// Notifications when Snug is closed, in Chromium against the real server, with
// two people in separate browser sessions.
//
// Chromium's real push service (Google's) is tried once and the result is
// reported; whatever it says, the rest of the flow is tested with the
// browser's subscription pointed at a local mock push service instead: the
// server encrypts and signs a real push to it, the test decrypts it with the
// subscription's keys, and hands the decrypted note to the real service
// worker through the DevTools protocol (ServiceWorker.deliverPushMessage).
//   node --test tests/e2e-notify.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import * as C from 'node:crypto';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-notify-'));
let srv, browser, url, mock, pushUrl;
const errors = [];
const got = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, pushAllowLocal: true });
  url = `http://127.0.0.1:${srv.port}`;
  mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201);
    res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  pushUrl = `http://127.0.0.1:${mock.address().port}`;
  // The new headless mode: notification permissions and service workers behave as in Chrome.
  browser = await chromium.launch({ channel: 'chromium' });
});
test.after(async () => { await browser?.close(); mock?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => { srv.hub.resetLimits(); srv.push.reset(); });
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function context(handle, { permissions = [], init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  return ctx;
}
async function open(ctx, handle, path = '/') {
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|push service|Registration failed/i.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url + path);
  return page;
}
async function signIn(page, handle) {
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector('.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
}
async function notifySettings(page) {
  await page.click('.self');
  await page.click('.me-pop >> text=Settings');
  await page.click('.layer-nav >> text=Notifications');
  await page.locator('.push-set, #set-keep-running').first().waitFor();
}
const state = (page) => page.locator('.push-set').getAttribute('data-state');
const waitState = (page, s) => page.locator(`.push-set[data-state="${s}"]`).waitFor();

// A stand-in subscription: the page's PushManager hands out these keys and a
// mock endpoint, as a real browser would hand out Google's.
function fakePush({ endpoint, p256dh, auth }) {
  const key = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
  const make = (appKey) => ({
    endpoint, expirationTime: null, options: { userVisibleOnly: true, applicationServerKey: appKey },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
    unsubscribe: async () => { localStorage.removeItem('fake-push'); return true; },
  });
  PushManager.prototype.subscribe = async function subscribe(o) {
    const k = o.applicationServerKey;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(k.buffer || k))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem('fake-push', b64);
    return make(new Uint8Array(k.buffer || k).buffer);
  };
  PushManager.prototype.getSubscription = async function getSubscription() {
    const k = localStorage.getItem('fake-push');
    return k ? make(key(k)) : null;
  };
}

function decrypt(body, ua, auth) {
  const hmac = (k, d) => C.createHmac('sha256', k).update(d).digest();
  const salt = body.subarray(0, 16);
  const asPub = body.subarray(21, 21 + body[20]);
  const ct = body.subarray(21 + body[20]);
  const ikm = hmac(hmac(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = C.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return pt.subarray(0, pt.lastIndexOf(2)).toString();
}
const pushes = async (n, ms = 3000) => {
  const end = Date.now() + ms;
  while (got.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 200));
  return got.splice(0);
};

test('the service worker is served at the root, uncached, allowed the whole site', async () => {
  const res = await fetch(`${url}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/javascript/);
  assert.equal(res.headers.get('service-worker-allowed'), '/');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(await res.text(), /notificationclick/);
  assert.equal((await fetch(`${url}/brand/notify-badge.png`)).status, 200);
});

test('settings: every state of “Notify me when Snug is closed” renders', async () => {
  // Blocked by the browser, with how to fix it.
  let ctx = await context('robin', { init: { fn: () => { Object.defineProperty(Notification, 'permission', { get: () => 'denied' }); } } });
  let page = await open(ctx, 'robin');
  await signIn(page, 'robin');
  await notifySettings(page);
  await waitState(page, 'blocked');
  assert.match(await page.locator('#set-push').textContent(), /blocking notifications for Snug.*site settings.*Allow/);
  await page.locator('#set-push button:has-text("Check again")').waitFor();
  await ctx.close();

  // Asking: the browser's prompt is still open.
  ctx = await context('robin', { init: { fn: () => { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); Notification.requestPermission = () => new Promise(() => {}); } } });
  page = await open(ctx, 'robin');
  await signIn(page, 'robin');
  await notifySettings(page);
  await waitState(page, 'off');
  assert.match(await page.locator('#set-push').textContent(), /every Snug tab closed/);
  await page.click('#set-push [role="switch"]');
  await waitState(page, 'asking');
  assert.match(await page.locator('#set-push').textContent(), /Choose Allow in your browser’s prompt/);
  assert.equal(await page.locator('#set-push [role="switch"]').getAttribute('aria-busy'), 'true');
  await ctx.close();

  // Dismissing the prompt returns to off, with a reason.
  ctx = await context('robin', { init: { fn: () => { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); Notification.requestPermission = async () => 'default'; } } });
  page = await open(ctx, 'robin');
  await signIn(page, 'robin');
  await notifySettings(page);
  await waitState(page, 'off');
  await page.click('#set-push [role="switch"]');
  await page.locator('.push-set .err:has-text("needs your permission")').waitFor();
  await ctx.close();

  // A browser without push.
  ctx = await context('robin', { init: { fn: () => { delete window.PushManager; } } });
  page = await open(ctx, 'robin');
  await signIn(page, 'robin');
  await notifySettings(page);
  await waitState(page, 'unsupported');
  assert.match(await page.locator('#set-push').textContent(), /Not available/);
  await ctx.close();

  // The desktop app: the setting there is keeping Snug running in the tray.
  ctx = await context('robin', {
    init: { fn: () => { let on = true; window.snugApp = { desktop: true, show() {}, getKeepRunning: async () => on, setKeepRunning: async (v) => { on = v; return v; } }; } },
  });
  page = await open(ctx, 'robin');
  await signIn(page, 'robin');
  await notifySettings(page);
  const keep = page.locator('#set-keep-running');
  await keep.waitFor();
  assert.match(await keep.textContent(), /Keep Snug running when the window is closed.*system tray/);
  await keep.locator('[role="switch"][aria-checked="true"]').waitFor();
  await keep.locator('[role="switch"]').click();
  await keep.locator('[role="switch"][aria-checked="false"]').waitFor();
  assert.match(await keep.textContent(), /Closing the window quits Snug/);
  await ctx.close();
});

test('Chromium’s real push service: try it, and say what happened', async (t) => {
  // A persistent profile: Chrome offers no Push API in incognito-style contexts.
  const profile = mkdtempSync(join(tmpdir(), 'snug-e2e-notify-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', permissions: ['notifications'], viewport: { width: 1280, height: 800 } });
  t.after(async () => { await ctx.close().catch(() => {}); rmSync(profile, { recursive: true, force: true }); });
  const page = await open(ctx, 'robin');
  await signIn(page, 'robin');
  await notifySettings(page);
  await waitState(page, 'off');
  await page.click('#set-push [role="switch"]');
  await page.locator('.push-set[data-state="on"], .push-set[data-state="error"]').waitFor({ timeout: 40000 });
  // The service worker registered and is running, whatever the push service said.
  const sw = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.state);
  assert.equal(sw, 'activated');
  const s = await state(page);
  if (s === 'on') {
    const ep = srv.db.get('SELECT endpoint FROM push_subs ORDER BY created DESC LIMIT 1')?.endpoint;
    t.diagnostic(`real push service: subscribed (${new URL(ep).host})`);
    assert.match(ep, /^https:\/\//);
    await page.click('#set-push [role="switch"]');
    await waitState(page, 'off');
    assert.equal(srv.db.get('SELECT 1 FROM push_subs WHERE endpoint = ?', ep), undefined, 'turning it off removes the device');
  } else {
    const why = await page.locator('.push-set .err').textContent();
    t.diagnostic(`real push service: not reachable from here; the setting shows “${why}”`);
    assert.ok(why.length > 10, 'the failure is explained');
  }
  await ctx.close();
});

test('two people: Ines writes while Robin has Snug closed; the push reaches Robin’s service worker and opens the conversation', async () => {
  const ua = C.createECDH('prime256v1');
  ua.generateKeys();
  const auth = C.randomBytes(16);
  const sub = { endpoint: `${pushUrl}/robin`, p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const robinCtx = await context('robin', { permissions: ['notifications'], init: { fn: fakePush, arg: sub } });
  let robin = await open(robinCtx, 'robin');
  await signIn(robin, 'robin');
  await notifySettings(robin);
  await robin.click('#set-push [role="switch"]');
  await waitState(robin, 'on');
  const robinId = await robin.evaluate(() => window.snug.S.me);
  assert.ok(srv.db.get('SELECT 1 FROM push_subs WHERE user = ? AND endpoint = ?', robinId, sub.endpoint), 'the server has Robin’s device');
  await robin.reload();
  await robin.waitForSelector('.nav');
  await notifySettings(robin);
  await waitState(robin, 'on'); // still on after a reload
  await robin.keyboard.press('Escape');

  const ines = await open(await context('ines'), 'ines');
  await signIn(ines, 'ines');
  await ines.click('.rail-btn:has-text("Messages")');
  await ines.click('.nav .ctx .row:has-text("Robin Hale")');
  const box = ines.locator('.main .composer textarea');

  // Robin has Snug open: no push.
  await box.fill('Kiln’s cool, you can unload.');
  await box.press('Enter');
  await robin.waitForFunction(() => Object.values(window.snug.S.msgs).flat().some((m) => m.text.startsWith('Kiln’s cool')));
  assert.equal((await pushes(1, 600)).length, 0, 'no push while Robin is connected');

  // Robin closes the tab. The service worker stays.
  await robin.close();
  await new Promise((r) => setTimeout(r, 300));
  await box.fill('Are you bringing the **celadon** bowls Saturday?');
  await box.press('Enter');
  const [p] = await pushes(1);
  assert.ok(p, 'the server pushed to Robin’s device');
  assert.equal(p.path, '/robin');
  const note = JSON.parse(decrypt(p.body, ua, auth));
  assert.equal(note.title, 'Ines Carvalho');
  assert.equal(note.body, 'Are you bringing the celadon bowls Saturday?');
  assert.equal(note.conv, 'd_ines');

  // Hand the decrypted note to Robin's real service worker, as the browser's push service would.
  const blank = await robinCtx.newPage();
  const cdp = await robinCtx.newCDPSession(blank);
  const reg = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    const r = registrations.find((x) => x.scopeURL === `${url}/` && !x.isDeleted);
    if (r) resolve(r.registrationId);
  }));
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: url, registrationId: await reg, data: JSON.stringify(note) });
  const [worker] = robinCtx.serviceWorkers();
  assert.ok(worker, 'the service worker is running');
  const shown = async () => worker.evaluate(async () => (await self.registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, badge: n.badge, data: n.data })));
  let list = [];
  for (let i = 0; i < 40 && !list.length; i++) { list = await shown(); if (!list.length) await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Ines Carvalho');
  assert.equal(list[0].body, 'Are you bringing the celadon bowls Saturday?');
  assert.equal(list[0].tag, 'snug:d_ines');
  assert.match(list[0].icon, /\/brand\/app-icon-192\.png$/);
  assert.match(list[0].badge, /\/brand\/notify-badge\.png$/);
  // A second message in the same conversation replaces the first (same tag).
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: url, registrationId: await reg, data: JSON.stringify({ ...note, body: 'Or the tenmoku ones?' }) });
  for (let i = 0; i < 40 && list[0]?.body !== 'Or the tenmoku ones?'; i++) { list = await shown(); await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(list.length, 1, 'notifications stack per conversation');

  // No Snug tab open: the notification's address opens the conversation (sign-in kept).
  robin = await open(robinCtx, 'robin', `/?open=d_ines&msg=${note.msg}`);
  await robin.waitForSelector('.nav');
  await robin.locator('.main .msg:has-text("Are you bringing the celadon bowls")').waitFor();
  assert.equal(new URL(robin.url()).search, '', 'the address is cleaned up');

  // A Snug tab is open somewhere else: clicking tells it to open the conversation.
  await robin.click('.rail-btn:has-text("Home")');
  await robin.locator('.main.home').waitFor();
  await worker.evaluate(async () => {
    const [n] = await self.registration.getNotifications();
    self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n }));
  }).catch(() => {});
  await robin.locator('.main .msg:has-text("Are you bringing the celadon bowls")').waitFor();
  assert.equal((await shown()).length, 0, 'the clicked notification closes');

  // Signing out on this device stops its notifications.
  await robin.click('.self');
  await robin.click('.me-pop >> text=Settings');
  await robin.click('.layer-nav >> text=Account');
  await robin.click('.layer-body .set-row:has-text("Sign out on this device") button:text-is("Sign out")');
  await robin.waitForSelector('.auth-form');
  assert.equal(srv.db.get('SELECT 1 FROM push_subs WHERE user = ?', robinId), undefined, 'signing out removes this device');
  await robinCtx.close();
  await ines.context().close();
});
