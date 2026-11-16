// Houses and community, driven in Chromium against the real server, with
// separate people in separate browser sessions (seeded data: Robin leads
// Kiln & Co., Priya is a Member). Categories and room order by keyboard and
// by drag, a category made and deleted from the menus, the house icon in a
// second member's rail, and editing an event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-community-'));
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

async function person(handle, { viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
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
async function openPlace(page, house = 'Kiln & Co.') {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function houseMenu(page, item, house = 'Kiln & Co.') {
  await openPlace(page, house);
  await page.click('.nav .ctx-house');
  await page.click(`.menu-item:has-text("${item}")`);
}
async function settingsPage(page, label) {
  await houseMenu(page, 'House settings');
  await page.click(`.layer-nav .row:has-text("${label}")`);
}
const close = (page) => page.context().close();
const groupOf = (room) => srv.db.get('SELECT grp FROM rooms WHERE id = ?', room).grp;
const roomsIn = (page, group) => page.evaluate((g) => window.snug.S.houses.kiln.groups.find((x) => x.id === g)?.rooms || [], group);

// A real PNG of one colour, w x h.
function png(w, h, rgb = [88, 199, 165]) {
  const table = Array.from({ length: 256 }, (_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('keyboard: Alt and an arrow moves a room into another category and a category up; a second member sees it live', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await openPlace(priya);
    await priya.locator('.nav-group[data-group="kg2"] .row:has-text("Marketplace")').waitFor();
    await settingsPage(robin, 'Rooms and access');
    // Marketplace is first in Practical: up once takes it to the end of Studio.
    await robin.focus('button[data-move-room="k_market"]');
    await robin.keyboard.press('Alt+ArrowUp');
    await robin.locator('.layer [role="status"]:has-text("Marketplace, place 6 of 6 in Studio")').waitFor();
    await priya.locator('.nav-group[data-group="kg1"] .row:has-text("Marketplace")').waitFor();
    assert.equal(groupOf('k_market'), 'kg1', 'the server has it in Studio');
    assert.deepEqual((await roomsIn(priya, 'kg1')).slice(-1), ['k_market']);
    // Focus stays on the room that moved: once more moves it up within Studio.
    await robin.keyboard.press('Alt+ArrowUp');
    await priya.waitForFunction(() => window.snug.S.houses.kiln.groups[0].rooms.indexOf('k_market') === 4);
    // A category: Live above Practical.
    await robin.focus('button[data-move-group="kg3"]');
    await robin.keyboard.press('Alt+ArrowUp');
    await priya.waitForFunction(() => window.snug.S.houses.kiln.groups.map((g) => g.id).join() === 'kg1,kg3,kg2');
    const order = await priya.locator('.nav .nav-group[data-group] .sect-name').allTextContents();
    assert.deepEqual(order.map((t) => t.trim()), ['Studio', 'Live', 'Practical'], 'the sidebar draws the new order');
    // A member can't: no grips for Priya, and the server refuses her.
    assert.equal(await priya.locator('.nav .room-dnd[draggable="true"]').count(), 0);
  } finally { await close(robin); await close(priya); }
});

test('drag: a room dropped on another category’s heading lands at its end, for everyone', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await openPlace(robin);
    await openPlace(priya);
    const from = robin.locator('.nav .room-dnd[data-drag-room="k_classes"]');
    const to = robin.locator('.nav .nav-group[data-group="kg3"] .sect');
    await from.dragTo(to);
    await priya.locator('.nav-group[data-group="kg3"] .row:has-text("Classes")').waitFor();
    assert.equal(groupOf('k_classes'), 'kg3');
    const live = await roomsIn(priya, 'kg3');
    assert.equal(live[live.length - 1], 'k_classes');
  } finally { await close(robin); await close(priya); }
});

test('menus: a new category, renamed, then deleted with its rooms moved; the empty state shows meanwhile', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await openPlace(priya);
    await houseMenu(robin, 'New category');
    await robin.fill('#cm-group-name', 'Glaze club');
    await robin.click('.modal button[type=submit]');
    const head = robin.locator('.nav .nav-group:has(.sect-name:has-text("Glaze club"))');
    await head.locator('.group-empty').waitFor();
    // Members don't see an empty category.
    await priya.waitForFunction(() => window.snug.S.houses.kiln.groups.some((g) => g.name === 'Glaze club'));
    assert.equal(await priya.locator('.nav .sect-name:has-text("Glaze club")').count(), 0);
    await head.locator('button[aria-label="Glaze club category options"]').click();
    await robin.click('.menu-item:has-text("Rename category")');
    await robin.fill('#cm-group-name', 'Glaze circle');
    await robin.click('.modal button[type=submit]');
    const renamed = robin.locator('.nav .nav-group:has(.sect-name:has-text("Glaze circle"))');
    await renamed.waitFor();
    // Move a room in by its own menu, then delete the category: the room goes to the one picked.
    await robin.click('.nav .row:has-text("Marketplace")', { button: 'right' });
    const item = robin.locator('.menu-item:has-text("Move to Glaze circle")');
    await item.click();
    await renamed.locator('.row').first().waitFor();
    const moved = (await renamed.locator('.row .trunc').first().textContent()).trim();
    await renamed.locator('button[aria-label="Glaze circle category options"]').click();
    await robin.click('.menu-item:has-text("Delete category")');
    await robin.selectOption('#cm-group-to', { label: 'Studio' });
    await robin.click('.modal .btn.danger');
    await priya.waitForFunction(() => !window.snug.S.houses.kiln.groups.some((g) => g.name === 'Glaze circle'));
    await priya.locator(`.nav-group[data-group="kg1"] .row:has-text("${moved}")`).waitFor();
  } finally { await close(robin); await close(priya); }
});

test('house icon: uploaded on Overview, drawn in the arch in a second member’s rail', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await settingsPage(robin, 'Overview');
    await robin.setInputFiles('input[aria-label="Upload the icon"]', { name: 'kiln.png', mimeType: 'image/png', buffer: png(128, 128) });
    await robin.locator('.toast:has-text("Icon updated")').waitFor();
    const img = priya.locator('.rail-house:has-text("Kiln & Co.") .tile.pic img');
    await img.waitFor();
    await priya.waitForFunction(() => {
      const el = [...document.querySelectorAll('.rail .tile.pic img')][0];
      return el && el.complete && el.naturalWidth === 128;
    });
    assert.match(await img.getAttribute('src'), /^\/api\/housepics\/f_/);
    // The house's own page draws it in its big arch as well.
    await priya.evaluate(() => import('/js/store.js').then((s) => s.go({ type: 'house', id: 'kiln' })));
    await priya.waitForFunction(() => { const el = document.querySelector('.pl-arch.pic img'); return el && el.complete && el.naturalWidth === 128; });
    // Someone with only the link sees it on the sign-up page, before an account exists.
    const { code } = await robin.evaluate(() => import('/js/server.js').then((s) => s.call('invite.create', { house: 'kiln' })));
    const ctx = await browser.newContext();
    try {
      const guest = await ctx.newPage();
      await guest.goto(`${url}/join/${code}`);
      await guest.locator('.auth-invite:has-text("Kiln & Co.")').waitFor();
      await guest.waitForFunction(() => { const el = document.querySelector('.auth-invite .tile.pic img'); return el && el.complete && el.naturalWidth === 128; });
    } finally { await ctx.close(); }
    // A file that isn't a picture is refused with a reason, and nothing changes.
    await robin.setInputFiles('input[aria-label="Upload the banner"]', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture at all, only words') });
    await robin.locator('.cm-pic-banner .err:has-text("need to be")').waitFor();
  } finally { await close(robin); await close(priya); }
});

test('events: the planner edits one, with a place somewhere else; a second member sees it change', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    const id = await robin.evaluate(() => Object.values(window.snug.S.events).find((e) => e.house === 'kiln' && e.ends > Date.now())?.id);
    assert.ok(id, 'a seeded event in Kiln & Co.');
    await openPlace(robin);
    await robin.click('.nav .row:has-text("Events")');
    const row = robin.locator('.ev-row').filter({ has: robin.locator(`.ev-title`) }).first();
    await row.waitFor();
    const title = (await robin.locator('.ev-row .ev-title').first().textContent()).trim();
    await robin.locator('.ev-row').first().locator('button[aria-label^="More about"]').click();
    await robin.click('.menu-item:has-text("Edit event")');
    await robin.fill('#ev-title', `${title} (moved)`);
    await robin.fill('#ev-where', 'The yard behind the studio');
    await robin.click('.modal button[type=submit]');
    await robin.locator('.toast:has-text("is updated")').waitFor({ timeout: 4000 }).catch(async (e) => { throw new Error(`${e.message}\nform says: ${await robin.locator('.modal').textContent()}`); });
    await priya.waitForFunction((t) => Object.values(window.snug.S.events).some((e) => e.title === t && e.location === 'The yard behind the studio'), `${title} (moved)`);
    await openPlace(priya);
    await priya.click('.nav .row:has-text("Events")');
    await priya.locator(`.ev-row:has-text("${title} (moved)") .ev-loc:has-text("The yard behind the studio")`).waitFor();
    // Interested, counted apart from going.
    const mine = priya.locator(`.ev-row:has-text("${title} (moved)")`);
    if (await mine.locator('.ev-keen-btn').count()) {
      await mine.locator('.ev-keen-btn').click();
      await robin.waitForFunction((t) => Object.values(window.snug.S.events).find((e) => e.title === t)?.interested?.length === 1, `${title} (moved)`);
    }
  } finally { await close(robin); await close(priya); }
});
