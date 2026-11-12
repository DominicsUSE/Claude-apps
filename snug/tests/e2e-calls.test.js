// Calls in direct conversations and groups, end to end: separate people in
// separate browser contexts, real WebRTC between them, Chromium's fake
// microphone and camera. Checks ringing and the incoming-call screen, that
// audio really plays and the camera really arrives, the records hanging up
// writes, declining, a missed call, a group call someone joins late from the
// strip, and one person on two devices.
//
// Calls ring for 5 seconds here instead of 30: SNUG_RING_MS, which the server
// honours only under the test runner.
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
const RING_MS = 5000;
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-calls-'));
let srv, browser, url;
const errors = [];
const contexts = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  process.env.SNUG_RING_MS = String(RING_MS);
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  delete process.env.SNUG_RING_MS;
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
  const seen = errors.splice(0);
  assert.deepEqual(seen, [], 'page errors');
});

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
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
// Open a direct conversation or group from Messages in the rail.
async function openDm(page, title) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
}
// Connected to `n` others, with audio arriving from each and its element playing.
async function connected(page, n) {
  await page.waitForFunction(async (want) => {
    const peers = Object.values(await window.snug.voiceStats());
    return peers.length === want && peers.every((p) => p.state === 'connected' && p.bytes > 1000);
  }, n, { timeout: 25000, polling: 300 });
}
// The remote voice is really playing: each peer's audio element's clock moves on.
async function hearing(page) {
  const t0 = Object.values(await page.evaluate(() => window.snug.voiceStats())).map((p) => p.audioTime);
  assert.ok(t0.every((t) => typeof t === 'number'), `an audio element per peer: ${JSON.stringify(t0)}`);
  await page.waitForFunction(async (before) => {
    const now = Object.values(await window.snug.voiceStats());
    return now.length === before.length && now.every((p, i) => p.audioTime > before[i] + 0.5 && p.audioPaused === false);
  }, t0, { timeout: 10000, polling: 250 });
}
// A video tile that is really playing: it has a picture and time moves on.
async function playing(page, tile) {
  const sel = `.stage .vt[data-tile="${tile}"] video`;
  await page.waitForFunction((s) => { const v = document.querySelector(s); return v && v.videoWidth > 0 && v.readyState >= 2; }, sel, { timeout: 25000, polling: 200 });
  const t1 = await page.$eval(sel, (v) => v.currentTime);
  await page.waitForFunction(({ s, t }) => document.querySelector(s)?.currentTime > t + 0.3, { s: sel, t: t1 }, { timeout: 10000, polling: 200 });
}
const ringtone = (page) => page.evaluate(() => window.snug.ringtone());

test('a call between two people: ringing, the incoming screen, picking up with Enter, audio and camera, hanging up writes the record', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  // Ines looks somewhere else, so the call has to find her.
  await ines.click('.rail-btn:has(.sr:text-matches("^Home"))');

  const phone = robin.locator('.main .bar .call-btn[aria-label="Start a voice call"]');
  assert.equal(await phone.getAttribute('data-tip'), 'Start a voice call');
  await robin.locator('.main .bar .call-btn[aria-label="Start a video call"]').waitFor();
  await phone.click();
  // Robin's side: calling, then ringing Ines.
  await robin.locator('.stage.call .stage-conn.ring:has-text("Ringing Ines")').waitFor();
  await robin.locator('.stage.call .stage-person.ringing:has-text("Ines")').waitFor();
  await robin.locator('.dock.call:has-text("Ines Carvalho")').waitFor();

  // Ines's side: the incoming-call screen, announced, ringing, with the focus on Accept.
  const card = ines.locator('.incoming[role="alertdialog"]');
  await card.waitFor();
  assert.equal(await card.locator('.inc-name').textContent(), 'Robin Hale');
  assert.match(await card.locator('.inc-kind').textContent(), /Voice call/);
  await card.locator('.inc-face .avatar').waitFor();
  assert.match(await ines.locator('[aria-live="assertive"]').textContent(), /Robin Hale is calling\. Voice call\./);
  await ines.waitForFunction(() => document.activeElement?.classList.contains('inc-accept'));
  assert.equal(await ringtone(ines), true, 'the ringtone plays');
  assert.equal(await ringtone(robin), false);
  // Her Recent list marks the conversation as having a call in it.
  await ines.locator('.nav .row:has-text("Robin Hale") .call-mark[aria-label="Call in progress"]').waitFor();

  // Enter accepts. The conversation opens on the call.
  await ines.keyboard.press('Enter');
  await card.waitFor({ state: 'detached' });
  assert.equal(await ringtone(ines), false, 'the ringtone stops on accepting');
  await ines.locator('.main .bar-title:has-text("Robin Hale")').waitFor();
  await ines.locator('.stage.call [aria-label="Leave call"]').waitFor();
  await connected(robin, 1);
  await connected(ines, 1);
  await hearing(robin);
  await hearing(ines);
  await robin.locator('.stage.call .stage-conn.ok:has-text("Connected")').waitFor();
  // Both see the call marked in their list of conversations.
  await robin.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await robin.locator('.nav .row:has-text("Ines Carvalho") .call-mark').waitFor();
  await robin.click('.nav .row:has-text("Ines Carvalho")');

  // The camera in the call: Ines turns hers on, Robin sees it play.
  await ines.click('.stage.call .vc.cam');
  await playing(robin, 'ines:camera');
  await playing(ines, 'ines:camera');
  await robin.waitForFunction(() => window.snug.S.voiceState.d_ines?.ines?.camera === true);

  // Hanging up ends it for both, and the conversation says how long it lasted.
  await new Promise((r) => setTimeout(r, 1200));
  await robin.click('.stage.call [aria-label="Leave call"]');
  await ines.locator('.stage.call').waitFor({ state: 'detached' });
  for (const p of [robin, ines]) {
    const line = p.locator('.callline').last();
    await line.waitFor();
    assert.match(await line.locator('b').textContent(), /^Call · \d+s$/);
    assert.match(await line.textContent(), p === robin ? /You started it/ : /Robin started it/);
    assert.equal(await line.evaluate((el) => el.classList.contains('missed')), false);
  }
  // Ines answered, so it isn't news to her: no count on the conversation.
  await ines.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  assert.equal(await ines.locator('.nav .row:has-text("Robin Hale") .badge').count(), 0);
  assert.equal(await ines.locator('.nav .row:has-text("Robin Hale") .call-mark').count(), 0);
  // A call record has no message actions.
  assert.equal(await robin.locator('.callline .msg-actions').count(), 0);
});

test('declining with Esc: the caller sees "Declined", the ringtone stops, a declined record', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await ines.locator('.incoming').waitFor();
  assert.equal(await ringtone(ines), true);
  await ines.keyboard.press('Escape');
  await ines.locator('.incoming').waitFor({ state: 'detached' });
  assert.equal(await ringtone(ines), false, 'the ringtone stops on declining');
  const note = robin.locator('.call-strip.ended.declined[role="status"]');
  await note.waitFor();
  assert.match(await note.textContent(), /Declined.*Ines declined the call/);
  await robin.locator('.stage.call').waitFor({ state: 'detached' });
  assert.equal(await robin.locator('.dock').count(), 0, 'nothing left in the dock');
  await robin.locator('.callline:has-text("Call declined")').waitFor();
  await openDm(ines, 'Robin Hale');
  await ines.locator('.callline:has-text("Declined call")').waitFor();
  // The note offers to call again, and can be dismissed.
  await note.locator('button:has-text("Call again")').waitFor();
  await note.locator('[aria-label="Dismiss"]').click();
  await note.waitFor({ state: 'detached' });
});

test('nobody answers: after the ring times out the caller sees "No answer", the callee a missed call that needs them', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  // Ines is on Home, away from the conversation.
  await ines.click('.rail-btn:has(.sr:text-matches("^Home"))');
  const t0 = Date.now();
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await ines.locator('.incoming').waitFor();
  // While it rings, her Recent list marks the conversation as in a call.
  await ines.locator('.nav .row:has-text("Robin Hale") .call-mark').waitFor();
  await ines.locator('.incoming').waitFor({ state: 'detached', timeout: RING_MS + 5000 });
  assert.ok(Date.now() - t0 >= RING_MS - 500, 'it rang for the whole time');
  assert.equal(await ringtone(ines), false);
  await robin.locator('.call-strip.ended.no-answer:has-text("No answer")').waitFor();
  await robin.locator('.callline:has-text("no answer")').last().waitFor();
  assert.equal(await robin.locator('.nav .row:has-text("Ines Carvalho") .call-mark').count(), 0, 'no longer live');
  // For Ines it is for her: a count on Messages and in the title, and a coral line.
  const badge = ines.locator('.rail-btn:has(.sr:text-matches("^Messages")) .rail-badge');
  await badge.waitFor();
  assert.equal(await badge.textContent(), '1');
  assert.match(await ines.title(), /^\(1\) Snug$/);
  assert.match(await ines.locator('.rail-btn:has(.sr:text-matches("^Messages")) .sr').textContent(), /1 thing needs you/);
  await ines.click('.nav .row:has-text("Robin Hale")');
  const missed = ines.locator('.callline.missed').last();
  await missed.waitFor();
  assert.match(await missed.textContent(), /Missed call.*from Robin/);
  await missed.locator('button:has-text("Call back")').waitFor();
  // Reading it clears the count.
  await badge.waitFor({ state: 'detached' });
});

test('a group call: two pick up, the third lets it ring out and joins late from the strip; everyone is connected', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  const malik = await person('malik');
  await openDm(robin, 'Saturday load');
  await openDm(malik, 'Saturday load');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  const ic = ines.locator('.incoming');
  await ic.waitFor();
  assert.match(await ic.locator('.inc-kind').textContent(), /Voice call in Saturday load/);
  await malik.locator('.incoming').waitFor();
  await ic.locator('.inc-accept').click();
  await connected(robin, 1);
  await connected(ines, 1);
  // Malik's keeps ringing until it times out; the call goes on.
  await malik.locator('.incoming').waitFor({ state: 'detached', timeout: RING_MS + 5000 });
  const strip = malik.locator('.call-strip.live[aria-label="Call in progress"]');
  await strip.waitFor();
  assert.match(await strip.textContent(), /Call in progress/);
  await strip.locator('button:has-text("Join")').click();
  await malik.locator('.stage.call [aria-label="Leave call"]').waitFor();
  await connected(malik, 2);
  await connected(robin, 2);
  await connected(ines, 2);
  await hearing(malik);
  await robin.locator('.stage.call .stage-count:has-text("3 in the call")').waitFor();
  // Robin leaves; the other two carry on.
  await robin.click('.stage.call [aria-label="Leave call"]');
  await connected(ines, 1);
  await robin.locator('.call-strip.live').waitFor();
  await ines.click('.stage.call [aria-label="Leave call"]');
  await malik.click('.stage.call [aria-label="Leave call"]');
  for (const p of [robin, ines, malik]) await p.locator('.callline:has-text("Call ·")').last().waitFor();
});

test('one person on two devices: both ring, picking up on one stops the other', async () => {
  const robin = await person('robin');
  const ines1 = await person('ines');
  const ines2 = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  await robin.click('.main .bar .call-btn[aria-label="Start a video call"]');
  await ines1.locator('.incoming').waitFor();
  await ines2.locator('.incoming').waitFor();
  assert.match(await ines2.locator('.inc-kind').textContent(), /Video call/);
  assert.equal(await ringtone(ines2), true);
  await ines1.locator('.incoming .inc-video').click();
  await ines2.locator('.incoming').waitFor({ state: 'detached' });
  assert.equal(await ringtone(ines2), false, 'the other device stops ringing');
  await ines2.locator('.toast:has-text("You answered on another device")').waitFor();
  await connected(robin, 1);
  await connected(ines1, 1);
  // Robin started a video call, so his camera is on, and Ines picked up with hers.
  await playing(ines1, 'robin:camera');
  await playing(robin, 'ines:camera');
  // The other device sees the call going on, and could take it over.
  await openDm(ines2, 'Robin Hale');
  await ines2.locator('.call-strip.live').waitFor();
  await robin.click('.stage.call [aria-label="Leave call"]');
  await ines2.locator('.call-strip.live').waitFor({ state: 'detached' });
});

test('on a phone: the incoming call is a bottom sheet with large controls; offline, the call buttons say why', async () => {
  const robin = await person('robin');
  const ines = await person('ines', { viewport: { width: 390, height: 844 } });
  await openDm(robin, 'Ines Carvalho');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  const card = ines.locator('.incoming');
  await card.waitFor();
  await card.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = await card.boundingBox();
  assert.ok(Math.abs(box.x) < 1 && Math.abs(box.width - 390) < 1 && Math.abs(box.y + box.height - 844) < 2, `a sheet at the bottom: ${JSON.stringify(box)}`);
  const accept = await card.locator('.inc-accept').boundingBox();
  assert.ok(accept.height >= 44, 'a 44px target');
  await card.locator('.inc-decline').click();
  await card.waitFor({ state: 'detached' });
  await robin.locator('.call-strip.ended.declined').waitFor();
  // Offline (the transport's state, as when the connection drops): the
  // buttons stay, disabled, and say why.
  await robin.evaluate(() => { window.snug.S.conn.socket = 'closed'; window.snug.emit(); });
  const btns = robin.locator('.main .bar .call-btn[aria-disabled="true"]');
  await btns.first().waitFor();
  assert.equal(await btns.count(), 2);
  assert.match(await btns.first().getAttribute('data-tip'), /offline/);
  await btns.first().click({ force: true });
  assert.equal(await robin.locator('.stage.call').count(), 0, 'a disabled button starts nothing');
  await robin.evaluate(() => { window.snug.S.conn.socket = 'open'; window.snug.emit(); });
});

test('a ring while typing: the focus stays in the composer, Enter sends the message and Esc belongs to the composer', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  await openDm(ines, 'Saturday load');
  const box = ines.locator('.main .composer textarea');
  await box.click();
  await box.fill('half typed');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  const card = ines.locator('.incoming');
  await card.waitFor();
  assert.equal(await ringtone(ines), true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await ines.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'the ring did not take the focus');
  // Esc goes to the composer, not to the call.
  await ines.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await card.count(), 1, 'Esc in the composer does not decline');
  // Space and Enter type and send; they don't pick up.
  await box.focus();
  await ines.keyboard.type(' and done');
  await ines.keyboard.press('Enter');
  await ines.locator('.main .msg:has-text("half typed and done")').waitFor();
  assert.equal(await card.count(), 1, 'Enter in the composer does not accept');
  assert.equal(await ines.evaluate(() => window.snug.S.call), null);
  await robin.locator('.stage.call .stage-conn.ring:has-text("Ringing Ines")').waitFor();
  await card.locator('.inc-decline').click();
  await robin.locator('.call-strip.ended.declined').waitFor();
});

test('no microphone: accepting fails, the call still rings here, and can be declined', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  await ines.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  });
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  const card = ines.locator('.incoming');
  await card.waitFor();
  await card.locator('.inc-accept').click();
  await ines.locator('.toast').first().waitFor();
  // The incoming screen comes back: the server was never told she picked up.
  await card.waitFor();
  assert.equal(await ines.evaluate(() => window.snug.S.call), null);
  assert.equal(await ines.locator('.toast:has-text("ended")').count(), 0, 'no "call ended" toast');
  await robin.locator('.stage.call .stage-conn.ring:has-text("Ringing Ines")').waitFor();
  await card.locator('.inc-decline').click();
  await robin.locator('.call-strip.ended.declined').waitFor();
});

test('a group call I declined is a quiet line, not a coral missed call', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  const malik = await person('malik');
  await openDm(robin, 'Saturday load');
  await openDm(ines, 'Saturday load');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await ines.locator('.incoming .inc-decline').click();
  await malik.locator('.incoming .inc-accept').click();
  await connected(robin, 1);
  await robin.click('.stage.call [aria-label="Leave call"]');
  await malik.click('.stage.call [aria-label="Leave call"]');
  const line = ines.locator('.callline').last();
  await ines.locator('.callline:has-text("Declined call")').waitFor();
  assert.equal(await line.evaluate((el) => el.classList.contains('missed')), false);
  assert.match(await line.textContent(), /Declined call.*from Robin/);
  assert.equal(await line.locator('button:has-text("Call back")').count(), 0);
});

test('in a call, calling someone else asks first; cancelling keeps the call', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await ines.locator('.incoming .inc-accept').click();
  await connected(robin, 1);
  await openDm(robin, 'Saturday load');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  const modal = robin.locator('.modal:has-text("End your call with Ines Carvalho?")');
  await modal.waitFor();
  await modal.locator('button:has-text("Cancel")').click();
  await modal.waitFor({ state: 'detached' });
  assert.equal(await robin.evaluate(() => window.snug.S.call?.room), 'd_ines', 'still in the call');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await modal.locator('button:has-text("End call and continue")').click();
  await ines.locator('.stage.call').waitFor({ state: 'detached' });
  await robin.locator('.stage.call .stage-conn.ring').waitFor();
  await robin.click('.stage.call [aria-label="Leave call"]');
});
