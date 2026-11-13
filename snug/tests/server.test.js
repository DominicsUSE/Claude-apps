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
// Calls ring for 1.5 seconds here instead of 30 seconds (see the calls tests at the end).
const boot = async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true, ringMs: 1500 }); base = `http://127.0.0.1:${srv.port}`; };
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
    // Message previews off, or streamer mode: the lock screen says that something
    // came, never what (as the open app does).
    ps.hub.resetLimits(); ps.push.reset();
    for (const prefs of [{ preview: false }, { preview: null, streamer: true }]) {
      await bo.open();
      await bo.ok('prefs.set', { prefs });
      await bo.shut();
      await send(dm, 'the pin for the kiln shed is 4417');
      [p] = await pushes(1);
      note = decrypt(p.body);
      assert.equal(note.body, 'New message', JSON.stringify(prefs));
      assert.equal(note.title, 'Ada Okafor');
    }
    await bo.open();
    await bo.ok('prefs.set', { prefs: { streamer: null } });
    await bo.shut();

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

// --- calls in direct conversations and groups ---------------------------------
// A call lives in a conversation and uses the voice machinery: only the people
// in that conversation may start it, join it, decline it, see it or signal in
// it. Rings go to every device; this server rings for 1500ms (boot, above)
// instead of 30 seconds.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Four people in a house: Ann and Ben share a conversation, Ann, Ben and Cal a
// group. Dot is in the house but in neither.
async function callPeople(tag) {
  const a = await Client.make(`${tag}ann`, 'Ann Ash');
  const b = await Client.make(`${tag}ben`, 'Ben Birch');
  const c = await Client.make(`${tag}cal`, 'Cal Cedar');
  const d = await Client.make(`${tag}dot`, 'Dot Dale');
  const made = await a.ok('house.create', { name: `Calls ${tag}`, hue: 200 });
  const { code } = await a.ok('invite.create', { house: made.house });
  for (const p of [b, c, d]) await p.ok('invite.accept', { code });
  const { id: dm } = await a.ok('dm.open', { users: [b.id] });
  const { id: group } = await a.ok('dm.open', { users: [b.id, c.id] });
  const hangout = srv.db.get("SELECT id FROM rooms WHERE house = ? AND kind = 'voice'", made.house).id;
  return { a, b, c, d, dm, group, house: made.house, hangout };
}
// Another socket for the same person: a second device.
const device = (p) => Object.assign(new Client(), { cookie: p.cookie, id: p.id }).connect();
const record = (p, conv, pred = () => true) => p.next('msg', (e) => e.conv === conv && !!e.m.call && pred(e.m.call), 2500);

test('calls: only the people in a conversation can start, join, decline, signal in or see its call', async () => {
  const { a, b, c, d, dm, group } = await callPeople('cq');
  for (const who of [c, d]) {
    assert.match(await who.refused('call.start', { dm }), /not in that conversation/);
    assert.match(await who.refused('call.join', { dm }), /not in that conversation/);
    assert.match(await who.refused('call.decline', { dm }), /not in that conversation/);
  }
  assert.match(await d.refused('call.start', { dm: group }), /not in that conversation/);
  assert.match(await a.refused('call.start', { dm: 'd_nothere' }), /not in that conversation/);
  assert.match(await a.refused('call.start', { dm, video: 'yes' }), /Video is yes or no/);
  assert.match(await a.refused('call.join', { dm }), /call has ended/, 'nothing to join yet');

  const started = await a.ok('call.start', { dm, video: true });
  assert.deepEqual(started.peers, []);
  assert.match(started.call, /^call_/);
  const ring = await b.next('call.ring', (r) => r.dm === dm);
  assert.equal(ring.from, a.id);
  assert.equal(ring.video, true);
  assert.equal(ring.group, false);
  assert.equal(ring.quiet, false);
  assert.ok(ring.until > Date.now(), 'it says until when it rings');
  assert.ok(ring.ms > 0 && ring.ms <= 1500, `and for how much longer, for devices whose clocks differ: ${ring.ms}`);
  assert.equal(ring.users[a.id].name, 'Ann Ash');
  const seen = await b.next('voice', (v) => v.room === dm && v.call?.ringing.includes(b.id));
  assert.deepEqual(seen.users, [a.id]);
  assert.equal(seen.call.by, a.id);
  // People in the house who are not in the conversation don't find it in a
  // fresh snapshot (nor hear about it; checked below); Ben does, ringing.
  assert.equal((await d.ok('sync')).voice[dm], undefined);
  assert.equal((await c.ok('sync')).voice[dm], undefined);
  const bsnap = await b.ok('sync');
  assert.deepEqual(bsnap.voice[dm].users, [a.id]);
  assert.deepEqual(bsnap.ringing.map((r) => r.dm), [dm]);
  // Signalling only between people in the same call; state only from someone in one.
  assert.match(await a.refused('rtc', { to: b.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } }), /isn’t in your voice room/);
  assert.match(await d.refused('rtc', { to: a.id, data: { candidate: {} } }), /isn’t in your voice room/);
  assert.match(await d.refused('voice.state', { muted: true }), /not in a call/);
  assert.match(await c.refused('voice.state', { camera: true }), /not in a call/);
  // Dot can't join someone else's call, even after it is answered.
  await b.ok('call.join', { dm });
  for (const who of [c, d]) {
    await who.none('voice', (v) => v.room === dm);
    await who.none('call.ring');
    await who.none('call.ring.stop');
  }
  assert.match(await d.refused('call.join', { dm }), /not in that conversation/);
  assert.match(await d.refused('rtc', { to: b.id, data: { candidate: {} } }), /isn’t in your voice room/);
  await a.ok('rtc', { to: b.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  assert.equal((await b.next('rtc')).from, a.id);
  await b.ok('voice.state', { camera: true });
  assert.equal((await a.next('voice', (v) => v.room === dm && v.state[b.id]?.camera)).state[b.id].camera, true);
  await d.none('voice', (v) => v.room === dm);
  await a.ok('voice.leave');
  await record(b, dm);
  for (const p of [a, b, c, d]) p.ws.close();
});

test('calls: ringing reaches every device; picking up on one stops the others; a duration record', async () => {
  const { a, b, d, dm } = await callPeople('cr');
  const b2 = await device(b);
  await a.ok('call.start', { dm });
  const r1 = await b.next('call.ring', (r) => r.dm === dm);
  const r2 = await b2.next('call.ring', (r) => r.dm === dm);
  assert.equal(r1.call, r2.call);
  assert.equal(r1.video, false);
  // Picking up on the first device.
  assert.deepEqual((await b.ok('call.join', { dm })).peers, [a.id]);
  assert.equal((await b2.next('call.ring.stop', (s) => s.dm === dm)).reason, 'answered');
  assert.equal((await b.next('call.ring.stop', (s) => s.dm === dm)).reason, 'answered');
  const live = await a.next('voice', (v) => v.room === dm && v.users.length === 2 && v.call?.answered);
  assert.deepEqual(live.call.ringing, []);
  await d.none('voice', (v) => v.room === dm);
  // Ann pastes something while they talk.
  const during = await a.ok('msg.send', { conv: dm, id: mid(), text: 'the link, for later' });
  // Moving the call to the other device: the first is told, the call goes on.
  assert.deepEqual((await b2.ok('call.join', { dm })).peers, [a.id]);
  assert.equal((await b.next('voice.kicked', (k) => k.room === dm)).reason, 'elsewhere');
  await a.none('call.ended', (e) => e.dm === dm, 150);
  await b2.ok('rtc', { to: a.id, data: { candidate: {} } });
  await wait(1100);
  // Hanging up a one-to-one call ends it for both, and the record says how long it lasted.
  await b2.ok('voice.leave');
  assert.equal((await a.next('call.ended', (e) => e.dm === dm)).reason, 'ended');
  const rec = await record(a, dm);
  assert.equal(rec.m.author, a.id, 'the person who started the call');
  assert.equal(rec.m.call.outcome, 'answered');
  assert.ok(rec.m.call.dur >= 1000 && rec.m.call.dur < 10_000, `lasted ${rec.m.call.dur}ms`);
  assert.deepEqual(rec.m.call.joined.sort(), [a.id, b.id].sort());
  assert.match(rec.m.text, /^Call · \ds$/);
  await record(b2, dm, (c) => c.outcome === 'answered');
  // The record moves nobody's read marker (both took part, so it isn't news
  // to either: the client and push skip it), so what Ann sent during the call
  // is still unread for Ben.
  assert.ok((srv.db.get('SELECT ts FROM reads WHERE user = ? AND conv = ?', b.id, dm)?.ts || 0) < during.m.ts, 'the message sent during the call is still unread');
  await b.none('self', (d) => d.read?.[dm], 150);
  assert.equal((await a.ok('sync')).voice[dm], undefined, 'nothing left live');
  for (const p of [a, b, b2, d]) p.ws.close();
});

test('calls: declining a one-to-one call ends it for the caller with a declined record', async () => {
  const { a, b, dm } = await callPeople('cd');
  const urgent = await a.ok('msg.send', { conv: dm, id: mid(), text: 'urgent: read this first' });
  const { call } = await a.ok('call.start', { dm });
  await b.next('call.ring', (r) => r.dm === dm);
  await b.ok('call.decline', { dm, call: 'call_notthisone' });
  await a.none('call.ended', (e) => e.dm === dm, 150);
  await b.ok('call.decline', { dm, call });
  assert.equal((await b.next('call.ring.stop', (s) => s.dm === dm)).reason, 'declined');
  assert.equal((await a.next('call.ended', (e) => e.dm === dm)).reason, 'declined');
  const rec = await record(a, dm);
  assert.equal(rec.m.call.outcome, 'declined');
  assert.deepEqual(rec.m.call.declined, [b.id]);
  assert.equal(rec.m.text, 'Declined call');
  // Declining from the incoming screen doesn't read the conversation: Ann's
  // message from before the call is still unread for Ben.
  assert.ok((srv.db.get('SELECT ts FROM reads WHERE user = ? AND conv = ?', b.id, dm)?.ts || 0) < urgent.m.ts, 'declining marks nothing read');
  // Declining when nothing rings changes nothing.
  assert.deepEqual(await b.ok('call.decline', { dm }), {});
  for (const p of [a, b]) p.ws.close();
});

test('calls: an unanswered call times out; the missed-call record is for the person who missed it and can’t be changed', async () => {
  const { ringMsFrom, RING_MS } = await import('../server/hub.js');
  assert.equal(RING_MS, 30_000);
  assert.equal(ringMsFrom({}), 30_000);
  assert.equal(ringMsFrom({ SNUG_RING_MS: '500' }), 30_000, 'outside the test runner the variable is ignored');
  assert.equal(ringMsFrom({ SNUG_RING_MS: '500', NODE_TEST_CONTEXT: 'child-v8' }), 500);
  assert.equal(ringMsFrom({ SNUG_RING_MS: '5', NODE_TEST_CONTEXT: 'child-v8' }), 30_000, 'not absurdly short');

  const { a, b, dm } = await callPeople('ct');
  const t0 = Date.now();
  await a.ok('call.start', { dm });
  await b.next('call.ring', (r) => r.dm === dm);
  assert.equal((await b.next('call.ring.stop', (s) => s.dm === dm, 4000)).reason, 'timeout');
  assert.ok(Date.now() - t0 >= 1400, 'rang for the whole (shortened) time');
  assert.equal((await a.next('call.ended', (e) => e.dm === dm)).reason, 'no-answer');
  const rec = await record(b, dm);
  assert.equal(rec.m.call.outcome, 'missed');
  assert.equal(rec.m.text, 'Missed call');
  assert.equal(rec.m.author, a.id);
  assert.deepEqual(rec.m.call.joined, [a.id]);
  assert.ok((srv.db.get('SELECT ts FROM reads WHERE user = ? AND conv = ?', b.id, dm)?.ts || 0) < rec.m.ts, 'Ben missed it: it is unread for him');
  // In the history and in the next snapshot, as a call.
  assert.equal((await b.ok('history', { conv: dm })).msgs.at(-1).call.outcome, 'missed');
  assert.equal((await b.ok('sync')).msgs[dm].at(-1).call.outcome, 'missed');
  // Nobody can edit, delete, restore, react to, pin or thread off a call record, not even its author.
  for (const p of [a, b]) {
    assert.match(await p.refused('msg.edit', { conv: dm, id: rec.m.id, text: 'nope' }), /Call records/);
    assert.match(await p.refused('msg.delete', { conv: dm, id: rec.m.id }), /Call records/);
    assert.match(await p.refused('msg.restore', { conv: dm, id: rec.m.id }), /Call records/);
    assert.match(await p.refused('react', { conv: dm, id: rec.m.id, emoji: '👍', on: true }), /Call records/);
    assert.match(await p.refused('msg.pin', { conv: dm, id: rec.m.id }), /Call records/);
    assert.match(await p.refused('msg.send', { conv: `t:${rec.m.id}`, id: mid(), text: 'a thread?' }), /don’t have threads/);
  }
  assert.equal(srv.db.get('SELECT deleted FROM messages WHERE id = ?', rec.m.id).deleted, null);
  for (const p of [a, b]) p.ws.close();
});

test('calls: a group call rings the rest until each times out, goes on while anyone is in it, and a late member can join', async () => {
  const { a, b, c, d, group } = await callPeople('cg');
  const { call } = await a.ok('call.start', { dm: group });
  const rb = await b.next('call.ring', (r) => r.dm === group);
  assert.equal(rb.group, true);
  await c.next('call.ring', (r) => r.dm === group);
  // Ben declines: in a group that only stops his ring.
  await b.ok('call.decline', { dm: group, call });
  assert.equal((await b.next('call.ring.stop', (s) => s.dm === group)).reason, 'declined');
  await a.none('call.ended', (e) => e.dm === group, 150);
  assert.deepEqual((await a.next('voice', (v) => v.room === group && v.call?.ringing.length === 1 && !v.call.ringing.includes(b.id))).call.ringing, [c.id]);
  // Cal's ring times out; the call stays live with Ann in it.
  assert.equal((await c.next('call.ring.stop', (s) => s.dm === group, 4000)).reason, 'timeout');
  await a.none('call.ended', (e) => e.dm === group, 200);
  const after = (await c.ok('sync')).voice[group];
  assert.deepEqual(after.users, [a.id]);
  assert.deepEqual(after.call.ringing, []);
  // Cal joins late, without being rung.
  assert.deepEqual((await c.ok('call.join', { dm: group })).peers, [a.id]);
  // Ann leaves; Cal is still in it, so it goes on.
  await a.ok('voice.leave');
  await a.none('call.ended', (e) => e.dm === group, 200);
  assert.deepEqual((await b.next('voice', (v) => v.room === group && v.users.length === 1 && v.users[0] === c.id)).users, [c.id]);
  // Ben changes his mind and joins from the strip.
  assert.deepEqual((await b.ok('call.join', { dm: group })).peers, [c.id]);
  await b.ok('voice.leave');
  await c.ok('voice.leave');
  assert.equal((await a.next('call.ended', (e) => e.dm === group)).reason, 'ended');
  const rec = await record(a, group);
  assert.equal(rec.m.call.outcome, 'answered');
  assert.deepEqual(rec.m.call.joined.sort(), [a.id, b.id, c.id].sort());
  await d.none('msg', (e) => e.conv === group);
  for (const p of [a, b, c, d]) p.ws.close();
});

test('calls: one live call per person, across voice rooms and calls', async () => {
  const { a, b, d, dm, hangout } = await callPeople('co');
  await b.ok('voice.join', { room: hangout });
  await d.next('voice', (v) => v.room === hangout && v.users.includes(b.id));
  await a.ok('call.start', { dm });
  // Ben is in a voice room, and still gets the call.
  await b.next('call.ring', (r) => r.dm === dm);
  await b.ok('call.join', { dm });
  // Taking it moved him out of the room, which everyone in the house sees.
  assert.deepEqual((await d.next('voice', (v) => v.room === hangout && !v.users.includes(b.id))).users, []);
  await a.next('voice', (v) => v.room === dm && v.users.length === 2);
  // Joining the room again hangs up the call.
  await b.ok('voice.join', { room: hangout });
  assert.equal((await a.next('call.ended', (e) => e.dm === dm)).reason, 'ended');
  await record(a, dm, (c) => c.outcome === 'answered');
  // And starting a call leaves the room.
  await b.ok('call.start', { dm });
  await d.next('voice', (v) => v.room === hangout && !v.users.includes(b.id));
  await a.next('call.ring', (r) => r.dm === dm && r.from === b.id);
  await b.ok('voice.leave');
  assert.equal((await a.next('call.ring.stop', (s) => s.dm === dm)).reason, 'ended');
  assert.equal((await a.next('call.ended', (e) => e.dm === dm)).reason, 'cancelled');
  for (const p of [a, b, d]) p.ws.close();
});

test('calls: a dropped connection hangs up; the caller dropping stops the ring with a missed call', async () => {
  const { a, b, dm } = await callPeople('cx');
  await a.ok('call.start', { dm });
  await b.next('call.ring', (r) => r.dm === dm);
  await a.close();
  assert.equal((await b.next('call.ring.stop', (s) => s.dm === dm)).reason, 'ended');
  assert.equal((await b.next('call.ended', (e) => e.dm === dm)).reason, 'cancelled');
  assert.equal((await record(b, dm)).m.call.outcome, 'missed');
  await a.connect();
  // In an answered call, the other side's connection dropping ends it.
  await a.ok('call.start', { dm });
  await b.ok('call.join', { dm });
  await a.next('voice', (v) => v.room === dm && v.users.length === 2);
  await b.close();
  assert.equal((await a.next('call.ended', (e) => e.dm === dm)).reason, 'ended');
  assert.equal((await record(a, dm, (c) => c.outcome === 'answered')).m.call.outcome, 'answered');
  assert.equal(srv.hub.callOf(dm), null);
  a.ws.close();
});

test('calls: a muted conversation rings quietly; starting calls is rate limited', async () => {
  const { a, b, dm } = await callPeople('cl');
  await b.ok('notify.set', { kind: 'dm', id: dm, level: 'muted' });
  await a.ok('call.start', { dm });
  assert.equal((await b.next('call.ring', (r) => r.dm === dm)).quiet, true, 'shown, but without a ringtone');
  await a.ok('voice.leave');
  // Quiet hours ring quietly too ("no sounds, pop-ups or phone notifications").
  await b.ok('notify.set', { kind: 'dm', id: dm, level: 'all' });
  const t = new Date(); const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  await b.ok('prefs.set', { prefs: { quiet: { on: true, from: (mins + 1430) % 1440, to: (mins + 10) % 1440, tz: 0 } } });
  await a.ok('call.start', { dm });
  assert.equal((await b.next('call.ring', (r) => r.dm === dm)).quiet, true, 'quiet hours: no ringtone');
  await a.ok('voice.leave');
  await b.ok('prefs.set', { prefs: { quiet: null } });
  await a.ok('call.start', { dm });
  assert.equal((await b.next('call.ring', (r) => r.dm === dm)).quiet, false, 'outside them it rings');
  await a.ok('voice.leave');
  srv.resetLimits();
  for (let i = 0; i < 4; i++) { await a.ok('call.start', { dm }); await a.ok('voice.leave'); }
  assert.match(await a.refused('call.start', { dm }), /a little fast/);
  for (const p of [a, b]) p.ws.close();
});

test('calls: someone with Snug closed gets a "Name is calling" push that opens the conversation', async () => {
  const { createServer } = await import('node:http');
  const C = await import('node:crypto');
  const pdir = mkdtempSync(join(tmpdir(), 'snug-callpush-'));
  const ps = await startServer({ port: 0, dataDir: pdir, quiet: true, pushAllowLocal: true, ringMs: 800 });
  const pbase = `http://127.0.0.1:${ps.port}`;
  const got = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    got.push({ path: req.url, body: Buffer.concat(chunks) });
    res.writeHead(201);
    res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const socks = [];
  try {
    const ppost = (path, body, cookie) => fetch(pbase + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: pbase, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const sock = async (p) => {
      await new Promise((resolve) => {
        p.ws = new WebSocket(`ws://127.0.0.1:${ps.port}/ws`, { headers: { cookie: p.cookie, origin: pbase } });
        socks.push(p.ws);
        p.ws.on('message', (buf) => { const m = JSON.parse(buf); if (m.t === 'hello') resolve(); else if (m.t === 'ack') p.acks.get(m.id)?.(m); });
      });
      p.ok = (op, d = {}) => new Promise((resolve, reject) => {
        const id = ++p.seq;
        p.acks.set(id, (m) => (m.ok ? resolve(m.d) : reject(new Error(`${op}: ${m.error}`))));
        p.ws.send(JSON.stringify({ t: 'op', id, op, d }));
      });
      return p;
    };
    const person = async (handle, name) => {
      const res = await ppost('/api/register', { handle, name, password: 'a long password' });
      return sock({ cookie: cookieOf(res), id: (await res.json()).user.id, seq: 0, acks: new Map() });
    };
    const ann = await person('pann', 'Ann Ash');
    const ben = await person('pben', 'Ben Birch');
    const made = await ann.ok('house.create', { name: 'Push calls', hue: 10 });
    const { code } = await ann.ok('invite.create', { house: made.house });
    await ben.ok('invite.accept', { code });
    const { id: dm } = await ann.ok('dm.open', { users: [ben.id] });
    const ua = C.createECDH('prime256v1');
    ua.generateKeys();
    const auth = C.randomBytes(16);
    const sub = { endpoint: `http://127.0.0.1:${mock.address().port}/ben`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    assert.equal((await ppost('/api/push/subscribe', sub, ben.cookie)).status, 201);
    const decrypt = (body) => {
      const hmac = (k, x) => C.createHmac('sha256', k).update(x).digest();
      const salt = body.subarray(0, 16);
      const idlen = body[20];
      const asPub = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const ikm = hmac(hmac(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const dec = C.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
      dec.setAuthTag(ct.subarray(-16));
      const pt = Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]);
      let i = pt.length - 1;
      while (pt[i] === 0) i--;
      return JSON.parse(pt.subarray(0, i));
    };
    const pushes = async (n, ms = 2000) => { const end = Date.now() + ms; while (got.length < n && Date.now() < end) await wait(20); return got.splice(0); };
    // While Ben has Snug open, the ring goes to his socket, not his phone.
    await ann.ok('call.start', { dm });
    assert.equal((await pushes(1, 300)).length, 0);
    await ann.ok('voice.leave');
    // The missed call record is not pushed either: he is connected.
    assert.equal((await pushes(1, 300)).length, 0);
    // Closed: "Ann Ash is calling", tagged so it replaces itself, then the missed call.
    await new Promise((r) => { ben.ws.on('close', r); ben.ws.close(); });
    for (let i = 0; i < 50 && ps.hub.connected(ben.id); i++) await wait(20);
    ps.push.reset();
    const { call: c1 } = await ann.ok('call.start', { dm, video: true });
    const [ring] = await pushes(1);
    const note = decrypt(ring.body);
    assert.deepEqual({ title: note.title, body: note.body, conv: note.conv, tag: note.tag, call: note.call, ring: note.ring }, { title: 'Ann Ash is calling', body: 'Video call', conv: dm, tag: `snug:${dm}`, call: true, ring: c1 });
    // The ring runs out: the ringing note (which stays on screen) is replaced
    // by a quiet one, and the missed call record follows.
    const after = (await pushes(2, 3000)).map((x) => decrypt(x.body));
    assert.equal(after.length, 2);
    const over = after.find((x) => x.ringOver);
    assert.deepEqual({ title: over.title, body: over.body, tag: over.tag, ringOver: over.ringOver, call: over.call }, { title: 'Ann Ash', body: 'Missed call', tag: `snug:${dm}`, ringOver: c1, call: undefined });
    const m = after.find((x) => !x.ringOver);
    assert.equal(m.title, 'Ann Ash');
    assert.equal(m.body, 'Missed call');
    assert.equal(m.tag, `snug:${dm}`, 'the missed call replaces the ringing note');
    await ann.ok('voice.leave').catch(() => {});
    // Answered on another device: the phone's "is calling" note is replaced
    // at once, though Ben now has Snug open.
    ps.push.reset();
    const { call: c2 } = await ann.ok('call.start', { dm });
    assert.equal(decrypt((await pushes(1))[0].body).ring, c2);
    const laptop = await sock({ cookie: ben.cookie, id: ben.id, seq: 0, acks: new Map() });
    await laptop.ok('call.join', { dm });
    const answered = decrypt((await pushes(1))[0].body);
    assert.deepEqual({ body: answered.body, ringOver: answered.ringOver }, { body: 'You answered on another device', ringOver: c2 });
    await ann.ok('voice.leave');
    assert.equal((await pushes(1, 400)).length, 0, 'he took the call: no record pushed, no second ring-over');
    await new Promise((r) => { laptop.ws.on('close', r); laptop.ws.close(); });
    for (let i = 0; i < 50 && ps.hub.connected(ben.id); i++) await wait(20);
    // A group Ben set to "Only what needs me": the call still rings his
    // phone, and when Ann and Cal talk without him the record is pushed as a
    // missed call (as the badge counts it), not "Call · 1s".
    const cal = await person('pcal', 'Cal Cedar');
    await cal.ok('invite.accept', { code });
    const { id: group } = await ann.ok('dm.open', { users: [ben.id, cal.id] });
    ps.db.run("INSERT INTO notify (user, place, level) VALUES (?, ?, 'mentions')", ben.id, group);
    ps.push.reset();
    ps.hub.resetLimits();
    const { call: c3 } = await ann.ok('call.start', { dm: group });
    assert.equal(decrypt((await pushes(1))[0].body).ring, c3);
    await cal.ok('call.join', { dm: group });
    const gover = decrypt((await pushes(1, 3000))[0].body);
    assert.deepEqual({ body: gover.body, ringOver: gover.ringOver }, { body: 'Missed call', ringOver: c3 });
    await ann.ok('voice.leave');
    await cal.ok('voice.leave');
    const grec = decrypt((await pushes(1, 2000))[0].body);
    assert.equal(grec.ringOver, undefined);
    assert.match(grec.title, /^Ann Ash in /);
    assert.equal(grec.body, 'Missed call', 'missed, though the others talked');
    assert.equal(grec.tag, `snug:${group}`);
    // A plain message there, with no mention, still isn't pushed to him.
    await cal.ok('msg.send', { conv: group, id: mid(), text: 'thanks for the chat' });
    assert.equal((await pushes(1, 400)).length, 0);
    // A muted conversation rings nobody's phone.
    ps.push.reset();
    ps.db.run("INSERT INTO notify (user, place, level) VALUES (?, ?, 'muted')", ben.id, dm);
    await ann.ok('call.start', { dm });
    assert.equal((await pushes(1, 400)).length, 0);
    await ann.ok('voice.leave');
  } finally {
    for (const w of socks) w.terminate();
    mock.close();
    await ps.close();
    rmSync(pdir, { recursive: true, force: true });
  }
});
// --- end calls ----------------------------------------------------------------

// --- messaging (server/messaging.js, server/linkpreview.js) --------------------
// Polls, forwarding, edit history, scheduled messages, stickers, link previews
// and the newer search filters. Separate people, real sockets.
{
  const { createServer: mxHttp } = await import('node:http');
  const { deflateSync, crc32 } = await import('node:zlib');
  const L = await import('../server/linkpreview.js');
  let ann, bea, cy, dee, hall, room, dmAC;
  const mxWait = (ms) => new Promise((r) => setTimeout(r, ms));
  const upload = (cookie, path, data, type, name = 'file') => fetch(base + path, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': type, 'x-file-name': name }, body: data,
  });
  // A real PNG, w by h, one colour.
  const png = (w, h) => {
    const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };

  test('messaging: polls are one vote per person, hide results until you vote, and end', async () => {
    ann = await Client.make('mxann', 'Ann Marsh');
    bea = await Client.make('mxbea', 'Bea Moss');
    cy = await Client.make('mxcy', 'Cy Mead');
    dee = await Client.make('mxdee', 'Dee Mint');
    ({ house: hall, room } = await ann.ok('house.create', { name: 'Poll Hall', hue: 200 }));
    const { code } = await ann.ok('invite.create', { house: hall });
    await bea.ok('invite.accept', { code });
    await dee.ok('invite.accept', { code });
    const base0 = { conv: room, question: 'Which glaze?', hours: 24 };
    const ans = (...t) => t.map((x) => ({ text: x }));
    assert.match(await ann.refused('poll.create', { ...base0, id: mid(), answers: ans('Only one') }), /at least two/);
    assert.match(await ann.refused('poll.create', { ...base0, id: mid(), answers: ans(...'abcdefghijk'.split('')) }), /up to 10/);
    assert.match(await ann.refused('poll.create', { ...base0, id: mid(), hours: 2, answers: ans('a', 'b') }), /how long/);
    assert.match(await ann.refused('poll.create', { ...base0, id: mid(), answers: ans('Same', 'same') }), /same thing/);
    assert.match(await ann.refused('poll.create', { ...base0, id: mid(), answers: [{ text: 'a', emoji: 'not emoji' }, { text: 'b' }] }), /emoji/);
    assert.match(await cy.refused('poll.create', { ...base0, id: mid(), answers: ans('a', 'b') }), /access|member/);

    const p1 = mid();
    await ann.ok('poll.create', { ...base0, id: p1, answers: [{ text: 'Celadon', emoji: '🍵' }, { text: 'Tenmoku' }, { text: 'Shino' }] });
    const got = await bea.next('msg', (d) => d.m.id === p1);
    assert.deepEqual({ q: got.m.poll.question, n: got.m.poll.answers.length, e: got.m.poll.answers[0].emoji, c: got.m.poll.counts, t: got.m.poll.total, multi: got.m.poll.multi },
      { q: 'Which glaze?', n: 3, e: '🍵', c: [0, 0, 0], t: 0, multi: false });
    assert.deepEqual((await bea.ok('poll.vote', { conv: room, id: p1, answers: [1] })).votes, [1]);
    assert.deepEqual((await ann.next('poll', (d) => d.id === p1)).poll.counts, [0, 1, 0]);
    assert.match(await bea.refused('poll.vote', { conv: room, id: p1, answers: [0, 1] }), /one answer/);
    assert.match(await bea.refused('poll.vote', { conv: room, id: p1, answers: [7] }), /choices/);
    await bea.ok('poll.vote', { conv: room, id: p1, answers: [2] });
    // Voting twice is one vote: it moves, it doesn't add.
    await bea.ok('poll.vote', { conv: room, id: p1, answers: [2] });
    const after = (await ann.ok('poll.view', { conv: room, id: p1 })).poll;
    assert.deepEqual({ c: after.counts, t: after.total }, { c: [0, 0, 1], t: 1 });
    assert.equal(srv.db.get('SELECT COUNT(*) n FROM poll_votes WHERE msg = ?', p1).n, 1);
    assert.match(await cy.refused('poll.vote', { conv: room, id: p1, answers: [0] }), /access/);
    assert.match(await cy.refused('poll.view', { conv: room, id: p1 }), /access/);
    assert.match(await ann.refused('msg.edit', { conv: room, id: p1, text: 'Which clay?' }), /Polls can’t be edited/);

    // Hidden results: nobody's counts reach someone who hasn't voted.
    const p2 = mid();
    await ann.ok('poll.create', { ...base0, id: p2, question: 'Days?', multi: true, hidden: true, answers: ans('Mon', 'Tue', 'Wed') });
    const hid = await dee.next('msg', (d) => d.m.id === p2);
    assert.equal(hid.m.poll.counts, undefined);
    await bea.ok('poll.vote', { conv: room, id: p2, answers: [0, 2] });
    assert.deepEqual((await ann.next('poll', (d) => d.id === p2)).poll.counts, [1, 0, 1], 'the author sees results');
    const deeSees = await dee.next('poll', (d) => d.id === p2);
    assert.equal(deeSees.poll.counts, undefined, 'someone who has not voted sees no counts');
    assert.equal(deeSees.poll.total, 1);
    assert.equal((await dee.ok('poll.view', { conv: room, id: p2 })).poll.counts, undefined);
    await dee.ok('poll.vote', { conv: room, id: p2, answers: [1] });
    assert.deepEqual((await dee.ok('poll.view', { conv: room, id: p2 })).poll.counts, [1, 1, 1]);
    // Only its author ends it early; then it is closed to votes and open to everyone's eyes.
    assert.match(await bea.refused('poll.end', { conv: room, id: p2 }), /Only the person/);
    await ann.ok('poll.end', { conv: room, id: p2 });
    assert.equal((await dee.next('poll', (d) => d.id === p2 && d.poll.ended)).poll.ended, true);
    assert.match(await bea.refused('poll.vote', { conv: room, id: p2, answers: [1] }), /ended/);
    // A poll's time running out closes it, and everyone hears.
    const p3 = mid();
    await ann.ok('poll.create', { ...base0, id: p3, question: 'Quick one?', hours: 1, answers: ans('Yes', 'No') });
    srv.db.run('UPDATE polls SET ends = ? WHERE msg = ?', Date.now() - 1000, p3);
    srv.hub.messaging.tick();
    assert.equal((await bea.next('poll', (d) => d.id === p3)).poll.ended, true);
    assert.match(await bea.refused('poll.vote', { conv: room, id: p3, answers: [0] }), /ended/);
    // Someone timed out in the house (server/safety.js) can't vote.
    srv.db.run('INSERT INTO timeouts (house, user, until, by) VALUES (?, ?, ?, ?)', hall, dee.id, Date.now() + 60_000, ann.id);
    assert.match(await dee.refused('poll.vote', { conv: room, id: p1, answers: [0] }), /timed out/);
    srv.db.run('DELETE FROM timeouts WHERE house = ? AND user = ?', hall, dee.id);
    // Your votes come back with every snapshot.
    await bea.close(); await bea.connect();
    assert.deepEqual(bea.hello.pollVotes[p1], [2]);
  });

  test('messaging: forwarding keeps who wrote it, copies files, and respects both places', async () => {
    await cy.ok('friend.request', { handle: 'mxann' });
    await ann.ok('friend.accept', { user: cy.id });
    ({ id: dmAC } = await ann.ok('dm.open', { users: [cy.id] }));
    const up = await upload(ann.cookie, `/api/files?conv=${room}`, Buffer.from('kiln log, cone 6'), 'text/plain', 'log.txt');
    assert.equal(up.status, 201);
    const file = await up.json();
    const src = mid();
    await ann.ok('msg.send', { conv: room, id: src, text: 'Firing log attached', files: [{ id: file.id }] });
    const fid = mid();
    const r = await ann.ok('msg.forward', { conv: room, id: src, to: dmAC, comment: 'for you', newId: fid });
    assert.equal(r.m.fwd.author, ann.id);
    const seen = await cy.next('msg', (d) => d.m.id === fid);
    assert.deepEqual({ text: seen.m.text, ftext: seen.m.fwd.text, author: seen.m.fwd.author }, { text: 'for you', ftext: 'Firing log attached', author: ann.id });
    const copy = seen.m.files[0].id;
    assert.notEqual(copy, file.id, 'files are copied into the new place');
    assert.equal((await fetch(`${base}/api/files/${copy}`, { headers: { cookie: cy.cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/files/${file.id}`, { headers: { cookie: cy.cookie } })).status, 404, 'the original stays private');
    // The way back works only for people who can read the original.
    assert.match(await cy.refused('history', { conv: seen.m.fwd.conv, fromId: seen.m.fwd.id }), /access/);
    // Cy can't forward from a room they can't read; Bea can't forward into a conversation she isn't in.
    assert.match(await cy.refused('msg.forward', { conv: room, id: src, to: dmAC, newId: mid() }), /access/);
    assert.match(await bea.refused('msg.forward', { conv: room, id: src, to: dmAC, newId: mid() }), /access/);
    // A forward of a forward still names the first author; with no note it's still a message.
    const f2 = mid();
    const again = await cy.ok('msg.forward', { conv: dmAC, id: fid, to: dmAC, newId: f2 });
    assert.deepEqual({ a: again.m.fwd.author, t: again.m.text, ft: again.m.fwd.text }, { a: ann.id, t: '', ft: 'Firing log attached' });
    // Retrying the same forward doesn't make a second copy.
    await cy.ok('msg.forward', { conv: dmAC, id: fid, to: dmAC, newId: f2 });
    assert.equal(srv.db.get('SELECT COUNT(*) n FROM messages WHERE id = ?', f2).n, 1);
  });

  test('messaging: edit history keeps the last ten versions, for readers only', async () => {
    const id1 = mid();
    await ann.ok('msg.send', { conv: room, id: id1, text: 'v1' });
    await ann.ok('msg.edit', { conv: room, id: id1, text: 'v2' });
    await ann.ok('msg.edit', { conv: room, id: id1, text: 'v3' });
    const h = await bea.ok('msg.edits', { conv: room, id: id1 });
    assert.equal(h.current.text, 'v3');
    assert.deepEqual(h.edits.map((e) => e.text), ['v2', 'v1']);
    assert.match(await cy.refused('msg.edits', { conv: room, id: id1 }), /access/);
    for (let i = 4; i <= 14; i++) await ann.ok('msg.edit', { conv: room, id: id1, text: `v${i}` });
    const all = await bea.ok('msg.edits', { conv: room, id: id1 });
    assert.equal(all.edits.length, 10);
    assert.deepEqual([all.edits[0].text, all.edits[9].text], ['v13', 'v4']);
  });

  test('messaging: scheduled messages wait, can be cancelled, send on time and are checked again', async () => {
    const soon = Date.now() + 5 * 60_000;
    assert.match(await ann.refused('sched.create', { conv: room, text: 'x', at: Date.now() + 1000 }), /minute/);
    assert.match(await ann.refused('sched.create', { conv: room, text: 'x', at: Date.now() + 31 * 86_400_000 }), /30 days/);
    assert.match(await cy.refused('sched.create', { conv: room, text: 'x', at: soon }), /access/);
    const { id: s1 } = await ann.ok('sched.create', { conv: room, text: 'Kiln opens at 9', at: soon });
    assert.equal((await ann.next('sched')).list.length, 1);
    await ann.close(); await ann.connect();
    assert.deepEqual(ann.hello.scheduled.map((s) => s.id), [s1]);
    assert.equal((await ann.ok('sched.cancel', { id: s1 })).text, 'Kiln opens at 9');
    assert.equal((await ann.next('sched')).list.length, 0);
    assert.equal((await bea.ok('sched.cancel', { id: s1 })).gone, true, 'someone else’s id does nothing');
    // Due: the server sends it, as Ann.
    const { id: s2 } = await ann.ok('sched.create', { conv: room, text: 'Glaze day tomorrow', at: soon });
    srv.db.run('UPDATE scheduled SET at = ? WHERE id = ?', Date.now() - 1, s2);
    srv.hub.messaging.tick();
    const sent = await bea.next('msg', (d) => d.m.text === 'Glaze day tomorrow');
    assert.equal(sent.m.author, ann.id);
    assert.equal(srv.db.get('SELECT COUNT(*) n FROM scheduled WHERE id = ?', s2).n, 0);
    // Someone removed from the house before it is due: refused at send time, and told.
    const { id: s3 } = await bea.ok('sched.create', { conv: room, text: 'still here?', at: soon });
    await ann.ok('member.remove', { house: hall, user: bea.id });
    srv.db.run('UPDATE scheduled SET at = ? WHERE id = ?', Date.now() - 1, s3);
    srv.hub.messaging.tick();
    assert.equal((await bea.next('sched.failed')).id, s3);
    assert.equal(srv.db.get("SELECT COUNT(*) n FROM messages WHERE text = 'still here?'").n, 0);
    const { code } = await ann.ok('invite.create', { house: hall });
    await bea.ok('invite.accept', { code });
  });

  test('messaging: stickers are checked from the file, managed by role, and sent only by members', async () => {
    const path = `/api/files?sticker=${hall}`;
    assert.equal((await upload(bea.cookie, path, png(64, 64), 'image/png')).status, 403, 'no Manage emoji permission');
    assert.equal((await upload(ann.cookie, path, png(400, 400), 'image/png')).status, 422);
    assert.equal((await upload(ann.cookie, path, Buffer.from('GIF89a\x10\x00\x10\x00\x80\x00\x00xxxxxxxxxx'), 'image/gif')).status, 415);
    assert.equal((await upload(ann.cookie, path, Buffer.alloc(600 * 1024, 1), 'image/png')).status, 413);
    const up = await upload(ann.cookie, path, png(64, 64), 'image/png', 'pot.png');
    assert.equal(up.status, 201);
    const f = await up.json();
    assert.match(await ann.refused('sticker.add', { house: hall, file: f.id, name: 'x' }), /2 to 30/);
    const { sticker } = await ann.ok('sticker.add', { house: hall, file: f.id, name: 'Happy pot' });
    assert.equal((await bea.next('stickers', (d) => d.house === hall && d.list.length)).list[0].name, 'Happy pot');
    assert.match(await ann.refused('sticker.add', { house: hall, file: f.id, name: 'Again' }), /already a sticker/);
    // The picker's image: members only.
    assert.equal((await fetch(`${base}/api/stickers/${f.id}`, { headers: { cookie: bea.cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/stickers/${f.id}`, { headers: { cookie: cy.cookie } })).status, 404);
    const sm = mid();
    await bea.ok('sticker.send', { conv: room, id: sm, sticker: sticker.id });
    const got = await ann.next('msg', (d) => d.m.id === sm);
    assert.equal(got.m.sticker.name, 'Happy pot');
    assert.equal((await fetch(`${base}/api/files/${got.m.files[0].id}`, { headers: { cookie: ann.cookie } })).status, 200);
    // Cy isn't in Poll Hall: Ann may send its sticker to Cy, Cy may not use it.
    assert.match(await cy.refused('sticker.send', { conv: dmAC, id: mid(), sticker: sticker.id }), /houses you’re in/);
    const sm2 = mid();
    await ann.ok('sticker.send', { conv: dmAC, id: sm2, sticker: sticker.id });
    const cs = await cy.next('msg', (d) => d.m.id === sm2);
    assert.equal((await fetch(`${base}/api/files/${cs.m.files[0].id}`, { headers: { cookie: cy.cookie } })).status, 200);
    assert.match(await bea.refused('sticker.remove', { id: sticker.id }), /can’t manage stickers/);
    await ann.ok('sticker.remove', { id: sticker.id });
    assert.equal((await bea.next('stickers', (d) => d.house === hall && !d.list.length)).list.length, 0);
  });

  test('messaging: link previews refuse private addresses and fetch public pages safely', async () => {
    // The address checks themselves.
    for (const a of ['127.0.0.1', '10.0.0.8', '172.16.4.4', '192.168.0.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1']) {
      assert.equal(L.addressBlocked(a), true, a);
    }
    for (const a of ['93.184.216.34', '2606:4700:4700::1111']) assert.equal(L.addressBlocked(a), false, a);
    assert.equal(L.checkUrl('file:///etc/passwd'), null);
    assert.equal(L.checkUrl('http://user:pw@example.com/'), null);
    assert.equal(L.checkUrl('http://example.com:22/'), null);
    assert.equal(await L.resolvePublic('localhost'), null);
    assert.equal(await L.resolvePublic('2130706433'), null, 'an IP written as a number');
    await assert.rejects(L.safeFetch('http://169.254.169.254/latest/meta-data/'), /refused/);

    // A stand-in site on this machine. It counts every request it gets.
    let hits = 0;
    const big = Buffer.alloc(11 * 1024 * 1024, 7);
    const site = mxHttp((req, res) => {
      hits++;
      const host = `http://127.0.0.1:${site.address().port}`;
      if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<html><head><title>Fallback</title><meta property="og:title" content="Kiln Weekly &amp; more"><meta property="og:description" content="Cone 6 news"><meta property="og:site_name" content="Kiln"><meta property="og:image" content="${host}/pic.png"></head><body>hi</body></html>`); return; }
      if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png(40, 20)); return; }
      if (req.url === '/meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
      if (req.url === '/inside') { res.writeHead(301, { location: 'http://10.0.0.1/' }); res.end(); return; }
      if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(big); return; }
      if (req.url === '/fake.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<script>alert(1)</script>'); return; }
      if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/html' }); const t = setInterval(() => res.write(' '), 100); res.on('close', () => clearInterval(t)); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const at = (p) => `http://127.0.0.1:${site.address().port}${p}`;
    const M = srv.hub.messaging;
    try {
      // By default nothing on this machine is ever fetched.
      const m0 = mid();
      await ann.ok('msg.send', { conv: room, id: m0, text: `look ${at('/page')} and http://localhost:8080/ and http://[::1]:8443/` });
      await mxWait(150); await M.idle();
      assert.equal(hits, 0, 'no request reached the local site');
      assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', m0).embeds, null);

      M.set({ allowLoopback: true }); // tests only: the stand-in may be fetched, nothing else private
      const m1 = mid();
      await ann.ok('msg.send', { conv: room, id: m1, text: `look ${at('/page')}` });
      const ev = await bea.next('msg', (d) => d.m.id === m1 && d.m.embeds, 5000);
      const e = ev.m.embeds[0];
      assert.deepEqual({ k: e.kind, t: e.title, d: e.description, s: e.site, h: e.host }, { k: 'link', t: 'Kiln Weekly & more', d: 'Cone 6 news', s: 'Kiln', h: '127.0.0.1' });
      const img = await fetch(`${base}/api/files/${e.image.id}`, { headers: { cookie: bea.cookie } });
      assert.deepEqual([img.status, img.headers.get('content-type')], [200, 'image/png'], 'the picture is a Snug file');
      assert.deepEqual([e.image.w, e.image.h], [40, 20]);
      assert.equal((await fetch(`${base}/api/files/${e.image.id}`, { headers: { cookie: cy.cookie } })).status, 404);
      // Cached: the same link again costs the site nothing.
      const before = hits;
      const m2 = mid();
      await ann.ok('msg.send', { conv: room, id: m2, text: `again ${at('/page')}` });
      await bea.next('msg', (d) => d.m.id === m2 && d.m.embeds, 5000);
      assert.equal(hits, before);
      // A picture linked directly shows as itself.
      const m3 = mid();
      await ann.ok('msg.send', { conv: room, id: m3, text: at('/pic.png') });
      assert.equal((await bea.next('msg', (d) => d.m.id === m3 && d.m.embeds, 5000)).m.embeds[0].kind, 'image');
      // Redirects into private space, oversize files, a page pretending to be a picture, <links>: nothing.
      const m4 = mid();
      await ann.ok('msg.send', { conv: room, id: m4, text: `${at('/meta')} ${at('/inside')} ${at('/big.png')} <${at('/page')}>` });
      await mxWait(100); await M.idle();
      assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', m4).embeds, null);
      const m5 = mid();
      await ann.ok('msg.send', { conv: room, id: m5, text: at('/fake.png') });
      await mxWait(100); await M.idle();
      assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', m5).embeds, null);
      // A site that drips forever is cut off at the time limit.
      const t0 = Date.now();
      await assert.rejects(L.safeFetch(at('/slow'), { allowLoopback: true, timeoutMs: 400 }));
      assert.ok(Date.now() - t0 < 1500, 'stopped at the deadline');
      // Only its author (or a moderator) removes a message's previews.
      assert.match(await bea.refused('msg.embeds', { conv: room, id: m1, on: false }), /Only the person/);
      await ann.ok('msg.embeds', { conv: room, id: m1, on: false });
      const gone = await bea.next('msg', (d) => d.m.id === m1 && d.m.noEmbeds);
      assert.equal(gone.m.embeds, undefined);
      // Turned off on the server: no previews at all.
      M.set({ previews: false });
      const m6 = mid();
      await ann.ok('msg.send', { conv: room, id: m6, text: at('/pic.png') });
      await mxWait(100); await M.idle();
      assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', m6).embeds, null);
    } finally {
      M.set({ allowLoopback: false, previews: true });
      site.close();
    }
  });

  test('messaging: search by mentions, dates, pins and polls', async () => {
    const id1 = mid();
    await ann.ok('msg.send', { conv: room, id: id1, text: 'ask @mxbea about the kiln' });
    await ann.ok('msg.pin', { conv: room, id: id1 });
    const ids = async (q, tz = 0) => (await bea.ok('search', { q, tz })).hits.map((h) => h.m.id);
    assert.ok((await ids('mentions:mxbea')).includes(id1));
    assert.ok(!(await ids('mentions:mxdee')).includes(id1));
    assert.ok((await ids('pinned:true')).includes(id1));
    assert.ok((await ids('has:poll')).length >= 3);
    assert.ok((await ids('has:poll')).every((m) => srv.db.get('SELECT 1 FROM polls WHERE msg = ?', m)));
    const today = new Date();
    const day = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    assert.ok((await ids(`kiln during:${day}`)).includes(id1));
    assert.equal((await ids('kiln before:2001')).length, 0);
    assert.ok((await ids('kiln after:2001')).includes(id1));
    assert.equal((await cy.ok('search', { q: 'mentions:mxbea' })).hits.length, 0, 'not a member: nothing');
  });
}
// --- end messaging ---------------------------------------------------------------

// --- safety, privacy and moderation (server/safety.js) -----------------------
// A house for these tests: an owner, a moderator role directly under the owner
// (the house's Member role, given moderation permissions) and a plain role
// under that (Newcomer, which new members get).
async function safeHouse(prefix) {
  const ow = await Client.make(`${prefix}-ow`, `Owen ${prefix}`);
  const md = await Client.make(`${prefix}-md`, `Mona ${prefix}`);
  const mm = await Client.make(`${prefix}-mm`, `Milo ${prefix}`);
  const m2 = await Client.make(`${prefix}-m2`, `Mara ${prefix}`);
  const made = await ow.ok('house.create', { name: `Safe ${prefix}`, hue: 35 });
  const h = await ow.next('house', (d) => d.house.id === made.house);
  const [ownerRole, modRole] = h.house.roles.map((r) => r.id);
  await ow.ok('role.update', { house: made.house, role: modRole, name: 'Mod', perms: ['post', 'invite', 'moderate', 'kick', 'ban', 'timeout', 'voicemod', 'audit'] });
  const { id: plainRole } = await ow.ok('role.create', { house: made.house });
  await ow.ok('role.update', { house: made.house, role: plainRole, name: 'Newcomer', perms: ['post'] });
  await ow.ok('house.update', { house: made.house, joinRole: plainRole });
  for (const c of [md, mm, m2]) {
    const { code } = await ow.ok('invite.create', { house: made.house });
    await c.ok('invite.accept', { code });
  }
  await ow.ok('member.role', { house: made.house, user: md.id, role: modRole });
  await ow.ok('member.role', { house: made.house, user: m2.id, role: modRole });
  const rooms = Object.values(h.rooms);
  return {
    ow, md, mm, m2, house: made.house, lounge: made.room, ownerRole, modRole, plainRole,
    voice: rooms.find((r) => r.kind === 'voice').id, intro: rooms.find((r) => r.name === 'Introductions').id, groups: h.house.groups.map((g) => g.id),
  };
}

test('safety: blocking ends a friendship and keeps someone out of your messages, calls, requests and pings', async () => {
  const al = await Client.make('sf-al', 'Alma Lind');
  const bz = await Client.make('sf-bz', 'Bruno Zed');
  const cq = await Client.make('sf-cq', 'Cleo Quist');
  const made = await al.ok('house.create', { name: 'Blockhouse', hue: 35 });
  for (const c of [bz, cq]) { const { code } = await al.ok('invite.create', { house: made.house }); await c.ok('invite.accept', { code }); }
  const { id: dm } = await bz.ok('dm.open', { users: [al.id] });
  await bz.ok('msg.send', { conv: dm, id: mid(), text: 'before' });
  await bz.ok('friend.request', { user: al.id });
  const { id: group } = await cq.ok('dm.open', { users: [al.id, bz.id] });

  await al.ok('block.set', { user: bz.id, on: true });
  const st = await al.next('safety', (d) => d.blocks.includes(bz.id));
  assert.deepEqual(st.blocks, [bz.id]);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM friends WHERE (user = ? AND other = ?) OR (user = ? AND other = ?)', al.id, bz.id, bz.id, al.id).n, 0, 'the pending request is gone');
  assert.equal((await bz.next('friend', (d) => d.id === al.id && d.friend === null)).friend, null);

  // No messages, reactions, calls, new conversations or friend requests, either way.
  assert.match(await bz.refused('msg.send', { conv: dm, id: mid(), text: 'hi' }), /couldn’t be delivered/);
  await al.refused('msg.send', { conv: dm, id: mid(), text: 'hi' });
  const before = srv.db.get('SELECT id FROM messages WHERE conv = ? ORDER BY seq LIMIT 1', dm).id;
  await al.refused('react', { conv: dm, id: before, emoji: '👍', on: true });
  assert.match(await bz.refused('call.start', { dm }), /can’t call/);
  assert.match(await bz.refused('dm.open', { users: [al.id] }), /can’t message/);
  await bz.refused('dm.open', { users: [al.id, cq.id] });
  assert.match(await bz.refused('friend.request', { user: al.id }), /can’t send/);
  await bz.refused('friend.request', { handle: 'sf-al' });
  await al.refused('friend.request', { user: bz.id });

  // In a shared house their messages still arrive, but never ping or push.
  assert.equal(srv.M.quietFor(al.id, bz.id, made.room), true);
  assert.equal(srv.M.quietFor(cq.id, bz.id, made.room), false);
  await bz.ok('msg.send', { conv: made.room, id: mid(), text: 'hey @sf-al' });

  // A group call they start rings everyone but the person who blocked them.
  await bz.ok('call.start', { dm: group });
  await cq.next('call.ring', (d) => d.dm === group);
  await al.none('call.ring', (d) => d.dm === group);
  await bz.ok('voice.leave');

  // The block list comes back on every connect.
  await al.close(); await al.connect();
  assert.deepEqual(al.hello.safety.blocks, [bz.id]);
  assert.ok(al.hello.users[bz.id], 'the blocked person is known by name, for the block list');

  await al.refused('block.set', { user: al.id, on: true });
  await al.refused('block.set', { user: 'u_nobody', on: true });
  await al.refused('block.set', { user: bz.id, on: 'yes' });
  await al.ok('block.set', { user: bz.id, on: false });
  await al.next('safety', (d) => !d.blocks.length);
  await bz.ok('msg.send', { conv: dm, id: mid(), text: 'hello again' });
  for (const c of [al, bz, cq]) await c.close();
});

test('safety: privacy decides who may message and befriend you; strangers land in message requests', async () => {
  const pa = await Client.make('sf-pa', 'Pia Alto');
  const pb = await Client.make('sf-pb', 'Per Berg');
  const pc = await Client.make('sf-pc', 'Pim Cole');
  // By default only friends and housemates can start a conversation.
  assert.match(await pb.refused('dm.open', { users: [pa.id] }), /friends and people you share a house with/);
  await pa.ok('privacy.set', { dm: 'everyone' });
  const { id: dm } = await pb.ok('dm.open', { users: [pa.id] });
  const st = await pa.next('safety', (d) => d.requests.some((r) => r.dm === dm));
  assert.equal(st.requests[0].by, pb.id);
  await pa.next('dm', (d) => d.dm.id === dm);
  assert.equal(srv.M.quietFor(pa.id, pb.id, dm), true, 'a waiting request never notifies');
  await pb.ok('msg.send', { conv: dm, id: mid(), text: 'hello, stranger' });
  assert.match(await pb.refused('call.start', { dm }), /hasn’t accepted/);
  assert.match(await pa.refused('call.start', { dm }), /Accept the message request/);
  await pa.ok('dm.request.accept', { dm });
  assert.equal(srv.M.quietFor(pa.id, pb.id, dm), false);
  assert.deepEqual((await pa.next('safety', (d) => !d.requests.length)).requests, []);

  // Declining leaves the conversation, and the same person can't ask again for a day.
  const { id: dm2 } = await pc.ok('dm.open', { users: [pa.id] });
  await pa.ok('dm.request.decline', { dm: dm2 });
  assert.equal(srv.M.inDm(dm2, pa.id), false);
  assert.ok((await pa.next('safety', (d) => d.left?.includes(dm2))));
  assert.match(await pc.refused('dm.open', { users: [pa.id] }), /declined/);
  await pa.refused('dm.request.decline', { dm: 'bad id!' });

  // Friends only: housemates can't start one either.
  const pd = await Client.make('sf-pd', 'Pol Dorn');
  const made = await pa.ok('house.create', { name: 'Private Place', hue: 200 });
  const { code } = await pa.ok('invite.create', { house: made.house });
  await pd.ok('invite.accept', { code });
  await pa.ok('privacy.set', { dm: 'friends' });
  assert.match(await pd.refused('dm.open', { users: [pa.id] }), /only takes messages from friends/);
  // People in my houses, with message requests for everyone who isn't a friend.
  await pa.ok('privacy.set', { dm: 'houses', requests: true });
  const { id: dm3 } = await pd.ok('dm.open', { users: [pa.id] });
  assert.ok(srv.M.quietFor(pa.id, pd.id, dm3));
  await pa.ok('msg.send', { conv: dm3, id: mid(), text: 'replying accepts it' });
  assert.equal(srv.M.quietFor(pa.id, pd.id, dm3), false);

  // Friend requests: nobody, then friends of friends.
  await pb.ok('friend.request', { user: pa.id });
  await pa.ok('friend.accept', { user: pb.id });
  await pa.ok('privacy.set', { friends: 'nobody' });
  assert.match(await pc.refused('friend.request', { user: pa.id }), /isn’t taking friend requests/);
  await pa.ok('privacy.set', { friends: 'fof' });
  assert.match(await pc.refused('friend.request', { user: pa.id }), /friends of friends/);
  await pc.ok('friend.request', { user: pb.id });
  await pb.ok('friend.accept', { user: pc.id });
  assert.equal((await pc.ok('friend.request', { user: pa.id })).state, 'outgoing');

  assert.match(await pa.refused('privacy.set', { dm: 'anyone' }), /choices/);
  await pa.refused('privacy.set', { friends: 'all' });
  await pa.refused('privacy.set', { requests: 'yes' });
  await pa.close(); await pa.connect();
  assert.deepEqual(pa.hello.safety.privacy, { dm: 'houses', friends: 'fof', requests: true });
  for (const c of [pa, pb, pc, pd]) await c.close();
});

test('safety: kick, ban and timeout need their permission and a role above the person', async () => {
  const s = await safeHouse('sh');
  const { ow, md, mm, m2, house, lounge } = s;
  // No permission, or not above them.
  assert.match(await mm.refused('mod.kick', { house, user: m2.id }), /Your role can’t remove people/);
  assert.match(await md.refused('mod.kick', { house, user: ow.id }), /owner/);
  assert.match(await md.refused('mod.ban', { house, user: m2.id }), /same as yours or above/);
  assert.match(await md.refused('mod.timeout', { house, user: md.id, ms: 60_000 }), /yourself/);
  await md.refused('mod.timeout', { house, user: mm.id, ms: 1234 });
  await md.refused('mod.kick', { house, user: mm.id, reason: 'x'.repeat(301) });

  // Timeout: no writing, reacting, voice or threads until it ends.
  await mm.ok('msg.send', { conv: lounge, id: mid(), text: 'before the timeout' });
  const mine = srv.db.get('SELECT id FROM messages WHERE conv = ? AND author = ? ORDER BY seq DESC', lounge, mm.id).id;
  await md.ok('mod.timeout', { house, user: mm.id, ms: 60_000, reason: 'cool off' });
  const note = await mm.next('mod.notice', (d) => d.action === 'timeout');
  assert.equal(note.reason, 'cool off');
  const hv = await mm.next('house', (d) => d.house.id === house && d.house.timedOut);
  assert.ok(hv.house.timedOut > Date.now() + 50_000);
  assert.equal(hv.house.timeouts, undefined, 'only people who can time others out see the list');
  assert.ok((await md.next('house', (d) => d.house.id === house && d.house.timeouts?.[mm.id])));
  assert.match(await mm.refused('msg.send', { conv: lounge, id: mid(), text: 'still here' }), /timed out/);
  assert.match(await mm.refused('msg.send', { conv: `t:${mine}`, id: mid(), text: 'a thread' }), /timed out/);
  assert.match(await mm.refused('react', { conv: lounge, id: mine, emoji: '👍', on: true }), /timed out/);
  assert.match(await mm.refused('voice.join', { room: s.voice }), /timed out/);
  assert.deepEqual(await mm.ok('typing', { conv: lounge }), {});
  await md.ok('mod.timeout', { house, user: mm.id, ms: 0 });
  await mm.ok('msg.send', { conv: lounge, id: mid(), text: 'back' });

  // Ban with the last day of messages: they leave, their messages go, they can't come back.
  await md.ok('mod.ban', { house, user: mm.id, reason: 'spam', deleteMs: 86_400_000 });
  assert.equal((await mm.next('mod.notice', (d) => d.action === 'ban')).reason, 'spam');
  await mm.next('house.gone', (d) => d.id === house);
  await ow.next('msg.del', (d) => d.id === mine);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM messages WHERE author = ? AND conv = ? AND deleted IS NULL', mm.id, lounge).n, 0);
  const { code } = await ow.ok('invite.create', { house });
  assert.match(await mm.refused('invite.accept', { code }), /can’t join/);
  await ow.ok('house.update', { house, public: true });
  assert.match(await mm.refused('house.joinPublic', { house }), /can’t join/);
  assert.match(await ow.refused('invite.user', { house, handle: 'sh-mm' }), /banned/);
  const bans = await md.ok('mod.bans', { house });
  assert.equal(bans.bans[0].user, mm.id);
  assert.equal(bans.bans[0].reason, 'spam');
  await mm.refused('mod.bans', { house });
  await md.ok('mod.unban', { house, user: mm.id });
  await mm.ok('invite.accept', { code });

  // Kick: the owner can remove a moderator.
  await ow.ok('mod.kick', { house, user: m2.id, reason: 'bye' });
  await m2.next('house.gone', (d) => d.id === house);
  assert.equal(srv.M.isMember(house, m2.id), false);

  // The house log has it all, newest first, and filters by kind and by who.
  const log = await ow.ok('audit.list', { house });
  const kinds = log.entries.map((e) => e.action);
  for (const k of ['member.timeout', 'member.untimeout', 'member.ban', 'member.unban', 'member.kick', 'member.role', 'role.update', 'invite.create']) assert.ok(kinds.includes(k), k);
  assert.equal(log.entries.find((e) => e.action === 'member.ban').detail.reason, 'spam');
  assert.ok(log.entries.find((e) => e.action === 'member.ban').detail.deleted >= 2);
  const onlyBans = await md.ok('audit.list', { house, action: 'member.ban' });
  assert.deepEqual([...new Set(onlyBans.entries.map((e) => e.action))], ['member.ban']);
  const byOwner = await md.ok('audit.list', { house, actor: ow.id });
  assert.ok(byOwner.entries.every((e) => e.actor === ow.id));
  assert.ok(log.users[md.id]);
  assert.match(await mm.refused('audit.list', { house }), /house log/);
  for (const c of [ow, md, mm, m2]) await c.close();
});

test('safety: moderators mute, deafen, move and disconnect people in voice; mutes hold until lifted', async () => {
  const s = await safeHouse('sv');
  const { ow, md, mm, house } = s;
  const { id: stage } = await ow.ok('room.create', { house, group: s.groups[1], name: 'Stage', kind: 'voice' });
  await mm.ok('voice.join', { room: s.voice });
  await md.ok('mod.voice', { house, user: mm.id, mute: true });
  const v = await mm.next('voice', (d) => d.room === s.voice && d.state[mm.id]?.smute);
  assert.equal(v.state[mm.id].muted, true);
  assert.match(await mm.refused('voice.state', { muted: false }), /muted you/);
  // Leaving and coming back keeps the mute.
  await mm.ok('voice.leave');
  await mm.ok('voice.join', { room: s.voice });
  await mm.next('voice', (d) => d.room === s.voice && d.state[mm.id]?.smute);
  await md.ok('mod.voice', { house, user: mm.id, mute: false, deaf: true });
  await mm.next('voice', (d) => d.room === s.voice && d.state[mm.id]?.sdeaf && d.state[mm.id]?.deaf);
  await mm.refused('voice.state', { deaf: false });
  await md.ok('mod.voice', { house, user: mm.id, deaf: false });
  await mm.ok('voice.state', { muted: false, deaf: false });
  assert.match(await mm.refused('mod.voice', { house, user: md.id, mute: true }), /Your role can’t/);
  await md.refused('mod.voice', { house, user: ow.id, mute: true });
  // Move: they leave this room and are told where to go.
  await md.ok('mod.move', { user: mm.id, room: stage });
  assert.equal((await mm.next('voice.moved')).to, stage);
  assert.equal(srv.hub.voicePlaceOf(mm.id), null);
  await md.refused('mod.move', { user: mm.id, room: stage });
  await mm.ok('voice.join', { room: stage });
  await md.refused('mod.move', { user: mm.id, room: s.lounge });
  // Disconnect.
  await md.ok('mod.disconnect', { user: mm.id });
  assert.equal((await mm.next('voice.kicked')).reason, 'moderator');
  assert.equal(srv.hub.voicePlaceOf(mm.id), null);
  const log = await ow.ok('audit.list', { house, action: 'voice' });
  assert.deepEqual(log.entries.map((e) => e.action).reverse(), ['voice.mute', 'voice.unmute', 'voice.deafen', 'voice.undeafen', 'voice.move', 'voice.disconnect']);
  for (const c of [ow, md, mm, s.m2]) await c.close();
});

test('safety: slowmode, the word and link filter, and exempt roles', async () => {
  const s = await safeHouse('sw');
  const { ow, md, mm, house, lounge } = s;
  assert.match(await mm.refused('room.slowmode', { room: lounge, seconds: 5 }), /Your role can’t/);
  await ow.refused('room.slowmode', { room: lounge, seconds: 7 });
  await ow.ok('room.slowmode', { room: lounge, seconds: 5 });
  assert.equal((await mm.next('house', (d) => d.rooms[lounge]?.slowmode === 5)).rooms[lounge].slowmode, 5);
  await mm.ok('msg.send', { conv: lounge, id: mid(), text: 'one' });
  assert.match(await mm.refused('msg.send', { conv: lounge, id: mid(), text: 'two' }), /Slowmode is on in Lounge. You can send again in [1-5]s/);
  await md.ok('msg.send', { conv: lounge, id: mid(), text: 'mods skip slowmode' });
  await md.ok('msg.send', { conv: lounge, id: mid(), text: 'twice' });
  await ow.ok('room.slowmode', { room: lounge, seconds: 0 });

  assert.match(await md.refused('automod.set', { house, words: ['x'] }), /Your role can’t/);
  await ow.refused('automod.set', { house, words: ['<script>'] });
  await ow.refused('automod.set', { house, action: 'explode' });
  const cfg = await ow.ok('automod.set', { house, words: ['Badword', 'scam*'], links: true, action: 'block' });
  assert.deepEqual(cfg.words, ['badword', 'scam*']);
  const intro = s.intro;
  assert.match(await mm.refused('msg.send', { conv: intro, id: mid(), text: 'what a BÁDWORD' }), /word this house doesn’t allow/);
  await mm.refused('msg.send', { conv: intro, id: mid(), text: 'such scammers' });
  await mm.ok('msg.send', { conv: intro, id: mid(), text: 'badwords are fine as a different word' });
  assert.match(await mm.refused('msg.send', { conv: intro, id: mid(), text: 'see https://example.com/x' }), /Links aren’t allowed/);
  const ok = mid();
  await mm.ok('msg.send', { conv: intro, id: ok, text: 'clean' });
  await mm.refused('msg.edit', { conv: intro, id: ok, text: 'now a badword' });
  await md.refused('msg.send', { conv: intro, id: mid(), text: 'mods are filtered too' + ' badword' });
  await ow.ok('msg.send', { conv: intro, id: mid(), text: 'owners are not: badword' });
  // Exempt roles skip it.
  await ow.ok('automod.set', { house, exempt: [s.modRole] });
  await md.ok('msg.send', { conv: intro, id: mid(), text: 'exempt badword' });
  // Flag: it goes through and lands in the moderators' queue.
  await ow.ok('automod.set', { house, action: 'flag', exempt: [] });
  await mm.ok('msg.send', { conv: intro, id: mid(), text: 'flag this badword' });
  const q = await md.ok('report.list', { house });
  assert.equal(q.reports[0].reason, 'filter');
  assert.equal(q.reports[0].by, null);
  assert.match(q.reports[0].note, /badword/);
  // Timeout: blocked, and the person is timed out.
  await ow.ok('automod.set', { house, action: 'timeout', timeoutMs: 60_000 });
  assert.match(await mm.refused('msg.send', { conv: intro, id: mid(), text: 'badword again' }), /timed out for/);
  assert.match(await mm.refused('msg.send', { conv: intro, id: mid(), text: 'clean now' }), /timed out/);
  const back = await ow.ok('automod.get', { house });
  assert.equal(back.action, 'timeout');
  for (const c of [ow, md, mm, s.m2]) await c.close();
});

test('safety: reports go to moderators, who resolve them; DMs are for blocking instead', async () => {
  const s = await safeHouse('sr');
  const { ow, md, mm, m2, house, lounge } = s;
  const id1 = mid();
  await m2.ok('msg.send', { conv: lounge, id: id1, text: 'something rude' });
  await mm.refused('report.create', { conv: lounge, msg: id1, reason: 'rude' });
  await mm.refused('report.create', { conv: lounge, msg: id1, reason: 'spam', note: 'x'.repeat(501) });
  const { id: rep } = await mm.ok('report.create', { conv: lounge, msg: id1, reason: 'harassment', note: 'third time' });
  assert.match(await mm.refused('report.create', { conv: lounge, msg: id1, reason: 'spam' }), /already reported/);
  assert.match(await m2.refused('report.create', { conv: lounge, msg: id1, reason: 'spam' }), /your own/);
  await md.next('house', (d) => d.house.id === house && d.house.reportsOpen === 1);
  await mm.ok('report.create', { house, user: m2.id, reason: 'spam' });
  assert.match(await mm.refused('report.create', { house, user: mm.id, reason: 'spam' }), /yourself/);
  const { id: dm } = await mm.ok('dm.open', { users: [m2.id] });
  const id2 = mid();
  await m2.ok('msg.send', { conv: dm, id: id2, text: 'in private' });
  assert.match(await mm.refused('report.create', { conv: dm, msg: id2, reason: 'spam' }), /block the person/);
  // Somebody who can't read the room can't report in it.
  const out = await Client.make('sr-out');
  await out.refused('report.create', { conv: lounge, msg: id1, reason: 'spam' });
  assert.match(await mm.refused('report.list', { house }), /see reports/);
  const q = await md.ok('report.list', { house });
  assert.equal(q.reports.length, 2);
  const r = q.reports.find((x) => x.id === rep);
  assert.equal(r.text, 'something rude');
  assert.equal(r.user, m2.id);
  assert.equal(r.by, mm.id);
  assert.equal(r.live, true);
  await mm.refused('report.resolve', { id: rep, status: 'resolved' });
  await md.ok('report.resolve', { id: rep, status: 'resolved' });
  assert.equal((await md.ok('report.list', { house })).reports.length, 1);
  const closed = await md.ok('report.list', { house, status: 'closed' });
  assert.equal(closed.reports[0].handledBy, md.id);
  // Reports are rate limited.
  srv.resetLimits();
  const many = [];
  for (let i = 0; i < 7; i++) { const x = mid(); await m2.ok('msg.send', { conv: s.intro, id: x, text: `msg ${i}` }); many.push(x); }
  let refused = 0;
  for (const x of many) { const a = await mm.op('report.create', { conv: s.intro, msg: x, reason: 'spam' }); if (!a.ok) refused++; }
  assert.ok(refused >= 2, 'the sixth report in a row is refused');
  for (const c of [ow, md, mm, m2, out]) await c.close();
});

test('safety: invitations expire, run out, can be revoked and listed; screening asks newcomers to accept the rules', async () => {
  const s = await safeHouse('si');
  const { ow, md, mm, house } = s;
  const once = await md.ok('invite.create', { house, maxUses: 1, maxAge: 1_800_000 });
  assert.ok(once.expires > Date.now() + 1_700_000 && once.expires <= Date.now() + 1_800_000);
  const forever = await ow.ok('invite.create', { house, maxAge: 0 });
  assert.equal(forever.expires, null);
  await ow.refused('invite.create', { house, maxAge: 999 });
  await ow.refused('invite.create', { house, maxUses: 3 });
  assert.match(await mm.refused('invite.create', { house }), /Your role can’t invite/);
  const n1 = await Client.make('si-n1');
  const n2 = await Client.make('si-n2');
  assert.equal((await fetch(`${base}/api/invite/${once.code}`)).status, 200);
  await n1.ok('invite.accept', { code: once.code });
  assert.match(await n2.refused('invite.accept', { code: once.code }), /expired/);
  assert.equal((await fetch(`${base}/api/invite/${once.code}`)).status, 404);
  // The owner sees every link with its uses; a member sees only their own.
  const all = await ow.ok('invite.list', { house });
  assert.equal(all.all, true);
  const f = all.invites.find((i) => i.code === forever.code);
  assert.equal(f.expires, null);
  assert.equal(f.by, ow.id);
  assert.ok(!all.invites.some((i) => i.code === once.code), 'a used-up link is no longer listed');
  const own = await md.ok('invite.list', { house });
  assert.ok(own.invites.every((i) => i.by === md.id));
  assert.match(await md.refused('invite.revoke', { house, code: forever.code }), /only revoke invitations you made/);
  await ow.ok('invite.revoke', { house, code: forever.code });
  assert.match(await n2.refused('invite.accept', { code: forever.code }), /expired/);
  assert.equal((await fetch(`${base}/api/invite/${forever.code}`)).status, 404);

  // Screening: the rules first; people already here are not asked.
  assert.match(await md.refused('house.screening', { house, on: true }), /Your role can’t/);
  assert.match(await ow.refused('house.screening', { house, on: true }), /rules first/);
  await ow.ok('house.update', { house, rules: 'Be kind. No spam.' });
  await ow.ok('house.screening', { house, on: true });
  await mm.ok('msg.send', { conv: s.lounge, id: mid(), text: 'old members carry on' });
  const { code } = await ow.ok('invite.create', { house });
  await n2.ok('invite.accept', { code });
  const view = await n2.next('house', (d) => d.house.id === house && d.house.screening);
  assert.equal(view.house.accepted, false);
  assert.match(await n2.refused('msg.send', { conv: s.lounge, id: mid(), text: 'hi' }), /accept this house’s rules/);
  await n2.refused('voice.join', { room: s.voice });
  await n2.ok('rules.accept', { house });
  assert.equal((await n2.next('house', (d) => d.house.id === house && d.house.accepted)).house.accepted, true);
  await n2.ok('msg.send', { conv: s.lounge, id: mid(), text: 'hello, I read them' });
  const log = await ow.ok('audit.list', { house });
  for (const k of ['invite.revoke', 'house.screening', 'member.join', 'house.update']) assert.ok(log.entries.some((e) => e.action === k), k);
  for (const c of [ow, md, mm, s.m2, n1, n2]) await c.close();
});
// --- end safety ---------------------------------------------------------------

// --- voice options: soundboard, voice room limits and bitrate (server/voiceopts.js) ---
// A real PCM WAV, made here: `seconds` of a 440 Hz tone.
function voWav(seconds, { rate = 16000, channels = 1, bits = 16 } = {}) {
  const frames = Math.round(seconds * rate);
  const bps = bits / 8;
  const data = Buffer.alloc(frames * channels * bps);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
    for (let ch = 0; ch < channels; ch++) {
      const at = (i * channels + ch) * bps;
      if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at); else data[at] = Math.round(128 + v * 127);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bps, 28); h.writeUInt16LE(channels * bps, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const voUpload = (house, bytes, cookie, name = 'horn.wav') => fetch(`${base}/api/files?sound=${encodeURIComponent(house)}`, {
  method: 'POST', headers: { 'content-type': 'audio/wav', 'x-file-name': name, origin: base, cookie }, body: bytes,
});
async function voHouse(prefix) {
  const ow = await Client.make(`${prefix}-ow`, `Owen ${prefix}`);
  const mm = await Client.make(`${prefix}-mm`, `Milo ${prefix}`);
  const md = await Client.make(`${prefix}-md`, `Mona ${prefix}`);
  const out = await Client.make(`${prefix}-out`, `Otto ${prefix}`);
  const made = await ow.ok('house.create', { name: `Voice ${prefix}`, hue: 120 });
  const h = await ow.next('house', (d) => d.house.id === made.house);
  const memberRole = h.house.roles[1].id;
  const { id: modRole } = await ow.ok('role.create', { house: made.house });
  await ow.ok('role.update', { house: made.house, role: modRole, name: 'Mod', perms: ['post', 'voicemod'] });
  for (const c of [mm, md]) {
    const { code } = await ow.ok('invite.create', { house: made.house });
    await c.ok('invite.accept', { code });
  }
  await ow.ok('member.role', { house: made.house, user: md.id, role: modRole });
  const voice = Object.values(h.rooms).find((r) => r.kind === 'voice').id;
  return { ow, mm, md, out, house: made.house, voice, memberRole, modRole };
}

test('voice options: sound uploads are checked from the WAV itself; only Manage sounds may add, edit and remove', async () => {
  const { ow, mm, out, house, memberRole } = await voHouse('vo1');
  // Snapshots and house views carry the soundboard and the room settings.
  const fresh = await Client.make('vo1-late', 'Late');
  assert.deepEqual(fresh.hello.sounds, {});
  assert.deepEqual(mm.hello.sounds, {}, 'no houses yet when the socket opened');

  // Without the permission: no upload, no add.
  const refused = await voUpload(house, voWav(1), mm.cookie);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /can’t manage the soundboard/);
  assert.equal((await voUpload(house, voWav(1), out.cookie)).status, 403, 'outsiders are refused');
  assert.equal((await voUpload('h_nothere', voWav(1), ow.cookie)).status, 404);
  // Limits, read from the file: length, size, and a real PCM WAV.
  const long = await voUpload(house, voWav(6), ow.cookie);
  assert.equal(long.status, 422);
  assert.match((await long.json()).error, /6\.0 seconds long/);
  assert.equal((await voUpload(house, voWav(5.1), ow.cookie)).status, 201, 'just under the limit is fine');
  const big = await voUpload(house, Buffer.concat([voWav(1), Buffer.alloc(512 * 1024)]), ow.cookie);
  assert.equal(big.status, 413);
  const fake = await voUpload(house, Buffer.from('ID3\x04\0\0\0\0\0\0' + 'x'.repeat(200), 'latin1'), ow.cookie, 'a.mp3');
  assert.equal(fake.status, 415, 'the type the browser claims is not trusted');
  const notPcm = voWav(1); notPcm.writeUInt16LE(3, 20); // IEEE float
  assert.equal((await voUpload(house, notPcm, ow.cookie)).status, 415);
  assert.equal((await voUpload(house, voWav(1, { rate: 96000 }), ow.cookie)).status, 415, 'sample rates above 48 kHz are refused');
  assert.equal((await voUpload(house, voWav(2, { channels: 2, bits: 8, rate: 8000 }), ow.cookie)).status, 201, '8-bit stereo is fine');
  srv.resetLimits();
  assert.equal((await voUpload(house, voWav(0.5), ow.cookie, '%E0%A4%A')).status, 201, 'a broken file name header is kept as sent, not a server error');

  const up = await voUpload(house, voWav(1.5), ow.cookie);
  assert.equal(up.status, 201);
  const file = await up.json();
  assert.equal(file.seconds, 1.5);
  // Only the house can fetch the file, and only through the sound route.
  assert.equal((await fetch(`${base}/api/sounds/${file.id}`, { headers: { cookie: ow.cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/sounds/${file.id}`, { headers: { cookie: out.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/files/${file.id}`, { headers: { cookie: ow.cookie } })).status, 404, 'not through the message file route');

  // Adding: validated name, emoji and volume; someone else's upload can't be used.
  assert.match(await mm.refused('sound.add', { house, file: file.id, name: 'Horn' }), /can’t manage the soundboard/);
  assert.match(await ow.refused('sound.add', { house, file: file.id, name: '   ' }), /name/);
  assert.match(await ow.refused('sound.add', { house, file: file.id, name: 'x'.repeat(33) }), /at most 32/);
  assert.match(await ow.refused('sound.add', { house, file: file.id, name: 'Horn', emoji: 'abc' }), /emoji/);
  assert.match(await ow.refused('sound.add', { house, file: file.id, name: 'Horn', volume: 1.5 }), /volume/);
  assert.match(await ow.refused('sound.add', { house, file: 'f_nothere123', name: 'Horn' }), /finish uploading/);
  const { sound } = await ow.ok('sound.add', { house, file: file.id, name: ' Horn ', emoji: '📯', volume: 0.8 });
  assert.deepEqual([sound.name, sound.emoji, sound.volume], ['Horn', '📯', 0.8]);
  const seen = await mm.next('sounds', (d) => d.house === house && d.list.length > 0);
  assert.equal(seen.list.length, 1, 'every member hears about the new sound');
  assert.match(await ow.refused('sound.add', { house, file: file.id, name: 'Again' }), /already a sound/);
  // Members can play it, so they can fetch it.
  assert.equal((await fetch(`${base}/api/sounds/${file.id}`, { headers: { cookie: mm.cookie } })).status, 200);

  // A role given Manage sounds can manage; edits are validated.
  await ow.ok('role.update', { house, role: memberRole, name: 'Member', perms: ['post', 'invite', 'sounds'] });
  const edited = await mm.ok('sound.edit', { id: sound.id, name: 'Big horn', volume: 0.5, emoji: null });
  assert.deepEqual([edited.sound.name, edited.sound.volume, edited.sound.emoji], ['Big horn', 0.5, null]);
  assert.match(await mm.refused('sound.edit', { id: sound.id, volume: -1 }), /volume/);
  assert.match(await out.refused('sound.edit', { id: sound.id, name: 'mine' }), /not a member/);
  assert.match(await out.refused('sound.remove', { id: sound.id }), /not a member/);

  // The house limit.
  for (let i = srv.db.get('SELECT COUNT(*) n FROM house_sounds WHERE house = ?', house).n; i < 24; i++) {
    const f = await (await voUpload(house, voWav(0.2), ow.cookie)).json();
    await ow.ok('sound.add', { house, file: f.id, name: `S${i}` });
    srv.resetLimits();
  }
  const over = await (await voUpload(house, voWav(0.2), ow.cookie)).json();
  assert.match(await ow.refused('sound.add', { house, file: over.id, name: 'One more' }), /up to 24 sounds/);

  // Removing deletes the file too.
  await mm.ok('sound.remove', { id: sound.id });
  assert.equal(srv.db.get('SELECT 1 FROM files WHERE id = ?', file.id), undefined);
  assert.equal((await fetch(`${base}/api/sounds/${file.id}`, { headers: { cookie: ow.cookie } })).status, 404);
  for (const c of [ow, mm, out, fresh]) await c.close();
});

test('voice options: playing a sound needs voice in its house, unmuted, the right to use it, and respects the cooldowns', async () => {
  const { ow, mm, md, out, house, voice, memberRole } = await voHouse('vo2');
  const f = await (await voUpload(house, voWav(1), ow.cookie)).json();
  const { sound } = await ow.ok('sound.add', { house, file: f.id, name: 'Ding' });
  // Not in voice, or in voice somewhere else: refused.
  assert.match(await mm.refused('sound.play', { id: sound.id }), /Join a voice room/);
  assert.match(await out.refused('sound.play', { id: sound.id }), /Join a voice room/);
  const other = await out.ok('house.create', { name: 'Elsewhere', hue: 10 });
  const oh = await out.next('house', (d) => d.house.id === other.house);
  await out.ok('voice.join', { room: Object.values(oh.rooms).find((r) => r.kind === 'voice').id });
  assert.match(await out.refused('sound.play', { id: sound.id }), /Join a voice room in this sound’s house/);
  assert.match(await mm.refused('sound.play', { id: 'snd_nothere' }), /removed/);

  await mm.ok('voice.join', { room: voice });
  await ow.ok('voice.join', { room: voice });
  ow.events.length = 0;
  const played = await mm.ok('sound.play', { id: sound.id });
  assert.equal(played.file, f.id);
  const ev = await ow.next('sound.play', (d) => d.id === sound.id);
  assert.deepEqual([ev.room, ev.user, ev.name], [voice, mm.id, 'Ding'], 'the room hears who played what');
  await md.none('sound.play', () => true, 100);
  // Cooldown: one sound every 3 seconds per person.
  assert.match(await mm.refused('sound.play', { id: sound.id }), /one sound every 3 seconds/);
  // Muted or deafened: refused, and a moderator's mute too.
  srv.resetLimits();
  await mm.ok('voice.state', { muted: true });
  assert.match(await mm.refused('sound.play', { id: sound.id }), /Unmute/);
  await mm.ok('voice.state', { muted: false, deaf: false });
  await ow.ok('mod.voice', { house, user: mm.id, mute: true });
  assert.match(await mm.refused('sound.play', { id: sound.id }), /moderator/);
  await ow.ok('mod.voice', { house, user: mm.id, mute: false });
  await mm.ok('voice.state', { muted: false });
  await mm.ok('sound.play', { id: sound.id });

  // The house keeps the soundboard to some roles: Members lose it, a role with "Use the soundboard" keeps it.
  assert.match(await mm.refused('house.soundboard', { house, open: false }), /can’t manage the soundboard/);
  assert.match(await ow.refused('house.soundboard', { house, open: 'no' }), /isn’t valid/);
  await ow.ok('house.soundboard', { house, open: false });
  const hv = await mm.next('house', (d) => d.house.id === house && d.house.soundOpen === false);
  assert.equal(hv.house.soundOpen, false);
  srv.resetLimits();
  assert.match(await mm.refused('sound.play', { id: sound.id }), /can’t use the soundboard/);
  await ow.ok('role.update', { house, role: memberRole, name: 'Member', perms: ['post', 'invite', 'soundboard'] });
  await mm.ok('sound.play', { id: sound.id });
  await ow.ok('sound.play', { id: sound.id }); // owners always may

  // A busy room: at most 6 sounds in a burst, whoever plays them.
  await ow.ok('house.soundboard', { house, open: true });
  srv.resetLimits();
  await md.ok('voice.join', { room: voice });
  let ok = 0, burst = 0;
  for (let i = 0; i < 9; i++) {
    srv.hub.soundLimits.perUser.reset(); // keep the per-person cooldown out of the way
    const who = [ow, mm, md][i % 3];
    const a = await who.op('sound.play', { id: sound.id });
    if (a.ok) ok++; else if (/heard a lot of sounds/.test(a.error)) burst++; else assert.fail(a.error);
  }
  assert.equal(ok, 6, 'six sounds get through');
  assert.equal(burst, 3, 'the rest wait for the room');
  for (const c of [ow, mm, md, out]) await c.close();
});

test('voice options: a voice room’s user limit is enforced by the server; bitrate is validated; only Manage rooms may change them', async () => {
  const { ow, mm, md, out, house, voice } = await voHouse('vo3');
  const third = await Client.make('vo3-th', 'Thea');
  const { code } = await ow.ok('invite.create', { house });
  await third.ok('invite.accept', { code });
  // Defaults in the house view.
  const before = await third.next('house', (d) => d.house.id === house);
  assert.deepEqual([before.rooms[voice].limit, before.rooms[voice].bitrate], [0, 64]);

  assert.match(await mm.refused('room.voice', { room: voice, limit: 2 }), /can’t change voice rooms/);
  assert.match(await out.refused('room.voice', { room: voice, limit: 2 }), /not a member/);
  assert.match(await ow.refused('room.voice', { room: voice, limit: 13 }), /1 to 12/);
  assert.match(await ow.refused('room.voice', { room: voice, limit: 1.5 }), /1 to 12/);
  assert.match(await ow.refused('room.voice', { room: voice, bitrate: 65 }), /bitrates/);
  const lounge = Object.values(before.rooms).find((r) => r.kind === 'text').id;
  assert.match(await ow.refused('room.voice', { room: lounge, limit: 2 }), /isn’t a voice room/);
  assert.deepEqual(await ow.ok('room.voice', { room: voice, limit: 2, bitrate: 96 }), { limit: 2, bitrate: 96 });
  const after = await third.next('house', (d) => d.house.id === house && d.rooms[voice].limit === 2);
  assert.equal(after.rooms[voice].bitrate, 96, 'everyone in the house learns the new settings');

  await ow.ok('voice.join', { room: voice });
  await mm.ok('voice.join', { room: voice });
  assert.match(await third.refused('voice.join', { room: voice }), /full\. It holds up to 2 people/);
  await mm.ok('voice.join', { room: voice }); // rejoining from the same seat is fine
  // People who can moderate voice may still come in.
  await md.ok('voice.join', { room: voice });
  await mm.ok('voice.leave');
  await md.ok('voice.leave');
  await third.ok('voice.join', { room: voice });
  // No limit again.
  await ow.ok('room.voice', { room: voice, limit: 0 });
  await mm.ok('voice.join', { room: voice });
  for (const c of [ow, mm, md, out, third]) await c.close();
});
// --- end voice options ------------------------------------------------------------

// --- places, structure and community (server/places.js, js/lib/places.js) ----
// A house for these tests: an owner (ow), two members (mm, m2) with the
// house's Member role, and a "Crew" role nobody has yet.
async function placesHouse(prefix, extra = 0) {
  const ow = await Client.make(`${prefix}-ow`, `Ola ${prefix}`);
  const mm = await Client.make(`${prefix}-mm`, `Mika ${prefix}`);
  const m2 = await Client.make(`${prefix}-m2`, `Nora ${prefix}`);
  const more = [];
  for (let i = 0; i < extra; i++) more.push(await Client.make(`${prefix}-x${i}`, `Xan${i} ${prefix}`));
  const made = await ow.ok('house.create', { name: `Place ${prefix}`, hue: 35 });
  const h = await ow.next('house', (d) => d.house.id === made.house);
  const [ownerRole, memberRole] = h.house.roles.map((r) => r.id);
  const { id: crew } = await ow.ok('role.create', { house: made.house });
  await ow.ok('role.update', { house: made.house, role: crew, name: 'Crew', perms: ['post'] });
  for (const c of [mm, m2, ...more]) {
    const { code } = await ow.ok('invite.create', { house: made.house });
    await c.ok('invite.accept', { code });
    await c.ok('msg.send', { conv: made.room, id: mid(), text: 'hello' }); // past the newcomer stage
  }
  const rooms = Object.values(h.rooms);
  return {
    ow, mm, m2, more, house: made.house, lounge: made.room, ownerRole, memberRole, crew,
    notices: rooms.find((r) => r.kind === 'news').id, voice: rooms.find((r) => r.kind === 'voice').id,
  };
}
const lastHouse = (c, house) => [...c.events].reverse().find((e) => e.ev === 'house' && e.d.house.id === house)?.d;
const settle = () => new Promise((r) => setTimeout(r, 120));

test('places: the room resolver: owners, managers, private rooms, role and member overrides, voice kinds', async () => {
  const { resolveRoom } = await import('../js/lib/places.js');
  const base = { housePerms: new Set(['post']), kind: 'text', roleIds: ['r1'], userId: 'u1' };
  assert.deepEqual(resolveRoom(base), { view: true, send: true, connect: false, speak: false, manage: false });
  assert.equal(resolveRoom({ ...base, isPrivate: true }).view, false);
  assert.equal(resolveRoom({ ...base, isPrivate: true }).send, false, 'no view, nothing else');
  assert.equal(resolveRoom({ ...base, isPrivate: true, overrides: [{ type: 'role', target: 'r1', allow: ['view'] }] }).view, true);
  assert.equal(resolveRoom({ ...base, isPrivate: true, overrides: [{ type: 'role', target: 'r2', allow: ['view'] }] }).view, false);
  // Allow beats deny across roles; a member override beats both; everyone comes first.
  const two = { ...base, roleIds: ['r1', 'r2'] };
  assert.equal(resolveRoom({ ...two, overrides: [{ type: 'role', target: 'r1', deny: ['send'] }, { type: 'role', target: 'r2', allow: ['send'] }] }).send, true);
  assert.equal(resolveRoom({ ...two, overrides: [{ type: 'role', target: 'r1', allow: ['send'] }, { type: 'member', target: 'u1', deny: ['send'] }] }).send, false);
  assert.equal(resolveRoom({ ...base, overrides: [{ type: 'everyone', target: '*', deny: ['send'] }, { type: 'role', target: 'r1', allow: ['send'] }] }).send, true);
  assert.equal(resolveRoom({ ...base, overrides: [{ type: 'everyone', target: '*', deny: ['view'] }] }).view, false);
  // Notices need 'announce'; owners and room managers can't be locked out.
  assert.equal(resolveRoom({ ...base, kind: 'news' }).send, false);
  assert.equal(resolveRoom({ ...base, kind: 'news', housePerms: new Set(['announce']) }).send, true);
  assert.equal(resolveRoom({ ...base, owner: true, isPrivate: true, overrides: [{ type: 'member', target: 'u1', deny: ['view', 'send'] }] }).send, true);
  const mgr = resolveRoom({ ...base, housePerms: new Set(['rooms']), isPrivate: true, overrides: [{ type: 'member', target: 'u1', deny: ['view', 'manage'] }] });
  assert.equal(mgr.view && mgr.manage, true);
  // Voice: connect and speak; a stage lets only its managers speak uninvited.
  assert.deepEqual(resolveRoom({ ...base, kind: 'voice' }), { view: true, send: true, connect: true, speak: true, manage: false });
  assert.equal(resolveRoom({ ...base, kind: 'stage' }).speak, false);
  assert.equal(resolveRoom({ ...base, kind: 'stage', housePerms: new Set(['rooms']) }).speak, true);
  assert.equal(resolveRoom({ ...base, kind: 'voice', overrides: [{ type: 'role', target: 'r1', deny: ['connect'] }] }).speak, false, 'no connect, no speaking');
});

test('places: a private room is out of reach everywhere: rooms list, live delivery, history, threads, search, files, snapshot', async () => {
  const s = await placesHouse('pv');
  const { ow, mm, m2, house, crew } = s;
  const { id: back } = await ow.ok('room.create', { house, name: 'Backroom', kind: 'text', private: true });
  await settle();
  assert.ok(lastHouse(ow, house).rooms[back], 'the owner sees it');
  assert.equal(lastHouse(mm, house).rooms[back], undefined, 'members do not');
  assert.equal(lastHouse(mm, house).house.groups.some((g) => g.rooms.includes(back)), false);
  const secret = mid();
  await ow.ok('msg.send', { conv: back, id: secret, text: 'pineapple plans' });
  await mm.none('msg', (d) => d.conv === back);
  assert.match(await mm.refused('msg.send', { conv: back, id: mid(), text: 'let me in' }), /access/);
  await mm.refused('history', { conv: back });
  await mm.refused('react', { conv: back, id: secret, emoji: '👍', on: true });
  await mm.refused('follow.set', { thread: `t:${secret}`, on: true });
  await mm.refused('msg.send', { conv: `t:${secret}`, id: mid(), text: 'thread sneak' });
  assert.equal((await mm.ok('search', { q: 'pineapple' })).hits.length, 0);
  assert.equal((await ow.ok('search', { q: 'pineapple' })).hits.length, 1);
  const f = await (await upload(ow.cookie, back, 'text/plain', Buffer.from('secret notes'), 'notes.txt')).json();
  assert.equal((await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: mm.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: ow.cookie } })).status, 200);
  assert.equal((await upload(mm.cookie, back, 'text/plain', Buffer.from('x'), 'x.txt')).status, 403);
  await mm.close(); await mm.connect();
  assert.equal(mm.hello.rooms[back], undefined, 'not in the snapshot');
  assert.equal(mm.hello.msgs[back], undefined);

  // An override for a role, and a second role for one person: Nora gets in.
  await ow.ok('room.override', { room: back, type: 'role', target: crew, allow: ['view'] });
  await ow.ok('member.roles', { house, user: m2.id, roles: [crew] });
  const content = await m2.next('content', (d) => d.msgs[back]);
  assert.ok(content.msgs[back].some((m) => m.id === secret), 'what was said arrives once she can see it');
  assert.ok(lastHouse(m2, house).rooms[back].viewers.includes(m2.id));
  await ow.ok('msg.send', { conv: back, id: mid(), text: 'welcome Nora' });
  await m2.next('msg', (d) => d.conv === back);
  await mm.none('msg', (d) => d.conv === back);
  await m2.ok('msg.send', { conv: back, id: mid(), text: 'thanks' });
  // A member override takes sending away from her alone.
  await ow.ok('room.override', { room: back, type: 'member', target: m2.id, deny: ['send'] });
  assert.match(await m2.refused('msg.send', { conv: back, id: mid(), text: 'still here?' }), /can’t send/);
  assert.equal((await ow.ok('room.perms', { room: back, user: m2.id })).perms.send, false);
  // Taking the role away takes the room away.
  await ow.ok('member.roles', { house, user: m2.id, roles: [] });
  await settle();
  assert.equal(lastHouse(m2, house).rooms[back], undefined);
  await m2.refused('history', { conv: back });
  // Outsiders previewing a public house never see its private room's name.
  await ow.ok('house.update', { house, public: true });
  const outsider = await Client.make('pv-out', 'Otto Side');
  const card = await outsider.ok('house.preview', { house });
  assert.equal(card.rooms.some((r) => r.name === 'Backroom'), false);
  assert.ok(card.rooms.some((r) => r.name === 'Lounge'));
  assert.equal((await outsider.ok('discover', { q: 'Place pv' })).houses.find((h) => h.id === house).rooms.some((r) => r.name === 'Backroom'), false);
  await outsider.close();
  // Making it public again opens it to everyone.
  await ow.ok('room.private', { room: back, on: false });
  await ow.ok('room.override', { room: back, type: 'role', target: crew, allow: [] });
  await ow.ok('room.override', { room: back, type: 'member', target: m2.id });
  await mm.ok('history', { conv: back });
  for (const c of [ow, mm, m2]) await c.close();
});

test('places: overrides decide sending and managing; only room managers change them, with valid input', async () => {
  const s = await placesHouse('ov');
  const { ow, mm, m2, house, lounge, memberRole, ownerRole } = s;
  await ow.ok('room.override', { room: lounge, type: 'everyone', allow: [], deny: ['send'] });
  assert.match(await mm.refused('msg.send', { conv: lounge, id: mid(), text: 'quiet please' }), /can’t send/);
  await ow.ok('room.override', { room: lounge, type: 'member', target: mm.id, allow: ['send'] });
  await mm.ok('msg.send', { conv: lounge, id: mid(), text: 'I may' });
  await m2.refused('msg.send', { conv: lounge, id: mid(), text: 'I may not' });
  // Members can't change overrides; bad input is refused.
  assert.match(await mm.refused('room.override', { room: lounge, type: 'everyone', allow: ['send'] }), /can’t manage/);
  await mm.refused('room.private', { room: lounge, on: true });
  assert.match(await ow.refused('room.override', { room: lounge, type: 'role', target: ownerRole, deny: ['view'] }), /owner role/);
  assert.match(await ow.refused('room.override', { room: lounge, type: 'role', target: memberRole, deny: ['fly'] }), /doesn’t exist/);
  await ow.refused('room.override', { room: lounge, type: 'gang', target: memberRole, deny: ['send'] });
  await ow.refused('room.override', { room: lounge, type: 'member', target: 'u_nobody123', deny: ['send'] });
  await ow.refused('room.override', { room: lounge, type: 'role', target: memberRole, deny: 'send' });
  // "Manage the room" on one room lets Mika rename it, and nothing else.
  const intro = Object.values(lastHouse(ow, house).rooms).find((r) => r.name === 'Introductions').id;
  await ow.ok('room.override', { room: intro, type: 'member', target: mm.id, allow: ['manage'] });
  await mm.ok('room.update', { room: intro, name: 'Hellos' });
  assert.equal(srv.db.get('SELECT name FROM rooms WHERE id = ?', intro).name, 'Hellos');
  await mm.ok('room.override', { room: intro, type: 'everyone', deny: ['send'] });
  assert.match(await mm.refused('room.update', { room: lounge, name: 'Mine now' }), /Your role can’t/);
  await mm.refused('room.delete', { room: lounge });
  await mm.refused('room.create', { house, name: 'Extra', kind: 'text' });
  for (const c of [ow, mm, m2]) await c.close();
});

test('places: voice and stages: joining and speaking follow the resolver; the audience is muted by the server', async () => {
  const s = await placesHouse('st');
  const { ow, mm, m2, house, voice, memberRole } = s;
  await ow.ok('room.override', { room: voice, type: 'role', target: memberRole, deny: ['connect'] });
  assert.match(await mm.refused('voice.join', { room: voice }), /can’t join/);
  await ow.ok('room.override', { room: voice, type: 'role', target: memberRole, allow: [], deny: ['speak'] });
  await mm.ok('voice.join', { room: voice });
  const v = await ow.next('voice', (d) => d.room === voice && d.users.includes(mm.id) && d.state[mm.id]?.smute);
  assert.equal(v.state[mm.id].muted, true, 'joins muted by the server');
  assert.match(await mm.refused('voice.state', { muted: false }), /can’t speak/);
  await mm.ok('voice.state', { muted: true, deaf: true });
  // Losing "see the room" takes you out of its voice.
  await ow.ok('room.override', { room: voice, type: 'member', target: mm.id, deny: ['view'] });
  await mm.next('voice.kicked', (d) => d.room === voice);
  await ow.ok('room.override', { room: voice, type: 'member', target: mm.id });

  const { id: stage } = await ow.ok('room.create', { house, name: 'Town hall', kind: 'stage' });
  await ow.ok('voice.join', { room: stage });
  await mm.ok('voice.join', { room: stage });
  const sv = await ow.next('voice', (d) => d.room === stage && d.users.includes(mm.id) && d.state[mm.id]?.smute);
  assert.equal(sv.state[ow.id].smute, undefined, 'the owner may speak');
  assert.match(await mm.refused('voice.state', { muted: false }), /audience/);
  assert.match(await mm.refused('voice.state', { camera: true }), /audience/);
  assert.match(await mm.refused('stage.speak', { room: stage }), /Raise your hand/);
  await mm.ok('stage.hand', { room: stage, up: true });
  assert.deepEqual((await ow.next('stage', (d) => d.room === stage && d.hands.length)).hands, [mm.id]);
  await m2.refused('stage.hand', { room: stage, up: true }); // not on the stage
  assert.match(await mm.refused('stage.invite', { room: stage, user: mm.id }), /run this stage/);
  assert.match(await mm.refused('stage.topic', { room: stage, topic: 'mine' }), /run this stage/);
  await ow.ok('stage.topic', { room: stage, topic: 'Budget questions' });
  assert.equal((await mm.next('stage', (d) => d.topic === 'Budget questions')).topic, 'Budget questions');
  await ow.ok('stage.invite', { room: stage, user: mm.id });
  const st = await mm.next('stage', (d) => d.speakers.includes(mm.id));
  assert.deepEqual(st.hands, []);
  await mm.ok('voice.state', { muted: false });
  await ow.ok('stage.audience', { room: stage, user: mm.id });
  await ow.next('voice', (d) => d.room === stage && d.state[mm.id]?.smute && d.state[mm.id]?.muted);
  await mm.refused('voice.state', { muted: false });
  // Mika can step down himself, and a moderator's unmute never makes him a speaker.
  await mm.ok('stage.audience', { room: stage });
  await ow.ok('mod.voice', { house, user: mm.id, mute: false });
  await mm.refused('voice.state', { muted: false });
  assert.equal(lastHouse(ow, house).rooms[stage].kind, 'stage');
  for (const c of [ow, mm, m2]) await c.close();
});

test('places: roles: extra roles add permissions, order, icon, show separately, mentionable; nicknames per house', async () => {
  const s = await placesHouse('rl');
  const { ow, mm, m2, house, notices, memberRole, crew } = s;
  assert.match(await mm.refused('msg.send', { conv: notices, id: mid(), text: 'news!' }), /post notices|Only/);
  await ow.ok('role.update', { house, role: crew, perms: ['post', 'announce'], icon: '🎨', hoist: false, mentionable: false });
  await ow.ok('member.roles', { house, user: mm.id, roles: [crew] });
  await mm.ok('msg.send', { conv: notices, id: mid(), text: 'news from the crew' });
  await settle();
  const view = lastHouse(m2, house).house;
  const c = view.roles.find((r) => r.id === crew);
  assert.deepEqual([c.icon, c.hoist, c.mentionable], ['🎨', false, false]);
  assert.deepEqual(view.extra[mm.id], [crew]);
  await ow.refused('role.update', { house, role: crew, icon: 'not an emoji' });
  assert.match(await ow.refused('role.update', { house, role: crew, hue: 12 }), /colours/);
  await ow.refused('role.update', { house, role: crew, hoist: 'yes' });
  await mm.refused('member.roles', { house, user: m2.id, roles: [crew] });
  await ow.refused('member.roles', { house, user: m2.id, roles: [s.ownerRole] });
  // Order: the owner role stays first; others move by index.
  await ow.ok('role.move', { house, role: crew, index: 1 });
  assert.deepEqual(srv.db.all('SELECT id FROM roles WHERE house = ? ORDER BY pos', house).map((r) => r.id), [s.ownerRole, crew, memberRole]);
  await ow.refused('role.move', { house, role: s.ownerRole, index: 2 });
  await ow.refused('role.move', { house, role: crew, index: 0 });
  // A manager below the top can't move roles above their own.
  await ow.ok('role.update', { house, role: memberRole, perms: ['post', 'roles', 'nick'] });
  assert.match(await mm.refused('role.move', { house, role: crew, index: 2 }), /below your own/);
  assert.match(await mm.refused('member.roles', { house, user: m2.id, roles: [crew] }), /below your own/);
  await ow.ok('role.update', { house, role: memberRole, perms: ['post', 'invite', 'nick'] });

  // Nicknames and pictures per house.
  await mm.ok('member.profile', { house, nick: 'Mik', emoji: '🦊', hue: 200 });
  await settle();
  assert.deepEqual(lastHouse(m2, house).house.profiles[mm.id], { nick: 'Mik', emoji: '🦊', hue: 200 });
  assert.match(await m2.refused('member.profile', { house, user: mm.id, nick: 'Silly' }), /other people’s nicknames/);
  await mm.refused('member.profile', { house, nick: 'x'.repeat(40) });
  await mm.refused('member.profile', { house, hue: 13 });
  await ow.ok('member.profile', { house, user: mm.id, nick: 'Mika (crew)' });
  await ow.ok('role.update', { house, role: memberRole, perms: ['post', 'invite'] });
  assert.match(await m2.refused('member.profile', { house, nick: 'Nono' }), /can’t change its nickname/);
  // Leaving drops extra roles and the nickname.
  await mm.ok('house.leave', { house });
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM member_roles WHERE house = ? AND user = ?', house, mm.id).n, 0);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM member_profiles WHERE house = ? AND user = ?', house, mm.id).n, 0);
  for (const x of [ow, mm, m2]) await x.close();
});

test('places: forum rooms: posts with a title and tags, required tags, replies in each post’s thread, follow, edit', async () => {
  const s = await placesHouse('fm');
  const { ow, mm, m2, house } = s;
  const { id: forum } = await ow.ok('room.create', { house, name: 'Questions', kind: 'forum' });
  await mm.refused('forum.tags', { room: forum, tags: [{ name: 'Glaze' }] });
  const { tags } = await ow.ok('forum.tags', { room: forum, tags: [{ name: 'Glaze' }, { name: 'Kiln', emoji: '🔥' }], required: true });
  assert.equal(tags.length, 2);
  await ow.refused('forum.tags', { room: forum, tags: [{ name: 'Same' }, { name: 'same' }] });
  // Plain messages are refused; posts need a title and, here, a tag.
  assert.match(await mm.refused('msg.send', { conv: forum, id: mid(), text: 'just chatting' }), /forum/);
  assert.match(await mm.refused('forum.post', { room: forum, id: mid(), title: 'No tag', text: 'body' }), /at least one tag/);
  await mm.refused('forum.post', { room: forum, id: mid(), title: '', text: 'body', tags: [tags[0].id] });
  await mm.refused('forum.post', { room: forum, id: mid(), title: 'Bad tag', tags: ['tg_madeup1'] });
  const pid = mid();
  const { m } = await mm.ok('forum.post', { room: forum, id: pid, title: 'Why does my glaze crawl?', text: 'Thick application, cone 6.', tags: [tags[0].id] });
  assert.deepEqual([m.post.title, m.post.tags, m.post.replies], ['Why does my glaze crawl?', [tags[0].id], 0]);
  const seen = await m2.next('msg', (d) => d.conv === forum && d.m.post);
  assert.equal(seen.m.post.title, 'Why does my glaze crawl?');
  await m2.next('forum.thread', (d) => d.id === `t:${pid}`);
  assert.ok(srv.db.get('SELECT 1 FROM follows WHERE user = ? AND thread = ?', mm.id, `t:${pid}`), 'the author follows their post');
  await m2.ok('msg.send', { conv: `t:${pid}`, id: mid(), text: 'Try sanding the bisque.' });
  await m2.ok('follow.set', { thread: `t:${pid}`, on: true });
  const h = await mm.ok('history', { conv: forum });
  assert.equal(h.msgs.find((x) => x.id === pid).post.replies, 1);
  // Editing: the author, or whoever manages the room.
  await m2.refused('forum.edit', { id: pid, title: 'Hijacked' });
  await mm.ok('forum.edit', { id: pid, title: 'Glaze crawling at cone 6', tags: [tags[1].id] });
  assert.equal((await m2.next('msg', (d) => d.m.id === pid && d.m.post?.title.startsWith('Glaze'))).m.post.tags[0], tags[1].id);
  await ow.ok('forum.edit', { id: pid, tags: [tags[0].id, tags[1].id] });
  // Denying send stops new posts and replies.
  await ow.ok('room.override', { room: forum, type: 'member', target: m2.id, deny: ['send'] });
  await m2.refused('forum.post', { room: forum, id: mid(), title: 'Mine', tags: [tags[0].id] });
  await m2.refused('msg.send', { conv: `t:${pid}`, id: mid(), text: 'one more' });
  for (const c of [ow, mm, m2]) await c.close();
});

test('places: notices followed into another house are copied with where they came from', async () => {
  const s = await placesHouse('nf');
  const { ow, mm, house, notices, lounge } = s;
  const other = await mm.ok('house.create', { name: 'Mika’s club', hue: 200 });
  const target = other.room;
  // Following needs a notice room, a room you manage elsewhere, and an open source.
  assert.match(await mm.refused('news.follow', { source: lounge, target }), /notice rooms/);
  assert.match(await mm.refused('news.follow', { source: notices, target: lounge }), /another house|manage/);
  assert.match(await s.m2.refused('news.follow', { source: notices, target }), /manage|member/);
  const { hook } = await mm.ok('news.follow', { source: notices, target });
  assert.equal(hook.kind, 'follow');
  await mm.refused('news.follow', { source: notices, target });
  await ow.ok('msg.send', { conv: notices, id: mid(), text: 'Firing on Saturday' });
  const copy = await mm.next('msg', (d) => d.conv === target && d.m.text === 'Firing on Saturday');
  assert.equal(copy.m.bot.follow.room, 'Notices');
  assert.equal(copy.m.bot.follow.house, `Place nf`);
  assert.notEqual(copy.m.author, ow.id, 'copied by a bot, not as the author');
  // Bots can't sign in.
  assert.equal((await post('/api/login', { handle: srv.db.get('SELECT handle FROM users WHERE id = ?', copy.m.author).handle, password: '!' })).status, 401);
  // A private notice room stops copying.
  await ow.ok('room.private', { room: notices, on: true });
  await ow.ok('msg.send', { conv: notices, id: mid(), text: 'Committee only' });
  await mm.none('msg', (d) => d.conv === target && d.m.text === 'Committee only');
  await ow.ok('room.private', { room: notices, on: false });
  await mm.ok('news.unfollow', { hook: hook.id });
  await ow.ok('msg.send', { conv: notices, id: mid(), text: 'After unfollow' });
  await mm.none('msg', (d) => d.conv === target && d.m.text === 'After unfollow');
  for (const c of [ow, mm, s.m2]) await c.close();
});

test('places: webhooks: a secret address posts with a bot badge; wrong tokens are refused; limited, regenerated, deleted', async () => {
  const s = await placesHouse('wh');
  const { ow, mm, house, lounge, voice } = s;
  assert.match(await mm.refused('hook.create', { room: lounge, name: 'CI' }), /can’t manage/);
  await ow.refused('hook.create', { room: voice, name: 'CI' });
  const { hook, url } = await ow.ok('hook.create', { room: lounge, name: 'Kiln sensor' });
  assert.match(url, /^\/api\/hooks\/wh_[a-z0-9]+\/[\w-]{20,}$/);
  assert.equal(srv.db.get('SELECT token FROM hooks WHERE id = ?', hook.id).token.includes(url.split('/').pop()), false, 'only a hash is stored');
  const send = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const ok = await send(url, { content: 'Kiln at 1220°C', username: 'Kiln 2', avatar_url: 'https://example.com/a.png' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const got = await mm.next('msg', (d) => d.conv === lounge && d.m.text === 'Kiln at 1220°C');
  assert.equal(got.m.bot.name, 'Kiln 2');
  assert.equal(got.m.bot.hook, hook.id);
  // Wrong token, unknown hook, a page on another site, bad bodies.
  const wrong = url.replace(/[\w-]{20,}$/, 'x'.repeat(32));
  assert.equal((await send(wrong, { content: 'forged' })).status, 401);
  assert.equal((await send('/api/hooks/wh_doesnotexist01/' + 'y'.repeat(32), { content: 'forged' })).status, 401);
  assert.equal((await send(url, { content: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(url, { content: '' })).status, 400);
  assert.equal((await send(url, { content: 'y'.repeat(2001) })).status, 400);
  assert.equal((await send(url, { content: 'ok', avatar_url: 'http://169.254.169.254/latest' })).status, 400);
  assert.equal((await fetch(base + url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' })).status, 415);
  await mm.none('msg', (d) => d.conv === lounge && d.m.text === 'forged');
  // Rate limited per hook.
  srv.resetLimits();
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await send(url, { content: `burst ${i}` })).status);
  assert.ok(codes.includes(429), `some were refused: ${codes}`);
  assert.equal(codes.filter((x) => x === 200).length, 5);
  srv.resetLimits();
  // Regenerate: the old address stops working. Delete: the new one does too.
  const { url: url2 } = await ow.ok('hook.regen', { hook: hook.id });
  assert.equal((await send(url, { content: 'old' })).status, 401);
  assert.equal((await send(url2, { content: 'new' })).status, 200);
  const list = await ow.ok('hook.list', { room: lounge });
  assert.deepEqual(list.hooks.map((h) => h.id), [hook.id]);
  assert.equal(JSON.stringify(list).includes(url2.split('/').pop()), false, 'the list never shows a token');
  await mm.refused('hook.delete', { hook: hook.id });
  await ow.ok('hook.delete', { hook: hook.id });
  assert.equal((await send(url2, { content: 'gone' })).status, 401);
  // Readers who can't see the room never get its webhook messages.
  const { hook: h2, url: url3 } = await ow.ok('hook.create', { room: lounge, name: 'Again' });
  await ow.ok('room.override', { room: lounge, type: 'member', target: mm.id, deny: ['view'] });
  assert.equal((await send(url3, { content: 'hidden from Mika' })).status, 200);
  await mm.none('msg', (d) => d.m.text === 'hidden from Mika');
  await ow.ok('hook.delete', { hook: h2.id });
  void house;
  for (const c of [ow, mm, s.m2]) await c.close();
});

test('places: the rail keeps folders and house order per person, on every device, and checks them', async () => {
  const s = await placesHouse('rail');
  const { ow, mm, house } = s;
  const h2 = (await ow.ok('house.create', { name: 'Second', hue: 200 })).house;
  const h3 = (await ow.ok('house.create', { name: 'Third', hue: 142 })).house;
  const items = [h3, { name: 'Pottery', hue: 200, open: true, houses: [house, h2] }];
  const { rail } = await ow.ok('rail.set', { items });
  assert.equal(rail.items[0], h3);
  assert.deepEqual(rail.items[1].houses, [house, h2]);
  assert.match(rail.items[1].id, /^fd_/);
  const other = await Client.make('rail-dev', 'Unused');
  void other;
  await ow.close(); await ow.connect();
  assert.deepEqual(ow.hello.places.rail.items[1].houses, [house, h2], 'kept across connections');
  assert.equal(ow.hello.places.rail.items[1].name, 'Pottery');
  await ow.refused('rail.set', { items: ['h_notmine12345'] });
  await mm.refused('rail.set', { items: [h2] });
  await ow.refused('rail.set', { items: [house, { name: 'Dup', houses: [house] }] });
  await ow.refused('rail.set', { items: [{ name: 'x'.repeat(40), houses: [house] }] });
  await ow.refused('rail.set', { items: [{ name: 'Bad hue', hue: 13, houses: [house] }] });
  await ow.refused('rail.set', { items: Array.from({ length: 21 }, () => ({ name: 'f', houses: [house] })) });
  // A house left out goes at the end.
  const { rail: r2 } = await ow.ok('rail.set', { items: [h2] });
  assert.deepEqual(r2.items.slice(1).sort(), [house, h3].sort());
  for (const c of [ow, mm, s.m2, other]) await c.close();
});

test('places: welcome and interests: picking an interest grants its roles; managing roles can’t be handed out', async () => {
  const s = await placesHouse('ob');
  const { ow, mm, house, crew, memberRole } = s;
  const { id: mods } = await ow.ok('role.create', { house });
  await ow.ok('role.update', { house, role: mods, name: 'Mods', perms: ['post', 'moderate'] });
  assert.match(await ow.refused('onboard.set', { house, interests: [{ label: 'Power', roles: [mods] }] }), /can’t be handed out/);
  await ow.refused('onboard.set', { house, interests: [{ label: 'Owner', roles: [s.ownerRole] }] });
  await mm.refused('onboard.set', { house, welcome: 'mine' });
  await ow.ok('onboard.set', { house, welcome: 'Welcome! Pick what you are into.', interests: [{ label: 'Glazes', emoji: '🎨', roles: [crew] }, { label: 'Wheel', roles: [] }] });
  await settle();
  const v = lastHouse(mm, house).house;
  assert.equal(v.welcome, 'Welcome! Pick what you are into.');
  assert.equal(v.interests.length, 2);
  await mm.refused('onboard.pick', { house, interests: ['in_notreal1'] });
  const r = await mm.ok('onboard.pick', { house, interests: [v.interests[0].id] });
  assert.deepEqual(r.roles, [crew]);
  assert.ok(srv.db.get("SELECT 1 FROM member_roles WHERE house = ? AND user = ? AND role = ? AND via = 'interest'", house, mm.id, crew));
  // If the role later gains a managing permission, picking no longer grants it.
  await ow.ok('role.update', { house, role: crew, perms: ['post', 'kick'] });
  assert.deepEqual((await mm.ok('onboard.pick', { house, interests: [v.interests[0].id] })).roles, []);
  // Unpicking removes what interests gave, never roles given by hand.
  await ow.ok('role.update', { house, role: crew, perms: ['post'] });
  await ow.ok('member.roles', { house, user: mm.id, roles: [crew] });
  await mm.ok('onboard.pick', { house, interests: [] });
  assert.ok(srv.db.get('SELECT 1 FROM member_roles WHERE house = ? AND user = ? AND role = ?', house, mm.id, crew), 'given by hand, kept');
  void memberRole;
  for (const c of [ow, mm, s.m2]) await c.close();
});

test('places: templates and copying a house’s structure (never its messages or members)', async () => {
  const a = await Client.make('tp-a', 'Tia Pal');
  await a.refused('house.create', { name: 'Bad', hue: 35, template: 'castle' });
  const made = await a.ok('house.create', { name: 'Study buddies', hue: 228, template: 'study' });
  const h = await a.next('house', (d) => d.house.id === made.house);
  const kinds = Object.values(h.rooms).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['forum', 'news', 'stage', 'text', 'voice']);
  const forum = Object.values(h.rooms).find((r) => r.kind === 'forum');
  assert.equal(forum.tagRequired, true);
  assert.deepEqual(forum.tags.map((t) => t.name), ['Maths', 'Science', 'Languages', 'Other']);
  assert.deepEqual(h.house.roles.map((r) => r.name), ['Owner', 'Tutor', 'Student']);
  assert.equal(h.house.roles[1].icon, '🎓');
  const club = await a.ok('house.create', { name: 'Our club', hue: 200, template: 'club' });
  const ch = await a.next('house', (d) => d.house.id === club.house);
  const committee = Object.values(ch.rooms).find((r) => r.name === 'Committee');
  assert.equal(committee.private, true);
  // A member of the club doesn't see the committee room.
  const b = await Client.make('tp-b', 'Ben Pal');
  const { code } = await a.ok('invite.create', { house: club.house });
  await b.ok('invite.accept', { code });
  const bh = await b.next('house', (d) => d.house.id === club.house);
  assert.equal(bh.rooms[committee.id], undefined);
  // Copy: same rooms, roles and overrides; no messages, no other members.
  await a.ok('msg.send', { conv: club.room, id: mid(), text: 'not copied' });
  srv.resetLimits();
  assert.match(await b.refused('house.create', { name: 'Stolen', hue: 35, from: club.house }), /Your role can’t/);
  const copy = await a.ok('house.create', { name: 'Club two', hue: 35, from: club.house });
  const cp = await a.next('house', (d) => d.house.id === copy.house);
  assert.deepEqual(Object.values(cp.rooms).map((r) => r.name).sort(), Object.values(ch.rooms).map((r) => r.name).sort());
  assert.deepEqual(cp.house.roles.map((r) => r.name), ch.house.roles.map((r) => r.name));
  assert.equal(Object.values(cp.rooms).find((r) => r.name === 'Committee').private, true);
  assert.deepEqual(Object.keys(cp.house.members), [a.id]);
  assert.equal(srv.db.get(`SELECT COUNT(*) n FROM messages WHERE conv IN (SELECT id FROM rooms WHERE house = ?)`, copy.house).n, 0);
  // Template creation is rate limited.
  srv.resetLimits();
  for (let i = 0; i < 3; i++) await a.ok('house.create', { name: `T${i}`, hue: 35, template: 'friends' });
  assert.match(await a.refused('house.create', { name: 'T4', hue: 35, template: 'friends' }), /little fast/);
  await a.close(); await b.close();
});

test('places: insights are for owners: joins, leaves, messages per day and the busiest rooms', async () => {
  const s = await placesHouse('in', 1);
  const { ow, mm, m2, house, lounge } = s;
  await ow.ok('msg.send', { conv: lounge, id: mid(), text: 'one' });
  await m2.ok('house.leave', { house });
  assert.match(await mm.refused('insights.get', { house }), /Only owners/);
  const r = await ow.ok('insights.get', { house });
  assert.equal(r.days, 30);
  assert.equal(r.messages.length, 30);
  const today = r.messages[r.messages.length - 1];
  assert.ok(today.n >= 4, `messages today: ${today.n}`);
  assert.ok(r.joined[r.joined.length - 1].n >= 3, 'joins today');
  assert.equal(r.left[r.left.length - 1].n, 1, 'one left today');
  assert.equal(r.rooms[0].id, lounge);
  assert.equal(r.members, 3);
  assert.ok(r.active >= 2);
  assert.equal((await ow.ok('insights.get', { house, days: 7 })).messages.length, 7);
  for (const c of [ow, mm, m2, ...s.more]) await c.close();
});
// --- end places ------------------------------------------------------------------

test('places: the resolver reaches highlights, events, pins and forum titles; the word filter reads post titles', async () => {
  const s = await placesHouse('rx');
  const { ow, mm, m2, house, crew } = s;
  // Crew can highlight, plan events and pin, house-wide; mm has Crew.
  await ow.ok('role.update', { house, role: crew, perms: ['post', 'highlight', 'announce', 'pin'] });
  await ow.ok('member.roles', { house, user: mm.id, roles: [crew] });
  const { id: back } = await ow.ok('room.create', { house, name: 'Backroom', kind: 'text', private: true });
  const secret = mid();
  await ow.ok('msg.send', { conv: back, id: secret, text: 'owners only' });
  assert.match(await mm.refused('highlight.set', { conv: back, id: secret, on: true }), /Highlights belong to rooms/);
  assert.match(await mm.refused('msg.pin', { conv: back, id: secret, on: true }), /access/);
  assert.match(await mm.refused('event.create', { house, title: 'Secret meeting', starts: Date.now() + 3_600_000, room: back }), /isn’t in this house/);
  // Once the room lets Crew see it, the same house-wide permissions work there.
  await ow.ok('room.override', { room: back, type: 'role', target: crew, allow: ['view'] });
  await mm.ok('highlight.set', { conv: back, id: secret, on: true });
  await mm.ok('event.create', { house, title: 'Crew meeting', starts: Date.now() + 3_600_000, room: back });
  await m2.refused('highlight.set', { conv: back, id: secret, on: true });
  // Forum titles go through the house's word filter, like any message.
  const { id: forum } = await ow.ok('room.create', { house, name: 'Board', kind: 'forum' });
  await ow.ok('automod.set', { house, words: ['badword'], action: 'block' });
  assert.match(await m2.refused('forum.post', { room: forum, id: mid(), title: 'A BADWORD title', text: 'clean body' }), /word this house doesn’t allow/);
  const pid = mid();
  await m2.ok('forum.post', { room: forum, id: pid, title: 'A clean title', text: 'clean body' });
  assert.match(await m2.refused('forum.edit', { id: pid, title: 'now a badword' }), /word this house doesn’t allow/);
  assert.equal(srv.db.get('SELECT title FROM forum_posts WHERE msg = ?', pid).title, 'A clean title');
  // With "flag", a title is posted and goes to Reports, on post and on edit.
  await ow.ok('automod.set', { house, words: ['badword'], action: 'flag' });
  const fid = mid();
  await m2.ok('forum.post', { room: forum, id: fid, title: 'A badword title', text: 'clean body' });
  await m2.ok('forum.edit', { id: pid, title: 'now a badword' });
  const flagged = srv.db.all("SELECT msg, note FROM reports WHERE house = ? AND reason = 'filter' ORDER BY ts", house);
  assert.deepEqual(flagged.map((r) => r.msg), [fid, pid]);
  assert.match(flagged[0].note, /^Title\. Word: badword/);
  // An exempt role counts when it is an extra role.
  await ow.ok('automod.set', { house, words: ['badword'], action: 'block', exempt: [crew] });
  await mm.ok('forum.post', { room: forum, id: mid(), title: 'crew may say badword', text: 'clean body' });
  for (const c of [ow, mm, m2]) await c.close();
});

// --- account, profile, presence and security (server/account.js, js/lib/account.js) ---
import { hotp, totpAt, totpMatch, unbase32, base32, stepAt } from '../server/account.js';
import { inQuiet, hasKeyword, everyonePing } from '../js/lib/account.js';

const acLogin = (handle, ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36') => fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'user-agent': ua }, body: JSON.stringify({ handle, password: 'a long password' }),
});
// Another device signed in as the same person, with its own session and socket.
async function acDevice(handle, ua) {
  const res = await acLogin(handle, ua);
  assert.equal(res.status, 200);
  const c = new Client();
  c.cookie = cookieOf(res);
  c.id = (await res.json()).user.id;
  await c.connect();
  return c;
}
async function acFriends(a, b) {
  await a.ok('friend.request', { user: b.id });
  await b.ok('friend.accept', { user: a.id });
  await a.next('friend', (d) => d.id === b.id && d.friend?.state === 'friends');
}
const acClosed = (c) => new Promise((r) => { if (c.ws.readyState === 3) r(c.ws.closeCode ?? 4001); else c.ws.on('close', (code) => r(code)); });

test('account: settings follow the person to every device; the server checks every value', async () => {
  const a1 = await Client.make('ac-set', 'Ari Settings');
  const a2 = await acDevice('ac-set');
  assert.deepEqual(a1.hello.account.prefs, {}, 'nothing stored yet');
  const r = await a1.ok('prefs.set', { prefs: { theme: 'midnight', fontScale: 18, display: 'compact', keywords: ['glaze', 'Glaze', ' kiln '] } });
  assert.deepEqual(r.prefs.keywords, ['glaze', 'kiln'], 'words are trimmed and kept once');
  const ev = await a2.next('account', (d) => d.prefs);
  assert.equal(ev.prefs.theme, 'midnight');
  assert.equal(ev.prefs.fontScale, 18);
  await a1.none('account', (d) => d.prefs, 150); // the device that changed it already knows
  // Bad names and values never reach the database.
  assert.match(await a1.refused('prefs.set', { prefs: { css: 'body{}' } }), /isn’t a setting/);
  assert.match(await a1.refused('prefs.set', { prefs: { fontScale: 30 } }), /12 to 20/);
  assert.match(await a1.refused('prefs.set', { prefs: { theme: 'neon' } }), /choices/);
  assert.match(await a1.refused('prefs.set', { prefs: { zoom: 333 } }), /choices/);
  assert.match(await a1.refused('prefs.set', { prefs: { keywords: Array.from({ length: 11 }, (_, i) => `w${i}`) } }), /up to 10/);
  assert.match(await a1.refused('prefs.set', { prefs: { quiet: { on: true, from: 2000, to: 10, tz: 0 } } }), /start and an end/);
  assert.match(await a1.refused('prefs.set', { prefs: { mutedSounds: { 'bad id!': true } } }), /isn’t valid/);
  assert.match(await a1.refused('prefs.set', { prefs: 'theme=dark' }), /aren’t valid/);
  // null puts one back to its default; the rest stay.
  await a1.ok('prefs.set', { prefs: { display: null } });
  // A new device starts with them.
  const a3 = await acDevice('ac-set');
  assert.deepEqual(a3.hello.account.prefs, { theme: 'midnight', fontScale: 18, keywords: ['glaze', 'kiln'] });
  for (const c of [a1, a2, a3]) await c.close();
});

test('account: invisible shows as offline to everyone, Focused and auto-idle show to friends', async () => {
  const iv = await Client.make('ac-inv', 'Ivy Invisible');
  const fr = await Client.make('ac-inv-fr', 'Fred Friend');
  await acFriends(iv, fr);
  await iv.ok('me.update', { presence: 'offline' });
  assert.equal((await fr.next('user', (d) => d.user.id === iv.id)).user.presence, 'offline');
  assert.equal((await iv.next('user', (d) => d.user.id === iv.id)).user.presence, 'offline', 'they see their own choice');
  // Still connected, still invisible in a fresh snapshot.
  const fr2 = await acDevice('ac-inv-fr');
  assert.equal(fr2.hello.users[iv.id].presence, 'offline');
  // Coming back.
  await iv.ok('me.update', { presence: 'around' });
  assert.equal((await fr.next('user', (d) => d.user.id === iv.id)).user.presence, 'around');
  // Auto-idle: every tab that reports is idle, so Around shows as Away, marked idle.
  assert.deepEqual(await iv.ok('presence.idle', { idle: true }), { idle: true });
  const idle = (await fr.next('user', (d) => d.user.id === iv.id)).user;
  assert.equal(idle.presence, 'away');
  assert.equal(idle.idle, true);
  // A second tab in use keeps them Around.
  const iv2 = await acDevice('ac-inv');
  assert.deepEqual(await iv2.ok('presence.idle', { idle: false }), { idle: false });
  assert.equal((await fr.next('user', (d) => d.user.id === iv.id)).user.presence, 'around');
  // That tab closing leaves only the idle one: Away again.
  await iv2.close();
  assert.equal((await fr.next('user', (d) => d.user.id === iv.id && d.user.idle)).user.presence, 'away');
  // Focused stays Focused when idle; invisible stays offline when idle.
  await iv.ok('me.update', { presence: 'focus' });
  assert.equal((await fr.next('user', (d) => d.user.id === iv.id && d.user.presence === 'focus')).user.idle, false);
  await iv.ok('presence.idle', { idle: true });
  await iv.ok('me.update', { presence: 'offline' });
  await iv.ok('presence.idle', { idle: true });
  const last = (await fr.next('user', (d) => d.user.id === iv.id && d.user.presence === 'offline')).user;
  assert.equal(last.idle, false);
  for (const c of [iv, fr, fr2]) await c.close();
});

test('account: a custom status has an emoji and clears on time, told to everyone by the server', async () => {
  const st = await Client.make('ac-st', 'Sol Status');
  const fr = await Client.make('ac-st-fr', 'Fia Friend');
  await acFriends(st, fr);
  const { until } = await st.ok('status.set', { text: 'At the wheel', emoji: '🏺', clear: '30m' });
  assert.ok(until > Date.now() + 29 * 60_000 && until <= Date.now() + 30 * 60_000);
  const seen = (await fr.next('user', (d) => d.user.id === st.id && d.user.status === 'At the wheel')).user;
  assert.equal(seen.statusEmoji, '🏺');
  assert.equal(seen.statusUntil, until);
  assert.match(await st.refused('status.set', { text: 'x', emoji: '<b>hi</b>' }), /one emoji/);
  assert.match(await st.refused('status.set', { text: 'x', clear: 'tomorrow' }), /times a status can clear/);
  assert.match(await st.refused('status.set', { text: 'x', clear: 'today', until: Date.now() + 3 * 86_400_000 }), /end of your day/);
  assert.match(await st.refused('status.set', { text: 'x'.repeat(81) }), /at most 80/);
  // Run out: the view stops showing it at once, and the sweep tells everyone.
  srv.db.run('UPDATE users SET status_until = ? WHERE id = ?', Date.now() - 1000, st.id);
  assert.equal(srv.hub.userView(st.id).status, '', 'an expired status never shows');
  assert.ok(srv.hub.sweepStatuses() >= 1);
  const cleared = (await fr.next('user', (d) => d.user.id === st.id && d.user.status === '')).user;
  assert.equal(cleared.statusEmoji, null);
  // "Don't clear" keeps it.
  assert.equal((await st.ok('status.set', { text: 'Glazing', emoji: '🔥', clear: 'never' })).until, null);
  assert.equal(srv.hub.sweepStatuses(), 0);
  assert.equal(srv.hub.userView(st.id).status, 'Glazing');
  for (const c of [st, fr]) await c.close();
});

test('account: private notes reach only the writer’s devices', async () => {
  const nw = await Client.make('ac-note', 'Nia Notes');
  const nw2 = await acDevice('ac-note');
  const tg = await Client.make('ac-note-t', 'Tam Target');
  await acFriends(nw, tg);
  await nw.ok('note.set', { user: tg.id, note: 'Met at the glaze night. Likes celadon.' });
  assert.equal((await nw2.next('account', (d) => d.note)).note.note, 'Met at the glaze night. Likes celadon.');
  await tg.none('account', () => true, 150);
  assert.match(await nw.refused('note.set', { user: nw.id, note: 'me' }), /isn’t here/);
  assert.match(await nw.refused('note.set', { user: tg.id, note: 'x'.repeat(257) }), /at most 256/);
  const again = await acDevice('ac-note');
  assert.deepEqual(again.hello.account.notes, { [tg.id]: 'Met at the glaze night. Likes celadon.' });
  const theirs = await acDevice('ac-note-t');
  assert.deepEqual(theirs.hello.account.notes, {}, 'the person a note is about never gets it');
  await nw.ok('note.set', { user: tg.id, note: '' });
  assert.deepEqual((await acDevice('ac-note')).hello.account.notes, {});
  for (const c of [nw, nw2, tg, again, theirs]) await c.close();
});

test('account: profile: pronouns, accent, a longer About, and a banner only people who may see you can load', async () => {
  const pr = await Client.make('ac-pro', 'Pip Profile');
  const fr = await Client.make('ac-pro-fr', 'Fen Friend');
  const xx = await Client.make('ac-pro-x', 'Xan Stranger');
  await acFriends(pr, fr);
  await pr.ok('me.update', { pronouns: 'they/them', accent: 200, about: `**Potter.** ${'a'.repeat(300)}` });
  const v = (await fr.next('user', (d) => d.user.id === pr.id && d.user.pronouns)).user;
  assert.equal(v.pronouns, 'they/them');
  assert.equal(v.accent, 200);
  assert.ok(v.about.length > 300);
  assert.match(await pr.refused('me.update', { about: 'a'.repeat(401) }), /at most 400/);
  assert.match(await pr.refused('me.update', { accent: 400 }), /colours/);
  assert.match(await pr.refused('me.update', { pronouns: 'x'.repeat(41) }), /at most 40/);
  // A banner is checked from its bytes.
  const png = Buffer.alloc(40); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(960, 16); png.writeUInt32BE(320, 20);
  const up = (bytes, cookie) => fetch(`${base}/api/files?banner=1`, { method: 'POST', headers: { 'content-type': 'image/png', origin: base, cookie }, body: bytes });
  assert.equal((await up(Buffer.from('<svg onload=alert(1)>'.padEnd(40)), pr.cookie)).status, 415);
  const res = await up(png, pr.cookie);
  assert.equal(res.status, 201);
  const { id: banner } = await res.json();
  // Someone else's upload can't become your banner.
  const other = await (await up(png, xx.cookie)).json();
  assert.match(await pr.refused('me.update', { banner: other.id }), /Upload the banner/);
  await pr.ok('me.update', { banner });
  assert.equal((await fr.next('user', (d) => d.user.id === pr.id && d.user.banner)).user.banner, banner);
  const get = (cookie) => fetch(`${base}/api/banners/${banner}`, { headers: { cookie } });
  assert.equal((await get(fr.cookie)).status, 200);
  assert.equal((await get(pr.cookie)).status, 200);
  assert.equal((await get(xx.cookie)).status, 404, 'a stranger can’t load it');
  await pr.ok('me.update', { banner: null });
  assert.equal((await get(fr.cookie)).status, 404, 'an old banner stops being served');
  for (const c of [pr, fr, xx]) await c.close();
});

test('account: sessions list the device and last use; sign one out, or every other one', async () => {
  const me1 = await Client.make('ac-ses', 'Sam Sessions');
  const phone = await acDevice('ac-ses', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36');
  const desk = await acDevice('ac-ses', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Snug/0.5.0 Chrome/130.0 Electron/33.0 Safari/537.36');
  const { sessions } = await me1.ok('sessions.list');
  assert.equal(sessions.length, 3);
  assert.equal(sessions.filter((s) => s.current).length, 1);
  assert.ok(sessions.some((s) => s.agent === 'Chrome on Android'));
  assert.ok(sessions.some((s) => s.agent === 'Snug desktop on Windows'));
  assert.ok(sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id) && s.seen >= s.created));
  const mine = sessions.find((s) => s.current);
  assert.match(await me1.refused('sessions.revoke', { id: mine.id }), /this device/);
  assert.match(await me1.refused('sessions.revoke', { id: 'zz' }), /isn’t valid/);
  // Sign the phone out: only its socket closes, and its cookie stops working.
  const phoneId = sessions.find((s) => s.agent === 'Chrome on Android').id;
  const closing = acClosed(phone);
  await me1.ok('sessions.revoke', { id: phoneId });
  assert.equal(await closing, 4001);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: phone.cookie } })).status, 401);
  assert.equal(desk.ws.readyState, 1, 'the desktop stays signed in');
  // Every other one.
  const deskClosing = acClosed(desk);
  assert.deepEqual(await me1.ok('sessions.revokeOthers'), { ended: 1 });
  assert.equal(await deskClosing, 4001);
  assert.equal((await me1.ok('sessions.list')).sessions.length, 1);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: me1.cookie } })).status, 200);
  // Someone else's session id does nothing to theirs.
  const other = await Client.make('ac-ses-o', 'Oli Other');
  const theirs = (await other.ok('sessions.list')).sessions[0];
  assert.match(await me1.refused('sessions.revoke', { id: theirs.id }), /already ended/);
  for (const c of [me1, other]) await c.close();
});

test('account: TOTP follows RFC 6238; codes drift one step at most and are refused the second time', () => {
  // RFC 6238 appendix B (SHA-1): the secret is the ASCII "12345678901234567890".
  const key = Buffer.from('12345678901234567890');
  assert.equal(hotp(key, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(key, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(key, Math.floor(1234567890 / 30), 8), '89005924');
  assert.equal(hotp(key, Math.floor(20000000000 / 30), 8), '65353130');
  // RFC 4226 appendix D, counters 0 and 9.
  assert.equal(hotp(key, 0), '755224');
  assert.equal(hotp(key, 9), '520489');
  assert.deepEqual([...unbase32(base32(key))], [...key]);
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  const now = 1_700_000_000_000;
  const s = stepAt(now);
  assert.equal(totpMatch(key, totpAt(key, now), { now }), s);
  assert.equal(totpMatch(key, hotp(key, s - 1), { now }), s - 1, 'one step late is fine');
  assert.equal(totpMatch(key, hotp(key, s + 1), { now }), s + 1, 'one step early is fine');
  assert.equal(totpMatch(key, hotp(key, s - 2), { now }), -1, 'two steps is too far');
  assert.equal(totpMatch(key, hotp(key, s + 2), { now }), -1);
  assert.equal(totpMatch(key, totpAt(key, now), { now, after: s }), -1, 'a used step is refused');
  assert.equal(totpMatch(key, 'abcdef', { now }), -1);
  assert.equal(totpMatch(key, '12345', { now }), -1);
});

test('account: two-factor sign-in: turning it on, required at sign-in, replay refused, backup codes, turning it off', async () => {
  const tf = await Client.make('ac-2fa', 'Tove Twofactor');
  const begun = await tf.ok('totp.begin');
  assert.match(begun.uri, /^otpauth:\/\/totp\/Snug%3Aac-2fa\?secret=[A-Z2-7]{32}&issuer=Snug/);
  const key = unbase32(begun.secret);
  // Turning it on needs the password as well as a code: a stolen session alone
  // can't put its own authenticator on the account and lock the owner out.
  assert.match(await tf.refused('totp.enable', { code: totpAt(key, Date.now()) }), /password/);
  assert.match(await tf.refused('totp.enable', { code: totpAt(key, Date.now()), password: 'not my password' }), /password/);
  assert.equal(srv.db.get('SELECT enabled FROM totp WHERE user = ?', tf.id).enabled, 0, 'still off');
  assert.match(await tf.refused('totp.enable', { password: 'a long password', code: '000000' === totpAt(key, Date.now()) ? '111111' : '000000' }), /isn’t right/);
  const { codes } = await tf.ok('totp.enable', { password: 'a long password', code: totpAt(key, Date.now()) });
  assert.equal(codes.length, 10);
  assert.ok(codes.every((c) => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c)));
  srv.resetLimits(); // two-factor changes allow six tries in a burst
  assert.match(await tf.refused('totp.begin'), /already on/);
  // The password alone no longer signs in: no cookie, a ticket for the second step.
  const first = await acLogin('ac-2fa');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('set-cookie'), null);
  const { totp, ticket } = await first.json();
  assert.equal(totp, true);
  const step2 = (t, code) => post('/api/login/totp', { ticket: t, code });
  assert.equal((await step2(ticket, '12345')).status, 401);
  // The code just used to turn it on is spent: replaying it is refused.
  assert.equal((await step2(ticket, totpAt(key, Date.now()))).status, 401);
  // The next code (one step ahead, within the drift) works once.
  const next = hotp(key, stepAt(Date.now()) + 1);
  const ok = await step2(ticket, next);
  assert.equal(ok.status, 200, await ok.clone().text());
  const cookie = cookieOf(ok);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 200);
  assert.equal((await step2(ticket, next)).status, 401, 'a ticket is good for one sign-in');
  const t2 = (await (await acLogin('ac-2fa')).json()).ticket;
  assert.equal((await step2(t2, next)).status, 401, 'the same code twice is refused');
  // A backup code works once.
  assert.equal((await step2(t2, codes[0].toUpperCase())).status, 200);
  const t3 = (await (await acLogin('ac-2fa')).json()).ticket;
  assert.equal((await step2(t3, codes[0])).status, 401, 'a backup code is single-use');
  assert.equal((await step2('not-a-ticket', codes[1])).status, 401);
  srv.resetLimits(); // the sign-in limit (10 tries per 15 minutes from one address) is checked elsewhere
  // Five wrong codes (the spent backup code was the first) end the ticket, even for a right one after.
  for (let i = 0; i < 4; i++) assert.equal((await step2(t3, '000001')).status, 401);
  assert.equal((await step2(t3, codes[1])).status, 429);
  assert.equal((await step2(t3, codes[1])).status, 401, 'the ticket is gone');
  // A new password needs a code too.
  assert.equal((await post('/api/password', { current: 'a long password', next: 'another long password' }, tf.cookie)).status, 401);
  // New backup codes need the password and a code; the old ones stop working.
  assert.match(await tf.refused('totp.codes', { password: 'wrong', code: codes[3] }), /password/);
  assert.match(await tf.refused('totp.codes', { password: 'a long password' }), /code isn’t right/, 'the password alone isn’t enough');
  assert.match(await tf.refused('totp.codes', { password: 'a long password', code: '999999' }), /code isn’t right/);
  const { codes: fresh } = await tf.ok('totp.codes', { password: 'a long password', code: codes[3] });
  const t4 = (await (await acLogin('ac-2fa')).json()).ticket;
  assert.equal((await step2(t4, codes[2])).status, 401);
  srv.resetLimits();
  // Turning it off needs the password and a code.
  assert.match(await tf.refused('totp.disable', { password: 'a long password', code: '999999' }), /isn’t right/);
  assert.match(await tf.refused('totp.disable', { password: 'nope', code: fresh[0] }), /password/);
  await tf.ok('totp.disable', { password: 'a long password', code: fresh[0] });
  const plain = await acLogin('ac-2fa');
  assert.ok(plain.headers.get('set-cookie'), 'password alone signs in again');
  await tf.close();
});

test('account: export holds what you wrote; delete keeps your messages as Deleted user; deactivate until you sign in', async () => {
  const ow = await Client.make('ac-del-ow', 'Oda Owner');
  const dl = await Client.make('ac-del', 'Dee Deleting');
  const made = await ow.ok('house.create', { name: 'Export house', hue: 40 });
  const h = await ow.next('house', (d) => d.house.id === made.house);
  const room = Object.values(h.rooms).find((r) => r.kind === 'text').id;
  const { code } = await ow.ok('invite.create', { house: made.house });
  await dl.ok('invite.accept', { code });
  const mine = mid();
  await dl.ok('msg.send', { conv: room, id: mine, text: 'Mine to keep' });
  await ow.ok('msg.send', { conv: room, id: mid(), text: 'Not yours' });
  await dl.ok('prefs.set', { prefs: { theme: 'light' } });
  // Export: a JSON download of your own account and messages, nobody else's.
  const ex = await fetch(`${base}/api/account/export`, { headers: { cookie: dl.cookie } });
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-disposition'), /attachment; filename="snug-ac-del-/);
  const data = await ex.json();
  assert.equal(data.account.handle, 'ac-del');
  assert.equal(data.settings.theme, 'light');
  assert.deepEqual(data.messages.map((m) => m.text), ['Mine to keep']);
  assert.equal(data.messages[0].where, 'Export house / ' + h.rooms[room].name);
  assert.deepEqual(data.houses.map((x) => x.name), ['Export house']);
  assert.equal(JSON.stringify(data).includes('pass'), false, 'no password hash');
  // The only owner of a house with people in it has to hand it over first.
  const own = await post('/api/account/delete', { password: 'a long password', confirm: 'ac-del-ow' }, ow.cookie);
  assert.equal(own.status, 409);
  assert.match((await own.json()).error, /only owner of Export house/);
  // Wrong password, or the wrong username typed, is refused.
  assert.equal((await post('/api/account/delete', { password: 'nope', confirm: 'ac-del' }, dl.cookie)).status, 401);
  assert.equal((await post('/api/account/delete', { password: 'a long password', confirm: 'someone' }, dl.cookie)).status, 401);
  const closing = acClosed(dl);
  const del = await post('/api/account/delete', { password: 'a long password', confirm: '@ac-del' }, dl.cookie);
  assert.equal(del.status, 200);
  assert.equal(await closing, 4001);
  assert.match(del.headers.get('set-cookie'), /Max-Age=0/);
  // Their message stays, by "Deleted user"; they are out of the house; they can't sign in.
  const hist = await ow.ok('history', { conv: room });
  assert.ok(hist.msgs.some((m) => m.id === mine && m.text === 'Mine to keep'));
  const gone = srv.hub.userView(dl.id);
  assert.equal(gone.name, 'Deleted user');
  assert.equal(gone.deleted, true);
  assert.notEqual(gone.handle, 'ac-del');
  assert.equal(srv.M.isMember(made.house, dl.id), false);
  assert.equal((await acLogin('ac-del')).status, 401);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: dl.cookie } })).status, 401);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM user_prefs WHERE user = ?', dl.id).n, 0);
  // Deactivate: offline to everyone until they sign in again.
  const da = await Client.make('ac-deact', 'Dax Deactivating');
  await acFriends(ow, da);
  assert.equal((await post('/api/account/deactivate', { password: 'wrong' }, da.cookie)).status, 401);
  const daClosing = acClosed(da);
  assert.equal((await post('/api/account/deactivate', { password: 'a long password' }, da.cookie)).status, 200);
  assert.equal(await daClosing, 4001);
  assert.equal(srv.hub.userView(da.id).presence, 'offline');
  const back = await acDevice('ac-deact');
  assert.equal(srv.M.userRow(da.id).deactivated, null, 'signing in brings the account back');
  assert.notEqual((await ow.next('user', (d) => d.user.id === da.id && d.user.presence !== 'offline')).user.presence, 'offline');
  for (const c of [ow, back]) await c.close();
});

test('account: quiet hours keep pushes quiet; highlight words and @everyone count as mentions', async () => {
  const qa = await Client.make('ac-quiet', 'Quin Quiet');
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  await qa.ok('prefs.set', { prefs: { quiet: { on: true, from: (mins + 1430) % 1440, to: (mins + 10) % 1440, tz: 0 }, keywords: ['raku'] } });
  assert.equal(srv.M.quietFor(qa.id, 'someone', 'nowhere'), true, 'inside quiet hours');
  await qa.ok('prefs.set', { prefs: { quiet: { on: true, from: (mins + 60) % 1440, to: (mins + 120) % 1440, tz: 0 } } });
  assert.equal(srv.M.quietFor(qa.id, 'someone', 'nowhere'), false, 'outside them');
  assert.equal(srv.M.forMeExtra(qa.id, { text: 'Anyone for RAKU firing?', author: 'x' }, { type: 'dm' }), true);
  assert.equal(srv.M.forMeExtra(qa.id, { text: 'rakuware is different', author: 'x' }, { type: 'dm' }), false, 'whole words only');
  // Pure rules, across midnight and time zones.
  assert.equal(inQuiet({ on: true, from: 22 * 60, to: 7 * 60, tz: 0 }, Date.UTC(2026, 0, 1, 23, 30)), true);
  assert.equal(inQuiet({ on: true, from: 22 * 60, to: 7 * 60, tz: 0 }, Date.UTC(2026, 0, 1, 12, 0)), false);
  assert.equal(inQuiet({ on: true, from: 22 * 60, to: 7 * 60, tz: -60 }, Date.UTC(2026, 0, 1, 21, 30)), true, '21:30 UTC is 22:30 at UTC+1');
  assert.equal(inQuiet({ on: false, from: 0, to: 1439, tz: 0 }), false);
  assert.equal(hasKeyword('Ça va, café?', ['café']), true);
  assert.equal(everyonePing('hey @everyone look'), 'everyone');
  assert.equal(everyonePing('`@everyone` in code'), null);
  assert.equal(everyonePing('mail@here.com'), null);
  await qa.close();
});
// --- end account ----------------------------------------------------------------

// ---------- Integration across tracks ----------
test('integration: one role hierarchy for moderation, members and roles, counting extra roles; later ops go in the house log', async () => {
  const s = await placesHouse('ih', 1);
  const { ow, mm, m2, house, memberRole, crew, ownerRole } = s;
  const [x0] = s.more;
  // An Admin role above Crew, with Manage roles and every moderation right.
  const { id: admin } = await ow.ok('role.create', { house });
  await ow.ok('role.update', { house, role: admin, name: 'Admin', perms: ['post', 'roles', 'kick', 'timeout'] });
  await ow.ok('role.move', { house, role: admin, index: 1 }); // owner, Admin, Member, Crew
  await ow.ok('role.update', { house, role: memberRole, perms: ['post', 'roles', 'kick', 'timeout'] });
  await ow.ok('member.role', { house, user: m2.id, role: admin });
  // mm manages roles with the Member role: nobody at or above Member is theirs to change.
  assert.match(await mm.refused('member.role', { house, user: m2.id, role: memberRole }), /same as yours or above/);
  assert.match(await mm.refused('member.remove', { house, user: m2.id }), /same as yours or above/);
  await ow.ok('member.role', { house, user: x0.id, role: crew });
  assert.match(await mm.refused('member.role', { house, user: x0.id, role: admin }), /roles below your own/);
  assert.match(await mm.refused('member.role', { house, user: x0.id, role: memberRole }), /roles below your own/, 'not their own role either');
  await mm.ok('member.role', { house, user: x0.id, role: crew });
  assert.match(await mm.refused('role.update', { house, role: admin, perms: ['post'] }), /roles below your own/);
  assert.match(await mm.refused('role.update', { house, role: memberRole, perms: ['post', 'roles', 'ban'] }), /roles below your own/);
  assert.match(await mm.refused('role.delete', { house, role: admin }), /roles below your own/);
  await ow.ok('member.role', { house, user: x0.id, role: memberRole });
  assert.match(await mm.refused('member.role', { house, user: x0.id, role: crew }), /same as yours or above/, 'an equal is not below');
  await mm.ok('role.update', { house, role: crew, name: 'Crew and kiln' });
  assert.match(await mm.refused('mod.timeout', { house, user: m2.id, ms: 60_000 }), /same as yours or above/);
  // An extra role counts: with Admin as an extra role, mm now outranks Member and Crew people,
  // and may hand out Member, but still not Admin (equal) or the owner role.
  await ow.ok('member.roles', { house, user: mm.id, roles: [admin] });
  await mm.ok('member.role', { house, user: x0.id, role: crew });
  await mm.ok('member.role', { house, user: x0.id, role: memberRole });
  await mm.ok('mod.timeout', { house, user: x0.id, ms: 60_000 });
  assert.match(await mm.refused('mod.timeout', { house, user: m2.id, ms: 60_000 }), /same as yours or above/);
  assert.match(await mm.refused('member.role', { house, user: x0.id, role: ownerRole }), /Only an owner/);
  assert.match(await mm.refused('member.remove', { house, user: ow.id }), /owner/);
  // Owners are not limited.
  await ow.ok('role.update', { house, role: admin, perms: ['post', 'roles', 'kick', 'timeout', 'audit'] });

  // Changes made through places, voice options and messaging ops reach the house log.
  await ow.ok('room.private', { room: s.notices, on: true });
  await ow.ok('room.voice', { room: s.voice, limit: 4 });
  await ow.ok('house.soundboard', { house, open: false });
  await ow.ok('member.profile', { house, user: x0.id, nick: 'Xan the Kiln' });
  const { entries } = await ow.ok('audit.list', { house });
  const kinds = entries.map((e) => e.action);
  for (const k of ['room.private', 'room.voice', 'house.soundboard', 'member.profile', 'member.roles', 'role.move', 'member.role', 'member.timeout']) {
    assert.ok(kinds.includes(k), `${k} is in the house log`);
  }
  assert.equal(entries.find((e) => e.action === 'member.profile').detail.nick, 'Xan the Kiln');
  // Refused changes write nothing.
  assert.equal(kinds.filter((k) => k === 'role.delete').length, 0);

  // A role mention counts as for you in the push service, as in the browser: a
  // mentionable role you have (extra roles too), whole names only.
  const w = { type: 'room', house, room: s.lounge };
  assert.equal(srv.M.forMeExtra(mm.id, { text: 'kiln is hot, @admin', author: ow.id }, w), true, 'an extra role');
  assert.equal(srv.M.forMeExtra(m2.id, { text: 'kiln is hot, @Admin!', author: ow.id }, w), true);
  assert.equal(srv.M.forMeExtra(x0.id, { text: 'kiln is hot, @admin', author: ow.id }, w), false, 'not their role');
  assert.equal(srv.M.forMeExtra(m2.id, { text: 'kiln is hot, @administrators', author: ow.id }, w), false, 'whole names');
  await ow.ok('role.update', { house, role: admin, mentionable: false });
  assert.equal(srv.M.forMeExtra(m2.id, { text: 'kiln is hot, @admin', author: ow.id }, w), false, 'not mentionable');

  // An event made in a room that later goes private keeps its title for the
  // house, but only people who can see the room learn which room it is.
  const { id: shed } = await ow.ok('room.create', { house, name: 'Kiln shed', kind: 'text' });
  const { id: ev } = await ow.ok('event.create', { house, title: 'Glaze firing', starts: Date.now() + 3_600_000, room: shed });
  await ow.ok('room.private', { room: shed, on: true });
  x0.events.length = 0; ow.events.length = 0;
  await ow.ok('event.rsvp', { event: ev, going: false }); // the maker was going
  assert.equal((await x0.next('event', (d) => d.event.id === ev && !d.event.going.length)).event.room, null);
  assert.equal((await ow.next('event', (d) => d.event.id === ev && !d.event.going.length)).event.room, shed);
  await x0.close(); await x0.connect();
  assert.equal(x0.hello.events[ev].room, null, 'and in a fresh snapshot');
  assert.equal(x0.hello.events[ev].title, 'Glaze firing');

  // Poll votes follow the same rules as reacting: blocks in a one-to-one conversation stop them.
  await ow.ok('mod.timeout', { house, user: x0.id, ms: 0 });
  const { id: dm } = await mm.ok('dm.open', { users: [x0.id] });
  const poll = mid();
  await mm.ok('poll.create', { conv: dm, id: poll, question: 'Raku or salt?', hours: 24, answers: [{ text: 'Raku' }, { text: 'Salt' }] });
  await x0.ok('block.set', { user: mm.id, on: true });
  assert.match(await x0.refused('poll.vote', { conv: dm, id: poll, answers: [0] }), /can’t do that with this person/);
  await x0.ok('block.set', { user: mm.id, on: false });
  await x0.ok('poll.vote', { conv: dm, id: poll, answers: [0] });
  for (const c of [ow, mm, m2, x0]) await c.close();
});

// ---------- Security review: regressions ----------
const FILTER_OFF = { words: [], links: false, action: 'block' };

test('security: a moderator who can’t see a private room gets neither its reports nor its words and name from the house log', async () => {
  const s = await placesHouse('sec1');
  const { ow, mm, m2, house, lounge } = s;
  // m2 moderates and reads the log, but can't see "Staff only"; mm can, by an override.
  const { id: modRole } = await ow.ok('role.create', { house });
  await ow.ok('role.update', { house, role: modRole, name: 'Mods', perms: ['post', 'moderate', 'audit'] });
  await ow.ok('member.role', { house, user: m2.id, role: modRole });
  const { id: secret } = await ow.ok('room.create', { house, name: 'Staff only', kind: 'text' });
  await ow.ok('room.private', { room: secret, on: true });
  await ow.ok('room.override', { room: secret, type: 'member', target: mm.id, allow: ['view', 'send'], deny: [] });
  assert.equal(srv.M.canRead(m2.id, secret), false);
  assert.equal(srv.M.canRead(mm.id, secret), true);
  const m1 = mid();
  await ow.ok('msg.send', { conv: secret, id: m1, text: 'TOP SECRET payroll numbers' });
  await mm.ok('report.create', { conv: secret, msg: m1, reason: 'other' });
  // A word-filter flag in the private room goes to the same queue.
  await ow.ok('automod.set', { house, words: ['badword'], action: 'flag' });
  await mm.ok('msg.send', { conv: secret, id: mid(), text: 'a badword in private' });
  // And a report in a room everyone sees, for comparison.
  const pub = mid();
  await ow.ok('msg.send', { conv: lounge, id: pub, text: 'a public message' });
  await mm.ok('report.create', { conv: lounge, msg: pub, reason: 'spam' });

  const theirs = await m2.ok('report.list', { house });
  assert.deepEqual(theirs.reports.map((r) => r.text), ['a public message'], 'only the report from a room they can see');
  assert.equal(JSON.stringify(theirs).includes('TOP SECRET'), false);
  assert.equal(JSON.stringify(theirs).includes('badword in private'), false);
  const owners = await ow.ok('report.list', { house });
  assert.equal(owners.reports.length, 3, 'the owner sees every report');
  assert.equal(srv.M.houseView(house, m2.id).house.reportsOpen, 1, 'the count is only what they may see');
  assert.equal(srv.M.houseView(house, ow.id).house.reportsOpen, 3);
  const hidden = owners.reports.find((r) => r.text === 'TOP SECRET payroll numbers');
  assert.match(await m2.refused('report.resolve', { id: hidden.id, status: 'dismissed' }), /doesn’t exist/);

  // The log: a deleted message's words and the room's name stay with people who can see it.
  const m3 = mid();
  await mm.ok('msg.send', { conv: secret, id: m3, text: 'private member note in staff room' });
  await ow.ok('msg.delete', { conv: secret, id: m3 });
  const log = (await m2.ok('audit.list', { house })).entries;
  const text = JSON.stringify(log);
  assert.equal(text.includes('private member note'), false, 'no deleted words');
  assert.equal(text.includes('Staff only'), false, 'no room name');
  const del = log.find((e) => e.action === 'msg.delete');
  assert.equal(del.detail.text, '');
  assert.equal(del.detail.hidden, true);
  for (const k of ['room.create', 'room.private', 'room.override']) {
    const e = log.find((x) => x.action === k && x.target === secret);
    assert.ok(e, `${k} is still listed`);
    assert.equal(e.detail.name, 'a private room');
  }
  const full = JSON.stringify((await ow.ok('audit.list', { house })).entries);
  assert.ok(full.includes('private member note') && full.includes('Staff only'), 'the owner sees all of it');
  // Once m2 may see the room, they see it all.
  await ow.ok('room.override', { room: secret, type: 'member', target: m2.id, allow: ['view'], deny: [] });
  assert.ok(JSON.stringify((await m2.ok('audit.list', { house })).entries).includes('Staff only'));
  assert.equal((await m2.ok('report.list', { house })).reports.length, 3);
  await ow.ok('automod.set', { house, ...FILTER_OFF });
  for (const c of [ow, mm, m2]) await c.close();
});

test('security: Manage roles can’t hand out permissions you lack, or change your own or a higher person’s roles', async () => {
  const s = await placesHouse('sec2', 1);
  const { ow, mm, m2, house, crew, memberRole } = s;
  const [x0] = s.more;
  // An Admin with only post and roles, above Member and Crew.
  const { id: admin } = await ow.ok('role.create', { house });
  await ow.ok('role.update', { house, role: admin, name: 'Admin', perms: ['post', 'roles'] });
  await ow.ok('role.move', { house, role: admin, index: 1 });
  await ow.ok('member.role', { house, user: mm.id, role: admin });
  // A role of their own making can only carry what they have.
  const { id: evil } = await mm.ok('role.create', { house });
  assert.match(await mm.refused('role.update', { house, role: evil, perms: ['post', 'ban', 'kick', 'timeout', 'audit', 'voicemod', 'moderate', 'rooms'] }), /permissions you have yourself/);
  assert.deepEqual(JSON.parse(srv.db.get('SELECT perms FROM roles WHERE id = ?', evil).perms), ['post'], 'nothing changed');
  await mm.ok('role.update', { house, role: evil, perms: ['post', 'roles'] });
  // Never onto themselves, even a role below them.
  assert.match(await mm.refused('member.roles', { house, user: mm.id, roles: [evil] }), /your own roles/);
  await ow.ok('role.update', { house, role: crew, perms: ['post', 'ban'] }); // an owner may
  assert.match(await mm.refused('member.roles', { house, user: mm.id, roles: [crew] }), /your own roles/);
  assert.equal(srv.M.can(mm.id, house, 'ban'), false, 'still no ban');
  // Keeping a permission an owner gave, or taking it away, is fine.
  await mm.ok('role.update', { house, role: crew, name: 'Crew and kiln', perms: ['post', 'ban'] });
  await mm.ok('role.update', { house, role: crew, perms: ['post'] });
  await ow.ok('role.update', { house, role: crew, perms: ['post', 'ban'] });
  // Not on an equal or someone higher: m2 is an Admin too, and the owner is above everyone.
  await ow.ok('member.role', { house, user: m2.id, role: admin });
  await ow.ok('member.roles', { house, user: m2.id, roles: [crew] });
  assert.match(await mm.refused('member.roles', { house, user: m2.id, roles: [] }), /same as yours or above/);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM member_roles WHERE house = ? AND user = ?', house, m2.id).n, 1, 'their extra role stays');
  assert.match(await mm.refused('member.roles', { house, user: ow.id, roles: [crew] }), /owner/);
  // Someone below them is still theirs to manage.
  assert.equal(srv.M.rankOf(house, x0.id) > srv.M.rankOf(house, mm.id), true);
  await mm.ok('member.roles', { house, user: x0.id, roles: [crew] });
  await mm.ok('member.roles', { house, user: x0.id, roles: [] });
  void memberRole;
  for (const c of [ow, mm, m2, x0]) await c.close();
});

test('security: deleting or deactivating an account drops its scheduled messages; the scheduler never sends as a deleted person', async () => {
  const a = await Client.make('sec3-a', 'Ash Leaving');
  const b = await Client.make('sec3-b', 'Bee Staying');
  const d = await Client.make('sec3-d', 'Dot Pausing');
  await acFriends(a, b);
  await acFriends(d, b);
  const { id: dm } = await a.ok('dm.open', { users: [b.id] });
  const { id: dm2 } = await d.ok('dm.open', { users: [b.id] });
  const soon = Date.now() + 5 * 60_000;
  await a.ok('sched.create', { conv: dm, text: 'sent from beyond the grave', at: soon });
  await d.ok('sched.create', { conv: dm2, text: 'sent while away', at: soon });
  const closing = acClosed(a);
  assert.equal((await post('/api/account/delete', { password: 'a long password', confirm: 'sec3-a' }, a.cookie)).status, 200);
  await closing;
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM scheduled WHERE user = ?', a.id).n, 0, 'deleting drops them');
  const pausing = acClosed(d);
  assert.equal((await post('/api/account/deactivate', { password: 'a long password' }, d.cookie)).status, 200);
  await pausing;
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM scheduled WHERE user = ?', d.id).n, 0, 'deactivating drops them');
  // Even a row that's still there (an older server, a race) is never sent.
  for (const [u, conv] of [[a.id, dm], [d.id, dm2]]) {
    srv.db.run('INSERT INTO scheduled (id, user, conv, text, reply_to, at, created) VALUES (?, ?, ?, ?, NULL, ?, ?)', `sch_sec3${u.slice(-6)}`, u, conv, 'sent from beyond the grave', Date.now() - 1, Date.now());
  }
  srv.hub.messaging.tick();
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM messages WHERE text = 'sent from beyond the grave'").n, 0);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM scheduled WHERE text = 'sent from beyond the grave'").n, 0, 'and the row is gone');
  await b.none('msg', (x) => x.m.text === 'sent from beyond the grave', 150);
  await b.close();
});

test('security: poll answers and forwarded words go through the house’s word and link filter', async () => {
  const s = await placesHouse('sec5');
  const { ow, mm, m2, house, lounge } = s;
  await ow.ok('automod.set', { house, words: ['badword'], links: true, action: 'block' });
  assert.match(await mm.refused('msg.send', { conv: lounge, id: mid(), text: 'a badword' }), /word this house doesn’t allow/);
  const answers = (t) => [{ text: t }, { text: 'Fine' }];
  assert.match(await mm.refused('poll.create', { conv: lounge, id: mid(), question: 'Which?', hours: 24, answers: answers('badword') }), /word this house doesn’t allow/);
  assert.match(await mm.refused('poll.create', { conv: lounge, id: mid(), question: 'Which?', hours: 24, answers: answers('https://evil.example/x') }), /Links aren’t allowed/);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM polls WHERE question = 'Which?'").n, 0);
  // Forwarding from a direct conversation (no filter there) into the house.
  const { id: dm } = await mm.ok('dm.open', { users: [m2.id] });
  const src = mid();
  await m2.ok('msg.send', { conv: dm, id: src, text: 'badword https://evil.example/x' });
  assert.match(await mm.refused('msg.forward', { conv: dm, id: src, to: lounge, newId: mid() }), /word this house doesn’t allow|Links aren’t allowed/);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM messages WHERE conv = ? AND fwd IS NOT NULL", lounge).n, 0);
  // Into another direct conversation: no house, no filter.
  const { id: dmOw } = await mm.ok('dm.open', { users: [ow.id] });
  await mm.ok('msg.forward', { conv: dm, id: src, to: dmOw, newId: mid() });
  // "Flag" lets them through and files a report saying where the word was.
  await ow.ok('automod.set', { house, action: 'flag' });
  const poll = mid();
  await mm.ok('poll.create', { conv: lounge, id: poll, question: 'Which glaze?', hours: 24, answers: answers('badword') });
  const fid = mid();
  await mm.ok('msg.forward', { conv: dm, id: src, to: lounge, newId: fid });
  const q = (await ow.ok('report.list', { house })).reports.filter((r) => r.reason === 'filter');
  assert.ok(q.some((r) => r.msg === poll && /^Answers\. /.test(r.note)), 'the poll is flagged');
  assert.ok(q.some((r) => r.msg === fid && /^Forwarded\. /.test(r.note)), 'the forward is flagged');
  await ow.ok('automod.set', { house, ...FILTER_OFF });
  for (const c of [ow, mm, m2]) await c.close();
});

test('security: the second sign-in step allows ten codes per account per 15 minutes, whatever the address', async () => {
  const xdir = mkdtempSync(join(tmpdir(), 'snug-totp-'));
  const xs = await startServer({ port: 0, dataDir: xdir, quiet: true, trustProxy: true });
  const xbase = `http://127.0.0.1:${xs.port}`;
  try {
    const xpost = (path, body, ip) => fetch(xbase + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: xbase, 'x-forwarded-for': ip }, body: JSON.stringify(body) });
    const reg = await xpost('/api/register', { handle: 'sec6', name: 'Six Guessed', password: 'a long password' }, '10.9.0.1');
    assert.equal(reg.status, 201);
    const uid = (await reg.json()).user.id;
    const key = Buffer.from('12345678901234567890');
    xs.db.run('INSERT INTO totp (user, secret, enabled, step, backup, created) VALUES (?, ?, 1, 0, ?, ?)', uid, base32(key), '[]', Date.now());
    let n = 0;
    const ticket = async () => (await (await xpost('/api/login', { handle: 'sec6', password: 'a long password' }, `10.8.0.${++n}`)).json()).ticket;
    // Ten wrong guesses, each from a new address, five to a ticket.
    let t;
    for (let i = 0; i < 10; i++) {
      if (i % 5 === 0) t = await ticket();
      assert.equal((await xpost('/api/login/totp', { ticket: t, code: '000000' === totpAt(key, Date.now()) ? '111111' : '000000' }, `10.7.0.${i}`)).status, 401);
    }
    // The eleventh, even the right code from yet another address, waits.
    const res = await xpost('/api/login/totp', { ticket: await ticket(), code: totpAt(key, Date.now()) }, '10.6.0.1');
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /Too many attempts/);
    xs.resetLimits();
    const ok = await xpost('/api/login/totp', { ticket: await ticket(), code: totpAt(key, Date.now()) }, '10.6.0.2');
    assert.equal(ok.status, 200, 'after the wait, the right code works');
  } finally { await xs.close(); rmSync(xdir, { recursive: true, force: true }); }
});

test('security: a timeout stops editing too; a banned person’s webhook addresses stop working', async () => {
  const s = await placesHouse('sec7');
  const { ow, mm, m2, house, lounge, memberRole } = s;
  const m3 = mid();
  await mm.ok('msg.send', { conv: lounge, id: m3, text: 'hello' });
  await ow.ok('mod.timeout', { house, user: mm.id, ms: 60_000 });
  assert.match(await mm.refused('msg.edit', { conv: lounge, id: m3, text: 'edited while timed out' }), /timed out/);
  assert.equal(srv.M.msg(m3).text, 'hello');
  await ow.ok('mod.timeout', { house, user: mm.id, ms: 0 });
  await mm.ok('msg.edit', { conv: lounge, id: m3, text: 'edited after' });
  // Webhooks: m2 makes one, then is banned.
  await ow.ok('role.update', { house, role: memberRole, perms: ['post', 'rooms'] });
  const { url } = await m2.ok('hook.create', { room: lounge, name: 'Kiln sensor' });
  const { url: ownUrl } = await ow.ok('hook.create', { room: lounge, name: 'Owner’s' });
  const hit = (u) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'kiln at 1200' }) });
  assert.equal((await hit(url)).status, 200);
  await ow.ok('mod.ban', { house, user: m2.id });
  assert.equal((await hit(url)).status, 401, 'the banned person’s address is revoked');
  assert.equal((await hit(ownUrl)).status, 200, 'other webhooks keep working');
  await ow.ok('mod.unban', { house, user: m2.id });
  await ow.ok('role.update', { house, role: memberRole, perms: ['post'] });
  for (const c of [ow, mm, m2]) await c.close();
});

test('security: an invisible person’s custom status reaches only their own devices', async () => {
  const iv = await Client.make('sec8', 'Ivo Invisible');
  const fr = await Client.make('sec8-fr', 'Fay Friend');
  await acFriends(iv, fr);
  await iv.ok('me.update', { presence: 'offline' });
  await fr.next('user', (d) => d.user.id === iv.id && d.user.presence === 'offline');
  fr.events.length = 0;
  await iv.ok('status.set', { text: 'Secretly glazing', emoji: '🏺', clear: 'never' });
  const mine = await iv.next('user', (d) => d.user.id === iv.id && d.user.status === 'Secretly glazing');
  assert.equal(mine.user.statusEmoji, '🏺', 'they see their own status');
  await fr.none('user', (d) => d.user.id === iv.id, 250);
  assert.equal(srv.hub.userView(iv.id).status, '');
  assert.equal(srv.hub.userView(iv.id).statusEmoji, null);
  const fr2 = await acDevice('sec8-fr');
  assert.equal(fr2.hello.users[iv.id].status, '', 'nor in a fresh snapshot');
  assert.equal(fr2.hello.users[iv.id].statusEmoji, null);
  const iv2 = await acDevice('sec8');
  assert.equal(iv2.hello.users[iv.id].status, 'Secretly glazing', 'their own snapshot has it');
  // Coming back shows it.
  await iv.ok('me.update', { presence: 'around' });
  assert.equal((await fr.next('user', (d) => d.user.id === iv.id && d.user.presence === 'around')).user.status, 'Secretly glazing');
  for (const c of [iv, fr, fr2, iv2]) await c.close();
});

test('security: a malformed percent-encoding in a file name, an address or a cookie is a client error, never a crash', async () => {
  const s = await placesHouse('sec9');
  const { ow, house } = s;
  const png = Buffer.alloc(40); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(64, 16); png.writeUInt32BE(64, 20);
  const up = (path) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'image/png', origin: base, cookie: ow.cookie, 'x-file-name': '%E0%A4%A' }, body: png });
  const st = await up(`/api/files?sticker=${house}`);
  assert.equal(st.status, 201, await st.clone().text());
  assert.equal((await st.json()).name, '%E0%A4%A', 'kept as it came');
  const em = await up(`/api/files?emoji=${house}`);
  assert.equal(em.status, 201, await em.clone().text());
  const fl = await up(`/api/files?conv=${s.lounge}`);
  assert.equal(fl.status, 201, await fl.clone().text());
  // Before, a bad address rejected outside the handler's try: an unhandled rejection that stops Node.
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: 'snug_session=%E0%A4%A' } })).status, 401);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: ow.cookie } })).status, 200, 'the server is still up');
  for (const c of [ow, s.mm, s.m2]) await c.close();
});

test('review: the house log says which of a nickname, picture or colour changed; “Today” allows a 25-hour day', async () => {
  const s = await placesHouse('rv1');
  const { ow, mm, m2, house } = s;
  await ow.ok('member.profile', { house, user: mm.id, emoji: '🦊' });
  await ow.ok('member.profile', { house, user: mm.id, nick: 'Mik', hue: 200 });
  await ow.ok('member.profile', { house, user: mm.id, nick: null });
  await ow.ok('member.profile', { house, user: mm.id, nick: null }); // nothing changed: nothing logged
  const e = (await ow.ok('audit.list', { house, action: 'member.profile' })).entries.map((x) => x.detail);
  assert.deepEqual(e, [{ fields: ['nick'], nick: null }, { fields: ['nick', 'hue'], nick: 'Mik' }, { fields: ['emoji'], nick: null }]);
  // The end of a day the clocks go back on is up to 25 hours away.
  const { until } = await m2.ok('status.set', { text: 'Firing', clear: 'today', until: Date.now() + 24.9 * 3_600_000 });
  assert.ok(until > Date.now() + 24 * 3_600_000);
  assert.match(await m2.refused('status.set', { text: 'x', clear: 'today', until: Date.now() + 27 * 3_600_000 }), /end of your day/);
  for (const c of [ow, mm, m2]) await c.close();
});

test('security: a timeout takes away pinning, managing and moderating too, not just writing; reading and deleting your own stay', async () => {
  const s = await placesHouse('sec10');
  const { ow, mm, m2, house, lounge, memberRole } = s;
  const mine = mid(), theirs = mid();
  await mm.ok('msg.send', { conv: lounge, id: mine, text: 'mine' });
  await m2.ok('msg.send', { conv: lounge, id: theirs, text: 'theirs' });
  await ow.ok('role.update', { house, role: memberRole, perms: ['post', 'pin', 'rooms', 'announce', 'highlight', 'invite', 'emoji', 'moderate'] });
  const forum = await ow.ok('room.create', { house, name: 'Forum', kind: 'forum' });
  const post = mid();
  await mm.ok('forum.post', { room: forum.id, id: post, title: 'My post', text: 'body' });
  const { hook } = await mm.ok('hook.create', { room: lounge, name: 'Kiln' });
  await ow.ok('mod.timeout', { house, user: mm.id, ms: 60_000 });
  for (const [op, d] of [
    ['msg.pin', { conv: lounge, id: theirs }], ['highlight.set', { conv: lounge, id: theirs, on: true }],
    ['forum.edit', { id: post, title: 'Renamed while timed out' }], ['hook.create', { room: lounge, name: 'Another' }],
    ['hook.delete', { hook: hook.id }], ['event.create', { house, title: 'Party', starts: Date.now() + 3_600_000 }],
    ['room.create', { house, name: 'sneaky', kind: 'text' }], ['invite.create', { house }],
    ['msg.delete', { conv: lounge, id: theirs }], ['member.profile', { house, user: mm.id, nick: 'Sneaky' }],
  ]) assert.match(await mm.refused(op, d), /timed out/, op);
  assert.equal(srv.db.get('SELECT title FROM forum_posts WHERE msg = ?', post).title, 'My post');
  assert.ok(srv.M.liveMsg(theirs), 'their message is still there');
  // Reading and taking your own words back still work.
  await mm.ok('history', { conv: lounge });
  await mm.ok('msg.delete', { conv: lounge, id: mine });
  // Once the timeout ends, everything comes back.
  await ow.ok('mod.timeout', { house, user: mm.id, ms: 0 });
  await mm.ok('msg.pin', { conv: lounge, id: theirs });
  await mm.ok('forum.edit', { id: post, title: 'Renamed after' });
  await ow.ok('role.update', { house, role: memberRole, perms: ['post'] });
  for (const c of [ow, mm, m2]) await c.close();
});
