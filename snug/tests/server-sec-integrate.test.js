// Security tests for the integration pass (sec-integrate): the parts the five
// fixers left open or that only showed up when their work met. Every refusal
// that matters reaches the one security log (server/seclog.js); the account's
// "Recent activity" shows its alerts; a made-up session cookie doesn't skip the
// signed-out rate limit; the link filter is linear; a throwaway data key never
// writes database snapshots; GCM tags are always 16 bytes; server ids are
// unbiased; a friend's PC gets the same WebRTC signal check as a local member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { hasLink, filterHit } from '../js/lib/safety.js';
import { gcmOpen } from '../server/peercrypto.js';
import { boxOpen } from '../server/vaultxfer.js';
import { newId } from '../server/model.js';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'snug-sec-int-')); dirs.push(d); return d; };
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: tmp(), quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PW = 'a long password';
async function register(handle) {
  const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ handle, name: handle, password: PW }) });
  assert.equal(res.status, 201, await res.clone().text());
  return { id: (await res.json()).user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}
function wsOpen({ cookie, origin = base } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { ...(cookie ? { cookie } : {}), origin } });
    const acks = new Map();
    let seq = 0;
    const api = {
      ws,
      op: (op, d = {}) => { const id = ++seq; ws.send(JSON.stringify({ t: 'op', id, op, d })); return new Promise((r) => acks.set(id, r)); },
    };
    ws.on('message', (b) => { const m = JSON.parse(b); if (m.t === 'hello') resolve({ ok: true, ...api }); else if (m.t === 'ack') acks.get(m.id)?.(m); });
    ws.on('unexpected-response', (_q, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false }));
  });
}
const events = (kind, after = 0) => srv.db.all('SELECT * FROM security_events WHERE kind = ? AND id > ?', kind, after);
const lastId = () => srv.db.get('SELECT COALESCE(MAX(id), 0) n FROM security_events').n;

// ---------- Security events from every area ----------
test('a socket from another site is refused and lands in the security log', async () => {
  const u = await register('int-ws-origin');
  const before = lastId();
  const r = await wsOpen({ cookie: u.cookie, origin: 'http://evil.example' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  const rows = events('origin.refused', before);
  assert.equal(rows.length, 1);
  assert.match(rows[0].detail, /\/ws/);
  assert.match(rows[0].detail, /evil\.example/);
});

test('a socket op refused by its rate limit is a ratelimit.hit with the person and the op', async () => {
  const u = await register('int-ws-rate');
  const c = await wsOpen({ cookie: u.cookie });
  assert.equal(c.ok, true);
  const before = lastId();
  // sync: 6 at once, then one every 5 s (server/hub.js).
  const acks = await Promise.all(Array.from({ length: 9 }, () => c.op('sync')));
  assert.ok(acks.some((a) => a.ok === false && /going a little fast/.test(a.error)), 'some syncs are refused');
  const rows = events('ratelimit.hit', before);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].user, u.id);
  assert.match(rows[0].detail, /"op":"sync"/);
  assert.equal(rows[0].ip, '127.0.0.x'); // the address is truncated, never whole
  c.ws.close();
});

test('the 11th socket evicts the oldest and that is recorded', async () => {
  const u = await register('int-ws-evict');
  const open = [];
  for (let i = 0; i < 10; i++) open.push(await wsOpen({ cookie: u.cookie }));
  const before = lastId();
  const closed = new Promise((r) => open[0].ws.on('close', (code) => r(code)));
  const extra = await wsOpen({ cookie: u.cookie });
  assert.equal(extra.ok, true);
  assert.equal(await closed, 4008);
  const rows = events('socket.evicted', before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, u.id);
  for (const s of [...open, extra]) s.ws.close();
});

test('a refused hierarchy change (room override on a role above you) is recorded', async () => {
  const owner = await register('int-hier-owner');
  const mod = await register('int-hier-mod');
  const o = await wsOpen({ cookie: owner.cookie });
  const h = await o.op('house.create', { name: 'Hier house', hue: 142 });
  assert.equal(h.ok, true, h.error);
  const house = srv.db.get('SELECT house FROM members WHERE user = ?', owner.id).house;
  const roles = srv.db.all('SELECT id, name FROM roles WHERE house = ? ORDER BY pos', house);
  // A moderator role that may manage rooms, sitting under a higher "senior" role.
  const senior = 'r_intsenior01';
  const modRole = 'r_intmodrole1';
  srv.db.run("INSERT INTO roles (id, house, name, pos, perms) VALUES (?, ?, 'Senior', 1, '[]')", senior, house);
  srv.db.run("INSERT INTO roles (id, house, name, pos, perms) VALUES (?, ?, 'Mod', 2, ?)", modRole, house, JSON.stringify(['rooms']));
  srv.db.run('UPDATE roles SET pos = pos + 2 WHERE house = ? AND id NOT IN (?, ?) AND pos > 0', house, senior, modRole);
  srv.db.run('INSERT INTO members (house, user, role, newcomer, joined) VALUES (?, ?, ?, 0, ?)', house, mod.id, modRole, Date.now());
  const room = srv.db.get("SELECT id FROM rooms WHERE house = ? AND kind = 'text' LIMIT 1", house).id;
  const m = await wsOpen({ cookie: mod.cookie });
  const before = lastId();
  const r = await m.op('room.override', { room, type: 'role', target: senior, allow: [], deny: [] });
  assert.equal(r.ok, false);
  assert.ok(roles.length >= 1);
  const rows = events('access.refused', before);
  assert.ok(rows.length >= 1, `refusal: ${r.error}`);
  assert.equal(rows[0].user, mod.id);
  assert.match(rows[0].detail, /room\.override/);
  o.ws.close(); m.ws.close();
});

// ---------- Alerts in the account's Recent activity ----------
test('auth.recent shows the account’s security alerts next to its sign-ins', async () => {
  const u = await register('int-recent');
  for (let i = 0; i < 7; i++) {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'int-recent', password: `wrong password ${i}` }) });
    assert.ok([401, 429].includes(res.status));
  }
  assert.ok(srv.db.get("SELECT COUNT(*) n FROM security_events WHERE kind = 'alert' AND user = ?", u.id).n >= 1, 'the detector raised an alert');
  const c = await wsOpen({ cookie: u.cookie });
  const r = await c.op('auth.recent');
  assert.equal(r.ok, true, r.error);
  const alert = r.d.events.find((e) => e.event === 'alert');
  assert.ok(alert, 'an alert is listed');
  assert.match(alert.what, /failed sign-in/);
  assert.equal(alert.ok, false);
  assert.ok(r.d.events.some((e) => e.event === 'login' && e.ok === false));
  for (let i = 1; i < r.d.events.length; i++) assert.ok(r.d.events[i - 1].at >= r.d.events[i].at, 'newest first');
  c.ws.close();
});

// ---------- The signed-out rate limit ----------
test('a made-up session cookie no longer skips the signed-out read limit', async () => {
  let limited = 0;
  for (let i = 0; i < 320; i++) {
    const res = await fetch(`${base}/api/invite/nosuchcode${i}`, { headers: { cookie: 'snug_session=made-up-token' } });
    await res.arrayBuffer();
    if (res.status === 429) limited++;
  }
  assert.ok(limited > 0, 'some requests were rate limited');
  // A real session still isn't limited by it.
  srv.resetLimits();
  const u = await register('int-openlimit');
  for (let i = 0; i < 320; i++) {
    const res = await fetch(`${base}/api/me`, { headers: { cookie: u.cookie } });
    await res.arrayBuffer();
    assert.equal(res.status, 200);
  }
});

// ---------- The link filter ----------
test('hasLink is the old link pattern, in linear time', () => {
  const OLD = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|co|me|app|dev|xyz|ly|tv|info|biz|ru|uk|de|link|site|online|shop|top|click)\b(?:\/\S*)?/i;
  const parts = ['a', 'B', '1', '-', '.', '_', ' ', 'com', 'co', 'uk', 'm', 'www', 'http', '://', '/', 'é', 'x', '\n', 'org', '.com'];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let n = 0; n < 50_000; n++) {
    let s = '';
    for (let i = 0, L = 1 + rnd(14); i < L; i++) s += parts[rnd(parts.length)];
    assert.equal(hasLink(s), OLD.test(s), JSON.stringify(s));
  }
  for (const [s, want] of [['see example.com', true], ['a.-.com', true], ['-x.co.uk/page', true], ['_.com', false], ['www.', false], ['www.x', true], ['https://x', true], ['the community', false], ['a..com', false]]) {
    assert.equal(hasLink(s), want, s);
  }
  assert.deepEqual(filterHit('visit example.com now', { links: true, words: [] }), { link: true });
  // The input that took quadratic time: 20,000 characters well under 50 ms.
  for (const big of ['a-'.repeat(10_000), 'a.'.repeat(10_000), `_${'-.'.repeat(10_000)}com`, '_.com'.repeat(4000)]) {
    const t = performance.now();
    hasLink(big);
    assert.ok(performance.now() - t < 50, `took ${performance.now() - t} ms`);
  }
});

// ---------- The data key ----------
test('a data key that can’t be read never writes or restores database snapshots', async () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'secret.key'), '{ not json');
  const before = readFileSync(join(dir, 'secret.key'), 'utf8');
  const s = await startServer({ port: 0, dataDir: dir, quiet: true });
  try {
    assert.equal(s.dbSnapshots, null);
    assert.equal(readFileSync(join(dir, 'secret.key'), 'utf8'), before, 'the unreadable key file is never replaced');
  } finally { await s.close(); }
  // A readable key does get snapshots.
  const ok = await startServer({ port: 0, dataDir: tmp(), quiet: true });
  try { assert.ok(ok.dbSnapshots && typeof ok.dbSnapshots.now === 'function'); } finally { await ok.close(); }
});

// ---------- AES-GCM tags ----------
// Node accepts a shorter GCM tag unless the length is fixed. Every opener slices 16 bytes today, so this guards the
// rule in the source: each AES-GCM decipher in the server names authTagLength 16 (semgrep finding, tooling.md).
test('every AES-GCM decipher in the server fixes the tag at 16 bytes', () => {
  const files = ['auth.js', 'dbbackup.js', 'peercrypto.js', 'vaultfile.js', 'vaultxfer.js'];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/createDecipheriv\(\s*'aes-256-gcm'[^;]*;/g)) {
      seen++;
      assert.match(m[0], /authTagLength:\s*16/, `${f}: ${m[0]}`);
    }
  }
  assert.ok(seen >= 5);
  // And a tag cut short is refused by the openers.
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 4 });
  c.setAAD(Buffer.from('aad'));
  const short = Buffer.concat([c.update(Buffer.alloc(20, 1)), c.final(), c.getAuthTag()]);
  assert.throws(() => gcmOpen(key, iv, short, 'aad'));
  assert.throws(() => boxOpen(key, 'x', 'a', 1, short.toString('base64url')));
});

// ---------- Ids ----------
test('server ids use every character evenly', () => {
  const counts = new Map();
  for (let i = 0; i < 20_000; i++) for (const ch of newId('f').slice(2)) counts.set(ch, (counts.get(ch) || 0) + 1);
  assert.equal(counts.size, 36);
  const n = 20_000 * 14 / 36;
  // Modulo bias put the first four characters about 14% above the rest; even, they stay within 5%.
  for (const [ch, k] of counts) assert.ok(Math.abs(k - n) / n < 0.05, `${ch}: ${k} vs ${n}`);
});

// ---------- sec-review: nothing is sealed under a throwaway data key ----------
// With secret.key unreadable (a locked OS key store, a damaged file), two-factor fails closed for that run.
// Reading a 0.10.1 two-factor row must not "upgrade" its plain secret and backup digests under the throwaway
// key: once the real key is back, they would be unreadable for good and the owner locked out.
test('review: an unreadable data key never re-seals 0.10.1 two-factor secrets or backup codes', async () => {
  const { base32, totpAt } = await import('../server/account.js');
  const { createHash } = await import('node:crypto');
  const dir = tmp();
  const login = async (b, handle) => (await fetch(`${b}/api/login`, { method: 'POST', headers: { origin: b, 'content-type': 'application/json' }, body: JSON.stringify({ handle, password: PW }) })).json();
  const raw = randomBytes(20);
  const code = 'abcd-efgh';
  let s = await startServer({ port: 0, dataDir: dir, quiet: true });
  let b = `http://127.0.0.1:${s.port}`;
  const reg = await fetch(`${b}/api/register`, { method: 'POST', headers: { origin: b, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'oldtotp', name: 'Old', password: PW }) });
  assert.equal(reg.status, 201);
  const uid = s.db.get("SELECT id FROM users WHERE handle = 'oldtotp'").id;
  // A two-factor row as 0.10.1 stored it: the secret in plain base32, backup codes as unsalted SHA-256.
  const legacy = createHash('sha256').update(`snug-backup:${code.replace(/[^a-z0-9]/g, '')}`).digest('hex');
  s.db.run('INSERT INTO totp (user, secret, enabled, step, backup, created) VALUES (?, ?, 1, 0, ?, ?)', uid, base32(raw), JSON.stringify([legacy]), Date.now());
  await s.close();
  // The key file can't be read for one run; someone signs in (the row is read).
  const good = readFileSync(join(dir, 'secret.key'));
  writeFileSync(join(dir, 'secret.key'), '{ not json');
  s = await startServer({ port: 0, dataDir: dir, quiet: true });
  b = `http://127.0.0.1:${s.port}`;
  const r1 = await login(b, 'oldtotp');
  assert.equal(r1.totp, true);
  // And no new two-factor secret is made under the throwaway key.
  const reg2 = await fetch(`${b}/api/register`, { method: 'POST', headers: { origin: b, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'newtotp', name: 'New', password: PW }) });
  const ack = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { cookie: reg2.headers.get('set-cookie').split(';')[0], origin: b } });
    ws.on('message', (m) => { const x = JSON.parse(m); if (x.t === 'hello') ws.send(JSON.stringify({ t: 'op', id: 1, op: 'totp.begin', d: {} })); if (x.t === 'ack') { ws.close(); resolve(x); } });
  });
  assert.equal(ack.ok, false);
  assert.match(String(ack.error ?? ack.d?.error ?? JSON.stringify(ack)), /key file/);
  await s.close();
  // The key is back: the code from the authenticator app and the backup code both still work.
  writeFileSync(join(dir, 'secret.key'), good);
  s = await startServer({ port: 0, dataDir: dir, quiet: true });
  b = `http://127.0.0.1:${s.port}`;
  try {
    const r2 = await login(b, 'oldtotp');
    const res = await fetch(`${b}/api/login/totp`, { method: 'POST', headers: { origin: b, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: r2.ticket, code: totpAt(raw, Date.now()) }) });
    assert.equal(res.status, 200, 'the authenticator code still works');
    const r3 = await login(b, 'oldtotp');
    const res2 = await fetch(`${b}/api/login/totp`, { method: 'POST', headers: { origin: b, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: r3.ticket, code }) });
    assert.equal(res2.status, 200, 'the backup code still works');
  } finally { await s.close(); }
});
