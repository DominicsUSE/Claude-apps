// End-to-end encryption of call media (calls C1, js/lib/callcrypt.js): each
// encoded frame is sealed with AES-256-GCM under the sender's call key, the
// codec's own header bytes stay readable so the packetiser still works, and
// the frame ends with [counter (8) | key id (1)]. A receiver drops anything
// that doesn't open once a sender has started encrypting to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCrypto, sealFrame, openFrame, clearBytes, frameKey, TRAILER, KEEP_OLD_MS } from '../js/lib/callcrypt.js';

const raw = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 255);
const frame = (n, fill = 0x42) => Uint8Array.from({ length: n }, (_, i) => (i < 10 ? 0x90 + i : fill + (i & 15)));

test('clear bytes: VP8 keeps 10 (key frame) or 3 (delta) header bytes, Opus 1; other video codecs are not encrypted', () => {
  assert.equal(clearBytes({ kind: 'audio' }), 1);
  assert.equal(clearBytes({ kind: 'video', type: 'key', mime: 'video/VP8' }), 10);
  assert.equal(clearBytes({ kind: 'video', type: 'delta', mime: 'video/VP8' }), 3);
  assert.equal(clearBytes({ kind: 'video', type: 'delta' }), 3, 'no codec reported: treated as VP8, the codec Snug asks for');
  assert.equal(clearBytes({ kind: 'video', type: 'key', mime: 'video/H264' }), null, 'H264 is parsed by the packetiser: left alone');
});

test('round trip: header in the clear, payload and tag sealed, trailer of counter and key id; tampering and the wrong key fail', async () => {
  const key = await frameKey(raw(1));
  const pt = frame(200);
  const sealed = await sealFrame(key, 7, { hi: 0, lo: 41 }, pt, 10);
  assert.equal(sealed.length, 200 + 16 + TRAILER);
  assert.deepEqual([...sealed.subarray(0, 10)], [...pt.subarray(0, 10)], 'the VP8 header stays readable');
  assert.notDeepEqual([...sealed.subarray(10, 200)], [...pt.subarray(10)], 'the picture is not');
  assert.equal(sealed.at(-1), 7, 'key id last');
  assert.deepEqual([...sealed.subarray(-TRAILER, -1)], [0, 0, 0, 0, 0, 0, 0, 41], 'the counter before it');
  assert.deepEqual([...(await openFrame(key, sealed, 10))], [...pt]);
  // Any changed byte, header included, fails: the header and trailer are authenticated too.
  for (const at of [0, 9, 10, 100, sealed.length - 12, sealed.length - 2]) {
    const bad = sealed.slice();
    bad[at] ^= 1;
    await assert.rejects(openFrame(key, bad, 10), `byte ${at} changed`);
  }
  await assert.rejects(openFrame(await frameKey(raw(2)), sealed, 10), 'another key');
  await assert.rejects(openFrame(key, sealed.subarray(0, 20), 10), 'too short');
  // A frame shorter than the codec header (an empty or 2-byte frame) still round-trips.
  for (const n of [0, 2]) {
    const tiny = frame(n);
    assert.deepEqual([...(await openFrame(key, await sealFrame(key, 7, { hi: 0, lo: 50 + n }, tiny, 3), 3))], [...tiny], `${n} bytes`);
  }
});

test('FrameCrypto: nothing is encrypted to a person until they acknowledged a key; then always, with a counter that never repeats', async () => {
  const a = new FrameCrypto();
  await a.setSendKey(5, raw(1));
  const audio = frame(60);
  let out = await a.encrypt('bob', audio, 1);
  assert.equal(out.e2ee, false, 'Bob has no key yet: plain');
  assert.deepEqual([...out.data], [...audio]);
  a.useFor('bob', 5);
  const one = await a.encrypt('bob', audio, 1), two = await a.encrypt('cleo', audio, 1);
  assert.equal(one.e2ee, true);
  assert.equal(two.e2ee, false, 'only the people who acknowledged');
  const three = await a.encrypt('bob', audio, 1);
  assert.notDeepEqual([...one.data.subarray(-TRAILER)], [...three.data.subarray(-TRAILER)], 'a fresh counter each frame');
  assert.equal(a.stats().bob.enc, 2);
  assert.equal(a.stats().bob.plain, 1);
});

test('FrameCrypto: a receiver passes plain frames until the first frame opens, then drops anything that does not open', async () => {
  const a = new FrameCrypto(), b = new FrameCrypto();
  await a.setSendKey(9, raw(3));
  await b.addRecvKey('ann', 9, raw(3));
  const pt = frame(120);
  // Before Ann encrypts to Bob (she hasn't seen his acknowledgement), her frames are plain and play.
  assert.deepEqual([...(await b.decrypt('ann', pt, 3)).data], [...pt]);
  a.useFor('bob', 9);
  const s = (await a.encrypt('bob', pt, 3)).data;
  const got = await b.decrypt('ann', s, 3);
  assert.equal(got.e2ee, true);
  assert.deepEqual([...got.data], [...pt]);
  // From now on: a plain frame, a tampered frame or one under an unknown key is dropped, never played.
  assert.equal((await b.decrypt('ann', pt, 3)).data, null, 'plain after encrypted: dropped (no silent downgrade)');
  const bad = s.slice(); bad[50] ^= 0xff;
  assert.equal((await b.decrypt('ann', bad, 3)).data, null, 'tampered: dropped');
  const other = new FrameCrypto();
  await other.setSendKey(9, raw(4));
  other.useFor('bob', 9);
  assert.equal((await b.decrypt('ann', (await other.encrypt('bob', pt, 3)).data, 3)).data, null, 'a frame under another key with the same id: dropped');
  assert.equal(b.stats().ann.drop, 3);
  assert.equal((await b.decrypt('ann', new Uint8Array(0), 1)).data.length, 0, 'an empty frame (the browser makes some) carries nothing: it goes on');
  assert.equal(b.stats().ann.strict, true);
  // Someone else's frames are judged on their own.
  assert.equal((await b.decrypt('cleo', s, 3)).e2ee, false);
});

test('FrameCrypto: rotation on join and leave; the old key is kept about 2 s after the new one is in use, then wiped; key ids roll over', async () => {
  let now = 1000;
  const clock = () => now;
  const a = new FrameCrypto({ now: clock }), b = new FrameCrypto({ now: clock });
  await a.setSendKey(255, raw(5));
  await b.addRecvKey('ann', 255, raw(5));
  a.useFor('bob', 255);
  const pt = frame(80);
  const old = (await a.encrypt('bob', pt, 1)).data;
  assert.ok((await b.decrypt('ann', old, 1)).data);
  // Someone left: Ann makes key 0 (255 rolls over), Bob acknowledges, Ann switches.
  await a.setSendKey(0, raw(6));
  await b.addRecvKey('ann', 0, raw(6));
  a.useFor('bob', 0);
  assert.deepEqual(a.sendKeyIds(), [0], 'the sender forgets a key nobody uses any more');
  const fresh = (await a.encrypt('bob', pt, 1)).data;
  assert.equal(fresh.at(-1), 0);
  assert.ok((await b.decrypt('ann', fresh, 1)).data);
  assert.ok((await b.decrypt('ann', old, 1)).data, 'a late frame under the old key still opens for a moment');
  now += KEEP_OLD_MS + 1;
  assert.ok((await b.decrypt('ann', fresh, 1)).data);
  assert.equal((await b.decrypt('ann', old, 1)).data, null, 'after that the old key is gone');
  assert.deepEqual(b.recvKeyIds('ann'), [0]);
  // The new key never opened anything sealed under the old one, nor the other way round.
  await assert.rejects(openFrame(await frameKey(raw(5)), fresh, 1));
});

test('FrameCrypto: dropping a person or the whole call forgets every key', async () => {
  const a = new FrameCrypto();
  await a.setSendKey(1, raw(7));
  await a.addRecvKey('bob', 3, raw(8));
  a.useFor('bob', 1);
  a.dropPeer('bob');
  assert.deepEqual(a.recvKeyIds('bob'), []);
  assert.equal((await a.encrypt('bob', frame(30), 1)).e2ee, false);
  a.wipe();
  assert.deepEqual(a.sendKeyIds(), []);
  await assert.rejects(a.setSendKey(2, new Uint8Array(16)), 'a call key is 32 bytes');
});
