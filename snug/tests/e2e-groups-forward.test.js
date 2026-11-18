// Groups across PCs, store and forward, end to end (design 0.10 section 4.5):
// three PCs and a local registry. Alice (A) is friends with Bob (B) and Carol (C);
// Bob and Carol are not friends. Carol's PC is off when Alice sends to the group in
// her page: Bob gets it at once, Alice sees "Waiting for 1 person". Then Alice's PC
// goes off too, Carol's comes back, and Bob's PC forwards Alice's message (her
// signature intact). Carol's page shows it with Alice's original time, and once
// Alice is back her page says "Sent to everyone".
process.env.SNUG_GROUP_FWD_MS = '200'; // the 0-20 s forward delay, shortened for tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startRegistry, startPc, clientFor, until } from './helpers/p2p.js';
import { threePcs, texts, uidOf } from './helpers/groups.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let registry, browser;
const pcs = [];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = async (s) => { await s.close(); pcs.splice(pcs.indexOf(s), 1); };
const goto = (page, view) => page.evaluate((v) => { window.snug.S.ui.view = v; window.snug.emit(); }, view);

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
test.afterEach(() => { assert.deepEqual(errors.splice(0), [], 'page errors'); });

test('group message: one friend offline gets it later with the original time, forwarded by the third member while the sender is off', async () => {
  let { A, B, C, a, b, c } = await threePcs(registry, pcs, ['fwa', 'fwb', 'fwc']);
  const aUser = a.id, cUser = c.id;
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  assert.match(g, /^dg_[a-z2-7]{26}$/);
  const joined = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ?', g).length === 3;
  await until(() => joined(B) && joined(C), 15_000, 'B and C have the group');
  await until(() => B.peer.isOnline(uidOf(c)) && C.peer.isOnline(uidOf(b)), 10_000, 'co-member presence');

  // Carol's PC goes off.
  await c.close();
  const cDir = C.dataDir;
  await stop(C);
  await until(() => !A.peer.isOnline(uidOf({ id: cUser })) && !B.peer.isOnline(uidOf({ id: cUser })), 10_000, 'C offline');

  // Alice sends in her page; Bob has it at once, Carol is waited for.
  const alice = await open(A, a, 'alice');
  await goto(alice.page, { type: 'conv', id: g });
  await alice.page.locator('.main .p2p-group:has-text("Group between your PCs")').waitFor();
  await alice.page.fill('.main .composer textarea', 'kept for carol');
  await alice.page.keyboard.press('Enter');
  await alice.page.locator('.msg-body:has-text("kept for carol") [data-peer-state="waiting"]:has-text("Waiting for 1 person")').waitFor({ timeout: 20_000 });
  await until(() => texts(B, g).includes('kept for carol'), 10_000, 'B has it');
  const sent = A.db.get("SELECT id, ts, author FROM messages WHERE conv = ? AND text = 'kept for carol'", g);
  assert.equal(sent.author, aUser);
  assert.equal(B.db.get('SELECT ts FROM messages WHERE id = ?', sent.id).ts, sent.ts, 'B keeps the original time');

  // Alice's PC goes off before Carol is back.
  await alice.ctx.close();
  await a.close();
  const aDir = A.dataDir;
  await stop(A);
  await until(() => !B.peer.isOnline(uidOf({ id: aUser })), 10_000, 'A offline');
  await sleep(1500); // so a re-stamped time could not pass for the original

  // Carol's PC comes back: Bob's PC forwards Alice's signed message.
  C = await startPc(registry, { dataDir: cDir });
  pcs.push(C);
  await until(() => texts(C, g).includes('kept for carol'), 30_000, 'forwarded to C');
  const row = C.db.get('SELECT by, via, ts FROM grp_items WHERE g = ? AND id = ?', g, sent.id);
  assert.equal(row.by, uidOf({ id: aUser }), 'still Alice’s message');
  assert.equal(row.via, uidOf(b), 'it came through Bob');
  const got = C.db.get('SELECT ts, author FROM messages WHERE id = ?', sent.id);
  assert.equal(got.author, aUser, 'author is Alice');
  assert.equal(got.ts, sent.ts, 'the original time, not the time it arrived');

  // Carol's page shows it under Alice's original time.
  const c2 = await clientFor(C, cUser);
  const carol = await open(C, c2, 'carol');
  await goto(carol.page, { type: 'conv', id: g });
  await carol.page.locator('.main .msg-body:has-text("kept for carol")').waitFor({ timeout: 15_000 });
  const shown = await carol.page.evaluate(({ g, id }) => (window.snug.S.msgs[g] || []).find((m) => m.id === id)?.ts ?? null, { g, id: sent.id });
  assert.equal(shown, sent.ts, 'Carol’s page has the original time');
  assert.ok(await carol.page.locator(`.main time[datetime="${new Date(sent.ts).toISOString()}"]`).count() >= 1, 'shown under the original time');
  await carol.ctx.close();
  await c2.close();

  // Alice is back: the receipt from Carol (through her own queue or Carol's) clears the wait.
  A = await startPc(registry, { dataDir: aDir });
  pcs.push(A);
  await until(() => A.db.get('SELECT COUNT(*) n FROM grp_pending WHERE g = ?', g).n === 0, 30_000, 'delivered to everyone');
  const a2 = await clientFor(A, aUser);
  const alice2 = await open(A, a2, 'alice again');
  await goto(alice2.page, { type: 'conv', id: g });
  await alice2.page.locator('.msg-body:has-text("kept for carol") [data-peer-state="delivered"]:has-text("Sent to everyone")').waitFor({ timeout: 20_000 });
  assert.equal(texts(C, g).filter((t) => t === 'kept for carol').length, 1, 'never twice');
  await alice2.ctx.close();
  await a2.close();
});
