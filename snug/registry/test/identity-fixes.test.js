// Regression tests for the v0.12 identity review: replay counters per signer (C1, C2), second proofs that
// wait 7 days and forced moves bound to one key (H3), the proof-of-work difficulty checked at sign-up and
// wider per-address budgets (M6), the purge and sign-up budget fixes (Low). Several started as the
// reviewer's proof-of-concept tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { start, makeKeys, OWNER_ID, HOUR, DAY } from './helpers.js';
import { registerStr, recoverStr, powInput } from '../src/keyacct.js';

let reg;
let nextGh = 71000;
let nextName = 0;
before(async () => {
  reg = await start({ env: { POW_BITS: '6' } });
});
after(() => reg.close());

const uniq = (p = 'fix') => `${p}${++nextName}x`;
let ipn = 0;
const ip = () => { ipn++; return `198.18.${(ipn >> 8) & 255}.${ipn & 255}`; };

function zeroBits(d) {
  let n = 0;
  for (const b of d) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; }
  return n;
}
const bitsOf = (c, ik, nonce) => zeroBits(createHash('sha256').update(powInput(c, ik, nonce)).digest());
function solve(c, ik, bits, below = Infinity) {
  for (let n = 0; ; n++) {
    const z = bitsOf(c, ik, String(n));
    if (z >= bits && z < below) return String(n);
  }
}

async function register(name, { R = reg, k = makeKeys(), r = makeKeys(), ipAddr, pw = null, nonce = null } = {}) {
  pw ||= (await R.call('/v1/pow', { purpose: 'register' }, { ip: ipAddr })).body;
  const f = { ik: k.ik, xk: k.xk, rk: r.ik, username: name, c: pw.c, nonce: nonce ?? solve(pw.c, k.ik, pw.bits), ts: R.ts() };
  const msg = registerStr(f);
  const res = await R.call('/v1/register', { ...f, sig: k.sign(msg), rsig: r.sign(msg) }, { ip: ipAddr });
  return { res, k, r, uid: res.body?.account?.uid, name };
}
async function account(name, opts) {
  const a = await register(name, opts);
  assert.equal(a.res.status, 200, JSON.stringify(a.res.body));
  return a;
}
function sp(u, path, op, payload, { k = u.k, ts = reg.ts(), extra = () => ({}), R = reg } = {}) {
  const p = JSON.stringify(payload);
  const msg = `snug-reg-v1\n${op}\n${u.uid}\n${ts}\n${p}`;
  return R.call(path, { uid: u.uid, ts, p, sig: k.sign(msg), ...extra(msg, ts) });
}
const kind = (u, k = u.k) => sp(u, '/v1/account/kind', 'account-kind', {}, { k });
const recCancel = (u, r, ts = reg.ts()) => reg.call('/v1/recovery/cancel', { uid: u.uid, ts, rsig: r.sign(`snug-reg-v1\nrecovery-cancel\n${u.uid}\n${ts}`) });
const stop = (u, k = u.k, ts = reg.ts()) => reg.call('/v1/rebind/cancel', { uid: u.uid, ts, sig: k.sign(`snug-reg-v1\nrebind-cancel\n${u.uid}\n${ts}`) });
function recSet(u, nr, { ts = reg.ts(), old = null } = {}) {
  const msg = `snug-reg-v1\nrecovery-set\n${u.uid}\n${nr.ik}\n${ts}`;
  const p = { rk: nr.ik, rsigNew: nr.sign(msg), ...(old ? { rsigOld: old.sign(msg) } : {}) };
  return sp(u, '/v1/recovery/set', 'recovery-set', p, { ts });
}
async function recover(u, k2 = makeKeys(), r = u.r) {
  const f = { rk: r.ik, ik: k2.ik, xk: k2.xk, ts: reg.ts() };
  const msg = recoverStr(f);
  return { res: await reg.call('/v1/recover', { ...f, sig: k2.sign(msg), rsig: r.sign(msg) }), k2 };
}
async function rebind(k, ghId) {
  const a = (await reg.authId(k, ghId)).body;
  const ts = reg.ts();
  return reg.call('/v1/rebind', { ticket: a.ticket, ts, sig: k.sign(`snug-reg-v1\nrebind\n${a.ticket}\n${ts}`) });
}
function release(u, ticket, k = u.k) {
  const ts = reg.ts();
  return reg.call('/v1/release', { uid: u.uid, ticket, ts, sig: k.sign(`snug-reg-v1\nrelease\n${u.uid}\n${ticket}\n${ts}`) });
}
async function connected(u, R = reg) {
  const s = await R.connect(u.uid, u.k);
  s.close();
}
const ghTicket = async (k, ghId) => (await reg.authId(k, ghId)).body;
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 5000, `${what}: ${a} vs ${b}`);
let ownerU = null;
const theOwner = async () => (ownerU ||= await reg.signUp(OWNER_ID, 'a'));
const adm = (u, payload) => sp(u, '/v1/admin', 'admin', payload);
const lookupIk = async (viewer, uid) => (await reg.lookup(viewer, { uid })).body.ik;

// ---------- C1, C2: replay counters ----------

test('C1: the recovery key has its own replay counter: its cancel cannot push the old PC Stop out', async () => {
  const u = await account(uniq('cone'));
  const { res } = await recover(u);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // the PoC's ts = now + 299 s is refused outright: state-changing calls allow only a little clock skew
  assert.equal((await recCancel(u, u.r, reg.clock.now() + 299_000)).body.error, 'stale');
  // inside the allowed skew it is accepted, and moves only the recovery key's own counter
  assert.equal((await recCancel(u, u.r, reg.clock.now() + 50_000)).status, 200);
  const s = await stop(u, u.k, reg.clock.now());
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await kind(u)).body.move, null, 'the old PC stopped the move');
  // the recovery key's counter still refuses a replay
  const ts = reg.clock.now() + 55_000;
  assert.equal((await recCancel(u, u.r, ts)).status, 200);
  assert.equal((await recCancel(u, u.r, ts)).body.error, 'stale');
});

test('C2: a failed call never moves the counter; the device counter cannot block the recovery key', async () => {
  const u = await account(uniq('ctwo'));
  const T = reg.clock.now() + 40_000;
  const f = await sp(u, '/v1/link/github', 'link-github', { ticket: makeKeys().ik }, { ts: T });
  assert.equal(f.body.error, 'bad_ticket');
  const ok = await sp(u, '/v1/link/github/remove', 'unlink-github', {}, { ts: T - 10_000 });
  assert.equal(ok.status, 200, `the failed call did not bump the counter: ${JSON.stringify(ok.body)}`);
  // a device thief sets its own recovery key (it waits 7 days) at the latest ts it may use
  const thiefR = makeKeys();
  const set = await recSet(u, thiefR, { ts: reg.clock.now() + 59_000 });
  assert.equal(set.body.state, 'pending', JSON.stringify(set.body));
  // the owner's recovery key, signing with the real time, still cancels it
  const c = await recCancel(u, u.r, reg.clock.now());
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await kind(u)).body.recovery.pendingAt, null);
  // too far ahead is refused for device-signed changes too
  assert.equal((await sp(u, '/v1/link/github/remove', 'unlink-github', {}, { ts: reg.clock.now() + 120_000 })).body.error, 'stale');
});

// ---------- H3: second proofs wait; forced moves are bound ----------

test('H3: a GitHub link waits 7 days and proves nothing until then; the recovery key cancels it', async () => {
  const u = await account(uniq('hlink'));
  await connected(u);
  const gid = nextGh++;
  const t = await ghTicket(u.k, gid);
  assert.equal(t.status, 'new');
  const l = await sp(u, '/v1/link/github', 'link-github', { ticket: t.ticket });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.state, 'pending');
  near(l.body.at, reg.clock.now() + 7 * DAY, 'at');
  let kd = (await kind(u)).body;
  assert.equal(kd.github.linked, false);
  assert.deepEqual(kd.github.pending, { change: 'link', at: l.body.at });
  // not a proof yet: a GitHub sign-in finds no account, and release through it is refused
  assert.equal((await reg.authId(makeKeys(), gid)).body.status, 'new');
  assert.equal((await release(u, (await ghTicket(u.k, gid)).ticket)).body.error, 'bad_ticket');
  // the recovery key cancels it
  assert.equal((await recCancel(u, u.r)).status, 200);
  kd = (await kind(u)).body;
  assert.equal(kd.github.pending, null);
  // again, and nobody cancels: it takes effect after 7 days
  const t2 = await ghTicket(u.k, gid);
  assert.equal((await sp(u, '/v1/link/github', 'link-github', { ticket: t2.ticket })).body.state, 'pending');
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  assert.equal((await kind(u)).body.github.linked, true);
  const other = await reg.authId(makeKeys(), gid);
  assert.equal(other.body.status, 'rebind');
  assert.equal(other.body.account.uid, u.uid);
});

test('H3: unlinking waits 7 days too, and the recovery key cancels it', async () => {
  const u = await account(uniq('hunl'));
  await connected(u);
  const gid = nextGh++;
  await sp(u, '/v1/link/github', 'link-github', { ticket: (await ghTicket(u.k, gid)).ticket });
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  assert.equal((await kind(u)).body.github.linked, true);
  const un = await sp(u, '/v1/link/github/remove', 'unlink-github', {});
  assert.equal(un.body.state, 'pending', JSON.stringify(un.body));
  assert.equal((await kind(u)).body.github.linked, true, 'still linked while the change waits');
  assert.equal((await recCancel(u, u.r)).status, 200);
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  assert.equal((await kind(u)).body.github.linked, true, 'the cancelled unlink never happened');
  assert.equal((await sp(u, '/v1/link/github/remove', 'unlink-github', {})).body.state, 'pending');
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  assert.equal((await kind(u)).body.github.linked, false);
  assert.equal((await reg.authId(makeKeys(), gid)).body.status, 'new');
});

test('H3: /v1/release through a linked GitHub needs a link older than the wait', async () => {
  const u = await account(uniq('hrel'));
  await connected(u);
  const gid = nextGh++;
  await sp(u, '/v1/link/github', 'link-github', { ticket: (await ghTicket(u.k, gid)).ticket });
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  // a link made before this fix took effect at once: one made an hour ago
  reg.runtime.sql('UPDATE gh_links SET at=? WHERE uid=?', reg.clock.now() - HOUR, u.uid);
  const young = await release(u, (await ghTicket(u.k, gid)).ticket);
  assert.equal(young.status, 409, JSON.stringify(young.body));
  assert.equal(young.body.error, 'link_too_new');
  assert.ok(young.body.retryAt > reg.clock.now());
  assert.ok(reg.runtime.sql('SELECT 1 AS x FROM accounts WHERE uid=?', u.uid).length, 'still there');
  reg.runtime.sql('UPDATE gh_links SET at=? WHERE uid=?', reg.clock.now() - 8 * DAY, u.uid);
  assert.equal((await release(u, (await ghTicket(u.k, gid)).ticket)).status, 200);
});

test('H3: a GitHub account\'s first recovery key waits 7 days; the GitHub account cancels it', async () => {
  const g = await reg.signUp(nextGh++, uniq('ghrk'));
  const nr = makeKeys();
  const s = await recSet(g, nr);
  assert.equal(s.body.state, 'pending', JSON.stringify(s.body));
  near(s.body.at, reg.clock.now() + 7 * DAY, 'at');
  const kd = (await kind(g)).body;
  assert.equal(kd.recovery.set, false);
  assert.equal(kd.recovery.pendingAt, s.body.at);
  assert.equal((await recover(g, makeKeys(), nr)).res.status, 404, 'it moves nothing yet');
  // GitHub (the account's proof) cancels it: any key may hold the ticket
  const k3 = makeKeys();
  const t = await ghTicket(k3, g.ghId);
  const ts = reg.ts();
  const bad = await reg.call('/v1/recovery/cancel', { ticket: t.ticket, ts, sig: makeKeys().sign(`snug-reg-v1\nrecovery-cancel-gh\n${t.ticket}\n${ts}`) });
  assert.equal(bad.body.error, 'bad_signature');
  const ts2 = reg.ts();
  const c = await reg.call('/v1/recovery/cancel', { ticket: t.ticket, ts: ts2, sig: k3.sign(`snug-reg-v1\nrecovery-cancel-gh\n${t.ticket}\n${ts2}`) });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await kind(g)).body.recovery.pendingAt, null);
  // again, and nobody cancels
  const nr2 = makeKeys();
  assert.equal((await recSet(g, nr2)).body.state, 'pending');
  await reg.clock.advance(7 * DAY + 1000);
  assert.equal((await kind(g)).body.recovery.set, true);
  // with the current key in hand, a replacement is immediate as before
  assert.equal((await recSet(g, makeKeys(), { old: nr2 })).body.state, 'set');
});

test('H3: an armed forced move completes only for the key it was armed for', async () => {
  const owner = await theOwner();
  const g = await reg.signUp(nextGh++, uniq('ghfo'));
  // no move waiting and no key named: nothing to bind the force to
  const none = await adm(owner, { a: 'move.force', uid: g.uid });
  assert.equal(none.status, 404, JSON.stringify(none.body));
  const mine = makeKeys();
  const armed = await adm(owner, { a: 'move.force', uid: g.uid, ik: mine.ik });
  assert.equal(armed.body.state, 'armed', JSON.stringify(armed.body));
  // someone else's GitHub-proved move gets the normal 72 h wait (the force is not used up)
  const thief = makeKeys();
  const tr = await rebind(thief, g.ghId);
  assert.equal(tr.status, 200);
  assert.ok(tr.body.at > reg.clock.now() + 71 * HOUR, 'not forced');
  // the person's own new PC: at once
  const mr = await rebind(mine, g.ghId);
  assert.equal(mr.status, 200, JSON.stringify(mr.body));
  near(mr.body.at, reg.clock.now(), 'forced');
  assert.equal(await lookupIk(owner, g.uid), mine.ik);

  // a keypair account: the recovery move of the bound key, not another one
  const u = await account(uniq('kfo'));
  await connected(u);
  const k4 = makeKeys();
  assert.equal((await adm(owner, { a: 'move.force', uid: u.uid, ik: k4.ik })).body.state, 'armed');
  const other = await recover(u, makeKeys());
  assert.ok(other.res.body.at > reg.clock.now() + 71 * HOUR, 'not forced');
  const own = await recover(u, k4);
  assert.equal(own.res.status, 200, JSON.stringify(own.res.body));
  near(own.res.body.at, reg.clock.now(), 'forced');
  assert.equal(await lookupIk(owner, u.uid), k4.ik);
});

// ---------- M6: proof-of-work difficulty and wider budgets ----------

test('M6: a challenge issued at a lower difficulty is refused once sign-ups raise it; the window slides', async () => {
  const R = await start({ trustClientIp: true, env: { POW_BITS: '6' } });
  try {
    const k = makeKeys();
    const early = (await R.call('/v1/pow', { purpose: 'register' }, { ip: ip() })).body;
    assert.equal(early.bits, 6);
    const nonce = solve(early.c, k.ik, 6, 8); // 6 or 7 zero bits: below what 61 sign-ups ask for
    for (let i = 0; i < 61; i++) await account(uniq('pow'), { R, ipAddr: ip() });
    const now = (await R.call('/v1/pow', { purpose: 'register' }, { ip: ip() })).body;
    assert.ok(now.bits >= 8, `bits now ${now.bits}`);
    const late = await register(uniq('late'), { R, k, pw: early, nonce, ipAddr: ip() });
    assert.equal(late.res.body.error, 'pow_invalid');
    // the hour turning over does not reset the difficulty at once
    const t = R.clock.now();
    await R.clock.advance(Math.ceil(t / HOUR) * HOUR - t + 60_000);
    const next = (await R.call('/v1/pow', { purpose: 'register' }, { ip: ip() })).body;
    assert.ok(next.bits > 6, `bits after the hour: ${next.bits}`);
  } finally {
    await R.close();
  }
});

test('M6: proof-of-work challenges count per /48; sign-ups also count per IPv6 /32', async () => {
  const R = await start({ trustClientIp: true, env: { POW_BITS: '2', TEST_LIMITS: { ipPow: [20, HOUR], ipRegister: [3, DAY], ipRegisterWide: [4, DAY] } } });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await R.call('/v1/pow', { purpose: 'register' }, { ip: `2001:db8:77:${i.toString(16)}::1` })).status, 200);
    assert.equal((await R.call('/v1/pow', { purpose: 'register' }, { ip: '2001:db8:77:ff::1' })).status, 429, 'the same /48');
    for (let i = 0; i < 4; i++) await account(uniq('w'), { R, ipAddr: `2001:db9:${(i + 1).toString(16)}::1` });
    const fifth = await register(uniq('w'), { R, ipAddr: '2001:db9:99::1' });
    assert.equal(fifth.res.status, 429, 'the same /32');
    assert.equal((await register(uniq('w'), { R, ipAddr: '2001:dba:1::1' })).res.status, 200, 'another /32');
  } finally {
    await R.close();
  }
});

// ---------- Low ----------

test('Low: an account with a recovery move waiting is not purged, and the new PC gets its own 7 days', async () => {
  const u = await account(uniq('lpur'));
  await reg.clock.advance(6 * DAY + 12 * HOUR);
  const { res, k2 } = await recover(u);
  assert.equal(res.status, 200);
  await reg.clock.advance(DAY);
  const exists = () => reg.runtime.sql('SELECT 1 AS x FROM accounts WHERE uid=?', u.uid).length === 1;
  assert.equal(exists(), true, 'kept while the move waits');
  await reg.clock.advance(2 * DAY + 1000); // the move completed
  assert.equal(exists(), true, 'kept after the move');
  assert.equal(await lookupIk(await theOwner(), u.uid), k2.ik);
});

test('Low: a refused sign-up does not use up the address\'s daily sign-ups', async () => {
  const R = await start({ trustClientIp: true, env: { POW_BITS: '2', TEST_LIMITS: { ipRegister: [3, DAY], ipAccount: [10, HOUR] } } });
  try {
    const first = await account(uniq('lreg'), { R, ipAddr: '203.0.113.50' });
    for (let i = 0; i < 3; i++) assert.equal((await register(first.name, { R, ipAddr: '203.0.113.51' })).res.body.error, 'taken');
    for (let i = 0; i < 3; i++) await account(uniq('lreg'), { R, ipAddr: '203.0.113.51' });
    assert.equal((await register(uniq('lreg'), { R, ipAddr: '203.0.113.51' })).res.status, 429);
  } finally {
    await R.close();
  }
});
