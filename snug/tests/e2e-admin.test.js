// v0.10 admin panel end to end: two PCs, a local registry, one Chromium context each.
// The owner ("a") sees the Admin pill and Settings > Admin; an announcement reaches the other PC's
// screen; a suspension shows its notice there. The registry enforces; the pages only show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startRegistry, startPc, signUp, OWNER_GH, until } from './helpers/p2p.js';
import { signalUp, uidOfPc } from './helpers/admin.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SNUG_SHOTS || ''; // a folder: screenshots for review
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/admin-${name}.png` }) : null);

let registry, browser;
const pcs = [];
const errors = [];
let O, B, ownerPage, bobPage, bobCtx;

async function open(srv, client, { viewport = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const [name, value] = client.cookie.split('=');
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto(srv.base);
  await page.waitForFunction(() => window.snug.S.auth === 'in' && window.snug.S.conn.socket === 'open');
  return { page, ctx };
}

test.before(async () => {
  registry = await startRegistry();
  browser = await chromium.launch();
});
test.after(async () => {
  await browser?.close();
  for (const s of pcs) await s.close().catch(() => {});
  await registry?.close();
});
test.afterEach(() => assert.deepEqual(errors.splice(0), [], 'page errors'));

test('the owner sees the Admin pill and Settings > Admin; others do not', async () => {
  O = await startPc(registry); pcs.push(O);
  B = await startPc(registry); pcs.push(B);
  const o = await signUp(O, registry, OWNER_GH, 'a');
  const b = await signUp(B, registry, OWNER_GH + 7, 'bob');
  await signalUp(O); await signalUp(B);
  ({ page: ownerPage } = await open(O, o));
  ({ page: bobPage, ctx: bobCtx } = await open(B, b));
  await ownerPage.waitForSelector('#admin-pill');
  assert.equal(await bobPage.locator('#admin-pill').count(), 0);
  await ownerPage.click('#admin-pill');
  await ownerPage.waitForSelector('.layer h1:has-text("Admin")');
  for (const t of ['Overview', 'People', 'Names', 'Announcements', 'Updates', 'Admins', 'Audit']) {
    assert.equal(await ownerPage.locator(`.admin-tabs button:has-text("${t}")`).count(), 1, t);
  }
  await ownerPage.waitForSelector('#admin-stats .admin-stat');
  assert.match(await ownerPage.locator('#admin-stats').textContent(), /Accounts/);
  await shot(ownerPage, 'overview');
});

test('an announcement reaches the other PC’s screen and can be dismissed there', async () => {
  await ownerPage.click('.admin-tabs button:has-text("Announcements")');
  await ownerPage.fill('#admin-ann-text', 'Maintenance tonight at nine');
  await ownerPage.click('#admin-ann-add');
  await ownerPage.waitForSelector('#admin-ann-list li:has-text("Maintenance tonight at nine")');
  const card = bobPage.locator('.notice-card:has-text("Maintenance tonight at nine")');
  await card.waitFor();
  await shot(bobPage, 'announcement');
  await card.locator('button[aria-label="Dismiss this announcement"]').click();
  await until(async () => (await card.count()) === 0, 5000, 'dismissed');
  await bobPage.reload();
  await bobPage.waitForFunction(() => window.snug.S.conn.socket === 'open' && window.snug.S.notices?.ann?.length === 1);
  assert.equal(await bobPage.locator('.notice-card:has-text("Maintenance tonight")').count(), 0, 'stays dismissed');
  await ownerPage.click('#admin-ann-list li button:has-text("Remove")');
  await bobPage.waitForFunction(() => window.snug.S.notices?.ann?.length === 0);
});

test('a suspension from People shows its notice on the suspended PC (and fits a phone screen)', async () => {
  await ownerPage.click('.admin-tabs button:has-text("People")');
  await ownerPage.fill('#admin-find', '@bob');
  await ownerPage.press('#admin-find', 'Enter');
  await ownerPage.waitForSelector(`.admin-person[data-uid="${uidOfPc(B)}"]`);
  await ownerPage.fill('#admin-reason', 'Spamming people');
  await ownerPage.click('#admin-ban');
  await ownerPage.click('.modal-foot button:has-text("Suspend")');
  await ownerPage.waitForSelector('#admin-bans li:has-text("bob")');
  await shot(ownerPage, 'people');
  const ban = bobPage.locator('#notice-ban');
  await ban.waitFor();
  assert.match(await ban.textContent(), /Your Snug account is suspended until .+ Reason: Spamming people\. Friends on other PCs can’t reach you until then\./);
  assert.equal(B.peer._signal.connected, false);
  // the same notice on a phone-sized screen: no sideways scrolling
  await bobPage.setViewportSize({ width: 390, height: 800 });
  await bobPage.waitForTimeout(200);
  const over = await bobPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `page scrolls sideways by ${over}px`);
  const box = await ban.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the notice fits the screen');
  await shot(bobPage, 'ban-phone');
  // lift it from the list
  await ownerPage.click('#admin-bans li button:has-text("Lift")');
  await until(async () => (await ownerPage.locator('#admin-bans li').count()) === 0, 5000, 'list empty');
  await bobCtx.close();
});
