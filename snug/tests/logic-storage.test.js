// This device's copy of messages, sealed under the device storage key (0.14, js/lib/devicecopy.js over
// js/e2ee/store.js): seal and open, the move of 0.13 plaintext localStorage entries (read, seal, delete),
// and sealed private keys (S4). Runs in Node with its WebCrypto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { _test as T } from '../js/e2ee/store.js';
import { b64u, random } from '../js/lib/e2ee/bytes.js';
import { COPY_NAMES, migrateCopy, readCopy, copyWriter } from '../js/lib/devicecopy.js';

const os = (secret) => async () => ({ protected: true, key: secret });
function fakeLocal(entries = {}) {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()], m };
}
const SECRET_TEXT = 'meet me by the old oak at nine';

test('S3: the device copy is sealed under SK; nothing readable is kept; a write replaces the last one', async () => {
  const kv = T.mapKv();
  const st = T.wrap(kv, 'snug-e2ee:u1', os(b64u(random(32))));
  const w = copyWriter(st);
  w.write('cache', JSON.stringify({ me: 'u1', msgs: { r1: [{ id: 'm1', text: SECRET_TEXT }] } }));
  w.write('drafts', JSON.stringify({ r1: `draft: ${SECRET_TEXT}` }));
  w.write('drafts', JSON.stringify({ r1: 'newer draft' })); // writes land in order
  await w.idle();
  assert.equal(st.protection(), 'os');
  for (const k of await kv.keys('meta')) {
    const box = await kv.get('meta', k);
    assert.ok(box.iv && box.ct, `${k} is an AES-GCM box`);
    assert.ok(!Buffer.from(box.ct).toString('latin1').includes('oak'), `${k} holds no plaintext`);
  }
  const back = await readCopy(st);
  assert.equal(back.cache.msgs.r1[0].text, SECRET_TEXT);
  assert.deepEqual(back.drafts, { r1: 'newer draft' });
  assert.equal(back.ops, null);
  // Deleted (sign-out): gone.
  w.write('cache', null);
  await w.idle();
  assert.equal((await readCopy(st)).cache, null);
  // Another secret (the data copied to another computer) opens nothing.
  await assert.rejects(readCopy(T.wrap(kv, 'snug-e2ee:u1', os(b64u(random(32))))));
});

test('S3: the 0.13 plaintext entries are moved on the first run: read, sealed, deleted from localStorage', async () => {
  const kv = T.mapKv();
  const st = T.wrap(kv, 'snug-e2ee:u1', os(b64u(random(32))));
  const ls = fakeLocal({
    [COPY_NAMES.cache]: JSON.stringify({ me: 'u1', msgs: { r1: [{ id: 'm1', text: SECRET_TEXT }] } }),
    [COPY_NAMES.drafts]: JSON.stringify({ r1: SECRET_TEXT }),
    [COPY_NAMES.reply]: JSON.stringify({ r1: 'm1' }),
    [COPY_NAMES.ops]: JSON.stringify({ user: 'u1', ops: [{ op: 'msg.edit', d: { id: 'm1', text: SECRET_TEXT } }] }),
    [COPY_NAMES.files]: JSON.stringify({ r1: [{ id: 'f_1', name: 'notes.txt' }] }),
    'snug.prefs': JSON.stringify({ theme: 'dark' }),
  });
  const moved = await migrateCopy(ls, st, 'u1');
  assert.deepEqual(moved.sort(), ['cache', 'drafts', 'files', 'ops', 'reply']);
  assert.deepEqual(ls.keys(), ['snug.prefs'], 'only settings stay in localStorage');
  assert.ok(![...ls.m.values()].join('').includes('oak'));
  const back = await readCopy(st);
  assert.equal(back.cache.msgs.r1[0].text, SECRET_TEXT);
  assert.deepEqual(back.drafts, { r1: SECRET_TEXT });
  assert.deepEqual(back.reply, { r1: 'm1' });
  assert.equal(back.ops.ops[0].d.text, SECRET_TEXT);
  assert.equal(back.files.r1[0].id, 'f_1');
  // A second run moves nothing; a newer sealed entry is never overwritten by a stale plaintext one.
  assert.deepEqual(await migrateCopy(ls, st, 'u1'), []);
  const w = copyWriter(st);
  w.write('drafts', JSON.stringify({ r1: 'typed after the move' }));
  await w.idle();
  ls.setItem(COPY_NAMES.drafts, JSON.stringify({ r1: 'stale' }));
  await migrateCopy(ls, st, 'u1');
  assert.deepEqual((await readCopy(st)).drafts, { r1: 'typed after the move' });
  assert.equal(ls.getItem(COPY_NAMES.drafts), null, 'the stale plaintext is deleted all the same');
  // Someone else's plaintext cache is deleted, never moved into this account.
  ls.setItem(COPY_NAMES.cache, JSON.stringify({ me: 'u2', msgs: { r9: [{ id: 'm9', text: 'not yours' }] } }));
  await migrateCopy(ls, st, 'u1');
  assert.equal(ls.getItem(COPY_NAMES.cache), null);
  assert.equal((await readCopy(st)).cache.me, 'u1');
});

test('S4: a private key sealed as PKCS#8 under SK comes back as a working non-extractable key; another secret opens nothing', async () => {
  const sig = await import('../js/lib/e2ee/sig.js');
  const kv = T.mapKv();
  const secret = b64u(random(32));
  const st = T.wrap(kv, 'snug-e2ee:u1', os(secret));
  const pair = await sig.newDhPair(true);
  const pkcs8 = await sig.pkcs8Of(pair.privateKey);
  const box = await st.sealBytes('snug-e2ee-v1/prekey\nd_1\n2', pkcs8);
  assert.ok(!Buffer.from(box.ct).includes(Buffer.from(pkcs8.subarray(-32))), 'the private key bytes are not in the box');
  const back = await T.wrap(kv, 'snug-e2ee:u1', os(secret)).openBytes('snug-e2ee-v1/prekey\nd_1\n2', box);
  const opened = await sig.importDhPair(back, await sig.rawPublic(pair.publicKey));
  assert.equal(opened.privateKey.extractable, false);
  const peer = await sig.newDhPair(false);
  const a = await crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey }, pair.privateKey, 256);
  const b = await crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey }, opened.privateKey, 256);
  assert.deepEqual(Buffer.from(a), Buffer.from(b), 'the same key');
  await assert.rejects(st.openBytes('snug-e2ee-v1/prekey\nd_1\n3', box), 'bound to its label');
  await assert.rejects(T.wrap(kv, 'snug-e2ee:u1', os(b64u(random(32)))).openBytes('snug-e2ee-v1/prekey\nd_1\n2', box));
  // The signing key the same way.
  const dsk = await sig.newSigningPair(true);
  const dbox = await st.sealBytes('snug-e2ee-v1/dsk\nd_1', await sig.pkcs8Of(dsk.privateKey));
  const dpriv = await sig.importSigning(await st.openBytes('snug-e2ee-v1/dsk\nd_1', dbox));
  const msg = new TextEncoder().encode('bind');
  assert.ok(await crypto.subtle.verify({ name: 'Ed25519' }, dsk.publicKey, await sig.signBytes(dpriv, msg), msg));
});
