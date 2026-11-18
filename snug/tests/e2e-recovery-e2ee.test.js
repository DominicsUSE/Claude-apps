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
// 0.14 S5: every body a page sends (HTTP and socket frames), to check no recovery or backup key travels.
const wire = [];

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
  page.on('request', (r) => { const b = r.postData(); if (b) wire.push(b); });
  page.on('websocket', (ws) => ws.on('framesent', (f) => wire.push(typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('latin1'))));
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
  // 0.14 S5: through saving, using and adopting, no request carried a key, its text or its backup key.
  const { parseRecoveryKey, deriveBackupKey } = await import('../js/lib/recovery.js');
  const { openBackup } = await import('../js/lib/e2ee/backup.js');
  const all = wire.join('\n');
  assert.ok(all.includes('"verifier"') && all.includes('"proof"') && all.includes('e2ee.publish'), 'save, use and adopt were all captured');
  const forms = (raw, text = null) => {
    const b = Buffer.from(raw);
    const out = [b.toString('hex'), b.toString('base64'), b.toString('base64url'), b.toString('base64').replace(/=+$/, '')];
    if (text) { const bare = text.replace(/-/g, ''); out.push(text, text.toLowerCase(), bare, bare.toLowerCase(), bare.slice(0, 32), bare.slice(0, 32).toLowerCase()); }
    return out;
  };
  for (const text of [e2Key, k1, k2]) {
    const { raw } = await parseRecoveryKey(text);
    for (const f of [...forms(raw, text), ...forms(await deriveBackupKey(raw))]) assert.equal(all.includes(f), false, `a key travelled (${f.slice(0, 6)}…)`);
  }
  // The server's recovery row opens nothing; the key itself does.
  const user = srv.db.get("SELECT id FROM users WHERE handle = 'robin'").id;
  const blob = JSON.parse(backupBlob('robin'));
  const row = srv.db.get('SELECT hash FROM recovery WHERE user = ?', user);
  for (const part of row.hash.split('$')) {
    const b = Buffer.concat([Buffer.from(part, 'base64'), Buffer.alloc(32)]).subarray(0, 32);
    await assert.rejects(openBackup(blob, new Uint8Array(b), user));
  }
  assert.equal((await openBackup(blob, await deriveBackupKey((await parseRecoveryKey(k2)).raw), user)).u, user);
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
  // Settings > Security offers it for the password too
  await A.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]').catch(() => {});
  await A.click('.layer-nav .row:has-text("Security")');
  await A.locator('.layer-body h1:has-text("Security")').waitFor();
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

// v0.13 review: after "Forgot your password?" on a browser that must still be added, the new key waits two
// minutes for encryption, then the app says the encrypted history still uses the previous key, and offers a
// key that does both once encryption is unlocked.
test('one key: when encryption isn’t ready in time, Home says the encrypted history still uses the previous key', async () => {
  const D1 = await newPage('tomasz');
  await signIn(D1, 'tomasz', PASSWORD);
  await turnOn(D1);
  await D1.evaluate(() => { window.snug.S.ui.view = { type: 'home' }; window.snug.emit(); });
  await D1.locator('#rk-e2-later').click();
  await D1.locator('#rk-remind-go').click();
  await D1.locator('#rk-key').waitFor();
  const k1 = await keyText(D1);
  await D1.fill('#rk-last', k1.slice(-4));
  await D1.click('#rk-saved');
  await D1.fill('#rk-pw', PASSWORD);
  await D1.click('#rk-pw-go');
  await D1.locator('.toast:has-text("also opens your encrypted history")').waitFor();
  await D1.context().close();
  // A new browser, with a clock the test moves: "Forgot your password?" with k1, then k2.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const D2 = await ctx.newPage();
  D2.setDefaultTimeout(15000);
  D2.on('pageerror', (e) => errors.push(`tomasz-new: ${e.message}`));
  await D2.clock.install();
  await D2.goto(url);
  await D2.waitForSelector('.auth-form');
  await D2.click('#auth-forgot');
  await D2.fill('#rk-handle', 'tomasz');
  await D2.fill('#rk-key-in', k1);
  await D2.click('#rk-check');
  const pw2 = 'a new kiln door';
  await D2.fill('#rk-new-pass', pw2);
  await D2.click('#rk-set-pass');
  await D2.locator('#rk-key').waitFor();
  const k2 = await keyText(D2);
  const b1 = backupBlob('tomasz');
  await D2.fill('#rk-last', k2.slice(-4));
  await D2.click('#rk-saved');
  await D2.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(D2, 'new-device');
  await D2.clock.fastForward('02:01');
  await D2.locator('.toast:has-text("still opens with your previous recovery key")').waitFor();
  assert.equal(backupBlob('tomasz'), b1, 'the backup is still under k1');
  await D2.waitForFunction(() => window.snug?.S.conn.socket === 'open' && window.snug.e2ee.E2.status === 'new-device'); // the jump may drop the socket
  // The browser is added with k1 (it still opens the backup); Home then offers a key that does both.
  await dialog(D2).locator('button:has-text("Use my recovery key")').click();
  await dialog(D2).locator('#e2-rk-in').fill(k1);
  await dialog(D2).locator('button:has-text("Use recovery key")').click();
  await dialog(D2).locator('h2:has-text("Encryption is back on this device")').waitFor();
  await dialog(D2).locator('button:has-text("Done")').click();
  await waitStatus(D2, 'ready');
  await D2.evaluate(() => { window.snug.S.ui.view = { type: 'home' }; window.snug.emit(); });
  // (the clock jump reconnected the socket, and its second hello can leave an "Add this browser" prompt behind)
  await D2.waitForTimeout(500);
  if (await dialog(D2).locator('button:has-text("Not now")').count()) await dialog(D2).locator('button:has-text("Not now")').click();
  await D2.locator('#rk-apart-go').click();
  await D2.locator('#rk-key').waitFor();
  const k3 = await keyText(D2);
  await D2.fill('#rk-last', k3.slice(-4));
  await D2.click('#rk-saved');
  await D2.locator('#rk-pw, .toast:has-text("also opens your encrypted history")').first().waitFor(); // a password, unless the sign-in was fresh enough
  if (await D2.locator('#rk-pw').count()) { await D2.fill('#rk-pw', pw2); await D2.click('#rk-pw-go'); }
  await D2.locator('.toast:has-text("also opens your encrypted history")').waitFor();
  await D2.locator('.rk-apart').waitFor({ state: 'detached' });
  assert.notEqual(backupBlob('tomasz'), b1);
  await ctx.close();
});
