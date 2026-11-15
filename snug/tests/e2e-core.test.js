// Snug 0.12 core track in Chromium against the real server and the sample
// data: close matches in search, disappearing messages, the offline app
// shell, drafts that keep their reply, offline reactions and edits, the
// connection page, and long conversations.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-core-'));
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
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 800 }, phone = false, ctx: given } = {}) {
  const ctx = given || await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|net::ERR/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector(phone ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
async function openPlace(page, house) {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function go(page, name, house = 'Kiln & Co.') {
  await openPlace(page, house);
  await page.click(`.nav .row:has-text("${name}")`);
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
const say = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };
const msg = (page, text) => page.locator('.main .msg', { hasText: text });

test('search: a misspelt word shows close matches, and says so', async () => {
  const page = await person('robin');
  await page.evaluate(() => { window.snug.S.ui.view = { type: 'search', q: 'pyrometr' }; window.snug.emit(); });
  await page.locator('.search-results .item', { hasText: 'pyrometer' }).first().waitFor();
  assert.match(await page.locator('.search-close').innerText(), /close matches/i);
  // An exact word: no such note, and the list is in order of relevance.
  await page.evaluate(() => { window.snug.S.ui.view = { type: 'search', q: 'pyrometer' }; window.snug.emit(); });
  await page.locator('.search-results .view-note', { hasText: 'best matches first' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.search-close'));
  assert.ok(await page.locator('.search-results .item', { hasText: 'pyrometer' }).count() >= 1);
  await page.context().close();
});
