// Privacy in the browser (v0.12 privacy track): the "Who can see what" words
// for the mode the app is in (a server, or the desktop app with friends on
// other PCs), the privacy page signed out, typing and online controls, erasing
// what you wrote when deleting your account, the zip download, and no request
// to any other website. Seeded data: Robin and Ines are friends in Kiln & Co.;
// Tomasz is in Kiln & Co. too but isn't Robin's friend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { startRegistry, startPc, signUp } from './helpers/p2p.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-privacy-'));
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

function watch(page, who) {
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${who} console: ${m.text()}`);
  });
}
async function person(handle, { viewport = { width: 1280, height: 800 }, phone = false, base = url } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page, handle);
  await page.goto(base);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForFunction(() => window.snug.S.ready && window.snug.S.conn.socket === 'open');
  return page;
}
const close = (page) => page.context().close();
async function settings(page, label) {
  await page.evaluate((l) => import('/js/store.js').then((s) => import('/js/views/settings.js').then((v) => s.openLayer({ C: v.Settings, props: {} }))), label);
  await page.click(`.layer-nav .row:has-text("${label}")`);
  await page.locator('.layer-body h1').waitFor();
}
const text = (page, sel) => page.locator(sel).innerText();

// ---------- The words, for each mode ----------
test('server mode: Settings > Privacy and safety says this Snug at its address stores everything and its owner can read rooms', async () => {
  const robin = await person('robin');
  await settings(robin, 'Privacy and safety');
  const box = robin.locator('#pv-overview');
  assert.equal(await box.getAttribute('data-mode'), 'host');
  const t = await box.innerText();
  assert.match(t, new RegExp(`stored on the server this Snug at 127\\.0\\.0\\.1:${srv.port} runs on`));
  assert.match(t, /Whoever runs it can read houses and rooms/);
  assert.match(t, /Direct messages are stored on the same server and are not end-to-end encrypted/);
  assert.match(t, /plain connection \(http\)/, 'a plain-http Snug says so');
  assert.doesNotMatch(t, /travel encrypted between your PC/);
  // The full page, with what this Snug keeps and for how long.
  await robin.click('#pv-open-guide');
  await robin.locator('#pv-guide').waitFor();
  const g = await text(robin, '#pv-guide');
  assert.match(g, /Sign-in history and security events: 30 days/);
  assert.match(g, /no analytics, diagnostics or crash reports/);
  assert.match(g, /Snug is not anonymous/);
  assert.match(g, /can be required by law to hand over what they store/);
  await close(robin);
});

test('signed out: the sign-in screen links to the privacy page, which works at /privacy and on a phone', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  watch(page, 'visitor');
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.click('#pv-link');
  await page.locator('#pv-guide').waitFor();
  assert.equal(new URL(page.url()).pathname, '/privacy');
  assert.match(await text(page, '.pv-panel h1'), /Privacy at Snug/);
  assert.match(await text(page, '#pv-guide'), /Whoever runs it can read houses and rooms/);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 0, `no sideways scrolling on a phone (${wide}px)`);
  await page.click('#pv-back');
  await page.waitForSelector('.auth-form');
  // Typed straight in.
  await page.goto(`${url}/privacy`);
  await page.locator('#pv-guide').waitFor();
  await ctx.close();
});

test('desktop app with friends on other PCs: the words say encrypted between PCs, stored on each PC, and what the directory sees', async () => {
  const registry = await startRegistry();
  const pc = await startPc(registry);
  try {
    const me = await signUp(pc, registry, 8101, 'pvdesk');
    me.ws.close();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const eq = me.cookie.indexOf('=');
    const [name, value] = [me.cookie.slice(0, eq), me.cookie.slice(eq + 1)];
    await ctx.addCookies([{ name, value, url: pc.base }]);
    const page = await ctx.newPage();
    watch(page, 'pvdesk');
    await page.goto(pc.base);
    await page.waitForFunction(() => window.snug.S.ready && !!window.snug.S.p2p?.owner);
    await settings(page, 'Privacy and safety');
    const box = page.locator('#pv-overview');
    assert.equal(await box.getAttribute('data-mode'), 'p2p');
    const t = await box.innerText();
    assert.match(t, /travel encrypted between your PC and theirs/);
    assert.match(t, /stored readable on each PC/);
    assert.match(t, /The directory \(Snug’s registry, run on Cloudflare\) sees when you’re online, which accounts are your friends/);
    assert.match(t, /key to your data file \(\.snugvault\)/);
    assert.doesNotMatch(t, /stored on the server this Snug/);
    // Friends' links: off, with the reason.
    assert.equal(await page.locator('[role=switch][aria-label="Previews for links friends send"]').getAttribute('aria-checked'), 'false');
    await ctx.close();
  } finally { await pc.close(); await registry.close(); }
});

// ---------- Online and typing ----------
test('friends only: a house-mate who isn’t a friend sees Robin offline with no “last wrote”; Ines, a friend, sees him online', async () => {
  const robin = await person('robin');
  await settings(robin, 'Privacy and safety');
  await robin.click('.seg[aria-label="Who sees when you’re online"] button:has-text("Friends only")');
  await new Promise((r) => setTimeout(r, 800)); // the setting syncs (300 ms) and the server tells everyone
  const tomasz = await person('tomasz');
  const ines = await person('ines');
  const robinId = await robin.evaluate(() => window.snug.S.me);
  const seen = (page) => page.evaluate((id) => import('/js/views/people.js').then((p) => ({ presence: window.snug.S.users[id].presence, doing: p.doingOf(window.snug.S.users[id]).text })), robinId);
  const t = await seen(tomasz);
  assert.equal(t.presence, 'offline');
  assert.equal(t.doing, 'Offline', 'no “last wrote” line');
  assert.notEqual((await seen(ines)).presence, 'offline');
  await robin.click('.seg[aria-label="Who sees when you’re online"] button:has-text("Everyone")');
  for (const p of [robin, tomasz, ines]) await close(p);
});

test('typing off: Robin’s typing isn’t shown to Ines, and he doesn’t see hers', async () => {
  const robin = await person('robin');
  const ines = await person('ines');
  for (const p of [robin, ines]) await p.evaluate(() => import('/js/store.js').then((s) => s.openConv('k_glaze')));
  const robinId = await robin.evaluate(() => window.snug.S.me);
  const inesId = await ines.evaluate(() => window.snug.S.me);
  const typing = (page, id) => page.evaluate((u) => (window.snug.S.typing.k_glaze || []).includes(u), id);
  await robin.locator('.main .composer textarea').type('hello');
  await ines.waitForFunction((u) => (window.snug.S.typing.k_glaze || []).includes(u), robinId);
  await settings(robin, 'Privacy and safety');
  await robin.click('[role=switch][aria-label="Typing"]');
  await new Promise((r) => setTimeout(r, 7000)); // the earlier note runs out (6 s)
  await robin.keyboard.press('Escape');
  await robin.locator('.main .composer textarea').type(' again');
  await ines.locator('.main .composer textarea').type('hi robin');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await typing(ines, robinId), false, 'Ines doesn’t see Robin typing');
  assert.equal(await typing(robin, inesId), false, 'Robin doesn’t see Ines typing');
  await settings(robin, 'Privacy and safety');
  await robin.click('[role=switch][aria-label="Typing"]');
  for (const p of [robin, ines]) await close(p);
});

// ---------- No other websites ----------
test('the app loads nothing from any other website (fonts, pictures, scripts, embeds)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  watch(page, 'robin');
  const outside = [];
  page.on('request', (r) => { const u = r.url(); if (!/^(data|blob):/.test(u) && new URL(u).origin !== url) outside.push(u); });
  await page.goto(url);
  await page.fill('#auth-handle', 'robin');
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForFunction(() => window.snug.S.ready);
  for (const room of ['k_desk', 'k_glaze', 'k_show', 'd_ines']) {
    await page.evaluate((r) => import('/js/store.js').then((s) => s.openConv(r)), room);
    await page.waitForTimeout(400);
  }
  await settings(page, 'Appearance');
  assert.deepEqual(outside, []);
  await ctx.close();
});

// ---------- Download and delete ----------
test('Your data: Download gives one zip with my data', async () => {
  const priya = await person('priya');
  await settings(priya, 'Your data');
  const [dl] = await Promise.all([priya.waitForEvent('download'), priya.click('.set-row:has-text("Download your data") button')]);
  assert.match(dl.suggestedFilename(), /^snug-priya-\d{4}-\d\d-\d\d\.zip$/);
  const buf = readFileSync(await dl.path());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'a zip file');
  assert.ok(buf.includes(Buffer.from('snug-data.json')));
  await close(priya);
});

test('Delete account offers keep or erase, says what can’t be erased, and erase leaves no copy of my words', async () => {
  const CANARY = 'canary-e2e-erase-91b2';
  const sunniva = await person('sunniva');
  await sunniva.evaluate(() => import('/js/store.js').then((s) => s.openConv('k_floor')));
  await sunniva.locator('.main .composer textarea').fill(`a note ${CANARY}`);
  await sunniva.keyboard.press('Enter');
  await sunniva.waitForFunction((c) => (window.snug.S.msgs.k_floor || []).some((m) => m.text.includes(c) && m.state !== 'queued' && m.state !== 'sending'), CANARY);
  await settings(sunniva, 'Your data');
  await sunniva.click('.set-row:has-text("Delete your account") button');
  const dialog = sunniva.locator('.modal');
  await dialog.locator('.erase-choice').waitFor();
  const words = await dialog.innerText();
  assert.match(words, /Keep my messages/);
  assert.match(words, /Erase what I wrote/);
  assert.match(words, /Copies other people already have/);
  await dialog.locator('input[value=erase]').check();
  await dialog.locator('#cf-pw').fill(PASSWORD);
  await dialog.locator('#cf-handle').fill('sunniva');
  await dialog.locator('button[type=submit]').click();
  await sunniva.waitForSelector('.auth-form');
  const hit = srv.db.get("SELECT COUNT(*) n FROM messages WHERE text LIKE ? OR fold LIKE ?", `%${CANARY}%`, `%${CANARY}%`).n;
  assert.equal(hit, 0);
  await close(sunniva);
});
