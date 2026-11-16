// Localization in Chromium against the real server: Settings > Appearance >
// Language switches the app to Lithuanian without a reload, the choice follows
// the account and survives a reload, the sign-in screen keeps it after signing
// out, and a browser set to Lithuanian gets a Lithuanian sign-in screen.
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

test('Settings > Appearance > Language: Lietuvių at once, kept on reload and on the account, then back to English', async () => {
  const p = await page();
  assert.equal(await lang(p), 'en');
  await signIn(p, 'robin');
  await openSettings(p);
  await page_(p, 'Appearance');
  const select = p.locator('select#set-lang');
  assert.equal(await select.inputValue(), 'auto', 'Match my browser is the default');
  assert.deepEqual(await select.locator('option').allInnerTexts(), ['Match my browser', 'English', 'Lietuvių']);
  await select.selectOption('lt');
  // No reload: the open page, the settings list and the app behind it change.
  await p.waitForFunction(() => document.documentElement.lang === 'lt');
  assert.equal(await text(p, '.layer-body h1'), 'Išvaizda');
  assert.equal(await text(p, '.layer-nav .row.sel'), 'Išvaizda');
  assert.ok(await p.locator('.layer-nav .row:has-text("Pranešimai")').count(), 'other page names too');
  assert.equal(await p.locator('select#set-lang').inputValue(), 'lt');
  assert.deepEqual(await p.locator('select#set-lang option').allInnerTexts(), ['Kaip naršyklėje', 'English', 'Lietuvių'], 'each language keeps its own name');
  await p.keyboard.press('Escape');
  await p.locator('.layer').waitFor({ state: 'detached' });
  assert.equal(await p.locator('.me-row .ib:last-child').getAttribute('aria-label'), 'Nustatymai');
  assert.match(await text(p, '.rail-home .sr'), /^Pradžia/);
  assert.match(await text(p, '.rail .rail-add .sr'), /^Įkurk namus arba prisijunk/);
  // The account has it (the server stores it with the other settings).
  for (let i = 0; i < 50 && prefsOf('robin').lang !== 'lt'; i++) await p.waitForTimeout(100);
  assert.equal(prefsOf('robin').lang, 'lt');
  // A reload keeps it, from the first paint.
  await p.reload();
  await p.waitForSelector('.nav');
  await p.waitForFunction(() => window.snug.S.conn.socket === 'open');
  assert.equal(await lang(p), 'lt');
  assert.match(await text(p, '.rail-home .sr'), /^Pradžia/);
  // A room's composer, and a thread opened from a message, in Lithuanian.
  await p.click('.rail-house:has-text("Kiln & Co.")');
  await p.click('.nav .row:has-text("Glaze lab")');
  const box = p.locator('.main .composer textarea');
  await box.waitFor();
  assert.equal(await box.getAttribute('placeholder'), 'Žinutė: #Glaze lab');
  assert.equal(await p.locator('.main .composer .ib.send').getAttribute('aria-label'), 'Siųsti žinutę');
  await box.focus();
  await p.keyboard.press('Shift+Tab');
  await p.keyboard.press('t');
  await p.locator('.pane .composer textarea').waitFor();
  assert.equal(await p.locator('.pane .composer textarea').getAttribute('placeholder'), 'Atsakyk gijoje');
  await p.keyboard.press('Escape');
  // And back to English.
  await openSettings(p);
  await page_(p, 'Išvaizda');
  await p.locator('select#set-lang').selectOption('en');
  await p.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await text(p, '.layer-body h1'), 'Appearance');
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.me-row [aria-label="Settings"]').count(), 1);
  assert.match(await text(p, '.rail-home .sr'), /^Home/);
  for (let i = 0; i < 50 && prefsOf('robin').lang !== 'en'; i++) await p.waitForTimeout(100);
  assert.equal(prefsOf('robin').lang, 'en');
  await p.context().close();
});

test('signing out in Lithuanian: the toast is Lithuanian and the sign-in screen stays Lithuanian on an English browser', async () => {
  const p = await page();
  await signIn(p, 'ines');
  await openSettings(p);
  await page_(p, 'Appearance');
  await p.locator('select#set-lang').selectOption('lt');
  await p.waitForFunction(() => document.documentElement.lang === 'lt');
  for (let i = 0; i < 50 && prefsOf('ines').lang !== 'lt'; i++) await p.waitForTimeout(100); // the account has it before signing out
  await page_(p, 'Paskyra ir saugumas');
  await p.click('.set-row:has-text("Sign out on this device") button'); // the Account page itself isn't translated yet
  await p.waitForSelector('.auth-form');
  assert.match(await text(p, '.toast'), /Tu atsijungei/);
  assert.equal(await lang(p), 'lt');
  assert.equal(await text(p, '#auth-title'), 'Prisijunk prie Snug');
  // Signing back in: the account's choice, Lithuanian.
  await signIn(p, 'ines');
  assert.equal(await lang(p), 'lt');
  // Reset for the other tests: ines back to English.
  await openSettings(p);
  await page_(p, 'Išvaizda');
  await p.locator('select#set-lang').selectOption('en');
  await p.waitForFunction(() => document.documentElement.lang === 'en');
  await p.context().close();
});

test('a browser set to Lithuanian gets a Lithuanian sign-in screen; one set to English gets English', async () => {
  const p = await page('lt-LT');
  assert.equal(await lang(p), 'lt');
  assert.equal(await text(p, '#auth-title'), 'Prisijunk prie Snug');
  assert.equal(await text(p, 'label[for="auth-handle"]'), 'Naudotojo vardas');
  assert.equal(await text(p, 'label[for="auth-pass"]'), 'Slaptažodis');
  assert.equal(await text(p, '.auth-form button[type=submit]'), 'Prisijungti');
  // Problems under their fields are Lithuanian too.
  await p.click('.auth-form button[type=submit]');
  assert.equal(await text(p, '#auth-handle-err'), 'Įrašyk savo naudotojo vardą.');
  assert.equal(await text(p, '#auth-password-err'), 'Įrašyk slaptažodį.');
  // Creating an account: the heading and its rules.
  await p.click('.auth-swap .auth-link');
  assert.equal(await text(p, '#auth-title'), 'Įsikurk kaip namie');
  assert.equal(await text(p, '.auth-form button[type=submit]'), 'Sukurti paskyrą');
  await p.click('.auth-form button[type=submit]');
  assert.equal(await text(p, '#auth-handle-err'), 'Pasirink naudotojo vardą.');
  await p.context().close();

  const e = await page('en-US');
  assert.equal(await lang(e), 'en');
  assert.equal(await text(e, '#auth-title'), 'Sign in to Snug');
  assert.equal(await text(e, '.auth-form button[type=submit]'), 'Sign in');
  await e.context().close();
});

test('a Lithuanian browser signing in: Messages and the house dialog are Lithuanian', async () => {
  const p = await page('lt-LT');
  await signIn(p, 'bex');
  assert.equal(await lang(p), 'lt');
  await p.click('.rail .rail-add');
  await p.locator('.add-house').waitFor();
  assert.equal(await text(p, '#add-house-title'), 'Įkurk namus');
  await p.click('.add-house .seg button:nth-child(2)');
  assert.equal(await text(p, '#add-house-title'), 'Prisijunk prie namų');
  await p.fill('#join-invite', 'not a code at all');
  await p.click('.add-house button[type=submit]');
  assert.match(await text(p, '#join-invite-msg'), /Tai nepanašu į kvietimą/);
  await p.fill('#join-invite', 'nosuchcode1');
  await p.click('.add-house button[type=submit]');
  await p.locator('.join-bad').waitFor();
  assert.equal(await text(p, '.join-bad h2'), 'Šis kvietimas neveikia');
  await p.context().close();
});
