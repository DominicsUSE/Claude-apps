// Safety, privacy and moderation, driven in Chromium against the real server,
// with separate people in separate browser sessions (seeded data: Robin and
// Ines own Kiln & Co., Priya and Sunniva are members, Jonas is not in it).
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-safety-'));
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

async function person(handle, { viewport = { width: 1280, height: 800 }, path = '/' } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  await page.goto(url + path);
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
async function say(page, text) { await box(page).fill(text); await box(page).press('Enter'); }
const settled = (page) => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state || m.state === 'failed'));
const msg = (page, text) => page.locator('.main .msg', { hasText: text });
async function menuOn(page, text, item) {
  const m = msg(page, text).last();
  await m.waitFor();
  await m.hover();
  await m.locator('[aria-label="More actions"]').click();
  await page.locator(`.menu-item:has-text("${item}")`).click();
}
async function houseMenu(page, item) {
  await openPlace(page, 'Kiln & Co.');
  await page.click('.nav .ctx-house');
  await page.click(`.menu-item:has-text("${item}")`);
}
const close = (page) => page.context().close();

test('blocking: their messages fold away with Show, they can’t message you, and Settings lists them to unblock', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await go(robin, 'The floor');
    await go(priya, 'The floor');
    await say(priya, 'Priya here with a glaze question');
    await settled(priya);
    await menuOn(robin, 'Priya here with a glaze question', 'Block');
    await robin.locator('.modal h2:has-text("Block Priya")').waitFor();
    await robin.click('.modal .btn.danger:has-text("Block")');
    await robin.locator('.toast:has-text("is blocked")').waitFor();
    // Folded away, with a way to look.
    const folded = robin.locator('.main .blocked-msg').last();
    await folded.waitFor();
    assert.equal(await msg(robin, 'Priya here with a glaze question').count(), 0);
    await folded.locator('button:has-text("Show")').click();
    await msg(robin, 'Priya here with a glaze question').waitFor();
    // New messages arrive folded too, and don't notify.
    await say(priya, 'second try @robin ok');
    await robin.waitForFunction(() => window.snug.S.msgs.k_floor.some((m) => m.text.includes('second try')));
    assert.equal(await msg(robin, 'second try').count(), 0);
    assert.equal(await robin.locator('.toast:has-text("second try")').count(), 0);
    // Priya can't write to Robin any more; the server refuses and she's told.
    await priya.evaluate(() => { window.snug.S.ui.view = { type: 'conv', id: 'd_priya' }; window.snug.emit(); });
    await priya.locator('.main .bar-title:has-text("Robin")').waitFor();
    await say(priya, 'are you there');
    await priya.locator('.main .msg-state.failed:has-text("couldn’t be delivered")').waitFor();
    // Robin sees why the box is closed in that conversation.
    await robin.evaluate(() => { window.snug.S.ui.view = { type: 'conv', id: 'd_priya' }; window.snug.emit(); });
    await robin.locator('.main .safety-locked:has-text("You blocked Priya")').waitFor();
    // Settings > Privacy and safety: the block list, and unblocking.
    await robin.click('button[aria-label="Settings"]');
    await robin.locator('.layer').waitFor();
    await robin.click('.layer-nav .row:has-text("Privacy and safety")');
    const item = robin.locator('.safe-item:has-text("Priya")');
    await item.waitFor();
    await item.locator('button:has-text("Unblock")').click();
    await robin.locator('.safe-empty:has-text("Nobody")').waitFor();
    assert.deepEqual(await robin.evaluate(() => window.snug.S.safety.blocks), []);
    await robin.keyboard.press('Escape');
  } finally { await close(robin); await close(priya); }
});

test('moderation: time someone out from a message, they see a countdown; reports reach the queue and the house log records it', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await go(robin, 'Glaze lab');
    await go(priya, 'Glaze lab');
    await say(priya, 'Selling cheap kiln shelves, DM me');
    await settled(priya);
    await menuOn(robin, 'Selling cheap kiln shelves', 'Time out');
    await robin.locator('.modal h2:has-text("Time out Priya")').waitFor();
    await robin.selectOption('#mod-choice', String(5 * 60_000));
    await robin.fill('#mod-reason', 'No selling here');
    await robin.click('.modal button[type=submit]');
    await robin.locator('.toast:has-text("is timed out")').waitFor();
    // Priya: told why, and the box counts down instead of letting her write.
    await priya.locator('.toast:has-text("timed out in Kiln & Co.")').waitFor();
    const locked = priya.locator('.main .safety-locked:has-text("You’re timed out in Kiln & Co.")');
    await locked.waitFor();
    assert.match(await locked.textContent(), /for (4m 5\ds|5m)\. You can still read/);
    // Priya reports a message of Robin's (from her side, the menu offers Report message).
    await say(robin, 'Kiln two is full tonight');
    await settled(robin);
    await menuOn(priya, 'Kiln two is full tonight', 'Report message');
    await priya.locator('.modal h2:has-text("Report this message")').waitFor();
    await priya.click('.modal button[type=submit]');
    await priya.locator('.modal .err:has-text("Pick what’s wrong")').waitFor();
    await priya.click('.report-reason:has-text("Spam or scams")');
    await priya.fill('#report-note', 'testing the queue');
    await priya.click('.modal button[type=submit]');
    await priya.locator('.toast:has-text("Reported")').waitFor();
    // Robin: the house menu says one is open; the queue shows it; resolve it.
    await houseMenu(robin, 'Moderation (1 open)');
    await robin.locator('.layer h1:has-text("Reports")').waitFor();
    const rep = robin.locator('.safe-report', { hasText: 'Kiln two is full tonight' });
    await rep.waitFor();
    assert.match(await rep.textContent(), /Spam or scams/);
    assert.match(await rep.textContent(), /testing the queue/);
    assert.match(await rep.textContent(), /Reported by Priya/);
    // Timed out now: lift Priya's timeout from here.
    const t = robin.locator('.safe-item:has-text("Priya")');
    await t.locator('button:has-text("Remove timeout")').click();
    await priya.locator('.main .composer textarea').waitFor();
    await rep.locator('button:has-text("Resolve")').click();
    await robin.locator('.empty:has-text("Nothing to look at")').waitFor();
    // The house log.
    await robin.click('.layer-nav .row:has-text("House log")');
    await robin.locator('.safe-log-row:has-text("timed out Priya")').waitFor();
    await robin.locator('.safe-log-row:has-text("resolved a report about Robin")').waitFor();
    await robin.selectOption('#log-kind', 'member');
    await robin.locator('.safe-log-row:has-text("resolved a report")').waitFor({ state: 'detached' }); // the filtered list replaces the full one
    await robin.locator('.safe-log-row:has-text("removed Priya")').waitFor();
    await robin.keyboard.press('Escape');
    await say(priya, 'sorry, back to glazes');
    await settled(priya);
    assert.equal(await priya.locator('.main .msg-state.failed').count(), 0);
  } finally { await close(robin); await close(priya); }
});

test('slowmode counts down in the composer; screening asks a newcomer to accept the rules; a one-use link runs out', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  let jonas, aiko;
  try {
    await houseMenu(robin, 'House settings');
    await robin.click('.layer-nav .row:has-text("Filter and screening")');
    await robin.locator('.layer h1:has-text("Filter and screening")').waitFor();
    await robin.selectOption('select[aria-label="Slowmode in Glaze lab"]', '10');
    await priya.waitForFunction(() => window.snug.S.rooms.k_glaze.slowmode === 10);
    await go(priya, 'Glaze lab');
    await priya.locator('.slow-note:has-text("one message every 10 seconds")').waitFor();
    await say(priya, 'first under slowmode');
    await priya.locator('.slow-note.waiting:has-text("You can send again in")').waitFor();
    await box(priya).fill('too soon');
    await box(priya).press('Enter');
    await priya.locator('.toast:has-text("Slowmode is on here")').waitFor();
    assert.equal(await msg(priya, 'too soon').count(), 0);

    // Screening on (Kiln & Co. has rules), then a one-use link.
    await robin.click('.switch[aria-label="Member screening"]');
    await priya.waitForFunction(() => window.snug.S.houses.kiln.screening === true);
    assert.equal(await priya.evaluate(() => window.snug.S.houses.kiln.accepted), true, 'people already in are not asked');
    await robin.click('.layer-nav .row:has-text("Invitations")');
    await robin.selectOption('#inv-uses', '1');
    await robin.selectOption('#inv-age', String(30 * 60_000));
    await robin.click('.safe-make button:has-text("Make a link")');
    const link = await robin.locator('.safe-made input').inputValue();
    const code = link.split('/join/')[1];
    await robin.locator(`.safe-invite:has-text("${code}")`).waitFor();
    assert.match(await robin.locator(`.safe-invite:has-text("${code}")`).textContent(), /0 of 1 uses/);

    // Jonas (not in Kiln & Co.) follows the link.
    const follow = async (page) => page.evaluate((c) => { window.snug.S.ui.joinCode = c; window.snug.emit(); }, code);
    jonas = await person('jonas');
    await follow(jonas);
    await jonas.locator('.modal button:has-text("Join Kiln & Co.")').click();
    await jonas.waitForFunction(() => window.snug.S.houses.kiln?.joined);
    await jonas.waitForFunction(() => window.snug.S.houses.kiln.accepted === false);
    await go(jonas, 'The floor');
    await jonas.locator('.main .safety-locked:has-text("Accept Kiln & Co.’s rules")').waitFor();
    await jonas.click('.main .safety-locked button:has-text("Read the rules")');
    await jonas.locator('.modal .rules-text:has-text("Wipe your foot rings")').waitFor();
    await jonas.click('.modal button:has-text("I accept the rules")');
    await box(jonas).waitFor();
    await say(jonas, 'Hello from Jonas, rules read');
    await settled(jonas);
    await msg(robin, 'Hello from Jonas').waitFor({ state: 'attached' }).catch(() => {});
    assert.ok(await srv.db.get("SELECT 1 FROM messages WHERE author = 'jonas' AND text LIKE 'Hello from Jonas%'"));

    // The link is used up for the next person.
    aiko = await person('aiko');
    await follow(aiko);
    await aiko.locator('.modal h2:has-text("That invitation doesn’t work")').waitFor();
    assert.match(await aiko.locator('.modal').textContent(), /expired/);
    assert.equal(await aiko.evaluate(() => !!window.snug.S.houses.kiln?.joined), false);
  } finally {
    await close(robin); await close(priya);
    if (jonas) await close(jonas);
    if (aiko) await close(aiko);
  }
});

test('message requests on a phone: a conversation from a non-friend waits behind Accept, Decline and Block', async () => {
  const robin = await person('robin', { viewport: { width: 390, height: 844 } });
  const sunniva = await person('sunniva');
  try {
    // Robin turns on message requests (from Settings, through the store on the phone).
    await robin.evaluate(() => import('/js/views/settings.js').then((m) => import('/js/store.js').then((s) => s.openLayer({ C: m.Settings, props: { page: 'privacy' } }))));
    await robin.locator('.layer h1:has-text("Privacy and safety")').waitFor();
    await robin.click('.switch[aria-label="Message requests for people who aren’t friends"]');
    await robin.waitForFunction(() => window.snug.S.safety.privacy.requests === true);
    assert.equal(await srv.db.get("SELECT requests FROM privacy WHERE user = 'robin'").requests, 1);
    await robin.keyboard.press('Escape');

    // Sunniva (a housemate, not a friend) opens a conversation from Robin's profile.
    await go(sunniva, 'The floor');
    await sunniva.evaluate(() => import('/js/views/people.js').then((p) => p.showProfile(window.snug.S.users.robin, document.querySelector('.main .bar-title').getBoundingClientRect(), 'kiln')));
    await sunniva.locator('.pcard button:has-text("Message")').click();
    await sunniva.locator('.main .bar-title:has-text("Robin")').waitFor();
    await say(sunniva, 'Hi Robin, can I borrow a banding wheel?');
    await settled(sunniva);
    await sunniva.locator('.safety-banner:has-text("hasn’t accepted your message request")').waitFor();

    // Robin: the conversation is there, behind the request banner; no notification.
    const dm = await robin.waitForFunction(() => window.snug.S.safety.requests[0]?.dm).then((h) => h.jsonValue());
    assert.equal(await robin.locator('.toast:has-text("banding wheel")').count(), 0);
    await robin.evaluate((id) => { window.snug.S.ui.view = { type: 'conv', id }; window.snug.S.ui.depth = 1; window.snug.emit(); }, dm);
    const banner = robin.locator('.safety-banner.request');
    await banner.waitFor();
    assert.match(await banner.textContent(), /Sunniva/);
    for (const b of ['Accept', 'Decline', 'Block']) {
      const r = await banner.locator(`button:has-text("${b}")`).boundingBox();
      assert.ok(r.height >= 44, `${b} is a 44px target on a phone (got ${r.height})`);
    }
    const noScroll = await robin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(noScroll, 'no sideways scrolling');
    await banner.locator('button:has-text("Accept")').click();
    await banner.waitFor({ state: 'detached' });
    await sunniva.locator('.safety-banner').waitFor({ state: 'detached' });
    assert.equal(await robin.evaluate(() => window.snug.S.safety.requests.length), 0);
  } finally { await close(robin); await close(sunniva); }
});

test('voice moderation: a moderator mutes someone from the stage; their microphone stops, others stop hearing them, and they can’t unmute', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    const wheel = async (page) => {
      await openPlace(page, 'Kiln & Co.');
      await page.click('.nav .row:has-text("Wheel room")');
      await page.locator('.stage').waitFor();
      await page.click('.stage .btn.primary:has-text("Join voice")');
      await page.locator('.stage [aria-label="Leave voice"]').waitFor();
    };
    await wheel(robin);
    await wheel(priya);
    await robin.waitForFunction(() => (window.snug.S.voice.k_wheel || []).length === 2);
    // Priya can't moderate Robin (an owner): no button for her.
    assert.equal(await priya.locator('.stage [aria-label="Moderate Robin Hale in voice"]').count(), 0);
    await robin.click('.stage [aria-label="Moderate Priya Raman in voice"]');
    await robin.click('.menu-item:has-text("Mute in voice")');
    await robin.locator('.toast:has-text("Priya is muted in voice")').waitFor();
    // Priya's own microphone goes off, and her Unmute is refused.
    await priya.waitForFunction(() => window.snug.S.call?.muted === true && window.snug.S.voiceState.k_wheel?.priya?.smute === true);
    await priya.click('.stage [aria-label="Unmute"]');
    await priya.locator('.toast:has-text("A moderator muted you here")').waitFor();
    assert.equal(await priya.evaluate(() => window.snug.S.call.muted), true);
    // Robin's browser stops playing Priya.
    await robin.waitForFunction(() => window.snug.S.voiceState.k_wheel?.priya?.smute === true);
    await robin.locator('.stage .stage-mod.on').waitFor();
    // Lift it; Priya may unmute again.
    await robin.click('.stage [aria-label="Moderate Priya Raman in voice"]');
    await robin.click('.menu-item:has-text("Unmute in voice")');
    await priya.waitForFunction(() => !window.snug.S.voiceState.k_wheel?.priya?.smute);
    await priya.click('.stage [aria-label="Unmute"]');
    await priya.waitForFunction(() => window.snug.S.call.muted === false);
    // Disconnect.
    await robin.click('.stage [aria-label="Moderate Priya Raman in voice"]');
    await robin.click('.menu-item:has-text("Disconnect from voice")');
    await priya.locator('.toast:has-text("disconnected from the voice room")').waitFor();
    await priya.waitForFunction(() => !window.snug.S.call);
    const log = await srv.db.all("SELECT action FROM audit WHERE house = 'kiln' AND action LIKE 'voice.%' ORDER BY id");
    assert.deepEqual(log.map((r) => r.action), ['voice.mute', 'voice.unmute', 'voice.disconnect']);
  } finally { await close(robin); await close(priya); }
});
