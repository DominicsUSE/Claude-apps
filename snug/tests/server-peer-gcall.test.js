// Snug 0.13: group calls in groups across PCs. Each member's PC keeps the same
// call: someone joining on their PC is mirrored as their stand-in on the
// others' PCs, and call signalling (rtc, voice state) goes over the PC-to-PC
// links, as for a one-to-one call. Only with PCs that say they understand it
// ('gcall'); with an older member the call is refused and names them.
process.env.SNUG_GROUP_FWD_MS = '200';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, until } from './helpers/p2p.js';
import { threePcs, uidOf } from './helpers/groups.js';

let registry;
const pcs = [];
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });


test('a group call across three PCs: ring, join on each PC, everyone mirrored everywhere, signalling between each pair, hang up', async () => {
  const t = await threePcs(registry, pcs, ['gcana', 'gcbea', 'gccal']);
  const { A, B, C, a, b, c } = t;
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort().join();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all && members(C) === all, 12_000, 'group on every PC');
  await until(() => A.peer.capsOf(uidOf(b)).includes('gcall') && A.peer.capsOf(uidOf(c)).includes('gcall') && B.peer.capsOf(uidOf(a)).includes('gcall') && C.peer.capsOf(uidOf(a)).includes('gcall'), 10_000, 'caps');
  // B and C aren't friends: they need a link of their own for signalling.
  await until(() => B.peer.isOnline(uidOf(c)) && C.peer.isOnline(uidOf(b)), 10_000, 'co-member presence');

  const started = await a.ok('call.start', { dm: g });
  assert.match(started.call, /^call_/);
  // Bea and Cal are rung on their own PCs.
  await b.next('call.ring', (r) => r.dm === g, 10_000);
  await c.next('call.ring', (r) => r.dm === g, 10_000);
  const jb = await b.ok('call.join', { dm: g });
  assert.deepEqual(jb.peers, [a.id], 'Bea calls Ana');
  await until(() => A.hub.voicePlaceOf(b.id) === g, 10_000, 'Bea mirrored on Ana’s PC');
  await until(() => C.hub.voicePlaceOf(b.id) === g && C.hub.voicePlaceOf(a.id) === g, 10_000, 'Ana and Bea mirrored on Cal’s PC');
  const jc = await c.ok('call.join', { dm: g });
  assert.deepEqual([...jc.peers].sort(), [a.id, b.id].sort(), 'Cal calls both');
  for (const s of [A, B]) await until(() => s.hub.voicePlaceOf(c.id) === g, 10_000, 'Cal mirrored');
  for (const [s, me] of [[A, a], [B, b], [C, c]]) {
    for (const u of [a, b, c]) assert.equal(s.hub.voicePlaceOf(u.id), g, `${u.id} in the call on ${me.id}’s PC`);
  }
  // Signalling between each pair goes over the links (B and C aren't friends).
  await c.ok('rtc', { to: b.id, data: { sdp: 'offer-from-cal' } });
  assert.deepEqual((await b.next('rtc', (d) => d.from === c.id, 10_000)).data, { sdp: 'offer-from-cal' });
  await b.ok('rtc', { to: c.id, data: { sdp: 'answer-from-bea' } });
  assert.deepEqual((await c.next('rtc', (d) => d.from === b.id, 10_000)).data, { sdp: 'answer-from-bea' });
  await c.ok('rtc', { to: a.id, data: { sdp: 'offer-to-ana' } });
  assert.deepEqual((await a.next('rtc', (d) => d.from === c.id, 10_000)).data, { sdp: 'offer-to-ana' });
  // Mute is mirrored.
  await b.ok('voice.state', { muted: true });
  await until(() => A.hub.voiceStateOf(b.id)?.muted && C.hub.voiceStateOf(b.id)?.muted, 10_000, 'mute mirrored');
  // Cal hangs up: he leaves the call on every PC; the others stay in it.
  await c.ok('voice.leave');
  for (const s of [A, B]) await until(() => s.hub.voicePlaceOf(c.id) === null, 10_000, 'Cal gone');
  assert.equal(A.hub.voicePlaceOf(b.id), g);
  await a.ok('voice.leave');
  await b.ok('voice.leave');
  for (const s of [A, B, C]) await until(() => !s.hub.callOf(g), 10_000, 'call over everywhere');

  // A member whose PC is older: the call is refused, naming them.
  A.peer._setCaps(uidOf(c), ['thread', 'pin', 'ttl', 'poll']);
  const err = await a.refused('call.start', { dm: g });
  assert.match(err, /gccal/);
  A.peer._setCaps(uidOf(c), null);
});

test('a group call survives a short drop in one PC’s registry connection: the others mirror it again once it is back', async () => {
  const { A, B, C, a, b, c } = await threePcs(registry, pcs, ['flana', 'flbea', 'flcal']);
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort().join();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all && members(C) === all, 12_000, 'group');
  await until(() => A.peer.capsOf(uidOf(b)).includes('gcall') && A.peer.capsOf(uidOf(c)).includes('gcall') && C.peer.capsOf(uidOf(a)).includes('gcall'), 10_000, 'caps');
  await until(() => B.peer.isOnline(uidOf(c)) && C.peer.isOnline(uidOf(b)), 10_000, 'co-member presence');
  await a.ok('call.start', { dm: g });
  await b.next('call.ring', (r) => r.dm === g, 10_000);
  await b.ok('call.join', { dm: g });
  await c.next('call.ring', (r) => r.dm === g, 10_000).catch(() => {});
  await c.ok('call.join', { dm: g });
  for (const s of [A, B, C]) for (const u of [a, b, c]) await until(() => s.hub.voicePlaceOf(u.id) === g, 10_000, 'all in the call everywhere');
  // Cal's PC loses its registry connection for a moment, then reconnects.
  C.peer._signal.stop();
  await until(() => !A.peer.isOnline(uidOf(c)), 10_000, 'Ana’s PC sees Cal offline');
  C.peer._signal.start();
  await until(() => A.peer.isOnline(uidOf(c)) && C.peer.isOnline(uidOf(a)) && B.peer.isOnline(uidOf(c)), 15_000, 'Cal back online');
  assert.equal(C.hub.voicePlaceOf(c.id), g, 'Cal never left the call on his own PC');
  for (const s of [A, B, C]) for (const u of [a, b, c]) await until(() => s.hub.voicePlaceOf(u.id) === g, 10_000, 'everyone in the call on every PC again');
});
