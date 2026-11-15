// The install page (docs/install.html) in Chromium against the real server: it renders with Snug's styles
// under its own strict policy (no CSP violation, no page error), reads on a phone without sideways scrolling,
// follows light and dark, its in-page links land, and a browser user finds it from Settings > Desktop app.
//   node --test tests/e2e-install.test.js
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-install-'));
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
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors and policy violations'); });

async function open(path, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...ctxOpts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  watch(page);
  // Report-only violations fire this event too; the docs policy is enforced, so any is a blocked resource.
  // (A failed load is caught from the response below, except the app's /api/ calls before sign-in.)
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(url + path);
  return page;
}
function watch(page) {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/')) errors.push(`${r.status()} ${r.url()}`); });
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('desktop: styled by Snug\'s stylesheets under the docs policy, nothing blocked, every in-page link lands', async () => {
  const page = await open('/docs/install.html');
  assert.equal(await page.title(), 'Install Snug on Windows or Mac');
  await page.evaluate(() => document.fonts.ready);
  const look = await page.evaluate(() => ({
    font: getComputedStyle(document.body).fontFamily,
    bg: getComputedStyle(document.documentElement).backgroundColor,
    pre: getComputedStyle(document.querySelector('pre')).fontFamily,
    logo: document.querySelector('header img').naturalWidth,
  }));
  assert.match(look.font, /Inter/, 'tokens.css applied');
  assert.notEqual(look.bg, 'rgba(0, 0, 0, 0)', 'the page has the Snug surface');
  assert.match(look.pre, /Atkinson Hyperlegible Mono/);
  assert.ok(look.logo > 0, 'the logo loaded');
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.equal(await page.locator('h1').count(), 1);
  for (const href of await page.locator('nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
    assert.equal(await page.locator(href).count(), 1, `${href} exists`);
  }
  assert.ok(await noSideScroll(page));
  await page.context().close();
});

test('phone (390 px): readable without sideways scrolling, commands wrap, the file table stacks', async () => {
  const page = await open('/docs/install.html', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  assert.ok(await noSideScroll(page), 'no horizontal page scroll');
  const box = await page.locator('.files tbody tr').first().boundingBox();
  assert.ok(box.width <= 390 - 16, 'the table fits inside the gutter');
  const size = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('p')).fontSize));
  assert.ok(size >= 15, `body text ${size}px`);
  await page.context().close();
});

test('light and dark follow the device', async () => {
  const bg = async (scheme) => {
    const page = await open('/docs/install.html', { colorScheme: scheme });
    const c = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    await page.context().close();
    return c;
  };
  assert.notEqual(await bg('light'), await bg('dark'));
});

test('a browser user finds the install page in Settings > Desktop app', async () => {
  const page = await open('/');
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', 'robin');
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector('.nav');
  await page.click('.me-row [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Desktop app")');
  const link = page.locator('.layer-body a[href="/docs/install.html"]');
  await link.waitFor();
  assert.match(await page.locator('.layer-body').innerText(), /Windows and Mac/);
  const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  watch(tab);
  await tab.waitForLoadState();
  assert.equal(await tab.title(), 'Install Snug on Windows or Mac');
  await page.context().close();
});
