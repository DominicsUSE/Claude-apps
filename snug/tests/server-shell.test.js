// Inbox, direct conversations, notifications and accounts on the real server
// (server/inbox.js, server/dms.js): server unread counts and the Mentions
// inbox, group management, timed mutes, @role suppression, presence for a set
// time, mutual friends and changing your username.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-shell-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
let n = 0;
const mid = () => `m_shell${String(++n).padStart(6, '0')}x`;
let hn = 0;
const handle = (p) => `${p}${++hn}`;
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

class Client {
  static async make(h, name = h) {
    const res = await post('/api/register', { handle: h, name, password: 'a long password' });
    assert.equal(res.status, 201, await res.clone().text());
    const c = new Client();
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    c.id = (await res.json()).user.id;
    c.handle = h;
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
        if (m.t === 'hello') { this.hello = m.d; resolve(this); } else if (m.t === 'ack') this.acks.get(m.id)?.(m); else if (m.t === 'ev') { this.events.push(m); this.waiter?.(); }
      });
    });
  }
  op(op, d = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ t: 'op', id, op, d })); return new Promise((r) => this.acks.set(id, r)); }
  async ok(op, d) { const a = await this.op(op, d); assert.equal(a.ok, true, `${op}: ${a.error}`); return a.d; }
  async refused(op, d) { const a = await this.op(op, d); assert.equal(a.ok, false, `${op} should be refused`); return a.error; }
  async next(ev, pred = () => true, ms = 1500) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => { this.waiter = r; setTimeout(r, 50); });
    }
  }
  async reconnect() { await this.shut(); await this.connect(); return this.hello; }
  shut() { return new Promise((r) => { this.ws.on('close', r); this.ws.close(); }); }
}
const say = (c, conv, text, extra = {}) => c.ok('msg.send', { conv, id: mid(), text, ...extra });

// An owner (who may post notices), a member and a newcomer without 'announce'; one text room.
async function house(p) {
  const ow = await Client.make(handle(`${p}o`), `Owen ${p}`);
  const mm = await Client.make(handle(`${p}m`), `Milo ${p}`);
  const nw = await Client.make(handle(`${p}n`), `Nell ${p}`);
  const made = await ow.ok('house.create', { name: `Shell ${p}`, hue: 35 });
  const { id: plain } = await ow.ok('role.create', { house: made.house });
  await ow.ok('role.update', { house: made.house, role: plain, name: 'Newcomer', perms: ['post', 'react'] });
  await ow.ok('house.update', { house: made.house, joinRole: plain });
  for (const c of [mm, nw]) { const { code } = await ow.ok('invite.create', { house: made.house }); await c.ok('invite.accept', { code }); }
  return { ow, mm, nw, house: made.house, room: made.room, close: async () => { for (const c of [ow, mm, nw]) await c.shut(); } };
}

// ---------- Unread counts and the Mentions inbox ----------

test('unread counts: 100 messages with a mention at #10 gives count 100, needs 1, in the snapshot and the op', async () => {
  const s = await house('uc');
  await s.ow.ok('read.set', { conv: s.room, ts: Date.now() });
  for (let i = 1; i <= 100; i++) {
    if (i % 12 === 0) srv.resetLimits();
    await say(s.mm, s.room, i === 10 ? `@${s.ow.handle} can you look at this?` : `message ${i}`);
  }
  const hello = await s.ow.reconnect();
  assert.equal((hello.msgs[s.room] || []).some((m) => m.text.includes(`@${s.ow.handle}`)), false, 'the mention is older than the loaded page');
  assert.deepEqual({ count: hello.unread[s.room].count, needs: hello.unread[s.room].needs }, { count: 100, needs: 1 });
  assert.ok(hello.unread[s.room].firstSeq > 0 && hello.unread[s.room].upTo > 0);
  const { unread } = await s.ow.ok('unread.counts');
  assert.equal(unread[s.room].needs, 1);
  // Reading moves the read point; nothing is unread afterwards.
  await s.ow.ok('read.set', { conv: s.room, ts: Date.now() });
  assert.equal((await s.ow.ok('unread.counts')).unread[s.room], undefined);
  // The Mentions inbox keeps it after reading.
  const list = await s.ow.ok('mentions.list', {});
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].why, 'mention');
  assert.match(list.items[0].m.text, /can you look/);
  assert.ok(list.users[s.mm.id]);
  // Rate limited.
  srv.resetLimits();
  let refused = 0;
  for (let i = 0; i < 10; i++) if (!(await s.ow.op('unread.counts')).ok) refused++;
  assert.ok(refused > 0, 'unread.counts is rate limited');
  await s.close();
});

test('unread counts: a mention in a private room I can’t see never shows in counts or the Mentions inbox', async () => {
  const s = await house('pr');
  const { id: back } = await s.ow.ok('room.create', { house: s.house, name: 'Backroom', kind: 'text', private: true });
  await say(s.ow, back, `@${s.mm.handle} secret plans`);
  await say(s.ow, s.room, `@${s.mm.handle} public hello`);
  const { unread } = await s.mm.ok('unread.counts');
  assert.equal(unread[back], undefined, 'no count for a room I can’t see');
  assert.equal(unread[s.room].needs, 1);
  const list = await s.mm.ok('mentions.list', {});
  assert.deepEqual(list.items.map((i) => i.m.text), [`@${s.mm.handle} public hello`]);
  assert.equal(JSON.stringify(list).includes('secret plans'), false);
  // House filter: another house's id I'm not in is refused; my house works.
  assert.match(await s.mm.refused('mentions.list', { house: 'h_nothere123' }), /not a member/);
  assert.equal((await s.mm.ok('mentions.list', { house: s.house })).items.length, 1);
  await s.close();
});

test('unread counts: @everyone from someone who may not post notices doesn’t need me; from the owner it does; toggles and dismiss', async () => {
  const s = await house('ev');
  await s.mm.ok('read.set', { conv: s.room, ts: Date.now() });
  await say(s.nw, s.room, '@everyone free pizza');
  let { unread } = await s.mm.ok('unread.counts');
  assert.deepEqual({ count: unread[s.room].count, needs: unread[s.room].needs }, { count: 1, needs: 0 });
  const owners = await say(s.ow, s.room, '@everyone the kiln is lit');
  ({ unread } = await s.mm.ok('unread.counts'));
  assert.deepEqual({ count: unread[s.room].count, needs: unread[s.room].needs }, { count: 2, needs: 1 });
  let list = await s.mm.ok('mentions.list', {});
  assert.deepEqual(list.items.map((i) => [i.why, i.m.text]), [['everyone', '@everyone the kiln is lit']]);
  assert.equal((await s.mm.ok('mentions.list', { everyone: false })).items.length, 0, 'the @everyone toggle');
  // Dismissed: gone from the list, and back with undo.
  await s.mm.ok('mention.dismiss', { id: owners.m.id });
  assert.equal((await s.mm.ok('mentions.list', {})).items.length, 0);
  await s.mm.ok('mention.dismiss', { id: owners.m.id, undo: true });
  assert.equal((await s.mm.ok('mentions.list', {})).items.length, 1);
  assert.match(await s.mm.refused('mention.dismiss', { id: '../x' }), /isn’t valid/);
  // A reply to me counts; with its mention turned off it doesn't.
  const mine = await say(s.mm, s.room, 'what time?');
  await say(s.ow, s.room, 'at six', { replyTo: mine.m.id });
  await say(s.ow, s.room, 'or seven', { replyTo: mine.m.id, replyPing: false });
  list = await s.mm.ok('mentions.list', {});
  assert.deepEqual(list.items.map((i) => [i.why, i.m.text]), [['reply', 'at six'], ['everyone', '@everyone the kiln is lit']]);
  await s.close();
});

// ---------- Direct conversations and groups ----------

test('groups: rename, icon, add, hide and show, pin, leave and kick, each with its rules', async () => {
  const s = await house('dm');
  const out = await Client.make(handle('dmx'), 'Xavi Outsider'); // shares nothing with anyone
  const extra = await Client.make(handle('dme'), 'Esme Extra');
  { const { code } = await s.ow.ok('invite.create', { house: s.house }); await extra.ok('invite.accept', { code }); }
  const one = (await s.ow.ok('dm.open', { users: [s.mm.id] })).id;
  assert.match(await s.ow.refused('dm.rename', { dm: one, name: 'Two of us' }), /two people/);
  // Adding to a one-to-one conversation starts a new group, owned by whoever added.
  const made = await s.ow.ok('dm.add', { dm: one, users: [s.nw.id] });
  assert.equal(made.created, true);
  const g = made.id;
  assert.notEqual(g, one);
  const view = await s.nw.next('dm', (d) => d.dm.id === g);
  assert.deepEqual(view.dm.members.sort(), [s.ow.id, s.mm.id, s.nw.id].sort());
  assert.equal(view.dm.owner, s.ow.id);
  // Rename: members only, 1-40 characters, with a line in the conversation.
  assert.match(await out.refused('dm.rename', { dm: g, name: 'Hijacked' }), /not in that conversation/);
  assert.match(await s.mm.refused('dm.rename', { dm: g, name: 'x'.repeat(41) }), /at most 40/);
  await s.mm.ok('dm.rename', { dm: g, name: 'Kiln crew' });
  const renamed = await s.nw.next('msg', (d) => d.conv === g && d.m.dmLine?.act === 'rename');
  assert.equal(renamed.m.dmLine.name, 'Kiln crew');
  assert.equal(renamed.m.sys, true);
  assert.equal((await s.nw.next('dm', (d) => d.dm.id === g && d.dm.name === 'Kiln crew')).dm.name, 'Kiln crew');
  // Icon: one emoji and one of the colours.
  assert.match(await s.mm.refused('dm.icon', { dm: g, emoji: 'not an emoji' }), /one emoji/);
  assert.match(await s.mm.refused('dm.icon', { dm: g, emoji: '🔥', hue: 7 }), /colours/);
  await s.mm.ok('dm.icon', { dm: g, emoji: '🔥', hue: 142 });
  assert.deepEqual((await s.ow.next('dm', (d) => d.dm.id === g && d.dm.icon)).dm.icon, { emoji: '🔥', hue: 142 });
  // Add: a stranger can't be added, nor someone blocked either way.
  assert.match(await s.ow.refused('dm.add', { dm: g, users: [out.id] }), /friends and people you share a house with/);
  await extra.ok('block.set', { user: s.mm.id, on: true });
  assert.match(await s.ow.refused('dm.add', { dm: g, users: [extra.id] }), /can’t add/);
  await extra.ok('block.set', { user: s.mm.id, on: false });
  await s.ow.ok('dm.add', { dm: g, users: [extra.id] });
  assert.equal((await extra.next('dm', (d) => d.dm.id === g)).dm.members.length, 4);
  // Hide keeps the messages; a new message brings it back.
  await say(s.ow, g, 'first light at six');
  await s.mm.ok('dm.hide', { dm: g });
  assert.equal((await s.mm.next('dm', (d) => d.dm.id === g && d.dm.hidden)).dm.hidden, true);
  const hist = await s.mm.ok('history', { conv: g });
  assert.ok(hist.msgs.some((m) => m.text === 'first light at six'), 'hidden, not gone');
  await say(s.nw, g, 'see you there');
  assert.equal((await s.mm.next('dm', (d) => d.dm.id === g && !d.dm.hidden)).dm.hidden, undefined);
  // Pin: your own list, at most ten.
  await s.mm.ok('dm.pin', { dm: g, on: true });
  assert.ok((await s.mm.next('dm', (d) => d.dm.id === g && d.dm.pinned)).dm.pinned > 0);
  assert.match(await s.mm.refused('dm.pin', { dm: g, on: 'yes' }), /on or off/);
  // Kick: the owner only.
  assert.match(await s.mm.refused('dm.kick', { dm: g, user: s.nw.id }), /owner/);
  await s.ow.ok('dm.kick', { dm: g, user: extra.id });
  await extra.next('dm.gone', (d) => d.id === g);
  assert.match(await extra.refused('history', { conv: g }), /access|not|can’t/i);
  // Leave: the leaver hears dm.gone and loses the history; the others see a line.
  await s.nw.ok('dm.leave', { dm: g });
  await s.nw.next('dm.gone', (d) => d.id === g);
  await s.mm.next('msg', (d) => d.conv === g && d.m.dmLine?.act === 'leave');
  assert.match(await s.nw.refused('history', { conv: g }), /access|not|can’t/i);
  assert.equal((await s.nw.ok('sync')).dms[g], undefined);
  // The owner leaving hands the group on.
  await s.ow.ok('dm.leave', { dm: g });
  assert.equal((await s.mm.next('dm', (d) => d.dm.id === g && d.dm.members.length === 1)).dm.owner, s.mm.id);
  await out.shut(); await extra.shut();
  await s.close();
});

test('groups: at most ten people, and message privacy is respected when adding', async () => {
  const s = await house('gm');
  const people = [];
  for (let i = 0; i < 9; i++) {
    const c = await Client.make(handle('gmp'), `Person ${i}`);
    const { code } = await s.ow.ok('invite.create', { house: s.house });
    await c.ok('invite.accept', { code });
    people.push(c);
    srv.resetLimits();
  }
  const g = (await s.ow.ok('dm.open', { users: [people[0].id, people[1].id] })).id;
  await people[2].ok('privacy.set', { dm: 'friends' });
  assert.match(await s.ow.refused('dm.add', { dm: g, users: [people[2].id] }), /only takes messages from friends/);
  await s.ow.ok('dm.add', { dm: g, users: people.slice(3, 9).map((p) => p.id) }); // 3 + 6 = 9
  assert.match(await s.ow.refused('dm.add', { dm: g, users: [s.mm.id, s.nw.id] }), /up to 10/);
  await s.ow.ok('dm.add', { dm: g, users: [s.mm.id] });
  srv.resetLimits();
  let refused = 0;
  for (let i = 0; i < 14; i++) if (!(await s.ow.op('dm.rename', { dm: g, name: `name ${i}` })).ok) refused++;
  assert.ok(refused > 0, 'group changes are rate limited');
  for (const p of people) await p.shut();
  await s.close();
});

// ---------- Timed mutes and @role suppression ----------

test('timed mutes: the server works out the time, refuses other values, and an expired mute counts as unset', async () => {
  const s = await house('tm');
  assert.match(await s.mm.refused('notify.set', { kind: 'room', id: s.room, level: 'muted', until: '3d' }), /times/);
  assert.match(await s.mm.refused('notify.set', { kind: 'room', id: s.room, level: 'mentions', until: '1h' }), /Only muting/);
  const t0 = Date.now();
  await s.mm.ok('notify.set', { kind: 'room', id: s.room, level: 'muted', until: '1h' });
  const hv = await s.mm.next('house', (d) => d.rooms[s.room]?.notifyUntil);
  assert.equal(hv.rooms[s.room].notify, 'muted');
  assert.ok(Math.abs(hv.rooms[s.room].notifyUntil - (t0 + 3_600_000)) < 5000, 'one hour from now, worked out by the server');
  // A push is suppressed while muted...
  await s.mm.shut();
  const m1 = await say(s.ow, s.room, `@${s.mm.handle} glaze is ready`);
  assert.equal(srv.push.wouldPush(s.mm.id, m1.m.id), false, 'muted: no push');
  // ...and sent once the mute is over (a small until, set as if time had passed).
  srv.db.run('UPDATE notify SET until = ? WHERE user = ? AND place = ?', Date.now() + 150, s.mm.id, s.room);
  assert.equal(srv.push.wouldPush(s.mm.id, m1.m.id), false, 'still muted until it ends');
  await settle(250);
  assert.equal(srv.M.notifyOf(s.mm.id, s.room), undefined, 'expired reads as unset');
  assert.equal(srv.push.wouldPush(s.mm.id, m1.m.id), true, 'pushed after the mute ends');
  await s.mm.connect();
  // The sweep drops the expired row and tells the person's devices.
  await s.mm.ok('notify.set', { kind: 'dm', id: (await s.mm.ok('dm.open', { users: [s.ow.id] })).id, level: 'muted', until: '15m' });
  const dmId = (await s.mm.ok('dm.open', { users: [s.ow.id] })).id;
  srv.db.run('UPDATE notify SET until = ? WHERE user = ? AND place = ?', Date.now() - 1, s.mm.id, dmId);
  assert.ok(srv.hub.sweepMutes() >= 1);
  const back = await s.mm.next('dm', (d) => d.dm.id === dmId && !d.dm.notify);
  assert.equal(back.dm.notifyUntil, undefined);
  // 'never' means until changed.
  await s.mm.ok('notify.set', { kind: 'house', id: s.house, level: 'muted', until: 'never' });
  assert.equal((await s.mm.next('house', (d) => d.house.id === s.house && d.house.notify === 'muted')).house.notifyUntil, undefined);
  await s.close();
});

test('suppress @role mentions: rolesOff stops a role mention counting and pushing for that house', async () => {
  const s = await house('ro');
  const { id: crew } = await s.ow.ok('role.create', { house: s.house });
  await s.ow.ok('role.update', { house: s.house, role: crew, name: 'Crew', perms: ['post', 'react'] });
  await s.ow.ok('member.role', { house: s.house, user: s.mm.id, role: crew });
  await s.mm.ok('read.set', { conv: s.room, ts: Date.now() });
  const m = await say(s.ow, s.room, '@Crew kiln at nine');
  assert.equal(srv.push.wouldPush(s.mm.id, m.m.id), true, 'a role I hold pushes');
  assert.equal((await s.mm.ok('unread.counts')).unread[s.room].needs, 1);
  assert.equal((await s.mm.ok('mentions.list', {})).items[0].why, 'role');
  assert.equal((await s.mm.ok('mentions.list', { roles: false })).items.length, 0, 'the roles toggle');
  await s.mm.ok('prefs.set', { prefs: { rolesOff: { [s.house]: true } } });
  assert.equal(srv.push.wouldPush(s.mm.id, m.m.id), false, 'suppressed: no push');
  assert.equal((await s.mm.ok('unread.counts')).unread[s.room].needs, 0, 'and no longer needs me');
  // @username still does.
  const direct = await say(s.ow, s.room, `@${s.mm.handle} and you`);
  assert.equal(srv.push.wouldPush(s.mm.id, direct.m.id), true);
  await s.close();
});

// ---------- Presence for a set time ----------

test('presence for a while: Focused for an hour shows to a friend, then Around after it ends; pushes only before', async () => {
  const s = await house('pf');
  assert.match(await s.mm.refused('me.update', { presence: 'focus', presenceUntil: '90m' }), /times/);
  assert.match(await s.mm.refused('me.update', { presenceUntil: '1h' }), /Pick a presence/);
  await s.mm.ok('me.update', { presence: 'focus', presenceUntil: '1h' });
  const self = await s.mm.next('user', (d) => d.user.id === s.mm.id && d.user.presenceUntil);
  assert.ok(Math.abs(self.user.presenceUntil - (Date.now() + 3_600_000)) < 5000);
  assert.equal((await s.ow.next('user', (d) => d.user.id === s.mm.id && d.user.presence === 'focus')).user.presence, 'focus');
  const seen = (await s.ow.ok('sync')).users[s.mm.id];
  assert.equal(seen.presence, 'focus');
  assert.equal(seen.presenceUntil, undefined, 'the end time is only for the person themselves');
  await s.mm.shut();
  const msg = await say(s.ow, s.room, `@${s.mm.handle} when you’re free`);
  assert.equal(srv.push.wouldPush(s.mm.id, msg.m.id), false, 'Focused: no push');
  srv.db.run('UPDATE users SET presence_until = ? WHERE id = ?', Date.now() - 1, s.mm.id);
  assert.equal(srv.push.wouldPush(s.mm.id, msg.m.id), true, 'over: pushes again (checked on read)');
  assert.ok(srv.hub.sweepPresence() >= 1);
  await s.mm.connect();
  assert.equal((await s.ow.ok('sync')).users[s.mm.id].presence, 'around');
  // The live change reaches a friend, by timer, with a short until set directly.
  await s.mm.ok('me.update', { presence: 'away', presenceUntil: '30m' });
  await s.ow.next('user', (d) => d.user.id === s.mm.id && d.user.presence === 'away');
  srv.db.run('UPDATE users SET presence_until = ? WHERE id = ?', Date.now() + 100, s.mm.id);
  await settle(200);
  srv.hub.sweepPresence();
  await s.ow.next('user', (d) => d.user.id === s.mm.id && d.user.presence === 'around');
  // A presence chosen without a time clears the old end.
  await s.mm.ok('me.update', { presence: 'focus', presenceUntil: '2h' });
  await s.mm.ok('me.update', { presence: 'focus' });
  assert.equal(srv.db.get('SELECT presence_until FROM users WHERE id = ?', s.mm.id).presence_until, null);
  await s.close();
});

// ---------- Mutual friends ----------

test('mutual friends: ids only, blocked and non-friends left out, someone I can’t see refused', async () => {
  const [a, b, c, d, e] = await Promise.all(['mfa', 'mfb', 'mfc', 'mfd', 'mfe'].map((p) => Client.make(handle(p))));
  const befriend = async (x, y) => { await x.ok('friend.request', { user: y.id }); await y.ok('friend.accept', { user: x.id }); };
  await befriend(a, b); await befriend(a, c); await befriend(b, c); await befriend(b, d); await befriend(a, e); await befriend(b, e);
  assert.deepEqual((await a.ok('friends.mutual', { user: b.id })).users.sort(), [c.id, e.id].sort());
  await e.ok('block.set', { user: a.id, on: true });
  assert.deepEqual((await a.ok('friends.mutual', { user: b.id })).users, [c.id], 'someone who blocked me is left out');
  // d is b's friend but not mine.
  assert.equal((await a.ok('friends.mutual', { user: b.id })).users.includes(d.id), false);
  const stranger = await Client.make(handle('mfs'));
  assert.match(await stranger.refused('friends.mutual', { user: b.id }), /can’t see/);
  await b.ok('block.set', { user: a.id, on: true });
  assert.match(await a.refused('friends.mutual', { user: b.id }), /can’t see/);
  for (const x of [a, b, c, d, e, stranger]) await x.shut();
});

// ---------- Changing your username ----------

test('username: rules, password, rate limit, the old name held for 7 days, and a friend sees the new one live', async () => {
  const me = await Client.make(handle('hna'), 'Hana');
  const friend = await Client.make(handle('hnf'), 'Fen');
  const other = await Client.make(handle('hno'), 'Otto');
  await me.ok('friend.request', { user: friend.id });
  await friend.ok('friend.accept', { user: me.id });
  assert.match(await me.refused('me.handle', { handle: other.handle, password: 'a long password' }), /taken/);
  assert.match(await me.refused('me.handle', { handle: other.handle.toUpperCase(), password: 'a long password' }), /taken/, 'case-insensitive');
  assert.match(await me.refused('me.handle', { handle: 'no spaces', password: 'a long password' }), /Usernames are/);
  assert.match(await me.refused('me.handle', { handle: 'hana-new', password: 'wrong password' }), /password/);
  const old = me.handle;
  assert.deepEqual(await me.ok('me.handle', { handle: '@Hana-New', password: 'a long password' }), { handle: 'hana-new' });
  assert.equal((await friend.next('user', (d) => d.user.id === me.id && d.user.handle === 'hana-new')).user.handle, 'hana-new');
  // The old name is held: nobody else can take it, by sign-up or by changing.
  assert.equal((await post('/api/register', { handle: old, name: 'Squatter', password: 'a long password' })).status, 409);
  assert.match(await other.refused('me.handle', { handle: old, password: 'a long password' }), /taken/);
  // Two changes an hour (taking your own old name back is allowed, and counts).
  srv.resetLimits();
  await me.ok('me.handle', { handle: old, password: 'a long password' });
  srv.resetLimits();
  assert.match(await me.refused('me.handle', { handle: 'hana-third', password: 'a long password' }), /twice an hour/);
  for (const x of [me, friend, other]) await x.shut();
});

// ---------- Security regressions ----------
test('groups: dm.add can’t skip a pending message request', async () => {
  const s = await house('rq');
  const stranger = await Client.make(handle('rqs'), 'Sol Stranger'); // shares no house with anyone
  await stranger.ok('privacy.set', { dm: 'everyone' });
  const pending = (await s.ow.ok('dm.open', { users: [stranger.id] })).id;
  assert.ok(srv.db.get('SELECT 1 FROM dm_requests WHERE dm = ? AND user = ? AND declined IS NULL', pending, stranger.id), 'a request is waiting');
  const one = (await s.ow.ok('dm.open', { users: [s.mm.id] })).id;
  assert.match(await s.ow.refused('dm.add', { dm: one, users: [stranger.id] }), /friends and people you share a house with/);
  const g = (await s.ow.ok('dm.open', { users: [s.mm.id, s.nw.id] })).id;
  assert.match(await s.ow.refused('dm.add', { dm: g, users: [stranger.id] }), /friends and people you share a house with/);
  await settle(200);
  assert.ok(!stranger.events.some((e) => e.ev === 'msg' && e.d.conv !== pending), 'nothing reached them outside the request');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM dm_members WHERE user = ?', stranger.id).n, 1, 'in no conversation but the request');
  // Once they accept, that conversation counts and adding works.
  await stranger.ok('dm.request.accept', { dm: pending });
  await s.ow.ok('dm.add', { dm: g, users: [stranger.id] });
  await stranger.shut();
  await s.close();
});

test('groups: names lose control and direction characters, in the name and the line', async () => {
  const s = await house('nm');
  const g = (await s.ow.ok('dm.open', { users: [s.mm.id, s.nw.id] })).id;
  await s.ow.ok('dm.rename', { dm: g, name: 'Kiln\u0000 crew‮\u0007 ⁦x' });
  const name = srv.db.get('SELECT name FROM dms WHERE id = ?', g).name;
  assert.equal(name, 'Kiln crew x');
  const line = await s.mm.next('msg', (d) => d.conv === g && d.m.dmLine?.act === 'rename');
  assert.equal(line.m.dmLine.name, 'Kiln crew x');
  assert.doesNotMatch(line.m.text, /[\u0000-\u001f‪-‮⁦-⁩]/);
  assert.match(await s.ow.refused('dm.rename', { dm: g, name: '\u0000‮\u0001' }), /can’t be empty/);
  await s.close();
});

test('groups: one that shrinks to two stays a group, not their one-to-one conversation', async () => {
  const s = await house('sk');
  const g = (await s.ow.ok('dm.open', { users: [s.mm.id, s.nw.id] })).id;
  await s.ow.ok('dm.rename', { dm: g, name: 'Secret plans' });
  await s.nw.ok('dm.leave', { dm: g });
  const one = (await s.mm.ok('dm.open', { users: [s.ow.id] })).id;
  assert.notEqual(one, g, 'a fresh one-to-one conversation');
  assert.equal((await s.ow.ok('dm.open', { users: [s.mm.id] })).id, one, 'and the same one from either side');
  // The shrunk group still takes group levels.
  await s.mm.ok('notify.set', { kind: 'dm', id: g, level: 'mentions' });
  assert.match(await s.mm.refused('notify.set', { kind: 'dm', id: one, level: 'mentions' }), /choices/);
  await s.close();
});

test('username: only the last two old names stay held', async () => {
  const me = await Client.make(handle('hld'), 'Holda');
  const names = [me.handle];
  for (let i = 0; i < 4; i++) {
    const next = `${me.handle}-v${i}`;
    // Past the hourly limit, as if an hour went by between changes.
    srv.db.run('UPDATE handle_released SET ts = ts - 7200000 WHERE user = ?', me.id);
    srv.resetLimits();
    await me.ok('me.handle', { handle: next, password: 'a long password' });
    names.push(next);
  }
  // Current name, then the two most recent old ones held; the older ones free.
  const held = names.slice(0, -1).filter((h) => srv.M.handleHeld(h));
  assert.deepEqual(held, names.slice(-3, -1));
  assert.equal((await post('/api/register', { handle: names[0], name: 'Taker', password: 'a long password' })).status, 201);
  assert.equal((await post('/api/register', { handle: names[3], name: 'Squatter', password: 'a long password' })).status, 409);
  await me.shut();
});

test('unread counts: thousands of unread mentions stay quick, and capped', async () => {
  const s = await house('pf');
  const rooms = [s.room];
  for (let i = 0; i < 9; i++) rooms.push((await s.ow.ok('room.create', { house: s.house, name: `r${i}`, kind: 'text' })).id);
  let k = 0;
  const firstId = `m_pfx${'0'.repeat(10)}`;
  srv.db.tx(() => {
    for (const r of rooms) for (let i = 0; i < 1500; i++) {
      srv.db.run("INSERT INTO messages (id, conv, author, ts, text, fold, reply_to) VALUES (?, ?, ?, ?, ?, '', ?)",
        `m_pf${String(++k).padStart(10, '0')}x`, r, s.ow.id, Date.now() - 100_000 + k, `@${s.mm.handle} and @here ${i}`, i % 3 ? firstId : null);
    }
  });
  srv.db.run('DELETE FROM reads WHERE user = ?', s.mm.id);
  const t = performance.now();
  const u = srv.M.unreadCounts(s.mm.id);
  const ms = performance.now() - t;
  assert.equal(Object.keys(u).filter((c) => rooms.includes(c)).length, rooms.length);
  for (const r of rooms) {
    assert.equal(u[r].count, 1500, 'every message counts as unread');
    assert.ok(u[r].needs > 0 && u[r].needs <= 100, `needs is capped (${u[r].needs})`);
  }
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
  await s.close();
});
