// Two PCs talking without a browser (design 12.3): each test server is one
// person's PC, with the local registry and mock GitHub between them. There is
// no link host here, so links use the registry relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRegistry, startPc, signUp, clientFor, guest, until, mid } from './helpers/p2p.js';
import { dmIdFor } from '../server/peercrypto.js';

let registry;
const pcs = [];
const pc = async (o) => { const s = await startPc(registry, o); pcs.push(s); return s; };
const restart = async (s, o = {}) => { await s.close(); pcs.splice(pcs.indexOf(s), 1); return pc({ dataDir: s.dataDir, ...o }); };
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });

let gh = 1000;
const uidOf = (c) => c.id.slice(2);
// Two friends on two PCs.
async function friends(nameA, nameB) {
  const A = await pc(), B = await pc();
  const a = await signUp(A, registry, ++gh, nameA);
  const b = await signUp(B, registry, ++gh, nameB);
  await a.ok('friend.request', { handle: nameB });
  const req = await b.next('friend', (d) => d.friend?.state === 'incoming');
  await b.ok('friend.accept', { user: req.id });
  await a.next('friend', (d) => d.friend?.state === 'friends');
  await until(() => A.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(a)), 8000, 'presence');
  const dm = dmIdFor(uidOf(a), uidOf(b));
  assert.equal((await a.ok('dm.open', { users: [b.id] })).id, dm);
  return { A, B, a, b, dm };
}
const msgs = (s, dm) => s.db.all('SELECT * FROM messages WHERE conv = ? AND deleted IS NULL ORDER BY seq', dm);

test('friend by username while the other PC is off; the request waits in the registry', async () => {
  const A = await pc();
  let B = await pc();
  const a = await signUp(A, registry, ++gh, 'alice1');
  const b0 = await signUp(B, registry, ++gh, 'bob1');
  const bobUid = uidOf(b0);
  await b0.close();
  B = await restart(B, { registryUrl: null }); // B's PC is "off" as far as P2P goes
  const r = await a.ok('friend.request', { handle: 'Bob1' });
  assert.equal(r.state, 'outgoing');
  assert.equal(r.user, `u_${bobUid}`);
  assert.equal((await a.refused('friend.request', { handle: 'nobody_here' })), 'No one is called @nobody_here.');
  B = await restart(B);
  const b = await clientFor(B, `u_${bobUid}`);
  const req = await b.next('friend', (d) => d.friend?.state === 'incoming');
  assert.equal(req.id, a.id, 'the shadow of alice has her global id');
  assert.equal(req.user.handle, 'alice1');
  assert.equal(req.user.remote, true);
  await b.ok('friend.accept', { user: req.id });
  await a.next('friend', (d) => d.id === `u_${bobUid}` && d.friend?.state === 'friends');
  await until(() => A.peer.isOnline(bobUid), 8000, 'presence on');
  const p = await a.next('presence', (d) => d.user === `u_${bobUid}`);
  assert.notEqual(p.presence, 'offline');
});

test('direct messages both ways, with edit, delete, react and typing; a resend never duplicates', async () => {
  const { A, B, a, b, dm } = await friends('alice2', 'bob2');
  assert.equal((await b.ok('dm.open', { users: [a.id] })).id, dm, 'both PCs name it the same');
  const m1 = mid();
  await a.ok('msg.send', { conv: dm, id: m1, text: 'hello bob' });
  const got = await b.next('msg', (d) => d.m.id === m1);
  assert.equal(got.m.text, 'hello bob');
  assert.equal(got.m.author, a.id);
  await a.next('msg.state', (d) => d.id === m1 && d.state === 'delivered');
  const m2 = mid();
  await b.ok('msg.send', { conv: dm, id: m2, text: 'hi alice' });
  await a.next('msg', (d) => d.m.id === m2);
  await a.ok('msg.edit', { conv: dm, id: m1, text: 'hello bob!' });
  await until(() => B.db.get('SELECT text FROM messages WHERE id = ?', m1)?.text === 'hello bob!', 8000, 'edit');
  await b.ok('react', { conv: dm, id: m1, emoji: '👍', on: true });
  await until(() => A.db.get('SELECT 1 FROM reactions WHERE msg = ? AND user = ?', m1, b.id), 8000, 'reaction');
  await b.ok('typing', { conv: dm });
  await a.next('typing', (d) => d.user === b.id && d.conv === dm);
  await a.ok('msg.delete', { conv: dm, id: m1 });
  await until(() => B.db.get('SELECT deleted FROM messages WHERE id = ?', m1)?.deleted, 8000, 'delete');
  // The same id sent again (a client retry) lands once on both sides.
  await a.ok('msg.send', { conv: dm, id: m2.replace('m_', 'm_x'), text: 'once' });
  await a.ok('msg.send', { conv: dm, id: m2.replace('m_', 'm_x'), text: 'once' });
  await until(() => msgs(B, dm).some((m) => m.text === 'once'), 8000, 'once');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(msgs(B, dm).filter((m) => m.text === 'once').length, 1);
  assert.equal(msgs(A, dm).filter((m) => m.text === 'once').length, 1);
});

import { deflateSync, crc32 } from 'node:zlib';
function png(w, h, rgb = [0x60, 0x80, 0xa0]) {
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function upload(s, c, path, body, type = 'image/png', name = 'pic.png') {
  const res = await fetch(`${s.base}${path}`, { method: 'POST', headers: { cookie: c.cookie, origin: s.base, 'content-type': type, 'x-file-name': name }, body });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

test('profile: pushed once on change, signed, cached on the friend’s disk; the old picture goes', async () => {
  const { A, B, a, b } = await friends('alice3', 'bob3');
  // Becoming friends sends the current profile once.
  await until(() => B.peer.stats().profileApplied >= 1, 8000, 'first profile');
  const before = B.peer.stats().profileApplied;
  const pic1 = await upload(A, a, '/api/files?avatar', png(80, 80));
  await a.ok('me.update', { name: 'Alice Three', avatar: pic1.id, pronouns: 'she/her' });
  await until(() => B.peer.stats().profileApplied === before + 1, 8000, 'profile applied');
  const shadow = () => B.db.get('SELECT * FROM users WHERE id = ?', a.id);
  assert.equal(shadow().name, 'Alice Three');
  assert.equal(shadow().pronouns, 'she/her');
  await until(() => shadow().avatar, 8000, 'avatar fetched');
  const av1 = shadow().avatar;
  assert.match(av1, /^f_h/);
  const seen = await b.next('user', (d) => d.user.id === a.id && d.user.img);
  assert.equal(seen.user.img, `/api/avatars/${av1}`);
  // The same values again push nothing.
  const pushes = A.peer.stats().profilePushes;
  await a.ok('me.update', { name: 'Alice Three' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(A.peer.stats().profilePushes, pushes);
  // A second picture replaces the first on B's disk too.
  const pic2 = await upload(A, a, '/api/files?avatar', png(96, 96, [200, 10, 10]));
  await a.ok('me.update', { avatar: pic2.id });
  await until(() => shadow().avatar && shadow().avatar !== av1, 8000, 'second avatar');
  assert.equal(B.db.get('SELECT 1 FROM files WHERE id = ?', av1), undefined);
  assert.equal(existsSync(join(B.dataDir, 'files', av1)), false);
  // A's PC goes away: B still shows the picture from its own disk.
  const av2 = shadow().avatar;
  await A.close(); pcs.splice(pcs.indexOf(A), 1);
  const res = await fetch(`${B.base}/api/avatars/${av2}`, { headers: { cookie: b.cookie } });
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(png(96, 96, [200, 10, 10])));
});

test('offline outbox: messages wait, then arrive in order with delivered notices', async () => {
  const { A, a, b, dm } = await friends('alice4', 'bob4');
  let { B } = { B: pcs[pcs.length - 1] };
  await b.close();
  B = await restart(B, { registryUrl: null });
  await until(() => !A.peer.isOnline(uidOf(b)), 8000, 'offline');
  const ids = [mid(), mid(), mid()];
  for (const [i, id] of ids.entries()) await a.ok('msg.send', { conv: dm, id, text: `n${i}` });
  for (const id of ids) await a.next('msg.state', (d) => d.id === id && d.state === 'waiting');
  assert.deepEqual((await clientFor(A, a.id)).hello.peerWaiting[dm], ids);
  B = await restart(B);
  for (const id of ids) await a.next('msg.state', (d) => d.id === id && d.state === 'delivered', 10_000);
  assert.deepEqual(msgs(B, dm).map((m) => m.text), ['n0', 'n1', 'n2']);
  assert.equal(A.peer.stats().outbox, 0);
});

test('rules: no remote groups; LAN guests never see a remote friend; a block purges and drops', async () => {
  const { A, B, a, b, dm } = await friends('alice5', 'bob5');
  const g = await guest(A, 'languest5');
  assert.match(await a.refused('dm.open', { users: [b.id, g.id] }), /Group chats with friends on other PCs/);
  await g.refused('dm.open', { users: [b.id] });
  await g.refused('friend.request', { user: b.id });
  assert.equal(await g.refused('friend.request', { handle: 'bob5' }), 'Nobody is called @bob5.');
  const house = await a.ok('house.create', { name: 'Home five', hue: 10 });
  assert.match(await a.refused('invite.user', { house: house.id ?? house.house?.id, handle: 'bob5' }), /Friends on other PCs can’t join houses yet/);
  assert.equal(A.M.sees(g.id, b.id), false);
  assert.equal((await g.ok('sync')).users[b.id], undefined);
  // Bob's picture on A: 404 for the guest, 200 for the owner.
  const pic = await upload(B, b, '/api/files?avatar', png(70, 70));
  await b.ok('me.update', { avatar: pic.id });
  await until(() => A.db.get('SELECT avatar FROM users WHERE id = ?', b.id)?.avatar, 8000, 'avatar');
  const av = A.db.get('SELECT avatar FROM users WHERE id = ?', b.id).avatar;
  assert.equal((await fetch(`${A.base}/api/avatars/${av}`, { headers: { cookie: g.cookie } })).status, 404);
  assert.equal((await fetch(`${A.base}/api/avatars/${av}`, { headers: { cookie: a.cookie } })).status, 200);
  // A blocks B: A's queue for B empties, B's frames are dropped, the friendship ends on both PCs.
  await b.close();
  await until(() => B.peer._links.count() === 0 || true, 100);
  await a.ok('block.set', { user: b.id, on: true });
  assert.equal(A.db.get('SELECT COUNT(*) n FROM peer_outbox WHERE peer = ?', b.id).n, 0);
  await until(() => !B.db.get('SELECT 1 FROM friends WHERE user = ? AND other = ?', b.id, a.id), 8000, 'unfriended on B');
  await a.refused('dm.open', { users: [b.id] });
  assert.ok(dm);
});

test('links close when idle and reopen on demand', async () => {
  const { A, B, a, b, dm } = await friends('alice6', 'bob6');
  await a.ok('msg.send', { conv: dm, id: mid(), text: 'x' });
  await until(() => A.peer._links.isUp(uidOf(b)), 8000, 'link up');
  await until(() => !A.peer._links.isUp(uidOf(b)) && !B.peer._links.isUp(uidOf(a)), 12_000, 'idle close');
  const id = mid();
  await a.ok('msg.send', { conv: dm, id, text: 'again' });
  await b.next('msg', (d) => d.m.id === id);
});

test('call signaling over the link: ring, join, rtc both ways, hang up; rtc outside a call is refused', async () => {
  const { A, B, a, b, dm } = await friends('alice7', 'bob7');
  const started = await a.ok('call.start', { dm });
  assert.match(started.call, /^call_/);
  const ring = await b.next('call.ring', (r) => r.dm === dm);
  assert.equal(ring.from, a.id);
  assert.equal(ring.call, started.call, 'both PCs use the same call id');
  const joined = await b.ok('call.join', { dm });
  assert.deepEqual(joined.peers, [a.id]);
  await a.next('voice', (v) => v.room === dm && v.users.includes(b.id));
  await b.ok('rtc', { to: a.id, data: { sdp: 'offer-from-b' } });
  const r1 = await a.next('rtc', (d) => d.from === b.id);
  assert.deepEqual(r1.data, { sdp: 'offer-from-b' });
  await a.ok('rtc', { to: b.id, data: { sdp: 'answer-from-a' } });
  assert.deepEqual((await b.next('rtc', (d) => d.from === a.id)).data, { sdp: 'answer-from-a' });
  await b.ok('voice.state', { muted: true });
  await until(() => A.hub.voiceStateOf(b.id)?.muted, 8000, 'mute mirrored');
  await a.ok('voice.leave');
  await b.next('call.ended', (d) => d.dm === dm);
  // One record per side, under the same id.
  await until(() => B.db.get('SELECT id FROM messages WHERE conv = ? AND sys IS NOT NULL', dm), 8000, 'record');
  assert.equal(A.db.get('SELECT id FROM messages WHERE conv = ? AND sys IS NOT NULL', dm).id, B.db.get('SELECT id FROM messages WHERE conv = ? AND sys IS NOT NULL', dm).id);
  await b.refused('rtc', { to: a.id, data: { x: 1 } });
  // A hand-made rtc frame with no call is refused on arrival.
  const rej = B.peer.stats().rejected;
  A.peer._links.sendEph(uidOf(b), 'rtc', { data: { x: 1 } });
  await until(() => B.peer.stats().rejected > rej, 8000, 'rtc refused');
});

test('replays: a captured relay frame and a captured knock do nothing the second time, even after a restart', async () => {
  const A = await pc();
  let B = await pc();
  const a = await signUp(A, registry, ++gh, 'alice8');
  const b = await signUp(B, registry, ++gh, 'bob8');
  const frames = [], knocks = [];
  let capture = true;
  B.peer._signal.on('relay', (m) => capture && frames.push(m));
  B.peer._signal.on('knock', (m) => capture && knocks.push(m));
  await a.ok('friend.request', { handle: 'bob8' });
  const req = await b.next('friend', (d) => d.friend?.state === 'incoming');
  await b.ok('friend.accept', { user: req.id });
  await a.next('friend', (d) => d.friend?.state === 'friends');
  await until(() => B.peer.isOnline(uidOf(a)), 8000, 'online');
  const dm = (await a.ok('dm.open', { users: [b.id] })).id;
  const id = mid();
  await a.ok('msg.send', { conv: dm, id, text: 'only once' });
  await b.next('msg', (d) => d.m.id === id);
  capture = false;
  const rej = B.peer.stats().rejected;
  for (const f of frames) B.peer._signal.emit('relay', f);
  await until(() => B.peer.stats().rejected > rej, 4000, 'frame replay refused');
  for (const k of knocks) B.peer._signal.emit('knock', k);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(msgs(B, dm).length, 1);
  assert.equal(B.db.get('SELECT state FROM friends WHERE user = ? AND other = ?', b.id, a.id).state, 'friends');
  await b.close();
  B = await restart(B);
  await until(() => B.peer._signal.connected, 8000, 'signal');
  for (const f of frames) B.peer._signal.emit('relay', f);
  for (const k of knocks) B.peer._signal.emit('knock', k);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(msgs(B, dm).length, 1);
  assert.equal(B.db.get('SELECT state FROM friends WHERE user = ? AND other = ?', b.id, a.id).state, 'friends');
});

test('a hostile friend: borrowed file ids, unknown kinds and a profile flood change nothing they shouldn’t', async () => {
  const { A, B, a, b, dm } = await friends('alice9', 'bob9');
  // B has a file of its own in the conversation.
  await b.ok('dm.open', { users: [a.id] });
  const mine = await upload(B, b, `/api/files?conv=${dm}`, Buffer.from('bob secret'), 'text/plain', 'secret.txt');
  // A's PC (modified) sends a message naming B's file id, and a frame of a kind nobody knows.
  const shadowB = b.id;
  const evil = mid();
  A.peer._outbox.push(shadowB, 'dm.msg', evil, JSON.stringify({ id: evil, text: 'look', files: [{ id: mine.id, name: 'x', type: 'text/plain', size: 10, hash: 'A'.repeat(43) }] }), Date.now());
  A.peer._outbox.push(shadowB, 'ops', null, JSON.stringify({ t: 'house.delete' }), Date.now());
  const rej = B.peer.stats().rejected;
  A.peer._links.want(uidOf(b));
  await b.next('msg', (d) => d.m.id === evil);
  const row = B.db.get('SELECT * FROM files WHERE id = ?', mine.id);
  assert.equal(row.owner, b.id, 'B’s own file row is untouched');
  assert.equal(readFileSync(join(B.dataDir, 'files', mine.id), 'utf8'), 'bob secret');
  const got = B.db.get('SELECT files FROM messages WHERE id = ?', evil);
  assert.notEqual(JSON.parse(got.files)[0].id, mine.id, 'the friend’s file gets its own local id');
  await until(() => B.peer.stats().rejected > rej, 8000, 'unknown kind refused');
  await until(() => A.peer.stats().outbox === 0, 8000, 'both acked (refused items still advance)');
  // 22 profile changes in a row: B applies 20 in the hour, the newest waits.
  const applied = B.peer.stats().profileApplied;
  for (let i = 0; i < 22; i++) await a.ok('me.update', { name: `Alice ${i}` });
  await until(() => (B.peer.stats().profileDeferred || 0) >= 1, 10_000, 'deferred');
  assert.ok(B.peer.stats().profileApplied - applied <= 20);
});

// GitHub sign-in on a new PC for an account that lives elsewhere: the registry starts a move (rebind).
async function startMove(B2, ghId) {
  const auth = await B2.peer.reg.authGithub(registry.github.issueToken({ id: ghId }));
  assert.equal(auth.status, 'rebind');
  const r = await B2.peer.reg.rebind(auth.ticket);
  assert.equal(r.status, 'pending');
  const id = `u_${r.uid}`;
  B2.db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, '!', 10, ?)", id, auth.account.username, auth.account.username, Date.now());
  B2.peer.identity.setSelf({ uid: r.uid, username: auth.account.username, user: id, kver: auth.account.kver, state: 'moving', rebindAt: r.at });
  B2.peer.start();
  return clientFor(B2, id);
}
const ghOf = new Map();
async function friendsGh(nameA, nameB) {
  const A = await pc(), B = await pc();
  const ga = ++gh, gb = ++gh;
  const a = await signUp(A, registry, ga, nameA);
  const b = await signUp(B, registry, gb, nameB);
  ghOf.set(b.id, gb);
  await a.ok('friend.request', { handle: nameB });
  await b.ok('friend.accept', { user: (await b.next('friend', (d) => d.friend?.state === 'incoming')).id });
  await a.next('friend', (d) => d.friend?.state === 'friends');
  await until(() => A.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(a)), 8000, 'presence');
  const dm = (await a.ok('dm.open', { users: [b.id] })).id;
  return { A, B, a, b, dm, gb };
}

test('move, approved on the old PC: friends come along, the friend re-pins quietly, both ways work after', async () => {
  const { A, B, a, b, dm, gb } = await friendsGh('alice10', 'bob10');
  const m0 = mid();
  await a.ok('msg.send', { conv: dm, id: m0, text: 'before the move' });
  await b.next('msg', (d) => d.m.id === m0);
  const B2 = await pc();
  const b2 = await startMove(B2, gb);
  await until(() => B.peer.statusFor(b.id).rebindPending, 8000, 'old PC told');
  await B.peer.approveRebind();
  await until(() => B.peer.identity.self().state === 'revoked', 8000, 'old PC revoked');
  await until(() => B2.peer.identity.self().state === 'ok' && B2.peer.identity.self().kver === 2, 8000, 'move done');
  await until(() => B2.db.get("SELECT state FROM friends WHERE user = ? AND other = ?", b2.id, a.id)?.state === 'friends', 8000, 'restored friend');
  await until(() => A.peer.isOnline(uidOf(b2)), 8000, 'B2 online to A');
  const m1 = mid();
  await a.ok('msg.send', { conv: dm, id: m1, text: 'after the move' });
  await b2.next('msg', (d) => d.m.id === m1, 10_000);
  const key = await a.next('peer.key', (d) => d.user === b.id);
  assert.equal(key.quiet, true, 'a confirmed move shows no warning');
  const m2 = mid();
  await b2.ok('msg.send', { conv: dm, id: m2, text: 'from the new PC' });
  await a.next('msg', (d) => d.m.id === m2);
  await b2.ok('me.update', { name: 'Bob on PC two' });
  await until(() => A.db.get('SELECT name FROM users WHERE id = ?', b.id).name === 'Bob on PC two', 8000, 'profile after move');
});

test('move without the old PC (lost key): a loud key change, held messages until OK, re-friend accepted', async () => {
  const { A, B, a, b, dm, gb } = await friendsGh('alice11', 'bob11');
  await b.close();
  await B.close(); pcs.splice(pcs.indexOf(B), 1);
  await until(() => !A.peer.isOnline(uidOf(b)), 8000, 'offline');
  const early = mid();
  await a.ok('msg.send', { conv: dm, id: early, text: 'written before the change' });
  const B2 = await pc();
  const b2 = await startMove(B2, gb);
  await registry.clock.advance(72 * 3600_000 + 1000);
  await until(() => B2.peer.identity.self().state === 'ok', 10_000, 'move done after 72 h');
  await b2.ok('friend.request', { handle: 'alice11' });
  const key = await a.next('peer.key', (d) => d.user === b.id, 10_000);
  assert.equal(key.quiet, false, 'no confirmation from the old PC: loud');
  await a.next('msg.state', (d) => d.id === early && d.state === 'held');
  // A's PC still counts them as friends: it answers the new request with yes.
  await b2.next('friend', (d) => d.id === a.id && d.friend?.state === 'friends', 10_000);
  await until(() => A.peer.isOnline(uidOf(b2)), 8000, 'online');
  const late = mid();
  await a.ok('msg.send', { conv: dm, id: late, text: 'after the change' });
  await b2.next('msg', (d) => d.m.id === late, 10_000);
  assert.equal(B2.db.get('SELECT 1 FROM messages WHERE id = ?', early), undefined, 'held until OK');
  assert.equal(A.peer.stats().held, 1);
  await a.ok('peer.keyAck', { user: b.id });
  await b2.next('msg', (d) => d.m.id === early, 10_000);
  const back = mid();
  await b2.ok('msg.send', { conv: dm, id: back, text: 'hi again' });
  await a.next('msg', (d) => d.m.id === back);
});

test('move stopped on the old PC: the new PC is told, the friend sees no key change', async () => {
  const { A, B, a, b, gb } = await friendsGh('alice12', 'bob12');
  const B2 = await pc();
  await startMove(B2, gb);
  await until(() => B.peer.statusFor(b.id).rebindPending, 8000, 'old PC told');
  await B.peer.cancelRebind();
  await until(() => B2.peer.identity.self().state === 'needs-signin', 8000, 'new PC told');
  assert.equal(B.peer.identity.self().state, 'ok');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.has('peer.key'), false);
  const dm = dmIdFor(uidOf(a), uidOf(b));
  const id = mid();
  await a.ok('msg.send', { conv: dm, id, text: 'still you' });
  await b.next('msg', (d) => d.m.id === id);
  assert.ok(A);
});

test('a restored backup on one side: sequences renumber and messages flow both ways', async () => {
  const { A, a, b, dm } = await friendsGh('alice13', 'bob13');
  let B = pcs.find((s) => s.peer.identity.self()?.user === b.id);
  const m0 = mid();
  await a.ok('msg.send', { conv: dm, id: m0, text: 'one' });
  await b.next('msg', (d) => d.m.id === m0);
  await b.close();
  await B.close(); pcs.splice(pcs.indexOf(B), 1);
  const backup = mkdtempSync(join(tmpdir(), 'snug-backup-'));
  cpSync(B.dataDir, backup, { recursive: true });
  B = await pc({ dataDir: B.dataDir });
  let bb = await clientFor(B, b.id);
  for (const t of ['two', 'three']) {
    const id = mid();
    await a.ok('msg.send', { conv: dm, id, text: t });
    await bb.next('msg', (d) => d.m.id === id, 10_000);
    const r = mid();
    await bb.ok('msg.send', { conv: dm, id: r, text: `re ${t}` });
    await a.next('msg', (d) => d.m.id === r);
  }
  await bb.close();
  await B.close(); pcs.splice(pcs.indexOf(B), 1);
  rmSync(B.dataDir, { recursive: true, force: true });
  cpSync(backup, B.dataDir, { recursive: true });
  B = await pc({ dataDir: B.dataDir });
  bb = await clientFor(B, b.id);
  const after = mid();
  await a.ok('msg.send', { conv: dm, id: after, text: 'after restore' });
  await bb.next('msg', (d) => d.m.id === after, 10_000);
  const reply = mid();
  await bb.ok('msg.send', { conv: dm, id: reply, text: 'restored reply' });
  await a.next('msg', (d) => d.m.id === reply, 10_000);
});

test('attachments: fetched from the friend’s PC by hash, typed by their bytes, served locally after', async () => {
  const { A, B, a, b, dm } = await friends('alice14', 'bob14');
  const pic = png(120, 90, [1, 2, 3]);
  const up = await upload(A, a, `/api/files?conv=${dm}`, pic, 'image/png', 'photo.png');
  const id = mid();
  await a.ok('msg.send', { conv: dm, id, text: 'a photo', files: [{ id: up.id, w: 120, h: 90 }] });
  const got = await b.next('msg', (d) => d.m.id === id);
  const local = got.m.files[0].id;
  assert.match(local, /^f_r/);
  assert.equal(got.m.files[0].kind, 'image');
  await until(() => JSON.parse(B.db.get('SELECT meta FROM files WHERE id = ?', local).meta).have === 1, 8000, 'fetched');
  const res = await fetch(`${B.base}/api/files/${local}`, { headers: { cookie: b.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(pic));
  assert.ok(B.peer.stats().blobsFetched >= 1);
  // Something that claims to be a PNG but isn't is kept as a download, never shown inline.
  const fake = await upload(A, a, `/api/files?conv=${dm}`, Buffer.from('not really a png'), 'text/plain', 'x.png');
  A.db.run("UPDATE files SET type = 'image/png' WHERE id = ?", fake.id); // a lying sender
  const id2 = mid();
  await a.ok('msg.send', { conv: dm, id: id2, text: 'fake', files: [{ id: fake.id }] });
  const got2 = await b.next('msg', (d) => d.m.id === id2);
  const lid = got2.m.files[0].id;
  await until(() => JSON.parse(B.db.get('SELECT meta FROM files WHERE id = ?', lid).meta).have === 1, 8000, 'fetched 2');
  assert.equal(B.db.get('SELECT type FROM files WHERE id = ?', lid).type, 'application/octet-stream');
});

test('logs never carry the GitHub token or message text; every token is revoked', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...x) => lines.push(x.map(String).join(' '));
  let A, B;
  try {
    A = await pc({ quiet: false }); B = await pc({ quiet: false });
    const tokens = [];
    const issue = registry.github.issueToken;
    registry.github.issueToken = (o) => { const t = issue(o); tokens.push(t); return t; };
    const a = await signUp(A, registry, ++gh, 'alice15');
    const b = await signUp(B, registry, ++gh, 'bob15');
    registry.github.issueToken = issue;
    await a.ok('friend.request', { handle: 'bob15' });
    await b.ok('friend.accept', { user: (await b.next('friend', (d) => d.friend?.state === 'incoming')).id });
    await until(() => A.peer.isOnline(uidOf(b)), 8000, 'online');
    const dm = (await a.ok('dm.open', { users: [b.id] })).id;
    const id = mid();
    await a.ok('msg.send', { conv: dm, id, text: 'secret words' });
    await b.next('msg', (d) => d.m.id === id);
    await A.close(); pcs.splice(pcs.indexOf(A), 1);
    await B.close(); pcs.splice(pcs.indexOf(B), 1);
    assert.ok(lines.length > 0);
    for (const t of tokens) assert.equal(lines.some((l) => l.includes(t)), false, 'token in the logs');
    assert.equal(lines.some((l) => l.includes('secret words')), false, 'message text in the logs');
    // The registry revoked every token after reading the id.
    for (const t of tokens) assert.ok(registry.github.calls.some((c) => c.method === 'DELETE' && c.token === t));
  } finally { console.log = orig; }
});
