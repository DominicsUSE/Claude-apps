// review-media refix item 4: a registry older than quiet watches. Its ready frame has no
// `quiet`, and it ignores quiet uids in watch frames. A PC with presence for friends only
// then keeps the old behaviour: group co-members who aren't friends aren't watched at all,
// so they don't see it online, and group messages between them still flow through a
// common friend (who forwards them). Its own file: the stub changes the registry class
// for the whole process.
process.env.SNUG_GROUP_FWD_MS = '200';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../registry/src/worker.js';
import { startRegistry, until, mid } from './helpers/p2p.js';
import { threePcs, texts, uidOf } from './helpers/groups.js';

// The older registry: no `quiet` in ready, and quiet uids in a watch frame mean nothing.
const baseSend = Hub.prototype.send;
Hub.prototype.send = function send(ws, obj) {
  if (obj?.t === 'ready' && 'quiet' in obj) { const { quiet, ...old } = obj; return baseSend.call(this, ws, old); }
  return baseSend.call(this, ws, obj);
};
const baseWatch = Hub.prototype.onWatch;
Hub.prototype.onWatch = function onWatch(ws, a, f) { const { quiet, ...old } = f || {}; return baseWatch.call(this, ws, a, old); };

let registry;
const pcs = [];
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });

test('older registry (no quiet watches): friends-only presence holds, and group messages between non-friends flow through a common friend', async () => {
  const { A, B, C, a, b, c } = await threePcs(registry, pcs, ['oldana', 'oldbea', 'oldcal']);
  assert.notEqual(B.peer._signal.ready?.quiet, true, 'the stub registry says nothing about quiet watches');
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort().join();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all && members(C) === all, 12_000, 'group on every PC');
  await until(() => C.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(c)), 10_000, 'co-member presence');
  // B: presence for friends only. With no quiet watches, C isn't watched by B at all.
  await b.ok('prefs.set', { prefs: { presenceTo: 'friends' } });
  await until(() => !C.peer.isOnline(uidOf(b)), 10_000, 'C no longer sees B online');
  assert.equal(A.peer.isOnline(uidOf(b)), true, 'a friend still does');
  // Group messages still go both ways between B and C, passed on by A (a friend of both).
  await c.ok('msg.send', { conv: g, id: mid(), text: 'cal to the group, old registry' });
  await until(() => texts(B, g).includes('cal to the group, old registry'), 20_000, 'B gets C’s message');
  await b.ok('msg.send', { conv: g, id: mid(), text: 'bea to the group, old registry' });
  await until(() => texts(C, g).includes('bea to the group, old registry'), 20_000, 'C gets B’s message');
  assert.equal(C.peer.isOnline(uidOf(b)), false, 'C still isn’t shown B online');
});
