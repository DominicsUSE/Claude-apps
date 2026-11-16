// Groups across PCs (design 0.10 section 4), without a browser: three PCs where
// A is friends with B and with C, and B and C are not friends. No host: every
// member's PC keeps the group; messages are signed by their author and any
// member forwards what another is missing.
process.env.SNUG_GROUP_FWD_MS = '200'; // the 0-20 s forward delay, shortened for tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, startPc, signUp, clientFor, guest, until, mid } from './helpers/p2p.js';
import { threePcs, uidOf, texts, hasGroup } from './helpers/groups.js';
import {
  replay, gidFor, signOp, signItem, opShape, MAX_MEMBERS, exportGroups, parseGroupsSection, itemAllowed,
} from '../server/grouplog.js';
import { newSigningKeys } from '../server/peercrypto.js';

let registry;
const pcs = [];
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });
const restart = async (s) => {
  await s.close();
  pcs.splice(pcs.indexOf(s), 1);
  const n = await startPc(registry, { dataDir: s.dataDir });
  pcs.push(n);
  return n;
};
const stop = async (s) => { await s.close(); pcs.splice(pcs.indexOf(s), 1); };
const members = (s, g) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user);

async function group(names) {
  const t = await threePcs(registry, pcs, names);
  const { A, B, C, a, b, c } = t;
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  assert.match(g, /^dg_[a-z2-7]{26}$/);
  const all = [a.id, b.id, c.id].sort();
  await until(() => members(A, g).join() === all.join(), 8000, 'A members');
  await until(() => members(B, g).join() === all.join(), 10_000, 'B joined, with C pinned');
  await until(() => members(C, g).join() === all.join(), 10_000, 'C joined, with B pinned');
  // B and C aren't friends, but people in a group see each other online.
  await until(() => B.peer.isOnline(uidOf(c)) && C.peer.isOnline(uidOf(b)), 10_000, 'co-member presence');
  return { ...t, g };
}

test('a group between three PCs: messages all ways, waiting then delivered, edits, reactions, rename, icon', async () => {
  const { A, B, C, a, b, c, g } = await group(['ga1', 'gb1', 'gc1']);
  assert.equal(B.db.get('SELECT state FROM friends WHERE user = ? AND other = ?', b.id, c.id), undefined, 'B and C stay strangers');
  // The same people again: the same group.
  assert.equal((await a.ok('dm.open', { users: [c.id, b.id] })).id, g);

  const m1 = mid();
  await a.ok('msg.send', { conv: g, id: m1, text: 'hello both' });
  const w = await a.next('msg.state', (d) => d.id === m1 && d.state === 'waiting');
  assert.equal(w.conv, g);
  await a.next('msg.state', (d) => d.id === m1 && d.state === 'delivered', 10_000);
  await b.next('msg', (d) => d.m.id === m1);
  await c.next('msg', (d) => d.m.id === m1);

  const m2 = mid();
  await b.ok('msg.send', { conv: g, id: m2, text: 'from bob' });
  await a.next('msg', (d) => d.m.id === m2);
  const atC = await c.next('msg', (d) => d.m.id === m2, 10_000);
  assert.equal(atC.m.author, b.id, 'C shows the message as B’s, a person C only knows from the group');
  await b.next('msg.state', (d) => d.id === m2 && d.state === 'delivered', 10_000);

  const m3 = mid();
  await c.ok('msg.send', { conv: g, id: m3, text: 'from carol', replyTo: m2 });
  await a.next('msg', (d) => d.m.id === m3);
  await b.next('msg', (d) => d.m.id === m3, 10_000);
  for (const s of [A, B, C]) assert.deepEqual(texts(s, g), ['hello both', 'from bob', 'from carol']);
  assert.equal(B.db.get('SELECT reply_to FROM messages WHERE id = ?', m3).reply_to, m2);
  // The author's time travels with the message.
  assert.equal(B.db.get('SELECT ts FROM messages WHERE id = ?', m1).ts, A.db.get('SELECT ts FROM messages WHERE id = ?', m1).ts);

  // Edits and reactions.
  await b.ok('msg.edit', { conv: g, id: m2, text: 'from bob (edited)' });
  await until(() => A.db.get('SELECT text FROM messages WHERE id = ?', m2).text === 'from bob (edited)' && C.db.get('SELECT text FROM messages WHERE id = ?', m2).text === 'from bob (edited)', 10_000, 'edit everywhere');
  await c.ok('react', { conv: g, id: m1, emoji: '👍', on: true });
  await until(() => A.db.get('SELECT 1 FROM reactions WHERE msg = ? AND user = ?', m1, c.id) && B.db.get('SELECT 1 FROM reactions WHERE msg = ? AND user = ?', m1, c.id), 10_000, 'reaction everywhere');

  // Rename and icon by members other than the owner.
  await c.ok('dm.rename', { dm: g, name: 'Three PCs' });
  await until(() => A.db.get('SELECT name FROM dms WHERE id = ?', g).name === 'Three PCs' && B.db.get('SELECT name FROM dms WHERE id = ?', g).name === 'Three PCs', 10_000, 'renamed everywhere');
  await b.ok('dm.icon', { dm: g, emoji: '🌲', hue: 142 });
  await until(() => A.db.get('SELECT icon FROM dms WHERE id = ?', g).icon === '🌲' && C.db.get('SELECT icon_hue FROM dms WHERE id = ?', g).icon_hue === 142, 10_000, 'icon everywhere');
  assert.ok(A.db.get("SELECT 1 FROM messages WHERE conv = ? AND sys LIKE '%rename%'", g), 'a line says who renamed it');

  // What is never allowed. (Group calls across PCs work since 0.13: tests/server-peer-gcall.test.js.)
  const lan = await guest(A, 'gguest1');
  assert.equal(await a.refused('dm.add', { dm: g, users: [lan.id] }), 'A group can have friends on other PCs or people on this PC, not both.');
  assert.equal(await lan.refused('msg.send', { conv: g, id: mid(), text: 'x' }), 'You don’t have access to this conversation.');
  assert.equal(await b.refused('dm.kick', { dm: g, user: c.id }), 'Only the group’s owner can remove people.');
  // Delivery state in the snapshot: nothing waits now.
  const hello = (await clientFor(A, a.id)).hello;
  assert.deepEqual(hello.peerWaitingN, {});
  // 300 changes at most.
  for (let i = 0; i < 300; i++) A.db.run('INSERT INTO grp_ops (g, id, by, ts, body, sig) VALUES (?, ?, ?, ?, ?, ?)', g, `o_fill${String(i).padStart(12, '0')}`, uidOf(a), 1, '{}', 'x');
  A.peer.groups.state(g); // ignored rows don't change the group
  assert.equal(await a.refused('dm.rename', { dm: g, name: 'more' }), 'This group has had too many changes. Start a new one.');
  A.db.run("DELETE FROM grp_ops WHERE id LIKE 'o_fill%'");
  // The data file section holds the log and the messages.
  const sec = A.peer.groups.section.export({});
  const round = parseGroupsSection(JSON.parse(JSON.stringify(sec)));
  assert.equal(round[0].g, g);
  assert.ok(round[0].msgs.some((m) => m.id === m3 && m.a === uidOf(c) && m.r === m2));
});

test('offline: a member gets it when back; with the author gone too, another member forwards it', async () => {
  let { A, B, C, a, b, c, g } = await group(['ga2', 'gb2', 'gc2']);
  const cUser = c.id, aUser = a.id;
  await c.close();
  await stop(C);
  await until(() => !A.peer.isOnline(uidOf({ id: cUser })) && !B.peer.isOnline(uidOf({ id: cUser })), 10_000, 'C offline');
  const m1 = mid();
  await a.ok('msg.send', { conv: g, id: m1, text: 'while carol is away' });
  await b.next('msg', (d) => d.m.id === m1, 10_000);
  const w = await a.next('msg.state', (d) => d.id === m1 && d.state === 'waiting' && d.waiting === 1, 10_000);
  assert.equal(w.waiting, 1, 'waiting for one person');
  assert.deepEqual((await clientFor(A, aUser)).hello.peerWaitingN, { [g]: { [m1]: 1 } });
  // The author goes away before C is back.
  await a.close();
  const aDir = A.dataDir;
  await stop(A);
  await until(() => !B.peer.isOnline(uidOf({ id: aUser })), 10_000, 'A offline');
  // C comes back: B holds the message and forwards it.
  C = await startPc(registry, { dataDir: C.dataDir });
  pcs.push(C);
  await until(() => texts(C, g).includes('while carol is away'), 20_000, 'forwarded to C');
  const row = C.db.get('SELECT by, via FROM grp_items WHERE g = ? AND id = ?', g, m1);
  assert.equal(row.by, uidOf({ id: aUser }), 'still A’s message');
  assert.equal(row.via, uidOf(b), 'it came through B');
  assert.equal(C.db.get('SELECT author FROM messages WHERE id = ?', m1).author, aUser);
  // A comes back: C's receipt (or A's own queue) clears the wait.
  A = await startPc(registry, { dataDir: aDir });
  pcs.push(A);
  await until(() => A.db.get('SELECT COUNT(*) n FROM grp_pending').n === 0, 20_000, 'delivered to everyone');
  assert.equal(texts(C, g).filter((t) => t === 'while carol is away').length, 1, 'never twice');
});

test('a tampered forwarded item and a stranger’s group change nothing', async () => {
  const { A, B, C, a, b, c, g } = await group(['ga3', 'gb3', 'gc3']);
  const m1 = mid();
  await a.ok('msg.send', { conv: g, id: m1, text: 'genuine' });
  await c.next('msg', (d) => d.m.id === m1, 10_000);
  // B "forwards" A's message to C with different words under A's signature.
  const body = JSON.parse(C.db.get('SELECT body FROM grp_items WHERE g = ? AND id = ?', g, m1).body);
  const forged = { ...body.item, id: mid(), d: { text: 'forged words' } };
  const dropped = C.peer.groups.stats().dropped;
  C.peer._g.DURABLE['grp.item'](uidOf(b), { item: forged, sig: body.sig });
  await until(() => C.peer.groups.stats().dropped > dropped, 8000, 'dropped');
  assert.equal(C.db.get('SELECT 1 FROM messages WHERE id = ?', forged.id), undefined);
  assert.equal(C.db.get('SELECT 1 FROM grp_items WHERE id = ?', forged.id), undefined);

  // A stranger D (friends with nobody) signs a group naming C: C's PC stores nothing.
  const D = await startPc(registry);
  pcs.push(D);
  const d = await signUp(D, registry, 59_999, 'gd3');
  const dUid = uidOf(d);
  const me = D.peer.identity.me();
  const id = 'o_strangerop000001';
  const op = { g: gidFor(dUid, id), id, t: 'create', by: dUid, kver: 1, ts: Date.now(), d: { name: 'spam', members: [uidOf(c)] } };
  assert.ok(opShape(op));
  const sig = signOp(me.ikPriv, op);
  C.peer._g.DURABLE['grp.op'](dUid, { op, sig });
  // The same op passed on by C's friend A: the creator isn't C's friend, so still nothing.
  C.peer._g.DURABLE['grp.op'](uidOf(a), { op, sig });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(C.db.get('SELECT 1 FROM grp_ops WHERE g = ?', op.g), undefined);
  assert.equal(C.db.get('SELECT 1 FROM dms WHERE id = ?', op.g), undefined);
  // Locally, only friends can be added.
  assert.equal(await b.refused('dm.add', { dm: g, users: [c.id] }), 'Pick someone who isn’t here yet.');
  assert.ok(B.db.get('SELECT 1 FROM users WHERE id = ?', c.id));
  assert.equal(await b.refused('dm.open', { users: [a.id, c.id] }), 'You can only add friends to a group with friends on other PCs.');
});

test('remove stops delivery; leave; the owner leaving hands the group on', async () => {
  const { A, B, C, a, b, c, g } = await group(['ga4', 'gb4', 'gc4']);
  await a.ok('dm.kick', { dm: g, user: c.id });
  await c.next('dm.gone', (d) => d.id === g, 10_000);
  await until(() => !hasGroup(C, g), 8000, 'gone on C');
  await until(() => !members(B, g).includes(c.id), 10_000, 'C out on B');
  const m = mid();
  await a.ok('msg.send', { conv: g, id: m, text: 'after carol' });
  await b.next('msg', (d) => d.m.id === m, 10_000);
  await a.next('msg.state', (d) => d.id === m && d.state === 'delivered', 10_000);
  assert.equal(A.db.get("SELECT 1 FROM peer_outbox WHERE peer = ? AND kind = 'grp.item' AND ref = ?", c.id, m), undefined, 'nothing queued for C');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(C.db.get('SELECT 1 FROM messages WHERE id = ?', m), undefined);
  assert.equal(C.db.get('SELECT 1 FROM grp_items WHERE g = ?', g), undefined);
  // The owner leaves: B is the owner now, on both PCs.
  await a.ok('dm.leave', { dm: g });
  await a.next('dm.gone', (d) => d.id === g);
  assert.equal(hasGroup(A, g), false);
  await until(() => B.db.get('SELECT owner FROM dms WHERE id = ?', g)?.owner === b.id, 10_000, 'B owns it');
  assert.ok(B.db.get("SELECT 1 FROM messages WHERE conv = ? AND sys LIKE '%leave%'", g));
  assert.deepEqual(members(B, g), [b.id]);
});

test('an old edit replayed by a forwarder never reverts newer text', async () => {
  const { B, a, b, g } = await group(['ga5', 'gb5', 'gc5']);
  const m = mid();
  await a.ok('msg.send', { conv: g, id: m, text: 'v0' });
  await b.next('msg', (d) => d.m.id === m, 10_000);
  await a.ok('msg.edit', { conv: g, id: m, text: 'v1' });
  await until(() => B.db.get('SELECT text FROM messages WHERE id = ?', m).text === 'v1', 10_000, 'v1');
  const e1 = B.db.get("SELECT id, body FROM grp_items WHERE g = ? AND json_extract(body, '$.item.k') = 'edit'", g);
  await a.ok('msg.edit', { conv: g, id: m, text: 'v2' });
  await until(() => B.db.get('SELECT text FROM messages WHERE id = ?', m).text === 'v2', 10_000, 'v2');
  // B forgets the first edit, then a forwarder hands it over again.
  B.db.run('DELETE FROM grp_items WHERE g = ? AND id = ?', g, e1.id);
  const before = B.peer.groups.stats().itemsIn;
  B.peer._g.DURABLE['grp.item'](uidOf(a), JSON.parse(e1.body));
  await until(() => B.peer.groups.stats().itemsIn > before, 8000, 'old edit taken in');
  assert.equal(B.db.get('SELECT text FROM messages WHERE id = ?', m).text, 'v2');
});

// ---------- The op log, as pure functions ----------
const keys = Array.from({ length: 30 }, () => newSigningKeys());
const U = Array.from({ length: 30 }, (_, i) => `u${'abcdefghijklmnopqrstuvwxyz234567'[i]}${'a'.repeat(14)}`);
let opN = 0;
const opId = () => `o_${String(++opN).padStart(16, '0')}`;
function mkCreate(by, others, ts = 1000) {
  const id = opId();
  return { g: gidFor(by, id), id, t: 'create', by, kver: 1, ts, d: { name: null, members: others } };
}
const mk = (g, t, by, ts, d) => ({ g, id: opId(), t, by, kver: 1, ts, d });
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const view = (st) => JSON.stringify({ ok: st.ok, owner: st.owner, name: st.name, icon: st.icon, m: [...st.members.keys()].sort(), v: [...st.valid].sort() });

test('replay: the same ops in any order give the same group', () => {
  const c = mkCreate(U[0], [U[1], U[2]]);
  const g = c.g;
  const ops = [c,
    mk(g, 'add', U[1], 2000, { uids: [U[3]] }),
    mk(g, 'rename', U[2], 3000, { name: 'one' }),
    mk(g, 'rename', U[3], 3000, { name: 'two' }), // same ts: the id decides
    mk(g, 'remove', U[0], 4000, { uid: U[2] }),
    mk(g, 'remove', U[0], 4000, { uid: U[1] }),
    mk(g, 'icon', U[2], 5000, { emoji: '🌲', hue: 140 }), // by someone removed: ignored
    mk(g, 'leave', U[3], 6000, {}),
  ];
  const ref = view(replay(g, ops));
  for (let i = 0; i < 50; i++) assert.equal(view(replay(g, shuffle(ops))), ref);
  const st = replay(g, ops);
  assert.deepEqual([...st.members.keys()], [U[0]]);
  assert.equal(st.valid.has(ops[6].id), false);
  assert.equal(st.name, 'two');
});

test('replay: 25 members at most, the owner alone removes, the longest-standing member inherits, invalid ops are ignored', () => {
  const c = mkCreate(U[0], U.slice(1, 20));
  const g = c.g;
  const tooMany = mk(g, 'add', U[1], 2000, { uids: U.slice(20, 27) }); // 20 + 7 > 25
  const fits = mk(g, 'add', U[1], 2001, { uids: U.slice(20, 25) });     // 25
  const one = mk(g, 'add', U[2], 2002, { uids: [U[25]] });              // 26: refused
  const notOwner = mk(g, 'remove', U[3], 3000, { uid: U[4] });
  const self = mk(g, 'remove', U[0], 3001, { uid: U[0] });
  const strangerOp = mk(g, 'rename', U[29], 3002, { name: 'x' });
  const wrongG = { ...mkCreate(U[5], [U[0]]), g };                      // a second create, for someone else's id
  const st = replay(g, [c, tooMany, fits, one, notOwner, self, strangerOp, wrongG]);
  assert.equal(st.members.size, MAX_MEMBERS);
  for (const o of [tooMany, one, notOwner, self, strangerOp, wrongG]) assert.equal(st.valid.has(o.id), false, o.t);
  assert.equal(st.owner, U[0]);
  // The owner leaves: earliest join wins, then the lowest uid.
  const leave = mk(g, 'leave', U[0], 4000, {});
  const st2 = replay(g, [c, fits, leave]);
  assert.equal(st2.owner, [...U.slice(1, 20)].sort()[0]);
  // No create, or a create whose id doesn't give g: no group.
  assert.equal(replay(g, [fits]).ok, false);
  assert.equal(replay('dg_aaaaaaaaaaaaaaaaaaaaaaaaaa', [c]).ok, false);
  // 300 ops replay fine.
  const many = [c];
  for (let i = 0; i < 299; i++) many.push(mk(g, 'rename', U[1], 5000 + i, { name: `n${i}` }));
  assert.equal(replay(g, many).name, 'n298');
});

test('items: membership at the item’s time, 30 days, and 24 h after leaving bound back-dating', () => {
  const c = mkCreate(U[0], [U[1]], 1_000_000);
  const g = c.g;
  const leave = mk(g, 'leave', U[1], 2_000_000, {});
  const st = replay(g, [c, leave]);
  const it = (by, ts) => ({ g, id: 'm_aaaaaaaaaaaa', k: 'msg', by, kver: 1, ts, d: { text: 'x' } });
  assert.equal(itemAllowed(st, it(U[1], 1_500_000), 2_000_000 + 3600_000), true, 'written while a member, arrives soon after');
  assert.equal(itemAllowed(st, it(U[1], 1_500_000), 2_000_000 + 25 * 3600_000), false, 'arrives more than a day after the leave');
  assert.equal(itemAllowed(st, it(U[1], 2_500_000), 2_600_000), false, 'written after leaving');
  assert.equal(itemAllowed(st, it(U[2], 1_500_000), 1_600_000), false, 'never a member');
  assert.equal(itemAllowed(st, it(U[0], 1_500_000), 1_500_000 + 31 * 86_400_000), false, 'older than 30 days');
  // Signatures are over the canonical item: any change breaks them.
  const item = it(U[0], 1_500_000);
  const sig = signItem(keys[0].priv, item);
  assert.equal(typeof sig, 'string');
});

test('the data file section round-trips as plain data and refuses junk', () => {
  const c = mkCreate(U[0], [U[1], U[2]]);
  const sig = signOp(keys[0].priv, c);
  const sec = exportGroups([{ g: c.g, name: 'n', icon: null, ops: [{ body: JSON.stringify(c), sig }], msgs: [{ id: 'm_aaaaaaaaaaaa', a: U[1], ts: 5, text: 'hi' }] }]);
  const back = parseGroupsSection(JSON.parse(JSON.stringify(sec)));
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].ops[0].op, c);
  assert.equal(back[0].ops[0].sig, sig);
  assert.deepEqual(back[0].msgs, sec.groups[0].msgs);
  assert.throws(() => parseGroupsSection({ groups: [{ g: c.g, ops: [{ body: '{"t":"nope"}', sig }], msgs: [] }] }));
  assert.throws(() => parseGroupsSection({ groups: 'x' }));
});

test('replay: a removed member’s back-dated op loses to the remove (remove.d.seen)', () => {
  const c = mkCreate(U[0], [U[1], U[2]], 1000);
  const g = c.g;
  const legit = mk(g, 'rename', U[2], 2000, { name: 'kept' });
  const rm = mk(g, 'remove', U[0], 5000, { uid: U[2], seen: [legit.id] });
  assert.ok(opShape(rm));
  assert.equal(opShape(mk(g, 'remove', U[0], 5000, { uid: U[2], seen: ['nope'] })), false);
  // U[2], already removed, signs an add of a second account dated just before the removal.
  const back = mk(g, 'add', U[2], 4999, { uids: [U[3]] });
  for (const ops of [[c, legit, rm, back], shuffle([c, legit, rm, back])]) {
    const st = replay(g, ops);
    assert.deepEqual([...st.members.keys()].sort(), [U[0], U[1]].sort());
    assert.equal(st.valid.has(back.id), false, 'the back-dated add is dropped');
    assert.equal(st.valid.has(legit.id), true, 'what the owner had seen stays');
    assert.equal(st.name, 'kept');
  }
  // Re-added later, their new ops count again.
  const readd = mk(g, 'add', U[0], 6000, { uids: [U[2]] });
  const after = mk(g, 'rename', U[2], 7000, { name: 'back' });
  assert.equal(replay(g, [c, legit, rm, back, readd, after]).name, 'back');
});

test('a member can’t hide someone’s message by sending its id first; removing a member ends the wait for them', async () => {
  const { A, B, C, a, b, c, g } = await group(['ga6', 'gb6', 'gc6']);
  const bUid = uidOf(b);
  // B signs its own item under the id A is about to use and hands it to C first.
  const m1 = mid();
  const squat = { g, id: m1, k: 'msg', by: bUid, kver: B.peer._g.kver(), ts: Date.now(), d: { text: 'squatted' } };
  C.peer._g.DURABLE['grp.item'](bUid, { item: squat, sig: signItem(B.peer.identity.me().ikPriv, squat) });
  await until(() => texts(C, g).includes('squatted'), 8000, 'squat stored');
  await a.ok('msg.send', { conv: g, id: m1, text: 'the real one' });
  await until(() => texts(C, g).includes('the real one'), 10_000, 'A’s message still reaches C');
  const real = C.db.get('SELECT id, author FROM messages WHERE conv = ? AND text = ?', g, 'the real one');
  assert.equal(real.author, a.id, 'under A’s name');
  assert.notEqual(real.id, m1, 'with an id of its own on C');
  assert.equal(C.db.get('SELECT COUNT(*) n FROM grp_items WHERE g = ? AND id = ?', g, m1).n, 2);
  await a.next('msg.state', (d) => d.id === m1 && d.state === 'delivered', 10_000);

  // C goes offline; A writes; A removes C: nobody is waited for any more.
  const cUser = c.id;
  await c.close();
  await stop(C);
  await until(() => !A.peer.isOnline(uidOf({ id: cUser })), 10_000, 'C offline');
  const m2 = mid();
  await a.ok('msg.send', { conv: g, id: m2, text: 'before removing carol' });
  await a.next('msg.state', (d) => d.id === m2 && d.state === 'waiting' && d.waiting === 1, 10_000);
  await a.ok('dm.kick', { dm: g, user: cUser });
  await a.next('msg.state', (d) => d.id === m2 && d.state === 'delivered', 10_000);
  assert.equal(A.db.get('SELECT COUNT(*) n FROM grp_pending WHERE g = ?', g).n, 0);
  assert.deepEqual((await clientFor(A, a.id)).hello.peerWaitingN, {});
});

test('REG-M3: a member who floods the op log can’t freeze the group: the owner still removes them, everywhere', async () => {
  const { A, B, C, a, b, c, g } = await group(['ga9', 'gb9', 'gc9']);
  const cUid = uidOf(c);
  const cKey = C.peer.identity.me();
  // C's modified client signs 300 cheap renames and sends them to A and B.
  const t0 = Date.now() - 5000;
  for (let i = 0; i < 300; i++) {
    const op = { g, id: `o_flood${String(i).padStart(11, '0')}`, t: 'rename', by: cUid, kver: C.peer._g.kver(), ts: t0 + i, d: { name: `spam ${i}` } };
    const sig = signOp(cKey.ikPriv, op);
    A.peer._g.DURABLE['grp.op'](cUid, { op, sig });
    B.peer._g.DURABLE['grp.op'](cUid, { op, sig });
  }
  await new Promise((r) => setTimeout(r, 1500));
  const byC = (S) => S.db.get('SELECT COUNT(*) n FROM grp_ops WHERE g = ? AND by = ?', g, cUid).n;
  assert.ok(byC(A) <= 31 && byC(B) <= 31, `a per-member quota: A ${byC(A)}, B ${byC(B)}`);
  // The owner removes the abuser, and every PC agrees.
  await a.ok('dm.kick', { dm: g, user: c.id });
  await until(() => !members(A, g).includes(c.id) && !members(B, g).includes(c.id), 10_000, 'C removed on A and B');
  assert.equal(B.peer.groups.state(g).members.has(cUid), false);
  // Others can still change the group.
  await b.ok('dm.rename', { dm: g, name: 'calm again' });
  await until(() => A.db.get('SELECT name FROM dms WHERE id = ?', g).name === 'calm again', 10_000, 'rename after the flood');
});

test('REG-M3: at the 300-op cap, the owner’s remove and a member’s leave still go through', async () => {
  const { A, B, a, b, c, g } = await group(['ga10', 'gb10', 'gc10']);
  for (let i = 0; i < 300; i++) A.db.run('INSERT INTO grp_ops (g, id, by, ts, body, sig) VALUES (?, ?, ?, ?, ?, ?)', g, `o_fill${String(i).padStart(12, '0')}`, uidOf(a), 1, '{}', 'x');
  A.peer.groups.state(g);
  assert.equal(await a.refused('dm.rename', { dm: g, name: 'more' }), 'This group has had too many changes. Start a new one.');
  await a.ok('dm.kick', { dm: g, user: c.id });
  assert.ok(!members(A, g).includes(c.id), 'remove allowed at the cap');
  await b.ok('dm.leave', { dm: g });
  await until(() => !members(A, g).includes(b.id), 10_000, 'B’s leave reaches A at the cap');
  A.db.run("DELETE FROM grp_ops WHERE id LIKE 'o_fill%'");
});

test('REG-M3 (review): a flood of leave ops can’t fill the log past the owner’s room for removes', async () => {
  const { A, C, a, b, c, g } = await group(['ga11', 'gb11', 'gc11']);
  const cUid = uidOf(c);
  const cKey = { ...C.peer.identity.me(), kver: C.peer._g.kver() };
  // C's modified client signs 400 leave ops (each a new id) and sends them to A, the owner.
  const t0 = Date.now() - 5000;
  for (let i = 0; i < 400; i++) {
    const op = { g, id: `o_leave${String(i).padStart(11, '0')}`, t: 'leave', by: cUid, kver: cKey.kver, ts: t0 + i, d: {} };
    A.peer._g.DURABLE['grp.op'](cUid, { op, sig: signOp(cKey.ikPriv, op) });
  }
  await new Promise((r) => setTimeout(r, 1500));
  const byC = A.db.get('SELECT COUNT(*) n FROM grp_ops WHERE g = ? AND by = ?', g, cUid).n;
  assert.ok(byC <= 31, `leave ops by one member are bounded too: ${byC}`);
  // The owner can still remove someone and others can still change the group.
  await a.ok('dm.kick', { dm: g, user: b.id });
  assert.ok(!members(A, g).includes(b.id), 'remove still allowed');
});

test('REG-M3 (review): a member’s real leave goes through, the copies after it are held to the quota', async () => {
  const { A, C, a, b, c, g } = await group(['ga12', 'gb12', 'gc12']);
  const cUid = uidOf(c);
  const cKey = { ...C.peer.identity.me(), kver: C.peer._g.kver() };
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    const op = { g, id: `o_leavr${String(i).padStart(11, '0')}`, t: 'leave', by: cUid, kver: cKey.kver, ts: t0 + i, d: {} };
    A.peer._g.DURABLE['grp.op'](cUid, { op, sig: signOp(cKey.ikPriv, op) });
  }
  await until(() => !members(A, g).includes(c.id), 10_000, 'C’s first leave applied on A');
  await new Promise((r) => setTimeout(r, 1000));
  const byC = A.db.get('SELECT COUNT(*) n FROM grp_ops WHERE g = ? AND by = ?', g, cUid).n;
  assert.ok(byC <= 31, `copies of the leave are bounded: ${byC}`);
  await a.ok('dm.kick', { dm: g, user: b.id });
  assert.ok(!members(A, g).includes(b.id), 'remove still allowed');
});
