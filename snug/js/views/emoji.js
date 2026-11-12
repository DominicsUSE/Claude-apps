// A small, searchable emoji set. Enough for reactions and messages without
// shipping a database.
import { html, useState } from '../../vendor/preact-htm.js';
import { S } from '../store.js';

export const QUICK = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

export const EMOJI = `👍 thumbsup yes +1|👎 thumbsdown no|❤️ heart love|😂 joy laugh lol|😊 smile happy|🙂 slight smile|😉 wink|😍 heart eyes love|🤔 thinking hmm|😅 sweat smile phew|😭 sob cry|😢 sad cry|😮 wow surprised|😴 sleep tired|🙃 upside down|😬 grimace awkward|🥳 party celebrate|😎 cool sunglasses|🤝 handshake deal|🙏 pray thanks please|👏 clap applause|🙌 raised hands hooray|💪 muscle strong|👋 wave hello hi|👀 eyes look|🫡 salute yes|🤷 shrug|🎉 tada party celebrate|🔥 fire hot|✨ sparkles|💡 idea bulb|✅ check done yes|❌ cross no|⚠️ warning|❓ question|💯 hundred|⭐ star|🚀 rocket ship launch|🐛 bug|🛠️ tools fix|📌 pin|📝 memo note|📅 calendar date|⏰ alarm clock time|☕ coffee|🍵 tea|🍪 cookie biscuit|🍰 cake|🍕 pizza|🍺 beer|🏺 pot vase amphora|🎨 art palette|🧱 brick clay|🚲 bike bicycle|🚴 cyclist ride|⛰️ mountain climb|🌧️ rain|☀️ sun|❄️ snow cold|🌿 herb plant|🦊 fox|🐢 turtle slow|🎛️ knobs synth|🎧 headphones|🎵 music note|💻 laptop computer|📦 package box|🧵 thread|💤 zzz sleep|🚇 metro train|👌 ok perfect|🤞 fingers crossed luck|😇 angel|🥲 smile tear|😤 huff|🤯 mind blown|😱 scream|🫠 melting|💀 skull dead|🤖 robot`
  .split('|').map((row) => { const i = row.indexOf(' '); return [row.slice(0, i), row.slice(i + 1)]; });

export function EmojiPicker({ onPick }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const recent = (S.prefs.recent || []).map((e) => EMOJI.find(([c]) => c === e)).filter(Boolean);
  const list = term ? EMOJI.filter(([, names]) => names.includes(term))
    : [...recent, ...EMOJI.filter(([c]) => !recent.some(([r]) => r === c))];
  return html`<div class="picker">
    <input class="field" data-autofocus placeholder="Find an emoji" aria-label="Find an emoji" value=${q}
      onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); onPick(list[0][0]); } }} />
    <div class="picker-grid">
      ${list.map(([c, names]) => html`<button key=${c} aria-label=${names.split(' ')[0]} onClick=${() => onPick(c)}>${c}</button>`)}
      ${!list.length && html`<div class="picker-none">No emoji called “${q}”</div>`}
    </div>
  </div>`;
}
