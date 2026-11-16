// This device's copy of messages in a browser (0.14, js/store.js): "Keep a copy of messages on this device"
// in Settings > Your data. On (the default) the copy is in localStorage, as before, and Settings says browser
// storage isn't protected; off, nothing is kept after the tab closes and what was kept is deleted.
// (The desktop app's sealed copy is checked in desktop/test.js; the sealing itself in logic-storage.)
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-storage-'));
let srv, browser, url;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv?.close(); rmSync(dir, { recursive: true, force: true }); });
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

const copyKeys = (page) => page.evaluate(() => ['snug.cache', 'snug.drafts', 'snug.reply', 'snug.ops', 'snug.draftFiles'].filter((k) => localStorage.getItem(k) != null));

test('browser: the copy is kept by default and Settings says browser storage isn’t protected; off keeps it in this tab only', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.fill('#auth-handle', 'robin');
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  const room = await page.evaluate(() => Object.keys(window.snug.S.rooms)[0]);
  await page.evaluate((r) => { window.snug.S.drafts[r] = 'a draft kept in this browser'; window.snug.emit(); }, room);
  await page.waitForFunction(() => localStorage.getItem('snug.cache') && (localStorage.getItem('snug.drafts') || '').includes('a draft kept'));
  // Settings > Your data: on, with the honest line about browser storage.
  await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Your data")');
  const row = page.locator('.set-row:has-text("Keep a copy of messages on this device")');
  await row.getByText(/Browser storage isn’t protected/).waitFor();
  assert.equal(await row.locator('[role=switch]').getAttribute('aria-checked'), 'true', 'on by default');
  // Off: what was kept is deleted at once, and nothing is written after.
  await row.locator('[role=switch]').click();
  assert.equal(await row.locator('[role=switch]').getAttribute('aria-checked'), 'false');
  assert.deepEqual(await copyKeys(page), []);
  await page.evaluate((r) => { window.snug.S.drafts[r] = 'a draft only in this tab'; window.snug.emit(); }, room);
  await page.waitForTimeout(2600);
  assert.deepEqual(await copyKeys(page), [], 'nothing written while it is off');
  // After a reload, nothing came back from the device (the server's messages still load).
  await page.reload();
  await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  assert.equal(await page.evaluate((r) => window.snug.S.drafts[r] || null, room), null);
  assert.ok(await page.evaluate(() => Object.keys(window.snug.S.rooms).length > 0));
  assert.deepEqual(await copyKeys(page), []);
  // On again: kept again.
  await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Your data")');
  await page.locator('.set-row:has-text("Keep a copy of messages on this device") [role=switch]').click();
  await page.waitForFunction(() => localStorage.getItem('snug.cache'));
  await ctx.close();
});
