// Integration tests against the real server: accounts, permissions, live
// delivery between separate users, persistence across a restart, and the
// rules that keep people out of places they don't belong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-test-'));
let srv, base;
const boot = async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; };
test.before(boot);
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie, origin = base) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
let n = 0;
const mid = () => `m_test${String(++n).padStart(6, '0')}x`;

// One signed-in person with a live socket.
class Client {
  static async make(handle, name = handle) {
    const res = await post('/api/register', { handle, name, password: 'a long password' });
    assert.equal(res.status, 201, await res.clone().text());
    const c = new Client();
    c.cookie = cookieOf(res);
    c.id = (await res.json()).user.id;
    await c.connect();
    return c;
  }
  connect() {
    this.events = [];
    this.acks = new Map();
    this.seq = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: this.cookie, origin: base } });
    return new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('message', (buf) => {
        const m = JSON.parse(buf);
        if (m.t === 'hello') { this.hello = m.d; resolve(this); }
        else if (m.t === 'ack') this.acks.get(m.id)?.(m);
        else if (m.t === 'ev') { this.events.push(m); this.waiter?.(); }
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
  // Wait for an event matching the test, or fail after a second.
  async next(ev, pred = () => true, ms = 1500) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => { this.waiter = r; setTimeout(r, 50); });
    }
  }
  async none(ev, pred = () => true, ms = 250) {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.events.some((e) => e.ev === ev && pred(e.d)), false, `unexpected "${ev}" event`);
  }
  close() { return new Promise((r) => { this.ws.on('close', r); this.ws.close(); }); }
}

let ada, bo, cy, house, lounge, notices;

test('accounts: register, sign in, wrong password, taken name, weak input', async () => {
  ada = await Client.make('ada', 'Ada Okafor');
  assert.equal((await post('/api/register', { handle: 'ADA', name: 'Other', password: 'a long password' })).status, 409);
  assert.equal((await post('/api/register', { handle: 'x y', name: 'X', password: 'a long password' })).status, 400);
  assert.equal((await post('/api/register', { handle: 'shorty', name: 'S', password: 'short' })).status, 400);
  const bad = await post('/api/login', { handle: 'ada', password: 'not the password' });
  assert.equal(bad.status, 401);
  const ghost = await post('/api/login', { handle: 'nobody-here', password: 'not the password' });
  assert.equal((await ghost.json()).error, (await bad.json()).error, 'unknown user and wrong password look the same');
  const good = await post('/api/login', { handle: 'Ada', password: 'a long password' });
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: cookieOf(good) } })).status, 200);
  assert.equal((await fetch(base + '/api/me')).status, 401);
  const stored = srv.db.get('SELECT pass FROM users WHERE handle = ?', 'ada').pass;
  assert.match(stored, /^scrypt\$/);
  assert.equal(stored.includes('a long password'), false);
});

test('the app\u2019s own files are served; nothing else on disk is', async () => {
  const get = (path) => fetch(base + path);
  for (const [path, type] of [['/', 'text/html'], ['/js/app.js', 'text/javascript'], ['/css/tokens.css', 'text/css'], ['/js/views/auth.js', 'text/javascript'], ['/fonts/inter-latin.woff2', 'font/woff2'], ['/vendor/preact-htm.js', 'text/javascript']]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(type), path);
    await res.arrayBuffer();
  }
  assert.match((await get('/')).headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await (await get('/join/abcdef123')).text(), /<div id="app">/, 'invitation links open the app');
  for (const path of ['/server/db.js', '/package.json', '/data/snug.db', '/js/../server/auth.js', '/js/..%2f..%2fserver/auth.js', '/css/missing.css', '/%2e%2e/%2e%2e/etc/passwd']) {
    const res = await get(path);
    const body = await res.text();
    assert.ok(res.status === 404 || /<div id="app">/.test(body), `${path} must not leak a file (got ${res.status})`);
    assert.equal(/scryptSync|DatabaseSync|"dependencies"/.test(body), false, path);
  }
});

test('sockets need a session and the right origin', async () => {
  const tryOpen = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers });
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('error', () => {});
  });
  assert.equal(await tryOpen({ origin: base }), 401);
  assert.equal(await tryOpen({ origin: base, cookie: 'snug_session=made-up' }), 401);
  assert.equal(await tryOpen({ origin: 'https://evil.example', cookie: ada.cookie }), 403);
  assert.equal((await post('/api/logout', {}, ada.cookie, 'https://evil.example')).status, 403);
});

test('a house: create, invite by link, join as a newcomer', async () => {
  const made = await ada.ok('house.create', { name: 'Kiln & Co.', hue: 35 });
  house = made.house;
  lounge = made.room;
  const h = await ada.next('house', (d) => d.house.id === house);
  notices = Object.values(h.rooms).find((r) => r.kind === 'news').id;
  assert.equal(h.house.joined, true);

  bo = await Client.make('bo', 'Bo Lindqvist');
  cy = await Client.make('cy', 'Cy Park');
  assert.equal(Object.keys(bo.hello.houses).length, 0, 'a new account sees no houses');
  assert.match(await bo.refused('msg.send', { conv: lounge, id: mid(), text: 'let me in' }), /access/);
  assert.match(await bo.refused('history', { conv: lounge }), /access/);

  const { code } = await ada.ok('invite.create', { house });
  const preview = await (await fetch(`${base}/api/invite/${code}`)).json();
  assert.equal(preview.house.name, 'Kiln & Co.');
  assert.match(await bo.refused('invite.accept', { code: 'not-a-real-code' }), /expired/);
  await bo.ok('invite.accept', { code });
  const joined = await bo.next('house', (d) => d.house.id === house);
  assert.equal(joined.house.joined, true);
  assert.equal(joined.house.newcomer, true);
  const seen = await ada.next('house', (d) => d.house.members[bo.id]);
  assert.ok(seen.users[bo.id], 'existing members learn who joined');
});

test('messages reach everyone in the room at once, and nobody else', async () => {
  const id = mid();
  const sent = await ada.ok('msg.send', { conv: lounge, id, text: 'The bisque kiln is unloaded.' });
  const got = await bo.next('msg', (d) => d.m.id === id);
  assert.equal(got.m.text, 'The bisque kiln is unloaded.');
  assert.equal(got.m.author, ada.id);
  assert.equal(got.m.seq, sent.m.seq);
  await cy.none('msg');
});

test('a resend with the same id never duplicates', async () => {
  const id = mid();
  await ada.ok('msg.send', { conv: lounge, id, text: 'only once' });
  await bo.next('msg', (d) => d.m.id === id);
  const again = await ada.ok('msg.send', { conv: lounge, id, text: 'only once' });
  assert.equal(again.m.text, 'only once');
  await bo.none('msg', (d) => d.m.id === id);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM messages WHERE id = ?', id).n, 1);
  assert.match(await bo.refused('msg.send', { conv: lounge, id, text: 'hijack' }), /taken/);
});

test('order is the server’s order, the same for everyone', async () => {
  const ids = Array.from({ length: 12 }, mid);
  await Promise.all(ids.map((id, i) => (i % 2 ? ada : bo).ok('msg.send', { conv: lounge, id, text: `n${i}` })));
  const a = (await ada.ok('history', { conv: lounge })).msgs.filter((m) => ids.includes(m.id)).map((m) => m.id);
  const b = (await bo.ok('history', { conv: lounge })).msgs.filter((m) => ids.includes(m.id)).map((m) => m.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, 12);
  const page = (await ada.ok('history', { conv: lounge })).msgs;
  assert.deepEqual(page.map((m) => m.seq), [...page.map((m) => m.seq)].sort((x, y) => x - y));
  assert.deepEqual(page.map((m) => m.ts), [...page.map((m) => m.ts)].sort((x, y) => x - y), 'time order matches sequence order');
  ada.events.length = 0; bo.events.length = 0;
});

test('permissions are enforced by the server, not the screen', async () => {
  assert.match(await bo.refused('msg.send', { conv: notices, id: mid(), text: 'not allowed' }), /Only Owner can post/);
  assert.match(await bo.refused('room.create', { house, name: 'Mine', kind: 'text' }), /can’t create rooms/);
  assert.match(await bo.refused('house.update', { house, name: 'Hijacked' }), /can’t/);
  assert.match(await bo.refused('member.role', { house, user: bo.id, role: 'x' }), /can’t/);
  assert.match(await bo.refused('role.create', { house }), /can’t/);
  assert.match(await cy.refused('voice.join', { room: lounge }), /member/);

  const id = mid();
  await ada.ok('msg.send', { conv: lounge, id, text: 'ada wrote this' });
  assert.match(await bo.refused('msg.edit', { conv: lounge, id, text: 'bo was here' }), /your own/);
  assert.match(await bo.refused('msg.delete', { conv: lounge, id }), /your own/);
  assert.match(await bo.refused('highlight.set', { conv: lounge, id, on: true }), /can’t curate/);

  // Give Bo a role that may moderate; now the same delete is allowed.
  const { id: role } = await ada.ok('role.create', { house });
  await ada.ok('role.update', { house, role, name: 'Technician', perms: ['post', 'moderate', 'not-a-real-permission'] });
  await ada.ok('member.role', { house, user: bo.id, role });
  const view = await bo.next('house', (d) => d.house.members[bo.id] === role);
  assert.deepEqual(view.house.roles.find((r) => r.id === role).perms, ['post', 'moderate'], 'unknown permissions are dropped');
  await bo.ok('msg.delete', { conv: lounge, id });
  await ada.next('msg.del', (d) => d.id === id);
  // But a non-owner can never hand out the owner role.
  const ownerRole = view.house.roles[0].id;
  await ada.ok('role.update', { house, role, perms: ['post', 'moderate', 'roles'] });
  assert.match(await bo.refused('member.role', { house, user: cy.id, role: ownerRole }), /isn’t in this house/);
  assert.match(await bo.refused('role.update', { house, role: ownerRole, name: 'Mine now' }), /Only an owner/);
  ada.events.length = 0; bo.events.length = 0;
});

test('edit, delete with undo, and reactions sync', async () => {
  const id = mid();
  await bo.ok('msg.send', { conv: lounge, id, text: 'Cone 5?' });
  await ada.next('msg', (d) => d.m.id === id);
  await bo.ok('msg.edit', { conv: lounge, id, text: 'Cone 6.' });
  const edited = await ada.next('msg', (d) => d.m.id === id);
  assert.equal(edited.m.text, 'Cone 6.');
  assert.ok(edited.m.edited);

  await ada.ok('react', { conv: lounge, id, emoji: '👍', on: true });
  await bo.ok('react', { conv: lounge, id, emoji: '👍', on: true });
  const rx = await bo.next('react', (d) => d.id === id && d.reactions['👍']?.length === 2);
  assert.deepEqual(rx.reactions['👍'], [ada.id, bo.id]);
  await ada.ok('react', { conv: lounge, id, emoji: '👍', on: false });
  await bo.next('react', (d) => d.id === id && d.reactions['👍'].length === 1);
  assert.match(await ada.refused('react', { conv: lounge, id, emoji: '<script>', on: true }), /emoji only/);

  await bo.ok('msg.delete', { conv: lounge, id });
  await ada.next('msg.del', (d) => d.id === id);
  assert.equal((await ada.ok('history', { conv: lounge })).msgs.some((m) => m.id === id), false);
  await bo.ok('msg.restore', { conv: lounge, id });
  assert.equal((await ada.next('msg', (d) => d.m.id === id)).m.text, 'Cone 6.');
});

test('threads: replies stay in the thread, repliers follow it', async () => {
  const root = mid(), reply = mid();
  await ada.ok('msg.send', { conv: lounge, id: root, text: 'Anyone layered satin white over tenmoku?' });
  await bo.ok('msg.send', { conv: `t:${root}`, id: reply, text: 'Goes milky blue where it’s thick.' });
  const ev = await ada.next('msg', (d) => d.m.id === reply);
  assert.equal(ev.conv, `t:${root}`);
  assert.deepEqual(ev.thread, { id: `t:${root}`, conv: lounge, root });
  assert.equal((await bo.next('self', (d) => d.follow)).follow[`t:${root}`], true);
  assert.equal((await ada.ok('history', { conv: lounge })).msgs.some((m) => m.id === reply), false, 'the room itself stays clean');
  assert.match(await cy.refused('msg.send', { conv: `t:${root}`, id: mid(), text: 'sneaking in' }), /access/);
  assert.match(await ada.refused('msg.send', { conv: `t:${reply}`, id: mid(), text: 'thread on a thread' }), /no longer exists/);
});

test('direct messages: private, and only between people who share a house', async () => {
  assert.match(await cy.refused('dm.open', { users: [ada.id] }), /share a house/);
  const { id: dm } = await ada.ok('dm.open', { users: [bo.id] });
  assert.equal((await bo.next('dm', (d) => d.dm.id === dm)).dm.members.length, 2);
  assert.equal((await bo.ok('dm.open', { users: [ada.id] })).id, dm, 'the same two people get the same conversation');
  const id = mid();
  await ada.ok('msg.send', { conv: dm, id, text: 'Could you cover Saturday?' });
  await bo.next('msg', (d) => d.m.id === id);
  await cy.none('msg');
  assert.match(await cy.refused('history', { conv: dm }), /access/);
  assert.match(await cy.refused('msg.send', { conv: dm, id: mid(), text: 'hello?' }), /access/);
  // A one-to-one conversation is always for you: it can be muted, not narrowed.
  assert.match(await ada.refused('notify.set', { kind: 'dm', id: dm, level: 'mentions' }), /level/i);
  await ada.ok('notify.set', { kind: 'dm', id: dm, level: 'muted' });
  // A group can narrow to mentions and replies.
  const dee = await Client.make('dee', 'Dee Okafor');
  const { code } = await ada.ok('invite.create', { house });
  await dee.ok('invite.accept', { code });
  const { id: group } = await ada.ok('dm.open', { users: [bo.id, dee.id] });
  await ada.ok('notify.set', { kind: 'dm', id: group, level: 'mentions' });
  assert.equal((await ada.next('dm', (d) => d.dm.id === group && d.dm.notify === 'mentions')).dm.notify, 'mentions');
  dee.close();
});

test('presence follows real connections; typing reaches the room', async () => {
  assert.equal(ada.hello.users[ada.id].presence, 'around');
  await bo.ok('me.update', { presence: 'focus', status: 'Loading the kiln' });
  const u = await ada.next('user', (d) => d.user.id === bo.id);
  assert.equal(u.user.presence, 'focus');
  assert.equal(u.user.status, 'Loading the kiln');
  await bo.ok('typing', { conv: lounge });
  assert.equal((await ada.next('typing')).user, bo.id);
  await cy.none('typing');
  assert.match(await bo.refused('me.update', { presence: 'invisible-admin' }), /choices/);
});

test('read state and saved messages sync to a person’s other devices', async () => {
  const phone = new Client();
  phone.cookie = ada.cookie; phone.id = ada.id;
  await phone.connect();
  await ada.ok('read.set', { conv: lounge, ts: 12345 });
  assert.equal((await phone.next('self', (d) => d.read)).read[lounge], 12345);
  const target = (await ada.ok('history', { conv: lounge })).msgs[0];
  await ada.ok('saved.set', { conv: lounge, id: target.id, on: true, note: 'keep this' });
  const s = await phone.next('self', (d) => d.saved);
  assert.equal(s.saved[0].note, 'keep this');
  // A message sent from one device shows on the other.
  const id = mid();
  await phone.ok('msg.send', { conv: lounge, id, text: 'from my phone' });
  await ada.next('msg', (d) => d.m.id === id);
  await phone.close();
});

test('search finds stored messages, only where you may read', async () => {
  const hit = (await ada.ok('search', { q: 'tenmoku' })).hits;
  assert.ok(hit.length >= 1);
  assert.equal((await cy.ok('search', { q: 'tenmoku' })).hits.length, 0, 'outsiders find nothing');
  assert.ok((await bo.ok('search', { q: 'from:ada tenmoku' })).hits.every((h) => h.m.author === ada.id));
  assert.equal((await ada.ok('search', { q: 'is:saved' })).hits.length, 1);
  assert.ok((await ada.ok('search', { q: 'saturday' })).hits.length >= 1, 'direct messages are searchable by their members');
  assert.equal((await ada.ok('search', { q: "100%' OR 1=1 --" })).hits.length, 0, 'query text is data, not SQL');
});

test('input is validated and markup is stored as plain text', async () => {
  assert.match(await ada.refused('msg.send', { conv: lounge, id: mid(), text: 'x'.repeat(4001) }), /at most 4000/);
  assert.match(await ada.refused('msg.send', { conv: lounge, id: mid(), text: '   ' }), /Write something/);
  assert.match(await ada.refused('msg.send', { conv: lounge, id: 'short', text: 'bad id' }), /isn’t valid/);
  assert.match(await ada.refused('room.create', { house, name: '', kind: 'text' }), /empty/);
  assert.match(await ada.refused('room.create', { house, name: 'Lounge', kind: 'text' }), /already a room/);
  assert.match(await ada.refused('room.create', { house, name: 'Secret', kind: 'admin' }), /choices/);
  assert.match(await ada.refused('nope.nope', {}), /doesn’t know/);
  assert.match(await ada.refused('__proto__', {}), /doesn’t know/);
  const id = mid();
  await ada.ok('msg.send', { conv: lounge, id, text: '<img src=x onerror=alert(1)>' });
  assert.equal((await bo.next('msg', (d) => d.m.id === id)).m.text, '<img src=x onerror=alert(1)>');
});

test('files: upload needs access, download needs access', async () => {
  const up = (who, conv) => fetch(`${base}/api/files?conv=${encodeURIComponent(conv)}`, {
    method: 'POST', headers: { cookie: who.cookie, origin: base, 'content-type': 'text/html', 'x-file-name': 'notes.html' }, body: '<script>alert(1)</script>',
  });
  assert.equal((await up(cy, lounge)).status, 403);
  const res = await up(ada, lounge);
  assert.equal(res.status, 201);
  const f = await res.json();
  const id = mid();
  await ada.ok('msg.send', { conv: lounge, id, text: '', files: [{ id: f.id }] });
  assert.equal((await bo.next('msg', (d) => d.m.id === id)).m.files[0].name, 'notes.html');
  assert.match(await bo.refused('msg.send', { conv: lounge, id: mid(), text: 'steal', files: [{ id: f.id }] }), /didn’t finish uploading/);
  const got = await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: bo.cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/octet-stream', 'html is never served as a page');
  assert.match(got.headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: cy.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/files/${f.id}`)).status, 401);
});

test('voice: only members of the same room can signal each other', async () => {
  const rooms = (await ada.ok('sync')).rooms;
  const hangout = Object.values(rooms).find((r) => r.kind === 'voice').id;
  assert.deepEqual((await ada.ok('voice.join', { room: hangout })).peers, []);
  assert.deepEqual((await bo.ok('voice.join', { room: hangout })).peers, [ada.id]);
  assert.deepEqual((await ada.next('voice', (d) => d.users.length === 2)).users, [ada.id, bo.id]);
  await bo.ok('rtc', { to: ada.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  assert.equal((await ada.next('rtc')).from, bo.id);
  assert.match(await cy.refused('rtc', { to: ada.id, data: { candidate: {} } }), /isn’t in your voice room/);
  assert.match(await cy.refused('voice.join', { room: hangout }), /member/);
  await bo.ok('voice.state', { muted: true });
  assert.equal((await ada.next('voice', (d) => d.state[bo.id]?.muted)).state[bo.id].muted, true);
  await bo.ok('voice.leave');
  assert.deepEqual((await ada.next('voice', (d) => d.users.length === 1)).users, [ada.id]);
  await ada.ok('voice.leave');
});

test('removing a member cuts them off at once', async () => {
  await ada.ok('member.remove', { house, user: bo.id });
  await bo.next('house.gone', (d) => d.id === house);
  assert.match(await bo.refused('msg.send', { conv: lounge, id: mid(), text: 'still here?' }), /access/);
  const id = mid();
  await ada.ok('msg.send', { conv: lounge, id, text: 'after bo left' });
  await bo.none('msg', (d) => d.m.id === id);
  // With someone else still in the house, its only owner can't walk away.
  const { code } = await ada.ok('invite.create', { house });
  await cy.ok('invite.accept', { code });
  assert.match(await ada.refused('house.leave', { house }), /only owner/i);
});

test('rate limits: a burst of messages is slowed down', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () => ada.op('msg.send', { conv: lounge, id: mid(), text: 'spam' })));
  const refused = results.filter((r) => !r.ok);
  assert.ok(refused.length >= 10, `expected a burst to be limited, ${refused.length} refused`);
  assert.match(refused[0].error, /little fast/);
});

test('everything survives a restart; reconnecting brings it all back', async () => {
  const before = (await ada.ok('sync'));
  const count = before.msgs[lounge].length;
  await srv.close();
  await boot();
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: ada.cookie } })).status, 200, 'sessions persist');
  await ada.connect();
  assert.equal(ada.hello.msgs[lounge].length, count);
  assert.equal(ada.hello.houses[house].name, 'Kiln & Co.');
  assert.equal(ada.hello.read[lounge] > 0, true);
  assert.equal(ada.hello.saved.length, 1);
});

test('signing out everywhere closes live sockets; a new password ends old sessions', async () => {
  const closed = new Promise((r) => ada.ws.on('close', (code) => r(code)));
  assert.equal((await post('/api/logout-all', {}, ada.cookie)).status, 200);
  assert.equal(await closed, 4001);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: ada.cookie } })).status, 401);
  const again = await post('/api/login', { handle: 'ada', password: 'a long password' });
  const c1 = cookieOf(again);
  assert.equal((await post('/api/password', { current: 'wrong', next: 'another long one' }, c1)).status, 401);
  const changed = await post('/api/password', { current: 'a long password', next: 'another long one' }, c1);
  assert.equal(changed.status, 200);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: c1 } })).status, 401, 'the old session is gone');
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: cookieOf(changed) } })).status, 200);
  assert.equal((await post('/api/login', { handle: 'ada', password: 'a long password' })).status, 401);
});

test('sign-in attempts are limited', async () => {
  let limited = 0;
  for (let i = 0; i < 14; i++) if ((await post('/api/login', { handle: 'cy', password: 'wrong wrong' })).status === 429) limited++;
  assert.ok(limited >= 3, `expected throttling, got ${limited}`);
});

// Friends, discovery and events. Every person below is a separate real account.

test('an older database gains the new columns and tables without losing anything', () => {
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, pass TEXT NOT NULL,
      hue INTEGER NOT NULL DEFAULT 165, emoji TEXT, about TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', presence TEXT NOT NULL DEFAULT 'around', created INTEGER NOT NULL);
    CREATE TABLE houses (id TEXT PRIMARY KEY, name TEXT NOT NULL, mark TEXT NOT NULL, hue INTEGER NOT NULL, about TEXT NOT NULL DEFAULT '',
      join_role TEXT, starter TEXT NOT NULL DEFAULT '[]', first_step TEXT, created INTEGER NOT NULL);
    INSERT INTO users (id, handle, name, pass, created) VALUES ('u_old', 'old', 'Old Timer', 'x', 1);
    INSERT INTO houses (id, name, mark, hue, created) VALUES ('h_old', 'Old House', 'O', 200, 1);`);
  old.close();
  for (let i = 0; i < 2; i++) {  // twice: opening an up-to-date database changes nothing
    const db = openDb(path);
    assert.deepEqual({ ...db.get('SELECT interests, links FROM users WHERE id = ?', 'u_old') }, { interests: '[]', links: '[]' });
    assert.deepEqual({ ...db.get('SELECT public, topic, rules FROM houses WHERE id = ?', 'h_old') }, { public: 0, topic: null, rules: '' });
    assert.equal(db.get('SELECT COUNT(*) n FROM friends').n, 0);
    assert.equal(db.get('SELECT COUNT(*) n FROM events').n, 0);
    db.close();
  }
});

test('brand files are served from /brand/', async () => {
  const exists = existsSync(fileURLToPath(new URL('../brand/favicon.svg', import.meta.url)));
  const res = await fetch(`${base}/brand/favicon.svg`);
  await res.arrayBuffer();
  assert.equal(res.status, exists ? 200 : 404);
  if (exists) assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal((await fetch(`${base}/brand/missing.svg`)).status, 404);
});

let fern, gus, hal;
const friendEv = (c, other, pred = () => true) => c.next('friend', (d) => d.id === other && pred(d.friend));

test('friends: request by username or id, accept, decline; both people and all their devices hear', async () => {
  fern = await Client.make('fern', 'Fern Ashby');
  gus = await Client.make('gus', 'Gus Moreau');
  hal = await Client.make('hal', 'Hal Ito');
  const gusPhone = new Client(); gusPhone.cookie = gus.cookie; gusPhone.id = gus.id; await gusPhone.connect();

  assert.deepEqual(await fern.ok('friend.request', { handle: '@GUS' }), { state: 'outgoing', user: gus.id });
  assert.equal((await friendEv(fern, gus.id)).friend.state, 'outgoing');
  for (const device of [gus, gusPhone]) {
    const ev = await friendEv(device, fern.id);
    assert.equal(ev.friend.state, 'incoming');
    assert.equal(ev.user.name, 'Fern Ashby', 'the request carries who it is from');
  }
  assert.equal((await fern.ok('friend.request', { user: gus.id })).state, 'outgoing', 'asking twice is harmless');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM friends WHERE user IN (?, ?)', fern.id, gus.id).n, 2);

  assert.match(await fern.refused('friend.request', { user: fern.id }), /That’s you/);
  assert.match(await fern.refused('friend.request', { handle: 'fern' }), /That’s you/);
  assert.match(await fern.refused('friend.request', { handle: 'nobody-at-all' }), /Nobody is called @nobody-at-all/);
  assert.match(await fern.refused('friend.request', { user: 'u_does_not_exist' }), /doesn’t exist/);
  assert.match(await fern.refused('friend.request', { user: '<script>' }), /isn’t valid/);
  assert.match(await fern.refused('friend.request', {}), /missing/);
  assert.match(await fern.refused('friend.accept', { user: gus.id }), /isn’t open/, 'you cannot accept your own request');

  // Hal asks Gus, Gus says no: it is gone for both.
  await hal.ok('friend.request', { user: gus.id });
  await friendEv(gus, hal.id, (f) => f?.state === 'incoming');
  await gus.ok('friend.decline', { user: hal.id });
  assert.equal((await friendEv(hal, gus.id, (f) => f === null)).friend, null);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM friends WHERE user = ? OR other = ?', hal.id, hal.id).n, 0);

  await gus.ok('friend.accept', { user: fern.id });
  assert.equal((await friendEv(fern, gus.id, (f) => f?.state === 'friends')).friend.state, 'friends');
  await friendEv(gusPhone, fern.id, (f) => f?.state === 'friends');

  // A star is private: only Fern's own devices hear about it.
  gus.events.length = 0;
  await fern.ok('friend.favorite', { user: gus.id, on: true });
  assert.equal((await friendEv(fern, gus.id, (f) => f?.favorite)).friend.favorite, true);
  await gus.none('friend', (d) => d.id === fern.id);
  assert.match(await gus.refused('friend.favorite', { user: hal.id, on: true }), /only star/);

  // Friends without a shared house still arrive in each other's snapshot.
  const again = await fern.ok('sync');
  assert.deepEqual(again.friends[gus.id], { state: 'friends', favorite: true, since: again.friends[gus.id].since });
  assert.equal(again.users[gus.id].name, 'Gus Moreau');
  assert.equal((await gus.ok('sync')).friends[fern.id].favorite, false, 'each side has its own star');

  await gus.ok('friend.remove', { user: fern.id });
  await friendEv(fern, gus.id, (f) => f === null);
  await friendEv(gusPhone, fern.id, (f) => f === null);
  assert.deepEqual((await fern.ok('sync')).friends, {});

  // Asking someone who already asked you is saying yes.
  await hal.ok('friend.request', { user: fern.id });
  assert.equal((await fern.ok('friend.request', { handle: 'hal' })).state, 'friends');
  await friendEv(hal, fern.id, (f) => f?.state === 'friends');
  assert.match(await fern.refused('friend.request', { user: hal.id }), /already friends/);
  await gusPhone.close();
});

test('friends see each other’s presence and profile without sharing a house; strangers do not', async () => {
  // Ivy has an account but is not connected yet.
  const res = await post('/api/register', { handle: 'ivy', name: 'Ivy Brenner', password: 'a long password' });
  const ivy = new Client(); ivy.cookie = cookieOf(res); ivy.id = (await res.json()).user.id;
  await fern.ok('friend.request', { handle: 'ivy' });
  assert.equal((await friendEv(fern, ivy.id)).user.presence, 'offline');
  // Sending a request is not enough to watch someone: Ivy hasn't said yes.
  await ivy.connect();
  await ivy.ok('me.update', { status: 'Busy today' });
  await fern.none('presence', (d) => d.user === ivy.id);
  await fern.none('user', (d) => d.user.id === ivy.id);
  const asked = (await fern.ok('sync')).users[ivy.id];
  assert.equal(asked.presence, 'offline', 'someone you only asked looks offline to you');
  assert.equal(asked.status, '', 'and shows no status');
  // The person asked does see who asked them.
  assert.equal((await ivy.ok('sync')).users[fern.id].presence, 'around');
  await gus.none('presence', (d) => d.user === ivy.id);
  await ivy.ok('friend.accept', { user: fern.id });
  const yes = await friendEv(fern, ivy.id, (f) => f?.state === 'friends');
  assert.equal(yes.user.presence, 'around', 'saying yes lets them see you');
  assert.equal(yes.user.status, 'Busy today');
  await ivy.ok('me.update', { status: 'Out walking', presence: 'away' });
  const u = await fern.next('user', (d) => d.user.id === ivy.id && d.user.status === 'Out walking');
  assert.equal(u.user.presence, 'away');
  await gus.none('user', (d) => d.user.id === ivy.id);

  // Friends can start a conversation; a pending request cannot.
  await ivy.ok('dm.open', { users: [fern.id] });
  await hal.ok('friend.request', { user: ivy.id });
  assert.match(await hal.refused('dm.open', { users: [ivy.id] }), /share a house/);

  // Declined or taken back, a request can't be sent again for a day.
  await ivy.ok('friend.decline', { user: hal.id });
  assert.match(await hal.refused('friend.request', { user: ivy.id }), /ask again tomorrow/);
  const cancelled = await Client.make('jo', 'Jo Park');
  await cancelled.ok('friend.request', { user: ivy.id });
  await cancelled.ok('friend.remove', { user: ivy.id });
  assert.match(await cancelled.refused('friend.request', { user: ivy.id }), /ask again tomorrow/);
  // The other way round is still open: Ivy can ask Jo.
  assert.equal((await ivy.ok('friend.request', { user: cancelled.id })).state, 'outgoing');
  srv.db.run('UPDATE friend_cooldown SET ts = ts - ? WHERE user = ?', 86_400_001, hal.id);
  assert.equal((await hal.ok('friend.request', { user: ivy.id })).state, 'outgoing', 'after a day you can ask again');

  // Unfriended with no place in common: they go offline to each other.
  await cancelled.ok('friend.accept', { user: ivy.id });
  assert.equal((await friendEv(cancelled, ivy.id, (f) => f?.state === 'friends')).user.presence, 'away');
  await cancelled.ok('friend.remove', { user: ivy.id });
  assert.equal((await friendEv(cancelled, ivy.id, (f) => f === null)).user.presence, 'offline');
  assert.equal((await friendEv(ivy, cancelled.id, (f) => f === null)).user.presence, 'offline');
  // Fern and Ivy still share a conversation, so they still see each other.
  await fern.ok('friend.remove', { user: ivy.id });
  assert.equal((await friendEv(fern, ivy.id, (f) => f === null)).user.presence, 'away');
  await ivy.close();
  await cancelled.close();
});

test('profiles: interests and links are checked, and reach friends', async () => {
  assert.match(await fern.refused('me.update', { interests: Array.from({ length: 9 }, (_, i) => `thing ${i}`) }), /up to 8/);
  assert.match(await fern.refused('me.update', { interests: ['x'.repeat(25)] }), /at most 24/);
  assert.match(await fern.refused('me.update', { interests: 'jazz' }), /missing/);
  assert.match(await fern.refused('me.update', { links: [{ label: 'Site', url: 'http://example.org' }] }), /https/);
  assert.match(await fern.refused('me.update', { links: [{ label: 'Hi', url: 'javascript:alert(1)' }] }), /https/);
  assert.match(await fern.refused('me.update', { links: [{ url: `https://example.org/${'a'.repeat(200)}` }] }), /at most 200/);
  assert.match(await fern.refused('me.update', { links: Array.from({ length: 4 }, () => ({ url: 'https://example.org' })) }), /up to 3/);
  assert.match(await fern.refused('me.update', { links: [{ label: 'x'.repeat(41), url: 'https://example.org' }] }), /at most 40/);
  await fern.ok('me.update', { interests: [' Jazz ', 'jazz', 'Ceramics'], links: [{ url: 'https://www.example.org/fern' }, { label: 'Shop', url: 'https://shop.example.org' }] });
  const u = await hal.next('user', (d) => d.user.id === fern.id && d.user.links.length);
  assert.deepEqual(u.user.interests, ['Jazz', 'Ceramics']);
  assert.deepEqual(u.user.links, [{ label: 'example.org', url: 'https://www.example.org/fern' }, { label: 'Shop', url: 'https://shop.example.org/' }]);
  assert.ok(u.user.since > 0);
});

let kay, lou, max, kitchen, kitchenLounge, lab, labRoom;

test('house settings: public, topic and rules, for people allowed to change them', async () => {
  kay = await Client.make('kay', 'Kay Obi');
  lou = await Client.make('lou', 'Lou Ferrante');
  max = await Client.make('max', 'Max Stern');
  ({ house: kitchen, room: kitchenLounge } = await kay.ok('house.create', { name: 'Open Kitchen', hue: 200 }));
  ({ house: lab, room: labRoom } = await kay.ok('house.create', { name: 'Secret Lab', hue: 250 }));
  assert.match(await kay.refused('house.update', { house: kitchen, topic: 'Cooking' }), /choices/);
  assert.match(await kay.refused('house.update', { house: kitchen, rules: 'x'.repeat(2001) }), /at most 2000/);
  assert.match(await kay.refused('house.update', { house: kitchen, public: 'yes' }), /yes or no/);
  assert.match(await lou.refused('house.update', { house: kitchen, public: true }), /not a member/);
  await kay.ok('house.update', { house: kitchen, public: true, topic: 'Local', rules: 'Wash up.\nLabel your jars.' });
  const h = await kay.next('house', (d) => d.house.id === kitchen && d.house.public);
  assert.deepEqual([h.house.public, h.house.topic, h.house.rules], [true, 'Local', 'Wash up.\nLabel your jars.']);
  assert.ok(h.house.created > 0);
  await kay.ok('house.update', { house: lab, topic: 'Tech' });
  assert.equal((await kay.ok('sync')).houses[lab].public, false, 'houses start private');
});

test('discover: only public houses, never private ones, whatever the search', async () => {
  const d = await lou.ok('discover', {});
  const card = d.houses.find((x) => x.id === kitchen);
  assert.ok(card, 'the public house is listed');
  assert.equal(d.houses.some((x) => x.id === lab), false, 'the private house is not');
  assert.deepEqual(Object.keys(card).sort(), ['about', 'created', 'friends', 'hue', 'id', 'inVoice', 'mark', 'members', 'name', 'online', 'rooms', 'talking', 'topic'].sort());
  assert.equal(card.members, 1);
  assert.equal(card.online, 1);
  assert.deepEqual(card.rooms.map((r) => r.kind), ['news', 'text', 'text', 'voice']);
  assert.equal(JSON.stringify(d).includes(kay.id), false, 'no member ids for strangers');
  assert.equal((await lou.ok('discover', { q: 'secret' })).houses.length, 0, 'searching a private house by name finds nothing');
  assert.equal((await lou.ok('discover', { q: 'lab', topic: 'Tech' })).houses.length, 0);
  assert.equal((await lou.ok('discover', { q: 'KITCHEN', topic: 'Local' })).houses.length, 1);
  assert.equal((await lou.ok('discover', { topic: 'Music' })).houses.some((x) => x.id === kitchen), false);
  assert.match(await lou.refused('discover', { topic: 'Cooking' }), /choices/);
  assert.equal((await kay.ok('discover', {})).houses.some((x) => x.id === kitchen), false, 'houses you are in are not suggested');

  assert.match(await lou.refused('house.preview', { house: lab }), /private/);
  assert.match(await lou.refused('house.preview', { house: 'h_nope' }), /private/, 'missing and private look the same');
  const p = await lou.ok('house.preview', { house: kitchen });
  assert.equal(p.rules, 'Wash up.\nLabel your jars.');
  assert.equal(p.joined, false);
  assert.deepEqual(p.events, []);
  assert.match(await lou.refused('house.joinPublic', { house: lab }), /isn’t open/);
  assert.match(await lou.refused('msg.send', { conv: labRoom, id: mid(), text: 'in?' }), /access/);
});

test('joining a public house needs no invitation and starts as a newcomer', async () => {
  const r = await lou.ok('house.joinPublic', { house: kitchen });
  assert.equal(r.house, kitchen);
  const h = await lou.next('house', (d) => d.house.id === kitchen);
  assert.equal(h.house.joined, true);
  assert.equal(h.house.newcomer, true);
  await kay.next('house', (d) => d.house.members[lou.id]);
  assert.deepEqual(await lou.ok('house.joinPublic', { house: kitchen }), { house: kitchen, starter: r.starter }, 'joining twice is harmless');
  assert.equal((await lou.ok('house.preview', { house: kitchen })).joined, true);
});

test('discover: people only through a shared house or a mutual friend', async () => {
  const nia = await Client.make('nia', 'Nia Kowalczyk');
  let people = (await lou.ok('discover', {})).people;
  const k = people.find((p) => p.user.id === kay.id);
  assert.deepEqual(k.mutualHouses, [kitchen]);
  assert.equal(k.reason, 'In Open Kitchen');
  assert.equal(k.user.presence, 'around', 'people in your houses show their presence');
  assert.equal(people.some((p) => p.user.id === max.id || p.user.id === nia.id), false, 'strangers are never suggested');
  assert.equal((await lou.ok('discover', { q: 'max' })).people.length, 0, 'not even by name');
  assert.equal((await lou.ok('discover', { q: 'stern' })).people.length, 0);

  // Lou and Kay become friends; Kay is friends with Nia, who shares nothing with Lou.
  await lou.ok('friend.request', { user: kay.id });
  await kay.ok('friend.accept', { user: lou.id });
  await kay.ok('friend.request', { handle: 'nia' });
  await nia.ok('friend.accept', { user: kay.id });
  people = (await lou.ok('discover', {})).people;
  assert.equal(people.some((p) => p.user.id === kay.id), false, 'friends are not suggested');
  const n = people.find((p) => p.user.id === nia.id);
  assert.deepEqual([n.mutualFriends, n.mutualHouses, n.reason], [1, [], 'Friends with Kay Obi']);
  assert.equal(n.user.presence, 'offline', 'presence is only for people who share a place with you');
  assert.equal((await lou.ok('discover', { q: 'kowal' })).people.length, 1);
  assert.equal((await max.ok('discover', {})).people.length, 0, 'someone with no connections gets no people');
  const card = (await max.ok('discover', {})).houses.find((x) => x.id === kitchen);
  assert.deepEqual([card.members, card.friends], [2, []]);
  assert.deepEqual((await nia.ok('discover', {})).houses.find((x) => x.id === kitchen).friends, [kay.id], 'friends inside a house are named');
  nia.close();
});

test('rate limits: discovery and friend requests are slowed down', async () => {
  const d = await Promise.all(Array.from({ length: 16 }, () => max.op('discover', {})));
  assert.ok(d.filter((r) => !r.ok).length >= 4);
  assert.match(d.find((r) => !r.ok).error, /little fast/);
  const f = await Promise.all(Array.from({ length: 16 }, (_, i) => max.op('friend.request', { handle: `ghost${i}` })));
  assert.ok(f.filter((r) => !r.ok && /little fast/.test(r.error)).length >= 4);
});

test('friend requests: at most 50 waiting at once', async () => {
  const t = Date.now();
  srv.db.tx(() => {
    for (let i = 0; i < 50; i++) {
      srv.db.run('INSERT INTO users (id, handle, name, pass, created) VALUES (?, ?, ?, ?, ?)', `u_bulk${i}`, `bulk${i}`, `Bulk ${i}`, 'x', t);
      srv.db.run("INSERT INTO friends (user, other, state, favorite, since) VALUES (?, ?, 'outgoing', 0, ?), (?, ?, 'incoming', 0, ?)", max.id, `u_bulk${i}`, t, `u_bulk${i}`, max.id, t);
    }
  });
  assert.match(await max.refused('friend.request', { user: fern.id }), /50 requests/);
  await max.ok('friend.remove', { user: 'u_bulk0' });
  await max.ok('friend.request', { user: fern.id });
});

let party;
test('events: planned by the right roles, answered by members, live to the whole house', async () => {
  const soon = Date.now() + 60 * 60_000;
  assert.match(await lou.refused('event.create', { house: kitchen, title: 'Bake-off', starts: soon }), /can’t plan events/);
  assert.match(await max.refused('event.create', { house: kitchen, title: 'Bake-off', starts: soon }), /not a member/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: '', starts: soon }), /empty/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'x'.repeat(81), starts: soon }), /at most 80/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off', about: 'x'.repeat(501), starts: soon }), /at most 500/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off' }), /when it starts/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off', starts: 'tomorrow' }), /when it starts/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off', starts: Date.now() - 3 * 3_600_000 }), /already passed/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off', starts: Date.now() + 400 * 86_400_000 }), /a year/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off', starts: soon, ends: soon - 1 }), /end after/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off', starts: soon, ends: soon + 8 * 86_400_000 }), /up to a week/);
  assert.match(await kay.refused('event.create', { house: kitchen, title: 'Bake-off', starts: soon, room: labRoom }), /isn’t in this house/);

  const made = await kay.ok('event.create', { house: kitchen, title: 'Bake-off', about: 'Bring a loaf.', starts: soon, room: kitchenLounge });
  party = made.id;
  assert.deepEqual([made.event.title, made.event.room, made.event.going, made.event.ends], ['Bake-off', kitchenLounge, [kay.id], null]);
  assert.equal((await lou.next('event', (d) => d.event.id === party)).event.about, 'Bring a loaf.');
  await max.none('event');
  assert.ok((await lou.ok('sync')).events[party], 'in the snapshot');
  assert.equal((await max.ok('sync')).events[party], undefined);
  assert.equal((await max.ok('house.preview', { house: kitchen })).events[0].goingCount, 1, 'visitors see the plan, not the people');

  await lou.ok('event.rsvp', { event: party, going: true });
  assert.deepEqual((await kay.next('event', (d) => d.event.going.length === 2)).event.going, [kay.id, lou.id]);
  assert.match(await max.refused('event.rsvp', { event: party, going: true }), /not a member/);
  assert.match(await lou.refused('event.delete', { event: party }), /can’t cancel/);
  assert.match(await lou.refused('event.rsvp', { event: 'e_missing', going: true }), /cancelled/);

  // Someone who joins later gets the house's events with its content.
  const oz = await Client.make('oz', 'Oz Hartley');
  await oz.ok('house.joinPublic', { house: kitchen });
  assert.ok((await oz.next('content')).events[party]);
  // Leaving a house takes back your answers.
  await oz.ok('event.rsvp', { event: party, going: true });
  await kay.next('event', (d) => d.event.going.includes(oz.id));
  kay.events.length = 0;
  await oz.ok('house.leave', { house: kitchen });
  assert.deepEqual((await kay.next('event', (d) => d.event.id === party && !d.event.going.includes(oz.id))).event.going, [kay.id, lou.id]);
  oz.close();

  await kay.ok('event.delete', { event: party });
  assert.equal((await lou.next('event.gone', (d) => d.id === party)).house, kitchen);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM event_rsvps WHERE event = ?', party).n, 0);
});

test('events: a role with the rooms permission can plan; a finished event takes no answers', async () => {
  const h = (await kay.ok('sync')).houses[kitchen];
  const { id: role } = await kay.ok('role.create', { house: kitchen });
  await kay.ok('role.update', { house: kitchen, role, perms: ['post', 'rooms'] });
  await kay.ok('member.role', { house: kitchen, user: lou.id, role });
  const { id: chat } = await lou.ok('event.create', { house: kitchen, title: 'Tasting', starts: Date.now() + 86_400_000 });
  await kay.ok('event.delete', { event: chat });
  await kay.ok('member.role', { house: kitchen, user: lou.id, role: h.joinRole });
  // An event that already happened, written straight to the database.
  srv.db.run('INSERT INTO events (id, house, room, title, about, starts, ends, by, created) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
    'e_done', kitchen, 'Last week', '', Date.now() - 8 * 86_400_000, Date.now() - 8 * 86_400_000 + 3_600_000, kay.id, Date.now() - 9 * 86_400_000);
  assert.match(await lou.refused('event.rsvp', { event: 'e_done', going: true }), /over/);
  assert.equal((await lou.ok('sync')).events.e_done, undefined, 'long-finished events stay out of the snapshot');
});

test('the sample data opens alive: friends both ways, two houses to discover, three events', async () => {
  const seeded = join(dir, 'seeded');
  const db = openDb(join(seeded, 'snug.db'));
  seedDatabase(db, join(seeded, 'files'), { password: 'snug-demo-1' });
  db.close();
  const other = await startServer({ port: 0, dataDir: seeded, quiet: true });
  try {
    const origin = `http://127.0.0.1:${other.port}`;
    const login = async (handle) => {
      const res = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ handle, password: 'snug-demo-1' }) });
      assert.equal(res.status, 200);
      const ws = new WebSocket(`ws://127.0.0.1:${other.port}/ws`, { headers: { cookie: cookieOf(res), origin } });
      const acks = new Map();
      let n = 0;
      const hello = await new Promise((resolve) => ws.on('message', (b) => {
        const m = JSON.parse(b);
        if (m.t === 'hello') resolve(m.d); else if (m.t === 'ack') acks.get(m.id)?.(m);
      }));
      const op = (o, d) => { const id = ++n; ws.send(JSON.stringify({ t: 'op', id, op: o, d })); return new Promise((r) => acks.set(id, r)); };
      return { hello, op, ws };
    };
    const robin = await login('robin');
    const f = robin.hello.friends;
    assert.equal(f.bex.state, 'incoming');
    assert.equal(f.yuki.state, 'outgoing');
    assert.equal(f.ines.favorite, true);
    assert.equal(f.mira.state, 'friends');
    assert.ok(robin.hello.users.mira, 'a friend with no shared house is in the snapshot');
    assert.deepEqual(Object.keys(robin.hello.events).sort(), ['e_open', 'e_ride', 'e_swap']);
    assert.ok(Object.values(robin.hello.houses).every((h) => h.topic));
    assert.deepEqual(robin.hello.users.ines.links.map((l) => l.label), ['Kiln & Co.', 'Classes']);
    const d = (await robin.op('discover', {})).d;
    assert.deepEqual(d.houses.map((h) => h.id).sort(), ['listen', 'plot']);
    assert.deepEqual(d.houses.find((h) => h.id === 'listen').friends.sort(), ['ines', 'mira']);
    assert.ok(d.people.some((p) => p.user.id === 'sol' && p.reason === 'Friends with Mira Castell'));
    const p = (await robin.op('house.preview', { house: 'listen' })).d;
    assert.equal(p.events[0].id, 'e_party');
    assert.deepEqual(p.events[0].friendsGoing, ['mira']);
    robin.ws.close();
  } finally {
    await other.close();
  }
});

// ---------- Camera and screen sharing (video agent) ----------
test('voice.state: camera and screen flags are validated and reach the room', async () => {
  const seeded = join(dir, 'seeded-video');
  const db = openDb(join(seeded, 'snug.db'));
  seedDatabase(db, join(seeded, 'files'), { password: 'snug-demo-1' });
  db.close();
  const other = await startServer({ port: 0, dataDir: seeded, quiet: true });
  try {
    const origin = `http://127.0.0.1:${other.port}`;
    const login = async (handle) => {
      const res = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ handle, password: 'snug-demo-1' }) });
      assert.equal(res.status, 200);
      const ws = new WebSocket(`ws://127.0.0.1:${other.port}/ws`, { headers: { cookie: cookieOf(res), origin } });
      const acks = new Map();
      const events = [];
      let n = 0;
      const hello = await new Promise((resolve) => ws.on('message', (b) => {
        const m = JSON.parse(b);
        if (m.t === 'hello') resolve(m.d); else if (m.t === 'ack') acks.get(m.id)?.(m); else if (m.t === 'ev') events.push(m);
      }));
      const op = (o, d) => { const id = ++n; ws.send(JSON.stringify({ t: 'op', id, op: o, d })); return new Promise((r) => acks.set(id, r)); };
      const next = async (ev, pred) => {
        for (let end = Date.now() + 1500; Date.now() < end;) {
          const i = events.findIndex((e) => e.ev === ev && pred(e.d));
          if (i >= 0) return events.splice(i, 1)[0].d;
          await new Promise((r) => setTimeout(r, 30));
        }
        throw new Error(`no "${ev}" event arrived`);
      };
      return { hello, op, ws, next };
    };
    const robin = await login('robin');
    const ines = await login('ines');
    assert.equal((await robin.op('voice.join', { room: 'k_wheel' })).ok, true);
    const joined = (await ines.op('voice.join', { room: 'k_wheel' })).d;
    assert.ok(joined.peers.includes('robin'));
    // A new person starts with camera and screen off.
    const first = await robin.next('voice', (d) => d.users.includes('ines'));
    assert.deepEqual(first.state.ines, { muted: false, deaf: false, camera: false, screen: false });

    // Only real booleans are accepted; nothing changes on a refusal.
    for (const bad of [{ camera: 'yes' }, { camera: 1 }, { screen: null }, { muted: 'true' }, { screen: {} }]) {
      const a = await ines.op('voice.state', bad);
      assert.equal(a.ok, false, JSON.stringify(bad));
      assert.match(a.error, /voice state isn’t valid/);
    }
    // Turning the camera on reaches the other person, and leaves mute alone.
    assert.equal((await ines.op('voice.state', { muted: true, deaf: false, camera: true, screen: false })).ok, true);
    let s = (await robin.next('voice', (d) => d.state.ines?.camera)).state.ines;
    assert.deepEqual(s, { muted: true, deaf: false, camera: true, screen: false });
    // A partial update only touches the flags it names.
    assert.equal((await ines.op('voice.state', { screen: true })).ok, true);
    s = (await robin.next('voice', (d) => d.state.ines?.screen)).state.ines;
    assert.deepEqual(s, { muted: true, deaf: false, camera: true, screen: true });
    // Someone in the house but not in the room sees the flags too (the stage shows who has a camera on).
    const malik = await login('malik');
    assert.equal(malik.hello.voice.k_wheel.state.ines.camera, true);
    // Leaving and joining again starts clean.
    assert.equal((await ines.op('voice.leave', {})).ok, true);
    assert.equal((await ines.op('voice.join', { room: 'k_wheel' })).ok, true);
    s = (await robin.next('voice', (d) => d.users.includes('ines') && d.state.ines && !d.state.ines.camera)).state.ines;
    assert.deepEqual(s, { muted: false, deaf: false, camera: false, screen: false });
    for (const c of [robin, ines, malik]) c.ws.close();
  } finally {
    await other.close();
  }
});

// --- Messages extras: voice messages, pins, GIFs ----------------------------
// Each test makes its own people and house, so it does not depend on the ones above.
const MX = { n: 0 };
const mxHandle = (p) => `${p}${Date.now().toString(36).slice(-4)}${++MX.n}`;
async function mxHouse(owner, member) {
  const { house: h, room } = await owner.ok('house.create', { name: 'Clay & Sound', hue: 120 });
  const { code } = await owner.ok('invite.create', { house: h });
  await member.ok('invite.accept', { code });
  return { house: h, room };
}
const upload = (cookie, conv, type, bytes, name = 'file') => fetch(`${base}/api/files?conv=${encodeURIComponent(conv)}`, {
  method: 'POST', headers: { cookie, origin: base, 'content-type': type, 'x-file-name': name }, body: bytes,
});
const pad = (head, n = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(n, 7)]);
const AUDIO_SAMPLES = {
  'audio/webm;codecs=opus': pad([0x1a, 0x45, 0xdf, 0xa3]),
  'audio/ogg': pad('OggS'),
  'audio/mp4': pad(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')])),
  'audio/mpeg': pad('ID3'),
};
const GIF_BYTES = pad('GIF89a', 200);

test('voice messages: every audio type uploads and plays inline; Range seeks; length and waveform are checked', async () => {
  const a = await Client.make(mxHandle('vox'), 'Vox A');
  const b = await Client.make(mxHandle('vox'), 'Vox B');
  const { room } = await mxHouse(a, b);
  for (const [claimed, bytes] of Object.entries(AUDIO_SAMPLES)) {
    const type = claimed.split(';')[0];
    const up = await upload(a.cookie, room, claimed, bytes, 'Voice message');
    assert.equal(up.status, 201, claimed);
    const f = await up.json();
    assert.equal(f.kind, 'audio', claimed);
    const got = await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: b.cookie } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), type);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.match(got.headers.get('content-disposition'), /^inline/);
    assert.equal(got.headers.get('accept-ranges'), 'bytes');
    assert.equal((await got.arrayBuffer()).byteLength, bytes.length);
    const part = await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: b.cookie, range: 'bytes=2-9' } });
    assert.equal(part.status, 206, `${claimed} range`);
    assert.equal(part.headers.get('content-range'), `bytes 2-9/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(2, 10));
    const tail = await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: b.cookie, range: 'bytes=-4' } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 4));
    const bad = await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: b.cookie, range: `bytes=${bytes.length + 5}-` } });
    assert.equal(bad.status, 416);
    await bad.arrayBuffer();
    // A Range header that doesn't parse, or asks for several ranges, is ignored: the whole file.
    for (const odd of ['bytes=0-0,5-9', 'bytes=abc', 'bytes=9-2', 'items=0-3']) {
      const whole = await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: b.cookie, range: odd } });
      assert.equal(whole.status, 200, odd);
      assert.equal(Buffer.from(await whole.arrayBuffer()).length, bytes.length);
    }
  }
  // Something that only claims to be audio downloads instead of playing.
  const fake = await (await upload(a.cookie, room, 'audio/webm', Buffer.from('<html><script>alert(1)</script>'), 'x.webm')).json();
  assert.equal(fake.kind, 'file');
  const fakeGet = await fetch(`${base}/api/files/${fake.id}`, { headers: { cookie: b.cookie } });
  assert.equal(fakeGet.headers.get('content-type'), 'application/octet-stream');
  assert.match(fakeGet.headers.get('content-disposition'), /^attachment/);
  await fakeGet.arrayBuffer();

  // The message carries the length and waveform; the other person gets both.
  const voice = await (await upload(a.cookie, room, 'audio/webm;codecs=opus', AUDIO_SAMPLES['audio/webm;codecs=opus'], 'Voice message.webm')).json();
  const peaks = Array.from({ length: 48 }, (_, i) => (i * 5) % 256);
  assert.match(await a.refused('msg.send', { conv: room, id: mid(), text: '', files: [{ id: voice.id, duration: 4.2, peaks: [...peaks.slice(0, 47), 300] }] }), /waveform/);
  assert.match(await a.refused('msg.send', { conv: room, id: mid(), text: '', files: [{ id: voice.id, duration: 4.2, peaks: ['a'] }] }), /waveform/);
  assert.match(await a.refused('msg.send', { conv: room, id: mid(), text: '', files: [{ id: voice.id, duration: 400, peaks }] }), /5 minutes/);
  const id = mid();
  await a.ok('msg.send', { conv: room, id, text: '', files: [{ id: voice.id, duration: 4.24, peaks }] });
  const ev = await b.next('msg', (d) => d.m.id === id);
  assert.deepEqual(ev.m.files[0], { kind: 'audio', id: voice.id, name: 'Voice message.webm', size: voice.size, duration: 4.2, peaks });
  a.close(); b.close();
});

test('pins: live to everyone who can read, in the snapshot, limited by role in houses and to 50', async () => {
  const a = await Client.make(mxHandle('pin'), 'Pin Owner');
  const b = await Client.make(mxHandle('pin'), 'Pin Member');
  const out = await Client.make(mxHandle('pin'), 'Pin Outsider');
  const { house: h, room } = await mxHouse(a, b);
  const id = mid();
  await a.ok('msg.send', { conv: room, id, text: 'Kiln opens at nine.' });
  await a.ok('msg.pin', { conv: room, id });
  const ev = await b.next('pins', (d) => d.conv === room);
  assert.equal(ev.on, true);
  assert.equal(ev.by, a.id);
  assert.deepEqual(ev.pins.map((p) => p.id), [id]);
  assert.equal(ev.m.text, 'Kiln opens at nine.');
  await out.none('pins');
  // A plain member (post and invite only) can't pin or unpin in a house.
  assert.match(await b.refused('msg.pin', { conv: room, id }), /can’t pin/);
  assert.match(await b.refused('msg.unpin', { conv: room, id }), /can’t pin/);
  assert.match(await out.refused('msg.pin', { conv: room, id }), /access/);
  // Pins come back in the snapshot after a reconnect.
  await b.close(); await b.connect();
  assert.deepEqual(b.hello.pins[room].map((p) => p.id), [id]);
  assert.equal(b.hello.pins[room][0].by, a.id);
  // The new 'pin' permission, or 'moderate', is enough.
  const view = await a.ok('sync');
  const memberRole = view.houses[h].roles[1].id;
  await a.ok('role.update', { house: h, role: memberRole, perms: ['post', 'pin'] });
  await b.ok('msg.unpin', { conv: room, id });
  assert.deepEqual((await a.next('pins', (d) => d.on === false)).pins, []);
  await a.ok('role.update', { house: h, role: memberRole, perms: ['post', 'moderate'] });
  await b.ok('msg.pin', { conv: room, id });
  // Threads have no pins.
  const reply = mid();
  await a.ok('msg.send', { conv: `t:${id}`, id: reply, text: 'In a thread' });
  assert.match(await a.refused('msg.pin', { conv: `t:${id}`, id: reply }), /not threads/);
  // In a direct conversation anyone in it can pin; at most 50.
  const { id: dm } = await a.ok('dm.open', { users: [b.id] });
  const ids = [];
  for (let i = 0; i < 51; i++) {
    const m = mid();
    srv.db.run('INSERT INTO messages (id, conv, author, ts, text, fold) VALUES (?, ?, ?, ?, ?, ?)', m, dm, a.id, Date.now() + i, `note ${i}`, `note ${i}`);
    ids.push(m);
  }
  for (let i = 0; i < 50; i++) { if (i % 40 === 0) srv.resetLimits(); await b.ok('msg.pin', { conv: dm, id: ids[i] }); }
  assert.match(await a.refused('msg.pin', { conv: dm, id: ids[50] }), /up to 50/);
  // Older and sample messages have short ids; they pin too.
  srv.db.run('INSERT INTO messages (id, conv, author, ts, text, fold) VALUES (?, ?, ?, ?, ?, ?)', 'm7', room, a.id, Date.now(), 'short id', 'short id');
  await a.ok('msg.pin', { conv: room, id: 'm7' });
  await a.ok('msg.unpin', { conv: room, id: 'm7' });
  await a.ok('msg.unpin', { conv: dm, id: ids[0] });
  await a.ok('msg.pin', { conv: dm, id: ids[50] });
  // A deleted message drops out of the pins.
  b.events.length = 0;
  await a.ok('msg.delete', { conv: room, id });
  assert.deepEqual((await b.next('pins', (d) => d.conv === room)).pins, [], 'everyone hears that the pin went with the message');
  await a.ok('msg.restore', { conv: room, id });
  assert.deepEqual((await b.next('pins', (d) => d.conv === room)).pins.map((p) => p.id), [id], 'and that it came back');
  await a.ok('msg.delete', { conv: room, id });
  const again = await a.ok('sync');
  assert.equal(again.pins[room], undefined);
  assert.equal(again.pins[dm].length, 50);
  a.close(); b.close(); out.close();
});

test('gifs: saved GIFs sync to every device; recent GIFs come from your places only; sending one copies it', async () => {
  const a = await Client.make(mxHandle('gif'), 'Gif A');
  const b = await Client.make(mxHandle('gif'), 'Gif B');
  const out = await Client.make(mxHandle('gif'), 'Gif Out');
  const { room } = await mxHouse(a, b);
  const up = await (await upload(a.cookie, room, 'image/gif', GIF_BYTES, 'wave.gif')).json();
  assert.equal(up.kind, 'image');
  const id = mid();
  await a.ok('msg.send', { conv: room, id, text: '', files: [{ id: up.id, w: 120, h: 80 }] });
  const ev = await b.next('msg', (d) => d.m.id === id);
  assert.equal(ev.m.files[0].gif, true);
  // Recent: b sees the GIF a posted; someone outside the house sees nothing.
  const recent = await b.ok('gif.recent');
  assert.equal(recent.gifs[0].id, up.id);
  assert.equal(recent.gifs[0].by, a.id);
  assert.deepEqual((await out.ok('gif.recent')).gifs, []);
  // Favourite on one device, the other device hears it; it is in the next snapshot.
  const b2 = new Client(); b2.cookie = b.cookie; b2.id = b.id; await b2.connect();
  await b.ok('gif.fav', { file: up.id, on: true, w: 120, h: 80 });
  const synced = await b2.next('gifs');
  assert.deepEqual(synced.favs.map((g) => [g.id, g.w, g.h]), [[up.id, 120, 80]]);
  await b2.close(); await b2.connect();
  assert.equal(b2.hello.gifFavs[0].id, up.id);
  assert.match(await out.refused('gif.fav', { file: up.id, on: true }), /no longer here/);
  // Only GIFs can be saved.
  const png = await (await upload(a.cookie, room, 'image/png', pad([0x89, 0x50, 0x4e, 0x47]), 'tile.png')).json();
  await a.ok('msg.send', { conv: room, id: mid(), text: '', files: [{ id: png.id, w: 1, h: 1 }] });
  assert.match(await b.refused('gif.fav', { file: png.id, on: true }), /Only GIFs/);
  // Sending a saved GIF in a direct conversation copies the file there.
  const { id: dm } = await b.ok('dm.open', { users: [a.id] });
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(body) });
  const copy = await post('/api/gifs/use', { conv: dm, file: up.id }, b.cookie);
  assert.equal(copy.status, 201);
  const c = await copy.json();
  assert.notEqual(c.id, up.id);
  assert.equal(c.gif, true);
  await b.ok('msg.send', { conv: dm, id: mid(), text: '', files: [{ id: c.id, w: 120, h: 80 }] });
  assert.equal((await (await fetch(`${base}/api/files/${c.id}`, { headers: { cookie: a.cookie } })).arrayBuffer()).byteLength, GIF_BYTES.length);
  assert.equal((await post('/api/gifs/use', { conv: dm, file: up.id }, out.cookie)).status, 403, 'an outsider can’t post there');
  // The same GIF sent twice shows once in recent.
  assert.equal((await a.ok('gif.recent')).gifs.filter((g) => g.name === 'wave.gif').length, 1);
  // Unsave.
  await b.ok('gif.fav', { file: up.id, on: false });
  assert.deepEqual((await b2.next('gifs')).favs, []);
  a.close(); b.close(); b2.close(); out.close();
});

test('gif search: off without a key; with one, proxied through Snug with a media allowlist', async () => {
  // Without SNUG_TENOR_KEY the picker has no search, and the routes say so.
  const plain = await Client.make(mxHandle('gs'), 'No Key');
  assert.deepEqual(await (await fetch(`${base}/api/gifs/config`, { headers: { cookie: plain.cookie } })).json(), { search: false });
  assert.equal((await fetch(`${base}/api/gifs?q=cat`, { headers: { cookie: plain.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/gifs/config`)).status, 401, 'signed-in people only');
  plain.close();

  // A stand-in for Tenor on this machine.
  const { createServer } = await import('node:http');
  const seen = [];
  const mock = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u.pathname + u.search);
    const here = `http://127.0.0.1:${mock.address().port}`;
    const elsewhere = `http://localhost:${mock.address().port}`;
    if (u.pathname === '/v2/search') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [
        { id: 'g1', content_description: 'Cat waves', media_formats: { mediumgif: { url: `${here}/media/cat.gif`, dims: [220, 140] }, tinygif: { url: `${here}/media/cat-tiny.gif`, dims: [110, 70] } } },
        { id: 'g2', content_description: 'Off-list', media_formats: { mediumgif: { url: `${elsewhere}/media/cat.gif`, dims: [1, 1] }, tinygif: { url: `${elsewhere}/media/cat.gif` } } },
      ] }));
    } else if (u.pathname.endsWith('.gif')) { res.setHeader('content-type', 'image/gif'); res.end(GIF_BYTES); }
    else if (u.pathname === '/media/page') { res.setHeader('content-type', 'image/gif'); res.end('<html>not a gif</html>'); }
    else if (u.pathname === '/media/hop') { res.writeHead(302, { location: `${elsewhere}/media/cat.gif` }); res.end(); }
    else if (u.pathname === '/media/huge') { res.setHeader('content-type', 'image/gif'); res.end(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10 * 1024 * 1024 + 10)])); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const here = `http://127.0.0.1:${mock.address().port}`;
  const gdir = mkdtempSync(join(tmpdir(), 'snug-gif-'));
  Object.assign(process.env, { SNUG_GIF_PROVIDER: 'tenor', SNUG_TENOR_KEY: 'test-key', SNUG_TENOR_BASE: here });
  let g;
  try {
    g = await startServer({ port: 0, dataDir: gdir, quiet: true });
  } finally {
    for (const k of ['SNUG_GIF_PROVIDER', 'SNUG_TENOR_KEY', 'SNUG_TENOR_BASE']) delete process.env[k];
  }
  const gb = `http://127.0.0.1:${g.port}`;
  const gpost = (path, body, cookie) => fetch(gb + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: gb, cookie }, body: JSON.stringify(body) });
  try {
    const reg = await gpost('/api/register', { handle: 'gifsearcher', name: 'Gif Searcher', password: 'a long password' });
    const cookie = cookieOf(reg);
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}/ws`, { headers: { cookie, origin: gb } });
    const acks = new Map(); let n2 = 0;
    await new Promise((r) => ws.on('message', (buf) => { const m = JSON.parse(buf); if (m.t === 'hello') r(); else if (m.t === 'ack') acks.get(m.id)?.(m); }));
    const op = (o, d) => { const i = ++n2; ws.send(JSON.stringify({ t: 'op', id: i, op: o, d })); return new Promise((r) => acks.set(i, r)); };
    const { room } = (await op('house.create', { name: 'Gif House', hue: 30 })).d;
    const get = (path) => fetch(gb + path, { headers: { cookie } });

    assert.deepEqual(await (await get('/api/gifs/config')).json(), { search: true });
    const found = await (await get('/api/gifs?q=cat')).json();
    assert.equal(found.results.length, 1, 'results whose media is off the allowlist are dropped');
    const r0 = found.results[0];
    assert.equal(r0.title, 'Cat waves');
    assert.equal(r0.w, 220);
    assert.ok(seen.some((s) => s.startsWith('/v2/search?') && s.includes('key=test-key') && s.includes('q=cat')), 'the key goes to the provider, from the server');
    // Previews come through Snug, never straight from the provider.
    assert.match(r0.preview, /^\/api\/gifs\/media\?u=/);
    const prev = await get(r0.preview);
    assert.equal(prev.status, 200);
    assert.equal(prev.headers.get('content-type'), 'image/gif');
    await prev.arrayBuffer();
    assert.equal((await get(`/api/gifs/media?u=${encodeURIComponent(`http://localhost:${mock.address().port}/media/cat.gif`)}`)).status, 403);

    // Picking one: the server downloads it and stores a normal Snug file.
    const imp = await gpost('/api/gifs/import', { conv: room, url: r0.url, w: r0.w, h: r0.h, title: r0.title }, cookie);
    assert.equal(imp.status, 201);
    const f = await imp.json();
    assert.match(f.id, /^f_/);
    assert.equal(f.name, 'Cat waves.gif');
    const file = await get(`/api/files/${f.id}`);
    assert.equal(file.headers.get('content-type'), 'image/gif');
    assert.equal((await file.arrayBuffer()).byteLength, GIF_BYTES.length);
    const mid2 = 'm_gifsearch000001';
    const sent = await op('msg.send', { conv: room, id: mid2, text: '', files: [{ id: f.id, w: 220, h: 140 }] });
    assert.equal(sent.ok, true, sent.error);
    assert.equal(sent.d.m.files[0].gif, true);
    assert.equal(sent.d.m.files[0].w, 220);

    // Refusals: another host (even the same machine under another name), a redirect away, not a GIF, too big.
    const refuse = async (url, status, why) => {
      const res = await gpost('/api/gifs/import', { conv: room, url }, cookie);
      assert.equal(res.status, status, url);
      assert.match((await res.json()).error, why);
    };
    await refuse(`http://localhost:${mock.address().port}/media/cat.gif`, 403, /isn’t one Snug fetches/);
    await refuse('https://evil.example/cat.gif', 403, /isn’t one Snug fetches/);
    await refuse(`${here}/media/hop`, 422, /couldn’t be fetched/);
    await refuse(`${here}/media/page`, 422, /isn’t a GIF/);
    await refuse(`${here}/media/huge`, 422, /over 10 MB/);
    // Someone who can't post in the conversation can't import into it.
    const other = await gpost('/api/register', { handle: 'gifstranger', name: 'Stranger', password: 'a long password' });
    assert.equal((await gpost('/api/gifs/import', { conv: room, url: r0.url }, cookieOf(other))).status, 403);
    ws.close();
  } finally {
    await g.close();
    await new Promise((r) => mock.close(r));
    rmSync(gdir, { recursive: true, force: true });
  }
});
// --- end messages extras ----------------------------------------------------

// --- Custom emoji (server/emoji.js) -----------------------------------------
// A real PNG, w by h pixels of one colour, made here so the tests need no fixture.
async function emoPng(w, h) {
  const { deflateSync, crc32 } = await import('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7a)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const emoUpload = (house, bytes, cookie, type = 'image/png', name = 'party.png') => fetch(`${base}/api/files?emoji=${encodeURIComponent(house)}`, {
  method: 'POST', headers: { 'content-type': type, 'x-file-name': name, origin: base, cookie }, body: bytes,
});
const emoGet = (file, cookie) => fetch(`${base}/api/files/${file}`, { headers: { cookie } });
let emoN = 0;
const emoHandle = (p) => `emo-${p}${++emoN}`;

test('custom emoji: permissions, names, image limits, duplicates and the house limit', async () => {
  const own = await Client.make(emoHandle('own'), 'Emoji Owner');
  const mem = await Client.make(emoHandle('mem'), 'Emoji Member');
  const { house: h, room } = await own.ok('house.create', { name: 'Emoji House', hue: 30 });
  const { code } = await own.ok('invite.create', { house: h });
  await mem.ok('invite.accept', { code });
  assert.deepEqual(mem.hello.emoji, {}, 'a person with no houses has no emoji');
  const png = await emoPng(32, 32);

  // A member without the permission can neither upload nor add.
  const refusedUp = await emoUpload(h, png, mem.cookie);
  assert.equal(refusedUp.status, 403);
  assert.match((await refusedUp.json()).error, /can’t manage emoji/);
  // Image limits, checked from the file itself.
  const big = await emoUpload(h, Buffer.concat([png, Buffer.alloc(256 * 1024)]), own.cookie);
  assert.equal(big.status, 413);
  const huge = await emoUpload(h, await emoPng(300, 200), own.cookie);
  assert.equal(huge.status, 422);
  assert.match((await huge.json()).error, /300 by 200 pixels/);
  const wide = await emoUpload(h, await emoPng(257, 10), own.cookie);
  assert.equal(wide.status, 422, 'one side over 256 is enough to refuse');
  const text = await emoUpload(h, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), own.cookie, 'image/png', 'x.png');
  assert.equal(text.status, 415, 'the type the browser claims is not trusted');
  const jpeg = await emoUpload(h, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(40)]), own.cookie, 'image/jpeg', 'x.jpg');
  assert.equal(jpeg.status, 415);
  assert.equal((await emoUpload('h_nothere', png, own.cookie)).status, 404);
  // GIF and WebP headers are read too.
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([16, 0, 16, 0]), Buffer.alloc(20)]);
  assert.equal((await emoUpload(h, gif, own.cookie, 'image/gif', 'g.gif')).status, 201);
  const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\x2b\x01\0\x0f\0\0\0\0', 'latin1');
  const webpRes = await emoUpload(h, webp, own.cookie, 'image/webp', 'w.webp');
  assert.equal(webpRes.status, 422, 'a 300 by 16 WebP is too wide');

  const up = await emoUpload(h, png, own.cookie);
  assert.equal(up.status, 201);
  const file = await up.json();
  assert.equal(file.w, 32);
  assert.equal(await mem.refused('emoji.add', { house: h, name: 'party', file: file.id }), 'Your role can’t manage emoji in this house.');
  // Bad names.
  for (const [name, why] of [['p', /at least 2/], ['Party', /lowercase/], ['has-dash', /lowercase/], ['has space', /lowercase/], ['x'.repeat(33), /at most 32/], ['', /Give the emoji a name/], ['ünï', /lowercase/]]) {
    assert.match(await own.refused('emoji.add', { house: h, name, file: file.id }), why, `"${name}"`);
  }
  assert.match(await own.refused('emoji.add', { house: h, name: 'party', file: 'f_madeupfile0001' }), /didn’t finish uploading/);
  // Someone else's upload can't be claimed.
  const { emoji } = await own.ok('emoji.add', { house: h, name: 'party', file: file.id });
  assert.equal(emoji.name, 'party');
  assert.match(emoji.id, /^em_/);
  const live = await mem.next('emoji', (d) => d.house === h && d.list.length > 0);
  assert.deepEqual(live.list.map((e) => e.name), ['party'], 'members hear about it at once');
  assert.match(await own.refused('emoji.add', { house: h, name: 'party2', file: file.id }), /already an emoji/, 'one image, one emoji');
  // Duplicates.
  const up2 = await (await emoUpload(h, png, own.cookie)).json();
  assert.match(await own.refused('emoji.add', { house: h, name: 'party', file: up2.id }), /already an emoji called :party:/);
  assert.match(await own.refused('emoji.add', { house: h, name: ':party:', file: up2.id }), /already an emoji called :party:/, 'colons around a name are ignored');
  const { emoji: cake } = await own.ok('emoji.add', { house: h, name: 'cake', file: up2.id });
  assert.match(await own.refused('emoji.rename', { id: cake.id, name: 'party' }), /already an emoji called :party:/);
  assert.match(await mem.refused('emoji.rename', { id: cake.id, name: 'pie' }), /can’t manage emoji/);
  assert.match(await mem.refused('emoji.remove', { id: cake.id }), /can’t manage emoji/);

  // Giving a role the permission lets its people manage emoji.
  const memberRole = srv.db.get('SELECT role FROM members WHERE house = ? AND user = ?', h, mem.id).role;
  const role = srv.db.get('SELECT perms FROM roles WHERE id = ?', memberRole);
  await own.ok('role.update', { house: h, role: memberRole, perms: [...JSON.parse(role.perms), 'emoji'] });
  await mem.ok('emoji.rename', { id: cake.id, name: 'pie' });
  assert.equal(srv.db.get('SELECT name FROM house_emoji WHERE id = ?', cake.id).name, 'pie');

  // At most 100 per house.
  for (let i = srv.db.get('SELECT COUNT(*) n FROM house_emoji WHERE house = ?', h).n; i < 100; i++) {
    srv.db.run('INSERT INTO house_emoji (id, house, name, file, by, created) VALUES (?, ?, ?, ?, ?, ?)', `em_filler${String(i).padStart(6, '0')}`, h, `filler_${i}`, `f_filler${i}`, own.id, Date.now());
  }
  const up3 = await (await emoUpload(h, png, own.cookie)).json();
  assert.match(await own.refused('emoji.add', { house: h, name: 'onemore', file: up3.id }), /up to 100 emoji/);
  srv.db.run("DELETE FROM house_emoji WHERE id LIKE 'em_filler%'");

  // The snapshot carries each house's emoji.
  await mem.close();
  await mem.connect();
  assert.deepEqual(mem.hello.emoji[h].map((e) => e.name), ['party', 'pie']);
  assert.ok(room);
  own.close(); mem.close();
});

test('custom emoji: in messages and reactions, who may see the image, rename and removal', async () => {
  const own = await Client.make(emoHandle('own'), 'Emoji Owner');
  const mem = await Client.make(emoHandle('mem'), 'Emoji Member');
  const out = await Client.make(emoHandle('out'), 'Emoji Outsider');
  const { house: h, room } = await own.ok('house.create', { name: 'Party House', hue: 60 });
  await mem.ok('invite.accept', { code: (await own.ok('invite.create', { house: h })).code });
  const file = await (await emoUpload(h, await emoPng(24, 24), own.cookie)).json();
  // Before it is added, only the uploader can see the image.
  assert.equal((await emoGet(file.id, own.cookie)).status, 200);
  assert.equal((await emoGet(file.id, mem.cookie)).status, 404);
  const { emoji: e } = await own.ok('emoji.add', { house: h, name: 'party', file: file.id });
  const token = `<:party:${e.id}>`;

  // Members may fetch the image; people outside the house may not.
  const img = await emoGet(e.file, mem.cookie);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  await img.arrayBuffer();
  assert.equal((await emoGet(e.file, out.cookie)).status, 404, 'non-members can’t fetch emoji images');
  assert.equal((await fetch(`${base}/api/files/${e.file}`)).status, 401);

  // In the house: the message carries the emoji's metadata.
  const sent = await mem.ok('msg.send', { conv: room, id: mid(), text: `so good ${token}` });
  assert.deepEqual(sent.m.emoji, { [e.id]: { name: 'party', file: e.file, house: h } });
  const seen = await own.next('msg', (d) => d.m.id === sent.m.id);
  assert.equal(seen.m.emoji[e.id].name, 'party');

  // An outsider crafting the token in their own house gets no metadata, and still can't fetch it.
  const { room: theirs } = await out.ok('house.create', { name: 'Elsewhere', hue: 90 });
  const crafted = await out.ok('msg.send', { conv: theirs, id: mid(), text: token });
  assert.equal(crafted.m.emoji, undefined);
  assert.equal((await emoGet(e.file, out.cookie)).status, 404);
  assert.match(await out.refused('react', { conv: theirs, id: crafted.m.id, emoji: token, on: true }), /your own houses/);

  // A member uses it in a direct conversation: its reader there may see it.
  await mem.ok('friend.request', { user: out.id });
  await out.ok('friend.accept', { user: mem.id });
  const { id: dm } = await mem.ok('dm.open', { users: [out.id] });
  const inDm = await mem.ok('msg.send', { conv: dm, id: mid(), text: token });
  const got = await out.next('msg', (d) => d.m.id === inDm.m.id);
  assert.equal(got.m.emoji[e.id].file, e.file);
  assert.equal((await emoGet(e.file, out.cookie)).status, 200, 'readers of a message with the emoji may fetch it');
  // ...and can react with it there, because it already appears there.
  await out.ok('react', { conv: dm, id: inDm.m.id, emoji: token, on: true });
  const rx = await mem.next('react', (d) => d.id === inDm.m.id);
  assert.deepEqual(rx.reactions[token], [out.id]);
  assert.equal(rx.emoji[e.id].name, 'party');

  // Reactions in the house, and bad keys.
  await own.ok('react', { conv: room, id: sent.m.id, emoji: token, on: true });
  const rx2 = await mem.next('react', (d) => d.id === sent.m.id);
  assert.deepEqual(rx2.reactions[token], [own.id]);
  assert.match(await own.refused('react', { conv: room, id: sent.m.id, emoji: '<:party:em_nothere00000>', on: true }), /removed/);
  assert.match(await own.refused('react', { conv: room, id: sent.m.id, emoji: '<:Bad Name:x>', on: true }), /emoji only/);
  // A history page carries the metadata for the reaction too.
  const page = await mem.ok('history', { conv: room });
  assert.equal(page.msgs.find((m) => m.id === sent.m.id).emoji[e.id].name, 'party');

  // Rename: reactions follow, old message tokens still find it by id.
  await own.ok('emoji.rename', { id: e.id, name: 'fiesta' });
  const renamed = await mem.next('emoji', (d) => d.house === h && d.list[0]?.name === 'fiesta');
  assert.equal(renamed.list.length, 1);
  const after = (await mem.ok('history', { conv: room })).msgs.find((m) => m.id === sent.m.id);
  assert.deepEqual(Object.keys(after.reactions), [`<:fiesta:${e.id}>`]);
  assert.equal(after.emoji[e.id].name, 'fiesta');
  // Taking a reaction back works with the old key.
  await own.ok('react', { conv: room, id: sent.m.id, emoji: token, on: false });
  assert.equal((await mem.next('react', (d) => d.id === sent.m.id)).reactions[`<:fiesta:${e.id}>`], undefined);

  // Removal: everyone who could see it hears, the image goes, messages fall back to text.
  await own.ok('emoji.remove', { id: e.id });
  await mem.next('emoji.gone', (d) => d.id === e.id);
  await out.next('emoji.gone', (d) => d.id === e.id);
  assert.equal((await emoGet(e.file, mem.cookie)).status, 404);
  assert.equal((await emoGet(e.file, out.cookie)).status, 404);
  const gone = (await mem.ok('history', { conv: room })).msgs.find((m) => m.id === sent.m.id);
  assert.equal(gone.emoji, undefined);
  assert.equal(gone.text, `so good ${token}`, 'the text keeps the token; the browser shows :party:');
  assert.match(await own.refused('react', { conv: room, id: sent.m.id, emoji: token, on: true }), /removed/);
  own.close(); mem.close(); out.close();
});
// --- end custom emoji -------------------------------------------------------

// --- push notifications (notifications agent) --------------------------------
// A second server of its own, allowed to push to a mock push service on
// 127.0.0.1. The test decrypts each push with the subscription's own keys
// (RFC 8291, written out here with plain HMAC rather than the server's code)
// and checks the VAPID token (RFC 8292).
test('push: subscribe rules, encrypted delivery only while closed, muted and Focused stay quiet, 410 forgets', async () => {
  const { createServer } = await import('node:http');
  const C = await import('node:crypto');
  const { checkEndpoint } = await import('../server/push.js');
  const pdir = mkdtempSync(join(tmpdir(), 'snug-push-'));
  const ps = await startServer({ port: 0, dataDir: pdir, quiet: true, pushAllowLocal: true });
  const pbase = `http://127.0.0.1:${ps.port}`;
  const got = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    got.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(req.url.startsWith('/gone') ? 410 : 201);
    res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const push = `http://127.0.0.1:${mock.address().port}`;
  const socks = [];
  const finish = async () => { for (const w of socks) w.terminate(); mock.close(); await ps.close(); rmSync(pdir, { recursive: true, force: true }); };
  try {
    const ppost = (path, body, cookie, origin = pbase) => fetch(pbase + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    });
    // A person on this server: an account, and a socket that can be closed and reopened.
    const person = async (handle, name) => {
      const res = await ppost('/api/register', { handle, name, password: 'a long password' });
      assert.equal(res.status, 201);
      const p = { cookie: cookieOf(res), id: (await res.json()).user.id, seq: 0, acks: new Map() };
      p.open = () => new Promise((resolve, reject) => {
        p.ws = new WebSocket(`ws://127.0.0.1:${ps.port}/ws`, { headers: { cookie: p.cookie, origin: pbase } });
        socks.push(p.ws);
        p.ws.on('error', reject);
        p.ws.on('message', (buf) => { const m = JSON.parse(buf); if (m.t === 'hello') resolve(); else if (m.t === 'ack') p.acks.get(m.id)?.(m); });
      });
      p.ok = (op, d = {}) => new Promise((resolve, reject) => {
        const id = ++p.seq;
        p.acks.set(id, (m) => (m.ok ? resolve(m.d) : reject(new Error(`${op}: ${m.error}`))));
        p.ws.send(JSON.stringify({ t: 'op', id, op, d }));
      });
      p.shut = async () => {
        await new Promise((r) => { p.ws.on('close', r); p.ws.close(); });
        for (let i = 0; i < 50 && ps.hub.connected(p.id); i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(ps.hub.connected(p.id), false);
      };
      await p.open();
      return p;
    };
    const ada = await person('ada', 'Ada Okafor');
    const bo = await person('bo', 'Bo Lindqvist');
    const made = await ada.ok('house.create', { name: 'Kiln & Co.', hue: 35 });
    const { code } = await ada.ok('invite.create', { house: made.house });
    await bo.ok('invite.accept', { code });
    const { id: dm } = await ada.ok('dm.open', { users: [bo.id] });

    // The key: one per data folder, kept across restarts, behind a session.
    assert.equal((await fetch(`${pbase}/api/push/key`)).status, 401);
    const { key } = await (await fetch(`${pbase}/api/push/key`, { headers: { cookie: bo.cookie } })).json();
    assert.equal(Buffer.from(key, 'base64url').length, 65);
    assert.equal(ps.push.publicKey, key);

    // Subscribing: origin checked, endpoint and keys validated.
    const ua = C.createECDH('prime256v1');
    ua.generateKeys();
    const auth = C.randomBytes(16);
    const sub = (path) => ({ endpoint: `${push}${path}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });
    assert.equal((await ppost('/api/push/subscribe', sub('/bo'), bo.cookie, null)).status, 403, 'no origin, no change');
    assert.equal((await ppost('/api/push/subscribe', sub('/bo'), bo.cookie, 'https://evil.example')).status, 403);
    assert.equal((await ppost('/api/push/subscribe', sub('/bo'))).status, 401);
    assert.equal((await ppost('/api/push/subscribe', { ...sub('/bo'), endpoint: 'ftp://127.0.0.1/x' }, bo.cookie)).status, 400);
    assert.equal((await ppost('/api/push/subscribe', { ...sub('/bo'), keys: { p256dh: 'AAAA', auth: 'AAAA' } }, bo.cookie)).status, 400);
    const badPoint = Buffer.alloc(65, 7); badPoint[0] = 4;
    assert.equal((await ppost('/api/push/subscribe', { ...sub('/bo'), keys: { p256dh: badPoint.toString('base64url'), auth: auth.toString('base64url') } }, bo.cookie)).status, 400, 'a point not on the curve');
    assert.equal((await ppost('/api/push/subscribe', sub('/bo'), bo.cookie)).status, 201);
    // In production (no test flag) only https on a named host will do.
    assert.equal(checkEndpoint('http://127.0.0.1:9/x', false), null);
    assert.equal(checkEndpoint('https://10.0.0.1/x', false), null);
    assert.equal(checkEndpoint('https://localhost/x', false), null);
    assert.equal(checkEndpoint('https://[::1]/x', false), null);
    assert.equal(checkEndpoint('http://fcm.googleapis.com/fcm/send/abc', false), null);
    assert.equal(checkEndpoint('https://fcm.googleapis.com/fcm/send/abc', false), 'https://fcm.googleapis.com/fcm/send/abc');
    assert.equal(checkEndpoint('http://10.0.0.1/x', true), null, 'the test flag allows this machine only');
    // Only the browsers' own push services, on 443: never a name that points at
    // this machine or a private network.
    for (const bad of ['https://127.0.0.1.nip.io/', 'https://169.254.169.254.nip.io/', 'https://metadata.google.internal./',
      'https://localhost./x', 'https://foo.localhost./', 'https://fcm.googleapis.com./x', 'https://fcm.googleapis.com:8443/x',
      'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://push.apple.com.evil.example/x']) {
      assert.equal(checkEndpoint(bad, false), null, bad);
    }
    for (const good of ['https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QAbc',
      'https://wns2-by3p.notify.windows.com/w/?token=abc', 'https://fcm.googleapis.com:443/fcm/send/abc']) {
      assert.ok(checkEndpoint(good, false), good);
    }
    const shared = await post('/api/register', { handle: 'pushprod', name: 'P', password: 'a long password' });
    assert.equal((await post('/api/push/subscribe', sub('/x'), cookieOf(shared))).status, 400, 'the default server refuses http endpoints');

    const decrypt = (body) => {
      const hmac = (k, d) => C.createHmac('sha256', k).update(d).digest();
      const salt = body.subarray(0, 16);
      assert.equal(body.readUInt32BE(16), 4096);
      const idlen = body[20];
      const asPub = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const secret = ua.computeSecret(asPub);
      const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const d = C.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(-16));
      const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
      let i = pt.length - 1;
      while (pt[i] === 0) i--;
      assert.equal(pt[i], 2, 'the last record ends with 0x02');
      return JSON.parse(pt.subarray(0, i));
    };
    const checkVapid = (h) => {
      const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(h.authorization);
      assert.ok(m, h.authorization);
      assert.equal(m[2], key);
      const [hd, pl, sg] = m[1].split('.');
      assert.deepEqual(JSON.parse(Buffer.from(hd, 'base64url')), { typ: 'JWT', alg: 'ES256' });
      const claims = JSON.parse(Buffer.from(pl, 'base64url'));
      assert.equal(claims.aud, push, 'the audience is the push service origin');
      assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
      assert.match(claims.sub, /^(mailto:|https:)/);
      const raw = Buffer.from(m[2], 'base64url');
      const pub = C.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
      assert.equal(C.verify('sha256', Buffer.from(`${hd}.${pl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sg, 'base64url')), true, 'the signature verifies');
    };
    const pushes = async (n, ms = 1500) => {
      const end = Date.now() + ms;
      while (got.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 150)); // and nothing more arrives
      return got.splice(0);
    };
    const send = (conv, text, extra = {}) => { const id = mid(); return ada.ok('msg.send', { conv, id, text, ...extra }).then((r) => r.m); };

    // Bo is connected: the open app notifies by itself, so nothing is pushed.
    await send(dm, 'Are you around?');
    assert.equal((await pushes(1, 400)).length, 0, 'no push while Bo has a live socket');

    // Bo closes every tab: a direct message is pushed, encrypted, signed.
    await bo.shut();
    const long = `Could you cover **Saturday**? ${'The kiln needs watching. '.repeat(20)}`;
    const m1 = await send(dm, long);
    let [p] = await pushes(1);
    assert.ok(p, 'a push arrived');
    assert.equal(p.method, 'POST');
    assert.equal(p.path, '/bo');
    assert.equal(p.headers['content-encoding'], 'aes128gcm');
    assert.equal(p.headers['content-type'], 'application/octet-stream');
    assert.ok(Number(p.headers.ttl) > 0);
    checkVapid(p.headers);
    let note = decrypt(p.body);
    assert.equal(note.title, 'Ada Okafor');
    assert.equal(note.conv, dm);
    assert.equal(note.msg, m1.id);
    assert.equal(note.tag, `snug:${dm}`);
    assert.ok(note.body.startsWith('Could you cover Saturday? The kiln'), 'plain text, no markdown');
    assert.ok(note.body.length <= 180 && note.body.endsWith('…'), 'the preview is cut short');
    // A resend of the same message id (a retry) pushes nothing new.
    await ada.ok('msg.send', { conv: dm, id: m1.id, text: long });
    assert.equal((await pushes(1, 300)).length, 0);

    // Rooms: only what needs Bo. A plain message does not; a mention and a reply do.
    await send(made.room, 'Kiln is hot, everyone.');
    assert.equal((await pushes(1, 400)).length, 0, 'plain room chatter is not pushed');
    await send(made.room, 'Glaze run at 6, @bo are you in?');
    [p] = await pushes(1);
    note = decrypt(p.body);
    assert.equal(note.title, 'Ada Okafor in Lounge');
    assert.equal(note.body, 'Glaze run at 6, @bo are you in?');

    // Muted: the house, then the direct conversation. Nothing at all.
    await bo.open();
    await bo.ok('notify.set', { kind: 'house', id: made.house, level: 'muted' });
    await bo.ok('notify.set', { kind: 'dm', id: dm, level: 'muted' });
    await bo.shut();
    await send(made.room, '@bo the muted house');
    await send(dm, 'the muted conversation');
    assert.equal((await pushes(1, 500)).length, 0, 'muted places send nothing');
    await bo.open();
    await bo.ok('notify.set', { kind: 'house', id: made.house, level: 'all' });
    await bo.ok('notify.set', { kind: 'dm', id: dm, level: 'all' });
    // Focused: nothing either.
    await bo.ok('me.update', { presence: 'focus' });
    await bo.shut();
    await send(dm, 'while focused');
    assert.equal((await pushes(1, 400)).length, 0, 'Focused sends nothing');
    await bo.open();
    await bo.ok('me.update', { presence: 'around' });
    const mine = (await bo.ok('msg.send', { conv: made.room, id: mid(), text: 'I made the tiles.' })).m;
    await bo.shut();
    await send(made.room, 'They look great', { replyTo: mine.id });
    [p] = await pushes(1);
    assert.equal(decrypt(p.body).body, 'They look great', 'a reply to Bo is pushed');
    // A thread Bo follows: replies in it are pushed; one Bo does not follow is not.
    ps.hub.resetLimits(); // sending limits, not push ones
    const root = await send(made.room, 'Thread about the glaze order');
    const other = await send(made.room, 'Thread nobody follows');
    await bo.open();
    await bo.ok('follow.set', { thread: `t:${root.id}`, on: true });
    await bo.shut();
    await send(`t:${other.id}`, 'just us here');
    assert.equal((await pushes(1, 400)).length, 0);
    await send(`t:${root.id}`, 'Ordered 10 kg');
    [p] = await pushes(1);
    assert.equal(decrypt(p.body).title, 'Ada Okafor in a thread in Lounge');

    // Rate limited per person: a burst sends at most five.
    ps.hub.resetLimits();
    ps.push.reset();
    for (let i = 0; i < 8; i++) await send(dm, `burst ${i}`);
    const burst = await pushes(8, 800);
    assert.equal(burst.length, 5, 'five at once, then the limit');
    ps.push.reset();

    // A subscription the push service says is gone (410) is forgotten.
    await bo.open();
    assert.equal((await ppost('/api/push/subscribe', sub('/gone/1'), bo.cookie)).status, 201);
    await bo.shut();
    await send(dm, 'one for each device');
    const both = await pushes(2);
    assert.deepEqual(both.map((x) => x.path).sort(), ['/bo', '/gone/1']);
    for (let i = 0; i < 50 && ps.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', `${push}/gone/1`); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ps.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', `${push}/gone/1`), undefined, '410 removes the subscription');
    assert.ok(ps.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', `${push}/bo`));

    // At most ten devices per person: the oldest go.
    for (let i = 0; i < 12; i++) { ps.push.reset(); assert.equal((await ppost('/api/push/subscribe', sub(`/dev/${i}`), ada.cookie)).status, 201); }
    const ends = ps.db.all('SELECT endpoint FROM push_subs WHERE user = ?', ada.id).map((r) => r.endpoint);
    assert.equal(ends.length, 10);
    assert.equal(ends.includes(`${push}/dev/0`), false);
    assert.equal(ends.includes(`${push}/dev/11`), true);
    // Unsubscribing removes only your own.
    assert.equal((await ppost('/api/push/unsubscribe', { endpoint: `${push}/bo` }, ada.cookie)).status, 200);
    assert.ok(ps.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', `${push}/bo`), 'someone else cannot drop Bo’s device');
    assert.equal((await ppost('/api/push/unsubscribe', { endpoint: `${push}/bo` }, bo.cookie)).status, 200);
    assert.equal(ps.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', `${push}/bo`), undefined);
    await send(dm, 'nobody is listening');
    assert.equal((await pushes(1, 300)).length, 0);

    // Knowing someone's push address is not enough to take it: the same device
    // (same keys) may move to another person, other keys may not.
    ps.push.reset();
    assert.equal((await ppost('/api/push/subscribe', sub('/bo2'), bo.cookie)).status, 201);
    const ua2 = C.createECDH('prime256v1'); ua2.generateKeys();
    const stolen = { endpoint: `${push}/bo2`, keys: { p256dh: ua2.getPublicKey().toString('base64url'), auth: C.randomBytes(16).toString('base64url') } };
    assert.equal((await ppost('/api/push/subscribe', stolen, ada.cookie)).status, 409);
    assert.equal(ps.db.get('SELECT user FROM push_subs WHERE endpoint = ?', `${push}/bo2`).user, bo.id);
    assert.equal((await ppost('/api/push/subscribe', stolen, bo.cookie)).status, 201, 'your own device may change its keys');
    assert.equal((await ppost('/api/push/subscribe', sub('/bo2'), bo.cookie)).status, 201);
    assert.equal((await ppost('/api/push/subscribe', sub('/bo2'), ada.cookie)).status, 201, 'the same device signing in as Ada moves to her');
    assert.equal(ps.db.get('SELECT user FROM push_subs WHERE endpoint = ?', `${push}/bo2`).user, ada.id);
    await ppost('/api/push/unsubscribe', { endpoint: `${push}/bo2` }, ada.cookie);

    // Signing out everywhere, or a new password, stops every device's notifications.
    ps.push.reset();
    ps.hub.resetLimits();
    const bo2 = await ppost('/api/login', { handle: 'bo', password: 'a long password' });
    const boCookie2 = cookieOf(bo2);
    assert.equal((await ppost('/api/push/subscribe', sub('/bo-phone'), boCookie2)).status, 201);
    assert.equal((await ppost('/api/push/subscribe', sub('/bo-laptop'), bo.cookie)).status, 201);
    await send(dm, 'to both devices');
    assert.deepEqual((await pushes(2)).map((x) => x.path).sort(), ['/bo-laptop', '/bo-phone']);
    assert.equal((await ppost('/api/logout', {}, boCookie2)).status, 200);
    assert.equal(ps.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', `${push}/bo-phone`), undefined, 'signing out forgets that device');
    assert.ok(ps.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', `${push}/bo-laptop`));
    assert.equal((await ppost('/api/logout-all', {}, bo.cookie)).status, 200);
    assert.equal(ps.db.get('SELECT 1 FROM push_subs WHERE user = ?', bo.id), undefined, 'signing out everywhere forgets every device');
    await send(dm, 'after signing out everywhere');
    assert.equal((await pushes(1, 300)).length, 0);
    const bo3 = cookieOf(await ppost('/api/login', { handle: 'bo', password: 'a long password' }));
    assert.equal((await ppost('/api/push/subscribe', sub('/bo-phone'), bo3)).status, 201);
    assert.equal((await ppost('/api/password', { current: 'a long password', next: 'another long password' }, bo3)).status, 200);
    assert.equal(ps.db.get('SELECT 1 FROM push_subs WHERE user = ?', bo.id), undefined, 'a new password forgets every device');
  } finally { await finish(); }
});
// --- end push notifications ---------------------------------------------------
