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
// No test may leave an error in any page behind it.
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

// One person in their own browser session.
async function person(handle, { viewport = { width: 1280, height: 800 }, path = '/' } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  // Console errors count too, except the browser's own network notes: the
  // tests refuse passwords and stop the server on purpose.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
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
// Rooms live in their community's column: open the community from the rail
// first, unless it is already the place you are in.
const HOUSE_OF = {
  'Front desk': 'Kiln & Co.', 'The floor': 'Kiln & Co.', 'Glaze lab': 'Kiln & Co.', 'Firing schedule': 'Kiln & Co.',
  'Show & tell': 'Kiln & Co.', Marketplace: 'Kiln & Co.', Classes: 'Kiln & Co.', 'Wheel room': 'Kiln & Co.',
  'Ride plans': 'Ridgeline Riders',
};
async function openPlace(page, house) {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function go(page, name) {
  if (HOUSE_OF[name]) await openPlace(page, HOUSE_OF[name]);
  await page.click(`.nav .row:has-text("${name}")`);
}
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
  await robin.click('.main .bar button[aria-label^="People,"]');
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
  await openPlace(again, 'Kiln & Co.');
  await again.locator('.nav .row:has-text("Show & tell")').waitFor();
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
  await priya.click('.rail-house:has-text("Kiln & Co.")', { button: 'right' });
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
  await robin.click('.rail-btn:has-text("Home")');
  await robin.click('.nav .row:has-text("Catch up")');
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
  await robin.click('.rail-btn:has-text("Home")');
  await robin.click('.nav .row:has-text("Catch up")');
  assert.equal(await robin.locator('.item[data-triage]').count(), before - 1);
});

test('a new account joins by link as a newcomer, and the house opens after a first message', async () => {
  await robin.click('.rail-house:has-text("Kiln & Co.")', { button: 'right' });
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
  // Joining puts you in the community's column, with only its starter rooms.
  await dana.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').waitFor();
  await dana.locator('.nav .row:has-text("The floor")').waitFor();
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
  await phone.locator('.tab[aria-selected="true"]:has-text("Home")').waitFor();
  await phone.click('.home-house:has-text("Kiln & Co.")');
  await phone.click('.screen.push .row:has-text("Glaze lab")');
  await phone.locator('.screen.push .composer textarea').waitFor();
  await phone.click('.screen.push [aria-label="Back"]');
  assert.equal(await phone.locator('.screen.push').count(), 0);
  await phone.click('.home-house:has-text("Ridgeline Riders")');
  await phone.click('.screen.push .row:has-text("Ride plans")');
  await phone.locator('.screen.push .composer textarea').waitFor();
  await phone.goBack();
  await phone.waitForFunction(() => !document.querySelector('.screen.push'));
  assert.match(phone.url(), new RegExp(`127.0.0.1:${port}`));
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll');
  await phone.context().close();
  assert.deepEqual(errors, []);
});

// ---------- The redesigned product: places, friends, discovery, events ----------

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Home from the rail reopens where you were in Home; its first row is the Home page.
const home = async (page) => {
  await page.click('.rail-btn:has-text("Home")');
  await page.locator('.nav .ctx .row', { hasText: /^Home$/ }).click();
  await page.locator('.main.home').waitFor();
};

test('the rail and the context column switch places, and Alt+Down walks the column', async () => {
  await robin.click('.rail-btn:has-text("Messages")');
  await robin.locator('.rail-btn[aria-current="page"]:has-text("Messages")').waitFor();
  await robin.locator('.nav .ctx[aria-label="Messages"] .sect:has-text("Direct messages")').waitFor();
  assert.ok(await robin.locator('.nav .ctx .row').count() >= 1, 'direct messages are listed');
  assert.equal(await robin.locator('.main .composer textarea').count(), 1, 'Messages opens the latest conversation');

  await robin.click('.rail-btn:has-text("Discover")');
  await robin.locator('.nav .ctx[aria-label="Discover"] .row:has-text("Communities")').waitFor();
  await robin.locator('.nav .ctx .row:has-text("Music")').waitFor();

  await robin.click('.rail-house:has-text("Ridgeline Riders")');
  await robin.locator('.nav .ctx-house:has-text("Ridgeline Riders")').waitFor();
  await robin.locator('.nav .row:has-text("Ride plans")').waitFor();
  assert.equal(await robin.locator('.nav .row:has-text("Glaze lab")').count(), 0, 'only this community’s rooms');

  await home(robin);
  await robin.locator('.rail-btn[aria-current="page"]:has-text("Home")').waitFor();
  await robin.locator('.nav .row[aria-current="page"]:has-text("Home")').waitFor();
  await robin.locator('.main').click({ position: { x: 5, y: 5 } });
  await robin.keyboard.press('Alt+ArrowDown');
  await robin.locator('.nav .row[aria-current="page"]:has-text("Catch up")').waitFor();
  assert.equal(await robin.evaluate(() => window.snug.S.ui.view.type), 'catchup');
  // Choosing a community again reopens where you were in it.
  await robin.click('.rail-house:has-text("Ridgeline Riders")');
  await robin.locator('.nav .ctx-house:has-text("Ridgeline Riders")').waitFor();
});

test('home shows friends who are around and conversations going, live', async () => {
  await home(robin);
  const ines2 = await person('ines');
  const friend = robin.locator('.home-sect[aria-labelledby="home-friends"] .home-friend:has-text("Ines")');
  await friend.waitFor();
  await go(ines2, 'Glaze lab');
  await say(ines2, 'Kiln is unloaded, come and look.');
  const row = robin.locator('.home-sect[aria-labelledby="home-active"] .home-row:has-text("Glaze lab")');
  await row.locator('text=Kiln is unloaded').waitFor();
  assert.match(await row.textContent(), /talking/);
  await ines2.context().close();
  await friend.waitFor({ state: 'detached', timeout: 9000 });
  // Offline now, but she just wrote: she moves to "Recently here" instead of vanishing.
  await robin.locator('.home-sect[aria-labelledby="home-recent"] .home-friend:has-text("Ines")').waitFor();
  // A conversation row opens the conversation.
  await row.click();
  await msg(robin, 'Kiln is unloaded').waitFor();
});

test('a friend request reaches the other person live, and accepting makes both friends', async () => {
  const tomasz = await person('tomasz');
  await home(tomasz);
  await tomasz.click('.nav .row:has-text("Friends")');
  await tomasz.click('.f-tab:has-text("Requests")');
  assert.equal(await tomasz.locator('.f-row:has-text("Robin Hale")').count(), 0);

  await home(robin);
  await robin.click('.nav .row:has-text("Friends")');
  await robin.click('.f-tab:has-text("Add friend")');
  await robin.fill('#f-add-handle', 'nobody-by-this-name');
  await robin.click('.f-add-form button[type=submit]');
  await robin.locator('#f-add-handle[aria-invalid="true"]').waitFor();
  await robin.fill('#f-add-handle', 'tomasz');
  await robin.click('.f-add-form button[type=submit]');
  await robin.locator('.ok-line:has-text("Request sent")').waitFor();

  // Tomasz sees it arrive without a refresh, with a number on Friends.
  const req = tomasz.locator('.f-row:has-text("Robin Hale")');
  await req.waitFor();
  assert.equal(await tomasz.locator('.nav .row:has-text("Friends") .badge').textContent(), '1');
  await req.locator('button:has-text("Accept")').click();
  await tomasz.locator('.nav .row:has-text("Friends") .badge').waitFor({ state: 'detached' });

  // Both are friends now, on both screens, without a refresh.
  await robin.click('.f-tab:has-text("All")');
  await robin.locator('.f-row:has-text("Tomasz")').waitFor();
  await tomasz.click('.f-tab:has-text("All")');
  await tomasz.locator('.f-row:has-text("Robin Hale")').waitFor();
  // The server agrees: a fresh session sees the friendship.
  await tomasz.reload();
  await tomasz.waitForFunction(() => window.snug.S.ready && window.snug.S.conn.socket === 'open');
  assert.equal(await tomasz.evaluate(() => window.snug.S.friends.robin?.state), 'friends');
  await tomasz.context().close();
});

test('discover lists a public community; preview, join, and its page opens', async () => {
  await robin.click('.rail-btn:has-text("Discover")');
  await robin.click('.nav .ctx .row:has-text("Communities")');
  const card = robin.locator('.d-house:has-text("The Listening Room")');
  await card.waitFor();
  assert.equal(await robin.locator('.d-house:has-text("Kiln & Co.")').count(), 0, 'communities you are in are not suggested');
  await card.locator('.d-house-main').click();
  await robin.locator('.hp #hp-title:has-text("The Listening Room")').waitFor();
  await robin.click('.hp-foot .btn.primary:has-text("Join")');
  await robin.locator('.main.pl-page[aria-label="The Listening Room"]').waitFor();
  assert.equal(await robin.locator('.modal').count(), 0, 'the preview closes');
  await robin.locator('.rail-house[aria-current="page"]:has-text("The Listening Room")').waitFor();
  await robin.locator('.nav .ctx-house:has-text("The Listening Room")').waitFor();
  assert.equal(await robin.evaluate(() => Object.values(window.snug.S.houses).find((h) => h.name === 'The Listening Room').newcomer), true, 'joins as a newcomer');
});

test('an event planned by one person appears for another, who says they are going', async () => {
  const priya = await person('priya');
  for (const p of [robin, priya]) {
    await openPlace(p, 'Kiln & Co.');
    await p.click('.nav .row:has-text("Events")');
    await p.locator('.main.pl-page[aria-label="Events in Kiln & Co."]').waitFor();
  }
  assert.equal(await priya.locator('.ev-list button:has-text("Create event")').count(), 0, 'a member cannot plan events');
  await robin.click('.ev-list button:has-text("Create event")');
  await robin.fill('#ev-title', 'Glaze night');
  await robin.fill('#ev-about', 'Test tiles and shared buckets.');
  await robin.fill('#ev-when', ymd(new Date(Date.now() + 3 * 86_400_000)));
  await robin.fill('.ev-form input[aria-label="Starts at"]', '19:00');
  await robin.click('.ev-form button[type=submit]');
  const mine = robin.locator('.ev-row:has-text("Glaze night")');
  await mine.waitFor();
  const theirs = priya.locator('.ev-row:has-text("Glaze night")');
  await theirs.waitFor();
  assert.match(await theirs.textContent(), /1 going/);
  await theirs.locator('.ev-rsvp').click();
  await theirs.locator('.ev-rsvp.on').waitFor();
  await mine.locator('text=2 going').waitFor();
  // The server agrees.
  const going = await priya.evaluate(() => import('./js/server.js').then((m) => m.call('sync')).then((d) => Object.values(d.events).find((e) => e.title === 'Glaze night').going));
  assert.deepEqual([...going].sort(), ['priya', 'robin']);
  await priya.context().close();
});

test('phone: Home, Messages, Discover, Catch up and You tabs each show their screen', async () => {
  const phone = await person('robin', { viewport: { width: 390, height: 844 } });
  const tab = async (name) => {
    await phone.click(`.tab:has-text("${name}")`);
    await phone.locator(`.tab[aria-selected="true"]:has-text("${name}")`).waitFor();
  };
  await phone.locator('.tab[aria-selected="true"]:has-text("Home")').waitFor();
  await phone.locator('.tab-body .home .home-greet:has-text("Robin")').waitFor();
  assert.ok(Number(await phone.locator('.tab:has-text("Home") .badge').textContent()) >= 1, 'the waiting friend request counts on Home');
  await tab('Messages');
  await phone.locator('.tab-body .sect:has-text("Direct messages")').waitFor();
  await phone.click('.tab-body .row >> nth=0');
  await phone.locator('.screen.push .composer textarea').waitFor();
  await phone.goBack();
  await phone.waitForFunction(() => !document.querySelector('.screen.push'));
  await tab('Discover');
  await phone.locator('.tab-body .d-house, .tab-body .d-feature').first().waitFor();
  await tab('Catch up');
  await phone.locator('.tab-body .item[data-triage]').first().waitFor();
  await tab('You');
  await phone.locator('.you-card:has-text("Robin Hale")').waitFor();
  await phone.click('.you-list .row:has-text("Friends")');
  await phone.locator('.screen.push .friends-view').waitFor();
  await phone.click('.screen.push [aria-label="Back"]');
  await phone.waitForFunction(() => !document.querySelector('.screen.push'));
  for (const name of ['Home', 'Messages', 'Discover', 'Catch up', 'You']) {
    const h = await phone.locator(`.tab:has-text("${name}")`).boundingBox();
    assert.ok(h.height >= 44, `${name} tab is a 44px target`);
  }
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll');
  await phone.context().close();
});
