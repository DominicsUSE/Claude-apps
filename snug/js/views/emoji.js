// The emoji picker: the full Unicode set (js/lib/emoji-data.js) in nine
// categories, each house's custom emoji, "Frequently used" from your own
// counts (they follow you to every device), search by name then keyword, and
// a skin tone for every emoji that takes one.
import { html, useRef, useState } from '../../vendor/preact-htm.js';
import { S, emit } from '../store.js';
import { CustomEmoji, emojiById, houseEmoji, parseKey, tokenOf } from './emoji-custom.js'; // each house's custom emoji
import { ALL, CATEGORIES, rankEmoji, withTone, label, shortName, bumpUse, frequent, emojiByChar, TONES, TONE_NAMES, stripTone } from '../lib/emojis.js';
import { Icon } from '../ui/icons.js';

export const QUICK = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

// [char, names] for older callers: every Unicode emoji, first name first.
export const EMOJI = ALL.map((e) => [e.c, e.names.join(' ')]);

// The person's skin tone (the skinTone setting), applied to an emoji that takes one.
export const toned = (c) => withTone(c, S.prefs.skinTone || 0);

// Count a use, for "Frequently used". Custom emoji count by their token.
export function countUse(key) {
  S.prefs.emojiUse = bumpUse(S.prefs.emojiUse, key.startsWith('<:') ? key : stripTone(key));
}

const CAT_ICON = { smileys: '😀', people: '👋', nature: '🌿', food: '🍕', activities: '⚽', travel: '🚲', objects: '💡', symbols: '❤️', flags: '🏳️' };

// Items are [key, names, customEmoji?]. A custom emoji's key is its <:name:id>
// token; onPick gets the key either way (Unicode keys already carry the tone).
export function EmojiPicker({ onPick }) {
  const [q, setQ] = useState('');
  const [tones, setTones] = useState(false);
  const grid = useRef();
  const tabs = useRef();
  const tone = S.prefs.skinTone || 0;
  const term = q.trim().toLowerCase().replace(/^:+|:+$/g, '');
  const houses = houseEmoji();
  const custom = houses.map((h) => ({ id: `h-${h.house}`, title: h.name, items: h.list.map((e) => [tokenOf(e), e.name, e]), icon: S.houses[h.house]?.mark || h.name[0] }));
  const uni = (e) => [withTone(e.c, tone), label(e), null, e];
  // Frequently used: your counts, else the older recent list.
  const freqKeys = Object.keys(S.prefs.emojiUse || {}).length ? frequent(S.prefs.emojiUse, 24) : (S.prefs.recent || []).slice(0, 8);
  const freq = freqKeys.map((key) => {
    const k = parseKey(key);
    if (!k) { const e = emojiByChar(key); return e ? uni(e) : null; }
    const e = emojiById(k.id);
    return e && [tokenOf(e), e.name, e];
  }).filter(Boolean);
  let sections;
  if (term) {
    const found = custom.flatMap((s) => s.items).filter(([, n]) => n.includes(term))
      .sort((a, b) => b[1].startsWith(term) - a[1].startsWith(term));
    sections = [{ id: 'found', items: [...found, ...rankEmoji(term).map(uni)] }];
  } else {
    sections = [
      freq.length && { id: 'freq', title: 'Frequently used', items: freq, icon: 'clock' },
      ...custom,
      ...CATEGORIES.map(([id, title]) => ({ id, title, items: ALL.filter((e) => e.cat === id).map(uni), icon: CAT_ICON[id] })),
    ].filter(Boolean);
  }
  const list = sections.flatMap((s) => s.items);
  const pick = (key) => {
    countUse(key);
    S.prefs.recent = [key, ...(S.prefs.recent || []).filter((e) => e !== key)].slice(0, 8);
    emit();
    onPick(key);
  };
  const setTone = (t) => { S.prefs.skinTone = t; setTones(false); emit(); };
  const jump = (id) => {
    const el = grid.current?.querySelector(`[data-sec="${CSS.escape(id)}"]`);
    if (el) grid.current.scrollTop = el.offsetTop; // the grid is position: relative (css/emoji.css)
    el?.nextElementSibling?.focus?.({ preventScroll: true });
  };
  // The category row: one stop in the Tab order, arrows move along it.
  const onTabsKey = (e) => {
    const btns = [...tabs.current.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    const to = e.key === 'ArrowRight' ? btns[(i + 1) % btns.length] : e.key === 'ArrowLeft' ? btns[(i - 1 + btns.length) % btns.length]
      : e.key === 'Home' ? btns[0] : e.key === 'End' ? btns[btns.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    btns.forEach((b) => b.setAttribute('tabindex', '-1'));
    to.setAttribute('tabindex', '0');
    to.focus();
  };
  // Arrow keys move through the grid by position, so rows split by headings still line up.
  const onGridKey = (e) => {
    const btns = [...grid.current.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let to = null;
    if (e.key === 'ArrowRight') to = btns[i + 1];
    else if (e.key === 'ArrowLeft') to = btns[i - 1];
    else if (e.key === 'Home') to = btns[0];
    else if (e.key === 'End') to = btns[btns.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const r = btns[i].getBoundingClientRect();
      const down = e.key === 'ArrowDown';
      // Only the next row or two need measuring, not every emoji.
      const near = btns.slice(Math.max(0, i - 24), i + 24);
      const rows = near.map((b) => ({ b, r: b.getBoundingClientRect() })).filter(({ r: x }) => (down ? x.top > r.top + 2 : x.top < r.top - 2));
      if (rows.length) {
        const top = down ? Math.min(...rows.map(({ r: x }) => x.top)) : Math.max(...rows.map(({ r: x }) => x.top));
        const row = rows.filter(({ r: x }) => Math.abs(x.top - top) < 2);
        to = row.reduce((best, x) => (Math.abs(x.r.left - r.left) < Math.abs(best.r.left - r.left) ? x : best)).b;
      } else if (!down) to = grid.current.parentNode.querySelector('input');
    } else return;
    e.preventDefault();
    to?.focus();
    to?.scrollIntoView?.({ block: 'nearest' });
  };
  const swatch = (t) => withTone('✋', t);
  return html`<div class="picker">
    <div class="picker-top">
      <input class="field" data-autofocus placeholder="Find an emoji" aria-label="Find an emoji" value=${q}
        onInput=${(e) => setQ(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter' && list[0]) { e.preventDefault(); pick(list[0][0]); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); grid.current.querySelector('button')?.focus(); }
        }} />
      <button class="ib tone-btn" aria-label=${`Skin tone: ${TONE_NAMES[tone]}. Change`} aria-expanded=${String(tones)} data-tip="Skin tone"
        onClick=${() => setTones(!tones)}><span class="emo">${swatch(tone)}</span></button>
    </div>
    ${tones && html`<div class="tone-row" role="radiogroup" aria-label="Skin tone">
      ${TONES.map((_, t) => html`<button key=${t} role="radio" aria-checked=${String(t === tone)} class=${`tone${t === tone ? ' on' : ''}`}
        aria-label=${TONE_NAMES[t]} data-tip=${TONE_NAMES[t]} onClick=${() => setTone(t)}><span class="emo">${swatch(t)}</span></button>`)}
    </div>`}
    ${!term && html`<div class="picker-cats" role="toolbar" aria-label="Emoji categories" ref=${tabs} onKeyDown=${onTabsKey}>
      ${sections.map((s, i) => html`<button key=${s.id} tabindex=${i === 0 ? 0 : -1} aria-label=${s.title} data-tip=${s.title} onClick=${() => jump(s.id)}>
        ${s.icon === 'clock' ? html`<${Icon} name="clock" size=${16} />` : html`<span class="emo">${s.icon}</span>`}
      </button>`)}
    </div>`}
    <div class="picker-grid" ref=${grid} onKeyDown=${onGridKey}>
      ${sections.map((s) => [
        s.title && html`<div key=${`h${s.id}`} class="picker-sec" data-sec=${s.id} role="presentation">${s.title}</div>`,
        ...s.items.map(([c, names, e, u]) => (e
          ? html`<button key=${`${s.id}${c}`} class="picker-custom" aria-label=${`${names} (${S.houses[e.house]?.name || 'custom'})`} data-tip=${`:${names}:`} onClick=${() => pick(c)}><${CustomEmoji} e=${e} /></button>`
          : html`<button key=${`${s.id}${c}`} aria-label=${names} data-tip=${u ? `:${shortName(u)}:` : undefined} onClick=${() => pick(c)}>${c}</button>`)),
      ])}
      ${!list.length && html`<div class="picker-none">No emoji called “${q}”</div>`}
    </div>
  </div>`;
}
