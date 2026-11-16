// Calls on phones and desktops, and calls that grow (v13 voice track): the
// screen kept on while in a call (Screen Wake Lock), the system's call
// controls (Media Session: lock screen, headset, the OS media keys), the
// security code people compare out loud, and send limits re-applied when a
// voice room grows past 3 other people. Separate people in separate browser
// contexts with fake media and real WebRTC; the wake lock and the media
// session are stood in for, since headless Chromium has no screen to keep on
// and no system controls.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-voicemesh-'));
let srv, browser, url;
const errors = [];
// Playwright's waitForFunction doesn't wait for a promise, so an async check
// would pass at once: this one polls it until it is true. Each check is
// awaited to its answer, one at a time: on a busy machine a page can take tens
// of seconds to answer (its WebRTC calls wait on a starved thread), and a slow
// true still counts. Only a check still unanswered 30 s past the limit fails.
async function waitAsync(page, fn, arg, { timeout = 15000, polling = 250 } = {}) {
  const end = Date.now() + timeout;
  const fail = (why) => new Error(`waitAsync: ${why} after ${timeout} ms: ${String(fn).slice(0, 160)}`);
  for (;;) {
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(fail('a check did not answer')), Math.max(0, end - Date.now()) + 30000); });
    const ok = await Promise.race([page.evaluate(fn, arg), late]).finally(() => clearTimeout(timer));
    if (ok) return ok;
    if (Date.now() > end) throw fail('timed out');
    await new Promise((r) => setTimeout(r, typeof polling === 'number' ? polling : 100));
  }
}

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, ringMs: 8000 });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

const contexts = [];
test.afterEach(async () => { for (const c of contexts.splice(0)) await c.close(); });
async function person(handle, { init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone', 'camera'] });
  contexts.push(ctx);
  // calls C3: this machine's server has no relay; the one-time "connects directly" sheet is tested on its own.
  await ctx.addInitScript(() => { try { localStorage.setItem('snug.directOk', '1'); } catch { /* none */ } });
  if (init) await ctx.addInitScript(init);
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
  await page.locator('.auth-form').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open' && !!window.snug.voiceTest);
  return page;
}
async function joinWheel(page) {
  if (!(await page.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').count())) {
    await page.click('.rail-house:has-text("Kiln & Co.")');
    await page.locator('.nav .ctx-house:has-text("Kiln & Co.")').waitFor();
  }
  await page.click('.nav .row:has-text("Wheel room")');
  await page.locator('.stage').waitFor();
  await page.click('.stage .btn.primary:has-text("Join voice")');
  await page.locator('.stage [aria-label="Leave voice"]').waitFor();
}
const connected = (page, n) => waitAsync(page, async (want) => {
  const peers = Object.values(await window.snug.voiceStats());
  return peers.length === want && peers.every((p) => p.state === 'connected' && p.bytes > 1000);
}, n, { timeout: 30000, polling: 300 });
async function openDm(page, title) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
}

// Stand-ins for the Screen Wake Lock and the Media Session, recording what Snug asks of them.
function stubs() {
  window.__wake = { asked: [], released: 0, last: null };
  const sentinel = (type) => {
    const s = new EventTarget();
    s.type = type;
    s.released = false;
    s.release = async () => {
      if (s.released) return;
      s.released = true;
      window.__wake.released++;
      s.dispatchEvent(new Event('release'));
    };
    return s;
  };
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: { request: async (type) => { window.__wake.asked.push(type); window.__wake.last = sentinel(type); return window.__wake.last; } },
  });
  const handlers = {};
  window.__ms = { handlers, mic: null, cam: null };
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null, playbackState: 'none',
      setActionHandler: (action, fn) => { if (fn) handlers[action] = fn; else delete handlers[action]; },
      setMicrophoneActive: (on) => { window.__ms.mic = on; },
      setCameraActive: (on) => { window.__ms.cam = on; },
    },
  });
}

// ---------- 1. The screen stays on ----------
test('wake lock: joining voice keeps the screen on, asks again when the page is back in front, and lets go on leaving', async () => {
  const robin = await person('robin', { init: stubs });
  assert.deepEqual(await robin.evaluate(() => window.__wake.asked), [], 'not before a call');
  await joinWheel(robin);
  await robin.waitForFunction(() => window.__wake.asked.length === 1);
  assert.deepEqual(await robin.evaluate(() => window.__wake.asked), ['screen']);
  // The system lets go of it when the page is hidden; back in front, Snug asks again.
  await robin.evaluate(() => window.__wake.last.release());
  await robin.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await robin.waitForFunction(() => window.__wake.asked.length === 2);
  // Still holding one: being shown again doesn't ask twice.
  await robin.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await robin.waitForTimeout(200);
  assert.equal(await robin.evaluate(() => window.__wake.asked.length), 2);
  await robin.click('.stage [aria-label="Leave voice"]');
  await robin.waitForFunction(() => window.__wake.last.released === true);
  await robin.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await robin.waitForTimeout(200);
  assert.equal(await robin.evaluate(() => window.__wake.asked.length), 2, 'out of the call, nothing is asked');
});

// ---------- 2. The system's call controls ----------
test('media session: a call sets the title and the mute, camera and hang-up controls; they work, follow the state, and go when the call ends', async () => {
  const robin = await person('robin', { init: stubs });
  const ines = await person('ines');
  await openDm(robin, 'Ines Carvalho');
  await robin.click('.main .bar .call-btn[aria-label="Start a voice call"]');
  await ines.locator('.incoming .inc-accept').click();
  await connected(robin, 1);
  await robin.waitForFunction(() => ['togglemicrophone', 'togglecamera', 'hangup'].every((a) => typeof window.__ms.handlers[a] === 'function'));
  assert.match(await robin.evaluate(() => navigator.mediaSession.metadata?.title), /Ines Carvalho/);
  assert.equal(await robin.evaluate(() => window.__ms.mic), true, 'the microphone shows as on');
  assert.equal(await robin.evaluate(() => window.__ms.cam), false);
  // The headset's or lock screen's mute.
  await robin.evaluate(() => window.__ms.handlers.togglemicrophone({ action: 'togglemicrophone' }));
  await robin.waitForFunction(() => window.snug.S.call.muted === true && window.__ms.mic === false);
  await robin.locator('.stage [aria-label="Unmute"]').waitFor();
  // Unmuting in Snug shows on the system's control too.
  await robin.click('.stage [aria-label="Unmute"]');
  await robin.waitForFunction(() => window.__ms.mic === true);
  await robin.evaluate(() => window.__ms.handlers.togglecamera({ action: 'togglecamera' }));
  await robin.waitForFunction(() => window.snug.S.call.camera === true && window.__ms.cam === true, null, { timeout: 15000 });
  // Hang up from the system: the call ends, here and for Ines.
  await robin.evaluate(() => window.__ms.handlers.hangup({ action: 'hangup' }));
  await robin.waitForFunction(() => window.snug.S.call === null);
  await ines.waitForFunction(() => window.snug.S.call === null);
  assert.deepEqual(await robin.evaluate(() => Object.keys(window.__ms.handlers)), [], 'no controls left after the call');
  assert.equal(await robin.evaluate(() => navigator.mediaSession.metadata), null);
});

test('media session in a voice room: named for the room; and a browser with neither API joins and leaves without errors', async () => {
  const robin = await person('robin', { init: stubs });
  await joinWheel(robin);
  await robin.waitForFunction(() => navigator.mediaSession.metadata?.title?.includes('Wheel room'));
  await robin.click('.stage [aria-label="Leave voice"]');
  await robin.waitForFunction(() => !Object.keys(window.__ms.handlers).length);
  const ines = await person('ines', { init: () => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: undefined });
  } });
  await joinWheel(ines);
  await ines.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await ines.click('.stage [aria-label="Mute"]');
  await ines.click('.stage [aria-label="Leave voice"]');
  await ines.waitForFunction(() => window.snug.S.call === null);
});

// ---------- 3. The security code ----------
test('security code: two people in a call see the same 6-digit code for each other, worded honestly', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  await connected(ines, 1);
  const codeOf = async (page, name) => {
    await page.click('.stage .act-conn');
    const row = page.locator(`.act-qpop .act-code-row:has-text("${name}") .act-code`);
    await row.waitFor();
    const text = (await row.textContent()).trim();
    // It says what a match shows, and that 6 digits are no guarantee (a server can try certificates until codes match).
    const note = await page.locator('.act-qpop').textContent();
    assert.match(note, /A match makes it much harder for anyone, the server included, to sit in the middle/);
    assert.match(note, /A 6-digit code means a device didn’t sign its side .*so it isn’t a guarantee/);
    assert.doesNotMatch(note, /nobody is in the middle/);
    await page.keyboard.press('Escape');
    return text;
  };
  const a = await codeOf(robin, 'Ines');
  const b = await codeOf(ines, 'Robin');
  assert.match(a, /^\d{3} \d{3}$/);
  assert.equal(a, b, 'the same code on both sides');
});

// ---------- 4. A call growing past 3 other people ----------
test('mesh: when a 5th person joins, everyone’s existing camera and screen sends drop to the lower caps; when one leaves they come back', async () => {
  const names = ['robin', 'ines', 'tomasz', 'priya'];
  const pages = [];
  for (const n of names) { const p = await person(n); await joinWheel(p); pages.push(p); }
  const [robin] = pages;
  await connected(robin, 3);
  // Robin sends at the lowest camera and screen settings: the caps are the same
  // kind of numbers, but eight full-size software encodes in one browser can
  // freeze its page for minutes on a shared machine.
  await robin.evaluate(async () => (await import('/js/voiceopts.js')).setVoice({ camRes: '360', camFps: 15, screenRes: '720', screenFps: 15 }));
  await robin.click('.stage .vc.cam');
  await robin.click('.stage .vc.scr');
  // Every one of Robin's sends, to each person, at the caps for this many people
  // (and for the step adaptive quality is at on that line, if the machine is busy).
  // A busy machine can keep a page from answering for half a minute, hence the long limit.
  const capsAre = (page, { many, n }) => waitAsync(page, async ([m, count]) => {
    const { sendCaps } = await import('/js/lib/callnet.js');
    const { screenBitrate } = await import('/js/voiceopts.js');
    const all = Object.values(await window.snug.voiceStats());
    return all.length === count && all.every((s) => {
      const want = sendCaps({ many: m, level: s.level, screenBps: screenBitrate(m) });
      return s.caps.camera?.maxBitrate === want.camera.maxBitrate && s.caps.screen?.maxBitrate === want.screen.maxBitrate;
    });
  }, [many, n], { timeout: 120000, polling: 300 });
  await capsAre(robin, { many: false, n: 3 });
  const few = await robin.evaluate(async () => (await window.snug.voiceStats()).ines.caps);
  // Malik joins: 4 others now.
  const malik = await person('malik');
  await joinWheel(malik);
  await connected(malik, 4);
  await capsAre(robin, { many: true, n: 4 });
  const lots = await robin.evaluate(async () => (await window.snug.voiceStats()).ines.caps);
  assert.ok(lots.camera.maxBitrate < few.camera.maxBitrate, `camera ${few.camera.maxBitrate} -> ${lots.camera.maxBitrate}`);
  assert.ok(lots.screen.maxBitrate < few.screen.maxBitrate, `screen ${few.screen.maxBitrate} -> ${lots.screen.maxBitrate}`);
  // Malik leaves: back to 3 others, and the higher caps come back.
  await malik.click('.stage [aria-label="Leave voice"]');
  await capsAre(robin, { many: false, n: 3 });
});

// ---------- 5. A browser that won't take a screen share's preference ----------
test('screen share: a browser that refuses the text/motion preference still gets the screen’s send cap', async () => {
  const robin = await person('robin', { init: () => {
    const real = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function (p) {
      return p && 'degradationPreference' in p ? Promise.reject(new DOMException('not supported', 'InvalidModificationError')) : real.call(this, p);
    };
  } });
  const ines = await person('ines');
  await joinWheel(robin);
  await joinWheel(ines);
  await connected(robin, 1);
  await robin.click('.stage .vc.scr');
  await waitAsync(robin, async () => {
    const { screenBitrate } = await import('/js/voiceopts.js');
    const s = (await window.snug.voiceStats()).ines;
    return s?.caps?.screen?.maxBitrate === screenBitrate(false) || (s?.level > 0 && s?.caps?.screen?.maxBitrate > 0);
  }, null, { timeout: 15000 });
  assert.equal((await robin.evaluate(async () => (await window.snug.voiceStats()).ines)).screenPref, null);
});

// ---------- 6. End-to-end encrypted media (calls C1, C2) ----------
// Turns encryption on from the invitation and confirms the recovery key (as tests/e2e-e2ee.test.js).
async function turnOnEncryption(page) {
  const dialog = page.locator('.modal[role=dialog]');
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.locator('.e2-invite button:has-text("Turn on")').click();
  await dialog.locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
  await dialog.locator('button:has-text("Turn on")').click();
  await dialog.locator('#e2-recovery-key').waitFor();
  const key = (await dialog.locator('#e2-recovery-key code').allTextContents()).join('-');
  await dialog.locator('#e2-last').fill(key.slice(-4).toLowerCase());
  await dialog.locator('button:has-text("I’ve saved it")').click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.snug.e2ee.E2.status === 'ready');
}
// Every connection end-to-end encrypted, with frames really opening on this side.
const allE2ee = (page, n, frames = 20) => waitAsync(page, async ([want, min]) => {
  const peers = Object.values(await window.snug.voiceStats());
  return peers.length === want && peers.every((p) => p.e2ee && p.frames?.dec > min && p.frames?.enc > min);
}, [n, frames], { timeout: 30000, polling: 300 }).catch(async (e) => {
  console.log('DEBUG', JSON.stringify(await page.evaluate(async () => ({ c: window.snug.voiceTest.crypt(), s: Object.fromEntries(Object.entries(await window.snug.voiceStats()).map(([k, v]) => [k, { e2ee: v.e2ee, why: v.e2eeWhy, f: v.frames, st: v.state }])) }))));
  throw e;
});
const cryptKey = (page) => page.evaluate(() => window.snug.voiceTest.crypt().key);

test('end-to-end encrypted media: sealed frames both ways, the label says so, a damaged frame is dropped, keys change on every join and leave, and the device-signed code is longer', async () => {
  const tomasz = await person('tomasz'), priya = await person('priya');
  await turnOnEncryption(tomasz);
  await turnOnEncryption(priya);
  await joinWheel(tomasz);
  await joinWheel(priya);
  await connected(tomasz, 1);
  await allE2ee(tomasz, 1);
  await allE2ee(priya, 1);
  // Audio really plays from opened frames (the voice keeps arriving and decoding).
  await waitAsync(priya, async () => (await window.snug.voiceStats()).tomasz?.energy > 0);
  await tomasz.locator('.stage .act-conn .act-e2ee.on:has-text("End-to-end encrypted")').waitFor();
  await tomasz.click('.stage .act-conn');
  await tomasz.locator('.act-qpop .act-e2ee-note:has-text("keys go only to the devices of the people listed here")').waitFor();
  // Both devices signed their certificates: "Verified device" and a 12-digit code, the same on both sides.
  const codeRow = (page, name) => page.locator(`.act-qpop .act-code-row:has-text("${name}")`);
  await codeRow(tomasz, 'Priya').locator('.act-verified:has-text("Verified device")').waitFor();
  const a = (await codeRow(tomasz, 'Priya').locator('.act-code').textContent()).trim();
  await tomasz.keyboard.press('Escape');
  await priya.click('.stage .act-conn');
  const b = (await codeRow(priya, 'Tomasz').locator('.act-code').textContent()).trim();
  await priya.keyboard.press('Escape');
  assert.match(a, /^\d{4} \d{4} \d{4}$/);
  assert.equal(a, b);
  // A damaged frame never plays: Priya drops what Tomasz damages on the way out.
  const before = (await priya.evaluate(async () => (await window.snug.voiceStats()).tomasz.frames));
  await tomasz.evaluate((u) => window.snug.voiceTest.tamper(u, true), 'priya');
  await waitAsync(priya, async (d0) => (await window.snug.voiceStats()).tomasz.frames.drop > d0 + 20, before.drop);
  const mid = (await priya.evaluate(async () => (await window.snug.voiceStats()).tomasz.frames));
  await tomasz.evaluate((u) => window.snug.voiceTest.tamper(u, false), 'priya');
  assert.ok(mid.dec - before.dec < 40, `damaged frames weren’t opened (${before.dec} -> ${mid.dec})`);
  await waitAsync(priya, async (d) => (await window.snug.voiceStats()).tomasz.frames.dec > d + 20, mid.dec);
  // Malik joins: everyone makes a new key; all three pairs are end-to-end encrypted.
  const k1 = await cryptKey(tomasz);
  const malik = await person('malik');
  await turnOnEncryption(malik);
  await joinWheel(malik);
  await connected(malik, 2);
  await waitAsync(tomasz, async (k) => window.snug.voiceTest.crypt().key !== k, k1);
  for (const p of [tomasz, priya, malik]) await allE2ee(p, 2, 5);
  // Malik leaves: a new key again, and after a moment Priya holds only Tomasz's newest key.
  const k2 = await cryptKey(tomasz);
  await malik.click('.stage [aria-label="Leave voice"]');
  await waitAsync(tomasz, async (k) => window.snug.voiceTest.crypt().key !== k, k2);
  const k3 = await cryptKey(tomasz);
  await waitAsync(priya, async (k) => {
    const f = (await window.snug.voiceStats()).tomasz?.frames;
    return f && f.recvKeys.length === 1 && f.recvKeys[0] === k;
  }, k3, { timeout: 20000 });
  await allE2ee(priya, 1, 5);
});

test('end-to-end encryption fallback: a browser without encoded transforms connects as before, and both sides say "Encrypted in transit only" and why', async () => {
  const sunniva = await person('sunniva');
  await turnOnEncryption(sunniva);
  const dara = await person('dara', { init: () => { delete window.RTCRtpScriptTransform; delete RTCRtpSender.prototype.createEncodedStreams; delete RTCRtpReceiver.prototype.createEncodedStreams; } });
  await joinWheel(sunniva);
  await joinWheel(dara);
  await connected(sunniva, 1);
  await connected(dara, 1);
  await waitAsync(sunniva, async () => (await window.snug.voiceStats()).dara?.e2eeWhy === 'their-browser').catch(async (e) => {
    for (const p of [sunniva, dara]) console.log('DEBUG', JSON.stringify(await p.evaluate(async () => ({ ce: window.snug.S.callE2ee, c: window.snug.voiceTest.crypt(), s: Object.fromEntries(Object.entries(await window.snug.voiceStats()).map(([k, v]) => [k, { e2ee: v.e2ee, why: v.e2eeWhy, f: v.frames, st: v.state }])) }))));
    throw e;
  });
  assert.equal((await dara.evaluate(async () => (await window.snug.voiceStats()).sunniva)).e2ee, false);
  await dara.locator('.stage .act-conn .act-e2ee.off:has-text("Encrypted in transit only")').waitFor();
  await dara.click('.stage .act-conn');
  await dara.locator('.act-qpop .act-e2ee-note:has-text("this browser can’t encrypt calls end to end")').waitFor();
  await dara.keyboard.press('Escape');
  await sunniva.click('.stage .act-conn');
  await sunniva.locator('.act-qpop .act-e2ee-note:has-text("Dara’s browser or app can’t encrypt calls end to end")').waitFor();
});
