// Snug 0.13: deleting a P2P account with "Erase what I wrote" asks friends' and
// co-members' PCs that are online to delete their copies of my messages (in
// direct conversations and groups across PCs) before the account goes. A PC
// that is offline at that moment keeps its copy.
process.env.SNUG_GROUP_FWD_MS = '200';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, until, mid } from './helpers/p2p.js';
import { threePcs, uidOf } from './helpers/groups.js';
import { dmIdFor } from '../server/peercrypto.js';
import { markAuth } from '../server/auth.js';

let registry;
const pcs = [];
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });

const row = (s, id) => s.db.get('SELECT * FROM messages WHERE id = ?', id);

test('erase on delete: online friends’ and co-members’ PCs delete my messages; an offline PC keeps its copy', async () => {
  const { A, B, C, a, b, c } = await threePcs(registry, pcs, ['erana', 'erbea', 'ercal']);
  const ab = dmIdFor(uidOf(a), uidOf(b)), ac = dmIdFor(uidOf(a), uidOf(c));
  await a.ok('dm.open', { users: [b.id] });
  await a.ok('dm.open', { users: [c.id] });
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const m1 = mid(), m2 = mid(), m3 = mid(), keep = mid();
  await a.ok('msg.send', { conv: ab, id: m1, text: 'for bea only' });
  await a.ok('msg.send', { conv: ac, id: m2, text: 'for cal only' });
  await until(() => row(B, m1) && row(C, m2) && B.db.get('SELECT 1 FROM dms WHERE id = ?', g) && C.db.get('SELECT 1 FROM dms WHERE id = ?', g), 12_000, 'messages and group everywhere');
  await a.ok('msg.send', { conv: g, id: m3, text: 'for the group' });
  await b.ok('msg.send', { conv: ab, id: keep, text: 'bea’s own words' });
  await until(() => row(B, m3) && row(C, m3) && row(A, keep), 12_000, 'group message everywhere');
  // Cal's PC goes off before the erase.
  const cDir = C.dataDir;
  await c.close(); await C.close(); pcs.splice(pcs.indexOf(C), 1);
  await until(() => !A.peer.isOnline(uidOf(c)), 10_000, 'Cal offline');

  const token = decodeURIComponent(a.cookie.split('=')[1]);
  markAuth(A.db, token); // signed in on this session a moment ago
  const res = await fetch(`${A.base}/api/account/delete`, { method: 'POST', headers: { cookie: a.cookie, origin: A.base, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'erana', erase: true }) });
  assert.equal(res.status, 200, await res.clone().text());
  // Bea's PC deleted Ana's messages, in their conversation and in the group; her own stays.
  await until(() => row(B, m1)?.deleted && row(B, m3)?.deleted, 10_000, 'deleted on Bea’s PC');
  assert.equal(row(B, keep).deleted, null);
  assert.equal(B.db.get('SELECT state FROM friends WHERE user = ? AND other = ?', b.id, a.id), undefined, 'and Ana left as a friend');
  // Cal's PC was off: when it starts again it still has its copies.
  const { startPc } = await import('./helpers/p2p.js');
  const C2 = await startPc(registry, { dataDir: cDir });
  pcs.push(C2);
  assert.equal(row(C2, m2).deleted, null);
  assert.equal(row(C2, m2).text, 'for cal only');
});
