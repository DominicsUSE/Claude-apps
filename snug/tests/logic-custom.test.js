// Customisation rules shared by the server and the browser: contrast maths,
// accent ramps, theme presets (checked against the CSS itself), the custom
// theme builder and its share codes, keyboard shortcut grammar and conflicts,
// the settings rules, and which sound each kind of notification plays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contrastRatio, luminance, nudge, accentRamp, inkOn, profileInk, ratioLabel, mix, toHsl } from '../js/lib/colour.js';
import {
  THEME_PRESETS, THEMES, ACCENT_PRESETS, accentTokens, accentProblem, deriveTheme, cleanTheme, encodeTheme, decodeTheme, CODE_PREFIX,
  cleanNameStyle, cleanProfileColors, validThemeName,
} from '../js/lib/theme.js';
import { parseCombo, normCombo, matches, eventCombo, conflictOf, cleanKeys, bindings, actionFor, ACTIONS } from '../js/lib/keys.js';
import { cleanPrefs, upgradePrefs, PREF_DEFAULTS, soundKind, soundFor, SOUND_PACKS, packOf } from '../js/lib/account.js';

const css = (f) => readFileSync(fileURLToPath(new URL(`../css/${f}`, import.meta.url)), 'utf8');
const near = (a, b, d = 0.01) => assert.ok(Math.abs(a - b) <= d, `${a} ≈ ${b}`);

test('contrast: WCAG ratios match known pairs', () => {
  near(contrastRatio('#000000', '#FFFFFF'), 21);
  near(contrastRatio('#FFFFFF', '#FFFFFF'), 1);
  near(contrastRatio('#777777', '#FFFFFF'), 4.48);   // the classic "almost AA" grey
  near(contrastRatio('#767676', '#FFFFFF'), 4.54);
  near(contrastRatio('#0000FF', '#FFFFFF'), 8.59);
  near(luminance('#FFFFFF'), 1);
  near(luminance('#808080'), 0.2159);
  assert.equal(contrastRatio('#ffffff', '#000000'), contrastRatio('#000000', '#ffffff'), 'order does not matter');
  assert.ok(Number.isNaN(contrastRatio('red', '#000000')));
  assert.equal(ratioLabel(4.499), '4.49:1', 'never rounds up past a rule');
  assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
});

test('contrast: nudging moves lightness the least it can, and refuses past the limit', () => {
  const bg = '#141516';
  const ok = (c) => contrastRatio(c, bg) >= 3;
  assert.equal(nudge('#996FF7', ok), '#996FF7', 'already fine: unchanged');
  const dark = nudge('#3A2A60', ok, { prefer: 1 });
  assert.ok(dark && contrastRatio(dark, bg) >= 3, 'a dark purple is lightened until it passes');
  assert.equal(nudge('#151617', ok, { prefer: 1 }), null, 'near-black would need more than a small nudge');
  assert.equal(nudge('#151617', ok, { prefer: 1, max: 60 }) !== null, true, 'with a bigger allowance it could');
  assert.equal(inkOn('#996FF7').ink, '#111211', 'dark-theme violet takes near-black text');
  assert.equal(inkOn('#763FF4').ink, '#FFFFFF', 'light-theme violet takes white text');
  assert.equal(inkOn('#1F3A6B').ink, '#FFFFFF');
});

test('accents: every preset works on every built-in theme; ramps pass the rules; unreadable hexes are refused', () => {
  for (const [a] of Object.entries(ACCENT_PRESETS)) {
    for (const [id, t] of Object.entries(THEME_PRESETS)) {
      const r = accentTokens(a, t.bg1, t.base) || accentRamp(ACCENT_PRESETS.violet[t.base], t.bg1);
      assert.ok(r, `${a} on ${id}`);
      assert.ok(contrastRatio(r['--accent'], t.bg1) >= 3, `${a} fill on ${id}`);
      assert.ok(contrastRatio(r['--accent-hover'], t.bg1) >= 3, `${a} hover on ${id}`);
      assert.ok(contrastRatio(r['--accent-press'], t.bg1) >= 3, `${a} press on ${id}`);
      assert.ok(contrastRatio(r['--accent-ink'], t.bg1) >= 4.5, `${a} as text on ${id}`);
      assert.ok(contrastRatio(r['--accent-ink'], r['--accent-soft']) >= 4.5, `${a} text on its tint on ${id}`);
      assert.ok(contrastRatio(r['--on-accent'], r['--accent']) >= 4.5, `text on ${a} on ${id}`);
    }
  }
  assert.equal(accentTokens('violet', '#141516', 'dark'), null, 'violet is the CSS default (the brand tokens)');
  assert.equal(accentTokens('coral', '#141516', 'dark'), null, 'a stale coral (the old default) also paints with the brand tokens');
  assert.ok(!ACCENT_PRESETS.coral, 'no coral preset: it sat next to error red');
  assert.equal(accentProblem('#3A7BD5'), null);
  assert.match(accentProblem('#151617'), /Dark theme/);
  assert.match(accentProblem('#FFFFFF'), /Light theme/);
  assert.match(accentProblem('#FFF'), /hex colour/);
  assert.match(accentProblem('#12345g'), /hex colour/);
  // The server's rule is the same function.
  assert.throws(() => cleanPrefs({ accent: '#151617' }), /can’t be made readable/);
  assert.throws(() => cleanPrefs({ accent: 'red; background:url(x)' }), /hex colour/);
  assert.deepEqual(cleanPrefs({ accent: '#3a7bd5' }), { accent: '#3A7BD5' });
  assert.deepEqual(cleanPrefs({ accent: 'mint' }), { accent: 'mint' });
});

// Every :root[data-theme="…"] block in the CSS: its text reaches 4.5:1 on its surfaces.
function themeBlocks() {
  const out = {};
  const src = css('tokens.css') + css('account.css') + css('appearance.css');
  const re = /:root\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g;
  for (let m; (m = re.exec(src));) {
    const vars = Object.fromEntries([...m[2].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((x) => [x[1], x[2]]));
    if (vars['bg-1']) out[m[1]] = vars;
  }
  // Dark is the bare :root.
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css('tokens.css'))[1];
  out.dark = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((x) => [x[1], x[2]]));
  return out;
}
test('theme presets: each CSS block is complete and readable, and matches the table the server checks', () => {
  const blocks = themeBlocks();
  for (const id of Object.keys(THEME_PRESETS)) {
    const b = blocks[id];
    assert.ok(b, `a CSS block for ${id}`);
    for (const t of ['text-1', 'text-2', 'text-3']) {
      for (const s of ['bg-1', 'bg-2', 'bg-3']) {
        assert.ok(contrastRatio(b[t], b[s]) >= 4.5, `${id}: ${t} ${b[t]} on ${s} ${b[s]} is ${contrastRatio(b[t], b[s]).toFixed(2)}`);
      }
    }
    assert.equal(b['bg-1'].toUpperCase(), THEME_PRESETS[id].bg1, `${id}: bg-1 matches js/lib/theme.js`);
    assert.equal(b['bg-0'].toUpperCase(), THEME_PRESETS[id].bg0, `${id}: bg-0 matches`);
    assert.equal(b['text-1'].toUpperCase(), THEME_PRESETS[id].text1, `${id}: text-1 matches`);
    if (id !== 'dark') {
      // Violet stays the brand and the semantic colours stay legible as fills.
      for (const k of ['brand', 'mint', 'amber', 'cyan', 'rose']) assert.ok(b[k] && contrastRatio(b[k], b['bg-1']) >= 3, `${id}: ${k} as a fill`);
    }
    // The brand ramp: text on every fill state 4.5:1, fills 3:1 on every
    // surface, violet as text 4.5:1 on the surfaces and on its own tint.
    const r = (a, c) => contrastRatio(b[a], b[c]);
    for (const f of ['brand', 'brand-hover', 'brand-press']) assert.ok(r('on-brand', f) >= 4.5, `${id}: on-brand on ${f} is ${r('on-brand', f).toFixed(2)}`);
    for (const s of ['bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-4']) assert.ok(r('brand', s) >= 3, `${id}: brand on ${s} is ${r('brand', s).toFixed(2)}`);
    for (const s of ['bg-1', 'bg-2', 'bg-3', 'brand-soft']) assert.ok(r('brand-ink', s) >= 4.5, `${id}: brand-ink on ${s} is ${r('brand-ink', s).toFixed(2)}`);
    // Your @mention chip (css/stream.css): violet into bg-1, 20% on hover and
    // 22% inside a message that mentions you; its violet text still 4.5:1.
    for (const p of [0.20, 0.22]) {
      const chip = mix(b['bg-1'], b.brand, p);
      assert.ok(contrastRatio(b['brand-ink'], chip) >= 4.5, `${id}: brand-ink on the ${p * 100}% mention chip is ${contrastRatio(b['brand-ink'], chip).toFixed(2)}`);
    }
    // Violet never passes for a link, a reaction or an error: a clear hue step
    // (HSL) from cyan, the link colour, rose and red in every theme.
    const hue = (c) => toHsl(c)[0], gap = (x, y) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
    for (const k of ['cyan', 'link', 'rose', 'error', 'mint', 'amber']) {
      if (b[k]) assert.ok(gap(hue(b.brand), hue(b[k])) >= 45, `${id}: brand ${b.brand} is too near ${k} ${b[k]}`);
    }
  }
  for (const t of ['ash', 'slate', 'moss', 'paper', 'sepia', 'contrast']) assert.ok(THEMES.includes(t));
  assert.ok(!/gradient\(/.test(css('appearance.css')), 'no gradients');
});

const GOOD = { name: 'Night', base: 'dark', bg: '#1E2228', surface: '#252A31', text: '#E8ECF1', accent: '#7AA2F7' };
test('theme builder: derives every token and checks contrast', () => {
  const d = deriveTheme(GOOD);
  assert.equal(d.ok, true, d.problems.join(' '));
  for (const k of ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4', '--text-1', '--text-2', '--text-3', '--text-disabled', '--line', '--line-strong', '--hover', '--press', '--accent', '--accent-hover', '--on-accent']) assert.ok(d.tokens[k], k);
  for (const t of ['--text-2', '--text-3']) {
    for (const s of ['--bg-2', '--bg-3']) assert.ok(contrastRatio(d.tokens[t], d.tokens[s]) >= 4.5, `${t} on ${s}`);
  }
  assert.ok(contrastRatio(d.tokens['--accent'], d.tokens['--bg-1']) >= 3);
  assert.ok(Object.values(d.tokens).every((v) => /^(#[0-9A-F]{6}|rgb\(\d+ \d+ \d+ \/ 0\.\d+\))$/.test(v)), 'only hex and rgb() values, never CSS text');
  // Unreadable: grey text on grey.
  const bad = deriveTheme({ ...GOOD, text: '#3A3F46' });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /4\.5:1/);
  // A light base needs light backgrounds.
  assert.equal(deriveTheme({ ...GOOD, base: 'light' }).ok, false);
  // A light theme that works.
  assert.equal(deriveTheme({ name: 'Day', base: 'light', bg: '#FCFBF7', surface: '#F2F0EA', text: '#1C1B19', accent: '#2F6FD0' }).ok, true);
  // Status colours must stay visible: a mid-grey background hides them.
  assert.equal(deriveTheme({ ...GOOD, bg: '#5A5A5A', surface: '#5A5A5A', text: '#FFFFFF' }).ok, false);
});

test('theme codes: round trip, and malformed or hostile codes are refused with a clear sentence', () => {
  const code = encodeTheme({ ...GOOD, name: 'Night ✨' });
  assert.ok(code.startsWith(CODE_PREFIX));
  assert.deepEqual(decodeTheme(code), { ...GOOD, name: 'Night ✨' });
  assert.deepEqual(decodeTheme(`  ${code}\n`), { ...GOOD, name: 'Night ✨' }, 'surrounding space is fine');
  const enc = (o) => CODE_PREFIX + Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.throws(() => decodeTheme('hello'), /start with “snug-theme:1:”/);
  assert.throws(() => decodeTheme(`${CODE_PREFIX}`), /damaged/);
  assert.throws(() => decodeTheme(`${CODE_PREFIX}!!!`), /damaged/);
  assert.throws(() => decodeTheme(`${CODE_PREFIX}${'A'.repeat(1000)}`), /damaged/);
  assert.throws(() => decodeTheme(CODE_PREFIX + Buffer.from('not json').toString('base64url')), /damaged/);
  assert.throws(() => decodeTheme(enc([1, 2])), /isn’t valid/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, bg: '#1E2228;}body{display:none}' })), /hex colours/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, bg: 'url(javascript:alert(1))' })), /hex colours/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, css: ':root{}' })), /doesn’t know/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, __proto__x: 1 })), /doesn’t know/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, id: 'abcd' })), /doesn’t know/, 'an id comes from the importer, not the code');
  assert.throws(() => decodeTheme(enc({ ...GOOD, name: 'x'.repeat(33) })), /32 characters/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, name: '  ' })), /needs a name/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, base: 'neon' })), /dark or light/);
  assert.throws(() => decodeTheme(enc({ ...GOOD, text: '#3A3F46' })), /isn’t readable/);
  assert.equal(decodeTheme(enc({ ...GOOD, name: 'a\u0000b‮c' })).name, 'ab‮c'.replace('‮', '‮'), 'control characters are dropped');
  assert.deepEqual(cleanTheme({ ...GOOD, id: 'abcd', bg: '#1e2228' }).bg, '#1E2228');
});

test('settings rules: themes, custom themes, fonts, chat display, sounds and keys', () => {
  assert.equal(PREF_DEFAULTS.accent, 'violet');
  // Coral was Snug's colour before violet: stored or sent, it means violet.
  assert.deepEqual(cleanPrefs({ accent: 'coral' }), { accent: 'violet' });
  assert.deepEqual(cleanPrefs({ tone: 'coral' }), { tone: 'violet' });
  assert.deepEqual(upgradePrefs({ accent: 'coral', tone: 'coral', theme: 'dark' }), { accent: 'violet', tone: 'violet', theme: 'dark' });
  const kept = { accent: 'mint', tone: 'cyan' };
  assert.equal(upgradePrefs(kept), kept, 'nothing to upgrade: the same object');
  assert.equal(upgradePrefs(null), null);
  assert.equal(PREF_DEFAULTS.gifAutoplay, 'auto');
  assert.equal(PREF_DEFAULTS.sounds, null, 'the older single sound applies until one is picked');
  assert.equal(validThemeName('custom:abcd12'), true);
  assert.equal(validThemeName('custom:../x'), false);
  assert.throws(() => cleanPrefs({ theme: 'neon' }), /choices/);
  assert.deepEqual(cleanPrefs({ theme: 'sepia' }), { theme: 'sepia' });
  const six = Array.from({ length: 6 }, (_, i) => ({ ...GOOD, id: `t${i}abc` }));
  assert.throws(() => cleanPrefs({ customThemes: six }), /up to 5/);
  assert.throws(() => cleanPrefs({ customThemes: [{ ...GOOD }] }), /isn’t valid/, 'a saved theme needs an id');
  assert.throws(() => cleanPrefs({ customThemes: [{ ...GOOD, id: 'abcd', text: '#3A3F46' }] }), /isn’t readable/);
  assert.deepEqual(cleanPrefs({ customThemes: [{ ...GOOD, id: 'abcd' }] }).customThemes, [{ ...GOOD, id: 'abcd' }]);
  for (const [k, bad] of [['font', 'comic'], ['codeFont', 'x'], ['showTimes', 'never'], ['emojiSize', 'xl'], ['gifAutoplay', 'sometimes'], ['animatedEmoji', 1], ['spoilers', 'never'], ['chatBg', 'url(x)']]) {
    assert.throws(() => cleanPrefs({ [k]: bad }), /choices/, k);
  }
  for (const k of ['jumboEmoji', 'showReactions', 'showNameStyles']) assert.throws(() => cleanPrefs({ [k]: 'yes' }), /on or off/, k);
  assert.deepEqual(cleanPrefs({ font: 'serif', codeFont: 'system-mono', showTimes: 'hover', emojiSize: 'l', gifAutoplay: 'never', animatedEmoji: 'hover', spoilers: 'always', chatBg: 'arches' }),
    { font: 'serif', codeFont: 'system-mono', showTimes: 'hover', emojiSize: 'l', gifAutoplay: 'never', animatedEmoji: 'hover', spoilers: 'always', chatBg: 'arches' });
  assert.throws(() => cleanPrefs({ sounds: { mention: 'airhorn' } }), /Snug’s sounds/);
  assert.throws(() => cleanPrefs({ sounds: { call: 'bell' } }), /aren’t valid/);
  assert.throws(() => cleanPrefs({ soundVolume: -1 }), /0 to 100/);
  assert.deepEqual(cleanPrefs({ sounds: { mention: 'bell' } }).sounds, { message: 'soft', mention: 'bell', dm: 'soft' });
  // Name styles and profile colours.
  assert.equal(cleanNameStyle({ font: 'inter', weight: 'semibold', hue: null }), null, 'the plain style is no style');
  assert.deepEqual(cleanNameStyle({ font: 'mono', hue: 200 }), { font: 'mono', weight: 'semibold', hue: 200 });
  assert.throws(() => cleanNameStyle({ font: 'mono', hue: 201 }), /name colours/);
  assert.throws(() => cleanNameStyle({ font: 'mono', color: 'red' }), /isn’t valid/);
  assert.throws(() => cleanProfileColors(['#777777', '#000000']), /readable/);
  assert.deepEqual(cleanProfileColors(['#2b4c7e', '#f3e9d2']), ['#2B4C7E', '#F3E9D2']);
  assert.equal(profileInk('#777777'), null);
  assert.equal(profileInk('#2B4C7E').ink, '#F4F1ED');
});

test('keys: combo grammar, matching, recording, reserved keys and conflicts', () => {
  assert.deepEqual(parseCombo('ctrl+shift+k'), { mods: ['Ctrl', 'Shift'], key: 'K', combo: 'Ctrl+Shift+K' });
  assert.equal(normCombo('Shift+Mod+k'), 'Mod+Shift+K', 'modifiers in a fixed order');
  assert.equal(normCombo('Cmd+/'), 'Meta+/');
  assert.equal(normCombo('alt+up'), 'Alt+ArrowUp');
  assert.equal(normCombo('F6'), 'F6', 'function keys stand alone');
  assert.equal(normCombo('Shift+Esc'), 'Shift+Escape');
  for (const bad of ['K', 'Shift+K', 'Mod+', '+K', 'Mod+Ctrl+K', 'Hyper+K', 'Mod+Banana', 'Mod+Mod+K', '', 'Ctrl+Shift+K'.repeat(5), null, 42]) {
    assert.equal(parseCombo(bad), null, String(bad));
  }
  const ev = (o) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(matches(ev({ code: 'KeyK', key: 'k', ctrlKey: true }), 'Mod+K'), true);
  assert.equal(matches(ev({ code: 'KeyK', key: 'k', metaKey: true }), 'Mod+K', true), true, 'Cmd on a Mac');
  assert.equal(matches(ev({ code: 'KeyK', key: 'k', metaKey: true }), 'Mod+K'), false, 'but not elsewhere');
  assert.equal(matches(ev({ code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true }), 'Mod+K'), false, 'extra Shift does not match');
  assert.equal(matches(ev({ code: 'Slash', key: '?', ctrlKey: true, shiftKey: true }), 'Mod+Shift+/'), true, 'by position, whatever Shift types');
  assert.equal(matches(ev({ code: 'KeyM', key: 'µ', altKey: true }), 'Alt+M'), true, 'Alt changing the character still matches');
  assert.equal(eventCombo(ev({ code: 'KeyJ', key: 'j', ctrlKey: true, altKey: true })), 'Mod+Alt+J');
  assert.equal(eventCombo(ev({ code: 'ShiftLeft', key: 'Shift', shiftKey: true })), null, 'a lone modifier waits');
  // Conflicts: the browser's own, Snug's fixed keys, other actions.
  assert.equal(conflictOf('Mod+W', 'quick').kind, 'reserved');
  assert.equal(conflictOf('Ctrl+T', 'quick').kind, 'reserved', 'Ctrl counts as Mod');
  assert.equal(conflictOf('Mod+L', 'quick').kind, 'reserved');
  assert.equal(conflictOf('Mod+N', 'quick').kind, 'reserved');
  assert.equal(conflictOf('Mod+B', 'quick').kind, 'fixed');
  assert.deepEqual([conflictOf('Mod+Shift+M', 'quick').kind, conflictOf('Mod+Shift+M', 'quick').id], ['action', 'mute']);
  assert.equal(conflictOf('Mod+Shift+M', 'mute'), null, 'its own binding is not a conflict');
  assert.equal(conflictOf('Mod+J', 'quick'), null);
  assert.equal(conflictOf('Mod+Shift+M', 'quick', { mute: 'Mod+Alt+M' }), null, 'free once moved');
  // Stored form.
  assert.deepEqual(cleanKeys({ quick: 'ctrl+alt+j', mute: '' }), { quick: 'Ctrl+Alt+J', mute: '' });
  assert.throws(() => cleanKeys({ nope: 'Mod+J' }), /isn’t a shortcut/);
  assert.throws(() => cleanKeys({ quick: 'J' }), /isn’t valid/);
  assert.throws(() => cleanKeys({ quick: 'Mod+W' }), /can’t be used/);
  assert.throws(() => cleanKeys({ quick: 'Mod+Shift+M' }), /share/);
  assert.throws(() => cleanKeys(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`a${i}`, 'Mod+J'])), 40), /up to 40/);
  const b = bindings({ quick: 'Mod+J', mute: '' });
  assert.equal(b.quick, 'Mod+J');
  assert.equal(b.mute, '', 'unbound');
  assert.equal(b.deafen, 'Mod+Shift+D', 'defaults stay');
  assert.equal(actionFor(ev({ code: 'KeyJ', key: 'j', ctrlKey: true }), { quick: 'Mod+J' }), 'quick');
  assert.equal(actionFor(ev({ code: 'KeyK', key: 'k', ctrlKey: true }), { quick: 'Mod+J' }), null, 'the old key is free again');
  for (const a of ACTIONS) if (a.def) assert.ok(normCombo(a.def), `${a.id} default parses`);
  assert.deepEqual(cleanKeys({}), {}, 'the defaults never conflict');
});

test('sounds: each kind of notification has its own sound; packs set all three; the older setting still works', () => {
  assert.equal(soundKind({ forMe: true }), 'mention');
  assert.equal(soundKind({ forMe: true, dm: true }), 'mention', 'a mention in a direct message is a mention');
  assert.equal(soundKind({ dm: true }), 'dm');
  assert.equal(soundKind({}), 'message');
  const prefs = { sound: 'soft', sounds: { message: 'tick', mention: 'bell', dm: 'wood' } };
  assert.equal(soundFor(prefs, 'mention'), 'bell');
  assert.equal(soundFor(prefs, 'dm'), 'wood');
  assert.equal(soundFor(prefs, 'message'), 'tick');
  assert.equal(soundFor({ sound: 'drop', sounds: null }, 'mention'), 'drop', 'the old single sound for every kind');
  assert.equal(soundFor({ sound: 'off' }, 'dm'), 'off');
  assert.equal(packOf(SOUND_PACKS.wood.sounds), 'wood');
  assert.equal(packOf({ message: 'soft', mention: 'soft', dm: 'soft' }), null);
  for (const p of Object.values(SOUND_PACKS)) assert.deepEqual(cleanPrefs({ sounds: p.sounds }).sounds, p.sounds);
});

test('keys: the camera has no default, and Mod+Shift+V stays paste as plain text', () => {
  assert.equal(ACTIONS.find((a) => a.id === 'camera').def, '');
  assert.equal(bindings({}).camera || '', '');
  assert.equal(conflictOf('Mod+Shift+V', 'camera')?.kind, 'reserved');
  assert.match(conflictOf('Ctrl+Shift+V', 'camera')?.text || '', /plain text/);
  assert.throws(() => cleanKeys({ camera: 'Mod+Shift+V' }), /can’t be used/);
  assert.deepEqual(cleanKeys({ camera: 'Mod+Shift+O' }), { camera: 'Mod+Shift+O' });
});
