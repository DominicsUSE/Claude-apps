// Account, profile, appearance and security, driven in Chromium against the
// real server with separate browser sessions (seeded data: Robin and Ines
// share Kiln & Co. and are friends; Bex, Priya and Jonas are other people).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { hotp, stepAt, unbase32 } from '../server/account.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-account-'));
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

async function open(handle, { viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  return page;
}
async function person(handle, opts) {
  const page = await open(handle, opts);
  await page.waitForSelector(opts?.viewport?.width < 760 ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
const close = (page) => page.context().close();
const attr = (page, name) => page.evaluate((n) => document.documentElement.getAttribute(n), name);
async function settings(page, label) {
  await page.click('.me-row [aria-label="Settings"]');
  await page.click(`.layer-nav .row:has-text("${label}")`);
  await page.locator('.layer-body h1').waitFor();
}
const idOf = (handle) => srv.db.get('SELECT id FROM users WHERE handle = ?', handle).id;
const prefsOf = (handle) => JSON.parse(srv.db.get('SELECT prefs FROM user_prefs WHERE user = ?', idOf(handle))?.prefs || '{}');

test('appearance: theme, compact display, text size and font apply at once and follow the person to another browser', async () => {
  const a = await person('robin');
  await settings(a, 'Appearance');
  await a.click('.ap-card[data-theme-id="midnight"]'); // theme cards (js/views/appearance.js)
  assert.equal(await attr(a, 'data-theme'), 'midnight');
  assert.equal(await a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim().toUpperCase()), '#000000', 'true black');
  assert.equal(await a.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(0, 0, 0)');
  assert.equal(await a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim().toUpperCase()), '#F4F1ED', 'light text even on a device set to light');
  await a.click('.seg[aria-label="Message display"] button:has-text("Compact")');
  assert.equal(await attr(a, 'data-display'), 'compact');
  await a.locator('#acc-font').fill('18');
  await a.waitForFunction(() => document.documentElement.style.fontSize === '18px');
  await a.click('.seg[aria-label="Clock"] button:has-text("24-hour")');
  await a.click('.seg[aria-label="Font"] button:has-text("Atkinson Hyperlegible")'); // fonts are on Appearance
  assert.equal(await attr(a, 'data-font'), 'hyperlegible');
  assert.match(await a.evaluate(() => getComputedStyle(document.body).fontFamily), /Atkinson Hyperlegible/);
  // Stored on the server, for this person.
  await a.waitForFunction(() => true);
  for (let i = 0; i < 40 && prefsOf('robin').font !== 'hyperlegible'; i++) await a.waitForTimeout(100);
  assert.deepEqual(
    (({ theme, display, fontScale, clock, font }) => ({ theme, display, fontScale, clock, font }))(prefsOf('robin')),
    { theme: 'midnight', display: 'compact', fontScale: 18, clock: '24', font: 'hyperlegible' },
  );
  // Another browser (no shared storage) opens with the same look.
  const b = await person('robin');
  await b.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'midnight');
  assert.equal(await attr(b, 'data-display'), 'compact');
  assert.equal(await attr(b, 'data-font'), 'hyperlegible');
  assert.equal(await b.evaluate(() => document.documentElement.style.fontSize), '18px');
  // Compact messages: no picture beside them, name on the line.
  await b.click('.rail-house:has-text("Kiln & Co.")');
  await b.click('.nav .row:has-text("Glaze lab")');
  await b.locator('.main .msg').first().waitFor();
  assert.equal(await b.locator('.main .msg .msg-gutter').first().isVisible(), false);
  assert.match(await b.locator('.main .msg-time').first().innerText(), /^\d{2}:\d{2}$/, '24-hour clock');
  // A change on the second browser reaches the first at once, without a reload.
  await settings(b, 'Appearance');
  await b.click('.ap-card[data-theme-id="light"]');
  await a.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  // Back to defaults for the other tests.
  await b.click('.seg[aria-label="Message display"] button:has-text("Cozy")');
  await b.click('.ap-card[data-theme-id="system"]');
  await b.locator('#acc-font').fill('16');
  await a.waitForFunction(() => !document.documentElement.getAttribute('data-display') && !document.documentElement.style.fontSize);
  await close(a); await close(b);
});

test('quick switcher: Ctrl+K finds places by fuzzy search, offers recent ones first and runs actions; Ctrl+/ lists shortcuts', async () => {
  const a = await person('robin');
  await a.keyboard.press('Control+k');
  await a.locator('.quick input').fill('glzlb');
  await a.locator('.quick .menu-item.act:has-text("Glaze lab")').waitFor();
  await a.keyboard.press('Enter');
  await a.locator('.main .bar-title:has-text("Glaze lab")').waitFor();
  await a.keyboard.press('Control+k');
  await a.locator('.quick input').fill('firing');
  await a.keyboard.press('Enter');
  await a.locator('.main .bar-title:has-text("Firing schedule")').waitFor();
  await a.keyboard.press('Control+k');
  await a.locator('.quick input').fill('front desk');
  await a.keyboard.press('Enter');
  await a.locator('.main .bar-title:has-text("Front desk")').waitFor();
  // Nothing typed: the places you were just in come first, newest first (not the one you're in).
  await a.keyboard.press('Control+k');
  const first = await a.locator('.quick .menu-item').allInnerTexts();
  assert.match(first[0], /Firing schedule/);
  assert.match(first[1], /Glaze lab/);
  // Actions: mark read, themes, presence.
  await a.locator('.quick input').fill('midnight');
  await a.locator('.quick .menu-item.act:has-text("Switch to midnight theme")').waitFor();
  await a.keyboard.press('Enter');
  assert.equal(await attr(a, 'data-theme'), 'midnight');
  await a.keyboard.press('Control+k');
  await a.locator('.quick input').fill('invisible');
  await a.locator('.quick .menu-item.act:has-text("Go invisible")').waitFor();
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => window.snug.S.users[window.snug.S.me].presence === 'offline');
  await a.keyboard.press('Control+k');
  await a.locator('.quick input').fill('mute this');
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => window.snug.S.rooms.k_firing?.notify === 'muted' || window.snug.S.rooms[window.snug.S.ui.view.id]?.notify === 'muted');
  // Ctrl+/ opens the shortcuts sheet; Esc closes it.
  await a.keyboard.press('Control+/');
  await a.locator('.modal h2:has-text("Keyboard shortcuts")').waitFor();
  assert.ok(await a.locator('.modal .acc-key-row:has-text("Streamer mode")').count());
  await a.keyboard.press('Escape');
  await a.locator('.modal').waitFor({ state: 'detached' });
  // Put things back.
  await a.evaluate(() => { window.snug.S.prefs.theme = 'system'; window.snug.emit(); });
  await a.keyboard.press('Control+k');
  await a.locator('.quick input').fill('around');
  await a.locator('.quick .menu-item.act:has-text("Set presence to Around")').waitFor();
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => window.snug.S.users[window.snug.S.me].presence === 'around');
  for (let i = 0; i < 30 && prefsOf('robin').theme; i++) await a.waitForTimeout(100);
  await close(a);
});

test('status: a custom status with an emoji, invisible and auto-idle, as a friend sees them', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  const rid = idOf('robin');
  await robin.click('.me-row .self');
  await robin.click('.me-pop .menu-item:has-text("Set a status")');
  await robin.locator('.modal input[aria-label="Status emoji"]').fill('🏺');
  await robin.locator('.modal input[aria-label="Status"]').fill('Trimming bowls');
  await robin.click('.modal .seg[aria-label="Clear after"] button:has-text("1 hour")');
  await robin.click('.modal button[type=submit]');
  await robin.locator('.modal').waitFor({ state: 'detached' });
  await robin.locator('.me-row .self-status:has-text("🏺")').waitFor();
  await robin.locator('.me-row .self-status:has-text("Trimming bowls")').waitFor();
  await ines.waitForFunction((id) => window.snug.S.users[id]?.statusEmoji === '🏺' && window.snug.S.users[id]?.status === 'Trimming bowls', rid);
  const until = await ines.evaluate((id) => window.snug.S.users[id].statusUntil, rid);
  assert.ok(until > Date.now() + 55 * 60_000 && until <= Date.now() + 61 * 60_000, 'clears in an hour');
  // Ines sees it on Robin's card, with the emoji.
  await ines.click('.rail-house:has-text("Kiln & Co.")');
  await ines.click('.nav .row:has-text("Glaze lab")');
  await ines.locator('.main .msg-name:has-text("Robin")').first().click();
  await ines.locator('.pcard .doing:has-text("🏺")').waitFor();
  await ines.keyboard.press('Escape');
  // Invisible: offline to Ines while still connected.
  await robin.click('.me-row .self');
  await robin.click('.me-pop .pres-opt:has-text("Offline")');
  await ines.waitForFunction((id) => window.snug.S.users[id]?.presence === 'offline', rid);
  assert.equal(await robin.evaluate(() => window.snug.S.conn.socket), 'open');
  // Around, then idle: Away to Ines, until Robin moves again.
  await robin.click('.me-row .self');
  await robin.click('.me-pop .pres-opt:has-text("Around")');
  await ines.waitForFunction((id) => window.snug.S.users[id]?.presence === 'around', rid);
  await robin.evaluate(() => window.snug.account.goIdle());
  await ines.waitForFunction((id) => window.snug.S.users[id]?.presence === 'away' && window.snug.S.users[id]?.idle, rid);
  await robin.mouse.click(5, 400);
  await ines.waitForFunction((id) => window.snug.S.users[id]?.presence === 'around', rid);
  // Clear the status from the same dialog.
  await robin.click('.me-row .self');
  await robin.click('.me-pop .menu-item:has-text("Change status")');
  await robin.click('.modal button:has-text("Clear status")');
  await ines.waitForFunction((id) => !window.snug.S.users[id]?.status && !window.snug.S.users[id]?.statusEmoji, rid);
  await close(robin); await close(ines);
});

test('two-factor: set up from a QR code made on the device; sign-in then needs a code, and a backup code works once', async () => {
  const bex = await person('bex');
  await settings(bex, 'Account and security');
  await bex.click('button:has-text("Set up")');
  await bex.locator('.modal svg.acc-qr').waitFor();
  assert.ok((await bex.locator('.modal svg.acc-qr path').getAttribute('d')).length > 500, 'a drawn QR code');
  const secret = (await bex.locator('.modal .acc-secret code').innerText()).replace(/\s/g, '');
  const key = unbase32(secret);
  await bex.locator('#tf-code').fill('000000' === hotp(key, stepAt(Date.now())) ? '111111' : '000000');
  assert.equal(await bex.locator('.modal button:has-text("Turn on")').isDisabled(), true, 'the password is needed too');
  await bex.locator('#tf-pw').fill(PASSWORD);
  await bex.click('.modal button:has-text("Turn on")');
  await bex.locator('.modal .err').waitFor();
  await bex.locator('#tf-code').fill(hotp(key, stepAt(Date.now())));
  await bex.click('.modal button:has-text("Turn on")');
  await bex.locator('.modal h2:has-text("Two-factor sign-in is on")').waitFor();
  const codes = await bex.locator('.modal .acc-code-list code').allInnerTexts();
  assert.equal(codes.length, 10);
  await bex.click('.modal button:has-text("I’ve saved them")');
  await bex.locator('.set-row:has-text("10 backup codes left")').waitFor();
  // A new browser: the password is not enough.
  const b = await open('bex');
  await b.locator('#auth-code').waitFor();
  assert.equal(await b.locator('.auth-form[hidden]').count(), 1, 'the password form steps aside');
  await b.locator('#auth-code').fill('123456');
  await b.click('.auth-form:not([hidden]) button[type=submit]');
  await b.locator('#auth-code-err').waitFor();
  await b.locator('#auth-code').fill(hotp(key, stepAt(Date.now()) + 1));
  await b.click('.auth-form:not([hidden]) button[type=submit]');
  await b.waitForSelector('.nav');
  // A third: a backup code, once.
  const c = await open('bex');
  await c.click('.auth-link:has-text("Use a backup code")');
  await c.locator('#auth-code').fill(codes[0]);
  await c.click('.auth-form:not([hidden]) button[type=submit]');
  await c.waitForSelector('.nav');
  const d = await open('bex');
  await d.click('.auth-link:has-text("Use a backup code")');
  await d.locator('#auth-code').fill(codes[0]);
  await d.click('.auth-form:not([hidden]) button[type=submit]');
  await d.locator('#auth-code-err').waitFor();
  // Turn it off again: password and a backup code.
  await bex.click('.set-row button:has-text("Turn off")');
  await bex.locator('#cf-pw').fill(PASSWORD);
  await bex.locator('#cf-code').fill(codes[1]);
  await bex.click('.modal button[type=submit]');
  await bex.locator('.set-row:has-text("Set up")').waitFor();
  for (const p of [bex, b, c, d]) await close(p);
});

test('devices: every signed-in browser is listed, and one can be signed out from another', async () => {
  const a = await person('priya');
  const other = await person('priya');
  await settings(a, 'Account and security');
  await a.locator('.acc-session').nth(1).waitFor();
  assert.equal(await a.locator('.acc-session').count(), 2);
  assert.equal(await a.locator('.acc-session .acc-tag:has-text("This device")').count(), 1);
  assert.match(await a.locator('.acc-session').first().innerText(), /Chrome on Linux/);
  await a.locator('.acc-session button:has-text("Sign out")').click();
  await other.locator('.auth-form').waitFor();
  await a.locator('.acc-session').nth(1).waitFor({ state: 'detached' });
  assert.equal(await a.locator('.acc-session').count(), 1);
  await close(a); await close(other);
});

test('profile: pronouns, a private note only you see, and streamer mode hiding usernames', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  await settings(robin, 'Profile');
  await robin.locator('input[aria-label="Pronouns"]').fill('he/him');
  await robin.locator('input[aria-label="Pronouns"]').press('Tab');
  await ines.waitForFunction((id) => window.snug.S.users[id]?.pronouns === 'he/him', idOf('robin'));
  await robin.keyboard.press('Escape');
  // Ines writes a note on Robin's card; it is still there after a reload, and Robin never gets it.
  await ines.click('.rail-house:has-text("Kiln & Co.")');
  await ines.click('.nav .row:has-text("Glaze lab")');
  await ines.locator('.main .msg-name:has-text("Robin")').first().click();
  await ines.locator('.pcard .acc-pronouns:has-text("he/him")').waitFor();
  await ines.locator('.pcard .acc-note textarea').fill('Owes me a kiln shelf');
  await ines.locator('.pcard .acc-note textarea').press('Tab');
  await ines.locator('.pcard .acc-note .hint:has-text("Saved")').waitFor();
  await ines.reload();
  await ines.waitForFunction(() => window.snug.S.conn.socket === 'open');
  assert.equal(await ines.evaluate((id) => window.snug.S.account.notes[id], idOf('robin')), 'Owes me a kiln shelf');
  assert.deepEqual(await robin.evaluate(() => window.snug.S.account.notes), {});
  // Streamer mode: Ctrl+Shift+S, and @usernames blur.
  await ines.click('.rail-house:has-text("Kiln & Co.")');
  await ines.click('.nav .row:has-text("Glaze lab")');
  await ines.keyboard.press('Control+Shift+S');
  assert.equal(await attr(ines, 'data-streamer'), '');
  await ines.locator('.main .msg-name:has-text("Robin")').first().click();
  assert.match(await ines.locator('.pcard-handle .secret').evaluate((el) => getComputedStyle(el).filter), /blur/);
  await ines.keyboard.press('Escape');
  await ines.keyboard.press('Control+Shift+S');
  assert.equal(await attr(ines, 'data-streamer'), null);
  await close(robin); await close(ines);
});

test('settings on a shared device: the next person never inherits the last one’s, and a change made offline survives reconnecting', async () => {
  const p = await person('jonas');
  await p.evaluate(() => { window.snug.S.prefs.keywords = ['jonas-secret']; window.snug.emit(); });
  for (let i = 0; i < 50 && !prefsOf('jonas').keywords; i++) await p.waitForTimeout(100);
  assert.deepEqual(prefsOf('jonas').keywords, ['jonas-secret']);
  // Jonas signs out; Priya signs in on the same browser for the first time.
  await settings(p, 'Account and security');
  await p.click('.set-row:has-text("Sign out on this device") button:text-is("Sign out")');
  await p.waitForSelector('.auth-form');
  assert.deepEqual(await p.evaluate(() => window.snug.S.prefs.keywords), [], 'signing out forgets them here');
  await p.fill('#auth-handle', 'priya');
  await p.fill('#auth-pass', PASSWORD);
  await p.click('.auth-form button[type=submit]');
  await p.waitForSelector('.nav');
  await p.waitForFunction(() => window.snug.S.conn.socket === 'open');
  await p.waitForTimeout(800); // longer than the settings upload waits
  assert.equal(prefsOf('priya').keywords, undefined, 'nothing of Jonas’s reached Priya’s account');
  assert.deepEqual(await p.evaluate(() => window.snug.S.prefs.keywords), []);
  // The server goes away; offline, Priya picks Midnight; reconnecting keeps it and sends it.
  const port = srv.port;
  await srv.close();
  await p.waitForFunction(() => window.snug.S.conn.socket !== 'open', null, { timeout: 15000 });
  await p.evaluate(() => { window.snug.S.prefs.theme = 'midnight'; window.snug.emit(); });
  await p.waitForTimeout(500); // past the upload's wait: nothing can be sent now
  srv = await startServer({ port, dataDir: dir, quiet: true });
  await p.waitForFunction(() => window.snug.S.conn.socket === 'open', null, { timeout: 25000 });
  for (let i = 0; i < 50 && prefsOf('priya').theme !== 'midnight'; i++) await p.waitForTimeout(100);
  assert.equal(await attr(p, 'data-theme'), 'midnight', 'the change made offline stays');
  assert.equal(prefsOf('priya').theme, 'midnight', 'and reaches the account');
  await close(p);
});
