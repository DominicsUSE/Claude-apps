// Less tracking, shorter retention (0.14 tracking track): operational
// metadata the server used to keep forever is purged after a short window,
// activity times are kept to the day, security events keep a device label
// instead of a raw browser string, and calls ask no third-party STUN server
// when this Snug has its own relay. Each test failed on the code before its change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { sessionUser } from '../server/auth.js';
import { iceConfig, withRelayIce } from '../server/voiceopts.js';
import { Client } from './helpers/p2p.js';
import { Sock, register as e2Register, newDevice, setupPayload, bind } from './helpers/e2ee.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const dir = mkdtempSync(join(tmpdir(), 'snug-retention-'));
let srv, base;
test.before(async () => {
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, e2ee: true });
  base = `http://127.0.0.1:${srv.port}`;
  srv.base = base;
});
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const PW = 'a long password';
let ipN = 0;
const freshIp = () => { ipN++; return `100.65.${(ipN >> 8) & 255}.${ipN & 255}`; };
async function person(handle) {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ handle, name: handle, password: PW }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const c = new Client(srv, cookie, (await res.json()).user.id);
  await c.connect();
  c.handle = handle;
  c.token = decodeURIComponent(cookie.split('=')[1]);
  return c;
}

// ---------- T1: the house join and leave log ----------
test('T1 house join/leave rows older than 90 days are purged hourly; the insights an owner sees stay the same', async () => {
  const owner = await person('rt-owner'), guest = await person('rt-guest'), quiet = await person('rt-quiet');
  const { house } = await owner.ok('house.create', { name: 'Retention', hue: 200 });
  const { code } = await owner.ok('invite.create', { house });
  await guest.ok('invite.accept', { code });
  const now = Date.now();
  // Someone who joined 60 days ago by a way the log doesn't record: counted from members.joined only
  // when that is before the log began.
  srv.db.run('INSERT INTO members (house, user, role, joined) SELECT house, ?, role, ? FROM members WHERE house = ? AND user = ?', quiet.id, now - 60 * DAY, house, guest.id);
  // A log that began long ago: a join and a leave past 90 days, and a join 30 days ago.
  srv.db.run("INSERT INTO member_log (house, user, ts, kind) VALUES (?, 'u_gone', ?, 'join')", house, now - 120 * DAY);
  srv.db.run("INSERT INTO member_log (house, user, ts, kind) VALUES (?, 'u_gone', ?, 'leave')", house, now - 100 * DAY);
  srv.db.run("INSERT INTO member_log (house, user, ts, kind) VALUES (?, 'u_new', ?, 'join')", house, now - 30 * DAY);
  const before = {};
  for (const days of [7, 30, 90]) before[days] = await owner.ok('insights.get', { house, days });
  srv.retention.run(now);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM member_log WHERE house = ? AND ts < ?', house, now - 90 * DAY).n, 0, 'old rows gone');
  assert.ok(srv.db.get('SELECT COUNT(*) n FROM member_log WHERE house = ?', house).n >= 2, 'recent rows kept');
  for (const days of [7, 30, 90]) assert.deepEqual(await owner.ok('insights.get', { house, days }), before[days], `insights for ${days} days unchanged`);
  // Only once an hour.
  srv.db.run("INSERT INTO member_log (house, user, ts, kind) VALUES (?, 'u_gone', ?, 'join')", house, now - 95 * DAY);
  srv.retention.tick(now + 60_000);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM member_log WHERE house = ? AND ts < ?', house, now - 90 * DAY).n, 1, 'not again within the hour');
  srv.retention.tick(now + HOUR + 1);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM member_log WHERE house = ? AND ts < ?', house, now - 90 * DAY).n, 0, 'the next hour it goes');
  owner.ws.close(); guest.ws.close(); quiet.ws.close();
});

// ---------- T2: the link-preview cache ----------
test('T2 link-preview cache rows (and their cached pictures) older than 24 hours are purged', async () => {
  const now = Date.now();
  const filesDir = join(dir, 'files');
  const hash = 'a'.repeat(40);
  writeFileSync(join(filesDir, `lc_${hash}`), 'picture');
  srv.db.run('INSERT INTO link_cache (url, data, ok, fetched) VALUES (?, ?, 1, ?)', 'https://old.example/page', JSON.stringify({ kind: 'link', title: 'Old', media: { hash, type: 'image/png', size: 7 } }), now - 25 * HOUR);
  srv.db.run('INSERT INTO link_cache (url, data, ok, fetched) VALUES (?, ?, 0, ?)', 'https://fresh.example/page', null, now - HOUR);
  srv.retention.run(now);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM link_cache WHERE url = 'https://old.example/page'").n, 0, 'old row gone');
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM link_cache WHERE url = 'https://fresh.example/page'").n, 1, 'fresh row kept');
  assert.equal(existsSync(join(filesDir, `lc_${hash}`)), false, 'its cached picture gone');
});

// ---------- T7: friend-request cooldowns ----------
test('T7 friend-request cooldowns past their day are pruned; a live one still blocks', async () => {
  const a = await person('rt-cool-a'), b = await person('rt-cool-b'), c = await person('rt-cool-c');
  await a.ok('friend.request', { handle: b.handle });
  await b.next('friend', (d) => d.id === a.id && d.friend?.state === 'incoming');
  await b.ok('friend.decline', { user: a.id });
  assert.ok(srv.db.get('SELECT 1 FROM friend_cooldown WHERE user = ? AND other = ?', a.id, b.id), 'a refusal leaves a cooldown');
  assert.match(await a.refused('friend.request', { handle: b.handle }), /recently/);
  srv.db.run('INSERT INTO friend_cooldown (user, other, ts) VALUES (?, ?, ?)', a.id, c.id, Date.now() - DAY - 1000);
  srv.retention.run(Date.now());
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM friend_cooldown WHERE user = ? AND other = ?', a.id, c.id).n, 0, 'past the day: gone');
  assert.ok(srv.db.get('SELECT 1 FROM friend_cooldown WHERE user = ? AND other = ?', a.id, b.id), 'within the day: kept');
  assert.match(await a.refused('friend.request', { handle: b.handle }), /recently/, 'and still blocks');
  for (const x of [a, b, c]) x.ws.close();
});

// ---------- T3: security events keep a device label ----------
test('T3 a security event stores the coarse device label, not the raw browser string; the address stays shortened', async () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36';
  srv.seclog.record('access.refused', { req: { headers: { 'user-agent': ua }, socket: { remoteAddress: '203.0.113.77' } }, user: 'u_rt_t3' });
  const row = srv.db.get("SELECT ip, agent FROM security_events WHERE user = 'u_rt_t3'");
  assert.equal(row.agent, 'Chrome on Windows');
  assert.ok(!row.ip.includes('.77'), `shortened: ${row.ip}`);
});

// ---------- T4: activity kept to the day ----------
test('T4 a session’s last use is stored as the day, written at most daily; idle expiry still works', async () => {
  const u = await person('rt-day');
  const row = () => srv.db.get('SELECT seen, created FROM sessions WHERE user = ?', u.id);
  const today = Date.now() - (Date.now() % DAY);
  assert.equal(row().seen, today, 'a new session: today');
  // Last used two days ago: using it now moves it to today, still a day boundary.
  srv.db.run('UPDATE sessions SET seen = ? WHERE user = ?', today - 2 * DAY, u.id);
  assert.equal(sessionUser(srv.db, u.token), u.id);
  assert.equal(row().seen, today);
  assert.equal(row().seen % DAY, 0);
  // 13 days unused: still signed in. 15 days: ended.
  srv.db.run('UPDATE sessions SET seen = ? WHERE user = ?', today - 13 * DAY, u.id);
  assert.equal(sessionUser(srv.db, u.token), u.id);
  srv.db.run('UPDATE sessions SET seen = ? WHERE user = ?', today - 15 * DAY, u.id);
  assert.equal(sessionUser(srv.db, u.token), null);
  u.ws.close();
});

test('T4 an encryption device’s last use is stored as the day', async () => {
  const p = await e2Register(srv, 'rt-e2day');
  p.sock = await new Sock(srv, p.cookie).connect();
  p.dev = await newDevice(p.id);
  const { payload } = await setupPayload(p.id, p.dev);
  await p.sock.ok('e2ee.setup', payload);
  await bind(p.sock, p.dev);
  const seen = srv.db.get('SELECT seen FROM e2ee_devices WHERE user = ?', p.id).seen;
  assert.equal(seen % DAY, 0, `a day boundary: ${seen}`);
  assert.equal(seen, Date.now() - (Date.now() % DAY));
  // The device list says that day too, nothing finer.
  const me = await p.sock.ok('e2ee.state', {});
  for (const d of me.devices || []) if (d.seen) assert.equal(new Date(d.seen).getUTCHours() % 12, 0, 'no time of day');
  await p.sock.close();
});

// ---------- T6: third-party STUN ----------
test('T6 with this Snug’s own TURN relay and no SNUG_STUN, calls ask the relay for addresses, not Google', () => {
  const ice = iceConfig({ SNUG_TURN_URL: 'turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349', SNUG_TURN_USER: 'u', SNUG_TURN_PASS: 'p' });
  assert.ok(!JSON.stringify(ice).includes('google'), JSON.stringify(ice));
  assert.deepEqual(ice[0], { urls: ['stun:turn.example.org:3478'] }, 'the relay answers STUN too');
  assert.deepEqual(ice[1], { urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349'], username: 'u', credential: 'p' });
  const perUser = iceConfig({ SNUG_TURN_URL: 'turn:turn.example.org', SNUG_TURN_SECRET: 's' })('u_1');
  assert.ok(!JSON.stringify(perUser).includes('google'));
  // No relay: the public default stays (and the privacy page names it). SNUG_STUN still wins.
  assert.match(iceConfig({})[0].urls[0], /stun\.l\.google\.com/);
  assert.deepEqual(iceConfig({ SNUG_STUN: 'stun:mine.example:3478', SNUG_TURN_URL: 'turn:turn.example.org' })[0], { urls: ['stun:mine.example:3478'] });
  assert.deepEqual(iceConfig({ SNUG_STUN: 'none', SNUG_TURN_URL: 'turn:t.example', SNUG_TURN_USER: 'u', SNUG_TURN_PASS: 'p' }), [{ urls: ['turn:t.example'], username: 'u', credential: 'p' }]);
});

test('T6 desktop: once the directory hands out relay details (which carry Cloudflare’s STUN), Google’s default STUN is dropped', () => {
  const base = iceConfig({});
  const cf = [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'x', credential: 'y' }];
  const out = withRelayIce(base, cf);
  assert.ok(!JSON.stringify(out).includes('google'), JSON.stringify(out));
  assert.deepEqual(out, cf);
  // A STUN server the PC's owner chose stays; relay details without STUN leave the default alone.
  assert.deepEqual(withRelayIce([{ urls: ['stun:mine.example'] }], cf), [{ urls: ['stun:mine.example'] }, ...cf]);
  const noStun = [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'x', credential: 'y' }];
  assert.deepEqual(withRelayIce(base, noStun), [...base, ...noStun]);
});
