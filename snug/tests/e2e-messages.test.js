// Voice messages, pinned messages and GIFs, driven in Chromium against the
// real server, with separate people in separate browser sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-msgs-'));
let srv, browser, url;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  url = `http://127.0.0.1:${srv.port}`;
  // A fake microphone (a steady beep), so recording can be tested without hardware.
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
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
  await page.waitForSelector(viewport.width < 760 ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
async function openPlace(page, house) {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function go(page, name) {
  await openPlace(page, 'Kiln & Co.');
  await page.click(`.nav .row:has-text("${name}")`);
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
const say = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };
const settled = (page) => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state));
const msg = (page, text) => page.locator('.main .msg', { hasText: text });

// A real GIF, w by h pixels of one colour, made here so the test needs no fixture.
function makeGif(w, h) {
  const codes = [];
  for (let i = 0; i < w * h; i += 2) codes.push(4, 0, 0);   // clear, then two pixels: the code size stays at 3 bits
  codes.push(5);
  const bytes = [];
  let acc = 0, bits = 0;
  for (const c of codes) { acc |= c << bits; bits += 3; while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8; } }
  if (bits) bytes.push(acc & 255);
  const blocks = [];
  for (let i = 0; i < bytes.length; i += 255) { const part = bytes.slice(i, i + 255); blocks.push(part.length, ...part); }
  const le = (n) => [n & 255, n >> 8];
  return Buffer.from([
    ...Buffer.from('GIF89a'), ...le(w), ...le(h), 0x80, 0, 0,
    0x7f, 0x9d, 0x97, 0xff, 0xff, 0xff,
    0x2c, 0, 0, 0, 0, ...le(w), ...le(h), 0,
    2, ...blocks, 0, 0x3b,
  ]);
}

let robin, ines;

test('voice message: recorded with the microphone, sent, and played by the other person', async () => {
  robin = await person('robin');
  ines = await person('ines');
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');

  // Esc cancels a recording: nothing is sent.
  const before = await robin.evaluate(() => window.snug.S.msgs.k_glaze.length);
  await robin.click('.main .composer .ib.mic');
  await robin.locator('.main .rec.recording').waitFor();
  await robin.keyboard.press('Escape');
  await robin.locator('.main .rec').waitFor({ state: 'detached' });
  assert.equal(await robin.evaluate(() => window.snug.S.msgs.k_glaze.length), before);

  // A tap starts it; the timer and level meter run; Send uploads it.
  await robin.click('.main .composer .ib.mic');
  await robin.locator('.main .rec.recording').waitFor();
  await robin.waitForFunction(() => document.querySelector('.main .rec-time')?.textContent === '0:02', null, { timeout: 6000 });
  assert.ok(await robin.evaluate(() => [...document.querySelectorAll('.main .rec-meter i')].some((i) => parseFloat(i.style.height) > 8)), 'the level meter moves with the fake microphone');
  await robin.click('.main .rec .send');
  await robin.locator('.main .rec').waitFor({ state: 'detached' });
  await settled(robin);
  const sent = await robin.evaluate(() => window.snug.S.msgs.k_glaze.at(-1).files[0]);
  assert.equal(sent.kind, 'audio');
  assert.ok(sent.duration >= 2 && sent.duration < 4, `duration ${sent.duration}`);
  assert.equal(sent.peaks.length, 48);
  assert.ok(sent.peaks.some((p) => p > 50), 'the waveform has the beep in it');

  // Ines sees the player row, with the length and the waveform, live.
  const player = ines.locator('.main .msg .voice').last();
  await player.waitFor();
  assert.equal(await player.locator('.voice-wave i').count(), 48);
  assert.match(await player.locator('.voice-time').textContent(), /^0:0[23]$/);
  // The file is served as audio, inline, and seeks with a range request.
  const res = await ines.evaluate(async (id) => {
    const r = await fetch(`/api/files/${id}`, { headers: { Range: 'bytes=0-15' } });
    return { status: r.status, type: r.headers.get('content-type'), range: r.headers.get('content-range') };
  }, sent.id);
  assert.equal(res.status, 206);
  assert.equal(res.type, 'audio/webm');
  assert.match(res.range, /^bytes 0-15\/\d+$/);

  // Playing it: the audio really advances, and the bars fill.
  await player.locator('.voice-play').click();
  await ines.waitForFunction(() => { const a = [...document.querySelectorAll('.main .voice audio')].pop(); return a && a.currentTime > 0.4; }, null, { timeout: 8000 });
  await player.locator('.voice-wave i.done').first().waitFor();
  assert.equal(await player.locator('.voice-play').getAttribute('aria-label'), 'Pause voice message');
  // Speed: 1x, 1.5x, 2x.
  await player.locator('.voice-speed').click();
  assert.equal(await ines.evaluate(() => [...document.querySelectorAll('.main .voice audio')].pop().playbackRate), 1.5);
  await player.locator('.voice-speed').click();
  assert.equal(await player.locator('.voice-speed').textContent(), '2×');
  // Keyboard: the waveform is a slider; Home goes back to the start.
  await player.locator('.voice-play').click();
  await player.locator('.voice-wave').focus();
  await ines.keyboard.press('Home');
  assert.ok(await ines.evaluate(() => [...document.querySelectorAll('.main .voice audio')].pop().currentTime) < 0.2);
  assert.equal(await player.locator('.voice-wave').getAttribute('aria-valuenow'), '0');

  // Hold to record: press, talk, let go, and it sends.
  const count = await robin.evaluate(() => window.snug.S.msgs.k_glaze.length);
  const players = await ines.locator('.main .msg .voice').count();
  await robin.locator('.main .composer .ib.mic').hover();
  await robin.mouse.down();
  await robin.locator('.main .rec.recording').waitFor();
  await robin.waitForTimeout(1500);
  await robin.mouse.up();
  await robin.locator('.main .rec').waitFor({ state: 'detached' });
  await settled(robin);
  assert.equal(await robin.evaluate(() => window.snug.S.msgs.k_glaze.length), count + 1);
  assert.equal(await robin.evaluate(() => window.snug.S.msgs.k_glaze.at(-1).files[0].kind), 'audio');
  await ines.waitForFunction((n) => document.querySelectorAll('.main .msg .voice').length === n, players + 1);
});

test('pins: pinned and unpinned live for the other person, with the line, the marker, the header count and the list', async () => {
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  await say(ines, 'Cone 6 glaze recipe: 20 silica, 20 frit, 30 feldspar.');
  await settled(ines);
  const mine = msg(robin, 'Cone 6 glaze recipe');
  await mine.waitFor();
  await mine.hover();
  await mine.locator('[aria-label="More actions"]').click();
  await robin.locator('.menu-item:has-text("Pin message")').click();
  // Ines sees it at once.
  await ines.locator('.main .pinline:has-text("Robin Hale pinned a message")').waitFor();
  await msg(ines, 'Cone 6 glaze recipe').locator('.msg-pin:has-text("Pinned by Robin")').waitFor();
  const btn = ines.locator('.main .bar .pins-btn');
  assert.equal(await btn.locator('.num').textContent(), '1');
  await btn.click();
  const pane = ines.locator('.pane[aria-label="Pinned messages"]');
  await pane.locator('.pin-row:has-text("Cone 6 glaze recipe")').waitFor();
  assert.match(await pane.locator('.pin-by').textContent(), /Pinned by Robin/);
  // Robin unpins from his list; Ines's line, marker and count go.
  await robin.locator('.main .bar .pins-btn').click();
  await robin.locator('.pane[aria-label="Pinned messages"] .pin-row button[aria-label="Unpin"]').click();
  await ines.locator('.main .pinline').waitFor({ state: 'detached' });
  await btn.waitFor({ state: 'detached' });
  assert.equal(await msg(ines, 'Cone 6 glaze recipe').locator('.msg-pin').count(), 0);
  await pane.locator('.pins-empty').waitFor();
  await ines.keyboard.press('Escape');
  await robin.keyboard.press('Escape');
  // A member without the pin or moderate permission doesn't get the menu item.
  const priya = await person('priya');
  await go(priya, 'Glaze lab');
  const hers = msg(priya, 'Cone 6 glaze recipe');
  await hers.hover();
  await hers.locator('[aria-label="More actions"]').click();
  await priya.locator('.menu-item:has-text("Copy text")').waitFor();
  assert.equal(await priya.locator('.menu-item:has-text("Pin message")').count(), 0);
  await priya.keyboard.press('Escape');
  await priya.context().close();
});

test('gifs: a GIF saved on one device is in "Your GIFs" on another, and sends from there', async () => {
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  await ines.locator('.main .composer input[type=file]').setInputFiles({ name: 'kiln-wave.gif', mimeType: 'image/gif', buffer: makeGif(120, 80) });
  await ines.locator('.pending-file:has-text("kiln-wave.gif") .pending-state:not(:has-text("Uploading"))').waitFor();
  await say(ines, 'The kiln when it opens');
  await settled(ines);
  const gif = msg(robin, 'The kiln when it opens').locator('.gif');
  await gif.waitFor();
  await gif.locator('img').waitFor();
  assert.equal(await gif.locator('.gif-tag').textContent(), 'GIF');

  // Robin's second device.
  const robin2 = await person('robin');
  await go(robin2, 'Firing schedule');
  await gif.hover();
  await gif.locator('.gif-star').click();
  assert.equal(await gif.locator('.gif-star').getAttribute('aria-pressed'), 'true');
  await robin2.waitForFunction(() => window.snug.S.gifFavs.some((g) => g.name === 'kiln-wave.gif'));
  await robin2.click('.main .composer .gif-btn');
  const picker = robin2.locator('.gif-picker');
  await picker.waitFor();
  assert.equal(await picker.locator('[role=tab][aria-selected=true]').textContent(), 'Your GIFs');
  assert.equal(await picker.locator('[role=tab]:has-text("Search")').count(), 0, 'no search without a provider key');
  await picker.locator('.gif-tile[aria-label="Send kiln-wave.gif"]').click();
  await picker.waitFor({ state: 'detached' });
  await settled(robin2);
  const copy = await robin2.evaluate(() => window.snug.S.msgs.k_firing.at(-1).files[0]);
  assert.equal(copy.gif, true);
  // Ines sees it, as a copied file in that room.
  await go(ines, 'Firing schedule');
  await ines.locator(`.main .msg .gif img[src="/api/files/${copy.id}"]`).waitFor();
  // Unsaving on the second device reaches the first.
  await robin2.evaluate(() => import('./js/views/media.js').then((m) => m.toggleGifFav(window.snug.S.gifFavs[0])));
  await gif.locator('.gif-star[aria-pressed="false"]').waitFor();
  await robin2.context().close();
});

test('gifs: "Recent in your places" shows a GIF someone else posted; reduced motion pauses GIFs until Play', async () => {
  await go(robin, 'Show & tell');
  await robin.click('.main .composer .gif-btn');
  const picker = robin.locator('.gif-picker');
  await picker.locator('[role=tab]:has-text("Recent in your places")').click();
  const tile = picker.locator('.gif-tile[aria-label="Send kiln-wave.gif"]');
  await tile.waitFor();
  assert.equal(await picker.locator('.gif-tile[aria-label="Send kiln-wave.gif"]').count(), 1, 'the same GIF shows once, though it was sent twice');
  await robin.keyboard.press('Escape');

  await robin.emulateMedia({ reducedMotion: 'reduce' });
  await go(robin, 'Glaze lab');
  const gif = msg(robin, 'The kiln when it opens').locator('.gif');
  await gif.locator('canvas').waitFor();
  assert.equal(await gif.locator('img').count(), 0, 'paused: a still frame, no animation');
  await gif.locator('.gif-play').click();
  await gif.locator('img').waitFor();
  await gif.hover();
  await gif.locator('.gif-pause').click();
  await gif.locator('canvas').waitFor();
  await robin.emulateMedia({ reducedMotion: 'no-preference' });
});
