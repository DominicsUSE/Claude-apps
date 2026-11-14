import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { start, makeKeys, verify, openSocket, sleep, DAY, HOUR } from './helpers.js';

let reg;
before(async () => {
  reg = await start();
});
after(() => reg.close());

let n = 5000;
const user = (name) => reg.signUp(n++, name);
const isPresence = (uid, on) => (m) => m.t === 'presence' && m.uid === uid && m.on === on;

test('auth: challenge carries now; ready carries mode, kver and ping', async () => {
  const u = await user('sam');
  const s = await reg.connect(u.uid, u.k);
  assert.match(s.challenge.n, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(Math.abs(s.challenge.now - reg.clock.now()) < 5000);
  assert.equal(s.ready.mode, 'normal');
  assert.equal(s.ready.kver, 1);
  assert.equal(s.ready.ping, 90);
  assert.ok(s.ready.now > 0);
  s.send('ping'); // auto-response, never reaches the DO
  const before = reg.runtime.stats.wsMessages;
  assert.deepEqual(await s.next((m) => m.t === 'pong'), { t: 'pong' });
  assert.equal(reg.runtime.stats.wsMessages, before);
  s.close();
});

test('auth failures: bad signature 4001, wrong uid 4001, unknown uid 4003, timeout 4005', async () => {
  const u = await user('tia');
  const bad = await reg.connect(u.uid, u.k, { auth: (c) => ({ t: 'auth', uid: u.uid, sig: makeKeys().sign(`snug-reg-v1\nsignal\n${u.uid}\n${c.n}`) }) });
  assert.equal((await bad.closed).code, 4001);
  const wrong = await reg.connect(u.uid, u.k, { auth: (c) => ({ t: 'auth', uid: 'bbbbbbbbbbbbbbbb', sig: u.k.sign(`snug-reg-v1\nsignal\nbbbbbbbbbbbbbbbb\n${c.n}`) }) });
  assert.equal((await wrong.closed).code, 4001);
  const unknown = await reg.connect('cccccccccccccccc', u.k, { auth: reg.signAuth('cccccccccccccccc', u.k) });
  assert.equal((await unknown.closed).code, 4003);
  const silent = await reg.connect(u.uid, u.k, { auth: false });
  await reg.clock.advance(11_000);
  assert.equal((await silent.closed).code, 4005);
});

test('a bad ?uid= is refused by the Worker with 400 and no DO request', async () => {
  const before = reg.runtime.stats.doRequests;
  for (const uid of ['short', 'ABCDEFGHIJKLMNOP', 'abcdefghijklmno1', '']) {
    const e = await openSocket(`${reg.url.replace('http', 'ws')}/v1/ws?uid=${uid}`).catch((x) => x);
    assert.equal(e.status, 400, uid);
  }
  assert.equal(reg.runtime.stats.doRequests, before);
});

test('at most 4 unauthenticated sockets per uid; a new one pushes out the oldest, so nobody can lock a uid out', async () => {
  const u = await user('uma');
  const open = [];
  for (let i = 0; i < 4; i++) open.push(await reg.connect(u.uid, u.k, { auth: false }));
  // Someone holding 4 silent sockets on uma's uid must not stop uma from connecting.
  const real = await reg.connect(u.uid, u.k);
  assert.equal(real.ready.mode, 'normal');
  assert.equal((await open[0].closed).code, 4005, 'the oldest silent socket made room');
  for (const s of open.slice(1)) s.close();
  real.close();
});

test('a second normal connection replaces the first (4002)', async () => {
  const u = await user('vic');
  const s1 = await reg.connect(u.uid, u.k);
  const s2 = await reg.connect(u.uid, u.k);
  assert.equal((await s1.closed).code, 4002);
  assert.equal(s2.ready.mode, 'normal');
  s2.close();
});

test('connect budget counts only successful auths', async () => {
  const r2 = await start({ env: { TEST_LIMITS: { connect: [2, HOUR] } } });
  try {
    const u = await r2.signUp(1, 'walt');
    for (let i = 0; i < 3; i++) {
      const s = await r2.connect(u.uid, u.k, { auth: (c) => ({ t: 'auth', uid: u.uid, sig: makeKeys().sign(c.n) }) });
      assert.equal((await s.closed).code, 4001);
    }
    const a = await r2.connect(u.uid, u.k);
    const b = await r2.connect(u.uid, u.k);
    assert.equal(b.ready.mode, 'normal');
    await a.closed;
    const c = await r2.connect(u.uid, u.k, { auth: r2.signAuth(u.uid, u.k) });
    assert.equal((await c.closed).code, 4029);
    b.close();
  } finally {
    await r2.close();
  }
});

test('presence: mutual watch only; off on close; watch row deleted on close; invisible', async () => {
  const a = await user('ada');
  const b = await user('ben');
  const c = await user('cy');
  const sa = await reg.connect(a.uid, a.k);
  const sb = await reg.connect(b.uid, b.k);
  const sc = await reg.connect(c.uid, c.k);
  sa.send({ t: 'watch', uids: [b.uid] });
  await sa.none(isPresence(b.uid, true)); // B does not watch A yet
  sb.send({ t: 'watch', uids: [a.uid] });
  await sa.next(isPresence(b.uid, true));
  await sb.next(isPresence(a.uid, true));
  // one-way: C watches A, A does not watch C -> nothing either way
  sc.send({ t: 'watch', uids: [a.uid] });
  await sc.none(isPresence(a.uid, true));
  await sa.none(isPresence(c.uid, true));
  assert.equal(reg.runtime.sql('SELECT uid FROM watch WHERE uid=?', b.uid).length, 1);
  // invisible: A sees B go off, and B is not announced on reconnect
  sb.send({ t: 'visible', on: false });
  await sa.next(isPresence(b.uid, false));
  sb.send({ t: 'visible', on: true });
  await sa.next(isPresence(b.uid, true));
  // close: off to mutual watchers, and the watch row is gone
  sb.close();
  await sa.next(isPresence(b.uid, false));
  await sleep(50);
  assert.equal(reg.runtime.sql('SELECT uid FROM watch WHERE uid=?', b.uid).length, 0);
  await sc.none(isPresence(b.uid, false));
  // too many uids
  sa.send({ t: 'watch', uids: Array.from({ length: 501 }, () => 'a'.repeat(16)) });
  assert.equal((await sa.next((m) => m.t === 'err')).code, 'too_many');
  sa.close();
  sc.close();
});

test('auth with visible:false starts invisible (no presence flash)', async () => {
  const a = await user('wes');
  const b = await user('xia');
  const sa = await reg.connect(a.uid, a.k);
  sa.send({ t: 'watch', uids: [b.uid] });
  const sb = await reg.connect(b.uid, b.k, { auth: (c) => ({ ...reg.signAuth(b.uid, b.k)(c), visible: false }) });
  await sb.next((m) => m.t === 'ready');
  sb.send({ t: 'watch', uids: [a.uid] });
  await sb.next(isPresence(a.uid, true)); // B still sees A
  await sa.none(isPresence(b.uid, true)); // A does not see B
  sb.send({ t: 'visible', on: true });
  await sa.next(isPresence(b.uid, true));
  sa.close();
  sb.close();
});

test('sig and relay: delivered only between mutual watchers; one answer for every failure', async () => {
  const a = await user('dee');
  const b = await user('eli');
  const c = await user('fay');
  const sa = await reg.connect(a.uid, a.k);
  const sb = await reg.connect(b.uid, b.k);
  sa.send({ t: 'watch', uids: [b.uid, c.uid] });
  sb.send({ t: 'watch', uids: [a.uid] });
  await sa.next(isPresence(b.uid, true));
  sa.send({ t: 'sig', id: 's1', to: b.uid, box: 'sealed-1' });
  assert.deepEqual(await sb.next((m) => m.t === 'sig'), { t: 'sig', from: a.uid, box: 'sealed-1' });
  sb.send({ t: 'relay', id: 'r1', to: a.uid, box: 'frame-1' });
  sb.send({ t: 'relay', id: 'r2', to: a.uid, box: 'frame-2' });
  assert.equal((await sa.next((m) => m.t === 'relay')).box, 'frame-1'); // order kept
  assert.equal((await sa.next((m) => m.t === 'relay')).box, 'frame-2');
  // C is offline; D is online but not watching A: both give the same err unavailable
  const d = await user('gus');
  const sd = await reg.connect(d.uid, d.k);
  for (const [t, to, id] of [['sig', c.uid, 'x1'], ['relay', c.uid, 'x2'], ['sig', d.uid, 'x3'], ['relay', d.uid, 'x4'], ['sig', 'zzzzzzzzzzzzzzzz', 'x5']]) {
    sa.send({ t, id, to, box: 'b' });
    assert.deepEqual(await sa.next((m) => m.t === 'err' && m.id === id), { t: 'err', id, code: 'unavailable' });
  }
  await sd.none((m) => m.t === 'sig' || m.t === 'relay');
  // invisible target: unavailable, unless it contacted us first
  sb.send({ t: 'visible', on: false });
  await sa.next(isPresence(b.uid, false));
  sa.send({ t: 'sig', id: 'y1', to: b.uid, box: 'b' });
  assert.equal((await sa.next((m) => m.id === 'y1')).code, 'unavailable');
  sb.send({ t: 'sig', id: 'y2', to: a.uid, box: 'hello' });
  await sa.next((m) => m.t === 'sig' && m.box === 'hello');
  sa.send({ t: 'sig', id: 'y3', to: b.uid, box: 'reply' });
  assert.equal((await sb.next((m) => m.t === 'sig')).box, 'reply');
  // size limits
  sa.send({ t: 'sig', id: 'big1', to: b.uid, box: 'x'.repeat(16 * 1024 + 1) });
  assert.equal((await sa.next((m) => m.id === 'big1')).code, 'too_big');
  sa.send({ t: 'relay', id: 'big2', to: b.uid, box: 'x'.repeat(64 * 1024 + 1) });
  assert.equal((await sa.next((m) => m.id === 'big2')).code, 'too_big');
  sa.send({ t: 'relay', id: 'max', to: b.uid, box: 'y'.repeat(64 * 1024) });
  assert.equal((await sb.next((m) => m.t === 'relay')).box.length, 64 * 1024);
  sa.send(JSON.stringify({ t: 'relay', id: 'huge', to: b.uid, box: 'z'.repeat(70 * 1024) }));
  assert.equal((await sa.next((m) => m.t === 'err' && m.code === 'too_big')).code, 'too_big');
  for (const s of [sa, sb, sd]) s.close();
});

test('relay daily budget survives re-creating the DO over the same SQLite; RELAY_OFF_AT turns relay off', async () => {
  const r2 = await start({ env: { TEST_LIMITS: { relayDay: [5, DAY] } } });
  try {
    const a = await r2.signUp(1, 'hal');
    const b = await r2.signUp(2, 'ivy');
    const pair = async () => {
      const sa = await r2.connect(a.uid, a.k);
      const sb = await r2.connect(b.uid, b.k);
      sa.send({ t: 'watch', uids: [b.uid] });
      sb.send({ t: 'watch', uids: [a.uid] });
      await sa.next(isPresence(b.uid, true));
      return [sa, sb];
    };
    let [sa, sb] = await pair();
    for (let i = 0; i < 3; i++) sa.send({ t: 'relay', id: `a${i}`, to: b.uid, box: `f${i}` });
    for (let i = 0; i < 3; i++) await sb.next((m) => m.t === 'relay');
    sa.close();
    sb.close();
    await sleep(100); // close flushes budgets
    r2.runtime.evict();
    [sa, sb] = await pair();
    sa.send({ t: 'relay', id: 'b1', to: b.uid, box: 'g1' });
    sa.send({ t: 'relay', id: 'b2', to: b.uid, box: 'g2' });
    sa.send({ t: 'relay', id: 'b3', to: b.uid, box: 'g3' });
    assert.deepEqual(await sa.next((m) => m.t === 'err'), { t: 'err', id: 'b3', code: 'rate_limited' });
    assert.equal((await sb.next((m) => m.t === 'relay')).box, 'g1');
    assert.equal((await sb.next((m) => m.t === 'relay')).box, 'g2');
    await sb.none((m) => m.t === 'relay');
    sa.close();
    sb.close();
  } finally {
    await r2.close();
  }
  const r3 = await start({ env: { RELAY_OFF_AT: '1' } });
  try {
    const a = await r3.signUp(1, 'jon');
    const b = await r3.signUp(2, 'kai');
    const sa = await r3.connect(a.uid, a.k);
    const sb = await r3.connect(b.uid, b.k);
    sa.send({ t: 'watch', uids: [b.uid] });
    sb.send({ t: 'watch', uids: [a.uid] });
    await sa.next(isPresence(b.uid, true));
    sa.send({ t: 'relay', id: 'r', to: b.uid, box: 'x' });
    assert.equal((await sa.next((m) => m.t === 'err')).code, 'relay_unavailable');
    sa.send({ t: 'sig', id: 's', to: b.uid, box: 'x' }); // signaling still works
    await sb.next((m) => m.t === 'sig');
    sa.close();
    sb.close();
  } finally {
    await r3.close();
  }
});

test('knocks: always ok; stored and pushed; deleted only after knocked; 3 per sender; box evicts oldest', async () => {
  const r2 = await start({ env: { TEST_LIMITS: { knockBox: [5, 0] } } });
  try {
    const t = await r2.signUp(1, 'target');
    const s1 = await r2.signUp(2, 'sender.one');
    const s2 = await r2.signUp(3, 'sender.two');
    const k1 = await r2.connect(s1.uid, s1.k);
    const k2 = await r2.connect(s2.uid, s2.k);
    const knock = async (s, id, to = t.uid) => {
      s.send({ t: 'knock', id, to, box: `box-${id}` });
      assert.deepEqual(await s.next((m) => m.id === id), { t: 'ok', id });
    };
    // target offline: stored; an unknown uid gets the very same answer
    await knock(k1, 'a1');
    await knock(k1, 'a2');
    await knock(k1, 'a3');
    await knock(k1, 'a4'); // replaces a1 (3 per sender)
    await knock(k1, 'nobody', 'qqqqqqqqqqqqqqqq');
    await knock(k2, 'b1');
    await knock(k2, 'b2');
    await knock(k2, 'b3'); // box of 5 is full: a2 (oldest) is evicted
    let st = await r2.connect(t.uid, t.k);
    const got = [];
    for (let i = 0; i < 5; i++) got.push(await st.next((m) => m.t === 'knock'));
    assert.deepEqual(got.map((m) => m.id), ['a3', 'a4', 'b1', 'b2', 'b3']);
    assert.equal(got[0].from, s1.uid);
    assert.equal(got[0].box, 'box-a3');
    assert.ok(got[0].ts > 0);
    // not acked yet: pushed again on reconnect
    st.close();
    await st.closed;
    st = await r2.connect(t.uid, t.k);
    for (let i = 0; i < 5; i++) await st.next((m) => m.t === 'knock');
    st.send({ t: 'knocked', ids: ['a3', 'a4', 'b1', 'b2', 'b3'] });
    await sleep(50);
    assert.equal(r2.runtime.sql('SELECT COUNT(*) AS n FROM knocks WHERE to_uid=?', t.uid)[0].n, 0);
    // live push while online (ok is sent before the push)
    await knock(k2, 'live');
    assert.equal((await st.next((m) => m.t === 'knock')).id, 'live');
    // too big
    k1.send({ t: 'knock', id: 'big', to: t.uid, box: 'x'.repeat(4097) });
    assert.equal((await k1.next((m) => m.id === 'big')).code, 'too_big');
    // a self-knock is refused unless a move is pending
    k1.send({ t: 'knock', id: 'self', to: s1.uid, box: 'restore' });
    assert.equal((await k1.next((m) => m.id === 'self')).code, 'unavailable');
    for (const s of [k1, k2, st]) s.close();
  } finally {
    await r2.close();
  }
});

test('knock pair budget: 5 per sender-target per day', async () => {
  const a = await user('lia');
  const b = await user('max');
  const s = await reg.connect(a.uid, a.k);
  for (let i = 0; i < 5; i++) {
    s.send({ t: 'knock', id: `p${i}`, to: b.uid, box: 'x' });
    assert.equal((await s.next((m) => m.id === `p${i}`)).t, 'ok');
  }
  s.send({ t: 'knock', id: 'p5', to: b.uid, box: 'x' });
  assert.equal((await s.next((m) => m.id === 'p5')).code, 'rate_limited');
  s.close();
});

test('small daily budgets survive hibernation while the socket stays open (no flush on close to save them)', async () => {
  const a = await user('lia2');
  const b = await user('max2');
  const s = await reg.connect(a.uid, a.k);
  for (let i = 0; i < 5; i++) {
    s.send({ t: 'knock', id: `h${i}`, to: b.uid, box: 'x' });
    assert.equal((await s.next((m) => m.id === `h${i}`)).t, 'ok');
  }
  reg.runtime.evict(); // the DO goes to sleep with a's socket still open, then wakes for the next frame
  s.send({ t: 'knock', id: 'h5', to: b.uid, box: 'x' });
  assert.equal((await s.next((m) => m.id === 'h5')).code, 'rate_limited');
  s.close();
});

// ---------- moves (rebind) ----------

async function startMove(u, newKeys = makeKeys()) {
  const a = await reg.authId(newKeys, u.ghId);
  assert.equal(a.body.status, 'rebind', JSON.stringify(a.body));
  const ts = reg.ts();
  const r = await reg.call('/v1/rebind', { ticket: a.body.ticket, ts, sig: newKeys.sign(`snug-reg-v1\nrebind\n${a.body.ticket}\n${ts}`) });
  return { r, k: newKeys, ticket: a.body.ticket };
}

test('move without approval: pending for 72 h, then completes (old 4003, pending 4004)', async () => {
  const u = await user('nia');
  const friend = await user('oz');
  const old = await reg.connect(u.uid, u.k);
  const { r, k: k2 } = await startMove(u);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.uid, u.uid);
  assert.ok(Math.abs(r.body.at - (reg.clock.now() + 72 * HOUR)) < 5000);
  const again = await reg.authId(u.k, u.ghId); // the old PC signing in again sees the pending move
  assert.equal(again.body.status, 'ok');
  assert.equal(again.body.rebind.at, r.body.at);
  const notice = await old.next((m) => m.t === 'rebind');
  assert.deepEqual(notice, { t: 'rebind', state: 'pending', at: r.body.at, kver: 2, ik: k2.ik, xk: k2.xk });
  // the new PC waits in pending mode; it gets no presence and cannot send
  const pend = await reg.connect(u.uid, k2);
  assert.equal(pend.ready.mode, 'pending');
  assert.deepEqual(pend.ready.rebind, { at: r.body.at });
  // a reconnect of the old PC hears about the move again
  const old2 = await reg.connect(u.uid, u.k);
  await old.closed;
  assert.equal(old2.ready.rebind.ik, k2.ik);
  // signing in again with the new key reports pending
  assert.equal((await reg.authId(k2, u.ghId)).body.status, 'pending');
  // nothing changes before 72 h
  await reg.clock.advance(71 * HOUR);
  assert.equal((await reg.lookup(friend, { uid: u.uid })).body.kver, 1);
  await reg.clock.advance(HOUR + 1000);
  assert.equal((await old2.closed).code, 4003);
  assert.equal((await pend.closed).code, 4004);
  const l = await reg.lookup(friend, { uid: u.uid });
  assert.equal(l.body.kver, 2);
  assert.equal(l.body.ik, k2.ik);
  assert.deepEqual(l.body.chain.map((c) => [c.kver, c.prev]), [[1, null], [2, null]]);
  // the old key is revoked; the new one connects normally
  const stale = await reg.connect(u.uid, u.k, { auth: reg.signAuth(u.uid, u.k) });
  assert.equal((await stale.closed).code, 4003);
  const fresh = await reg.connect(u.uid, k2);
  assert.equal(fresh.ready.mode, 'normal');
  assert.equal(fresh.ready.kver, 2);
  fresh.close();
});

test('approved move completes at once; the chain verifies; the restore self-knock reaches the new key', async () => {
  const u = await user('pia');
  const friend = await user('quin');
  const old = await reg.connect(u.uid, u.k);
  const { r, k: k2 } = await startMove(u);
  await old.next((m) => m.t === 'rebind');
  old.send({ t: 'knock', id: 'restore1', to: u.uid, box: 'sealed-restore-list' });
  assert.equal((await old.next((m) => m.id === 'restore1')).t, 'ok');
  const pend = await reg.connect(u.uid, k2);
  const prevMsg = `snug-keychange-v1\n${u.uid}\n2\n${k2.ik}\n${k2.xk}`;
  const bad = await reg.call('/v1/rebind/approve', { uid: u.uid, kver: 2, ik: k2.ik, xk: k2.xk, prev: k2.sign(prevMsg) });
  assert.equal(bad.body.error, 'bad_signature'); // must be signed by the current (old) key
  const ok = await reg.call('/v1/rebind/approve', { uid: u.uid, kver: 2, ik: k2.ik, xk: k2.xk, prev: u.k.sign(prevMsg) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await old.closed).code, 4003);
  assert.equal((await pend.closed).code, 4004);
  assert.ok(r.body.at > reg.clock.now());
  const l = await reg.lookup(friend, { uid: u.uid });
  assert.equal(l.body.kver, 2);
  const [c1, c2] = l.body.chain;
  assert.ok(verify(c1.ik, c2.prev, `snug-keychange-v1\n${u.uid}\n${c2.kver}\n${c2.ik}\n${c2.xk}`));
  const now = await reg.connect(u.uid, k2);
  const restore = await now.next((m) => m.t === 'knock');
  assert.deepEqual(restore, { t: 'knock', from: u.uid, id: 'restore1', box: 'sealed-restore-list', ts: restore.ts });
  now.close();
});

test('stopped move: pending socket 4006; a new attempt within 24 h is blocked', async () => {
  const u = await user('rae');
  const old = await reg.connect(u.uid, u.k);
  const { k: k2 } = await startMove(u);
  await old.next((m) => m.t === 'rebind');
  const pend = await reg.connect(u.uid, k2);
  const c = await reg.signed('/v1/rebind/cancel', u.k, { uid: u.uid }, (ts) => ['rebind-cancel', u.uid, ts]);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await pend.closed).code, 4006);
  assert.equal((await old.next((m) => m.t === 'rebind')).state, 'stopped');
  const again = await startMove(u, k2);
  assert.equal(again.r.status, 409);
  assert.equal(again.r.body.error, 'rebind_blocked');
  assert.ok(again.r.body.retryAt > reg.clock.now());
  // the new key cannot cancel or approve
  const forged = await reg.signed('/v1/rebind/cancel', k2, { uid: u.uid }, (ts) => ['rebind-cancel', u.uid, ts]);
  assert.equal(forged.body.error, 'bad_signature');
  await reg.clock.advance(24 * HOUR + 1000);
  const ok = await startMove(u, k2);
  assert.equal(ok.r.body.status, 'pending');
  old.close();
});

test('rebind tickets: tampered or expired gives bad_ticket', async () => {
  const u = await user('sol');
  const k2 = makeKeys();
  const a = await reg.authId(k2, u.ghId);
  const t = a.body.ticket;
  const tampered = (t[0] === 'A' ? 'B' : 'A') + t.slice(1);
  let ts = reg.ts();
  assert.equal((await reg.call('/v1/rebind', { ticket: tampered, ts, sig: k2.sign(`snug-reg-v1\nrebind\n${tampered}\n${ts}`) })).body.error, 'bad_ticket');
  await reg.clock.advance(11 * 60_000);
  ts = reg.ts();
  assert.equal((await reg.call('/v1/rebind', { ticket: t, ts, sig: k2.sign(`snug-reg-v1\nrebind\n${t}\n${ts}`) })).body.error, 'bad_ticket');
  assert.equal(reg.runtime.sql('SELECT COUNT(*) AS n FROM tickets WHERE exp<=?', reg.clock.now())[0].n, 0, 'expired tickets purged by the alarm');
});
