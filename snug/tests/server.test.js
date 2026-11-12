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
