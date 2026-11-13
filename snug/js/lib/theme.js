// Themes, accents and profile styling shared by the server and the browser.
//
// - The built-in themes: their names, light or dark base, and the few values
//   the checks need (the full token blocks live in css/account.css and
//   css/appearance.css; tests/logic-custom.test.js checks the two agree and
//   that every block's text reaches 4.5:1).
// - Accent presets: one colour per base, run through accentRamp
//   (js/lib/colour.js) for the theme in use.
// - Custom themes: four colours and a base. deriveTheme builds every surface,
//   text and line token from them and checks the contrast rules; the server
//   runs the same function before it keeps one, so a modified client can't
//   store an unreadable theme. Themes travel as "snug-theme:1:<base64url JSON>".
// - Profile styling: avatar decorations and name styles, from fixed lists.
import { HEX, parseHex, normHex, contrastRatio, mix, nudge, accentRamp, isDark, profileInk } from './colour.js';
import { HUES, RETIRED_HUES } from './util.js';

// ---------- Built-in themes ----------
// bg1 is the conversation surface; semantic colours come from the base.
export const THEME_PRESETS = {
  dark: { label: 'Dark', base: 'dark', bg0: '#0E0F10', bg1: '#141516', bg2: '#1A1C1D', text1: '#F4F1ED' },
  light: { label: 'Light', base: 'light', bg0: '#E9E6E1', bg1: '#FBFAF8', bg2: '#F3F1ED', text1: '#1A1817' },
  midnight: { label: 'Midnight', base: 'dark', bg0: '#000000', bg1: '#000000', bg2: '#0B0B0C', text1: '#F4F1ED' },
  ash: { label: 'Ash', base: 'dark', bg0: '#1B1B1C', bg1: '#222223', bg2: '#29292A', text1: '#F2F0EC' },
  slate: { label: 'Slate', base: 'dark', bg0: '#0F1217', bg1: '#151A21', bg2: '#1B2129', text1: '#EEF2F6' },
  moss: { label: 'Moss', base: 'dark', bg0: '#0E120F', bg1: '#141915', bg2: '#1A201B', text1: '#F0F3EE' },
  paper: { label: 'Paper', base: 'light', bg0: '#E6E8EA', bg1: '#FFFFFF', bg2: '#F5F6F7', text1: '#16181A' },
  sepia: { label: 'Sepia', base: 'light', bg0: '#E4D9C6', bg1: '#F6EEDF', bg2: '#EFE5D3', text1: '#2B2118' },
  contrast: { label: 'Contrast dark', base: 'dark', bg0: '#000000', bg1: '#000000', bg2: '#0A0A0A', text1: '#FFFFFF' },
};
export const THEMES = ['system', ...Object.keys(THEME_PRESETS)];
export const THEME_NOTES = {
  system: 'Dark or Light, following your device.',
  midnight: 'True black, for OLED screens.',
  contrast: 'Black with white text and firm lines.',
};

// Semantic colours each base keeps whatever the theme (violet brand, mint
// live, amber idle, cyan info, rose reactions, red errors). A custom theme
// must keep them readable: 3:1 on its surfaces.
export const BASE_SEMANTIC = {
  dark: { brand: '#996FF7', mint: '#58C7A5', amber: '#E8B65A', cyan: '#62B8D8', rose: '#D98598', error: '#E05A5A' },
  light: { brand: '#763FF4', mint: '#1F8F6E', amber: '#A86F0D', cyan: '#1F7EA3', rose: '#B24E66', error: '#C93838' },
};

// ---------- Accents ----------
// Violet is Snug's own colour and the default (the brand tokens: #8B5CF6, the
// mark's colour, lifted for dark themes and deepened for light ones so button
// text passes). Each preset has a value for dark and one for light themes; a
// custom hex is nudged per theme. There is no coral preset any more: it sat
// next to error red, and a stored 'coral' reads as violet (upgradePrefs).
export const ACCENT_PRESETS = {
  violet: { label: 'Violet', dark: '#996FF7', light: '#763FF4' },
  cyan: { label: 'Cyan', dark: '#62B8D8', light: '#1F7EA3' },
  mint: { label: 'Mint', dark: '#58C7A5', light: '#1F8F6E' },
  amber: { label: 'Amber', dark: '#E8B65A', light: '#A86F0D' },
  rose: { label: 'Rose', dark: '#D98598', light: '#B24E66' },
  neutral: { label: 'Neutral', dark: '#B8B4AE', light: '#57534E' },
};
// The colour an accent setting stands for on a theme of this base.
export function accentHex(accent, base = 'dark') {
  const p = ACCENT_PRESETS[accent];
  if (p) return p[base === 'light' ? 'light' : 'dark'];
  return normHex(accent);
}
// Every built-in theme's surface: a custom accent has to work on all of them,
// because the setting follows the person to every device and theme.
export function accentProblem(accent) {
  if (ACCENT_PRESETS[accent]) return null;
  if (typeof accent !== 'string' || !HEX.test(accent)) return 'An accent is one of the colours, or a hex colour like #3A7BD5.';
  for (const t of Object.values(THEME_PRESETS)) {
    if (!accentRamp(accent, t.bg1)) return `That colour can’t be made readable on the ${t.label} theme. Try a ${t.base === 'dark' ? 'lighter' : 'darker'} one.`;
  }
  return null;
}
// The tokens an accent paints with on a surface (null: use the CSS default).
export function accentTokens(accent, bg, base) {
  if (accent === 'violet' || accent === 'coral' || !accent) return null;
  return accentRamp(accentHex(accent, base), bg);
}

// ---------- Custom themes ----------
export const MAX_THEMES = 5;
export const THEME_KEYS = ['name', 'base', 'bg', 'surface', 'text', 'accent'];
const THEME_ID = /^[a-z0-9]{4,12}$/;
const rgbA = (hex, a) => { const [r, g, b] = parseHex(hex); return `rgb(${r} ${g} ${b} / ${a})`; };

// Every token a custom theme sets, and the checks it has to pass.
export function deriveTheme({ base, bg, surface, text, accent }) {
  const problems = [];
  const checks = [];
  if (base !== 'dark' && base !== 'light') return { ok: false, problems: ['A theme is dark or light.'], checks, tokens: {} };
  for (const [k, v] of Object.entries({ bg, surface, text, accent })) {
    if (!parseHex(v)) return { ok: false, problems: [`The ${k} colour needs to be a hex colour like #1E2228.`], checks, tokens: {} };
  }
  [bg, surface, text, accent] = [bg, surface, text, accent].map((c) => c.toUpperCase());
  const dark = base === 'dark';
  if (isDark(bg) !== dark || isDark(surface) !== dark) problems.push(dark ? 'A dark theme needs dark background colours.' : 'A light theme needs light background colours.');
  const toward = isDark(bg) ? 1 : -1;
  const bg3 = mix(surface, text, 0.05), bg4 = mix(surface, text, 0.1);
  const readsOn = (c) => contrastRatio(c, surface) >= 4.5 && contrastRatio(c, bg3) >= 4.5;
  const text2 = nudge(mix(text, surface, 0.28), readsOn, { prefer: toward }) || mix(text, surface, 0.28);
  const text3 = nudge(mix(text, surface, 0.45), readsOn, { prefer: toward }) || mix(text, surface, 0.45);
  const ramp = accentRamp(accent, bg);
  const check = (id, label, a, b, need) => { const ratio = contrastRatio(a, b); checks.push({ id, label, ratio, need, pass: ratio >= need }); return ratio >= need; };
  if (!check('text-bg', 'Text on the background', text, bg, 4.5)) problems.push('Text needs 4.5:1 on the background.');
  if (!check('text-surface', 'Text on panels', text, surface, 4.5)) problems.push('Text needs 4.5:1 on panels.');
  const t2a = check('text2', 'Secondary text on panels', text2, surface, 4.5);
  const t2b = check('text2-hover', 'Secondary text on hover', text2, bg3, 4.5);
  const t3a = check('text3', 'Faint text on panels', text3, surface, 4.5);
  const t3b = check('text3-hover', 'Faint text on hover', text3, bg3, 4.5);
  const t2 = t2a && t2b, t3 = t3a && t3b;
  if (!t2 || !t3) problems.push('Secondary text can’t reach 4.5:1 here. Move the text and panel colours further apart.');
  if (ramp) check('accent', 'Accent on the background', ramp['--accent'], bg, 3);
  else { checks.push({ id: 'accent', label: 'Accent on the background', ratio: contrastRatio(accent, bg), need: 3, pass: false }); problems.push('The accent can’t reach 3:1 on the background.'); }
  const sem = BASE_SEMANTIC[base];
  const weak = Object.entries(sem).filter(([, c]) => contrastRatio(c, bg) < 3 || contrastRatio(c, surface) < 3).map(([k]) => k);
  checks.push({ id: 'status', label: 'Status colours (online, idle, mentions)', ratio: Math.min(...Object.values(sem).flatMap((c) => [contrastRatio(c, bg), contrastRatio(c, surface)])), need: 3, pass: !weak.length });
  if (weak.length) problems.push('Snug’s status colours (online, idle, mentions) wouldn’t show on these backgrounds.');
  const tokens = {
    '--bg-0': mix(bg, '#000000', dark ? 0.3 : 0.07),
    '--bg-1': bg, '--bg-2': surface, '--bg-3': bg3, '--bg-4': bg4,
    '--text-1': text, '--text-2': text2, '--text-3': text3,
    '--text-disabled': mix(text, surface, 0.62), '--text-inverse': bg,
    '--line': mix(surface, text, 0.1), '--line-strong': mix(surface, text, 0.2), '--line-subtle': mix(bg, text, 0.06),
    '--btn2': bg4, '--btn2-hover': mix(surface, text, 0.16), '--btn2-press': mix(surface, text, 0.21),
    '--hover': rgbA(text, 0.05), '--press': rgbA(text, 0.09),
    '--selection': rgbA(ramp?.['--accent'] || accent, 0.32),
    ...(ramp || {}),
  };
  return { ok: !problems.length, problems, checks, tokens };
}

const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/g;
// A theme as stored: exactly these fields, hex colours, a short name.
export function cleanTheme(t, { needId = true } = {}) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('That theme isn’t valid.');
  const allowed = needId ? ['id', ...THEME_KEYS] : THEME_KEYS;
  const extra = Object.keys(t).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error('That theme has things in it Snug doesn’t know.');
  if (needId && (typeof t.id !== 'string' || !THEME_ID.test(t.id))) throw new Error('That theme isn’t valid.');
  if (typeof t.name !== 'string') throw new Error('A theme needs a name.');
  const name = t.name.replace(CTRL, '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A theme needs a name.');
  if ([...name].length > 32) throw new Error('Keep a theme’s name to 32 characters.');
  if (t.base !== 'dark' && t.base !== 'light') throw new Error('A theme is dark or light.');
  for (const k of ['bg', 'surface', 'text', 'accent']) if (typeof t[k] !== 'string' || !HEX.test(t[k])) throw new Error('A theme’s colours are hex colours like #1E2228.');
  const out = { ...(needId ? { id: t.id } : {}), name, base: t.base, bg: t.bg.toUpperCase(), surface: t.surface.toUpperCase(), text: t.text.toUpperCase(), accent: t.accent.toUpperCase() };
  const d = deriveTheme(out);
  if (!d.ok) throw new Error(`“${name}” isn’t readable: ${d.problems[0]}`);
  return out;
}

// ---------- Theme codes ----------
export const CODE_PREFIX = 'snug-theme:1:';
const MAX_CODE = 900;
function b64urlEncode(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
export function encodeTheme(t) {
  const clean = cleanTheme(t, { needId: false });
  return CODE_PREFIX + b64urlEncode(JSON.stringify(Object.fromEntries(THEME_KEYS.map((k) => [k, clean[k]]))));
}
export function themeForCode(t) { const { id, ...rest } = t; void id; return encodeTheme(rest); }
// A pasted code back to a theme (no id yet), with a sentence when it's wrong.
export function decodeTheme(code) {
  const s = typeof code === 'string' ? code.trim() : '';
  if (!s.startsWith(CODE_PREFIX)) throw new Error('That isn’t a Snug theme code. They start with “snug-theme:1:”.');
  const body = s.slice(CODE_PREFIX.length);
  if (!body || body.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('That theme code is damaged. Copy it again.');
  let obj;
  try { obj = JSON.parse(b64urlDecode(body)); } catch { throw new Error('That theme code is damaged. Copy it again.'); }
  return cleanTheme(obj, { needId: false });
}
export const newThemeId = () => Math.random().toString(36).slice(2, 10).padEnd(6, '0');

// The theme setting: a built-in name, or "custom:<id>" of a saved theme.
export const customId = (theme) => (typeof theme === 'string' && theme.startsWith('custom:') ? theme.slice(7) : null);
export const validThemeName = (v) => THEMES.includes(v) || (typeof v === 'string' && /^custom:[a-z0-9]{4,12}$/.test(v));

// ---------- Profile styling ----------
export const DECORATIONS = [
  ['ring', 'Ring'], ['double', 'Double ring'], ['dotted', 'Dotted ring'], ['halo', 'Arch halo'], ['leaves', 'Leaves'], ['stars', 'Stars'],
];
export const DECORATION_IDS = DECORATIONS.map(([id]) => id);
export const HUE_IDS = [...HUES.map(([v]) => v), ...RETIRED_HUES]; // retired ones show as the nearest (hueOf)
export const NAME_FONTS = [['inter', 'Inter'], ['hyperlegible', 'Hyperlegible'], ['mono', 'Mono'], ['serif', 'Serif']];
export const NAME_WEIGHTS = [['semibold', 'Semibold'], ['bold', 'Bold']];
// A name style, or null for the plain one. Throws a readable sentence.
export function cleanNameStyle(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('That name style isn’t valid.');
  if (Object.keys(v).some((k) => !['font', 'weight', 'hue'].includes(k))) throw new Error('That name style isn’t valid.');
  const font = v.font ?? 'inter', weight = v.weight ?? 'semibold', hue = v.hue ?? null;
  if (!NAME_FONTS.some(([id]) => id === font)) throw new Error('Pick one of the name fonts.');
  if (!NAME_WEIGHTS.some(([id]) => id === weight)) throw new Error('Pick one of the name weights.');
  if (hue !== null && !HUE_IDS.includes(hue)) throw new Error('Pick one of the name colours.');
  if (font === 'inter' && weight === 'semibold' && hue === null) return null;
  return { font, weight, hue };
}
// Two profile colours (card header, card body), each readable with dark or light text.
export function cleanProfileColors(v) {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length !== 2 || v.some((c) => typeof c !== 'string' || !HEX.test(c))) throw new Error('Profile colours are two hex colours.');
  if (v.some((c) => !profileInk(c))) throw new Error('Text wouldn’t be readable on that colour. Pick a lighter or darker one.');
  return v.map((c) => c.toUpperCase());
}
