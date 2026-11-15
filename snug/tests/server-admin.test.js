// v0.10 admin, bans, announcements and the minimum version, end to end between PCs and a local registry
// (server/notices.js, server/peersignal.js, registry admin). The registry enforces; the PCs show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, startPc, signUp, clientFor, guest, until, OWNER_GH } from './helpers/p2p.js';
import { signalUp, regAdmin, uidOfPc, staysDown } from './helpers/admin.js';
import { APP_VERSION } from '../server/peersignal.js';

let registry;
const pcs = [];
const pc = async (o) => { const s = await startPc(registry, o); pcs.push(s); return s; };
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });

let O, o, B, b, bGuest;
test('the owner’s PC: snapshot has notices.admin with every right; admin.call works for the owner only', async () => {
  O = await pc();
  o = await signUp(O, registry, OWNER_GH, 'a');
  await signalUp(O);
  await until(() => O.notices.state.admin.includes('grant'), 8000, 'admin rights from ready');
  const o2 = await clientFor(O, o.id);
  assert.deepEqual([...o2.hello.notices.admin].sort(), ['ann', 'ban', 'grant', 'names', 'stats', 'update']);
  assert.deepEqual(o2.hello.notices.ann, []);
  assert.equal(o2.hello.notices.ban, null);
  await o2.close();
  const me = await o.ok('admin.call', { a: 'me' });
  assert.ok(me.perms.includes('grant'));
  const stats = await o.ok('admin.call', { a: 'stats' });
  assert.ok(stats.accounts >= 1);
  assert.ok(stats.online >= 1);
  // a LAN guest on the owner's PC: no admin, no rights in the snapshot
  const g = await guest(O, 'lanny');
  assert.match(await g.refused('admin.call', { a: 'me' }), /Only this PC’s Snug account/);
  assert.equal(g.hello.notices.admin, undefined);
  assert.deepEqual(g.hello.notices.ann, []);
  // never from a friend's PC (c.peer)
  await assert.rejects(Promise.resolve().then(() => O.hub.ops['admin.call']({ user: o.id, peer: 'abcdefghijklmnop' }, { a: 'me' })), /Only this PC’s Snug account/);
  // registry errors come back in words
  assert.match(await o.refused('admin.call', { a: 'user.find', q: 'nobody.here' }), /Nobody by that name/);
  assert.match(await o.refused('admin.call', { a: 'nope' }), /malformed/i);
  await g.close();
});

test('a ban stops P2P on the banned PC and shows notices.ban; unban, then a timeout reconnects by itself at its end', async () => {
  B = await pc();
  b = await signUp(B, registry, OWNER_GH + 1, 'bob');
  await signalUp(B);
  bGuest = await guest(B, 'bobsguest');
  const bUid = uidOfPc(B);
  await o.ok('admin.call', { a: 'ban', uid: bUid, reason: 'Spamming people', until: null });
  const n = await b.next('notices', (d) => d.ban);
  assert.deepEqual(n.ban, { until: null, reason: 'Spamming people' });
  assert.ok(await staysDown(B, 1500), 'no reconnecting while banned');
  assert.equal(B.notices.state.ban.reason, 'Spamming people');
  // the guest on that PC is not told about the owner's ban
  assert.ok(!bGuest.has('notices', (d) => d.ban));
  const b2 = await clientFor(B, b.id);
  assert.equal(b2.hello.notices.ban.reason, 'Spamming people');
  await b2.close();
  // the registry refuses its lookups too
  await assert.rejects(B.peer.reg.lookup({ name: 'a' }), (e) => e.code === 'banned');
  await o.ok('admin.call', { a: 'unban', uid: bUid });
  B.peer.stop(); B.peer.start();
  await signalUp(B);
  await until(() => B.notices.state.ban === null, 5000, 'ban cleared on ready');
  assert.equal((await b.next('notices', (d) => d.ban === null)).ban, null);
  // a timeout: the PC tries once more when it ends and is let back in
  const untilT = Date.now() + 2500;
  await o.ok('admin.call', { a: 'ban', uid: bUid, reason: 'Cool down', until: untilT });
  assert.equal((await b.next('notices', (d) => d.ban?.reason === 'Cool down')).ban.until, untilT);
  await until(() => !B.peer._signal.connected, 3000, 'socket closed');
  await until(() => B.peer._signal.connected, 10_000, 'reconnected after the timeout');
  await until(() => B.notices.state.ban === null, 3000, 'ban cleared');
});

test('an announcement arrives live on every PC and for every local person; removing it clears it', async () => {
  const added = await o.ok('admin.call', { a: 'ann.add', text: 'Maintenance tonight', level: 'warn' });
  for (const c of [o, b, bGuest]) {
    const n = await c.next('notices', (d) => d.ann.some((a) => a.id === added.id));
    assert.equal(n.ann.find((a) => a.id === added.id).text, 'Maintenance tonight');
  }
  const fresh = await clientFor(B, b.id);
  assert.equal(fresh.hello.notices.ann[0].level, 'warn');
  await fresh.close();
  await o.ok('admin.call', { a: 'ann.remove', id: added.id });
  await bGuest.next('notices', (d) => d.ann.length === 0);
  await b.next('notices', (d) => d.ann.length === 0);
});

test('admin rights granted live; a granted admin can use them, and not others', async () => {
  const bUid = uidOfPc(B);
  await o.ok('admin.call', { a: 'admin.grant', uid: bUid, perms: ['ann'] });
  assert.deepEqual((await b.next('notices', (d) => d.admin?.length)).admin, ['ann']);
  const a2 = await b.ok('admin.call', { a: 'ann.add', text: 'From bob', level: 'info' });
  assert.match(await b.refused('admin.call', { a: 'stats' }), /don’t have that admin right/);
  await b.ok('admin.call', { a: 'ann.remove', id: a2.id });
  await o.ok('admin.call', { a: 'admin.revoke', uid: bUid });
  await b.next('notices', (d) => Array.isArray(d.admin) && d.admin.length === 0);
});

test('a forced rename reaches the renamed PC: its username and local handle follow', async () => {
  const bUid = uidOfPc(B);
  await o.ok('admin.call', { a: 'name.rename', uid: bUid, name: 'robert' });
  await until(() => B.peer.identity.self().username === 'robert', 5000, 'username updated');
  assert.equal(B.db.get('SELECT handle FROM users WHERE id = ?', b.id).handle, 'robert');
  assert.equal((await b.next('p2p', (d) => d.username === 'robert')).username, 'robert');
});

test('a suspension “for good” that is lifted: the PC reconnects by itself, without a restart', async () => {
  process.env.SNUG_BAN_RETRY_MS = '1500'; // hourly in the app
  let C, c;
  try {
    C = await pc();
    c = await signUp(C, registry, OWNER_GH + 7, 'carlos');
  } finally { delete process.env.SNUG_BAN_RETRY_MS; }
  await signalUp(C);
  const cUid = uidOfPc(C);
  await regAdmin(O, { a: 'ban', uid: cUid, reason: 'Oops', until: null });
  await c.next('notices', (d) => d.ban);
  await until(() => !C.peer._signal.connected, 3000, 'socket closed');
  await regAdmin(O, { a: 'unban', uid: cUid });
  await until(() => C.peer._signal.connected, 10_000, 'reconnected by itself');
  await until(() => C.notices.state.ban === null, 3000, 'ban cleared');
});

test('below the minimum version: the PC stops reconnecting and shows outdated', async () => {
  // Claim a newer app than this one so the minimum can sit above APP_VERSION (the registry trusts the claim).
  const next = APP_VERSION.split('.').map(Number);
  const min = `${next[0]}.${next[1] + 1}.0`;
  await regAdmin(O, { a: 'min.set', v: min, app: min });
  const n = await b.next('notices', (d) => d.outdated);
  assert.deepEqual(n.outdated, { min });
  assert.equal(n.min, min);
  assert.ok(await staysDown(B, 2500), 'no reconnecting while outdated');
  // the guest hears the minimum too (shown as "update Snug")
  assert.equal((await bGuest.next('notices', (d) => d.min === min)).min, min);
  await regAdmin(O, { a: 'min.set', v: null });
});
