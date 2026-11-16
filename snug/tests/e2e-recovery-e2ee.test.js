// v0.13: one recovery key for "Forgot your password?" and the end-to-end encryption backup
// (js/views/recover.js with js/e2ee/manager.js adoptRecoveryKey), against the real server with
// encryption on and seeded data. Separate browser contexts are separate devices.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-rk-e2ee-'));
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

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  return page;
}
async function signIn(page, handle, password) {
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', password);
  await page.click('.auth-form button[type=submit]');
  await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
}
async function signOut(page) {
  await page.evaluate(() => fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  await page.reload();
  await page.waitForSelector('.auth-form');
}
const dialog = (page) => page.locator('.modal[role=dialog]');
const waitStatus = (page, want) => page.waitForFunction((w) => window.snug.e2ee.E2.status === w, want);
const keyText = async (page) => (await page.locator('#rk-key span').allTextContents()).join('-');
const backupBlob = (handle) => srv.db.get('SELECT b.blob FROM e2ee_backup b JOIN users u ON u.id = b.user WHERE u.handle = ?', handle)?.blob;
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 150)); }
}
// Turns encryption on from the invitation above the direct messages and confirms its recovery key.
async function turnOn(page) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.locator('.e2-invite button:has-text("Turn on")').click();
  await dialog(page).locator('button:has-text("Turn on")').click();
  await dialog(page).locator('#e2-recovery-key').waitFor();
  const key = (await dialog(page).locator('#e2-recovery-key code').allTextContents()).join('-');
  await dialog(page).locator('#e2-last').fill(key.slice(-4));
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).waitFor({ state: 'detached' });
  await waitStatus(page, 'ready');
  return key;
}
// A browser with no keys adds itself with a recovery key; true when the backup opened.
async function addWithKey(handle, password, key) {
  const fresh = await newPage(`${handle}-fresh`);
  await signIn(fresh, handle, password);
  await dialog(fresh).locator('h2:has-text("Add this browser")').waitFor();
  await dialog(fresh).locator('button:has-text("Use my recovery key")').click();
  await dialog(fresh).locator('#e2-rk-in').fill(key);
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('h2:has-text("Encryption is back on this device"), [role=alert]').first().waitFor();
  const ok = await dialog(fresh).locator('h2:has-text("Encryption is back on this device")').count() === 1;
  if (ok) { await dialog(fresh).locator('button:has-text("Done")').click(); await waitStatus(fresh, 'ready'); }
  return { ok, page: fresh };
}

let A, pw = PASSWORD;

test('one key: a password recovery key made after "Forgot your password?" also opens the encryption backup on a fresh device', async () => {
  A = await newPage('robin');
  await signIn(A, 'robin', pw);
  const e2Key = await turnOn(A);
  // Encryption's new key is offered for the password too; not now.
  await A.evaluate(() => { window.snug.S.ui.view = { type: 'home' }; window.snug.emit(); });
  await A.locator('#rk-e2-later').click();
  // A password recovery key from Home: the backup moves to it.
  const b0 = backupBlob('robin');
  await A.locator('#rk-remind-go').click();
  await A.locator('#rk-key').waitFor();
  const k1 = await keyText(A);
  await A.fill('#rk-last', k1.slice(-4));
  await A.click('#rk-saved');
  await A.fill('#rk-pw', pw); // not a fresh sign-in: the password
  await A.click('#rk-pw-go');
  await A.locator('.toast:has-text("also opens your encrypted history")').waitFor();
  assert.notEqual(backupBlob('robin'), b0);
  // Forgot the password: k1 sets a new one; the new key k2 saved straight after takes over the backup too.
  await signOut(A);
  await A.click('#auth-forgot');
  await A.fill('#rk-handle', 'robin');
  await A.fill('#rk-key-in', k1);
  await A.click('#rk-check');
  pw = 'a recovered garden gate';
  await A.fill('#rk-new-pass', pw);
  await A.click('#rk-set-pass');
  await A.locator('#rk-recovered').waitFor();
  await A.locator('#rk-key').waitFor();
  const k2 = await keyText(A);
  const b1 = backupBlob('robin');
  await A.fill('#rk-last', k2.slice(-4));
  await A.click('#rk-saved');
  await A.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(A, 'ready');
  await until(() => backupBlob('robin') !== b1, 'the backup sealed again under the new key');
  await A.locator('.toast:has-text("also opens your encrypted history")').waitFor();
  // On a fresh device: the encryption key from setup and k1 no longer open the backup; k2 does.
  const old = await addWithKey('robin', pw, e2Key);
  assert.equal(old.ok, false, 'the old encryption key no longer opens it');
  await old.page.context().close();
  const fresh = await addWithKey('robin', pw, k2);
  assert.equal(fresh.ok, true, 'the new password recovery key opens the encryption backup');
  await fresh.page.context().close();
});

test('one key: a device removed in Settings > Encryption; its new recovery key, used for the password too, works for "Forgot your password?"', async () => {
  // A tells Robin what happened meanwhile: the browser that tried the old key asks to be approved (not me),
  // and the one added with the new key is announced (Done).
  await dialog(A).locator('button:has-text("Not me")').click();
  await dialog(A).locator('h2:has-text("Device added")').waitFor();
  await dialog(A).locator('button:has-text("Done")').click();
  await dialog(A).waitFor({ state: 'detached' });
  // The fresh device from the first test is still one of Robin's: remove it from A.
  await A.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
  await A.click('.layer-nav .row:has-text("Encryption")');
  await A.locator('.layer-col h1:has-text("Encryption")').waitFor();
  await A.locator('.e2-dev:not(:has-text("(this device)")) button:has-text("Remove")').click();
  await dialog(A).locator('button.danger:has-text("Remove")').click();
  await A.waitForFunction(() => window.snug.e2ee.E2.rk?.fresh);
  const e2Key = await A.evaluate(() => window.snug.e2ee.E2.rk.text);
  await A.keyboard.press('Escape');
  await A.keyboard.press('Escape');
  // Settings > Account and security offers it for the password too
  await A.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]').catch(() => {});
  await A.click('.layer-nav .row:has-text("Account")');
  await A.locator('.layer-body h1:has-text("Account and security")').waitFor();
  await A.locator('#rk-e2-use-settings').click();
  await A.fill('#rk-e2-pw', 'not my password');
  await A.click('#rk-e2-go');
  await A.locator('#rk-e2-err').waitFor();
  await A.fill('#rk-e2-pw', pw);
  await A.click('#rk-e2-go');
  await A.locator('.toast:has-text("is also your password recovery key now")').waitFor();
  await A.locator('#rk-e2-use-settings').waitFor({ state: 'detached' });
  assert.equal(await A.locator('#rk-e2-use').count(), 0, 'and Home stops offering it');
  assert.equal(srv.db.get("SELECT r.v FROM recovery r JOIN users u ON u.id = r.user WHERE u.handle = 'robin' AND r.used IS NULL").v, 2);
  await A.keyboard.press('Escape');
  // Forgot the password: the encryption key resets it.
  await signOut(A);
  await A.click('#auth-forgot');
  await A.fill('#rk-handle', 'robin');
  await A.fill('#rk-key-in', e2Key);
  await A.click('#rk-check');
  await A.locator('#rk-new-pass').waitFor();
  await A.fill('#rk-new-pass', 'one key for both doors');
  await A.click('#rk-set-pass');
  await A.locator('#rk-recovered').waitFor();
  await A.context().close();
});
