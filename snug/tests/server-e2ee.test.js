// End-to-end encryption on the real server (server/e2ee.js and the hooks it
// uses), with real sockets. The clients use the real js/lib/e2ee modules
// (tests/helpers/e2ee.js). Encryption is on by default (0.12); the server's owner can turn it off with SNUG_E2EE=off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { UserError } from '../server/ops.js';
import { Sock, register, web } from './helpers/e2ee.js';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'snug-e2ee-')); dirs.push(d); return d; };
let srv;
test.before(async () => { srv = await startServer({ port: 0, dataDir: tmp(), quiet: true, e2ee: true }); });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const person = async (handle) => { const p = await register(srv, handle); p.sock = await new Sock(srv, p.cookie).connect(); return p; };

// ---------- step 2: hooks the encryption module builds on ----------
test('GET /api/version is public and names the protocol', async () => {
  const res = await fetch(`${web(srv).base}/api/version`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const v = await res.json();
  assert.deepEqual({ proto: v.proto, minClient: v.minClient, e2ee: v.e2ee }, { proto: 12, minClient: 12, e2ee: 1 });
  assert.match(v.version, /^\d+\.\d+\.\d+/);
  const off = await startServer({ port: 0, dataDir: tmp(), quiet: true, e2ee: false });
  try { assert.equal((await (await fetch(`http://127.0.0.1:${off.port}/api/version`)).json()).e2ee, 0); } finally { await off.close(); }
});

test('a refusal can carry a code and data in its ack; plain refusals stay as they were', async () => {
  const p = await person('e2-ack');
  srv.hub.ops['test.refuse'] = (c, d) => { throw d.plain ? new UserError('Plain no.') : new UserError('Keys changed.', { code: 'e2ee_stale', data: { users: { u_x: { ver: 2 } } } }); };
  try {
    const a = await p.sock.op('test.refuse', {});
    assert.deepEqual(a, { t: 'ack', id: a.id, ok: false, error: 'Keys changed.', code: 'e2ee_stale', data: { users: { u_x: { ver: 2 } } } });
    const b = await p.sock.op('test.refuse', { plain: true });
    assert.deepEqual(b, { t: 'ack', id: b.id, ok: false, error: 'Plain no.' });
  } finally { delete srv.hub.ops['test.refuse']; await p.sock.close(); }
});

test('hub.socketView lets one socket get its own copy of an event; unset, every socket gets the same', async () => {
  const p = await person('e2-view');
  const second = await new Sock(srv, p.cookie).connect();
  p.sock.ws.mark = 'one';
  for (const set of [p.sock, second]) set.events.length = 0;
  const serverSide = [...(srv.hub.socketsOf?.(p.id) || [])];
  assert.equal(serverSide.length, 2, 'hub.socketsOf lists a person’s sockets');
  serverSide[0].mark = 'first';
  const prev = srv.hub.socketView;
  srv.hub.socketView = (ws, ev, d) => (ev === 'test.ev' ? { ...d, mine: ws.mark || 'other' } : d);
  try {
    srv.hub.toUser(p.id, 'test.ev', { a: 1 });
    const got = [await p.sock.next('test.ev'), await second.next('test.ev')].map((d) => d.mine).sort();
    assert.deepEqual(got, ['first', 'other']);
    srv.hub.socketView = () => { throw new Error('broken hook'); };
    srv.hub.toUser(p.id, 'test.ev', { a: 2 });
    assert.deepEqual(await p.sock.next('test.ev'), { a: 2 }, 'a failing hook falls back to the shared event');
  } finally { srv.hub.socketView = prev; await second.close(); await p.sock.close(); }
});

// ---------- step 3: the key directory ----------
import { newDevice, nextPrekey, setupPayload, bind, bindSig, nextList, deviceEntry, devicePublic, login, b64u, random, sig, obj, backup } from './helpers/e2ee.js';
import * as link from '../js/lib/e2ee/link.js';
import { sealKey, openKey } from '../js/lib/e2ee/hpke.js';
import { canon } from '../js/lib/e2ee/canon.js';
import { b64uOf } from '../js/lib/e2ee/bytes.js';

async function friends(a, b) {
  await a.sock.ok('friend.request', { handle: b.handle });
  await b.sock.ok('friend.accept', { user: a.id });
}
// A person with encryption on: their account keys, first device and a bound socket.
async function enrolled(handle, opts) {
  const p = await person(handle);
  p.dev = await newDevice(p.id);
  const { acct, payload } = await setupPayload(p.id, p.dev, opts);
  p.acct = acct;
  p.setup = payload;
  await p.sock.ok('e2ee.setup', payload);
  await bind(p.sock, p.dev);
  return p;
}
const reconnect = async (p, cookie = p.cookie) => new Sock(srv, cookie).connect();

test('setup: once per account, hello reports it; on by default, and refused when the server owner turns it off (SNUG_E2EE=off)', async () => {
  const p = await person('e2-setup');
  assert.equal(p.sock.hello.proto, 12);
  assert.equal(p.sock.hello.e2ee.on, true);
  assert.equal(p.sock.hello.e2ee.me.state, 'none');
  assert.match(p.sock.hello.e2ee.nonce, /^[\w-]{43}$/);
  p.dev = await newDevice(p.id);
  const { payload } = await setupPayload(p.id, p.dev);
  // A list signed by one key but naming another account key is refused.
  const other = await sig.newSigningPair(true);
  const forged = { ...payload.devlist, aik: b64u(await sig.rawPublic(other.publicKey)) };
  await p.sock.refused('e2ee.setup', { ...payload, devlist: forged }, /signature/);
  await p.sock.refused('e2ee.setup', { ...payload, prekey: { ...payload.prekey, kid: 2 } }, /prekey/);
  const r = await p.sock.ok('e2ee.setup', payload);
  assert.equal(r.me.state, 'ready');
  assert.equal(r.me.devices.length, 1);
  assert.equal(r.me.devices[0].state, 'trusted');
  await p.sock.refused('e2ee.setup', payload, /already on/);
  const again = await reconnect(p);
  assert.equal(again.hello.e2ee.me.state, 'ready');
  assert.equal(again.hello.e2ee.me.hist, true);
  assert.notEqual(again.hello.e2ee.nonce, p.sock.hello.e2ee.nonce, 'a fresh nonce per socket');
  await again.close(); await p.sock.close();

  // On by default: a server started with no setting offers it.
  const onSrv = await startServer({ port: 0, dataDir: tmp(), quiet: true });
  try {
    const q = await register(onSrv, 'e2-default');
    const s = await new Sock(onSrv, q.cookie).connect();
    assert.equal(s.hello.e2ee.on, true, 'on by default');
    assert.equal((await (await fetch(`http://127.0.0.1:${onSrv.port}/api/version`)).json()).e2ee, 1);
    await s.close();
  } finally { await onSrv.close(); }

  // The server owner's switch: SNUG_E2EE=off stops offering it (nothing already encrypted is downgraded).
  for (const value of ['off', '0', 'false']) {
    const was = process.env.SNUG_E2EE;
    process.env.SNUG_E2EE = value;
    let offSrv;
    try { offSrv = await startServer({ port: 0, dataDir: tmp(), quiet: true }); } finally { if (was === undefined) delete process.env.SNUG_E2EE; else process.env.SNUG_E2EE = was; }
    try {
      const q = await register(offSrv, `e2-off-${value}`);
      const s = await new Sock(offSrv, q.cookie).connect();
      assert.equal(s.hello.e2ee.on, false, `SNUG_E2EE=${value}`);
      const dev = await newDevice(q.id);
      await s.refused('e2ee.setup', (await setupPayload(q.id, dev)).payload, /isn’t turned on/);
      await s.close();
    } finally { await offSrv.close(); }
  }
});

test('bind: only a valid proof over this socket’s nonce binds; another socket’s nonce or another person’s device doesn’t', async () => {
  const p = await enrolled('e2-bind');
  const q = await enrolled('e2-bind2');
  const s = await reconnect(p);
  await s.refused('e2ee.bind', { d: p.dev.d, sig: b64u(random(64)) }, /didn’t check out/);
  await s.refused('e2ee.bind', { d: p.dev.d, sig: await bindSig(p.dev, p.sock.hello.e2ee.nonce) }, /didn’t check out/, 'replayed proof from another socket');
  await s.refused('e2ee.bind', { d: q.dev.d, sig: await bindSig(q.dev, s.hello.e2ee.nonce) });
  // Unbound, it can't rotate a prekey.
  await s.refused('e2ee.prekey', { prekey: await nextPrekey(p.dev) }, /Bind/);
  p.dev.kid -= 1;
  const r = await bind(s, p.dev);
  assert.deepEqual([r.state, r.kid], ['trusted', 1]);
  const session = srv.db.get('SELECT e2ee_device FROM sessions WHERE user = ?', p.id);
  assert.equal(session.e2ee_device, p.dev.d, 'the session remembers its device');
  await s.close(); await p.sock.close(); await q.sock.close();
});

test('bundles: keys only for yourself and people you can message; prekey ids must grow', async () => {
  const a = await enrolled('e2-bun-a');
  const b = await enrolled('e2-bun-b');
  const stranger = await enrolled('e2-bun-x');
  let r = await a.sock.ok('e2ee.bundles', { users: [a.id, b.id, stranger.id] });
  assert.deepEqual(Object.keys(r.users), [a.id], 'nobody else before they can talk');
  await friends(a, b);
  r = await a.sock.ok('e2ee.bundles', { users: [b.id, stranger.id] });
  assert.deepEqual(Object.keys(r.users), [b.id]);
  const got = r.users[b.id];
  assert.equal(got.ready, true);
  assert.equal(canon(got.list), canon(b.acct.list));
  assert.ok(await obj.verifyList(got.list));
  assert.ok(await obj.verifyPrekey(got.prekeys[b.dev.d], { u: b.id, d: b.dev.d, dsk: b.dev.dskPub }));
  // Prekey rotation: the next id only; the old one is retired, the new one served.
  await b.sock.refused('e2ee.prekey', { prekey: await obj.makePrekey(b.dev.dsk.privateKey, { u: b.id, d: b.dev.d, kid: 3, pub: b64u(random(32)) }) }, /out of order/);
  await b.sock.refused('e2ee.prekey', { prekey: await obj.makePrekey(b.dev.dsk.privateKey, { u: b.id, d: b.dev.d, kid: 1, pub: b64u(random(32)) }) }, /out of order/);
  const p2 = await nextPrekey(b.dev);
  assert.equal((await b.sock.ok('e2ee.prekey', { prekey: p2 })).kid, 2);
  r = await a.sock.ok('e2ee.bundles', { users: [b.id] });
  assert.equal(r.users[b.id].prekeys[b.dev.d].kid, 2);
  assert.ok(srv.db.get('SELECT retired FROM e2ee_prekeys WHERE device = ? AND kid = 1', b.dev.d).retired);
  await a.sock.refused('e2ee.bundles', { users: Array.from({ length: 11 }, (_, i) => `u_${i}`) }, /up to 10/);
  for (const p of [a, b, stranger]) await p.sock.close();
});

test('publish: compare-and-swap on the list version, the account key must match, and only the account’s own devices', async () => {
  const p = await enrolled('e2-pub');
  const q = await enrolled('e2-pub2');
  // History off: a list with no archive key.
  const v2 = await nextList(p.acct, () => ({ arc: null }));
  assert.equal((await p.sock.ok('e2ee.publish', { devlist: v2 })).ver, 2);
  assert.equal(srv.db.get('SELECT hist FROM e2ee_accounts WHERE user = ?', p.id).hist, 0);
  const stale = await p.sock.refused('e2ee.publish', { devlist: v2 });
  assert.equal(stale.code, 'e2ee_conflict');
  // Another person's device can't be slipped into the list.
  const withQ = await obj.makeList(p.acct.keys.aik, { ...v2, ver: 3, devs: [...v2.devs, deviceEntry(q.dev)] });
  await p.sock.refused('e2ee.publish', { devlist: withQ }, /doesn’t have|own steps/);
  // A list signed by someone else's account key is refused.
  const foreign = await obj.makeList(q.acct.keys.aik, { ...v2, ver: 3, aik: q.acct.keys.aikPub });
  await p.sock.refused('e2ee.publish', { devlist: foreign }, /different account key/);
  // An unbound socket can't publish.
  const s = await reconnect(p);
  await s.refused('e2ee.publish', { devlist: await nextList(p.acct, () => ({})) }, /can’t change/);
  await s.close(); await p.sock.close(); await q.sock.close();
});

test('link: a new device is added with the typed code; contacts hear about it; the new device gets the account keys', async () => {
  const a = await enrolled('e2-link');
  const friend = await enrolled('e2-link-f');
  await friends(a, friend);
  await a.sock.ok('dm.open', { users: [friend.id] }); // people sharing a DM hear about device changes
  // The new browser: same account, new socket, new keys.
  const b = await reconnect(a, await login(srv, a.handle));
  const dev = await newDevice(a.id, { label: 'Firefox on Windows' });
  const { linkId } = await b.ok('e2ee.link.start', { device: devicePublic(dev), prekey: dev.prekeys[1].signed });
  await bind(b, dev);
  assert.equal((await b.ok('e2ee.state')).devices.find((x) => x.d === dev.d).state, 'pending');
  const ask = await a.sock.next('e2ee.link', (x) => x.linkId === linkId);
  assert.equal(ask.label, 'Firefox on Windows');
  // Trusted device shows a code; the person types it on the new one.
  const { code } = link.newLinkCode();
  const Kc = await link.linkKey(code, linkId);
  const t1 = await link.tag1(Kc, { linkId, u: a.id, d: dev.d, dsk: dev.dskPub, prekey: dev.prekeys[1].signed });
  await a.sock.refused('e2ee.link.proof', { linkId, tag1: t1 }, /new device/);
  await b.ok('e2ee.link.proof', { linkId, tag1: t1 });
  await b.refused('e2ee.link.proof', { linkId, tag1: t1 }, /already tried/);
  const proof = await a.sock.next('e2ee.link.proof', (x) => x.linkId === linkId);
  const mine = await link.tag1(Kc, { linkId, u: a.id, d: ask.d, dsk: ask.dsk, prekey: ask.prekey });
  assert.ok(link.sameTag(proof.tag1, mine), 'the approving device recomputes the tag over the keys it was given');
  // Approve: list + 1 with the new device, the account keys sealed to its prekey.
  const list = await nextList(a.acct, (cur) => ({ devs: [...cur.devs, deviceEntry(dev)] }));
  const box = await sealKey(b64uOf(ask.prekey.pub, 32), `snug-e2ee-v1/link-asb\n${a.id}\n${dev.d}`, canon({ linkId, ver: list.ver }), new TextEncoder().encode(canon({ asb: a.acct.asb, by: a.dev.d })));
  await a.sock.ok('e2ee.link.approve', { linkId, devlist: list, box: b64u(box), tag2: await link.tag2(Kc, box, list) });
  await b.next('e2ee.link.done', (x) => x.linkId === linkId && x.state === 'approved');
  const changed = await friend.sock.next('e2ee.devices', (x) => x.user === a.id);
  assert.equal(changed.ver, 2);
  const f = await b.ok('e2ee.link.fetch', { linkId });
  assert.ok(link.sameTag(f.tag2, await link.tag2(Kc, b64uOf(f.box), f.devlist)));
  const opened = JSON.parse(new TextDecoder().decode(await openKey(dev.prekeys[1].pair, `snug-e2ee-v1/link-asb\n${a.id}\n${dev.d}`, canon({ linkId, ver: f.devlist.ver }), b64uOf(f.box))));
  assert.equal(await backup.asbAikPublic(opened.asb), f.devlist.aik, 'the account key in the box is the one that signed the list');
  assert.equal((await b.ok('e2ee.state')).devices.find((x) => x.d === dev.d).state, 'trusted');
  await b.close(); await a.sock.close(); await friend.sock.close();
});

test('link: a wrong code cancels the request (one attempt), and at most three requests wait at once', async () => {
  const a = await enrolled('e2-link-bad');
  const b = await reconnect(a);
  const dev = await newDevice(a.id);
  const { linkId } = await b.ok('e2ee.link.start', { device: devicePublic(dev), prekey: dev.prekeys[1].signed });
  await bind(b, dev);
  const Kc = await link.linkKey(link.newLinkCode().code, linkId); // typed the wrong code
  await b.ok('e2ee.link.proof', { linkId, tag1: await link.tag1(Kc, { linkId, u: a.id, d: dev.d, dsk: dev.dskPub, prekey: dev.prekeys[1].signed }) });
  await a.sock.next('e2ee.link.proof');
  await a.sock.ok('e2ee.link.cancel', { linkId }); // the approving device's tag didn't match
  await b.next('e2ee.link.done', (x) => x.linkId === linkId && x.state === 'cancelled');
  assert.equal(srv.db.get('SELECT 1 FROM e2ee_devices WHERE id = ?', dev.d), undefined, 'the pending device is gone');
  await b.refused('e2ee.link.fetch', { linkId }, /ended/);
  for (let i = 0; i < 3; i++) { const x = await newDevice(a.id); await b.ok('e2ee.link.start', { device: devicePublic(x), prekey: x.prekeys[1].signed }); }
  const extra = await newDevice(a.id);
  await b.refused('e2ee.link.start', { device: devicePublic(extra), prekey: extra.prekeys[1].signed }, /Too many devices are waiting/);
  // The sweep clears expired requests.
  srv.hub.e2ee.sweep(Date.now() + 11 * 60_000);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'pending'", a.id).n, 0);
  await b.close(); await a.sock.close();
});

test('recovery: the backup needs a recent sign-in (or the password), is rate limited, and adds the device with the account key', async () => {
  const a = await enrolled('e2-recover');
  const b = await reconnect(a, await login(srv, a.handle));
  const dev = await newDevice(a.id, { label: 'New laptop' });
  const { linkId } = await b.ok('e2ee.link.start', { device: devicePublic(dev), prekey: dev.prekeys[1].signed });
  await bind(b, dev);
  srv.db.run('UPDATE sessions SET auth_at = 0 WHERE user = ?', a.id); // signed in long ago
  const no = await b.refused('e2ee.backup.get', {}, /password/);
  assert.equal(no.code, 'reauth');
  await b.refused('e2ee.backup.get', { password: 'not it' }, /isn’t right/);
  const got = await b.ok('e2ee.backup.get', { password: 'a long password' });
  const asb = await backup.openBackup(got.blob, a.acct.bk, a.id);
  const keys = await backup.loadAsb(asb);
  // Recovery drops the old (lost) device in the same step.
  const list = await obj.makeList(keys.aik, { u: a.id, ver: a.acct.list.ver + 1, aik: keys.aikPub, devs: [deviceEntry(dev)], arc: await nextArc(a.acct.list) }); // a new history epoch: the dropped device holds the old key
  await b.ok('e2ee.recover', { linkId, devlist: list });
  const me = await b.ok('e2ee.state');
  assert.deepEqual(me.devices.map((x) => [x.d, x.state]), [[dev.d, 'trusted']]);
  assert.equal(srv.db.get('SELECT state FROM e2ee_devices WHERE id = ?', a.dev.d).state, 'removed');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM e2ee_prekeys WHERE device = ?', a.dev.d).n, 0);
  // Five tries an hour.
  for (let i = 0; i < 4; i++) await b.ok('e2ee.backup.get', {});
  await b.refused('e2ee.backup.get', {}, /Too many tries/);
  assert.ok(srv.db.get("SELECT COUNT(*) n FROM auth_events WHERE user = ? AND event = 'e2ee.backup.get'", a.id).n >= 5);
  await b.close(); await a.sock.close().catch(() => {});
});

test('device removal ends that device’s sessions; meta is compare-and-swap; reset is audited and replaces the account key', async () => {
  const a = await enrolled('e2-remove');
  // Add a second device through the link flow's server steps.
  const cookie2 = await login(srv, a.handle);
  const b = await reconnect(a, cookie2);
  const dev = await newDevice(a.id);
  const { linkId } = await b.ok('e2ee.link.start', { device: devicePublic(dev), prekey: dev.prekeys[1].signed });
  await bind(b, dev);
  await b.ok('e2ee.link.proof', { linkId, tag1: b64u(random(32)) });
  const list = await nextList(a.acct, (cur) => ({ devs: [...cur.devs, deviceEntry(dev)] }));
  await a.sock.ok('e2ee.link.approve', { linkId, devlist: list, box: b64u(random(120)), tag2: b64u(random(32)) });
  // Meta: compare-and-swap.
  const m = await a.sock.ok('e2ee.meta.get');
  assert.equal(m.ver, 1);
  await a.sock.ok('e2ee.meta.put', { ver: 2, blob: b64u(random(60)) });
  const conflict = await b.refused('e2ee.meta.put', { ver: 2, blob: b64u(random(60)) });
  assert.deepEqual([conflict.code, conflict.data], ['e2ee_conflict', { ver: 2 }]);
  // Remove the second device from the first: its socket closes and its session is gone.
  const closed = new Promise((r) => b.ws.on('close', r));
  const without = await nextList(a.acct, async (cur) => ({ devs: cur.devs.filter((x) => x.d !== dev.d), arc: await nextArc(cur) }));
  await a.sock.refused('e2ee.device.remove', { d: a.dev.d, devlist: without }, /without that one/);
  await a.sock.ok('e2ee.device.remove', { d: dev.d, devlist: without });
  assert.equal(await closed, 4001);
  assert.equal((await fetch(`${web(srv).base}/api/me`, { headers: { cookie: cookie2 } })).status, 401);
  // Reset: a new account key and device; old devices removed; audited.
  const fresh = await newDevice(a.id);
  const { payload } = await setupPayload(a.id, fresh);
  // Signed by an old key, or naming a key that didn't sign it: refused.
  const sameKey = await obj.makeList(a.acct.keys.aik, { ...payload.devlist, ver: a.acct.list.ver + 1, aik: a.acct.keys.aikPub });
  await a.sock.refused('e2ee.reset', { ...payload, devlist: sameKey }, /new account key|account key/);
  await a.sock.refused('e2ee.reset', { ...payload, devlist: { ...payload.devlist, ver: a.acct.list.ver + 1 } }, /signature/);
  const r2 = await setupPayload(a.id, fresh);
  const v = await obj.makeList(r2.acct.keys.aik, { ...r2.payload.devlist, ver: a.acct.list.ver + 1 });
  const res = await a.sock.ok('e2ee.reset', { ...r2.payload, devlist: v });
  assert.equal(res.me.devices.length, 1);
  assert.equal(res.me.devices[0].d, fresh.d);
  assert.ok(res.me.resetAt);
  assert.equal(srv.db.get('SELECT state FROM e2ee_devices WHERE id = ?', a.dev.d).state, 'removed');
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM auth_events WHERE user = ? AND event = 'e2ee.reset'", a.id).n, 1);
  await a.sock.close();
});

// ---------- review fixes (H3, M2): removing a device, history keys, the recovery backup ----------
const freshPub = async () => b64u(await sig.rawPublic((await sig.newDhPair(false)).publicKey));
const nextArc = async (cur, step = 1) => ({ e: cur.arc.e + step, pub: await freshPub(), at: Date.now() });
// A second trusted device for p, through the link flow's server steps; returns its socket.
async function secondDevice(p) {
  const s = await reconnect(p, await login(srv, p.handle));
  const dev = await newDevice(p.id, { label: 'Old phone' });
  const { linkId } = await s.ok('e2ee.link.start', { device: devicePublic(dev), prekey: dev.prekeys[1].signed });
  await bind(s, dev);
  await s.ok('e2ee.link.proof', { linkId, tag1: b64u(random(32)) });
  await p.sock.ok('e2ee.link.approve', { linkId, devlist: await nextList(p.acct, (cur) => ({ devs: [...cur.devs, deviceEntry(dev)] })), box: b64u(random(120)), tag2: b64u(random(32)) });
  return { s, dev };
}

test('history key: a list may keep the current epoch only with the same key; a new key needs a higher epoch, on every path', async () => {
  const p = await enrolled('e2-arc');
  const e = p.acct.list.arc.e;
  // The same epoch number with another key: refused (a box made for the old key would still say "newest").
  await p.sock.refused('e2ee.publish', { devlist: await obj.makeList(p.acct.keys.aik, { ...p.acct.list, ver: p.acct.list.ver + 1, arc: { e, pub: await freshPub(), at: Date.now() } }) }, /history key/);
  // The same key at the same epoch (a label change, history switched on again): fine; a higher epoch: fine.
  assert.equal((await p.sock.ok('e2ee.publish', { devlist: await nextList(p.acct, () => ({})) })).ver, 2);
  assert.equal((await p.sock.ok('e2ee.publish', { devlist: await nextList(p.acct, async (cur) => ({ arc: await nextArc(cur) })) })).ver, 3);
  // Off, then on again with the key it had: fine; with another key at that epoch: refused.
  const keep = p.acct.list.arc;
  await p.sock.ok('e2ee.publish', { devlist: await nextList(p.acct, () => ({ arc: null })) });
  await p.sock.refused('e2ee.publish', { devlist: await obj.makeList(p.acct.keys.aik, { ...p.acct.list, ver: p.acct.list.ver + 1, arc: { e: keep.e, pub: await freshPub(), at: Date.now() } }) }, /history key/);
  await p.sock.ok('e2ee.publish', { devlist: await nextList(p.acct, () => ({ arc: keep })) });
  await p.sock.close();
});

test('removing a device with history on needs a new history epoch; the backup, the other devices’ keys and the synced settings change in the same step', async () => {
  const p = await enrolled('e2-rm-epoch');
  const { s, dev } = await secondDevice(p);
  const third = await secondDevice(p);
  const without = (cur) => cur.devs.filter((x) => x.d !== dev.d);
  // The same history key after a removal: refused (the removed device holds it).
  const same = await obj.makeList(p.acct.keys.aik, { ...p.acct.list, ver: p.acct.list.ver + 1, devs: without(p.acct.list) });
  await p.sock.refused('e2ee.device.remove', { d: dev.d, devlist: same }, /new history key/);
  // Synced settings that changed on another device meanwhile: refused as a whole (nothing removed).
  const meta = await p.sock.ok('e2ee.meta.get');
  const next = await obj.makeList(p.acct.keys.aik, { ...p.acct.list, ver: p.acct.list.ver + 1, devs: without(p.acct.list), arc: await nextArc(p.acct.list) });
  const boxes = { [third.dev.d]: { kid: 1, blob: b64u(random(200)), by: p.dev.d, sig: b64u(random(64)) } };
  const bk2 = random(32);
  const backup2 = await backup.sealBackup(p.acct.asb, bk2, { ver: next.ver, aik: next.aik });
  const conflict = await p.sock.refused('e2ee.device.remove', { d: dev.d, devlist: next, boxes, backup: backup2, meta: { ver: meta.ver + 5, blob: b64u(random(60)) } });
  assert.equal(conflict.code, 'e2ee_conflict');
  assert.equal(srv.db.get('SELECT state FROM e2ee_devices WHERE id = ?', dev.d).state, 'trusted', 'nothing changed');
  const newMeta = b64u(random(60));
  await p.sock.ok('e2ee.device.remove', { d: dev.d, devlist: next, boxes, backup: backup2, meta: { ver: meta.ver + 1, blob: newMeta } });
  p.acct.list = next;
  assert.equal(srv.db.get('SELECT state FROM e2ee_devices WHERE id = ?', dev.d).state, 'removed');
  assert.deepEqual({ ...srv.db.get('SELECT ver, blob FROM e2ee_meta WHERE user = ?', p.id) }, { ver: meta.ver + 1, blob: newMeta });
  assert.equal(JSON.parse(srv.db.get('SELECT blob FROM e2ee_backup WHERE user = ?', p.id).blob).c, backup2.c, 'the backup under the new recovery key');
  assert.ok(srv.db.get('SELECT 1 FROM e2ee_asb_boxes WHERE device = ? AND ver = ?', third.dev.d, next.ver));
  // A device removing itself needs a new epoch too (refused without one; the same step from another device goes through).
  const self = await obj.makeList(p.acct.keys.aik, { ...p.acct.list, ver: p.acct.list.ver + 1, devs: p.acct.list.devs.filter((x) => x.d !== third.dev.d) });
  await third.s.refused('e2ee.device.remove', { d: third.dev.d, devlist: self }, /new history key/);
  await p.sock.ok('e2ee.device.remove', { d: third.dev.d, devlist: await nextList(p.acct, async (cur) => ({ devs: cur.devs.filter((x) => x.d !== third.dev.d), arc: await nextArc(cur) })) });
  await s.close().catch(() => {}); await third.s.close().catch(() => {}); await p.sock.close();
});

test('recovery that leaves devices out starts a new epoch and can bring the other devices their keys and a new backup', async () => {
  const a = await enrolled('e2-rec-epoch');
  const kept = await secondDevice(a);
  const lost = await secondDevice(a);
  const b = await reconnect(a, await login(srv, a.handle));
  const dev = await newDevice(a.id, { label: 'New laptop' });
  const { linkId } = await b.ok('e2ee.link.start', { device: devicePublic(dev), prekey: dev.prekeys[1].signed });
  await bind(b, dev);
  const devs = [...a.acct.list.devs.filter((x) => x.d !== lost.dev.d), deviceEntry(dev)];
  const same = await obj.makeList(a.acct.keys.aik, { ...a.acct.list, ver: a.acct.list.ver + 1, devs });
  await b.refused('e2ee.recover', { linkId, devlist: same }, /new history key/);
  const list = await obj.makeList(a.acct.keys.aik, { ...a.acct.list, ver: a.acct.list.ver + 1, devs, arc: await nextArc(a.acct.list) });
  const boxes = { [kept.dev.d]: { kid: 1, blob: b64u(random(200)), by: dev.d, sig: b64u(random(64)) }, [a.dev.d]: { kid: 1, blob: b64u(random(200)), by: dev.d, sig: b64u(random(64)) } };
  const backup2 = await backup.sealBackup(a.acct.asb, random(32), { ver: list.ver, aik: list.aik });
  await b.ok('e2ee.recover', { linkId, devlist: list, boxes, backup: backup2 });
  assert.equal(srv.db.get('SELECT state FROM e2ee_devices WHERE id = ?', lost.dev.d).state, 'removed');
  assert.ok(srv.db.get('SELECT 1 FROM e2ee_asb_boxes WHERE device = ? AND ver = ?', kept.dev.d, list.ver));
  assert.equal(JSON.parse(srv.db.get('SELECT blob FROM e2ee_backup WHERE user = ?', a.id).blob).c, backup2.c);
  for (const x of [kept.s, lost.s, b, a.sock]) await x.close().catch(() => {});
});

test('the recovery backup goes only to a socket bound to one of the account’s devices', async () => {
  const a = await enrolled('e2-backup-bound');
  const b = await reconnect(a, await login(srv, a.handle));
  await b.refused('e2ee.backup.get', { password: 'a long password' }, /this device/);
  await b.close(); await a.sock.close();
});
