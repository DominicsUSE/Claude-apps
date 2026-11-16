// The Snug identity in code: the Nook (the Huddle mark: an arch with two
// round cut-outs at its foot, two people side by side in one place), the
// wordmark, the lockup and the loading mark. Geometry matches brand/*.svg; see
// docs/brand/BRAND.md. Colours come from tokens: the mark is --brand unless
// mono, the wordmark is currentColor.
import { html } from '../../vendor/preact-htm.js';

// 64 grid. Arch 48 x 54 (r24 top, r4 feet). Two cut-outs at its foot, bottoms
// level 6 units above the ground: r8 centred at 23, r6 at 41, 4 units apart.
// The mark is one shape with holes (fill-rule evenodd), so the ground shows
// through the cut-outs.
const ARCH = 'M8 56V30a24 24 0 0 1 48 0v26a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z';
const EYES = 'M15 46a8 8 0 1 0 16 0a8 8 0 1 0-16 0ZM35 48a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z';
// The same mark redrawn on the 16 grid (brand/favicon.svg) for sizes up to
// 24px, so every edge lands on a pixel: 4px and 3px cut-outs, 1px apart.
const SMALL = 'M2 14V8a6 6 0 0 1 12 0v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1ZM4 11a2 2 0 1 0 4 0a2 2 0 1 0-4 0ZM9 11.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0Z';

// "snug": Inter Bold, tracking -0.03em, outlined (font units, y down, baseline 0).
const SNUG = 'M572 22C865 22 1072 -125 1072 -345C1072 -504 968 -603 752 -647L551 -687C445 -709 407 -748 407 -804C407 -871 483 -917 581 -917C690 -917 753 -863 777 -787L1043 -834C1001 -1016 842 -1132 577 -1132C294 -1132 107 -1000 107 -785C107 -618 213 -512 429 -468L622 -428C720 -408 766 -372 766 -313C766 -246 695 -198 581 -198C458 -198 386 -249 357 -354L78 -306C117 -98 302 22 572 22ZM1513.6 -647C1513.6 -795 1602.6 -881 1730.6 -881C1856.6 -881 1932.6 -798 1932.6 -659V0H2232.6V-711C2232.6 -973 2080.6 -1132 1848.6 -1132C1676.6 -1132 1563.6 -1043 1500.6 -887L1496.6 -1118H1213.6V0H1513.6ZM2812.1 14C2982.1 14 3096.1 -74 3159.1 -232L3163.1 0H3447.1V-1118H3146.1V-471C3146.1 -323 3056.1 -237 2929.1 -237C2803.1 -237 2727.1 -320 2727.1 -459V-1118H2427.1V-407C2427.1 -145 2580.1 14 2812.1 14ZM4137.7 442C4452.7 442 4678.7 294 4678.7 -9V-1118H4383.7V-930H4370.7C4329.7 -1019 4237.7 -1132 4049.7 -1132C3801.7 -1132 3593.7 -939 3593.7 -561C3593.7 -191 3796.7 -16 4048.7 -16C4229.7 -16 4317.7 -108 4358.7 -198H4381.7V8C4381.7 155 4288.7 224 4135.7 224C3989.7 224 3920.7 159 3892.7 96L3634.7 168C3683.7 328 3857.7 442 4137.7 442ZM4142.7 -244C3986.7 -244 3901.7 -368 3901.7 -563C3901.7 -755 3984.7 -892 4142.7 -892C4296.7 -892 4382.7 -761 4382.7 -563C4382.7 -363 4295.7 -244 4142.7 -244Z';
const S = 0.026846;

const label = (title) => (title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': 'true' });

// The symbol. size = px of the square box (the arch is 54/64 of it tall).
// The export keeps its old name so callers do not change.
export function Nook({ size = 20, mono = false, title, class: cls = '' }) {
  const small = size <= 24;
  return html`<svg class=${`nook ${cls}`} width=${size} height=${size} viewBox=${small ? '0 0 16 16' : '0 0 64 64'} ...${label(title)}>
    <path d=${small ? SMALL : ARCH + EYES} fill-rule="evenodd" style=${mono ? 'fill:currentColor' : 'fill:var(--brand)'} />
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
// about a person's width of space between them; the symbol is centred on the x-height.
export function Lockup({ size = 28, title = 'Snug' }) {
  const w = +(size * 192 / 56).toFixed(2);
  return html`<svg class="lockup" width=${w} height=${size} viewBox="0 0 192 56" ...${label(title)}>
    <path d=${ARCH + EYES} fill-rule="evenodd" transform="matrix(1.037037 0 0 1.037037 -8.2963 -6.2222)" style="fill:var(--brand)" />
    <path d=${SNUG} fill="currentColor" transform="matrix(${S} 0 0 ${S} 66.39 43)" />
  </svg>`;
}

// Loading: the two arrive, one after the other. The arch is solid and the
// cut-outs open in it (a mask), the larger first, then the smaller (each grows
// from its foot over 240ms; rest; close; 1.2s cycle). Static and complete
// under reduced motion. role=status so screen readers hear the label once.
let masks = 0;
export function Loading({ label: text = 'Loading', size = 32, quiet = false }) {
  const id = `nook-mask-${++masks}`;
  return html`<div class=${`loading${quiet ? ' quiet' : ''}`} role="status" aria-live="polite">
    <svg class="nook loading-nook" width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
      <mask id=${id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <circle class="loading-dot" cx="23" cy="46" r="8" fill="#000" />
        <circle class="loading-dot two" cx="41" cy="48" r="6" fill="#000" />
      </mask>
      <path d=${ARCH} mask=${`url(#${id})`} style="fill:var(--brand)" />
    </svg>
    <span class="loading-label">${text}</span>
  </div>`;
}
