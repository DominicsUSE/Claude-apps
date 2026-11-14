// Voice and calls on the real server: holding a voice slot through a dropped
// connection, the room's "Share camera and screen" permission, the whiteboard,
// the games, voice reactions, ringing someone again, who may ring you, and
// short-lived TURN credentials. Every rule is checked from separate signed-in
// sockets, never trusted from the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-voice-'));
const GRACE = 600;
const SECRET = 'test-turn-secret';
let srv, base;
test.before(async () => {
  srv = await startServer({
    port: 0, dataDir: dir, quiet: true, ringMs: 1200, voiceGraceMs: GRACE,
    iceEnv: { SNUG_STUN: 'stun:stun.example.org:3478', SNUG_TURN_URL: 'turn:turn.example.org:3478', SNUG_TURN_SECRET: SECRET, SNUG_TURN_USER: 'static', SNUG_TURN_PASS: 'static-pass' },
  });
  base = `http://127.0.0.1:${srv.port}`;
});
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  static async make(handle, name = handle) {
    const res = await post('/api/register', { handle, name, password: 'a long password' });
    assert.equal(res.status, 201, await res.clone().text());
    const c = new Client();
    c.cookie = res.headers.get('set-cookie').split(';')[0];
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
        if (m.t === 'hello') { this.hello = m.d; resolve(this); } else if (m.t === 'ack') this.acks.get(m.id)?.(m);
        else if (m.t === 'ev') { this.events.push(m); this.waiter?.(); }
      });
    });
  }
  // A dropped connection: no clean close from a page going away.
  drop() { return new Promise((r) => { this.ws.on('close', r); this.ws.terminate(); }); }
  op(op, d = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ t: 'op', id, op, d }));
    return new Promise((r) => this.acks.set(id, r));
  }
  async ok(op, d) { const a = await this.op(op, d); assert.equal(a.ok, true, `${op}: ${a.error}`); return a.d; }
  async refused(op, d) { const a = await this.op(op, d); assert.equal(a.ok, false, `${op} should be refused`); return a.error; }
  async next(ev, pred = () => true, ms = 1500) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => { this.waiter = r; setTimeout(r, 30); });
    }
  }
  async none(ev, pred = () => true, ms = 250) {
    await sleep(ms);
    assert.equal(this.events.some((e) => e.ev === ev && pred(e.d)), false, `unexpected "${ev}" event`);
  }
  clear() { this.events.length = 0; }
}
const device = (p) => Object.assign(new Client(), { cookie: p.cookie, id: p.id }).connect();

async function people(tag) {
  const a = await Client.make(`${tag}ann`, 'Ann Ash');
  const b = await Client.make(`${tag}ben`, 'Ben Birch');
  const c = await Client.make(`${tag}cal`, 'Cal Cedar');
  const d = await Client.make(`${tag}dot`, 'Dot Dale');
  const made = await a.ok('house.create', { name: `Voice ${tag}`, hue: 200 });
  const { code } = await a.ok('invite.create', { house: made.house });
  for (const p of [b, c, d]) await p.ok('invite.accept', { code });
  const { id: dm } = await a.ok('dm.open', { users: [b.id] });
  const { id: group } = await a.ok('dm.open', { users: [b.id, c.id] });
  const hangout = srv.db.get("SELECT id FROM rooms WHERE house = ? AND kind = 'voice'", made.house).id;
  return { a, b, c, d, dm, group, house: made.house, hangout };
}
const closeAll = (...ps) => { for (const p of ps) p.ws.close(); };

// ---------- Reconnect ----------
test('reconnect: a dropped connection holds the voice slot; coming back keeps mute and deafen without the full-room check', async () => {
  const { a, b, d, hangout } = await people('rc');
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  await a.ok('voice.state', { muted: true, deaf: true });
  // Only Ann and Ben fit, so a room "full" check would refuse her coming back.
  await a.ok('room.voice', { room: hangout, limit: 2 });
  await a.drop();
  const held = await b.next('voice', (v) => v.room === hangout && v.state[a.id]?.reconnecting);
  assert.deepEqual(held.users.sort(), [a.id, b.id].sort(), 'still in the room');
  assert.equal(held.state[a.id].muted, true);
  // Someone else still can't take the held place.
  assert.match(await d.refused('voice.join', { room: hangout }), /full/);
  // Back on a new socket within the grace period.
  await a.connect();
  b.clear();
  assert.equal(a.hello.voice[hangout].state[a.id].reconnecting, true, 'the snapshot says she is reconnecting');
  const back = await a.ok('voice.join', { room: hangout });
  assert.deepEqual(back.peers, [b.id]);
  const now = await b.next('voice', (v) => v.room === hangout && v.users.includes(a.id) && !v.state[a.id]?.reconnecting);
  assert.equal(now.state[a.id].muted, true, 'mute kept');
  assert.equal(now.state[a.id].deaf, true, 'deafen kept');
  // Signalling reaches her new socket.
  await b.ok('rtc', { to: a.id, data: { candidate: { candidate: 'x' } } });
  assert.equal((await a.next('rtc', (r) => r.from === b.id)).data.candidate.candidate, 'x');
  closeAll(a, b, d);
});

test('reconnect: a 1:1 call survives a drop and a rejoin; when the grace runs out the slot is freed and the call ends', async () => {
  const { a, b, dm, hangout } = await people('rk');
  await a.ok('call.start', { dm });
  await b.next('call.ring', (r) => r.dm === dm);
  await b.ok('call.join', { dm });
  await b.drop();
  await a.next('voice', (v) => v.room === dm && v.state[b.id]?.reconnecting);
  await a.none('call.ended', (e) => e.dm === dm, GRACE / 2);
  await b.connect();
  assert.deepEqual((await b.ok('call.join', { dm })).peers, [a.id], 'back in the same call');
  await a.next('voice', (v) => v.room === dm && v.users.length === 2 && !v.state[b.id]?.reconnecting);
  assert.ok(srv.hub.callOf(dm), 'the call goes on');
  // Dropped again, and not back in time: an ordinary hang-up.
  await b.drop();
  assert.equal((await a.next('call.ended', (e) => e.dm === dm, GRACE + 1500)).reason, 'ended');
  assert.equal(srv.hub.callOf(dm), null);
  assert.equal(srv.hub.voicePlaceOf(b.id), null, 'the slot is freed');
  // A tab closing (a clean close) leaves at once, without the grace period.
  await b.connect();
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  b.ws.close(1001);
  await a.next('voice', (v) => v.room === hangout && !v.users.includes(b.id), 400);
  closeAll(a, b);
});

test('reconnect: someone banned while their slot is held can’t come back, and the slot goes at once', async () => {
  const { a, b, c, hangout, house } = await people('rb');
  await b.ok('voice.join', { room: hangout });
  await c.ok('voice.join', { room: hangout });
  await b.drop();
  await c.next('voice', (v) => v.room === hangout && v.state[b.id]?.reconnecting);
  await a.ok('mod.ban', { house, user: b.id });
  await c.next('voice', (v) => v.room === hangout && !v.users.includes(b.id));
  await b.connect();
  assert.ok(await b.refused('voice.join', { room: hangout }));
  assert.equal(srv.hub.voicePlaceOf(b.id), null);
  // A timeout instead: the refused comeback lets the held slot go straight away.
  await a.ok('mod.timeout', { house, user: c.id, ms: 60_000 }).catch(() => {});
  const d2 = await Client.make('rbdee', 'Dee Dune');
  const { code } = await a.ok('invite.create', { house });
  await d2.ok('invite.accept', { code });
  await d2.ok('voice.join', { room: hangout });
  await d2.drop();
  await a.ok('mod.timeout', { house, user: d2.id, ms: 60_000 });
  await d2.connect();
  assert.match(await d2.refused('voice.join', { room: hangout }), /timed out/);
  assert.equal(srv.hub.voicePlaceOf(d2.id), null, 'not held until the grace runs out');
  closeAll(a, b, c, d2);
});

// ---------- Share camera and screen ----------
test('video permission: a role without "Share camera and screen" is refused camera and screen; taking it away mid-call turns them off', async () => {
  const { a, b, hangout, house } = await people('vp');
  const role = srv.db.get('SELECT join_role FROM houses WHERE id = ?', house).join_role;
  await b.ok('voice.join', { room: hangout });
  await b.ok('voice.state', { camera: true, screen: true });
  b.clear();
  await a.ok('room.override', { room: hangout, type: 'role', target: role, allow: [], deny: ['video'] });
  const off = await a.next('voice', (v) => v.room === hangout && v.state[b.id] && !v.state[b.id].camera && !v.state[b.id].screen);
  assert.equal(off.state[b.id].muted, false, 'still speaking: only the pictures go');
  await b.next('voice.media.off', (e) => e.room === hangout);
  assert.match(await b.refused('voice.state', { camera: true }), /camera or screen/);
  assert.match(await b.refused('voice.state', { screen: true }), /camera or screen/);
  await b.ok('voice.state', { muted: true });
  assert.equal((await a.ok('room.perms', { room: hangout, user: b.id })).perms.video, false);
  // The owner still may.
  await a.ok('voice.join', { room: hangout });
  await a.ok('voice.state', { camera: true });
  closeAll(a, b);
});

// ---------- Whiteboard ----------
test('whiteboard: only people in the voice place draw and see it; strokes are checked; late joiners get the board; it ends when the place empties', async () => {
  const { a, b, c, d, hangout } = await people('wb');
  assert.match(await a.refused('activity.start', { kind: 'board' }), /Join the call/);
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  assert.match(await a.refused('activity.start', { kind: 'chess' }), /whiteboard or a game/);
  const { activity } = await a.ok('activity.start', { kind: 'board' });
  assert.equal(activity.kind, 'board');
  assert.equal((await b.next('activity', (e) => e.place === hangout)).activity.by, a.id);
  const line = [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]];
  await b.ok('board.stroke', { points: line, colour: 'mint', width: 2 });
  const got = await a.next('board.stroke', (e) => e.place === hangout);
  assert.deepEqual(got.stroke.points, line);
  assert.equal(got.stroke.by, b.id);
  // Not in voice: refused, and nothing reaches them.
  assert.match(await d.refused('board.stroke', { points: line, colour: 'mint', width: 2 }), /Join the call/);
  await d.none('board.stroke');
  // Bad input.
  const bad = [
    { points: [], colour: 'mint', width: 2 },
    { points: Array.from({ length: 257 }, () => [0.5, 0.5]), colour: 'mint', width: 2 },
    { points: [[0.5, 1.5]], colour: 'mint', width: 2 },
    { points: [[-0.1, 0.5]], colour: 'mint', width: 2 },
    { points: [['0.5', 0.5]], colour: 'mint', width: 2 },
    { points: [[0.5]], colour: 'mint', width: 2 },
    { points: 'nope', colour: 'mint', width: 2 },
    { points: line, colour: '#ff0000', width: 2 },
    { points: line, colour: 'violet', width: 2 }, // the brand: never a drawing colour
    { points: line, colour: 'mint', width: 5 },
    { points: line, colour: 'mint', width: 1.5 },
  ];
  for (const s of bad) assert.ok(await b.refused('board.stroke', s), JSON.stringify(s).slice(0, 60));
  assert.equal(srv.hub.activityOf(hangout).strokes.length, 1);
  // Undo takes back your own last stroke only.
  assert.match(await a.refused('board.undo'), /haven’t drawn/);
  // A late joiner gets the board as it is.
  await c.ok('voice.join', { room: hangout });
  const late = await c.next('activity', (e) => e.place === hangout);
  assert.equal(late.activity.strokes.length, 1);
  // Clearing: the starter (or a voice moderator), not anyone.
  assert.match(await b.refused('board.clear'), /Only the person who opened/);
  await b.ok('board.undo');
  assert.equal((await c.next('board.undo', (e) => e.place === hangout)).id, got.stroke.id);
  await b.ok('board.stroke', { points: line, colour: 'cyan', width: 1 });
  await a.ok('board.clear');
  await c.next('board.clear', (e) => e.place === hangout);
  assert.equal(srv.hub.activityOf(hangout).strokes.length, 0);
  // Everyone leaves: the board is gone.
  for (const p of [a, b, c]) await p.ok('voice.leave');
  assert.equal(srv.hub.activityOf(hangout), null);
  a.clear();
  await a.ok('voice.join', { room: hangout });
  await a.none('activity', (e) => e.place === hangout && e.activity);
  closeAll(a, b, c, d);
});

test('whiteboard: drawing is rate limited per person, and a timed-out or server-muted person can’t draw', async () => {
  const { a, b, hangout, house } = await people('wr');
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  await a.ok('activity.start', { kind: 'board' });
  const s = { points: [[0.2, 0.2], [0.3, 0.3]], colour: 'ink', width: 1 };
  let ok = 0, refused = 0;
  for (let i = 0; i < 30; i++) { const r = await b.op('board.stroke', s); if (r.ok) ok++; else { refused++; assert.match(r.error, /fast/); } }
  assert.ok(ok >= 20 && ok < 30 && refused > 0, `a burst of 20, then refused: ${ok} ok, ${refused} refused`);
  await a.ok('mod.voice', { house, user: b.id, mute: true });
  srv.resetLimits();
  assert.match(await b.refused('board.stroke', s), /moderator muted/);
  closeAll(a, b);
});

// ---------- Games ----------
test('games: tic-tac-toe is refereed by the server: seats, turns, taken squares, a win, and a rematch', async () => {
  const { a, b, c, d, hangout } = await people('gt');
  for (const p of [a, b, c]) await p.ok('voice.join', { room: hangout });
  await a.ok('game.start', { kind: 'ttt' });
  assert.match(await a.refused('game.move', { cell: 0 }), /other seat/);
  await b.ok('game.join');
  assert.match(await c.refused('game.join'), /Both seats/);
  assert.match(await c.refused('game.move', { cell: 0 }), /Take a seat/);
  assert.match(await d.refused('game.move', { cell: 0 }), /Join the call/);
  assert.match(await b.refused('game.move', { cell: 0 }), /not your turn/);
  await a.ok('game.move', { cell: 0 });
  assert.match(await b.refused('game.move', { cell: 0 }), /taken/);
  assert.match(await b.refused('game.move', { cell: 9 }), /taken/);
  assert.match(await b.refused('game.move', { cell: 'x' }), /Pick a square/);
  await b.ok('game.move', { cell: 3 });
  await a.ok('game.move', { cell: 1 });
  await b.ok('game.move', { cell: 4 });
  const win = (await a.ok('game.move', { cell: 2 })).game;
  assert.deepEqual(win.result, { winner: 0, line: [0, 1, 2] });
  const seen = await c.next('game', (e) => e.place === hangout && e.game.result);
  assert.equal(seen.game.result.winner, 0, 'watchers see it too');
  await d.none('game');
  assert.match(await b.refused('game.move', { cell: 5 }), /over/);
  assert.match(await c.refused('game.rematch'), /Only the players/);
  const re = (await b.ok('game.rematch')).game;
  assert.equal(re.turn, 1, 'the other player goes first');
  assert.equal(re.moves, 0);
  // A player leaving frees their seat; someone else can take it.
  await b.ok('voice.leave');
  const after = await a.next('activity', (e) => e.place === hangout && e.activity?.game.seats[1] === null);
  assert.equal(after.activity.game.seats[0], a.id);
  await c.ok('game.join');
  closeAll(a, b, c, d);
});

test('games: Connect Four drops into columns, refuses a full one, finds four in a row, and a resignation ends it', async () => {
  const { a, b, hangout } = await people('gc');
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  await a.ok('game.start', { kind: 'c4' });
  await b.ok('game.join');
  // Fill column 0 alternately: six pieces, then it is full.
  for (let i = 0; i < 6; i++) await (i % 2 ? b : a).ok('game.move', { col: 0 });
  assert.match(await a.refused('game.move', { col: 0 }), /full/);
  assert.match(await a.refused('game.move', { col: 7 }), /full/);
  // Ann: columns 1, 2, 3 on the bottom row; Ben stacks on 6.
  await a.ok('game.move', { col: 1 });
  await b.ok('game.move', { col: 6 });
  await a.ok('game.move', { col: 2 });
  await b.ok('game.move', { col: 6 });
  const g = (await a.ok('game.move', { col: 3 })).game;
  assert.equal(g.result.winner, 0);
  assert.deepEqual(g.result.line, [35, 36, 37, 38]);
  await a.ok('game.rematch');
  await b.ok('game.move', { col: 3 });
  const r = (await a.ok('game.resign')).game;
  assert.deepEqual(r.result, { winner: 1, resigned: a.id });
  closeAll(a, b);
});

// ---------- Voice reactions ----------
test('voice reactions: only people in voice, only the fixed list or the house’s own emoji, one a second', async () => {
  const { a, b, d, hangout } = await people('vr');
  assert.match(await a.refused('voice.react', { emoji: '👍' }), /Join the call/);
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  assert.match(await a.refused('voice.react', { emoji: '🍕' }), /reactions/);
  assert.match(await a.refused('voice.react', { emoji: '<script>' }), /reactions/);
  assert.match(await a.refused('voice.react', { emoji: '<:fake:em_abcdefgh12>' }), /reactions/);
  await a.ok('voice.react', { emoji: '🎉' });
  const r = await b.next('voice.react', (e) => e.place === hangout);
  assert.equal(r.user, a.id);
  assert.equal(r.emoji, '🎉');
  await d.none('voice.react');
  assert.match(await a.refused('voice.react', { emoji: '🎉' }), /second/);
  closeAll(a, b, d);
});

// ---------- Ring again ----------
test('ring again: only people in the call ring someone who declined, never someone already ringing or in it, blocked or too often', async () => {
  const { a, b, c, d, group } = await people('ra');
  const { call } = await a.ok('call.start', { dm: group });
  await b.next('call.ring', (r) => r.dm === group);
  await c.next('call.ring', (r) => r.dm === group);
  assert.match(await a.refused('call.ring', { dm: group, user: b.id }), /already being rung/);
  await b.ok('call.decline', { dm: group, call });
  await b.next('call.ring.stop', (s) => s.dm === group);
  // Not in the call: Cal (only rung) and Dot (not in the conversation).
  assert.match(await c.refused('call.ring', { dm: group, user: b.id }), /Join the call/);
  assert.match(await d.refused('call.ring', { dm: group, user: b.id }), /not in that conversation/);
  assert.match(await a.refused('call.ring', { dm: group, user: d.id }), /Pick someone/);
  await a.ok('call.ring', { dm: group, user: b.id });
  const again = await b.next('call.ring', (r) => r.dm === group);
  assert.equal(again.from, a.id);
  const v = await a.next('voice', (e) => e.room === group && e.call?.ringing.includes(b.id));
  assert.ok(v.call.ringing.includes(b.id));
  await b.ok('call.decline', { dm: group, call });
  assert.match(await a.refused('call.ring', { dm: group, user: b.id }), /just now/);
  // In the call already.
  await c.ok('call.join', { dm: group });
  assert.match(await a.refused('call.ring', { dm: group, user: c.id }), /already in the call/);
  // Blocked: never rung again.
  srv.resetLimits();
  await b.ok('block.set', { user: a.id, on: true });
  b.clear();
  assert.match(await a.refused('call.ring', { dm: group, user: b.id }), /can’t ring/);
  await b.none('call.ring');
  closeAll(a, b, c, d);
});

// ---------- Who can ring me ----------
test('who can ring me: friends only stops a non-friend’s ring and its push, a friend still rings, and the call is recorded as missed', async () => {
  const { a, b, c } = await people('wc');
  await b.ok('prefs.set', { prefs: { whoCanRing: 'friends' } });
  assert.match(await b.refused('prefs.set', { prefs: { whoCanRing: 'strangers' } }), /choices/);
  const pushed = [];
  const before = srv.hub.hooks.ring;
  srv.hub.hooks.ring = (u, r) => pushed.push([u, r]);
  try {
    const { id: ab } = await a.ok('dm.open', { users: [b.id] });
    await a.ok('call.start', { dm: ab });
    await b.none('call.ring', (r) => r.dm === ab, 300);
    // Ben has nothing open: no push either.
    await b.drop();
    const { id: cb } = await c.ok('dm.open', { users: [b.id] });
    await c.ok('call.start', { dm: cb });
    await sleep(200);
    assert.equal(pushed.filter(([u]) => u === b.id).length, 0, 'no push for someone who opted out');
    await b.connect();
    // Not rung, but recorded: a missed call once a ring would have run out.
    const rec = await b.next('msg', (e) => e.conv === ab && e.m.call, 2500);
    assert.equal(rec.m.call.outcome, 'missed');
    // A friend's call rings.
    await c.ok('voice.leave');
    await a.ok('friend.request', { user: b.id });
    await b.ok('friend.accept', { user: a.id });
    srv.resetLimits();
    await a.ok('call.start', { dm: ab });
    assert.equal((await b.next('call.ring', (r) => r.dm === ab)).from, a.id);
    await a.ok('voice.leave');
    // Nobody: not even friends.
    await b.ok('prefs.set', { prefs: { whoCanRing: 'nobody' } });
    srv.resetLimits();
    await a.ok('call.start', { dm: ab });
    await b.none('call.ring', (r) => r.dm === ab, 300);
    await a.ok('voice.leave');
  } finally { srv.hub.hooks.ring = before; }
  closeAll(a, b, c);
});

// ---------- TURN ----------
test('TURN: with a shared secret each person gets a credential that verifies, runs out in about 12 hours, and the static password is never sent', async () => {
  const a = await Client.make('turnann', 'Ann Turn');
  const check = (ice) => {
    assert.deepEqual(ice[0], { urls: ['stun:stun.example.org:3478'] });
    const turn = ice[1];
    assert.deepEqual(turn.urls, ['turn:turn.example.org:3478']);
    const [expiry, user] = turn.username.split(':');
    assert.equal(user, a.id);
    const left = Number(expiry) - Date.now() / 1000;
    assert.ok(left > 11 * 3600 && left <= 12 * 3600 + 5, `expires in about 12 hours: ${left}`);
    assert.equal(turn.credential, createHmac('sha1', SECRET).update(turn.username).digest('base64'));
    assert.ok(!JSON.stringify(ice).includes('static'), 'no static login');
  };
  check(a.hello.ice);
  check((await a.ok('ice.refresh')).ice);
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: a.cookie } })).json();
  check(me.ice);
  // Refreshing is rate limited.
  for (let i = 0; i < 3; i++) await a.op('ice.refresh');
  assert.match(await a.refused('ice.refresh'), /Wait/);
  const { iceConfig } = await import('../server/voiceopts.js');
  assert.deepEqual(iceConfig({ SNUG_TURN_URL: 'turn:t.example', SNUG_TURN_USER: 'u', SNUG_TURN_PASS: 'p' })[1], { urls: ['turn:t.example'], username: 'u', credential: 'p' }, 'without a secret the static login is the fallback');
  assert.equal(iceConfig({}).length, 1, 'no TURN configured: STUN only');
  a.ws.close();
});

test('grace: SNUG_VOICE_GRACE_MS only shortens the grace under the test runner', async () => {
  const { voiceGraceFrom, VOICE_GRACE } = await import('../server/hub.js');
  assert.equal(VOICE_GRACE, 20_000);
  assert.equal(voiceGraceFrom({ SNUG_VOICE_GRACE_MS: '500' }), 20_000);
  assert.equal(voiceGraceFrom({ SNUG_VOICE_GRACE_MS: '500', NODE_TEST_CONTEXT: 'child-v8' }), 500);
  assert.equal(voiceGraceFrom({ SNUG_VOICE_GRACE_MS: '5', NODE_TEST_CONTEXT: 'child-v8' }), 20_000);
});
