// Security tests for authorization and abuse limits on the real server
// (the "authz" findings): broadcast storms one member can trigger, interest
// roles and the role hierarchy, socket and op limits, deleted attachments,
// invitations, invisible characters in names, and WebRTC signalling size.
// Each test was written to fail on the code before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-sec-authz-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
let n = 0;
const mid = () => `m_sa${Date.now().toString(36)}${(n++).toString(36)}xx`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  static async make(handle, name = handle) {
    const res = await post('/api/register', { handle, name, password: 'a long password' });
    assert.equal(res.status, 201, await res.clone().text());
    const c = new Client();
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    c.id = (await res.json()).user.id;
    c.handle = handle;
    await c.connect();
    return c;
  }
  connect() {
    this.events = []; this.acks = new Map(); this.seq = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: this.cookie, origin: base } });
    return new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('message', (buf) => {
        const m = JSON.parse(buf);
        if (m.t === 'hello') { this.hello = m.d; resolve(this); }
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
  async ok(op, d) { const a = await this.op(op, d); assert.equal(a.ok, true, `${op}: ${a.error}`); return a.d; }
  async refused(op, d) { const a = await this.op(op, d); assert.equal(a.ok, false, `${op} should be refused`); return a.error; }
  close() { return new Promise((r) => { if (this.ws.readyState === 3) return r(); this.ws.on('close', r); this.ws.close(); }); }
}

// Put people straight into a house, as plain members, without sockets.
function seedMembers(houseId, count, prefix) {
  const role = srv.db.get('SELECT join_role FROM houses WHERE id = ?', houseId).join_role;
  const ids = [];
  srv.db.tx(() => {
    for (let i = 0; i < count; i++) {
      const u = `u_${prefix}${i}`;
      srv.db.run('INSERT INTO users (id, handle, name, pass, created) VALUES (?, ?, ?, ?, ?)', u, `${prefix}${i}`, `${prefix} ${i}`, 'x', Date.now());
      srv.db.run('INSERT INTO members (house, user, role, newcomer, joined) VALUES (?, ?, ?, 0, ?)', houseId, u, role, Date.now());
      ids.push(u);
    }
  });
  return ids;
}
const join2 = (houseId, user) => {
  const role = srv.db.get('SELECT join_role FROM houses WHERE id = ?', houseId).join_role;
  srv.db.run('INSERT INTO members (house, user, role, newcomer, joined) VALUES (?, ?, ?, 0, ?)', houseId, user, role, Date.now());
};

// ---------- H1: one member must not be able to make the server rebuild everyone's view ----------
test('H1: onboard.pick and member.profile do not rebuild views for offline members or when nothing changed', { timeout: 300_000 }, async () => {
  const owner = await Client.make('h1owner');
  const { house } = await owner.ok('house.create', { name: 'Big house', hue: 200 });
  const g = srv.db.get('SELECT id FROM room_groups WHERE house = ? ORDER BY pos LIMIT 1', house).id;
  srv.db.tx(() => {
    for (let r = 0; r < 30; r++) {
      const rid = `r_h1room${r}`;
      srv.db.run('INSERT INTO rooms (id, house, grp, name, kind, topic, pos) VALUES (?, ?, ?, ?, ?, ?, ?)', rid, house, g, `room ${r}`, 'text', '', 10 + r);
      for (let m = 0; m < 100; m++) srv.db.run('INSERT INTO messages (id, conv, author, ts, text) VALUES (?, ?, ?, ?, ?)', `m_h1${r}x${m}aaaa`, rid, owner.id, Date.now() - 100000 + m, `message ${m}`);
    }
  });
  const offline = seedMembers(house, 150, 'h1off');
  const mallory = await Client.make('h1mallory');
  const watcher = await Client.make('h1watcher');
  join2(house, mallory.id); join2(house, watcher.id);
  watcher.events = [];

  let t = Date.now();
  for (let i = 0; i < 10; i++) await mallory.ok('onboard.pick', { house, interests: [] });
  const took = Date.now() - t;
  assert.ok(took < 500, `10 empty picks took ${took} ms`);
  await sleep(300);
  assert.equal(watcher.events.some((e) => e.ev === 'content'), false, 'nothing changed: no content resend to others');

  // A nickname change builds views only for people with a socket open.
  const seen = new Set();
  const real = srv.M.houseView;
  srv.M.houseView = (h, viewer) => { seen.add(viewer); return real(h, viewer); };
  try {
    t = Date.now();
    await mallory.ok('member.profile', { house, nick: 'Mal' });
    await sleep(50);
    assert.equal(offline.some((u) => seen.has(u)), false, 'no view built for an offline member');
    assert.ok(seen.has(watcher.id), 'online members still get the change');
  } finally { srv.M.houseView = real; }
  await Promise.all([owner.close(), mallory.close(), watcher.close()]);
});

test('H1: an expensive house fan-out collapses a burst into a few runs, and the last state still goes out', async () => {
  let runs = 0, lastSeen = -1;
  const busy = (i) => () => { runs++; lastSeen = i; const end = Date.now() + 20; while (Date.now() < end); };
  for (let i = 0; i < 30; i++) { srv.hub.throttle('test:burst', busy(i)); await sleep(2); }
  await sleep(200);
  assert.ok(runs <= 6, `30 calls ran ${runs} times`);
  assert.equal(lastSeen, 29, 'the trailing run uses the latest call');
});

// ---------- M1: interest roles stay inside the role hierarchy ----------
test('M1: a house manager can’t offer a role above their own as an interest; interest roles give no rank over moderators', async () => {
  const owner = await Client.make('m1owner');
  const dec = await Client.make('m1dec');
  const mod = await Client.make('m1mod');
  const mal = await Client.make('m1mal');
  const { house } = await owner.ok('house.create', { name: 'Hierarchy', hue: 20 });
  for (const c of [dec, mod, mal]) join2(house, c.id);
  const role = async (name, perms) => { const { id } = await owner.ok('role.create', { house }); await owner.ok('role.update', { house, role: id, name, perms }); return id; };
  const decorator = await role('Decorator', ['post', 'house']);
  const moderator = await role('Moderator', ['post', 'kick', 'timeout']);
  const supporter = await role('Supporter', ['post', 'announce']);
  const fancy = await role('Fancy', ['post']);
  await owner.ok('role.move', { house, role: supporter, index: 1 });
  await owner.ok('role.move', { house, role: fancy, index: 2 }); // above Moderator
  await owner.ok('role.move', { house, role: moderator, index: 3 }); // above Member: Owner, Supporter, Fancy, Moderator, Member
  await owner.ok('member.role', { house, user: dec.id, role: decorator });
  await owner.ok('member.role', { house, user: mod.id, role: moderator });

  // (a) 'house' without 'roles': may still edit the welcome, but not hand out Supporter.
  await dec.ok('onboard.set', { house, welcome: 'Hello there' });
  await dec.refused('onboard.set', { house, interests: [{ label: 'VIP', roles: [supporter] }] });
  assert.equal(srv.db.get('SELECT interests FROM houses WHERE id = ?', house).interests.includes(supporter), false);

  // (b) The owner offers Fancy, which sits above Moderator. Picking it gives no immunity.
  await owner.ok('onboard.set', { house, interests: [{ id: 'in_fancy1', label: 'Fancy', roles: [fancy] }] });
  await dec.ok('onboard.set', { house, welcome: 'Still fine: roles unchanged', interests: [{ id: 'in_fancy1', label: 'Fancy hats', roles: [fancy] }] });
  const picked = await mal.ok('onboard.pick', { house, interests: ['in_fancy1'] });
  assert.deepEqual(picked.roles, [fancy]);
  await mod.ok('mod.kick', { house, user: mal.id });
  assert.equal(srv.M.isMember(house, mal.id), false);
  await Promise.all([owner, dec, mod, mal].map((c) => c.close()));
});

// ---------- M2: sockets and heavy ops ----------
const openSocket = (cookie) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie, origin: base } });
  ws.on('message', (buf) => { if (JSON.parse(buf).t === 'hello') resolve({ ws, ok: true }); });
  ws.on('unexpected-response', (req, res) => resolve({ ws, ok: false, status: res.statusCode }));
  ws.on('error', () => resolve({ ws, ok: false }));
});
test('M2: one person holds at most 10 sockets; a loop of new sockets is refused; sync and read.many have their own buckets', async () => {
  const a = await Client.make('m2a');
  const socks = [];
  for (let i = 0; i < 10; i++) socks.push(await openSocket(a.cookie));
  // a's own Client socket was the first: it is now closed as the oldest.
  const code = await new Promise((r) => { if (a.ws.readyState === 3) r('closed'); else a.ws.on('close', (c) => r(c)); });
  assert.equal(code, 4008, 'the oldest socket is closed with 4008');
  assert.equal(socks.every((s) => s.ok), true);
  assert.equal(srv.hub.connected(a.id), true);
  for (const s of socks) s.ws.close();

  srv.resetLimits();
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const s = await openSocket(a.cookie);
    if (!s.ok) { refused++; assert.equal(s.status, 429); }
    s.ws.close();
  }
  assert.ok(refused >= 5, `a loop of 40 sockets: ${refused} refused`);

  srv.resetLimits();
  await a.connect();
  const syncs = await Promise.all(Array.from({ length: 20 }, () => a.op('sync')));
  assert.ok(syncs.some((r) => !r.ok && /going a little fast/.test(r.error)), 'some syncs are refused');
  const reads = await Promise.all(Array.from({ length: 20 }, () => a.op('read.many', { items: [] })));
  assert.ok(reads.some((r) => !r.ok), 'some read.many are refused');
  await a.close();
});

// ---------- M3: attachments of deleted messages, and uploads never sent ----------
test('M3: a deleted message’s attachment is removed after the undo window; an upload never sent is removed after a day', async () => {
  const al = await Client.make('m3al');
  const bo = await Client.make('m3bo');
  const { house, room } = await al.ok('house.create', { name: 'Files', hue: 90 });
  join2(house, bo.id);
  const upload = async (name) => {
    const res = await fetch(`${base}/api/files?conv=${room}`, { method: 'POST', headers: { cookie: al.cookie, origin: base, 'content-type': 'application/octet-stream', 'x-file-name': name }, body: Buffer.from('secret bytes ' + name) });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).id;
  };
  const get = (fid) => fetch(`${base}/api/files/${fid}`, { headers: { cookie: bo.cookie } });
  const filesDir = join(dir, 'files');
  const sent = await upload('a.txt');
  const kept = await upload('b.txt');
  const msg = mid(), other = mid();
  await al.ok('msg.send', { conv: room, id: msg, text: 'look', files: [{ id: sent }] });
  await al.ok('msg.send', { conv: room, id: other, text: 'keep', files: [{ id: kept }] });
  assert.equal((await get(sent)).status, 200);
  await al.ok('msg.delete', { conv: room, id: msg });
  srv.sweepFiles(Date.now() + 5 * 60_000);
  assert.equal((await get(sent)).status, 200, 'still there inside the undo window');
  srv.sweepFiles(Date.now() + 12 * 60_000);
  assert.equal((await get(sent)).status, 404, 'gone after the undo window');
  assert.equal(existsSync(join(filesDir, sent)), false, 'and the bytes are gone');
  assert.equal((await get(kept)).status, 200, 'a live message’s file stays');

  const never = await upload('c.txt');
  srv.sweepFiles(Date.now() + 2 * 3600_000);
  assert.equal(existsSync(join(filesDir, never)), true, 'a fresh upload waits to be sent');
  srv.sweepFiles(Date.now() + 25 * 3600_000);
  assert.equal(srv.db.get('SELECT 1 FROM files WHERE id = ?', never), undefined);
  assert.equal(existsSync(join(filesDir, never)), false);
  assert.equal((await get(kept)).status, 200, 'attached files survive the day sweep');
  assert.ok(readdirSync(filesDir).includes(kept));
  await Promise.all([al.close(), bo.close()]);
});

// ---------- M4: invitations and house creation ----------
test('M4: personal invitations are rate limited, honour a privacy setting and don’t reveal who exists; house creation is limited', async () => {
  const inv = await Client.make('m4inv');
  const vic = await Client.make('m4vic');
  const { house } = await inv.ok('house.create', { name: 'Spam house', hue: 10 });
  // Privacy: friends only.
  await vic.ok('privacy.set', { invites: 'friends' });
  const blocked = await inv.refused('invite.user', { house, handle: 'm4vic' });
  const missing = await inv.refused('invite.user', { house, handle: 'm4nobody' });
  assert.equal(blocked.replace('m4vic', 'X'), missing.replace('m4nobody', 'X'), 'the same answer for privacy and a missing name');
  assert.equal(srv.db.get('SELECT 1 FROM personal_invites WHERE user = ?', vic.id), undefined);
  // Rate limit: 15 in a row, some refused.
  srv.resetLimits();
  for (let i = 0; i < 15; i++) srv.db.run('INSERT INTO users (id, handle, name, pass, created) VALUES (?, ?, ?, ?, ?)', `u_m4s${i}`, `m4s${i}`, `S ${i}`, 'x', Date.now());
  let ok = 0;
  for (let i = 0; i < 15; i++) if ((await inv.op('invite.user', { house, handle: `m4s${i}` })).ok) ok++;
  assert.ok(ok <= 10, `${ok} of 15 invitations went out`);
  // House creation: a burst is limited.
  srv.resetLimits();
  let made = 0;
  for (let i = 0; i < 12; i++) if ((await inv.op('house.create', { name: `H${i}`, hue: 1 })).ok) made++;
  assert.ok(made <= 6, `${made} houses in a burst`);
  await Promise.all([inv, vic].map((c) => c.close()));
});

// ---------- L1: invisible and direction-changing characters ----------
test('L1: names and file names lose bidi overrides and zero-width characters; emoji sequences survive', async () => {
  const { stripInvisible, cleanFileName } = await import('../js/lib/util.js');
  assert.equal(stripInvisible('a‮b'), 'ab');
  assert.equal(cleanFileName('invoice‮fdp.exe'), 'invoicefdp.exe');
  assert.equal(stripInvisible('\u{1F468}‍\u{1F469}‍\u{1F467}'), '\u{1F468}‍\u{1F469}‍\u{1F467}');
  const c = await Client.make('l1user');
  await c.ok('me.update', { name: 'Bob​' });
  assert.equal(srv.db.get('SELECT name FROM users WHERE id = ?', c.id).name, 'Bob');
  const { house } = await c.ok('house.create', { name: '‮esuoH', hue: 5 });
  assert.equal(srv.db.get('SELECT name FROM houses WHERE id = ?', house).name, 'esuoH');
  const room = srv.db.get("SELECT id FROM rooms WHERE house = ? AND kind = 'text' LIMIT 1", house).id;
  const res = await fetch(`${base}/api/files?conv=${room}`, { method: 'POST', headers: { cookie: c.cookie, origin: base, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('invoice‮fdp.exe') }, body: Buffer.from('x') });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).name, 'invoicefdp.exe');
  await c.close();
});

// sec-review: the zero-width joiner is part of how some scripts are written (Sinhala ශ්‍රී, Malayalam chillu
// letters, Devanagari eyelash ra): it stays between letters of those scripts, as the non-joiner does.
test('L1 (review): a zero-width joiner inside Sinhala, Malayalam or Devanagari words is kept; in Latin text it goes', async () => {
  const { stripInvisible } = await import('../js/lib/util.js');
  const ZWJ = '\u200d';
  for (const word of [`ශ්${ZWJ}රී`, `ന്${ZWJ}`.concat('മ'), `र्${ZWJ}य`]) assert.equal(stripInvisible(word), word, JSON.stringify(word));
  assert.equal(stripInvisible(`pay${ZWJ}pal`), 'paypal');
  assert.equal(stripInvisible(`a${ZWJ}`), 'a');
});

// ---------- L2: WebRTC signalling ----------
test('L2: rtc signals must be small and well formed', async () => {
  const { rtcSignal } = await import('../server/ops.js');
  assert.throws(() => rtcSignal({ sdp: { type: 'offer', sdp: 'x'.repeat(30_000) } }));
  assert.throws(() => rtcSignal({ junk: 'x' }));
  assert.throws(() => rtcSignal({ candidate: { candidate: 'x'.repeat(2000) } }));
  assert.deepEqual(rtcSignal({ candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, extra: 'dropped' } }), { candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } });
  const a = await Client.make('l2a');
  const b = await Client.make('l2b');
  const { house } = await a.ok('house.create', { name: 'Voice', hue: 3 });
  join2(house, b.id);
  const vr = srv.db.get("SELECT id FROM rooms WHERE house = ? AND kind = 'voice'", house).id;
  await a.ok('voice.join', { room: vr });
  await b.ok('voice.join', { room: vr });
  await b.refused('rtc', { to: a.id, data: { sdp: { type: 'offer', sdp: 'x'.repeat(30_000) } } });
  await b.refused('rtc', { to: a.id, data: { blob: 'x'.repeat(20_000) } });
  await b.ok('rtc', { to: a.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  // A flood of large-but-valid signals runs out of budget.
  const big = { sdp: { type: 'offer', sdp: 'x'.repeat(20_000) } };
  const rs = await Promise.all(Array.from({ length: 60 }, () => b.op('rtc', { to: a.id, data: big })));
  assert.ok(rs.some((r) => !r.ok), 'some are refused');
  await Promise.all([a.close(), b.close()]);
});

test('hardening: the database zeroes deleted content (secure_delete) and keeps its WAL short', () => {
  assert.equal(srv.db.get('PRAGMA secure_delete').secure_delete, 1);
  assert.equal(srv.db.get('PRAGMA journal_size_limit').journal_size_limit, 4194304);
});

test('hardening: search and the mentions inbox work for someone in more conversations than SQLite has variables', async () => {
  const c = await Client.make('manyrooms');
  const { house } = await c.ok('house.create', { name: 'Huge', hue: 7 });
  const g = srv.db.get('SELECT id FROM room_groups WHERE house = ? LIMIT 1', house).id;
  srv.db.tx(() => { for (let i = 0; i < 33_000; i++) srv.db.run('INSERT INTO rooms (id, house, grp, name, kind, topic, pos) VALUES (?, ?, ?, ?, ?, ?, ?)', `r_many${i}`, house, g, `r${i}`, 'text', '', 100 + i); });
  try {
    const r = await c.op('search', { q: 'hello' });
    assert.equal(r.ok, true, r.error);
    const m = await c.op('mentions.list', {});
    assert.equal(m.ok, true, m.error);
  } finally {
    srv.db.run("DELETE FROM rooms WHERE id LIKE 'r_many%'");
    await c.close();
  }
});

test('hardening: webhook posts go through the house word filter', async () => {
  const o = await Client.make('hkowner');
  const { house, room } = await o.ok('house.create', { name: 'Hooks', hue: 8 });
  await o.ok('automod.set', { house, words: ['badword'], action: 'block' });
  const { url } = await o.ok('hook.create', { room });
  const postHook = (content) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
  assert.equal((await postHook('hello there')).status, 200);
  assert.equal((await postHook('this has badword in it')).status, 422);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM messages WHERE conv = ? AND text LIKE '%badword%'", room).n, 0);
  await o.close();
});

test('hardening: a room manager by override can’t hide the room from roles or people above them', async () => {
  const o = await Client.make('ovowner');
  const mgr = await Client.make('ovmgr');
  const modr = await Client.make('ovmod');
  const { house, room } = await o.ok('house.create', { name: 'Overrides', hue: 9 });
  join2(house, mgr.id); join2(house, modr.id);
  const role = async (name, perms) => { const { id } = await o.ok('role.create', { house }); await o.ok('role.update', { house, role: id, name, perms }); return id; };
  const mod = await role('Moderator', ['post', 'kick']);
  await o.ok('role.move', { house, role: mod, index: 1 });
  await o.ok('member.role', { house, user: modr.id, role: mod });
  await o.ok('room.override', { room, type: 'member', target: mgr.id, allow: ['manage'] });
  await mgr.refused('room.override', { room, type: 'role', target: mod, deny: ['view'] });
  await mgr.refused('room.override', { room, type: 'member', target: modr.id, deny: ['view'] });
  await mgr.ok('room.override', { room, type: 'everyone', deny: ['send'] });
  await Promise.all([o, mgr, modr].map((c) => c.close()));
});
