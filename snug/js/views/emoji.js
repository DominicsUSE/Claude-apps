// A small, searchable emoji set. Enough for reactions and messages without
// shipping a database.
import { html, useRef, useState } from '../../vendor/preact-htm.js';
import { S } from '../store.js';
import { CustomEmoji, emojiById, houseEmoji, parseKey, tokenOf } from './emoji-custom.js'; // each house's custom emoji

export const QUICK = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

export const EMOJI = `👍 thumbsup yes +1|👎 thumbsdown no|❤️ heart love|😂 joy laugh lol|😊 smile happy|🙂 slight smile|😉 wink|😍 heart eyes love|🤔 thinking hmm|😅 sweat smile phew|😭 sob cry|😢 sad cry|😮 wow surprised|😴 sleep tired|🙃 upside down|😬 grimace awkward|🥳 party celebrate|😎 cool sunglasses|🤝 handshake deal|🙏 pray thanks please|👏 clap applause|🙌 raised hands hooray|💪 muscle strong|👋 wave hello hi|👀 eyes look|🫡 salute yes|🤷 shrug|🎉 tada party celebrate|🔥 fire hot|✨ sparkles|💡 idea bulb|✅ check done yes|❌ cross no|⚠️ warning|❓ question|💯 hundred|⭐ star|🚀 rocket ship launch|🐛 bug|🛠️ tools fix|📌 pin|📝 memo note|📅 calendar date|⏰ alarm clock time|☕ coffee|🍵 tea|🍪 cookie biscuit|🍰 cake|🍕 pizza|🍺 beer|🏺 pot vase amphora|🎨 art palette|🧱 brick clay|🚲 bike bicycle|🚴 cyclist ride|⛰️ mountain climb|🌧️ rain|☀️ sun|❄️ snow cold|🌿 herb plant|🦊 fox|🐢 turtle slow|🎛️ knobs synth|🎧 headphones|🎵 music note|💻 laptop computer|📦 package box|🧵 thread|💤 zzz sleep|🚇 metro train|👌 ok perfect|🤞 fingers crossed luck|😇 angel|🥲 smile tear|😤 huff|🤯 mind blown|😱 scream|🫠 melting|💀 skull dead|🤖 robot`
  .split('|').map((row) => { const i = row.indexOf(' '); return [row.slice(0, i), row.slice(i + 1)]; });

// Items are [key, names, customEmoji?]. A custom emoji's key is its <:name:id>
// token; onPick gets the key either way.
export function EmojiPicker({ onPick }) {
  const [q, setQ] = useState('');
  const grid = useRef();
  const term = q.trim().toLowerCase().replace(/^:+|:+$/g, '');
  const houses = houseEmoji();
  const custom = houses.map((h) => ({ title: h.name, items: h.list.map((e) => [tokenOf(e), e.name, e]) }));
  const recent = (S.prefs.recent || []).map((key) => {
    const k = parseKey(key);
    if (!k) return EMOJI.find(([c]) => c === key);
    const e = emojiById(k.id);
    return e && [tokenOf(e), e.name, e];
  }).filter(Boolean);
  let sections;
  if (term) {
    const found = custom.flatMap((s) => s.items).filter(([, n]) => n.includes(term))
      .sort((a, b) => b[1].startsWith(term) - a[1].startsWith(term));
    sections = [{ items: [...found, ...EMOJI.filter(([, names]) => names.includes(term))] }];
  } else if (!custom.length) {
    sections = [{ items: [...recent, ...EMOJI.filter(([c]) => !recent.some(([r]) => r === c))] }];
  } else {
    sections = [recent.length && { title: 'Recent', items: recent }, ...custom, { title: 'Standard', items: EMOJI }].filter(Boolean);
  }
  const list = sections.flatMap((s) => s.items);
  const pick = (key) => {
    S.prefs.recent = [key, ...(S.prefs.recent || []).filter((e) => e !== key)].slice(0, 8);
    onPick(key);
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
      const rows = btns.map((b) => b.getBoundingClientRect()).map((b, j) => ({ j, b }))
        .filter(({ b }) => (down ? b.top > r.top + 2 : b.top < r.top - 2));
      if (rows.length) {
        const top = down ? Math.min(...rows.map(({ b }) => b.top)) : Math.max(...rows.map(({ b }) => b.top));
        const row = rows.filter(({ b }) => Math.abs(b.top - top) < 2);
        to = btns[row.reduce((best, x) => (Math.abs(x.b.left - r.left) < Math.abs(best.b.left - r.left) ? x : best)).j];
      } else if (!down) to = grid.current.parentNode.querySelector('input');
    } else return;
    e.preventDefault();
    to?.focus();
    to?.scrollIntoView?.({ block: 'nearest' });
  };
  return html`<div class="picker">
    <input class="field" data-autofocus placeholder="Find an emoji" aria-label="Find an emoji" value=${q}
      onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && list[0]) { e.preventDefault(); pick(list[0][0]); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); grid.current.querySelector('button')?.focus(); }
      }} />
    <div class="picker-grid" ref=${grid} onKeyDown=${onGridKey}>
      ${sections.map((s, si) => [
        s.title && html`<div key=${`h${si}`} class="picker-sec" role="presentation">${s.title}</div>`,
        ...s.items.map(([c, names, e]) => (e
          ? html`<button key=${`${si}${c}`} class="picker-custom" aria-label=${`${names} (${S.houses[e.house]?.name || 'custom'})`} data-tip=${`:${names}:`} onClick=${() => pick(c)}><${CustomEmoji} e=${e} /></button>`
          : html`<button key=${`${si}${c}`} aria-label=${names.split(' ')[0]} onClick=${() => pick(c)}>${c}</button>`)),
      ])}
      ${!list.length && html`<div class="picker-none">No emoji called “${q}”</div>`}
    </div>
  </div>`;
}
