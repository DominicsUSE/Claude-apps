// Activities in a voice room, end to end: two people draw on one whiteboard
// and see each other's strokes, play a whole game of tic-tac-toe (one move by
// keyboard) and Connect Four on a phone, and send reactions that float up on
// the other person's stage. Separate browser contexts, real WebRTC, Chromium's
// fake devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-act-'));
let srv, browser, url;
const errors = [];

// Ten seconds of a 440 Hz tone at about -12 dBFS, as the fake microphone.
function toneWav(path) {
  const rate = 48000, secs = 10, n = rate * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.25 * 32767), 44 + i * 2);
  writeFileSync(path, buf);
}

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, ringMs: 8000 });
  url = `http://127.0.0.1:${srv.port}`;
  const wav = join(dir, 'tone.wav');
  toneWav(wav);
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--use-file-for-fake-audio-capture=${wav}`],
  });
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

const contexts = [];
async function person(handle, { viewport = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'] });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
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
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open' && !!window.snug.voiceTest);
  return page;
}
// Each test starts with nobody left in voice from the one before.
test.afterEach(async () => { for (const c of contexts.splice(0)) await c.close(); });

async function openWheelRoom(page) {
  if (!(await page.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').count())) {
    await page.click('.rail-house:has-text("Kiln & Co.")');
    await page.locator('.nav .ctx-house:has-text("Kiln & Co.")').waitFor();
  }
  await page.click('.nav .row:has-text("Wheel room")');
  await page.locator('.stage').waitFor();
}
async function joinWheel(page) {
  await openWheelRoom(page);
  await page.click('.stage .btn.primary:has-text("Join voice")');
  await page.locator('.stage [aria-label="Leave voice"]').waitFor();
}
const connected = (page, n) => page.waitForFunction(async (want) => {
  const peers = Object.values(await window.snug.voiceStats());
  return peers.length === want && peers.every((p) => p.state === 'connected' && p.bytes > 1000);
}, n, { timeout: 25000, polling: 300 });
async function openDm(page, title) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
}
async function openVoiceSettings(page) {
  await page.click('.me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Voice and video")');
  await page.locator('.layer-col h1:has-text("Voice and video")').waitFor();
}
const closeLayer = (page) => page.keyboard.press('Escape');


async function bothIn() {
  const robin = await person('robin');
  const malik = await person('malik');
  await joinWheel(robin);
  await joinWheel(malik);
  await connected(robin, 1);
  return { robin, malik };
}
async function start(page, label) {
  await page.click('.stage [aria-label^="Activities"]');
  await page.click(`.menu [role="menuitemradio"]:has-text("${label}")`);
}
// A stroke drawn with the mouse across a fraction of the canvas.
async function drawLine(page, [x1, y1], [x2, y2]) {
  const box = await page.locator('.act-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (x1 + ((x2 - x1) * i) / 10), box.y + box.height * (y1 + ((y2 - y1) * i) / 10));
  await page.mouse.up();
}
const strokes = (page) => page.locator('.act-canvas').getAttribute('data-strokes').then(Number);

test('whiteboard: two people draw and see each other’s strokes; undo, colours, clear and stop', async () => {
  const { robin, malik } = await bothIn();
  await start(robin, 'Whiteboard');
  await robin.locator('.act-tile.act-board .act-empty').waitFor();
  await malik.locator('.act-tile.act-board').waitFor();
  assert.match(await malik.locator('.act-canvas').getAttribute('aria-label'), /empty/);
  await drawLine(robin, [0.1, 0.2], [0.6, 0.7]);
  await malik.waitForFunction(() => document.querySelector('.act-canvas')?.dataset.strokes === '1');
  // Malik picks rose, the thickest pen, and draws back.
  await malik.click('.act-swatch[aria-label="Rose"]');
  assert.equal(await malik.locator('.act-swatch[aria-label="Rose"]').getAttribute('aria-checked'), 'true');
  await malik.click('.act-width[aria-label="Pen size 4"]');
  await drawLine(malik, [0.8, 0.1], [0.3, 0.9]);
  await robin.waitForFunction(() => document.querySelector('.act-canvas')?.dataset.strokes === '2');
  const theirs = await robin.evaluate(() => Object.values(window.snug.S.activity)[0].strokes.find((s) => s.by === 'malik'));
  assert.equal(theirs.colour, 'rose');
  assert.equal(theirs.width, 4);
  assert.ok(theirs.points.length >= 2 && theirs.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
  // The canvas really has ink on it.
  const inked = await robin.evaluate(() => { const c = document.querySelector('.act-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  assert.ok(inked > 100, `pixels drawn: ${inked}`);
  // Undo takes back only Malik's own stroke.
  await malik.click('.act-tool[aria-label="Undo your last stroke"]');
  await robin.waitForFunction(() => document.querySelector('.act-canvas')?.dataset.strokes === '1');
  // Malik didn't open it, so she can't clear it; Robin can.
  assert.equal(await malik.locator('.act-tool[aria-label="Clear the whiteboard"]').count(), 0);
  await robin.click('.act-tool[aria-label="Clear the whiteboard"]');
  await malik.waitForFunction(() => document.querySelector('.act-canvas')?.dataset.strokes === '0');
  // Tools are 36px and keyboard reachable; Stop ends it for both.
  await robin.locator('.act-swatch[aria-label="Mint"]').focus();
  await robin.keyboard.press('Enter');
  assert.equal(await robin.locator('.act-swatch[aria-label="Mint"]').getAttribute('aria-checked'), 'true');
  await robin.click('.act-stop');
  await malik.locator('.act-tile').waitFor({ state: 'detached' });
});

test('tic-tac-toe: a full game across two browsers, one move by keyboard, announced, then a rematch', async () => {
  const { robin, malik } = await bothIn();
  await start(robin, 'Tic-tac-toe');
  await malik.locator('.act-tile.act-ttt').waitFor();
  await malik.click('.act-sit');
  await robin.locator('.act-status:has-text("Your turn")').waitFor();
  const play = async (page, i) => {
    const turn = await page.evaluate(() => Object.values(window.snug.S.activity)[0].game.moves);
    await page.click(`.act-grid.ttt [data-i="${i}"]`);
    await page.waitForFunction((n) => Object.values(window.snug.S.activity)[0].game.moves === n + 1, turn);
  };
  await play(robin, 0);
  // Malik moves by keyboard: from the centre, Left, then Enter (middle left = 3).
  await malik.locator('.act-status:has-text("Your turn")').waitFor();
  await malik.locator('.act-grid.ttt [data-i="4"]').focus();
  await malik.keyboard.press('ArrowLeft');
  assert.equal(await malik.evaluate(() => document.activeElement?.dataset.i), '3');
  await malik.keyboard.press('Enter');
  await robin.waitForFunction(() => Object.values(window.snug.S.activity)[0].game.board[3] === 1);
  await malik.waitForFunction(() => Object.values(window.snug.S.activity)[0].game.turn === 0);
  // Malik can't play out of turn: her squares are marked unavailable.
  assert.equal(await malik.locator('.act-grid.ttt [data-i="5"]').getAttribute('aria-disabled'), 'true');
  await play(robin, 1);
  await play(malik, 4);
  await play(robin, 2);
  await robin.locator('.act-status.over:has-text("You win")').waitFor();
  await malik.locator('.act-status.over:has-text("Robin wins")').waitFor();
  assert.equal(await malik.locator('.act-grid.ttt .act-cell.win').count(), 3);
  assert.match(await malik.locator('.stage .sr[role="status"]').textContent(), /Robin won/);
  await malik.click('.act-game-acts button:has-text("Rematch")');
  await malik.locator('.act-status:has-text("Your turn")').waitFor();
  assert.equal(await robin.locator('.act-grid.ttt .act-cell.p0, .act-grid.ttt .act-cell.p1').count(), 0, 'a fresh board');
});

test('Connect Four on a phone: 44px drop targets, pieces fall, four in a row wins', async () => {
  const robin = await person('robin');
  const malik = await person('malik', { viewport: { width: 390, height: 844 } });
  await joinWheel(robin);
  await start(robin, 'Connect Four');
  // Malik, on her phone, opens the room and joins.
  await malik.click('.home-house:has-text("Kiln & Co.")');
  await malik.click('.screen.push .row:has-text("Wheel room")');
  await malik.click('.screen.push .stage .btn.primary:has-text("Join voice")');
  await malik.locator('.act-tile.act-c4').waitFor();
  await malik.locator('.act-sit').click();
  const box = await malik.locator('.act-drop').first().boundingBox();
  assert.ok(box.height >= 44, `a 44px target: ${box.height}`);
  const drop = async (page, col) => {
    const n = await page.evaluate(() => Object.values(window.snug.S.activity)[0].game.moves);
    await page.locator(`.act-drop[data-i="${col}"]`).click();
    await page.waitForFunction((m) => Object.values(window.snug.S.activity)[0].game.moves === m + 1, n);
  };
  for (const [who, col] of [[robin, 0], [malik, 6], [robin, 1], [malik, 6], [robin, 2], [malik, 6], [robin, 3]]) await drop(who, col);
  await robin.locator('.act-status.over:has-text("You win")').waitFor();
  assert.equal(await malik.locator('.act-grid.c4 .act-hole.win').count(), 4);
  const g = await malik.evaluate(() => Object.values(window.snug.S.activity)[0].game);
  assert.deepEqual(g.result.line, [35, 36, 37, 38], 'the bottom row');
});

test('voice reactions: Robin’s reaction floats up on Malik’s stage', async () => {
  const { robin, malik } = await bothIn();
  await robin.click('.stage [aria-label="React"]');
  await robin.click('.act-react-btn[aria-label="React 🎉"]');
  await malik.locator('.stage .stage-person:has-text("Robin") .act-float:has-text("🎉")').waitFor();
  await robin.locator('.stage .stage-person:has-text("You") .act-float:has-text("🎉")').waitFor();
  assert.match(await malik.locator('.stage .sr[role="status"]').textContent(), /Robin reacted 🎉/);
  // Too fast: the server says so.
  await robin.click('.act-react-btn[aria-label="React 👍"]');
  await robin.click('.act-react-btn[aria-label="React 👍"]');
  await robin.locator('.toasts:has-text("One reaction a second")').waitFor();
  // It floats away.
  await malik.locator('.stage .act-float').first().waitFor({ state: 'detached', timeout: 5000 });
});
