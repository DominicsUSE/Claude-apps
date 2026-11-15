// End-to-end encryption in the browser (Chromium), against the real server
// with encryption turned on, seeded data (Robin and Ines share Kiln & Co., are
// friends and have a DM) and separate browser contexts as separate devices.
// Covers the key directory: turning it on, the recovery key, adding a device
// with a typed code (and a wrong one), recovery with the recovery key, safety
// numbers and their verified mark following you to another device, Settings >
// Encryption, and the same sheets on a phone.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-e2ee-'));
let srv, browser, url;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, e2ee: true });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
async function device(handle, opts = {}) {
  const ctx = await browser.newContext(opts.phone ? PHONE : { viewport: { width: 1280, height: 800 } });
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
  await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  return page;
}
const status = (page) => page.evaluate(() => window.snug.e2ee.E2.status);
const waitStatus = (page, want) => page.waitForFunction((w) => window.snug.e2ee.E2.status === w, want);
const idOf = (handle) => srv.db.get('SELECT id FROM users WHERE handle = ?', handle).id;
const dialog = (page) => page.locator('.modal[role=dialog]');
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Turns encryption on from the first-run sheet and confirms the recovery key; returns the key text.
async function turnOn(page) {
  await dialog(page).locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
  await dialog(page).locator('button:has-text("Turn on")').click();
  await dialog(page).locator('#e2-recovery-key').waitFor();
  const key = (await dialog(page).locator('#e2-recovery-key code').allTextContents()).join('-');
  assert.match(key, /^([A-Z2-7]{4}-){8}[A-Z2-7]{4}$/);
  await dialog(page).locator('#e2-last').fill('ZZZZ' === key.slice(-4) ? 'YYYY' : 'ZZZZ');
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).locator('[role=alert]:has-text("isn’t the last group")').waitFor();
  await dialog(page).locator('#e2-last').fill(key.slice(-4).toLowerCase());
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).waitFor({ state: 'detached' });
  await waitStatus(page, 'ready');
  return key;
}
async function openEncryptionSettings(page) {
  await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Encryption")');
  await page.locator('.layer-col h1:has-text("Encryption")').waitFor();
}
async function openDmDetails(page, title) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
  await page.click('.main .bar [aria-label="Details"]');
  await page.locator('.pane[aria-label="Details"] .e2-detail').waitFor();
}

let robinKey, robinA, inesKey;

test('turning it on: the first-run sheet, the recovery key typed back, keys kept across a reload, Settings > Encryption', async () => {
  robinA = await device('robin');
  robinKey = await turnOn(robinA);
  const acct = srv.db.get('SELECT ver, hist FROM e2ee_accounts WHERE user = ?', idOf('robin'));
  assert.deepEqual({ ...acct }, { ver: 1, hist: 1 });
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'trusted'", idOf('robin')).n, 1);
  // The server never sees the recovery key.
  assert.ok(!JSON.stringify(srv.db.get('SELECT blob FROM e2ee_backup WHERE user = ?', idOf('robin'))).includes(robinKey.replace(/-/g, '')));
  // Device keys survive a reload, non-extractable.
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
  const extractable = await robinA.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open(`snug-e2ee:${window.snug.S.me}`); q.onsuccess = () => r(q.result); });
    const dev = await new Promise((r) => { const q = db.transaction('dev').objectStore('dev').get('device'); q.onsuccess = () => r(q.result); });
    return [dev.dsk.privateKey.extractable, dev.prekeys[dev.kid].pair.privateKey.extractable];
  });
  assert.deepEqual(extractable, [false, false]);
  assert.equal(await dialog(robinA).count(), 0, 'no sheet once it is on');
  await openEncryptionSettings(robinA);
  const page = robinA.locator('.layer-col');
  await page.locator('.e2-ok:has-text("on for this device")').waitFor();
  await page.locator('text=Saved. You confirmed you have it.').waitFor();
  assert.equal(await page.locator('.e2-dev').count(), 1);
  assert.match(await page.locator('.e2-limits').textContent(), /still sees who talks to whom/);
  assert.match(await page.locator('.e2-limits').textContent(), /Snug’s code comes from this server/);
  await robinA.keyboard.press('Escape');
});

test('adding a device with the typed code: a wrong code cancels, the right one adds it, both see two devices', async () => {
  const b = await device('robin');
  await dialog(b).locator('h2:has-text("Add this browser")').waitFor();
  assert.equal(await status(b), 'new-device');
  await dialog(b).locator('button:has-text("Use my other device")').click();
  await dialog(b).locator('#e2-code').waitFor();
  // The trusted device is asked.
  await dialog(robinA).locator('h2:has-text("Approve Chrome on")').waitFor();
  await dialog(robinA).locator('button:has-text("Approve")').click();
  const code = await dialog(robinA).locator('#e2-link-code').textContent();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  // A wrong code first: one try, the request is cancelled on both sides.
  const wrong = code.startsWith('0') ? `1${code.slice(1)}` : `0${code.slice(1)}`;
  await dialog(b).locator('#e2-code').fill(wrong);
  await dialog(b).locator('button:has-text("Add this browser")').click();
  await dialog(robinA).locator('text=didn’t match').waitFor();
  await dialog(robinA).locator('button:has-text("Done")').click();
  await dialog(b).locator('h2:has-text("That didn’t go through")').waitFor();
  // Start again: a new request and a new code.
  await dialog(b).locator('button:has-text("Start again")').click();
  await dialog(b).locator('#e2-code').waitFor();
  await dialog(robinA).locator('button:has-text("Approve")').click();
  const code2 = await dialog(robinA).locator('#e2-link-code').textContent();
  assert.notEqual(code2, code);
  await dialog(b).locator('#e2-code').fill(code2.toLowerCase());
  await dialog(b).locator('button:has-text("Add this browser")').click();
  await dialog(b).locator('h2:has-text("This browser is added")').waitFor();
  await dialog(robinA).locator('h2:has-text("Device added")').waitFor();
  await dialog(robinA).locator('button:has-text("Done")').click();
  await dialog(b).locator('button:has-text("Done")').click();
  await waitStatus(b, 'ready');
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'trusted'", idOf('robin')).n, 2);
  for (const p of [robinA, b]) {
    await openEncryptionSettings(p);
    await p.waitForFunction(() => document.querySelectorAll('.e2-dev').length === 2);
    await p.keyboard.press('Escape');
  }
  await b.context().close();
});

test('recovery: another browser with no keys reads the recovery key back in (and asks for the password after an old sign-in)', async () => {
  const ines = await device('ines');
  inesKey = await turnOn(ines);
  await ines.context().close();
  const fresh = await device('ines');
  await dialog(fresh).locator('h2:has-text("Add this browser")').waitFor();
  srv.db.run('UPDATE sessions SET auth_at = 0 WHERE user = ?', idOf('ines')); // signed in long ago
  await dialog(fresh).locator('button:has-text("Use my recovery key")').click();
  await dialog(fresh).locator('#e2-rk-in').fill('ABCD-EFGH');
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('[role=alert]:has-text("36 letters")').waitFor();
  await dialog(fresh).locator('#e2-rk-in').fill(inesKey.toLowerCase().replace(/-/g, ' '));
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('#e2-rk-pw').waitFor();
  await dialog(fresh).locator('#e2-rk-pw').fill(PASSWORD);
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('h2:has-text("Encryption is back on this device")').waitFor();
  await dialog(fresh).locator('button:has-text("Done")').click();
  await waitStatus(fresh, 'ready');
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'trusted'", idOf('ines')).n, 2);
  await fresh.context().close();
});

test('safety numbers: the same 60 digits on both sides; marking verified follows Robin to his other device', async () => {
  const ines = await device('ines');
  await dialog(ines).locator('h2:has-text("Add this browser")').waitFor();
  await dialog(ines).locator('button:has-text("Use my recovery key")').click();
  await dialog(ines).locator('#e2-rk-in').fill(inesKey);
  await dialog(ines).locator('button:has-text("Use recovery key")').click();
  await dialog(ines).locator('h2:has-text("Encryption is back")').waitFor();
  await dialog(ines).locator('button:has-text("Done")').click();
  await waitStatus(ines, 'ready');
  await openDmDetails(robinA, 'Ines Carvalho');
  assert.match(await robinA.locator('.e2-detail').textContent(), /Not end-to-end encrypted yet/);
  await robinA.locator('.e2-detail button:has-text("Safety number")').click();
  await dialog(robinA).locator('#e2-safety-number').waitFor();
  await openDmDetails(ines, 'Robin Hale');
  await ines.locator('.e2-detail button:has-text("Safety number")').click();
  await dialog(ines).locator('#e2-safety-number').waitFor();
  const a = (await dialog(robinA).locator('#e2-safety-number code').allTextContents()).join(' ');
  const b = (await dialog(ines).locator('#e2-safety-number code').allTextContents()).join(' ');
  assert.match(a, /^(\d{5} ){11}\d{5}$/);
  assert.equal(a, b);
  assert.equal(await dialog(robinA).locator('svg.acc-qr').count(), 1);
  await dialog(robinA).locator('.e2-state:has-text("Not verified")').waitFor();
  await dialog(robinA).locator('button:has-text("Mark as verified")').click();
  await dialog(robinA).locator('.e2-state:has-text("Verified")').waitFor();
  // Robin's other device: link it, then the mark is there (synced, encrypted settings).
  const b2 = await device('robin');
  await dialog(b2).locator('button:has-text("Use my recovery key")').click();
  await dialog(b2).locator('#e2-rk-in').fill(robinKey);
  await dialog(b2).locator('button:has-text("Use recovery key")').click();
  await dialog(b2).locator('h2:has-text("Encryption is back")').waitFor();
  await dialog(b2).locator('button:has-text("Done")').click();
  await waitStatus(b2, 'ready');
  const synced = await b2.evaluate(async (u) => (await window.snug.e2ee.safetyFor(u)).verified, idOf('ines'));
  assert.equal(synced, true);
  await robinA.keyboard.press('Escape');
  await ines.context().close();
  await b2.context().close();
});

test('phone: the setup, add-device and safety-number sheets fit a 390px screen', async () => {
  const priya = await device('priya', { phone: true });
  await dialog(priya).locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
  assert.ok(await noOverflow(priya), 'setup sheet');
  const key = await turnOn(priya);
  assert.ok(key);
  const phone2 = await device('priya', { phone: true });
  await dialog(phone2).locator('h2:has-text("Add this browser")').waitFor();
  assert.ok(await noOverflow(phone2), 'add-device sheet');
  await dialog(phone2).locator('button:has-text("Use my other device")').click();
  await dialog(phone2).locator('#e2-code').waitFor();
  assert.ok(await noOverflow(phone2), 'code screen');
  await dialog(priya).locator('button:has-text("Approve")').click();
  await dialog(priya).locator('#e2-link-code').waitFor();
  assert.ok(await noOverflow(priya), 'approval code');
  const box = await dialog(priya).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 391, 'the dialog is inside the screen');
  await dialog(priya).locator('button:has-text("Cancel")').click();
  await dialog(priya).waitFor({ state: 'detached' });
  // Safety number with Robin (encryption on since the first test), from the DM's details.
  await priya.click('.tab:has-text("Messages")');
  await priya.click('.tab-body .row:has-text("Robin")');
  await priya.locator('.screen.push .composer textarea').waitFor();
  await priya.click('.screen.push .bar [aria-label="More"]');
  await priya.locator('[role=menu] [role=menuitem]:has-text("Details")').click();
  await priya.locator('.e2-detail button:has-text("Safety number")').click();
  await dialog(priya).locator('#e2-safety-number').waitFor();
  assert.ok(await noOverflow(priya), 'safety number sheet');
  const sn = await dialog(priya).boundingBox();
  assert.ok(sn.x >= 0 && sn.x + sn.width <= 391, 'the safety number sheet is inside the screen');
  await phone2.context().close();
  await priya.context().close();
});

test('off by default: a server without SNUG_E2EE offers nothing and lists no Encryption page', async () => {
  const off = await startServer({ port: 0, dataDir: dir.replace(/$/, '-off'), quiet: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`off: ${e.message}`));
    await page.goto(`http://127.0.0.1:${off.port}`);
    await page.waitForSelector('.auth-form');
    await page.click('text=Create an account').catch(() => {});
    await page.evaluate(async () => {
      await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'offperson', name: 'Off', password: 'a long password' }) });
    });
    await page.reload();
    await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    await page.waitForTimeout(300);
    assert.equal(await status(page), 'off');
    assert.equal(await dialog(page).count(), 0);
    await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
    await page.locator('.layer-nav').waitFor();
    assert.equal(await page.locator('.layer-nav .row:has-text("Encryption")').count(), 0);
    await ctx.close();
  } finally { await off.close(); rmSync(`${dir}-off`, { recursive: true, force: true }); }
});
