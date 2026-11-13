// Shared building blocks. A person, a house, a room and a piece of message
// text look and behave the same wherever they appear.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, voiceRoomOf, toast } from '../store.js';
import { initials, hueOf } from '../lib/util.js';
import { parse } from '../lib/format.js';
import { Icon } from './icons.js';
import { CustomEmoji } from '../views/emoji-custom.js'; // custom emoji per house
import { Still, reducedMotion } from '../views/media.js'; // a still frame for animated pictures
import { profileInk } from '../lib/colour.js'; // profile colours keep their text readable
import { CodeBlock, renderExtra } from '../views/rich.js'; // headings, quotes, lists, spoilers, masked links, timestamps, code blocks

export const PRESENCE = {
  open: { label: 'Open to talk', hint: 'Happy to be called or pulled into a room.' },
  around: { label: 'Around', hint: 'Here and reading. Write any time.' },
  focus: { label: 'Focused', hint: 'Heads down. Notifications wait in Catch up.' },
  away: { label: 'Away', hint: 'Not at the screen.' },
  offline: { label: 'Offline', hint: 'Appear offline to everyone.' },
};

// Being in a voice room is the most useful thing to know, so it wins.
export const presenceOf = (user) => (user.presence !== 'offline' && voiceRoomOf(user.id) ? 'live' : user.presence);
export function presenceLabel(user) {
  const r = user.presence !== 'offline' && voiceRoomOf(user.id);
  return r ? `In ${S.rooms[r].name}` : PRESENCE[user.presence].label;
}

export function Pres({ user, inline }) {
  return html`<i class=${`pres ${presenceOf(user)}${inline ? ' inline' : ''}`} role="img" aria-label=${presenceLabel(user)}></i>`;
}

// Decorations drawn around the circle (people's own choice, js/lib/theme.js).
const star = (x, y, r) => `M${x} ${y - r}L${x + r / 4} ${y - r / 4}L${x + r} ${y}L${x + r / 4} ${y + r / 4}L${x} ${y + r}L${x - r / 4} ${y + r / 4}L${x - r} ${y}L${x - r / 4} ${y - r / 4}Z`;
const DECO_ART = {
  leaves: html`<svg viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M16 84c-10-9-11-25-2-33 6 11 7 23 2 33Zm68 0c10-9 11-25 2-33-6 11-7 23-2 33ZM26 92c-4-7-1-15 6-18 1 7-1 14-6 18Zm48 0c4-7 1-15-6-18-1 7 1 14 6 18Z"/></svg>`,
  stars: html`<svg viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d=${`${star(12, 18, 8)}${star(90, 12, 6)}${star(92, 80, 7)}`}/></svg>`,
};
export function Decoration({ user }) {
  if (!user?.decoration) return null;
  return html`<i class=${`deco ${user.decoration}`} aria-hidden="true">${DECO_ART[user.decoration] || null}</i>`;
}

export function Avatar({ user, size, presence, speaking, dim, onClick, deco = true }) {
  const [hover, setHover] = useState(false);
  const decorated = deco && user.decoration && (size ?? 40) >= 32;
  const cls = `avatar${speaking ? ' speaking' : ''}${dim ? ' dim' : ''}${decorated ? ' decorated' : ''}`;
  const style = `--hue:${hueOf(user.hue)}${size ? `;--sz:${size}px` : ''}`;
  // An animated picture is still until hovered, and always still with reduced motion.
  // A picture that can't load (removed, or its owner blocked you) falls back to the initials.
  const [broken, setBroken] = useState(null);
  const img = user.img && broken !== user.img ? user.img : null;
  const gone = () => setBroken(user.img);
  const still = img && user.imgAnim && (!hover || reducedMotion());
  const face = img ? (still ? html`<${Still} src=${img} alt="" onError=${gone} />` : html`<img src=${img} alt="" onError=${gone} />`)
    : user.emoji ? html`<span class="emo">${user.emoji}</span>`
      : html`<span class="ini">${initials(user.name)[0]}<span class="ini2">${initials(user.name).slice(1)}</span></span>`;
  const mark = presence ? html`<${Pres} user=${user} />` : null;
  const extra = { 'data-deco-hue': decorated && user.decorationHue != null ? String(hueOf(user.decorationHue)) : undefined };
  const hov = user.imgAnim ? { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false), onFocus: () => setHover(true), onBlur: () => setHover(false) } : {};
  const ring = decorated ? html`<${Decoration} user=${user} />` : null;
  if (onClick) return html`<button class=${cls} style=${style} ...${extra} ...${hov} onClick=${onClick} aria-label=${`${user.name}, open profile`}>${face}${ring}${mark}</button>`;
  return html`<span class=${cls} style=${style} ...${extra} ...${hov}>${face}${ring}${mark}</span>`;
}

// A person's name style, as data attributes (css/appearance.css draws them;
// a viewer can turn them off, and role colours win while shown).
export function nameAttrs(u) {
  const ns = u?.nameStyle;
  if (!ns) return {};
  return {
    'data-ns-font': ns.font && ns.font !== 'inter' ? ns.font : undefined,
    'data-ns-weight': ns.weight === 'bold' ? 'bold' : undefined,
    'data-ns-hue': ns.hue != null ? String(hueOf(ns.hue)) : undefined,
  };
}
// Profile colours on a card: a class and the custom properties, or nothing.
export function profileColours(u) {
  const pc = u?.profileColors;
  if (!Array.isArray(pc) || pc.length !== 2) return { cls: '', style: '' };
  const a = profileInk(pc[0]), b = profileInk(pc[1]);
  if (!a || !b) return { cls: '', style: '' };
  return { cls: ' has-pcolors', style: `;--pc-1:${pc[0]};--pc-2:${pc[1]};--pc-ink-1:${a.ink};--pc-ink-2:${b.ink}` };
}

export function Stack({ users, max = 3, size }) {
  const shown = users.slice(0, max);
  return html`<span class="stack">${shown.map((u) => html`<${Avatar} key=${u.id} user=${u} size=${size} speaking=${!!S.speaking[u.id]} />`)}</span>`;
}

// A house's tile: its icon clipped to the arch when it has one (server/community.js),
// over the mark and hue, which show if the picture can't load.
export const Tile = ({ house, lg, invite }) => html`<span class=${`tile${lg ? ' lg' : ''}${house.icon ? ' pic' : ''}`} style=${`--hue:${hueOf(house.hue)}`}>${house.mark}${house.icon
  ? html`<img src=${`/api/housepics/${house.icon}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`} alt="" loading="lazy" decoding="async" onError=${(e) => e.currentTarget.remove()} />` : null}</span>`;

// Text rooms are a hash and voice rooms a speaker, as in every chat app people already know.
export const KIND_ICON = { text: 'hash', voice: 'speaker', news: 'news', thread: 'thread', forum: 'forum', stage: 'stage' }; // forum, stage: js/views/places.js
export const RoomIcon = ({ kind, size }) => html`<${Icon} name=${KIND_ICON[kind] || 'room'} size=${size} />`;

export function Seg({ value, options, onChange, label }) {
  return html`<div class="seg" role="group" aria-label=${label}>
    ${options.map(([v, text]) => html`<button key=${v} type="button" aria-pressed=${String(value === v)} onClick=${() => onChange(v)}>${text}</button>`)}
  </div>`;
}

export const Switch = ({ on, onChange, label, disabled }) =>
  html`<button type="button" class="switch" role="switch" aria-checked=${String(!!on)} aria-label=${label} disabled=${disabled} onClick=${() => onChange(!on)}></button>`;

export function Empty({ icon, title, text, children, inline }) {
  return html`<div class=${`empty${inline ? ' inline' : ''}`}>
    ${icon && html`<${Icon} name=${icon} size=${24} />`}
    <h2>${title}</h2>
    ${text && html`<p>${text}</p>`}
    ${children}
  </div>`;
}

// An icon-only button: 32x32 (compact 28, sm 24), its name as the aria-label
// and the tooltip (with an optional shortcut). pressed: a toggle (aria-pressed).
export function IconButton({ icon, label, onClick, size, iconSize, cls = '', pressed, tip = true, tipKey, tipSide, danger, disabled, busy, ...rest }) {
  const sz = iconSize || (size === 'sm' ? 16 : size === 'compact' ? 18 : 20);
  const c = `ib${size === 'sm' ? ' sm' : size === 'compact' ? ' compact' : ''}${danger ? ' danger' : ''}${cls ? ` ${cls}` : ''}`;
  return html`<button type="button" class=${c} aria-label=${label} data-tip=${tip ? label : undefined} data-key=${tipKey} data-tip-side=${tipSide}
    aria-pressed=${pressed === undefined ? undefined : String(!!pressed)} aria-busy=${busy ? 'true' : undefined} disabled=${disabled} onClick=${onClick} ...${rest}><${Icon} name=${icon} size=${sz} /></button>`;
}

// A count: violet when it needs you (mentions, requests), neutral (quiet) when it doesn't.
export const Badge = ({ n, quiet, alert, label }) => (n > 0
  ? html`<span class=${`badge${quiet ? ' quiet' : ''}${alert ? ' alert' : ''}`} aria-label=${label}>${n > 99 ? '99+' : n}</span>` : null);

export const Spinner = ({ label = 'Loading' }) => html`<span class="spinner" role="status" aria-label=${label}></span>`;

// Message text
function marked(text, terms) {
  if (!terms?.length) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? html`<mark class="hit">${part}</mark>` : part));
}

function render(tokens, ctx) {
  return tokens.map((t) => {
    switch (t.t) {
      case 'text': return marked(t.v, ctx.hl);
      case 'code': return html`<code>${t.v}</code>`;
      case 'pre': return html`<${CodeBlock} lang=${t.lang} v=${t.v} />`;
      case 'b': return html`<strong>${render(t.c, ctx)}</strong>`;
      case 'i': return html`<em>${render(t.c, ctx)}</em>`;
      case 's': return html`<s>${render(t.c, ctx)}</s>`;
      case 'link': return html`<a href=${t.v} target="_blank" rel="noopener noreferrer">${t.v.replace(/^https?:\/\//, '')}</a>`;
      case 'at': {
        const u = S.users[t.v] || Object.values(S.users).find((x) => x.handle === t.v);
        if (!u) return `@${t.v}`;
        return html`<span class=${`at${u.id === S.me ? ' at-you' : ''}`} onClick=${(e) => ctx.onMention?.(u, e)}>@${u.name}</span>`;
      }
      case 'emoji': return html`<${CustomEmoji} id=${t.id} name=${t.v} m=${ctx.m} />`; // <:name:id>
      default: return renderExtra(t, ctx, render); // js/views/rich.js
    }
  });
}

const cache = new WeakMap();
export function Rich({ m, text, hl, onMention }) {
  const src = m ? m.text : text;
  let tokens;
  if (m) {
    const hit = cache.get(m);
    if (hit && hit.src === src) tokens = hit.tokens;
    else { tokens = parse(src || ''); cache.set(m, { src, tokens }); }
  } else tokens = parse(src || '');
  return html`<span class="rich">${render(tokens, { hl, onMention, m })}</span>`;
}

export function copyText(text) {
  const done = () => toast('Copied');
  const fail = () => toast('Couldn\u2019t copy. Select the text and copy it by hand.');
  try { navigator.clipboard.writeText(text).then(done, fail); } catch { fail(); }
}
