// Keypair accounts on the desktop's local server (server/keyauth.js) against the local registry
// (registry/dev.js, which has keypair accounts on): creating an account with no GitHub account, saving the
// recovery key, moving with a pairing code, moving with the recovery key, a new recovery key, the optional
// GitHub link, and deleting with the recovery key. Plus the proof-of-work worker (server/pow.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRegistry, startPc, Client, signUp, until, mid } from './helpers/p2p.js';
import { solvePow, powOk } from '../server/pow.js';
import { parseRecoveryKey } from '../js/lib/recovery.js';
import { startLocalRegistry } from '../registry/dev.js';

let registry;
const pcs = [];
before(async () => { registry = await startRegistry(); });
after(async () => { for (const p of pcs) await p.close().catch(() => {}); await registry.close(); });

async function pc(extra = {}, reg = registry) {
  const srv = await startPc(reg, { movePollMs: 100, ...extra });
  pcs.push(srv);
  return srv;
}
async function http(srv, method, path, body, { cookie } = {}) {
  const res = await fetch(`${srv.base}${path}`, {
    method,
    headers: { origin: srv.base, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const post = (srv, path, body, o) => http(srv, 'POST', path, body || {}, o);
const get = (srv, path, o) => http(srv, 'GET', path, null, o);
async function client(srv, cookie) {
  const me = await get(srv, '/api/me', { cookie });
  const c = new Client(srv, cookie, me.data.user?.id || me.data.id);
  await c.connect();
  return c;
}
async function create(srv, username) {
  const r = await post(srv, '/api/id/create', { username });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}
const kindOf = (srv) => srv.peer.reg.signedCall('/v1/account/kind', 'account-kind', {});

test('pow worker: finds the lowest nonce that does the work; a cancel stops it at once', async () => {
  const c = '1.123.12.abcdefghijklmnopqrstuv.00';
  const nonce = await solvePow(c, 'ik', 12);
  assert.ok(powOk(c, 'ik', 12, nonce));
  for (let n = 0; n < Number(nonce); n++) assert.ok(!powOk(c, 'ik', 12, String(n)), `a lower nonce ${n} works`);
  const ctl = new AbortController();
  const p = solvePow(c, 'ik', 60, { signal: ctl.signal }); // never finishes on its own
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(p, (e) => e.cancelled === true);
});

test('create: no GitHub, a username, a recovery key shown once and confirmed by its last group', async () => {
  const a = await pc();
  const cfg = await get(a, '/api/id/config');
  assert.deepEqual(cfg.data, { enabled: true, github: true, owner: false, resume: null });
  // the name rules, with no short names for new accounts
  const chk = async (n) => (await get(a, `/api/id/check?name=${encodeURIComponent(n)}`)).data;
  assert.equal((await chk('kit')).error, 'too_new');
  assert.match((await chk('kit')).message, /2 or 3 characters/);
  assert.equal((await chk('a')).error, 'owner_only');
  assert.deepEqual(await chk('kittie'), { ok: true });
  assert.equal((await post(a, '/api/id/create', { username: 'abc' })).status, 400);

  const r = await create(a, 'Kittie');
  assert.ok(r.cookie.startsWith('snug_session='));
  assert.equal(r.data.user.handle, 'kittie');
  const code = r.data.recovery.code;
  assert.match(code, /^([A-Z2-7]{4}-){8}[A-Z2-7]{4}$/);
  assert.ok((await parseRecoveryKey(code)).raw);
  // the registry has the account; this PC is its owner and connects
  assert.equal((await chk('kittie')).error, 'taken');
  const self = a.peer.identity.self();
  assert.equal(self.username, 'kittie');
  assert.equal(self.state, 'ok');
  await until(() => a.peer.statusFor(self.user)?.registry === 'connected', 8000, 'connected');
  const st = a.peer.statusFor(self.user);
  assert.equal(st.kind, 'key');
  assert.deepEqual(st.recovery, { set: true, saved: false, pendingAt: null });
  assert.equal((await kindOf(a)).kind, 'key');
  // the recovery secret waits on disk, not in plain text
  const file = join(a.dataDir, 'recovery.json');
  assert.ok(existsSync(file));
  assert.ok(!readFileSync(file, 'utf8').includes(code.replace(/-/g, '')));
  // shown again until saved; the wrong last group is refused
  const shown = await get(a, '/api/id/recovery', { cookie: r.cookie });
  assert.deepEqual(shown.data, { code, username: 'kittie' });
  assert.equal((await post(a, '/api/id/recovery/confirm', { last: 'AAAA' }, { cookie: r.cookie })).status, 400);
  const ok = await post(a, '/api/id/recovery/confirm', { last: code.slice(-4).toLowerCase() }, { cookie: r.cookie });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await get(a, '/api/id/recovery', { cookie: r.cookie })).status, 404);
  assert.ok(!existsSync(file));
  assert.equal(a.peer.statusFor(self.user).recovery.saved, true);
  // signed out here, the recovery key signs them back in on this PC without a move
  const back = await post(a, '/api/id/recover', { code });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.state, 'signed-in');
  assert.equal(a.peer.identity.self().state, 'ok');
  // one account per PC; no password, no two-factor
  assert.equal((await post(a, '/api/id/create', { username: 'another' })).status, 409);
  const c = await client(a, r.cookie);
  assert.match(await c.refused('totp.begin', {}), /no password/);
  c.close();
});

test('pairing code: the new PC shows a code, the old PC types it, the account and its friends move now', async () => {
  const old = await pc();
  const r = await create(old, 'mover');
  const friendPc = await pc();
  const fr = await signUp(friendPc, registry, 81001, 'frieda');
  const o = await client(old, r.cookie);
  await until(() => old.peer.statusFor(o.id)?.registry === 'connected', 8000, 'old connected');
  await o.ok('friend.request', { handle: 'frieda' });
  const req = await fr.next('friend', (x) => x.friend?.state === 'incoming', 15000);
  await fr.ok('friend.accept', { user: req.id });
  await o.next('friend', (x) => x.friend?.state === 'friends', 15000);
  // A message saved on the old PC: it should reach the new PC in the data file that follows the move.
  const dm = (await o.ok('dm.open', { users: [fr.id] })).id; // her stand-in on this PC is u_<her uid>, as on hers
  await o.ok('msg.send', { conv: dm, id: mid(), text: 'saved before the move' });

  const neu = await pc();
  const s = await post(neu, '/api/id/move/start');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.match(s.data.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.ok(s.data.expiresIn > 500);
  // the old PC: a wrong code, then the right one, which shows the new PC's security code
  assert.match(await o.refused('id.movePeek', { code: 'ZZZZZ-ZZZZZ' }), /isn’t right or has expired/);
  const peek = await o.ok('id.movePeek', { code: s.data.code });
  assert.equal(peek.fingerprint, neu.peer.identity.fingerprint);
  const waiting = post(neu, '/api/id/move/wait', { flow: s.data.flow });
  await o.ok('id.moveAccept', { code: s.data.code });
  const w = await waiting;
  assert.equal(w.data.state, 'signed-in', JSON.stringify(w.data));
  assert.ok(w.cookie.startsWith('snug_session='));
  const self = neu.peer.identity.self();
  assert.equal(self.uid, old.peer.identity.self().uid);
  assert.equal(self.username, 'mover');
  await until(() => neu.peer.identity.self().state === 'ok', 10000, 'new PC active');
  await until(() => old.peer.identity.self()?.state === 'revoked', 10000, 'old PC revoked');
  // the friend came along (the restore list), and the friend's PC saw a quiet, verified key change
  await until(() => neu.db.get("SELECT 1 FROM friends f JOIN peers p ON p.user = f.other WHERE p.username = 'frieda' AND f.state = 'friends'"), 15000, 'friend restored');
  await until(() => neu.db.get("SELECT 1 FROM messages WHERE text = 'saved before the move'"), 30000, 'the data file from the old PC');
  await until(async () => (await kindOf(neu)).kind === 'key', 5000, 'kind');
  assert.equal(neu.peer.statusFor(self.user).kind, 'key');
  o.close();
  fr.close();
});

test('recovery key: a lost PC; the key starts a 72 h move the old PC can see; afterwards the account is here', async () => {
  const old = await pc();
  const r = await create(old, 'lostpc');
  const code = r.data.recovery.code;
  await post(old, '/api/id/recovery/confirm', { last: code.slice(-4) }, { cookie: r.cookie });
  const o = await client(old, r.cookie);
  await until(() => old.peer.statusFor(o.id)?.registry === 'connected', 8000, 'old connected');
  const neu = await pc();
  // typos are caught before anything is sent; a well-formed key nobody has is refused by the registry
  const typo = await post(neu, '/api/id/recover', { code: code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A') });
  assert.equal(typo.status, 400);
  assert.match(typo.data.error, /groups looks wrong/);
  const { newRecoveryKey } = await import('../js/lib/recovery.js');
  const stranger = await post(neu, '/api/id/recover', { code: (await newRecoveryKey()).text });
  assert.equal(stranger.status, 404);
  assert.match(stranger.data.error, /doesn’t match a Snug account/);
  // spaces and lower case are fine
  const mv = await post(neu, '/api/id/recover', { code: code.toLowerCase().replace(/-/g, ' ') });
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  assert.equal(mv.data.state, 'moving');
  assert.ok(Math.abs(mv.data.at - (registry.clock.now() + 72 * 3600_000)) < 5000);
  assert.equal(neu.peer.identity.self().state, 'moving');
  // the old PC hears about it, by recovery key
  await until(() => old.peer.statusFor(o.id)?.rebindPending?.via === 'recovery', 10000, 'old PC sees a recovery move');
  await registry.clock.advance(72 * 3600_000 + 1000);
  await until(() => neu.peer.identity.self().state === 'ok', 20000, 'moved');
  await until(() => old.peer.identity.self()?.state === 'revoked', 10000, 'old PC revoked');
  assert.equal(neu.peer.statusFor(neu.peer.identity.self().user).recovery.saved, true);
  o.close();
});

test('a new recovery key: with the old one at once (the old one stops working); without it, 7 days later', async () => {
  const a = await pc();
  const r = await create(a, 'rotator');
  const first = r.data.recovery.code;
  await post(a, '/api/id/recovery/confirm', { last: first.slice(-4) }, { cookie: r.cookie });
  const c = await client(a, r.cookie);
  await until(() => a.peer.statusFor(c.id)?.registry === 'connected', 8000, 'connected');
  assert.match(await c.refused('id.recoveryNew', { old: 'AAAA-BBBB' }), /36 letters/);
  const n = await c.ok('id.recoveryNew', { old: first });
  assert.equal(n.state, 'set');
  assert.notEqual(n.code, first);
  assert.equal(a.peer.statusFor(c.id).recovery.saved, false, 'the new key waits to be saved');
  await c.ok('id.recoveryConfirm', { last: n.code.slice(-4) });
  // the first key no longer moves the account
  const other = await pc();
  assert.equal((await post(other, '/api/id/recover', { code: first })).status, 404);
  // without the old key: pending, and the current key cancels it
  const p = await c.ok('id.recoveryNew', {});
  assert.equal(p.state, 'pending');
  assert.ok(p.at > Date.now() + 6 * 86_400_000);
  assert.equal(a.peer.statusFor(c.id).recovery.pendingAt, p.at);
  await c.ok('id.recoveryCancel', { code: n.code });
  assert.equal(a.peer.statusFor(c.id).recovery.pendingAt, null);
  assert.equal((await kindOf(a)).recovery.pendingAt, null);
  c.close();
});

test('GitHub as an optional second proof: a link and an unlink each wait 7 days; the recovery key cancels them', async () => {
  const a = await pc();
  const r = await create(a, 'linker');
  const code = r.data.recovery.code;
  await post(a, '/api/id/recovery/confirm', { last: code.slice(-4) }, { cookie: r.cookie });
  const c = await client(a, r.cookie);
  await until(() => a.peer.statusFor(c.id)?.registry === 'connected', 8000, 'connected');
  const linkFlow = async (ghId) => {
    const s = await post(a, '/api/gh/start', { purpose: 'link-account' }, { cookie: r.cookie });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    registry.github.authorize(s.data.userCode, { id: ghId });
    let w;
    do w = await post(a, '/api/gh/wait', { flow: s.data.flow }); while (w.data.state === 'pending');
    assert.equal(w.data.state, 'confirmed');
    return s.data.flow;
  };
  const flow = await linkFlow(82001);
  const l = await c.ok('id.linkGithub', { flow });
  // v0.12 review H3: someone with only this PC can't add a GitHub account of their own at once
  assert.equal(l.state, 'pending');
  assert.ok(l.at > registry.clock.now() + 6 * 86_400_000);
  assert.equal((await kindOf(a)).github.linked, false);
  assert.deepEqual(a.peer.statusFor(c.id).ghChange, { change: 'link', at: l.at });
  assert.equal(a.peer.statusFor(c.id).ghLinked, false);
  // the same flow can't be used twice
  assert.match(await c.refused('id.linkGithub', { flow }), /took too long/);
  // the recovery key cancels it
  await c.ok('id.recoveryCancel', { code });
  assert.equal(a.peer.statusFor(c.id).ghChange, null);
  assert.equal((await kindOf(a)).github.pending, null);
  // again, and nobody cancels: linked 7 days later, and this PC hears of it
  await c.ok('id.linkGithub', { flow: await linkFlow(82001) });
  await registry.clock.advance(7 * 86_400_000 + 1000);
  await until(async () => { await a.refreshKind(); return a.peer.statusFor(c.id).ghLinked === true; }, 10000, 'linked');
  assert.equal(a.peer.statusFor(c.id).ghChange, null);
  // unlinking waits too
  const u = await c.ok('id.unlinkGithub', {});
  assert.equal(u.state, 'pending');
  assert.equal((await kindOf(a)).github.linked, true);
  await registry.clock.advance(7 * 86_400_000 + 1000);
  await until(async () => { await a.refreshKind(); return a.peer.statusFor(c.id).ghLinked === false; }, 10000, 'unlinked');
  assert.equal((await kindOf(a)).github.linked, false);
  c.close();
});

test('delete with the recovery key frees the username', async () => {
  const a = await pc();
  const r = await create(a, 'leaver');
  const c = await client(a, r.cookie);
  assert.match(await c.refused('id.releaseCheck', { code: (await (await import('../js/lib/recovery.js')).newRecoveryKey()).text }), /isn’t your account’s recovery key/);
  const { flow } = await c.ok('id.releaseCheck', { code: r.data.recovery.code });
  c.close();
  const d = await post(a, '/api/account/delete', { confirm: 'leaver', flow }, { cookie: r.cookie });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(d.data.released, true);
  assert.equal((await get(a, '/api/id/check?name=leaver')).data.ok, true);
  assert.equal(a.peer.identity.self(), null);
});

test('desktop: only the app window (its per-launch cookie) may use these routes', async () => {
  const secret = 'w'.repeat(43);
  const a = await pc({ ghWindowOnly: true, resumeSecret: secret });
  const win = `snug_resume=${secret}`;
  assert.deepEqual((await get(a, '/api/id/config')).data, { enabled: false });
  assert.equal((await post(a, '/api/id/create', { username: 'sneaky' })).status, 403);
  assert.equal((await post(a, '/api/id/move/start')).status, 403);
  assert.equal((await post(a, '/api/id/recover', { code: 'x' })).status, 403);
  assert.equal((await get(a, '/api/id/config', { cookie: win })).data.enabled, true);
  const r = await post(a, '/api/id/create', { username: 'windowed' }, { cookie: win });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // and then the window can come back without anything typed
  assert.equal((await get(a, '/api/id/config', { cookie: win })).data.resume, 'windowed');
  assert.equal((await post(a, '/api/id/resume', {}, { cookie: win })).status, 200);
  assert.equal((await post(a, '/api/id/resume', {})).status, 403);
});

test('a registry with keypair accounts off: create says to use GitHub, and config stops offering it', async () => {
  const off = await startLocalRegistry({ env: { KEY_ACCOUNTS: '0', OWNER_GITHUB_IDS: '900001' } });
  try {
    const a = await pc({}, off);
    const r = await post(a, '/api/id/create', { username: 'nokeys' });
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'unsupported');
    assert.match(r.data.error, /Use GitHub instead/);
    assert.equal((await get(a, '/api/id/config')).data.enabled, false);
  } finally {
    await off.close();
  }
});

// ---------- v0.12 identity review ----------

test('a recovery key replaced on the registry no longer signs anyone back in on this PC', async () => {
  const a = await pc();
  const r = await create(a, 'staler');
  const first = r.data.recovery.code;
  await post(a, '/api/id/recovery/confirm', { last: first.slice(-4) }, { cookie: r.cookie });
  const c = await client(a, r.cookie);
  await until(() => a.peer.statusFor(c.id)?.registry === 'connected', 8000, 'connected');
  // a new key without the old one: it takes effect after 7 days
  const p = await c.ok('id.recoveryNew', {});
  assert.equal(p.state, 'pending');
  await c.ok('id.recoveryConfirm', { last: p.code.slice(-4) });
  await registry.clock.advance(7 * 86_400_000 + 1000);
  await until(async () => { await a.refreshKind(); return a.peer.statusFor(c.id).recovery.pendingAt === null; }, 10000, 'the new key took effect');
  const old = await post(a, '/api/id/recover', { code: first });
  assert.notEqual(old.data.state, 'signed-in', 'the replaced key signs nobody in');
  assert.equal(old.status, 409, JSON.stringify(old.data)); // this PC holds the account; that key isn't its key now
  const now = await post(a, '/api/id/recover', { code: p.code });
  assert.equal(now.status, 200, JSON.stringify(now.data));
  assert.equal(now.data.state, 'signed-in');
  c.close();
});

test('recovering another account on a PC that still holds one is refused before any move starts', async () => {
  const b = await pc();
  const rb = await create(b, 'bystander');
  const a = await pc();
  const ra = await create(a, 'leftbehind');
  const oa = await client(a, ra.cookie);
  await until(() => a.peer.statusFor(oa.id)?.registry === 'connected', 8000, 'connected');
  // the account moves on to another PC; this one is left holding it, revoked
  const neu = await pc();
  const s = await post(neu, '/api/id/move/start');
  const waiting = post(neu, '/api/id/move/wait', { flow: s.data.flow });
  await oa.ok('id.moveAccept', { code: s.data.code });
  assert.equal((await waiting).data.state, 'signed-in');
  await until(() => a.peer.identity.self()?.state === 'revoked', 10000, 'revoked');
  const mv = await post(a, '/api/id/recover', { code: rb.data.recovery.code });
  assert.equal(mv.status, 409, JSON.stringify(mv.data));
  assert.equal((await kindOf(b)).move, null, 'no move was started for the other account');
  oa.close();
});

test('a GitHub account: a first recovery key waits 7 days, and a GitHub sign-in on this PC cancels it', async () => {
  const a = await pc();
  const c = await signUp(a, registry, 82101, 'ghkeyed');
  await until(() => a.peer.statusFor(c.id)?.registry === 'connected', 8000, 'connected');
  const p = await c.ok('id.recoveryNew', {});
  assert.equal(p.state, 'pending');
  assert.equal((await kindOf(a)).recovery.set, false);
  const s = await post(a, '/api/gh/start', { purpose: 'recovery-cancel' }, { cookie: c.cookie });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  registry.github.authorize(s.data.userCode, { id: 82101 });
  let w;
  do w = await post(a, '/api/gh/wait', { flow: s.data.flow }); while (w.data.state === 'pending');
  assert.equal(w.data.state, 'confirmed', JSON.stringify(w.data));
  await c.ok('id.recoveryCancelGh', { flow: s.data.flow });
  assert.equal((await kindOf(a)).recovery.pendingAt, null);
  assert.equal(a.peer.statusFor(c.id).recovery.pendingAt, null);
  c.close();
});

// ---------- v0.12 identity review, second pass ----------

test('a revoked PC whose stored recovery key is stale still takes its own account\'s current key (the registry is asked whose it is)', async () => {
  const a = await pc();
  const ra = await create(a, 'staleback');
  const oa = await client(a, ra.cookie);
  await until(() => a.peer.statusFor(oa.id)?.registry === 'connected', 8000, 'connected');
  const b = await pc();
  const s = await post(b, '/api/id/move/start');
  const waiting = post(b, '/api/id/move/wait', { flow: s.data.flow });
  await oa.ok('id.moveAccept', { code: s.data.code });
  const w = await waiting;
  assert.equal(w.data.state, 'signed-in');
  await until(() => a.peer.identity.self()?.state === 'revoked', 10000, 'revoked');
  // on the new PC the key is replaced (with the old one, so at once); the old PC never hears of it
  const ob = await client(b, w.cookie);
  await until(() => b.peer.identity.self()?.state === 'ok', 20000, 'b active');
  const n = await ob.ok('id.recoveryNew', { old: ra.data.recovery.code });
  assert.equal(n.state, 'set');
  assert.notEqual(a.peer.identity.get('rk'), (await kindOf(b)).recovery.rk, 'the old PC holds a stale key');
  const mv = await post(a, '/api/id/recover', { code: n.code });
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  assert.equal(mv.data.state, 'moving');
  oa.close(); ob.close();
});

async function ghFlow(srv, cookie, purpose, ghId) {
  const s = await post(srv, '/api/gh/start', { purpose }, { cookie });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  registry.github.authorize(s.data.userCode, { id: ghId });
  let w;
  do w = await post(srv, '/api/gh/wait', { flow: s.data.flow }); while (w.data.state === 'pending');
  assert.equal(w.data.state, 'confirmed', JSON.stringify(w.data));
  return s.data.flow;
}

test('a moving PC (the owner lost the old one) sees what waits on the account and cancels each change on its own', async () => {
  const a = await pc();
  const ra = await create(a, 'lostagain');
  const code = ra.data.recovery.code;
  await post(a, '/api/id/recovery/confirm', { last: code.slice(-4) }, { cookie: ra.cookie });
  const oa = await client(a, ra.cookie);
  await until(() => a.peer.statusFor(oa.id)?.registry === 'connected', 8000, 'connected');
  // whoever has the old PC links their own GitHub and asks for their own recovery key
  assert.equal((await oa.ok('id.linkGithub', { flow: await ghFlow(a, ra.cookie, 'link-account', 82201) })).state, 'pending');
  assert.equal((await oa.ok('id.recoveryNew', {})).state, 'pending');
  // the owner, on a new PC, with the recovery key
  const b = await pc();
  const mv = await post(b, '/api/id/recover', { code });
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  const ob = await client(b, mv.cookie);
  await until(async () => { await b.refreshKind(); const st = b.peer.statusFor(ob.id); return st?.ghChange?.change === 'link' && st.recovery.pendingAt; }, 10000, 'the moving PC sees both changes');
  // the GitHub link only: the recovery key change still waits, and this PC's saved state says so
  await ob.ok('id.recoveryCancel', { code, what: 'link' });
  let kd = await kindOf(a);
  assert.equal(kd.github.pending, null);
  assert.ok(kd.recovery.pendingAt);
  assert.equal(b.peer.statusFor(ob.id).ghChange, null);
  assert.ok(b.peer.statusFor(ob.id).recovery.pendingAt);
  await ob.ok('id.recoveryCancel', { code, what: 'key' });
  kd = await kindOf(a);
  assert.equal(kd.recovery.pendingAt, null);
  assert.equal(b.peer.statusFor(ob.id).recovery.pendingAt, null);
  oa.close(); ob.close();
});

test('the linked GitHub cancels a waiting unlink from a moving PC; with the recovery key, link and unlink are immediate', async () => {
  const a = await pc();
  const ra = await create(a, 'ghguard');
  const code = ra.data.recovery.code;
  await post(a, '/api/id/recovery/confirm', { last: code.slice(-4) }, { cookie: ra.cookie });
  const oa = await client(a, ra.cookie);
  await until(() => a.peer.statusFor(oa.id)?.registry === 'connected', 8000, 'connected');
  // with the recovery key typed, the link works at once
  const l = await oa.ok('id.linkGithub', { flow: await ghFlow(a, ra.cookie, 'link-account', 82301), code });
  assert.equal(l.state, 'done');
  assert.equal((await kindOf(a)).github.linked, true);
  assert.equal(a.peer.statusFor(oa.id).ghLinked, true);
  // someone with the old PC unlinks (it waits); the owner moves with GitHub's help... from a new PC
  assert.equal((await oa.ok('id.unlinkGithub', {})).state, 'pending');
  const b = await pc();
  const mv = await post(b, '/api/id/recover', { code });
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  const ob = await client(b, mv.cookie);
  await ob.ok('id.recoveryCancelGh', { flow: await ghFlow(b, mv.cookie, 'recovery-cancel', 82301), what: 'link' });
  assert.equal((await kindOf(a)).github.pending, null);
  assert.equal((await kindOf(a)).github.linked, true);
  // and on the old PC, with the recovery key: unlinked at once
  const u = await oa.ok('id.unlinkGithub', { code });
  assert.equal(u.state, 'done');
  assert.equal((await kindOf(a)).github.linked, false);
  oa.close(); ob.close();
});

// ---------- v0.13 ----------

test('v0.13: this PC calls off a waiting GitHub link alone, or with that GitHub account', async () => {
  const a = await pc();
  const r = await create(a, 'linkoff');
  const code = r.data.recovery.code;
  await post(a, '/api/id/recovery/confirm', { last: code.slice(-4) }, { cookie: r.cookie });
  const c = await client(a, r.cookie);
  await until(() => a.peer.statusFor(c.id)?.registry === 'connected', 8000, 'connected');
  assert.match(await c.refused('id.linkCancel', {}), /No GitHub link is waiting/);
  // link (waits), then this PC calls it off with no recovery key
  assert.equal((await c.ok('id.linkGithub', { flow: await ghFlow(a, r.cookie, 'link-account', 82401) })).state, 'pending');
  await c.ok('id.linkCancel', {});
  let kd = await kindOf(a);
  assert.equal(kd.github.pending, null);
  assert.equal(kd.github.linked, false);
  assert.equal(a.peer.statusFor(c.id).ghChange, null);
  // link again; the GitHub account being linked calls it off
  assert.equal((await c.ok('id.linkGithub', { flow: await ghFlow(a, r.cookie, 'link-account', 82401) })).state, 'pending');
  await c.ok('id.linkCancelGh', { flow: await ghFlow(a, r.cookie, 'link-account', 82401) });
  kd = await kindOf(a);
  assert.equal(kd.github.pending, null);
  assert.equal(a.peer.statusFor(c.id).ghChange, null);
  c.close();
});

test('v0.13: a GitHub account calls off its first recovery key from this PC alone (only the key change)', async () => {
  const a = await pc();
  const c = await signUp(a, registry, 82402, 'ghdropper');
  await until(() => a.peer.statusFor(c.id)?.registry === 'connected', 8000, 'connected');
  assert.match(await c.refused('id.recoveryDrop', {}), /No recovery key is waiting/);
  assert.equal((await c.ok('id.recoveryNew', {})).state, 'pending');
  assert.ok(a.peer.statusFor(c.id).recovery.pendingAt);
  await c.ok('id.recoveryDrop', {});
  const kd = await kindOf(a);
  assert.equal(kd.recovery.pendingAt, null);
  assert.equal(kd.recovery.set, false);
  assert.equal(a.peer.statusFor(c.id).recovery.pendingAt, null);
  c.close();
});
