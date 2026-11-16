// Groups across PCs, end to end (design 0.10 section 4): three PCs with a local
// registry, A friends with B and C, B and C strangers. Alice starts the group in
// the New message dialog; her page shows "Waiting for 1 person" while Carol's
// PC is off and "Sent to everyone" once it is back. Bob's page shows the group.
process.env.SNUG_GROUP_FWD_MS = '200';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startRegistry, startPc, until } from './helpers/p2p.js';
import { threePcs, texts } from './helpers/groups.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let registry, browser;
const pcs = [];
const errors = [];

async function open(srv, client, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const [k, v] = client.cookie.split('=');
  await ctx.addCookies([{ name: k, value: v, url: srv.base }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  await page.goto(srv.base);
  await page.waitForFunction(() => window.snug.S.auth === 'in' && window.snug.S.conn.socket === 'open' && !!window.snug.S.p2p?.owner);
  return page;
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
test.afterEach(() => { assert.deepEqual(errors.splice(0), [], 'page errors'); });

test('start a group with two friends on other PCs; waiting for 1 person; sent to everyone; the others see it', async () => {
  let { A, B, C, a, b, c } = await threePcs(registry, pcs, ['ega', 'egb', 'egc']);
  const alice = await open(A, a, 'alice');
  // New message: pick both friends on other PCs and start a group.
  await alice.getByRole('button', { name: 'Messages' }).first().click();
  await alice.click('[aria-label="New message"]');
  await alice.locator('.pick-list .menu-item:has-text("egb")').click();
  await alice.locator('.pick-list .menu-item:has-text("egc")').click();
  await alice.locator('.modal-foot .btn.primary:has-text("Start group")').click();
  await alice.locator('.main .p2p-group:has-text("Group between your PCs")').waitFor();
  const g = await alice.evaluate(() => window.snug.S.view?.id || Object.keys(window.snug.S.dms).find((id) => id.startsWith('dg_')));
  assert.match(g, /^dg_/);
  // 0.13: group calls work across PCs, so the call button is there.
  await alice.locator('.main .bar [aria-label="Start a voice call"]').first().waitFor();
  const joined = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ?', g).length === 3;
  await until(() => joined(B) && joined(C), 15_000, 'B and C have the group');

  // Carol's PC goes off: Alice's message waits for one person.
  const cDir = C.dataDir;
  await c.close();
  await C.close(); pcs.splice(pcs.indexOf(C), 1);
  await until(() => !A.peer.isOnline(c.id.slice(2)), 10_000, 'C offline');
  await alice.fill('.main .composer textarea', 'hello group');
  await alice.keyboard.press('Enter');
  await alice.locator('.msg-body:has-text("hello group") [data-peer-state="waiting"]:has-text("Waiting for 1 person")').waitFor({ timeout: 20_000 });
  await until(() => texts(B, g).includes('hello group'), 10_000, 'B has it');

  // Carol is back: everyone has it.
  C = await startPc(registry, { dataDir: cDir });
  pcs.push(C);
  await alice.locator('.msg-body:has-text("hello group") [data-peer-state="delivered"]:has-text("Sent to everyone")').waitFor({ timeout: 30_000 });
  assert.ok(texts(C, g).includes('hello group'));

  // Bob's page has the group, with all three in it.
  const bob = await open(B, b, 'bob');
  await until(() => bob.evaluate((id) => window.snug.S.dms[id]?.members?.length === 3 && window.snug.S.dms[id].group === true, g), 10_000, 'bob has the group');
});
