// Two PCs, end to end (design section 12.4): a local registry and mock GitHub,
// one Snug server per person, and one Chromium context per person. The pages
// are the link hosts, so messages take the direct WebRTC path. No real GitHub.
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

// Continue with GitHub: the code screen, then (mock) GitHub approves it.
async function github(page, ghId) {
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
  await alice.waitForSelector('#auth-github');
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
  for (const n of ['a', '1']) {
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
  // and "1" is refused for anyone but the owner. Then Carol takes her own name.
  assert.equal((await check('BOB')).error, 'taken');
  const claim = (username) => fetch(`${C.base}/api/gh/claim`, { method: 'POST', headers: { origin: C.base, 'content-type': 'application/json' }, body: JSON.stringify({ flow: start.flow, username }) });
  let r = await claim('BOB');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'taken');
  r = await claim('1');
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'owner_only');
  r = await claim('Carol');
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(C.peer.identity.self().username, 'carol');
  // The registry itself (not just this PC's checks) keeps "a" and "1" for the owner's GitHub id.
  const X = await pc('X');
  const auth = await X.peer.reg.authGithub(registry.github.issueToken({ id: 1003 }));
  for (const n of ['a', '1', 'CAROL']) {
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
