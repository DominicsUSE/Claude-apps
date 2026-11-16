// Security fixes for the registry (sec-registry). Each test failed on the code before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, makeKeys, HOUR, DAY, OWNER_ID } from './helpers.js';
import { relaxedLimits } from '../dev.js';

async function startMove(reg, u, k2 = makeKeys()) {
  const a = await reg.authId(k2, u.ghId);
  assert.equal(a.body.status, 'rebind', JSON.stringify(a.body));
  const ts = reg.ts();
  const res = await reg.call('/v1/rebind', { ticket: a.body.ticket, ts, sig: k2.sign(`snug-reg-v1\nrebind\n${a.body.ticket}\n${ts}`) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return k2;
}
async function approve(reg, u, k2, kver = 2) {
  const res = await reg.call('/v1/rebind/approve', { uid: u.uid, kver, ik: k2.ik, xk: k2.xk, prev: u.k.sign(`snug-keychange-v1\n${u.uid}\n${kver}\n${k2.ik}\n${k2.xk}`) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
const xferAuth = (uid, k) => (c) => ({ t: 'auth', uid, mode: 'xfer', v: '0.10.1', sig: k.sign(`snug-reg-v1\nsignal-xfer\n${uid}\n${c.n}`) });
async function xfer(reg, uid, k) {
  const s = await reg.connect(uid, k, { auth: xferAuth(uid, k) });
  s.ready = await s.next((m) => m.t === 'ready').catch(() => null);
  return s;
}

// ---------- REG-M1: other keys can't use up the current key's connect budget ----------
test('REG-M1: 30+ xfer/pending sockets of a pending key do not lock the current key out; it still hears about the move', async () => {
  const reg = await start({ limits: { ...relaxedLimits(), connect: [30, HOUR] } }); // the production per-uid cap
  try {
    const u = await reg.signUp(5151, 'lockme');
    const k2 = await startMove(reg, u);
    for (let i = 0; i < 40; i++) {
      const s = await reg.connect(u.uid, k2, { auth: i % 2 ? xferAuth(u.uid, k2) : reg.signAuth(u.uid, k2) });
      await s.next((m) => m.t === 'ready' || m.t === 'never').catch(() => null);
      s.close();
    }
    const victim = await reg.connect(u.uid, u.k);
    assert.equal(victim.ready.mode, 'normal');
    assert.equal(victim.ready.rebind.ik, k2.ik, 'the current PC hears about the pending move');
    victim.close();
  } finally {
    await reg.close();
  }
});

test('REG-M1: a stolen old key can’t lock the new current key out of signaling for 30 days', async () => {
  const reg = await start({ limits: { ...relaxedLimits(), connect: [30, HOUR] } });
  try {
    const u = await reg.signUp(5152, 'lockme2');
    const k2 = await startMove(reg, u);
    await approve(reg, u, k2); // u.k is now 'old' (e.g. the laptop that was stolen), k2 current
    for (let i = 0; i < 40; i++) {
      const s = await xfer(reg, u.uid, u.k);
      s.close();
    }
    const cur = await reg.connect(u.uid, k2);
    assert.equal(cur.ready.mode, 'normal');
    cur.close();
  } finally {
    await reg.close();
  }
});

test('REG-M1: the current key’s own budget still applies, and a refused socket still learns of a pending move', async () => {
  const reg = await start({ limits: { ...relaxedLimits(), connect: [3, HOUR] } });
  try {
    const u = await reg.signUp(5153, 'lockme3');
    for (let i = 0; i < 3; i++) (await reg.connect(u.uid, u.k)).close();
    const k2 = await startMove(reg, u);
    const s = await reg.connect(u.uid, u.k, { auth: reg.signAuth(u.uid, u.k) });
    const c = await s.closed;
    assert.equal(c.code, 4029);
    const rb = s.q.find((m) => m.t === 'rebind');
    assert.ok(rb, `pending move sent before the 4029 close: ${JSON.stringify(s.q)}`);
    assert.equal(rb.state, 'pending');
    assert.equal(rb.ik, k2.ik);
  } finally {
    await reg.close();
  }
});

// ---------- REG-M2: recovery from a stolen current device ----------
function adminCall(reg, who, d) {
  const ts = reg.ts();
  const p = JSON.stringify(d);
  return reg.call('/v1/admin', { uid: who.uid, ts, p, sig: who.k.sign(`snug-reg-v1\nadmin\n${who.uid}\n${ts}\n${p}`) });
}
const cancel = (reg, uid, k) => reg.signed('/v1/rebind/cancel', k, { uid }, (ts) => ['rebind-cancel', uid, ts]);

test('REG-M2: a thief holding the current key can cancel moves, but the owner can force the GitHub-proved move (audited)', async () => {
  const reg = await start();
  try {
    const owner = await reg.signUp(OWNER_ID, 'a');
    const u = await reg.signUp(6161, 'stolenlaptop'); // u.k now sits on a stolen laptop
    const k2 = await startMove(reg, u); // the real owner signs in with GitHub on a new PC
    assert.equal((await cancel(reg, u.uid, u.k)).status, 200, 'the thief presses Stop');
    // The owner of the registry (after checking with the user, e.g. over GitHub) arms a forced move. v0.12
    // review H3: with no move waiting, the force is bound to the new PC's key (read from its security code).
    assert.equal((await adminCall(reg, owner, { a: 'move.force', uid: u.uid })).status, 400, 'no key named: refused');
    const f = await adminCall(reg, owner, { a: 'move.force', uid: u.uid, ik: k2.ik });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.state, 'armed');
    // The user's next GitHub-proved move completes at once: no 24 h block, no 72 h wait, no Stop.
    const a = await reg.authId(k2, u.ghId);
    assert.equal(a.body.status, 'rebind');
    const ts = reg.ts();
    const rb = await reg.call('/v1/rebind', { ticket: a.body.ticket, ts, sig: k2.sign(`snug-reg-v1\nrebind\n${a.body.ticket}\n${ts}`) });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.equal(rb.body.status, 'pending', '0.10.1 clients see the shape they know');
    const look = await reg.lookup(owner, { uid: u.uid });
    assert.equal(look.body.ik, k2.ik, 'the move is done');
    assert.equal(look.body.chain.at(-1).prev, null, 'unapproved: friends see a loud key change');
    assert.equal((await cancel(reg, u.uid, u.k)).body.error, 'bad_signature', 'the thief can no longer cancel anything');
    const s = await reg.connect(u.uid, k2);
    assert.equal(s.ready.mode, 'normal');
    s.close();
    const thiefX = await xfer(reg, u.uid, u.k);
    assert.equal(thiefX.ready, null, 'the forced-out key gets no "old" xfer role: it can push nothing to the new PC');
    const audit = await adminCall(reg, owner, { a: 'audit' });
    assert.ok(audit.body.audit.some((r) => r.a === 'move.force' && r.target === u.uid), JSON.stringify(audit.body.audit.slice(0, 3)));
    // Used once: a later move waits 72 h again.
    const u2 = { ...u, k: k2 };
    await startMove(reg, u2);
    assert.equal((await reg.lookup(owner, { uid: u.uid })).body.ik, k2.ik);
  } finally {
    await reg.close();
  }
});

test('REG-M2: a pending move can be forced at once; only the owner may force, never on the owner', async () => {
  const reg = await start();
  try {
    const owner = await reg.signUp(OWNER_ID, 'a');
    const admin = await reg.signUp(6262, 'helper');
    assert.equal((await adminCall(reg, owner, { a: 'admin.grant', uid: admin.uid, perms: ['stats', 'names', 'ban', 'ann', 'update'] })).status, 200);
    const u = await reg.signUp(6263, 'movingnow');
    const k2 = await startMove(reg, u);
    assert.equal((await adminCall(reg, admin, { a: 'move.force', uid: u.uid })).body.error, 'forbidden', 'an admin may not');
    assert.equal((await adminCall(reg, owner, { a: 'move.force', uid: u.uid })).status, 400, 'the waiting key must be named');
    const f = await adminCall(reg, owner, { a: 'move.force', uid: u.uid, ik: k2.ik });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.state, 'done');
    assert.equal((await reg.lookup(owner, { uid: u.uid })).body.ik, k2.ik);
    assert.equal((await adminCall(reg, owner, { a: 'move.force', uid: owner.uid, ik: makeKeys().ik })).body.error, 'forbidden');
    // Arming expires after 7 days.
    const v = await reg.signUp(6264, 'expires');
    const vk = makeKeys();
    assert.equal((await adminCall(reg, owner, { a: 'move.force', uid: v.uid, ik: vk.ik })).body.state, 'armed');
    await reg.clock.advance(8 * DAY);
    await startMove(reg, v, vk);
    assert.equal((await reg.lookup(owner, { uid: v.uid })).body.ik, v.k.ik, 'not forced: waits 72 h as usual');
  } finally {
    await reg.close();
  }
});

// ---------- REG-M4: junk tokens can't use up the global sign-in budget ----------
test('REG-M4: 300 junk-token sign-ins from 31 IPv6 /64s don’t lock out a real sign-in from a new address', async () => {
  const reg = await start({ limits: 'production', trustClientIp: true });
  try {
    const k = makeKeys();
    let junk = 0;
    for (let n = 0; n < 31; n++) {
      for (let i = 0; i < 10; i++) {
        const r = await reg.auth(k, `gho_${'x'.repeat(26)}${String(n * 10 + i).padStart(4, '0')}`, { ip: `2001:db8:${n.toString(16)}::${i + 1}` });
        if (r.body.error === 'github_invalid') junk++;
      }
    }
    assert.ok(junk >= 300, `junk calls reached GitHub: ${junk}`);
    const real = makeKeys();
    const ok = await reg.auth(real, reg.github.issueToken({ id: 4242 }), { ip: '198.51.100.20' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'new');
  } finally {
    await reg.close();
  }
});

test('REG-M4: sign-in limits per address count an IPv6 /48 as one address', async () => {
  const reg = await start({ limits: 'production', trustClientIp: true });
  try {
    const k = makeKeys();
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const r = await reg.auth(k, `gho_${'y'.repeat(26)}${String(i).padStart(4, '0')}`, { ip: `2001:db8:77:${(i + 1).toString(16)}::1` }); // 12 different /64s in one /48
      codes.push(r.status);
    }
    assert.deepEqual(codes.slice(10), [429, 429], codes.join());
  } finally {
    await reg.close();
  }
});

// ---------- REG-M5: refused requests don't count toward the global relay switch ----------
const isPresence = (uid, on) => (m) => m.t === 'presence' && m.uid === uid && m.on === on;
test('REG-M5: one address flooding until 429 doesn’t switch relay off for everyone', async () => {
  const reg = await start({ limits: 'production', trustClientIp: true, env: { RELAY_OFF_AT: '100' } }); // off past 100 requests a day
  try {
    const codes = {};
    for (let i = 0; i < 150; i++) {
      const r = await reg.call('/v1/check?name=abc', undefined, { ip: '203.0.113.7' });
      codes[r.status] = (codes[r.status] || 0) + 1;
    }
    assert.ok(codes[429] >= 100, JSON.stringify(codes));
    const a = await reg.signUp(8181, 'relaya');
    const b = await reg.signUp(8182, 'relayb');
    const sa = await reg.connect(a.uid, a.k);
    const sb = await reg.connect(b.uid, b.k);
    sa.send({ t: 'watch', uids: [b.uid] });
    sb.send({ t: 'watch', uids: [a.uid] });
    await sa.next(isPresence(b.uid, true));
    sa.send({ t: 'relay', id: 'r1', to: b.uid, box: 'still-on' });
    assert.equal((await sb.next((m) => m.t === 'relay' || m.t === 'err')).box, 'still-on');
    await sa.none((m) => m.t === 'err');
    // Refused frames don't count either: a burst over the relay limit leaves the switch where it was.
    for (let i = 0; i < 200; i++) sa.send({ t: 'sig', id: `s${i}`, to: 'zzzzzzzzzzzzzzzz', box: 'x' });
    await sa.next((m) => m.id === 's199');
    sa.send({ t: 'relay', id: 'r2', to: b.uid, box: 'still-on-2' });
    assert.equal((await sb.next((m) => m.t === 'relay')).box, 'still-on-2');
    sa.close();
    sb.close();
  } finally {
    await reg.close();
  }
});

// ---------- REG-L1: the vault key can rotate; older keys stay readable by the current key only ----------
function vaultKey(reg, u, { k = u.k, p = '{}' } = {}) {
  const ts = reg.ts();
  return reg.call('/v1/vault/key', { uid: u.uid, ts, p, sig: k.sign(`snug-reg-v1\nvault-key\n${u.uid}\n${ts}\n${p}`) });
}
function vaultRotate(reg, u, k = u.k) {
  const ts = reg.ts();
  const p = '{}';
  return reg.call('/v1/vault/rotate', { uid: u.uid, ts, p, sig: k.sign(`snug-reg-v1\nvault-rotate\n${u.uid}\n${ts}\n${p}`) });
}
test('REG-L1: rotate gives kid 2 with a new key; {kid:1} still returns the old one, for the current key only', async () => {
  const reg = await start();
  try {
    const u = await reg.signUp(9191, 'rotor');
    const k1 = await vaultKey(reg, u);
    assert.equal(k1.body.kid, 1);
    const r = await vaultRotate(reg, u);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kid, 2);
    const k2 = await vaultKey(reg, u);
    assert.equal(k2.body.kid, 2, '0.10.1 clients (p "{}") get the newest key');
    assert.notEqual(k2.body.key, k1.body.key);
    const old = await vaultKey(reg, u, { p: JSON.stringify({ kid: 1 }) });
    assert.equal(old.body.kid, 1);
    assert.equal(old.body.key, k1.body.key);
    assert.equal((await vaultKey(reg, u, { p: JSON.stringify({ kid: 2 }) })).body.key, k2.body.key);
    assert.equal((await vaultKey(reg, u, { p: JSON.stringify({ kid: 9 }) })).status, 404);
    assert.equal((await vaultKey(reg, u, { p: JSON.stringify({ kid: 'x' }) })).status, 400);
    const k3 = await startMove(reg, u);
    assert.equal((await vaultKey(reg, u, { k: k3, p: JSON.stringify({ kid: 1 }) })).body.error, 'bad_signature', 'never a pending key');
    assert.equal((await vaultRotate(reg, u, k3)).body.error, 'bad_signature');
    const other = await reg.signUp(9192, 'other');
    assert.equal((await vaultKey(reg, u, { k: other.k, p: JSON.stringify({ kid: 1 }) })).body.error, 'bad_signature');
    // The wrapped rows are not the raw keys.
    for (const row of reg.runtime.sql('SELECT k FROM vault_keys_old')) assert.ok(!row.k.includes(k1.body.key.slice(0, 20)));
  } finally {
    await reg.close();
  }
});

test('REG-L1: a forced move rotates the key at the next fetch (the forced-out device holds the old one)', async () => {
  const reg = await start();
  try {
    const owner = await reg.signUp(OWNER_ID, 'a');
    const u = await reg.signUp(9193, 'forcedrot');
    const before = await vaultKey(reg, u);
    const k2 = await startMove(reg, u);
    assert.equal((await adminCall(reg, owner, { a: 'move.force', uid: u.uid, ik: k2.ik })).body.state, 'done');
    const after = await vaultKey(reg, { ...u, k: k2 });
    assert.equal(after.body.kid, before.body.kid + 1);
    assert.notEqual(after.body.key, before.body.key);
    assert.equal((await vaultKey(reg, { ...u, k: k2 }, { p: JSON.stringify({ kid: before.body.kid }) })).body.key, before.body.key, 'old files stay readable');
  } finally {
    await reg.close();
  }
});

test('hardening: the Worker cuts a chunked body with no Content-Length at the cap instead of buffering it', async () => {
  const { default: worker } = await import('../src/worker.js');
  let pulled = 0;
  const body = new ReadableStream({
    pull(c) {
      pulled++;
      if (pulled > 200) return c.close(); // 200 x 1 KiB if read to the end
      c.enqueue(new Uint8Array(1024));
    },
  });
  const req = new Request('https://r.example/v1/claim', { method: 'POST', body, duplex: 'half' });
  const res = await worker.fetch(req, { HUB: { idFromName() { throw new Error('must not reach the Hub'); } } });
  assert.equal(res.status, 413);
  assert.ok(pulled < 40, `stopped early (${pulled} chunks read)`);
});

// ---------- REG-L3: the sensitive per-address limits survive the Hub sleeping ----------
test('REG-L3: account, sign-in, vault and admin limits per address survive an eviction', async () => {
  const reg = await start({ limits: 'production', trustClientIp: true });
  try {
    const hit = async () => (await reg.call('/v1/rebind/cancel', { uid: 'aaaaaaaaaaaaaaaa', ts: Date.now(), sig: 'x'.repeat(86) }, { ip: '203.0.113.50' })).status;
    const first = [];
    for (let i = 0; i < 5; i++) first.push(await hit());
    assert.ok(first.every((s) => s !== 429), first.join());
    assert.equal(await hit(), 429);
    await reg.runtime.evict();
    assert.equal(await hit(), 429, 'still limited after the Hub woke up again');
    // Other addresses are not affected.
    assert.notEqual((await reg.call('/v1/rebind/cancel', { uid: 'aaaaaaaaaaaaaaaa', ts: Date.now(), sig: 'x'.repeat(86) }, { ip: '203.0.113.51' })).status, 429);
  } finally {
    await reg.close();
  }
});

test('REG-L6: the owner can export the wrapped vault key rows (audited); nobody else can', async () => {
  const reg = await start();
  try {
    const owner = await reg.signUp(OWNER_ID, 'a');
    const admin = await reg.signUp(9291, 'helper2');
    assert.equal((await adminCall(reg, owner, { a: 'admin.grant', uid: admin.uid, perms: ['stats', 'names', 'ban', 'ann', 'update'] })).status, 200);
    const u = await reg.signUp(9292, 'exported');
    const key = (await vaultKey(reg, u)).body.key;
    await vaultRotate(reg, u);
    assert.equal((await adminCall(reg, admin, { a: 'vault.export' })).body.error, 'forbidden');
    assert.equal((await adminCall(reg, u, { a: 'vault.export' })).body.error, 'forbidden');
    const ex = await adminCall(reg, owner, { a: 'vault.export' });
    assert.equal(ex.status, 200, JSON.stringify(ex.body));
    assert.equal(ex.body.rows.length, 1);
    assert.equal(ex.body.old.length, 1);
    assert.equal(ex.body.rows[0].kid, 2);
    assert.ok(!JSON.stringify(ex.body).includes(key.slice(0, 20)), 'only wrapped keys leave');
    const audit = await adminCall(reg, owner, { a: 'audit' });
    assert.ok(audit.body.audit.some((r) => r.a === 'vault.export'));
  } finally {
    await reg.close();
  }
});

// ---------- hardening: bans and the audit log ----------
test('hardening: a ban drops the knocks the account left; a banned account can’t approve a move', async () => {
  const reg = await start();
  try {
    const owner = await reg.signUp(OWNER_ID, 'a');
    const x = await reg.signUp(9391, 'knocker');
    const y = await reg.signUp(9392, 'knocked');
    const sx = await reg.connect(x.uid, x.k);
    sx.send({ t: 'knock', id: 'k_spam_00000001', to: y.uid, box: 'hi' });
    await sx.next((m) => m.t === 'ok');
    sx.close();
    const k2 = await startMove(reg, x); // started before the ban
    assert.equal((await adminCall(reg, owner, { a: 'ban', uid: x.uid, reason: 'spam', until: null })).status, 200);
    const sy = await reg.connect(y.uid, y.k);
    await sy.none((m) => m.t === 'knock');
    sy.close();
    const kv = 2;
    const res = await reg.call('/v1/rebind/approve', { uid: x.uid, kver: kv, ik: k2.ik, xk: k2.xk, prev: x.k.sign(`snug-keychange-v1\n${x.uid}\n${kv}\n${k2.ik}\n${k2.xk}`) });
    assert.equal(res.body.error, 'banned');
  } finally {
    await reg.close();
  }
});

test('hardening: high-impact audit rows survive the 5000-row rotation', async () => {
  const reg = await start();
  try {
    const owner = await reg.signUp(OWNER_ID, 'a');
    const x = await reg.signUp(9393, 'bannedone');
    assert.equal((await adminCall(reg, owner, { a: 'ban', uid: x.uid, reason: 'kept', until: null })).status, 200);
    const t = Date.now();
    reg.runtime.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5100)
      INSERT INTO audit(at, by, a, target, detail) SELECT ?, ?, 'name.reserve', 'x' || i, '{}' FROM n`, t, owner.uid);
    assert.equal((await adminCall(reg, owner, { a: 'name.reserve', name: 'rotateit' })).status, 200);
    const rows = reg.runtime.sql("SELECT a FROM audit WHERE a = 'ban'");
    assert.equal(rows.length, 1, 'the ban is still in the log');
    assert.ok(reg.runtime.sql('SELECT COUNT(*) AS n FROM audit')[0].n <= 5002);
  } finally {
    await reg.close();
  }
});

test('hardening: with VAULT_WRAP_SECRET set, vault key rows are re-wrapped with it as they are read; keys stay the same', async () => {
  const reg = await start();
  try {
    const u = await reg.signUp(9491, 'wrapme');
    const before = await vaultKey(reg, u);
    const rowBefore = reg.runtime.sql('SELECT k FROM vault_keys')[0].k;
    reg.runtime.env.VAULT_WRAP_SECRET = 'w'.repeat(40);
    const after = await vaultKey(reg, u);
    assert.equal(after.body.key, before.body.key, 'the same key');
    const rowAfter = reg.runtime.sql('SELECT k FROM vault_keys')[0].k;
    assert.notEqual(rowAfter, rowBefore, 're-wrapped under the dedicated secret');
    assert.equal((await vaultKey(reg, u)).body.key, before.body.key);
    // New rows (a rotation) use it, and the older kid (re-wrapped on read) still opens.
    await vaultRotate(reg, u);
    assert.equal((await vaultKey(reg, u, { p: JSON.stringify({ kid: 1 }) })).body.key, before.body.key);
    // GH_HMAC_SECRET alone no longer opens the re-wrapped rows.
    delete reg.runtime.env.VAULT_WRAP_SECRET;
    assert.equal((await vaultKey(reg, u)).status, 500);
  } finally {
    await reg.close();
  }
});

// ---------- sec-review: the frame cap is per key, so another key can't close the current key's sockets ----------
test('REG-M5 (review): a stolen old key flooding xfer frames doesn’t close the current key’s xfer socket', async () => {
  const reg = await start({ limits: { ...relaxedLimits(), xferFramesMin: [50, 60_000] } });
  try {
    const u = await reg.signUp(5161, 'framecap');
    const k2 = await startMove(reg, u);
    await approve(reg, u, k2); // u.k is the old key now (say, the stolen laptop), k2 the current one
    const cur = await xfer(reg, u.uid, k2);
    assert.equal(cur.ready?.mode, 'xfer');
    const old = await xfer(reg, u.uid, u.k);
    assert.equal(old.ready?.mode, 'xfer');
    for (let i = 0; i < 80; i++) old.send({ t: 'noop', i });
    assert.equal((await old.closed).code, 4029, 'the flooding socket is closed');
    cur.send({ t: 'noop' });
    const r = await Promise.race([cur.closed.then((c) => `closed ${c.code}`), new Promise((res) => setTimeout(() => res('open'), 500))]);
    assert.equal(r, 'open', 'the current key’s socket stays open');
    cur.close();
  } finally {
    await reg.close();
  }
});
