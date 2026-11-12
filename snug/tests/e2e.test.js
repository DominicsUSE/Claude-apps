// Drives the real app in Chromium: sending, offline and failure states,
// drafts, scroll memory, keyboard paths and notification levels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8790 + Math.floor(Math.random() * 100);

let server, browser, page;
const errors = [];

test.before(async () => {
  server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.kill(); });

async function open(viewport = { width: 1280, height: 800 }) {
  page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(viewport.width < 760 ? '.tabs' : '.msgs[role="log"]');
}
const go = (name) => page.click(`.nav .row:has-text("${name}")`);
const box = () => page.locator('.main .composer textarea');
const state = (fn) => page.evaluate(fn);
// Every message I wrote has been confirmed, failed or deleted: nothing in flight.
const settled = () => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => m.state !== 'sending' && m.state !== 'queued'));

test('a sent message shows at once, then is confirmed', async () => {
  await open();
  await go('Glaze lab');
  await box().fill('Testing the calcined swap on Thursday.');
  await box().press('Enter');
  const mine = page.locator('.main .msg', { hasText: 'Testing the calcined swap' });
  await mine.waitFor();
  assert.equal(await mine.evaluate((el) => el.classList.contains('pending')), true, 'shown before the server confirms');
  await settled();
  assert.equal(await mine.evaluate((el) => el.classList.contains('pending')), false);
  assert.equal(await box().inputValue(), '');
  assert.deepEqual(errors, []);
});

test('offline messages wait, then send by themselves', async () => {
  await state(() => { window.snug.S.conn.simOffline = true; window.snug.emit(); });
  await page.locator('.banner:has-text("You’re offline")').waitFor();
  await box().fill('Sent from the tunnel');
  await box().press('Enter');
  await page.locator('.msg-state:has-text("Waiting for a connection")').waitFor();
  await page.click('.self');
  await page.keyboard.press('Escape');
  await page.evaluate(() => import('./js/server.js').then((m) => m.setSimOffline(false)));
  await settled();
  assert.equal(await page.locator('.main .msg', { hasText: 'Sent from the tunnel' }).count(), 1);
  assert.equal(await page.locator('.msg-state').count(), 0);
});

test('a failed send says so and can be retried', async () => {
  await page.evaluate(() => import('./js/server.js').then((m) => m.setSimFail(true)));
  await box().fill('This one will fail');
  await box().press('Enter');
  await page.locator('.msg-state.failed').waitFor();
  await page.evaluate(() => import('./js/server.js').then((m) => m.setSimFail(false)));
  await page.click('.msg-state.failed >> text=Try again');
  await settled();
  assert.equal(await page.locator('.msg-state').count(), 0);
});

test('drafts survive switching rooms', async () => {
  await go('Firing schedule');
  await box().fill('Half a thought about shelf 3');
  await go('Show & tell');
  assert.equal(await box().inputValue(), '');
  await go('Firing schedule');
  assert.equal(await box().inputValue(), 'Half a thought about shelf 3');
  await box().fill('');
});

test('coming back to a room keeps your place', async () => {
  await go('The floor');
  const scroller = page.locator('.main .scroller');
  await scroller.evaluate((el) => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')); });
  await go('Classes');
  await go('The floor');
  await page.waitForTimeout(100);
  assert.equal(await scroller.evaluate((el) => Math.round(el.scrollTop)), 120);
});

test('keyboard: reply with R, thread with T, Escape closes in order', async () => {
  await go('Glaze lab');
  await box().focus();
  await page.keyboard.press('Shift+Tab');
  const focused = () => page.evaluate(() => document.activeElement.classList.contains('msg'));
  assert.equal(await focused(), true, 'Shift+Tab from an empty box goes into the messages');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('r');
  await page.locator('.composer-banner:has-text("Replying to")').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.composer-banner').count(), 0);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('t');
  await page.locator('.pane[aria-label="Thread"]').waitFor();
  await page.keyboard.press('Control+k');
  await page.locator('.quick').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.quick').count(), 0);
  assert.equal(await page.locator('.pane').count(), 1, 'first Escape closes only the top layer');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.pane').count(), 0);
});

test('quick jump goes to a room by a few letters', async () => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('ride');
  await page.keyboard.press('Enter');
  await page.locator('.main .bar-title:has-text("Ride plans")').waitFor();
});

test('muting a house removes its numbers and dots', async () => {
  await page.click('.nav .house-row:has-text("Kiln & Co.")', { button: 'right' });
  await page.click('.menu-item:has-text("Nothing")');
  const marks = await page.locator('.nav .row:has-text("Glaze lab") .row-end > *').count();
  assert.equal(marks, 0);
  const level = await state(() => window.snug.S.houses.kiln.notify);
  assert.equal(level, 'muted');
  await page.click('.nav .house-row:has-text("Kiln & Co.")', { button: 'right' });
  await page.click('.menu-item:has-text("Everything")');
});

test('saving a message and finding it with is:saved', async () => {
  await go('Ride plans');
  const msg = page.locator('.main .msg', { hasText: 'Overshoes weather' });
  await msg.hover();
  await msg.locator('[aria-label="Save"]').click();
  await page.keyboard.press('Control+Shift+F');
  await page.keyboard.type('is:saved overshoes');
  await page.locator('.item:has-text("Overshoes weather")').waitFor();
  await page.click('.item:has-text("Overshoes weather") .item-main');
  await page.locator('.main .msg.flash:has-text("Overshoes weather")').waitFor();
  assert.deepEqual(errors, []);
});

test('catch up: J moves, E marks done, Undo brings it back', async () => {
  await page.click('.nav >> text=Catch up');
  const items = page.locator('.item[data-triage]');
  const before = await items.count();
  await items.first().focus();
  await page.keyboard.press('j');
  assert.equal(await items.nth(1).evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('e');
  await page.waitForFunction((n) => document.querySelectorAll('.item[data-triage]').length === n - 1, before);
  assert.equal(await page.evaluate(() => document.activeElement.matches('.item[data-triage]')), true, 'focus stays in the list');
  await page.click('.toast >> text=Undo');
  await page.waitForFunction((n) => document.querySelectorAll('.item[data-triage]').length === n, before);
});

test('high contrast darkens faint text', async () => {
  const faint = () => page.evaluate(() => getComputedStyle(document.querySelector('.item-meta')).color);
  const standard = await faint();
  await page.evaluate(() => import('./js/store.js').then((s) => s.setPref('contrast', 'high')));
  assert.notEqual(await faint(), standard);
  await page.evaluate(() => import('./js/store.js').then((s) => s.setPref('contrast', 'system')));
});

test('phone: tabs, a room pushed on top, back returns', async () => {
  await page.close();
  await open({ width: 390, height: 844 });
  await page.locator('.tab[aria-selected="true"]:has-text("Catch up")').waitFor();
  await page.click('.tab:has-text("Houses")');
  await page.click('.row:has-text("Glaze lab")');
  await page.locator('.screen.push .composer textarea').waitFor();
  await page.click('.screen.push [aria-label="Back"]');
  assert.equal(await page.locator('.screen.push').count(), 0);
  // The system back gesture closes the room instead of leaving the app.
  await page.click('.row:has-text("Ride plans")');
  await page.locator('.screen.push .composer textarea').waitFor();
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector('.screen.push'));
  assert.match(page.url(), new RegExp(`localhost:${PORT}`));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'no horizontal scroll at phone width');
  assert.deepEqual(errors, []);
});
