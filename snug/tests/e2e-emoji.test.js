// Custom emoji per house, driven in Chromium against the real server, with
// separate people in separate browser sessions: Robin (an owner of Kiln & Co.)
// adds an emoji in House settings; Priya (a member) sees it live, sends it and
// reacts with it; when Robin removes it, both see its name as text instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { deflateSync, crc32 } from 'node:zlib';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-emoji-'));
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

async function person(handle, { viewport = { width: 1280, height: 800 } } = {}) {
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
async function emojiSettings(page) {
  await openPlace(page, 'Kiln & Co.');
  await page.click('.nav .ctx-house');
  await page.click('.menu-item:has-text("House settings")');
  await page.click('.layer-nav .row:has-text("Emoji")');
  await page.locator('.layer h1:has-text("Emoji")').waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
const settled = (page) => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state));
const msg = (page, text) => page.locator('.main .msg', { hasText: text });
// True once the image really loaded from the server, not just that the element exists.
const loaded = (loc) => loc.evaluate((img) => img.complete && img.naturalWidth > 0);

// A real PNG, w by h pixels of one colour, made here so the test needs no fixture.
function png(w, h, rgb = [240, 90, 71]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, () => Buffer.from(rgb))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

let robin, priya;

test('an owner adds an emoji; a member sees it live in the picker, sends it, and both see the image', async () => {
  robin = await person('robin');
  priya = await person('priya');
  await go(priya, 'Glaze lab');

  // Priya has the picker open while Robin adds the emoji: it should appear in it.
  await priya.click('.main .composer [aria-label="Insert an emoji"]');
  await priya.locator('.picker').waitFor();
  assert.equal(await priya.locator('.picker .picker-custom').count(), 0, 'no custom emoji yet');

  await robin.bringToFront();
  await emojiSettings(robin);
  await robin.locator('.emo-empty:has-text("No emoji yet")').waitFor();
  await robin.locator('.set-head:has-text("0 of 100")').waitFor();

  // Too big, checked before upload: the message says why.
  await robin.setInputFiles('.emo-add input[type=file]', { name: 'huge.png', mimeType: 'image/png', buffer: png(300, 300) });
  await robin.locator('.emo-add .err:has-text("300 by 300 pixels")').waitFor();
  // Not an image Snug takes.
  await robin.setInputFiles('.emo-add input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await robin.locator('.emo-add .err:has-text("PNG, GIF or WebP")').waitFor();

  // A good one: uploaded at once, the name comes from the file, and bad names are caught inline.
  await robin.setInputFiles('.emo-add input[type=file]', { name: 'Party Time.png', mimeType: 'image/png', buffer: png(32, 32) });
  await robin.locator('.emo-drop-text:has-text("32 by 32 pixels")').waitFor();
  assert.equal(await robin.inputValue('#emo-name'), 'party_time');
  assert.ok(await loaded(robin.locator('.emo-prev img.lg')), 'the preview shows the image');
  await robin.fill('#emo-name', 'party-time');
  await robin.locator('#emo-name-msg.err:has-text("lowercase letters, numbers and underscores")').waitFor();
  assert.equal(await robin.locator('.emo-add button[type=submit]').isDisabled(), true);
  await robin.fill('#emo-name', 'p');
  await robin.locator('#emo-name-msg.err:has-text("at least 2")').waitFor();
  await robin.fill('#emo-name', 'party');
  await robin.locator('#emo-name-msg.hint').waitFor();
  await robin.click('.emo-add button[type=submit]');
  const row = robin.locator('.emo-row[data-emoji="party"]');
  await row.waitFor();
  assert.ok(await loaded(row.locator('img.cemoji')));
  await robin.locator('.set-head:has-text("1 of 100")').waitFor();
  // Duplicate names are caught before sending.
  await robin.setInputFiles('.emo-add input[type=file]', { name: 'party.png', mimeType: 'image/png', buffer: png(16, 16, [80, 200, 160]) });
  await robin.locator('#emo-name-msg.err:has-text("already an emoji called :party:")').waitFor();
  await robin.fill('#emo-name', 'mint');
  await robin.locator('.emo-drop-text:has-text("16 by 16 pixels")').waitFor();
  await robin.click('.emo-add button[type=submit]');
  await robin.locator('.emo-row[data-emoji="mint"]').waitFor();

  // Live in Priya's open picker, under the house's name.
  await priya.bringToFront();
  await priya.locator('.picker .picker-sec:has-text("Kiln & Co.")').waitFor();
  const inPicker = priya.locator('.picker .picker-custom[aria-label="party (Kiln & Co.)"]');
  await inPicker.waitFor();
  assert.ok(await loaded(inPicker.locator('img')));
  // Search by name; Enter picks the first; it goes in as :party:.
  await priya.fill('.picker input', 'part');
  assert.equal(await priya.locator('.picker-grid button').first().getAttribute('aria-label'), 'party (Kiln & Co.)');
  await priya.press('.picker input', 'Enter');
  await priya.locator('.picker').waitFor({ state: 'detached' });
  assert.equal(await box(priya).inputValue(), ':party:');
  // Keyboard: down into the grid, across, and back up to the search.
  await priya.click('.main .composer [aria-label="Insert an emoji"]');
  await priya.press('.picker input', 'ArrowDown');
  const first = await priya.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await priya.keyboard.press('ArrowRight');
  const second = await priya.evaluate(() => document.activeElement.getAttribute('aria-label'));
  assert.notEqual(first, second);
  await priya.keyboard.press('ArrowLeft');
  assert.equal(await priya.evaluate(() => document.activeElement.getAttribute('aria-label')), first);
  await priya.keyboard.press('ArrowUp');
  assert.equal(await priya.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Find an emoji');
  await priya.keyboard.press('Escape');
  await priya.locator('.picker').waitFor({ state: 'detached' });

  // Autocomplete while typing ":par", like @-mentions.
  await box(priya).fill('');
  await box(priya).pressSequentially('Look at this :par');
  const sug = priya.locator('.main .ac .menu-item:has-text("party")').first();
  await sug.waitFor();
  assert.ok(await loaded(sug.locator('img.cemoji')));
  await box(priya).press('Tab');
  assert.equal(await box(priya).inputValue(), 'Look at this :party: ');
  await box(priya).press('Enter');
  await settled(priya);
  const stored = await priya.evaluate(() => window.snug.S.msgs.k_glaze.at(-1).text);
  assert.match(stored, /^Look at this <:party:em_[a-z0-9]+>$/, 'the message stores the resolved token');

  // Both see the image, at text size.
  const mine = msg(priya, 'Look at this').locator('img.cemoji[alt=":party:"]');
  await mine.waitFor();
  assert.ok(await loaded(mine));
  await robin.bringToFront();
  await robin.keyboard.press('Escape');
  await robin.locator('.layer').waitFor({ state: 'detached' });
  await go(robin, 'Glaze lab');
  const theirs = msg(robin, 'Look at this').locator('img.cemoji[alt=":party:"]');
  await theirs.waitFor();
  assert.ok(await loaded(theirs));
  assert.equal(Math.round((await theirs.boundingBox()).width), 24);

  // Only emoji: shown large, like built-in emoji.
  await priya.bringToFront();
  await box(priya).fill(':party: :mint:');
  await box(priya).press('Enter');
  await settled(priya);
  const big = robin.locator('.main .msg-text.jumbo img.cemoji[alt=":mint:"]');
  await big.waitFor();
  assert.equal(Math.round((await big.boundingBox()).width), 48);
});

test('reactions with a custom emoji sync both ways', async () => {
  const target = msg(robin, 'Look at this');
  await target.hover();
  await target.locator('.msg-actions [aria-label="Add a reaction"]').click();
  await robin.locator('.picker .picker-custom[aria-label="party (Kiln & Co.)"]').click();
  const chip = msg(priya, 'Look at this').locator('.rx:not(.add)');
  await chip.waitFor();
  assert.ok(await loaded(chip.locator('img.cemoji')), 'the reaction shows the image');
  assert.match(await chip.getAttribute('aria-label'), /^:party:, 1 reaction: Robin/);
  await chip.click();
  await msg(robin, 'Look at this').locator('.rx.mine:has-text("2")').waitFor();
  await msg(priya, 'Look at this').locator('.rx.mine:has-text("2")').waitFor();
  // It's now among Robin's recent emoji.
  await target.hover();
  await target.locator('.msg-actions [aria-label="Add a reaction"]').click();
  await robin.locator('.picker .picker-sec:has-text("Recent") + .picker-custom[aria-label="party (Kiln & Co.)"]').waitFor();
  await robin.keyboard.press('Escape');
});

test('a removed emoji falls back to its name as text, for everyone', async () => {
  await emojiSettings(robin);
  await robin.click('[aria-label="Remove :party:"]');
  await robin.click('.modal .btn.danger:has-text("Remove emoji")');
  await robin.locator('.emo-row[data-emoji="party"]').waitFor({ state: 'detached' });
  await robin.keyboard.press('Escape');
  await robin.locator('.layer').waitFor({ state: 'detached' });

  for (const page of [priya, robin]) {
    const m = msg(page, 'Look at this');
    await m.locator('.msg-text .cemoji-gone:has-text(":party:")').waitFor();
    assert.equal(await m.locator('img.cemoji').count(), 0);
    await m.locator('.rx .cemoji-gone:has-text(":party:")').waitFor();
  }
  // The other emoji still shows.
  assert.ok(await loaded(robin.locator('.main .msg-text.jumbo img.cemoji[alt=":mint:"]')));
  // After a reload too.
  await priya.reload();
  await priya.waitForFunction(() => window.snug.S.conn.socket === 'open');
  await priya.locator('.main .msg:has-text("Look at this") .msg-text .cemoji-gone:has-text(":party:")').waitFor();
  assert.equal(await priya.locator('.picker-custom[aria-label^="party"]').count(), 0);

  // The role editor shows the permission. Given to Priya's role, she can manage
  // emoji from the house menu, without the rest of House settings.
  await priya.click('.rail-house:has-text("Kiln & Co.")', { button: 'right' });
  await priya.locator('.menu-item:has-text("Browse rooms")').waitFor();
  assert.equal(await priya.locator('.menu-item:has-text("Custom emoji")').count(), 0);
  await priya.keyboard.press('Escape');
  await emojiSettings(robin);
  await robin.click('.layer-nav .row:has-text("Roles")');
  await robin.click('.role-pick .row:has-text("Member")');
  await robin.click('.switch[aria-label="Manage emoji"]');
  await priya.click('.rail-house:has-text("Kiln & Co.")', { button: 'right' });
  await priya.click('.menu-item:has-text("Custom emoji")');
  await priya.locator('.layer h1:has-text("Emoji")').waitFor();
  assert.equal(await priya.locator('.layer-nav .row').count(), 1, 'only the Emoji page');
  await priya.locator('.emo-row[data-emoji="mint"] [aria-label="Rename :mint:"]').click();
  await priya.fill('.emo-rename input', 'fresh_mint');
  await priya.keyboard.press('Enter');
  await priya.locator('.emo-row[data-emoji="fresh_mint"]').waitFor();
  await robin.click('.layer-nav .row:has-text("Emoji")');
  await robin.locator('.emo-row[data-emoji="fresh_mint"]').waitFor();
  await robin.context().close();
  await priya.context().close();
});
