// Big files between PCs (server/peerblob.js, server/peer.js): progress while a
// friend's file arrives, a cut transfer resuming from the bytes already on disk,
// and the capability flag that keeps files over 10 MB away from 0.11 PCs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createBlobs } from '../server/peerblob.js';
import { P2P_MAX_FILE, OLD_MAX_FILE, peerMaxFile } from '../server/peer.js';
import { startRegistry, startPc, signUp, until, mid } from './helpers/p2p.js';
import { dmIdFor } from '../server/peercrypto.js';

// Two blob stores wired to each other in memory: `sender` serves, `receiver` fetches.
function pair({ cutAfter = Infinity } = {}) {
  const dirS = mkdtempSync(join(tmpdir(), 'snug-blob-s-'));
  const dirR = mkdtempSync(join(tmpdir(), 'snug-blob-r-'));
  const rows = new Map();
  const db = { get: (_q, id) => rows.get(id) || (id && [...rows.values()].find((r) => r.hash === id) && { file: [...rows.values()].find((r) => r.hash === id).id }), run() {} };
  let parts = 0;
  let up = true;
  const progress = [];
  const S = createBlobs({ db, filesDir: dirS, stats: { blobsFetched: 0 }, canServe: () => true, sendEph: (uid, t, d) => { if (!up) return false; queueMicrotask(() => (t === 'blob.part' ? (++parts > cutAfter ? (up = false) : R.onPart('s', d)) : R.onMiss('s', d))); return true; } });
  const R = createBlobs({ db, filesDir: dirR, stats: { blobsFetched: 0 }, canServe: () => false, onProgress: (id, got, size) => progress.push([id, got, size]), sendEph: (uid, t, d) => { if (!up) return false; queueMicrotask(() => S.serve('r', d)); return true; } });
  const add = (id, data) => {
    writeFileSync(join(dirS, id), data);
    const hash = createHash('sha256').update(data).digest('base64url');
    rows.set(id, { id, size: data.length, meta: JSON.stringify({ hash }), hash });
    return hash;
  };
  return { S, R, add, dirR, progress, reconnect: () => { up = true; parts = 0; cutAfter = Infinity; }, done: () => { rmSync(dirS, { recursive: true, force: true }); rmSync(dirR, { recursive: true, force: true }); } };
}

test('a friend’s file reports progress as it arrives, and is kept only when the hash matches', async () => {
  const p = pair();
  const data = randomBytes(600 * 1024);
  const h = p.add('f_src0000001', data);
  const ok = await p.R.fetch('s', { h, size: data.length, id: 'f_rdst000001', cap: P2P_MAX_FILE });
  assert.equal(ok, true);
  assert.ok(p.progress.length >= 2, 'more than one progress report');
  assert.deepEqual(p.progress.at(-1), ['f_rdst000001', data.length, data.length]);
  assert.ok(p.progress.every(([, got], i) => i === 0 || got >= p.progress[i - 1][1]));
  p.done();
});

test('a cut transfer keeps its bytes, and the next try carries on from them', async () => {
  const p = pair({ cutAfter: 20 });
  const data = randomBytes(1200 * 1024);
  const h = p.add('f_src0000002', data);
  const job = { h, size: data.length, id: 'f_rdst000002', cap: P2P_MAX_FILE };
  const first = p.R.fetch('s', job);
  await new Promise((r) => setTimeout(r, 50));
  p.R.peerDown('s'); // the link drops
  assert.equal(await first, false);
  const part = join(p.dirR, 'f_rdst000002.part');
  assert.ok(existsSync(part), 'the bytes so far are kept');
  const kept = statSync(part).size;
  assert.ok(kept > 0 && kept < data.length);
  p.reconnect();
  p.progress.length = 0;
  assert.equal(await p.R.fetch('s', job), true);
  assert.ok(p.progress[0][1] >= kept, 'it did not start again from zero');
  p.done();
});

test('a cut transfer whose bytes turn out wrong starts over instead of keeping them', async () => {
  const p = pair();
  const data = randomBytes(100 * 1024);
  const h = p.add('f_src0000003', data);
  writeFileSync(join(p.dirR, 'f_rdst000003.part'), randomBytes(30 * 1024)); // junk left from before
  assert.equal(await p.R.fetch('s', { h, size: data.length, id: 'f_rdst000003', cap: P2P_MAX_FILE }), false, 'the hash check fails once');
  assert.equal(existsSync(join(p.dirR, 'f_rdst000003.part')), false, 'and the junk is gone');
  assert.equal(await p.R.fetch('s', { h, size: data.length, id: 'f_rdst000003', cap: P2P_MAX_FILE }), true);
  p.done();
});

test('peerMaxFile: a PC that says nothing is a 0.11 PC and takes 10 MB; a 0.12 PC says how much it takes', () => {
  assert.equal(OLD_MAX_FILE, 10 * 1024 * 1024);
  assert.equal(P2P_MAX_FILE, 100 * 1024 * 1024);
  assert.equal(peerMaxFile(null), OLD_MAX_FILE);
  assert.equal(peerMaxFile('{"avatar":null}'), OLD_MAX_FILE);
  assert.equal(peerMaxFile(JSON.stringify({ maxFile: P2P_MAX_FILE })), P2P_MAX_FILE);
  assert.equal(peerMaxFile(JSON.stringify({ maxFile: 5 })), OLD_MAX_FILE, 'never below the old rule');
  assert.equal(peerMaxFile(JSON.stringify({ maxFile: 10 ** 12 })), P2P_MAX_FILE, 'never above what this PC sends');
});

test('between PCs: a 12 MB file goes to a friend whose Snug takes it; a friend on 0.11 gets a clear refusal instead', async () => {
  const registry = await startRegistry();
  const A = await startPc(registry), B = await startPc(registry);
  try {
    const a = await signUp(A, registry, 7001, 'bigalice');
    const b = await signUp(B, registry, 7002, 'bigbob');
    await a.ok('friend.request', { handle: 'bigbob' });
    const req = await b.next('friend', (d) => d.friend?.state === 'incoming');
    await b.ok('friend.accept', { user: req.id });
    await a.next('friend', (d) => d.friend?.state === 'friends');
    const ua = a.id.slice(2), ub = b.id.slice(2);
    await until(() => A.peer.isOnline(ub) && B.peer.isOnline(ua), 8000, 'presence');
    // Each PC's profile says how big a file it takes.
    await until(() => (JSON.parse(A.db.get('SELECT media FROM peers WHERE uid = ?', ub)?.media || '{}').maxFile) === P2P_MAX_FILE, 8000, 'B says 100 MB');
    const dm = dmIdFor(ua, ub);
    await a.ok('dm.open', { users: [b.id] });
    const big = Buffer.concat([Buffer.from('PK\u0003\u0004'), randomBytes(12 * 1024 * 1024)]);
    const up = await (await fetch(`${A.base}/api/files?conv=${dm}`, { method: 'POST', headers: { cookie: a.cookie, origin: A.base, 'content-type': 'application/zip', 'x-file-name': 'big.zip' }, body: big })).json();
    const id = mid();
    await a.ok('msg.send', { conv: dm, id, text: 'the big one', files: [{ id: up.id }] });
    const got = await b.next('msg', (d) => d.m.id === id, 8000);
    assert.equal(got.m.files[0].size, big.length, 'the message arrived with its file, not refused as a bad attachment');
    // Pretend B is still on 0.11: its profile never said how big a file it takes.
    A.db.run("UPDATE peers SET media = '{}' WHERE uid = ?", ub);
    const id2 = mid();
    const err = await a.refused('msg.send', { conv: dm, id: id2, text: 'too big for them', files: [{ id: up.id }] });
    assert.match(err, /bigbob’s Snug takes files up to 10 MB/);
    assert.equal(A.db.get('SELECT 1 FROM messages WHERE id = ?', id2), undefined, 'nothing was stored or queued');
    // A small file still goes.
    const small = await (await fetch(`${A.base}/api/files?conv=${dm}`, { method: 'POST', headers: { cookie: a.cookie, origin: A.base, 'content-type': 'text/plain', 'x-file-name': 'a.txt' }, body: 'hello' })).json();
    await a.ok('msg.send', { conv: dm, id: mid(), text: 'small', files: [{ id: small.id }] });
    a.close(); b.close();
  } finally {
    await A.close(); await B.close(); await registry.close();
  }
});
