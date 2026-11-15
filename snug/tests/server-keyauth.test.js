// Keypair accounts on the desktop's local server (server/keyauth.js) against the local registry
// (registry/dev.js, which has keypair accounts on): creating an account with no GitHub account, saving the
// recovery key, moving with a pairing code, moving with the recovery key, a new recovery key, the optional
// GitHub link, and deleting with the recovery key. Plus the proof-of-work worker (server/pow.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRegistry, startPc, Client, signUp, until } from './helpers/p2p.js';
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

test('GitHub as an optional second proof: link, then unlink', async () => {
  const a = await pc();
  const r = await create(a, 'linker');
  const c = await client(a, r.cookie);
  await until(() => a.peer.statusFor(c.id)?.registry === 'connected', 8000, 'connected');
  const s = await post(a, '/api/gh/start', { purpose: 'link-account' }, { cookie: r.cookie });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  registry.github.authorize(s.data.userCode, { id: 82001 });
  let w;
  do w = await post(a, '/api/gh/wait', { flow: s.data.flow }); while (w.data.state === 'pending');
  assert.equal(w.data.state, 'confirmed');
  await c.ok('id.linkGithub', { flow: s.data.flow });
  assert.equal((await kindOf(a)).github.linked, true);
  assert.equal(a.peer.statusFor(c.id).ghLinked, true);
  // the same flow can't be used twice
  assert.match(await c.refused('id.linkGithub', { flow: s.data.flow }), /took too long/);
  await c.ok('id.unlinkGithub', {});
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
