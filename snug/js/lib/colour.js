// Colour maths shared by the server and the browser: WCAG contrast, small
// lightness nudges, and the accent ramp. Everything here takes and returns
// "#rrggbb" strings, so what the server checks is exactly what the page paints.
//
// The rules a colour has to pass (docs/direction): a fill (button, switch,
// selected edge) reaches 3:1 against the surface behind it, and text reaches
// 4.5:1 against what it sits on. A colour that would need more than a small
// nudge to get there is refused rather than quietly changed beyond
// recognition.

export const HEX = /^#[0-9a-f]{6}$/i;
export const INK_DARK = '#111211';
export const INK_LIGHT = '#FFFFFF';
// How far (HSL lightness points) a chosen colour may be moved to pass.
export const MAX_NUDGE = 25;

export function parseHex(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const h2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
export const toHex = ([r, g, b]) => `#${h2(r)}${h2(g)}${h2(b)}`.toUpperCase();
export const normHex = (hex) => (parseHex(hex) ? hex.toUpperCase() : null);

// WCAG 2 relative luminance and contrast ratio.
const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(hex) {
  const c = parseHex(hex);
  if (!c) return NaN;
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (Number.isNaN(la) || Number.isNaN(lb)) return NaN;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
// Rounded down to two places, the way the badges show it (never round up past a rule).
export const ratioLabel = (r) => `${(Math.floor(r * 100) / 100).toFixed(2)}:1`;

// HSL, for nudging lightness while keeping the hue the person chose.
export function toHsl(hex) {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
export function fromHsl([h, s, l]) {
  const S = Math.max(0, Math.min(100, s)) / 100, L = Math.max(0, Math.min(100, l)) / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
export function shift(hex, dl) {
  const [h, s, l] = toHsl(hex);
  return fromHsl([h, s, Math.max(0, Math.min(100, l + dl))]);
}
// Mix two colours in sRGB: t = 0 is a, t = 1 is b.
export function mix(a, b, t) {
  const x = parseHex(a), y = parseHex(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

// The smallest lightness move (either way, `prefer` first) that makes ok()
// true, within `max` points; null when there is none.
export function nudge(hex, ok, { prefer = 1, max = MAX_NUDGE } = {}) {
  if (!parseHex(hex)) return null;
  const [h, s, l] = toHsl(hex);
  for (let d = 0; d <= max; d += 1) {
    for (const dir of d ? [prefer, -prefer] : [1]) {
      const nl = l + dir * d;
      if (nl < 0 || nl > 100) continue;
      const c = d ? fromHsl([h, s, nl]) : hex.toUpperCase();
      if (ok(c)) return c;
    }
  }
  return null;
}

// Text on a fill: dark or white, whichever reads better.
export function inkOn(fill) {
  const d = contrastRatio(fill, INK_DARK), w = contrastRatio(fill, INK_LIGHT);
  return d >= w ? { ink: INK_DARK, ratio: d } : { ink: INK_LIGHT, ratio: w };
}

// Is the surface dark? (Light text is the theme's text.)
export const isDark = (bg) => luminance(bg) < 0.18;

// The accent ramp for one surface. Returns the CSS custom properties, or null
// when the colour can't be made to work on that surface with a small nudge.
//   --accent        fills: 3:1 on bg, and its own ink reads 4.5:1 on it
//   --accent-hover  a step away from bg, still passing
//   --accent-press  a step back, still passing
//   --accent-soft   a tint for selected rows and badges, on bg
//   --accent-ink    the accent as text: 4.5:1 on bg and on the soft tint
//   --on-accent     text on an accent fill
export function accentRamp(hex, bg) {
  if (!parseHex(hex) || !parseHex(bg)) return null;
  const away = isDark(bg) ? 1 : -1;
  const fillOk = (c) => contrastRatio(c, bg) >= 3 && inkOn(c).ratio >= 4.5;
  const fill = nudge(hex, fillOk, { prefer: away });
  if (!fill) return null;
  const pick = (d) => { const c = shift(fill, d); return fillOk(c) ? c : fill; };
  const hover = pick(away * 6);
  const press = pick(-away * 5) === fill ? pick(away * 10) : pick(-away * 5);
  const soft = mix(bg, fill, isDark(bg) ? 0.2 : 0.14);
  const ink = nudge(fill, (c) => contrastRatio(c, bg) >= 4.5 && contrastRatio(c, soft) >= 4.5, { prefer: away });
  if (!ink) return null;
  return {
    '--accent': fill,
    '--accent-hover': hover,
    '--accent-press': press,
    '--accent-soft': soft,
    '--accent-ink': ink,
    '--on-accent': inkOn(fill).ink,
  };
}

// Profile colours: a solid fill people's cards are painted with. Whatever the
// viewer's theme, the card's text is dark or light, whichever reads 4.5:1.
export const PROFILE_INK = { dark: '#1A1817', light: '#F4F1ED' };
export function profileInk(hex) {
  if (!parseHex(hex)) return null;
  const d = contrastRatio(hex, PROFILE_INK.dark), l = contrastRatio(hex, PROFILE_INK.light);
  const best = d >= l ? { ink: PROFILE_INK.dark, ratio: d } : { ink: PROFILE_INK.light, ratio: l };
  return best.ratio >= 4.5 ? best : null;
}
