// Things to do together in a voice place (a voice room or a call), on the
// server: a shared whiteboard, tic-tac-toe and Connect Four, and quick
// reactions that float up from your tile. Also a few call rules that belong
// with them: ringing someone again in a group call, who may ring you at all,
// fresh TURN credentials, and letting go of a held voice slot when coming
// back is refused.
//
// Everything here lives in memory, per voice place, and ends when the place
// empties. The server is the referee:
// - Only people in the place right now (hub.voicePlaceOf) can start, draw,
//   play or react, and only they hear about it (hub.voiceUsers).
// - A timeout in the house, an unaccepted rules screen, or a moderator's
//   server mute stops drawing, playing and reacting (M.mayTakePart, smute).
// - Every input is checked: at most 256 finite points from 0 to 1 per stroke,
//   2,000 strokes per board, colours from a fixed list of tokens, widths 1 to
//   4; moves only on your turn, into an empty cell or a column with room.
// - Drawing, moving and reacting are rate limited per person and per place.
import { newId } from './model.js';
import { limiter } from './auth.js';
import {
  BOARD_COLOURS, BOARD_WIDTHS, BOARD_LIMITS, VOICE_REACTIONS, GAMES, GAME_KINDS, ACTIVITY_KINDS, emptyBoard, gameResult, moveCell,
} from '../js/lib/games.js';

const CUSTOM = /^<:([a-z0-9_]{2,32}):(em_[a-z0-9]{8,40})>$/;
export const RING_AGAIN_S = 30;

export function createActivitiesOps({ db, M, hub, fail, ops = {} }) {
  const acts = new Map(); // place -> { id, kind, by, started, strokes?, seq?, game? }
  const out = {};

  // Rate limits, reset with the hub's.
  const L = {
    stroke: limiter({ capacity: 20, perSecond: 5 }),
    strokePlace: limiter({ capacity: 60, perSecond: 20 }),
    edit: limiter({ capacity: 10, perSecond: 2 }),         // start, stop, undo, clear, join, resign, rematch
    move: limiter({ capacity: 10, perSecond: 4 }),
    react: limiter({ capacity: 1, perSecond: 1 }),          // one a second...
    reactWindow: limiter({ capacity: 8, perSecond: 0.8 }),  // ...and 8 in 10 seconds
    reactPlace: limiter({ capacity: 20, perSecond: 2 }),
    ring: limiter({ capacity: 1, perSecond: 1 / RING_AGAIN_S }),  // per caller and person rung
    ringCaller: limiter({ capacity: 4, perSecond: 1 / 15 }),
    ice: limiter({ capacity: 3, perSecond: 1 / 60 }),
  };
  (hub.extraLimits ||= []).push(...Object.values(L));
  hub.activityLimits = L; // tests reach in to clear one

  const take = (lim, key, msg) => { if (!lim.take(key)) fail(msg); };
  const room = (place) => M.room(place);
  const first = (u) => (M.userRow(u)?.name || 'Someone').split(' ')[0];

  // In a voice place now, allowed to take part in it.
  function here(c, d, what) {
    const place = hub.voicePlaceOf?.(c.user);
    if (!place || hub.voiceHeld?.(c.user)) fail('Join the call or voice room first.');
    if (d.place !== undefined && d.place !== place) fail('You’re not in that voice room.');
    const st = hub.voiceStateOf?.(c.user);
    if (st?.smute || st?.sdeaf) fail(`A moderator muted you here, so you can’t ${what}.`);
    M.mayTakePart?.(c.user, place, what); // a timeout or unaccepted rules (server/safety.js)
    return place;
  }
  // The starter, a voice moderator of the house, someone who manages the
  // room, or anyone once the starter has left.
  function mayRun(user, place, act) {
    if (act.by === user || !hub.voiceUsers(place).includes(act.by)) return true;
    const r = room(place);
    return !!r && (M.can(user, r.house, 'voicemod') || !!M.roomPerms?.(user, r)?.manage);
  }

  const gameView = (g) => g && {
    kind: g.kind, seats: [...g.seats], board: [...g.board], turn: g.turn, result: g.result, moves: g.moves, last: g.last,
  };
  const view = (a) => a && {
    id: a.id, kind: a.kind, by: a.by, started: a.started,
    ...(a.kind === 'board' ? { strokes: a.strokes } : { game: gameView(a.game) }),
  };
  const toPlace = (place, ev, d) => hub.toUsers(hub.voiceUsers(place), ev, { place, ...d });
  const changed = (place) => toPlace(place, 'activity', { activity: view(acts.get(place)) || null });

  // Late joiners (and people coming back after a drop) get what is running.
  hub.voiceHooks.joined.push((u, place) => {
    const a = acts.get(place);
    if (a) hub.toUser(u, 'activity', { place, activity: view(a) });
  });
  // A player who leaves gives up their seat; the game waits for someone new.
  hub.voiceHooks.left.push((u, place) => {
    const a = acts.get(place);
    if (!a?.game) return;
    const g = a.game;
    const seat = g.seats.indexOf(u);
    if (seat < 0) return;
    g.seats[seat] = null;
    if (!g.result && g.moves) g.result = { left: u, winner: 1 - seat };
    if (hub.voiceUsers(place).length) changed(place);
  });
  hub.voiceHooks.empty.push((place) => acts.delete(place));
  hub.activityOf = (place) => view(acts.get(place)) || null; // tests

  // ---------- Starting and stopping ----------
  function newGame(kind, by) {
    return { kind, seats: [by, null], board: emptyBoard(kind), turn: 0, first: 0, result: null, moves: 0, last: null };
  }
  out['activity.start'] = (c, d) => {
    const kind = ACTIVITY_KINDS.includes(d.kind) ? d.kind : fail('Pick the whiteboard or a game.');
    const place = here(c, d, 'start an activity');
    take(L.edit, c.user, 'You’re going a little fast. Wait a moment.');
    const cur = acts.get(place);
    if (cur && !mayRun(c.user, place, cur)) fail(`${first(cur.by)} is running ${cur.kind === 'board' ? 'the whiteboard' : GAMES[cur.kind].name} here. Ask them to stop it first.`);
    const a = { id: newId('act'), kind, by: c.user, started: Date.now() };
    if (kind === 'board') { a.strokes = []; a.seq = 0; } else a.game = newGame(kind, c.user);
    acts.set(place, a);
    changed(place);
    return { activity: view(a) };
  };
  out['game.start'] = (c, d) => {
    if (!GAME_KINDS.includes(d.kind)) fail('Pick tic-tac-toe or Connect Four.');
    return out['activity.start'](c, d);
  };
  out['activity.stop'] = (c, d) => {
    const place = here(c, d, 'stop the activity');
    const a = acts.get(place) || fail('Nothing is running here.');
    if (!mayRun(c.user, place, a)) fail('Only the person who started it, or someone who moderates voice here, can stop it.');
    take(L.edit, c.user, 'You’re going a little fast. Wait a moment.');
    acts.delete(place);
    changed(place);
    return {};
  };

  // ---------- Whiteboard ----------
  const boardOf = (place) => { const a = acts.get(place); return a?.kind === 'board' ? a : fail('The whiteboard isn’t open here.'); };
  function points(v) {
    if (!Array.isArray(v) || !v.length || v.length > BOARD_LIMITS.points) fail(`A stroke has 1 to ${BOARD_LIMITS.points} points.`);
    return v.map((p) => {
      if (!Array.isArray(p) || p.length !== 2) fail('That stroke isn’t valid.');
      const [x, y] = p;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) fail('That stroke isn’t valid.');
      return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
    });
  }
  out['board.stroke'] = (c, d) => {
    const place = here(c, d, 'draw');
    const a = boardOf(place);
    const p = points(d.points);
    const colour = BOARD_COLOURS.includes(d.colour) ? d.colour : fail('Pick one of the whiteboard’s colours.');
    const width = BOARD_WIDTHS.includes(d.width) ? d.width : fail('Pick a pen size from 1 to 4.');
    if (a.strokes.length >= BOARD_LIMITS.strokes) fail('The whiteboard is full. Clear it to keep drawing.');
    take(L.stroke, c.user, 'You’re drawing a little fast. Wait a moment.');
    take(L.strokePlace, place, 'Lots of drawing at once here. Wait a moment.');
    const stroke = { id: ++a.seq, by: c.user, colour, width, points: p };
    a.strokes.push(stroke);
    toPlace(place, 'board.stroke', { activity: a.id, stroke });
    return { id: stroke.id };
  };
  out['board.undo'] = (c, d) => {
    const place = here(c, d, 'draw');
    const a = boardOf(place);
    take(L.edit, c.user, 'You’re going a little fast. Wait a moment.');
    let i = a.strokes.length - 1;
    while (i >= 0 && a.strokes[i].by !== c.user) i--;
    if (i < 0) fail('You haven’t drawn anything to undo.');
    const [s] = a.strokes.splice(i, 1);
    toPlace(place, 'board.undo', { activity: a.id, id: s.id });
    return { id: s.id };
  };
  out['board.clear'] = (c, d) => {
    const place = here(c, d, 'clear the whiteboard');
    const a = boardOf(place);
    if (!mayRun(c.user, place, a)) fail('Only the person who opened the whiteboard, or someone who moderates voice here, can clear it.');
    take(L.edit, c.user, 'You’re going a little fast. Wait a moment.');
    a.strokes = [];
    toPlace(place, 'board.clear', { activity: a.id });
    return {};
  };

  // ---------- Games ----------
  const gameOf = (place) => { const a = acts.get(place); return a?.game ? a : fail('No game is running here.'); };
  out['game.join'] = (c, d) => {
    const place = here(c, d, 'play');
    const a = gameOf(place), g = a.game;
    if (g.seats.includes(c.user)) return { game: gameView(g) };
    const seat = g.seats.indexOf(null);
    if (seat < 0) fail('Both seats are taken. Watch this one, or start a rematch after.');
    take(L.edit, c.user, 'You’re going a little fast. Wait a moment.');
    g.seats[seat] = c.user;
    // A seat freed mid-game starts a fresh game once it is filled again.
    if (g.result?.left) { g.board = emptyBoard(g.kind); g.result = null; g.moves = 0; g.last = null; g.turn = g.first; }
    changed(place);
    return { game: gameView(g) };
  };
  out['game.move'] = (c, d) => {
    const place = here(c, d, 'play');
    const a = gameOf(place), g = a.game;
    const seat = g.seats.indexOf(c.user);
    if (seat < 0) fail('Take a seat to play.');
    if (g.result) fail('This game is over. Start a rematch to play again.');
    if (g.seats.includes(null)) fail('Wait for someone to take the other seat.');
    if (g.turn !== seat) fail('It’s not your turn.');
    const move = g.kind === 'c4' ? d.col : d.cell;
    if (!Number.isInteger(move)) fail(g.kind === 'c4' ? 'Pick a column.' : 'Pick a square.');
    take(L.move, c.user, 'You’re going a little fast. Wait a moment.');
    const cell = moveCell(g.kind, g.board, move);
    if (cell < 0) fail(g.kind === 'c4' ? 'That column is full.' : 'That square is taken.');
    g.board[cell] = seat;
    g.moves++;
    g.last = cell;
    g.result = gameResult(g.kind, g.board);
    if (!g.result) g.turn = 1 - seat;
    toPlace(place, 'game', { activity: a.id, game: gameView(g), by: c.user });
    return { game: gameView(g) };
  };
  out['game.resign'] = (c, d) => {
    const place = here(c, d, 'play');
    const a = gameOf(place), g = a.game;
    const seat = g.seats.indexOf(c.user);
    if (seat < 0) fail('Only the players can resign.');
    if (g.result) fail('This game is already over.');
    take(L.edit, c.user, 'You’re going a little fast. Wait a moment.');
    g.result = { winner: 1 - seat, resigned: c.user };
    toPlace(place, 'game', { activity: a.id, game: gameView(g), by: c.user });
    return { game: gameView(g) };
  };
  out['game.rematch'] = (c, d) => {
    const place = here(c, d, 'play');
    const a = gameOf(place), g = a.game;
    if (!g.seats.includes(c.user)) fail('Only the players can start a rematch.');
    if (!g.result) fail('Finish this game first.');
    take(L.edit, c.user, 'You’re going a little fast. Wait a moment.');
    // The other person goes first this time.
    g.first = 1 - g.first;
    Object.assign(g, { board: emptyBoard(g.kind), turn: g.first, result: null, moves: 0, last: null });
    toPlace(place, 'game', { activity: a.id, game: gameView(g), by: c.user });
    return { game: gameView(g) };
  };

  // ---------- Voice reactions ----------
  out['voice.react'] = (c, d) => {
    const place = here(c, d, 'react');
    let emoji = typeof d.emoji === 'string' ? d.emoji : '';
    let custom = null;
    const m = CUSTOM.exec(emoji);
    if (m) {
      // A custom emoji of the house this voice room is in.
      const r = room(place);
      const e = db.get('SELECT * FROM house_emoji WHERE id = ?', m[2]);
      if (!r || !e || e.house !== r.house) fail('Pick one of the reactions, or an emoji of this house.');
      emoji = `<:${e.name}:${e.id}>`;
      custom = { name: e.name, file: e.file };
    } else if (!VOICE_REACTIONS.includes(emoji)) fail('Pick one of the reactions.');
    take(L.react, c.user, 'One reaction a second.');
    take(L.reactWindow, c.user, 'That’s a lot of reactions. Wait a moment.');
    take(L.reactPlace, place, 'Lots of reactions here just now. Wait a moment.');
    toPlace(place, 'voice.react', { user: c.user, emoji, ...(custom ? { custom } : {}), at: Date.now() });
    return {};
  };

  // ---------- Calls: ring someone again ----------
  out['call.ring'] = (c, d) => {
    const dm = typeof d.dm === 'string' && M.inDm(d.dm, c.user) ? d.dm : fail('You’re not in that conversation.');
    const target = typeof d.user === 'string' && d.user !== c.user && M.inDm(dm, d.user) ? d.user : fail('Pick someone in this conversation.');
    const call = hub.callOf(dm) || fail('That call has ended.');
    if (hub.voicePlaceOf?.(c.user) !== dm || hub.voiceHeld?.(c.user)) fail('Join the call to ring people.');
    if (hub.voiceUsers(dm).includes(target)) fail(`${first(target)} is already in the call.`);
    if (call.ringing.includes(target)) fail(`${first(target)} is already being rung.`);
    if (M.ringBlocked?.(c.user, target, dm)) fail(`You can’t ring ${first(target)}.`);
    take(L.ring, `${c.user}:${target}`, `You rang ${first(target)} just now. Wait a little before ringing again.`);
    take(L.ringCaller, c.user, 'You’re ringing a lot of people. Wait a moment.');
    hub.callRing(dm, target);
    return {};
  };

  // ---------- Who may ring me (prefs: whoCanRing) ----------
  // Enforced where every ring and its push start (server/hub.js ring), so
  // someone who opted out is never rung; the call is still recorded as missed.
  const baseBlocked = M.ringBlocked || (() => false);
  M.ringBlocked = (caller, user, dm) => {
    if (baseBlocked(caller, user, dm)) return true;
    const who = M.prefsOf?.(user)?.whoCanRing || 'everyone';
    if (who === 'nobody') return true;
    if (who === 'friends') return !M.areFriends(user, caller);
    return false;
  };

  // ---------- Fresh TURN credentials (server/voiceopts.js iceConfig) ----------
  out['ice.refresh'] = (c) => {
    take(L.ice, c.user, 'Wait a moment before asking again.');
    return { ice: hub.iceFor(c.user) };
  };

  // ---------- Coming back after a drop, refused ----------
  // A held voice slot whose owner may no longer come back (banned, timed out,
  // no longer allowed in the room) is let go at once instead of waiting out
  // the grace period.
  for (const name of ['voice.join', 'call.join']) {
    const base = ops[name];
    if (!base) continue;
    out[name] = (c, d) => {
      const held = hub.voiceHeld?.(c.user);
      try { return base(c, d); } catch (e) {
        const target = name === 'voice.join' ? d.room : d.dm;
        if (held && held === target && hub.voiceHeld?.(c.user) === held) hub.voiceLeave(c.user);
        throw e;
      }
    };
  }

  return out;
}
