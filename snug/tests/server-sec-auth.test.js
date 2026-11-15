// Security tests for sign-in, passwords, sessions and two-factor (the "auth"
// findings AUTH-1 to AUTH-13). Each test was written to fail on the code
// before its fix: lockouts that a flood of requests could wipe, client
// addresses taken from a header the client controls, lockout denial of
// service, cheap and blocking password hashing, common passwords, no audit
// trail, two-factor secrets in plain text, step-up checks as password oracles,
// sockets that outlive their session, cookies without the __Host- prefix,
// login timing, and sessions without an idle limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, scryptSync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import * as A from '../server/auth.js';
import { totpAt, base32, unbase32 } from '../server/account.js';

const { limiter, hashPassword, verifyPassword, burnPasswordCheck, sessionUser, sessionCookie, readCookie, clientIp, ipKey, COOKIE } = A;
const dir = mkdtempSync(join(tmpdir(), 'snug-sec-auth-'));
let srv, base;
// Every log line the server writes, for the audit tests (and kept off the test output).
const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: false, trustProxy: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { console.log = realLog; await srv.close(); rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
const freshIp = () => { ipN++; return `100.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN & 255}`; };
const req = (method, path, body, { cookie, ip = freshIp(), headers = {}, at = base } = {}) => fetch(at + path, {
  method,
  headers: { origin: at, 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const post = (path, body, o) => req('POST', path, body || {}, o);
const get = (path, o) => req('GET', path, null, o);
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const PW = 'a long password';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(handle, { password = PW, ip } = {}) {
  const res = await post('/api/register', { handle, name: handle, password }, { ip });
  assert.equal(res.status, 201, await res.clone().text());
  const d = await res.json();
  return { id: d.user.id, cookie: cookieOf(res), handle };
}
const login = (handle, password, o) => post('/api/login', { handle, password }, o);

class Sock {
  constructor(cookie) { this.cookie = cookie; this.events = []; this.acks = new Map(); this.seq = 0; }
  open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: this.cookie, origin: base } });
    this.closed = new Promise((r) => this.ws.on('close', (code) => r(code)));
    return new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('message', (buf) => {
        const m = JSON.parse(buf);
        if (m.t === 'hello') resolve(this);
        else if (m.t === 'ack') this.acks.get(m.id)?.(m);
        else if (m.t === 'ev') this.events.push(m);
      });
    });
  }
  op(op, d = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ t: 'op', id, op, d }));
    return new Promise((r) => this.acks.set(id, r));
  }
  close() { this.ws.close(); }
}
const sock = async (cookie) => new Sock(cookie).open();

// ---------- AUTH-1: a flood of new keys never wipes a lockout ----------
test('AUTH-1 limiter: 60,000 other keys do not refill a drained bucket', () => {
  const l = limiter({ capacity: 3, perSecond: 1 / 900 });
  for (let i = 0; i < 3; i++) assert.equal(l.take('victim'), true);
  assert.equal(l.take('victim'), false);
  for (let i = 0; i < 60_000; i++) l.take(`k${i}`);
  assert.equal(l.take('victim'), false, 'the drained bucket survived the flood');
});

test('AUTH-1 server: a locked account stays locked after 50,010 cheap requests from rotating addresses', { timeout: 120_000 }, async () => {
  await register('flood-alice');
  // Enough wrong passwords, each from its own address, to lock the account itself.
  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) locked = (await login('flood-alice', `wrong guess ${i}`)).status === 429;
  assert.ok(locked, 'the account locked');
  // The flood: register with an empty body, each from a new address (it never reaches scrypt).
  const agent = [];
  // 100 at a time, and a refused connection is tried again: Windows runners drop some of a 500-wide burst.
  const again = async (fn, n = 5) => { for (;;) { try { return await fn(); } catch (e) { if (--n <= 0) throw e; await new Promise((r) => setTimeout(r, 50)); } } };
  for (let i = 0; i < 50_010; i += 100) {
    const batch = [];
    for (let j = i; j < Math.min(i + 100, 50_010); j++) batch.push(again(() => post('/api/register', {}, { ip: `10.${(j >> 16) & 255}.${(j >> 8) & 255}.${j & 255}` })).then((r) => r.status));
    agent.push(...await Promise.all(batch));
  }
  assert.equal(agent.length, 50_010);
  assert.equal((await login('flood-alice', 'another guess')).status, 429, 'still locked');
});

// ---------- AUTH-2: the client address comes from the proxy's own entry ----------
test('AUTH-2 the address is the rightmost X-Forwarded-For entry (the one our proxy added), not the leftmost', async () => {
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post('/api/register', { handle: `xff-${i}`, name: 'X', password: PW }, { ip: `7.7.${i}.1, 9.9.9.9` })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(201));
  assert.equal(codes[10], 429, 'the eleventh from 9.9.9.9 waits');
});

test('AUTH-2 clientIp and ipKey: hop count, private proxies only, IPv4-mapped and IPv6 /64', () => {
  const r = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(r('127.0.0.1', '1.1.1.1, 2.2.2.2'), 1), '2.2.2.2');
  assert.equal(clientIp(r('127.0.0.1', '1.1.1.1, 2.2.2.2'), 2), '1.1.1.1');
  assert.equal(clientIp(r('127.0.0.1', '2.2.2.2'), 2), '2.2.2.2', 'fewer entries than hops: the leftmost there is');
  assert.equal(clientIp(r('203.0.113.9', '1.1.1.1'), 1), '203.0.113.9', 'a public peer is not our proxy');
  assert.equal(clientIp(r('10.0.0.2', '1.1.1.1'), 1), '1.1.1.1', 'a private proxy is trusted');
  assert.equal(clientIp(r('127.0.0.1', '1.1.1.1'), false), '127.0.0.1', 'no proxy configured: the socket address');
  assert.equal(clientIp(r('::ffff:127.0.0.1', 'junk, ::ffff:5.6.7.8'), 1), '5.6.7.8');
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:db8:1:2:bbbb::9'), 'one /64');
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
});

test('AUTH-2 registrations from one IPv6 /64 share one limit', async () => {
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post('/api/register', { handle: `v6-${i}`, name: 'V', password: PW }, { ip: `2001:db8:7:7::${(i + 1).toString(16)}` })).status);
  assert.equal(codes[10], 429);
});

// ---------- AUTH-3: lockout denial of service ----------
test('AUTH-3 ten wrong passwords from one address do not lock the owner out from another', async () => {
  await register('dos-alice');
  const A = '6.6.6.6';
  for (let i = 0; i < 10; i++) await login('dos-alice', `wrong ${i}`, { ip: A });
  const ok = await login('dos-alice', PW, { ip: '2.2.2.2' });
  assert.equal(ok.status, 200, await ok.clone().text());
});

test('AUTH-3 a handle that looks like an address cannot drain that address’s sign-in limit', async () => {
  await register('dos-bob');
  for (let i = 0; i < 10; i++) await login('3.3.3.3', 'whatever pw', { ip: '6.6.6.7' });
  const ok = await login('dos-bob', PW, { ip: '3.3.3.3' });
  assert.equal(ok.status, 200, await ok.clone().text());
});

test('AUTH-3 a right password is not charged against the account', async () => {
  await register('dos-carl');
  for (let i = 0; i < 25; i++) assert.equal((await login('dos-carl', PW)).status, 200, `sign-in ${i}`);
});

// ---------- AUTH-4: password hashing ----------
test('AUTH-4 new hashes are v2 with OWASP-level scrypt cost, and a legacy hash is upgraded at sign-in', async () => {
  const h = hashPassword('correct horse battery');
  const [kind, v, N, r, p] = h.split('$');
  assert.equal(kind, 'scrypt'); assert.equal(v, 'v2');
  // OWASP's scrypt minimums (Password Storage Cheat Sheet): N=2^17,p=1 / 2^16,2 / 2^15,3 / 2^14,5 / 2^13,10, all with r=8.
  const owasp = { 131072: 1, 65536: 2, 32768: 3, 16384: 5, 8192: 10 };
  assert.ok(Number(r) >= 8 && (Number(N) > 131072 || Number(p) >= (owasp[N] ?? Infinity)), h);
  assert.equal((await verifyPassword('correct horse battery', h)).ok, true);
  assert.equal((await verifyPassword('wrong horse battery', h)).ok, false);
  // A 0.10.1 hash: scrypt$salt$key with N=2^14.
  const u = await register('legacy-hash');
  const salt = randomBytes(16);
  const legacy = `scrypt$${salt.toString('base64')}$${scryptSync('an old password', salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  srv.db.run('UPDATE users SET pass = ? WHERE id = ?', legacy, u.id);
  assert.equal((await login('legacy-hash', 'an old password')).status, 200);
  assert.match(srv.db.get('SELECT pass FROM users WHERE id = ?', u.id).pass, /^scrypt\$v2\$/, 'rehashed');
  assert.equal((await login('legacy-hash', 'an old password')).status, 200, 'and still signs in');
});

test('AUTH-4 password checks do not block the event loop', async () => {
  await register('loop-check');
  let last = Date.now(), worst = 0;
  const t = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 1);
  await Promise.all(Array.from({ length: 5 }, (_, i) => login('loop-check', i % 2 ? PW : 'not it at all')));
  clearInterval(t);
  // One hash on the main thread would hold the loop for its whole run; slow runners get that as the yardstick.
  const t0 = Date.now();
  scryptSync('x', 'salt', 64, { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  const one = Date.now() - t0;
  assert.ok(worst < Math.max(25, one / 2), `longest pause ${worst} ms (one hash: ${one} ms)`);
});

// ---------- AUTH-5: common passwords ----------
test('AUTH-5 common passwords and the username itself are refused; a passphrase is fine', async () => {
  for (const password of ['12345678', 'password1', 'Password123', 'qwertyuiop', 'common-pw-user', 'my common-pw-user!']) {
    const res = await post('/api/register', { handle: 'common-pw-user', name: 'Common', password });
    assert.equal(res.status, 400, password);
  }
  const u = await register('common-pw-user', { password: 'violet kettle drumming' });
  assert.equal((await post('/api/password', { current: 'violet kettle drumming', next: 'iloveyou1' }, { cookie: u.cookie })).status, 400);
  assert.equal((await post('/api/password', { current: 'violet kettle drumming', next: 'violet kettle drumming' }, { cookie: u.cookie })).status, 400, 'the same password again');
  assert.equal((await post('/api/password', { current: 'violet kettle drumming', next: 'amber lantern swimming' }, { cookie: u.cookie })).status, 200);
});

// ---------- AUTH-6: audit log and new sign-in notice ----------
test('AUTH-6 sign-ins and security changes are logged without secrets; other devices hear of a new sign-in', async () => {
  const u = await register('audit-ann');
  const first = await sock(u.cookie);
  const before = logs.length;
  assert.equal((await login('audit-ann', 'secret wrong guess 1')).status, 401);
  const lines = logs.slice(before).join('\n');
  assert.match(lines, /"event":"login"[^\n]*"ok":false/);
  assert.doesNotMatch(lines, /secret wrong guess/);
  // A second sign-in reaches the first device.
  assert.equal((await login('audit-ann', PW, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/130.0' } })).status, 200);
  await sleep(100);
  assert.ok(first.events.some((e) => e.ev === 'account' && e.d.newSignIn), 'newSignIn event');
  // Two-factor on and off are logged; the codes never are.
  const begun = (await first.op('totp.begin')).d;
  const key = unbase32(begun.secret);
  const code = totpAt(key, Date.now());
  const on = await first.op('totp.enable', { password: PW, code });
  assert.equal(on.ok, true, on.error);
  const off = await first.op('totp.disable', { password: PW, code: on.d.codes[0] });
  assert.equal(off.ok, true, off.error);
  const all = logs.slice(before).join('\n');
  assert.match(all, /"event":"totp.enable"/);
  assert.match(all, /"event":"totp.disable"/);
  assert.ok(!all.includes(code) && !all.includes(on.d.codes[0]) && !all.includes(begun.secret) && !all.includes(PW), 'no code, secret or password in the log');
  // And the account can see its recent sign-ins.
  const recent = await first.op('auth.recent');
  assert.equal(recent.ok, true, recent.error);
  assert.ok(recent.d.events.some((e) => e.event === 'login' && e.ok === false));
  assert.ok(recent.d.events.every((e) => !('ip' in e) || /^[\d.]+\.x$|^[0-9a-f:]+::\/\d+$|^$/.test(e.ip)), 'addresses are truncated');
  first.close();
});

// ---------- AUTH-7: two-factor secrets at rest ----------
test('AUTH-7 the TOTP secret is encrypted and backup codes are keyed hashes; old plain rows still work and are upgraded', async () => {
  const u = await register('tf-rest');
  const s = await sock(u.cookie);
  const begun = (await s.op('totp.begin')).d;
  const pendingRow = srv.db.get('SELECT pending FROM totp WHERE user = ?', u.id).pending;
  assert.doesNotMatch(pendingRow, /^[A-Z2-7]+$/);
  assert.equal(pendingRow.includes(begun.secret), false);
  const key = unbase32(begun.secret);
  const on = await s.op('totp.enable', { password: PW, code: totpAt(key, Date.now()) });
  assert.equal(on.ok, true, on.error);
  const row = srv.db.get('SELECT secret, backup FROM totp WHERE user = ?', u.id);
  assert.doesNotMatch(row.secret, /^[A-Z2-7]+$/, 'not base32 plain text');
  const plainSha = on.d.codes.map((c) => createHash('sha256').update(`snug-backup:${c.replace(/[^a-z0-9]/g, '')}`).digest('hex'));
  for (const h of plainSha) assert.equal(row.backup.includes(h), false, 'not an unsalted SHA-256 of the code');
  // A backup code still signs in.
  const t = (await (await login('tf-rest', PW)).json()).ticket;
  assert.equal((await post('/api/login/totp', { ticket: t, code: on.d.codes[1] })).status, 200);
  s.close();
  // A 0.10.1 row: plain base32 secret and unsalted SHA-256 backup codes.
  const v = await register('tf-legacy');
  const k2 = Buffer.from('12345678901234567890');
  const oldHash = createHash('sha256').update('snug-backup:abcd2345').digest('hex');
  srv.db.run('INSERT INTO totp (user, secret, enabled, step, backup, created) VALUES (?, ?, 1, 0, ?, ?)', v.id, base32(k2), JSON.stringify([oldHash]), Date.now());
  const t2 = (await (await login('tf-legacy', PW)).json()).ticket;
  assert.equal((await post('/api/login/totp', { ticket: t2, code: totpAt(k2, Date.now()) })).status, 200);
  const up = srv.db.get('SELECT secret, backup FROM totp WHERE user = ?', v.id);
  assert.doesNotMatch(up.secret, /^[A-Z2-7]+$/, 'rewritten encrypted');
  assert.equal(up.backup.includes(oldHash), false, 'legacy backup hash rewrapped');
  const t3 = (await (await login('tf-legacy', PW)).json()).ticket;
  assert.equal((await post('/api/login/totp', { ticket: t3, code: 'abcd-2345' })).status, 200, 'the old backup code still works once');
});

// ---------- AUTH-8: one failure counter for every step-up check ----------
test('AUTH-8 wrong passwords on one step-up path slow every other path', async () => {
  const u = await register('stepup');
  const s = await sock(u.cookie);
  assert.equal((await s.op('totp.begin')).ok, true);
  for (let i = 0; i < 5; i++) {
    const a = await s.op('totp.enable', { password: `nope ${i}`, code: '123456' });
    assert.match(a.error, /password/, `try ${i}`);
  }
  const h = await s.op('me.handle', { handle: 'stepup-2', password: 'nope again' });
  assert.equal(h.ok, false);
  assert.doesNotMatch(h.error, /password isn’t right/);
  assert.match(h.error, /Too many|Wait/);
  const pw = await post('/api/password', { current: PW, next: 'brand new long phrase' }, { cookie: u.cookie });
  assert.equal(pw.status, 429, 'even the right password waits');
  s.close();
});

// ---------- AUTH-9: sockets of ended sessions close ----------
test('AUTH-9 signing out closes that session’s sockets; an expired session’s socket closes at the next check', async () => {
  const u = await register('sock-end');
  const two = cookieOf(await login('sock-end', PW));
  const a = await sock(u.cookie);
  const b = await sock(two);
  assert.equal((await post('/api/logout', {}, { cookie: u.cookie })).status, 200);
  assert.equal(await Promise.race([a.closed, sleep(2000).then(() => 'open')]), 4001);
  // Session two runs out.
  srv.db.run('UPDATE sessions SET expires = 1 WHERE user = ?', u.id);
  srv.hub.recheckSessions();
  assert.equal(await Promise.race([b.closed, sleep(2000).then(() => 'open')]), 4001);
});

// ---------- AUTH-10: step-up for sensitive account changes ----------
test('AUTH-10 sessions remember when their owner last proved who they are', async () => {
  const u = await register('recent-auth');
  const row = srv.db.get('SELECT auth_at FROM sessions WHERE user = ?', u.id);
  assert.ok(row.auth_at > Date.now() - 60_000);
});

// ---------- AUTH-11: cookies ----------
test('AUTH-11 secure servers use __Host-snug_session with Secure and HSTS; the old name still works; two session cookies are refused', async () => {
  const sdir = mkdtempSync(join(tmpdir(), 'snug-sec-auth-s-'));
  const s = await startServer({ port: 0, dataDir: sdir, quiet: true, secure: true });
  const sb = `http://127.0.0.1:${s.port}`;
  try {
    const res = await fetch(`${sb}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://' + `127.0.0.1:${s.port}` }, body: JSON.stringify({ handle: 'hosty', name: 'H', password: PW }) });
    assert.equal(res.status, 201, await res.clone().text());
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /^__Host-snug_session=/);
    assert.match(sc, /; Secure/);
    assert.match(sc, /Path=\//);
    assert.doesNotMatch(sc, /Domain=/i);
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    const token = decodeURIComponent(sc.split(';')[0].split('=')[1]);
    assert.equal((await fetch(`${sb}/api/me`, { headers: { cookie: `snug_session=${token}` } })).status, 200, 'the 0.10.1 name');
    assert.equal((await fetch(`${sb}/api/me`, { headers: { cookie: `__Host-snug_session=${token}` } })).status, 200);
  } finally { await s.close(); rmSync(sdir, { recursive: true, force: true }); }
  assert.equal((await get('/api/me')).headers.get('strict-transport-security'), null, 'no HSTS on plain http');
  // Behind an HTTPS proxy, the cookie is Secure even without SNUG_SECURE.
  const viaProxy = await post('/api/register', { handle: 'proxied', name: 'P', password: PW }, { headers: { 'x-forwarded-proto': 'https', origin: base.replace('http:', 'https:') } });
  assert.equal(viaProxy.status, 201, await viaProxy.clone().text());
  assert.match(viaProxy.headers.get('set-cookie'), /^__Host-snug_session=.*; Secure/);
  // Cookie tossing: two session cookies with the old name are refused.
  const u = await register('tossed');
  const other = await register('tosser');
  const t1 = u.cookie.split('=')[1], t2 = other.cookie.split('=')[1];
  assert.equal(readCookie(`${COOKIE}=${t1}; ${COOKIE}=${t2}`, COOKIE), null);
  assert.equal((await get('/api/me', { cookie: `${COOKIE}=${t2}; ${COOKIE}=${t1}` })).status, 401);
  assert.equal(readCookie(`${COOKIE}=${t2}; __Host-${COOKIE}=${t1}`, COOKIE), t1, 'the __Host- cookie wins');
  assert.match(sessionCookie('x', { secure: true }), /^__Host-snug_session=x; /);
});

// ---------- AUTH-12: login timing ----------
test('AUTH-12 a password-less account takes as long to refuse as an unknown one', async () => {
  const time = async (f) => { const t = process.hrtime.bigint(); await f(); return Number(process.hrtime.bigint() - t) / 1e6; };
  await verifyPassword('warm', '!');
  const a = Math.min(await time(() => verifyPassword('x', '!')), await time(() => verifyPassword('y', '!')));
  const b = Math.min(await time(() => burnPasswordCheck('x')), await time(() => burnPasswordCheck('y')));
  assert.ok(a / b > 0.5 && a / b < 2, `password-less ${a.toFixed(1)} ms vs unknown ${b.toFixed(1)} ms`);
});

// ---------- AUTH-13: idle sessions; two-factor ends other sessions ----------
test('AUTH-13 a session unused for 15 days has ended', async () => {
  const u = await register('idle-sess');
  const token = decodeURIComponent(u.cookie.split('=')[1]);
  assert.equal(sessionUser(srv.db, token), u.id);
  srv.db.run('UPDATE sessions SET seen = ? WHERE user = ?', Date.now() - 15 * 86_400_000, u.id);
  assert.equal(sessionUser(srv.db, token), null);
});

test('AUTH-13 turning on two-factor signs every other device out', async () => {
  const u = await register('tf-others');
  const second = cookieOf(await login('tf-others', PW));
  const s = await sock(u.cookie);
  const begun = (await s.op('totp.begin')).d;
  const on = await s.op('totp.enable', { password: PW, code: totpAt(unbase32(begun.secret), Date.now()) });
  assert.equal(on.ok, true, on.error);
  assert.equal((await get('/api/me', { cookie: second })).status, 401, 'the other device is signed out');
  assert.equal((await get('/api/me', { cookie: u.cookie })).status, 200, 'this one stays');
  s.close();
});
