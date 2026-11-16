// v0.12 keypair accounts (registry/src/keyacct.js): sign-up with a proof of work and a recovery key, the
// pairing-code move, the recovery move, recovery key changes, the optional GitHub link, delete with the
// recovery key, the abuse rules, and that a 0.11 client's flow is unchanged with all of it switched on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { start, makeKeys, OWNER_ID, HOUR, DAY } from './helpers.js';
import { registerStr, recoverStr, powInput } from '../src/keyacct.js';

let reg;
let nextGh = 61000;
let nextName = 0;
before(async () => {
  reg = await start({ env: { POW_BITS: '6' } });
});
after(() => reg.close());

const uniq = (p = 'kay') => `${p}${++nextName}x`;

function zeroBits(d) {
  let n = 0;
  for (const b of d) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; }
  return n;
}
function solve(c, ik, bits) {
  for (let n = 0; ; n++) {
    if (zeroBits(createHash('sha256').update(powInput(c, ik, String(n))).digest()) >= bits) return String(n);
  }
}

/** POST /v1/register for a fresh device key k and recovery key r. Returns {res, k, r, uid}. */
async function register(name, { k = makeKeys(), r = makeKeys(), ip, R = reg, mutate } = {}) {
  const pw = await R.call('/v1/pow', { purpose: 'register' }, { ip });
  assert.equal(pw.status, 200, JSON.stringify(pw.body));
  const f = { ik: k.ik, xk: k.xk, rk: r.ik, username: name, c: pw.body.c, nonce: solve(pw.body.c, k.ik, pw.body.bits), ts: R.ts() };
  const msg = registerStr(f);
  let body = { ...f, sig: k.sign(msg), rsig: r.sign(msg) };
  if (mutate) body = mutate(body, pw.body);
  const res = await R.call('/v1/register', body, { ip });
  return { res, k, r, uid: res.body?.account?.uid, account: res.body?.account };
}
async function account(name, opts) {
  const a = await register(name, opts);
  assert.equal(a.res.status, 200, JSON.stringify(a.res.body));
  return a;
}
/** A v0.10-style signedP call {uid, ts, p, sig} (+ extra fields over the same string). */
function sp(u, path, op, payload, { k = u.k, extra = () => ({}), R = reg } = {}) {
  const p = JSON.stringify(payload);
  const ts = R.ts();
  const msg = `snug-reg-v1\n${op}\n${u.uid}\n${ts}\n${p}`;
  return R.call(path, { uid: u.uid, ts, p, sig: k.sign(msg), ...extra(msg, ts) });
}
const kind = (u, R = reg) => sp(u, '/v1/account/kind', 'account-kind', {}, { R });
async function connectV(u, v, k = u.k, R = reg) {
  const s = await R.connect(u.uid, k, { auth: (c) => ({ t: 'auth', uid: u.uid, sig: k.sign(`snug-reg-v1\nsignal\n${u.uid}\n${c.n}`), ...(v ? { v } : {}) }) });
  s.ready = await s.next((m) => m.t === 'ready').catch(() => null);
  return s;
}
function recover(u, k2 = makeKeys(), { r = u.r, R = reg } = {}) {
  const f = { rk: r.ik, ik: k2.ik, xk: k2.xk, ts: R.ts() };
  const msg = recoverStr(f);
  return R.call('/v1/recover', { ...f, sig: k2.sign(msg), rsig: r.sign(msg) }).then((res) => ({ res, k2 }));
}
function hello(k2, R = reg) {
  const ts = R.ts();
  return R.call('/v1/move/hello', { ik: k2.ik, xk: k2.xk, ts, sig: k2.sign(`snug-reg-v1\nmove-hello\n${k2.ik}\n${k2.xk}\n${ts}`) });
}
function wait(k2, hid, R = reg) {
  const ts = R.ts();
  return R.call('/v1/move/wait', { hid, ts, sig: k2.sign(`snug-reg-v1\nmove-wait\n${hid}\n${ts}`) });
}
const prevSig = (u, kver, k2) => u.k.sign(`snug-keychange-v1\n${u.uid}\n${kver}\n${k2.ik}\n${k2.xk}`);
function adm(u, payload) {
  return sp(u, '/v1/admin', 'admin', payload);
}
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 2000, `${what}: ${a} vs ${b}`);
let ownerU = null;
const theOwner = async () => (ownerU ||= await reg.signUp(OWNER_ID, 'a'));
const ghTicket = async (k, ghId, R = reg) => (await R.authId(k, ghId)).body;

// ---------- switched off ----------

test('KEY_ACCOUNTS off: every new route answers exactly like an unknown path', async () => {
  const off = await start({ env: { KEY_ACCOUNTS: '0' } });
  try {
    const unknown = await off.call('/v1/nope', {});
    for (const path of ['/v1/pow', '/v1/register', '/v1/recover', '/v1/move/hello', '/v1/move/wait', '/v1/move/peek', '/v1/move/accept',
      '/v1/recovery/set', '/v1/recovery/cancel', '/v1/recovery/drop', '/v1/link/github', '/v1/link/github/remove', '/v1/release/key', '/v1/account/kind']) {
      const r = await off.call(path, { purpose: 'register' });
      assert.equal(r.status, 404, path);
      assert.deepEqual({ ...r.body, now: 0 }, { ...unknown.body, now: 0 }, path);
    }
  } finally {
    await off.close();
  }
});

// ---------- proof of work and sign-up ----------

test('pow: a MAC-protected challenge; tampered, expired, reused or unsolved ones are refused', async () => {
  const pw = await reg.call('/v1/pow', { purpose: 'register' });
  assert.equal(pw.status, 200);
  assert.equal(pw.body.bits, 6);
  assert.match(pw.body.c, /^1\.\d{13}\.6\.[A-Za-z0-9_-]{22}\.[0-9a-f]{32}$/);
  assert.equal((await reg.call('/v1/pow', { purpose: 'other' })).status, 400);

  const bad = async (mutate) => (await register(uniq(), { mutate })).res.body.error;
  // fewer bits claimed than issued: the MAC no longer matches
  assert.equal(await bad((b) => ({ ...b, c: b.c.replace(/\.6\./, '.1.') })), 'pow_invalid');
  // a nonce that doesn't do the work: solve() returns the lowest solution, so the one below it fails
  const below = await register(uniq(), { mutate: (b) => (b.nonce === '0' ? { ...b, c: `${b.c}x` } : { ...b, nonce: String(Number(b.nonce) - 1) }) });
  assert.equal(below.res.body.error, 'pow_invalid');
  assert.equal((await register(uniq(), { mutate: (b) => ({ ...b, nonce: 'x' }) })).res.status, 400);
  // an expired challenge
  const k = makeKeys();
  const r = makeKeys();
  const old = await reg.call('/v1/pow', { purpose: 'register' });
  await reg.clock.advance(11 * 60_000);
  const f = { ik: k.ik, xk: k.xk, rk: r.ik, username: uniq(), c: old.body.c, nonce: solve(old.body.c, k.ik, old.body.bits), ts: reg.ts() };
  const msg = registerStr(f);
  assert.equal((await reg.call('/v1/register', { ...f, sig: k.sign(msg), rsig: r.sign(msg) })).body.error, 'pow_invalid');
  // a challenge used once is spent, even for other keys
  const pw2 = await reg.call('/v1/pow', { purpose: 'register' });
  const send = (kk, rr) => {
    const g = { ik: kk.ik, xk: kk.xk, rk: rr.ik, username: uniq(), c: pw2.body.c, nonce: solve(pw2.body.c, kk.ik, pw2.body.bits), ts: reg.ts() };
    const m = registerStr(g);
    return reg.call('/v1/register', { ...g, sig: kk.sign(m), rsig: rr.sign(m) });
  };
  assert.equal((await send(makeKeys(), makeKeys())).status, 200);
  assert.equal((await send(makeKeys(), makeKeys())).body.error, 'pow_invalid', 'spent');
});

test('pow: the difficulty rises with the sign-ups of the last hour', async () => {
  const r2 = await start({ env: { POW_BITS: '2' } });
  try {
    assert.equal((await r2.call('/v1/pow', { purpose: 'register' })).body.bits, 2);
    for (let i = 0; i < 31; i++) await account(uniq('rush'), { R: r2 });
    assert.equal((await r2.call('/v1/pow', { purpose: 'register' })).body.bits, 3);
    // The count is a sliding estimate over two fixed windows (the previous one weighted by how much of it is
    // still in the last hour), so one hour later part of it can remain; two hours later none does.
    await r2.clock.advance(2 * HOUR);
    assert.equal((await r2.call('/v1/pow', { purpose: 'register' })).body.bits, 2);
  } finally {
    await r2.close();
  }
});

test('register: an ordinary account row anchored at a:<uid>; lookup looks exactly like a GitHub account', async () => {
  const name = uniq('Kim');
  const a = await account(name);
  assert.match(a.uid, /^[a-z2-7]{16}$/);
  assert.deepEqual(Object.keys(a.account).sort(), ['claimedAt', 'kver', 'renameAt', 'renamedAt', 'uid', 'username']);
  assert.equal(a.account.username, name.toLowerCase());
  const row = reg.runtime.sql('SELECT * FROM accounts WHERE uid=?', a.uid)[0];
  assert.equal(row.ghh, `a:${a.uid}`);
  assert.equal(reg.runtime.sql('SELECT rk FROM recovery_keys WHERE uid=?', a.uid)[0].rk, a.r.ik);
  // the name is taken for everyone, and checked the same way
  assert.equal((await reg.call(`/v1/check?name=${name}`)).body.error, 'taken');
  const gh = await reg.signUp(nextGh++, uniq('gil'));
  const viaGh = await reg.lookup(gh, { name: a.account.username });
  const viaKey = await reg.lookup({ uid: a.uid, k: a.k }, { name: gh.account.username });
  assert.equal(viaGh.status, 200);
  assert.equal(viaKey.status, 200);
  assert.deepEqual(Object.keys(viaGh.body).sort(), Object.keys(viaKey.body).sort());
  assert.deepEqual(viaGh.body.chain.map((c) => Object.keys(c).sort()), viaKey.body.chain.map((c) => Object.keys(c).sort()));
  // a keypair account can sign in to the signal socket like any account
  const s = await connectV({ uid: a.uid, k: a.k }, '0.12.0');
  assert.equal(s.ready.mode, 'normal');
  s.close();
});

test('register: both signatures, fresh keys, names and short-name rules', async () => {
  const taken = await account(uniq('tess'));
  const wrongRsig = await register(uniq(), { mutate: (b) => ({ ...b, rsig: makeKeys().sign('x') }) });
  assert.equal(wrongRsig.res.body.error, 'bad_signature');
  const wrongSig = await register(uniq(), { mutate: (b) => ({ ...b, sig: makeKeys().sign('x') }) });
  assert.equal(wrongSig.res.body.error, 'bad_signature');
  // the recovery key of another account
  assert.equal((await register(uniq(), { r: taken.r })).res.body.error, 'key_in_use');
  // the device key of another account (a GitHub one too)
  assert.equal((await register(uniq(), { k: taken.k })).res.body.error, 'key_in_use');
  const gh = await reg.signUp(nextGh++, uniq('gus'));
  assert.equal((await register(uniq(), { k: gh.k })).res.body.error, 'key_in_use');
  // rk must differ from ik
  const k = makeKeys();
  assert.equal((await register(uniq(), { k, r: k })).res.status, 400);
  // names
  assert.equal((await register(taken.account.username)).res.body.error, 'taken');
  assert.equal((await register('abc')).res.body.error, 'too_new');
  assert.equal((await register('a')).res.body.error, 'owner_only');
  assert.equal((await register('bad_')).res.body.error, 'invalid_name');
  assert.equal((await register('admin')).res.body.error, 'reserved');
  // stale ts
  assert.equal((await register(uniq(), { mutate: (b) => ({ ...b, ts: b.ts - 10 * 60_000 }) })).res.body.error, 'stale');
});

test('register: 3 a day per address, and a global hourly cap that leaves GitHub sign-up working', async () => {
  const r2 = await start({ trustClientIp: true, env: { POW_BITS: '2', TEST_LIMITS: { ipRegister: [3, DAY], regGlobal: [5, HOUR] } } });
  try {
    for (let i = 0; i < 3; i++) await account(uniq('ip'), { R: r2, ip: '203.0.113.7' });
    const fourth = await register(uniq('ip'), { R: r2, ip: '203.0.113.7' });
    assert.equal(fourth.res.status, 429);
    // the same /48 counts as one address
    assert.equal((await register(uniq('ip'), { R: r2, ip: '2001:db8:1:2::1' })).res.status, 200);
    assert.equal((await register(uniq('ip'), { R: r2, ip: '2001:db8:1:3::1' })).res.status, 200);
    const sixth = await register(uniq('ip'), { R: r2, ip: '198.51.100.9' });
    assert.equal(sixth.res.status, 429, 'global cap');
    assert.ok(sixth.res.body.retryAfter > 0);
    await r2.signUp(nextGh++, uniq('still'), undefined);
  } finally {
    await r2.close();
  }
});

// ---------- pairing code ----------

test('pairing code: hello, peek, accept: the move completes now with a verified key change and the restore knock', async () => {
  const a = await account(uniq('pia'));
  const u = { uid: a.uid, k: a.k };
  const old = await connectV(u, '0.12.0');
  const k2 = makeKeys();
  const h = await hello(k2);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.match(h.body.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal((await wait(k2, h.body.hid)).body.state, 'waiting');
  // a wrong code
  assert.equal((await sp(u, '/v1/move/peek', 'move-peek', { code: 'ZZZZZ-ZZZZZ' })).status, 404);
  // the right one, typed sloppily
  const pk = await sp(u, '/v1/move/peek', 'move-peek', { code: h.body.code.toLowerCase().replace('-', ' ') });
  assert.equal(pk.status, 200, JSON.stringify(pk.body));
  assert.deepEqual(pk.body, { ik: k2.ik, xk: k2.xk, kver: 2 });
  // accept with a prev that isn't over the new keys
  const badPrev = await sp(u, '/v1/move/accept', 'move-accept', { code: h.body.code, prev: u.k.sign('nope') });
  assert.equal(badPrev.body.error, 'bad_signature');
  const knock = { id: 'restore1', box: 'a-sealed-box' };
  const acc = await sp(u, '/v1/move/accept', 'move-accept', { code: h.body.code, prev: prevSig(u, 2, k2), knock });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal((await old.closed).code, 4003);
  const w = await wait(k2, h.body.hid);
  assert.equal(w.body.state, 'done');
  assert.equal(w.body.account.uid, a.uid);
  assert.equal(w.body.account.kver, 2);
  // friends see a key change signed by the old key
  const gh = await reg.signUp(nextGh++, uniq('fay'));
  const lk = await reg.lookup(gh, { uid: a.uid });
  assert.equal(lk.body.ik, k2.ik);
  assert.equal(lk.body.chain.at(-1).prev, prevSig(u, 2, k2));
  // the new PC's socket is normal at once and gets the restore list
  const s = await connectV({ uid: a.uid, k: k2 }, '0.12.0');
  assert.equal(s.ready.mode, 'normal');
  const kn = await s.next((m) => m.t === 'knock');
  assert.deepEqual([kn.from, kn.id, kn.box], [a.uid, 'restore1', 'a-sealed-box']);
  s.close();
  // the code is used up
  assert.equal((await sp({ uid: a.uid, k: k2 }, '/v1/move/peek', 'move-peek', { code: h.body.code })).status, 404);
});

test('pairing code: a GitHub account can use it too; tries are capped; codes expire; keys in use are refused', async () => {
  const gh = await reg.signUp(nextGh++, uniq('gina'));
  const k2 = makeKeys();
  const h = await hello(k2);
  const acc = await sp(gh, '/v1/move/accept', 'move-accept', { code: h.body.code, prev: prevSig(gh, 2, k2) });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal((await wait(k2, h.body.hid)).body.state, 'done');
  // the GitHub sign-in on the new PC now finds it there
  assert.equal((await reg.authId(k2, gh.ghId)).body.status, 'ok');

  const a = await account(uniq('tri'));
  const u = { uid: a.uid, k: a.k };
  const k3 = makeKeys();
  const h3 = await hello(k3);
  for (let i = 0; i < 5; i++) assert.equal((await sp(u, '/v1/move/peek', 'move-peek', { code: h3.body.code })).status, 200);
  assert.equal((await sp(u, '/v1/move/peek', 'move-peek', { code: h3.body.code })).status, 404, 'past 5 tries');
  // expiry
  const k4 = makeKeys();
  const h4 = await hello(k4);
  await reg.clock.advance(11 * 60_000);
  assert.equal((await wait(k4, h4.body.hid)).body.state, 'expired');
  assert.equal((await sp(u, '/v1/move/peek', 'move-peek', { code: h4.body.code })).status, 404);
  // a device key that is already an account's
  assert.equal((await hello(a.k)).body.error, 'key_in_use');
  // waiting needs the hello's key
  const k5 = makeKeys();
  const h5 = await hello(k5);
  assert.equal((await wait(makeKeys(), h5.body.hid)).body.error, 'bad_signature');
});

// ---------- recovery move ----------

test('recover: a 72 h move the old PC hears about; Stop blocks the next for a day', async () => {
  const a = await account(uniq('rae'));
  const u = { uid: a.uid, k: a.k, r: a.r };
  const old = await connectV(u, '0.11.1');
  const { res, k2 } = await recover(u);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.uid, a.uid);
  near(res.body.at, reg.clock.now() + 72 * HOUR, 'at');
  // the old PC gets the unchanged 0.11 frame
  const f = await old.next((m) => m.t === 'rebind');
  assert.deepEqual(Object.keys(f).sort(), ['at', 'ik', 'kver', 'state', 't', 'xk']);
  assert.equal((await kind(u)).body.move.via, 'recovery');
  // the new PC may hold a pending socket
  const pend = await connectV({ uid: a.uid, k: k2 }, '0.12.0');
  assert.equal(pend.ready.mode, 'pending');
  // Stop
  const ts = reg.ts();
  const stop = await reg.call('/v1/rebind/cancel', { uid: a.uid, ts, sig: a.k.sign(`snug-reg-v1\nrebind-cancel\n${a.uid}\n${ts}`) });
  assert.equal(stop.status, 200);
  assert.equal((await pend.closed).code, 4006);
  assert.equal((await recover(u)).res.body.error, 'rebind_blocked');
  // the wrong recovery key, or one nobody has
  assert.equal((await recover(u, makeKeys(), { r: makeKeys() })).res.status, 404);
  old.close();
  // a day later it works, and 72 h after that the account is on the new PC
  await reg.clock.advance(DAY + 1000);
  const again = await recover(u, k2);
  assert.equal(again.res.status, 200);
  await reg.clock.advance(72 * HOUR + 1000);
  const s = await connectV({ uid: a.uid, k: k2 }, '0.12.0');
  assert.equal(s.ready.mode, 'normal');
  assert.equal(s.ready.kver, 2);
  s.close();
  assert.equal((await kind({ uid: a.uid, k: k2 })).body.move, null);
});

test('recover: an owner-armed move.force completes at once; an unapproved completion drops a GitHub link and rotates the vault key', async () => {
  const owner = await theOwner();
  const a = await account(uniq('fox'));
  const u = { uid: a.uid, k: a.k, r: a.r };
  // link a GitHub account first
  const gid = nextGh++;
  const t = await ghTicket(a.k, gid);
  assert.equal(t.status, 'new');
  assert.equal((await sp(u, '/v1/link/github', 'link-github', { ticket: t.ticket })).status, 200);
  (await connectV(u, '0.12.0')).close(); // connected once, so the purge leaves it
  await reg.clock.advance(7 * DAY + 1000); // v0.12 review H3: a link works after 7 days
  assert.equal((await kind(u)).body.github.linked, true);
  // a vault key exists
  const vk = (k, uid) => { const ts = reg.ts(); return reg.call('/v1/vault/key', { uid, ts, p: '{}', sig: k.sign(`snug-reg-v1\nvault-key\n${uid}\n${ts}\n{}`) }); };
  const k1 = await vk(a.k, a.uid);
  assert.equal(k1.status, 200);
  const k2 = makeKeys();
  assert.equal((await adm(owner, { a: 'move.force', uid: a.uid, ik: k2.ik })).body.state, 'armed'); // bound to the new key (H3)
  const { res } = await recover(u, k2);
  near(res.body.at, reg.clock.now(), 'at');
  const s = await connectV({ uid: a.uid, k: k2 }, '0.12.0');
  assert.equal(s.ready.mode, 'normal');
  s.close();
  const kd = await kind({ uid: a.uid, k: k2 });
  assert.equal(kd.body.github.linked, false, 'the recovery key won: the GitHub link is gone');
  const k1b = await vk(k2, a.uid);
  assert.ok(k1b.body.kid > k1.body.kid, 'a new data file key for files written from now on');
  // the GitHub account is free again
  assert.equal((await reg.authId(makeKeys(), gid)).body.status, 'new');
});

// ---------- recovery key changes ----------

test('recovery/set: with the old key at once; without it 7 days later unless the old key cancels', async () => {
  const a = await account(uniq('ros'));
  const u = { uid: a.uid, k: a.k };
  const set = async (nr, oldR) => {
    const ts = reg.ts();
    const msg = `snug-reg-v1\nrecovery-set\n${a.uid}\n${nr.ik}\n${ts}`;
    const p = JSON.stringify({ rk: nr.ik, rsigNew: nr.sign(msg), ...(oldR ? { rsigOld: oldR.sign(msg) } : {}) });
    return reg.call('/v1/recovery/set', { uid: a.uid, ts, p, sig: a.k.sign(`snug-reg-v1\nrecovery-set\n${a.uid}\n${ts}\n${p}`) });
  };
  const r2 = makeKeys();
  const now = await set(r2, a.r);
  assert.deepEqual(now.body, { state: 'set' });
  assert.equal(reg.runtime.sql('SELECT rk FROM recovery_keys WHERE uid=?', a.uid)[0].rk, r2.ik);
  // the old key no longer recovers
  assert.equal((await recover({ uid: a.uid, r: a.r })).res.status, 404);
  // a wrong "old" key
  assert.equal((await set(makeKeys(), makeKeys())).body.error, 'bad_signature');
  // device alone: pending for 7 days, and a 0.12 socket hears it (a 0.11 one doesn't)
  const s12 = await connectV(u, '0.12.0');
  const r3 = makeKeys();
  const pend = await set(r3);
  assert.equal(pend.body.state, 'pending');
  near(pend.body.at, reg.clock.now() + 7 * DAY, 'at');
  assert.equal((await s12.next((m) => m.t === 'recovery')).state, 'pending');
  s12.close();
  assert.equal((await kind(u)).body.recovery.pendingAt, pend.body.at);
  // the current key cancels it
  const ts = reg.ts();
  const cancel = await reg.call('/v1/recovery/cancel', { uid: a.uid, ts, rsig: r2.sign(`snug-reg-v1\nrecovery-cancel\n${a.uid}\n${ts}`) });
  assert.equal(cancel.status, 200);
  assert.equal((await kind(u)).body.recovery.pendingAt, null);
  // again, and this time nobody cancels: the alarm applies it
  const r4 = makeKeys();
  assert.equal((await set(r4)).body.state, 'pending');
  await reg.clock.advance(7 * DAY + 1000);
  assert.equal(reg.runtime.sql('SELECT rk FROM recovery_keys WHERE uid=?', a.uid)[0].rk, r4.ik);
  // a recovery move someone started blocks a device-only change, and the device plus the old key end it
  const { res } = await recover({ uid: a.uid, r: r4 });
  assert.equal(res.status, 200);
  assert.equal((await set(makeKeys())).body.error, 'move_pending');
  const r5 = makeKeys();
  assert.equal((await set(r5, r4)).body.state, 'set');
  assert.equal((await kind(u)).body.move, null);
});

test('recovery/set: a GitHub account adds a first key 7 days later; a later unapproved GitHub move removes it', async () => {
  const gh = await reg.signUp(nextGh++, uniq('gale'));
  const nr = makeKeys();
  const ts = reg.ts();
  const msg = `snug-reg-v1\nrecovery-set\n${gh.uid}\n${nr.ik}\n${ts}`;
  const p = JSON.stringify({ rk: nr.ik, rsigNew: nr.sign(msg) });
  const r = await reg.call('/v1/recovery/set', { uid: gh.uid, ts, p, sig: gh.k.sign(`snug-reg-v1\nrecovery-set\n${gh.uid}\n${ts}\n${p}`) });
  // v0.12 review H3: the device alone adds a second proof only after 7 days (its GitHub sign-in can cancel)
  assert.equal(r.body.state, 'pending');
  near(r.body.at, reg.clock.now() + 7 * DAY, 'at');
  await reg.clock.advance(7 * DAY + 1000);
  const kd = await kind(gh);
  assert.deepEqual(kd.body, { kind: 'github', recovery: { set: true, pendingAt: null, rk: nr.ik }, github: { linked: true, pending: null }, move: null });
  // the recovery key can move a GitHub account too
  const { res } = await recover({ uid: gh.uid, r: nr });
  assert.equal(res.status, 200);
  const ts2 = reg.ts();
  await reg.call('/v1/rebind/cancel', { uid: gh.uid, ts: ts2, sig: gh.k.sign(`snug-reg-v1\nrebind-cancel\n${gh.uid}\n${ts2}`) });
  await reg.clock.advance(DAY + 1000);
  // an unapproved GitHub move: GitHub won, the recovery key goes
  const k2 = makeKeys();
  const a = await reg.authId(k2, gh.ghId);
  const ts3 = reg.ts();
  await reg.call('/v1/rebind', { ticket: a.body.ticket, ts: ts3, sig: k2.sign(`snug-reg-v1\nrebind\n${a.body.ticket}\n${ts3}`) });
  await reg.clock.advance(72 * HOUR + 1000);
  const after = await kind({ uid: gh.uid, k: k2 });
  assert.equal(after.body.recovery.set, false);
});

// ---------- GitHub link ----------

test('link/github: a new GitHub account becomes a second proof; it can move the account; unlink frees it', async () => {
  const a = await account(uniq('lin'));
  const u = { uid: a.uid, k: a.k };
  const gid = nextGh++;
  // a ticket of a GitHub account that already has a Snug account
  const other = await reg.signUp(nextGh++, uniq('oli'));
  const t0 = await ghTicket(a.k, other.ghId);
  assert.equal(t0.status, 'rebind');
  assert.equal((await sp(u, '/v1/link/github', 'link-github', { ticket: t0.ticket })).body.error, 'already_claimed');
  // a ticket issued to another key
  const tOther = await ghTicket(makeKeys(), gid);
  assert.equal((await sp(u, '/v1/link/github', 'link-github', { ticket: tOther.ticket })).body.error, 'bad_ticket');
  // the owner's GitHub account stays a GitHub account
  const tOwner = await ghTicket(a.k, OWNER_ID);
  if (tOwner.status === 'new') assert.equal((await sp(u, '/v1/link/github', 'link-github', { ticket: tOwner.ticket })).body.error, 'forbidden');
  const t = await ghTicket(a.k, gid);
  const l = await sp(u, '/v1/link/github', 'link-github', { ticket: t.ticket });
  assert.equal(l.status, 200);
  // v0.12 review H3: the link works 7 days later (the recovery key can cancel it meanwhile)
  assert.equal(l.body.state, 'pending');
  assert.equal((await kind(u)).body.github.linked, false);
  (await connectV(u, '0.12.0')).close(); // connected once, so the purge leaves it
  await reg.clock.advance(7 * DAY + 1000);
  assert.equal((await kind(u)).body.github.linked, true);
  // signing in with it finds this account: ok here, rebind elsewhere; claiming with it is refused
  assert.equal((await reg.authId(a.k, gid)).body.status, 'ok');
  const k2 = makeKeys();
  const elsewhere = await reg.authId(k2, gid);
  assert.equal(elsewhere.body.status, 'rebind');
  assert.equal(elsewhere.body.account.uid, a.uid);
  assert.equal((await reg.claim(k2, elsewhere.body.ticket, uniq('dup'))).body.error, 'already_claimed');
  // a GitHub account can't link (it is one)
  const ghAcc = await reg.signUp(nextGh++, uniq('gab'));
  const tg = await ghTicket(ghAcc.k, nextGh++);
  assert.equal((await sp(ghAcc, '/v1/link/github', 'link-github', { ticket: tg.ticket })).status, 400);
  // unlink: 7 days later too
  const un = await sp(u, '/v1/link/github/remove', 'unlink-github', {});
  assert.equal(un.status, 200);
  assert.equal(un.body.state, 'pending');
  await reg.clock.advance(7 * DAY + 1000);
  assert.equal((await reg.authId(makeKeys(), gid)).body.status, 'new');
});

test('v0.13: a waiting link can be cancelled by the GitHub account being linked (only the link)', async () => {
  const a = await account(uniq('lgc'));
  const u = { uid: a.uid, k: a.k };
  const gid = nextGh++;
  const t = await ghTicket(a.k, gid);
  assert.equal((await sp(u, '/v1/link/github', 'link-github', { ticket: t.ticket })).body.state, 'pending');
  // a recovery key waiting too: cancelling the link with GitHub leaves it
  const nr = makeKeys();
  const ts0 = reg.ts();
  const msg0 = `snug-reg-v1\nrecovery-set\n${u.uid}\n${nr.ik}\n${ts0}`;
  const p0 = JSON.stringify({ rk: nr.ik, rsigNew: nr.sign(msg0) });
  assert.equal((await reg.call('/v1/recovery/set', { uid: u.uid, ts: ts0, p: p0, sig: a.k.sign(`snug-reg-v1\nrecovery-set\n${u.uid}\n${ts0}\n${p0}`) })).body.state, 'pending');
  // another GitHub account can't
  const k3 = makeKeys();
  const tx = await ghTicket(k3, nextGh++);
  const cancelGh = (tk, k, what) => { const ts = reg.ts(); return reg.call('/v1/recovery/cancel', { ticket: tk, ts, sig: k.sign(`snug-reg-v1\nrecovery-cancel-gh\n${tk}\n${ts}${what ? `\n${what}` : ''}`), ...(what ? { what } : {}) }); };
  assert.equal((await cancelGh(tx.ticket, k3, 'link')).body.error, 'not_found');
  // the GitHub account being linked, signed in on any PC
  const k2 = makeKeys();
  const t2 = await ghTicket(k2, gid);
  assert.equal((await cancelGh(t2.ticket, k2, 'link')).status, 200);
  const kd = (await kind(u)).body;
  assert.equal(kd.github.pending, null);
  assert.equal(kd.github.linked, false);
  assert.ok(kd.recovery.pendingAt, 'the waiting recovery key stays');
  // it can't cancel the recovery key: it isn't linked
  const t3 = await ghTicket(k2, gid);
  assert.equal((await cancelGh(t3.ticket, k2, 'key')).body.error, 'not_found');
  assert.ok((await kind(u)).body.recovery.pendingAt);
});

test('v0.13 review: the same GitHub waiting on two accounts: its cancel calls off every link waiting for it', async () => {
  const cancelGh = (tk, k) => { const ts = reg.ts(); return reg.call('/v1/recovery/cancel', { ticket: tk, ts, sig: k.sign(`snug-reg-v1\nrecovery-cancel-gh\n${tk}\n${ts}\nlink`), what: 'link' }); };
  const link = async (u, id) => (await sp(u, '/v1/link/github', 'link-github', { ticket: (await ghTicket(u.k, id)).ticket })).body;
  const x = await account(uniq('lwx'));
  const y = await account(uniq('lwy'));
  const gid = nextGh++;
  assert.equal((await link(x, gid)).state, 'pending');
  assert.equal((await link(y, gid)).state, 'pending');
  // Y's PC cancels with that GitHub: Y's own link stops waiting (X's too: that GitHub said no to both)
  const sy = await connectV(y, '0.13.0');
  assert.equal((await cancelGh((await ghTicket(y.k, gid)).ticket, y.k)).status, 200);
  await sy.next((m) => m.t === 'recovery' && m.state === 'cancelled');
  sy.close();
  assert.equal((await kind(y)).body.github.pending, null);
  assert.equal((await kind(x)).body.github.pending, null);
  await reg.clock.advance(7 * DAY + 1000);
  assert.equal((await kind(y)).body.github.linked, false); // and it didn't come through later
});

test('v0.13: recovery/drop: the device cancels a first recovery key it asked for; not a key that replaces one', async () => {
  const gh = await reg.signUp(nextGh++, uniq('drp'));
  const setKey = (who, k) => {
    const nr = makeKeys();
    const ts = reg.ts();
    const msg = `snug-reg-v1\nrecovery-set\n${who.uid}\n${nr.ik}\n${ts}`;
    const p = JSON.stringify({ rk: nr.ik, rsigNew: nr.sign(msg) });
    return reg.call('/v1/recovery/set', { uid: who.uid, ts, p, sig: k.sign(`snug-reg-v1\nrecovery-set\n${who.uid}\n${ts}\n${p}`) });
  };
  const drop = (who, payload = { what: 'key' }, k = who.k) => sp({ uid: who.uid, k }, '/v1/recovery/drop', 'recovery-drop', payload);
  assert.equal((await drop(gh)).body.error, 'not_found'); // nothing waiting
  assert.equal((await setKey(gh, gh.k)).body.state, 'pending');
  assert.equal((await drop(gh, { what: 'link' })).status, 400);
  assert.equal((await drop(gh, {}, makeKeys())).body.error, 'bad_signature');
  const s = await connectV(gh, '0.12.0');
  assert.equal((await drop(gh)).status, 200);
  await s.next((m) => m.t === 'recovery' && m.state === 'cancelled' && m.what === 'key');
  s.close();
  assert.deepEqual((await kind(gh)).body.recovery, { set: false, pendingAt: null, rk: null });
  // a keypair account has a current key: that key cancels a new one, the device alone can't
  const a = await account(uniq('drk'));
  const u = { uid: a.uid, k: a.k };
  assert.equal((await setKey(u, a.k)).body.state, 'pending');
  assert.equal((await drop(u)).body.error, 'forbidden');
  assert.ok((await kind(u)).body.recovery.pendingAt);
});

// ---------- delete with the recovery key ----------

test('release/key: needs the device and the recovery key; frees the name; refused while banned', async () => {
  const owner = await theOwner();
  const a = await account(uniq('rel'));
  const u = { uid: a.uid, k: a.k };
  const rel = (r) => sp(u, '/v1/release/key', 'release-key', {}, { extra: (msg) => ({ rsig: r.sign(msg) }) });
  assert.equal((await rel(makeKeys())).body.error, 'bad_signature');
  const b = await account(uniq('ban'));
  assert.equal((await adm(owner, { a: 'ban', uid: b.uid, reason: 'spam', until: null })).status, 200);
  assert.equal((await sp({ uid: b.uid, k: b.k }, '/v1/release/key', 'release-key', {}, { extra: (msg) => ({ rsig: b.r.sign(msg) }) })).body.error, 'banned');
  const s = await connectV(u, '0.12.0');
  assert.equal((await rel(a.r)).status, 200);
  assert.equal((await s.closed).code, 4003);
  assert.equal((await reg.call(`/v1/check?name=${a.account.username}`)).body.ok, true);
  assert.equal(reg.runtime.sql('SELECT * FROM recovery_keys WHERE uid=?', a.uid).length, 0);
});

// ---------- abuse rules ----------

test('purge: an account whose device never connected within 7 days frees its name; connected or banned ones stay', async () => {
  const r2 = await start({ env: { POW_BITS: '2', OWNER_GITHUB_IDS: String(OWNER_ID) } });
  try {
    const owner = await r2.signUp(OWNER_ID, 'a');
    const never = await account(uniq('nev'), { R: r2 });
    const seen = await account(uniq('see'), { R: r2 });
    const banned = await account(uniq('bnd'), { R: r2 });
    const s = await connectV({ uid: seen.uid, k: seen.k }, '0.12.0', seen.k, r2);
    s.close();
    assert.equal((await sp(owner, '/v1/admin', 'admin', { a: 'ban', uid: banned.uid, reason: 'x', until: null }, { R: r2 })).status, 200);
    await r2.clock.advance(7 * DAY + 60_000);
    await r2.clock.advance(1000);
    const exists = (u) => r2.runtime.sql('SELECT 1 AS x FROM accounts WHERE uid=?', u.uid).length === 1;
    assert.equal(exists(never), false);
    assert.equal(exists(seen), true);
    assert.equal(exists(banned), true);
    assert.equal((await r2.call(`/v1/check?name=${never.account.username}`)).body.ok, true);
  } finally {
    await r2.close();
  }
});

test('idle purge (KEY_ACCOUNT_IDLE_DAYS): an idle account goes; an active one, one with a recovery move waiting and a GitHub-linked one stay', async () => {
  // Off by default: nothing in wrangler.toml sets it.
  const toml = (await import('node:fs')).readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.doesNotMatch(toml, /^\s*KEY_ACCOUNT_IDLE_DAYS\s*=/m);
  const r2 = await start({ env: { POW_BITS: '2', KEY_ACCOUNT_IDLE_DAYS: '30' } });
  try {
    const mk = async (p) => { const a = await account(uniq(p), { R: r2 }); const u = { uid: a.uid, k: a.k, r: a.r, name: a.account.username }; (await connectV(u, '0.12.0', u.k, r2)).close(); return u; };
    const idle = await mk('idl');
    const active = await mk('act');
    const moving = await mk('mov');
    const linked = await mk('lnk');
    // linked: GitHub linked at once with the recovery key
    const t = await ghTicket(linked.k, nextGh++, r2);
    const l = await sp(linked, '/v1/link/github', 'link-github', { ticket: t.ticket }, { R: r2, extra: (msg) => ({ rsig: linked.r.sign(msg) }) });
    assert.equal(l.body.state, 'done', JSON.stringify(l.body));
    // active: its app stays connected
    const live = await connectV(active, '0.12.0', active.k, r2);
    await r2.clock.advance(30 * 86_400_000 - 3_600_000);
    // moving: someone with the recovery key starts a move an hour before the purge would come
    const { res } = await recover(moving, makeKeys(), { R: r2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await r2.clock.advance(2 * 3_600_000);
    await r2.clock.advance(1000);
    const exists = (u) => r2.runtime.sql('SELECT 1 AS x FROM accounts WHERE uid=?', u.uid).length === 1;
    assert.equal(exists(idle), false, 'the idle account is purged');
    assert.equal((await r2.call(`/v1/check?name=${idle.name}`)).body.ok, true);
    assert.equal(exists(active), true, 'a connected account stays');
    assert.equal(exists(moving), true, 'an account with a recovery move waiting stays');
    assert.equal(exists(linked), true, 'a GitHub-linked account stays');
    live.close();
  } finally {
    await r2.close();
  }
});

test('new keypair accounts: smaller lookup budget for 72 h; first rename after 7 days; short names after 30', async () => {
  const r2 = await start({ env: { POW_BITS: '2', TEST_LIMITS: { newLookupDay: [2, DAY] } } });
  try {
    const a = await account(uniq('new'), { R: r2 });
    const u = { uid: a.uid, k: a.k };
    (await connectV(u, '0.12.0', a.k, r2)).close(); // connected once, so the 7-day purge doesn't take it
    const gh = await r2.signUp(nextGh++, uniq('old'));
    for (let i = 0; i < 2; i++) assert.equal((await r2.lookup(u, { uid: gh.uid })).status, 200);
    assert.equal((await r2.lookup(u, { uid: gh.uid })).status, 429);
    // a GitHub account keeps the usual budget
    for (let i = 0; i < 3; i++) assert.equal((await r2.lookup(gh, { uid: a.uid })).status, 200);
    assert.equal((await r2.rename(u, uniq('ren'))).body.error, 'too_new');
    await r2.clock.advance(4 * DAY);
    assert.equal((await r2.lookup(u, { uid: gh.uid })).status, 200);
    await r2.clock.advance(3 * DAY + 1000);
    assert.equal((await r2.rename(u, 'abc')).body.error, 'too_new');
    const n = uniq('ren');
    assert.equal((await r2.rename(u, n)).status, 200);
    await r2.clock.advance(23 * DAY + 1000);
    assert.equal((await r2.rename(u, 'abc')).status, 200);
  } finally {
    await r2.close();
  }
});

test('frames: a 0.11.1 socket never gets a recovery frame', async () => {
  const a = await account(uniq('frm'));
  const u = { uid: a.uid, k: a.k };
  const s11 = await connectV(u, '0.11.1');
  const ts = reg.ts();
  const nr = makeKeys();
  const msg = `snug-reg-v1\nrecovery-set\n${a.uid}\n${nr.ik}\n${ts}`;
  const p = JSON.stringify({ rk: nr.ik, rsigNew: nr.sign(msg) });
  assert.equal((await reg.call('/v1/recovery/set', { uid: a.uid, ts, p, sig: a.k.sign(`snug-reg-v1\nrecovery-set\n${a.uid}\n${ts}\n${p}`) })).body.state, 'pending');
  await s11.none((m) => m.t === 'recovery', 300);
  s11.close();
  // and a 0.11 socket that connects while it waits doesn't either; a 0.12 one does
  const again = await connectV(u, '0.11.1');
  await again.none((m) => m.t === 'recovery', 300);
  again.close();
  const s12 = await connectV(u, '0.12.0');
  assert.equal((await s12.next((m) => m.t === 'recovery')).state, 'pending');
  s12.close();
});

test('vault: a keypair account gets a data file key; the pairing-code move hands the same key to the new PC', async () => {
  const a = await account(uniq('vau'));
  const vk = (k) => { const ts = reg.ts(); return reg.call('/v1/vault/key', { uid: a.uid, ts, p: '{}', sig: k.sign(`snug-reg-v1\nvault-key\n${a.uid}\n${ts}\n{}`) }); };
  const k1 = await vk(a.k);
  assert.equal(k1.status, 200);
  const k2 = makeKeys();
  const h = await hello(k2);
  // a pending key never gets it
  assert.equal((await vk(k2)).status, 401);
  await sp({ uid: a.uid, k: a.k }, '/v1/move/accept', 'move-accept', { code: h.body.code, prev: prevSig({ uid: a.uid, k: a.k }, 2, k2) });
  const k1b = await vk(k2);
  assert.equal(k1b.body.key, k1.body.key);
  assert.equal(k1b.body.kid, k1.body.kid);
});

// ---------- 0.11 clients ----------

/** A 0.11 client's whole flow (sign-up, sign-in, lookup, rename, move, approve, socket, release), normalized. */
async function flow011(R) {
  const out = [];
  const keep = (label, r) => out.push([label, r.status, r.body]);
  const ka = makeKeys();
  const kb = makeKeys();
  let a = await R.authId(ka, 71001);
  keep('auth new', a);
  keep('claim', await R.claim(ka, a.body.ticket, 'olda'));
  keep('auth ok', await R.authId(ka, 71001));
  a = await R.authId(kb, 71002);
  const cb = await R.claim(kb, a.body.ticket, 'oldb');
  keep('claim b', cb);
  const ua = { uid: (await R.authId(ka, 71001)).body.account.uid, k: ka };
  const ub = { uid: cb.body.account.uid, k: kb };
  keep('lookup', await R.lookup(ua, { name: 'oldb' }));
  keep('check taken', await R.call('/v1/check?name=olda'));
  keep('check free', await R.call('/v1/check?name=freebie'));
  keep('rename', await R.rename(ub, 'oldbee'));
  const s = await R.connect(ua.uid, ka, { auth: (c) => ({ t: 'auth', uid: ua.uid, v: '0.11.1', sig: ka.sign(`snug-reg-v1\nsignal\n${ua.uid}\n${c.n}`) }) });
  const ready = await s.next((m) => m.t === 'ready');
  out.push(['ready', ready]);
  // a move from a new PC, approved by the old one
  const k2 = makeKeys();
  const rb = await R.authId(k2, 71001);
  keep('auth rebind', rb);
  const ts = R.ts();
  keep('rebind', await R.call('/v1/rebind', { ticket: rb.body.ticket, ts, sig: k2.sign(`snug-reg-v1\nrebind\n${rb.body.ticket}\n${ts}`) }));
  out.push(['rebind frame', await s.next((m) => m.t === 'rebind')]);
  keep('approve', await R.call('/v1/rebind/approve', { uid: ua.uid, kver: 2, ik: k2.ik, xk: k2.xk, prev: ka.sign(`snug-keychange-v1\n${ua.uid}\n2\n${k2.ik}\n${k2.xk}`) }));
  out.push(['old socket', await s.closed]);
  keep('lookup after move', await R.lookup(ub, { uid: ua.uid }));
  // release b with a fresh GitHub ticket
  const t = await R.authId(kb, 71002);
  const ts2 = R.ts();
  keep('release', await R.call('/v1/release', { uid: ub.uid, ticket: t.body.ticket, ts: ts2, sig: kb.sign(`snug-reg-v1\nrelease\n${ub.uid}\n${t.body.ticket}\n${ts2}`) }));
  keep('notices', await R.call('/v1/notices'));
  // Random values (uids, tickets, keys, signatures, times) differ between runs: name them by first appearance.
  const names = new Map();
  const norm = (v, k) => {
    if (typeof v === 'string' && (/^[a-z2-7]{16}$/.test(v) || /^[A-Za-z0-9_-]{22,}$/.test(v))) {
      if (!names.has(v)) names.set(v, `<${names.size}>`);
      return names.get(v);
    }
    if (typeof v === 'number' && ['now', 'at', 'claimedAt', 'renamedAt', 'renameAt', 'retryAt'].includes(k)) return v > 0 ? '<time>' : v;
    if (Array.isArray(v)) return v.map((x) => norm(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, norm(x, kk)]));
    return v;
  };
  return norm(out);
}

test('a 0.11 client flow is byte-for-byte the same with keypair accounts on and off', async () => {
  const on = await start({ env: { KEY_ACCOUNTS: '1' } });
  const off = await start({ env: { KEY_ACCOUNTS: '0' } });
  try {
    const a = await flow011(on);
    const b = await flow011(off);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    // and it really ran: sign-up, the move and the release all succeeded
    const statuses = a.filter((x) => typeof x[1] === 'number').map((x) => x[1]);
    assert.ok(statuses.every((s) => s === 200), JSON.stringify(a));
  } finally {
    await on.close();
    await off.close();
  }
});
