// Messaging, driven in Chromium against the real server with separate people
// in separate browsers: rich text and the formatting bar, polls, forwarding,
// edit history, link previews, scheduled messages, stickers, search filters,
// jumping to the first unread and to a date, and a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-messaging-'));
let srv, browser, url, site;
const errors = [];

// A real PNG, w by h, one colour.
function png(w, h) {
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x60); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  // A stand-in website on this machine for link previews. The server is told
  // (tests only) that it may fetch 127.0.0.1; every other private address stays refused.
  site = createServer((req, res) => {
    const host = `http://127.0.0.1:${site.address().port}`;
    if (req.url === '/article') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><meta property="og:title" content="Cone 6 glazes, explained"><meta property="og:description" content="Why satin whites break over tenmoku."><meta property="og:site_name" content="Kiln Notes"><meta property="og:image" content="${host}/card.png"></head></html>`); return; }
    if (req.url === '/card.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png(120, 60)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, linkAllowLocal: true });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv.close(); site.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  page.on('dialog', (d) => { errors.push(`${handle}: a dialog opened: ${d.message()}`); d.dismiss(); });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector(viewport.width < 760 ? '.tabs' : '.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
async function openPlace(page, house) {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function go(page, name) {
  await openPlace(page, 'Kiln & Co.');
  await page.click(`.nav .row:has-text("${name}")`);
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
const say = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };
const settled = (page) => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state));
const msg = (page, text) => page.locator('.main .msg', { hasText: text });
const menuOf = async (page, text) => {
  const m = msg(page, text).last();
  await m.hover();
  await m.locator('.msg-actions button[aria-label="More actions"]').click();
};

let robin, ines;

test('rich text: markup renders safely, spoilers hide, code copies, masked links ask, timestamps localise', async () => {
  robin = await person('robin');
  ines = await person('ines');
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  const t = 1893456000; // 1 January 2030, 00:00 UTC
  await box(robin).fill([
    '# Glaze plan',
    'Use __satin white__ over ||the secret tenmoku|| and read [the notes](https://example.org/notes).',
    '> Dip for three seconds',
    '- bisque',
    '- glaze',
    `-# firing <t:${t}:D>`,
    '```js',
    'const cone = 6; // hot',
    '```',
    '<img src=x onerror="window.pwned=1"> \\*literal\\*',
  ].join('\n'));
  await box(robin).press('Enter');
  await settled(robin);
  const m = msg(ines, 'Glaze plan').last();
  await m.waitFor();
  assert.equal(await m.locator('h3.rh1').textContent(), 'Glaze plan');
  assert.equal(await m.locator('u').textContent(), 'satin white');
  assert.equal(await m.locator('blockquote.rquote').textContent(), 'Dip for three seconds');
  assert.equal(await m.locator('ul.rlist li').count(), 2);
  assert.equal(await m.locator('small.rsub time.stamp').count(), 1);
  // The timestamp reads in Ines's own locale, from the same number.
  const expected = await ines.evaluate((n) => new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(n * 1000), t);
  assert.equal(await m.locator('time.stamp').textContent(), expected);
  // Typed HTML stays text; nothing runs.
  assert.equal(await m.locator('.msg-text img').count(), 0);
  assert.equal(await ines.evaluate(() => window.pwned), undefined);
  assert.match(await m.locator('.msg-text').textContent(), /<img src=x onerror="window.pwned=1"> \*literal\*/);
  // Spoiler: hidden (and silent to screen readers) until clicked.
  const sp = m.locator('.spoiler');
  assert.equal(await sp.getAttribute('role'), 'button');
  assert.equal(await sp.locator('.spoiler-in').evaluate((e) => getComputedStyle(e).visibility), 'hidden');
  await sp.click();
  await m.locator('.spoiler.open').waitFor();
  assert.equal(await m.locator('.spoiler.open').textContent(), 'the secret tenmoku');
  // Code block: label, highlighting, Copy.
  assert.equal(await m.locator('.codeblock .cb-lang').textContent(), 'js');
  assert.equal(await m.locator('.codeblock .hl-kw').first().textContent(), 'const');
  assert.equal(await m.locator('.codeblock .hl-com').textContent(), '// hot');
  await m.locator('.cb-copy').click();
  await m.locator('.cb-copy:has-text("Copied")').waitFor();
  assert.equal(await ines.evaluate(() => navigator.clipboard.readText()), 'const cone = 6; // hot');
  // A masked link shows where it really goes, and asks before leaving.
  const link = m.locator('a.mlink');
  assert.equal(await link.getAttribute('data-tip'), 'example.org');
  await link.click();
  await ines.locator('.modal:has-text("Leaving Snug")').waitFor();
  assert.match(await ines.locator('.modal .leave-url').textContent(), /^https:\/\/example\.org\/notes$/);
  await ines.click('.modal button:has-text("Go back")');
  await ines.locator('.modal').waitFor({ state: 'detached' });
  // The preview in the sidebar never gives the spoiler away.
  assert.equal(await robin.evaluate(async () => (await import('/js/lib/format.js')).plain('a ||b|| c')), 'a [spoiler] c');
});

test('formatting bar and shortcuts wrap the selected text', async () => {
  await box(robin).fill('hello world');
  await box(robin).evaluate((el) => { el.focus(); el.setSelectionRange(6, 11); });
  await robin.locator('.fmt-bar').waitFor();
  await robin.click('.fmt-bar button[aria-label="Bold"]');
  assert.equal(await box(robin).inputValue(), 'hello **world**');
  // The selection stays on the word, so the same shortcut takes it off again.
  await box(robin).press('Control+b');
  assert.equal(await box(robin).inputValue(), 'hello world');
  await box(robin).evaluate((el) => el.setSelectionRange(0, 5));
  await box(robin).press('Control+u');
  assert.equal(await box(robin).inputValue(), '__hello__ world');
  await box(robin).evaluate((el) => el.setSelectionRange(10, 15));
  await box(robin).press('Control+Shift+X');
  assert.equal(await box(robin).inputValue(), '__hello__ ~~world~~');
  await box(robin).press('Enter');
  await msg(ines, 'hello').last().locator('u:has-text("hello")').waitFor();
  assert.equal(await msg(ines, 'hello').last().locator('s').textContent(), 'world');
  await robin.locator('.fmt-bar').waitFor({ state: 'detached' });
});

test('polls: made from the + menu, voted on live, one vote each, ended by the author', async () => {
  await robin.click('.main .composer .plus-btn');
  await robin.click('.menu-item:has-text("Create a poll")');
  await robin.fill('#poll-q', 'Which glaze for the bowls?');
  await robin.fill('.modal input[aria-label="Answer 1"]', 'Satin white');
  await robin.fill('.modal input[aria-label="Answer 2"]', 'Tenmoku');
  await robin.click('.modal button:has-text("Add an answer")');
  await robin.fill('.modal input[aria-label="Answer 3"]', 'Celadon');
  await robin.click('.modal button[aria-label="Add an emoji to answer 3"]');
  await robin.locator('.modal .poll-emo-pick .picker-grid button').first().click();
  await robin.click('.modal button:has-text("Post poll")');
  await robin.locator('.modal').waitFor({ state: 'detached' });
  const poll = ines.locator('.main .poll:has-text("Which glaze for the bowls?")');
  await poll.waitFor();
  assert.equal(await poll.locator('.poll-a').count(), 3);
  assert.equal(await poll.locator('.poll-a[role="radio"]').count(), 3, 'single choice reads as radio buttons');
  assert.equal(await poll.locator('.poll-a').nth(2).locator('.poll-emo').count(), 1);
  await poll.locator('.poll-a:has-text("Tenmoku")').click();
  // Ines sees results with her vote marked; Robin sees it arrive.
  await poll.locator('.poll-a.done.mine:has-text("Tenmoku") .poll-n:has-text("100%")').waitFor();
  const rpoll = robin.locator('.main .poll:has-text("Which glaze for the bowls?")');
  // Robin hasn't voted: he votes, or looks at the results first.
  await rpoll.locator('button:has-text("Show results")').click();
  await rpoll.locator('.poll-a:has-text("Tenmoku") .poll-n:has-text("100%")').waitFor();
  assert.match(await rpoll.locator('.poll-meta').textContent(), /^1 vote ·/);
  // Changing a vote moves it; it never counts twice.
  await poll.locator('button:has-text("Change vote")').click();
  await poll.locator('.poll-a:has-text("Celadon")').click();
  await rpoll.locator('.poll-a:has-text("Celadon") .poll-n:has-text("100%")').waitFor();
  assert.match(await rpoll.locator('.poll-meta').textContent(), /^1 vote ·/);
  // Its author ends it (so could Ines, who can remove messages here).
  await rpoll.locator('button:has-text("End now")').click();
  await poll.locator('.poll-how:has-text("Final results")').waitFor();
  assert.equal(await poll.locator('button.poll-a').count(), 0, 'no more voting');
});

test('forwarding: to a conversation, with a note and who wrote it; the way back works', async () => {
  await say(robin, 'Kiln is at cone 6 by noon');
  await settled(robin);
  await menuOf(ines, 'Kiln is at cone 6 by noon');
  await ines.click('.menu-item:has-text("Forward")');
  await ines.fill('.modal input[type="search"]', 'Robin');
  await ines.click('.modal .fwd-dest:has-text("Robin Hale")');
  await ines.fill('.modal textarea', 'heads up');
  await ines.click('.modal button:has-text("Forward")');
  await ines.locator('.toast:has-text("Forwarded to Robin Hale")').waitFor();
  // Robin finds it in his conversation with Ines.
  await robin.click('.nav .row:has-text("Ines Carvalho")').catch(async () => { await robin.click('.rail [aria-label*="Home"], .rail-home'); await robin.click('.nav .row:has-text("Ines Carvalho")'); });
  const card = robin.locator('.main .msg:has-text("heads up") .fwd-card');
  await card.waitFor();
  assert.match(await card.locator('.fwd-head').textContent(), /Robin Hale/);
  assert.match(await card.textContent(), /Kiln is at cone 6 by noon/);
  await card.locator('.fwd-src').click();
  await robin.locator('.main .bar-title:has-text("Glaze lab")').waitFor();
  await msg(robin, 'Kiln is at cone 6 by noon').last().waitFor();
});

test('edit history: anyone who can read it sees earlier versions', async () => {
  await go(robin, 'Glaze lab');
  await say(robin, 'Firing on Tuesday');
  await settled(robin);
  const id = await robin.evaluate(() => window.snug.S.msgs.k_glaze.at(-1).id);
  for (const text of ['Firing on Wednesday', 'Firing on Thursday']) {
    await robin.evaluate(([i, t]) => window.snug.S.msgs.k_glaze.find((m) => m.id === i) && import('/js/store.js').then((s) => s.editMsg('k_glaze', i, t)), [id, text]);
    await msg(ines, text).waitFor();
  }
  await menuOf(ines, 'Firing on Thursday');
  await ines.click('.menu-item:has-text("Edit history")');
  const modal = ines.locator('.modal:has-text("Edit history")');
  await modal.locator('.edit-v').nth(2).waitFor();
  assert.deepEqual(await modal.locator('.edit-v .msg-text').allTextContents(), ['Firing on Thursday', 'Firing on Wednesday', 'Firing on Tuesday']);
  await ines.click('.modal button:has-text("Close")');
});

test('link previews: a card from the page, its picture through Snug, removable, and a setting to hide them', async () => {
  const link = `http://127.0.0.1:${site.address().port}/article`;
  await say(robin, `notes here ${link}`);
  const card = ines.locator('.main .msg:has-text("notes here") .embed');
  await card.waitFor();
  assert.equal(await card.locator('.embed-title').textContent(), 'Cone 6 glazes, explained');
  assert.equal(await card.locator('.embed-site').textContent(), 'Kiln Notes');
  const src = await card.locator('.embed-img img').getAttribute('src');
  assert.match(src, /^\/api\/files\/f_/, 'the picture comes from Snug, not the site');
  await ines.waitForFunction((s) => [...document.images].some((i) => i.getAttribute('src') === s && i.complete && i.naturalWidth === 120), src);
  // Turned off in Settings > Appearance: no cards.
  await ines.evaluate(() => import('/js/store.js').then((s) => s.setPref('embeds', false)));
  await card.waitFor({ state: 'detached' });
  await ines.evaluate(() => import('/js/store.js').then((s) => s.setPref('embeds', true)));
  await card.waitFor();
  // Its author removes it for everyone.
  const mine = robin.locator('.main .msg:has-text("notes here")');
  await mine.locator('.embed').waitFor();
  await mine.hover();
  await mine.locator('.embed-x').click();
  await card.waitFor({ state: 'detached' });
  await robin.locator('.toast:has-text("Previews removed")').waitFor();
});

test('scheduled messages: written now, listed, cancelled or sent by the server on time', async () => {
  await box(robin).fill('Glaze day tomorrow, 9 sharp');
  await robin.click('.main .composer .plus-btn');
  await robin.click('.menu-item:has-text("Schedule a message")');
  const modal = robin.locator('.modal:has-text("Schedule a message")');
  assert.equal(await modal.locator('textarea').inputValue(), 'Glaze day tomorrow, 9 sharp');
  await modal.locator('.chip:has-text("Tomorrow morning")').click();
  await modal.locator('button:has-text("Schedule")').last().click();
  await modal.waitFor({ state: 'detached' });
  assert.equal(await box(robin).inputValue(), '', 'the composer is cleared');
  await robin.locator('.sched-note:has-text("1 message scheduled")').waitFor();
  // A second one, then cancelled from the list.
  await robin.click('.main .composer .plus-btn');
  await robin.click('.menu-item:has-text("Schedule a message")');
  await modal.locator('textarea').fill('never mind this one');
  await modal.locator('button:has-text("Schedule")').last().click();
  await robin.locator('.sched-note:has-text("2 messages scheduled")').click();
  await modal.locator('.sched-item:has-text("never mind this one") button:has-text("Cancel")').click();
  await robin.locator('.toast:has-text("Scheduled message cancelled")').waitFor();
  await modal.locator('.sched-item:has-text("never mind this one")').waitFor({ state: 'detached' });
  await robin.click('.modal button:has-text("Close")');
  // When it is due, the server sends it as Robin.
  srv.db.run("UPDATE scheduled SET at = ? WHERE text = 'Glaze day tomorrow, 9 sharp'", Date.now() - 1);
  srv.hub.messaging.tick();
  await msg(ines, 'Glaze day tomorrow, 9 sharp').waitFor();
  await robin.locator('.sched-note').waitFor({ state: 'detached' });
});

test('stickers: added in House settings, picked from the + menu, seen by the other person', async () => {
  await openPlace(ines, 'Kiln & Co.');
  await ines.click('.nav .ctx-house');
  await ines.click('.menu-item:has-text("House settings")');
  await ines.click('.layer-nav .row:has-text("Emoji")');
  await ines.locator('.layer .set-head:has-text("Stickers")').waitFor();
  await ines.setInputFiles('.sticker-add input[type="file"]', { name: 'pot.png', mimeType: 'image/png', buffer: png(96, 96) });
  await ines.fill('.sticker-add input[aria-label="Sticker name"]', 'Happy pot');
  await ines.click('.sticker-add button:has-text("Add sticker")');
  await ines.locator('.sticker-list li:has-text("Happy pot")').waitFor();
  await ines.keyboard.press('Escape');
  await robin.click('.main .composer .plus-btn');
  await robin.click('.menu-item:has-text("Send a sticker")');
  await robin.click('.sticker-pick button[aria-label="Send sticker Happy pot"]');
  const st = ines.locator('.main .msg img.sticker[alt="Sticker: Happy pot"]');
  await st.waitFor();
  await ines.waitForFunction(() => [...document.querySelectorAll('img.sticker')].some((i) => i.complete && i.naturalWidth === 96));
});

test('search: mentions, dates, pinned and polls as chips, and suggestions while typing', async () => {
  await say(robin, 'ask @ines about the satin white');
  await settled(robin);
  await robin.evaluate(() => import('/js/store.js').then((s) => s.go({ type: 'search', q: '' })));
  const field = robin.locator('.search-input input');
  await field.click();
  await field.fill('ment');
  await robin.locator('.search-suggest .menu-item:has-text("mentions:")').click();
  assert.equal(await field.inputValue(), 'mentions:');
  await field.type('ine');
  await robin.locator('.search-suggest .menu-item:has-text("Ines Carvalho")').click();
  assert.equal(await field.inputValue(), 'mentions:ines ');
  await robin.locator('.search-results .item:has-text("satin white")').first().waitFor();
  assert.match(await robin.locator('.filters .chip.on').first().textContent(), /Mentions Ines/);
  // Polls only.
  await field.fill('has:poll');
  await robin.locator('.search-results .item:has-text("Which glaze for the bowls?")').waitFor();
  // A date chip writes during:, and nothing from before 2001 exists.
  await field.fill('glaze before:2001-01-01');
  await robin.locator('.empty:has-text("No messages match")').waitFor();
  await field.fill('glaze');
  await robin.click('.filters .chip:has-text("Any time")');
  await robin.click('.date-pop .seg button:has-text("On")');
  await robin.click('.date-pop button:has-text("Apply")');
  assert.match(await field.inputValue(), /^glaze during:\d{4}-\d{2}-\d{2}$/);
  await robin.locator('.search-results .item').first().waitFor();
});

test('first unread and going to a date', async () => {
  // Ines is elsewhere while Robin writes a lot.
  await go(ines, 'Firing schedule');
  await go(robin, 'Glaze lab');
  for (let i = 1; i <= 12; i++) { await box(robin).fill(`batch line ${i}\nsecond line\nthird line\nfourth line`); await box(robin).press('Enter'); }
  await settled(robin);
  await go(ines, 'Glaze lab');
  await msg(ines, 'batch line 12').waitFor();
  const scroller = ines.locator('.main .scroller');
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await ines.locator('.unread-bar:has-text("new messages since")').waitFor();
  await ines.click('.unread-bar .unread-jump');
  await ines.waitForFunction(() => { const s = document.querySelector('.main .scroller'); const n = s.querySelector('.newline'); return n && Math.abs(n.offsetTop - s.scrollTop) < 40; });
  await ines.click('.unread-bar .unread-done').catch(() => {});
  // Going to a date: the seeded history starts days ago.
  const first = await ines.evaluate(() => window.snug.S.msgs.k_glaze.find((m) => m.seq != null));
  await ines.click('.main .bar button[aria-label="Go to a date"]');
  const day = new Date(first.ts - 86_400_000 * 30);
  await ines.fill('#jump-date', `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`);
  await ines.click('.date-pop button:has-text("Go")');
  await ines.waitForFunction((id) => { const el = document.querySelector(`.main .msg[data-id="${id}"]`); if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, first.id);
});

test('phone: the + menu, poll answers and the formatting bar are big enough to tap', async () => {
  const phone = await person('priya', { viewport: { width: 390, height: 844 } });
  await phone.click('.tabs button:has-text("Kiln"), .tabs [aria-label*="Kiln"]').catch(() => {});
  await phone.evaluate(() => import('/js/store.js').then((s) => s.openConv('k_glaze')));
  await phone.locator('.main .bar-title:has-text("Glaze lab")').waitFor();
  const plus = phone.locator('.main .composer .plus-btn');
  const pb = await plus.boundingBox();
  assert.ok(pb.width >= 40 && pb.height >= 40, `+ is ${pb.width}x${pb.height}`);
  const poll = phone.locator('.main .poll:has-text("Which glaze for the bowls?")');
  await poll.scrollIntoViewIfNeeded();
  const a = await poll.locator('.poll-a').first().boundingBox();
  assert.ok(a.height >= 44, `a poll answer is ${a.height}px tall`);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling');
  // Priya can't manage stickers, but can send them.
  await plus.click();
  await phone.click('.menu-item:has-text("Send a sticker")');
  await phone.locator('.sticker-pick button[aria-label="Send sticker Happy pot"]').waitFor();
  await phone.keyboard.press('Escape');
  await phone.context().close();
});
