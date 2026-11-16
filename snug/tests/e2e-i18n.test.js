// English only (0.13): Snug no longer ships the Lithuanian translation or the
// Language picker. A browser set to Lithuanian, a device that kept
// snug.lang = 'lt' and an account whose settings hold lang: 'lt' (all from
// 0.12.0) get English with no errors, and a 0.12.0 client may still send it.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-i18n-'));
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
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function page(locale = 'en-US') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await p.goto(url);
  await p.waitForSelector('.auth-form');
  return p;
}
async function signIn(p, handle) {
  await p.fill('#auth-handle', handle);
  await p.fill('#auth-pass', PASSWORD);
  await p.click('.auth-form button[type=submit]');
  await p.waitForSelector('.nav');
  await p.waitForFunction(() => window.snug.S.conn.socket === 'open');
}
const lang = (p) => p.evaluate(() => document.documentElement.lang);
const idOf = (handle) => srv.db.get('SELECT id FROM users WHERE handle = ?', handle).id;
const prefsOf = (handle) => JSON.parse(srv.db.get('SELECT prefs FROM user_prefs WHERE user = ?', idOf(handle))?.prefs || '{}');
const text = (p, sel) => p.locator(sel).first().innerText();
// The gear under your name, whatever language its label is in.
const openSettings = (p) => p.click('.me-row .ib:last-child');
async function page_(p, label) {
  await p.click(`.layer-nav .row:has-text("${label}")`);
  await p.locator('.layer-body h1').waitFor();
}

test('Settings > Appearance has no Language row', async () => {
  const p = await page();
  assert.equal(await lang(p), 'en');
  await signIn(p, 'robin');
  await openSettings(p);
  await page_(p, 'Appearance');
  assert.equal(await text(p, '.layer-body h1'), 'Appearance');
  assert.equal(await p.locator('select#set-lang').count(), 0);
  assert.equal(await p.locator('.set-row:has-text("Language")').count(), 0);
  // The clock follows the browser's own English now, and says so.
  assert.equal(await p.locator('.seg button:has-text("Match language")').count(), 0);
  assert.equal(await p.locator('.seg button:has-text("Match my browser")').count(), 1);
  await p.context().close();
});

test('a browser set to Lithuanian gets the English sign-in screen', async () => {
  const p = await page('lt-LT');
  assert.equal(await lang(p), 'en');
  assert.equal(await text(p, '#auth-title'), 'Sign in to Snug');
  assert.equal(await text(p, 'label[for="auth-handle"]'), 'Username');
  assert.equal(await text(p, '.auth-form button[type=submit]'), 'Sign in');
  await p.click('.auth-form button[type=submit]');
  assert.equal(await text(p, '#auth-handle-err'), 'Type your username.');
  await p.context().close();
});

test('a device that kept snug.lang = lt (0.12.0) loads in English and forgets it', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'lt-LT' });
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('snug.lang', 'lt'); sessionStorage.setItem('seeded', '1'); } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForSelector('.auth-form');
  assert.equal(await lang(p), 'en');
  assert.equal(await text(p, '#auth-title'), 'Sign in to Snug');
  assert.equal(await p.evaluate(() => localStorage.getItem('snug.lang')), null, 'the old choice is cleared');
  await ctx.close();
});

test('an account whose settings hold lang: lt signs in, in English, with no errors; a 0.12.0 client may still send it', async () => {
  srv.db.run("INSERT INTO user_prefs (user, prefs, updated) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET prefs = excluded.prefs", idOf('ines'), JSON.stringify({ lang: 'lt' }), Date.now());
  const p = await page('lt-LT');
  await signIn(p, 'ines');
  assert.equal(await lang(p), 'en');
  assert.equal(await p.locator('.me-row [aria-label="Settings"]').count(), 1);
  assert.match(await text(p, '.rail-home .sr'), /^Home/);
  assert.notEqual(await p.evaluate(() => window.snug.S.prefs.lang), 'lt');
  // What a 0.12.0 client sends when someone picks Lietuvių there: accepted, kept as English.
  const r = await p.evaluate(() => import('/js/server.js').then((m) => m.call('prefs.set', { prefs: { lang: 'lt' } })).then((x) => x.prefs.lang, (e) => `failed: ${e.message}`));
  assert.equal(r, 'auto');
  assert.equal(prefsOf('ines').lang, 'auto');
  await p.context().close();
});
