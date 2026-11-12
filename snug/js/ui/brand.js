// The Snug identity in code: the Nook (a doorway with someone in it), the
// wordmark, the lockup and the loading mark. Geometry matches brand/*.svg; see
// docs/brand/BRAND.md. Colours come from tokens: the arch is --brand unless
// mono, the wordmark is currentColor.
import { html, useRef } from '../../vendor/preact-htm.js';

// 64 grid. Doorway 40 x 56, round top r20, 4-unit foot. Person r9, centred,
// 9 units above the threshold (11 from each side), so it sits rather than floats.
const ARCH = 'M12 56V24a20 20 0 0 1 40 0v32a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4Z';
const DOT = 'M23 42a9 9 0 1 0 18 0a9 9 0 1 0-18 0Z';

// "snug": Inter Bold, tracking -0.03em, outlined (font units, y down, baseline 0).
const SNUG = 'M572 22C865 22 1072 -125 1072 -345C1072 -504 968 -603 752 -647L551 -687C445 -709 407 -748 407 -804C407 -871 483 -917 581 -917C690 -917 753 -863 777 -787L1043 -834C1001 -1016 842 -1132 577 -1132C294 -1132 107 -1000 107 -785C107 -618 213 -512 429 -468L622 -428C720 -408 766 -372 766 -313C766 -246 695 -198 581 -198C458 -198 386 -249 357 -354L78 -306C117 -98 302 22 572 22ZM1513.6 -647C1513.6 -795 1602.6 -881 1730.6 -881C1856.6 -881 1932.6 -798 1932.6 -659V0H2232.6V-711C2232.6 -973 2080.6 -1132 1848.6 -1132C1676.6 -1132 1563.6 -1043 1500.6 -887L1496.6 -1118H1213.6V0H1513.6ZM2812.1 14C2982.1 14 3096.1 -74 3159.1 -232L3163.1 0H3447.1V-1118H3146.1V-471C3146.1 -323 3056.1 -237 2929.1 -237C2803.1 -237 2727.1 -320 2727.1 -459V-1118H2427.1V-407C2427.1 -145 2580.1 14 2812.1 14ZM4137.7 442C4452.7 442 4678.7 294 4678.7 -9V-1118H4383.7V-930H4370.7C4329.7 -1019 4237.7 -1132 4049.7 -1132C3801.7 -1132 3593.7 -939 3593.7 -561C3593.7 -191 3796.7 -16 4048.7 -16C4229.7 -16 4317.7 -108 4358.7 -198H4381.7V8C4381.7 155 4288.7 224 4135.7 224C3989.7 224 3920.7 159 3892.7 96L3634.7 168C3683.7 328 3857.7 442 4137.7 442ZM4142.7 -244C3986.7 -244 3901.7 -368 3901.7 -563C3901.7 -755 3984.7 -892 4142.7 -892C4296.7 -892 4382.7 -761 4382.7 -563C4382.7 -363 4295.7 -244 4142.7 -244Z';
const S = 0.026846;

const label = (title) => (title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': 'true' });

// The symbol. size = px of the 64 box (the arch is 7/8 of it tall).
export function Nook({ size = 20, mono = false, title, class: cls = '' }) {
  return html`<svg class=${`nook ${cls}`} width=${size} height=${size} viewBox="0 0 64 64" ...${label(title)}>
    <path d=${ARCH + DOT} fill-rule="evenodd" style=${mono ? 'fill:currentColor' : 'fill:var(--brand)'} />
  </svg>`;
}

// The wordmark alone. size = px height of "snug" from x-height to the g's tail.
export function Wordmark({ size = 20, title = 'Snug' }) {
  const w = +(size * 123.51 / 42.26).toFixed(2);
  return html`<svg class="wordmark" width=${w} height=${size} viewBox="0 0 123.51 42.26" ...${label(title)}>
    <path d=${SNUG} fill="currentColor" transform="matrix(${S} 0 0 ${S} -2.09 30.39)" />
  </svg>`;
}

// Symbol left, wordmark right. size = px height of the symbol (cap height x 1.4);
// one dot of space between them; the symbol is centred on the x-height.
export function Lockup({ size = 28, title = 'Snug' }) {
  const w = +(size * 180 / 56).toFixed(2);
  return html`<svg class="lockup" width=${w} height=${size} viewBox="0 0 180 56" ...${label(title)}>
    <path d=${ARCH + DOT} transform="translate(-12 -4)" fill-rule="evenodd" style="fill:var(--brand)" />
    <path d=${SNUG} fill="currentColor" transform="matrix(${S} 0 0 ${S} 53.91 43)" />
  </svg>`;
}

// Loading: the person settles into the doorway (drop + fade in over 240ms,
// rest, fade out; 1.2s cycle). Static and complete under reduced motion.
// role=status so screen readers hear the label once.
let masks = 0;
export function Loading({ label: text = 'Loading', size = 32, quiet = false }) {
  const id = useRef(null);
  if (!id.current) id.current = `nook-load-${++masks}`;
  return html`<div class=${`loading${quiet ? ' quiet' : ''}`} role="status" aria-live="polite">
    <svg class="nook loading-nook" width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
      <mask id=${id.current} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <circle class="loading-dot" cx="32" cy="42" r="9" fill="#000" />
      </mask>
      <path d=${ARCH} style="fill:var(--brand)" mask=${`url(#${id.current})`} />
    </svg>
    <span class="loading-label">${text}</span>
  </div>`;
}
