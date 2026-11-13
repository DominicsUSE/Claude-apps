// Custom emoji per house, in the browser: looking them up, drawing them, and
// turning what people type (:name:) into the tokens messages store.
//
// - S.emoji holds each joined house's emoji: { [houseId]: [{ id, house, name, file, by, created }] }.
// - Messages store <:name:id>. The sender's browser resolves :name: from the
//   houses they are in, preferring the conversation's own house.
// - A token draws as the image only while the emoji exists and this person may
//   see it: from one of their houses, or from the metadata the server put on
//   that message (m.emoji). Otherwise it reads as the plain :name:.
// - Images only ever come from /api/files/<id> on this server.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, convMeta } from '../store.js';
import { on } from '../server.js';
import { Still, reducedMotion } from './media.js'; // a still frame for animated emoji (Settings > Appearance > Chat)

const KEY = /^<:([a-z0-9_]{2,32}):(em_[a-z0-9]{8,40})>$/;
const TOKEN_G = /<:([a-z0-9_]{2,32}):(em_[a-z0-9]{8,40})>/g;
const FILE = /^f_[a-z0-9]{8,40}$/;
export const EMOJI_NAME = /^[a-z0-9_]{2,32}$/;
export const MAX_EMOJI = 100;

export const tokenOf = (e) => `<:${e.name}:${e.id}>`;
export const parseKey = (k) => { const m = KEY.exec(k || ''); return m ? { name: m[1], id: m[2] } : null; };
// Tokens shown the way people type them.
export const asTyped = (text) => (text || '').replace(TOKEN_G, ':$1:');

// id -> emoji, rebuilt when the emoji lists change.
let index = new Map();
let indexOf = null;
function byId() {
  if (indexOf !== S.emoji) {
    index = new Map();
    for (const list of Object.values(S.emoji || {})) for (const e of list) index.set(e.id, e);
    indexOf = S.emoji;
  }
  return index;
}

// The emoji behind an id, if this person may see it now.
export function emojiById(id, m) {
  const e = byId().get(id);
  if (e && S.houses[e.house]?.joined) return e;
  const meta = m?.emoji?.[id];
  return meta ? { id, ...meta } : null;
}

// The houses this person is in that have emoji, in sidebar order.
export function houseEmoji() {
  return (S.houseOrder || []).filter((h) => S.houses[h]?.joined && S.emoji?.[h]?.length)
    .map((h) => ({ house: h, name: S.houses[h].name, list: S.emoji[h] }));
}

// :name: -> <:name:id>, outside code. Names already used in the message being
// edited win, then the conversation's own house, then the other houses in order.
export function resolveEmoji(conv, text, original = '') {
  if (!text || !text.includes(':')) return text;
  const names = new Map();
  for (const x of (original || '').matchAll(TOKEN_G)) if (!names.has(x[1])) names.set(x[1], x[0]);
  const here = convMeta(conv)?.house;
  for (const h of [here, ...(S.houseOrder || []).filter((x) => x !== here)]) {
    if (!h || !S.houses[h]?.joined) continue;
    for (const e of S.emoji?.[h] || []) if (!names.has(e.name)) names.set(e.name, tokenOf(e));
  }
  if (!names.size) return text;
  return text.split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => (i % 2 ? part
    : part.replace(/(?<![\w<]):([a-z0-9_]{2,32}):(?!\w)/g, (all, n) => names.get(n) || all))).join('');
}

// Composer suggestions for ":pa": [typed, name, emoji], the same shape as the
// built-in list's [char, names] so accepting one inserts ":party: ".
export function customSuggest(q, conv) {
  const here = convMeta(conv)?.house;
  const all = houseEmoji().sort((a, b) => (b.house === here) - (a.house === here)).flatMap((h) => h.list);
  const seen = new Set();
  return all.filter((e) => e.name.includes(q) && !seen.has(e.name) && seen.add(e.name))
    .sort((a, b) => (b.name.startsWith(q) - a.name.startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 6).map((e) => [`:${e.name}:`, e.name, e]);
}

export function CustomEmoji({ id, name, m, e: given }) {
  const [broken, setBroken] = useState(null);
  const [over, setOver] = useState(false);
  const e = given || emojiById(id, m);
  if (!e || !FILE.test(e.file) || broken === e.file) {
    return html`<span class="cemoji-gone" title="This emoji was removed, or is from a house you’re not in">:${name || e?.name}:</span>`;
  }
  // Settings > Appearance > Chat (animatedEmoji): auto moves unless motion is
  // reduced; hover and never show a still frame until pointed at or focused.
  const mode = S.prefs.animatedEmoji || 'auto';
  const still = mode === 'always' ? false : mode === 'auto' ? reducedMotion() : !over;
  const src = `/api/files/${e.file}`;
  if (still) {
    return html`<span class="cemoji cemoji-still" title=${`:${e.name}:`} tabindex=${mode === 'auto' ? undefined : -1}
      onPointerEnter=${() => setOver(true)} onFocus=${() => setOver(true)}><${Still} src=${src} alt=${`:${e.name}:`} /></span>`;
  }
  return html`<img class="cemoji" src=${src} alt=${`:${e.name}:`} title=${`:${e.name}:`} draggable="false"
    onPointerLeave=${() => setOver(false)} onBlur=${() => setOver(false)} onError=${() => setBroken(e.file)} />`;
}

// Reaction chips: the face and the words for a reaction key.
export function reactionFace(key, m) {
  const k = parseKey(key);
  return k ? html`<${CustomEmoji} id=${k.id} name=${k.name} m=${m} />` : key;
}
export function reactionLabel(key, m) {
  const k = parseKey(key);
  return k ? `:${emojiById(k.id, m)?.name || k.name}:` : key;
}

// Live changes. A house's list replaces the old one; a removed emoji also
// leaves every message that carried its metadata, so it reads as text at once.
on('emoji', ({ house, list }) => { S.emoji = { ...(S.emoji || {}), [house]: list || [] }; });
on('emoji.gone', ({ id, house }) => {
  if (S.emoji?.[house]?.some((e) => e.id === id)) S.emoji = { ...S.emoji, [house]: S.emoji[house].filter((e) => e.id !== id) };
  const strip = (m) => { if (m?.emoji?.[id]) { const { [id]: _, ...rest } = m.emoji; m.emoji = rest; } };
  for (const list of Object.values(S.msgs || {})) list.forEach(strip);
  Object.values(S.cache || {}).forEach(strip);
});
