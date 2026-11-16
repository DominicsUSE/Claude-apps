// Regression tests for the second pass over the v0.12 identity review (the verifier's findings after the
// first fixes): GitHub links can't be replaced by the device alone and the linked GitHub can cancel what the
// device asked for (H3 link), move.force needs a key (H3 force), a moving PC can read and cancel waiting
// changes (H3 cancel paths), cancel names what it cancels and the recovery key co-signs an immediate unlink
// (H3 fast unlink), and the sign-up budgets (ipAccount refund, the IPv6 /32 count raising the proof of work).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { start, makeKeys, OWNER_ID, HOUR, DAY } from './helpers.js';
import { registerStr, recoverStr, powInput } from '../src/keyacct.js';

let reg;
let nextGh = 91000;
let nextName = 0;
before(async () => {
  reg = await start({ env: { POW_BITS: '6' } });
});
after(() => reg.close());

const uniq = (p = 'fx') => `${p}${++nextName}y`;
function zeroBits(d) {
  let n = 0;
  for (const b of d) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; }
  return n;
}
function solve(c, ik, bits) {
  for (let n = 0; ; n++) if (zeroBits(createHash('sha256').update(powInput(c, ik, String(n))).digest()) >= bits) return String(n);
}
async function register(name, { R = reg, k = makeKeys(), r = makeKeys(), ipAddr } = {}) {
  const pw = (await R.call('/v1/pow', { purpose: 'register' }, { ip: ipAddr })).body;
  const f = { ik: k.ik, xk: k.xk, rk: r.ik, username: name, c: pw.c, nonce: solve(pw.c, k.ik, pw.bits), ts: R.ts() };
  const msg = registerStr(f);
  const res = await R.call('/v1/register', { ...f, sig: k.sign(msg), rsig: r.sign(msg) }, { ip: ipAddr });
  return { res, k, r, uid: res.body?.account?.uid, name, bits: pw.bits };
}
async function account(name, opts) {
  const a = await register(name, opts);
  assert.equal(a.res.status, 200, JSON.stringify(a.res.body));
  return a;
}
function sp(u, path, op, payload, { k = u.k, ts = reg.ts(), rk = null } = {}) {
  const p = JSON.stringify(payload);
  const msg = `snug-reg-v1\n${op}\n${u.uid}\n${ts}\n${p}`;
  return reg.call(path, { uid: u.uid, ts, p, sig: k.sign(msg), ...(rk ? { rsig: rk.sign(msg) } : {}) });
}
const kind = (u, k = u.k) => sp(u, '/v1/account/kind', 'account-kind', {}, { k });
function recCancel(u, r, what) {
  const ts = reg.ts();
  const msg = `snug-reg-v1\nrecovery-cancel\n${u.uid}\n${ts}${what ? `\n${what}` : ''}`;
  return reg.call('/v1/recovery/cancel', { uid: u.uid, ts, rsig: r.sign(msg), ...(what ? { what } : {}) });
}
async function ghCancel(ghId, what) {
  const k3 = makeKeys();
  const t = (await reg.authId(k3, ghId)).body;
  const ts = reg.ts();
  const msg = `snug-reg-v1\nrecovery-cancel-gh\n${t.ticket}\n${ts}${what ? `\n${what}` : ''}`;
  return reg.call('/v1/recovery/cancel', { ticket: t.ticket, ts, sig: k3.sign(msg), ...(what ? { what } : {}) });
}
function recSet(u, nr) {
  const ts = reg.ts();
  const msg = `snug-reg-v1\nrecovery-set\n${u.uid}\n${nr.ik}\n${ts}`;
  return sp(u, '/v1/recovery/set', 'recovery-set', { rk: nr.ik, rsigNew: nr.sign(msg) }, { ts });
}
async function recover(u, k2 = makeKeys(), r = u.r) {
  const f = { rk: r.ik, ik: k2.ik, xk: k2.xk, ts: reg.ts() };
  const msg = recoverStr(f);
  return { res: await reg.call('/v1/recover', { ...f, sig: k2.sign(msg), rsig: r.sign(msg) }), k2 };
}
function release(u, ticket, k = u.k) {
  const ts = reg.ts();
  return reg.call('/v1/release', { uid: u.uid, ticket, ts, sig: k.sign(`snug-reg-v1\nrelease\n${u.uid}\n${ticket}\n${ts}`) });
}
async function connected(u) {
  const s = await reg.connect(u.uid, u.k);
  s.close();
}
const ghTicket = async (k, ghId) => (await reg.authId(k, ghId)).body;
const link = async (u, gid, opts) => sp(u, '/v1/link/github', 'link-github', { ticket: (await ghTicket(u.k, gid)).ticket }, opts);
async function linked(u) {
  const gid = nextGh++;
  assert.equal((await link(u, gid)).body.state, 'pending');
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  assert.equal((await kind(u)).body.github.linked, true);
  return gid;
}
let ownerU = null;
const theOwner = async () => (ownerU ||= await reg.signUp(OWNER_ID, 'a'));
const adm = (u, payload) => sp(u, '/v1/admin', 'admin', payload);
const lookupIk = async (viewer, uid) => (await reg.lookup(viewer, { uid })).body.ik;

// ---------- H3 (link replace / unlink) ----------

test('H3 link: a link can not be replaced while one exists; the device must unlink first', async () => {
  const u = await account(uniq('lrep'));
  await connected(u);
  const ownerGh = await linked(u);
  const thiefGh = nextGh++;
  const l = await link(u, thiefGh);
  assert.equal(l.status, 409, JSON.stringify(l.body));
  assert.equal(l.body.error, 'already_linked');
  assert.equal((await kind(u)).body.github.pending, null);
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  assert.equal((await reg.authId(makeKeys(), ownerGh)).body.status, 'rebind', 'the owner\'s GitHub still proves the account');
  assert.equal((await reg.authId(makeKeys(), thiefGh)).body.status, 'new');
});

test('H3 link: the linked GitHub cancels a waiting unlink and a waiting recovery key (the verifier\'s PoC A)', async () => {
  const u = await account(uniq('lgh'));
  await connected(u);
  const ownerGh = await linked(u);
  assert.equal((await sp(u, '/v1/link/github/remove', 'unlink-github', {})).body.state, 'pending');
  const thiefR = makeKeys();
  assert.equal((await recSet(u, thiefR)).body.state, 'pending');
  const c = await ghCancel(ownerGh);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const kd = (await kind(u)).body;
  assert.equal(kd.github.pending, null);
  assert.equal(kd.recovery.pendingAt, null);
  await reg.clock.advance(7 * DAY + 1000);
  await connected(u);
  assert.equal((await kind(u)).body.github.linked, true, 'the cancelled unlink never happened');
  assert.equal((await reg.authId(makeKeys(), ownerGh)).body.status, 'rebind');
  assert.equal((await recover(u, makeKeys(), thiefR)).res.status, 404, 'the thief\'s recovery key never took effect');
});

test('H3 link: a link that came from the wait is as young as the moment it applied (no instant release)', async () => {
  const u = await account(uniq('lage'));
  await connected(u);
  const gid = await linked(u);
  const young = await release(u, (await ghTicket(u.k, gid)).ticket);
  assert.equal(young.status, 409, JSON.stringify(young.body));
  assert.equal(young.body.error, 'link_too_new');
  await reg.clock.advance(7 * DAY + 1000);
  assert.equal((await release(u, (await ghTicket(u.k, gid)).ticket)).status, 200);
});

// ---------- H3 (move.force without fp) ----------

test('H3 force: move.force needs fp or ik, so it can not complete a move someone swapped in (PoC B)', async () => {
  const owner = await theOwner();
  const u = await account(uniq('fbare'));
  await connected(u);
  const ownerNew = makeKeys();
  assert.equal((await recover(u, ownerNew)).res.status, 200);
  const atk = makeKeys();
  assert.equal((await recover(u, atk)).res.status, 200);
  const f = await adm(owner, { a: 'move.force', uid: u.uid });
  assert.equal(f.status, 400, JSON.stringify(f.body));
  assert.equal(await lookupIk(owner, u.uid), u.k.ik, 'nothing completed');
  // naming the owner's key arms the force; the attacker's waiting move is not it
  assert.equal((await adm(owner, { a: 'move.force', uid: u.uid, ik: ownerNew.ik })).body.state, 'armed');
  assert.equal(await lookupIk(owner, u.uid), u.k.ik);
  assert.equal((await recover(u, ownerNew)).res.status, 200);
  assert.equal(await lookupIk(owner, u.uid), ownerNew.ik);
});

// ---------- H3 (cancel paths for the owner who lost the PC) ----------

test('H3 cancel: a moving PC (the pending key) reads the account\'s waiting changes', async () => {
  const u = await account(uniq('kpen'));
  await connected(u);
  assert.equal((await link(u, nextGh++)).body.state, 'pending');
  assert.equal((await recSet(u, makeKeys())).body.state, 'pending');
  const { res, k2 } = await recover(u);
  assert.equal(res.status, 200);
  const kd = await kind(u, k2);
  assert.equal(kd.status, 200, JSON.stringify(kd.body));
  assert.equal(kd.body.kind, 'key');
  assert.equal(kd.body.github.pending.change, 'link');
  assert.ok(kd.body.recovery.pendingAt > reg.clock.now());
  assert.equal(kd.body.move.via, 'recovery');
  assert.equal(kd.body.recovery.rk, undefined, 'the pending key is not told the recovery key');
  // and from there the recovery key cancels them
  assert.equal((await recCancel(u, u.r)).status, 200);
  const kd2 = (await kind(u, k2)).body;
  assert.equal(kd2.github.pending, null);
  assert.equal(kd2.recovery.pendingAt, null);
  // a key that is neither current nor pending is still refused
  assert.equal((await kind(u, makeKeys())).body.error, 'bad_signature');
});

// ---------- H3 (cancel names what; fast unlink) ----------

test('H3 cancel: {what} cancels only that change; no what cancels both (as before)', async () => {
  const u = await account(uniq('cwhat'));
  await connected(u);
  assert.equal((await link(u, nextGh++)).body.state, 'pending');
  assert.equal((await recSet(u, makeKeys())).body.state, 'pending');
  assert.equal((await recCancel(u, u.r, 'link')).status, 200);
  let kd = (await kind(u)).body;
  assert.equal(kd.github.pending, null, 'the link is cancelled');
  assert.ok(kd.recovery.pendingAt, 'the new recovery key still waits');
  assert.equal((await link(u, nextGh++)).body.state, 'pending');
  assert.equal((await recCancel(u, u.r, 'key')).status, 200);
  kd = (await kind(u)).body;
  assert.equal(kd.recovery.pendingAt, null);
  assert.ok(kd.github.pending, 'the link still waits');
  assert.equal((await recCancel(u, u.r, 'bogus')).status, 400);
  // the signature covers what: a cancel signed for "key" can't be sent as "link"
  const ts = reg.ts();
  const bad = await reg.call('/v1/recovery/cancel', { uid: u.uid, ts, what: 'link', rsig: u.r.sign(`snug-reg-v1\nrecovery-cancel\n${u.uid}\n${ts}\nkey`) });
  assert.equal(bad.body.error, 'bad_signature');
  assert.equal((await recCancel(u, u.r)).status, 200);
  assert.equal((await kind(u)).body.github.pending, null);
});

test('H3 fast unlink: the device and the recovery key together unlink (and link) at once', async () => {
  const u = await account(uniq('fast'));
  await connected(u);
  const phished = await linked(u);
  const wrong = await sp(u, '/v1/link/github/remove', 'unlink-github', {}, { rk: makeKeys() });
  assert.equal(wrong.body.error, 'bad_signature');
  const un = await sp(u, '/v1/link/github/remove', 'unlink-github', {}, { rk: u.r });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.state, 'done');
  assert.equal((await kind(u)).body.github.linked, false);
  assert.equal((await reg.authId(makeKeys(), phished)).body.status, 'new', 'that GitHub proves nothing now');
  const gid = nextGh++;
  const l = await link(u, gid, { rk: u.r });
  assert.equal(l.body.state, 'done', JSON.stringify(l.body));
  assert.equal((await reg.authId(makeKeys(), gid)).body.status, 'rebind');
});

// ---------- Low: ipAccount spent by a mistyped or taken name ----------

test('Low: a sign-up refused for its name gives back the shared ipAccount allowance', async () => {
  const R = await start({ trustClientIp: true, env: { POW_BITS: '2', TEST_LIMITS: { ipAccount: [3, HOUR] } } });
  try {
    const first = await account(uniq('ia'), { R, ipAddr: '203.0.113.70' });
    for (let i = 0; i < 3; i++) assert.equal((await register(first.name, { R, ipAddr: '203.0.113.71' })).res.body.error, 'taken');
    for (let i = 0; i < 3; i++) assert.equal((await register('x y', { R, ipAddr: '203.0.113.71' })).res.body.error, 'invalid_name');
    assert.equal((await register(uniq('ia'), { R, ipAddr: '203.0.113.71' })).res.status, 200);
  } finally {
    await R.close();
  }
});

// ---------- Medium: the per-/32 count raises the work instead of refusing ----------

test('M6 /32: past the /32 count, sign-ups still work but the proof of work gets harder', async () => {
  const R = await start({ trustClientIp: true, env: { POW_BITS: '2', TEST_LIMITS: { ipRegister: [3, DAY], ipRegisterWide: [4, DAY] } } });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await account(uniq('wide'), { R, ipAddr: `2001:db9:${(i + 1).toString(16)}::1` })).bits, 2);
    const fifth = await register(uniq('wide'), { R, ipAddr: '2001:db9:99::1' });
    assert.equal(fifth.res.status, 200, JSON.stringify(fifth.res.body));
    assert.ok(fifth.bits >= 4, `bits in a busy /32: ${fifth.bits}`);
    assert.equal((await R.call('/v1/pow', { purpose: 'register' }, { ip: '2001:dba:1::1' })).body.bits, 2, 'another /32');
    // a challenge issued before the /32 got busy (8 sign-ups: 4 more bits, 2 of them allowed as slack) is refused
    const early = (await R.call('/v1/pow', { purpose: 'register' }, { ip: '2001:db8:aa::1' })).body;
    for (let i = 0; i < 8; i++) await account(uniq('wide'), { R, ipAddr: `2001:db8:${(i + 1).toString(16)}::1` });
    const k = makeKeys(), r = makeKeys();
    const f = { ik: k.ik, xk: k.xk, rk: r.ik, username: uniq('wide'), c: early.c, nonce: solve(early.c, k.ik, early.bits), ts: R.ts() };
    const msg = registerStr(f);
    const late = await R.call('/v1/register', { ...f, sig: k.sign(msg), rsig: r.sign(msg) }, { ip: '2001:db8:bb::1' });
    assert.equal(late.body.error, 'pow_invalid', JSON.stringify(late.body));
  } finally {
    await R.close();
  }
});
