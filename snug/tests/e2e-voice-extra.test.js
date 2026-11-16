// Voice and calls, end to end, beyond the basics: coming back after a dropped
// connection without clicking anything, switching devices from the call's
// menu, a microphone that stops, the "You're muted" note, real connection
// numbers, the call clock, a room that keeps cameras to some people, the
// ringtone settings reaching the ring, ringing someone again in a group call,
// and camera quality, mirror and microphone volume. Separate people in
// separate browser contexts, real WebRTC, Chromium's fake devices, and a
// steady tone as the microphone so "talking while muted" is reliable.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-voicex-'));
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
  await page.waitForSelector('.nav');
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

test('reconnect: a dropped connection comes back into the same voice room, still muted, with audio flowing again and no Join click', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  await robin.click('.stage [aria-label="Mute"]');
  await ines.waitForFunction(() => window.snug.S.voiceState[Object.keys(window.snug.S.voiceState).find((r) => window.snug.S.voice[r]?.includes('robin'))]?.robin?.muted === true);
  // The connection drops (not a clean close).
  await robin.evaluate(() => window.snug.voiceTest.dropSocket());
  await robin.waitForFunction(() => window.snug.S.call?.status === 'reconnecting', null, { polling: 30 });
  // Ines sees Robin reconnecting, still in the room.
  await ines.locator('.stage-person:has-text("Robin") .stage-note:has-text("Reconnecting")').waitFor();
  // Back by itself.
  await robin.waitForFunction(() => window.snug.S.call?.status === 'live' && window.snug.S.conn.socket === 'open', null, { timeout: 15000 });
  assert.equal(await robin.locator('.stage .btn.primary:has-text("Join voice")').count(), 0, 'no Join button: still in');
  assert.equal(await robin.evaluate(() => window.snug.S.call.muted), true, 'still muted');
  const before = Object.values(await ines.evaluate(() => window.snug.voiceStats()))[0]?.bytes || 0;
  await connected(robin, 1);
  await connected(ines, 1);
  await ines.waitForFunction(async (b) => (Object.values(await window.snug.voiceStats())[0]?.bytes || 0) > b + 2000, before, { timeout: 15000, polling: 300 });
  await ines.locator('.stage-person:has-text("Robin") .stage-note:has-text("Reconnecting")').waitFor({ state: 'detached' });
  const room = await robin.evaluate(() => window.snug.S.call.room);
  assert.equal(srv.hub.voiceStateOf('robin').muted, true, 'the server kept the mute');
  assert.equal(srv.hub.voicePlaceOf('robin'), room);
});

test('devices: the call’s menu switches microphone and camera; a microphone that stops falls back with a toast', async () => {
  const robin = await person('robin');
  await joinWheel(robin);
  const mics = await robin.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label })));
  assert.ok(mics.length >= 2, `fake microphones: ${JSON.stringify(mics)}`);
  const pick = mics[1];
  await robin.click('.stage [aria-label="Voice options"]');
  await robin.locator('.menu .menu-label:text-is("Microphone")').waitFor();
  await robin.locator('.menu .menu-label:text-is("Camera")').waitFor();
  await robin.click(`.menu [role="menuitemradio"]:has-text("${pick.label}")`);
  await robin.waitForFunction((id) => { const d = window.snug.voiceDebug(); return d.input === id && d.device === id; }, pick.id);
  // The menu shows it checked next time.
  await robin.click('.stage [aria-label="Voice options"]');
  assert.equal(await robin.locator(`.menu [role="menuitemradio"]:has-text("${pick.label}")`).getAttribute('aria-checked'), 'true');
  await robin.keyboard.press('Escape');
  // The chosen microphone disappears and its track ends: back to the default, said in a toast.
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, input: 'unplugged-device' }; });
  await robin.evaluate(() => window.snug.voiceTest.endMic());
  await robin.locator('.toasts:has-text("isn’t connected, so Snug is using the default one")').waitFor();
  await robin.waitForFunction(() => window.snug.voiceDebug().mic && window.snug.S.call?.status === 'live' && !window.snug.S.call.muted);
});

test('you’re muted: talking while muted shows the note with Unmute, at most once a minute, and it can be switched off', async () => {
  const robin = await person('robin');
  await joinWheel(robin);
  await robin.click('.stage [aria-label="Mute"]');
  const note = robin.locator('.stage .act-muted[role="status"]');
  await note.waitFor({ timeout: 10000 });
  assert.match(await note.textContent(), /You’re muted/);
  await note.locator('button:has-text("Unmute")').click();
  await robin.waitForFunction(() => window.snug.S.call.muted === false);
  await note.waitFor({ state: 'detached' });
  // Muted again straight away: not again within the minute.
  await robin.click('.stage [aria-label="Mute"]');
  await robin.waitForTimeout(2500);
  assert.equal(await note.count(), 0, 'once a minute at most');
  // Switched off in settings: never, even after the minute.
  await robin.evaluate(() => { window.snug.voiceTest.resetMutedWarn(); window.snug.S.prefs.mutedWarning = false; window.snug.emit(); });
  await robin.waitForTimeout(2500);
  assert.equal(await note.count(), 0, 'off means off');
  await robin.evaluate(() => { window.snug.S.prefs.mutedWarning = true; window.snug.emit(); });
});

test('quality and clock: real round trip and loss per person, the connection popover, and a call clock that ticks', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  await robin.waitForFunction(async () => {
    const p = Object.values(await window.snug.voiceStats())[0];
    return p && typeof p.rtt === 'number' && typeof p.loss === 'number' && typeof p.relay === 'boolean' && !!p.quality;
  }, null, { timeout: 15000, polling: 500 });
  const conn = robin.locator('.stage .act-conn');
  await conn.locator('.act-q').waitFor();
  assert.match(await conn.textContent(), /Voice connected/);
  await conn.click();
  const pop = robin.locator('.act-qpop');
  await pop.waitFor();
  await pop.locator('tbody tr:has-text("Ines")').waitFor();
  await robin.waitForFunction(() => /\d+ ms/.test(document.querySelector('.act-qpop tbody')?.textContent || ''));
  assert.match(await pop.textContent(), /Direct|Relayed/);
  await robin.waitForFunction(() => /\d+ kbit\/s/.test(document.querySelector('.act-qpop')?.textContent || ''), null, { timeout: 8000 });
  await robin.keyboard.press('Escape');
  // The clock: mm:ss, moving on.
  const clock = robin.locator('.stage .act-timer');
  const t1 = (await clock.textContent()).trim();
  assert.match(t1, /^\d\d:\d\d$/);
  assert.match(await clock.getAttribute('aria-label'), /In the call for/);
  await robin.waitForFunction((t) => document.querySelector('.stage .act-timer')?.textContent.trim() !== t, t1, { timeout: 4000 });
  // The dock shows it too, away from the room.
  await robin.click('.rail-btn:has(.sr:text-matches("^Home"))');
  await robin.locator('.dock .act-timer').waitFor();
});

test('a room without "Share camera and screen" for you: the buttons say why and do nothing', async () => {
  const room = srv.db.get("SELECT id, house FROM rooms WHERE name = 'Wheel room'");
  const owner = srv.db.get('SELECT m.user FROM members m JOIN roles r ON r.id = m.role WHERE m.house = ? AND r.pos = 0', room.house).user;
  const malik = await person('malik');
  await joinWheel(malik);
  srv.hub.ops['room.override']({ user: owner, ws: null }, { room: room.id, type: 'member', target: 'malik', allow: [], deny: ['video'] });
  const cam = malik.locator('.stage .vc.cam[aria-disabled="true"]');
  await cam.waitFor();
  assert.match(await cam.getAttribute('data-tip'), /can’t share your camera or screen/);
  assert.equal(await malik.locator('.stage .vc.scr[aria-disabled="true"]').count(), 1);
  await cam.click({ force: true });
  await malik.waitForTimeout(300);
  assert.equal(await malik.evaluate(() => window.snug.S.call.camera), false);
  srv.hub.ops['room.override']({ user: owner, ws: null }, { room: room.id, type: 'member', target: 'malik', allow: [], deny: [] });
  await malik.locator('.stage .vc.cam:not([aria-disabled="true"])').waitFor();
});

test('ringing settings: the ringtone and its volume reach the ring; who can ring me is saved on the server', async () => {
  const robin = await person('robin');
  await openVoiceSettings(robin);
  await robin.selectOption('.vo-ringtone', 'bells');
  await robin.locator('.vo-ring-volume').fill('50');
  await robin.waitForFunction(() => window.snug.voiceTest.lastRing()?.pattern === 'bells');
  await robin.click('.layer-col .seg[aria-label="Who can ring you"] button:has-text("Friends")');
  const saved = () => JSON.parse(srv.db.get("SELECT prefs FROM user_prefs WHERE user = 'robin'")?.prefs || '{}').whoCanRing || 'everyone';
  for (let i = 0; i < 50 && saved() !== 'friends'; i++) await robin.waitForTimeout(100);
  assert.equal(saved(), 'friends', 'saved on the server');
  await robin.click('.layer-col .seg[aria-label="Who can ring you"] button:has-text("Everyone")');
  for (let i = 0; i < 50 && saved() !== 'everyone'; i++) await robin.waitForTimeout(100);
  assert.equal(saved(), 'everyone');
  await closeLayer(robin);
  // A real ring plays the chosen pattern at the chosen volume.
  const ines = await person('ines');
  await openDm(ines, 'Robin Hale');
  await ines.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await robin.locator('.incoming').waitFor();
  await robin.waitForFunction(() => { const r = window.snug.voiceTest.lastRing(); return r && r.pattern === 'bells' && Date.now() - r.at < 4000; });
  const ring = await robin.evaluate(() => window.snug.voiceTest.lastRing());
  assert.ok(Math.abs(ring.peak - 0.11) < 1e-9, `half volume: ${ring.peak}`);
  await robin.click('.incoming .inc-decline');
});

test('ring again: in a group call, someone who declined gets a Ring button, is rung again and joins', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  const malik = await person('malik');
  await openDm(robin, 'Saturday load');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await ines.locator('.incoming').waitFor();
  await malik.locator('.incoming').waitFor();
  await ines.click('.incoming .inc-decline');
  await malik.click('.incoming .inc-accept');
  await connected(robin, 1);
  const ring = robin.locator('.stage .act-away button[aria-label="Ring Ines Carvalho again"]');
  await ring.waitFor();
  await ring.click();
  await ines.locator('.incoming').waitFor();
  await robin.locator('.stage .stage-person.ringing:has-text("Ines"), .stage .act-away').first().waitFor();
  await ines.click('.incoming .inc-accept');
  await connected(robin, 2);
  await connected(ines, 2);
  await ring.waitFor({ state: 'detached' });
});

test('camera quality, mirror and microphone volume reach the camera, the tile and the graph', async () => {
  const robin = await person('robin');
  await openVoiceSettings(robin);
  await robin.click('.layer-col .seg[aria-label="Camera resolution"] button:has-text("360p")');
  await robin.locator('.layer-col input[aria-label="Microphone volume"]').fill('150');
  await closeLayer(robin);
  await joinWheel(robin);
  await robin.waitForFunction(() => Math.abs((window.snug.voiceDebug().inputGain ?? 0) - 1.5) < 0.01);
  await robin.click('.stage .vc.cam');
  const video = robin.locator('.stage .vt-camera video');
  await video.waitFor();
  await robin.waitForFunction(() => document.querySelector('.stage .vt-camera video')?.srcObject?.getVideoTracks()[0]?.getSettings().height === 360);
  assert.match(await video.getAttribute('class'), /mirror/);
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, mirror: false }; window.snug.emit(); });
  await robin.waitForFunction(() => !document.querySelector('.stage .vt-camera video')?.classList.contains('mirror'));
});
