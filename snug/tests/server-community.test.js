// Houses and community on the real server (server/community.js): categories
// and room order, house pictures, deleting and handing over a house, the new
// permissions, event editing and reminders, spam rules, verification,
// pausing invitations, custom links and join announcements. Every rule is
// checked from separate signed-in sockets, never trusted from the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { migrateCommunity } from '../server/community.js';
import { deflateSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'snug-community-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
// A real PNG of one colour, w x h.
function png(w, h, rgb = [240, 90, 71]) {
  const table = Array.from({ length: 256 }, (_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let n = 0;
const mid = () => `m_cm${Date.now().toString(36)}${(n++).toString(36)}xx`;

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
        if (m.t === 'hello') { this.hello = m.d; resolve(this); } else if (m.t === 'ack') this.acks.get(m.id)?.(m); else if (m.t === 'ev') this.events.push(m);
      });
    });
  }
  async reconnect() { this.ws.close(); await this.connect(); return this.hello; }
  op(op, d = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ t: 'op', id, op, d })); return new Promise((r) => this.acks.set(id, r)); }
  async ok(op, d) { const a = await this.op(op, d); assert.equal(a.ok, true, `${op}: ${a.error}`); return a.d; }
  async refused(op, d) { const a = await this.op(op, d); assert.equal(a.ok, false, `${op} should be refused`); return a.error; }
  async next(ev, pred = () => true, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  async none(ev, pred = () => true, ms = 300) {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.events.some((e) => e.ev === ev && pred(e.d)), false, `no "${ev}" should arrive`);
  }
  upload(buf, q, type = 'image/png') {
    return fetch(`${base}/api/files?${q}`, { method: 'POST', headers: { 'content-type': type, origin: base, cookie: this.cookie }, body: buf });
  }
  get(path) { return fetch(base + path, { headers: { cookie: this.cookie } }); }
  send(conv, text) { return this.op('msg.send', { conv, id: mid(), text }); }
}

// A house owned by `owner` with the others joined by an invitation link.
async function houseWith(owner, others, name = 'Glaze lab') {
  const { house, room } = await owner.ok('house.create', { name, hue: 25 });
  const { code } = await owner.ok('invite.create', { house });
  for (const c of others) await c.ok('invite.accept', { code });
  return { house, room, code };
}
const view = (c, house) => c.reconnect().then((h) => h.houses[house]);
const roleIds = (house) => srv.db.all('SELECT id FROM roles WHERE house = ? ORDER BY pos', house).map((r) => r.id);
const setPerms = (role, perms) => srv.db.run('UPDATE roles SET perms = ? WHERE id = ?', JSON.stringify(perms), role);

let ava, bo, cy, dee, H;
test.before(async () => {
  while (!base) await new Promise((r) => setTimeout(r, 20));
  ava = await Client.make('ava_c', 'Ava');
  bo = await Client.make('bo_c', 'Bo');
  cy = await Client.make('cy_c', 'Cy');
  dee = await Client.make('dee_c', 'Dee');
  H = await houseWith(ava, [bo, cy]);
});

// ---------- Categories and room order ----------
test('categories: only room managers make, rename, move and delete them', async () => {
  assert.match(await bo.refused('group.create', { house: H.house, name: 'Kilns' }), /can’t manage rooms/);
  const { id: g } = await ava.ok('group.create', { house: H.house, name: 'Kilns' });
  await bo.next('house', (d) => d.house.id === H.house && d.house.groups.some((x) => x.id === g && x.name === 'Kilns'));
  assert.match(await bo.refused('group.update', { group: g, name: 'Ovens' }), /can’t manage rooms/);
  await ava.ok('group.update', { group: g, name: 'Kiln talk' });
  await ava.ok('group.move', { group: g, to: 0 });
  const v = await view(bo, H.house);
  assert.equal(v.groups[0].id, g, 'moved to the top for everyone');
  assert.equal(v.groups[0].name, 'Kiln talk');
  assert.match(await ava.refused('group.create', { house: H.house, name: '' }), /can’t be empty/);
});

test('room.move: into another category at a place, persisted in the snapshot, live for others', async () => {
  const before = await view(ava, H.house);
  const live = before.groups.find((g) => g.name === 'Live');
  const rooms = before.groups.find((g) => g.name === 'Rooms');
  const lounge = H.room;
  assert.match(await bo.refused('room.move', { room: lounge, group: live.id, to: 0 }), /can’t move rooms/);
  await ava.ok('room.move', { room: lounge, group: live.id, to: 0 });
  const ev = await bo.next('house', (d) => d.house.id === H.house && d.house.groups.find((g) => g.id === live.id)?.rooms[0] === lounge);
  assert.ok(!ev.house.groups.find((g) => g.id === rooms.id).rooms.includes(lounge), 'it left its old category');
  const snap = await view(cy, H.house);
  assert.equal(snap.groups.find((g) => g.id === live.id).rooms[0], lounge, 'the order persists');
  // Within one category: to the end.
  await ava.ok('room.move', { room: lounge, to: 99 });
  const after = await view(cy, H.house);
  const order = after.groups.find((g) => g.id === live.id).rooms;
  assert.equal(order[order.length - 1], lounge);
  assert.match(await ava.refused('room.move', { room: lounge, group: live.id, to: -1 }), /isn’t valid/);
});

test('ids from another house are refused', async () => {
  const other = await houseWith(ava, [], 'Second house');
  const otherGroup = (await view(ava, other.house)).groups[0].id;
  assert.match(await ava.refused('room.move', { room: H.room, group: otherGroup, to: 0 }), /isn’t in this house/);
  // bo isn't in the second house: its categories aren't his to touch.
  assert.match(await bo.refused('group.update', { group: otherGroup, name: 'Mine' }), /not a member/);
  assert.match(await ava.refused('group.delete', { group: (await view(ava, H.house)).groups[0].id, moveTo: otherGroup }), /another category in this house/);
});

test('deleting a category moves its rooms; the last one stays', async () => {
  const solo = await houseWith(ava, [], 'Solo');
  const v = await view(ava, solo.house);
  const [first, second] = v.groups;
  await ava.ok('group.delete', { group: second.id, moveTo: first.id });
  const after = await view(ava, solo.house);
  assert.equal(after.groups.length, 1);
  assert.ok(second.rooms.every((r) => after.groups[0].rooms.includes(r)), 'its rooms moved');
  assert.match(await ava.refused('group.delete', { group: first.id }), /at least one category/);
  const log = await ava.ok('audit.list', { house: solo.house });
  assert.ok(log.entries.some((e) => e.action === 'group.delete'), 'in the house log');
});

// ---------- Finer permissions ----------
test('react: a role without it is refused; taking back your own reaction always works', async () => {
  const [, member] = roleIds(H.house);
  const { m } = await ava.ok('msg.send', { conv: H.room, id: mid(), text: 'React to this' });
  await bo.ok('react', { conv: H.room, id: m.id, emoji: '👍', on: true });
  const perms = JSON.parse(srv.db.get('SELECT perms FROM roles WHERE id = ?', member).perms);
  assert.ok(perms.includes('react'), 'new houses give members reactions');
  setPerms(member, perms.filter((p) => p !== 'react'));
  assert.match(await bo.refused('react', { conv: H.room, id: m.id, emoji: '🎉', on: true }), /can’t add reactions/);
  await bo.ok('react', { conv: H.room, id: m.id, emoji: '👍', on: false });
  setPerms(member, perms);
});

test("a role with 'house' but not 'roles' can rename the house; one without can't", async () => {
  const [, member] = roleIds(H.house);
  const perms = JSON.parse(srv.db.get('SELECT perms FROM roles WHERE id = ?', member).perms);
  assert.match(await bo.refused('house.update', { house: H.house, name: 'Bo’s lab' }), /can’t change house settings/);
  setPerms(member, [...perms, 'house']);
  await bo.ok('house.update', { house: H.house, name: 'Glaze lab' });
  assert.match(await bo.refused('role.create', { house: H.house }), /can’t manage roles/, "'house' isn't 'roles'");
  setPerms(member, perms);
});

test("events need 'events' (the old 'announce' still counts after the backfill); hooks need 'hooks'", async () => {
  const [, member] = roleIds(H.house);
  const perms = JSON.parse(srv.db.get('SELECT perms FROM roles WHERE id = ?', member).perms);
  const starts = Date.now() + 3 * 86_400_000;
  assert.match(await bo.refused('event.create', { house: H.house, title: 'Firing', starts }), /can’t plan events/);
  setPerms(member, [...perms, 'events']);
  const { id } = await bo.ok('event.create', { house: H.house, title: 'Firing', starts });
  setPerms(member, perms);
  await bo.ok('event.delete', { event: id }); // your own, always
  const [owner] = roleIds(H.house);
  void owner;
  const managerRole = (await ava.ok('role.create', { house: H.house })).id;
  await ava.ok('role.update', { house: H.house, role: managerRole, perms: ['post', 'rooms'] });
  await ava.ok('member.role', { house: H.house, user: cy.id, role: managerRole });
  assert.match(await cy.refused('hook.create', { room: H.room, name: 'CI' }), /can’t manage webhooks/);
  await ava.ok('role.update', { house: H.house, role: managerRole, perms: ['post', 'rooms', 'hooks'] });
  await cy.ok('hook.create', { room: H.room, name: 'CI' });
  await ava.ok('member.role', { house: H.house, user: cy.id, role: member });
});

test('the backfill keeps what every existing role could do, once', () => {
  const path = join(dir, 'old.db');
  const db = openDb(path);
  db.run("INSERT INTO houses (id, name, mark, hue, created) VALUES ('h_old', 'Old', 'O', 1, 1)");
  db.run(`INSERT INTO roles (id, house, name, perms, pos) VALUES ('r_own', 'h_old', 'Owner', '[]', 0),
    ('r_mod', 'h_old', 'Mod', '["post","roles","announce"]', 1), ('r_mem', 'h_old', 'Member', '["post"]', 2)`);
  db.close();
  // Written as the sample data or an older release would: not worked out yet.
  const raw = new DatabaseSync(path);
  assert.equal(raw.prepare("SELECT perms_v FROM roles WHERE id = 'r_mod'").get().perms_v, 0);
  migrateCommunity(raw);
  const perms = (r) => new Set(JSON.parse(raw.prepare('SELECT perms FROM roles WHERE id = ?').get(r).perms));
  assert.deepEqual(perms('r_mod'), new Set(['post', 'roles', 'announce', 'house', 'hooks', 'events', 'react']));
  assert.deepEqual(perms('r_mem'), new Set(['post', 'react']));
  // Taking 'react' away afterwards sticks: the backfill runs once per role.
  raw.prepare("UPDATE roles SET perms = '[\"post\"]' WHERE id = 'r_mem'").run();
  migrateCommunity(raw);
  assert.deepEqual(perms('r_mem'), new Set(['post']));
  raw.close();
});

// ---------- House pictures ----------
test('house pictures: type from the bytes, size and shape limits, managers only', async () => {
  const q = (k) => `housePic=${k}&house=${H.house}`;
  let r = await ava.upload(Buffer.from('not an image at all, just words padded out'), q('icon'), 'image/png');
  assert.equal(r.status, 415, 'the bytes decide the type');
  r = await ava.upload(Buffer.alloc(1024 * 1024 + 10, 1), q('icon'));
  assert.equal(r.status, 413, 'icons are at most 1 MB');
  r = await ava.upload(png(600, 600), q('icon'));
  assert.equal(r.status, 422, 'icons are at most 512 px');
  r = await ava.upload(png(64, 48), q('icon'));
  assert.equal(r.status, 422, 'icons are square');
  r = await bo.upload(png(64, 64), q('icon'));
  assert.equal(r.status, 403, 'members who can’t manage the house can’t');
  r = await ava.upload(png(64, 64), q('icon'));
  assert.equal(r.status, 201, await r.clone().text());
  const icon = (await r.json()).id;
  const ev = await bo.next('house', (d) => d.house.id === H.house && d.house.icon === icon);
  assert.equal(ev.house.icon, icon, 'members see the new icon live');
  r = await ava.upload(png(400, 100), q('banner'));
  assert.equal(r.status, 201);
  const banner = (await r.json()).id;
  const log = await ava.ok('audit.list', { house: H.house, action: 'house.picture' });
  assert.ok(log.entries.length >= 2, 'audited');
  return { icon, banner };
});

test('house pictures are served to members and invitation holders, 404 to anyone else', async () => {
  const h = srv.db.get('SELECT icon, banner FROM houses WHERE id = ?', H.house);
  assert.ok(h.icon && h.banner);
  assert.equal((await bo.get(`/api/housepics/${h.icon}`)).status, 200, 'members');
  assert.equal((await dee.get(`/api/housepics/${h.icon}`)).status, 404, 'a stranger without an invitation');
  assert.equal((await fetch(`${base}/api/housepics/${h.icon}`)).status, 404, 'signed out without an invitation');
  assert.equal((await fetch(`${base}/api/housepics/${h.icon}?invite=${H.code}`)).status, 200, 'an invitation shows the icon');
  assert.equal((await fetch(`${base}/api/housepics/${h.banner}?invite=${H.code}`)).status, 404, 'but not the banner of a private house');
  const preview = await (await fetch(`${base}/api/invite/${H.code}`)).json();
  assert.equal(preview.house.icon, h.icon);
  assert.equal(preview.house.banner, null);
  // Removing it: house.update with null.
  await ava.ok('house.update', { house: H.house, banner: null });
  assert.equal((await bo.get(`/api/housepics/${h.banner}`)).status, 404, 'a removed banner is gone');
  assert.match(await ava.refused('house.update', { house: H.house, icon: 'f_abcdefghijkl' }), /Upload a picture first/);
});

// ---------- Delete and transfer ----------
test('house.delete: owners only, the exact name, and every member hears house.gone', async () => {
  const doomed = await houseWith(ava, [bo, cy], 'Doomed');
  await ava.ok('msg.send', { conv: doomed.room, id: mid(), text: 'last words' });
  assert.match(await bo.refused('house.delete', { house: doomed.house, confirmName: 'Doomed' }), /Only an owner/);
  assert.match(await ava.refused('house.delete', { house: doomed.house, confirmName: 'doomed' }), /exactly/);
  await ava.ok('house.delete', { house: doomed.house, confirmName: 'Doomed' });
  for (const c of [ava, bo, cy]) await c.next('house.gone', (d) => d.id === doomed.house);
  const snap = await bo.reconnect();
  assert.equal(snap.houses[doomed.house], undefined, 'the snapshot drops it');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM messages WHERE conv = ?', doomed.room).n, 0, 'its messages are gone');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM rooms WHERE house = ?', doomed.house).n, 0);
});

test('house.transfer: the new owner runs it; stepping down takes the old owner’s settings away', async () => {
  const t = await houseWith(ava, [bo], 'Handover');
  assert.match(await bo.refused('house.transfer', { house: t.house, user: cy.id }), /Only an owner/);
  assert.match(await ava.refused('house.transfer', { house: t.house, user: dee.id }), /isn’t in this house/);
  await ava.ok('house.transfer', { house: t.house, user: bo.id, stepDown: true });
  assert.match(await ava.refused('house.update', { house: t.house, name: 'Still mine' }), /can’t change house settings/);
  await bo.ok('house.update', { house: t.house, name: 'Bo’s now' });
  const log = await bo.ok('audit.list', { house: t.house, action: 'house.transfer' });
  assert.equal(log.entries[0].target, bo.id);
});

// ---------- Events ----------
test('event.update: the author or a role with events; a second member sees it live', async () => {
  const starts = Date.now() + 2 * 86_400_000;
  const { id } = await ava.ok('event.create', { house: H.house, title: 'Open studio', starts, location: 'Studio 4, Elm St' });
  assert.match(await cy.refused('event.update', { event: id, title: 'Mine now' }), /only change events you planned/);
  assert.match(await ava.refused('event.update', { event: id, location: 'http://example.com/x' }), /https/);
  await ava.ok('event.update', { event: id, title: 'Open studio night', location: 'https://example.com/studio' });
  const ev = await bo.next('event', (d) => d.event.id === id && d.event.title === 'Open studio night');
  assert.equal(ev.event.location, 'https://example.com/studio');
  assert.match(await ava.refused('event.update', { event: id, ends: starts - 1 }), /end after it starts/);
  // Going and interested, counted separately.
  await bo.ok('event.rsvp', { event: id, kind: 'interested' });
  const r = await cy.next('event', (d) => d.event.id === id && d.event.interested.includes(bo.id));
  assert.ok(!r.event.going.includes(bo.id));
  assert.ok(r.event.going.includes(ava.id), 'the planner is going');
});

test('event covers: PNG, JPEG or WebP only, members only', async () => {
  const { id } = await ava.ok('event.create', { house: H.house, title: 'Raku day', starts: Date.now() + 86_400_000 });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([64, 0, 64, 0, 0, 0, 0]), Buffer.alloc(20)]);
  let r = await ava.upload(gif, `eventCover=${id}`, 'image/gif');
  assert.equal(r.status, 415, 'a GIF isn’t a cover');
  r = await cy.upload(png(200, 100), `eventCover=${id}`);
  assert.equal(r.status, 403, 'not the planner, no events permission');
  r = await ava.upload(png(200, 100), `eventCover=${id}`);
  assert.equal(r.status, 201);
  const cover = (await r.json()).id;
  assert.equal((await bo.get(`/api/eventcovers/${cover}`)).status, 200);
  assert.equal((await dee.get(`/api/eventcovers/${cover}`)).status, 404);
});

test('reminders: people who said going or interested get a note; a muted house gets no push', async () => {
  const { id } = await ava.ok('event.create', { house: H.house, title: 'Glaze swap', starts: Date.now() + 5 * 60_000 });
  await bo.ok('event.rsvp', { event: id, kind: 'going' });
  await cy.ok('event.rsvp', { event: id, kind: 'interested' });
  await cy.ok('notify.set', { kind: 'house', id: H.house, level: 'muted' });
  const stats = srv.hub.community.stats;
  stats.notes.length = 0; stats.pushed.length = 0; stats.quiet.length = 0;
  srv.hub.community.tick();
  const note = await bo.next('event.remind', (d) => d.event.id === id);
  assert.equal(note.when, 'soon');
  await cy.next('event.remind', (d) => d.event.id === id);
  assert.ok(stats.pushed.some((p) => p.user === bo.id && p.event === id), 'bo would get a push');
  assert.ok(!stats.pushed.some((p) => p.user === cy.id), 'cy muted the house: no push');
  assert.ok(stats.quiet.some((p) => p.user === cy.id));
  // dee isn't in the house; a member who didn't answer gets nothing.
  const other = await Client.make('eli_c', 'Eli');
  await other.ok('invite.accept', { code: H.code });
  srv.hub.community.tick();
  await other.none('event.remind');
  assert.equal(stats.notes.filter((x) => x.event === id).length, 3, 'one each for ava, bo and cy, once');
  // At the start: again, with "now".
  srv.db.run('UPDATE events SET starts = ? WHERE id = ?', Date.now() - 1000, id);
  srv.hub.community.tick();
  assert.equal((await bo.next('event.remind', (d) => d.event.id === id)).when, 'now');
  await cy.ok('notify.set', { kind: 'house', id: H.house, level: 'all' });
});

// ---------- Spam rules ----------
test('spam rules: mentions, flooding, other houses’ invitations; exempt roles and rooms pass', async () => {
  const s = await houseWith(ava, [bo, cy], 'Spam test');
  const other = await houseWith(dee, [], 'Elsewhere');
  const [, member] = roleIds(s.house);
  const helper = (await ava.ok('role.create', { house: s.house })).id;
  await ava.ok('member.role', { house: s.house, user: cy.id, role: helper });
  await ava.ok('automod.set', { house: s.house, mentions: 5, mentionsAction: 'block', flood: 3, floodAction: 'timeout', invites: true, invitesAction: 'block', exempt: [helper] });
  const got = await ava.ok('automod.get', { house: s.house });
  assert.equal(got.mentions, 5);
  assert.match(await bo.refused('automod.set', { house: s.house, mentions: 2 }), /can’t change/);
  assert.match(await ava.refused('automod.set', { house: s.house, mentions: 2 }), /3 to 50/);
  const six = '@a1 @b2 @c3 @d4 @e5 @f6 hello';
  let a = await bo.send(s.room, six);
  assert.equal(a.ok, false); assert.match(a.error, /mentions too many/);
  assert.equal((await bo.send(s.room, '@a1 @b2 @c3 @d4 @e5 hello')).ok, true, 'five is fine');
  a = await bo.send(s.room, `come over https://snug.example/join/${other.code}`);
  assert.equal(a.ok, false); assert.match(a.error, /Invitations to other houses/);
  assert.equal((await bo.send(s.room, `our own: https://snug.example/join/${s.code}`)).ok, true, 'this house’s own link passes');
  assert.equal((await cy.send(s.room, six)).ok, true, 'an exempt role passes');
  // An exempt room.
  await ava.ok('automod.set', { house: s.house, exemptRooms: [s.room] });
  assert.equal((await bo.send(s.room, six)).ok, true, 'an exempt room passes');
  await ava.ok('automod.set', { house: s.house, exemptRooms: [] });
  // Flooding: the third time the same words go in 30 seconds, a timeout.
  assert.equal((await bo.send(s.room, 'buy my pots')).ok, true);
  assert.equal((await bo.send(s.room, 'buy my pots')).ok, true);
  a = await bo.send(s.room, 'buy my pots');
  assert.equal(a.ok, false); assert.match(a.error, /timed out/);
  a = await bo.send(s.room, 'sorry');
  assert.equal(a.ok, false, 'still timed out'); assert.match(a.error, /timed out/);
  const log = await ava.ok('audit.list', { house: s.house, action: 'automod.hit' });
  assert.ok(log.entries.length >= 3, 'hits are in the house log');
  void member;
});

test('spam rules: a flag lets the message through and files a report', async () => {
  const s = await houseWith(ava, [bo], 'Loud house');
  await ava.ok('automod.set', { house: s.house, caps: true, capsAction: 'flag' });
  const { m } = await bo.ok('msg.send', { conv: s.room, id: mid(), text: 'THIS IS A VERY LOUD MESSAGE INDEED' });
  const reports = await ava.ok('report.list', { house: s.house });
  assert.ok(reports.reports.some((r) => r.msg === m.id && /Shouting/.test(r.note)));
});

// ---------- Verification and pausing ----------
test('verification: a fresh account waits under the 5-minute level', async () => {
  const v = await houseWith(ava, [], 'Careful house');
  await ava.ok('house.safety', { house: v.house, verify: 'low' });
  assert.match(await bo.refused('house.safety', { house: v.house, verify: 'none' }), /not a member/);
  const fresh = await Client.make('fresh_c', 'Fresh');
  await fresh.ok('invite.accept', { code: v.code });
  const a = await fresh.send(v.room, 'hi all');
  assert.equal(a.ok, false); assert.match(a.error, /wait a little/);
  const hv = await view(fresh, v.house);
  assert.ok(hv.waitUntil > Date.now(), 'the house view says until when');
  srv.db.run('UPDATE users SET created = ? WHERE id = ?', Date.now() - 10 * 60_000, fresh.id);
  assert.equal((await fresh.send(v.room, 'hi all')).ok, true);
  assert.equal((await ava.send(v.room, 'owners never wait')).ok, true);
});

test('pausing invitations: refused while paused, works after lifting', async () => {
  const p = await houseWith(ava, [], 'Paused house');
  await ava.ok('house.safety', { house: p.house, pause: 1 });
  const late = await Client.make('late_c', 'Late');
  assert.match(await late.refused('invite.accept', { code: p.code }), /paused new members/);
  await ava.ok('house.update', { house: p.house, public: true });
  assert.match(await late.refused('house.joinPublic', { house: p.house }), /paused/);
  const preview = await (await fetch(`${base}/api/invite/${p.code}`)).json();
  assert.equal(preview.paused, true);
  await ava.ok('house.safety', { house: p.house, pause: null });
  await late.ok('invite.accept', { code: p.code });
  const log = await ava.ok('audit.list', { house: p.house, action: 'house.' });
  assert.ok(log.entries.some((e) => e.action === 'house.pause') && log.entries.some((e) => e.action === 'house.unpause'));
});

// ---------- Custom links ----------
test('custom links: unique, the link joins, bans still hold', async () => {
  const c1 = await houseWith(ava, [], 'Potters');
  const c2 = await houseWith(bo, [], 'Other potters');
  await ava.ok('house.vanity', { house: c1.house, word: 'potters' });
  assert.match(await bo.refused('house.vanity', { house: c2.house, word: 'Potters' }), /taken/);
  assert.match(await bo.refused('house.vanity', { house: c2.house, word: 'admin' }), /kept for Snug/);
  const res = await fetch(`${base}/api/invite/potters`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).house.name, 'Potters');
  const joiner = await Client.make('joiner_c', 'Joiner');
  const r = await joiner.ok('invite.accept', { code: 'potters' });
  assert.equal(r.house, c1.house);
  const banned = await Client.make('banned_c', 'Banned');
  await banned.ok('invite.accept', { code: 'potters' });
  await ava.ok('mod.ban', { house: c1.house, user: banned.id });
  assert.match(await banned.refused('invite.accept', { code: 'potters' }), /can’t join/);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM personal_invites WHERE user = ?', banned.id).n, 0, 'nothing left behind');
  // Clearing frees it.
  await ava.ok('house.vanity', { house: c1.house, word: null });
  await bo.ok('house.vanity', { house: c2.house, word: 'potters' });
});

// ---------- Join announcements and default level ----------
test('join announcements: one line, only to people who can see the room; the default level applies', async () => {
  const j = await houseWith(ava, [bo], 'Welcoming');
  const v = await view(ava, j.house);
  const intro = v.groups[0].rooms.find((r) => r !== j.room && v.groups[0].rooms.indexOf(r) === 2) || j.room;
  await ava.ok('room.private', { room: intro, on: true });
  await ava.ok('house.update', { house: j.house, announceRoom: intro, defaultNotify: 'mentions' });
  const newbie = await Client.make('newbie_c', 'Newbie');
  await newbie.ok('invite.accept', { code: j.code });
  const line = await ava.next('msg', (d) => d.conv === intro && d.m.join?.user === newbie.id);
  assert.match(line.m.text, /Newbie joined/);
  assert.equal(line.m.call, undefined, 'never a call record');
  await bo.none('msg', (d) => d.conv === intro);
  const nv = await view(newbie, j.house);
  assert.equal(nv.notify, 'mentions', 'new members start on Only mentions');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM messages WHERE conv = ? AND sys IS NOT NULL', intro).n, 1, 'one line');
  // Join lines can't be edited or deleted by anyone.
  assert.match(await newbie.refused('msg.edit', { conv: intro, id: line.m.id, text: 'x' }), /can’t be changed|access/);
});

test('two-factor for moderators: refused until the moderator has it', async () => {
  const t = await houseWith(ava, [bo, cy], 'Strict');
  const mods = (await ava.ok('role.create', { house: t.house })).id;
  await ava.ok('role.update', { house: t.house, role: mods, perms: ['post', 'kick'] });
  await ava.ok('member.role', { house: t.house, user: bo.id, role: mods });
  assert.match(await ava.refused('house.safety', { house: t.house, mod2fa: true }), /two-factor sign-in for yourself first/);
  srv.db.run(`INSERT INTO totp (user, secret, enabled, created) VALUES (?, 'AAAA', 1, ?) ON CONFLICT (user) DO UPDATE SET enabled = 1`, ava.id, Date.now());
  await ava.ok('house.safety', { house: t.house, mod2fa: true });
  assert.match(await bo.refused('mod.kick', { house: t.house, user: cy.id }), /two-factor/);
  srv.db.run('DELETE FROM totp WHERE user = ?', ava.id);
});

// ---------- Security regressions ----------
test("joinRole: 'house' alone can't choose it; below an owner it's a role under yours that manages nothing", async () => {
  const j = await houseWith(ava, [bo, cy], 'Join rules');
  const [, member] = roleIds(j.house);
  const { id: admin } = await ava.ok('role.create', { house: j.house });
  await ava.ok('role.update', { house: j.house, role: admin, name: 'Admin', perms: ['post', 'roles', 'ban', 'kick'] });
  const { id: plain } = await ava.ok('role.create', { house: j.house });
  await ava.ok('role.update', { house: j.house, role: plain, name: 'Plain', perms: ['post', 'react'] });
  const perms = JSON.parse(srv.db.get('SELECT perms FROM roles WHERE id = ?', member).perms);
  // Bo manages the house but not roles: renaming works, choosing the newcomer role doesn't.
  setPerms(member, [...perms, 'house']);
  await bo.ok('house.update', { house: j.house, name: 'Join rules' });
  assert.match(await bo.refused('house.update', { house: j.house, joinRole: admin }), /can’t choose the role newcomers get/);
  assert.match(await bo.refused('house.update', { house: j.house, joinRole: plain }), /can’t choose the role newcomers get/);
  const before = srv.db.get('SELECT join_role FROM houses WHERE id = ?', j.house).join_role;
  assert.notEqual(before, admin);
  // Sending the current value back (as a settings page might) is fine.
  await bo.ok('house.update', { house: j.house, joinRole: before, about: 'Kept' });
  // A newcomer who joins now doesn't get Admin, and can't manage roles.
  const alt = await Client.make('alt_join', 'Alt');
  const { code } = await ava.ok('invite.create', { house: j.house });
  await alt.ok('invite.accept', { code });
  assert.notEqual(srv.db.get('SELECT role FROM members WHERE house = ? AND user = ?', j.house, alt.id).role, admin);
  assert.match(await alt.refused('role.create', { house: j.house }), /can’t manage roles/);
  // With 'roles' (and below an owner): never a managing role, and only below your own.
  setPerms(member, [...perms, 'house', 'roles']);
  assert.match(await bo.refused('house.update', { house: j.house, joinRole: admin }), /manage or moderate/);
  // A role that manages nothing but sits above Bo's own: refused.
  srv.db.run('UPDATE roles SET perms = ? WHERE id = ?', JSON.stringify(['post']), admin);
  srv.db.run('UPDATE roles SET pos = pos + 1 WHERE house = ? AND pos >= 1', j.house);
  srv.db.run('UPDATE roles SET pos = 1 WHERE id = ?', admin);
  assert.ok(roleIds(j.house).indexOf(admin) < roleIds(j.house).indexOf(member));
  assert.match(await bo.refused('house.update', { house: j.house, joinRole: admin }), /below your own/);
  // One below Bo's that manages nothing: allowed.
  await bo.ok('house.update', { house: j.house, joinRole: plain });
  await ava.ok('house.update', { house: j.house, joinRole: before });
  const [ownerRole] = roleIds(j.house);
  assert.match(await bo.refused('house.update', { house: j.house, joinRole: ownerRole }), /isn’t one of the choices/);
  // The owner may choose any role but their own.
  await ava.ok('house.update', { house: j.house, joinRole: plain });
  assert.equal(srv.db.get('SELECT join_role FROM houses WHERE id = ?', j.house).join_role, plain);
  setPerms(member, perms);
  await alt.reconnect(); alt.ws.close();
});

test('house.transfer: with two-factor on, a code is required (leaving it out is refused too)', async () => {
  const t = await houseWith(ava, [bo], 'Two factor handover');
  const t0 = srv.M.totpOn, v0 = srv.M.verifySecond;
  srv.M.totpOn = (u) => u === ava.id;
  srv.M.verifySecond = (u, code) => code === '123456';
  try {
    assert.match(await ava.refused('house.transfer', { house: t.house, user: bo.id, stepDown: true }), /authenticator/);
    assert.match(await ava.refused('house.transfer', { house: t.house, user: bo.id, stepDown: true, code: '' }), /authenticator/);
    srv.resetLimits();
    assert.match(await ava.refused('house.transfer', { house: t.house, user: bo.id, stepDown: true, code: '000000' }), /isn’t right/);
    assert.ok(srv.M.isOwner(ava.id, t.house), 'still the owner after every refusal');
    assert.ok(!srv.M.isOwner(bo.id, t.house));
    srv.resetLimits();
    await ava.ok('house.transfer', { house: t.house, user: bo.id, stepDown: true, code: '123456' });
    assert.ok(srv.M.isOwner(bo.id, t.house));
  } finally { srv.M.totpOn = t0; srv.M.verifySecond = v0; }
});

test('event covers: a timed-out planner can neither upload nor remove one', async () => {
  const { id } = await ava.ok('event.create', { house: H.house, title: 'Glaze swap', starts: Date.now() + 86_400_000 });
  const [, member] = roleIds(H.house);
  const perms = JSON.parse(srv.db.get('SELECT perms FROM roles WHERE id = ?', member).perms);
  setPerms(member, [...perms, 'events']);
  let r = await bo.upload(png(200, 100), `eventCover=${id}`);
  assert.equal(r.status, 201, 'allowed before the timeout');
  const first = (await r.json()).id;
  srv.db.run('INSERT INTO timeouts (house, user, until, by) VALUES (?, ?, ?, ?)', H.house, bo.id, Date.now() + 3_600_000, ava.id);
  try {
    assert.match(await bo.refused('event.update', { event: id, title: 'Mine' }), /timed out/);
    r = await bo.upload(png(200, 100), `eventCover=${id}`);
    assert.equal(r.status, 403);
    assert.match(await bo.refused('event.cover', { event: id, cover: null }), /timed out/);
    assert.equal(srv.M.eventRow(id).cover, first, 'the cover is unchanged');
  } finally {
    srv.db.run('DELETE FROM timeouts WHERE house = ? AND user = ?', H.house, bo.id);
    setPerms(member, perms);
  }
});

test('event covers and house pictures: bytes that only start like a JPEG are refused', async () => {
  const { id } = await ava.ok('event.create', { house: H.house, title: 'Kiln night', starts: Date.now() + 86_400_000 });
  const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html><script>alert(1)</script></html>'.padEnd(300, ' '))]);
  let r = await ava.upload(junk, `eventCover=${id}`, 'image/jpeg');
  assert.equal(r.status, 415, 'no frame header, no size: not a picture');
  assert.equal(srv.M.eventRow(id).cover ?? null, null);
  r = await ava.upload(junk, `housePic=banner&house=${H.house}`, 'image/jpeg');
  assert.equal(r.status, 415);
});
