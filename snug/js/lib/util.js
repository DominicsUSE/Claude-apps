// Small pure helpers shared by every module.

let seq = 0;
export const uid = (prefix = 'x') => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export const MIN = 60_000;
export const DAY = 86_400_000;

export const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

let timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const shortFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
let fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
// Settings > Appearance > Clock (js/account.js): 'auto' follows the language, or force 12 or 24 hours.
let clockMode = 'auto';
export function setClock(mode = 'auto') {
  if (mode === clockMode) return;
  clockMode = mode;
  const hc = mode === '24' ? { hourCycle: 'h23' } : mode === '12' ? { hourCycle: 'h12' } : {};
  timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', ...hc });
  fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', ...hc });
}

export const fmtTime = (ts) => timeFmt.format(ts);
export const fmtFull = (ts) => fullFmt.format(ts);

export function fmtDay(ts, now = Date.now()) {
  if (sameDay(ts, now)) return 'Today';
  if (sameDay(ts, now - DAY)) return 'Yesterday';
  return dayFmt.format(ts);
}

// Compact stamp for lists: a time today, otherwise a short date.
export function fmtWhen(ts, now = Date.now()) {
  if (sameDay(ts, now)) return fmtTime(ts);
  if (sameDay(ts, now - DAY)) return `Yesterday ${fmtTime(ts)}`;
  return shortFmt.format(ts);
}

export function initials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// "Ines", "Ines and Tomasz", "Ines, Tomasz and 2 others"
export function nameList(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

// Subsequence match that favours word starts. Returns a score, or -1 for no match.
export function fuzzy(query, text) {
  const q = fold(query), t = fold(text);
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at === 0) return 100 - t.length * 0.1;
  if (at > 0) return (t[at - 1] === ' ' ? 80 : 60) - at * 0.1;
  let score = 0, ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === ti ? 2 : 1;
    ti = found + 1;
  }
  return score;
}

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// The colours people, roles and houses can choose: OKLCH hues only, named for
// screen readers. The theme sets lightness and chroma. Kept at least 25 degrees
// clear of the hues that carry meaning: error red (23 to 25), amber (73 to 81),
// mint (168 to 170) and brand violet (289 to 297: the mark 293, the tokens
// from 289 in light to 297 as dark text). Nothing sits between Blue and Clay
// rose, so no chosen colour can pass for the brand, a warning or a presence.
export const HUES = [[106, 'Olive'], [142, 'Green'], [200, 'Teal'], [228, 'Sky'], [255, 'Blue'], [335, 'Clay rose'], [350, 'Pink']];
// Hues that were choosable once and may still be stored. They stay valid (a
// role saved as Plum can be saved again) but show as the nearest choosable
// hue (hueOf): Plum (318) sat too close to the violet brand.
export const RETIRED_HUES = [318];

// Any stored hue, shown as the nearest choosable one, so older choices never
// read as a warning, a highlight or a presence colour.
export function hueOf(h) {
  if (h == null) return h;
  let best = HUES[0][0], gap = 360;
  for (const [v] of HUES) {
    const d = Math.min(Math.abs(v - h), 360 - Math.abs(v - h));
    if (d < gap) { gap = d; best = v; }
  }
  return best;
}
