// Inbox, direct conversations and the app shell, in Chromium against the real
// server with the sample data: a mention older than the loaded page still
// counts and stays in Catch up > Mentions, the installed-app badge, renaming
// and adding people to a group across two browsers, closing and reopening a
// conversation, the Friends Blocked tab and filter, and the landmarks.
//   node --test tests/e2e-shell.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-shell-'));
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

async function person(handle, { init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  if (handle) {
    await page.fill('#auth-handle', handle);
    await page.fill('#auth-pass', PASSWORD);
    await page.click('.auth-form button[type=submit]');
    await page.waitForSelector('.nav');
    await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  }
  return page;
}

// Someone else, on a plain socket: sends what the test needs quickly.
async function socket(handle) {
  const res = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ handle, password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { cookie, origin: url } });
  const acks = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (buf) => { const m = JSON.parse(buf); if (m.t === 'hello') resolve(); else if (m.t === 'ack') acks.get(m.id)?.(m); });
  });
  const op = (name, d = {}) => { const id = ++seq; ws.send(JSON.stringify({ t: 'op', id, op: name, d })); return new Promise((r) => acks.set(id, r)); };
  return { op, close: () => ws.close() };
}
let n = 0;
const mid = () => `m_e2eshell${String(++n).padStart(6, '0')}x`;

test('a mention older than the loaded page shows in the badge and in Catch up > Mentions, and stays after reading', async () => {
  const room = 'k_glaze';
  // Robin has read the glaze lab up to now; Ines then writes 100 messages, the 10th mentioning Robin.
  srv.db.run('INSERT INTO reads (user, conv, ts) VALUES (?, ?, ?) ON CONFLICT (user, conv) DO UPDATE SET ts = excluded.ts', 'robin', room, Date.now());
  const ines = await socket('ines');
  for (let i = 1; i <= 100; i++) {
    if (i % 12 === 0) srv.resetLimits();
    const a = await ines.op('msg.send', { conv: room, id: mid(), text: i === 10 ? '@robin the cone 6 test tiles are out of the kiln' : `glaze note ${i}` });
    assert.equal(a.ok, true, a.error);
  }
  ines.close();
  const page = await person('robin', {
    // The installed web app's badge, recorded.
    init: () => { window.__badges = []; navigator.setAppBadge = (nb) => { window.__badges.push(nb); return Promise.resolve(); }; navigator.clearAppBadge = () => { window.__badges.push(0); return Promise.resolve(); }; },
  });
  const state = () => page.evaluate((r) => {
    const S = window.snug.S;
    return { loaded: (S.msgs[r] || []).some((m) => m.text.includes('cone 6 test tiles')), server: S.unread?.[r] || null, badge: window.snug.desktop.badgeCount(), title: document.title, badges: window.__badges };
  }, room);
  await page.waitForFunction(() => window.__badges.length > 0);
  let s = await state();
  assert.equal(s.loaded, false, 'the mention is older than the page this device loaded');
  assert.equal(s.server.needs, 1);
  assert.equal(s.server.count, 100);
  assert.ok(s.badge >= 1);
  assert.match(s.title, new RegExp(`^\\(${s.badge}\\) Snug$`), 'the icon badge and the tab title agree');
  assert.equal(s.badges.at(-1), s.badge, 'navigator.setAppBadge got the same number');
  // The glaze lab's row in the sidebar has a count for Robin.
  await page.click('.rail-house:has-text("Kiln & Co.")');
  await page.locator('.nav .row:has-text("Glaze lab") .badge, .nav .row:has-text("Glaze lab") [class*="count"]').first().waitFor();

  // Catch up > Mentions lists it, from the server.
  await page.click('.rail-home');
  await page.click('.nav .row:has-text("Catch up")');
  await page.click('#cu-tab-mentions');
  const row = page.locator('.mention-row:has-text("cone 6 test tiles")');
  await row.waitFor();
  assert.match(await row.getAttribute('aria-label'), /Ines .* mentioned you in Glaze lab/);
  // Jump goes to the message, fetching the history between.
  await row.locator('[data-jump]').click();
  await page.locator('.main .msg:has-text("cone 6 test tiles")').waitFor();
  // Read it all: the room's menu, Mark read.
  await page.click('.nav .row:has-text("Glaze lab")', { button: 'right' });
  await page.click('.menu-item:has-text("Mark read")');
  await page.waitForFunction((r) => (window.snug.S.read[r] || 0) >= (window.snug.S.unread?.[r]?.upTo || 0), room);
  s = await state();
  // After reading: the count is gone from the badge, the mention stays in Mentions.
  await page.click('.rail-home');
  await page.click('.nav .row:has-text("Catch up")');
  await page.click('#cu-tab-mentions');
  await page.locator('.mention-row:has-text("cone 6 test tiles")').waitFor();
  const after = await page.evaluate((r) => window.snug.S.unread?.[r] && (window.snug.S.read[r] || 0) < window.snug.S.unread[r].upTo, room);
  assert.equal(after, false, 'the server count no longer counts once read');
  // Dismiss with E, from the keyboard.
  await page.locator('.mention-row:has-text("cone 6 test tiles")').focus();
  await page.keyboard.press('e');
  await page.locator('.mention-row:has-text("cone 6 test tiles")').waitFor({ state: 'detached' });
  await page.context().close();
});

test('groups: rename and add a third person across two browsers; close and reopen', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  const openMessages = async (p) => { await p.click('.rail-btn:has(.sr:text-matches("^Messages"))'); await p.locator('.nav .ctx').waitFor(); };
  await openMessages(robin);
  await openMessages(ines);
  // Rename from the conversation's menu.
  await robin.click('.nav .row:has-text("Saturday load")', { button: 'right' });
  await robin.click('.menu-item:has-text("Rename group")');
  await robin.fill('#dm-name', 'Kiln crew');
  await robin.click('.modal button[type=submit]');
  await ines.locator('.nav .row:has-text("Kiln crew")').waitFor();
  await robin.locator('.nav .row:has-text("Kiln crew")').waitFor();
  // The change is a line in the conversation.
  await ines.click('.nav .row:has-text("Kiln crew")');
  await ines.locator('.main .dmline:has-text("named the group Kiln crew")').waitFor();
  // Add a third person (Priya) from the header.
  await robin.click('.nav .row:has-text("Kiln crew")');
  await robin.click('.main .bar [aria-label="Add people"]');
  await robin.fill('.modal [aria-label="Find someone"]', 'Priya');
  await robin.click('.modal .pick-list .menu-item:has-text("Priya")');
  await robin.click('.modal .btn.primary:has-text("Add")');
  await ines.locator('.main .dmline:has-text("added Priya")').waitFor();
  await ines.waitForFunction(() => window.snug.S.dms.g_sat.members.includes('priya'));
  // The members popover lists four, with the owner marked.
  await ines.click('.main .bar [aria-label^="Members"]');
  await ines.locator('.dm-members .dm-member').nth(3).waitFor();
  assert.equal(await ines.locator('.dm-members .dm-member').count(), 4);
  await ines.locator('.dm-members .tag:has-text("Owner")').waitFor();
  await ines.keyboard.press('Escape');

  // Close: it leaves Robin's list; a new message from Ines brings it back.
  await robin.click('.nav .row:has-text("Kiln crew")', { button: 'right' });
  await robin.click('.menu-item:has-text("Close conversation")');
  await robin.locator('.nav .row:has-text("Kiln crew")').waitFor({ state: 'detached' });
  await ines.fill('.main .composer textarea', 'still on for Saturday?');
  await ines.press('.main .composer textarea', 'Enter');
  await robin.locator('.nav .row:has-text("Kiln crew")').waitFor();
  assert.equal(await robin.evaluate(() => !!window.snug.S.dms.g_sat.hidden), false);
  // Pin to top puts it first.
  await robin.click('.nav .row:has-text("Kiln crew")', { button: 'right' });
  await robin.click('.menu-item:has-text("Pin to top")');
  await robin.waitForFunction(() => document.querySelector('.ctx .nav-group .row .trunc')?.textContent.includes('Kiln crew'));
  await robin.context().close();
  await ines.context().close();
});

test('timed mute: Mute for 1 hour shows "Muted until" in the menu, and Unmute clears it', async () => {
  const page = await person('robin');
  await page.click('.rail-house:has-text("Kiln & Co.")');
  await page.click('.nav .row:has-text("Marketplace")', { button: 'right' });
  await page.click('.menu-item:has-text("Mute for…")');
  await page.click('.menu-item:has-text("For 1 hour")');
  await page.waitForFunction(() => window.snug.S.rooms.k_market.notify === 'muted' && window.snug.S.rooms.k_market.notifyUntil > Date.now());
  const until = await page.evaluate(() => window.snug.S.rooms.k_market.notifyUntil);
  assert.ok(Math.abs(until - (Date.now() + 3_600_000)) < 60_000);
  await page.click('.nav .row:has-text("Marketplace")', { button: 'right' });
  await page.locator('.menu-item:has-text("Muted until")').waitFor();
  await page.click('.menu-item:has-text("Unmute")');
  await page.waitForFunction(() => !window.snug.S.rooms.k_market.notifyUntil && window.snug.S.rooms.k_market.notify !== 'muted');
  await page.context().close();
});

test('friends: the Blocked tab unblocks, and the filter box narrows the list (Escape clears)', async () => {
  const page = await person('robin');
  await page.click('.self');
  await page.locator('.me-pop').waitFor();
  await page.keyboard.press('Escape');
  // Block Jonas from a plain socket as Robin would from his profile.
  const me = await socket('robin');
  assert.equal((await me.op('block.set', { user: 'jonas', on: true })).ok, true);
  me.close();
  await page.waitForFunction(() => window.snug.S.safety.blocks.includes('jonas'));
  await page.evaluate(() => { window.snug.S.ui.view = { type: 'friends', tab: 'blocked' }; window.snug.emit(); });
  const row = page.locator('.f-row:has-text("Jonas")');
  await row.waitFor();
  await row.locator('button:has-text("Unblock")').click();
  await page.locator('.friends-view >> text=You haven’t blocked anyone').waitFor();
  assert.equal(await page.evaluate(() => window.snug.S.safety.blocks.includes('jonas')), false);
  // Filter on All.
  await page.click('#f-tab-all');
  const total = await page.locator('.f-list .f-row').count();
  assert.ok(total > 1);
  await page.fill('#f-filter', 'ines');
  await page.waitForFunction(() => document.querySelectorAll('.f-list .f-row').length === 1);
  assert.match(await page.locator('.f-list .f-row').first().textContent(), /Ines/);
  await page.fill('#f-filter', 'zzzz-nobody');
  await page.locator('.friends-view >> text=Nobody by that name').waitFor();
  await page.focus('#f-filter');
  await page.keyboard.press('Escape');
  await page.waitForFunction((t) => document.querySelectorAll('.f-list .f-row').length === t, total);
  await page.context().close();
});

test('landmarks: Tab from load reaches Skip to messages, Enter focuses the composer; F6 cycles regions; one main', async () => {
  const page = await person('robin');
  await page.click('.rail-house:has-text("Kiln & Co.")');
  await page.click('.nav .row:has-text("The floor")');
  await page.locator('.main .composer textarea').waitFor();
  // Start over from the top of the page, as a fresh load would.
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.reload();
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  await page.locator('.main .composer textarea').waitFor();
  // The composer takes the focus when it opens; put the keyboard back at the
  // top of the document, where a page with nothing focused starts.
  await page.evaluate(() => { const s = document.createElement('span'); s.tabIndex = -1; document.body.prepend(s); s.focus(); s.blur(); s.remove(); });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'skip-link');
  const box = await page.locator('.skip-link').boundingBox();
  assert.ok(box.height >= 44 && box.y >= 0, 'visible when focused, 44px tall');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.main .composer textarea')), true);
  assert.equal(await page.locator('main').count(), 1, 'exactly one main landmark');
  // F6: rail, sidebar, main in order; Shift+F6 goes back.
  await page.click('.rail-home');
  await page.click('.rail-house:has-text("Kiln & Co.")');
  await page.click('.nav .row:has-text("The floor")');
  const where = () => page.evaluate(() => ['.rail', '.ctx', '#main', '.pane', '.dock'].find((s) => document.querySelector(s)?.contains(document.activeElement)));
  await page.locator('.rail-house:has-text("Kiln & Co.")').focus();
  assert.equal(await where(), '.rail');
  await page.keyboard.press('F6');
  assert.equal(await where(), '.ctx');
  await page.keyboard.press('F6');
  assert.equal(await where(), '#main');
  await page.keyboard.press('Shift+F6');
  assert.equal(await where(), '.ctx');
  await page.keyboard.press('Shift+F6');
  assert.equal(await where(), '.rail');
  await page.context().close();
});

test('presence for a while: Focused for 1 hour from the presence menu shows "Focused until"; the quick switcher sets 2 hours', async () => {
  const page = await person('robin');
  await page.click('.self');
  await page.click('.me-pop [aria-label="Focused for a while"]');
  await page.click('.pres-times .chip:has-text("1 hour")');
  await page.waitForFunction(() => window.snug.S.users.robin.presence === 'focus' && window.snug.S.users.robin.presenceUntil > Date.now());
  await page.click('.self');
  await page.locator('.me-pop .pres-opt[aria-checked="true"] small:text-matches("Focused until \\\\d")').waitFor();
  await page.keyboard.press('Escape');
  const row = srv.db.get('SELECT presence, presence_until FROM users WHERE id = ?', 'robin');
  assert.equal(row.presence, 'focus');
  assert.ok(row.presence_until > Date.now() + 3_000_000);
  // Back to Around with no time.
  await page.click('.self');
  await page.click('.me-pop .pres-opt:has-text("Around")');
  await page.waitForFunction(() => window.snug.S.users.robin.presence === 'around' && !window.snug.S.users.robin.presenceUntil);
  // The quick switcher offers the same: Focused for 2 hours.
  await page.keyboard.press('Control+k');
  await page.locator('.quick input').fill('focused for 2 hours');
  await page.locator('.quick .menu-item.act:has-text("Focused for 2 hours")').waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.snug.S.users.robin.presence === 'focus' && Math.abs(window.snug.S.users.robin.presenceUntil - Date.now() - 7_200_000) < 60_000);
  assert.ok(srv.db.get('SELECT presence_until FROM users WHERE id = ?', 'robin').presence_until > Date.now() + 7_000_000);
  await page.click('.self');
  await page.click('.me-pop .pres-opt:has-text("Around")');
  await page.waitForFunction(() => window.snug.S.users.robin.presence === 'around');
  await page.context().close();
});
