// v0.10 vault keys (POST /v1/vault/key) and xfer sockets (device-to-device data transfer routing).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, makeKeys, OWNER_ID, DAY } from './helpers.js';

let reg;
let nextId = 7000;
before(async () => {
  reg = await start();
});
after(() => reg.close());

const user = (name, r = reg) => r.signUp(nextId++, name);

function vaultKey(u, { k = u.k, r = reg, p = '{}' } = {}) {
  const ts = r.ts();
  return r.call('/v1/vault/key', { uid: u.uid, ts, p, sig: k.sign(`snug-reg-v1\nvault-key\n${u.uid}\n${ts}\n${p}`) });
}

async function startMove(u, k2 = makeKeys(), r = reg) {
  const a = await r.authId(k2, u.ghId);
  assert.equal(a.body.status, 'rebind', JSON.stringify(a.body));
  const ts = r.ts();
  const res = await r.call('/v1/rebind', { ticket: a.body.ticket, ts, sig: k2.sign(`snug-reg-v1\nrebind\n${a.body.ticket}\n${ts}`) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return k2;
}

async function approve(u, k2, kver = 2, r = reg) {
  const prevMsg = `snug-keychange-v1\n${u.uid}\n${kver}\n${k2.ik}\n${k2.xk}`;
  const res = await r.call('/v1/rebind/approve', { uid: u.uid, kver, ik: k2.ik, xk: k2.xk, prev: u.k.sign(prevMsg) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

/** Open an xfer socket. Resolves with s.ready, or s.ready = null when the registry closed it. */
async function xfer(uid, k, r = reg) {
  const s = await r.connect(uid, k, {
    auth: (c) => ({ t: 'auth', uid, mode: 'xfer', v: '0.10.0', sig: k.sign(`snug-reg-v1\nsignal-xfer\n${uid}\n${c.n}`) }),
  });
  s.ready = await s.next((m) => m.t === 'ready').catch(() => null);
  return s;
}

// ---------- vault keys ----------

test('vault key: created on first use, 32 bytes, stable, the same after release and a new claim', async () => {
  const u = await user('vika');
  const r1 = await vaultKey(u);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.match(r1.body.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(r1.body.key, 'base64url').length, 32);
  assert.equal(r1.body.kid, 1);
  assert.equal((await vaultKey(u)).body.key, r1.body.key);
  // release the name, wait out the 7 days, claim again with a new device: same GitHub account, same key
  const t = (await reg.authId(u.k, u.ghId)).body.ticket;
  const rel = await reg.signed('/v1/release', u.k, { uid: u.uid, ticket: t }, (ts) => ['release', u.uid, t, ts]);
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  await reg.clock.advance(7 * DAY + 1000);
  const again = await reg.signUp(u.ghId, 'vika2');
  assert.notEqual(again.uid, u.uid);
  assert.equal((await vaultKey(again)).body.key, r1.body.key);
  // a different GitHub account has a different key
  const other = await user('otto');
  assert.notEqual((await vaultKey(other)).body.key, r1.body.key);
});

test('vault key: only the current key gets it (never a pending move key); other keys and uids may not; not stored raw', async () => {
  const u = await user('pemma');
  const key = (await vaultKey(u)).body.key;
  const k2 = await startMove(u);
  // sec-registry REG-H1: a pending key has proved GitHub only; the 72 h delay and the old PC's Stop exist
  // because that is not enough. It gets the key once the move completes (approve, or after 72 h).
  const viaPending = await vaultKey(u, { k: k2 });
  assert.equal(viaPending.status, 401, JSON.stringify(viaPending.body));
  assert.equal(viaPending.body.error, 'bad_signature');
  assert.equal(viaPending.body.key, undefined);
  assert.equal((await vaultKey(u)).body.key, key, 'the current key still gets it during the move');
  await approve(u, k2);
  const afterMove = await vaultKey(u, { k: k2 });
  assert.equal(afterMove.status, 200, JSON.stringify(afterMove.body));
  assert.equal(afterMove.body.key, key, 'after the move the new key gets the same key');
  assert.equal((await vaultKey(u)).body.error, 'bad_signature', 'and the old key no longer does');
  u.k = k2;
  assert.equal((await vaultKey(u, { k: makeKeys() })).body.error, 'bad_signature');
  const mallory = await user('mallory');
  assert.equal((await vaultKey(u, { k: mallory.k })).body.error, 'bad_signature', 'another account’s key cannot fetch it');
  assert.equal((await vaultKey(u, { p: '{"x":1}', k: makeKeys() })).body.error, 'bad_signature');
  // banned accounts still get their own key (it is their own data)
  const owner = await reg.signUp(OWNER_ID, 'a');
  const ts = reg.ts();
  const p = JSON.stringify({ a: 'ban', uid: u.uid, reason: 'test', until: null });
  const b = await reg.call('/v1/admin', { uid: owner.uid, ts, p, sig: owner.k.sign(`snug-reg-v1\nadmin\n${owner.uid}\n${ts}\n${p}`) });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal((await vaultKey(u)).body.key, key);
  // the DB row is wrapped: never the raw key, 12 + 32 + 16 bytes
  const rows = reg.runtime.sql('SELECT * FROM vault_keys');
  assert.ok(rows.length >= 1);
  const raw = Buffer.from(key, 'base64url');
  for (const r of rows) {
    const k = Buffer.from(r.k, 'base64url');
    assert.equal(k.length, 60);
    assert.ok(!k.includes(raw.subarray(0, 16)), 'raw key bytes are not in the row');
    assert.ok(!r.k.includes(key.slice(0, 20)));
  }
});

test('vault key: per-uid daily budget', async () => {
  const r2 = await start({ env: { TEST_LIMITS: { vaultDay: [2, DAY] } } });
  try {
    const u = await user('budgie', r2);
    assert.equal((await vaultKey(u, { r: r2 })).status, 200);
    assert.equal((await vaultKey(u, { r: r2 })).status, 200);
    assert.equal((await vaultKey(u, { r: r2 })).status, 429);
  } finally {
    await r2.close();
  }
});

// ---------- xfer ----------

test('xfer: current and pending keys find each other and exchange boxes both ways; presence on/off', async () => {
  const u = await user('xena');
  const k2 = await startMove(u);
  const cur = await xfer(u.uid, u.k);
  assert.equal(cur.ready.mode, 'xfer');
  assert.equal(cur.ready.role, 'cur');
  assert.deepEqual(cur.ready.keys.pending, { ik: k2.ik, xk: k2.xk });
  assert.deepEqual(cur.ready.keys.chain.map((c) => c.ik), [u.k.ik]);
  assert.deepEqual(cur.ready.others, []);
  const pend = await xfer(u.uid, k2);
  assert.equal(pend.ready.role, 'pending');
  assert.deepEqual(pend.ready.others, [{ ik: u.k.ik, xk: u.k.xk, role: 'cur' }]);
  assert.deepEqual(await cur.next((m) => m.t === 'xfer-peer'), { t: 'xfer-peer', ik: k2.ik, xk: k2.xk, role: 'pending', on: true });
  cur.send({ t: 'xfer', id: 'x1', to: k2.ik, box: 'offer-box' });
  assert.deepEqual(await pend.next((m) => m.t === 'xfer'), { t: 'xfer', from: u.k.ik, box: 'offer-box' });
  pend.send({ t: 'xfer', id: 'x2', to: u.k.ik, box: 'want-box' });
  assert.deepEqual(await cur.next((m) => m.t === 'xfer'), { t: 'xfer', from: k2.ik, box: 'want-box' });
  // xfer sockets ignore every other frame; normal sockets ignore xfer frames; the normal socket is not replaced
  const normal = await reg.connect(u.uid, u.k);
  cur.send({ t: 'watch', uids: [] });
  normal.send({ t: 'xfer', id: 'x3', to: k2.ik, box: 'from-normal' });
  await pend.none((m) => m.t === 'xfer');
  await normal.none((m) => m.t === 'err');
  cur.send({ t: 'xfer', id: 'x4', to: u.k.ik, box: 'self' });
  assert.equal((await cur.next((m) => m.t === 'err')).code, 'unavailable');
  // sending to a key with no socket: unavailable
  cur.send({ t: 'xfer', id: 'x5', to: makeKeys().ik, box: 'nobody' });
  assert.deepEqual(await cur.next((m) => m.id === 'x5'), { t: 'err', id: 'x5', code: 'unavailable' });
  pend.close();
  assert.deepEqual(await cur.next((m) => m.t === 'xfer-peer'), { t: 'xfer-peer', ik: k2.ik, xk: k2.xk, role: 'pending', on: false });
  cur.close();
  normal.close();
});

test('xfer: after the move the old key keeps an "old" role for 30 days; older keys and strangers are refused', async () => {
  const u = await user('olga');
  const k2 = await startMove(u);
  const curBefore = await xfer(u.uid, u.k);
  const pend = await xfer(u.uid, k2);
  await curBefore.next((m) => m.t === 'xfer-peer');
  await approve(u, k2);
  // the open xfer sockets stay; roles move and both sides hear the new roles
  assert.deepEqual(await curBefore.next((m) => m.t === 'xfer-peer' && m.ik === k2.ik), { t: 'xfer-peer', ik: k2.ik, xk: k2.xk, role: 'cur', on: true });
  assert.equal((await pend.next((m) => m.t === 'xfer-peer' && m.ik === u.k.ik)).role, 'old');
  curBefore.send({ t: 'xfer', id: 'y1', to: k2.ik, box: 'still-works' });
  assert.equal((await pend.next((m) => m.t === 'xfer')).box, 'still-works');
  curBefore.close();
  pend.close();
  const old = await xfer(u.uid, u.k);
  assert.equal(old.ready.role, 'old');
  const now = await xfer(u.uid, k2);
  assert.equal(now.ready.role, 'cur');
  assert.deepEqual(now.ready.others, [{ ik: u.k.ik, xk: u.k.xk, role: 'old' }]);
  old.send({ t: 'xfer', id: 'y2', to: k2.ik, box: 'late-delivery' });
  assert.deepEqual(await now.next((m) => m.t === 'xfer'), { t: 'xfer', from: u.k.ik, box: 'late-delivery' });
  old.close();
  now.close();
  // a stranger's key, and another account's key, are refused
  const stranger = await xfer(u.uid, makeKeys());
  assert.equal(stranger.ready, null);
  assert.equal((await stranger.closed).code, 4001);
  // a second move: the first key (kver 1) is now two behind and refused
  const u2 = { ...u, k: k2 };
  const k3 = await startMove(u2);
  await approve(u2, k3, 3);
  const tooOld = await xfer(u.uid, u.k);
  assert.equal(tooOld.ready, null);
  assert.equal((await tooOld.closed).code, 4001);
  const prev = await xfer(u.uid, k2);
  assert.equal(prev.ready.role, 'old');
  prev.close();
  // after 30 days the previous key is refused too
  await reg.clock.advance(31 * DAY);
  const expired = await xfer(u.uid, k2);
  assert.equal(expired.ready, null);
  assert.equal((await expired.closed).code, 4001);
});

test('xfer: the key from before a move talks only with the current key, never with a new pending key', async () => {
  const u = await user('oldkey');
  const k2 = await startMove(u);
  await approve(u, k2); // u.k is now 'old', k2 'cur'
  const u2 = { ...u, k: k2 };
  const k3 = await startMove(u2); // a second move starts: k3 'pending'
  const old = await xfer(u.uid, u.k);
  const cur = await xfer(u.uid, k2);
  const pend = await xfer(u.uid, k3);
  assert.deepEqual([old.ready.role, cur.ready.role, pend.ready.role], ['old', 'cur', 'pending']);
  pend.send({ t: 'xfer', id: 'o1', to: u.k.ik, box: 'to-old' });
  assert.equal((await pend.next((m) => m.id === 'o1')).code, 'unavailable');
  old.send({ t: 'xfer', id: 'o2', to: k3.ik, box: 'to-pending' });
  assert.equal((await old.next((m) => m.id === 'o2')).code, 'unavailable');
  await old.none((m) => m.t === 'xfer');
  await pend.none((m) => m.t === 'xfer');
  // old <-> cur still works both ways (the old PC hands its file over; the new one replies)
  old.send({ t: 'xfer', id: 'o3', to: k2.ik, box: 'hand-over' });
  assert.equal((await cur.next((m) => m.t === 'xfer')).box, 'hand-over');
  cur.send({ t: 'xfer', id: 'o4', to: u.k.ik, box: 'reply' });
  assert.equal((await old.next((m) => m.t === 'xfer')).box, 'reply');
  for (const s of [old, cur, pend]) s.close();
});

test('xfer: never across accounts; a cancelled move closes the pending xfer socket; banned accounts may use it', async () => {
  const a = await user('alfa');
  const b = await user('bravo');
  const sa = await xfer(a.uid, a.k);
  const sb = await xfer(b.uid, b.k);
  sa.send({ t: 'xfer', id: 'z1', to: b.k.ik, box: 'cross' });
  assert.equal((await sa.next((m) => m.id === 'z1')).code, 'unavailable');
  await sb.none((m) => m.t === 'xfer');
  // b's key on a's uid is refused at auth
  const wrong = await xfer(a.uid, b.k);
  assert.equal(wrong.ready, null);
  sb.close();
  // cancel: the pending key's xfer socket closes (4006)
  const k2 = await startMove(a);
  const pend = await xfer(a.uid, k2);
  assert.equal(pend.ready.role, 'pending');
  const c = await reg.signed('/v1/rebind/cancel', a.k, { uid: a.uid }, (ts) => ['rebind-cancel', a.uid, ts]);
  assert.equal(c.status, 200);
  assert.equal((await pend.closed).code, 4006);
  sa.close();
  // banned accounts keep xfer (their own data)
  const r2 = await start();
  try {
    const o = await r2.signUp(OWNER_ID, 'a');
    const v = await user('victim', r2);
    const ts = r2.ts();
    const p = JSON.stringify({ a: 'ban', uid: v.uid, reason: 'r', until: null });
    assert.equal((await r2.call('/v1/admin', { uid: o.uid, ts, p, sig: o.k.sign(`snug-reg-v1\nadmin\n${o.uid}\n${ts}\n${p}`) })).status, 200);
    const s = await xfer(v.uid, v.k, r2);
    assert.equal(s.ready.role, 'cur');
    s.close();
  } finally {
    await r2.close();
  }
});

test('xfer: too_big, burst and daily budgets, at most two sockets per key', async () => {
  const r2 = await start({ env: { TEST_LIMITS: { xferBurst: [3, 1000], xferBytesDay: [200_000, DAY] } } });
  try {
    const u = await user('budget', r2);
    const k2 = await startMove(u, makeKeys(), r2);
    const a = await xfer(u.uid, u.k, r2);
    const b = await xfer(u.uid, k2, r2);
    a.send({ t: 'xfer', id: 'big', to: k2.ik, box: 'x'.repeat(65537) });
    assert.equal((await a.next((m) => m.id === 'big')).code, 'too_big');
    for (let i = 0; i < 3; i++) a.send({ t: 'xfer', id: `b${i}`, to: k2.ik, box: 'y'.repeat(60_000) });
    a.send({ t: 'xfer', id: 'b3', to: k2.ik, box: 'z' });
    assert.equal((await a.next((m) => m.id === 'b3')).code, 'rate_limited');
    for (let i = 0; i < 3; i++) await b.next((m) => m.t === 'xfer');
    await new Promise((r) => setTimeout(r, 1100));
    a.send({ t: 'xfer', id: 'b4', to: k2.ik, box: 'w'.repeat(60_000) });
    assert.equal((await a.next((m) => m.id === 'b4')).code, 'rate_limited', 'daily bytes used up');
    // a third socket of the same key pushes out the oldest
    const a2 = await xfer(u.uid, u.k, r2);
    assert.equal(a2.ready.role, 'cur');
    const a3 = await xfer(u.uid, u.k, r2);
    assert.equal((await a.closed).code, 4002);
    for (const s of [a2, a3, b]) s.close();
  } finally {
    await r2.close();
  }
});

test('xfer and vault key keep working while a minimum version is set (their own data)', async () => {
  const r2 = await start();
  try {
    const o = await r2.signUp(OWNER_ID, 'a');
    const ts = r2.ts();
    const p = JSON.stringify({ a: 'min.set', v: '0.10.0', app: '0.10.0' });
    assert.equal((await r2.call('/v1/admin', { uid: o.uid, ts, p, sig: o.k.sign(`snug-reg-v1\nadmin\n${o.uid}\n${ts}\n${p}`) })).status, 200);
    const u = await user('oldie', r2);
    const s = await r2.connect(u.uid, u.k, {
      auth: (c) => ({ t: 'auth', uid: u.uid, mode: 'xfer', sig: u.k.sign(`snug-reg-v1\nsignal-xfer\n${u.uid}\n${c.n}`) }),
    });
    assert.equal((await s.next((m) => m.t === 'ready')).role, 'cur');
    s.close();
    assert.equal((await vaultKey(u, { r: r2 })).status, 200);
    // and a normal-mode signature never opens an xfer socket (domain separated)
    const n = await r2.connect(u.uid, u.k, {
      auth: (c) => ({ t: 'auth', uid: u.uid, mode: 'xfer', sig: u.k.sign(`snug-reg-v1\nsignal\n${u.uid}\n${c.n}`) }),
    });
    assert.equal((await n.closed).code, 4001);
  } finally {
    await r2.close();
  }
});
