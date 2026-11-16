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
import { openDb } from '../server/db.js';

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
// ---------- Listening without a microphone, and data saver signals ----------
test('listen only: "listen" is a real true or false in voice.state, reaches the others, and a later microphone clears it', async () => {
  const { a, b, hangout } = await people('ls');
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  assert.match(await b.refused('voice.state', { listen: 'yes' }), /isn’t valid/);
  await b.ok('voice.state', { muted: true, listen: true });
  const heard = await a.next('voice', (v) => v.room === hangout && v.state[b.id]?.listen === true);
  assert.equal(heard.state[b.id].muted, true);
  // A microphone added later in the call: talking, no longer listening.
  await b.ok('voice.state', { muted: false, listen: false });
  const now = await a.next('voice', (v) => v.room === hangout && v.state[b.id]?.muted === false);
  assert.equal(now.state[b.id].listen, undefined, 'not listening: the key is left out');
  // A listener's receive-only signalling still goes through.
  await b.ok('rtc', { to: a.id, data: { kinds: { mic: null } } });
  assert.deepEqual((await a.next('rtc', (r) => r.from === b.id)).data, { kinds: { mic: null } });
  closeAll(a, b);
});

test('data saver: { want: { camera } } is a signal with one true or false, rebuilt, and nothing else gets through', async () => {
  const { rtcSignal } = await import('../server/ops.js');
  assert.deepEqual(rtcSignal({ want: { camera: false } }), { want: { camera: false } });
  assert.deepEqual(rtcSignal({ want: { camera: true } }), { want: { camera: true } });
  assert.throws(() => rtcSignal({ want: { camera: 'off' } }));
  assert.throws(() => rtcSignal({ want: { camera: false, screen: false } }));
  assert.throws(() => rtcSignal({ want: {} }));
  const { a, b, hangout } = await people('ws');
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  await b.ok('rtc', { to: a.id, data: { want: { camera: false } } });
  assert.deepEqual((await a.next('rtc', (r) => r.from === b.id)).data, { want: { camera: false } });
  closeAll(a, b);
});

test('call keys (calls C1): { ck } carries a sealed key, an acknowledgement or why not, rebuilt from known fields with a size cap; the hello says the server passes it on', async () => {
  const { rtcSignal } = await import('../server/ops.js');
  const box = 'A'.repeat(108);
  const key = { v: 1, t: 'key', place: 'd_x', from: 'u_a', d: 'dv_abcdefghijklmnopqrst', to: 'u_b', id: 7, ts: 1_700_000_000_000, w: [['dv_bcdefghijklmnopqrstu', 3, box]], sig: 'S'.repeat(86) };
  assert.deepEqual(rtcSignal({ ck: key }), { ck: key });
  assert.deepEqual(rtcSignal({ ck: { v: 1, t: 'ack', id: 255 } }), { ck: { v: 1, t: 'ack', id: 255 } });
  assert.deepEqual(rtcSignal({ ck: { v: 1, t: 'no', why: 'browser' } }), { ck: { v: 1, t: 'no', why: 'browser' } });
  assert.throws(() => rtcSignal({ ck: { ...key, extra: 'x' } }), 'unknown fields');
  assert.throws(() => rtcSignal({ ck: { ...key, id: 256 } }));
  assert.throws(() => rtcSignal({ ck: { ...key, w: Array.from({ length: 13 }, () => key.w[0]) } }), 'at most 12 devices');
  assert.throws(() => rtcSignal({ ck: { ...key, w: [['dv_x', 1, 'B'.repeat(5000)]] } }), 'size cap');
  assert.throws(() => rtcSignal({ ck: { v: 1, t: 'no', why: '<script>' } }));
  assert.throws(() => rtcSignal({ ck: { v: 2, t: 'ack', id: 1 } }));
  // The fingerprint statement rides inside the SDP string, as before.
  const sdp = 'v=0\r\na=x-snug-fp:v1 dv_abcdefghijklmnopqrst sig\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  assert.equal(rtcSignal({ sdp: { type: 'offer', sdp } }).sdp.sdp, sdp);
  const { a, b, hangout } = await people('ck');
  assert.equal(a.hello.callE2ee, 1, 'clients send { ck } only to a server that says it passes it on');
  await a.ok('voice.join', { room: hangout });
  await b.ok('voice.join', { room: hangout });
  await b.ok('rtc', { to: a.id, data: { ck: { v: 1, t: 'ack', id: 3 } } });
  assert.deepEqual((await a.next('rtc', (r) => r.from === b.id)).data, { ck: { v: 1, t: 'ack', id: 3 } });
  closeAll(a, b);
});

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

// ---------- Call records (calls C5) ----------
test('call records: only who started it, how it went, when, how long and who missed it; no list of who took part; the expiry sweep and erasing an account cut it down', async () => {
  const { a, b, c, d, group, dm } = await people('rec');
  // A group call Ben answers, Cal declines, Dot isn't in (not a member).
  const { call } = await a.ok('call.start', { dm: group });
  await b.next('call.ring', (r) => r.dm === group);
  await c.next('call.ring', (r) => r.dm === group);
  await c.ok('call.decline', { dm: group, call });
  await b.ok('call.join', { dm: group });
  await sleep(50);
  await b.ok('voice.leave');
  await a.ok('voice.leave');
  const rec = (await a.next('msg', (e) => e.conv === group && e.m.call)).m;
  const stored = JSON.parse(srv.db.get('SELECT sys FROM messages WHERE id = ?', rec.id).sys);
  assert.deepEqual(Object.keys(stored).sort(), ['by', 'dur', 'missed', 'outcome', 'started', 'video'], 'nothing more is kept');
  // 0.12/0.13 clients read joined: worked out from the members who didn't miss it, not stored.
  assert.deepEqual(rec.call.joined.sort(), [a.id, b.id, c.id].sort());
  assert.deepEqual(rec.call.missed, [], 'Ben took part and Cal declined: nobody missed it');
  assert.equal(rec.call.outcome, 'answered');
  const row = srv.db.get('SELECT sys FROM messages WHERE id = ?', rec.id);
  assert.ok(!row.sys.includes(b.id) && !row.sys.includes(c.id), 'who took part or declined is not stored');
  // A one-to-one call nobody answers: the person who missed it is the one listed.
  await a.ok('call.start', { dm });
  await b.next('call.ring', (r) => r.dm === dm);
  await a.ok('voice.leave');
  const missed = (await b.next('msg', (e) => e.conv === dm && e.m.call)).m;
  assert.deepEqual(missed.call.missed, [b.id]);
  // The disappearing-messages sweep leaves only how it went.
  srv.db.run('UPDATE messages SET expires = ? WHERE id = ?', Date.now() - 1000, missed.id);
  srv.expiry.sweep(Date.now());
  assert.deepEqual(JSON.parse(srv.db.get('SELECT sys FROM messages WHERE id = ?', missed.id).sys), { outcome: 'missed' });
  // Erasing Ann's account (she started the group call) does the same to her records.
  srv.M.eraseAuthored(a.id);
  assert.deepEqual(JSON.parse(srv.db.get('SELECT sys FROM messages WHERE id = ?', rec.id).sys), { outcome: 'answered' });
  // Erasing Ben takes him off the records of calls others started.
  await a.ok('call.start', { dm });
  await b.next('call.ring', (r) => r.dm === dm);
  await a.ok('voice.leave');
  const again = (await b.next('msg', (e) => e.conv === dm && e.m.call)).m;
  srv.M.eraseAuthored(b.id);
  assert.deepEqual(JSON.parse(srv.db.get('SELECT sys FROM messages WHERE id = ?', again.id).sys).missed, []);
  closeAll(a, b, c, d);
});

test('call records a 0.12/0.13 sweep already blanked keep only how it went once the database is opened; records still showing are left alone', () => {
  const path = join(dir, 'old-records.db');
  const t = Date.now() - 100_000;
  const full = (id) => JSON.stringify({ id, by: 'u_old', video: false, outcome: 'answered', joined: ['u_old', 'u_two'], declined: ['u_three'], started: t, dur: 5000 });
  let db = openDb(path);
  db.run("INSERT INTO users (id, handle, name, pass, created) VALUES ('u_old', 'oldrec', 'Old Rec', 'x', ?)", t);
  const put = (id, expires, deleted) => db.run("INSERT INTO messages (id, conv, author, ts, text, fold, sys, expires, deleted) VALUES (?, 'd_old', 'u_old', ?, '', '', ?, ?, ?)", id, t, full(id), expires, deleted);
  put('m_swept', t + 1000, t + 1000); // what the 0.12/0.13 sweep left: deleted, words gone, sys untouched
  put('m_later', Date.now() + 86_400_000, null); // not expired yet
  put('m_kept', null, null); // no timer
  db.close();
  db = openDb(path);
  const sys = (id) => JSON.parse(db.get('SELECT sys FROM messages WHERE id = ?', id).sys);
  assert.deepEqual(sys('m_swept'), { outcome: 'answered' });
  assert.deepEqual(sys('m_later').joined, ['u_old', 'u_two'], 'a record still showing is untouched');
  assert.deepEqual(sys('m_kept').declined, ['u_three']);
  db.close();
});

// ---------- TURN ----------
test('TURN: with a shared secret each person gets a credential that verifies, runs out in about an hour, can’t be linked to their account, and the static password is never sent', async () => {
  const a = await Client.make('turnann', 'Ann Turn');
  const check = (ice, iceExp) => {
    assert.deepEqual(ice[0], { urls: ['stun:stun.example.org:3478'] });
    const turn = ice[1];
    assert.deepEqual(turn.urls, ['turn:turn.example.org:3478']);
    const [expiry, tag] = turn.username.split(':');
    // calls C4: the TURN operator sees an opaque tag, never the account id.
    assert.notEqual(tag, a.id);
    assert.ok(!turn.username.includes(a.id), 'no account id in the TURN username');
    assert.match(tag, /^[A-Za-z0-9_-]{16}$/);
    // Not even with the shared secret the TURN server holds: the tag is keyed with a key only Snug's server has.
    const day = Math.floor(Date.now() / 86_400_000);
    for (const d of [day - 1, day, day + 1]) assert.notEqual(tag, createHmac('sha256', SECRET).update(`${a.id}|${d}`).digest('base64url').slice(0, 16), 'the TURN secret alone gives the tag away');
    const left = Number(expiry) - Date.now() / 1000;
    assert.ok(left > 55 * 60 && left <= 3600 + 5, `expires in about an hour: ${left}`);
    // Still the coturn use-auth-secret scheme: the credential is HMAC-SHA1 of the username.
    assert.equal(turn.credential, createHmac('sha1', SECRET).update(turn.username).digest('base64'));
    assert.ok(!JSON.stringify(ice).includes('static'), 'no static login');
    // When it runs out, so the client refreshes before making a connection (js/voice.js).
    assert.equal(iceExp, Number(expiry) * 1000 - 5 * 60_000);
  };
  check(a.hello.ice, a.hello.iceExp);
  const r = await a.ok('ice.refresh');
  check(r.ice, r.iceExp);
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: a.cookie } })).json();
  check(me.ice, Number(me.ice[1].username.split(':')[0]) * 1000 - 5 * 60_000);
  // Refreshing is rate limited.
  for (let i = 0; i < 3; i++) await a.op('ice.refresh');
  assert.match(await a.refused('ice.refresh'), /Wait/);
  const { iceConfig } = await import('../server/voiceopts.js');
  const warned = [];
  assert.deepEqual(iceConfig({ SNUG_TURN_URL: 'turn:t.example', SNUG_TURN_USER: 'u', SNUG_TURN_PASS: 'p' }, { warn: (m) => warned.push(m) }).at(-1), { urls: ['turn:t.example'], username: 'u', credential: 'p' }, 'without a secret the static login is the fallback');
  assert.match(warned.join(' '), /static TURN login/i, 'a static login is warned about at startup');
  assert.equal(iceConfig({}).length, 1, 'no TURN configured: STUN only');
  a.ws.close();
});

test('TURN credentials (calls C4): the same tag all day for one person, different people get different tags, expiry follows the clock', async () => {
  const { turnCredential, TURN_TTL_S, iceExpOf } = await import('../server/voiceopts.js');
  assert.equal(TURN_TTL_S, 3600);
  const t = Date.UTC(2026, 10, 16, 9, 0, 0);
  const KEY = Buffer.alloc(32, 7);
  const a1 = turnCredential(SECRET, KEY, 'u_ann', t), a2 = turnCredential(SECRET, KEY, 'u_ann', t + 3 * 3600_000);
  const b1 = turnCredential(SECRET, KEY, 'u_bob', t);
  const tag = (c) => c.username.split(':')[1];
  assert.equal(tag(a1), tag(a2), 'stable within a day (one relay allocation per person per day can be told apart, no more)');
  assert.notEqual(tag(a1), tag(b1));
  assert.notEqual(tag(turnCredential(SECRET, KEY, 'u_ann', t + 86_400_000)), tag(a1), 'a new tag each day');
  assert.notEqual(tag(turnCredential(SECRET, Buffer.alloc(32, 8), 'u_ann', t)), tag(a1), 'the tag needs the server’s own key');
  assert.equal(tag(turnCredential('another-secret', KEY, 'u_ann', t)), tag(a1), 'the TURN secret plays no part in it');
  assert.equal(a1.credential, createHmac('sha1', SECRET).update(a1.username).digest('base64'), 'the credential is still the coturn one');
  assert.equal(Number(a1.username.split(':')[0]), t / 1000 + 3600);
  assert.equal(iceExpOf([{ urls: ['turn:x'], ...a1 }]), (t / 1000 + 3600) * 1000 - 5 * 60_000);
  assert.equal(iceExpOf([{ urls: ['stun:x'] }]), null);
  assert.equal(iceExpOf([{ urls: ['turn:x'], username: 'u', credential: 'p' }]), null, 'a static login has no expiry');
});

test('STUN: SNUG_STUN=none leaves the STUN server out (it sees callers’ IP addresses); unset uses the public default', async () => {
  const { iceConfig } = await import('../server/voiceopts.js');
  assert.deepEqual(iceConfig({ SNUG_STUN: 'none' }), []);
  assert.deepEqual(iceConfig({ SNUG_STUN: ' NONE ', SNUG_TURN_URL: 'turn:t.example', SNUG_TURN_USER: 'u', SNUG_TURN_PASS: 'p' }), [{ urls: ['turn:t.example'], username: 'u', credential: 'p' }]);
  assert.match(iceConfig({})[0].urls[0], /^stun:/);
  // calls C3: with TURN configured and SNUG_STUN unset, no outside STUN server (the TURN server answers STUN).
  assert.deepEqual(iceConfig({ SNUG_TURN_URL: 'turn:t.example', SNUG_TURN_SECRET: 's' })('u_x').map((s) => s.urls), [['turn:t.example']]);
});

test('grace: SNUG_VOICE_GRACE_MS only shortens the grace under the test runner', async () => {
  const { voiceGraceFrom, VOICE_GRACE } = await import('../server/hub.js');
  assert.equal(VOICE_GRACE, 20_000);
  assert.equal(voiceGraceFrom({ SNUG_VOICE_GRACE_MS: '500' }), 20_000);
  assert.equal(voiceGraceFrom({ SNUG_VOICE_GRACE_MS: '500', NODE_TEST_CONTEXT: 'child-v8' }), 500);
  assert.equal(voiceGraceFrom({ SNUG_VOICE_GRACE_MS: '5', NODE_TEST_CONTEXT: 'child-v8' }), 20_000);
});
