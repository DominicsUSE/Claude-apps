// Integration tests against the real server: accounts, permissions, live
// delivery between separate users, persistence across a restart, and the
// rules that keep people out of places they don't belong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-test-'));
let srv, base;
const boot = async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; };
test.before(boot);
test.beforeEach(() => srv.hub.resetLimits());
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
  for (const [path, type] of [['/', 'text/html'], ['/js/app.js', 'text/javascript'], ['/css/tokens.css', 'text/css'], ['/js/views/auth.js', 'text/javascript'], ['/fonts/ahn-latin.woff2', 'font/woff2'], ['/vendor/preact-htm.js', 'text/javascript']]) {
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
