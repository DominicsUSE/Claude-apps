// Snug 0.12 core track, across PCs (bug B3 and disappearing messages): thread
// replies, pins and the disappearing-messages timer reach friends on other
// PCs, in direct conversations and in groups; a PC that doesn't say it
// understands them (0.11) gets what it can read and isn't sent the rest.
process.env.SNUG_GROUP_FWD_MS = '200';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, startPc, signUp, until, mid } from './helpers/p2p.js';
import { threePcs, texts } from './helpers/groups.js';
import { dmIdFor } from '../server/peercrypto.js';

let registry;
const pcs = [];
const pc = async (o) => { const s = await startPc(registry, o); pcs.push(s); return s; };
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });

let gh = 70_000;
const uidOf = (c) => c.id.slice(2);
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
const row = (s, id) => s.db.get('SELECT * FROM messages WHERE id = ?', id);
const DAY = 86_400_000;

let pair;
test('B3: a thread reply in a direct conversation with a friend on another PC reaches them, both ways', async () => {
  pair = await friends('corealice', 'corebob');
  const { A, B, a, b, dm } = pair;
  const root = mid();
  await a.ok('msg.send', { conv: dm, id: root, text: 'root of a thread' });
  await until(() => row(B, root), 8000, 'root on B');
  // Both PCs say they understand threads, pins and timers (in their signed profiles).
  await until(() => A.peer.capsOf(uidOf(b)).includes('thread') && B.peer.capsOf(uidOf(a)).includes('thread'), 8000, 'caps');
  const reply = mid();
  await a.ok('msg.send', { conv: `t:${root}`, id: reply, text: 'a reply in the thread' });
  await until(() => row(B, reply), 8000, 'thread reply on B');
  assert.equal(row(B, reply).conv, `t:${root}`);
  assert.equal(row(B, reply).text, 'a reply in the thread');
  assert.ok(B.db.get('SELECT 1 FROM threads WHERE id = ? AND conv = ?', `t:${root}`, dm), 'the thread exists on B');
  const back = mid();
  await b.ok('msg.send', { conv: `t:${root}`, id: back, text: 'bob answers in the thread' });
  await until(() => row(A, back), 8000, 'thread reply on A');
  assert.equal(row(A, back).conv, `t:${root}`);
  // Edits and reactions in the thread follow too.
  await a.ok('msg.edit', { conv: `t:${root}`, id: reply, text: 'a reply in the thread, edited' });
  await until(() => row(B, reply).text === 'a reply in the thread, edited', 8000, 'thread edit on B');
  await b.ok('react', { conv: `t:${root}`, id: reply, emoji: '👍', on: true });
  await until(() => A.db.get('SELECT 1 FROM reactions WHERE msg = ?', reply), 8000, 'thread reaction on A');
});

test('B3: pins in a direct conversation across PCs reach the friend', async () => {
  const { A, B, a, b, dm } = pair;
  const id = mid();
  await a.ok('msg.send', { conv: dm, id, text: 'pin me' });
  await until(() => row(B, id), 8000, 'message on B');
  await a.ok('msg.pin', { conv: dm, id });
  await until(() => B.db.get('SELECT 1 FROM pins WHERE conv = ? AND msg = ?', dm, id), 8000, 'pin on B');
  await b.ok('msg.unpin', { conv: dm, id });
  await until(() => !A.db.get('SELECT 1 FROM pins WHERE conv = ? AND msg = ?', dm, id), 8000, 'unpin on A');
});

test('disappearing across PCs: the timer reaches the friend, and their copy of each new message expires with the sender’s', async () => {
  const { A, B, a, b, dm } = pair;
  await a.ok('conv.ttl', { conv: dm, ttl: DAY });
  await until(() => B.db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', dm)?.ttl === DAY, 8000, 'timer on B');
  const id = mid();
  await a.ok('msg.send', { conv: dm, id, text: 'gone tomorrow' });
  await until(() => row(B, id), 8000, 'message on B');
  // Both copies expire together: the friend's PC counts from the sender's time (the frame's, within a second of the message's).
  assert.ok(Math.abs(row(B, id).expires - row(A, id).expires) < 1000, 'both copies expire at the same time');
  assert.ok(row(B, id).expires > Date.now() + DAY - 120_000);
  // Bob turns it off; it goes back to Alice.
  await b.ok('conv.ttl', { conv: dm, ttl: 0 });
  await until(() => !A.db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', dm), 8000, 'timer off on A');
});

// 0.13: polls travel between PCs (tests/server-peer-polls.test.js); a friend's older PC still gets a plain refusal.
test('B3: a poll for a friend whose PC doesn’t know polls (0.12.0) is refused plainly instead of staying on one PC', async () => {
  const { A, a, dm } = pair;
  A.peer._setCaps(uidOf(pair.b), ['thread', 'pin', 'ttl']);
  assert.match(await a.refused('poll.create', { conv: dm, id: mid(), question: 'Lunch?', answers: [{ text: 'Yes' }, { text: 'No' }], hours: 24 }), /needs an update/);
  A.peer._setCaps(uidOf(pair.b), null);
});

test('capabilities: a friend whose PC doesn’t say it knows timers (0.11) can’t be given one; threads reach it as replies', async () => {
  const { A, B, a, dm } = pair;
  // Make A believe B is a 0.11 PC: no capabilities in its profile.
  A.peer._setCaps(uidOf(pair.b), []);
  assert.match(await a.refused('conv.ttl', { conv: dm, ttl: DAY }), /update/i);
  const view = (await a.ok('history', { conv: dm }));
  assert.ok(view);
  const root = mid();
  await a.ok('msg.send', { conv: dm, id: root, text: 'root for an old PC' });
  await until(() => row(B, root), 8000, 'root on B');
  const reply = mid();
  await a.ok('msg.send', { conv: `t:${root}`, id: reply, text: 'thread reply for an old PC' });
  // A 0.11 PC has no threads over the link: it gets the reply as a reply to the root, in the conversation.
  await until(() => row(B, reply), 8000, 'reply on B');
  assert.equal(row(B, reply).conv, dm);
  assert.equal(row(B, reply).reply_to, root);
  // Pins aren't sent to it at all (it would refuse the frame).
  await a.ok('msg.pin', { conv: dm, id: root });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(B.db.get('SELECT 1 FROM pins WHERE msg = ?', root), undefined);
  A.peer._setCaps(uidOf(pair.b), null); // back to what its profile says
});

test('B3 in groups across PCs: thread replies, pins and the timer reach every member', async () => {
  const t = await threePcs(registry, pcs, ['coregina', 'corehal', 'coreivy']);
  const { A, B, C, a, b, c } = t;
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all.join() && members(C) === all.join(), 12_000, 'group on every PC');
  await until(() => [B, C].every((s) => s.peer.capsOf(uidOf(a)).includes('thread')) && A.peer.capsOf(uidOf(b)).includes('thread') && A.peer.capsOf(uidOf(c)).includes('thread'), 10_000, 'caps');
  const root = mid();
  await a.ok('msg.send', { conv: g, id: root, text: 'group root' });
  await until(() => row(B, root) && row(C, root), 10_000, 'root everywhere');
  const reply = mid();
  await b.ok('msg.send', { conv: `t:${root}`, id: reply, text: 'group thread reply' });
  await until(() => row(A, reply) && row(C, reply), 10_000, 'thread reply everywhere');
  assert.equal(row(C, reply).conv, `t:${root}`);
  await c.ok('msg.pin', { conv: g, id: root });
  await until(() => A.db.get('SELECT 1 FROM pins WHERE msg = ?', root) && B.db.get('SELECT 1 FROM pins WHERE msg = ?', root), 10_000, 'pin everywhere');
  await a.ok('conv.ttl', { conv: g, ttl: DAY });
  await until(() => B.db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', g)?.ttl === DAY && C.db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', g)?.ttl === DAY, 10_000, 'timer everywhere');
  const id = mid();
  await c.ok('msg.send', { conv: g, id, text: 'group message that goes' });
  await until(() => row(A, id) && row(B, id), 10_000, 'message everywhere');
  assert.equal(row(A, id).expires, row(C, id).expires);
});

// review-media 4: "friends only" on a PC stops group co-members who aren't friends from seeing it online.
test('presence "friends only": co-members of a group across PCs who aren’t friends stop seeing me online; friends still do', async () => {
  const t = await threePcs(registry, pcs, ['prsgina', 'prshal', 'prsivy']);
  const { A, B, C, a, b, c } = t;
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all.join() && members(C) === all.join(), 12_000, 'group on every PC');
  // B and C aren't friends, but share the group, so each sees the other online.
  await until(() => C.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(c)), 10_000, 'co-member presence');
  await b.ok('prefs.set', { prefs: { presenceTo: 'friends' } });
  await until(() => !C.peer.isOnline(uidOf(b)), 10_000, 'C no longer sees B online');
  assert.equal(A.peer.isOnline(uidOf(b)), true, 'a friend still does');
  // Back to everyone: the co-member sees B again.
  await b.ok('prefs.set', { prefs: { presenceTo: 'everyone' } });
  await until(() => C.peer.isOnline(uidOf(b)), 10_000, 'C sees B again');
});

// review-media 4 (pass 2): friends only hides me from group co-members who aren't friends without cutting
// them off: the registry is told they're quiet (no presence, they reach me once my PC contacted theirs),
// and group messages still go both ways directly, with no common friend online to pass them on.
test('presence "friends only": group messages still go both ways between co-members who aren’t friends', async () => {
  const t = await threePcs(registry, pcs, ['fogana', 'fogbea', 'fogcal']);
  const { A, B, C, a, b, c } = t;
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort().join();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all && members(C) === all, 12_000, 'group on every PC');
  await until(() => C.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(c)), 10_000, 'co-member presence');
  await b.ok('prefs.set', { prefs: { presenceTo: 'friends' } });
  await until(() => !C.peer.isOnline(uidOf(b)), 10_000, 'C no longer sees B online');
  // The common friend goes away, so nobody can pass messages on.
  await A.close(); pcs.splice(pcs.indexOf(A), 1);
  await c.ok('msg.send', { conv: g, id: mid(), text: 'from cal while ana is away' });
  await until(() => texts(B, g).includes('from cal while ana is away'), 30_000, 'B gets C’s message');
  await b.ok('msg.send', { conv: g, id: mid(), text: 'from bea while ana is away' });
  await until(() => texts(C, g).includes('from bea while ana is away'), 30_000, 'C gets B’s message');
  assert.equal(C.peer.isOnline(uidOf(b)), false, 'C still isn’t shown B online');
});
