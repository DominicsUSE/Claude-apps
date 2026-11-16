// Two PCs, end to end (design section 12.4): a local registry and mock GitHub,
// one Snug server per person, and one Chromium context per person. The pages
// are the link hosts, so messages take the direct WebRTC path. No real GitHub.
// v0.12: an account made with no GitHub at all, its recovery key, and moving it
// to a second PC with that key, then to a third with a pairing code.
//
// The tests run in order and share the people they set up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startRegistry, startPc, signUp, OWNER_GH, Client, mid } from './helpers/p2p.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SNUG_SHOTS || ''; // a folder: screenshots of each screen, for review
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : null);

let registry, browser;
const pcs = {};      // name -> server
const pages = {};    // name -> page
const sdps = [];     // every description a link host handed its server
const errors = [];
const contexts = [];

async function pc(name, extra = {}) {
  const srv = await startPc(registry, extra);
  pcs[name] = srv;
  // Watch what the link host sends: no raw private addresses may leave the PC (S14).
  const base = srv.hub.ops['peer.sdp'];
  srv.hub.ops['peer.sdp'] = (c, d) => { if (typeof d?.sdp === 'string') sdps.push(d.sdp); return base(c, d); };
  return srv;
}

async function open(name, srv, { viewport = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'] });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  await page.goto(srv.base);
  pages[name] = page;
  return page;
}

// Continue with GitHub: the code screen, then (mock) GitHub approves it. Since v0.12 GitHub is under
// "I already have an account" > "I used GitHub before".
async function github(page, ghId) {
  await page.click('#auth-have');
  await page.click('#auth-github-path');
  await page.click('#auth-github');
  const code = (await page.locator('#auth-device-code').textContent()).trim();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  registry.github.authorize(code, { id: ghId });
  return code;
}
async function typeName(page, name) {
  await page.fill('#auth-username', name);
}
const inApp = (page) => page.waitForFunction(() => window.snug.S.auth === 'in' && window.snug.S.conn.socket === 'open' && !!window.snug.S.p2p?.owner);

test.before(async () => {
  registry = await startRegistry();
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
test.after(async () => {
  await browser?.close();
  for (const s of Object.values(pcs)) await s.close().catch(() => {});
  await registry?.close();
});
test.afterEach(() => {
  const seen = errors.splice(0);
  assert.deepEqual(seen, [], 'page errors');
});

test('unique names: the owner takes "a"; others get clear errors; Bob is saved as bob', async () => {
  await pc('A');
  await pc('B');
  const alice = await open('alice', pcs.A);
  await alice.waitForSelector('#auth-create');
  await alice.waitForSelector('#auth-have');
  await shot(alice, '01-sign-in');
  await github(alice, OWNER_GH);
  // The code screen says not to share the code.
  await alice.locator('text=Only type this code on github.com yourself. Snug will never ask you to send it to anyone.').waitFor();
  assert.ok((await alice.getAttribute('#auth-open-github', 'href')).startsWith(`${registry.github.url}/login/device`));
  await shot(alice, '02-device-code');
  await alice.waitForSelector('#auth-username');
  await typeName(alice, 'a');
  await alice.locator('#auth-username-ok:has-text("@a is available.")').waitFor();
  await shot(alice, '03-pick-username-owner');
  await alice.click('.auth-form button[type=submit]');
  await inApp(alice);
  assert.equal(await alice.evaluate(() => window.snug.S.p2p.username), 'a');

  const bob = await open('bob', pcs.B);
  await github(bob, 1001);
  await bob.waitForSelector('#auth-username');
  for (const n of ['a']) {
    await typeName(bob, n);
    await bob.locator('#auth-username-err:has-text("That name is reserved")').waitFor();
  }
  await typeName(bob, 'bob_');
  await bob.locator('#auth-username-err:has-text("can’t start or end with a dot or an underscore")').waitFor();
  await shot(bob, '04-pick-username-error');
  await typeName(bob, 'Bob');
  await bob.locator('#auth-username-ok:has-text("@bob is available.")').waitFor();
  await bob.click('.auth-form button[type=submit]');
  await inApp(bob);
  assert.equal(await bob.evaluate(() => window.snug.S.users[window.snug.S.me].handle), 'bob');

  // Carol, through the API on a third PC: taken by name and by look-alike, and a bad shape.
  const C = await pc('C');
  const start = await (await fetch(`${C.base}/api/gh/start`, { method: 'POST', headers: { origin: C.base, 'content-type': 'application/json' }, body: '{}' })).json();
  registry.github.authorize(start.userCode, { id: 1002 });
  let w;
  do w = await (await fetch(`${C.base}/api/gh/wait`, { method: 'POST', headers: { origin: C.base, 'content-type': 'application/json' }, body: JSON.stringify({ flow: start.flow }) })).json(); while (w.state === 'pending');
  assert.equal(w.state, 'choose-name');
  const check = async (n) => (await fetch(`${C.base}/api/gh/check?name=${encodeURIComponent(n)}&flow=${start.flow}`)).json();
  assert.equal((await check('bob')).error, 'taken');
  assert.equal((await check('b.o.b')).error, 'taken');
  assert.equal((await check('bob_')).error, 'invalid_name');
  // Names are case-insensitive: "BOB" is Bob's. Claiming it is refused by the registry,
  // and "a" is refused for anyone but the owner. Then Carol takes her own name.
  assert.equal((await check('BOB')).error, 'taken');
  const claim = (username) => fetch(`${C.base}/api/gh/claim`, { method: 'POST', headers: { origin: C.base, 'content-type': 'application/json' }, body: JSON.stringify({ flow: start.flow, username }) });
  let r = await claim('BOB');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'taken');
  r = await claim('a');
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'owner_only');
  r = await claim('Carol');
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(C.peer.identity.self().username, 'carol');
  // The registry itself (not just this PC's checks) keeps "a" for the owner's GitHub id ("1" is open to anyone).
  const X = await pc('X');
  const auth = await X.peer.reg.authGithub(registry.github.issueToken({ id: 1003 }));
  for (const n of ['a', 'CAROL']) {
    const e = await X.peer.reg.claim(auth.ticket, n).then(() => null, (err) => err);
    assert.ok(e, `${n} should be refused`);
    assert.equal(e.code, n === 'CAROL' ? 'taken' : 'owner_only', `${n}: ${e.code}`);
  }
  await X.close();
  delete pcs.X;
  // GitHub was asked for no scopes, ever.
  assert.ok(registry.github.calls.filter((c) => c.path === '/login/device/code').every((c) => c.scope === ''));
  // No GitHub identity anywhere on the page.
  // (the mock GitHub calls everyone "hidden"; tokens start gho_)
  for (const p of [alice, bob]) {
    assert.doesNotMatch(await p.evaluate(() => JSON.stringify(window.snug.S)), /"hidden"|gh[ou]_|"login"/);
    assert.doesNotMatch(await p.evaluate(() => document.body.innerText), /\bhidden\b|GitHub account:/);
  }
});

test('friend by username, then messages both ways over the direct path', async () => {
  const { alice, bob } = pages;
  await alice.evaluate(() => window.snug.S.ui.view = { type: 'friends', tab: 'add' });
  await alice.evaluate(() => window.snug.emit());
  await alice.waitForSelector('#f-add-handle');
  assert.equal(await alice.getAttribute('#f-add-handle', 'placeholder'), 'their Snug username');
  await alice.fill('#f-add-handle', 'bob');
  await shot(alice, '05-add-friend');
  await alice.click('.f-add-form button[type=submit]');
  await alice.locator('.ok-line:has-text("Request sent")').waitFor();

  await bob.evaluate(() => { window.snug.S.ui.view = { type: 'friends', tab: 'requests' }; window.snug.emit(); });
  const row = bob.locator('.f-row:has-text("@a")');
  await row.waitFor();
  await row.locator('button:has-text("Accept")').click();
  await bob.evaluate(() => { window.snug.S.ui.view = { type: 'friends', tab: 'all' }; window.snug.emit(); });
  await bob.locator('.f-row:has-text("@a")').waitFor();
  await alice.evaluate(() => { window.snug.S.ui.view = { type: 'friends', tab: 'all' }; window.snug.emit(); });
  await alice.locator('.f-row:has-text("@bob")').waitFor();
  // Presence: Bob is online for Alice.
  await alice.waitForFunction(() => Object.values(window.snug.S.users).some((u) => u.remote && u.username === 'bob' && u.presence !== 'offline'));
  await shot(alice, '06-friends-remote');

  // Alice opens the conversation and writes.
  await alice.locator('.f-row:has-text("@bob") button[aria-label^="Message"]').click();
  await alice.locator('.p2p-direct:has-text("Direct between your PCs")').waitFor();
  await alice.fill('.main .composer textarea', 'hello from the other PC');
  await alice.keyboard.press('Enter');
  await bob.waitForFunction(() => Object.values(window.snug.S.msgs).flat().some((m) => m.text === 'hello from the other PC'));
  const dm = await bob.evaluate(() => Object.entries(window.snug.S.msgs).find(([, l]) => l.some((m) => m.text === 'hello from the other PC'))[0]);
  await bob.evaluate((id) => { window.snug.S.ui.view = { type: 'conv', id }; window.snug.emit(); }, dm);
  await bob.locator('.msg-body:has-text("hello from the other PC")').waitFor();
  await bob.fill('.main .composer textarea', 'and back again');
  await bob.keyboard.press('Enter');
  await alice.locator('.msg-body:has-text("and back again")').waitFor();
  // Delivered: Alice's "sending" line goes once Bob's PC acknowledges it.
  await alice.locator('.msg-body:has-text("hello from the other PC") [data-peer-state]').waitFor({ state: 'detached' });
  await shot(alice, '07-dm-direct');
  // The direct path carried it, and no description held a raw private address.
  await alice.waitForFunction(() => true);
  const deadline = Date.now() + 15000;
  while (pcs.A.peer.stats().direct < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.ok(pcs.A.peer.stats().direct >= 1, JSON.stringify(pcs.A.peer.stats()));
  assert.ok(sdps.length > 0);
  for (const s of sdps) {
    for (const line of s.split('\r\n').filter((l) => / typ host/.test(l))) {
      const addr = line.split(' ')[4];
      assert.ok(addr.endsWith('.local') || !/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|fe80:|fd|fc)/i.test(addr), line);
    }
  }
});

function png(w, h, rgb) {
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
// A socket client signed in as the person on a page (same session cookie).
async function clientOf(page, srv) {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'snug_session');
  const me = await page.evaluate(() => window.snug.S.me);
  const c = new Client(srv, `snug_session=${cookie.value}`, me);
  await c.connect();
  return c;
}
const until = async (fn, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};
const goto = (page, view) => page.evaluate((v) => { window.snug.S.ui.view = v; window.snug.emit(); }, view);
const rowsOf = (srv, id) => srv.db.all('SELECT * FROM messages WHERE id = ?', id);
const reactsOf = (srv, id) => srv.db.all('SELECT user, emoji FROM reactions WHERE msg = ? ORDER BY emoji', id).map((r) => `${r.user}:${r.emoji}`);

test('edits, deletes and reactions reach the other PC, both ways', async () => {
  const { alice, bob } = pages;
  const dm = await alice.evaluate(() => window.snug.S.ui.view.id);
  await goto(bob, { type: 'conv', id: dm });
  const a = await clientOf(alice, pcs.A);
  const b = await clientOf(bob, pcs.B);
  const aliceId = a.id, bobId = b.id;
  // Alice writes with a typo, then fixes it.
  const id1 = mid();
  await a.ok('msg.send', { conv: dm, id: id1, text: 'see you at the kiln at sxi' });
  await bob.locator('.msg-body:has-text("see you at the kiln at sxi")').waitFor();
  await a.ok('msg.edit', { conv: dm, id: id1, text: 'see you at the kiln at six' });
  await bob.locator('.msg-body:has-text("see you at the kiln at six")').waitFor();
  await until(() => rowsOf(pcs.B, id1)[0]?.edited, 10000, 'the edit lands on Bob’s disk');
  assert.equal(rowsOf(pcs.B, id1).length, 1);
  assert.equal(rowsOf(pcs.B, id1)[0].author, aliceId);
  // Bob reacts; Alice's PC has it. Alice reacts, then takes it back.
  await b.ok('react', { conv: dm, id: id1, emoji: '👍', on: true });
  await until(() => reactsOf(pcs.A, id1).join() === `${bobId}:👍`, 10000, 'Bob’s reaction on Alice’s PC');
  await alice.waitForFunction(({ dm, id }) => window.snug.S.msgs[dm]?.find((m) => m.id === id)?.reactions?.['👍'], { dm, id: id1 });
  await a.ok('react', { conv: dm, id: id1, emoji: '🎉', on: true });
  await until(() => reactsOf(pcs.B, id1).length === 2, 10000, 'Alice’s reaction on Bob’s PC');
  assert.deepEqual(reactsOf(pcs.B, id1).sort(), [`${aliceId}:🎉`, `${bobId}:👍`].sort());
  await a.ok('react', { conv: dm, id: id1, emoji: '🎉', on: false });
  await until(() => reactsOf(pcs.B, id1).join() === `${bobId}:👍`, 10000, 'Alice’s reaction gone on Bob’s PC');
  // Bob writes something and deletes it; Alice's copy goes too.
  const id2 = mid();
  await b.ok('msg.send', { conv: dm, id: id2, text: 'wrong window, ignore' });
  await alice.locator('.msg-body:has-text("wrong window, ignore")').waitFor();
  await b.ok('msg.delete', { conv: dm, id: id2 });
  await alice.locator('.msg-body:has-text("wrong window, ignore")').waitFor({ state: 'detached' });
  await until(() => rowsOf(pcs.A, id2)[0]?.deleted, 10000, 'the delete lands on Alice’s disk');
  // Alice deletes hers; it leaves Bob's screen.
  await a.ok('msg.delete', { conv: dm, id: id1 });
  await bob.locator('.msg-body:has-text("see you at the kiln at six")').waitFor({ state: 'detached' });
  assert.ok(rowsOf(pcs.B, id1)[0].deleted);
  // Bob's message is stored on Alice's PC as written by Bob's local stand-in.
  assert.equal(rowsOf(pcs.A, id2)[0].author, bobId);
  await a.close();
  await b.close();
});

// 0.13: polls between PCs.
test('a poll made from the + menu reaches Bob’s PC; both votes show the same counts on both screens; ending it ends it there', async () => {
  const { alice, bob } = pages;
  const dm = await alice.evaluate(() => window.snug.S.ui.view.id);
  await goto(bob, { type: 'conv', id: dm });
  await alice.click('.main .composer .plus-btn');
  await alice.click('.menu-item:has-text("Create a poll")');
  await alice.fill('#poll-q', 'Which kiln shelf?');
  await alice.fill('.modal input[aria-label="Answer 1"]', 'Top shelf');
  await alice.fill('.modal input[aria-label="Answer 2"]', 'Bottom shelf');
  await alice.click('.modal button:has-text("Post poll")');
  await alice.locator('.modal').waitFor({ state: 'detached' });
  const bpoll = bob.locator('.main .poll:has-text("Which kiln shelf?")');
  await bpoll.waitFor({ timeout: 20000 });
  assert.equal(await bpoll.locator('.poll-a').count(), 2);
  await bpoll.locator('.poll-a:has-text("Bottom shelf")').click();
  await bpoll.locator('.poll-a.done.mine:has-text("Bottom shelf") .poll-n:has-text("100%")').waitFor();
  const apoll = alice.locator('.main .poll:has-text("Which kiln shelf?")');
  await apoll.locator('.poll-a:has-text("Top shelf")').click();
  // Both votes on both screens: 50% each.
  for (const p of [apoll, bpoll]) {
    await p.locator('.poll-a:has-text("Top shelf") .poll-n:has-text("50%")').waitFor({ timeout: 20000 });
    await p.locator('.poll-a:has-text("Bottom shelf") .poll-n:has-text("50%")').waitFor({ timeout: 20000 });
  }
  await apoll.locator('button:has-text("End now")').click();
  await bpoll.locator('.poll-how:has-text("Final results")').waitFor({ timeout: 20000 });
});

// 0.13: forwarding a whole message (its picture too) into a conversation with a friend on another PC.
test('forwarding a message with a picture to Bob: he sees the forwarded card with the picture', async () => {
  const { alice, bob } = pages;
  const dm = await alice.evaluate(() => window.snug.S.ui.view.id);
  await goto(bob, { type: 'conv', id: dm });
  const a = await clientOf(alice, pcs.A);
  const up = await (await fetch(`${pcs.A.base}/api/files?conv=${dm}`, { method: 'POST', headers: { cookie: a.cookie, origin: pcs.A.base, 'content-type': 'image/png', 'x-file-name': 'glaze.png' }, body: png(48, 32, [20, 160, 90]) })).json();
  await a.ok('msg.send', { conv: dm, id: mid(), text: 'test tile from the kiln', files: [{ id: up.id, w: 48, h: 32 }] });
  await a.close();
  const m = alice.locator('.main .msg:has-text("test tile from the kiln")').last();
  await m.waitFor();
  await m.hover();
  await m.locator('.msg-actions button[aria-label="More actions"]').click();
  await alice.click('.menu-item:has-text("Forward")');
  await alice.click('.modal .fwd-dest:has-text("bob")');
  await alice.fill('.modal textarea', 'look at the colour');
  await alice.click('.modal button:has-text("Forward")');
  await alice.locator('.modal').waitFor({ state: 'detached' });
  const card = bob.locator('.main .msg:has-text("look at the colour") .fwd-card');
  await card.waitFor({ timeout: 20000 });
  assert.match(await card.textContent(), /test tile from the kiln/);
  // The picture comes over from Alice's PC and shows inside the card.
  await bob.waitForFunction(() => [...document.querySelectorAll('.main .fwd-card img')].some((i) => i.complete && i.naturalWidth === 48), null, { timeout: 20000 });
  // Bob's PC holds Alice's message with those words, so the card is hers and carries no warning.
  assert.equal(await bob.locator('.main .msg:has-text("look at the colour") .fwd-unchecked').count(), 0);
  // A card whose words Bob's PC can't find (a modified PC could send one) shows only the name it was given, and says so.
  const bobUid = pcs.B.peer.identity.self().uid;
  const id = mid();
  pcs.A.peer._outbox.push(`u_${bobUid}`, 'dm.msg', id, JSON.stringify({ id, text: '> I never said this\n— bob, forwarded', note: '', fwd: { a: bobUid, name: 'bob', ts: Date.now(), text: 'I never said this' } }), Date.now());
  pcs.A.peer._links.want(bobUid);
  const forged = bob.locator('.main .msg:has-text("I never said this")');
  await forged.locator('.fwd-unchecked:has-text("can’t check who wrote it")').waitFor({ timeout: 20000 });
});

test('profile: a new name and picture reach Bob once, and the picture is served from his PC', async () => {
  const { alice, bob } = pages;
  const before = pcs.B.peer.stats().profileApplied;
  // The name, from Settings > Profile.
  await alice.click('.nav button[aria-label="Settings"]');
  await alice.locator('.set-field[aria-label="Name"]').waitFor();
  await alice.fill('.set-field[aria-label="Name"]', 'Alice A');
  await alice.locator('.set-field[aria-label="Name"]').press('Tab');
  await bob.locator('.f-row:has-text("Alice A"), .msg-body:has-text("Alice A"), .bar-title:has-text("Alice A")').first().waitFor();
  await until(() => pcs.B.peer.stats().profileApplied === before + 1, 10000, 'one profile apply');
  // The picture: uploaded on Alice's PC, fetched by Bob's when the profile names it.
  const a = await clientOf(alice, pcs.A);
  const up = await fetch(`${pcs.A.base}/api/files?avatar`, { method: 'POST', headers: { cookie: a.cookie, origin: pcs.A.base, 'content-type': 'image/png', 'x-file-name': 'me.png' }, body: png(64, 64, [139, 92, 246]) });
  assert.equal(up.status, 201);
  await a.ok('me.update', { avatar: (await up.json()).id });
  await a.close();
  const img = await bob.waitForFunction(() => Object.values(window.snug.S.users).find((u) => u.remote && u.name === 'Alice A' && u.img)?.img);
  const src = await img.jsonValue();
  // Served by Bob's own server, even with Alice's server gone (checked in the outbox test below too).
  assert.equal(await bob.evaluate(async (u) => (await fetch(u)).status, src), 200);
  // Exactly once each: one apply for the name, one for the picture, one picture fetch. Nothing more
  // arrives while nothing changes (no timer pushes).
  const fetched = pcs.B.peer.stats().blobsFetched;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(pcs.B.peer.stats().profileApplied, before + 2);
  assert.equal(pcs.B.peer.stats().blobsFetched, fetched);
  assert.ok(fetched >= 1);
  // On Bob's disk: the name, and the picture's bytes.
  const shadow = pcs.B.db.get("SELECT * FROM users WHERE remote = 1 AND name = 'Alice A'");
  assert.ok(shadow?.avatar, 'the shadow row has the picture');
  const file = pcs.B.db.get('SELECT * FROM files WHERE id = ?', shadow.avatar);
  assert.ok(file, 'a local files row for the picture');
  // Settings > Account: the Snug username, security code and key protection.
  await alice.click('.layer-nav button.row:has-text("Account and security")');
  await alice.locator('#p2p-username:has-text("@a")').waitFor();
  await alice.locator('text=Signed in with GitHub').waitFor();
  await alice.locator('#p2p-fingerprint').waitFor();
  await shot(alice, '08-settings-account');
  await alice.keyboard.press('Escape');
});

test('offline outbox: Bob\'s PC is off, Alice sees "Waiting", it arrives when Bob is back', async () => {
  const { alice } = pages;
  const dataDir = pcs.B.dataDir;
  const avatar = await pages.bob.evaluate(() => Object.values(window.snug.S.users).find((u) => u.remote && u.img)?.img);
  // Bob's page goes with his PC.
  await pages.bob.context().close();
  await pcs.B.close();
  await alice.waitForFunction(() => Object.values(window.snug.S.users).some((u) => u.remote && u.username === 'bob' && u.presence === 'offline'));
  const dm = await alice.evaluate(() => Object.keys(window.snug.S.dms).find((id) => window.snug.S.dms[id].members.some((m) => window.snug.S.users[m]?.username === 'bob')));
  await goto(alice, { type: 'conv', id: dm });
  await alice.fill('.main .composer textarea', 'are you there?');
  await alice.keyboard.press('Enter');
  await alice.locator('.msg-body:has-text("are you there?") [data-peer-state="waiting"]:has-text("Waiting for bob to come online")').waitFor();
  await shot(alice, '09-waiting');
  // Bob's PC starts again with the same data folder (a new port, the same Snug).
  await pc('B', { dataDir });
  const bob = await open('bob', pcs.B);
  // The session cookie is gone with the old context: Bob signs in with GitHub again and goes straight in.
  await github(bob, 1001);
  await inApp(bob);
  await bob.waitForFunction(() => Object.values(window.snug.S.msgs).flat().some((m) => m.text === 'are you there?'), null, { timeout: 30000 });
  await alice.locator('.msg-body:has-text("are you there?") [data-peer-state]').waitFor({ state: 'detached', timeout: 30000 });
  // It arrived once, on the page and on disk, and stays once.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(pcs.B.db.get("SELECT COUNT(*) n FROM messages WHERE text = 'are you there?'").n, 1);
  assert.equal(await bob.evaluate(() => Object.values(window.snug.S.msgs).flat().filter((m) => m.text === 'are you there?').length), 1);
  assert.equal(pcs.A.db.get("SELECT COUNT(*) n FROM peer_outbox").n, 0, 'Alice’s outbox is empty');
  // Alice’s picture comes from Bob’s own server (his copy on disk), and her name too:
  // Bob’s restarted PC applied no profile and fetched no picture.
  assert.equal(await bob.evaluate(async (u) => (await fetch(u)).status, avatar), 200);
  await bob.waitForFunction(() => Object.values(window.snug.S.users).some((u) => u.remote && u.name === 'Alice A' && u.img));
  assert.equal(pcs.B.peer.stats().profileApplied, 0);
  assert.equal(pcs.B.peer.stats().blobsFetched, 0);
});

test('a DM call connects with fake media', async () => {
  const { alice, bob } = pages;
  const dm = await alice.evaluate(() => window.snug.S.ui.view.id);
  await goto(bob, { type: 'conv', id: dm });
  await alice.locator('.main .bar .call-btn[aria-label="Start a voice call"]').click();
  const card = bob.locator('.incoming[role="alertdialog"]');
  await card.waitFor({ timeout: 20000 });
  await card.locator('.inc-accept').click();
  for (const p of [alice, bob]) {
    await p.waitForFunction(async () => {
      const peers = Object.values(await window.snug.voiceStats());
      return peers.length === 1 && peers.every((x) => x.state === 'connected' && x.bytes > 1000);
    }, null, { timeout: 30000, polling: 300 });
  }
  await shot(alice, '10-call');
  await alice.click('.stage.call [aria-label="Leave call"]');
  await bob.waitForFunction(() => !window.snug.S.call, null, { timeout: 15000 });
});

test('move notice: someone signs in as Alice on a third PC; "Stop it" stops the move', async () => {
  const { alice } = pages;
  const C2 = await pc('C2');
  const post = (path, body) => fetch(`${C2.base}${path}`, { method: 'POST', headers: { origin: C2.base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const s = await post('/api/gh/start', {});
  registry.github.authorize(s.userCode, { id: OWNER_GH });
  let w;
  do w = await post('/api/gh/wait', { flow: s.flow }); while (w.state === 'pending');
  assert.equal(w.state, 'rebind');
  assert.equal(w.username, 'a');
  const mv = await post('/api/gh/rebind', { flow: s.flow });
  assert.equal(mv.state, 'moving');
  await alice.locator('#p2p-move-notice:has-text("Someone signed in to your Snug account on another PC")').waitFor();
  await shot(alice, '11-move-notice');
  await alice.click('#p2p-move-stop');
  await alice.locator('#p2p-move-notice').waitFor({ state: 'detached' });
  await until(() => C2.peer.identity.self()?.state === 'needs-signin', 10000, 'the third PC hears it stopped');
});

test('key change: Bob loses his PC, moves after 72 h, re-adds Alice; Alice sees the security-code banner', async () => {
  const { alice } = pages;
  pcs.B.vault.close(); // v0.10: a lost PC can't send its data file (otherwise the old PC hands Alice over and re-add says "already friends")
  const B2 = await pc('B2');
  const bob2 = await open('bob2', B2);
  await github(bob2, 1001);
  await bob2.locator('#auth-move').waitFor();
  await bob2.locator('text=@bob is on another PC').waitFor();
  await shot(bob2, '12-rebind');
  await bob2.click('#auth-move');
  await bob2.waitForFunction(() => window.snug.S.auth === 'in' && window.snug.S.conn.socket === 'open');
  await bob2.locator('#p2p-state-notice[data-state="moving"]').waitFor();
  await shot(bob2, '13-moving');
  await registry.clock.advance(72 * 3600_000 + 1000);
  await bob2.waitForFunction(() => window.snug.S.p2p?.state === 'ok', null, { timeout: 20000 });
  await bob2.locator('#p2p-state-notice').waitFor({ state: 'detached' });
  // The old PC hears it moved.
  await until(() => pcs.B.peer.identity.self()?.state === 'revoked', 10000, 'old PC revoked');
  // Bob re-adds Alice by her username; her PC accepts on its own (they were friends).
  await goto(bob2, { type: 'friends', tab: 'add' });
  await bob2.fill('#f-add-handle', 'a');
  await bob2.click('.f-add-form button[type=submit]');
  await bob2.locator('.f-add-msg .ok-line').waitFor();
  await bob2.waitForFunction(() => Object.values(window.snug.S.friends).some((f) => f.state === 'friends'), null, { timeout: 20000 });
  // Alice: the loud banner in the conversation, and OK dismisses it.
  await alice.locator('#p2p-key-banner:has-text("security code changed")').waitFor({ timeout: 20000 });
  await alice.click('#p2p-key-banner button:has-text("Compare codes")');
  await alice.locator('.p2p-key-codes').waitFor();
  await shot(alice, '14-key-banner');
  await alice.click('#p2p-key-ok');
  await alice.locator('#p2p-key-banner').waitFor({ state: 'detached' });
});

// ---------- v0.12: no GitHub ----------
let kayCode = null; // Kay's recovery key, as she saved it

test('no GitHub: Kay creates an account, saves her recovery key, adds Alice and they message', async () => {
  const { alice } = pages;
  await pc('K');
  const kay = await open('kay', pcs.K);
  await kay.click('#auth-create');
  await kay.waitForSelector('#auth-username');
  await typeName(kay, 'kay');
  await kay.locator('#auth-username-err:has-text("2 or 3 characters")').waitFor();
  await typeName(kay, 'Kaylee');
  await kay.locator('#auth-username-ok:has-text("@kaylee is available.")').waitFor();
  await shot(kay, '20-key-pick-username');
  await kay.click('.auth-form button[type=submit]');
  // "Save your recovery key": 9 groups of 4, a file, print and copy, then the last group typed back.
  await kay.locator('#rk-key').waitFor({ timeout: 30000 });
  await shot(kay, '21-key-save-recovery');
  const groupsShown = await kay.locator('#rk-key > span').allTextContents();
  assert.equal(groupsShown.length, 9);
  kayCode = groupsShown.join('-');
  assert.match(kayCode, /^([A-Z2-7]{4}-){8}[A-Z2-7]{4}$/);
  const [download] = await Promise.all([kay.waitForEvent('download'), kay.click('#rk-download')]);
  assert.equal(download.suggestedFilename(), 'Snug recovery key - @kaylee.txt');
  const saved = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
  assert.ok(saved.includes(kayCode) && saved.includes('@kaylee') && saved.includes('can’t reset this key'), saved);
  assert.ok(await kay.locator('#rk-print').isVisible());
  assert.ok(await kay.locator('#rk-copy').isVisible());
  await kay.fill('#rk-last', 'ZZZZ');
  await kay.click('#rk-saved');
  await kay.locator('#rk-last-err:has-text("isn’t the end of your recovery key")').waitFor();
  await kay.fill('#rk-last', kayCode.slice(-4).toLowerCase());
  await kay.click('#rk-saved');
  await inApp(kay);
  assert.equal(await kay.evaluate(() => window.snug.S.p2p.kind), 'key');
  assert.equal(await kay.evaluate(() => window.snug.S.p2p.recovery?.saved), true);
  // Settings > Account says how this account signs in, and offers GitHub only as an option.
  await kay.click('.nav button[aria-label="Settings"]');
  await kay.click('.layer-nav button.row:has-text("Account and security")');
  await kay.locator('#p2p-key-saved:has-text("Recovery key saved")').waitFor();
  await kay.locator('#p2p-gh-link').waitFor();
  await kay.locator('#p2p-move-new').waitFor();
  assert.equal(await kay.locator('text=Signed in with GitHub').count(), 0);
  await shot(kay, '22-key-settings');
  await kay.evaluate(() => { window.snug.S.ui.layer = null; window.snug.emit(); });

  // Alice adds her by username; Kay accepts; messages go both ways.
  await goto(alice, { type: 'friends', tab: 'add' });
  await alice.fill('#f-add-handle', 'kaylee');
  await alice.click('.f-add-form button[type=submit]');
  await alice.locator('.f-add-msg .ok-line').waitFor();
  await goto(kay, { type: 'friends', tab: 'requests' });
  await kay.locator('.f-row:has-text("@a") button:has-text("Accept")').click();
  await goto(kay, { type: 'friends', tab: 'all' });
  await kay.locator('.f-row:has-text("@a")').waitFor();
  await kay.locator('.f-row:has-text("@a")').hover();
  await kay.locator('.f-row:has-text("@a") button[aria-label^="Message"]').click({ force: true }); // a hover action
  await kay.locator('.p2p-direct:has-text("Direct between your PCs")').waitFor();
  await kay.fill('.main .composer textarea', 'hi Alice, no GitHub here');
  await kay.keyboard.press('Enter');
  await alice.waitForFunction(() => Object.values(window.snug.S.msgs).flat().some((m) => m.text === 'hi Alice, no GitHub here'), null, { timeout: 20000 });
  const dm = await alice.evaluate(() => Object.entries(window.snug.S.msgs).find(([, l]) => l.some((m) => m.text === 'hi Alice, no GitHub here'))[0]);
  await goto(alice, { type: 'conv', id: dm });
  await alice.fill('.main .composer textarea', 'welcome, Kay');
  await alice.keyboard.press('Enter');
  await kay.locator('.msg-body:has-text("welcome, Kay")').waitFor({ timeout: 20000 });
  await shot(kay, '23-key-dm');
});

test('no GitHub: Kay loses her PC and moves to a second one with her recovery key', async () => {
  const { alice } = pages;
  const kay = pages.kay;
  pcs.K.vault.close(); // a lost PC sends no data file
  // v0.12 review, second pass: whoever has the lost PC asks for a recovery key of their own (it waits 7 days)
  const { recoverySigner } = await import('../server/keyauth.js');
  const { newRecoveryKey } = await import('../js/lib/recovery.js');
  const thiefRk = await recoverySigner((await newRecoveryKey()).raw);
  const set = await pcs.K.peer.reg.signedCall('/v1/recovery/set', 'recovery-set', (t, u) => ({ rk: thiefRk.pub, rsigNew: thiefRk.sign(`snug-reg-v1\nrecovery-set\n${u}\n${thiefRk.pub}\n${t}`) }));
  assert.equal(set.state, 'pending');
  await pc('K2');
  const kay2 = await open('kay2', pcs.K2);
  await kay2.click('#auth-have');
  await kay2.locator('#auth-lost-pc').waitFor();
  await shot(kay2, '24-key-have-account');
  await kay2.click('#auth-lost-pc');
  // A typo is caught before anything is sent.
  const typo = kayCode.slice(0, -1) + (kayCode.endsWith('A') ? 'B' : 'A');
  await kay2.fill('#auth-recovery', typo);
  await kay2.click('#auth-recover-go');
  await kay2.locator('#auth-recovery-err:has-text("groups looks wrong")').waitFor();
  await kay2.fill('#auth-recovery', kayCode.toLowerCase().replace(/-/g, ' '));
  await kay2.click('#auth-recover-go');
  await kay2.locator('#auth-moving-at').waitFor();
  await shot(kay2, '25-key-moving');
  await kay2.click('#auth-moving-continue');
  await kay2.waitForFunction(() => window.snug.S.auth === 'in' && window.snug.S.conn.socket === 'open');
  await kay2.locator('#p2p-state-notice[data-state="moving"]').waitFor();
  // The new PC, still moving in, sees the waiting change and cancels it with the recovery key.
  await kay2.locator('#p2p-moving-waiting').click({ timeout: 20000 });
  await kay2.locator('#p2p-waiting-key button:has-text("Cancel with my recovery key")').click();
  await kay2.fill('#rk-cur', kayCode);
  await kay2.click('button[type=submit]:has-text("Cancel the new key")');
  await kay2.waitForFunction(() => !window.snug.S.p2p?.recovery?.pendingAt, null, { timeout: 20000 });
  assert.equal((await pcs.K2.peer.reg.signedCall('/v1/account/kind', 'account-kind', {})).recovery.pendingAt, null);
  // The old PC, still on, is told how the move started and could stop it.
  await kay.locator('#p2p-move-notice[data-via="recovery"]:has-text("Someone used your recovery key")').waitFor({ timeout: 20000 });
  await shot(kay, '26-key-old-pc-notice');
  await registry.clock.advance(72 * 3600_000 + 1000);
  await kay2.waitForFunction(() => window.snug.S.p2p?.state === 'ok', null, { timeout: 20000 });
  await until(() => pcs.K.peer.identity.self()?.state === 'revoked', 15000, 'old PC revoked');
  assert.equal(pcs.K2.peer.identity.self().username, 'kaylee');
  // Kay re-adds Alice from the new PC; Alice sees the security-code banner, confirms, and they talk again.
  await goto(kay2, { type: 'friends', tab: 'add' });
  await kay2.fill('#f-add-handle', 'a');
  await kay2.click('.f-add-form button[type=submit]');
  await kay2.locator('.f-add-msg .ok-line').waitFor();
  await kay2.waitForFunction(() => Object.values(window.snug.S.friends).some((f) => f.state === 'friends'), null, { timeout: 20000 });
  const dm = await alice.evaluate(() => Object.keys(window.snug.S.dms).find((id) => window.snug.S.dms[id].members.some((m) => window.snug.S.users[m]?.username === 'kaylee')));
  await goto(alice, { type: 'conv', id: dm });
  await alice.locator('#p2p-key-banner:has-text("security code changed")').waitFor({ timeout: 20000 });
  await alice.click('#p2p-key-ok');
  await goto(kay2, { type: 'friends', tab: 'all' });
  await kay2.locator('.f-row:has-text("@a")').hover();
  await kay2.locator('.f-row:has-text("@a") button[aria-label^="Message"]').click({ force: true });
  await kay2.fill('.main .composer textarea', 'back on a new PC');
  await kay2.keyboard.press('Enter');
  await alice.locator('.msg-body:has-text("back on a new PC")').waitFor({ timeout: 20000 });
});

test('no GitHub: Kay moves again, to a third PC, with a pairing code typed on the second', async () => {
  const kay2 = pages.kay2;
  await pc('K3');
  const kay3 = await open('kay3', pcs.K3);
  await kay3.click('#auth-have');
  await kay3.click('#auth-other-pc');
  await kay3.locator('#auth-move-code').waitFor();
  const code = (await kay3.locator('#auth-move-code').textContent()).trim();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  await shot(kay3, '27-key-pairing-code');
  // On the second PC: Settings > Account and security > Move to a new PC.
  await kay2.click('.nav button[aria-label="Settings"]');
  await kay2.click('.layer-nav button.row:has-text("Account and security")');
  await kay2.click('#p2p-move-new');
  await kay2.fill('#mv-code', 'ZZZZZ-ZZZZZ');
  await kay2.click('#mv-check');
  await kay2.locator('.modal .err:has-text("isn’t right or has expired")').waitFor();
  await kay2.fill('#mv-code', code.toLowerCase());
  await kay2.click('#mv-check');
  await kay2.locator('#mv-fingerprint').waitFor();
  assert.equal((await kay2.locator('#mv-fingerprint').textContent()).replace(/\s+/g, ''), pcs.K3.peer.identity.fingerprint.replace(/\s+/g, ''));
  await shot(kay2, '28-key-move-confirm');
  await kay2.click('#mv-go');
  await inApp(kay3);
  await kay3.waitForFunction(() => window.snug.S.p2p?.state === 'ok', null, { timeout: 20000 });
  assert.equal(pcs.K3.peer.identity.self().username, 'kaylee');
  await until(() => pcs.K2.peer.identity.self()?.state === 'revoked', 15000, 'second PC revoked');
  // Alice came along (the restore list), with no security-code warning: the old PC vouched for the new one.
  await until(() => pcs.K3.db.get("SELECT 1 FROM friends f JOIN peers p ON p.user = f.other WHERE p.username = 'a' AND f.state = 'friends'"), 20000, 'Alice restored on the third PC');
});

test('no GitHub, on a phone-sized window: the welcome and recovery key screens fit with no sideways scroll', async () => {
  await pc('P');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await page.goto(pcs.P.base);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.waitForSelector('#auth-create');
  assert.ok(await fits(), 'welcome fits');
  await shot(page, '29-key-phone-welcome');
  await page.tap('#auth-create');
  await page.fill('#auth-username', 'phoebe');
  await page.locator('#auth-username-ok').waitFor();
  await page.tap('.auth-form button[type=submit]');
  await page.locator('#rk-key').waitFor({ timeout: 30000 });
  assert.ok(await fits(), 'recovery key screen fits');
  const box = await page.locator('#rk-key').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await shot(page, '30-key-phone-recovery');
  // "Do this later" warns, then lets them in; a reminder stays.
  await page.tap('#rk-later');
  await page.locator('.rk-later-warn:has-text("losing this PC means losing your account")').waitFor();
  await page.tap('#rk-later-ok');
  await inApp(page);
  await page.locator('#p2p-state-notice:has-text("Save your recovery key")').waitFor();
  assert.equal(await page.evaluate(() => window.snug.S.p2p.recovery.saved), false);
});

test('relay fallback: with direct links off on one PC, messages still go both ways through the registry relay', async () => {
  const D = await pc('D');                          // direct allowed, with a link host (its page)
  const E = await pc('E', { peerDirect: false });   // direct links off: as if behind a NAT nothing gets through
  const d = await signUp(D, registry, 1004, 'dana');
  const e = await signUp(E, registry, 1005, 'erin');
  // Both people have the app open, so both PCs have a link host.
  for (const [name, srv, c] of [['dana', D, d], ['erin', E, e]]) {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    await ctx.addCookies([{ name: 'snug_session', value: c.cookie.split('=')[1], url: srv.base }]);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
    await page.goto(srv.base);
    await inApp(page);
    pages[name] = page;
  }
  await d.ok('friend.request', { handle: 'erin' });
  const req = await e.next('friend', (x) => x.friend?.state === 'incoming', 15000);
  await e.ok('friend.accept', { user: req.id });
  await d.next('friend', (x) => x.friend?.state === 'friends', 15000);
  await until(() => D.peer.isOnline(e.id.slice(2)) && E.peer.isOnline(d.id.slice(2)), 15000, 'presence');
  const dm = (await d.ok('dm.open', { users: [e.id] })).id;
  assert.equal((await e.ok('dm.open', { users: [d.id] })).id, dm);
  const id1 = mid(), id2 = mid();
  await d.ok('msg.send', { conv: dm, id: id1, text: 'through the relay' });
  await pages.erin.waitForFunction((id) => Object.values(window.snug.S.msgs).flat().some((m) => m.id === id), id1, { timeout: 20000 });
  await e.ok('msg.send', { conv: dm, id: id2, text: 'and back through it' });
  await pages.dana.waitForFunction((id) => Object.values(window.snug.S.msgs).flat().some((m) => m.id === id), id2, { timeout: 20000 });
  await until(() => !D.db.get('SELECT 1 FROM peer_outbox') && !E.db.get('SELECT 1 FROM peer_outbox'), 10000, 'both outboxes acknowledged');
  assert.equal(rowsOf(E, id1).length, 1);
  assert.equal(rowsOf(D, id2).length, 1);
  // Now the fallback itself: the link closes when idle; Dana's PC (with a host) dials direct
  // first, Erin's answers "no direct", and Dana's falls back to the relay at once.
  await until(() => D.peer.stats().links === 0 && E.peer.stats().links === 0, 20000, 'idle links close');
  const fails = D.peer.stats().directFail;
  const id3 = mid();
  await d.ok('msg.send', { conv: dm, id: id3, text: 'after the fallback' });
  await pages.erin.waitForFunction((id) => Object.values(window.snug.S.msgs).flat().some((m) => m.id === id), id3, { timeout: 20000 });
  assert.equal(D.peer.stats().directFail, fails + 1, JSON.stringify(D.peer.stats()));
  assert.equal(D.peer.stats().relayed, true);
  // No direct link opened on either PC; every link was relayed.
  for (const s of [D, E]) {
    const st = s.peer.stats();
    assert.equal(st.direct, 0, JSON.stringify(st));
    assert.ok(st.relay >= 2, JSON.stringify(st));
  }
  assert.equal(rowsOf(E, id3).length, 1);
  await d.close();
  await e.close();
});

// 0.13: group calls in a group across PCs: a mesh between the members' browsers, signalled over the PC links.
test('a group call between three PCs connects with fake media: each person hears the two others', async () => {
  const people = [['F', 'faye', 1011], ['G', 'gus', 1012], ['H', 'hana', 1013]];
  const cs = {};
  for (const [P, name, ghId] of people) {
    const srv = await pc(P);
    cs[name] = await signUp(srv, registry, ghId, name);
    const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
    contexts.push(ctx);
    await ctx.addCookies([{ name: 'snug_session', value: cs[name].cookie.split('=')[1], url: srv.base }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
    await page.goto(srv.base);
    await inApp(page);
    pages[name] = page;
  }
  const { faye, gus, hana } = cs;
  // Faye is friends with both; Gus and Hana only share the group.
  for (const [x, y] of [[faye, gus], [faye, hana]]) {
    await x.ok('friend.request', { handle: y.srv === pcs.G ? 'gus' : 'hana' });
    const req = await y.next('friend', (d) => d.friend?.state === 'incoming', 15000);
    await y.ok('friend.accept', { user: req.id });
    await x.next('friend', (d) => d.id === y.id && d.friend?.state === 'friends', 15000);
  }
  const g = (await faye.ok('dm.open', { users: [gus.id, hana.id] })).id;
  await until(() => pcs.G.db.get('SELECT 1 FROM dms WHERE id = ?', g) && pcs.H.db.get('SELECT 1 FROM dms WHERE id = ?', g), 20000, 'the group on every PC');
  await until(() => pcs.F.peer.capsOf(gus.id.slice(2)).includes('gcall') && pcs.F.peer.capsOf(hana.id.slice(2)).includes('gcall'), 20000, 'caps');
  await until(() => pcs.G.peer.isOnline(hana.id.slice(2)) && pcs.H.peer.isOnline(gus.id.slice(2)), 20000, 'co-members online to each other');
  for (const name of ['faye', 'gus', 'hana']) await goto(pages[name], { type: 'conv', id: g });
  await pages.faye.locator('.main .bar .call-btn[aria-label="Start a voice call"]').click();
  for (const name of ['gus', 'hana']) {
    const card = pages[name].locator('.incoming[role="alertdialog"]');
    await card.waitFor({ timeout: 20000 });
    await card.locator('.inc-accept').click();
  }
  for (const name of ['faye', 'gus', 'hana']) {
    await pages[name].waitForFunction(async () => {
      const peers = Object.values(await window.snug.voiceStats());
      return peers.length === 2 && peers.every((x) => x.state === 'connected' && x.bytes > 1000);
    }, null, { timeout: 45000, polling: 500 });
  }
  await shot(pages.faye, '32-group-call');
  for (const name of ['faye', 'gus', 'hana']) await pages[name].click('.stage.call [aria-label="Leave call"]');
  await until(() => !pcs.F.hub.callOf(g) && !pcs.G.hub.callOf(g) && !pcs.H.hub.callOf(g), 20000, 'the call is over on every PC');
  for (const c of Object.values(cs)) await c.close();
});

// 0.13: deleting with "Erase what I wrote" asks friends' PCs that are online to delete their copies.
test('erase on delete: with Erin’s PC off the dialog says it keeps its copy; with it on, Dana’s messages go from Erin’s PC', async () => {
  const { dana } = pages;
  const D = pcs.D;
  const eDir = pcs.E.dataDir;
  const erinUid = D.db.get("SELECT uid FROM peers WHERE username = 'erin'").uid;
  await pcs.E.close();
  await dana.waitForFunction(() => Object.values(window.snug.S.users).some((u) => u.remote && u.username === 'erin' && u.presence === 'offline'), null, { timeout: 30000 });
  await dana.evaluate(async () => { const s = await import('/js/store.js'); const p = await import('/js/views/p2p.js'); s.openModal(p.DeleteP2p, { onGone: async () => {} }); });
  await dana.locator('.erase-choice input[value="erase"]').check();
  const note = dana.locator('.erase-choice .erase-offline');
  await note.waitFor();
  assert.match(await note.textContent(), /erin’s PC is offline now, so it keeps its copy/);
  await shot(dana, '31-erase-offline');
  // Erin's PC starts again: the note goes, and erasing reaches it.
  await pc('E', { dataDir: eDir, peerDirect: false });
  await until(() => D.peer.isOnline(erinUid), 30000, 'Erin back online');
  await note.waitFor({ state: 'detached', timeout: 20000 });
  const mine = D.db.all("SELECT id FROM messages WHERE author = (SELECT id FROM users WHERE handle = 'dana') AND sys IS NULL").map((r) => r.id);
  assert.ok(mine.length >= 2);
  await until(() => mine.every((id) => rowsOf(pcs.E, id)[0] && !rowsOf(pcs.E, id)[0].deleted), 10000, 'Erin has Dana’s messages');
  await dana.fill('#cf-handle', 'dana');
  await dana.click('.modal button:has-text("Delete my account")');
  await until(() => mine.every((id) => rowsOf(pcs.E, id)[0]?.deleted), 30000, 'Dana’s messages deleted on Erin’s PC');
});

// ---------- v0.13: waiting changes, from Settings > Account and security ----------
const kindOn = (srv) => srv.peer.reg.signedCall('/v1/account/kind', 'account-kind', {});
async function openAccount(page) {
  await page.click('.nav button[aria-label="Settings"]');
  await page.click('.layer-nav button.row:has-text("Account and security")');
}
// The GitHub code screen in a modal; (mock) GitHub approves it for ghId.
async function approveOnGithub(page, ghId) {
  const code = (await page.locator('.modal #auth-device-code').textContent()).trim();
  registry.github.authorize(code, { id: ghId });
}

test('v0.13: a GitHub account adds a first recovery key, cancels the wait from this PC, then with GitHub', async () => {
  const bob2 = pages.bob2;
  await openAccount(bob2);
  const add = async () => {
    await bob2.click('#p2p-recovery-add');
    await bob2.click('#rk-make');
    await bob2.locator('#rk-key').waitFor();
    const code = (await bob2.locator('#rk-key > span').allTextContents()).join('-');
    await bob2.fill('#rk-last', code.slice(-4));
    await bob2.click('#rk-saved');
    await bob2.locator('#p2p-recovery-cancel').waitFor();
    const k = await kindOn(pcs.B2);
    assert.ok(k.recovery.pendingAt, 'a first key waits');
    assert.equal(k.recovery.set, false);
  };
  await add();
  await bob2.locator('.set-label span:has-text("Your recovery key starts working on")').waitFor();
  await shot(bob2, '40-first-key-waiting');
  // from this PC: only the key change goes
  await bob2.click('#p2p-recovery-cancel');
  await bob2.click('#p2p-cancel-go');
  await bob2.locator('#p2p-recovery-add').waitFor();
  assert.deepEqual((await kindOn(pcs.B2)).recovery, { set: false, pendingAt: null, rk: null });
  // again, and this time GitHub cancels it
  await add();
  await bob2.click('#p2p-recovery-cancel-gh');
  await approveOnGithub(bob2, 1001);
  await bob2.locator('#p2p-recovery-add').waitFor({ timeout: 20000 });
  assert.deepEqual((await kindOn(pcs.B2)).recovery, { set: false, pendingAt: null, rk: null });
  await bob2.keyboard.press('Escape');
});

test('v0.13: a keypair account links GitHub and cancels the wait from this PC and with GitHub; unlinks with and without its recovery key', async () => {
  const kay3 = pages.kay3;
  const GH = 1101;
  await openAccount(kay3);
  const link = async () => {
    await kay3.click('#p2p-gh-link');
    await approveOnGithub(kay3, GH);
    await kay3.locator('#p2p-gh-waiting').waitFor({ timeout: 20000 });
    assert.equal((await kindOn(pcs.K3)).github.pending?.change, 'link');
  };
  await link();
  await kay3.locator('.set-label span:has-text("Your GitHub account starts working on")').waitFor();
  await shot(kay3, '41-link-waiting');
  // from this PC, with no recovery key
  await kay3.click('#p2p-gh-cancel');
  await kay3.click('#p2p-cancel-go');
  await kay3.locator('#p2p-gh-link').waitFor();
  assert.deepEqual((await kindOn(pcs.K3)).github, { linked: false, pending: null });
  // again; the GitHub account being linked cancels it
  await link();
  await kay3.click('#p2p-gh-cancel-gh');
  await approveOnGithub(kay3, GH);
  await kay3.locator('#p2p-gh-link').waitFor({ timeout: 20000 });
  assert.deepEqual((await kindOn(pcs.K3)).github, { linked: false, pending: null });
  // a third time, and the 7 days pass: linked
  await link();
  await registry.clock.advance(7 * 24 * 3600_000 + 1000);
  await kay3.locator('#p2p-gh-unlink').waitFor({ timeout: 20000 });
  assert.deepEqual((await kindOn(pcs.K3)).github, { linked: true, pending: null });
  // unlink without the recovery key: it waits; the linked GitHub cancels it
  const unlinkLater = async () => {
    await kay3.click('#p2p-gh-unlink');
    await kay3.locator('#gh-unlink-go:has-text("Unlink in 7 days")').click();
    await kay3.locator('#p2p-gh-waiting').waitFor();
    assert.equal((await kindOn(pcs.K3)).github.pending?.change, 'unlink');
  };
  await unlinkLater();
  await kay3.locator('.set-label span:has-text("GitHub is unlinked on")').waitFor();
  await kay3.click('#p2p-gh-cancel-gh');
  await approveOnGithub(kay3, GH);
  await kay3.locator('#p2p-gh-unlink').waitFor({ timeout: 20000 });
  assert.deepEqual((await kindOn(pcs.K3)).github, { linked: true, pending: null });
  // again; the recovery key cancels it
  await unlinkLater();
  await kay3.click('#p2p-gh-cancel');
  await kay3.fill('#rk-cur', kayCode);
  await kay3.click('button[type=submit]:has-text("Cancel it")');
  await kay3.locator('#p2p-gh-unlink').waitFor({ timeout: 20000 });
  assert.deepEqual((await kindOn(pcs.K3)).github, { linked: true, pending: null });
  // with the recovery key typed, the unlink happens at once
  await kay3.click('#p2p-gh-unlink');
  await kay3.fill('#rk-unlink', kayCode);
  await kay3.locator('#gh-unlink-go:has-text("Unlink now")').click();
  await kay3.locator('#p2p-gh-link').waitFor();
  assert.deepEqual((await kindOn(pcs.K3)).github, { linked: false, pending: null });
  await kay3.keyboard.press('Escape');
});
