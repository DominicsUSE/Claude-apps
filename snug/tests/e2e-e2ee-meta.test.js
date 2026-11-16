// 0.14 in the browser (Chromium): less metadata in end-to-end encrypted
// conversations, against the real server with seeded data (Robin, Ines and
// Malik share the group "Saturday load"; Robin and Ines have a DM). Sealed
// reactions counted on both sides, replies whose target is inside the sealed
// body, padded attachments that open byte for byte, encrypted polls counted
// the same by three people, and a group name the server never sees (a member
// added later gets it too). Each check also looks at what the server stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { padBucket, TAG } from '../js/lib/e2ee/attach.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-e2ee-meta-'));
let srv, browser, url;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, e2ee: true });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function device(handle) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  return page;
}
const dialog = (page) => page.locator('.modal[role=dialog]');
const waitStatus = (page, want) => page.waitForFunction((w) => window.snug.e2ee.E2.status === w, want);
const idOf = (handle) => srv.db.get('SELECT id FROM users WHERE handle = ?', handle).id;
async function turnOn(page) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.locator('.e2-invite button:has-text("Turn on")').click();
  await dialog(page).locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
  await dialog(page).locator('button:has-text("Turn on")').click();
  await dialog(page).locator('#e2-recovery-key').waitFor();
  const key = (await dialog(page).locator('#e2-recovery-key code').allTextContents()).join('-');
  await dialog(page).locator('#e2-last').fill(key.slice(-4).toLowerCase());
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).waitFor({ state: 'detached' });
  await waitStatus(page, 'ready');
}
async function openDm(page, title) {
  for (let i = 0; i < 4 && (await dialog(page).count() || await page.locator('.layer-col').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
}
async function say(page, text) {
  const box = page.locator('.main [data-composer] textarea');
  await box.fill(text);
  await box.press('Enter');
}
const idByText = async (page, needle) => (await page.waitForFunction((n) => {
  for (const l of Object.values(window.snug.S.msgs)) { const m = l.find((x) => x.text === n && !x.state); if (m) return m.id; }
  return null;
}, needle)).jsonValue();
const dmOf = (a, b) => srv.db.get(`SELECT dm FROM dm_members WHERE user IN (?, ?) GROUP BY dm
  HAVING COUNT(*) = 2 AND (SELECT COUNT(*) FROM dm_members x WHERE x.dm = dm_members.dm) = 2`, idOf(a), idOf(b)).dm;
// Every byte the server keeps: rows, the database and its WAL.
function serverHas(needle) {
  srv.db.run('PRAGMA wal_checkpoint(PASSIVE)');
  const bytes = Buffer.from(needle);
  return ['snug.db', 'snug.db-wal'].some((f) => existsSync(join(dir, f)) && readFileSync(join(dir, f)).includes(bytes));
}
async function until(get, why) {
  for (let i = 0; i < 80; i++) { const v = get(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return assert.fail(why);
}

let robin, ines, malik;

test('setup: Robin, Ines and Malik turn encryption on; each device signs its 0.14 features', async () => {
  robin = await device('robin');
  ines = await device('ines');
  malik = await device('malik');
  for (const p of [robin, ines, malik]) await turnOn(p);
  await until(() => srv.db.get('SELECT e2ee FROM dms WHERE id = ?', 'g_sat')?.e2ee === 1, 'the group turned encrypted');
  for (const h of ['robin', 'ines', 'malik']) {
    const row = await until(() => srv.db.get("SELECT caps FROM e2ee_devices WHERE user = ? AND state = 'trusted' AND caps IS NOT NULL", idOf(h)), `${h}’s device features`);
    assert.deepEqual(JSON.parse(row.caps).caps, ['info', 'pad', 'poll', 're', 'react']);
  }
});

test('E1: reactions in an encrypted DM are sealed; counts match on both sides and after a reload; the server keeps no emoji', async () => {
  const dm = dmOf('robin', 'ines');
  await openDm(robin, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  const MARK = `RX-${Date.now().toString(36)}`;
  await say(robin, MARK);
  const id = await idByText(ines, MARK);
  // Robin reacts (the store's react, as the picker does); Ines adds hers by clicking the chip.
  await robin.evaluate(async ([c, m]) => (await import('/js/store.js')).react(c, m, '🫖'), [dm, id]);
  const chip = (page) => page.locator(`.main .msg[data-id="${id}"] .rx:has-text("🫖")`);
  await chip(ines).locator('span:text-is("1")').waitFor();
  await chip(ines).click();
  await chip(robin).locator('span:text-is("2")').waitFor();
  await chip(ines).locator('span:text-is("2")').waitFor();
  assert.equal(await chip(ines).getAttribute('aria-pressed'), 'true');
  // The server: two opaque envelopes, no reactions rows, no emoji anywhere.
  await until(() => srv.db.get("SELECT COUNT(*) n FROM e2ee_side WHERE msg = ? AND slot = 'react'", id).n === 2, 'two sealed reactions');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM reactions WHERE msg = ?', id).n, 0);
  assert.equal(serverHas('🫖'), false, 'the emoji never reached the database');
  // Ines takes hers back; then a reload opens the rest again from the envelopes.
  await chip(ines).click();
  await chip(robin).locator('span:text-is("1")').waitFor();
  await ines.reload();
  await ines.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(ines, 'ready');
  await openDm(ines, 'Robin Hale');
  await chip(ines).locator('span:text-is("1")').waitFor();
  assert.equal(await chip(ines).getAttribute('aria-pressed'), 'false');
  // Robin takes his back too: the reaction is gone on both sides.
  await chip(robin).click();
  for (const p of [robin, ines]) await chip(p).waitFor({ state: 'detached' });
  // A tab on an older Snug sends a plain reaction: refused, saying why.
  const err = await ines.evaluate(async ([c, m]) => { try { await (await import('/js/server.js')).call('react', { conv: c, id: m, emoji: '🍕', on: true }); return null; } catch (e) { return e.message; } }, [dm, id]);
  assert.match(err, /Reactions in this conversation are encrypted\. Update Snug/);
});

test('E4: a reply’s target is inside the sealed body: the quote shows on both sides, the server row has no reply link, the author is notified by a declared mention', async () => {
  await openDm(robin, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  const MARK = `RE-${Date.now().toString(36)}`;
  await say(robin, `${MARK} question`);
  const qid = await idByText(ines, `${MARK} question`);
  const target = ines.locator(`.main .msg[data-id="${qid}"]`);
  await target.hover();
  await target.locator('[aria-label="Reply"]').click();
  await say(ines, `${MARK} answer`);
  await robin.locator(`.main .msg.has-ref:has-text("${MARK} answer") .reply-ref:has-text("${MARK} question")`).waitFor();
  await ines.locator(`.main .msg.has-ref:has-text("${MARK} answer") .reply-ref:has-text("${MARK} question")`).waitFor();
  const aid = await idByText(robin, `${MARK} answer`);
  const row = await until(() => srv.db.get('SELECT reply_to, ping, enc FROM messages WHERE id = ?', aid), 'the reply is stored');
  assert.equal(row.reply_to, null, 'no reply link on the server');
  assert.equal(JSON.parse(row.enc).h.re, null);
  assert.deepEqual(JSON.parse(row.ping), [idOf('robin')], 'Robin is notified through a declared mention');
});

test('E5: an attachment is padded to a size step on the server and opens byte for byte on the other side', async () => {
  await openDm(robin, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  const bytes = randomBytes(5000);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const before = new Set(readdirSync(join(dir, 'files')));
  await robin.locator('.main [data-composer] input[type=file]').setInputFiles({ name: 'kiln-log.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await robin.locator('.main [data-composer] .pending-file .pending-state:not(:has-text("Uploading"))').waitFor();
  await robin.locator('.main [data-composer] textarea').press('Enter');
  const added = await until(() => readdirSync(join(dir, 'files')).filter((f) => !before.has(f) && srv.db.get('SELECT enc FROM files WHERE id = ?', f)?.enc === 1), 'the upload is stored');
  const row = srv.db.get('SELECT size, name, type FROM files WHERE id = ?', added[0]);
  assert.deepEqual({ ...row }, { size: padBucket(5000 + 5) + TAG, name: 'file', type: 'application/octet-stream' }, 'the server sees the size step, not 5000 bytes');
  // Ines's device opens it: the same bytes.
  // Ines's device opens it as the conversation does (the key from the message it opened): the same bytes.
  const fid = await (await ines.waitForFunction(() => {
    for (const l of Object.values(window.snug.S.msgs)) for (const m of l) for (const f of m.files || []) if (f.name === 'kiln-log.bin' && f.src) return f.id;
    return null;
  })).jsonValue();
  const got = await ines.evaluate(async (id) => {
    const { _test } = await import('/js/e2ee/conv.js');
    const { decryptFile } = await import('/js/lib/e2ee/attach.js');
    const part = _test.parts.get(id);
    const ct = new Uint8Array(await (await fetch(`/api/files/${id}`)).arrayBuffer());
    const b = await decryptFile(ct, part);
    return [part.p, ct.length, b.length, [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('')];
  }, fid);
  assert.deepEqual(got.slice(0, 2), [1, padBucket(5000 + 5) + TAG]);
  got.splice(0, 2);
  assert.deepEqual(got, [5000, sha]);
});

async function vote(page, mid, answer) {
  await page.locator(`.main .msg[data-id="${mid}"] .poll-a:has-text("${answer}")`).click();
}
const pollOf = (page, mid) => page.evaluate((id) => { for (const l of Object.values(window.snug.S.msgs)) { const m = l.find((x) => x.id === id); if (m?.poll) return { counts: m.poll.counts, total: m.poll.total, ended: m.poll.ended }; } return null; }, mid);

test('E3: an encrypted poll in the group: three people vote, all three count the same, the author ends it; the server has no question, answers or votes', async () => {
  for (const p of [robin, ines, malik]) await openDm(p, 'Saturday load');
  const tag = Date.now().toString(36);
  const Q = `Which glaze ${tag}?`, A1 = `Celadon ${tag}`, A2 = `Tenmoku ${tag}`;
  await robin.locator('.main .plus-btn').click();
  await robin.locator('[role=menu] .menu-item:has-text("Poll")').click();
  await dialog(robin).locator('.hint:has-text("This poll is end-to-end encrypted")').waitFor();
  await dialog(robin).locator('#poll-q').fill(Q);
  await dialog(robin).locator('input[aria-label="Answer 1"]').fill(A1);
  await dialog(robin).locator('input[aria-label="Answer 2"]').fill(A2);
  await dialog(robin).locator('button:has-text("Post poll")').click();
  await dialog(robin).waitFor({ state: 'detached' });
  const mid = await (await ines.waitForFunction((q) => { for (const l of Object.values(window.snug.S.msgs)) { const m = l.find((x) => x.poll?.question === q); if (m) return m.id; } return null; }, Q)).jsonValue();
  await malik.locator(`.main .msg[data-id="${mid}"] .poll-q:has-text("${Q}")`).waitFor();
  await vote(ines, mid, A1);
  await vote(malik, mid, A2);
  await vote(robin, mid, A2);
  for (const p of [robin, ines, malik]) {
    await p.waitForFunction((id) => { for (const l of Object.values(window.snug.S.msgs)) { const m = l.find((x) => x.id === id); if (m?.poll?.total === 3) return true; } return false; }, mid);
    assert.deepEqual(await pollOf(p, mid), { counts: [1, 2], total: 3, ended: false });
  }
  await robin.locator(`.main .msg[data-id="${mid}"] .poll button:has-text("End now")`).click();
  for (const p of [ines, malik]) await p.locator(`.main .msg[data-id="${mid}"] .poll-how:has-text("Final results")`).waitFor();
  assert.deepEqual(await pollOf(malik, mid), { counts: [1, 2], total: 3, ended: true });
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM polls WHERE msg = ?', mid).n, 0);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_side WHERE msg = ? AND slot = 'vote'", mid).n, 3);
  for (const s of [Q, A1, A2]) assert.equal(serverHas(s), false, `"${s}" never reached the database`);
});

test('E2: renaming the encrypted group seals the name: members see it, the server keeps none, the line names no name; someone added later gets it', async () => {
  // Sealed already: the seeded name was sealed once everyone's devices could (no line for that).
  await until(() => srv.db.get('SELECT info_enc FROM dms WHERE id = ?', 'g_sat')?.info_enc, 'the seeded name is sealed');
  assert.equal(srv.db.get('SELECT name FROM dms WHERE id = ?', 'g_sat').name, null);
  const NAME = `Glaze Night ${Date.now().toString(36).slice(-4)}`;
  await openDm(robin, 'Saturday load');
  await robin.locator('.nav .row:has-text("Saturday load")').click({ button: 'right' });
  await robin.locator('[role=menu] :text("Rename group")').click();
  await dialog(robin).locator('#dm-name').fill(NAME);
  await dialog(robin).locator('button:has-text("Save")').click();
  await dialog(robin).waitFor({ state: 'detached' });
  for (const p of [ines, malik]) await p.locator(`.nav .row:has-text("${NAME}")`).waitFor();
  await ines.locator(`.main .bar-title:has-text("${NAME}")`).waitFor();
  await ines.locator('.main .dmline:has-text("Robin Hale renamed the group")').waitFor();
  const row = srv.db.get('SELECT name, icon, info_enc FROM dms WHERE id = ?', 'g_sat');
  assert.equal(row.name, null);
  assert.equal(row.info_enc.includes('Glaze'), false);
  assert.equal(serverHas(NAME), false, 'the new name never reached the database');
  // Tomasz turns encryption on and is added: a member's device seals the name again for him.
  const tomasz = await device('tomasz');
  await turnOn(tomasz);
  await until(() => srv.db.get("SELECT 1 FROM e2ee_devices WHERE user = ? AND caps IS NOT NULL", idOf('tomasz')), 'Tomasz’s device features');
  await robin.evaluate(async (u) => (await import('/js/server.js')).call('dm.add', { dm: 'g_sat', users: [u] }), idOf('tomasz'));
  await tomasz.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await tomasz.locator(`.nav .row:has-text("${NAME}")`).waitFor({ timeout: 20000 });
  const sealedTo = JSON.parse(srv.db.get('SELECT info_enc FROM dms WHERE id = ?', 'g_sat').info_enc).h.to.map(([u]) => u);
  assert.ok(sealedTo.includes(idOf('tomasz')), 'the newest revision is sealed to Tomasz');
  await tomasz.context().close();
});

test('E3: a poll where someone is still on an older Snug is refused, naming the device', async () => {
  // Malik's device as an older Snug would leave it: no signed features on the server.
  const saved = srv.db.get("SELECT id, caps FROM e2ee_devices WHERE user = ? AND state = 'trusted'", idOf('malik'));
  srv.db.run('UPDATE e2ee_devices SET caps = NULL WHERE id = ?', saved.id);
  try {
    await openDm(robin, 'Glaze Night');
    await robin.locator('.main .plus-btn').click();
    await robin.locator('[role=menu] .menu-item:has-text("Poll")').click();
    await dialog(robin).locator('#poll-q').fill('Old device?');
    await dialog(robin).locator('input[aria-label="Answer 1"]').fill('Yes');
    await dialog(robin).locator('input[aria-label="Answer 2"]').fill('No');
    await dialog(robin).locator('button:has-text("Post poll")').click();
    await dialog(robin).locator('[role=alert]:has-text("Still on an older Snug: Malik")').waitFor();
    await dialog(robin).locator('button:has-text("Cancel")').click();
  } finally {
    srv.db.run('UPDATE e2ee_devices SET caps = ? WHERE id = ?', saved.caps, saved.id);
  }
});
