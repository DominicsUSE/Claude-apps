// Safety, privacy and moderation rules shared by the server (server/safety.js)
// and the browser (js/views/safety*.js). The server applies every one of them;
// the browser uses the same rules only to explain and to count down.
import { fold } from './util.js';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// How long someone can be timed out for.
export const TIMEOUTS = [
  [MIN, '60 seconds'], [5 * MIN, '5 minutes'], [HOUR, '1 hour'], [DAY, '1 day'], [7 * DAY, '1 week'],
];
// Slowmode choices, in seconds (0 is off): 5 seconds to 6 hours.
export const SLOWMODES = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
// How long an invitation link lasts (0 is never) and how many times it can be used (0 is no limit).
export const INVITE_AGES = [
  [30 * MIN, '30 minutes'], [HOUR, '1 hour'], [6 * HOUR, '6 hours'], [12 * HOUR, '12 hours'],
  [DAY, '1 day'], [7 * DAY, '7 days'], [14 * DAY, '14 days'], [0, 'Never'],
];
export const INVITE_USES = [0, 1, 5, 10, 25, 50, 100];
// Messages a ban can take with it.
export const BAN_DELETE = [[0, 'Don’t delete any'], [DAY, 'The last 24 hours'], [7 * DAY, 'The last 7 days']];
export const REPORT_REASONS = [
  ['spam', 'Spam or scams'], ['harassment', 'Harassment or bullying'], ['hate', 'Hate or slurs'],
  ['explicit', 'Sexual or graphic content'], ['self-harm', 'Someone may be at risk'], ['other', 'Something else'],
];
export const PRIVACY_DM = [['everyone', 'Everyone'], ['houses', 'People in my houses'], ['friends', 'Friends only']];
export const PRIVACY_FRIENDS = [['everyone', 'Everyone'], ['fof', 'Friends of friends'], ['nobody', 'Nobody']];
export const DEFAULT_PRIVACY = { dm: 'houses', friends: 'everyone', requests: false };
export const FILTER_ACTIONS = [['block', 'Block the message'], ['flag', 'Let it through and flag it'], ['timeout', 'Block it and time the person out']];
export const MAX_WORDS = 200;
export const WORD_MAX = 40;

// "60 seconds", "2 hours", "1 day": a slowmode or a duration, for people.
export function spell(seconds) {
  if (!seconds) return 'Off';
  const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [n, name] of units) if (seconds % n === 0 && seconds >= n) { const v = seconds / n; return `${v} ${name}${v === 1 ? '' : 's'}`; }
  return `${seconds} seconds`;
}
// "4s", "2m 5s", "1h 3m": what is left of a wait.
export function left(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ''}`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)}h` : ''}`;
}

// A blocked word as stored: folded, single spaces, letters, numbers, spaces,
// apostrophes and hyphens, with an optional * at the end for "starts with".
export function cleanWord(w) {
  if (typeof w !== 'string') return '';
  const s = fold(w).replace(/\s+/g, ' ').trim();
  if (!s || s.length > WORD_MAX) return '';
  return /^[\p{L}\p{N}][\p{L}\p{N} '’-]*\*?$/u.test(s) ? s : '';
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINK = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|co|me|app|dev|xyz|ly|tv|info|biz|ru|uk|de|link|site|online|shop|top|click)\b(?:\/\S*)?/i;

// Which rule a message breaks: { word } for a blocked word, { link: true } for
// a link when links are blocked, or null. Matching is on whole words, ignoring
// case and accents; "free*" matches "freebies" too.
export function filterHit(text, cfg) {
  if (!cfg || !text) return null;
  const t = fold(text);
  for (const w of cfg.words || []) {
    const prefix = w.endsWith('*');
    const body = esc(prefix ? w.slice(0, -1) : w).replace(/ /g, '\\s+');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${body}${prefix ? '' : '(?![\\p{L}\\p{N}])'}`, 'u');
    if (re.test(t)) return { word: w };
  }
  if (cfg.links && LINK.test(text)) return { link: true };
  return null;
}

// Role hierarchy. roles is the house's list in order (the first is the owner
// role), members maps a person to their role id. "actor" outranks "target" when
// the actor's role sits strictly above the target's and the target is not an
// owner. Nobody outranks themselves.
export function outranks(roles, members, actor, target) {
  if (!actor || !target || actor === target) return false;
  const pos = (u) => roles.findIndex((r) => r.id === members[u]);
  const a = pos(actor), t = pos(target);
  if (a < 0) return false;
  if (t === 0) return false;
  if (t < 0) return true; // not a member any more: only the permission matters
  return a < t;
}

// How long until this person may write in this room again, in ms (0 now).
export function slowWait(seconds, lastTs, now = Date.now()) {
  if (!seconds || !lastTs) return 0;
  return Math.max(0, lastTs + seconds * 1000 - now);
}
