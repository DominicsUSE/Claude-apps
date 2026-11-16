// End-to-end encryption, second review pass (Chromium against the real server,
// seeded data, separate browser contexts as separate devices). Each test is a
// gap a verifier confirmed after the first fix pass: what the server can still
// show as someone's message without an envelope (H2), the revision check
// skipped from one payload (H2-rev), synced settings rolled back past a repair
// or onto a new device (H1, H1-newdev), what a removed device keeps (H3),
// history keys across builds and history switched back on (M2), a stale device
// blocking every key change, a contact's pin after "send anyway", messages
// from removed devices (L4), key lines before the loaded window (M4) and the
// pinned start of encryption (e2eeSince).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-e2ee2-'));
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
const waitStatus = (page, want) => page.waitForFunction((w) => window.snug.e2ee.E2.status === w, want);
const idOf = (handle) => srv.db.get('SELECT id FROM users WHERE handle = ?', handle).id;
const dialog = (page) => page.locator('.modal[role=dialog]');
const dmOf = (a, b) => srv.db.get(`SELECT dm FROM dm_members WHERE user IN (?, ?) GROUP BY dm
  HAVING COUNT(*) = 2 AND (SELECT COUNT(*) FROM dm_members x WHERE x.dm = dm_members.dm) = 2`, idOf(a), idOf(b)).dm;
const textOf = (page, needle) => page.locator(`.main .msg .msg-text:has-text("${needle}")`);
const msgIdOf = (page, needle) => page.waitForFunction((n) => { for (const l of Object.values(window.snug.S.msgs)) { const m = l.find((x) => x.text === n && !x.state); if (m) return m.id; } return null; }, needle).then((h) => h.jsonValue());
async function expectRow(get, why) {
  for (let i = 0; i < 80; i++) { if (get()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(why);
}
async function turnOn(page) {
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.locator('.e2-invite button:has-text("Turn on")').click();
  await dialog(page).locator('button:has-text("Turn on")').click();
  return saveKey(page);
}
async function saveKey(page) {
  await dialog(page).locator('#e2-recovery-key').waitFor();
  const key = (await dialog(page).locator('#e2-recovery-key code').allTextContents()).join('-');
  await dialog(page).locator('#e2-last').fill(key.slice(-4));
  await dialog(page).locator('button:has-text("I’ve saved it")').click();
  await dialog(page).waitFor({ state: 'detached' });
  return key;
}
async function recoverWith(page, key) {
  await dialog(page).locator('h2:has-text("Add this browser")').waitFor();
  await dialog(page).locator('button:has-text("Use my recovery key")').click();
  await dialog(page).locator('#e2-rk-in').fill(key);
  await dialog(page).locator('button:has-text("Use recovery key")').click();
  await dialog(page).locator('h2:has-text("Encryption is back")').waitFor();
  await dialog(page).locator('button:has-text("Done")').click();
  await waitStatus(page, 'ready');
}
async function closeSheets(page) {
  for (let i = 0; i < 4 && (await dialog(page).count() || await page.locator('.layer-col').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
}
async function openDm(page, title) {
  await closeSheets(page);
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.click(`.nav .row:has-text("${title}")`);
  await page.locator(`.main .bar-title:has-text("${title}")`).waitFor();
}
async function openEncryptionSettings(page) {
  await closeSheets(page);
  await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Encryption")');
  await page.locator('.layer-col h1:has-text("Encryption")').waitFor();
}
async function say(page, text) {
  const box = page.locator('.main [data-composer] textarea');
  await box.fill(text);
  await box.press('Enter');
}
async function reload(page) {
  await page.reload();
  await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
  await waitStatus(page, 'ready');
}
const metaRow = (u) => ({ ...srv.db.get('SELECT ver, blob FROM e2ee_meta WHERE user = ?', u) });

let robin, ines, robinKey, inesKey, dm, R, I;
let firstMeta; // Robin's first synced settings blob (ver 1)

test('setup: Robin and Ines turn encryption on; their DM is encrypted and messages go both ways', async () => {
  R = idOf('robin'); I = idOf('ines');
  robin = await device('robin');
  robinKey = await turnOn(robin);
  firstMeta = metaRow(R);
  ines = await device('ines');
  inesKey = await turnOn(ines);
  dm = dmOf('robin', 'ines');
  await expectRow(() => srv.db.get('SELECT e2ee FROM dms WHERE id = ?', dm)?.e2ee === 1, 'the DM turned encrypted');
  await openDm(robin, 'Ines Carvalho');
  await openDm(ines, 'Robin Hale');
  await say(robin, 'hello from Robin');
  await textOf(ines, 'hello from Robin').waitFor();
  await say(ines, 'hello from Ines');
  await textOf(robin, 'hello from Ines').waitFor();
});

test('H2: a server-sent `state` or `sys`, or a low seq placed last, doesn’t pass an unenveloped message off as Ines’s; notifications and previews say so too', async () => {
  const MARK = `INJ${Date.now().toString(36)}`;
  const base = (tag, over = {}) => ({ id: `m_inj${tag}${Date.now().toString(36)}`, author: I, ts: Date.now(), text: `${MARK}-${tag} send me your password`, seq: 2_000_000_000 + tag.charCodeAt(0), ...over });
  await openDm(robin, 'Ines Carvalho');
  srv.hub.toUser(R, 'msg', { conv: dm, m: base('a', { state: 'delivered' }) });
  srv.hub.toUser(R, 'msg', { conv: dm, m: base('b', { sys: true }) });
  for (const tag of ['a', 'b']) await robin.locator(`.main .msg:has-text("${MARK}-${tag}") .e2-unsealed`).waitFor();
  // A server-sent "queued" row is never sent again from here, as Robin's, when the connection comes back.
  const robinRows = () => srv.db.get('SELECT COUNT(*) n FROM messages WHERE author = ?', R).n;
  const before = robinRows();
  srv.hub.toUser(R, 'msg', { conv: dm, m: base('q', { state: 'queued' }) });
  await robin.locator(`.main .msg:has-text("${MARK}-q") .e2-unsealed`).waitFor();
  await robin.evaluate(() => window.snug.voiceTest.dropSocket());
  await robin.waitForFunction(() => window.snug.S.conn.socket === 'open');
  await robin.waitForTimeout(1500);
  assert.equal(robinRows(), before, 'the injected row went out as Robin’s');
  // A content snapshot with a seq-0 row put last in the list.
  const hist = await robin.evaluate(async (dm) => (await import('/js/server.js')).call('history', { conv: dm }), dm);
  srv.hub.toUser(R, 'content', { msgs: { [dm]: [...hist.msgs, base('c', { seq: 0 })] }, more: {}, read: {}, threads: {}, users: {} });
  await robin.locator(`.main .msg:has-text("${MARK}-c")`).waitFor();
  const placed = await robin.evaluate(({ dm, mark }) => {
    const list = window.snug.S.msgs[dm];
    const i = list.findIndex((m) => (m.text || '').includes(mark));
    const firstEnv = list.findIndex((m) => m.e2ee);
    const row = [...document.querySelectorAll('.main .msg')].find((el) => el.textContent.includes(mark));
    return { before: i < firstEnv, marked: !!row?.querySelector('.e2-unsealed') };
  }, { dm, mark: `${MARK}-c` });
  assert.ok(placed.before || placed.marked, `the seq-0 row is neither placed before the encrypted messages nor marked: ${JSON.stringify(placed)}`);
  // Notifications: while Robin looks elsewhere, an unenveloped message doesn't toast Ines's name with its text.
  await robin.click('.rail-btn:has(.sr:text-matches("^Kiln"))').catch(() => {});
  await robin.evaluate(() => { window.snug.S.ui.view = { type: 'home' }; window.snug.emit(); });
  srv.hub.toUser(R, 'msg', { conv: dm, m: base('d') });
  await robin.locator('.toast:has-text("Not encrypted")').first().waitFor();
  assert.equal(await robin.locator(`.toast:has-text("${MARK}-d")`).count(), 0, 'the injected text in a notification');
  // The phone's DM list: its preview says it isn't encrypted, not the injected text.
  await robin.setViewportSize({ width: 390, height: 844 });
  try {
    await robin.waitForFunction(() => window.snug.S.ui.phone === true);
    await robin.evaluate(() => import('/js/store.js').then((s) => s.go({ type: 'home' })));
    if (await robin.locator('.tab:has-text("Messages")').count()) await robin.click('.tab:has-text("Messages")');
    const row = robin.locator('.row.two:has-text("Ines Carvalho")').first();
    await row.waitFor();
    await robin.waitForFunction(() => [...document.querySelectorAll('.row.two')].some((r) => r.textContent.includes('Ines Carvalho') && r.textContent.includes('Not encrypted')));
    assert.equal(await row.locator(`text=${MARK}-d`).count(), 0, 'the injected text in the DM list');
  } finally {
    await robin.setViewportSize({ width: 1280, height: 800 });
    await robin.waitForFunction(() => window.snug.S.ui.phone === false);
  }
});

test('e2eeSince: a since pinned past the first envelope seen is lowered to it, so later unenveloped rows are marked', async () => {
  await robin.evaluate(async (dm) => {
    const { ring } = await import('/js/e2ee/manager.js');
    await ring.store.putSecret('convs', { [dm]: 9_000_000_000 }); // as if the server had reported a huge e2eeSince at upgrade
  }, dm);
  await reload(robin);
  await openDm(robin, 'Ines Carvalho');
  await textOf(robin, 'hello from Ines').waitFor();
  const firstEnvSeq = srv.db.get('SELECT MIN(seq) s FROM messages WHERE conv = ? AND enc IS NOT NULL', dm).s;
  await robin.waitForFunction(async ({ dm, s }) => (await import('/js/e2ee/conv.js')).encryptedSince(dm) <= s, { dm, s: firstEnvSeq });
  const MARK = `LATE${Date.now().toString(36)}`;
  srv.hub.toUser(R, 'msg', { conv: dm, m: { id: `m_late${Date.now().toString(36)}`, author: I, ts: Date.now(), text: `${MARK} plain`, seq: firstEnvSeq + 1_000_000 } });
  await robin.locator(`.main .msg:has-text("${MARK}") .e2-unsealed`).waitFor();
});

test('H2-rev: one payload carrying an old revision both as current and under some `edits` key is still refused as current', async () => {
  await openDm(robin, 'Ines Carvalho');
  const MARK = `REV${Date.now().toString(36)}`;
  await say(robin, `${MARK} original`);
  await textOf(robin, `${MARK} original`).waitFor();
  await robin.locator('.main [data-composer] textarea').press('ArrowUp');
  await robin.locator('.main .msg-edit textarea').fill(`${MARK} edited`);
  await robin.locator('.main .msg-edit textarea').press('Enter');
  const id = await msgIdOf(robin, `${MARK} edited`);
  await reload(robin); // this page's memory forgets the top revision; the device's store still has it
  await openDm(robin, 'Ines Carvalho');
  await textOf(robin, `${MARK} edited`).waitFor();
  const got = await robin.evaluate(async (id) => {
    const conv = await import('/js/e2ee/conv.js');
    const { call } = await import('/js/server.js');
    let m = null;
    for (const l of Object.values(window.snug.S.msgs)) m ||= l.find((x) => x.id === id && x.e2ee);
    const place = m.e2ee.h.place;
    const hist = await call('msg.edits', { conv: place, id }); // the real edit history still opens its earlier version
    const rev0 = hist.edits[hist.edits.length - 1].e2ee;
    conv._test.topRev.delete(id); // as a page that hasn't loaded the current revision (the device's store still has it)
    const view = { id, author: m.author, ts: m.ts, seq: m.seq, e2ee: JSON.parse(JSON.stringify(rev0)) };
    const copy = { id, author: m.author, ts: m.ts, e2ee: JSON.parse(JSON.stringify(rev0)) };
    conv.scan({ msgs: { [place]: [view] }, edits: [copy] });
    await new Promise((r) => setTimeout(r, 1500));
    return { view: [view.enc, view.encWhy, view.text], history: [hist.edits.at(-1).enc, hist.edits.at(-1).text] };
  }, id);
  assert.deepEqual(got.view, ['failed', 'revision', '']);
  assert.deepEqual(got.history, [true, `${MARK} original`]);
});

test('H1: putting this device’s copy back never lowers its mark, so an older settings blob replayed after the repair is still refused; no key change goes out meanwhile', async () => {
  // Three more versions of the synced settings, keeping each blob the server held.
  const seen = [];
  for (const yes of [true, false, true]) {
    await robin.evaluate(async ({ u, yes }) => {
      const m = await import('/js/e2ee/manager.js');
      const s = await m.safetyFor(u);
      await m.setVerified(u, s.aik, yes);
    }, { u: I, yes });
    seen.push(metaRow(R));
  }
  const top = seen.at(-1).ver;
  assert.ok(top >= 4);
  // The server goes back to the first blob: refused; the person puts this device's copy back.
  srv.db.run('UPDATE e2ee_meta SET ver = ?, blob = ? WHERE user = ?', firstMeta.ver, firstMeta.blob, R);
  await reload(robin);
  await robin.waitForFunction(() => window.snug.e2ee.E2.metaProblem === 'rollback');
  // While the settings are behind, no key change writes settings at the server's lower version.
  const exposed = await robin.evaluate(async () => { try { await (await import('/js/e2ee/manager.js')).newRecoveryKeyFlow(); return 'sent'; } catch (e) { return e.message; } });
  assert.match(exposed, /synced encryption settings/);
  await openEncryptionSettings(robin);
  await robin.locator('.e2-meta-problem button').click();
  await robin.waitForFunction(() => window.snug.e2ee.E2.metaProblem === null);
  assert.ok(metaRow(R).ver > top, `the repair wrote at ${metaRow(R).ver}, not above ${top}`);
  // An older blob the device once took, replayed now: still a rollback.
  const old = seen[1];
  srv.db.run('UPDATE e2ee_meta SET ver = ?, blob = ? WHERE user = ?', old.ver, old.blob, R);
  await reload(robin);
  await robin.waitForFunction(() => window.snug.e2ee.E2.metaProblem === 'rollback');
  await openEncryptionSettings(robin);
  await robin.locator('.e2-meta-problem button').click();
  await robin.waitForFunction(() => window.snug.e2ee.E2.metaProblem === null);
});

test('H1-newdev: a device added with a code, or with the recovery key, isn’t fooled by settings rolled back to before it existed', async () => {
  // The recovery backup carries the settings version and the encrypted conversations (written by any key change).
  await openEncryptionSettings(robin);
  await robin.locator('.layer-col button:has-text("Make a new recovery key")').click();
  await dialog(robin).locator('button:has-text("Make a new key")').click();
  robinKey = await saveKey(robin);
  const live = metaRow(R);
  srv.db.run('UPDATE e2ee_meta SET ver = ?, blob = ? WHERE user = ?', firstMeta.ver, firstMeta.blob, R);
  srv.db.run('UPDATE dms SET e2ee = NULL WHERE id = ?', dm);
  try {
    // With the code from Robin's laptop.
    const b = await device('robin');
    await dialog(b).locator('h2:has-text("Add this browser")').waitFor();
    await dialog(b).locator('button:has-text("Use my other device")').click();
    await dialog(b).locator('#e2-code').waitFor();
    await dialog(robin).locator('button:has-text("Approve")').click();
    const code = await dialog(robin).locator('#e2-link-code').textContent();
    await dialog(b).locator('#e2-code').fill(code);
    await dialog(b).locator('button:has-text("Add this browser")').click();
    await dialog(b).locator('h2:has-text("This browser is added")').waitFor();
    await dialog(b).locator('button:has-text("Done")').click();
    await waitStatus(b, 'ready');
    await b.waitForFunction(() => window.snug.e2ee.E2.metaProblem === 'rollback');
    await openDm(b, 'Ines Carvalho');
    await b.evaluate((dm) => { window.snug.S.dms[dm].e2ee = false; window.snug.emit(); }, dm); // what a downgrading server reports (it may upgrade the DM again on its own)
    await say(b, 'new device must not send this readable');
    await b.locator('.main .msg-state.failed:has-text("won’t send here in plain text")').waitFor();
    await b.context().close();
    await closeSheets(robin);
    // With the recovery key.
    const c = await device('robin');
    await recoverWith(c, robinKey);
    await c.waitForFunction(() => window.snug.e2ee.E2.metaProblem === 'rollback');
    await openDm(c, 'Ines Carvalho');
    await c.evaluate((dm) => { window.snug.S.dms[dm].e2ee = false; window.snug.emit(); }, dm);
    await say(c, 'recovered device must not send this readable');
    await c.locator('.main .msg-state.failed:has-text("won’t send here in plain text")').waitFor();
    await c.context().close();
    assert.equal(srv.db.get("SELECT COUNT(*) n FROM messages WHERE text LIKE '%must not send this readable%'").n, 0);
  } finally {
    srv.db.run('UPDATE dms SET e2ee = 1 WHERE id = ?', dm);
    srv.db.run('UPDATE e2ee_meta SET ver = ?, blob = ? WHERE user = ?', live.ver, live.blob, R);
  }
  await closeSheets(robin);
  // Robin removes the two browsers again (plain Remove makes a new recovery key, see H3).
  for (;;) {
    await openEncryptionSettings(robin);
    const other = robin.locator('.e2-dev:not(:has-text("(this device)")) button:has-text("Remove")');
    if (!(await other.count())) break;
    await other.first().click();
    await dialog(robin).locator('button:has-text("Remove")').last().click();
    robinKey = await saveKey(robin);
  }
});

test('H3: a plain Remove makes a new recovery key too; "lost or stolen" warns about the account key; Robin’s devices are told when his list gains a device', async () => {
  const other = await device('robin');
  await recoverWith(other, robinKey);
  // Robin's laptop, which didn't add it, says so prominently.
  await robin.locator('.e2-own-added[role=alert]:has-text("A device was added to your account")').waitFor();
  // One alert per device added elsewhere (the recovered browser of the test before is one too).
  for (let i = 0; i < 5 && await robin.locator('.e2-own-added').count(); i++) {
    await robin.locator('.e2-own-added button:has-text("It’s mine")').click();
    await robin.waitForTimeout(150);
  }
  await robin.locator('.e2-own-added').waitFor({ state: 'detached' });
  const d = await other.evaluate(() => window.snug.e2ee.E2.device.d);
  await openEncryptionSettings(robin);
  await robin.locator(`.e2-dev[data-d="${d}"] button:has-text("Remove")`).click();
  await dialog(robin).locator('#e2-lost').check();
  await dialog(robin).locator('.e2-lost-warn:has-text("Reset encryption")').waitFor();
  await dialog(robin).locator('#e2-lost').uncheck();
  await dialog(robin).locator('button:has-text("Remove")').last().click();
  const newKey = await saveKey(robin);
  assert.notEqual(newKey, robinKey, 'a plain Remove makes a new recovery key');
  await other.context().close().catch(() => {});
  // The old key (which the removed device's owner could still have) no longer opens the backup.
  const fresh = await device('robin');
  await dialog(fresh).locator('button:has-text("Use my recovery key")').click();
  await dialog(fresh).locator('#e2-rk-in').fill(robinKey);
  await dialog(fresh).locator('button:has-text("Use recovery key")').click();
  await dialog(fresh).locator('[role=alert]:has-text("doesn’t open your backup")').waitFor();
  await fresh.context().close();
  robinKey = newKey;
  await closeSheets(robin);
});

test('M2: switching history off and on again starts a new history epoch (a device removed meanwhile holds the old key)', async () => {
  const e0 = srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', R).epoch;
  await openEncryptionSettings(robin);
  const sw = robin.locator('.layer-col [role=switch]').first();
  await sw.click();
  await expectRow(() => srv.db.get('SELECT hist FROM e2ee_accounts WHERE user = ?', R).hist === 0, 'history off');
  await sw.click();
  await expectRow(() => srv.db.get('SELECT hist FROM e2ee_accounts WHERE user = ?', R).hist === 1, 'history on again');
  assert.equal(srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', R).epoch, e0 + 1);
  await closeSheets(robin);
});

test('a device whose prekey is too old no longer stops the weekly history key: it is left out and named; "Make new keys" offers to remove it', async () => {
  const other = await device('robin');
  await recoverWith(other, robinKey);
  const d = await other.evaluate(() => window.snug.e2ee.E2.device.d);
  await other.context().close();
  await closeSheets(robin);
  srv.db.run('DELETE FROM e2ee_prekeys WHERE device = ?', d); // as a phone not opened for over a month
  const e0 = srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', R).epoch;
  srv.db.run('UPDATE e2ee_accounts SET epoch_at = ? WHERE user = ?', Date.now() - 8 * 86_400_000, R);
  await reload(robin);
  await expectRow(() => srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', R).epoch === e0 + 1, 'the weekly epoch went ahead');
  await robin.waitForFunction(() => /Chrome on|Browser on/.test(window.snug.e2ee.E2.rotateProblem || ''));
  // "My keys may be exposed" with that device still listed: offered to remove it, then done.
  await openEncryptionSettings(robin);
  await robin.locator('.layer-col button:has-text("Make new keys")').click();
  await dialog(robin).locator('button:has-text("Make new keys")').click();
  await dialog(robin).locator('button:has-text("Remove it and continue")').click();
  robinKey = await saveKey(robin);
  assert.equal(srv.db.get('SELECT state FROM e2ee_devices WHERE id = ?', d).state, 'removed');
  assert.equal(srv.db.get('SELECT epoch FROM e2ee_accounts WHERE user = ?', R).epoch, e0 + 3, 'the weekly key, the removal, then the new keys');
  await closeSheets(robin);
});

test('L4, M4: a message from a device Ines removed is marked in the conversation; one that reached the server after the removal is refused; key lines before the loaded messages still show', async () => {
  const MARK = `PHONE${Date.now().toString(36)}`;
  await openDm(robin, 'Ines Carvalho');
  const phone = await device('ines');
  await recoverWith(phone, inesKey);
  await openDm(phone, 'Robin Hale');
  // Robin is told where he types that what he sends now also goes to that new device.
  await robin.locator('.main .e2-newdev:has-text("Ines Carvalho added a device this week")').waitFor();
  await say(phone, `${MARK} one`);
  await textOf(robin, `${MARK} one`).waitFor();
  await say(phone, `${MARK} two`);
  await textOf(robin, `${MARK} two`).waitFor();
  const gone = await phone.evaluate(() => window.snug.e2ee.E2.device.d);
  await phone.context().close();
  inesKey = (await ines.evaluate(async (d) => (await import('/js/e2ee/manager.js')).removeDevice(d), gone)).recoveryKey || inesKey;
  const removedAt = Date.now();
  // "two" reached the server (so the server says) after the removal: its sender chose h.ts, the server chose ts.
  srv.db.run('UPDATE messages SET ts = ? WHERE id = (SELECT id FROM messages WHERE conv = ? AND enc IS NOT NULL ORDER BY seq DESC LIMIT 1)', removedAt + 3600_000, dm);
  await robin.locator('.main .e2-keyline:has-text("removed a device")').first().waitFor();
  await robin.locator('.main .e2-newdev').waitFor({ state: 'detached' }); // removed again: no longer a recipient
  await reload(robin);
  await openDm(robin, 'Ines Carvalho');
  const one = robin.locator(`.main .msg:has-text("${MARK} one")`);
  await one.locator('.e2-removed-dev').waitFor();
  await robin.locator('.main .msg .e2-msg.failed').last().waitFor();
  const two = await robin.evaluate(() => { const l = Object.values(window.snug.S.msgs).flat().filter((m) => m.e2ee && m.enc === 'failed'); return l.map((m) => m.encWhy); });
  assert.ok(two.includes('removed device'), `refused: ${JSON.stringify(two)}`);
  // A key line older than every loaded message is pinned at the top of the window.
  const shown = await robin.evaluate(async (dm) => {
    const { E2 } = await import('/js/e2ee/manager.js');
    const { withKeyLines } = await import('/js/views/e2ee-conv.js');
    const ines = window.snug.S.dms[dm].members.find((u) => u !== window.snug.S.me);
    E2.events = [{ id: 'old1', key: 'old1', u: ines, kind: 'added', label: 'Old tablet', ts: 1 }, ...E2.events];
    const items = window.snug.S.msgs[dm].map((m) => ({ type: 'msg', key: m.id, m }));
    return withKeyLines(dm, items).some((it) => it.type === 'e2' && it.e.id === 'old1');
  }, dm);
  assert.equal(shown, true, 'an older key line is dropped');
});

test('a safety number change accepted with "I understand, send anyway" keeps Ines’s devices: her replies still open', async () => {
  // Robin verified Ines; then she resets.
  await robin.evaluate(async (u) => { const m = await import('/js/e2ee/manager.js'); const s = await m.safetyFor(u); await m.setVerified(u, s.aik, true); }, I);
  await ines.evaluate(async () => (await import('/js/e2ee/manager.js')).resetEncryption());
  await closeSheets(ines);
  await openDm(robin, 'Ines Carvalho');
  const gate = robin.locator('.main .e2-gate');
  await gate.waitFor();
  await gate.locator('button:has-text("I understand, send anyway")').click();
  await gate.waitFor({ state: 'detached' });
  const MARK = `AFTER${Date.now().toString(36)}`;
  await say(robin, `${MARK} from Robin`);
  await openDm(ines, 'Robin Hale');
  await textOf(ines, `${MARK} from Robin`).waitFor();
  await say(ines, `${MARK} reply from Ines`);
  await textOf(robin, `${MARK} reply from Ines`).waitFor();
});
