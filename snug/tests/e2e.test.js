// Drives the real app in Chromium against the real server, with separate
// people in separate browser sessions: live sync, persistence, reconnection,
// permissions, notifications, search and voice.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-'));
let srv, browser, url, port;
const errors = [];

async function boot(p = 0) {
  srv = await startServer({ port: p, dataDir: dir, quiet: true });
  port = srv.port;
  url = `http://127.0.0.1:${port}`;
}

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  await boot();
  // Fake microphone, so voice can be tested end to end without hardware.
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.hub.resetLimits());

// One person in their own browser session.
async function person(handle, { viewport = { width: 1280, height: 800 }, path = '/' } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  await page.goto(url + path);
  await page.waitForSelector('.auth-form');
  if (handle) await signIn(page, handle);
  return page;
}
async function signIn(page, handle, password = PASSWORD) {
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', password);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector(page.viewportSize().width < 760 ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
}
const go = (page, name) => page.click(`.nav .row:has-text("${name}")`);
const box = (page) => page.locator('.main .composer textarea');
const say = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };
const settled = (page) => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state));
const msg = (page, text) => page.locator('.main .msg', { hasText: text });

let robin, ines;

test('sign in: a wrong password is refused with a reason; the right one opens the app', async () => {
  robin = await person(null);
  await robin.fill('#auth-handle', 'robin');
  await robin.fill('#auth-pass', 'not-the-password');
  await robin.click('.auth-form button[type=submit]');
  await robin.locator('.auth-form .err:has-text("don’t match")').waitFor();
  await signIn(robin, 'robin');
  assert.equal(await robin.locator('.self-name').textContent(), 'Robin Hale');
  ines = await person('ines');
});

test('a message appears for the other person without a refresh, and survives one', async () => {
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  await say(robin, 'Testing the calcined swap on Thursday.');
  await msg(ines, 'Testing the calcined swap').waitFor();
  await settled(robin);
  assert.equal(await msg(robin, 'Testing the calcined swap').count(), 1, 'the sender sees it once');
  await ines.reload();
  await ines.waitForSelector('.nav');
  await msg(ines, 'Testing the calcined swap').waitFor();
});

test('typing shows to the other person; reactions sync both ways', async () => {
  await box(robin).fill('thinking about');
  await ines.locator('.foot:has-text("Robin is typing")').waitFor();
  await box(robin).fill('');
  const theirs = msg(ines, 'Testing the calcined swap');
  await theirs.hover();
  await theirs.locator('[aria-label="Add a reaction"]').first().click();
  await ines.locator('.picker-grid button').first().click();
  const chip = msg(robin, 'Testing the calcined swap').locator('.rx:not(.add)');
  await chip.waitFor();
  assert.equal((await chip.textContent()).replace(/\D/g, ''), '1');
  await chip.click();
  await msg(ines, 'Testing the calcined swap').locator('.rx.mine:has-text("2")').waitFor();
});

test('an attached picture uploads and shows for the other person', async () => {
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  // A real 2x1 PNG, made in the page so the test needs no fixture file.
  const png = await robin.evaluate(() => new Promise((r) => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100;
    const g = c.getContext('2d'); g.fillStyle = '#7f9d97'; g.fillRect(0, 0, 200, 100);
    c.toBlob(async (b) => r([...new Uint8Array(await b.arrayBuffer())]), 'image/png');
  }));
  await robin.locator('.main .composer input[type=file]').setInputFiles({ name: 'glaze-test.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await robin.locator('.pending-file:has-text("glaze-test.png") .pending-state:not(:has-text("Uploading"))').waitFor();
  await say(robin, 'Tile from this morning');
  const theirs = msg(ines, 'Tile from this morning').locator('.img img');
  await theirs.waitFor();
  await ines.waitForFunction(() => [...document.querySelectorAll('.main .msg .img img')].pop()?.naturalWidth === 200);
  assert.match(await theirs.getAttribute('src'), /^\/api\/files\/f_/);
  // Someone who is not signed in cannot fetch it.
  const src = await theirs.getAttribute('src');
  assert.equal((await fetch(url + src)).status, 401);
});

test('presence is real: people show online only while connected', async () => {
  await robin.click('[aria-label*="people here"]');
  const row = robin.locator('.person:has-text("Ines Carvalho")');
  await row.locator('.pres.open').waitFor();
  assert.equal(await robin.locator('.person:has-text("Tomasz") .pres.offline').count(), 1, 'nobody is signed in as Tomasz');
  await ines.context().close();
  await row.locator('.pres.offline').waitFor({ timeout: 9000 });
  ines = await person('ines');
  await row.locator('.pres.open').waitFor();
  await robin.keyboard.press('Escape');
});

test('a mention elsewhere raises a note and a number; opening it clears both', async () => {
  await go(robin, 'Classes');
  await go(ines, 'Show & tell');
  await say(ines, '@robin your bowls are out of the kiln.');
  await robin.locator('.toast.note:has-text("your bowls are out")').waitFor();
  const badge = robin.locator('.nav .row:has-text("Show & tell") .badge');
  assert.equal(await badge.textContent(), '1');
  await robin.click('.toast.note');
  await robin.locator('.main .msg.mention:has-text("your bowls are out")').waitFor();
  await badge.waitFor({ state: 'detached' });
  // Read state is on the server: a fresh session agrees.
  const again = await person('robin');
  assert.equal(await again.locator('.nav .row:has-text("Show & tell") .badge').count(), 0);
  await again.context().close();
});

test('the server going away: messages wait, then send by themselves when it is back', async () => {
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  await srv.close();
  await robin.locator('.banner:has-text("You’re offline")').waitFor();
  await say(robin, 'Written while the server was down');
  await robin.locator('.msg-state:has-text("Waiting for a connection")').waitFor();
  await boot(port);
  await robin.waitForFunction(() => window.snug.S.conn.socket === 'open', null, { timeout: 25000 });
  await settled(robin);
  assert.equal(await robin.locator('.msg-state').count(), 0);
  assert.equal(await msg(robin, 'Written while the server was down').count(), 1, 'sent once, not twice');
  await ines.waitForFunction(() => window.snug.S.conn.socket === 'open', null, { timeout: 25000 });
  await msg(ines, 'Written while the server was down').waitFor();
});

test('a refused message says why and can be tried again', async () => {
  await go(robin, 'Marketplace');
  for (let i = 0; i < 20; i++) await say(robin, `burst ${i}`);
  const failed = robin.locator('.msg-state.failed');
  await failed.first().waitFor();
  assert.match(await failed.first().textContent(), /little fast/);
  // Let every send finish, one way or the other, before counting.
  await robin.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => m.state !== 'sending'));
  srv.hub.resetLimits();
  const before = await failed.count();
  await failed.first().locator('text=Try again').click();
  await robin.waitForFunction((n) => document.querySelectorAll('.msg-state.failed').length === n - 1, before);
  for (let i = await failed.count(); i > 0; i--) await failed.first().locator('text=Delete').click();
});

test('permissions: a member cannot post notices; the server agrees', async () => {
  const priya = await person('priya');
  await go(priya, 'Front desk');
  await priya.locator('.composer-locked:has-text("Only Studio lead and Technician")').waitFor();
  const refused = await priya.evaluate(() => import('./js/server.js').then((m) => m.call('msg.send', { conv: 'k_desk', id: 'm_forced0000000001', text: 'forced' }).then(() => 'sent', (e) => e.message)));
  assert.match(refused, /Only Studio lead and Technician/);
  await priya.click('.nav .house-row:has-text("Kiln & Co.")', { button: 'right' });
  await priya.locator('.menu-item:has-text("Browse rooms")').waitFor();
  assert.equal(await priya.locator('.menu-item:has-text("House settings")').count(), 0);
  await priya.keyboard.press('Escape');
  await priya.context().close();
});

test('drafts survive switching rooms; coming back keeps your place', async () => {
  await go(robin, 'Firing schedule');
  await box(robin).fill('Half a thought about shelf 3');
  await go(robin, 'The floor');
  assert.equal(await box(robin).inputValue(), '');
  const scroller = robin.locator('.main .scroller');
  await scroller.evaluate((el) => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')); });
  await go(robin, 'Firing schedule');
  assert.equal(await box(robin).inputValue(), 'Half a thought about shelf 3');
  await box(robin).fill('');
  await go(robin, 'The floor');
  await robin.waitForTimeout(100);
  assert.equal(await scroller.evaluate((el) => Math.round(el.scrollTop)), 120);
});

test('keyboard: reply with R, thread with T, Escape closes in order; a thread reply reaches the other person', async () => {
  await go(robin, 'Glaze lab');
  await box(robin).focus();
  await robin.keyboard.press('Shift+Tab');
  assert.equal(await robin.evaluate(() => document.activeElement.classList.contains('msg')), true);
  await robin.keyboard.press('r');
  await robin.locator('.composer-banner:has-text("Replying to")').waitFor();
  await robin.keyboard.press('Escape');
  assert.equal(await robin.locator('.composer-banner').count(), 0);
  await robin.keyboard.press('Shift+Tab');
  await robin.keyboard.press('t');
  await robin.locator('.pane[aria-label="Thread"]').waitFor();
  await robin.locator('.pane .composer textarea').fill('Starting a thread from the keyboard');
  await robin.locator('.pane .composer textarea').press('Enter');
  await ines.locator('.main .stub:has-text("1 reply")').last().waitFor();
  await robin.keyboard.press('Control+k');
  await robin.locator('.quick').waitFor();
  await robin.keyboard.press('Escape');
  assert.equal(await robin.locator('.quick').count(), 0);
  assert.equal(await robin.locator('.pane').count(), 1, 'first Escape closes only the top layer');
  await robin.keyboard.press('Escape');
  assert.equal(await robin.locator('.pane').count(), 0);
});

test('search runs on the server over stored messages', async () => {
  await robin.keyboard.press('Control+Shift+F');
  await robin.keyboard.type('calcined swap');
  await robin.locator('.item:has-text("Testing the calcined swap")').waitFor();
  await robin.locator('.search-input input').fill('from:kwame debounce');
  await robin.locator('.empty:has-text("No messages match")').waitFor();
  await robin.locator('.search-input input').fill('is:saved kaolin');
  await robin.locator('.item:has-text("calcined kaolin")').waitFor();
  await robin.click('.item:has-text("calcined kaolin") .item-main');
  await robin.locator('.main .msg.flash:has-text("calcined kaolin")').waitFor();
});

test('catch up: J moves, E marks done, and it stays done after a reload', async () => {
  await robin.click('.nav >> text=Catch up');
  const items = robin.locator('.item[data-triage]');
  const before = await items.count();
  assert.ok(before >= 2, `expected at least two items, got ${before}`);
  await items.first().focus();
  await robin.keyboard.press('j');
  assert.equal(await items.nth(1).evaluate((el) => el === document.activeElement), true);
  await robin.keyboard.press('e');
  await robin.waitForFunction((n) => document.querySelectorAll('.item[data-triage]').length === n - 1, before);
  await robin.waitForTimeout(300);
  await robin.reload();
  await robin.waitForSelector('.nav');
  await robin.waitForFunction(() => window.snug.S.conn.socket === 'open');
  await robin.click('.nav >> text=Catch up');
  assert.equal(await robin.locator('.item[data-triage]').count(), before - 1);
});

test('a new account joins by link as a newcomer, and the house opens after a first message', async () => {
  await robin.click('.nav .house-row:has-text("Kiln & Co.")', { button: 'right' });
  await robin.click('.menu-item:has-text("Invite people")');
  await robin.waitForFunction(() => /\/join\//.test(document.querySelector('.copy-row input')?.value || ''));
  const link = await robin.locator('.copy-row input').first().inputValue();
  await robin.keyboard.press('Escape');

  const dana = await person(null, { path: new URL(link).pathname });
  await dana.locator('.auth-invite:has-text("invited you to Kiln & Co.")').waitFor();
  await dana.fill('#auth-handle', 'dana');
  await dana.fill('#auth-name', 'Dana Whitfield');
  await dana.fill('#auth-pass', 'a brand new password');
  await dana.click('.auth-form button[type=submit]');
  await dana.locator('.modal:has-text("Kiln & Co.")').waitFor();
  await dana.click('.modal >> text=Join Kiln & Co.');
  await dana.locator('.welcome:has-text("Welcome to Kiln & Co.")').waitFor();
  assert.equal(await dana.locator('.nav .row:has-text("Glaze lab")').count(), 0, 'only starter rooms at first');
  await go(dana, 'The floor');
  await say(dana, 'Hello, I just joined.');
  await dana.locator('.toast:has-text("rooms in Kiln & Co. are open")').waitFor();
  await dana.locator('.nav .row:has-text("Glaze lab")').waitFor();
  await go(robin, 'The floor');
  await msg(robin, 'Hello, I just joined.').waitFor();
  await dana.context().close();
});

test('voice: two people in a room are really connected and audio flows', async () => {
  await go(robin, 'Wheel room');
  await go(ines, 'Wheel room');
  await robin.click('.stage .btn.primary');
  await robin.locator('.stage-person:has-text("You")').waitFor();
  await ines.locator('.stage-person:has-text("Robin")').waitFor();
  await ines.click('.stage .btn.primary');
  const connected = (page) => page.waitForFunction(async () => {
    const s = await window.snug.voiceStats();
    const peers = Object.values(s);
    return peers.length === 1 && peers[0].state === 'connected' && peers[0].bytes > 2000;
  }, null, { timeout: 20000, polling: 300 });
  await connected(robin);
  await connected(ines);
  // The "Connecting" note clears once the connection event reaches the page.
  await robin.waitForFunction(() => !document.querySelector('.stage-note'));
  await ines.waitForFunction(() => !document.querySelector('.stage-note'));
  await robin.locator('.dock').waitFor();
  // Mute is real: it reaches the other person.
  await robin.click('.stage [aria-label="Mute"]');
  await ines.locator('.stage-person:has-text("Robin") .muted-ic').waitFor();
  await ines.click('.stage [aria-label="Leave voice"]');
  await robin.waitForFunction(async () => Object.keys(await window.snug.voiceStats()).length === 0);
  await robin.click('.stage [aria-label="Leave voice"]');
  assert.equal(await robin.locator('.dock').count(), 0);
});

test('signing out returns to sign-in and clears this device', async () => {
  await ines.click('.self');
  await ines.click('.me-pop >> text=Settings');
  await ines.click('.layer-nav >> text=Account');
  await ines.click('.layer-body button:text-is("Sign out")');
  await ines.waitForSelector('.auth-form');
  assert.equal(await ines.evaluate(() => localStorage.getItem('snug.cache')), null);
  await ines.reload();
  await ines.waitForSelector('.auth-form');
  await ines.context().close();
});

test('phone: tabs, a room pushed on top, back button and back gesture return', async () => {
  const phone = await person('robin', { viewport: { width: 390, height: 844 } });
  await phone.locator('.tab[aria-selected="true"]:has-text("Catch up")').waitFor();
  await phone.click('.tab:has-text("Houses")');
  await phone.click('.row:has-text("Glaze lab")');
  await phone.locator('.screen.push .composer textarea').waitFor();
  await phone.click('.screen.push [aria-label="Back"]');
  assert.equal(await phone.locator('.screen.push').count(), 0);
  await phone.click('.row:has-text("Ride plans")');
  await phone.locator('.screen.push .composer textarea').waitFor();
  await phone.goBack();
  await phone.waitForFunction(() => !document.querySelector('.screen.push'));
  assert.match(phone.url(), new RegExp(`127.0.0.1:${port}`));
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll');
  await phone.context().close();
  assert.deepEqual(errors, []);
});
