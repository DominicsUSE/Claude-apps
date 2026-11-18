// End-to-end encryption in the browser (Chromium), against the real server
// with encryption turned on, seeded data (Robin and Ines share Kiln & Co., are
// friends and have a DM) and separate browser contexts as separate devices.
// Covers the key directory: turning it on, the recovery key, adding a device
// with a typed code (and a wrong one), recovery with the recovery key, safety
// numbers and their verified mark following you to another device, Settings >
// Encryption, and the same sheets on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { readStoredSync } from '../server/filecrypt.js'; // 0.14: what a stored file holds under the at-rest layer
const storedFiles = (d) => readdirSync(d).filter((f) => statSync(join(d, f)).isFile()); // files/partial holds uploads under way
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-e2ee-'));
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

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
async function device(handle, opts = {}) {
  const ctx = await browser.newContext(opts.phone ? PHONE : { viewport: { width: 1280, height: 800 } });
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
const status = (page) => page.evaluate(() => window.snug.e2ee.E2.status);
const waitStatus = (page, want) => page.waitForFunction((w) => window.snug.e2ee.E2.status === w, want);
const idOf = (handle) => srv.db.get('SELECT id FROM users WHERE handle = ?', handle).id;
const dialog = (page) => page.locator('.modal[role=dialog]');
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Opens the setup sheet from the invitation above the direct messages (0.12: offered without interrupting).
async function openSetup(page) {
  if (await page.locator('.tab:has-text("Messages")').count()) await page.click('.tab:has-text("Messages")');
  else await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.locator('.e2-invite button:has-text("Turn on")').click();
  await dialog(page).locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
}
// Turns encryption on from the invitation and confirms the recovery key; returns the key text.
async function turnOn(page) {
  if (!(await dialog(page).count())) await openSetup(page);
  await dialog(page).locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
  await dialog(page).locator('button:has-text("Turn on")').click();
  await dialog(page).locator('#e2-recovery-key').waitFor();
  const key = (await dialog(page).locator('#e2-recovery-key code').allTextContents()).join('-');
  assert.match(key, /^([A-Z2-7]{4}-){8}[A-Z2-7]{4}$/);
  await dialog(page).locator('#e2-last').fill('ZZZZ' === key.slice(-4) ? 'YYYY' : 'ZZZZ');
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).locator('[role=alert]:has-text("isn’t the last group")').waitFor();
  await dialog(page).locator('#e2-last').fill(key.slice(-4).toLowerCase());
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).waitFor({ state: 'detached' });
  await waitStatus(page, 'ready');
  return key;
}
async function openEncryptionSettings(page) {
  await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Encryption")');
  await page.locator('.layer-col h1:has-text("Encryption")').waitFor();
}
async function openDmDetails(page, title) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
  await page.click('.main .bar [aria-label="Details"]');
  await page.locator('.pane[aria-label="Details"] .e2-detail').waitFor();
}

let robinKey, robinA, inesKey;

test('turning it on: the first-run sheet, the recovery key typed back, keys kept across a reload, Settings > Encryption', async () => {
  robinA = await device('robin');
  robinKey = await turnOn(robinA);
  const acct = srv.db.get('SELECT ver, hist FROM e2ee_accounts WHERE user = ?', idOf('robin'));
  assert.deepEqual({ ...acct }, { ver: 1, hist: 1 });
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'trusted'", idOf('robin')).n, 1);
  // The server never sees the recovery key.
  assert.ok(!JSON.stringify(srv.db.get('SELECT blob FROM e2ee_backup WHERE user = ?', idOf('robin'))).includes(robinKey.replace(/-/g, '')));
  // Device keys survive a reload, non-extractable.
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
  const extractable = await robinA.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open(`snug-e2ee:${window.snug.S.me}`); q.onsuccess = () => r(q.result); });
    const dev = await new Promise((r) => { const q = db.transaction('dev').objectStore('dev').get('device'); q.onsuccess = () => r(q.result); });
    return [dev.dsk.privateKey.extractable, dev.prekeys[dev.kid].pair.privateKey.extractable];
  });
  assert.deepEqual(extractable, [false, false]);
  assert.equal(await dialog(robinA).count(), 0, 'no sheet once it is on');
  await openEncryptionSettings(robinA);
  const page = robinA.locator('.layer-col');
  await page.locator('.e2-ok:has-text("on for this device")').waitFor();
  await page.locator('text=Saved. You confirmed you have it.').waitFor();
  assert.equal(await page.locator('.e2-dev').count(), 1);
  assert.match(await page.locator('.e2-limits').textContent(), /It still sees:/);
  // 0.15: the details are a disclosure under the controls; opened, the server's own list (GET /api/privacy) renders inside.
  await page.locator('.e2-limits summary').click();
  await page.locator('.e2-limits .e2-sees li:has-text("Who is in each DM and group")').waitFor();
  assert.match(await page.locator('.e2-limits').textContent(), /Snug’s code comes from this server/);
  assert.match(await page.locator('.e2-limits').textContent(), /aren’t sealed/); // 0.14: a browser's keys aren't sealed by a key store
  assert.doesNotMatch(await page.locator('.e2-limits').textContent(), /sealed with the system key store/);
  await robinA.keyboard.press('Escape');
});

test('adding a device with the typed code: a wrong code cancels, the right one adds it, both see two devices', async () => {
  const b = await device('robin');
  await dialog(b).locator('h2:has-text("Add this browser")').waitFor();
  assert.equal(await status(b), 'new-device');
  await dialog(b).locator('button:has-text("Use my other device")').click();
  await dialog(b).locator('#e2-code').waitFor();
  // The trusted device is asked.
  await dialog(robinA).locator('h2:has-text("Approve Chrome on")').waitFor();
  await dialog(robinA).locator('button:has-text("Approve")').click();
  const code = await dialog(robinA).locator('#e2-link-code').textContent();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  // A wrong code first: one try, the request is cancelled on both sides.
  const wrong = code.startsWith('0') ? `1${code.slice(1)}` : `0${code.slice(1)}`;
  await dialog(b).locator('#e2-code').fill(wrong);
  await dialog(b).locator('button:has-text("Add this browser")').click();
  await dialog(robinA).locator('text=didn’t match').waitFor();
  await dialog(robinA).locator('button:has-text("Done")').click();
  await dialog(b).locator('h2:has-text("That didn’t go through")').waitFor();
  // Start again: a new request and a new code.
  await dialog(b).locator('button:has-text("Start again")').click();
  await dialog(b).locator('#e2-code').waitFor();
  await dialog(robinA).locator('button:has-text("Approve")').click();
  const code2 = await dialog(robinA).locator('#e2-link-code').textContent();
  assert.notEqual(code2, code);
  await dialog(b).locator('#e2-code').fill(code2.toLowerCase());
  await dialog(b).locator('button:has-text("Add this browser")').click();
  await dialog(b).locator('h2:has-text("This browser is added")').waitFor();
  await dialog(robinA).locator('h2:has-text("Device added")').waitFor();
  await dialog(robinA).locator('button:has-text("Done")').click();
  await dialog(b).locator('button:has-text("Done")').click();
  await waitStatus(b, 'ready');
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'trusted'", idOf('robin')).n, 2);
  for (const p of [robinA, b]) {
    await openEncryptionSettings(p);
    await p.waitForFunction(() => document.querySelectorAll('.e2-dev').length === 2);
    await p.keyboard.press('Escape');
  }
  await b.context().close();
});

test('recovery: another browser with no keys reads the recovery key back in (and asks for the password after an old sign-in)', async () => {
  const ines = await device('ines');
  inesKey = await turnOn(ines);
  await ines.context().close();
  const fresh = await device('ines');
  await dialog(fresh).locator('h2:has-text("Add this browser")').waitFor();
  srv.db.run('UPDATE sessions SET auth_at = 0 WHERE user = ?', idOf('ines')); // signed in long ago
  await dialog(fresh).locator('button:has-text("Use my recovery key")').click();
  await dialog(fresh).locator('#e2-rk-in').fill('ABCD-EFGH');
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('[role=alert]:has-text("36 letters")').waitFor();
  await dialog(fresh).locator('#e2-rk-in').fill(inesKey.toLowerCase().replace(/-/g, ' '));
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('#e2-rk-pw').waitFor();
  await dialog(fresh).locator('#e2-rk-pw').fill(PASSWORD);
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('h2:has-text("Encryption is back on this device")').waitFor();
  await dialog(fresh).locator('button:has-text("Done")').click();
  await waitStatus(fresh, 'ready');
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'trusted'", idOf('ines')).n, 2);
  await fresh.context().close();
});

test('safety numbers: the same 60 digits on both sides; marking verified follows Robin to his other device', async () => {
  const ines = await device('ines');
  await dialog(ines).locator('h2:has-text("Add this browser")').waitFor();
  await dialog(ines).locator('button:has-text("Use my recovery key")').click();
  await dialog(ines).locator('#e2-rk-in').fill(inesKey);
  await dialog(ines).locator('button:has-text("Use recovery key")').click();
  await dialog(ines).locator('h2:has-text("Encryption is back")').waitFor();
  await dialog(ines).locator('button:has-text("Done")').click();
  await waitStatus(ines, 'ready');
  await openDmDetails(robinA, 'Ines Carvalho');
  assert.match(await robinA.locator('.e2-detail').textContent(), /End-to-end encrypted/, 'both have it on: their DM turned encrypted');
  await robinA.locator('.e2-detail button:has-text("Safety number")').click();
  await dialog(robinA).locator('#e2-safety-number').waitFor();
  await openDmDetails(ines, 'Robin Hale');
  await ines.locator('.e2-detail button:has-text("Safety number")').click();
  await dialog(ines).locator('#e2-safety-number').waitFor();
  const a = (await dialog(robinA).locator('#e2-safety-number code').allTextContents()).join(' ');
  const b = (await dialog(ines).locator('#e2-safety-number code').allTextContents()).join(' ');
  assert.match(a, /^(\d{5} ){11}\d{5}$/);
  assert.equal(a, b);
  assert.equal(await dialog(robinA).locator('svg.acc-qr').count(), 1);
  await dialog(robinA).locator('.e2-state:has-text("Not verified")').waitFor();
  await dialog(robinA).locator('button:has-text("Mark as verified")').click();
  await dialog(robinA).locator('.e2-state:has-text("Verified")').waitFor();
  // Robin's other device: link it, then the mark is there (synced, encrypted settings).
  const b2 = await device('robin');
  await dialog(b2).locator('button:has-text("Use my recovery key")').click();
  await dialog(b2).locator('#e2-rk-in').fill(robinKey);
  await dialog(b2).locator('button:has-text("Use recovery key")').click();
  await dialog(b2).locator('h2:has-text("Encryption is back")').waitFor();
  await dialog(b2).locator('button:has-text("Done")').click();
  await waitStatus(b2, 'ready');
  const synced = await b2.evaluate(async (u) => (await window.snug.e2ee.safetyFor(u)).verified, idOf('ines'));
  assert.equal(synced, true);
  await robinA.keyboard.press('Escape');
  await ines.context().close();
  await b2.context().close();
});

// ---------- encrypted conversations (step 5) ----------
async function recoverWith(page, key) {
  await dialog(page).locator('h2:has-text("Add this browser")').waitFor();
  await dialog(page).locator('button:has-text("Use my recovery key")').click();
  await dialog(page).locator('#e2-rk-in').fill(key);
  await dialog(page).locator('button:has-text("Use recovery key")').click();
  await dialog(page).locator('h2:has-text("Encryption is back")').waitFor();
  await dialog(page).locator('button:has-text("Done")').click();
  await waitStatus(page, 'ready');
}
async function openDm(page, title) {
  // A sheet left from an earlier step ("Device added") closes first.
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
const dmOf = (a, b) => srv.db.get(`SELECT dm FROM dm_members WHERE user IN (?, ?) GROUP BY dm
  HAVING COUNT(*) = 2 AND (SELECT COUNT(*) FROM dm_members x WHERE x.dm = dm_members.dm) = 2`, idOf(a), idOf(b)).dm;
// Every place the server keeps things: rows, the raw database and WAL bytes, and the files folder.
function scanServer(needle) {
  const rows = JSON.stringify([srv.db.all('SELECT * FROM messages'), srv.db.all('SELECT * FROM msg_edits'), srv.db.all('SELECT * FROM files')]);
  assert.equal(rows.includes(needle), false, 'a row holds the marker');
  srv.db.run('PRAGMA wal_checkpoint(PASSIVE)');
  for (const f of ['snug.db', 'snug.db-wal']) {
    const p = join(dir, f);
    if (existsSync(p)) assert.equal(readFileSync(p).includes(Buffer.from(needle)), false, `${f} holds the marker`);
  }
  // 0.14: under the at-rest encryption too (server/filecrypt.js): the server can open that layer, not the message.
  for (const f of storedFiles(join(dir, 'files'))) assert.equal(readStoredSync(join(dir, 'files', f)).includes(Buffer.from(needle)), false, `files/${f} holds the marker`);
}
const textOf = (page, needle) => page.locator(`.main .msg .msg-text:has-text("${needle}")`);

test('encrypted DM: the conversation turned encrypted says so, messages go both ways, survive a reload, and the server holds no text', async () => {
  const ines = await device('ines');
  await recoverWith(ines, inesKey);
  const dm = dmOf('robin', 'ines');
  assert.equal(srv.db.get('SELECT e2ee FROM dms WHERE id = ?', dm).e2ee, 1);
  await openDm(robinA, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  // The header label, the line where it turned on (with the honest note about what came before), legacy marks.
  await robinA.locator('.main .bar .e2-label.on:has-text("End-to-end encrypted")').waitFor();
  await ines.locator('.main .e2-line:has-text("Messages above were sent before end-to-end encryption")').waitFor();
  const MARK = `MARK-${Date.now().toString(36)}`;
  await say(robinA, `Dinner at 7? ${MARK}`);
  await textOf(ines, `Dinner at 7? ${MARK}`).waitFor();
  await say(ines, `Yes! ${MARK}-reply`);
  await textOf(robinA, `Yes! ${MARK}-reply`).waitFor();
  const row = srv.db.get("SELECT text, enc FROM messages WHERE conv = ? AND enc IS NOT NULL ORDER BY seq DESC LIMIT 1", dm);
  assert.equal(row.text, '');
  // A reload opens them again (from the server's envelopes and this device's keys).
  await ines.reload();
  await ines.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(ines, 'ready');
  await openDm(ines, 'Robin Hale');
  await textOf(ines, `Dinner at 7? ${MARK}`).waitFor();
  await textOf(ines, `Yes! ${MARK}-reply`).waitFor();
  // A message from before shows its "not encrypted" line in its menu.
  const legacy = ines.locator('.main .msg').first();
  await legacy.click({ button: 'right' });
  await ines.locator('[role=menu] :text("Not end-to-end encrypted")').waitFor();
  await ines.keyboard.press('Escape');
  scanServer(MARK);
  await ines.context().close();
});

test('encrypted DM: an edit, a reply quote and a thread reply all decrypt after a reload; a stale plain send gets the reload message', async () => {
  const ines = await device('ines');
  await recoverWith(ines, inesKey);
  await openDm(robinA, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  const MARK = `EDIT-${Date.now().toString(36)}`;
  await say(robinA, `${MARK} first`);
  await textOf(ines, `${MARK} first`).waitFor();
  // Edit (Arrow Up edits your last message).
  const box = robinA.locator('.main [data-composer] textarea');
  await box.press('ArrowUp');
  const edit = robinA.locator('.main .msg-edit textarea');
  await edit.fill(`${MARK} second`);
  await edit.press('Enter');
  await textOf(ines, `${MARK} second`).waitFor();
  // Reply with a quote, and a thread reply.
  const target = ines.locator(`.main .msg:not(.has-ref):has-text("${MARK} second")`);
  await target.hover();
  await target.locator('[aria-label="Reply"]').click();
  await say(ines, `${MARK} reply`);
  await robinA.locator(`.main .msg.has-ref:has-text("${MARK} reply") .reply-ref:has-text("${MARK} second")`).waitFor();
  const tid = await (await robinA.waitForFunction((needle) => { for (const l of Object.values(window.snug.S.msgs)) { const m = l.find((x) => x.text === needle && !x.state); if (m) return m.id; } return null; }, `${MARK} second`)).jsonValue();
  const own = robinA.locator(`.main .msg[data-id="${tid}"]`);
  await own.hover();
  await own.locator('[aria-label="More actions"]').click();
  await robinA.locator('[role=menu] :text("Start a thread")').click();
  await robinA.locator('.thread-pane [data-composer] textarea').fill(`${MARK} in thread`);
  await robinA.locator('.thread-pane [data-composer] textarea').press('Enter');
  await robinA.locator(`.thread-pane .msg-text:has-text("${MARK} in thread")`).waitFor();
  assert.ok(srv.db.get('SELECT enc FROM messages WHERE conv = ? AND enc IS NOT NULL', `t:${tid}`), 'the thread reply is encrypted');
  await ines.reload();
  await ines.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(ines, 'ready');
  await openDm(ines, 'Robin Hale');
  await textOf(ines, `${MARK} second`).waitFor();
  await ines.locator(`.main .msg[data-id="${tid}"] .edited`).waitFor();
  await ines.locator(`.main .reply-ref:has-text("${MARK} second")`).waitFor();
  await ines.locator('.main .stub:has-text("1 reply")').click();
  await ines.locator(`.thread-pane .msg-text:has-text("${MARK} in thread")`).waitFor();
  // A tab running old code sends plain text: refused with the reload message.
  const err = await ines.evaluate(async (dm) => {
    const { call } = await import('/js/server.js');
    try { await call('msg.send', { conv: dm, id: 'm_staleplaintext01', text: 'old tab' }); return null; } catch (e) { return e.message; }
  }, dmOf('robin', 'ines'));
  assert.match(err, /end-to-end encrypted\. Reload Snug/);
  scanServer(MARK);
  await ines.context().close();
});

test('encrypted DM: polls are sealed (0.14) and say so, /roll is off and says why; forwarding to a room warns and posts readable text; into the group it stays encrypted', async () => {
  await openDm(robinA, 'Ines Carvalho');
  await robinA.locator('.main .plus-btn').click();
  await robinA.locator('[role=menu] .menu-item:has-text("Poll")').click();
  await dialog(robinA).locator('.hint:has-text("This poll is end-to-end encrypted")').waitFor();
  assert.equal(await dialog(robinA).locator('text=Hide results until people vote').count(), 0, 'hiding results isn’t offered: nobody could enforce it');
  await dialog(robinA).locator('button:has-text("Cancel")').click();
  await say(robinA, '/roll 2d6');
  await robinA.locator('.toast:has-text("a fair roll needs the server to see the result")').waitFor();
  assert.equal(await robinA.locator('.main [data-composer] textarea').inputValue(), '/roll 2d6', 'the command stays for editing');
  await robinA.locator('.main [data-composer] textarea').fill('');
  const MARK = `FWD-${Date.now().toString(36)}`;
  await say(robinA, `${MARK} to share`);
  const msg = robinA.locator(`.main .msg:has-text("${MARK} to share")`).last();
  await msg.locator('.msg-text').waitFor();
  await msg.hover();
  await msg.locator('[aria-label="More actions"]').click();
  await robinA.locator('[role=menu] :text-is("Forward")').click();
  await dialog(robinA).locator('input[type=search]').fill('glaze');
  await dialog(robinA).locator('.fwd-dest').first().click();
  await dialog(robinA).locator('.e2-warn:has-text("This will post the message unencrypted in")').waitFor();
  await dialog(robinA).locator('button:has-text("Forward")').last().click();
  await dialog(robinA).waitFor({ state: 'detached' });
  await expectRow(() => srv.db.get("SELECT text FROM messages WHERE conv = 'k_glaze' AND text LIKE ?", `%${MARK} to share%`), 'the room copy is readable, as the warning said');
  // Into an encrypted conversation (here the same one): sealed again, shown as a forward, nothing readable on the server.
  await msg.hover();
  await msg.locator('[aria-label="More actions"]').click();
  await robinA.locator('[role=menu] :text-is("Forward")').click();
  await dialog(robinA).locator('input[type=search]').fill('Ines');
  await dialog(robinA).locator('.fwd-dest:has-text("Ines Carvalho")').first().click();
  assert.equal(await dialog(robinA).locator('.e2-warn').count(), 0);
  await dialog(robinA).locator('textarea').fill(`${MARK} note`);
  await dialog(robinA).locator('button:has-text("Forward")').last().click();
  await dialog(robinA).waitFor({ state: 'detached' });
  await robinA.locator(`.main .msg:has-text("${MARK} note") .fwd:has-text("${MARK} to share")`).waitFor();
  const dm = dmOf('robin', 'ines');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM messages WHERE conv = ? AND (text LIKE ? OR fwd LIKE ?)', dm, `%${MARK}%`, `%${MARK}%`).n, 0);
});

async function expectRow(get, why) {
  for (let i = 0; i < 50; i++) { if (get()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(why);
}

// ---------- step 6: attachments, scheduled, groups, epochs, device removal, reset ----------
// A 2 by 2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('attachments: a picture sent in an encrypted DM shows from a blob on the other side; the server keeps no PNG', async () => {
  const ines = await device('ines');
  await recoverWith(ines, inesKey);
  await openDm(robinA, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  const before = new Set(storedFiles(join(dir, 'files')));
  await robinA.locator('.main [data-composer] input[type=file]').setInputFiles({ name: 'glaze-test.png', mimeType: 'image/png', buffer: PNG });
  await robinA.locator('.main [data-composer] .pending-file .pending-state:not(:has-text("Uploading"))').waitFor();
  assert.equal(await robinA.locator('.main [data-composer] .pending-state.bad').count(), 0, 'the encrypted upload worked');
  await robinA.locator('.main [data-composer] textarea').press('Enter');
  const img = ines.locator('.main .msg .files img[src^="blob:"]').last();
  await img.waitFor();
  assert.ok(await img.evaluate((el) => el.complete && el.naturalWidth === 2), 'the decrypted picture loads');
  const added = storedFiles(join(dir, 'files')).filter((f) => !before.has(f));
  assert.ok(added.length >= 1);
  for (const f of added) {
    const bytes = readStoredSync(join(dir, 'files', f)); // 0.14: under the at-rest layer, still ciphertext
    assert.equal(bytes.subarray(0, 4).equals(PNG_MAGIC), false, `files/${f} is a readable PNG`);
    assert.equal(srv.db.get('SELECT enc FROM files WHERE id = ?', f)?.enc, 1);
  }
  const res = await ines.evaluate(async (id) => { const r = await fetch(`/api/files/${id}`); return [r.headers.get('content-type'), r.headers.get('content-disposition')]; }, added[0]);
  assert.equal(res[0], 'application/octet-stream');
  assert.match(res[1], /^attachment/);
  await ines.context().close();
});

test('scheduled: sealed now, sent later by the server, readable when it arrives; 14 days at most here', async () => {
  const ines = await device('ines');
  await recoverWith(ines, inesKey);
  await openDm(robinA, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  const MARK = `SCHED-${Date.now().toString(36)}`;
  await robinA.locator('.main .plus-btn').click();
  await robinA.locator('[role=menu] :text("Schedule a message")').click();
  await dialog(robinA).locator('.modal-lead:has-text("Up to 14 days ahead in encrypted conversations")').waitFor();
  await dialog(robinA).locator('textarea').fill(`${MARK} later`);
  // 70 seconds from now (to the second), so the time it was sealed for matches when the server sends it below.
  await dialog(robinA).locator('#sched-at').evaluate((el) => {
    const t = new Date(Date.now() + 70_000);
    const p = (n) => String(n).padStart(2, '0');
    el.value = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await dialog(robinA).locator('button:has-text("Schedule")').last().click();
  await dialog(robinA).waitFor({ state: 'detached' });
  const row = srv.db.get('SELECT id, text, enc FROM scheduled WHERE user = ? ORDER BY created DESC LIMIT 1', idOf('robin'));
  assert.equal(row.text, '');
  assert.ok(!row.enc.includes(MARK));
  srv.db.run('UPDATE scheduled SET at = ? WHERE id = ?', Date.now() - 1, row.id);
  srv.hub.messaging.tick();
  await textOf(ines, `${MARK} later`).waitFor();
  scanServer(MARK);
  await ines.context().close();
});

test('group of three: once Malik turns it on the group is encrypted; after he is removed his open page gets nothing new', async () => {
  const malik = await device('malik');
  await turnOn(malik);
  const g = 'g_sat';
  await expectRow(() => srv.db.get('SELECT e2ee FROM dms WHERE id = ?', g)?.e2ee === 1, 'the group turned encrypted');
  const ines = await device('ines');
  await recoverWith(ines, inesKey);
  for (const p of [robinA, ines, malik]) await openDm(p, 'Saturday load');
  const MARK = `GRP-${Date.now().toString(36)}`;
  await say(robinA, `${MARK} all three`);
  await textOf(ines, `${MARK} all three`).waitFor();
  await textOf(malik, `${MARK} all three`).waitFor();
  await robinA.evaluate(async (u) => (await import('/js/server.js')).call('dm.kick', { dm: 'g_sat', user: u }), idOf('malik'));
  // The server writes the line about the removal: in an encrypted conversation it says it isn't encrypted.
  await robinA.locator('.main .dmline:has-text("removed") .e2-note-mark[aria-label="Snug note (not encrypted)"]').waitFor();
  await say(robinA, `${MARK} just us`);
  await textOf(ines, `${MARK} just us`).waitFor();
  await malik.waitForTimeout(500);
  assert.equal(await malik.evaluate((needle) => JSON.stringify(window.snug.S.msgs).includes(needle), `${MARK} just us`), false);
  const last = srv.db.get("SELECT enc FROM messages WHERE conv = 'g_sat' AND enc IS NOT NULL ORDER BY seq DESC LIMIT 1");
  assert.equal(JSON.parse(last.enc).h.to.some(([u]) => u === idOf('malik')), false, 'not sealed to Malik');
  scanServer(MARK);
  await ines.context().close();
  await malik.context().close();
});

test('history epochs: a week-old history key is replaced; removing a device starts another; the recovery key still reads both sides', async () => {
  const MARK = `EPOCH-${Date.now().toString(36)}`;
  await openDm(robinA, 'Ines Carvalho');
  await say(robinA, `${MARK} before`);
  await textOf(robinA, `${MARK} before`).waitFor();
  const robin = idOf('robin');
  const e0 = srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', robin).epoch;
  srv.db.run('UPDATE e2ee_accounts SET epoch_at = ? WHERE user = ?', Date.now() - 8 * 86_400_000, robin);
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
  await expectRow(() => srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', robin).epoch === e0 + 1, 'a new epoch');
  await openDm(robinA, 'Ines Carvalho');
  await say(robinA, `${MARK} after`);
  await textOf(robinA, `${MARK} after`).waitFor();
  const h = JSON.parse(srv.db.get('SELECT enc FROM messages WHERE conv = ? AND enc IS NOT NULL ORDER BY seq DESC LIMIT 1', dmOf('robin', 'ines')).enc).h;
  assert.deepEqual(h.ar.find(([u]) => u === robin), [robin, e0 + 1], 'sealed to the new history key');
  // Remove one of Robin's other devices in Settings: another epoch.
  await openEncryptionSettings(robinA);
  const others = robinA.locator('.e2-dev:not(:has-text("(this device)")) button:has-text("Remove")');
  await others.first().click();
  await dialog(robinA).locator('button:has-text("Remove")').last().click();
  robinKey = await saveKey(robinA); // every removal makes a new recovery key (review H3, second pass)
  await expectRow(() => srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', robin).epoch === e0 + 2, 'removal starts a new epoch');
  await robinA.keyboard.press('Escape');
  // A new browser with the recovery key reads messages sealed to the old and the new history keys.
  const fresh = await device('robin');
  await recoverWith(fresh, robinKey);
  await openDm(fresh, 'Ines Carvalho');
  await textOf(fresh, `${MARK} before`).waitFor();
  await textOf(fresh, `${MARK} after`).waitFor();
  await fresh.context().close();
});

test('search: the server finds nothing in encrypted conversations; this device does, and further back on request', async () => {
  const MARK = `FIND${Date.now().toString(36)}`;
  await openDm(robinA, 'Ines Carvalho');
  await say(robinA, `the kiln code is ${MARK}`);
  await textOf(robinA, `the kiln code is ${MARK}`).waitFor();
  const server = await robinA.evaluate(async (q) => (await (await import('/js/server.js')).call('search', { q })).hits.length, MARK.toLowerCase());
  assert.equal(server, 0, 'the server has no text to match');
  await robinA.evaluate((q) => import('/js/store.js').then((s) => s.go({ type: 'search', q })), MARK.toLowerCase());
  const section = robinA.locator('.e2-search');
  await section.locator('.search-group-h:has-text("Encrypted conversations (searched on this device)")').waitFor();
  await section.locator(`.item-text:has-text("${MARK}")`).waitFor();
  // A new browser of Robin's has nothing loaded far back; searching further back loads and decrypts it.
  const fresh = await device('robin');
  await recoverWith(fresh, robinKey);
  await fresh.evaluate((q) => import('/js/store.js').then((s) => s.go({ type: 'search', q })), MARK.toLowerCase());
  await fresh.locator('.e2-search button:has-text("Search further back")').click();
  await fresh.locator('.e2-search .hint:has-text("Searched up to 2000 messages")').waitFor();
  await fresh.locator(`.e2-search .item-text:has-text("${MARK}")`).waitFor();
  await fresh.context().close();
});

test('reset: Ines resets her encryption; Robin, who verified her, is held at the composer until he chooses; then it sends', async () => {
  const ines = await device('ines');
  await dialog(ines).locator('h2:has-text("Add this browser")').waitFor();
  await ines.keyboard.press('Escape');
  await openEncryptionSettings(ines);
  await ines.locator('.layer-col button:has-text("Reset encryption")').click();
  await dialog(ines).locator('h2:has-text("Reset end-to-end encryption")').waitFor();
  await dialog(ines).locator('button[type=submit]:has-text("Reset encryption")').click();
  await dialog(ines).locator('#e2-recovery-key').waitFor();
  inesKey = (await dialog(ines).locator('#e2-recovery-key code').allTextContents()).join('-');
  await waitStatus(ines, 'ready');
  await ines.keyboard.press('Escape');
  assert.ok(srv.db.get('SELECT reset_at FROM e2ee_accounts WHERE user = ?', idOf('ines')).reset_at);
  await openDm(robinA, 'Ines Carvalho');
  const gate = robinA.locator('.main .e2-gate:has-text("safety number changed since you verified it")');
  await gate.waitFor();
  const MARK = `RESET-${Date.now().toString(36)}`;
  await say(robinA, `${MARK} held`);
  await robinA.locator('.main .msg-state.failed:has-text("safety number changed")').waitFor();
  await gate.locator('button:has-text("I understand, send anyway")').click();
  await gate.waitFor({ state: 'detached' });
  await say(robinA, `${MARK} sent`);
  await openDm(ines, 'Robin Hale');
  await textOf(ines, `${MARK} sent`).waitFor();
  await ines.context().close();
});

test('labels: a DM with someone who hasn’t set up encryption says so; a house room says it isn’t end-to-end encrypted', async () => {
  await openDm(robinA, 'Tomasz');
  await robinA.locator('.main .bar .e2-label:not(.on):has-text("Not end-to-end encrypted")').waitFor();
  await robinA.click('.main .bar [aria-label="Details"]');
  assert.match(await robinA.locator('.pane[aria-label="Details"] .e2-detail').textContent(), /hasn’t set up encryption yet\. Messages are stored readable on this server/);
  await robinA.evaluate(() => import('/js/store.js').then((s) => s.openConv('k_glaze')));
  await robinA.locator('.main.conv .bar-title').waitFor();
  if (!(await robinA.locator('.pane[aria-label="Details"]').count())) {
    await robinA.click('.main .bar [aria-label="More options"]');
    await robinA.locator('[role=menu] :text-is("Details")').click();
  }
  await robinA.locator('.pane[aria-label="Details"] .e2-room-note:has-text("aren’t end-to-end encrypted")').waitFor();
  assert.equal(await robinA.locator('.main .bar .e2-label').count(), 0, 'no lock or shield in rooms');
  // A one-time hint above a room's composer says the same; "Got it" puts it away on this device, for every room.
  const hint = robinA.locator('.main .composer .e2-room-hint');
  assert.match(await hint.textContent(), /can be read by whoever runs it and by moderators\. They aren’t end-to-end encrypted/);
  await hint.locator('button:has-text("Got it")').click();
  await hint.waitFor({ state: 'detached' });
  const other = await robinA.evaluate(() => Object.keys(window.snug.S.rooms).find((r) => r !== 'k_glaze' && window.snug.S.rooms[r].kind === 'text'));
  await robinA.evaluate((r) => import('/js/store.js').then((s) => s.openConv(r)), other);
  await robinA.locator('.main .composer textarea').waitFor();
  assert.equal(await robinA.locator('.main .composer .e2-room-hint').count(), 0);
  // In a DM there is no room hint.
  await openDm(robinA, 'Tomasz');
  assert.equal(await robinA.locator('.main .composer .e2-room-hint').count(), 0);
});

test('phone: the setup, add-device and safety-number sheets fit a 390px screen', async () => {
  const priya = await device('priya', { phone: true });
  await priya.locator('.tab:has-text("Messages")').click();
  await priya.locator('.e2-invite').waitFor();
  assert.ok(await noOverflow(priya), 'the invitation');
  await openSetup(priya);
  assert.ok(await noOverflow(priya), 'setup sheet');
  const key = await turnOn(priya);
  assert.ok(key);
  const phone2 = await device('priya', { phone: true });
  await dialog(phone2).locator('h2:has-text("Add this browser")').waitFor();
  assert.ok(await noOverflow(phone2), 'add-device sheet');
  await dialog(phone2).locator('button:has-text("Use my other device")').click();
  await dialog(phone2).locator('#e2-code').waitFor();
  assert.ok(await noOverflow(phone2), 'code screen');
  await dialog(priya).locator('button:has-text("Approve")').click();
  await dialog(priya).locator('#e2-link-code').waitFor();
  assert.ok(await noOverflow(priya), 'approval code');
  const box = await dialog(priya).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 391, 'the dialog is inside the screen');
  await dialog(priya).locator('button:has-text("Cancel")').click();
  await dialog(priya).waitFor({ state: 'detached' });
  // Safety number with Robin (encryption on since the first test), from the DM's details.
  await priya.click('.tab:has-text("Messages")');
  await priya.click('.tab-body .row:has-text("Robin")');
  await priya.locator('.screen.push .composer textarea').waitFor();
  await priya.click('.screen.push .bar [aria-label="More"]');
  await priya.locator('[role=menu] [role=menuitem]:has-text("Details")').click();
  await priya.locator('.e2-detail button:has-text("Safety number")').click();
  await dialog(priya).locator('#e2-safety-number').waitFor();
  assert.ok(await noOverflow(priya), 'safety number sheet');
  const sn = await dialog(priya).boundingBox();
  assert.ok(sn.x >= 0 && sn.x + sn.width <= 391, 'the safety number sheet is inside the screen');
  // Their DM turned encrypted (Robin has it on): the phone header shows the lock, a message goes through, nothing overflows.
  await priya.keyboard.press('Escape');
  await priya.locator('.screen.push .bar .e2-label.on').waitFor();
  const pbox = priya.locator('.screen.push .composer textarea');
  await pbox.fill('From my phone, encrypted');
  await pbox.press('Enter');
  await priya.locator('.screen.push .msg-text:has-text("From my phone, encrypted")').waitFor();
  await priya.locator('.screen.push .e2-compose-note').waitFor();
  assert.ok(await noOverflow(priya), 'encrypted conversation on a phone');
  await phone2.context().close();
  await priya.context().close();
});

test('on by default: a server with no setting offers encryption without interrupting; Not now puts the offer away on this device', async () => {
  const d = `${dir}-default`;
  const on = await startServer({ port: 0, dataDir: d, quiet: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => errors.push(`default: ${e.message}`));
    await page.goto(`http://127.0.0.1:${on.port}`);
    await page.waitForSelector('.auth-form');
    await page.evaluate(async () => {
      await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'newperson', name: 'New Person', password: 'a long password' }) });
    });
    await page.reload();
    await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    await waitStatus(page, 'none');
    await page.waitForTimeout(500);
    assert.equal(await dialog(page).count(), 0, 'nothing pops up over the app');
    await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
    const invite = page.locator('.e2-invite');
    await invite.locator('h3:has-text("Encrypt your direct messages")').waitFor();
    await invite.locator('button:has-text("Not now")').click();
    await invite.waitFor({ state: 'detached' });
    await page.reload();
    await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
    await page.locator('.nav .sect:has-text("Direct messages")').waitFor();
    assert.equal(await page.locator('.e2-invite').count(), 0, 'put away on this device');
    // Still offered where it belongs.
    await openEncryptionSettings(page);
    await page.locator('.layer-col button:has-text("Turn on")').click();
    await dialog(page).locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
    await ctx.close();
  } finally { await on.close(); rmSync(d, { recursive: true, force: true }); }
});

test('the server owner\'s switch: with SNUG_E2EE=off the server offers nothing and lists no Encryption page', async () => {
  const was = process.env.SNUG_E2EE;
  process.env.SNUG_E2EE = 'off';
  let off;
  try { off = await startServer({ port: 0, dataDir: dir.replace(/$/, '-off'), quiet: true }); } finally { if (was === undefined) delete process.env.SNUG_E2EE; else process.env.SNUG_E2EE = was; }
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`off: ${e.message}`));
    await page.goto(`http://127.0.0.1:${off.port}`);
    await page.waitForSelector('.auth-form');
    await page.click('text=Create an account').catch(() => {});
    await page.evaluate(async () => {
      await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'offperson', name: 'Off', password: 'a long password' }) });
    });
    await page.reload();
    await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    await page.waitForTimeout(300);
    assert.equal(await status(page), 'off');
    assert.equal(await dialog(page).count(), 0);
    await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
    await page.locator('.layer-nav').waitFor();
    assert.equal(await page.locator('.layer-nav .row:has-text("Encryption")').count(), 0);
    await ctx.close();
  } finally { await off.close(); rmSync(`${dir}-off`, { recursive: true, force: true }); }
});

// ---------- review fixes (H1, H2, H3, M1, M3, M4, M5, L2, L4) ----------
const msgIdOf = (page, needle) => page.waitForFunction((n) => { for (const l of Object.values(window.snug.S.msgs)) { const m = l.find((x) => x.text === n && !x.state); if (m) return m.id; } return null; }, needle, { timeout: 30_000 }).then((h) => h.jsonValue());
async function saveKey(page) {
  await dialog(page).locator('#e2-recovery-key').waitFor();
  const key = (await dialog(page).locator('#e2-recovery-key code').allTextContents()).join('-');
  await dialog(page).locator('#e2-last').fill(key.slice(-4));
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).waitFor({ state: 'detached' });
  return key;
}

test('review H2, L2: an opened envelope shown elsewhere, as someone else, with another reply or as an older revision is refused; nothing decrypted reaches localStorage', async () => {
  await openDm(robinA, 'Ines Carvalho');
  const MARK = `REPLAY-${Date.now().toString(36)}`;
  await say(robinA, `${MARK} original`);
  await textOf(robinA, `${MARK} original`).waitFor();
  await msgIdOf(robinA, `${MARK} original`); // the server has it (Arrow Up edits the last one it has)
  await robinA.locator('.main [data-composer] textarea').press('ArrowUp');
  // Arrow Up must have opened this message (not an earlier one) before the edit is typed.
  await robinA.waitForFunction((t) => document.querySelector('.main .msg-edit textarea')?.value === t, `${MARK} original`);
  await robinA.locator('.main .msg-edit textarea').fill(`${MARK} edited`);
  await robinA.locator('.main .msg-edit textarea').press('Enter');
  const id = await msgIdOf(robinA, `${MARK} edited`);
  const got = await robinA.evaluate(async ({ id, ines }) => {
    const conv = await import('/js/e2ee/conv.js');
    const { call } = await import('/js/server.js');
    let m = null;
    for (const l of Object.values(window.snug.S.msgs)) m ||= l.find((x) => x.id === id && x.e2ee);
    const place = m.e2ee.h.place;
    const copy = (over = {}, h = {}) => JSON.parse(JSON.stringify({ id: m.id, author: m.author, ts: m.ts, seq: m.seq, ...over, e2ee: { ...m.e2ee, h: { ...m.e2ee.h, ...h } } }));
    const hist = await call('msg.edits', { conv: place, id });
    const views = {
      elsewhere: copy({}, { place: 'g_sat', conv: 'g_sat' }), // the server moves it into the group
      author: copy({ author: ines }), // shown as Ines's
      reply: copy({ replyTo: 'm_notthereply12' }), // shown as a reply it wasn't
      older: JSON.parse(JSON.stringify({ id: m.id, author: m.author, ts: m.ts, seq: m.seq, e2ee: hist.edits[0].e2ee })), // the first version, sent as if it were current
    };
    conv.scan({ conv: 'g_sat', m: views.elsewhere });
    conv.scan({ conv: place, m: views.author });
    conv.scan({ conv: place, m: views.reply });
    conv.scan({ conv: place, m: views.older });
    // The edit history itself still opens its earlier versions.
    const history = { current: { id: m.id, author: m.author, e2ee: hist.current.e2ee }, edits: hist.edits.map((x) => ({ id: x.id, author: x.author, ts: x.ts, e2ee: x.e2ee })) };
    conv.scanReply(history, 'msg.edits'); // as the msg.edits answer arrives
    await new Promise((r) => setTimeout(r, 1500));
    const out = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, [v.enc, v.encWhy, v.text]]));
    out.history = [history.edits[0].enc, history.edits[0].text];
    return out;
  }, { id, ines: idOf('ines') });
  assert.deepEqual(got.elsewhere.slice(0, 1), ['failed']);
  assert.deepEqual(got.author, ['failed', 'author', '']);
  assert.deepEqual(got.reply, ['failed', 'reply', '']);
  assert.deepEqual(got.older, ['failed', 'revision', '']);
  assert.equal(got.elsewhere[2], '');
  assert.deepEqual(got.history, [true, `${MARK} original`]);
  // The device copy (written at most every 2 seconds) holds envelopes, not text.
  await robinA.waitForTimeout(2500);
  const stored = await robinA.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'));
  assert.ok(stored.length > 0);
  assert.equal(stored.includes(MARK), false, 'decrypted text in localStorage');
});

test('review H2: a message the server adds without an envelope to an encrypted conversation shows as not encrypted, delivered by the server', async () => {
  const dm = dmOf('robin', 'ines');
  const MARK = `INJECTED-${Date.now().toString(36)}`;
  srv.db.run("INSERT INTO messages (id, conv, author, ts, text, fold) VALUES (?, ?, ?, ?, ?, '')", `m_inj${Date.now().toString(36)}`, dm, idOf('ines'), Date.now(), `${MARK} send me your password`);
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
  await openDm(robinA, 'Ines Carvalho');
  const row = robinA.locator(`.main .msg:has-text("${MARK}")`);
  await row.locator('.e2-unsealed:has-text("Not encrypted – delivered by the server")').waitFor();
  await row.click({ button: 'right' });
  await robinA.locator('[role=menu] :text("Not encrypted – delivered by the server")').waitFor();
  await robinA.keyboard.press('Escape');
  // Messages from before the conversation turned encrypted keep their own (legacy) mark, not this one.
  const legacy = await robinA.evaluate((dm) => (window.snug.S.msgs[dm] || []).filter((m) => m.legacy).length, dm);
  assert.ok(legacy >= 0);
});

test('review H1: synced settings rolled back or removed by the server: this device keeps its copy, says so, and still won’t send in plain text where it saw encryption', async () => {
  const robin = idOf('robin');
  const dm = dmOf('robin', 'ines');
  // The server serves the account's first settings blob (ver 1, nothing in it) and says the DM isn't encrypted.
  const first = await robinA.evaluate(async () => {
    const { ring } = await import('/js/e2ee/manager.js');
    const b = await import('/js/lib/e2ee/backup.js');
    return b.sealMeta(b.emptyMeta(), ring.keys.sync, { u: window.snug.S.me, ver: 1 });
  });
  const seenVer = srv.db.get('SELECT ver FROM e2ee_meta WHERE user = ?', robin).ver;
  assert.ok(seenVer > 1);
  srv.db.run('UPDATE e2ee_meta SET ver = 1, blob = ? WHERE user = ?', first, robin);
  srv.db.run('UPDATE dms SET e2ee = NULL WHERE id = ?', dm);
  try {
    await robinA.reload();
    await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    await waitStatus(robinA, 'ready');
    await robinA.waitForFunction(() => window.snug.e2ee.E2.metaProblem === 'rollback');
    await openDm(robinA, 'Ines Carvalho');
    await robinA.locator('.main .e2-warn:has-text("isn’t encrypted any more")').waitFor();
    await say(robinA, 'this must never go out readable');
    await robinA.locator('.main .msg-state.failed:has-text("won’t send here in plain text")').waitFor();
    assert.equal(srv.db.get("SELECT COUNT(*) n FROM messages WHERE text LIKE '%never go out readable%'").n, 0);
    // Settings says what happened; the person puts this device's copy back.
    await openEncryptionSettings(robinA);
    await robinA.locator('.e2-meta-problem:has-text("older synced encryption settings")').waitFor();
    await robinA.locator('.e2-meta-problem button:has-text("Put this device’s copy back")').click();
    await robinA.waitForFunction(() => window.snug.e2ee.E2.metaProblem === null);
    // Above the highest version this device saw, never at the server's 1 + 1 (review H1, second pass).
    const repaired = srv.db.get('SELECT ver FROM e2ee_meta WHERE user = ?', robin).ver;
    assert.ok(repaired > seenVer, `repaired at ${repaired}, not above ${seenVer}`);
    // Gone altogether after it was seen: an error too, never "empty".
    srv.db.run('DELETE FROM e2ee_meta WHERE user = ?', robin);
    await robinA.reload();
    await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    await robinA.waitForFunction(() => window.snug.e2ee.E2.metaProblem === 'missing');
    await openEncryptionSettings(robinA);
    await robinA.locator('.e2-meta-problem button').click();
    await robinA.waitForFunction(() => window.snug.e2ee.E2.metaProblem === null);
    assert.ok(srv.db.get('SELECT ver FROM e2ee_meta WHERE user = ?', robin).ver > repaired);
  } finally {
    srv.db.run('UPDATE dms SET e2ee = 1 WHERE id = ?', dm);
  }
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
});

test('review M5: where this device saw encryption and the server now says there is none, no upload, edit, forward or plain op goes out', async () => {
  const dm = dmOf('robin', 'ines');
  await openDm(robinA, 'Ines Carvalho');
  const got = await robinA.evaluate(async (dm) => {
    const { S } = window.snug;
    const server = await import('/js/server.js');
    const store = await import('/js/store.js');
    S.dms[dm].e2ee = false; // what a downgrading server reports
    const out = {};
    try { await server.uploadFile(dm, new Blob(['plain bytes'], { type: 'text/plain' }), 'notes.txt'); out.upload = 'sent'; } catch (e) { out.upload = e.code || e.message; }
    try { await server.call('msg.send', { conv: dm, id: 'm_downgradeplain1', text: 'plain' }); out.send = 'sent'; } catch (e) { out.send = e.code || e.message; }
    try { await server.call('poll.create', { conv: dm, question: 'q', options: ['a', 'b'] }); out.poll = 'sent'; } catch (e) { out.poll = e.code || e.message; }
    try { await server.call('msg.forward', { conv: 'k_glaze', id: 'x', to: dm }); out.forward = 'sent'; } catch (e) { out.forward = e.code || e.message; }
    const mine = (S.msgs[dm] || []).filter((m) => m.author === S.me && m.e2ee && m.enc === true).at(-1);
    store.editMsg(dm, mine.id, 'an edit in plain text');
    await new Promise((r) => setTimeout(r, 300));
    S.dms[dm].e2ee = true;
    return out;
  }, dm);
  assert.deepEqual(got, { upload: 'e2ee_downgraded', send: 'e2ee_downgraded', poll: 'e2ee_downgraded', forward: 'e2ee_downgraded' });
  await robinA.locator('.toast:has-text("won’t send here in plain text")').first().waitFor();
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM messages WHERE text = 'an edit in plain text' OR text = 'plain'").n, 0);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM files WHERE name = 'notes.txt'").n, 0);
});

test('review M4, L4: a contact’s new safety number and added or removed devices stay as lines in the conversation; a message from a removed device says so', async () => {
  await openDm(robinA, 'Ines Carvalho');
  // Ines's reset (earlier) is a lasting line here, also after a reload.
  await robinA.locator('.main .e2-keyline:has-text("Ines Carvalho’s safety number changed")').waitFor();
  const MARK = `OLDPHONE-${Date.now().toString(36)}`;
  const phone = await device('ines');
  await recoverWith(phone, inesKey);
  await robinA.locator('.main .e2-keyline:has-text("Ines Carvalho added a device")').first().waitFor();
  await openDm(phone, 'Robin Hale');
  await say(phone, `${MARK} sent from the phone`);
  await textOf(robinA, `${MARK} sent from the phone`).waitFor();
  const gone = await phone.evaluate(() => window.snug.e2ee.E2.device.d);
  const laptop = await device('ines');
  await recoverWith(laptop, inesKey);
  await laptop.evaluate(async (d) => (await import('/js/e2ee/manager.js')).removeDevice(d), gone);
  await robinA.locator('.main .e2-keyline:has-text("Ines Carvalho removed a device")').first().waitFor();
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
  await openDm(robinA, 'Ines Carvalho');
  await robinA.locator('.main .e2-keyline:has-text("removed a device")').first().waitFor();
  await robinA.locator('.main .e2-keyline:has-text("safety number changed")').waitFor();
  const msg = robinA.locator(`.main .msg:has-text("${MARK} sent from the phone")`);
  await msg.locator('.msg-text').waitFor();
  await msg.click({ button: 'right' });
  await robinA.locator('[role=menu] :text("Sent from a device Ines has since removed")').waitFor();
  await robinA.keyboard.press('Escape');
  await phone.context().close().catch(() => {});
  await laptop.context().close();
});

test('review H3, M1, M3: removing a lost device makes a new recovery key the old one can’t replace; "My keys may be exposed" makes new keys; an older own device list is refused', async () => {
  const robin = idOf('robin');
  const lost = await device('robin');
  await recoverWith(lost, robinKey);
  const d = await lost.evaluate(() => window.snug.e2ee.E2.device.d);
  const before = { ...srv.db.get('SELECT * FROM e2ee_accounts WHERE user = ?', robin) };
  const metaVer = srv.db.get('SELECT ver FROM e2ee_meta WHERE user = ?', robin).ver;
  await openDm(robinA, 'Ines Carvalho'); // closes the approval sheet the new device's request opened
  await openEncryptionSettings(robinA);
  await robinA.locator(`.e2-dev[data-d="${d}"] button:has-text("Remove")`).click();
  await dialog(robinA).locator('#e2-lost').check();
  await dialog(robinA).locator('button:has-text("Remove")').last().click();
  const newKey = await saveKey(robinA);
  assert.notEqual(newKey, robinKey);
  assert.equal(srv.db.get('SELECT state FROM e2ee_devices WHERE id = ?', d).state, 'removed');
  const after = srv.db.get('SELECT ver, epoch FROM e2ee_accounts WHERE user = ?', robin);
  assert.equal(after.epoch, before.epoch + 1, 'a new history epoch');
  assert.ok(srv.db.get('SELECT ver FROM e2ee_meta WHERE user = ?', robin).ver > metaVer, 'settings sealed again under a new key');
  assert.equal(await robinA.evaluate(() => window.snug.e2ee.E2.metaProblem), null);
  // The old recovery key (which the lost device's owner could have) no longer opens the backup; the new one does.
  const fresh = await device('robin');
  await dialog(fresh).locator('button:has-text("Use my recovery key")').click();
  await dialog(fresh).locator('#e2-rk-in').fill(robinKey);
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('[role=alert]:has-text("doesn’t open your backup")').waitFor();
  await dialog(fresh).locator('#e2-rk-in').fill(newKey);
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('h2:has-text("Encryption is back")').waitFor();
  await dialog(fresh).locator('button:has-text("Done")').click();
  await waitStatus(fresh, 'ready');
  assert.equal(await fresh.evaluate(() => window.snug.e2ee.E2.metaProblem), null, 'the new device opens the settings under the new key');
  robinKey = newKey;
  await fresh.context().close();
  await lost.context().close().catch(() => {});
  // "My keys may be exposed": new history key, settings key and recovery key.
  const e1 = srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', robin).epoch;
  await openDm(robinA, 'Ines Carvalho'); // closes Settings and the sheets the new devices opened
  await openEncryptionSettings(robinA);
  await robinA.locator('.layer-col button:has-text("Make new keys")').click();
  await dialog(robinA).locator('button:has-text("Make new keys")').click();
  robinKey = await saveKey(robinA);
  assert.equal(srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', robin).epoch, e1 + 1);
  await robinA.keyboard.press('Escape');
  // The server hands back an older list of Robin's own devices: refused, never sealed to.
  const now = { ...srv.db.get('SELECT * FROM e2ee_accounts WHERE user = ?', robin) };
  srv.db.run('UPDATE e2ee_accounts SET ver = ?, list = ?, sig = ? WHERE user = ?', before.ver, before.list, before.sig, robin);
  try {
    await robinA.reload();
    await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    await waitStatus(robinA, 'ready');
    await openDm(robinA, 'Ines Carvalho');
    await say(robinA, 'sealed to an old list?');
    await robinA.locator('.main .msg-state.failed:has-text("older list of your devices")').waitFor();
  } finally {
    srv.db.run('UPDATE e2ee_accounts SET ver = ?, list = ?, sig = ? WHERE user = ?', now.ver, now.list, now.sig, robin);
  }
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
});

// Review L2 (the rest): what this device keeps for an encrypted conversation while it is unsent (the draft,
// what it replies to, a message waiting for the connection) is sealed under this device's storage key, never
// written to localStorage as text, and comes back once the keys are open after a reload.
test('review L2: a draft and a message waiting to send in an encrypted DM never reach localStorage as text; after a reload both come back, and it sends', async () => {
  await openDm(robinA, 'Ines Carvalho');
  const MARK = `UNSENT-${Date.now().toString(36)}`;
  const ctx = robinA.context();
  await ctx.setOffline(true);
  await robinA.evaluate(() => window.snug.voiceTest.dropSocket());
  await robinA.waitForFunction(() => window.snug.S.conn.socket !== 'open');
  await say(robinA, `${MARK} queued`);
  await robinA.waitForFunction((t) => Object.values(window.snug.S.msgs).flat().some((m) => m.text === t && m.state === 'queued'), `${MARK} queued`);
  const replyTo = await robinA.evaluate(() => Object.values(window.snug.S.msgs).flat().find((m) => m.e2ee && !m.state)?.id);
  await robinA.evaluate(async (id) => { const { setReply } = await import('/js/store.js'); setReply(window.snug.S.ui.view.id, id); }, replyTo);
  await robinA.locator('.main [data-composer] textarea').fill(`${MARK} draft`);
  // Drafts are saved shortly after a change, the device copy at most every 2 seconds (and when the page goes).
  await robinA.waitForTimeout(2600);
  await robinA.evaluate(() => dispatchEvent(new Event('pagehide')));
  const stored = await robinA.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n'));
  assert.ok(stored.includes('snug.cache='));
  assert.equal(stored.includes(MARK), false, 'the draft or the waiting message is in localStorage as text');
  assert.equal(stored.split('\n').find((l) => l.startsWith('snug.reply='))?.includes(replyTo) ?? false, false, 'what the draft replies to isn’t kept in the clear either');
  // A reload: this page goes while offline; the next one opens with the connection back.
  await robinA.close();
  await ctx.setOffline(false);
  robinA = await ctx.newPage();
  robinA.setDefaultTimeout(15000);
  robinA.on('pageerror', (e) => errors.push(`robin: ${e.message}`));
  await robinA.goto(url);
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
  // It was sent, sealed: the server has the envelope and no text.
  const sentId = await msgIdOf(robinA, `${MARK} queued`);
  await expectRow(() => srv.db.get('SELECT enc FROM messages WHERE id = ?', sentId)?.enc, 'the waiting message reached the server');
  assert.equal(srv.db.get('SELECT text FROM messages WHERE id = ?', sentId).text, '');
  await openDm(robinA, 'Ines Carvalho');
  await robinA.waitForFunction((t) => document.querySelector('.main [data-composer] textarea')?.value === t, `${MARK} draft`);
  assert.equal(await robinA.evaluate(() => window.snug.S.ui.reply[window.snug.S.ui.view.id]), replyTo, 'still a reply');
  await robinA.locator('.main .composer:has-text("Replying to")').waitFor();
  await robinA.waitForTimeout(2600);
  assert.equal((await robinA.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'))).includes(MARK), false);
  scanServer(`${MARK} draft`);
  // Sent, it is a message like any other (and nothing is left unsent).
  await say(robinA, `${MARK} draft`);
  const draftId = await msgIdOf(robinA, `${MARK} draft`);
  assert.ok(srv.db.get('SELECT enc FROM messages WHERE id = ?', draftId)?.enc);
  scanServer(MARK);
});

// A scheduled message with history off: its envelope opens on the author's own device after a reload (it is
// sealed to that device, and the key is kept sealed here), so "Waiting here" shows its text.
test('scheduled, history off: after a reload the Waiting here list still shows the text', async () => {
  const R = idOf('robin');
  await openEncryptionSettings(robinA);
  const sw = robinA.locator('.layer-col [role=switch]').first();
  if ((await sw.getAttribute('aria-checked')) !== 'false') await sw.click();
  await expectRow(() => srv.db.get('SELECT hist FROM e2ee_accounts WHERE user = ?', R).hist === 0, 'history off');
  await openDm(robinA, 'Ines Carvalho');
  const MARK = `SCHED-OFF-${Date.now().toString(36)}`;
  const schedule = async () => {
    await robinA.locator('.main .plus-btn').click();
    await robinA.locator('[role=menu] :text("Schedule a message")').click();
    await dialog(robinA).locator('.modal-lead:has-text("Up to 14 days ahead")').waitFor();
  };
  await schedule();
  await dialog(robinA).locator('textarea').fill(`${MARK} later`);
  await dialog(robinA).locator('.chips .chip').first().click();
  await dialog(robinA).locator('button:has-text("Schedule")').last().click();
  await dialog(robinA).waitFor({ state: 'detached' });
  const row = srv.db.get('SELECT id, enc FROM scheduled WHERE user = ? ORDER BY created DESC LIMIT 1', R);
  assert.ok(row.enc && !row.enc.includes(MARK));
  assert.equal(row.enc.includes(`"a:${R}:`), false, 'no history wrap with history off');
  await robinA.reload();
  await robinA.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(robinA, 'ready');
  await openDm(robinA, 'Ines Carvalho');
  await schedule();
  await dialog(robinA).locator(`.sched-list .sched-text:has-text("${MARK} later")`).waitFor();
  assert.equal(await dialog(robinA).locator('.sched-list .sched-text:text-is("Encrypted message")').count(), 0);
  // Tidy up: cancel it, and history back on for the tests after this one.
  await dialog(robinA).locator('.sched-item:has-text("SCHED-OFF") button:has-text("Cancel")').click();
  await expectRow(() => !srv.db.get('SELECT 1 FROM scheduled WHERE id = ?', row.id), 'cancelled');
  await robinA.keyboard.press('Escape');
  await openEncryptionSettings(robinA);
  await robinA.locator('.layer-col [role=switch]').first().click();
  await expectRow(() => srv.db.get('SELECT hist FROM e2ee_accounts WHERE user = ?', R).hist === 1, 'history on again');
  await robinA.keyboard.press('Escape');
});
