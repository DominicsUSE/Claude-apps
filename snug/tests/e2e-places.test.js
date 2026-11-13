// Places, structure and community, driven in Chromium against the real
// server, with separate people in separate browser sessions (seeded data:
// Robin and Ines lead Kiln & Co., Priya is a Member, Jonas is not in it).
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
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-places-'));
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
async function openPlace(page, house) {
  if (await page.locator(`.rail-house[aria-current="page"]:has-text("${house}")`).count()) return;
  await page.click(`.rail-house:has-text("${house}")`);
  await page.locator(`.nav .ctx-house:has-text("${house}")`).waitFor();
}
async function go(page, name, house = 'Kiln & Co.') {
  await openPlace(page, house);
  await page.click(`.nav .row:has-text("${name}")`);
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
async function say(page, text) { await box(page).fill(text); await box(page).press('Enter'); }
const settled = (page) => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state || m.state === 'failed'));
async function houseMenu(page, item, house = 'Kiln & Co.') {
  await openPlace(page, house);
  await page.click('.nav .ctx-house');
  await page.click(`.menu-item:has-text("${item}")`);
}
async function newRoom(page, name, kind) {
  await houseMenu(page, 'New room');
  await page.fill('#room-name', name);
  await page.click(`.modal .seg button:has-text("${kind}")`);
  await page.click('.modal button[type=submit], .modal .btn.primary');
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
async function access(page, room) {
  await go(page, room);
  if (!(await page.locator('.pane[aria-label="Details"]').count())) await page.click('.main button[aria-label="Details"]');
  await page.click('.pane button:has-text("Access and webhooks")');
  await page.locator('.modal .room-access').waitFor();
}
const close = (page) => page.context().close();

test('a private room from its details: it leaves a member’s sidebar live, and an override for one person brings it back', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await openPlace(priya, 'Kiln & Co.');
    await priya.locator('.nav .row:has-text("Glaze lab")').waitFor();
    await access(robin, 'Glaze lab');
    await robin.click('.modal .switch[aria-label="Private room"]');
    await priya.locator('.nav .row:has-text("Glaze lab")').waitFor({ state: 'detached' });
    assert.equal(await priya.evaluate(() => !!window.snug.S.rooms.k_glaze), false);
    // Robin still sees it, marked private.
    await robin.locator('.pane .access-note:has-text("Private")').waitFor();
    // One person's own setting lets Priya in.
    await robin.selectOption('.modal select[aria-label="Add a person"]', 'priya');
    const row = robin.locator('.modal .ovr[aria-label="Access for Priya Raman"]');
    await row.locator('.seg[aria-label="See the room for Priya Raman"] button:has-text("On")').click();
    await priya.locator('.nav .row:has-text("Glaze lab")').waitFor();
    await go(priya, 'Glaze lab');
    await priya.locator('.main .msg').first().waitFor();
    // "Send messages: Off" for her closes the composer with the reason.
    await row.locator('.seg[aria-label="Send messages for Priya Raman"] button:has-text("Off")').click();
    await priya.waitForFunction(() => window.snug.S.rooms.k_glaze?.perms?.send === false);
    await priya.locator('.main:has-text("can’t send messages in Glaze lab")').waitFor();
    // Back to how it was.
    await row.locator('button[aria-label="Remove the override for Priya Raman"]').click();
    await robin.click('.modal .switch[aria-label="Private room"]');
    await robin.click('.modal button:has-text("Done")');
    await priya.waitForFunction(() => window.snug.S.rooms.k_glaze?.perms?.send === true);
  } finally { await close(robin); await close(priya); }
});

test('a forum: tags that are required, a post that opens as a thread, replies, follow, sort and grid', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await newRoom(robin, 'Questions', 'Forum');
    await robin.locator('.main .forum .empty:has-text("No posts yet")').waitFor();
    // Tags, from the room's access dialog.
    await access(robin, 'Questions');
    await robin.click('.modal .seg button:has-text("Tags")');
    await robin.click('.modal button:has-text("Add a tag")');
    await robin.fill('.modal input[aria-label="Tag name"]', 'Glaze');
    await robin.click('.modal .switch[aria-label="Posts need a tag"]');
    await robin.click('.modal button:has-text("Save tags")');
    await robin.waitForFunction(() => Object.values(window.snug.S.rooms).find((r) => r.name === 'Questions')?.tagRequired === true);
    await robin.click('.modal button:has-text("Done")');
    // A post needs a title, then a tag.
    await robin.click('.main .forum button:has-text("New post")');
    await robin.click('.modal button:has-text("Post")');
    await robin.locator('.modal .err:has-text("Give your post a title")').waitFor();
    await robin.fill('#post-title', 'Why does my glaze crawl?');
    await robin.fill('#post-body', 'Thick application at cone 6.');
    await robin.click('.modal button.btn.primary:has-text("Post")');
    await robin.locator('.modal .err:has-text("Pick at least one tag")').waitFor();
    await robin.click('.modal .chip:has-text("Glaze")');
    await robin.click('.modal button.btn.primary:has-text("Post")');
    await robin.locator('.pane[aria-label="Thread"] .post-title:has-text("Why does my glaze crawl?")').waitFor();
    assert.equal(await robin.locator('.main .post-follow[aria-pressed="true"]').count(), 1, 'the author follows their post');
    // Priya sees the card, opens it and replies in its thread.
    await go(priya, 'Questions');
    const card = priya.locator('.main .post-card:has-text("Why does my glaze crawl?")');
    await card.locator('.tag-chip:has-text("Glaze")').waitFor();
    assert.equal(await priya.locator('.main .composer').count(), 0, 'no plain composer in a forum');
    await card.locator('.post-open').click();
    await priya.locator('.pane[aria-label="Thread"] .composer textarea').fill('Sand the bisque first.');
    await priya.locator('.pane[aria-label="Thread"] .composer textarea').press('Enter');
    await robin.locator('.main .post-card:has-text("Why does my glaze crawl?") .post-meta .num:text-is("1")').waitFor();
    // Replying followed the post; the card's bell turns it off and on again.
    await card.locator('.post-follow[aria-pressed="true"]').click();
    await card.locator('.post-follow[aria-pressed="false"]').waitFor();
    await card.locator('.post-follow').click();
    await card.locator('.post-follow[aria-pressed="true"]').waitFor();
    // Sort and grid are remembered per room.
    await priya.click('.main .forum .seg button[aria-label="Grid"]');
    await priya.locator('.main .forum-posts.grid').waitFor();
    await priya.click('.main .forum .seg button:has-text("Newest")');
    await priya.locator('.main .forum .seg button[aria-pressed="true"]:has-text("Newest")').waitFor();
  } finally { await close(robin); await close(priya); }
});

test('a stage: the audience raises a hand, a lead invites them to speak, and moving them back mutes them', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await newRoom(robin, 'Town hall', 'Stage');
    await robin.click('.main .stage-room button:has-text("Join the stage")');
    await robin.locator('.main .stage-room .stage-list.big .stage-who:has-text("You")').waitFor();
    await go(priya, 'Town hall');
    await priya.click('.main .stage-room button:has-text("Join the stage")');
    await priya.locator('.main .stage-room button:has-text("Raise your hand")').waitFor();
    await priya.waitForFunction(() => window.snug.S.call?.muted === true);
    await priya.click('.main .stage-room button:has-text("Raise your hand")');
    const inAudience = robin.locator('.main .stage-room .stage-list:not(.big) .stage-who:has-text("Priya")');
    await inAudience.locator('.hand-up').waitFor();
    await inAudience.locator('button:has-text("Invite to speak")').click();
    await priya.locator('.main .stage-room button[aria-label="Unmute"]').click();
    await priya.waitForFunction(() => window.snug.S.call?.muted === false);
    await robin.locator('.main .stage-room .stage-list.big .stage-who:has-text("Priya")').waitFor();
    // A topic, set by the lead, for everyone.
    await robin.click('.main .stage-room button[aria-label="Set the topic"]');
    await robin.fill('.main .stage-room input[aria-label="Stage topic"]', 'Kiln rota');
    await robin.click('.main .stage-room button:has-text("Save")');
    await priya.locator('.main .stage-topic:has-text("Kiln rota")').waitFor();
    // Moved back to the audience: muted by the server, and it holds.
    await robin.locator('.main .stage-list.big .stage-who:has-text("Priya") button:has-text("Move to audience")').click();
    await priya.locator('.main .stage-room button:has-text("Raise your hand")').waitFor();
    await priya.waitForFunction(() => window.snug.S.call?.muted === true);
    await priya.click('.main .stage-room button:has-text("Leave")');
    await robin.click('.main .stage-room button:has-text("Leave")');
  } finally { await close(robin); await close(priya); }
});

test('roles: an icon, not shown separately, ordered by keyboard; a nickname shows on messages', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await houseMenu(robin, 'House settings');
    await robin.click('.layer-nav .row:has-text("Roles")');
    await robin.click('.role-pick .row:has-text("Member")');
    await robin.fill('input[aria-label="Role icon"]', '🧪');
    await robin.locator('input[aria-label="Role icon"]').press('Tab');
    await robin.click('.switch[aria-label="Show separately in the member list"]');
    await priya.waitForFunction(() => { const r = window.snug.S.houses.kiln.roles.find((x) => x.id === 'kiln_member'); return r.icon === '🧪' && r.hoist === false; });
    // Alt+Up moves Member above Technician.
    await robin.locator('.role-pick .row:has-text("Member")').focus();
    await robin.keyboard.press('Alt+ArrowUp');
    await priya.waitForFunction(() => window.snug.S.houses.kiln.roles.map((r) => r.id).join() === 'kiln_lead,kiln_member,kiln_tech,kiln_new');
    await robin.keyboard.press('Escape');
    // The member list: Priya is under Online now, with the icon.
    await go(robin, 'The floor');
    await robin.click('.main button[aria-label^="People"]');
    const online = robin.locator('.pane[aria-label="People"] .pane-sect:has-text("Online")');
    await online.waitFor();
    await robin.locator('.pane[aria-label="People"] .person:has-text("Priya") .role-icon').waitFor();
    // Priya's name in this house.
    await go(priya, 'The floor');
    await priya.click('.main button[aria-label="Details"]');
    await priya.click('.pane button:has-text("Your name in Kiln & Co.")');
    await priya.fill('#nick', 'Pri the glazer');
    await priya.click('.modal button.btn.primary:has-text("Save")');
    await say(priya, 'Nickname check');
    await settled(priya);
    await robin.locator('.main .msg:has-text("Nickname check") .msg-name:has-text("Pri the glazer")').waitFor();
  } finally { await close(robin); await close(priya); }
});

test('the rail: drag a house onto another to make a folder, name it, close it; it is kept after a reload', async () => {
  const robin = await person('robin');
  try {
    const houses = await robin.evaluate(() => window.snug.S.houseOrder.slice(0, 2));
    await robin.locator(`.rail-dnd[data-rail-id="${houses[1]}"]`).dragTo(robin.locator(`.rail-dnd[data-rail-id="${houses[0]}"]`));
    const folder = robin.locator('.rail .rail-folder');
    await folder.waitFor();
    await folder.click({ button: 'right' });
    await robin.click('.menu-item:has-text("Rename folder")');
    await robin.fill('#folder-name', 'Weekends');
    await robin.click('.modal button.btn.primary:has-text("Save")');
    await robin.locator('.rail .rail-folder:has-text("Weekends folder")').waitFor();
    await folder.click(); // close it
    await robin.locator('.rail .folder-minis').waitFor();
    await robin.waitForFunction(() => window.snug.S.places.rail.items.some((i) => typeof i === 'object' && i.name === 'Weekends' && !i.open));
    await robin.reload();
    await robin.waitForFunction(() => window.snug.S.conn.socket === 'open');
    await robin.locator('.rail .rail-folder:has-text("Weekends folder, 2 houses, closed")').waitFor();
    // Open it, and take the houses out again from its menu.
    await robin.click('.rail .rail-folder');
    await robin.click('.rail .rail-folder', { button: 'right' });
    await robin.click('.menu-item:has-text("Take the houses out")');
    await robin.locator('.rail .rail-folder').waitFor({ state: 'detached' });
    // Alt+Down moves a house down the rail.
    const before = await robin.evaluate(() => window.snug.S.houseOrder.slice());
    await robin.locator(`.rail-dnd[data-rail-id="${before[0]}"] .rail-btn`).focus();
    await robin.keyboard.press('Alt+ArrowDown');
    await robin.waitForFunction((first) => window.snug.S.places.rail.items[1] === first, before[0]);
  } finally { await close(robin); }
});

test('a webhook from the room’s access dialog posts a message everyone sees with a Bot badge', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await go(priya, 'Firing schedule');
    await access(robin, 'Firing schedule');
    await robin.click('.modal .seg button:has-text("Webhooks")');
    await robin.fill('.modal input[aria-label="Webhook name"]', 'Kiln sensor');
    await robin.click('.modal button:has-text("New webhook")');
    const hook = (await robin.locator('.modal .hook-url code').textContent()).trim();
    assert.match(hook, /\/api\/hooks\/wh_/);
    const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Kiln 2 reached 1220 °C', username: 'Kiln 2' }) });
    assert.equal(res.status, 200);
    const m = priya.locator('.main .msg:has-text("Kiln 2 reached 1220 °C")');
    await m.locator('.bot-badge:has-text("Bot")').waitFor();
    assert.match(await m.locator('.msg-name').textContent(), /Kiln 2/);
    // A wrong token is refused and nothing arrives.
    const bad = hook.replace(/[\w-]+$/, 'x'.repeat(32));
    assert.equal((await fetch(bad, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'forged' }) })).status, 401);
    await robin.click('.modal .hook-item button:has-text("Delete")');
    await robin.locator('.modal :text("No webhooks yet.")').waitFor();
    assert.equal((await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'gone' }) })).status, 401);
    assert.equal(await priya.locator('.main .msg:has-text("forged")').count(), 0);
  } finally { await close(robin); await close(priya); }
});

test('a house from the Study template; a welcome with interests that give a role to a newcomer; insights for the owner', async () => {
  const robin = await person('robin');
  let jonas;
  try {
    // Robin writes a welcome for Kiln & Co. with an interest that gives a role.
    await houseMenu(robin, 'House settings');
    // The welcome sits on the Newcomers page, under who newcomers join as and their starter rooms.
    await robin.click('.layer-nav .row:has-text("Newcomers")');
    await robin.locator('.layer-body select[aria-label="Role for newcomers"]').waitFor();
    await robin.fill('textarea[aria-label="Welcome text"]', 'Welcome to the studio. Tell us what you make.');
    await robin.click('button:has-text("Add an interest")');
    await robin.fill('input[aria-label="Interest"]', 'Glazes');
    await robin.click('.interest-edit .chip:has-text("Member")');
    await robin.click('button:has-text("Save welcome")');
    await robin.locator('.toast:has-text("Welcome saved")').waitFor();
    // Insights: owners only.
    await robin.click('.layer-nav .row:has-text("Insights")');
    await robin.locator('.ins-tile:has-text("members")').waitFor();
    await robin.locator('.ins-bars').first().waitFor();
    await robin.locator('.ins-rooms li').first().waitFor();
    // A link for Jonas.
    await robin.click('.layer-nav .row:has-text("Invitations")');
    await robin.click('.safe-make button:has-text("Make a link")');
    const code = (await robin.locator('.safe-made input').inputValue()).split('/join/')[1];
    await robin.keyboard.press('Escape');
    jonas = await person('jonas');
    await jonas.evaluate((c) => { window.snug.S.ui.joinCode = c; window.snug.emit(); }, code);
    await jonas.locator('.modal button:has-text("Join Kiln & Co.")').click();
    await jonas.locator('.modal .onboard:has-text("Welcome to the studio")').waitFor();
    await jonas.click('.modal .onboard .chip:has-text("Glazes")');
    await jonas.click('.modal .onboard button:has-text("Save and start")');
    await jonas.waitForFunction(() => window.snug.S.houses.kiln.extra?.[window.snug.S.me]?.includes('kiln_member'));
    // Jonas starts his own house from the Study group template.
    await jonas.click('.rail-add');
    await jonas.fill('#house-name', 'Glaze theory');
    await jonas.click('.modal .chip:has-text("Study group")');
    await jonas.click('.modal button:has-text("Create house")');
    await jonas.locator('.nav .ctx-house:has-text("Glaze theory")').waitFor();
    for (const room of ['Questions', 'Office hours', 'Study room', 'Notices']) await jonas.locator(`.nav .row:has-text("${room}")`).waitFor();
    await jonas.click('.nav .row:has-text("Questions")');
    await jonas.locator('.main .forum').waitFor();
  } finally { await close(robin); if (jonas) await close(jonas); }
});

test('a post’s title and tags are edited by its author, live for everyone; the access dialog checks what one person can do', async () => {
  const robin = await person('robin');
  const priya = await person('priya');
  try {
    await newRoom(robin, 'Ideas board', 'Forum');
    await access(robin, 'Ideas board');
    await robin.click('.modal .seg button:has-text("Tags")');
    await robin.click('.modal button:has-text("Add a tag")');
    await robin.fill('.modal input[aria-label="Tag name"]', 'Kit');
    await robin.click('.modal button:has-text("Save tags")');
    await robin.waitForFunction(() => Object.values(window.snug.S.rooms).find((r) => r.name === 'Ideas board')?.tags?.length === 1);
    await robin.click('.modal button:has-text("Done")');
    // Priya posts; only she (and people who manage the room) get the edit button.
    await go(priya, 'Ideas board');
    await priya.click('.main .forum button:has-text("New post")');
    await priya.fill('#post-title', 'A bigger kiln');
    await priya.click('.modal button.btn.primary:has-text("Post")');
    await priya.locator('.pane[aria-label="Thread"] .post-title:has-text("A bigger kiln")').waitFor();
    const mine = priya.locator('.main .post-card:has-text("A bigger kiln")');
    await mine.locator('.post-edit').click();
    assert.equal(await priya.locator('.modal #post-body').count(), 0, 'the body is edited in the thread, not here');
    await priya.fill('#post-title', '');
    await priya.click('.modal button.btn.primary:has-text("Save")');
    await priya.locator('.modal .err:has-text("Give your post a title")').waitFor();
    await priya.fill('#post-title', 'A bigger kiln for the studio');
    await priya.click('.modal .chip:has-text("Kit")');
    await priya.click('.modal button.btn.primary:has-text("Save")');
    await priya.locator('.modal').waitFor({ state: 'detached' });
    await go(robin, 'Ideas board');
    const seen = robin.locator('.main .post-card:has-text("A bigger kiln for the studio")');
    await seen.locator('.tag-chip:has-text("Kit")').waitFor();
    assert.equal(await seen.locator('.post-edit').count(), 1, 'Robin manages the room, so he may edit it too');
    // Robin's own post shows no edit button to Priya.
    await robin.click('.main .forum button:has-text("New post")');
    await robin.fill('#post-title', 'Glaze swap');
    await robin.click('.modal button.btn.primary:has-text("Post")');
    const his = priya.locator('.main .post-card:has-text("Glaze swap")');
    await his.waitFor();
    assert.equal(await his.locator('.post-edit').count(), 0);
    assert.equal(await his.locator('.post-follow').count(), 1);
    // Check a person: the server's resolver answers, and follows the settings.
    await access(robin, 'Glaze lab');
    await robin.selectOption('.modal select[aria-label="Person to check"]', 'priya');
    const result = robin.locator('.modal .ovr-result[aria-label="What Priya Raman can do"]');
    await result.locator('li.yes:has-text("See the room")').waitFor();
    await robin.click('.modal .switch[aria-label="Private room"]');
    await result.locator('li.no:has-text("See the room")').waitFor();
    await result.locator('li.no:has-text("Send messages")').waitFor();
    await robin.click('.modal .switch[aria-label="Private room"]');
    await result.locator('li.yes:has-text("Send messages")').waitFor();
    await robin.click('.modal button:has-text("Done")');
  } finally { await close(robin); await close(priya); }
});
