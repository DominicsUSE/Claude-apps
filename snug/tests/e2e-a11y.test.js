// An automated accessibility check (axe-core 4.10.3, tests/helpers/axe.min.js,
// MPL-2.0, used by this test only, never shipped in the app) on the main
// screens, in Chromium against the real server with the seeded data: signing
// in, Home, a room, Settings, the quick switcher and the phone layout. Serious
// and critical problems fail; axe can't judge everything (meaning, order,
// wording), so this is a floor, not a promise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const AXE = readFileSync(new URL('./helpers/axe.min.js', import.meta.url), 'utf8');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-a11y-'));
let srv, browser, url;

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());

async function open({ handle = null, phone = false } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' }
    : { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  if (handle) {
    await page.fill('#auth-handle', handle);
    await page.fill('#auth-pass', PASSWORD);
    await page.click('.auth-form button[type=submit]');
    await page.waitForSelector(phone ? '.tabs' : '.nav');
    await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  }
  return page;
}

// axe on what is on screen now; serious and critical problems, one line each.
async function audit(page, where) {
  await page.waitForTimeout(300); // transitions settle (reduced motion makes them short)
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE);
  const res = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const lines = bad.flatMap((v) => v.nodes.slice(0, 4).map((n) => `${where}: ${v.id} (${v.impact}) ${n.target.join(' ')}: ${n.failureSummary.split('\n').slice(1, 2).join('').trim()}`));
  return lines;
}

test('signing in and creating an account', async () => {
  const page = await open();
  const found = await audit(page, 'sign-in');
  await page.click('.auth-swap .auth-link');
  await page.waitForSelector('#auth-name');
  found.push(...await audit(page, 'sign-up'));
  await page.context().close();
  assert.deepEqual(found, []);
});

test('Home, a room, Settings and the quick switcher', async () => {
  const page = await open({ handle: 'robin' });
  const found = await audit(page, 'Home');
  await page.click('.rail-house:has-text("Kiln & Co.")');
  await page.click('.nav .row:has-text("Glaze lab")');
  await page.locator('.main .msg').first().waitFor();
  found.push(...await audit(page, 'room'));
  await page.click('.me-row [aria-label="Settings"]');
  await page.locator('.layer-body h1').waitFor();
  found.push(...await audit(page, 'Settings'));
  await page.click('.layer-nav .row:has-text("Appearance")');
  await page.locator('.layer-body h1:has-text("Appearance")').waitFor();
  found.push(...await audit(page, 'Settings > Appearance'));
  await page.keyboard.press('Escape');
  await page.locator('.layer').waitFor({ state: 'detached' });
  await page.keyboard.press('Control+k');
  await page.locator('.quick input').fill('gla');
  found.push(...await audit(page, 'quick switcher'));
  await page.context().close();
  assert.deepEqual(found, []);
});

test('the phone layout: Home and a room', async () => {
  const page = await open({ handle: 'robin', phone: true });
  const found = await audit(page, 'phone Home');
  await page.click('.home-house:has-text("Kiln & Co.")');
  await page.click('.screen.push .row:has-text("Glaze lab")');
  await page.locator('.screen.push .composer textarea').waitFor();
  found.push(...await audit(page, 'phone room'));
  await page.context().close();
  assert.deepEqual(found, []);
});
