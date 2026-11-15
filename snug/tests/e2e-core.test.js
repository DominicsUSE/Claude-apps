// Snug 0.12 core track in Chromium against the real server and the sample
// data: close matches in search, disappearing messages, the offline app
// shell, drafts that keep their reply, offline reactions and edits, the
// connection page, and long conversations.
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

// The service worker's copy of the app is complete (it writes its version last).
// page.evaluate awaits the promise; page.waitForFunction would not wait for it.
const shellKept = (page) => page.evaluate(async () => {
  for (let i = 0; i < 300; i++) {
    if (await (await caches.open('snug-shell-v1')).match('/__version')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the app shell was never kept');
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
  await robin.locator('.dmline', { hasText: 'set messages to disappear after 1 hour' }).waitFor();
  await ines.locator('.dmline', { hasText: 'set messages to disappear after 1 hour' }).waitFor();
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

test('PWA: the app shell is kept by the service worker and opens with no connection, showing this device’s copy', async () => {
  const page = await person('robin');
  // The worker installs and keeps every file of the app.
  await shellKept(page);
  const kept = await page.evaluate(async () => (await (await caches.open('snug-shell-v1')).keys()).map((r) => new URL(r.url).pathname));
  assert.ok(kept.includes('/') && kept.includes('/js/app.js') && kept.includes('/css/tokens.css'));
  assert.equal(kept.some((p) => p.startsWith('/api/')), false, 'nothing from the API is kept');
  await go(page, 'Glaze lab');
  await msg(page, 'pyrometer').first().waitFor();
  // Wait for the device copy of the data to be written (it's throttled).
  await page.waitForFunction(() => !!localStorage.getItem('snug.cache'));
  await page.waitForTimeout(2500);
  // No connection: reload. The page, scripts and styles come from the worker's copy,
  // the messages from the device copy, and Snug says it can't reach the server.
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 15000 });
  await msg(page, 'pyrometer').first().waitFor();
  await page.waitForFunction(() => window.snug.S.conn.socket !== 'open');
  assert.match(await page.locator('.main').innerText(), /You.re offline/);
  await page.context().setOffline(false);
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open', null, { timeout: 30000 });
  await page.context().close();
});

test('PWA: the manifest is linked and complete enough to install (checked in the browser)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(url);
  const m = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]').href;
    return (await fetch(href)).json();
  });
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.ok(m.screenshots.some((s) => s.form_factor === 'narrow'));
  // Chromium's own manifest parser: no errors for this manifest.
  const cdp = await ctx.newCDPSession(page);
  const r = await cdp.send('Page.getAppManifest');
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  await ctx.close();
});

test('drafts: the reply target and an uploaded attachment survive a reload, then send together', async () => {
  const page = await person('priya');
  await go(page, 'Glaze lab');
  const target = msg(page, 'keep it off the bottom third');
  await target.hover();
  await target.locator('button[aria-label="Reply"]').click();
  await box(page).fill('draft that replies, with a file');
  await page.locator('.main .composer input[type=file]').setInputFiles({ name: 'recipe.txt', mimeType: 'text/plain', buffer: Buffer.from('copper green: 2% CuCO3') });
  await page.locator('.composer-files .pending-file', { hasText: 'recipe.txt' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.composer-files')?.textContent.includes('Uploading'));
  await page.waitForTimeout(600); // the draft is saved shortly after a change
  await page.reload();
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  await page.locator('.main .bar-title:has-text("Glaze lab")').waitFor();
  assert.equal(await box(page).inputValue(), 'draft that replies, with a file');
  assert.match(await page.locator('.main .composer').innerText(), /Replying to\s+Tomasz/);
  await page.locator('.composer-files .pending-file', { hasText: 'recipe.txt' }).waitFor();
  await box(page).press('Enter');
  const sent = await page.waitForFunction(() => {
    const id = Object.values(window.snug.S.msgs).flat().find((m) => m.text === 'draft that replies, with a file' && !m.state)?.id;
    return id || null;
  });
  const id = await sent.jsonValue();
  const row = srv.db.get('SELECT reply_to, files FROM messages WHERE id = ?', id);
  assert.ok(row.reply_to, 'sent as a reply');
  assert.equal(JSON.parse(row.files)[0].name, 'recipe.txt');
  // Nothing of it is left for the next reload.
  assert.equal(await page.evaluate(() => JSON.stringify(window.snug.S.ui.reply)), '{}');
  assert.equal(await page.evaluate(() => Object.keys(window.snug.S.draftFiles).length), 0);
  await page.context().close();
});

test('offline: a reaction and an edit made with no connection wait, survive a reload, and are sent when it is back', async () => {
  const page = await person('robin');
  await go(page, 'Glaze lab');
  // The service worker must have the app, so the offline reload below works.
  await shellKept(page);
  await page.context().setOffline(true);
  await page.evaluate(() => window.snug.voiceTest.dropSocket());
  await page.waitForFunction(() => window.snug.S.conn.socket !== 'open');
  const tomasz = msg(page, 'keep it off the bottom third');
  const robinId = srv.db.get("SELECT id FROM users WHERE handle = 'robin'").id;
  const tm = srv.db.get("SELECT id FROM messages WHERE text LIKE '%keep it off the bottom third%'").id;
  const emoji = srv.db.get('SELECT emoji FROM reactions WHERE msg = ? LIMIT 1', tm).emoji;
  const had = !!srv.db.get('SELECT 1 FROM reactions WHERE msg = ? AND user = ? AND emoji = ?', tm, robinId, emoji);
  await tomasz.locator('.rx:not(.add)').first().click(); // robin's reaction on the one already there, toggled
  await page.locator('.toast', { hasText: 'kept here' }).waitFor();
  // Edit robin's own message (the last one robin wrote here): Up arrow in an empty box.
  await box(page).fill('');
  await box(page).press('ArrowUp');
  await page.locator('.msg-edit textarea').fill('Has anyone layered satin white over tenmoku? Edited offline.');
  await page.locator('.msg-edit textarea').press('Enter');
  await msg(page, 'Edited offline.').waitFor();
  // Still there after a reload with no connection.
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 15000 });
  await msg(page, 'Edited offline.').waitFor();
  assert.equal(await page.evaluate(() => window.snug.S.conn.socket !== 'open'), true);
  // Back online: both reach the server, and the screen doesn't flick back.
  await page.context().setOffline(false);
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open', null, { timeout: 30000 });
  for (let i = 0; i < 50 && !srv.db.get("SELECT 1 FROM messages WHERE text LIKE '%Edited offline.%'"); i++) await page.waitForTimeout(100);
  assert.ok(srv.db.get("SELECT 1 FROM messages WHERE text LIKE '%Edited offline.%'"), 'the edit reached the server');
  assert.equal(!!srv.db.get('SELECT 1 FROM reactions WHERE msg = ? AND user = ? AND emoji = ?', tm, robinId, emoji), !had, 'the reaction change reached the server');
  await msg(page, 'Edited offline.').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('snug.ops')).then((s) => JSON.parse(s).ops.length), 0, 'nothing left waiting');
  await page.context().close();
});

test('heartbeat: a connection that stops answering is noticed within about 30 seconds and opened again', async () => {
  const page = await person('tomasz');
  const id = srv.db.get("SELECT id FROM users WHERE handle = 'tomasz'").id;
  await page.waitForFunction(() => window.snug.S.conn.rtt != null, null, { timeout: 15000 });
  // The server side of the socket goes silent: it reads nothing and sends nothing (a half-open connection).
  const silent = srv.hub.socketsOf(id);
  for (const ws of silent) { ws.send = () => {}; ws._socket.pause(); }
  const t0 = Date.now();
  await page.waitForFunction(() => window.snug.S.conn.lastError?.text.includes('stopped answering'), null, { timeout: 40000, polling: 500 });
  const noticed = Date.now() - t0;
  assert.ok(noticed <= 36_000, `noticed after ${noticed} ms`);
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open', null, { timeout: 20000 });
  // And it works again.
  await go(page, 'Glaze lab');
  await say(page, 'back after a dead connection');
  for (let i = 0; i < 50 && !srv.db.get("SELECT 1 FROM messages WHERE text = 'back after a dead connection'"); i++) await page.waitForTimeout(100);
  assert.ok(srv.db.get("SELECT 1 FROM messages WHERE text = 'back after a dead connection'"));
  for (const ws of silent) ws.terminate(); // the server would drop it at its next check; not after the test
  await page.context().close();
  await new Promise((r) => setTimeout(r, 200));
});

test('Settings > Connection: plain words for the socket, round trip, relay, version and last problem; details copy without secrets', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await person('ines', { ctx });
  await page.waitForFunction(() => window.snug.S.conn.rtt != null, null, { timeout: 15000 });
  await page.click('.me-row [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Connection")');
  await page.locator('.layer-body h1:has-text("Connection")').waitFor();
  const text = await page.locator('.conn-facts').innerText();
  assert.match(text, /Connection to the server\s+Connected/);
  assert.match(text, /Round trip\s+\d+ ms/);
  assert.match(text, /Calls through a relay \(TURN\)\s+Not set up on this server/);
  assert.match(text, new RegExp(`Server version\\s+${JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version.replace(/\./g, '\\.')}`));
  assert.match(await page.locator('.layer').innerText(), new RegExp(`Snug ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version.replace(/\./g, '\\.')}`), 'the settings footer shows the real version');
  // A drop is reported as the last problem.
  await page.evaluate(() => window.snug.voiceTest.dropSocket());
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open' && window.snug.S.conn.attempts >= 1, null, { timeout: 20000 });
  assert.match(await page.locator('.conn-facts').innerText(), /Reconnects since this page opened\s+1/);
  await page.click('button:has-text("Copy details")');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /^Snug connection details/);
  assert.equal(/127\.0\.0\.1|snug_session|password/i.test(copied), false, 'no addresses or secrets');
  await ctx.close();
});

test('long conversations: scrolling far back loads pages, coming back to the bottom lets the old ones go, and jumping back still works', async () => {
  const room = srv.db.get("SELECT id FROM rooms WHERE name = 'Marketplace'").id;
  const authors = srv.db.all("SELECT id FROM users WHERE handle IN ('ines', 'tomasz', 'priya')").map((r) => r.id);
  const t0 = Date.now() - 2 * 86_400_000;
  srv.db.tx(() => {
    for (let i = 1; i <= 900; i++) {
      const text = `long line ${i}`;
      srv.db.run('INSERT INTO messages (id, conv, author, ts, text, fold) VALUES (?, ?, ?, ?, ?, ?)', `m_long${String(i).padStart(6, '0')}`, room, authors[i % 3], t0 + i * 60_000, text, text);
    }
  });
  const page = await person('sunniva');
  await go(page, 'Marketplace');
  await msg(page, 'long line 900').waitFor();
  const count = () => page.evaluate(() => document.querySelectorAll('.main .msg').length);
  const held = (r) => page.evaluate((c) => window.snug.S.msgs[c].length, r);
  // Scroll to the top again and again: older pages come in.
  for (let i = 0; i < 30 && (await count()) < 320; i++) {
    const before = await count();
    await page.evaluate(() => document.querySelector('.main .scroller').scrollTo(0, 0));
    await page.waitForFunction((n) => document.querySelectorAll('.main .msg').length > n, before, { timeout: 4000 }).catch(() => {});
  }
  assert.ok((await count()) >= 320, `rendered ${await count()} after scrolling back`);
  // Back to the bottom: what is far above is let go, on screen and in memory.
  await page.evaluate(() => { const s = document.querySelector('.main .scroller'); s.scrollTop = s.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('.main .msg').length <= 120, null, { timeout: 5000 });
  assert.ok((await held(room)) <= 120, `holding ${await held(room)} messages`);
  assert.equal(await page.evaluate((c) => window.snug.S.more[c], room), true, 'the rest loads again when scrolled to');
  // Still at the bottom, with the newest showing.
  await msg(page, 'long line 900').waitFor();
  // Jumping to a message far back loads it again and shows it.
  await page.evaluate(() => { window.snug.S.ui.view = { type: 'search', q: 'long line 42' }; window.snug.emit(); });
  await page.locator('.search-results .item-text', { hasText: /^long line 42$/ }).first().click();
  const target = page.locator('.main .msg', { has: page.locator('.body, .text, p', { hasText: /^long line 42$/ }) });
  await page.locator('.main .msg[data-id="m_long000042"]').waitFor();
  assert.ok(await page.locator('.main .msg[data-id="m_long000042"]').isVisible(), 'the old message is on screen');
  void target;
  await page.context().close();
});
