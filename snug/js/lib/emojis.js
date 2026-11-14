// The Unicode emoji set as something to search: names, keywords, categories,
// skin tones and :shortcode: resolution. The data is js/lib/emoji-data.js
// (generated, offline). No DOM here, so the rules are tested in Node.
import { CATEGORIES, RAW } from './emoji-data.js';

export { CATEGORIES };

// [{ c: '👋', names: ['waving_hand', 'wave'], keys: ['hello', ...], tone: true, cat: 'people' }]
export const ALL = [];
const byName = new Map();
const byChar = new Map();
for (const [cat] of CATEGORIES) {
  for (const line of RAW[cat].split('\n')) {
    const [c, names, keys, tone] = line.split('\t');
    const e = { c, names: names.split(','), keys: keys ? keys.split(',') : [], tone: tone === '1', cat };
    ALL.push(e);
    byChar.set(c, e);
    for (const n of e.names) if (!byName.has(n)) byName.set(n, e);
  }
}
export const emojiByName = (name) => byName.get(String(name).toLowerCase()) || null;
export const emojiByChar = (c) => byChar.get(c) || byChar.get(stripTone(c)) || null;
// The name shown for an emoji: its short name when it has one (":wave:"), else its Unicode name.
export const shortName = (e) => (e.names.length > 1 ? e.names[1] : e.names[0]);
export const label = (e) => e.names[0].replace(/_/g, ' ');

// Skin tones: 0 is the default yellow, 1 to 5 are Fitzpatrick types 1-2 to 6.
export const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
export const TONE_NAMES = ['Default', 'Light', 'Medium light', 'Medium', 'Medium dark', 'Dark'];
const TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
export const stripTone = (s) => String(s).replace(TONE_RE, '');
// A tone goes after each person or hand in the emoji. Inside a sequence like
// "people holding hands" the handshake itself stays as it is, and a variation
// selector straight after a toned character is dropped (✌️ becomes ✌🏽).
export function withTone(c, tone) {
  const t = TONES[tone] || '';
  if (!t) return c;
  const e = byChar.get(c);
  if (e && !e.tone) return c;
  const parts = c.split('‍');
  const many = parts.length > 1;
  return parts.map((p) => {
    const cps = [...p];
    const out = [];
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      out.push(cp);
      if (/\p{Emoji_Modifier_Base}/u.test(cp) && !(many && cp === '\u{1F91D}')) {
        out.push(t);
        if (cps[i + 1] === '️') i++;
      }
    }
    return out.join('');
  }).join('‍');
}

// Search: a name that starts with the term first, then a name containing it,
// then a keyword that starts with it, then a keyword containing it. Ties keep
// the Unicode order, which puts common emoji first.
export function rankEmoji(term, list = ALL, limit = Infinity) {
  const q = String(term || '').trim().toLowerCase().replace(/^:+|:+$/g, '').replace(/\s+/g, '_');
  if (!q) return list.slice(0, limit);
  const qs = q.replace(/_/g, ' ');
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    let s = -1;
    if (e.names.some((n) => n === q)) s = 5;
    else if (e.names.some((n) => n.startsWith(q))) s = 4;
    else if (e.names.some((n) => n.split('_').some((w) => w.startsWith(q)))) s = 3;
    else if (e.names.some((n) => n.includes(q))) s = 2.5;
    else if (e.keys.some((k) => k.startsWith(qs))) s = 2;
    else if (e.keys.some((k) => k.includes(qs))) s = 1;
    if (s >= 0) scored.push({ e, s, i });
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.e);
}

// :name: in a message becomes the emoji when the name is a Unicode emoji's
// (with the person's skin tone if it takes one). Unknown names, and anything
// inside code, stay exactly as typed. Custom emoji (<:name:id>) are resolved
// separately (js/views/emoji-custom.js) and left alone here.
export function resolveShortcodes(text, tone = 0) {
  if (!text || !text.includes(':')) return text;
  return String(text).split(/(```[\s\S]*?```|`[^`\n]*`|<:[a-z0-9_]{2,32}:em_[a-z0-9]{8,40}>)/).map((part, i) => {
    if (i % 2) return part;
    // Left to right, so :thumbsup::tada: is two emoji; a name glued to a word
    // or a number before it (10:30:00, http://a:b:) is never one.
    const re = /:([a-z0-9_+-]{1,40}):/gi;
    let out = '', last = 0, m;
    while ((m = re.exec(part))) {
      const before = m.index === last && out ? '' : part[m.index - 1] || '';
      const e = /[\w<]/.test(before) ? null : emojiByName(m[1]);
      if (!e) { re.lastIndex = m.index + 1; continue; }
      out += part.slice(last, m.index) + withTone(e.c, tone);
      last = re.lastIndex;
    }
    return out + part.slice(last);
  }).join('');
}

// "Frequently used": the counts kept in the emojiUse setting, highest first.
// Keys are emoji characters or custom emoji tokens.
export const MAX_USE_KEYS = 40;
export function bumpUse(use, key, max = MAX_USE_KEYS) {
  const next = { ...(use || {}) };
  next[key] = Math.min(1e6, (next[key] || 0) + 1);
  const keys = Object.keys(next);
  if (keys.length > max) {
    const others = keys.filter((k) => k !== key).sort((a, b) => next[a] - next[b]);
    for (const k of others.slice(0, keys.length - max)) delete next[k];
  }
  return next;
}
export const frequent = (use, n = 24) => Object.entries(use || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
