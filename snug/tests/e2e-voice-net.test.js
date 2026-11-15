// Voice and calls on a real network path (v12 voice track): listening without
// a microphone and adding one later, keeping media through a signalling drop,
// ICE restarts, data saver and adaptive quality, hiding your IP behind a
// relay, the phone call screen, push to talk's release and global key, and
// who is in a voice room for a newcomer. Separate people in separate browser
// contexts and real WebRTC; one browser has fake media devices, the other none.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-voicenet-'));
const relayDir = mkdtempSync(join(tmpdir(), 'snug-e2e-voicenet-relay-'));
let srv, browser, bare, url;
let relaySrv = null, relayUrl = null;
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
function seeded(d) {
  const db = openDb(join(d, 'snug.db'));
  seedDatabase(db, join(d, 'files'), { password: PASSWORD });
  db.close();
}

test.before(async () => {
  seeded(dir);
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, ringMs: 8000 });
  url = `http://127.0.0.1:${srv.port}`;
  const wav = join(dir, 'tone.wav');
  toneWav(wav);
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--use-file-for-fake-audio-capture=${wav}`],
  });
  // No fake devices at all: a computer with no microphone or camera.
  bare = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => {
  await browser?.close(); await bare?.close(); await srv.close(); await relaySrv?.close();
  rmSync(dir, { recursive: true, force: true }); rmSync(relayDir, { recursive: true, force: true });
});
test.beforeEach(() => { srv.resetLimits(); relaySrv?.resetLimits(); });
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

const contexts = [];
async function person(handle, { viewport = { width: 1280, height: 860 }, on = browser, at = url, phone = false, permissions = ['microphone', 'camera'], init = null } = {}) {
  const ctx = await on.newContext({ viewport, permissions, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  contexts.push(ctx);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(at);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.locator('.auth-form').waitFor({ state: 'detached' });
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
async function joinWheel(page, { listen = false } = {}) {
  await openWheelRoom(page);
  await page.click(listen ? '.stage .btn.stage-listen' : '.stage .btn.primary:has-text("Join voice")');
  await page.locator('.stage [aria-label="Leave voice"]').waitFor();
}
const stats = (page) => page.evaluate(() => window.snug.voiceStats());
const statsOf = async (page, user) => (await stats(page))[user];
const connected = (page, n) => page.waitForFunction(async (want) => {
  const peers = Object.values(await window.snug.voiceStats());
  return peers.length === want && peers.every((p) => p.state === 'connected' && p.bytes > 1000);
}, n, { timeout: 25000, polling: 300 });
// Audio from one person keeps arriving: more bytes than before, by a margin.
const moreBytes = (page, user, before, by = 2000, timeout = 15000) => page.waitForFunction(async ([u, b, d]) => ((await window.snug.voiceStats())[u]?.bytes || 0) > b + d, [user, before, by], { timeout, polling: 200 });
async function openVoiceSettings(page) {
  await page.click('.me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Voice and video")');
  await page.locator('.layer-col h1:has-text("Voice and video")').waitFor();
}
async function openDm(page, title) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
}

// ---------- 1. Listen only ----------
test('listen only: with no microphone at all, joining voice listens; audio arrives and the others see "Listening"', async () => {
  const ines = await person('ines');
  const robin = await person('robin', { on: bare });
  await joinWheel(ines);
  await openWheelRoom(robin);
  await robin.click('.stage .btn.primary:has-text("Join voice")');
  await robin.locator('.stage [aria-label="Leave voice"]').waitFor();
  await robin.locator('.toast:has-text("so you joined voice to listen")').waitFor();
  assert.equal(await robin.evaluate(() => window.snug.S.call.listen), true);
  // Ines's voice really arrives at Robin, who has nothing to send.
  await connected(robin, 1);
  const mine = await statsOf(robin, 'ines');
  assert.equal(mine.sending, false, 'nothing is sent from a computer without a microphone');
  // Ines sees Robin listening, in the stage and the sidebar.
  await ines.locator('.stage-person:has-text("Robin") .stage-media.listen:has-text("Listening")').waitFor();
  await ines.locator('.vroom-person[aria-label*="listening without a microphone"]').waitFor();
  assert.equal(srv.hub.voiceStateOf('robin').listen, true);
  // The microphone button offers to talk; with no microphone it says so and keeps listening.
  const talk = robin.locator('.stage [aria-label="Turn on your microphone"]');
  await talk.click();
  await robin.locator('.toast:has-text("You’re still listening")').waitFor();
  assert.equal(await robin.evaluate(() => window.snug.S.call.listen), true);
  // The connection popup doesn't promise a send rate for a listener.
  await robin.click('.stage .act-conn');
  await robin.locator('.act-qpop:has-text("listening without a microphone")').waitFor();
});

test('listen only by choice, then a microphone mid-call: no capture until asked; unmuting adds it and Ines hears it', async () => {
  const robin = await person('robin', { init: () => {
    window.__gum = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { if (c?.audio) window.__gum++; return real(c); };
  } });
  const ines = await person('ines');
  await joinWheel(robin, { listen: true });
  assert.equal(await robin.evaluate(() => window.__gum), 0, 'Listen only never asks for the microphone');
  assert.equal(await robin.locator('.toast:has-text("to listen")').count(), 0, 'chosen: no explanation needed');
  await joinWheel(ines);
  await connected(robin, 1);
  await ines.locator('.stage-person:has-text("Robin") .stage-media.listen').waitFor();
  const quiet = (await statsOf(ines, 'robin')).bytes;
  // Robin adds the microphone: the same connection, now carrying Robin's voice.
  const pcBefore = (await statsOf(ines, 'robin')).pc;
  await robin.click('.stage [aria-label="Turn on your microphone"]');
  await robin.waitForFunction(() => window.snug.S.call.listen === false && window.snug.S.call.muted === false);
  await moreBytes(ines, 'robin', quiet, 4000);
  assert.equal((await statsOf(ines, 'robin')).pc, pcBefore, 'renegotiated, not rebuilt');
  await ines.locator('.stage-person:has-text("Robin") .stage-media.listen').waitFor({ state: 'detached' });
  assert.equal(srv.hub.voiceStateOf('robin').listen, undefined);
  assert.equal(await robin.locator('.stage [aria-label="Mute"]').count(), 1);
});

test('listen only: a refused microphone joins to listen and says why; a call too', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await robin.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); });
  await joinWheel(robin);
  await robin.locator('.toast:has-text("Snug may not use your microphone, so you joined voice to listen")').waitFor();
  await robin.click('.stage [aria-label="Leave voice"]');
  // A call picked up without a microphone: in the call, listening.
  await openDm(ines, 'Robin Hale');
  await ines.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  const card = robin.locator('.incoming');
  await card.waitFor();
  await card.locator('.inc-accept').click();
  await robin.locator('.toast:has-text("so you joined the call to listen")').waitFor();
  await connected(robin, 1);
  await ines.locator('.stage-person:has-text("Robin") .stage-media.listen').waitFor();
});

test('alone in voice: the connection popup says there is nothing to measure, and no half-empty send rate', async () => {
  const robin = await person('robin');
  await joinWheel(robin);
  await robin.click('.stage .act-conn');
  const pop = robin.locator('.act-qpop');
  await pop.locator('.act-note:has-text("Nobody else is here yet")').waitFor();
  assert.doesNotMatch(await pop.textContent(), /sending/);
});

// ---------- 2. Reconnection ----------
test('reconnect: a 3-second signalling drop keeps the connection and its audio; the call comes back on the same connection', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  await connected(ines, 1);
  const pcIn = (await statsOf(ines, 'robin')).pc;
  const pcRo = (await statsOf(robin, 'ines')).pc;
  await robin.evaluate(() => window.snug.voiceTest.dropSocket(3000));
  await robin.waitForFunction(() => window.snug.S.call?.status === 'reconnecting', null, { polling: 30 });
  await robin.locator('.stage .act-reconn:has-text("Reconnecting")').waitFor();
  await ines.locator('.stage-person:has-text("Robin") .stage-note:has-text("Reconnecting")').waitFor();
  // While Robin's socket is down, audio keeps flowing both ways on the same connections.
  const a = (await statsOf(ines, 'robin')).bytes;
  const b = (await statsOf(robin, 'ines')).bytes;
  await moreBytes(ines, 'robin', a, 2000, 2500);
  await moreBytes(robin, 'ines', b, 2000, 2500);
  assert.equal(await robin.evaluate(() => window.snug.S.call?.status), 'reconnecting', 'measured during the drop');
  // Back by itself, same connections, still flowing.
  await robin.waitForFunction(() => window.snug.S.call?.status === 'live' && window.snug.S.conn.socket === 'open', null, { timeout: 15000 });
  await ines.locator('.stage-person:has-text("Robin") .stage-note:has-text("Reconnecting")').waitFor({ state: 'detached' });
  assert.equal((await statsOf(ines, 'robin')).pc, pcIn, 'Ines kept the connection');
  assert.equal((await statsOf(robin, 'ines')).pc, pcRo, 'Robin kept the connection');
  const c = (await statsOf(ines, 'robin')).bytes;
  await moreBytes(ines, 'robin', c);
  // Signalling works again: a camera turned on now reaches Ines.
  await robin.click('.stage .vc.cam');
  await ines.waitForFunction(() => !!document.querySelector('.stage .vt-camera video')?.srcObject, null, { timeout: 15000 });
});

test('ICE restart: "failed" restarts at once, "disconnected" after a grace with Reconnecting shown, from either side; audio keeps coming', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  const before = await statsOf(robin, 'ines');
  await robin.evaluate(() => window.snug.voiceTest.line('ines', 'failed'));
  await robin.waitForFunction(async (u) => { const s = (await window.snug.voiceStats()).ines; return s.ufrag && s.ufrag !== u && s.state === 'connected' && s.signaling === 'stable'; }, before.ufrag, { timeout: 15000 });
  const after = await statsOf(robin, 'ines');
  assert.equal(after.pc, before.pc, 'the same connection, new ICE credentials');
  assert.equal(after.restarts, 1);
  await moreBytes(robin, 'ines', after.bytes);
  // Ines (the other side) on a disconnect: nothing for the grace, Reconnecting shown, then a restart.
  await ines.evaluate(() => window.snug.voiceTest.iceGrace(1500));
  const inBefore = await statsOf(ines, 'robin');
  await ines.evaluate(() => window.snug.voiceTest.line('robin', 'disconnected'));
  await ines.locator('.stage-person:has-text("Robin") .stage-note:has-text("Reconnecting")').waitFor();
  await ines.waitForTimeout(600);
  assert.equal((await statsOf(ines, 'robin')).restarts, inBefore.restarts, 'not before the grace');
  await ines.waitForFunction(async (n) => (await window.snug.voiceStats()).robin.restarts === n + 1, inBefore.restarts, { timeout: 5000 });
  await ines.locator('.stage-person:has-text("Robin") .stage-note').waitFor({ state: 'detached', timeout: 15000 });
  await ines.waitForFunction(async () => { const s = (await window.snug.voiceStats()).robin; return s.state === 'connected' && s.signaling === 'stable'; });
  await moreBytes(ines, 'robin', (await statsOf(ines, 'robin')).bytes);
});

// ---------- 3. Data saver and adaptive quality ----------
test('data saver: voice at 24 kbit/s, the camera stays off on a video call, others’ cameras paused until shown', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openVoiceSettings(robin);
  await robin.click('button[role="switch"][aria-label="Data saver"]');
  assert.equal(await robin.evaluate(() => window.snug.S.prefs.voice.lowData), true);
  await robin.keyboard.press('Escape');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).ines?.voiceMax === 24000);
  // Ines's voice to Robin follows the room (Ines has no data saver).
  await ines.waitForFunction(async () => (await window.snug.voiceStats()).robin?.voiceMax === 64000);
  // Ines turns her camera on: her sender to Robin is switched off, and Robin's tile says so.
  await ines.click('.stage .vc.cam');
  await ines.waitForFunction(async () => (await window.snug.voiceStats()).robin?.caps?.camera?.active === false, null, { timeout: 15000 });
  await robin.locator('.stage .vt-paused:has-text("Camera paused to save data")').waitFor();
  assert.equal(await robin.locator('.stage .vt-camera video').count(), 0);
  // Show video: Ines's sender turns on and the picture plays for Robin.
  await robin.click('.stage .vt-paused button:has-text("Show video")');
  await ines.waitForFunction(async () => (await window.snug.voiceStats()).robin?.caps?.camera?.active === true, null, { timeout: 15000 });
  await robin.waitForFunction(() => { const v = document.querySelector('.stage .vt-camera video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
  // Robin's own camera: a quarter of the pixels, 15 fps, 250 kbit/s.
  await robin.click('.stage .vc.cam');
  await robin.waitForFunction(async () => { const c = (await window.snug.voiceStats()).ines?.caps?.camera; return c && c.maxBitrate === 250000 && c.scaleResolutionDownBy === 2 && c.maxFramerate === 15; }, null, { timeout: 15000 });
  // Turned off mid-call from the call's menu: Robin's voice back to the room's bitrate.
  await robin.click('.stage [aria-label="Voice options"]');
  await robin.click('.menu [role="menuitemcheckbox"]:has-text("Data saver"), .menu .menu-item:has-text("Data saver")');
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).ines?.voiceMax === 64000);
});

test('data saver on a video call: the camera stays off when the call starts', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, lowData: true }; });
  await openDm(robin, 'Ines Carvalho');
  await robin.click('.main .bar .call-btn[aria-label="Start a video call"]');
  await robin.locator('.toast:has-text("Data saver is on, so your camera stays off")').waitFor();
  assert.equal(await robin.evaluate(() => window.snug.S.call.camera), false);
  await ines.locator('.incoming .inc-decline').click();
});

test('adaptive quality: reported loss steps the caps down on that line, steady polls step them back up', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  await robin.click('.stage .vc.cam');
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).ines?.caps?.camera?.maxBitrate === 900000, null, { timeout: 15000 });
  assert.equal((await statsOf(robin, 'ines')).voiceMax, 64000);
  // Two polls with 12% loss: one step down.
  await robin.evaluate(() => { for (let i = 0; i < 2; i++) window.snug.voiceTest.quality('ines', { loss: 12, rtt: 60 }); });
  await robin.waitForFunction(async () => { const s = (await window.snug.voiceStats()).ines; return s.level === 1 && s.voiceMax === 32000 && s.caps.camera.maxBitrate === 450000; });
  // Two more with a slow round trip: step 2, fewer pixels.
  await robin.evaluate(() => { for (let i = 0; i < 2; i++) window.snug.voiceTest.quality('ines', { loss: 0, rtt: 700 }); });
  await robin.waitForFunction(async () => { const s = (await window.snug.voiceStats()).ines; return s.level === 2 && s.voiceMax === 24000 && s.caps.camera.scaleResolutionDownBy === 2; });
  // Ten good polls: back to full.
  await robin.evaluate(() => { for (let i = 0; i < 10; i++) window.snug.voiceTest.quality('ines', { loss: 0, rtt: 40 }); });
  await robin.waitForFunction(async () => { const s = (await window.snug.voiceStats()).ines; return s.level === 0 && s.voiceMax === 64000 && s.caps.camera.maxBitrate === 900000 && (s.caps.camera.scaleResolutionDownBy ?? 1) === 1; });
});

// ---------- 4. Hiding your IP behind a relay ----------
async function relayServer() {
  if (relaySrv) return relayUrl;
  seeded(relayDir);
  // A relay that answers nobody (a documentation-only address): relay-only connections can't connect, which proves they never went direct.
  relaySrv = await startServer({
    port: 0, dataDir: relayDir, quiet: true, ringMs: 8000,
    iceEnv: { SNUG_STUN: 'none', SNUG_TURN_URL: 'turn:192.0.2.1:3478', SNUG_TURN_USER: 'snug', SNUG_TURN_PASS: 'relay-pass' },
  });
  relayUrl = `http://127.0.0.1:${relaySrv.port}`;
  return relayUrl;
}

test('relay: with a relay, voice rooms go relay-only by default (never direct), calls with a friend go direct; Always and Off; the setting explains who sees what', async () => {
  const at = await relayServer();
  const robin = await person('robin', { at });
  const ines = await person('ines', { at });
  await openVoiceSettings(robin);
  const row = robin.locator('.set-row:has-text("Hide my IP address from people in calls (uses a relay)")');
  await row.waitFor();
  assert.match(await row.textContent(), /relay’s operator/);
  assert.match(await row.textContent(), /little delay/);
  assert.equal(await row.locator('.seg button[aria-pressed="true"], .seg button[aria-checked="true"]').first().textContent(), 'Rooms and non-friends');
  await robin.keyboard.press('Escape');
  // A voice room: relay-only, so with a dead relay it stays unconnected and says how it's trying.
  await joinWheel(robin);
  await joinWheel(ines);
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).ines?.policy === 'relay');
  await robin.locator('.stage-person:has-text("Ines") .stage-note:has-text("through the relay")').waitFor();
  await robin.waitForTimeout(1500);
  assert.notEqual((await statsOf(robin, 'ines')).state, 'connected', 'never direct');
  await robin.click('.stage [aria-label="Leave voice"]');
  await ines.click('.stage [aria-label="Leave voice"]');
  // Off: direct, and it connects (both on this machine).
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, relay: 'off' }; });
  await ines.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, relay: 'off' }; });
  await joinWheel(robin);
  await joinWheel(ines);
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).ines?.policy === 'all');
  await connected(robin, 1);
  await robin.locator('.stage .act-conn .act-routeword:has-text("Direct")').waitFor({ timeout: 10000 });
  await robin.click('.stage .act-conn');
  await robin.locator('.act-qpop .act-route:has-text("they can see your IP address")').waitFor();
  await robin.locator('.act-qpop .act-route:has-text("not the end-to-end encryption of private messages")').waitFor();
  await robin.keyboard.press('Escape');
  await robin.click('.stage [aria-label="Leave voice"]');
  await ines.click('.stage [aria-label="Leave voice"]');
  // The default with a friend in a call: direct.
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, relay: 'others' }; });
  await ines.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, relay: 'others' }; });
  await openDm(robin, 'Ines Carvalho');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await ines.locator('.incoming .inc-accept').click();
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).ines?.policy === 'all');
  // Always: relay-only with a friend too.
  await robin.click('.stage [aria-label="Leave call"]');
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, relay: 'all' }; });
  await joinWheel(robin);
  await joinWheel(ines);
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).ines?.policy === 'relay');
});

test('relay: asked to hide my IP with no relay on the server, Snug doesn’t connect directly and says why', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openVoiceSettings(robin);
  await robin.locator('.set-row:has-text("This Snug server has no relay")').waitFor();
  await robin.keyboard.press('Escape');
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, relay: 'all' }; });
  await joinWheel(ines);
  await joinWheel(robin);
  await robin.locator('.toast:has-text("found no relay to hide your IP address")').waitFor();
  await robin.locator('.stage-person:has-text("Ines") .stage-note:has-text("no relay to hide your IP")').waitFor();
  const s = await statsOf(robin, 'ines');
  assert.equal(s.policy, 'relay');
  await robin.waitForTimeout(1500);
  assert.notEqual((await statsOf(robin, 'ines')).state, 'connected', 'no direct connection');
});

// ---------- 5. The phone call screen ----------
test('phone 390x844: labelled controls in reach, tiles, a screen share full screen, the sound toggle', async () => {
  const phone = await person('malik', { viewport: { width: 390, height: 844 }, phone: true });
  const robin = await person('robin');
  await joinWheel(robin);
  await phone.click('.home-house:has-text("Kiln & Co.")');
  await phone.click('.screen.push .row:has-text("Wheel room")');
  // Before joining: Join voice and Listen only, both full-size targets.
  // The room's screen slides in from the side: measure once it has arrived.
  await phone.waitForFunction(() => { const r = document.querySelector('.screen.push')?.getBoundingClientRect(); return r && Math.abs(r.x) < 1; });
  for (const sel of ['.btn.primary:has-text("Join voice")', '.btn.stage-listen']) {
    const b = await phone.locator(`.screen.push .stage ${sel}`).boundingBox();
    assert.ok(b.height >= 44 && b.x >= 0 && b.x + b.width <= 390, `${sel}: ${JSON.stringify(b)}`);
  }
  await phone.click('.screen.push .stage .btn.primary:has-text("Join voice")');
  await phone.locator('.screen.push .stage [aria-label="Leave voice"]').waitFor();
  await connected(phone, 1);
  // Every control shows its word and sits on screen as a touch target.
  for (const [sel, word] of [['[aria-label="Mute"]', 'Mute'], ['.vc.ear', 'Sound'], ['.vc.cam', 'Camera'], ['.vc.scr', 'Screen'], ['.vc-more', 'More'], ['[aria-label="Leave voice"]', 'Leave']]) {
    const btn = phone.locator(`.stage .stage-acts ${sel}`);
    const b = await btn.boundingBox();
    assert.ok(b.width >= 44 && b.height >= 44 && b.x >= 0 && b.x + b.width <= 390 && b.y + b.height <= 844, `${sel}: ${JSON.stringify(b)}`);
    if (word) assert.equal((await btn.locator('.vc-word').textContent()).trim(), word);
  }
  if (process.env.SNUG_SHOTS) await phone.screenshot({ path: join(process.env.SNUG_SHOTS, 'phone-call.png') });
  // The sound toggle (deafen) works from the phone.
  await phone.click('.stage .stage-acts .vc.ear');
  await phone.waitForFunction(() => window.snug.S.call.deaf === true);
  assert.equal((await phone.locator('.stage .stage-acts .vc.ear .vc-word').textContent()).trim(), 'Sound off');
  await phone.click('.stage .stage-acts .vc.ear');
  // Robin shares a screen: a large tile on the phone with a full-screen button that goes full screen.
  await robin.click('.stage .vc.scr');
  const tile = phone.locator('.stage .vt-screen');
  await tile.waitFor({ timeout: 15000 });
  await phone.waitForFunction(() => { const v = document.querySelector('.stage .vt-screen video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
  const tb = await tile.boundingBox();
  assert.ok(tb.width >= 300 && tb.x >= 0 && tb.x + tb.width <= 390, `screen tile: ${JSON.stringify(tb)}`);
  if (process.env.SNUG_SHOTS) await phone.screenshot({ path: join(process.env.SNUG_SHOTS, 'phone-screen-share.png') });
  await phone.click('.stage .vt-screen .vt-full');
  await phone.waitForFunction(() => document.fullscreenElement?.dataset?.tile?.endsWith(':screen'));
  await phone.evaluate(() => document.exitFullscreen());
  // No sideways scrolling anywhere on the call screen.
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

// ---------- 6. Push to talk ----------
test('push to talk: letting go of focus releases it; a key still held opens again on return; the desktop key bridges a 900 ms repeat delay', async () => {
  const robin = await person('robin', { init: () => {
    // The desktop app's bridge (desktop/preload.js): the global key's presses.
    window.snugApp = { setPushToTalk: async () => true, onPushToTalk: (fn) => { window.__ptt = fn; } };
  } });
  await robin.evaluate(() => { window.snug.S.prefs.voice = { ...window.snug.S.prefs.voice, mode: 'ptt', pttDelay: 0 }; });
  await joinWheel(robin);
  const held = () => robin.evaluate(() => window.snug.voiceDebug().ptt);
  await robin.locator('.stage').click({ position: { x: 5, y: 5 } });
  await robin.keyboard.down('Backquote');
  await robin.waitForFunction(() => window.snug.voiceDebug().ptt === true);
  // The window loses focus: no key-up will come, so it lets go now.
  await robin.evaluate(() => window.dispatchEvent(new Event('blur')));
  await robin.waitForFunction(() => window.snug.voiceDebug().ptt === false);
  // Back, with the key still down: the next repeat opens it again.
  await robin.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', repeat: true, bubbles: true })));
  await robin.waitForFunction(() => window.snug.voiceDebug().ptt === true);
  await robin.keyboard.up('Backquote');
  await robin.waitForFunction(() => window.snug.voiceDebug().ptt === false);
  // The global key: a press, a 900 ms wait for the system to start repeating, then repeats every 33 ms.
  await robin.evaluate(() => window.__ptt());
  for (let t = 0; t < 9; t++) { await robin.waitForTimeout(100); assert.equal(await held(), true, `open ${t * 100} ms after the press`); }
  await robin.evaluate(async () => { for (let i = 0; i < 15; i++) { window.__ptt(); await new Promise((r) => setTimeout(r, 33)); } });
  assert.equal(await held(), true, 'open while repeats come');
  // Repeats stop (the key is up): it closes soon, not a second later.
  const stopped = Date.now();
  await robin.waitForFunction(() => window.snug.voiceDebug().ptt === false, null, { timeout: 2000, polling: 20 });
  assert.ok(Date.now() - stopped < 700, `closed ${Date.now() - stopped} ms after the last repeat`);
});

// ---------- 6b. Devices mid-call ----------
test('mid-call: a speaker chosen in the call’s menu plays every voice there; echo cancellation and noise suppression switch live', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  const outs = await robin.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label })));
  assert.ok(outs.length >= 1, `fake speakers: ${JSON.stringify(outs)}`);
  await robin.click('.stage [aria-label="Voice options"]');
  await robin.click(`.menu [role="menuitemradio"]:has-text("${outs[0].label}")`);
  await robin.waitForFunction((id) => { const s = window.snug.voiceTest.sinks(); return s.length > 0 && s.every((x) => x === id); }, outs[0].id);
  await openVoiceSettings(robin);
  await robin.click('button[role="switch"][aria-label="Echo cancellation"]');
  await robin.waitForFunction(() => window.snug.voiceDebug().mic?.echo === false);
  await robin.click('button[role="switch"][aria-label="Noise suppression"]');
  await robin.waitForFunction(() => window.snug.voiceDebug().mic?.noise === false);
  await robin.keyboard.press('Escape');
  // Still heard, on the same sent track.
  await moreBytes(ines, 'robin', (await statsOf(ines, 'robin')).bytes);
  await openVoiceSettings(robin);
  await robin.click('button[role="switch"][aria-label="Echo cancellation"]');
  await robin.click('button[role="switch"][aria-label="Noise suppression"]');
  await robin.waitForFunction(() => window.snug.voiceDebug().mic?.noise === true && window.snug.voiceDebug().mic?.echo === true);
});

// ---------- 7. Who is in a voice room, for a newcomer ----------
test('a newcomer sees who is in a voice room they can see, live, and the stage shows the empty chat without a cut-off icon', async () => {
  const room = srv.db.get("SELECT id, house FROM rooms WHERE name = 'Wheel room'");
  const was = srv.db.get('SELECT starter FROM houses WHERE id = ?', room.house).starter;
  srv.db.run('UPDATE houses SET starter = ? WHERE id = ?', JSON.stringify([...JSON.parse(was || '[]'), room.id]), room.house);
  try {
    const robin = await person('robin');
    const { code } = await robin.evaluate(() => import('/js/server.js').then((s) => s.call('invite.create', { house: 'kiln' })));
    const res = await fetch(`${url}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ handle: 'newvoice', name: 'New Voice', password: 'a long password' }) });
    assert.equal(res.status, 201);
    const cookie = res.headers.get('set-cookie').split(';')[0].split('=');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    contexts.push(ctx);
    await ctx.addCookies([{ name: cookie[0], value: cookie.slice(1).join('='), url }]);
    const guest = await ctx.newPage();
    guest.on('pageerror', (e) => errors.push(`newvoice: ${e.message}`));
    await guest.goto(url);
    await guest.waitForFunction(() => window.snug?.S?.conn?.socket === 'open');
    await guest.evaluate((c) => import('/js/server.js').then((s) => s.call('invite.accept', { code: c })), code);
    await guest.waitForFunction(() => window.snug.S.houses.kiln?.newcomer === true);
    await guest.click('.rail-house:has-text("Kiln & Co.")');
    await guest.locator('.nav .row:has-text("Wheel room")').waitFor();
    // Robin joins: the newcomer sees Robin under the room, without reloading.
    await joinWheel(robin);
    await guest.locator('.nav .vroom-people[aria-label="In Wheel room"] .vroom-person:has-text("Robin")').waitFor();
    // In the room with an empty chat, the room's intro doesn't show a half-hidden icon.
    await robin.evaluate(() => { window.snug.S.msgs[window.snug.S.call.room] = []; window.snug.emit(); });
    await robin.waitForFunction(() => document.querySelector('.conv.voice-live.chat-empty'));
    assert.equal(await robin.locator('.conv.voice-live .start-mark').isVisible(), false);
  } finally {
    srv.db.run('UPDATE houses SET starter = ? WHERE id = ?', was, room.house);
  }
});
