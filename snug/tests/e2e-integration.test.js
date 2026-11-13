// Settings and features from every track fitting together, driven in Chromium
// against the real server with the seeded data (Robin owns Kiln & Co.).
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-integration-'));
let srv, browser, url;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 800 }, path = '/' } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url + path);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector(viewport.width < 760 ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
async function openPlace(page, house) {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function houseSettings(page) {
  await openPlace(page, 'Kiln & Co.');
  await page.click('.nav .ctx-house');
  await page.click('.menu-item:has-text("House settings")');
  await page.locator('.layer-body h1').waitFor();
}
const navText = (page) => page.locator('.layer-nav').evaluate((n) => [...n.querySelectorAll('.layer-sec, .row')].map((x) => (x.classList.contains('layer-sec') ? `# ${x.textContent.trim()}` : x.textContent.trim())));

test('settings: one structure in sections with a search; each room’s pace and size on Rooms and access; changes from every track reach the house log', async () => {
  const robin = await person('robin');
  // Personal settings: two sections, every page in one of them.
  await robin.click('.me-row [aria-label="Settings"]');
  await robin.locator('.layer-body h1').waitFor();
  assert.deepEqual(await navText(robin), [
    '# You', 'Profile', 'Account and security', 'Privacy and safety', 'Your data',
    '# App', 'Notifications', 'Voice and video', 'Appearance', 'Accessibility', 'Streamer mode', 'Keyboard',
  ]);
  // Contrast and motion have one home, on Accessibility.
  await robin.click('.layer-nav .row:has-text("Appearance")');
  assert.equal(await robin.locator('.layer-body .seg[aria-label="Contrast"]').count(), 0);
  await robin.click('.layer-nav .row:has-text("Accessibility")');
  await robin.locator('.layer-body .seg[aria-label="Contrast"]').waitFor();
  await robin.locator('.layer-body .seg[aria-label="Motion"]').waitFor();
  // The search finds pages by what is on them, and keeps their section.
  await robin.fill('.layer-nav input[type=search]', 'two factor');
  assert.deepEqual(await navText(robin), ['# You', 'Account and security']);
  await robin.fill('.layer-nav input[type=search]', 'zzzz');
  await robin.locator('.layer-nav:has-text("No setting called")').waitFor();
  await robin.keyboard.press('Escape');
  await robin.locator('.layer').waitFor({ state: 'detached' });

  // House settings: sections, and Newcomers holds the welcome too.
  await houseSettings(robin);
  const house = await navText(robin);
  assert.deepEqual(house.filter((x) => x.startsWith('# ')), ['# House', '# Rooms and newcomers', '# Moderation', '# Owners']);
  assert.ok(!house.includes('Welcome'), 'one page for newcomers');
  await robin.click('.layer-nav .row:has-text("Newcomers")');
  await robin.locator('.layer-body select[aria-label="Role for newcomers"]').waitFor();
  await robin.locator('.layer-body textarea[aria-label="Welcome text"]').waitFor();
  // Slowmode and voice room size live with each room.
  await robin.fill('.layer-nav input[type=search]', 'slowmode');
  assert.ok((await navText(robin)).includes('Rooms and access'));
  await robin.fill('.layer-nav input[type=search]', '');
  await robin.click('.layer-nav .row:has-text("Rooms and access")');
  await robin.selectOption('select[aria-label="Slowmode in Glaze lab"]', '30');
  await robin.waitForFunction(() => window.snug.S.rooms.k_glaze.slowmode === 30);
  await robin.selectOption('select[aria-label="Slowmode in Glaze lab"]', '0');
  await robin.selectOption('select[aria-label="User limit for Wheel room"]', '6');
  await robin.waitForFunction(() => Object.values(window.snug.S.rooms).find((r) => r.name === 'Wheel room')?.limit === 6);
  // The log has them, written by voice options and safety alike.
  await robin.click('.layer-nav .row:has-text("House log")');
  await robin.locator('.safe-log-row:has-text("changed the user limit or quality of Wheel room")').waitFor();
  await robin.locator('.safe-log-row:has-text("turned off slowmode in Glaze lab")').waitFor();
  await robin.keyboard.press('Escape');
  await robin.context().close();
});

test('settings on a phone: the search and every section stay reachable, with 44px targets and no sideways scroll', async () => {
  const robin = await person('robin', { viewport: { width: 390, height: 844 } });
  await robin.evaluate(() => import('/js/views/settings.js').then((m) => import('/js/store.js').then((s) => s.openLayer({ C: m.HouseSettings, props: { house: 'kiln' } }))));
  await robin.locator('.layer-body h1').waitFor();
  const search = robin.locator('.layer-nav input[type=search]');
  assert.equal(await search.isVisible(), true);
  assert.ok((await search.boundingBox()).height >= 44);
  for (const box of await robin.locator('.layer-nav .row').evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height))) assert.ok(box >= 44, `tab height ${box}`);
  await search.fill('bans');
  await robin.click('.layer-nav .row:has-text("Bans")');
  await robin.locator('.layer-body h1:has-text("Bans")').waitFor();
  await search.fill('');
  await robin.click('.layer-nav .row:has-text("Rooms and access")');
  await robin.locator('select[aria-label="Slowmode in Glaze lab"]').waitFor();
  assert.ok((await robin.locator('select[aria-label="Slowmode in Glaze lab"]').boundingBox()).height >= 44);
  assert.equal(await robin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  await robin.context().close();
});
