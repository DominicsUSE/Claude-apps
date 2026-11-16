// Camera and screen sharing in voice rooms, end to end: separate people in
// separate browser sessions, real WebRTC between them, fake camera and screen
// from Chromium. Checks that pictures really arrive and play, that they stop,
// that someone joining late sees what is already on, and that refusals are
// explained.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-video-'));
let srv, browser, url;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  url = `http://127.0.0.1:${srv.port}`;
  // Fake camera, microphone and screen, and no permission prompts, so media
  // can be tested end to end without hardware. With the fake UI flag,
  // getDisplayMedia hands back a fake "screen" plus a fake sound track.
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
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
async function openWheelRoom(page) {
  if (!(await page.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').count())) {
    await page.click('.rail-house:has-text("Kiln & Co.")');
    await page.locator('.nav .ctx-house:has-text("Kiln & Co.")').waitFor();
  }
  await page.click('.nav .row:has-text("Wheel room")');
  await page.locator('.stage').waitFor();
}
// Connected to `n` others, with audio flowing from each.
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
// A video in this tile is really playing: it has a picture and time moves on.
async function playing(page, tile) {
  const sel = `.stage .vt[data-tile="${tile}"] video`;
  await page.waitForFunction((s) => {
    const v = document.querySelector(s);
    return v && v.videoWidth > 0 && v.readyState >= 2;
  }, sel, { timeout: 25000, polling: 200 });
  const t1 = await page.$eval(sel, (v) => v.currentTime);
  await page.waitForFunction(({ s, t }) => document.querySelector(s)?.currentTime > t + 0.3, { s: sel, t: t1 }, { timeout: 10000, polling: 200 }).catch(async (e) => {
    const info = await page.$eval(sel, (v) => ({ t: v.currentTime, w: v.videoWidth, rs: v.readyState, paused: v.paused, frames: v.getVideoPlaybackQuality?.().totalVideoFrames, tracks: v.srcObject?.getTracks().map((k) => `${k.kind}:${k.readyState}:${k.muted}`) }));
    throw new Error(`${tile} is not playing (from ${t1}): ${JSON.stringify(info)}; ${e.message}`);
  });
  return page.$eval(sel, (v) => ({ w: v.videoWidth, h: v.videoHeight }));
}

let robin, ines, tomasz;

test('camera: two people in a voice room; one turns the camera on, the other sees it play; off brings the face back', async () => {
  robin = await person('robin');
  ines = await person('ines');
  await joinVoiceRoom(robin);
  await joinVoiceRoom(ines, 1);
  await connected(robin, 1);

  // Before: faces, and the camera control is off and named for what it does.
  const camBtn = robin.locator('.stage .vc.cam');
  assert.equal(await camBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(await camBtn.getAttribute('aria-label'), 'Turn camera on');
  assert.equal(await ines.locator('.stage .vt').count(), 0);

  await camBtn.click();
  await robin.locator('.stage .vc.cam[aria-pressed="true"][aria-label="Turn camera off"]').waitFor();
  // My own preview plays, mirrored; Ines keeps her circle in a slot beside it.
  await playing(robin, 'robin:camera');
  assert.equal(await robin.locator('.vt[data-tile="robin:camera"] video.mirror').count(), 1);
  await robin.locator('.vt[data-tile="ines:face"] .avatar').waitFor();

  // Ines really receives Robin's camera over the connection.
  const size = await playing(ines, 'robin:camera');
  assert.ok(size.w > 0 && Math.abs(size.w / size.h - 16 / 9) < 0.05, `a 16:9 picture arrives, got ${size.w}x${size.h}`);
  // The camera itself is captured between 640x360 and 1280x720 (what is sent
  // starts smaller and grows as the connection measures its bandwidth).
  const sent = await robin.$eval('.vt[data-tile="robin:camera"] video', (v) => v.srcObject.getVideoTracks()[0].getSettings());
  assert.ok(sent.width >= 640 && sent.width <= 1280 && sent.height >= 360 && sent.height <= 720, `captured ${sent.width}x${sent.height}`);
  assert.equal(await ines.locator('.vt[data-tile="robin:camera"] video.mirror').count(), 0, 'only your own preview is mirrored');
  await ines.locator('.vt[data-tile="robin:camera"] .vt-label:has-text("Robin")').waitFor();
  // The server passed the flag on, validated.
  await ines.waitForFunction(() => window.snug.S.voiceState.k_wheel?.robin?.camera === true);

  // Mute shows on the video tile's label.
  await robin.click('.stage [aria-label="Mute"]');
  await ines.locator('.vt[data-tile="robin:camera"] .vt-muted[aria-label="Muted"]').waitFor();
  await robin.click('.stage [aria-label="Unmute"]');
  await ines.locator('.vt[data-tile="robin:camera"] .vt-muted').waitFor({ state: 'detached' });

  // Off: the tile goes and Robin is a face again for Ines.
  await robin.click('.stage .vc.cam');
  await ines.locator('.stage .vt').first().waitFor({ state: 'detached' });
  await ines.locator('.stage-person:has-text("Robin") .avatar').waitFor();
  await robin.locator('.stage-person:has-text("You") .avatar').waitFor();
  assert.equal(await robin.locator('.stage .vc.cam').getAttribute('aria-pressed'), 'false');
  assert.equal(await robin.evaluate(() => document.querySelectorAll('video').length), 0);
});

test('camera: on and off again reuses the connection and still arrives', async () => {
  const transceivers = async () => Object.values(await robin.evaluate(() => window.snug.voiceStats()))[0].tx;
  await robin.click('.stage .vc.cam');
  await playing(ines, 'robin:camera');
  const first = await transceivers();
  for (let i = 0; i < 3; i++) {
    await robin.click('.stage .vc.cam');
    await ines.locator('.stage .vt').first().waitFor({ state: 'detached' });
    await robin.click('.stage .vc.cam');
    await playing(ines, 'robin:camera');
  }
  assert.equal(await transceivers(), first, 'turning the camera off and on adds no media sections');
  // Both have cameras on: both see both.
  await ines.click('.stage .vc.cam');
  await playing(robin, 'ines:camera');
  await playing(ines, 'robin:camera');
  await playing(ines, 'ines:camera');
});

test('both change at the same moment: crossing offers settle and both pictures arrive', async () => {
  // Each click renegotiates; clicking on both sides at once makes the offers cross.
  for (let i = 0; i < 3; i++) {
    await Promise.all([robin.click('.stage .vc.cam'), ines.click('.stage .vc.cam')]);
    await Promise.all([robin.locator('.stage .vt').first().waitFor({ state: 'detached' }), ines.locator('.stage .vt').first().waitFor({ state: 'detached' })]);
    await Promise.all([robin.click('.stage .vc.cam'), ines.click('.stage .vc.cam')]);
    await playing(robin, 'ines:camera');
    await playing(ines, 'robin:camera');
  }
  await connected(robin, 1);
  await connected(ines, 1);
  const glare = (await robin.evaluate(() => window.snug.voiceStats())).ines.glare + (await ines.evaluate(() => window.snug.voiceStats())).robin.glare;
  console.log(`offers crossed ${glare} times`); // timing decides how often; 10 in a typical run
});

test('late joiner: a third person joining sees the cameras already on', async () => {
  tomasz = await person('tomasz');
  await openWheelRoom(tomasz);
  // From outside the call, the stage marks who has a camera on.
  await tomasz.locator('.stage-person:has-text("Robin") .stage-media[aria-label="Camera on"]').waitFor();
  await joinVoiceRoom(tomasz, 2);
  await playing(tomasz, 'robin:camera');
  await playing(tomasz, 'ines:camera');
  await tomasz.locator('.vt[data-tile="tomasz:face"]').waitFor();
  // And the two already there still hear and see each other.
  await connected(robin, 2);
  await connected(ines, 2);
  await ines.click('.stage .vc.cam');
  await tomasz.locator('.vt[data-tile="ines:face"]').waitFor();
  await robin.locator('.vt[data-tile="ines:face"]').waitFor();
});

test('screen share: the large tile for everyone, others as a strip; click to focus; stopping returns the grid', async () => {
  const shareBtn = ines.locator('.stage .vc.scr');
  assert.equal(await shareBtn.getAttribute('aria-label'), 'Share your screen');
  await shareBtn.click();
  await ines.locator('.stage .vc.scr[aria-pressed="true"][aria-label="Stop sharing your screen"]').waitFor();
  for (const page of [robin, tomasz]) {
    await playing(page, 'ines:screen');
    // The screen share takes the large tile; the rest sit in the strip.
    await page.locator('.vt-main .vt[data-tile="ines:screen"]').waitFor();
    await page.locator('.vt-strip .vt[data-tile="robin:camera"]').waitFor();
    await page.locator('.vt[data-tile="ines:screen"] .vt-full[aria-label="Show full screen"]').waitFor();
  }
  // Screens are shown whole, never cropped.
  assert.equal(await robin.locator('.vt[data-tile="ines:screen"] video.contain').count(), 1);
  // Clicking a tile in the strip makes it the large one; clicking it again shows everyone.
  await tomasz.click('.vt-strip .vt[data-tile="robin:camera"] .vt-hit');
  await tomasz.locator('.vt-main .vt[data-tile="robin:camera"]').waitFor();
  await tomasz.locator('.vt-strip .vt[data-tile="ines:screen"]').waitFor();
  await playing(tomasz, 'robin:camera');
  await tomasz.click('.vt-main .vt[data-tile="robin:camera"] .vt-hit');
  await tomasz.locator('.vt-grid .vt[data-tile="ines:screen"]').waitFor();
  // Keyboard: the tile is a button.
  await tomasz.focus('.vt[data-tile="ines:screen"] .vt-hit');
  await tomasz.keyboard.press('Enter');
  await tomasz.locator('.vt-main .vt[data-tile="ines:screen"]').waitFor();

  // The browser's own "Stop sharing" ends the screen track; Snug follows.
  // (Headless Chromium has no sharing bar to click, so the end is signalled on the track.)
  await ines.evaluate(() => {
    const v = document.querySelector('.vt[data-tile="ines:screen"] video');
    v.srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  });
  await ines.locator('.stage .vc.scr[aria-pressed="false"]').waitFor();
  for (const page of [robin, tomasz]) {
    await page.locator('.vt[data-tile="ines:screen"]').waitFor({ state: 'detached' });
    await page.locator('.vt-grid .vt[data-tile="robin:camera"]').waitFor();
  }
  await robin.waitForFunction(() => !window.snug.S.voiceState.k_wheel?.ines?.screen);
});

test('screen share from a late joiner reaches people already in the room, and the newest joiner too', async () => {
  await tomasz.click('.stage .vc.scr');
  await playing(robin, 'tomasz:screen');
  await playing(ines, 'tomasz:screen');
  // The screen's sound (Chromium's fake one here) arrives too, played apart from the picture.
  await robin.waitForFunction(async () => (await window.snug.voiceStats()).tomasz?.screenSound === true);
  const priya = await person('priya');
  await joinVoiceRoom(priya, 3);
  await playing(priya, 'tomasz:screen');
  await playing(priya, 'robin:camera');
  await tomasz.click('.stage .vc.scr');
  await priya.locator('.vt[data-tile="tomasz:screen"]').waitFor({ state: 'detached' });
  await priya.click('.stage [aria-label="Leave voice"]');
  await robin.waitForFunction(async () => Object.keys(await window.snug.voiceStats()).length === 2);
  await priya.context().close();
});

test('phone: tiles in one column, the controls stay in reach at the bottom of the stage', async () => {
  const phone = await person('malik', { viewport: { width: 390, height: 844 } });
  await phone.click('.home-house:has-text("Kiln & Co.")');
  await phone.click('.screen.push .row:has-text("Wheel room")');
  await phone.click('.screen.push .stage .btn.primary:has-text("Join voice")');
  await phone.locator('.screen.push .stage [aria-label="Leave voice"]').waitFor();
  await playing(phone, 'robin:camera');
  const boxes = await phone.$$eval('.stage .vt-grid .vt', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }));
  assert.ok(boxes.length >= 3);
  assert.ok(boxes.every((b) => b.x === boxes[0].x && b.w === boxes[0].w), `one column: ${JSON.stringify(boxes)}`);
  // Scrolled to the top of a tall stage, the controls are still on screen.
  const acts = await phone.$eval('.stage .stage-acts', (el) => { el.closest('.stage').scrollTop = 0; const r = el.getBoundingClientRect(); return { bottom: r.bottom, top: r.top }; });
  assert.ok(acts.top >= 0 && acts.bottom <= 844, `controls in view: ${JSON.stringify(acts)}`);
  for (const sel of ['[aria-label="Mute"]', '.vc.cam', '.vc.scr', '[aria-label="Leave voice"]']) {
    const b = await phone.locator(`.stage .stage-acts ${sel}`).boundingBox();
    assert.ok(b.height >= 44 && b.width >= 44, `${sel} is a 44px target`);
  }
  await phone.click('.stage [aria-label="Leave voice"]');
  await phone.context().close();
});

test('camera refused or missing: a plain reason, and the camera stays off', async () => {
  await ines.evaluate(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__realGUM = real;
    navigator.mediaDevices.getUserMedia = (c) => (c?.video ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : real(c));
  });
  await ines.click('.stage .vc.cam');
  await ines.locator('.toast:has-text("Snug needs your camera")').waitFor();
  assert.equal(await ines.locator('.stage .vc.cam').getAttribute('aria-pressed'), 'false');
  await ines.evaluate(() => {
    navigator.mediaDevices.getUserMedia = (c) => (c?.video ? Promise.reject(new DOMException('none', 'NotFoundError')) : window.__realGUM(c));
  });
  await ines.click('.stage .vc.cam');
  await ines.locator('.toast:has-text("No camera found")').waitFor();
  assert.equal(await robin.evaluate(() => window.snug.S.voiceState.k_wheel?.ines?.camera), false);
  await ines.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__realGUM; });
  // Closing the screen picker is a choice, not an error: no message.
  await ines.evaluate(() => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
  const toasts = await ines.locator('.toast').count();
  await ines.click('.stage .vc.scr');
  await ines.waitForTimeout(300);
  assert.equal(await ines.locator('.toast:has-text("screen")').count(), 0);
  assert.ok((await ines.locator('.toast').count()) <= toasts);
});

test('leaving stops the camera for everyone and frees the device', async () => {
  // Robin's camera is still on; going to another room keeps the call, and the dock can turn it off.
  await robin.click('.nav .row:has-text("Glaze lab")');
  await robin.locator('.dock .vc.cam[aria-pressed="true"]').waitFor();
  await robin.click('.dock .vc.cam');
  await ines.locator('.vt[data-tile="robin:camera"]').waitFor({ state: 'detached' });
  assert.equal(await robin.locator('.dock .vc.cam').count(), 0, 'the dock only shows the camera while it is on');
  await openWheelRoom(robin);
  await robin.click('.stage .vc.cam');
  await playing(ines, 'robin:camera');
  await robin.click('.stage [aria-label="Leave voice"]');
  await ines.locator('.vt[data-tile="robin:camera"]').waitFor({ state: 'detached' });
  assert.equal(await robin.evaluate(() => document.querySelectorAll('video').length), 0);
  await ines.click('.stage [aria-label="Leave voice"]');
  await tomasz.click('.stage [aria-label="Leave voice"]');
});
