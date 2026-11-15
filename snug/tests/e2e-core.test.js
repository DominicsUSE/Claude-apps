// Snug 0.12 core track in Chromium against the real server and the sample
// data: close matches in search, disappearing messages, the offline app
// shell, drafts that keep their reply, offline reactions and edits, the
// connection page, and long conversations.
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-core-'));
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
test.after(async () => { await browser?.close(); await srv?.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 800 }, phone = false, ctx: given, clock = false } = {}) {
  const ctx = given || await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport });
  const page = await ctx.newPage();
  if (clock) await page.clock.install(); // a clock the test can move forward
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|net::ERR/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector(phone ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
async function openPlace(page, house) {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function go(page, name, house = 'Kiln & Co.') {
  await openPlace(page, house);
  await page.click(`.nav .row:has-text("${name}")`);
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
const say = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };
const msg = (page, text) => page.locator('.main .msg', { hasText: text });

test('search: a misspelt word shows close matches, and says so', async () => {
  const page = await person('robin');
  await page.evaluate(() => { window.snug.S.ui.view = { type: 'search', q: 'pyrometr' }; window.snug.emit(); });
  await page.locator('.search-results .item', { hasText: 'pyrometer' }).first().waitFor();
  assert.match(await page.locator('.search-close').innerText(), /close matches/i);
  // An exact word: no such note, and the list is in order of relevance.
  await page.evaluate(() => { window.snug.S.ui.view = { type: 'search', q: 'pyrometer' }; window.snug.emit(); });
  await page.locator('.search-results .view-note', { hasText: 'best matches first' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.search-close'));
  assert.ok(await page.locator('.search-results .item', { hasText: 'pyrometer' }).count() >= 1);
  await page.context().close();
});

test('quiet hours: one weekday set to quiet all day is saved for every device', async () => {
  const page = await person('ines');
  await page.click('.me-row [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Notifications")');
  await page.locator('.layer-body h1').waitFor();
  // Switch quiet hours on, then make Saturday quiet all day.
  const sw = page.getByRole('switch', { name: 'Quiet hours' });
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
  await page.selectOption('#quiet-day-6', 'all');
  await page.selectOption('#quiet-day-3', 'own');
  await page.getByLabel('Wednesday quiet from').fill('13:00');
  await page.getByLabel('Wednesday quiet from').dispatchEvent('change');
  const id = srv.db.get("SELECT id FROM users WHERE handle = 'ines'").id;
  const saved = async () => JSON.parse(srv.db.get('SELECT prefs FROM user_prefs WHERE user = ?', id)?.prefs || '{}').quiet;
  for (let i = 0; i < 50 && (await saved())?.days?.[3]?.from !== 780; i++) await page.waitForTimeout(100);
  const q = await saved();
  assert.equal(q.days[6], 'all');
  assert.equal(q.days[3].from, 13 * 60);
  assert.equal(q.days[1], null);
  await page.context().close();
});

const dmWith = (page, handle) => page.evaluate((h) => {
  const S = window.snug.S;
  const other = Object.values(S.users).find((u) => u.handle === h).id;
  return Object.keys(S.dms).find((id) => S.dms[id].members.length === 2 && S.dms[id].members.includes(other) && !S.dms[id].group);
}, handle);
const openDm = async (page, id) => {
  await page.evaluate((d) => { window.snug.S.ui.view = { type: 'conv', id: d }; window.snug.S.ui.depth = 1; window.snug.emit(); }, id);
  await page.locator('.main .composer textarea').waitFor();
};

test('disappearing messages: set from the header, a line says so, the timer shows, and a message goes on time even offline', async () => {
  const robin = await person('robin');
  const ines = await person('ines', { clock: true });
  const dm = await dmWith(robin, 'ines');
  assert.ok(dm, 'robin and ines have a conversation in the sample data');
  await openDm(robin, dm);
  await openDm(ines, dm);
  await robin.click('.main .bar-more');
  await robin.click('.menu [role=menuitem]:has-text("Disappearing messages")');
  const dialog = robin.locator('.ttl-form');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /copy or screenshot/);
  assert.match(await dialog.innerText(), /backups/);
  await dialog.locator('label:has-text("1 hour")').click();
  await dialog.locator('button[type=submit]').click();
  await robin.locator('.dmline', { hasText: 'turned on disappearing messages' }).waitFor();
  await ines.locator('.dmline', { hasText: 'turned on disappearing messages' }).waitFor();
  assert.match(await ines.locator('.main .ttl-btn').innerText(), /1 hour/);
  await say(robin, 'this note will vanish');
  await msg(ines, 'this note will vanish').waitFor();
  // Ines goes offline; an hour later the message is gone from her screen anyway.
  await ines.context().setOffline(true);
  await ines.clock.fastForward('01:00:30');
  await msg(ines, 'this note will vanish').waitFor({ state: 'detached' });
  await ines.context().setOffline(false);
  // The server's sweep removes it everywhere (its own clock, moved forward here).
  srv.expiry.sweep(Date.now() + 3_600_000 + 60_000);
  await msg(robin, 'this note will vanish').waitFor({ state: 'detached' });
  assert.equal(srv.db.get("SELECT text FROM messages WHERE text = 'this note will vanish'"), undefined);
  await robin.context().close();
  await ines.context().close();
});
