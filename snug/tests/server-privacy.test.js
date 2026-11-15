// Privacy controls and data minimisation (v0.12 privacy track): who sees that
// you're online, typing, link previews for friends' links on other PCs,
// erasing what you wrote when you delete your account, a complete download of
// your own data, shorter logs and no full addresses in failure counters.
// Each test failed on the code before its change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { startServer } from '../server/index.js';
import { Client, startRegistry, startPc, signUp, until } from './helpers/p2p.js';
import { dmIdFor } from '../server/peercrypto.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-privacy-'));
let srv, base;
const logs = [];
const realLog = console.log;
test.before(async () => {
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  srv = await startServer({ port: 0, dataDir: dir, quiet: false, trustProxy: 1 });
  base = `http://127.0.0.1:${srv.port}`;
  srv.base = base;
});
test.beforeEach(() => srv.resetLimits());
test.after(async () => { console.log = realLog; await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const PW = 'a long password';
let ipN = 0;
const freshIp = () => { ipN++; return `100.64.${(ipN >> 8) & 255}.${ipN & 255}`; };
const post = (path, body, { cookie, ip = freshIp() } = {}) => fetch(base + path, {
  method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}),
});
const get = (path, { cookie, ip = freshIp() } = {}) => fetch(base + path, { headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) } });
async function person(handle) {
  const res = await post('/api/register', { handle, name: handle, password: PW });
  assert.equal(res.status, 201, await res.clone().text());
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const c = new Client(srv, cookie, (await res.json()).user.id);
  await c.connect();
  c.handle = handle;
  return c;
}
async function befriend(a, b) {
  await a.ok('friend.request', { handle: b.handle });
  const req = await b.next('friend', (d) => d.friend?.state === 'incoming' && d.id === a.id);
  await b.ok('friend.accept', { user: req.id });
  await a.next('friend', (d) => d.id === b.id && d.friend?.state === 'friends');
}
async function houseOf(owner, ...others) {
  const { house, room } = await owner.ok('house.create', { name: `H ${owner.handle}`, hue: 200 });
  const { code } = await owner.ok('invite.create', { house });
  for (const o of others) await o.ok('invite.accept', { code });
  return { house, room };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const none = async (c, ev, pred, ms = 400) => { await sleep(ms); return !c.events.some((e) => e.ev === ev && pred(e.d)); };

// ---------- Who sees that I'm online ----------
test('presence "friends only": a house-mate sees me offline with no activity lines; a friend sees me online', async () => {
  const robin = await person('pv-robin'), ines = await person('pv-ines'), bex = await person('pv-bex');
  await houseOf(robin, ines, bex);
  await befriend(robin, ines);
  await robin.ok('prefs.set', { prefs: { presenceTo: 'friends' } });
  // A fresh connection from each: what the snapshot says.
  const bex2 = new Client(srv, bex.cookie, bex.id); await bex2.connect();
  const ines2 = new Client(srv, ines.cookie, ines.id); await ines2.connect();
  assert.equal(bex2.hello.users[robin.id].presence, 'offline', 'not a friend: offline');
  assert.equal(bex2.hello.users[robin.id].hideActive, true, 'not a friend: no "last wrote" lines');
  assert.notEqual(ines2.hello.users[robin.id].presence, 'offline', 'a friend: online');
  assert.ok(!ines2.hello.users[robin.id].hideActive);
  // Live changes follow the same rule.
  bex2.events.length = 0; ines2.events.length = 0;
  await robin.ok('me.update', { presence: 'focus' });
  await ines2.next('user', (d) => d.user.id === robin.id && d.user.presence === 'focus');
  assert.ok(await none(bex2, 'user', (d) => d.user.id === robin.id && d.user.presence !== 'offline'), 'bex never hears robin is online');
  const seen = bex2.events.filter((e) => e.ev === 'user' && e.d.user.id === robin.id);
  assert.ok(seen.length && seen.every((e) => e.d.user.hideActive === true), 'and keeps hiding his activity');
  // Discover's "people you might know" follows it too.
  const d = await bex2.ok('discover', {});
  const card = d.people.find((x) => x.user.id === robin.id);
  assert.ok(card, "robin is someone bex might know");
  assert.equal(card.user.presence, "offline");
  // Robin still sees himself as he is.
  const me = new Client(srv, robin.cookie, robin.id); await me.connect();
  assert.equal(me.hello.users[robin.id].presence, 'focus');
  for (const c of [robin, ines, bex, bex2, ines2, me]) c.ws.close();
});

test('presence "nobody": friends see me offline too, and no typing note goes out', async () => {
  const kay = await person('pv-kay'), lee = await person('pv-lee');
  const { room } = await houseOf(kay, lee);
  await befriend(kay, lee);
  await kay.ok('prefs.set', { prefs: { presenceTo: 'nobody' } });
  const lee2 = new Client(srv, lee.cookie, lee.id); await lee2.connect();
  assert.equal(lee2.hello.users[kay.id].presence, 'offline');
  await kay.ok('typing', { conv: room });
  assert.ok(await none(lee2, 'typing', (d) => d.user === kay.id), 'no typing note');
  for (const c of [kay, lee, lee2]) c.ws.close();
});

// ---------- Typing ----------
test('typing off: my typing notes never leave the server; invisible people send none either', async () => {
  const amy = await person('pv-amy'), ben = await person('pv-ben');
  const { room } = await houseOf(amy, ben);
  await amy.ok('typing', { conv: room });
  await ben.next('typing', (d) => d.user === amy.id && d.conv === room);
  await amy.ok('prefs.set', { prefs: { typing: false } });
  await amy.ok('typing', { conv: room });
  assert.ok(await none(ben, 'typing', (d) => d.user === amy.id), 'typing off');
  await amy.ok('prefs.set', { prefs: { typing: true } });
  await amy.ok('me.update', { presence: 'offline' }); // Go invisible
  await amy.ok('typing', { conv: room });
  assert.ok(await none(ben, 'typing', (d) => d.user === amy.id), 'invisible people do not type');
  amy.ws.close(); ben.ws.close();
});

// ---------- What this Snug keeps ----------
test('GET /api/privacy (no sign-in) says what is kept and for how long, and that nothing is sent for diagnostics', async () => {
  const r = await get('/api/privacy');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.mode, 'host');
  assert.equal(d.logDays, 30);
  assert.equal(d.failureHours, 48);
  assert.equal(d.undoMinutes, 11);
  assert.equal(d.diagnostics, false);
  assert.equal(typeof d.linkPreviews, 'boolean');
  assert.equal(d.stun, 'google');
});

test('sign-in history and security events are kept 30 days by default (90 before), and SNUG_LOG_DAYS changes it', async () => {
  const u = await person('pv-logs');
  const old = Date.now() - 31 * 86_400_000;
  srv.db.run("INSERT INTO auth_events (ts, user, event, ok, ip, agent) VALUES (?, ?, 'login', 1, '1.2.3.x', 'x')", old, u.id);
  srv.db.run("INSERT INTO security_events (ts, user, kind, ip, agent, detail) VALUES (?, ?, 'origin.refused', '', '', '{}')", old, u.id);
  srv.seclog.prune();
  srv.accountPrune();
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM auth_events WHERE user = ? AND ts = ?', u.id, old).n, 0);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM security_events WHERE user = ? AND ts = ?', u.id, old).n, 0);
  u.ws.close();
  // A server owner who wants a week.
  const d2 = mkdtempSync(join(tmpdir(), 'snug-privacy-days-'));
  const s2 = await startServer({ port: 0, dataDir: d2, quiet: true, logDays: 7 });
  const r = await fetch(`http://127.0.0.1:${s2.port}/api/privacy`);
  assert.equal((await r.json()).logDays, 7);
  s2.db.run("INSERT INTO security_events (ts, user, kind, ip, agent, detail) VALUES (?, 'x', 'origin.refused', '', '', '{}')", Date.now() - 8 * 86_400_000);
  s2.seclog.prune();
  assert.equal(s2.db.get('SELECT COUNT(*) n FROM security_events').n, 0);
  await s2.close();
  rmSync(d2, { recursive: true, force: true });
});

test('failed sign-in counters keep no full address, and logs print none', async () => {
  await person('pv-fail');
  logs.length = 0;
  const ip = '203.0.113.77';
  for (let i = 0; i < 3; i++) await post('/api/login', { handle: 'pv-fail', password: 'wrong password!' }, { ip });
  await post('/api/login', { handle: 'pv-nobody', password: 'wrong password!' }, { ip });
  const keys = srv.db.all('SELECT key FROM auth_failures').map((r) => r.key);
  assert.ok(keys.length >= 2, keys.join());
  for (const k of keys) assert.ok(!k.includes('203.0.113'), `no address in ${k}`);
  assert.ok(!logs.some((l) => l.includes('203.0.113.77')), 'no full address in the log');
  assert.ok(srv.db.all('SELECT ip FROM auth_events').every((r) => !r.ip.includes('.77')), 'masked in sign-in history');
});

// ---------- Erasing what I wrote ----------
const CANARY = 'canary-7f3a-privacy-erase';
// Every text column of every table, searched for a string.
function dbHas(db, s) {
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    const cols = db.all(`PRAGMA table_info(${name})`).map((c) => c.name);
    for (const c of cols) if (db.get(`SELECT 1 FROM "${name}" WHERE CAST("${c}" AS TEXT) LIKE ? LIMIT 1`, `%${s}%`)) return `${name}.${c}`;
  }
  return null;
}
const filesHave = (s) => readdirSync(join(dir, 'files')).filter((f) => readFileSync(join(dir, 'files', f)).includes(s));
async function upload(c, conv, name, text) {
  const r = await fetch(`${base}/api/files?conv=${encodeURIComponent(conv)}`, {
    method: 'POST', headers: { origin: base, cookie: c.cookie, 'content-type': 'text/plain', 'x-file-name': name }, body: text,
  });
  assert.equal(r.status, 201, await r.clone().text());
  return { id: (await r.json()).id };
}
let msgN = 0;
const mid = () => `m_pv${String(++msgN).padStart(8, '0')}`;

test('delete with "erase what I wrote": messages, DMs, files, reactions, sign-in history and security rows tied to me are gone', async () => {
  const zed = await person('pv-zed'), ann = await person('pv-ann');
  const { room } = await houseOf(ann, zed);
  const dm = (await zed.ok('dm.open', { users: [ann.id] })).id;
  const f = await upload(zed, dm, 'notes.txt', `file ${CANARY}`);
  await zed.ok('msg.send', { conv: room, id: mid(), text: `room ${CANARY}` });
  const inDm = mid();
  await zed.ok('msg.send', { conv: dm, id: inDm, text: `dm ${CANARY}`, files: [f] });
  await zed.ok('msg.edit', { conv: dm, id: inDm, text: `dm edited ${CANARY}` });
  const annMsg = mid();
  await ann.ok('msg.send', { conv: room, id: annMsg, text: 'ann keeps this' });
  await zed.ok('react', { conv: room, id: annMsg, emoji: '👍', on: true });
  await post('/api/login', { handle: 'pv-zed', password: 'not the password' }); // a failure counter and a history row
  assert.ok(dbHas(srv.db, CANARY));
  assert.ok(filesHave(CANARY).length);
  const r = await post('/api/account/delete', { password: PW, confirm: 'pv-zed', erase: true }, { cookie: zed.cookie });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(dbHas(srv.db, CANARY), null, 'no copy left in the database');
  assert.deepEqual(filesHave(CANARY), [], 'no copy left in the files folder');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM reactions WHERE user = ?', zed.id).n, 0);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM auth_events WHERE user = ?', zed.id).n, 0);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM security_events WHERE user = ?', zed.id).n, 0);
  assert.equal(srv.db.all('SELECT key FROM auth_failures').filter((x) => x.key.includes(zed.id) || x.key.includes('pv-zed')).length, 0);
  assert.equal(srv.db.get('SELECT text FROM messages WHERE id = ?', annMsg).text, 'ann keeps this', 'other people’s messages stay');
  await ann.next('msg.del', (d) => d.id === inDm);
  ann.ws.close();
});

test('delete keeping my messages: they stay by "Deleted user", and failure counters still go', async () => {
  const kim = await person('pv-kim'), joe = await person('pv-joe');
  const { room } = await houseOf(joe, kim);
  await kim.ok('msg.send', { conv: room, id: mid(), text: 'kim stays as deleted user' });
  await post('/api/login', { handle: 'pv-kim', password: 'not the password' });
  const r = await post('/api/account/delete', { password: PW, confirm: 'pv-kim' }, { cookie: kim.cookie });
  assert.equal(r.status, 200);
  assert.ok(srv.db.get("SELECT 1 FROM messages WHERE author = ? AND text = 'kim stays as deleted user'", kim.id));
  assert.equal(srv.db.get('SELECT name FROM users WHERE id = ?', kim.id).name, 'Deleted user');
  assert.equal(srv.db.all('SELECT key FROM auth_failures').filter((x) => x.key.includes(kim.id) || x.key.includes('pv-kim')).length, 0);
  joe.ws.close();
});

// ---------- Download my data ----------
// A zip file's entries: name -> Buffer (stored or deflated, as written by server/zip.js).
function unzip(buf) {
  const out = {};
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('Download my data: one zip with my profile, my messages, the DMs I am in, files I uploaded and my settings; nobody else’s private data', async () => {
  const una = await person('pv-una'), vic = await person('pv-vic'), wes = await person('pv-wes');
  const { room } = await houseOf(una, vic, wes);
  await una.ok('me.update', { about: 'una about text' });
  await una.ok('prefs.set', { prefs: { typing: false } });
  const dm = (await una.ok('dm.open', { users: [vic.id] })).id;
  const f = await upload(una, dm, 'una-file.txt', 'una file bytes');
  await una.ok('msg.send', { conv: dm, id: mid(), text: 'una in dm', files: [f] });
  await vic.ok('msg.send', { conv: dm, id: mid(), text: 'vic answers una' });
  await una.ok('msg.send', { conv: room, id: mid(), text: 'una in the room' });
  await wes.ok('msg.send', { conv: room, id: mid(), text: 'wes in the room' });
  const other = (await vic.ok('dm.open', { users: [wes.id] })).id;
  await vic.ok('msg.send', { conv: other, id: mid(), text: 'vic and wes private' });
  const r = await get('/api/account/export.zip', { cookie: una.cookie });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get('content-type'), /application\/zip/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="snug-pv-una-\d{4}-\d\d-\d\d\.zip"/);
  const z = unzip(Buffer.from(await r.arrayBuffer()));
  assert.ok(z['README.txt'], 'a note on what is inside');
  const data = JSON.parse(z['snug-data.json'].toString('utf8'));
  assert.equal(data.account.handle, 'pv-una');
  assert.equal(data.account.about, 'una about text');
  assert.equal(data.settings.typing, false);
  assert.ok(data.messages.some((m) => m.text === 'una in the room'));
  const conv = data.conversations.find((c) => c.id === dm);
  assert.ok(conv.messages.some((m) => m.text === 'vic answers una'), 'the other side of my DMs');
  assert.ok(Array.isArray(data.signIns) && data.signIns.length >= 1, 'sign-in history');
  const all = JSON.stringify(data) + Object.values(z).map((b) => b.toString('utf8')).join('');
  assert.ok(!all.includes('wes in the room'), 'not other people’s room messages');
  assert.ok(!all.includes('vic and wes private'), 'not conversations I am not in');
  const fileEntry = Object.keys(z).find((n) => n.startsWith('files/') && n.endsWith('una-file.txt'));
  assert.ok(fileEntry, Object.keys(z).join());
  assert.equal(z[fileEntry].toString('utf8'), 'una file bytes');
  assert.match(z['messages.txt'].toString('utf8'), /una in the room/);
  for (const c of [una, vic, wes]) c.ws.close();
});

// ---------- Link previews for links friends on other PCs send ----------
test('desktop: a link a friend sends is not fetched by my PC unless I turn on previews for friends’ links; my own links still are', async () => {
  const hits = [];
  const site = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Site</title><meta property="og:title" content="A page"></head></html>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${site.address().port}`;
  const registry = await startRegistry();
  const A = await startPc(registry, { linkAllowLocal: true }), B = await startPc(registry, { linkAllowLocal: true });
  try {
    const a = await signUp(A, registry, 7101, 'pvalice'), b = await signUp(B, registry, 7102, 'pvbob');
    await a.ok('friend.request', { handle: 'pvbob' });
    const req = await b.next('friend', (d) => d.friend?.state === 'incoming');
    await b.ok('friend.accept', { user: req.id });
    await a.next('friend', (d) => d.friend?.state === 'friends');
    const ua = a.id.slice(2), ub = b.id.slice(2);
    await until(() => A.peer.isOnline(ub) && B.peer.isOnline(ua), 8000, 'presence');
    const dm = dmIdFor(ua, ub);
    await a.ok('dm.open', { users: [b.id] });
    // Alice's own link: her PC fetches it.
    await a.ok('msg.send', { conv: dm, id: mid(), text: `look ${at}/alice-own` });
    await until(() => hits.includes('/alice-own'), 8000, 'own preview');
    // Bob's PC gets it but does not fetch it.
    await until(() => B.db.get("SELECT 1 FROM messages WHERE text LIKE '%alice-own%'"), 8000, 'delivered');
    await sleep(500);
    assert.equal(hits.filter((h) => h === '/alice-own').length, 1, 'only the sender’s PC fetched it');
    // Bob opts in: the next link from Alice is fetched by his PC too.
    await b.ok('prefs.set', { prefs: { friendPreviews: true } });
    await a.ok('msg.send', { conv: dm, id: mid(), text: `and ${at}/second` });
    await until(() => hits.filter((h) => h === '/second').length === 2, 8000, 'both PCs fetched it');
  } finally {
    await A.close().catch(() => {}); await B.close().catch(() => {});
    await registry.close(); site.close();
  }
});
