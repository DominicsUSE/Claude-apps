// "Forgot your password?" with a recovery key, no email (v0.12, server/recovery.js), and the owner's
// reset command (server/tools/reset-password.js). The recovery key is made and turned into its proof
// with the same code the browser runs (js/lib/recovery.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { totpAt, unbase32 } from '../server/account.js';
import { newRecoveryKey, parseRecoveryKey, deriveAuthKey, deriveBackupKey } from '../js/lib/recovery.js';
import { resetPassword } from '../server/tools/reset-password.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-recovery-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true, trustProxy: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
const freshIp = () => { ipN++; return `100.64.${(ipN >> 8) & 255}.${ipN & 255}`; };
const req = (method, path, body, { cookie, ip = freshIp() } = {}) => fetch(base + path, {
  method, headers: { origin: base, 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const post = (p, b, o) => req('POST', p, b || {}, o);
const get = (p, o) => req('GET', p, null, o);
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const PW = 'a long recovery password';
const NEW = 'a brand new password here';
const b64u = (u8) => Buffer.from(u8).toString('base64url');
const proofOf = async (raw) => b64u(await deriveAuthKey(raw));

async function register(handle) {
  const res = await post('/api/register', { handle, name: handle, password: PW });
  assert.equal(res.status, 201, await res.clone().text());
  return { id: (await res.json()).user.id, cookie: cookieOf(res), handle };
}
// Right after sign-up the session itself may save the key (a recent sign-in).
async function withKey(handle) {
  const who = await register(handle);
  const key = await newRecoveryKey();
  const r = await post('/api/recovery/set', { verifier: await proofOf(key.raw) }, { cookie: who.cookie });
  assert.equal(r.status, 200, await r.clone().text());
  return { ...who, key };
}
const login = (handle, password, o) => post('/api/login', { handle, password }, o);
async function recover(handle, raw, o) {
  const res = await post('/api/recover', { handle, proof: await proofOf(raw) }, o);
  return { status: res.status, body: await res.json() };
}

test('recovery: a key saved at sign-up is stored only as a slow hash of its proof; the key itself never reaches the server', async () => {
  const a = await withKey('rk-ana');
  const st = await (await get('/api/recovery', { cookie: a.cookie })).json();
  assert.equal(st.set, true);
  const row = srv.db.get('SELECT hash FROM recovery WHERE user = ?', a.id);
  const proof = await proofOf(a.key.raw);
  assert.match(row.hash, /^scrypt\$v2\$/);
  assert.ok(!row.hash.includes(proof), 'the stored hash is not the proof');
  // The proof can't open the encrypted backup: a different key, and one-way.
  assert.notEqual(b64u(await deriveBackupKey(a.key.raw)), proof);
  assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'recovery.set'", a.id));
  // The parsed text gives back the same raw bytes (what the browser does with what people type).
  const parsed = await parseRecoveryKey(a.key.text.toLowerCase().replace(/-/g, ' '));
  assert.equal(await proofOf(parsed.raw), proof);
});

test('recovery: later, making a new key needs the password; a malformed proof is refused', async () => {
  const b = await register('rk-bo');
  srv.db.run('UPDATE sessions SET auth_at = ? WHERE user = ?', Date.now() - 3_600_000, b.id); // signed in an hour ago
  const key = await newRecoveryKey();
  const verifier = await proofOf(key.raw);
  assert.equal((await post('/api/recovery/set', { verifier }, { cookie: b.cookie })).status, 401);
  assert.equal((await post('/api/recovery/set', { verifier, password: 'not my password' }, { cookie: b.cookie })).status, 401);
  assert.equal((await post('/api/recovery/set', { verifier: 'short', password: PW }, { cookie: b.cookie })).status, 400);
  assert.equal((await post('/api/recovery/set', { verifier, password: PW }, { cookie: b.cookie })).status, 200);
});

test('recovery: "Forgot your password?" sets a new password, signs out every other device and closes its sockets; the key works once', async () => {
  const c = await withKey('rk-cy');
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: c.cookie, origin: base } });
  const closed = new Promise((r) => ws.on('close', r));
  await new Promise((r) => ws.on('message', (m) => { if (JSON.parse(m).t === 'hello') r(); }));
  const r1 = await recover('rk-cy', c.key.raw);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.totp, false);
  // A weak password is refused and the ticket stays for another try.
  const weak = await post('/api/recover/finish', { ticket: r1.body.ticket, password: 'password' });
  assert.equal(weak.status, 400);
  const fin = await post('/api/recover/finish', { ticket: r1.body.ticket, password: NEW });
  assert.equal(fin.status, 200, await fin.clone().text());
  const fresh = cookieOf(fin);
  assert.equal((await fin.json()).user.id, c.id);
  await closed;
  assert.equal((await get('/api/me', { cookie: c.cookie })).status, 401, 'the old session ended');
  assert.equal((await get('/api/me', { cookie: fresh })).status, 200, 'this browser is signed in');
  assert.equal((await login('rk-cy', PW)).status, 401, 'the old password is gone');
  assert.equal((await login('rk-cy', NEW)).status, 200);
  // Used once: the same key is refused now, and Settings shows no key until a new one is made.
  assert.equal((await recover('rk-cy', c.key.raw)).status, 401);
  assert.equal((await (await get('/api/recovery', { cookie: fresh })).json()).set, false);
  assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'recovery.use' AND ok = 1", c.id));
  // The new session is a recent sign-in, so the forced "make a new key" step needs no password.
  const next = await newRecoveryKey();
  assert.equal((await post('/api/recovery/set', { verifier: await proofOf(next.raw) }, { cookie: fresh })).status, 200);
  assert.equal((await recover('rk-cy', next.raw)).status, 200, 'the new key works');
});

test('recovery: a ticket finishes once; two finishes at the same time spend the key once', async () => {
  const d = await withKey('rk-di');
  const r = await recover('rk-di', d.key.raw);
  const [x, y] = await Promise.all([post('/api/recover/finish', { ticket: r.body.ticket, password: NEW }), post('/api/recover/finish', { ticket: r.body.ticket, password: `${NEW}!` })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 401]);
  assert.equal((await post('/api/recover/finish', { ticket: 'made-up-ticket', password: NEW })).status, 401);
});

test('recovery: wrong keys count per account across addresses; unknown accounts get the same answer', async () => {
  const e = await withKey('rk-ed');
  const other = await newRecoveryKey();
  const unknown = await recover('rk-nobody-here', other.raw);
  const wrong = await recover('rk-ed', other.raw);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.body.error, wrong.body.error, 'no hint which accounts exist');
  let locked = false;
  for (let i = 0; i < 8 && !locked; i++) locked = (await recover('rk-ed', other.raw)).status === 429; // each from a new address
  assert.ok(locked, 'the account waits after 5 free tries');
  assert.equal((await recover('rk-ed', e.key.raw)).status, 429, 'even the right key waits now');
  // Per address too (the sign-in bucket: 10 per 15 minutes).
  srv.resetLimits();
  const ip = freshIp();
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await recover(`rk-ghost${i}`, other.raw, { ip })).status);
  assert.ok(statuses.includes(429), 'one address is limited');
});

test('recovery: with two-factor on, it is kept unless "I lost my authenticator app too" is ticked', async () => {
  for (const reset of [false, true]) {
    const f = await withKey(`rk-tf${reset ? 1 : 0}`);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: f.cookie, origin: base } });
    const acks = new Map();
    let seq = 0;
    await new Promise((r) => ws.on('message', (b) => { const m = JSON.parse(b); if (m.t === 'hello') r(); if (m.t === 'ack') acks.get(m.id)?.(m); }));
    const op = (o, d) => new Promise((r) => { const id = ++seq; acks.set(id, r); ws.send(JSON.stringify({ t: 'op', id, op: o, d })); });
    const secret = unbase32((await op('totp.begin', {})).d.secret);
    assert.ok((await op('totp.enable', { password: PW, code: totpAt(secret, Date.now()) })).ok);
    ws.close();
    const r = await recover(f.handle, f.key.raw);
    assert.equal(r.body.totp, true);
    const fin = await post('/api/recover/finish', { ticket: r.body.ticket, password: NEW, resetTwoFactor: reset });
    assert.equal(fin.status, 200);
    assert.equal((await fin.json()).totpReset, reset);
    const l = await (await login(f.handle, NEW)).json();
    assert.equal(!!l.totp, !reset, reset ? 'signs in with the password alone' : 'still asks for a code');
    if (reset) assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'recovery.use' AND why = 'two-factor-reset'", f.id));
  }
});

test('recovery: passkeys are removed, in case someone else added one', async () => {
  const g = await withKey('rk-ga');
  srv.db.run("INSERT INTO passkeys (id, user, pub, alg, name, created) VALUES ('cGFzc2tleS1mb3ItcmstZ2E', ?, '{}', -7, 'Not mine', ?)", g.id, Date.now());
  const r = await recover('rk-ga', g.key.raw);
  const fin = await (await post('/api/recover/finish', { ticket: r.body.ticket, password: NEW })).json();
  assert.equal(fin.passkeysRemoved, 1);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM passkeys WHERE user = ?', g.id).n, 0);
});

test('recovery: the export says a key exists (never the hash); deleting the account forgets it', async () => {
  const h = await withKey('rk-ha');
  const exp = await (await get('/api/account/export', { cookie: h.cookie })).json();
  assert.equal(exp.recoveryKey.usable, true);
  assert.ok(!JSON.stringify(exp).includes('scrypt$'), 'no hash in the export');
  assert.equal((await post('/api/account/delete', { password: PW, confirm: 'rk-ha' }, { cookie: h.cookie })).status, 200);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM recovery WHERE user = ?', h.id).n, 0);
});

test('owner reset: a temporary password shown once, every device signed out, passkeys removed; two-factor only when asked', async () => {
  const k = await register('rk-owner');
  srv.db.run("INSERT INTO passkeys (id, user, pub, alg, name, created) VALUES ('cGFzc2tleS1mb3Itcmstb3duZXI', ?, '{}', -7, 'x', ?)", k.id, Date.now());
  const r = resetPassword(srv.db, '@RK-Owner');
  assert.match(r.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.equal(r.passkeys, 1);
  assert.equal(r.twoFactor, false);
  assert.equal((await get('/api/me', { cookie: k.cookie })).status, 401);
  assert.equal((await login('rk-owner', PW)).status, 401);
  assert.equal((await login('rk-owner', r.password)).status, 200);
  assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'password.reset.owner'", k.id));
  assert.throws(() => resetPassword(srv.db, 'nobody-at-all'), /No account/);
  srv.db.run("UPDATE users SET pass = '!' WHERE id = ?", k.id);
  assert.throws(() => resetPassword(srv.db, 'rk-owner'), /has no password here/);
});
