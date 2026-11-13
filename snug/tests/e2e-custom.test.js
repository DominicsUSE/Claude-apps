// Customisation, driven in Chromium against the real server with separate
// browser sessions (seeded data: Robin and Ines share Kiln & Co. and are
// friends). Profile pictures, accents, themes and the theme builder, the live
// preview, chat display, fonts, shortcuts, sounds, decorations, name styles,
// profile colours, chat backgrounds and the per-device override.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { accentTokens, THEME_PRESETS } from '../js/lib/theme.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-custom-'));
let srv, browser, url;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector('.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
const close = (page) => page.context().close();
async function settings(page, label) {
  if (!(await page.locator('.layer').count())) await page.click('.me-row [aria-label="Settings"]');
  await page.click(`.layer-nav .row:has-text("${label}")`);
  await page.locator(`.layer-body h1:has-text("${label === 'Appearance' ? 'Appearance' : label}")`).first().waitFor();
}
const closeLayer = (page) => page.click('.layer-close');
async function go(page, name) {
  if (!(await page.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').count())) {
    await page.click('.rail-house:has-text("Kiln & Co.")');
    await page.locator('.nav .ctx-house:has-text("Kiln & Co.")').waitFor();
  }
  await page.click(`.nav .row:has-text("${name}")`);
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
const say = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };
const msg = (page, text) => page.locator('.main .msg', { hasText: text });
const css = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
const rootVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase(), name);
const prefsOf = (handle) => JSON.parse(srv.db.get('SELECT p.prefs FROM user_prefs p JOIN users u ON u.id = p.user WHERE u.handle = ?', handle)?.prefs || '{}');
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
const setPrefs = (page, prefs) => page.evaluate(async (p) => { const { S, emit } = window.snug; Object.assign(S.prefs, p); emit(); }, prefs);
const syncedPrefs = (handle, test) => new Promise((resolve, reject) => {
  const end = Date.now() + 5000;
  const tick = () => { const p = prefsOf(handle); if (test(p)) resolve(p); else if (Date.now() > end) reject(new Error(`prefs never matched: ${JSON.stringify(p)}`)); else setTimeout(tick, 100); };
  tick();
});

// A real PNG of one colour (the browser decodes it to crop it).
function png(w, h, rgbv = [88, 160, 210]) {
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgbv).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
// A small one-frame GIF.
function gif(w, h) {
  const codes = [];
  for (let i = 0; i < w * h; i += 2) codes.push(4, 0, 0);
  codes.push(5);
  const bytes = [];
  let acc = 0, bits = 0;
  for (const c of codes) { acc |= c << bits; bits += 3; while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8; } }
  if (bits) bytes.push(acc & 255);
  const blocks = [];
  for (let i = 0; i < bytes.length; i += 255) { const part = bytes.slice(i, i + 255); blocks.push(part.length, ...part); }
  const le = (n) => [n & 255, n >> 8];
  return Buffer.from([...Buffer.from('GIF89a'), ...le(w), ...le(h), 0x80, 0, 0, 0x7f, 0x9d, 0x97, 0xff, 0xff, 0xff, 0x2c, 0, 0, 0, 0, ...le(w), ...le(h), 0, 2, ...blocks, 0, 0x3b]);
}

test('profile picture: checked in the browser, cropped, uploaded; another person sees it on messages and in the member list', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await settings(robin, 'Profile');
  const input = robin.locator('#ap-avatar-file');
  // Wrong kind, too big: clear errors, nothing uploaded.
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await robin.locator('#ap-avatar-err:has-text("PNG, JPEG, GIF or WebP")').waitFor();
  await input.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await robin.locator('#ap-avatar-err:has-text("up to 2 MB")').waitFor();
  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png at all') });
  await robin.locator('#ap-avatar-err:has-text("couldn’t be opened")').waitFor();
  // A real one: the crop stage, the three preview sizes, then save.
  await input.setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png(300, 200) });
  await robin.locator('.ap-crop-stage canvas').waitFor();
  await robin.waitForFunction(() => [...document.querySelectorAll('.ap-sizes .avatar img')].filter((i) => i.src.startsWith('data:')).length === 3, null, { timeout: 5000 }); // previews at 24, 40 and 96 px
  await robin.locator('.ap-crop input[aria-label="Zoom"]').fill('1.5');
  await robin.click('button:has-text("Save picture")');
  await robin.waitForFunction(() => /^\/api\/avatars\/f_/.test(window.snug.S.users[window.snug.S.me].img || ''));
  const img = await robin.evaluate(() => window.snug.S.users[window.snug.S.me].img);
  const fileRow = srv.db.get('SELECT type, meta FROM files WHERE id = ?', img.split('/').pop());
  assert.equal(fileRow.type, 'image/png');
  assert.deepEqual(JSON.parse(fileRow.meta), { w: 512, h: 512 }, 'cropped square in the browser');
  await closeLayer(robin);
  await go(robin, 'Glaze lab');
  await say(robin, 'Picture check 1');
  await go(ines, 'Glaze lab');
  const head = msg(ines, 'Picture check 1').locator('.msg-gutter .avatar img');
  await head.waitFor();
  assert.equal(await head.getAttribute('src'), img);
  assert.ok(await head.evaluate((el) => el.complete && el.naturalWidth === 512), 'the picture loads for someone who may see Robin');
  await ines.click('.main .bar [aria-label^="People"]');
  await ines.locator('.person:has-text("Robin") .avatar img').waitFor();
  await close(robin); await close(ines);
});

test('decorations, name styles and profile colours: picked in Profile, seen by someone else; viewers can turn name styles off', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await settings(robin, 'Profile');
  await robin.click('.ap-deco[data-deco="leaves"]');
  await robin.locator('.swatches[aria-label="Decoration colour"] [aria-label="Teal"]').click();
  await robin.click('.seg[aria-label="Name font"] button:has-text("Serif")');
  await robin.waitForFunction(() => window.snug.S.users[window.snug.S.me].nameStyle?.font === 'serif');
  await robin.click('.seg[aria-label="Name weight"] button:text-is("Bold")');
  await robin.waitForFunction(() => window.snug.S.users[window.snug.S.me].nameStyle?.weight === 'bold');
  // An unreadable header colour can't be saved.
  await robin.locator('#pc-1').fill('#777777');
  await robin.locator('.ap-card-pv + .ap-field .ap-badge.bad, .ap-field:has(#pc-1) .ap-badge.bad').first().waitFor();
  assert.equal(await robin.locator('button:has-text("Save colours")').isDisabled(), true);
  await robin.locator('#pc-1').fill('#2B4C7E');
  await robin.locator('#pc-2').fill('#F3E9D2');
  await robin.click('button:has-text("Save colours")');
  await robin.waitForFunction(() => window.snug.S.users[window.snug.S.me].profileColors?.[0] === '#2B4C7E');
  await closeLayer(robin);
  await go(robin, 'Glaze lab');
  await say(robin, 'Style check 2');
  await go(ines, 'Glaze lab');
  const m = msg(ines, 'Style check 2');
  await m.locator('.msg-gutter .avatar .deco.leaves').waitFor();
  assert.equal(await m.locator('.msg-gutter .avatar').getAttribute('data-deco-hue'), '200');
  const name = m.locator('.msg-name');
  assert.equal(await name.getAttribute('data-ns-font'), 'serif');
  assert.match(await css(name, 'fontFamily'), /Georgia|Palatino|Iowan/);
  assert.equal(await css(name, 'fontWeight'), '700');
  // The profile card: header in the first colour, text chosen to read on it.
  await name.click();
  const card = ines.locator('.pcard.has-pcolors');
  await card.waitFor();
  assert.equal(await css(card.locator('.acc-banner'), 'backgroundColor'), rgb('#2B4C7E'));
  assert.equal(await css(card, 'backgroundColor'), rgb('#F3E9D2'));
  await ines.keyboard.press('Escape');
  // Ines turns other people's name styles off for herself.
  await settings(ines, 'Appearance');
  await ines.click('[aria-label="Show people’s name styles"]');
  await ines.waitForFunction(() => document.documentElement.getAttribute('data-name-styles') === 'off');
  await closeLayer(ines);
  assert.doesNotMatch(await css(msg(ines, 'Style check 2').locator('.msg-name'), 'fontFamily'), /Georgia|Palatino|Iowan/);
  await setPrefs(ines, { showNameStyles: true });
  await close(robin); await close(ines);
});

test('accent: a custom colour with a contrast badge; another browser on the same account paints its buttons with it; unreadable ones are refused', async () => {
  const a = await person('robin');
  await settings(a, 'Appearance');
  await a.locator('#ap-accent-hex').fill('#151617');
  await a.click('.ap-custom button:has-text("Use colour")');
  await a.locator('#ap-accent-msg:has-text("can’t be made readable")').waitFor();
  await a.locator('#ap-accent-hex').fill('#3A7BD5');
  await a.locator('.ap-custom .ap-badge').waitFor();
  await a.click('.ap-custom button:has-text("Use colour")');
  await syncedPrefs('robin', (p) => p.accent === '#3A7BD5');
  const base = await a.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const want = accentTokens('#3A7BD5', THEME_PRESETS[base].bg1, base)['--accent'];
  const b = await person('robin');
  await b.waitForFunction(() => document.documentElement.hasAttribute('data-accent'));
  await settings(b, 'Appearance');
  const primary = b.locator('.ap-preview .btn.primary');
  assert.equal(await css(primary, 'backgroundColor'), rgb(want), 'the second browser shows the new accent on primary buttons');
  // Violet stays the brand for what needs you.
  assert.equal(await rootVar(b, '--brand'), base === 'dark' ? '#996FF7' : '#763FF4');
  await b.click('.ap-accent[data-accent="violet"]');
  await syncedPrefs('robin', (p) => !p.accent || p.accent === 'violet');
  await b.waitForFunction(() => !document.documentElement.hasAttribute('data-accent'));
  await close(a); await close(b);
  // An account and a device saved while Snug was coral (accent and tone
  // 'coral', the old default) open in violet, with no leftover attributes.
  const row = prefsOf('robin');
  srv.db.run('UPDATE user_prefs SET prefs = ? WHERE user = (SELECT id FROM users WHERE handle = ?)', JSON.stringify({ ...row, accent: 'coral', tone: 'coral' }), 'robin');
  const c = await person('robin');
  await c.evaluate(() => { const p = JSON.parse(localStorage.getItem('snug.prefs')); localStorage.setItem('snug.prefs', JSON.stringify({ ...p, accent: 'coral', tone: 'coral' })); });
  await c.reload();
  await c.waitForFunction(() => window.snug?.S?.prefs?.accent === 'violet' && window.snug.S.prefs.tone === 'violet');
  assert.equal(await c.evaluate(() => ['data-accent', 'data-tone'].some((n) => document.documentElement.hasAttribute(n))), false);
  assert.equal(await rootVar(c, '--accent'), base === 'dark' ? '#996FF7' : '#763FF4', 'the brand tokens paint the controls');
  await settings(c, 'Appearance');
  assert.equal(await c.locator('.ap-accent[data-accent="violet"]').getAttribute('aria-checked'), 'true');
  await closeLayer(c);
  // A device last synced while coral (its prefs and what it last sent both say
  // 'coral') must not read the rename as an offline change: an accent and tone
  // picked since on another device survive its next sign-in.
  await c.evaluate(() => {
    for (const k of ['snug.prefs', 'snug.prefsSent']) { const p = JSON.parse(localStorage.getItem(k)) || {}; localStorage.setItem(k, JSON.stringify({ ...p, accent: 'coral', tone: 'coral' })); }
  });
  srv.db.run('UPDATE user_prefs SET prefs = ? WHERE user = (SELECT id FROM users WHERE handle = ?)', JSON.stringify({ ...prefsOf('robin'), accent: 'cyan', tone: 'cyan' }), 'robin');
  await c.reload();
  await c.waitForFunction(() => window.snug?.S?.conn?.socket === 'open' && window.snug.S.prefs.accent === 'cyan' && window.snug.S.prefs.tone === 'cyan');
  await c.waitForTimeout(1500); // a wrong push would land within the sync debounce
  assert.equal(prefsOf('robin').accent, 'cyan', 'the newer accent stays on the account');
  assert.equal(prefsOf('robin').tone, 'cyan', 'the newer tone stays on the account');
  assert.deepEqual(await c.evaluate(() => [window.snug.S.prefs.accent, window.snug.S.prefs.tone]), ['cyan', 'cyan']);
  await setPrefs(c, { accent: 'violet', tone: 'violet' });
  await syncedPrefs('robin', (p) => (!p.accent || p.accent === 'violet') && (!p.tone || p.tone === 'violet'));
  await close(c);
});

test('themes: named cards, quick switcher actions, and the live preview follows text size and accent', async () => {
  const a = await person('robin');
  await settings(a, 'Appearance');
  await a.click('.ap-card[data-theme-id="sepia"]');
  await a.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'sepia');
  assert.equal(await a.evaluate(() => getComputedStyle(document.body).backgroundColor), rgb('#E4D9C6'));
  assert.equal(await a.locator('.ap-card[data-theme-id="sepia"]').getAttribute('aria-checked'), 'true');
  // Preview: text size and accent show at once.
  const text = a.locator('.ap-preview .msg-text').first();
  const before = parseFloat(await css(text, 'fontSize'));
  await a.locator('#acc-font').fill('19');
  await a.waitForFunction(() => document.documentElement.style.fontSize === '19px');
  assert.ok(parseFloat(await css(text, 'fontSize')) > before, 'preview text grows with the text size');
  const btn = a.locator('.ap-preview .btn.primary');
  const violet = await css(btn, 'backgroundColor');
  assert.equal(violet, rgb('#763FF4'), 'Sepia: the light-theme violet');
  await a.click('.ap-accent[data-accent="cyan"]');
  const cyan = rgb(accentTokens('cyan', THEME_PRESETS.sepia.bg1, 'light')['--accent']);
  assert.notEqual(cyan, violet);
  await a.waitForFunction((c) => getComputedStyle(document.querySelector('.ap-preview .btn.primary')).backgroundColor === c, cyan);
  await closeLayer(a);
  // Quick switcher: themes by name.
  await a.keyboard.press('Control+k');
  await a.locator('.quick input').fill('slate theme');
  await a.locator('.quick .menu-item:has-text("Switch to Slate theme")').waitFor();
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'slate');
  await setPrefs(a, { theme: 'system', accent: 'violet', fontScale: 16 });
  await syncedPrefs('robin', (p) => !p.theme && !p.fontScale);
  await close(a);
});

test('theme builder: create, save and use; share the code; another account imports it with the same colours; bad codes explain themselves', async () => {
  const a = await person('robin');
  await settings(a, 'Appearance');
  await a.click('button:has-text("Create theme")');
  await a.locator('#tb-name').fill('Night shift');
  await a.locator('#tb-text').fill('#3A3F46');
  await a.locator('#tb-err').waitFor();
  assert.equal(await a.locator('button:has-text("Save and use")').isDisabled(), true, 'an unreadable theme can’t be saved');
  await a.locator('#tb-text').fill('#E8ECF1');
  await a.locator('#tb-bg').fill('#1B2430');
  assert.ok(await a.locator('.ap-checks .ap-badge.bad').count() === 0);
  await a.click('button:has-text("Save and use")');
  await a.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg-1') === '#1B2430');
  assert.equal(await a.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'drawn on the dark base');
  const saved = await syncedPrefs('robin', (p) => p.customThemes?.length === 1 && p.theme?.startsWith('custom:'));
  assert.equal(saved.customThemes[0].name, 'Night shift');
  assert.equal(await a.evaluate(() => getComputedStyle(document.body).backgroundColor) !== '', true);
  await a.click('[aria-label="Share Night shift"]');
  const code = await a.locator('input[aria-label="Theme code for Night shift"]').inputValue();
  assert.match(code, /^snug-theme:1:[A-Za-z0-9_-]+$/);
  const bg1 = await rootVar(a, '--bg-1');
  // The first paint already has it: js/boot.js puts last time's look on <html>
  // before any module runs (here the app's modules never load at all).
  const first = await a.context().newPage();
  await first.route('**/js/app.js', (r) => r.abort());
  await first.goto(url);
  assert.equal(await first.evaluate(() => document.documentElement.style.getPropertyValue('--bg-1')), '#1B2430', 'no flash of the default colours');
  assert.equal(await first.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
  await first.close();

  const b = await person('ines');
  await settings(b, 'Appearance');
  await b.locator('#ap-import').fill('snug-theme:1:not-really');
  await b.click('.ap-code button:has-text("Import")');
  await b.locator('#ap-import-msg:has-text("damaged")').waitFor();
  await b.locator('#ap-import').fill('hello there');
  await b.click('.ap-code button:has-text("Import")');
  await b.locator('#ap-import-msg:has-text("start with")').waitFor();
  await b.locator('#ap-import').fill(code);
  await b.click('.ap-code button:has-text("Import")');
  await b.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg-1') !== '');
  assert.equal(await rootVar(b, '--bg-1'), bg1, 'the same colours on another account');
  await syncedPrefs('ines', (p) => p.customThemes?.[0]?.name === 'Night shift');
  // Delete it again: back to the default theme.
  await b.click('[aria-label="Delete Night shift"]');
  await b.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg-1') === '');
  await a.click('[aria-label="Delete Night shift"]');
  await syncedPrefs('robin', (p) => !p.customThemes?.length && !p.theme);
  await close(a); await close(b);
});

test('chat display: big emoji, times on hover, reactions, GIFs still until hovered, chat background and font, on another browser', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await go(robin, 'Glaze lab');
  await say(robin, '🏺');
  await robin.locator('.main .composer input[type=file]').setInputFiles({ name: 'kiln.gif', mimeType: 'image/gif', buffer: gif(120, 80) });
  await robin.locator('.pending-file:has-text("kiln.gif") .pending-state:not(:has-text("Uploading"))').waitFor();
  await say(robin, 'A moving kiln 3');
  await robin.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state));
  // Ines changes her chat display.
  await settings(ines, 'Appearance');
  await ines.click('[aria-label="Big emoji"]');
  await ines.click('.seg[aria-label="Times on messages"] button:has-text("On hover")');
  await ines.click('[aria-label="Show reactions"]');
  await ines.click('.seg[aria-label="Play GIFs"] button:has-text("Never")');
  await ines.click('.seg[aria-label="Chat background"] button:has-text("Dots")');
  await ines.click('.seg[aria-label="Font"] button:has-text("Serif")');
  await syncedPrefs('ines', (p) => p.gifAutoplay === 'never' && p.font === 'serif' && p.chatBg === 'dots');
  await closeLayer(ines);
  await go(ines, 'Glaze lab');
  await say(ines, 'Display check 3');
  const jumbo = ines.locator('.main .msg-text.jumbo').last();
  await jumbo.waitFor();
  assert.equal(await css(jumbo, 'fontSize'), '16px', 'big emoji off: normal size');
  const head = msg(ines, 'Display check 3').locator('.msg-time');
  assert.equal(await css(head, 'visibility'), 'hidden', 'times wait for hover');
  await msg(ines, 'Display check 3').hover();
  assert.equal(await css(head, 'visibility'), 'visible');
  const withRx = ines.locator('.main .msg:has(.reactions)').first();
  if (await withRx.count()) assert.equal(await css(withRx.locator('.reactions'), 'display'), 'none', 'reactions hidden');
  const g = msg(ines, 'A moving kiln 3').locator('.gif');
  await g.locator('canvas').waitFor();
  assert.equal(await g.locator('img').count(), 0, 'a still frame, not the moving GIF');
  await g.hover();
  await g.locator('img').waitFor();
  assert.match(await css(ines.locator('.main .scroller'), 'backgroundImage'), /data:image\/svg\+xml/);
  assert.match(await css(msg(ines, 'Display check 3').locator('.msg-text'), 'fontFamily'), /Georgia|Palatino|Iowan/);
  // The same look on Ines's other browser.
  const ines2 = await person('ines');
  await ines2.waitForFunction(() => document.documentElement.getAttribute('data-font') === 'serif');
  await go(ines2, 'Glaze lab');
  assert.match(await css(msg(ines2, 'Display check 3').locator('.msg-text'), 'fontFamily'), /Georgia|Palatino|Iowan/);
  assert.equal(await css(ines2.locator('.main .msg-text.jumbo').last(), 'fontSize'), '16px');
  await setPrefs(ines2, { jumboEmoji: true, showTimes: 'always', showReactions: true, gifAutoplay: 'auto', chatBg: 'plain', font: 'inter' });
  await syncedPrefs('ines', (p) => !p.font && !p.chatBg);
  await close(robin); await close(ines); await close(ines2);
});

test('keyboard: rebind the quick switcher and use it; Ctrl+Shift+M mutes in a call and the other person sees it', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await settings(robin, 'Keyboard');
  const row = robin.locator('.kb-row[data-action="quick"]');
  await row.locator('.kb-rec').click();
  await row.locator('.kb-rec.listening').waitFor();
  await robin.keyboard.press('Control+f');
  await row.locator('.kb-err:has-text("browser keeps")').waitFor();
  await robin.keyboard.press('Control+Shift+m');
  await row.locator('.kb-err:has-text("Mute or unmute")').waitFor();
  assert.equal(await row.locator('.kb-rec.listening').count(), 1, 'still listening after a conflict');
  await robin.keyboard.press('Control+j');
  await row.locator('kbd:has-text("J")').waitFor();
  await syncedPrefs('robin', (p) => p.keys?.quick === 'Mod+J');
  await closeLayer(robin);
  await robin.keyboard.press('Control+j');
  await robin.locator('.quick input').waitFor();
  await robin.keyboard.press('Escape');
  await robin.keyboard.press('Control+k');
  await robin.waitForTimeout(200);
  assert.equal(await robin.locator('.quick').count(), 0, 'the old keys are free now');
  // The shortcuts sheet lists Robin's own keys.
  await robin.keyboard.press('Control+/');
  await robin.locator('.acc-key-row:has-text("quick switcher") kbd:has-text("J")').waitFor();
  await robin.keyboard.press('Escape');
  // Voice: in the Wheel room, mute from the keyboard while typing.
  for (const p of [robin, ines]) {
    await go(p, 'Wheel room');
    await p.click('.stage .btn.primary:has-text("Join voice")');
    await p.locator('.stage [aria-label="Leave voice"]').waitFor();
  }
  await robin.waitForFunction(() => window.snug.S.call?.status === 'live' && !window.snug.S.call.muted);
  await robin.locator('.composer textarea').first().click().catch(() => {});
  await robin.keyboard.press('Control+Shift+m');
  await robin.waitForFunction(() => window.snug.S.call.muted === true);
  await robin.locator('#key-announce:has-text("Muted")').waitFor({ state: 'attached' });
  const robinId = await robin.evaluate(() => window.snug.S.me);
  await ines.waitForFunction((id) => Object.values(window.snug.S.voiceState).some((r) => r[id]?.muted), robinId);
  await ines.locator('.stage-person:has-text("Robin") .muted-ic').waitFor();
  await robin.keyboard.press('Control+Shift+m');
  await robin.waitForFunction(() => window.snug.S.call.muted === false);
  await robin.click('.stage [aria-label="Leave voice"]');
  await ines.click('.stage [aria-label="Leave voice"]');
  await setPrefs(robin, { keys: {} });
  await syncedPrefs('robin', (p) => !p.keys || !Object.keys(p.keys).length);
  await close(robin); await close(ines);
});

test('sounds: a mention and a direct message play the sounds picked for each', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await settings(robin, 'Notifications');
  await robin.selectOption('select[aria-label="Mentions sound"]', 'bell');
  await robin.selectOption('select[aria-label="Direct messages sound"]', 'wood');
  await syncedPrefs('robin', (p) => p.sounds?.mention === 'bell' && p.sounds?.dm === 'wood');
  await closeLayer(robin);
  await robin.click('.rail [aria-label="Home"], .rail-item:has-text("Home")').catch(() => {});
  await robin.evaluate(() => window.snug.account.soundLog.splice(0));
  await go(ines, 'Glaze lab');
  await say(ines, '@robin the glaze is ready');
  await robin.waitForFunction(() => window.snug.account.soundLog.length > 0);
  assert.equal(await robin.evaluate(() => window.snug.account.soundLog.at(-1)), 'bell', 'a mention');
  const dm = await ines.evaluate(() => {
    const { S } = window.snug;
    const robinId = Object.keys(S.users).find((id) => S.users[id].handle === 'robin');
    return S.dmOrder.find((d) => S.dms[d]?.members?.length === 2 && S.dms[d].members.includes(robinId));
  });
  assert.ok(dm, 'Ines and Robin have a conversation');
  await ines.evaluate(async (conv) => { const m = await import('/js/server.js'); m.sendMessage(conv, 'Are you coming on Saturday?'); }, dm);
  await robin.waitForFunction(() => window.snug.account.soundLog.length > 1);
  assert.equal(await robin.evaluate(() => window.snug.account.soundLog.at(-1)), 'wood', 'a direct message');
  await setPrefs(robin, { sounds: null });
  await close(robin); await close(ines);
});

test('this device only: one browser keeps its own theme and text size; the other keeps the synced ones', async () => {
  const a = await person('robin');
  const b = await person('robin');
  await settings(a, 'Appearance');
  await a.click('[aria-label="Use these settings on this device only"]');
  await a.click('.ap-card[data-theme-id="moss"]');
  await a.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'moss');
  await a.locator('#acc-font').fill('18');
  await a.waitForFunction(() => document.documentElement.style.fontSize === '18px');
  await a.waitForTimeout(600);
  const p = prefsOf('robin');
  assert.notEqual(p.theme, 'moss', 'not synced');
  assert.notEqual(p.fontScale, 18);
  assert.notEqual(await b.evaluate(() => document.documentElement.getAttribute('data-theme')), 'moss');
  // A synced change still reaches the overridden browser, for settings it doesn't keep.
  await settings(b, 'Appearance');
  await b.click('.seg[aria-label="Line height"] button:has-text("Loose")');
  await a.waitForFunction(() => document.documentElement.getAttribute('data-lh') === 'loose');
  assert.equal(await a.evaluate(() => document.documentElement.getAttribute('data-theme')), 'moss', 'its own theme stays');
  // Reloading keeps it (localStorage).
  await a.reload();
  await a.waitForSelector('.nav');
  await a.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'moss');
  // Off again: the synced values return.
  await settings(a, 'Appearance');
  await a.click('[aria-label="Use these settings on this device only"]');
  await a.waitForFunction(() => document.documentElement.getAttribute('data-theme') !== 'moss' && !document.documentElement.style.fontSize);
  await b.click('.seg[aria-label="Line height"] button:has-text("Normal")');
  await close(a); await close(b);
});
