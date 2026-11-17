// Design system guards (DESIGN.md): every custom property the CSS reads is
// defined somewhere, nothing moves for longer than 200ms, text stays at or
// above the 11px floor, and the theme colours keep WCAG AA contrast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir, ext) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
});
const CSS = walk(join(ROOT, 'css'), '.css').map((p) => [p, readFileSync(p, 'utf8')]);
const JS = walk(join(ROOT, 'js'), '.js').map((p) => [p, readFileSync(p, 'utf8')]);
const tokens = readFileSync(join(ROOT, 'css', 'tokens.css'), 'utf8');

test('every var(--x) without a fallback is defined in CSS or set from JS', () => {
  const defined = new Set();
  for (const [, s] of [...CSS, ...JS]) for (const m of s.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  for (const [, s] of JS) for (const m of s.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) defined.add(m[1]);
  const missing = [];
  for (const [p, s] of CSS) {
    for (const m of s.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.push(`${p.slice(ROOT.length + 1)}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('motion tokens stay at or under 200ms and reduced motion zeroes them', () => {
  const line = tokens.match(/--m-fast:[^\n]+/)[0];
  for (const m of line.matchAll(/--m-[\w-]+:\s*(\d+)ms/g)) assert.ok(Number(m[1]) <= 200, line);
  assert.match(tokens, /prefers-reduced-motion: reduce\)[\s\S]*?--m-smooth: 0ms[\s\S]*?--m-slow: 0ms/);
});

test('no text under 11px in the stylesheets', () => {
  const small = [];
  for (const [p, s] of CSS) {
    for (const m of s.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) if (Number(m[1]) > 0 && Number(m[1]) < 11) small.push(`${p.slice(ROOT.length + 1)}: ${m[0]}`);
  }
  assert.deepEqual(small, []);
});

test('the layer scale is used for the global layers', () => {
  for (const name of ['--z-scrim', '--z-pop', '--z-menu', '--z-toast', '--z-tip']) assert.match(tokens, new RegExp(`${name}:\\s*\\d+`));
  const base = readFileSync(join(ROOT, 'css', 'base.css'), 'utf8');
  for (const sel of ['.menu', '.pop', '.scrim', '.toasts', '.tip']) {
    const rule = base.match(new RegExp(`\\n\\${sel} \\{[^}]*\\}`))?.[0] || '';
    assert.match(rule, /z-index: var\(--z-/, `${sel} uses a --z token`);
  }
});

// WCAG relative luminance for #RRGGBB.
const lum = (hex) => {
  const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// The first value given to each name in a block of declarations.
const read = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]));

test('dark and light themes keep AA contrast for text, actions and the tooltip', () => {
  const darkBlock = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('/* ---------- Surface roles'));
  const lightBlock = tokens.slice(tokens.indexOf(':root[data-theme="light"] {'), tokens.indexOf('/* Light surface roles'));
  const dark = read(darkBlock);
  const light = { ...dark, ...read(lightBlock) };
  const checks = (t, name) => {
    const bad = [];
    const need = (fg, bg, min) => { const r = ratio(t[fg], t[bg]); if (r < min) bad.push(`${name}: ${fg} on ${bg} ${r.toFixed(2)} < ${min}`); };
    for (const bg of ['--bg-0', '--bg-1', '--bg-2', '--bg-3']) { need('--text-1', bg, 7); need('--text-2', bg, 4.5); need('--text-3', bg, 4.5); }
    need('--on-brand', '--brand', 4.5);
    need('--brand-ink', '--bg-1', 4.5);
    need('--tip-ink', '--tip-bg', 7);
    need('--tip-muted', '--tip-bg', 4.5);
    return bad;
  };
  assert.deepEqual([...checks(dark, 'dark'), ...checks(light, 'light')], []);
  // Layered greys, never pure black.
  for (const k of ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4']) assert.notEqual(dark[k].toUpperCase(), '#000000');
  assert.ok(lum(dark['--bg-0']) < lum(dark['--bg-1']) && lum(dark['--bg-1']) < lum(dark['--bg-2']) && lum(dark['--bg-2']) < lum(dark['--bg-3']), 'dark surfaces step up');
});
