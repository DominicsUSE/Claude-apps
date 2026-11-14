// Peer core units (design 12.2): the crypto envelope, the outbox and its
// epochs, profile versioning, the ids both PCs derive, and the key file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canon, parseCapped, newSigningKeys, newDhKeys, seal, parseBox, boxVerify, boxOpen, hs1Make, hs2Make, hsShape, hsVerify,
  hs2Binds, sessionKeys, frameSeal, frameOpen, profileSign, profileVerify, newer, nextVer, keychangeSign, chainCheck,
  dmIdFor, remoteFileId, remoteMediaId, fingerprint, hkdf, randomEp,
} from '../server/peercrypto.js';
import { openDb } from '../server/db.js';
import { migratePeer, createOutbox, HELD } from '../server/peerdb.js';
import { createIdentity } from '../server/identity.js';

const person = (uid) => { const s = newSigningKeys(), x = newDhKeys(); return { uid, ikPriv: s.priv, ik: s.pub, xkPriv: x.priv, xk: x.pub }; };
const A = person('aaaaaaaaaaaaaaaa');
const B = person('bbbbbbbbbbbbbbbb');

test('canon is stable and refuses what it should', () => {
  assert.equal(canon({ b: 1, a: [true, null, 's', { d: 2, c: 1 }] }), '{"a":[true,null,"s",{"c":1,"d":2}],"b":1}');
  assert.equal(canon({ z: 1, a: 2 }), canon({ a: 2, z: 1 }));
  let deep = 1;
  for (let i = 0; i < 9; i++) deep = [deep];
  assert.throws(() => canon(deep));
  for (const k of ['__proto__', 'constructor', 'prototype']) assert.equal(parseCapped(`{"${k}":1}`, 100), null);
  assert.throws(() => canon({ a: Infinity }));
  assert.throws(() => canon({ a: new Date() }));
  assert.equal(parseCapped('{"a":"xxxxxxxx"}', 5), null, 'byte cap checked before parsing');
  assert.ok(Buffer.isBuffer(hkdf(Buffer.alloc(32), Buffer.alloc(8), 'x', 32)), 'hkdf gives a Buffer');
});

test('sealed box: round trip, wrong recipient, tampering', () => {
  const box = seal(A, B.uid, B.xk, { t: 'friend.request', id: 'k1', ts: 1, from: A.uid, d: { username: 'alice' } });
  const b = parseBox(box);
  assert.ok(b);
  assert.ok(boxVerify(A.uid, B.uid, b, A.ik));
  assert.deepEqual(boxOpen(B, A.uid, b), { t: 'friend.request', id: 'k1', ts: 1, from: A.uid, d: { username: 'alice' } });
  const C = person('cccccccccccccccc');
  assert.throws(() => boxOpen({ ...C, uid: B.uid }, A.uid, b), 'another key cannot open it');
  assert.ok(!boxVerify(A.uid, B.uid, b, C.ik), 'signature is bound to the signer');
  assert.ok(!boxVerify(C.uid, B.uid, b, A.ik), 'and to the claimed sender');
  const bad = { ...b, c: b.c.slice(0, -2) + (b.c.endsWith('A') ? 'BB' : 'AA') };
  assert.ok(!boxVerify(A.uid, B.uid, bad, A.ik));
  assert.throws(() => boxOpen(B, A.uid, bad));
  assert.equal(parseBox('{"v":1}'), null);
});

function handshake() {
  const info = { kver: 1, pv: 5, ep: randomEp(), rx: { ep: '', upto: 0 }, now: Date.now() };
  const { hs: h1, eph: eA } = hs1Make(A, B.uid, info);
  assert.ok(hsShape(h1) && hsVerify(h1, A.ik));
  const { hs: h2, eph: eB } = hs2Make(B, h1, { ...info, ep: randomEp() });
  assert.ok(hsShape(h2) && hsVerify(h2, B.ik) && hs2Binds(h2, h1));
  const sa = { ...sessionKeys('A', eA, h2.e, h1, h2, A.uid, B.uid), nOut: 0, nIn: 0 };
  const sb = { ...sessionKeys('B', eB, h1.e, h1, h2, A.uid, B.uid), nOut: 0, nIn: 0 };
  return { h1, h2, sa, sb };
}

test('handshake: both sides derive the same keys; tampering fails', () => {
  const { h1, h2, sa, sb } = handshake();
  assert.ok(sa.kOut.equals(sb.kIn) && sa.kIn.equals(sb.kOut));
  assert.ok(!sa.kOut.equals(sa.kIn));
  assert.ok(!hsVerify({ ...h1, pv: 6 }, A.ik), 'a changed hs1 fails');
  assert.ok(!hsVerify({ ...h2, kver: 2 }, B.ik), 'a changed hs2 fails');
  assert.ok(!hsVerify(h1, B.ik), 'the wrong key fails');
  assert.ok(!hs2Binds(h2, { ...h1, nA: h2.nB }), 'hs2 is bound to its hs1');
});

test('data frames: in order, replay refused, bound to the session', () => {
  const { h1, sa, sb } = handshake();
  const P1 = canon({ t: 'dm.msg', seq: 1, ts: 1, d: { id: 'm_aaaaaaaa', text: 'hi' } });
  const f1 = JSON.parse(frameSeal(sa, h1.sid, A.ikPriv, P1));
  const f2 = JSON.parse(frameSeal(sa, h1.sid, A.ikPriv, canon({ t: 'typing', seq: 0, ts: 2, d: {} })));
  assert.equal(frameOpen(sb, h1.sid, A.ik, f1).d.text, 'hi');
  assert.equal(frameOpen(sb, h1.sid, A.ik, f1), null, 'the same counter again is a replay');
  assert.equal(frameOpen(sb, h1.sid, A.ik, f2).t, 'typing');
  // A frame for another session id is refused (AAD and signature both bind the sid).
  const other = handshake();
  const f3 = JSON.parse(frameSeal(other.sa, other.h1.sid, A.ikPriv, P1));
  assert.equal(frameOpen(sb, h1.sid, A.ik, { ...f3, s: h1.sid }), null);
  // Signed by someone else inside a valid encryption: refused.
  const f4 = JSON.parse(frameSeal(sa, h1.sid, B.ikPriv, P1));
  assert.equal(frameOpen(sb, h1.sid, A.ik, f4), null);
  // A batch is just a list of frames, handled in order (peerlink unpacks it).
  const batch = JSON.parse(JSON.stringify({ k: 'b', fs: [frameSeal(sa, h1.sid, A.ikPriv, P1), frameSeal(sa, h1.sid, A.ikPriv, P1)] }));
  const seqs = batch.fs.map((s) => frameOpen(sb, h1.sid, A.ik, JSON.parse(s))?.seq);
  assert.deepEqual(seqs, [1, 1]);
});

test('profile signature and (kver, ver) ordering', () => {
  const snap = { uid: A.uid, kver: 1, ver: 1700000000000, ts: 1, p: { name: 'Alice', interests: ['a'] } };
  const sig = profileSign(A.ikPriv, snap);
  assert.ok(profileVerify(A.ik, snap, sig));
  assert.ok(!profileVerify(A.ik, { ...snap, ver: snap.ver + 1 }, sig));
  assert.ok(!profileVerify(A.ik, { ...snap, p: { name: 'Mallory', interests: ['a'] } }, sig));
  assert.ok(!profileVerify(B.ik, snap, sig));
  // A key change wins even with a lower version (a new PC with a slow clock).
  assert.ok(newer([2, 5], [1, 1700000000000]));
  assert.ok(!newer([1, 5], [1, 5]));
  assert.ok(newer([1, 6], [1, 5]));
  assert.ok(!newer([1, 9e12], [2, 1]));
  // ver = max(previous + 1, now): a restored backup still goes up.
  assert.equal(nextVer(10, 5), 11);
  assert.equal(nextVer(10, 50), 50);
  assert.equal(nextVer(0, 50), 50);
});

test('key-change chain: continuous is quiet, a missing prev is loud, older is a downgrade', () => {
  const uid = B.uid;
  const k1 = person(uid), k2 = person(uid), k3 = person(uid);
  const e = (k, kver, prev) => ({ kver, ik: k.ik, xk: k.xk, prev });
  const chain = [e(k1, 1, null), e(k2, 2, keychangeSign(k1.ikPriv, uid, 2, k2.ik, k2.xk)), e(k3, 3, keychangeSign(k2.ikPriv, uid, 3, k3.ik, k3.xk))];
  assert.equal(chainCheck(uid, { kver: 1, ik: k1.ik }, chain), 'quiet');
  assert.equal(chainCheck(uid, { kver: 2, ik: k2.ik }, chain), 'quiet');
  assert.equal(chainCheck(uid, { kver: 3, ik: k3.ik }, chain), 'same');
  assert.equal(chainCheck(uid, { kver: 1, ik: k1.ik }, [chain[0], { ...chain[1], prev: null }, chain[2]]), 'loud', 'an unapproved move');
  assert.equal(chainCheck(uid, { kver: 1, ik: k1.ik }, [chain[1], chain[2]].map((x, i) => (i ? x : { ...x, prev: null })).slice(1)), 'loud', 'pinned key no longer in the chain');
  assert.equal(chainCheck(uid, { kver: 3, ik: k3.ik }, chain.slice(0, 2)), 'downgrade');
  assert.equal(chainCheck(uid, { kver: 1, ik: k1.ik }, [chain[0], e(k1, 2, null)], [{ kver: 1, ik: k1.ik }]), 'downgrade', 'an old key under a new number');
  const forged = keychangeSign(k3.ikPriv, uid, 2, k2.ik, k2.xk);
  assert.equal(chainCheck(uid, { kver: 1, ik: k1.ik }, [chain[0], { ...chain[1], prev: forged }]), 'loud', 'signed by the wrong key');
});

test('ids both PCs agree on, and remote file ids that cannot collide with local ones', () => {
  assert.equal(dmIdFor(A.uid, B.uid), dmIdFor(B.uid, A.uid));
  assert.match(dmIdFor(A.uid, B.uid), /^d_[a-z2-7]{24}$/);
  assert.notEqual(dmIdFor(A.uid, B.uid), dmIdFor(A.uid, 'cccccccccccccccc'));
  const id = remoteFileId(A.uid, 'f_abcdefgh123');
  assert.match(id, /^f_[a-z0-9]{8,40}$/);
  assert.ok(id.startsWith('f_r'));
  assert.notEqual(remoteFileId(A.uid, 'f_abcdefgh123'), remoteFileId(B.uid, 'f_abcdefgh123'), 'per sender');
  assert.notEqual(remoteMediaId(A.uid, 'h'), remoteMediaId(B.uid, 'h'), 'the same picture from two friends never shares a row');
  assert.match(fingerprint(A.ik, A.xk), /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
});

function outboxDb() {
  const db = openDb(':memory:');
  migratePeer(db);
  db.run("INSERT INTO users (id, handle, name, pass, hue, created, remote) VALUES ('u_bbbbbbbbbbbbbbbb', 'bob', 'Bob', '!', 0, 0, 1)");
  db.run("INSERT INTO peers (user, uid, username, ik, xk, kver, pinned_at, out_ep) VALUES ('u_bbbbbbbbbbbbbbbb', 'bbbbbbbbbbbbbbbb', 'bob', ?, ?, 1, 0, 'epepepepepe')", B.ik, B.xk);
  return { db, O: createOutbox(db), u: 'u_bbbbbbbbbbbbbbbb' };
}

test('outbox: ordered seqs, cumulative ack, renumber on a lost epoch', () => {
  const { db, O, u } = outboxDb();
  for (let i = 1; i <= 5; i++) assert.equal(O.push(u, 'dm.msg', `m_${i}`, '{}'), i);
  assert.deepEqual(O.after(u, 2, 2).map((r) => r.seq), [3, 4]);
  assert.deepEqual(O.ack(u, 3).map((r) => r.ref), ['m_1', 'm_2', 'm_3']);
  assert.equal(O.minSeq(u), 4);
  // The friend lost my epoch (new PC, restored backup): pending rows go back to 1..n in order.
  const ep = O.renumber(u);
  assert.notEqual(ep, 'epepepepepe');
  assert.deepEqual(O.after(u, 0).map((r) => [r.seq, r.ref]), [[1, 'm_4'], [2, 'm_5']]);
  const p = db.get('SELECT out_ep, out_seq FROM peers WHERE user = ?', u);
  assert.equal(p.out_ep, ep);
  assert.equal(p.out_seq, 2);
  assert.equal(O.push(u, 'dm.msg', 'm_6', '{}'), 3);
});

test('outbox: a profile not yet sent is replaced in place; a sent one is not', () => {
  const { db, O, u } = outboxDb();
  O.push(u, 'dm.msg', 'm_1', '{}');
  const s1 = O.pushProfile(u, '{"v":1}');
  const s2 = O.pushProfile(u, '{"v":2}');
  assert.equal(s1, s2);
  assert.equal(db.get('SELECT body FROM peer_outbox WHERE seq = ?', s1).body, '{"v":2}');
  // Sent in this link session (sentUpTo covers it): a new row goes after it.
  const s3 = O.pushProfile(u, '{"v":3}', s2);
  assert.equal(s3, s2 + 1);
});

test('outbox: held rows wait aside, the live sequence stays contiguous, release puts them back in order', () => {
  const { db, O, u } = outboxDb();
  O.push(u, 'dm.msg', 'm_old1', '{}', 100);
  O.push(u, 'profile', null, '{}', 100);
  O.push(u, 'dm.msg', 'm_old2', '{}', 100);
  assert.equal(O.hold(u, 200), 2);
  assert.deepEqual(O.heldMsgs(u), ['m_old1', 'm_old2']);
  assert.deepEqual(O.after(u, 0).map((r) => [r.seq, r.kind]), [[1, 'profile']], 'only the profile stays live, renumbered');
  O.push(u, 'dm.msg', 'm_new', '{}', 300);
  assert.deepEqual(O.after(u, 0).map((r) => r.ref), [null, 'm_new']);
  assert.ok(db.get('SELECT MIN(seq) s FROM peer_outbox WHERE kind LIKE ?', 'held:%').s >= HELD);
  O.ack(u, 2);
  assert.equal(O.held(u).length, 2, 'acks never touch held rows');
  assert.deepEqual(O.release(u).map((r) => r.ref), ['m_old1', 'm_old2']);
  assert.deepEqual(O.after(u, 0).map((r) => [r.seq, r.ref]), [[3, 'm_old1'], [4, 'm_old2']]);
  assert.equal(O.held(u).length, 0);
});

test('identity: safeStorage when the key store works, none otherwise, a broken file is set aside', () => {
  const fake = { available: () => true, encrypt: (s) => `ENC:${Buffer.from(s).toString('base64')}`, decrypt: (b) => Buffer.from(b.slice(4), 'base64').toString() };
  const dir = mkdtempSync(join(tmpdir(), 'snug-id-'));
  const db = openDb(':memory:');
  const id1 = createIdentity({ dataDir: dir, keyStore: fake, db });
  assert.equal(id1.ik, null, 'no keys until the first sign-in');
  const { ik } = id1.ensureKeys();
  const file = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
  assert.equal(file.enc, 'safeStorage');
  assert.ok(file.blob.startsWith('ENC:'));
  assert.equal(id1.protected, true);
  assert.equal(createIdentity({ dataDir: dir, keyStore: fake, db }).ik, ik, 'loads the same keys again');

  const dir2 = mkdtempSync(join(tmpdir(), 'snug-id-'));
  const id2 = createIdentity({ dataDir: dir2, keyStore: null, db: openDb(':memory:') });
  id2.ensureKeys();
  assert.equal(JSON.parse(readFileSync(join(dir2, 'identity.json'), 'utf8')).enc, 'none');
  assert.equal(id2.protected, false);

  const dir3 = mkdtempSync(join(tmpdir(), 'snug-id-'));
  const throws = { available: () => true, encrypt: () => { throw new Error('no keyring'); }, decrypt: () => '' };
  createIdentity({ dataDir: dir3, keyStore: throws, db: openDb(':memory:') }).ensureKeys();
  assert.equal(JSON.parse(readFileSync(join(dir3, 'identity.json'), 'utf8')).enc, 'none', 'encrypt throwing falls back (xvfb)');

  // A file this OS user can't decrypt: rotated aside, new keys, and the next sign-in becomes a move.
  const db4 = openDb(':memory:');
  const id4 = createIdentity({ dataDir: dir, keyStore: { ...fake, decrypt: () => { throw new Error('other user'); } }, db: db4 });
  id4.setSelf({ uid: 'aaaaaaaaaaaaaaaa', user: 'u_x', username: 'a', kver: 1, state: 'ok' });
  assert.notEqual(id4.ik, ik);
  assert.equal(id4.self().state, 'needs-signin');
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('identity.broken-')).length, 1);
  assert.equal(id4.dropBroken(), 1);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('identity.broken-')).length, 0);
  assert.ok(existsSync(join(dir, 'identity.json')));
  writeFileSync(join(dir, 'x'), '');

  // In memory only for :memory: servers.
  const mem = createIdentity({ dataDir: ':memory:', db: openDb(':memory:') });
  mem.ensureKeys();
  assert.ok(mem.ik);
  // The signature over a registry string verifies with the public key.
  assert.equal(id2.sign('x').length, 86);
});

import { createBlobs, PART } from '../server/peerblob.js';
import { createHash } from 'node:crypto';
test('blobs: only the next bytes, never past the declared size, checked against the hash; failures leave no .part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snug-blob-'));
  const db = openDb(':memory:');
  migratePeer(db);
  const sent = [];
  const stats = { blobsFetched: 0 };
  const blobs = createBlobs({ db, filesDir: dir, sendEph: (uid, t, d) => { sent.push({ t, d }); return true; }, canServe: () => true, stats });
  const data = Buffer.alloc(PART + 100, 7);
  const h = createHash('sha256').update(data).digest('base64url');
  const parts = (o, n) => ({ h, o, d: data.subarray(o, o + n).toString('base64') });
  // Out of order: aborted.
  let p = blobs.fetch('u1', { h, size: data.length, id: 'f_rtest1aaaaaaaa', cap: 1 << 20 });
  blobs.onPart('u1', parts(100, 100));
  assert.equal(await p, false);
  assert.equal(existsSync(join(dir, 'f_rtest1aaaaaaaa.part')), false);
  // More than declared: aborted.
  p = blobs.fetch('u1', { h, size: 50, id: 'f_rtest2aaaaaaaa', cap: 1 << 20 });
  blobs.onPart('u1', parts(0, 100));
  assert.equal(await p, false);
  assert.equal(existsSync(join(dir, 'f_rtest2aaaaaaaa.part')), false);
  // Declared size over the cap: never started.
  assert.equal(await blobs.fetch('u1', { h, size: 5 << 20, id: 'f_rtest3aaaaaaaa', cap: 1 << 20 }), false);
  // Right bytes, wrong hash: aborted.
  p = blobs.fetch('u1', { h: 'A'.repeat(43), size: 100, id: 'f_rtest4aaaaaaaa', cap: 1 << 20 });
  blobs.onPart('u1', { h: 'A'.repeat(43), o: 0, d: data.subarray(0, 100).toString('base64') });
  assert.equal(await p, false);
  assert.equal(existsSync(join(dir, 'f_rtest4aaaaaaaa')), false);
  // In order, the right size and hash: kept.
  sent.length = 0;
  p = blobs.fetch('u1', { h, size: data.length, id: 'f_rtest5aaaaaaaa', cap: 1 << 20 });
  assert.deepEqual(sent[0], { t: 'blob.get', d: { h, o: 0, n: 8 } }, 'one request at a time, up to 8 parts');
  blobs.onPart('u1', parts(0, PART));
  blobs.onPart('u1', parts(PART, 100));
  assert.equal(await p, true);
  assert.ok(readFileSync(join(dir, 'f_rtest5aaaaaaaa')).equals(data));
  assert.equal(stats.blobsFetched, 1);
  blobs.close();
});
