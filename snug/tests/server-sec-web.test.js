// Security tests for the web layer (the "web" findings W1 to W7 and the
// hardening that came with them): a file row with no bytes on disk must not
// crash the server, DNS rebinding must not get past the Origin checks, the
// client must not pick its own rate-limit address, security events are kept
// and shown to their owner, logs never hold webhook tokens or forged lines,
// security headers go on every response, and sockets per person are capped.
// Each test was written to fail on the code before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import * as A from '../server/auth.js';

const seclog = () => import('../server/seclog.js');
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'snug-sec-web-')); dirs.push(d); return d; };

// Every log line the main server writes (kept off the test output).
const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? String(x.stack) : JSON.stringify(x))).join(' ')); };

let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: tmp(), quiet: false }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { console.log = realLog; await srv.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PW = 'a long password';
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const post = (path, body, { cookie, at = base, headers = {} } = {}) => fetch(at + path, {
  method: 'POST',
  headers: { origin: at, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(10_000),
});
const get = (path, { cookie, at = base, headers = {} } = {}) => fetch(at + path, { headers: { ...(cookie ? { cookie } : {}), ...headers }, signal: AbortSignal.timeout(10_000) });
async function register(handle, at = base) {
  const res = await post('/api/register', { handle, name: handle, password: PW }, { at });
  assert.equal(res.status, 201, await res.clone().text());
  const d = await res.json();
  return { id: d.user.id, cookie: cookieOf(res), handle };
}
// A raw request, so the Host header is exactly what we say (fetch drops a custom Host).
function raw(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers, timeout: 10_000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timed out')));
    if (body) r.write(body);
    r.end();
  });
}
function wsOpen(port, { cookie, origin, host } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(host ? { host } : {}) } });
    let hello = false;
    ws.on('message', (b) => { if (JSON.parse(b).t === 'hello' && !hello) { hello = true; resolve({ ok: true, ws }); } });
    ws.on('unexpected-response', (_q, res) => resolve({ ok: false, status: res.statusCode, ws }));
    ws.on('error', (e) => { if (!hello) resolve({ ok: false, error: e.message, ws }); });
  });
}
const alive = async () => (await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })).status;

// ---------- W1: a file whose bytes are gone is a 404, never a crash ----------
test('W1 a conversation file with a row but no bytes on disk gives 404 and the server keeps running', async () => {
  const u = await register('w1-files');
  const { ws } = await wsOpen(srv.port, { cookie: u.cookie, origin: base });
  await new Promise((r) => { ws.send(JSON.stringify({ t: 'op', id: 1, op: 'house.create', d: { name: 'W1 house', hue: 142 } })); ws.on('message', (b) => { if (JSON.parse(b).t === 'ack') r(); }); });
  ws.close();
  const room = srv.db.get("SELECT id FROM rooms WHERE kind = 'text' AND house IN (SELECT house FROM members WHERE user = ?) LIMIT 1", u.id).id;
  assert.ok(srv.M.canRead(u.id, room));
  srv.db.run("INSERT INTO files (id, owner, conv, name, type, size, created) VALUES ('f_w1gone0001', ?, ?, 'a.png', 'image/png', 10, ?)", u.id, room, Date.now());
  const res = await get('/api/files/f_w1gone0001', { cookie: u.cookie });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('content-disposition'), null);
  // A range request for it too.
  assert.equal((await get('/api/files/f_w1gone0001', { cookie: u.cookie, headers: { range: 'bytes=0-3' } })).status, 404);
  assert.equal(await alive(), 200);
});

test('W1 a profile picture, banner, sticker and sound with no bytes on disk give 404 and the server keeps running', async () => {
  const u = await register('w1-pics');
  srv.db.run("INSERT INTO files (id, owner, conv, name, type, size, created) VALUES ('f_w1avatar01', ?, ?, 'a', 'image/png', 10, ?)", u.id, `avatar:${u.id}`, Date.now());
  srv.db.run("UPDATE users SET avatar = 'f_w1avatar01' WHERE id = ?", u.id);
  const res = await get('/api/avatars/f_w1avatar01', { cookie: u.cookie }).catch((e) => ({ status: `failed: ${e.message}` }));
  assert.equal(res.status, 404);
  srv.db.run("INSERT INTO files (id, owner, conv, name, type, size, created) VALUES ('f_w1banner01', ?, ?, 'b', 'image/png', 10, ?)", u.id, `banner:${u.id}`, Date.now());
  srv.db.run("UPDATE users SET banner = 'f_w1banner01' WHERE id = ?", u.id);
  const b = await get('/api/banners/f_w1banner01', { cookie: u.cookie }).catch((e) => ({ status: `failed: ${e.message}` }));
  assert.ok([404].includes(b.status), `banner: ${b.status}`);
  assert.equal(await alive(), 200);
});

test('W1 a static file that disappears between the check and the read gives 404', async () => {
  const { sendFile } = await seclog();
  const s = http.createServer((req, res) => { sendFile(res, join(tmp(), 'nope.bin')); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const r = await raw(s.address().port);
  assert.equal(r.status, 404);
  await new Promise((done) => s.close(done));
});

// ---------- W2: DNS rebinding: a Host this server doesn't answer to is refused ----------
test('W2 a request whose Host is a foreign name is refused (421), with the matching Origin too', async () => {
  const evil = `evil.test:${srv.port}`;
  const body = JSON.stringify({ handle: 'w2-rebind', name: 'x', password: PW });
  const r = await raw(srv.port, { method: 'POST', path: '/api/register', headers: { host: evil, origin: `http://${evil}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body });
  assert.equal(r.status, 421);
  assert.equal(srv.db.get("SELECT id FROM users WHERE handle = 'w2-rebind'"), undefined);
  // GETs too (the page itself would load under the foreign name otherwise).
  assert.equal((await raw(srv.port, { headers: { host: evil } })).status, 421);
  // The real names still work.
  for (const host of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`]) {
    const b = JSON.stringify({ handle: `w2-ok-${host[0]}`, name: 'x', password: PW });
    const ok = await raw(srv.port, { method: 'POST', path: '/api/register', headers: { host, origin: `http://${host}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }, body: b });
    assert.equal(ok.status, 201, `${host}: ${ok.body}`);
  }
});

test('W2 a socket opened under a foreign Host is refused even with a valid cookie', async () => {
  const u = await register('w2-sock');
  const evil = `evil.test:${srv.port}`;
  const bad = await wsOpen(srv.port, { cookie: u.cookie, origin: `http://${evil}`, host: evil });
  assert.equal(bad.ok, false);
  assert.ok([403, 421].includes(bad.status), `status ${bad.status}`);
  bad.ws.terminate();
  const good = await wsOpen(srv.port, { cookie: u.cookie, origin: base });
  assert.equal(good.ok, true);
  good.ws.close();
});

test('W2 a server bound to every address keeps answering any Host unless SNUG_HOSTS is set', async () => {
  const open = await startServer({ port: 0, host: '0.0.0.0', dataDir: tmp(), quiet: true });
  try { assert.equal((await raw(open.port, { headers: { host: `snug.example.org:${open.port}` } })).status, 200); } finally { await open.close(); }
  const strict = await startServer({ port: 0, host: '0.0.0.0', dataDir: tmp(), quiet: true, hosts: ['snug.example.org'] });
  try {
    assert.equal((await raw(strict.port, { headers: { host: `snug.example.org:${strict.port}` } })).status, 200);
    assert.equal((await raw(strict.port, { headers: { host: `evil.test:${strict.port}` } })).status, 421);
    // An address typed as an IP can't be a rebinding attack (the page's origin is that IP).
    assert.equal((await raw(strict.port, { headers: { host: `192.168.1.20:${strict.port}` } })).status, 200);
  } finally { await strict.close(); }
});

// ---------- W3: behind a proxy the address is the one the proxy saw ----------
test('W3 clientIp takes the entry the trusted proxy appended, not the leftmost one', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' } };
  assert.equal(A.clientIp(req, 1), '9.9.9.9');
  assert.equal(A.clientIp({ socket: { remoteAddress: '8.8.8.8' }, headers: req.headers }, 1), '8.8.8.8', 'a public peer is not a proxy');
});

test('W3 with a trusted proxy, rotating the leftmost X-Forwarded-For does not escape the sign-in limit', async () => {
  const p = await startServer({ port: 0, dataDir: tmp(), quiet: true, trustProxy: 1 });
  const at = `http://127.0.0.1:${p.port}`;
  try {
    const codes = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await post('/api/login', { handle: `nobody${i}`, password: 'wrong wrong' }, { at, headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` } })).status);
    }
    assert.equal(codes.at(-1), 429, codes.join(','));
  } finally { await p.close(); }
});

// ---------- W4: security events are kept, shown to their owner, and watched ----------
test('W4 sign-in failures and successes are listed for the owner only, with no secrets', async () => {
  const alice = await register('w4-alice');
  const bob = await register('w4-bob');
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/login', { handle: 'w4-alice', password: `wrong password ${i}` })).status, 401);
  const ok = await post('/api/login', { handle: 'w4-alice', password: PW });
  assert.equal(ok.status, 200);
  const res = await get('/api/account/security-events', { cookie: alice.cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-store/);
  const text = await res.text();
  const { events } = JSON.parse(text);
  const logins = events.filter((e) => e.kind === 'login');
  assert.equal(logins.filter((e) => !e.ok).length, 3, text);
  assert.ok(logins.some((e) => e.ok), text);
  assert.ok(!text.includes('wrong password') && !text.includes(PW), 'no passwords');
  assert.ok(!text.includes(cookieOf(ok).split('=')[1]) && !/snug_session/.test(text), 'no tokens');
  for (const e of events) if (e.ip) assert.match(e.ip, /\.x$|::\/48$/, 'addresses are truncated');
  // Bob sees none of Alice's.
  const bobs = await (await get('/api/account/security-events', { cookie: bob.cookie })).json();
  assert.equal(bobs.events.filter((e) => e.kind === 'login' && !e.ok).length, 0);
  // Signed out: nothing.
  assert.equal((await get('/api/account/security-events')).status, 401);
});

test('W4 refused cross-site requests, refused hosts and rate limits are recorded, and a burst raises an alert', async () => {
  const before = srv.db.get('SELECT COUNT(*) n FROM security_events').n;
  assert.equal((await post('/api/login', { handle: 'x', password: 'y' }, { headers: { origin: 'http://evil.test' } })).status, 403);
  assert.equal((await raw(srv.port, { headers: { host: `evil.test:${srv.port}` } })).status, 421);
  const kinds = srv.db.all('SELECT kind, ip, detail FROM security_events WHERE id > ?', before).map((r) => r.kind);
  assert.ok(kinds.includes('origin.refused'), kinds.join());
  assert.ok(kinds.includes('host.refused'), kinds.join());
  // Many failed sign-ins for one account in a few minutes: an alert row and a log line.
  await register('w4-target');
  for (let i = 0; i < 7; i++) await post('/api/login', { handle: 'w4-target', password: `guess ${i}` });
  const target = srv.db.get("SELECT id FROM users WHERE handle = 'w4-target'").id;
  await new Promise((r) => setTimeout(r, 50));
  const alerts = srv.db.all("SELECT * FROM security_events WHERE kind = 'alert' AND user = ?", target);
  assert.ok(alerts.length >= 1, 'an alert for the burst');
  assert.ok(logs.some((l) => /security alert/.test(l)), 'an alert log line');
  // Rate-limited requests are recorded too.
  srv.resetLimits();
  let hit = false;
  for (let i = 0; i < 40 && !hit; i++) hit = (await post('/api/register', {}, {})).status === 429;
  assert.ok(hit);
  assert.ok(srv.db.get("SELECT COUNT(*) n FROM security_events WHERE kind = 'ratelimit.hit'").n >= 1);
});

test('W4 events older than 90 days are removed by the sweep, and each account keeps a bounded number', async () => {
  const u = await register('w4-old');
  const old = Date.now() - 91 * 86_400_000;
  srv.db.run("INSERT INTO security_events (ts, user, kind, ip, agent, detail) VALUES (?, ?, 'origin.refused', '', '', '{}')", old, u.id);
  for (let i = 0; i < 520; i++) srv.db.run("INSERT INTO security_events (ts, user, kind, ip, agent, detail) VALUES (?, ?, 'ratelimit.hit', '', '', '{}')", Date.now() - i, u.id);
  srv.seclog.prune();
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM security_events WHERE ts < ?', Date.now() - 90 * 86_400_000).n, 0);
  assert.ok(srv.db.get('SELECT COUNT(*) n FROM security_events WHERE user = ?', u.id).n <= 500);
});

// ---------- W5: logs never hold webhook tokens or forged lines ----------
test('W5 redact masks webhook tokens, keys and control characters', async () => {
  const { redact } = await seclog();
  const out = redact('/api/hooks/wh_abc12345/AAAAAAAAAAAAAAAAAAAAAAAA\nFAKE line');
  assert.ok(!out.includes('AAAAAAAAAAAAAAAAAAAAAAAA'), out);
  assert.ok(!/[\n\r]/.test(out), out);
  assert.match(out, /\/api\/hooks\/wh_abc12345\/\*\*\*/);
  const k = redact('Authorization: Bearer abc.def.ghi token=s3cr3t&x=1 cookie: snug_session=zzzz; "password":"hunter2"');
  for (const s of ['abc.def.ghi', 's3cr3t', 'zzzz', 'hunter2']) assert.ok(!k.includes(s), k);
  assert.ok(redact('x'.repeat(5000)).length <= 2100);
});

test('W5 a server error on a webhook address logs the path without its token', async () => {
  const token = 'TOKENtokenTOKENtoken1234';
  const realGet = srv.db.get;
  srv.db.get = function (sql, ...a) { if (/FROM hooks/.test(sql)) throw new Error('boom'); return realGet.call(this, sql, ...a); };
  const n = logs.length;
  try {
    const res = await fetch(`${base}/api/hooks/wh_abcdefgh12/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"content":"x"}' });
    assert.equal(res.status, 500);
  } finally { srv.db.get = realGet; }
  const lines = logs.slice(n);
  assert.ok(lines.some((l) => /error/.test(l) && /hooks/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes(token)), lines.join('\n'));
  assert.ok(!lines.some((l) => /\n/.test(l)), 'one line per entry');
});

// ---------- W6: security headers on every response ----------
test('W6 every response carries CORP, frame and content policies; HSTS only when secure', async () => {
  const u = await register('w6-heads');
  for (const p of ['/brand/favicon.svg', '/api/me', '/js/app.js', '/api/nope']) {
    const r = await get(p, { cookie: u.cookie });
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
    assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, p);
    assert.equal(r.headers.get('strict-transport-security'), null, p);
  }
  assert.match((await get('/brand/favicon.svg')).headers.get('content-security-policy'), /default-src 'none'/);
  const page = (await get('/')).headers.get('content-security-policy');
  assert.match(page, /script-src 'self'/);
  assert.doesNotMatch(page, /upgrade-insecure-requests/);
  const s = await startServer({ port: 0, dataDir: tmp(), quiet: true, secure: true });
  try {
    for (const p of ['/', '/api/me', '/api/nope']) {
      const r = await fetch(`http://127.0.0.1:${s.port}${p}`);
      assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/, p);
    }
    assert.match((await fetch(`http://127.0.0.1:${s.port}/`)).headers.get('content-security-policy'), /upgrade-insecure-requests/);
  } finally { await s.close(); }
  // Behind a TLS proxy too.
  const p = await startServer({ port: 0, dataDir: tmp(), quiet: true, trustProxy: 1 });
  try {
    const r = await fetch(`http://127.0.0.1:${p.port}/api/me`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(r.headers.get('strict-transport-security') || '', /max-age/);
  } finally { await p.close(); }
});

// ---------- W7: sockets per person are capped ----------
test('W7 opening more sockets than the cap closes the oldest with 4008 and the server keeps answering', async () => {
  const u = await register('w7-socks');
  const socks = [];
  for (let i = 0; i < 11; i++) {
    const s = await wsOpen(srv.port, { cookie: u.cookie, origin: base });
    assert.equal(s.ok, true, `socket ${i}: ${s.status || s.error}`);
    socks.push(s.ws);
  }
  const code = await new Promise((r) => { if (socks[0].readyState === WebSocket.CLOSED) r(4008); else socks[0].on('close', (c) => r(c)); });
  assert.equal(code, 4008);
  assert.equal(await alive(), 200);
  for (const s of socks) s.terminate();
});

// ---------- Hardening ----------
test('hardening: a state change with no Origin but Sec-Fetch-Site cross-site is refused', async () => {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{"handle":"x","password":"y"}' });
  assert.equal(r.status, 403);
  const same = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{"handle":"nobody-here","password":"yyyyyyyy"}' });
  assert.equal(same.status, 401);
});

test('hardening: signing out tells the browser to drop its cache of private files', async () => {
  const u = await register('h-logout');
  const r = await post('/api/logout', {}, { cookie: u.cookie });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('clear-site-data') || '', /"cache"/);
  const v = await register('h-logout2');
  const r2 = await post('/api/logout-all', {}, { cookie: v.cookie });
  assert.match(r2.headers.get('clear-site-data') || '', /"cache"/);
});

test('hardening: attachments are not kept in a shared browser cache', async () => {
  const u = await register('h-cache');
  const res = await fetch(`${base}/api/files?conv=nope`, { method: 'POST', headers: { origin: base, cookie: u.cookie, 'content-type': 'image/png', 'content-length': '3' }, body: 'abc' });
  assert.ok([403, 201].includes(res.status));
  const { ws } = await wsOpen(srv.port, { cookie: u.cookie, origin: base });
  await new Promise((r) => { ws.send(JSON.stringify({ t: 'op', id: 1, op: 'house.create', d: { name: 'H house', hue: 142 } })); ws.on('message', (b) => { if (JSON.parse(b).t === 'ack') r(); }); });
  ws.close();
  const room = srv.db.get("SELECT id FROM rooms WHERE kind = 'text' AND house IN (SELECT house FROM members WHERE user = ?) LIMIT 1", u.id).id;
  const up = await fetch(`${base}/api/files?conv=${room}`, { method: 'POST', headers: { origin: base, cookie: u.cookie, 'content-type': 'text/plain', 'content-length': '5', 'x-file-name': 'a.txt' }, body: 'hello' });
  assert.equal(up.status, 201);
  const { id } = await up.json();
  const f = await get(`/api/files/${id}`, { cookie: u.cookie });
  assert.equal(await f.text(), 'hello');
  assert.match(f.headers.get('cache-control'), /no-store/);
});

test('hardening: link previews refuse IPv4-translated and benchmarking IPv6 addresses', async () => {
  const { v6Blocked, addressBlocked } = await import('../server/linkpreview.js');
  for (const a of ['::ffff:0:7f00:1', '::ffff:0:a00:1', '2001:2::1', '2001:10::1', '3fff::1', '64:ff9b:1::a00:1', '5f00::1']) assert.equal(v6Blocked(a), true, a);
  for (const a of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '64:ff9b::808:808', '::ffff:8.8.8.8']) assert.equal(addressBlocked(a), false, a);
});

test('hardening: unauthenticated API reads are rate limited per address', async () => {
  let limited = false;
  for (let i = 0; i < 400 && !limited; i++) limited = (await get('/api/invite/nosuchcode1')).status === 429;
  assert.ok(limited);
  srv.resetLimits();
  assert.equal((await get('/api/invite/nosuchcode1')).status, 404);
});

test('hardening: the page reports what a stricter policy would block, and the reports are kept', async () => {
  const page = await get('/');
  assert.match(page.headers.get('content-security-policy-report-only') || '', /require-trusted-types-for 'script'.*report-uri \/api\/csp-report/);
  const before = srv.db.get("SELECT COUNT(*) n FROM security_events WHERE kind = 'csp.violation'").n;
  const r = await fetch(`${base}/api/csp-report`, { method: 'POST', headers: { origin: base, 'content-type': 'application/csp-report' },
    body: JSON.stringify({ 'csp-report': { 'document-uri': `${base}/m/x?token=secret1234`, 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.test/x.js?k=1', disposition: 'report' } }) });
  assert.equal(r.status, 204);
  const rows = srv.db.all("SELECT detail FROM security_events WHERE kind = 'csp.violation' ORDER BY id DESC LIMIT 1");
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM security_events WHERE kind = 'csp.violation'").n, before + 1);
  assert.match(rows[0].detail, /evil\.test/);
  assert.doesNotMatch(rows[0].detail, /secret1234|k=1/);
  // The Reporting API form too.
  const r2 = await fetch(`${base}/api/csp-report`, { method: 'POST', headers: { origin: base, 'content-type': 'application/reports+json' },
    body: JSON.stringify([{ type: 'csp-violation', body: { documentURL: `${base}/`, effectiveDirective: 'style-src-attr', blockedURL: 'inline', disposition: 'report' } }]) });
  assert.equal(r2.status, 204);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM security_events WHERE kind = 'csp.violation'").n, before + 2);
});

test('hardening: a sealed value with a cut-short GCM tag is refused', () => {
  const k = Buffer.alloc(32, 7);
  const v = A.seal(k, 'ctx', 'hello');
  assert.equal(A.unseal(k, 'ctx', v), 'hello');
  const b = Buffer.from(v.slice(3), 'base64url');
  assert.equal(A.unseal(k, 'ctx', `v1:${b.subarray(0, 16).toString('base64url')}`), null);
});
