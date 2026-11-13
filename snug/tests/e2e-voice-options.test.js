// Voice options end to end: separate people in separate browsers, real WebRTC
// between them, fake microphone and camera from Chromium. Device lists and
// checks in settings, push to talk gating what is sent, each person's volume
// on the audio element that plays them, a soundboard sound really arriving at
// the other person, a voice room's user limit, and the floating call.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-voiceopts-'));
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
test.beforeEach(() => srv.hub.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'] });
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
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
async function openKiln(page) {
  if (!(await page.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').count())) {
    await page.click('.rail-house:has-text("Kiln & Co.")');
    await page.locator('.nav .ctx-house:has-text("Kiln & Co.")').waitFor();
  }
}
async function openWheelRoom(page) {
  await openKiln(page);
  await page.click('.nav .row:has-text("Wheel room")');
  await page.locator('.stage').waitFor();
}
const connected = (page, n) => page.waitForFunction(async (want) => {
  const peers = Object.values(await window.snug.voiceStats());
  return peers.length === want && peers.every((p) => p.state === 'connected' && p.bytes > 1000);
}, n, { timeout: 25000, polling: 300 });
async function joinVoiceRoom(page, others) {
  await openWheelRoom(page);
  await page.click('.stage .btn.primary:has-text("Join voice")');
  await page.locator('.stage [aria-label="Leave voice"]').waitFor();
  if (others) await connected(page, others);
}
async function leave(page) {
  if (await page.locator('.stage [aria-label="Leave voice"]').count()) await page.click('.stage [aria-label="Leave voice"]');
  await page.waitForFunction(() => !window.snug.S.call);
}
async function openVoiceSettings(page) {
  await page.click('.me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Voice and video")');
  await page.locator('.layer-col h1:has-text("Voice and video")').waitFor();
}
const closeLayer = (page) => page.click('.layer-close');
const debug = (page) => page.evaluate(() => window.snug.voiceDebug());
// A tone, as a WAV file the soundboard can take: 1.2 seconds of 600 Hz.
function toneWav(path, seconds = 1.2, rate = 22050) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 600 * i) / rate) * 0.8 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

let robin, ines;

test('settings: microphone, speaker and camera lists, a working level meter, a camera preview, processing switches', async () => {
  robin = await person('robin');
  await openVoiceSettings(robin);
  // Device names show once the microphone is allowed (the context already allows it).
  const mic = robin.locator('select[aria-label="Microphone"]');
  await robin.waitForFunction(() => document.querySelector('select[aria-label="Microphone"]')?.options.length >= 2);
  const micOptions = await mic.locator('option').allTextContents();
  assert.equal(micOptions[0], 'System default');
  assert.ok(micOptions.some((t) => /fake/i.test(t)), `the fake microphone is listed: ${micOptions}`);
  const camOptions = await robin.locator('select[aria-label="Camera"] option').allTextContents();
  assert.ok(camOptions.length >= 2, `cameras listed: ${camOptions}`);
  // Choosing one is remembered on this device.
  const micId = await mic.locator('option').nth(1).getAttribute('value');
  await mic.selectOption(micId);
  assert.equal(await robin.evaluate(() => window.snug.S.prefs.voice.input), micId);

  // The microphone check: the meter moves with the fake microphone's sound.
  await robin.click('button:has-text("Check your microphone")');
  await robin.waitForFunction(() => Number(document.querySelector('.vo-meter')?.getAttribute('aria-valuenow')) > -90, null, { timeout: 10000 });
  await robin.check('.vo-check input');
  await robin.click('button:has-text("Stop checking")');

  // The camera preview plays.
  await robin.click('button:has-text("Check your camera")');
  await robin.waitForFunction(() => { const v = document.querySelector('.vo-cam-video'); return v && v.videoWidth > 0; });
  await robin.click('button:has-text("Stop preview")');
  await robin.locator('.vo-cam-empty').waitFor();

  // Processing switches are stored and become the capture constraints.
  await robin.click('button[role="switch"][aria-label="Noise suppression"]');
  assert.equal(await robin.getAttribute('button[role="switch"][aria-label="Noise suppression"]', 'aria-checked'), 'false');
  assert.equal(await robin.evaluate(() => window.snug.S.prefs.voice.noise), false);
  await robin.click('button[role="switch"][aria-label="Noise suppression"]');
  await mic.selectOption('');
  await closeLayer(robin);
});

test('push to talk: the key opens what is sent and closes it after the release delay; a new key can be bound; the hold button works', async () => {
  ines = await person('ines');
  await openVoiceSettings(robin);
  await robin.click('.seg button:has-text("Push to talk")');
  await robin.locator('button.vo-key:has-text("`")').waitFor();
  // Rebind to V.
  await robin.click('button.vo-key');
  await robin.locator('button.vo-key.listening').waitFor();
  await robin.keyboard.press('KeyV');
  await robin.locator('button.vo-key kbd:has-text("V")').waitFor();
  await robin.fill('input[aria-label="Release delay"]', '300').catch(async () => {
    await robin.$eval('input[aria-label="Release delay"]', (el) => { el.value = '300'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  });
  assert.equal(await robin.evaluate(() => window.snug.S.prefs.voice.pttDelay), 300);
  await closeLayer(robin);

  await joinVoiceRoom(robin);
  await joinVoiceRoom(ines, 1);
  await connected(robin, 1);
  let d = await debug(robin);
  assert.equal(d.graph, 'mixed', 'the microphone goes through the mixing graph');
  assert.equal(d.trackEnabled, false, 'nothing is sent while the key is up');
  assert.equal(d.gate, 0);

  await robin.locator('.composer textarea').first().click().catch(() => {});
  await robin.keyboard.down('KeyV');
  await robin.waitForFunction(() => window.snug.voiceDebug().trackEnabled === true);
  d = await debug(robin);
  assert.equal(d.ptt, true);
  await robin.keyboard.up('KeyV');
  // Still open just after letting go (the 300 ms delay), then closed.
  assert.equal((await debug(robin)).trackEnabled, true, 'the release delay keeps it open for a moment');
  await robin.waitForFunction(() => window.snug.voiceDebug().trackEnabled === false, null, { timeout: 3000 });
  // The old key does nothing now.
  await robin.keyboard.down('Backquote');
  await robin.waitForTimeout(200);
  assert.equal((await debug(robin)).trackEnabled, false);
  await robin.keyboard.up('Backquote');

  // The on-screen hold button.
  const hold = robin.locator('.stage .vo-hold');
  await hold.waitFor();
  const box = await hold.boundingBox();
  await robin.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await robin.mouse.down();
  await robin.waitForFunction(() => window.snug.voiceDebug().trackEnabled === true);
  await robin.locator('.stage .vo-hold[aria-pressed="true"]:has-text("Talking")').waitFor();
  await robin.mouse.up();
  await robin.waitForFunction(() => window.snug.voiceDebug().trackEnabled === false, null, { timeout: 3000 });

  // Muted beats the key.
  await robin.click('.stage [aria-label="Mute"]');
  await robin.keyboard.down('KeyV');
  await robin.waitForTimeout(200);
  assert.equal((await debug(robin)).trackEnabled, false, 'muted sends nothing even with the key down');
  await robin.keyboard.up('KeyV');
  await robin.click('.stage [aria-label="Unmute"]');

  // Back to voice activity: what is sent follows the voice, and the options menu switches modes too.
  await robin.click('.stage .vo-opts');
  await robin.click('.menu-item:has-text("Voice activity")');
  await robin.waitForFunction(() => window.snug.voiceDebug().mode === 'vad');
});

test('each person’s volume: 50% and 150% on the element that plays them, a mute only I hear, remembered', async () => {
  // Robin and Ines are still in the Wheel room together.
  const vol = robin.locator('.stage-person:has-text("Ines") .vo-vol');
  await vol.click();
  const slider = robin.locator('.pop input[aria-label="Ines Duarte’s volume"], .pop input.vo-range').first();
  await slider.waitFor();
  const setTo = (n) => robin.$eval('.pop input.vo-range', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, n);
  const inesId = await ines.evaluate(() => window.snug.S.me);
  const stat = () => robin.evaluate(async (id) => (await window.snug.voiceStats())[id], inesId);

  await setTo(50);
  await robin.waitForFunction(async (id) => (await window.snug.voiceStats())[id]?.volume === 0.5, inesId);
  let s = await stat();
  assert.equal(s.muted, false);
  assert.equal(s.boost, 0);

  await setTo(150);
  await robin.waitForFunction(async (id) => (await window.snug.voiceStats())[id]?.boost === 1.5, inesId);
  s = await stat();
  assert.equal(s.volume, 1, 'the element plays at full volume...');
  assert.equal(s.muted, true, '...silenced, while WebAudio plays it louder');

  await robin.click('.pop button:has-text("Mute Ines for me")');
  await robin.waitForFunction(async (id) => { const x = (await window.snug.voiceStats())[id]; return x.muted && x.boost === 0; }, inesId);
  // Ines doesn't know: her own state is unchanged.
  assert.equal(await ines.evaluate(() => window.snug.S.call.muted), false);
  await robin.click('.pop button:has-text("Unmute Ines")');
  await setTo(80);
  await robin.waitForFunction(async (id) => { const x = (await window.snug.voiceStats())[id]; return x.volume === 0.8 && !x.muted; }, inesId);
  await robin.keyboard.press('Escape');
  // Remembered on this device for Ines.
  const saved = await robin.evaluate(() => new Promise((r) => setTimeout(() => r(JSON.parse(localStorage.getItem('snug.prefs')).voice), 600)));
  assert.equal(saved.volumes[inesId], 0.8);
  assert.equal(saved.muted[inesId], undefined);
  await robin.locator(`.stage-person:has-text("Ines") .vo-vol.on`).waitFor();
});

test('soundboard: a sound added in House settings plays into the voice room and really arrives at the other person', async () => {
  // Add a sound through House settings > Voice.
  const wav = join(dir, 'tada.wav');
  toneWav(wav);
  await openKiln(robin);
  await robin.click('.nav button.ctx-house');
  await robin.click('.menu-item:has-text("House settings")');
  await robin.click('.layer-nav .row:has-text("Voice") >> nth=0');
  await robin.locator('.layer-col h1:has-text("Voice")').waitFor();
  await robin.setInputFiles('input.vo-file', wav);
  await robin.locator('.vo-drop-text:has-text("Ready to add")').waitFor();
  await robin.fill('.vo-add-form input[maxlength="40"]', 'Tada');
  await robin.fill('.vo-add-form input[aria-label="Emoji, optional"]', '🎉');
  await robin.click('.vo-add-form button:has-text("Add sound")');
  await robin.locator('.vo-snd-row [aria-label="Listen to Tada"]').waitFor();
  await ines.waitForFunction(() => Object.values(window.snug.S.sounds || {}).flat().some((s) => s.name === 'Tada'));
  await closeLayer(robin);

  // Robin keeps his microphone shut (push to talk, key up), so only the sound can be heard.
  await openWheelRoom(robin);
  await robin.click('.stage .vo-opts');
  await robin.click('.menu-item:has-text("Push to talk")');
  await robin.waitForFunction(() => window.snug.voiceDebug().trackEnabled === false);
  const robinId = await robin.evaluate(() => window.snug.S.me);
  const energy = () => ines.evaluate(async (id) => (await window.snug.voiceStats())[id]?.energy || 0, robinId);
  await ines.waitForTimeout(800);
  const e0 = await energy();
  await ines.waitForTimeout(800);
  const quiet = (await energy()) - e0;
  assert.ok(quiet < 0.01, `nothing heard from Robin while his key is up (energy grew by ${quiet})`);

  await robin.click('.stage .vo-board-btn');
  await robin.locator('.vo-snd:has-text("Tada")').click();
  // Ines sees who played what, and hears it.
  await ines.locator('.stage-person:has-text("Robin") .vo-played:has-text("Tada")').waitFor();
  await ines.waitForFunction(async ({ id, base }) => ((await window.snug.voiceStats())[id]?.energy || 0) - base > 0.05, { id: robinId, base: e0 + quiet }, { timeout: 8000, polling: 200 });
  // The cooldown: the board's sounds wait a moment before the next one.
  await robin.locator('.vo-board .vo-note:has-text("One sound every few seconds")').waitFor();
  assert.equal(await robin.locator('.vo-snd:has-text("Tada")').isDisabled(), true);
  await robin.keyboard.press('Escape');
  await robin.click('.stage .vo-opts');
  await robin.click('.menu-item:has-text("Voice activity")');
});

test('the floating call follows you to other places; a voice room’s user limit keeps others out', async () => {
  // Robin looks at another room: the call floats with him.
  await robin.click('.nav .row:has-text("Front desk")').catch(() => robin.click('.nav .row >> nth=0'));
  const mini = robin.locator('.vo-mini');
  await mini.waitFor();
  assert.match(await mini.getAttribute('aria-label'), /Wheel room/);
  // Dragging by keyboard moves it and is remembered.
  const before = await mini.boundingBox();
  await robin.focus('.vo-mini-grip');
  await robin.keyboard.press('ArrowLeft');
  await robin.keyboard.press('ArrowUp');
  const after = await mini.boundingBox();
  assert.ok(after.x < before.x && after.y < before.y, 'the call window moved');
  assert.ok(await robin.evaluate(() => !!window.snug.S.prefs.voice.mini));
  await robin.click('.vo-mini [aria-label="Mute"]');
  assert.equal(await robin.evaluate(() => window.snug.S.call.muted), true);
  await robin.click('.vo-mini [aria-label="Unmute"]');
  await robin.click('.vo-mini button:has-text("Back to voice")');
  await robin.locator('.main .stage.in').waitFor();
  assert.equal(await robin.locator('.vo-mini').count(), 0, 'not shown over the call itself');

  // A limit of 2: Tomasz (no voice moderation) can't join while Robin and Ines are in.
  await robin.click('.nav button.ctx-house');
  await robin.click('.menu-item:has-text("House settings")');
  await robin.click('.layer-nav .row:has-text("Voice") >> nth=0');
  await robin.selectOption('select[aria-label="User limit for Wheel room"]', '2');
  await robin.waitForFunction(() => Object.values(window.snug.S.rooms).find((r) => r.name === 'Wheel room')?.limit === 2);
  await robin.selectOption('select[aria-label="Bitrate for Wheel room"]', '96');
  await robin.waitForFunction(() => Object.values(window.snug.S.rooms).find((r) => r.name === 'Wheel room')?.bitrate === 96);
  await closeLayer(robin);
  const tomasz = await person('tomasz');
  await openWheelRoom(tomasz);
  await tomasz.locator('.stage .vo-limit.full:has-text("Full")').waitFor();
  await tomasz.click('.stage .btn.primary:has-text("Join voice")');
  await tomasz.locator('.toast:has-text("Wheel room is full. It holds up to 2 people.")').waitFor();
  await tomasz.waitForFunction(() => !window.snug.S.call);
  assert.equal(await robin.evaluate(() => window.snug.S.voice[Object.values(window.snug.S.rooms).find((r) => r.name === 'Wheel room').id].length), 2);
  // Once Ines leaves there is room.
  await leave(ines);
  await joinVoiceRoom(tomasz, 1);
  await leave(tomasz);
  await leave(robin);
  await tomasz.context().close();
  await ines.context().close();
  await robin.context().close();
});
