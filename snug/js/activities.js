// Activities in a voice place, in the browser: what is running in the call
// I am in (the whiteboard or a game), the strokes and moves as they arrive,
// voice reactions floating up from people's tiles, and the "You're muted"
// note. The server referees everything (server/activities.js); this module
// keeps what it says and sends what I do. The screens are js/views/activities.js.
import { S, emit, subscribe, toast, person } from './store.js';
import { call, on } from './server.js';
import { GAMES, moveName } from './lib/games.js';

// S.activity: { [place]: { id, kind, by, started, strokes?, game? } }, only for the place I am in.
S.activity ||= {};
S.vreacts ||= [];   // [{ id, place, user, emoji, custom, at }]: reactions floating now
S.actSay = '';      // the last thing to announce politely (a move, a reaction)

const first = (id) => (id === S.me ? 'You' : person(id).name.split(' ')[0]);
const mine = (place) => S.call?.room === place;

on('activity', ({ place, activity } = {}) => {
  if (!mine(place)) return;
  if (activity) S.activity[place] = activity; else delete S.activity[place];
  S.actSay = activity ? `${first(activity.by)} started ${activity.kind === 'board' ? 'the whiteboard' : GAMES[activity.kind]?.name}.` : 'The activity ended.';
});
on('board.stroke', ({ place, activity, stroke } = {}) => {
  const a = S.activity[place];
  if (!mine(place) || !a || a.id !== activity || !stroke) return;
  if (!a.strokes.some((s) => s.id === stroke.id)) a.strokes = [...a.strokes, stroke];
});
on('board.undo', ({ place, activity, id } = {}) => {
  const a = S.activity[place];
  if (a && a.id === activity) a.strokes = a.strokes.filter((s) => s.id !== id);
});
on('board.clear', ({ place, activity } = {}) => {
  const a = S.activity[place];
  if (a && a.id === activity) a.strokes = [];
});
on('game', ({ place, activity, game, by } = {}) => {
  const a = S.activity[place];
  if (!mine(place) || !a || a.id !== activity || !game) return;
  a.game = game;
  S.actSay = gameSay(game, by);
});
// What a screen reader hears after a move.
export function gameSay(g, by) {
  const who = (seat) => (g.seats[seat] ? first(g.seats[seat]) : 'Nobody');
  if (g.result?.resigned) return `${first(g.result.resigned)} resigned. ${who(g.result.winner)} won.`;
  const moved = g.last != null && by ? `${first(by)} played ${moveName(g.kind, g.last)}. ` : '';
  if (g.result?.draw) return `${moved}It’s a draw.`;
  if (g.result && g.result.winner != null) return `${moved}${who(g.result.winner)} won.`;
  if (!g.moves) return 'New game.';
  return `${moved}${g.seats[g.turn] === S.me ? 'Your turn.' : `${who(g.turn)}’s turn.`}`;
}

// Leaving the place: forget what was running there.
subscribe(() => {
  for (const place of Object.keys(S.activity)) if (!mine(place)) delete S.activity[place];
});

// ---------- Doing things ----------
const fail = (e) => { toast(e.offline ? 'You’re offline, so that didn’t reach anyone.' : e.message); return null; };
export const act = (op, d = {}) => call(op, d).catch(fail);
export const startActivity = (kind) => act(GAMES[kind] ? 'game.start' : 'activity.start', { kind });
export const stopActivity = () => act('activity.stop');

// ---------- Voice reactions ----------
const REACT_MS = 2400;
on('voice.react', ({ place, user, emoji, custom, at } = {}) => {
  if (!mine(place) || typeof user !== 'string' || typeof emoji !== 'string') return;
  const id = `${user}:${at}:${Math.random().toString(36).slice(2, 6)}`;
  S.vreacts = [...S.vreacts.slice(-11), { id, place, user, emoji, custom: custom || null, at: Date.now() }];
  S.actSay = `${first(user)} reacted ${custom ? `:${custom.name}:` : emoji}`;
  setTimeout(() => { S.vreacts = S.vreacts.filter((r) => r.id !== id); emit(); }, REACT_MS);
});
export const react = (emoji) => act('voice.react', { emoji });

// ---------- "You're muted" ----------
// The note stays for 8 seconds (js/voice.js decides when to show it).
let warnTimer = null;
let warnSeen = 0;
subscribe(() => {
  if (S.mutedWarn && S.mutedWarn !== warnSeen) {
    warnSeen = S.mutedWarn;
    clearTimeout(warnTimer);
    warnTimer = setTimeout(() => { if (S.mutedWarn === warnSeen) { S.mutedWarn = 0; emit(); } }, 8000);
  }
  if (S.mutedWarn && !S.call?.muted) S.mutedWarn = 0;
});
