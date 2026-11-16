// Groups across PCs (design 0.10 section 4): three PCs where A is friends with
// B and with C, and B and C are not friends. Used by tests/server-groups.test.js.
import { startPc, signUp, until } from './p2p.js';

let gh = 50_000;
export const uidOf = (c) => c.id.slice(2);

export async function befriend(a, b, nameB, A, B) {
  await a.ok('friend.request', { handle: nameB });
  const req = await b.next('friend', (d) => d.friend?.state === 'incoming' && d.id === a.id);
  await b.ok('friend.accept', { user: req.id });
  await a.next('friend', (d) => d.id === b.id && d.friend?.state === 'friends');
  await until(() => A.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(a)), 8000, 'presence');
}

// Three PCs: { A, B, C, a, b, c } with A-B and A-C friends.
export async function threePcs(registry, pcs, names) {
  const [na, nb, nc] = names;
  const A = await startPc(registry), B = await startPc(registry), C = await startPc(registry);
  pcs.push(A, B, C);
  const a = await signUp(A, registry, ++gh, na);
  const b = await signUp(B, registry, ++gh, nb);
  const c = await signUp(C, registry, ++gh, nc);
  await befriend(a, b, nb, A, B);
  await befriend(a, c, nc, A, C);
  return { A, B, C, a, b, c };
}

export const groupMsgs = (s, g) => s.db.all('SELECT * FROM messages WHERE conv = ? AND deleted IS NULL AND sys IS NULL ORDER BY ts, seq', g);
export const texts = (s, g) => groupMsgs(s, g).map((m) => m.text);
export const hasGroup = (s, g) => !!s.db.get('SELECT 1 FROM dms WHERE id = ?', g);
