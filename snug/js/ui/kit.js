// Shared building blocks. A person, a house, a room and a piece of message
// text look and behave the same wherever they appear.
import { html } from '../../vendor/preact-htm.js';
import { S, voiceRoomOf, toast } from '../store.js';
import { initials, hueOf } from '../lib/util.js';
import { parse } from '../lib/format.js';
import { Icon } from './icons.js';

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

export function Avatar({ user, size, presence, speaking, dim, onClick }) {
  const cls = `avatar${speaking ? ' speaking' : ''}${dim ? ' dim' : ''}`;
  const style = `--hue:${hueOf(user.hue)}${size ? `;--sz:${size}px` : ''}`;
  const face = user.img ? html`<img src=${user.img} alt="" />`
    : user.emoji ? html`<span class="emo">${user.emoji}</span>`
      : html`<span class="ini">${initials(user.name)[0]}<span class="ini2">${initials(user.name).slice(1)}</span></span>`;
  const mark = presence ? html`<${Pres} user=${user} />` : null;
  if (onClick) return html`<button class=${cls} style=${style} onClick=${onClick} aria-label=${`${user.name}, open profile`}>${face}${mark}</button>`;
  return html`<span class=${cls} style=${style}>${face}${mark}</span>`;
}

export function Stack({ users, max = 3, size }) {
  const shown = users.slice(0, max);
  return html`<span class="stack">${shown.map((u) => html`<${Avatar} key=${u.id} user=${u} size=${size} speaking=${!!S.speaking[u.id]} />`)}</span>`;
}

export const Tile = ({ house, lg }) => html`<span class=${`tile${lg ? ' lg' : ''}`} style=${`--hue:${hueOf(house.hue)}`}>${house.mark}</span>`;

const KIND_ICON = { text: 'room', voice: 'voice', news: 'news', thread: 'thread' };
export const RoomIcon = ({ kind, size }) => html`<${Icon} name=${KIND_ICON[kind] || 'room'} size=${size} />`;

export function Seg({ value, options, onChange, label }) {
  return html`<div class="seg" role="group" aria-label=${label}>
    ${options.map(([v, text]) => html`<button key=${v} aria-pressed=${String(value === v)} onClick=${() => onChange(v)}>${text}</button>`)}
  </div>`;
}

export const Switch = ({ on, onChange, label }) =>
  html`<button class="switch" role="switch" aria-checked=${String(!!on)} aria-label=${label} onClick=${() => onChange(!on)}></button>`;

export function Empty({ icon, title, text, children }) {
  return html`<div class="empty">
    ${icon && html`<${Icon} name=${icon} size=${28} />`}
    <h2>${title}</h2>
    ${text && html`<p>${text}</p>`}
    ${children}
  </div>`;
}

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
      case 'pre': return html`<pre><code>${t.v}</code></pre>`;
      case 'b': return html`<strong>${render(t.c, ctx)}</strong>`;
      case 'i': return html`<em>${render(t.c, ctx)}</em>`;
      case 's': return html`<s>${render(t.c, ctx)}</s>`;
      case 'link': return html`<a href=${t.v} target="_blank" rel="noopener noreferrer">${t.v.replace(/^https?:\/\//, '')}</a>`;
      case 'at': {
        const u = S.users[t.v] || Object.values(S.users).find((x) => x.handle === t.v);
        if (!u) return `@${t.v}`;
        return html`<span class=${`at${u.id === S.me ? ' at-you' : ''}`} onClick=${(e) => ctx.onMention?.(u, e)}>@${u.name}</span>`;
      }
      default: return null;
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
  return html`<span class="rich">${render(tokens, { hl, onMention })}</span>`;
}

export function copyText(text) {
  const done = () => toast('Copied');
  const fail = () => toast('Couldn\u2019t copy. Select the text and copy it by hand.');
  try { navigator.clipboard.writeText(text).then(done, fail); } catch { fail(); }
}
