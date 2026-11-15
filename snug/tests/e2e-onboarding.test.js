// Getting in and finding your way, in Chromium against the real server with
// the seeded data (Robin leads Kiln & Co.): "a friend sent me an invite" from
// signed out to saying hello, dead invitation links, the rail's plus (start
// or join a house, then the invite prompt), signing out from the menu under
// your name, who "New message" lists, adding a friend who isn't here yet,
// the wording of counts, Settings' version, and the phone flows at 390x844.
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
const PASSWORD = 'snug-demo-1';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-onboarding-'));
let srv, browser, url;
const errors = [];
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

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

// A browser of one's own: signed in as `handle`, or signed out at `path`.
async function open({ handle = null, path = '/', phone = false, permissions = [] } = {}) {
  const ctx = await browser.newContext(phone ? { ...PHONE, permissions } : { viewport: { width: 1280, height: 800 }, permissions });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const who = handle || 'guest';
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${who} console: ${m.text()}`);
  });
  await page.goto(url + path);
  await page.waitForSelector('.auth-form');
  if (handle) await signIn(page, handle);
  return page;
}
async function signIn(page, handle, password = PASSWORD) {
  if (await page.locator('#auth-name').count()) await page.click('.auth-swap .auth-link:text-is("Sign in")');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', password);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector(page.viewportSize().width < 760 ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
}
const close = (page) => page.context().close();
// An invitation made over the socket, as the Invite dialog does.
const invite = (page, house = 'kiln', extra = {}) => page.evaluate(([h, x]) => import('/js/server.js').then((s) => s.call('invite.create', { house: h, ...x })), [house, extra]);
const errOf = (page, field) => page.locator(`#auth-${field}-err`);

test('a friend sent me an invite: sign up with every problem shown at once, join, land where I can write, see the voice rooms, say hello', async () => {
  const robin = await open({ handle: 'robin' });
  const { code } = await invite(robin);
  const guest = await open({ path: `/join/${code}` });
  try {
    await guest.locator('.auth-invite:has-text("invited you to Kiln & Co.")').waitFor();
    // Signed out: one line on what Snug is would be on sign-in; sign-up says how recovery works.
    await guest.locator('#auth-password-hint:has-text("Snug doesn’t ask for an email")').waitFor();
    // Every problem at once, each beside its own field.
    await guest.click('.auth-form button[type=submit]');
    await errOf(guest, 'handle').waitFor();
    await errOf(guest, 'name').waitFor();
    await errOf(guest, 'password').waitFor();
    assert.equal(await guest.locator('#auth-form-err').count(), 0, 'nothing in a box at the bottom');
    assert.equal(await guest.locator('#auth-handle').getAttribute('aria-invalid'), 'true');
    assert.match(await guest.locator('#auth-handle').getAttribute('aria-describedby'), /auth-handle-err/);
    await guest.fill('#auth-handle', 'mantas k');
    await guest.fill('#auth-name', 'Mantas');
    await guest.fill('#auth-pass', 'short');
    await guest.click('.auth-form button[type=submit]');
    assert.match(await errOf(guest, 'handle').textContent(), /spaces/);
    assert.match(await errOf(guest, 'password').textContent(), /8 characters/);
    assert.equal(await errOf(guest, 'name').count(), 0, 'the name is fine now');
    // Show password, then hide it again.
    const eye = guest.locator('.pass-show');
    assert.equal(await guest.locator('#auth-pass').getAttribute('type'), 'password');
    await eye.click();
    assert.equal(await guest.locator('#auth-pass').getAttribute('type'), 'text');
    assert.equal(await eye.getAttribute('aria-pressed'), 'true');
    await eye.click();
    assert.equal(await guest.locator('#auth-pass').getAttribute('type'), 'password');
    // A server refusal lands on its field too.
    await guest.fill('#auth-handle', 'priya');
    await guest.fill('#auth-pass', 'quiet green kettle');
    await guest.click('.auth-form button[type=submit]');
    assert.match(await errOf(guest, 'handle').textContent(), /taken/);
    await guest.fill('#auth-handle', 'mantas');
    await guest.click('.auth-form button[type=submit]');

    await guest.locator('.modal:has-text("Kiln & Co.")').waitFor();
    await guest.click('.modal >> text=Join Kiln & Co.');
    // Lands in The floor, a room a newcomer can write in, not Front desk (notices).
    await guest.waitForFunction(() => window.snug.S.ui.view.id === 'k_floor');
    await guest.locator('.main .composer textarea').waitFor();
    assert.equal(await guest.locator('.main .composer textarea').isDisabled(), false);
    // The welcome card is in view from its title down.
    const title = guest.locator('.main .welcome h2');
    await title.waitFor();
    const box = await title.boundingBox();
    const scroller = await guest.locator('.main .scroller').boundingBox();
    assert.ok(box.y >= scroller.y, `welcome title at ${box.y}, view starts at ${scroller.y}`);
    // Voice rooms are there from the start; the other text rooms wait behind a clear Browse.
    await guest.locator('.nav .row:has-text("Wheel room")').waitFor();
    await guest.locator('.nav .row:has-text("Kiln watch")').waitFor();
    assert.equal(await guest.locator('.nav .row:has-text("Glaze lab")').count(), 0);
    const more = guest.locator('.nav .row:has-text("Browse 4 more rooms")');
    await more.waitFor();
    assert.match(await more.textContent(), /Read them now/);
    // Readers can read every room before posting.
    await more.click();
    await guest.locator('.modal:has-text("You can open and read any of these now")').waitFor();
    await guest.click('.modal .room-pick:has-text("Glaze lab")');
    await guest.locator('.main .msg').first().waitFor();
    await guest.click('.nav .row:has-text("The floor")');
    // Say hello: the rest of the house opens, and Robin sees it.
    await guest.locator('.main .composer textarea').fill('Hello, Mantas here.');
    await guest.locator('.main .composer textarea').press('Enter');
    await guest.locator('.nav .row:has-text("Glaze lab")').waitFor();
    await robin.click('.rail-house:has-text("Kiln & Co.")');
    await robin.click('.nav .row:has-text("The floor")');
    await robin.locator('.main .msg', { hasText: 'Hello, Mantas here.' }).waitFor();
  } finally { await close(guest); await close(robin); }
});

test('a dead invitation link says plainly why, before sign-up, and the same once signed in', async () => {
  const unknown = await open({ path: '/join/notarealcode99' });
  try {
    const bad = unknown.locator('.auth-invite.bad');
    await bad.waitFor();
    assert.match(await bad.textContent(), /That invitation doesn’t work.*doesn’t match any invitation/s);
    assert.match(await bad.textContent(), /still create an account or sign in/);
  } finally { await close(unknown); }

  const robin = await open({ handle: 'robin' });
  try {
    const old = await invite(robin);
    srv.db.run('UPDATE invites SET expires = ? WHERE code = ?', Date.now() - 60_000, old.code);
    const expired = await open({ path: `/join/${old.code}` });
    await expired.locator('.auth-invite.bad:has-text("expired")').waitFor();
    // Signing up after a dead link opens no join dialog.
    await expired.fill('#auth-handle', 'late_one');
    await expired.fill('#auth-name', 'Late');
    await expired.fill('#auth-pass', 'quiet green kettle');
    await expired.click('.auth-form button[type=submit]');
    await expired.waitForSelector('.nav');
    assert.equal(await expired.locator('.modal').count(), 0);
    await close(expired);

    // Signed in: the same reasons in the dialog.
    const off = await invite(robin);
    await robin.evaluate((c) => import('/js/server.js').then((s) => s.call('invite.revoke', { house: 'kiln', code: c })), off.code);
    await robin.goto(`${url}/join/${off.code}`);
    await robin.locator('.modal:has-text("That invitation doesn’t work")').waitFor();
    await robin.locator('.modal:has-text("turned it off")').waitFor();
    await robin.click('.modal button:text-is("Close")');
  } finally { await close(robin); }
});

test('the plus: Start a house offers the invite link at once; Join with an invite reads a pasted link and joins', async () => {
  const robin = await open({ handle: 'robin' });
  const priya = await open({ handle: 'priya' });
  try {
    const plus = robin.locator('.rail-add');
    assert.equal(await plus.getAttribute('data-tip'), 'Start or join a house');
    assert.equal(await plus.locator('.sr').textContent(), 'Start or join a house');
    await plus.click();
    await robin.locator('.modal h2:text-is("Start a house")').waitFor();
    await robin.locator('.modal .seg button:text-is("Join with an invite")').waitFor();
    await robin.fill('#house-name', 'Night bakers');
    await robin.click('.modal button[type=submit]');
    // Straight to inviting, in plain words, with the link to copy.
    await robin.locator('.modal h2:text-is("Night bakers is ready")').waitFor();
    await robin.waitForFunction(() => /\/join\//.test(document.querySelector('.modal .copy-row input')?.value || ''));
    const link = await robin.locator('.modal .copy-row input').first().inputValue();
    await robin.locator('.modal button:has-text("Copy link")').waitFor();
    // 127.0.0.1 only works on this computer: the dialog says so.
    await robin.locator('.modal .local-address:has-text("only works on this computer")').waitFor();
    await robin.click('.modal button:text-is("Later")');
    // The empty room offers inviting too, not only Edit room.
    await robin.locator('.main .start button:has-text("Invite people")').waitFor();
    await robin.locator('.main .start:has-text("just you so far")').waitFor();

    // Priya pastes the app form of the link.
    await priya.click('.rail-add');
    await priya.click('.modal .seg button:text-is("Join with an invite")');
    await priya.locator('.modal h2:text-is("Join a house")').waitFor();
    await priya.fill('#join-invite', 'hello there');
    await priya.click('.modal button:text-is("Look at the house")');
    await priya.locator('#join-invite-msg.err:has-text("doesn’t look like an invitation")').waitFor();
    await priya.fill('#join-invite', `snug://join/${link.split('/join/')[1]}`);
    await priya.click('.modal button:text-is("Look at the house")');
    await priya.locator('.modal .join-card h2:text-is("Night bakers")').waitFor();
    await priya.click('.modal button:text-is("Join Night bakers")');
    await priya.locator('.rail-house[aria-current="page"]:has-text("Night bakers")').waitFor();
    await priya.locator('.main .composer textarea').waitFor();

    // A made-up code shows the reason, and Back goes to the field.
    await priya.click('.rail-add');
    await priya.click('.modal .seg button:text-is("Join with an invite")');
    await priya.fill('#join-invite', `${url}/join/zzzzzzzzzz`);
    await priya.click('.modal button:text-is("Look at the house")');
    await priya.locator('.modal:has-text("doesn’t match any invitation")').waitFor();
    await priya.click('.modal button:text-is("Try another link")');
    await priya.locator('#join-invite').waitFor();
    await priya.keyboard.press('Escape');
  } finally { await close(robin); await close(priya); }
});

test('sign out from the menu under your name, after a short question; this device forgets the drafts', async () => {
  const malik = await open({ handle: 'malik' });
  try {
    await malik.click('.rail-house:has-text("Kiln & Co.")');
    await malik.click('.nav .row:has-text("The floor")');
    await malik.locator('.main .composer textarea').fill('half a thought');
    await malik.waitForFunction(() => Object.values(window.snug.S.drafts).includes('half a thought'));
    await malik.click('.self');
    await malik.click('.me-pop .menu-item:has-text("Sign out")');
    await malik.locator('.modal h2:text-is("Sign out?")').waitFor();
    await malik.click('.modal button:text-is("Sign out")');
    await malik.waitForSelector('.auth-form');
    await malik.locator('.toast:has-text("You’re signed out.")').waitFor();
    assert.equal(await malik.evaluate(() => localStorage.getItem('snug.drafts')), null);
    // The sign-in page says what Snug is, in one line.
    await malik.locator('.auth-sub:has-text("A calm place for chat, voice and screen sharing with your people.")').waitFor();
    // The next person on this browser has no drafts.
    await signIn(malik, 'priya');
    assert.deepEqual(await malik.evaluate(() => Object.values(window.snug.S.drafts)), []);
  } finally { await close(malik); }
});

test('New message lists only people you can message; someone you can’t says why', async () => {
  const newbie = await open({ path: '/' });
  const robin = await open({ handle: 'robin' });
  try {
    await newbie.click('.auth-swap .auth-link:text-is("Create an account")');
    await newbie.fill('#auth-handle', 'stranger_q');
    await newbie.fill('#auth-name', 'Quinn Stranger');
    await newbie.fill('#auth-pass', 'quiet green kettle');
    await newbie.click('.auth-form button[type=submit]');
    await newbie.waitForSelector('.nav');
    await newbie.waitForFunction(() => window.snug.S.conn.socket === 'open');
    await newbie.evaluate(() => import('/js/server.js').then((s) => s.call('friend.request', { handle: 'robin' })));
    await robin.waitForFunction(() => Object.values(window.snug.S.users).some((u) => u.handle === 'stranger_q'));
    await robin.evaluate(() => import('/js/store.js').then((s) => import('/js/views/modals.js').then((m) => s.openModal(m.NewMessage))));
    const modal = robin.locator('.modal');
    await modal.locator('.pick-list .menu-item:has-text("Priya")').waitFor();
    await modal.locator('input[aria-label="Find someone"]').fill('Quinn');
    assert.equal(await modal.locator('.pick-list .menu-item:has-text("Quinn")').count(), 0, 'not offered as a choice');
    await modal.locator('.pick-other:has-text("Quinn Stranger"):has-text("Accept on the Friends page")').waitFor();
    await robin.keyboard.press('Escape');
  } finally { await close(newbie); await close(robin); }
});

test('Add a friend with an email or an unknown name offers an invitation, not a dead end', async () => {
  const robin = await open({ handle: 'robin', permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    await robin.evaluate(() => import('/js/store.js').then((s) => s.go({ type: 'friends', tab: 'add' })));
    await robin.fill('#f-add-handle', 'jurga@gmail.com');
    await robin.click('.f-add-form button[type=submit]');
    const panel = robin.locator('.f-nothere');
    await panel.locator('b:has-text("Snug doesn’t use email addresses")').waitFor();
    assert.equal(await robin.locator('.f-add-msg .err-line').count(), 0, 'not shown as an error');
    await panel.locator('button:has-text("Copy an invite to Kiln & Co.")').click();
    await robin.locator('.toast:has-text("Copied")').waitFor();
    assert.match(await robin.evaluate(() => navigator.clipboard.readText()), /\/join\/[\w-]+$/);
    await robin.fill('#f-add-handle', 'nobody-here-yet');
    await robin.click('.f-add-form button[type=submit]');
    await panel.locator('b:has-text("Nobody here is called @nobody-here-yet")').waitFor();
    await panel.locator('button:has-text("Copy this Snug’s address")').waitFor();
  } finally { await close(robin); }
});

test('counts say what they count; Settings shows the real version; the Messages list follows the latest message', async () => {
  const robin = await open({ handle: 'robin' });
  const fresh = await open({ path: '/' });
  try {
    // Someone writes in Kiln & Co. (public): Discover counts writers, not "talking" people with a presence dot.
    await robin.click('.rail-house:has-text("Kiln & Co.")');
    await robin.click('.nav .row:has-text("Show & tell")');
    await robin.locator('.main .composer textarea').fill('New mugs out of the kiln.');
    await robin.locator('.main .composer textarea').press('Enter');
    await fresh.click('.auth-swap .auth-link:text-is("Create an account")');
    await fresh.fill('#auth-handle', 'looker');
    await fresh.fill('#auth-name', 'Looker');
    await fresh.fill('#auth-pass', 'quiet green kettle');
    await fresh.click('.auth-form button[type=submit]');
    await fresh.waitForSelector('.nav');
    await fresh.click('.rail-btn:has-text("Discover")');
    const line = fresh.locator('.live-talk', { hasText: 'wrote in the last 15 minutes' }).first();
    await line.waitFor();
    assert.equal(await line.locator('.pres').count(), 0, 'no presence dot on a count of writers');
    assert.equal(await fresh.locator('text=/people talking/').count(), 0);
    assert.equal(await fresh.locator('.d-kicker:text-is("Lively right now")').count(), 0);

    // Settings: the version the server runs.
    await robin.click('.self');
    await robin.click('.me-pop >> text=Settings');
    await robin.locator(`.set-version:text-is("Snug ${VERSION}")`).waitFor();
    await robin.keyboard.press('Escape');

    // Messages: the conversation with the newest message comes first, at once.
    await robin.click('.rail-btn:has-text("Messages")');
    const rows = robin.locator('.nav .ctx[aria-label="Messages"] .row');
    await rows.first().waitFor();
    const last = (await rows.allTextContents()).at(-1);
    await rows.last().click();
    await robin.locator('.main .composer textarea').fill('Bumping this one.');
    await robin.locator('.main .composer textarea').press('Enter');
    await robin.waitForFunction((t) => document.querySelector('.nav .ctx[aria-label="Messages"] .row')?.textContent === t || document.querySelector('.nav .ctx[aria-label="Messages"] .row')?.textContent.startsWith(t.slice(0, 6)), last);
  } finally { await close(robin); await close(fresh); }
});

test('a group’s header: no two buttons look or read the same', async () => {
  const robin = await open({ handle: 'robin' });
  const phone = await open({ handle: 'robin', phone: true });
  try {
    await robin.evaluate(() => import('/js/store.js').then((s) => s.openConv('g_sat')));
    await robin.locator('.main .bar-title:has-text("Saturday load")').waitFor();
    const labels = await robin.locator('.main .bar-end button[aria-label]').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.getAttribute('aria-label')));
    assert.equal(new Set(labels).size, labels.length, `labels: ${labels.join(' | ')}`);
    assert.ok(labels.some((l) => /^Member list, \d+ of 2 others online/.test(l)), labels.join(' | '));
    assert.ok(labels.includes('Manage members, 3'));
    // No two buttons draw the same icon (it was two identical "people" icons).
    const icons = await robin.locator('.main .bar-end button[aria-label]').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.querySelector('svg')?.innerHTML || ''));
    assert.deepEqual(icons.filter((s, i) => s && icons.indexOf(s) !== i), [], 'repeated icons');
    // Phone: the rarely used ones live in More.
    await phone.evaluate(() => import('/js/store.js').then((s) => s.openConv('g_sat')));
    await phone.locator('.screen.push .bar-title:has-text("Saturday load")').waitFor();
    assert.equal(await phone.locator('.screen.push .bar-end button[aria-label^="Member list"]').count(), 0);
    await phone.click('.screen.push .bar-end button[aria-label="More"]');
    await phone.locator('.menu-item:has-text("Members (3)")').waitFor();
  } finally { await close(robin); await close(phone); }
});

// ---------- Phone, 390x844 with touch ----------

test('phone: signing out and back in without reloading keeps the phone layout', async () => {
  const phone = await open({ handle: 'ines', phone: true });
  try {
    await phone.locator('.phone .tabs').waitFor();
    await phone.click('.tab:has-text("You")');
    await phone.click('.you-list .row:has-text("Sign out")');
    await phone.click('.modal button:text-is("Sign out")');
    await phone.waitForSelector('.auth-form');
    await signIn(phone, 'robin');
    await phone.locator('.phone .tabs').waitFor();
    assert.equal(await phone.locator('.app .nav').count(), 0, 'no desktop sidebar');
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no sideways scroll');
  } finally { await close(phone); }
});

test('phone: Back from a room returns to the house’s room list, then Home; voice rooms show to a newcomer there', async () => {
  const phone = await open({ handle: 'robin', phone: true });
  try {
    await phone.click('.home-house:has-text("Kiln & Co.")');
    await phone.locator('.screen.push .phone-house').waitFor();
    await phone.click('.screen.push .row:has-text("Glaze lab")');
    await phone.locator('.screen.push .composer textarea').waitFor();
    await phone.click('.screen.push [aria-label="Back"]');
    await phone.locator('.screen.push .phone-house').waitFor();
    assert.equal(await phone.evaluate(() => window.snug.S.ui.view.type), 'house');
    // The hardware back button agrees.
    await phone.click('.screen.push .row:has-text("Show & tell")');
    await phone.locator('.screen.push .composer textarea').waitFor();
    await phone.goBack();
    await phone.locator('.screen.push .phone-house').waitFor();
    await phone.click('.screen.push [aria-label="Back"]');
    await phone.waitForFunction(() => !document.querySelector('.screen.push'));
    await phone.locator('.tab[aria-selected="true"]:has-text("Home")').waitFor();
  } finally { await close(phone); }

  // A newcomer on a phone: lands in The floor; the house page lists the voice rooms.
  const robin = await open({ handle: 'robin' });
  const { code } = await invite(robin);
  await close(robin);
  const guest = await open({ path: `/join/${code}`, phone: true });
  try {
    await guest.fill('#auth-handle', 'phone_joiner');
    await guest.fill('#auth-name', 'Gabija');
    await guest.fill('#auth-pass', 'quiet green kettle');
    await guest.click('.auth-form button[type=submit]');
    await guest.click('.modal >> text=Join Kiln & Co.');
    await guest.waitForFunction(() => window.snug.S.ui.view.id === 'k_floor');
    await guest.locator('.screen.push .welcome h2').waitFor();
    const box = await guest.locator('.screen.push .welcome h2').boundingBox();
    assert.ok(box.y >= 0 && box.y < 844, `welcome title on screen at ${box.y}`);
    await guest.click('.screen.push [aria-label="Back"]');
    await guest.click('.home-house:has-text("Kiln & Co.")');
    await guest.locator('.screen.push .row:has-text("Wheel room")').waitFor();
    await guest.locator('.screen.push .row:has-text("Browse 4 more rooms")').waitFor();
    assert.equal(await guest.locator('.screen.push .row:has-text("Glaze lab")').count(), 0);
  } finally { await close(guest); }
});

test('phone: a long press opens the sheet without choosing what lands under the finger, and the message stays in view', async () => {
  const phone = await open({ handle: 'robin', phone: true });
  try {
    await phone.click('.home-house:has-text("Kiln & Co.")');
    await phone.click('.screen.push .row:has-text("Glaze lab")');
    await phone.locator('.screen.push .composer textarea').waitFor();
    const msg = phone.locator('.screen.push .msg').last();
    await msg.waitFor();
    const r = await msg.boundingBox();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + Math.min(r.height / 2, 30));
    const cdp = await phone.context().newCDPSession(phone);
    const before = await phone.evaluate(() => ({ reply: { ...window.snug.S.ui.reply }, pane: window.snug.S.ui.pane, saved: window.snug.S.saved.length }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await phone.locator('.menu[role="menu"]').waitFor({ timeout: 3000 });
    await new Promise((res) => setTimeout(res, 150));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((res) => setTimeout(res, 500));
    // Lifting the finger chose nothing: the sheet is still open and nothing changed.
    await phone.locator('.menu[role="menu"]').waitFor();
    const after = await phone.evaluate(() => ({ reply: { ...window.snug.S.ui.reply }, pane: window.snug.S.ui.pane, saved: window.snug.S.saved.length }));
    assert.deepEqual(after, before);
    // The pressed message is above the sheet, not under it.
    const sheet = await phone.locator('.menu[role="menu"]').boundingBox();
    const m2 = await phone.locator('.screen.push .msg.menu-open').boundingBox();
    assert.ok(m2.y + m2.height <= sheet.y + 1, `message ends at ${m2.y + m2.height}, sheet starts at ${sheet.y}`);
    // A real tap afterwards still works.
    await phone.locator('.menu-item:has-text("Reply")').tap();
    await phone.waitForFunction(() => Object.keys(window.snug.S.ui.reply).length > 0);
  } finally { await close(phone); }
});

test('phone: notification settings are written for a phone', async () => {
  const phone = await open({ handle: 'robin', phone: true });
  try {
    await phone.click('.tab:has-text("You")');
    await phone.click('.you-list .row:has-text("Notifications")');
    await phone.locator('.set-row:has-text("Notifications while Snug is open")').waitFor();
    const text = await phone.locator('.layer').textContent();
    assert.doesNotMatch(text, /beside the address|top of the sidebar|another tab|Desktop notifications/);
    assert.match(text, /You tab/);
  } finally { await close(phone); }
});
