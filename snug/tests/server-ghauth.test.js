// Sign in with GitHub (server/ghauth.js) against the local registry and mock
// GitHub: the device flow, the username picker's rules, moves, resume, renames,
// the owner's password-free account and deleting it. No real GitHub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, startPc, Client, OWNER_GH } from './helpers/p2p.js';

let registry;
const pcs = [];
const logs = [];
before(async () => { registry = await startRegistry(); });
after(async () => { for (const p of pcs) await p.close().catch(() => {}); await registry.close(); });

async function pc(extra = {}) {
  const srv = await startPc(registry, { quiet: false, ...extra });
  pcs.push(srv);
  return srv;
}
// startPc passes quiet; capture every log line through console.log while these tests run.
const realLog = console.log;
console.log = (...a) => { logs.push(a.map(String).join(' ')); };
after(() => { console.log = realLog; });

async function http(srv, method, path, body, { cookie, headers = {} } = {}) {
  const res = await fetch(`${srv.base}${path}`, {
    method,
    headers: { origin: srv.base, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const post = (srv, path, body, o) => http(srv, 'POST', path, body || {}, o);
const get = (srv, path, o) => http(srv, 'GET', path, null, o);

// Start a device flow and approve it on (mock) GitHub as `ghId`; returns the flow and the first non-pending wait.
async function githubSignIn(srv, ghId, body = {}, o) {
  const s = await post(srv, '/api/gh/start', body, o);
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.match(s.data.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(s.data.verificationUri.startsWith(`${registry.github.url}/login/device`));
  registry.github.authorize(s.data.userCode, { id: ghId });
  let w;
  do w = await post(srv, '/api/gh/wait', { flow: s.data.flow }); while (w.data.state === 'pending');
  return { flow: s.data.flow, ...w };
}

test('sign up: device code, the name rules, claim, and no GitHub identity anywhere', async () => {
  const a = await pc();
  const cfg = await get(a, '/api/gh/config');
  assert.deepEqual(cfg.data, { enabled: true, owner: false, resume: null });

  const w = await githubSignIn(a, 1001);
  assert.equal(w.data.state, 'choose-name');
  assert.equal(w.data.owner, false);
  // Device-flow calls asked for no scopes and carried a User-Agent.
  const dev = registry.github.calls.filter((c) => c.path === '/login/device/code');
  assert.ok(dev.length && dev.every((c) => c.scope === '' && /^Snug\//.test(c.ua)));

  const chk = async (name) => (await get(a, `/api/gh/check?name=${encodeURIComponent(name)}&flow=${w.flow}`)).data;
  assert.equal((await chk('a')).message, 'That name is reserved. Try another.');
  assert.equal((await chk('1')).error, 'owner_only');
  assert.equal((await chk('admin')).error, 'reserved');
  assert.equal((await chk('x')).message, 'Usernames need at least 2 characters.');
  assert.equal((await chk('bob_')).message, 'A username can’t start or end with a dot or an underscore.');
  assert.equal((await chk('bo..b')).message, 'Dots and underscores can’t sit next to each other.');
  assert.equal((await chk('bob!')).message, 'Use only lowercase letters, numbers, dots and underscores.');
  assert.deepEqual(await chk('Bob'), { ok: true });

  const bad = await post(a, '/api/gh/claim', { flow: w.flow, username: 'a' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'That name is reserved. Try another.');
  const c = await post(a, '/api/gh/claim', { flow: w.flow, username: 'Bob' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.user.handle, 'bob');
  assert.match(c.data.user.id, /^u_[a-z2-7]{16}$/);
  assert.match(c.cookie, /^snug_session=/);

  const me = await get(a, '/api/me', { cookie: c.cookie });
  assert.equal(me.data.p2p.username, 'bob');
  assert.equal(me.data.p2p.state, 'ok');
  assert.equal((await get(a, '/api/gh/config')).data.owner, true);
  // Nothing GitHub-shaped reaches the page: no login, no numeric id, no token.
  const text = JSON.stringify([c.data, me.data]);
  assert.doesNotMatch(text, /gh[ou]_|hidden|"1001"|github/i);
  // The PC is bob's now: another GitHub account can't make a second Snug account here.
  const other = await githubSignIn(a, 1009);
  assert.equal(other.data.state, 'error');
  assert.equal(other.data.message, 'This PC is linked to another Snug account.');
  // A name someone has is taken, as the picker would show it.
  const b = await pc();
  const wb = await githubSignIn(b, 1002);
  assert.equal((await get(b, `/api/gh/check?name=bob&flow=${wb.flow}`)).data.message, '@bob is taken. Try another.');
  assert.equal((await get(b, `/api/gh/check?name=b.o.b&flow=${wb.flow}`)).data.error, 'taken');
  const taken = await post(b, '/api/gh/claim', { flow: wb.flow, username: 'b_o_b' });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.error, '@b_o_b is taken. Try another.');
  assert.equal((await post(b, '/api/gh/claim', { flow: wb.flow, username: 'carol' })).status, 200);
});

test('the owner GitHub id may claim a one-character name', async () => {
  const p = await pc();
  const w = await githubSignIn(p, OWNER_GH);
  assert.equal(w.data.owner, true);
  assert.deepEqual((await get(p, `/api/gh/check?name=a&flow=${w.flow}`)).data, { ok: true });
  const c = await post(p, '/api/gh/claim', { flow: w.flow, username: 'a' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.user.handle, 'a');
});

test('returning, moving to another PC, resume and the password-free account', async () => {
  const secret = 'resume-secret-for-tests-0123456789';
  const a = await pc({ resumeSecret: secret });
  const w = await githubSignIn(a, 1003);
  const c = await post(a, '/api/gh/claim', { flow: w.flow, username: 'dora' });
  // Signing in again on the same PC goes straight in.
  const again = await githubSignIn(a, 1003);
  assert.equal(again.data.state, 'signed-in');
  assert.equal(again.data.user.id, c.data.user.id);
  assert.match(again.cookie, /^snug_session=/);

  // Resume: only with the per-launch cookie the desktop app sets.
  assert.equal((await post(a, '/api/gh/resume')).status, 403);
  assert.equal((await post(a, '/api/gh/resume', {}, { cookie: 'snug_resume=wrong' })).status, 403);
  assert.equal((await get(a, '/api/gh/config', { cookie: `snug_resume=${secret}` })).data.resume, 'dora');
  const r = await post(a, '/api/gh/resume', {}, { cookie: `snug_resume=${secret}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.id, c.data.user.id);

  // No password, no two-factor, no old-style username change for this account.
  assert.equal((await post(a, '/api/password', { current: 'x', next: 'something long' }, { cookie: c.cookie })).data.error, 'Your account is secured by GitHub sign-in.');
  const owner = new Client(a, c.cookie, c.data.user.id);
  await owner.connect();
  assert.equal(await owner.refused('totp.begin'), 'Your account is secured by GitHub sign-in.');
  assert.match(await owner.refused('me.handle', { handle: 'dora2', password: 'x' }), /Settings/);
  // id.rename goes through the registry; the second within 7 days says when.
  const rn = await owner.ok('id.rename', { username: 'dora.k' });
  assert.equal(rn.username, 'dora.k');
  assert.ok(rn.renameAt > Date.now() + 6 * 86_400_000);
  assert.equal((await get(a, '/api/me', { cookie: c.cookie })).data.user.handle, 'dora.k');
  assert.match(await owner.refused('id.rename', { username: 'dora.x' }), /^You can change your username once every 7 days\. Next change: /);
  assert.equal(await owner.refused('id.rename', { username: 'Snug_Team' }), 'That name is reserved. Try another.');

  // Another PC: the same GitHub account asks to move here.
  const b = await pc();
  const m = await githubSignIn(b, 1003);
  assert.equal(m.data.state, 'rebind');
  assert.equal(m.data.username, 'dora.k');
  const notice = owner.next('p2p', (d) => !!d.rebindPending, 8000);
  const mv = await post(b, '/api/gh/rebind', { flow: m.flow });
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  assert.equal(mv.data.state, 'moving');
  assert.ok(mv.data.at > Date.now() + 71 * 3600_000);
  assert.equal(mv.data.user.handle, 'dora.k');
  const n = await notice;
  assert.match(n.rebindPending.fingerprint, /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
  // The old PC says "Stop it": the new PC hears it, and can't ask again for a day.
  const bc = new Client(b, mv.cookie, mv.data.user.id);
  await bc.connect();
  assert.equal(bc.hello.p2p.state, 'moving');
  const stopped = bc.next('p2p', (d) => d.state === 'needs-signin', 8000);
  await owner.ok('id.rebind', { approve: false });
  await stopped;
  const again2 = await githubSignIn(b, 1003);
  assert.equal(again2.data.state, 'rebind');
  const blocked = await post(b, '/api/gh/rebind', { flow: again2.flow });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /stopped a move/);
  await owner.close();
  await bc.close();
});

test('delete with a GitHub check frees the username; loopback only; nothing secret in the log', async () => {
  const a = await pc();
  const w = await githubSignIn(a, 1004);
  const c = await post(a, '/api/gh/claim', { flow: w.flow, username: 'erin' });
  // A request that came through a proxy, or from another machine, never reaches GitHub sign-in.
  assert.equal((await get(a, '/api/gh/config', { headers: { 'x-forwarded-for': '10.0.0.5' } })).data.enabled, false);
  assert.equal((await post(a, '/api/gh/start', {}, { headers: { 'x-forwarded-for': '10.0.0.5' } })).status, 403);
  // Release needs the owner's session.
  assert.equal((await post(a, '/api/gh/start', { purpose: 'release' })).status, 401);
  const conf = await githubSignIn(a, 1004, { purpose: 'release' }, { cookie: c.cookie });
  assert.equal(conf.data.state, 'confirmed');
  // Delete is confirmed by typing the username, not a password.
  assert.equal((await post(a, '/api/account/delete', { confirm: 'nope', flow: conf.flow }, { cookie: c.cookie })).status, 401);
  const del = await post(a, '/api/account/delete', { confirm: 'erin', flow: conf.flow }, { cookie: c.cookie });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(del.data.released, true);
  assert.equal((await get(a, '/api/gh/config')).data.owner, false);
  // The name is free again at once (brief rule), for anyone.
  const b = await pc();
  const wb = await githubSignIn(b, 1005);
  assert.deepEqual((await get(b, `/api/gh/check?name=erin&flow=${wb.flow}`)).data, { ok: true });

  const all = logs.join('\n');
  assert.doesNotMatch(all, /gh[ou]_[A-Za-z0-9]{20,}/);
  for (const call of registry.github.calls) if (call.token) assert.ok(!all.includes(call.token));
});

test('cancel and an expired or denied flow', async () => {
  const a = await pc();
  const s = await post(a, '/api/gh/start');
  assert.deepEqual((await post(a, '/api/gh/cancel', { flow: s.data.flow })).data, { ok: true });
  assert.equal((await post(a, '/api/gh/wait', { flow: s.data.flow })).data.state, 'expired');
  const d = await post(a, '/api/gh/start');
  registry.github.deny(d.data.userCode);
  let w;
  do w = await post(a, '/api/gh/wait', { flow: d.data.flow }); while (w.data.state === 'pending');
  assert.equal(w.data.state, 'denied');
});

test('without a registry, GitHub sign-in is off and accounts work as before', async () => {
  const { startServer } = await import('../server/index.js');
  const srv = await startServer({ port: 0, dataDir: ':memory:', quiet: true, registryUrl: null });
  pcs.push(srv);
  srv.base = `http://127.0.0.1:${srv.port}`;
  assert.deepEqual((await get(srv, '/api/gh/config')).data, { enabled: false });
  assert.equal((await post(srv, '/api/gh/start')).status, 404);
});

test('the PC’s first password account can connect GitHub and keep everything; others can’t', async () => {
  const a = await pc();
  const reg = async (handle) => {
    const r = await post(a, '/api/register', { handle, name: handle, password: 'a long password' });
    assert.equal(r.status, 201);
    return r;
  };
  const first = await reg('olive');
  const second = await reg('pat');
  assert.equal((await get(a, '/api/gh/config', { cookie: first.cookie })).data.canLink, true);
  assert.equal((await get(a, '/api/gh/config', { cookie: second.cookie })).data.canLink, undefined);
  assert.equal((await post(a, '/api/gh/start', { link: true }, { cookie: second.cookie })).status, 403);
  const w = await githubSignIn(a, 1006, { link: true }, { cookie: first.cookie });
  assert.equal(w.data.state, 'choose-name');
  const c = await post(a, '/api/gh/claim', { flow: w.flow, username: 'olive.p' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.user.id, first.data.user.id, 'the same account, with its data');
  const me = await get(a, '/api/me', { cookie: first.cookie });
  assert.equal(me.data.user.handle, 'olive.p');
  assert.equal(me.data.p2p.owner, true);
  // GitHub-secured now: the old password no longer signs in.
  assert.equal((await post(a, '/api/login', { handle: 'olive.p', password: 'a long password' })).status, 401);
});

test('deleted without the GitHub check: signing in again brings the account back on this PC', async () => {
  const a = await pc();
  const w = await githubSignIn(a, 1007);
  const c = await post(a, '/api/gh/claim', { flow: w.flow, username: 'quinn' });
  const del = await post(a, '/api/account/delete', { confirm: 'quinn' }, { cookie: c.cookie });
  assert.equal(del.status, 200);
  assert.equal(del.data.released, false);
  // The name is still taken on the registry, and this PC still holds the key: sign in again.
  const again = await githubSignIn(a, 1007);
  assert.equal(again.data.state, 'signed-in');
  assert.equal(again.data.user.handle, 'quinn');
  assert.equal(again.data.user.name, 'quinn');
  assert.ok(!again.data.user.deleted);
});
