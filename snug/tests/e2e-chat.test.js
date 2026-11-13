// Text and messages, driven in Chromium against the real server with two
// people in two browsers: the full emoji set and skin tones, role, @everyone
// and room mentions, message links and their cards, spoiler attachments with
// descriptions, the video and sound players, slash commands, the media
// viewer, quick edits, and long text sent as a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-chat-'));
let srv, browser, url;
const errors = [];
// A 64x48, four-second H.264 video (made once with ffmpeg; 1.7 KB).
const MP4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOEbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAD6AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAq50cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAAAwAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAABAAAABAAAAAAImbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAABAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB0W1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAZFzdGJsAAAAwXN0c2QAAAAAAAAAAQAAALFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAMABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAN2F2Y0MBZAAK/+EAGWdkAAqscgREewEQAAADABAAAAMAQPEiWEYBAAdo6EODksiw/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAZiAAAGYgAAABhzdHRzAAAAAAAAAAEAAAAIAAAgAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAOGN0dHMAAAAAAAAABQAAAAEAAEAAAAAAAQABAAAAAAABAABgAAAAAAIAAAAAAAAAAwAAIAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAgAAAABAAAANHN0c3oAAAAAAAAAAAAAAAgAAALVAAAADgAAAA0AAAANAAAADQAAAA0AAAANAAAADQAAABRzdGNvAAAAAAAAAAEAAAO0AAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAAAzltZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTE2IGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMzMgbWU9dW1oIHN1Ym1lPTEwIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MjQgY2hyb21hX21lPTEgdHJlbGxpcz0yIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTggYl9weXJhbWlkPTIgYl9hZGFwdD0yIGJfYmlhcz0wIGRpcmVjdD0zIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MiBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTYwIHJjPWNyZiBtYnRyZWU9MSBjcmY9NDAuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAB5liIEAAt/+py/gUkfzkQJL5ZwV4pCKM2Vtq7kBIAcAAAAKQZoI7Ygl/wCegAAAAAlBnhBnEFf/LWEAAAAJAZ4YJogl/zwgAAAACQGeGEaIJf88IQAAAAkBnhiNSCX/PCEAAAAJAZ4YrUgl/zwhAAAACQGeGM1IJf88IQ==', 'base64');

function png(w, h, rgb = [0x60, 0x80, 0xa0]) {
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true, linkPreviews: false });
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  page.on('dialog', (d) => { errors.push(`${handle}: a dialog opened: ${d.message()}`); d.dismiss(); });
  await page.goto(url);
  await signIn(page, handle);
  return page;
}
async function signIn(page, handle) {
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForSelector('.nav');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
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
const say = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };
const settled = (page) => page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().every((m) => !m.state));
const msg = (page, text) => page.locator('.main .msg', { hasText: text });
const menuOf = async (page, text) => {
  const m = msg(page, text).last();
  await m.hover();
  await m.locator('.msg-actions button[aria-label="More actions"]').click();
};
const typeIn = async (page, text) => { await box(page).click(); await box(page).pressSequentially(text); };

let robin, ines;

test('emoji: the full set, a skin tone picked once and used everywhere, frequently used, and :wave: on send', async () => {
  robin = await person('robin');
  ines = await person('ines');
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  await say(robin, 'react to this one');
  await settled(robin);
  const m = msg(ines, 'react to this one').last();
  await m.waitFor();
  await m.hover();
  await m.locator('.msg-actions button[aria-label="Add a reaction"]').click();
  const pop = ines.locator('.pop .picker');
  await pop.waitFor();
  // Nine categories plus Frequently used, as a row of tabs.
  assert.ok(await pop.locator('.picker-cats button').count() >= 9);
  assert.ok(await pop.locator('.picker-grid button').count() > 1800, 'the whole set is there');
  await pop.locator('.tone-btn').click();
  await pop.locator('.tone-row [role=radio][aria-label="Medium"]').click();
  assert.equal(await ines.evaluate(() => window.snug.S.prefs.skinTone), 3);
  await pop.locator('input').fill('wave');
  assert.equal(await pop.locator('.picker-grid button').first().textContent(), '👋🏽');
  await pop.locator('.picker-grid button').first().click();
  // Robin sees the toned reaction.
  await msg(robin, 'react to this one').last().locator('.rx:has-text("👋🏽")').waitFor();
  assert.equal(await ines.evaluate(() => window.snug.S.prefs.emojiUse['👋']), 1, 'counted for Frequently used');
  // Autocomplete uses the tone too, and :name: resolves on send.
  await typeIn(ines, 'hi :wav');
  await ines.locator('.ac [role=option]:has-text(":wave:")').first().waitFor();
  assert.match(await ines.locator('.ac [role=option]').first().textContent(), /👋🏽/);
  await box(ines).fill('');
  await say(robin, ':wave: hello and :not_an_emoji:');
  await msg(ines, 'hello and').last().waitFor();
  assert.equal((await msg(ines, 'hello and').last().locator('.msg-text .rich').textContent()).trim(), '👋 hello and :not_an_emoji:');
  // The picker opens on Frequently used next time.
  await ines.locator('.main .composer button[aria-label="Insert an emoji"]').click();
  await ines.locator('.pop .picker-sec:has-text("Frequently used")').waitFor();
  await ines.keyboard.press('Escape');
});

test('reaction picker by keyboard: the toolbar stays while it is open and Escape returns focus to Add a reaction', async () => {
  await ines.mouse.move(0, 0);
  const m = msg(ines, 'react to this one').last();
  await m.focus();
  const add = m.locator('.msg-actions button[aria-label="Add a reaction"]');
  await add.focus();
  await ines.keyboard.press('Enter');
  await ines.locator('.pop .picker').waitFor();
  assert.equal(await add.isVisible(), true, 'the button that opened the picker stays on screen');
  assert.notEqual(await ines.evaluate(() => document.activeElement === document.body), true, 'focus is not dropped while the picker is open');
  await ines.keyboard.press('Escape');
  await ines.locator('.pop .picker').waitFor({ state: 'detached' });
  assert.equal(await ines.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Add a reaction');
  assert.equal(await ines.evaluate(() => !!document.activeElement?.closest('.msg')?.textContent.includes('react to this one')), true, 'on the same message');
});

test('mentions: role pill with its colour, @everyone only for people who may, # autocomplete and a room link that opens the room', async () => {
  // Ines leads the studio: she may ping everyone, and is told how many.
  await typeIn(ines, '@ever');
  const ev = ines.locator('.ac [role=option]:has-text("@everyone")');
  await ev.waitFor();
  assert.match(await ev.textContent(), /Notifies \d+ people/);
  await box(ines).fill('');
  // Robin (a lead too in the seed) mentions the Technician role.
  await typeIn(robin, 'kiln is hot @Tech');
  await robin.locator('.ac [role=option]:has-text("@Technician")').click();
  assert.equal(await box(robin).inputValue(), 'kiln is hot @Technician ');
  await box(robin).press('Enter');
  const pill = msg(ines, 'kiln is hot').last().locator('.pill-role');
  await pill.waitFor();
  assert.equal(await pill.textContent(), '@Technician');
  assert.match(await pill.getAttribute('class'), /hued/);
  // Rooms.
  await typeIn(robin, 'details in #fir');
  await robin.locator('.ac [role=option]:has-text("Firing schedule")').click();
  await box(robin).press('Enter');
  const room = msg(ines, 'details in').last().locator('.pill-room');
  await room.waitFor();
  assert.equal((await room.textContent()).trim(), 'Firing schedule');
  assert.match(await ines.evaluate(() => Object.values(window.snug.S.msgs).flat().find((x) => x.text?.startsWith('details in')).text), /<#k_firing>/);
  await room.click();
  await ines.locator('.main .bar-title:has-text("Firing schedule")').waitFor();
  await go(ines, 'Glaze lab');
});

test('message links: copy, paste elsewhere, the other person sees a card, and /m/... opens the message', async () => {
  await say(robin, 'the cone 6 recipe is 40 feldspar');
  await settled(robin);
  await menuOf(robin, 'the cone 6 recipe');
  await robin.locator('[role=menu] [role=menuitem]:has-text("Copy message link")').click();
  const link = await robin.evaluate(() => navigator.clipboard.readText());
  assert.match(link, new RegExp(`^${url}/m/k_glaze/m_[a-z0-9]+$`));
  await go(robin, 'The floor');
  await go(ines, 'The floor');
  await say(robin, `see ${link}`);
  const card = msg(ines, 'see').last().locator('.mcard');
  await card.waitFor();
  assert.match(await card.textContent(), /Robin Hale.*the cone 6 recipe is 40 feldspar/s);
  await card.locator('.mcard-jump').click();
  await ines.locator('.main .bar-title:has-text("Glaze lab")').waitFor();
  // Opening the link itself, in a fresh tab, lands on the message.
  const tab = await ines.context().newPage();
  tab.on('pageerror', (e) => errors.push(`ines tab: ${e.message}`));
  await tab.goto(link);
  await tab.locator('.main .bar-title:has-text("Glaze lab")').waitFor();
  const id = link.split('/').pop();
  await tab.locator(`.main .msg[data-id="${id}"]`).waitFor();
  assert.equal(new URL(tab.url()).pathname, '/');
  // A link to something you can't see says so, the same way as a missing one.
  await tab.goto(`${url}/m/k_glaze/m_doesnotexist00`);
  await tab.locator('.toast:has-text("You can’t see that message.")').waitFor();
  await tab.close();
});

test('spoiler and alt text: mark a picture, the other person sees it covered, reveals it and reads the description', async () => {
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  await robin.locator('.main .composer input[type=file]').setInputFiles({ name: 'ending.png', mimeType: 'image/png', buffer: png(80, 60) });
  const tile = robin.locator('.pending-file:has-text("ending.png")');
  await tile.locator('.pending-state:not(:has-text("Uploading"))').waitFor();
  await tile.locator('button[aria-label^="Edit ending.png"]').click();
  await robin.locator('.att-edit input[type=checkbox]').check();
  await robin.locator('.att-edit textarea').fill('The last bowl, cracked in two');
  await robin.locator('.att-edit button:has-text("Save")').click();
  await robin.locator('.pending-file:has-text("Spoiler · ALT")').waitFor();
  await box(robin).fill('how it ends');
  await box(robin).press('Enter');
  const m = msg(ines, 'how it ends').last();
  const cover = m.locator('.spoiler-file');
  await cover.waitFor();
  assert.equal(await cover.getAttribute('aria-label'), 'Spoiler image. Select to show it.');
  assert.equal(await m.locator('img').count(), 0, 'nothing is fetched before it is revealed');
  await cover.focus();
  await ines.keyboard.press('Enter');
  const img = m.locator('.files img');
  await img.waitFor();
  assert.equal(await img.getAttribute('alt'), 'The last bowl, cracked in two');
  await m.locator('.alt-badge').click();
  assert.equal(await m.locator('.alt-text').textContent(), 'The last bowl, cracked in two');
  // Settings > Appearance > Spoilers: Always show uncovers files too, for
  // the person who chose it only.
  await robin.evaluate(() => { const { S, emit } = window.snug; S.prefs.spoilers = 'always'; emit(); });
  const mine = msg(robin, 'how it ends').last();
  await mine.locator('.files img').waitFor();
  assert.equal(await mine.locator('.spoiler-file').count(), 0);
  await robin.evaluate(() => { const { S, emit } = window.snug; S.prefs.spoilers = 'click'; emit(); });
  await mine.locator('.spoiler-file').waitFor();
});

test('video and sound: the other person plays and seeks an mp4; an mp3 shows its name', async () => {
  await robin.locator('.main .composer input[type=file]').setInputFiles({ name: 'wheel.mp4', mimeType: 'video/mp4', buffer: MP4 });
  await robin.locator('.pending-file:has-text("wheel.mp4") .pending-state:not(:has-text("Uploading"))').waitFor();
  await box(robin).press('Enter');
  await settled(robin);
  const v = ines.locator('.main .msg .vplayer').last();
  await v.waitFor();
  assert.equal(await v.getAttribute('aria-label'), 'Video: wheel.mp4');
  assert.match(await v.locator('a[download]').getAttribute('download'), /wheel\.mp4/);
  await v.locator('.vp-big').click();
  await ines.waitForFunction(() => { const x = [...document.querySelectorAll('.main .vplayer video')].pop(); return x && (x.currentTime > 0 || x.ended); });
  await v.locator('.vp-bar button[aria-label="Pause"]').click().catch(() => {});
  const seek = v.locator('.mp-seek');
  await seek.focus();
  await ines.keyboard.press('Home');
  await ines.keyboard.press('ArrowRight');
  await ines.waitForFunction(() => { const x = [...document.querySelectorAll('.main .vplayer video')].pop(); return x.currentTime >= 3; });
  assert.match(await seek.getAttribute('aria-valuetext'), /^0:0[34] of 0:04$/);
  // A sound file is a file with a player, not a voice message.
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 1)]);
  await robin.locator('.main .composer input[type=file]').setInputFiles({ name: 'kiln-hum.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
  await robin.locator('.pending-file:has-text("kiln-hum.mp3") .pending-state:not(:has-text("Uploading"))').waitFor();
  await box(robin).press('Enter');
  const a = ines.locator('.main .msg .afile').last();
  await a.waitFor();
  assert.equal(await a.locator('.afile-name').textContent(), 'kiln-hum.mp3');
  assert.equal(await ines.locator('.main .msg .voice').filter({ hasText: 'kiln-hum' }).count(), 0);
});

test('slash commands: argument chips, /me in italics, /roll seen by the other person, /giphy opens the picker, unknown ones don’t send', async () => {
  await typeIn(robin, '/ro');
  const opt = robin.locator('.ac [role=option]:has-text("/roll")');
  await opt.waitFor();
  assert.match(await opt.textContent(), /dice/);
  await box(robin).press('Tab');
  await robin.locator('.ac.args .arg-chip.on:has-text("dice")').waitFor();
  await box(robin).pressSequentially('2d6');
  await box(robin).press('Enter');
  const roll = ines.locator('.main .msg .roll').last();
  await roll.waitFor();
  assert.match(await roll.textContent(), /rolled 2d6: \d \+ \d = \d{1,2}/);
  await say(robin, '/me waves from the wheel');
  const em = msg(ines, 'waves from the wheel').last().locator('em');
  await em.waitFor();
  assert.equal(await em.textContent(), 'waves from the wheel');
  await say(robin, '/nope hello');
  await robin.locator('.toast:has-text("No command called /nope")').waitFor();
  assert.equal(await box(robin).inputValue(), '/nope hello', 'kept in the box');
  await box(robin).fill('/giphy happy pots');
  await box(robin).press('Enter');
  const gif = robin.locator('.pop .gif-picker input');
  await gif.waitFor();
  assert.equal(await gif.inputValue(), 'happy pots');
  await robin.keyboard.press('Escape');
});

test('media viewer: open a picture, arrow to the next, Esc gives focus back to the thumbnail, download keeps the name', async () => {
  await robin.locator('.main .composer input[type=file]').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: png(40, 30, [200, 80, 60]) },
    { name: 'second.png', mimeType: 'image/png', buffer: png(40, 30, [60, 200, 120]) },
  ]);
  await robin.locator('.pending-file:has-text("second.png") .pending-state:not(:has-text("Uploading"))').waitFor();
  await robin.locator('.pending-file:has-text("first.png") .pending-state:not(:has-text("Uploading"))').waitFor();
  await box(robin).fill('two tiles');
  await box(robin).press('Enter');
  const m = msg(ines, 'two tiles').last();
  const thumb = m.locator('button.img').first();
  await thumb.waitFor();
  await thumb.click();
  const dlg = ines.locator('.viewer[role=dialog][aria-modal=true]');
  await dlg.waitFor();
  assert.match(await dlg.locator('.vw-count').textContent(), /^1 of \d+$/);
  assert.equal(await dlg.locator('.vw-download').getAttribute('download'), 'first.png');
  assert.equal(await ines.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close');
  await ines.keyboard.press('ArrowRight');
  await dlg.locator('.vw-count:has-text("2 of")').waitFor();
  assert.equal(await dlg.locator('.vw-download').getAttribute('download'), 'second.png');
  await ines.keyboard.press('+');
  await ines.waitForFunction(() => /scale\(1\.5\)/.test(document.querySelector('.viewer img.vw-media')?.getAttribute('style') || ''));
  await ines.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  await ines.waitForFunction(() => document.activeElement?.matches('button.img'));
  assert.equal(await ines.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Open image first.png');
});

test('quick edits: Quote, s/old/new on your last message, and +:emoji: reacts to the last one', async () => {
  await say(robin, 'the glaze is teh best');
  await settled(robin);
  await say(robin, 's/teh/the');
  await msg(ines, 'the glaze is the best').last().waitFor();
  await say(ines, '+:tada:');
  await msg(robin, 'the glaze is the best').last().locator('.rx:has-text("🎉")').waitFor();
  await menuOf(ines, 'the glaze is the best');
  await ines.locator('[role=menu] [role=menuitem]:has-text("Quote")').click();
  assert.equal(await box(ines).inputValue(), '> the glaze is the best\n@robin ');
  assert.equal(await ines.evaluate(() => document.activeElement.tagName), 'TEXTAREA');
  await box(ines).pressSequentially('agreed');
  await box(ines).press('Enter');
  const q = msg(robin, 'agreed').last();
  await q.locator('blockquote.rquote').waitFor();
  assert.equal(await q.locator('blockquote.rquote').textContent(), 'the glaze is the best');
});

test('Settings > Text and messages: show message IDs adds Copy ID; the skin tone set there is the picker’s', async () => {
  await ines.click('.me-row [aria-label="Settings"]');
  await ines.click('.layer-nav .row:has-text("Text and messages")');
  await ines.locator('[role=radiogroup][aria-label="Skin tone"] [aria-label="Dark"]').click();
  await ines.locator('[role=switch][aria-label="Show message IDs"]').click();
  assert.equal(await ines.evaluate(() => [window.snug.S.prefs.skinTone, window.snug.S.prefs.showIds].join()), '5,true');
  await ines.keyboard.press('Escape');
  await ines.locator('.layer-nav').waitFor({ state: 'detached' });
  await menuOf(ines, 'agreed');
  await ines.locator('[role=menu] [role=menuitem]:has-text("Copy ID")').click();
  const id = await ines.evaluate(() => navigator.clipboard.readText());
  assert.match(id, /^m_[a-z0-9]+$/);
  assert.equal(await ines.evaluate((x) => window.snug.S.msgs.k_glaze.some((m) => m.id === x && m.text.endsWith('agreed')), id), true);
  // The setting syncs: the server holds it (checked by cleanPrefs) for her other devices.
  const uid = srv.db.get('SELECT id FROM users WHERE handle = ?', 'ines').id;
  let p = {};
  for (let i = 0; i < 40; i++) {
    p = JSON.parse(srv.db.get('SELECT prefs FROM user_prefs WHERE user = ?', uid)?.prefs || '{}');
    if (p.skinTone === 5 && p.showIds === true) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual([p.skinTone, p.showIds, p.emojiUse?.['👋']], [5, true, 1]);
});

test('long text: a counter from 3,500, Send turned off past 4,000, and 5,000 pasted characters go as a file the other person can expand', async () => {
  await box(robin).fill('x'.repeat(3600));
  await robin.locator('.len-note:not(.over)').waitFor();
  await box(robin).fill('y'.repeat(4100));
  await robin.locator('.len-note.over').waitFor();
  assert.equal(await robin.locator('.main .composer .send').isDisabled(), true);
  await box(robin).fill('');
  const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'z'.repeat(42)}`).join('\n');
  assert.ok(long.length >= 4900);
  await box(robin).focus();
  await robin.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.querySelector('.main .composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, long);
  await robin.locator('.long-paste button:has-text("Send as a file")').click();
  await robin.locator('.pending-file:has-text("message.txt") .pending-state:not(:has-text("Uploading"))').waitFor();
  await box(robin).press('Enter');
  const t = ines.locator('.main .msg .tfile').last();
  await t.waitFor();
  await t.locator('.codeblock').waitFor();
  assert.equal((await t.locator('.codeblock code').textContent()).split('\n').length, 10);
  await t.locator('.tfile-more').click();
  assert.equal((await t.locator('.codeblock code').textContent()).split('\n').length, 100);
});
