// v0.10 admin: permissions, owner rules, replay, bans and timeouts, announcements, minimum version,
// reserved names, forced renames, the audit log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, makeKeys, OWNER_ID, HOUR, DAY } from './helpers.js';

let reg;
let owner;
let nextId = 5000;
before(async () => {
  reg = await start();
  owner = await reg.signUp(OWNER_ID, 'a');
});
after(() => reg.close());

const user = (name) => reg.signUp(nextId++, name);

/** POST /v1/admin as u (S0 signedCall format). Returns {status, body, sent}. */
async function adm(u, payload, { k = u.k, ts = reg.ts() } = {}) {
  const p = JSON.stringify(payload);
  const body = { uid: u.uid, ts, p, sig: k.sign(`snug-reg-v1\nadmin\n${u.uid}\n${ts}\n${p}`) };
  const r = await reg.call('/v1/admin', body);
  return { ...r, sent: body };
}
const ok = async (u, payload) => {
  const r = await adm(u, payload);
  assert.equal(r.status, 200, `${payload.a}: ${JSON.stringify(r.body)}`);
  return r.body;
};
/** A signal socket whose auth frame carries app version v; s.ready is set when the registry accepted it. */
async function connectV(u, v, k = u.k) {
  const s = await reg.connect(u.uid, k, {
    auth: (c) => ({ t: 'auth', uid: u.uid, sig: k.sign(`snug-reg-v1\nsignal\n${u.uid}\n${c.n}`), ...(v ? { v } : {}) }),
  });
  s.ready = await s.next((m) => m.t === 'ready' || m.t === 'update').then((m) => (m.t === 'ready' ? m : null)).catch(() => null);
  return s;
}

test('me: the owner has every right plus grant; others none; ready.admin only for admins', async () => {
  const me = await ok(owner, { a: 'me' });
  assert.deepEqual(me.perms.sort(), ['ann', 'ban', 'grant', 'names', 'stats', 'update']);
  const u = await user('plainuser');
  assert.deepEqual((await ok(u, { a: 'me' })).perms, []);
  const so = await reg.connect(owner.uid, owner.k);
  assert.ok(so.ready.admin.includes('grant'));
  assert.deepEqual(so.ready.notices, { min: null, ann: [] });
  const su = await reg.connect(u.uid, u.k);
  assert.equal(su.ready.admin, undefined);
  so.close();
  su.close();
});

test('permission matrix: grants, forbidden actions, owner untouchable, admins only by the owner', async () => {
  const mod = await user('helper1');
  const mod2 = await user('helper2');
  const target = await user('troll');
  const plain = await user('nobody1');
  // non-admins get forbidden for everything but me
  for (const a of ['stats', 'bans', 'audit', 'admins', 'name.reserved']) {
    const r = await adm(plain, { a });
    assert.equal(r.status, 403, a);
    assert.equal(r.body.error, 'forbidden');
  }
  // only the owner grants
  const sm = await reg.connect(mod.uid, mod.k);
  const g = await ok(owner, { a: 'admin.grant', uid: mod.uid, perms: ['ban', 'ban'] });
  assert.deepEqual(g.perms, ['ban']);
  assert.deepEqual((await sm.next((m) => m.t === 'admin')).perms, ['ban']);
  await ok(owner, { a: 'admin.grant', uid: mod2.uid, perms: ['ban', 'stats'] });
  assert.equal((await adm(mod, { a: 'admin.grant', uid: plain.uid, perms: ['ban'] })).body.error, 'forbidden');
  assert.equal((await adm(mod, { a: 'admin.revoke', uid: mod.uid })).body.error, 'forbidden', 'no changing own rights');
  assert.equal((await adm(owner, { a: 'admin.grant', uid: owner.uid, perms: ['ban'] })).body.error, 'forbidden', 'the owner is untouchable');
  assert.equal((await adm(owner, { a: 'admin.grant', uid: plain.uid, perms: ['grant'] })).body.error, 'bad_request', 'grant cannot be given');
  // a ban admin can ban a normal account, but not stats, not the owner, not another admin
  assert.equal((await adm(mod, { a: 'stats' })).body.error, 'forbidden');
  assert.equal((await adm(mod, { a: 'ban', uid: owner.uid, reason: 'x', until: null })).body.error, 'forbidden');
  assert.equal((await adm(mod, { a: 'ban', uid: mod2.uid, reason: 'x', until: null })).body.error, 'forbidden');
  assert.equal((await adm(mod, { a: 'ban', uid: mod.uid, reason: 'x', until: null })).status, 400, 'not yourself');
  await ok(mod, { a: 'ban', uid: target.uid, reason: 'spam', until: null });
  await ok(mod, { a: 'unban', uid: target.uid });
  // the owner may act on an admin
  await ok(owner, { a: 'ban', uid: mod2.uid, reason: 'misuse', until: null });
  await ok(owner, { a: 'unban', uid: mod2.uid });
  // revoke: rights gone, the socket hears it
  await ok(owner, { a: 'admin.revoke', uid: mod.uid });
  assert.deepEqual((await sm.next((m) => m.t === 'admin')).perms, []);
  assert.equal((await adm(mod, { a: 'ban', uid: target.uid, reason: 'x', until: null })).body.error, 'forbidden');
  const list = await ok(owner, { a: 'admins' });
  assert.deepEqual(list.admins.map((x) => [x.username, x.perms]), [['helper2', ['stats', 'ban']]]);
  sm.close();
});

test('signatures: replay refused (stale), wrong key refused, payload must be JSON with a known action', async () => {
  const r1 = await adm(owner, { a: 'stats' });
  assert.equal(r1.status, 200);
  const replay = await reg.call('/v1/admin', r1.sent);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, 'stale');
  const forged = await adm(owner, { a: 'stats' }, { k: makeKeys() });
  assert.equal(forged.body.error, 'bad_signature');
  assert.equal((await adm(owner, { a: 'nope' })).body.error, 'bad_request');
  const ts = reg.ts();
  const p = 'not json';
  const bad = await reg.call('/v1/admin', { uid: owner.uid, ts, p, sig: owner.k.sign(`snug-reg-v1\nadmin\n${owner.uid}\n${ts}\n${p}`) });
  assert.equal(bad.body.error, 'bad_request');
  // the payload is signed whole: changing any byte breaks it
  const r2 = await adm(owner, { a: 'stats' });
  const tampered = { ...r2.sent, ts: reg.ts(), p: JSON.stringify({ a: 'stats', x: 1 }) };
  assert.equal((await reg.call('/v1/admin', tampered)).body.error, 'bad_signature');
});

test('stats and user.find', async () => {
  const s = await ok(owner, { a: 'stats' });
  for (const k of ['accounts', 'new24h', 'new7d', 'online', 'bans', 'admins', 'knocks', 'reqToday']) assert.equal(typeof s[k], 'number', k);
  assert.ok(s.accounts >= 1);
  assert.equal(typeof s.relayOff, 'boolean');
  const u = await user('findme');
  const byName = await ok(owner, { a: 'user.find', q: '@FindMe' });
  assert.equal(byName.uid, u.uid);
  assert.equal(byName.ban, null);
  assert.deepEqual(byName.perms, []);
  assert.equal((await ok(owner, { a: 'user.find', q: u.uid })).username, 'findme');
  assert.equal((await adm(owner, { a: 'user.find', q: 'nobody.at.all' })).body.error, 'not_found');
});

test('ban: socket gets the banned frame and 4010; signaling, lookup, rename, claim and release refused; unban restores', async () => {
  const u = await user('banme');
  const friend = await user('banfriend');
  const s = await reg.connect(u.uid, u.k);
  const r = await ok(owner, { a: 'ban', uid: u.uid, reason: 'Spamming people', until: null });
  assert.equal(r.ban.until, null);
  assert.deepEqual(await s.next((m) => m.t === 'banned'), { t: 'banned', until: null, reason: 'Spamming people' });
  assert.equal((await s.closed).code, 4010);
  // reconnecting is refused the same way
  const s2 = await reg.connect(u.uid, u.k, { auth: reg.signAuth(u.uid, u.k) });
  assert.equal((await s2.next((m) => m.t === 'banned')).reason, 'Spamming people');
  assert.equal((await s2.closed).code, 4010);
  const lk = await reg.lookup(u, { name: 'banfriend' });
  assert.equal(lk.status, 403);
  assert.equal(lk.body.error, 'banned');
  assert.equal(lk.body.reason, 'Spamming people');
  assert.equal(lk.body.until, null);
  assert.equal((await reg.rename(u, 'newbanname')).body.error, 'banned');
  const a = await reg.authId(u.k, u.ghId);
  assert.equal((await reg.claim(u.k, a.body.ticket, 'otherbanname')).body.error, 'banned');
  const rel = await reg.signed('/v1/release', u.k, { uid: u.uid, ticket: a.body.ticket }, (ts) => ['release', u.uid, a.body.ticket, ts]);
  assert.equal(rel.body.error, 'banned', 'a ban cannot be shed by releasing the name');
  // others can still look the account up (only the banned account's own requests are refused)
  assert.equal((await reg.lookup(friend, { uid: u.uid })).status, 200);
  const found = await ok(owner, { a: 'user.find', q: 'banme' });
  assert.equal(found.ban.reason, 'Spamming people');
  assert.ok((await ok(owner, { a: 'bans' })).bans.some((b) => b.uid === u.uid && b.username === 'banme'));
  await ok(owner, { a: 'unban', uid: u.uid });
  const s3 = await reg.connect(u.uid, u.k);
  assert.equal(s3.ready.mode, 'normal');
  assert.equal((await reg.lookup(u, { name: 'banfriend' })).status, 200);
  s3.close();
});

test('timeout: refused until the time, then connects again (TEST_CLOCK)', async () => {
  const u = await user('timeout1');
  const until = reg.clock.now() + 2 * HOUR;
  await ok(owner, { a: 'ban', uid: u.uid, reason: 'Cool down', until });
  const s = await reg.connect(u.uid, u.k, { auth: reg.signAuth(u.uid, u.k) });
  assert.deepEqual(await s.next((m) => m.t === 'banned'), { t: 'banned', until, reason: 'Cool down' });
  assert.equal((await s.closed).code, 4010);
  assert.equal((await adm(owner, { a: 'ban', uid: u.uid, reason: 'x', until: reg.clock.now() - 1 })).status, 400, 'until must be in the future');
  await reg.clock.advance(2 * HOUR + 1000);
  const s2 = await reg.connect(u.uid, u.k);
  assert.equal(s2.ready.mode, 'normal');
  assert.ok(!(await ok(owner, { a: 'bans' })).bans.some((b) => b.uid === u.uid));
  s2.close();
});

test('announcements: broadcast to connected apps, GET /v1/notices, at most 5, remove, expiry', async () => {
  const u = await user('listener');
  const s = await reg.connect(u.uid, u.k);
  const added = await ok(owner, { a: 'ann.add', text: '  Maintenance tonight  ', level: 'warn' });
  const f = await s.next((m) => m.t === 'notices');
  assert.equal(f.ann.length, 1);
  assert.equal(f.ann[0].text, 'Maintenance tonight');
  assert.equal(f.ann[0].level, 'warn');
  assert.equal(f.ann[0].id, added.id);
  const pub = await reg.call('/v1/notices');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body, { min: null, ann: f.ann });
  // a new connection gets them in ready
  const s2 = await reg.connect(u.uid, u.k);
  await s.closed;
  assert.equal(s2.ready.notices.ann[0].id, added.id);
  assert.equal((await adm(owner, { a: 'ann.add', text: 'x', level: 'loud' })).status, 400);
  assert.equal((await adm(owner, { a: 'ann.add', text: 'y'.repeat(501) })).status, 400);
  const short = await ok(owner, { a: 'ann.add', text: 'Short one', until: reg.clock.now() + HOUR });
  for (let i = 0; i < 3; i++) await ok(owner, { a: 'ann.add', text: `n${i}` });
  const six = await adm(owner, { a: 'ann.add', text: 'one too many' });
  assert.equal(six.status, 400);
  await reg.clock.advance(HOUR + 1000);
  const after1 = (await reg.call('/v1/notices')).body.ann;
  assert.equal(after1.length, 4);
  assert.ok(!after1.some((a) => a.id === short.id), 'expired announcement is gone');
  for (const a of after1) await ok(owner, { a: 'ann.remove', id: a.id });
  const last = await s2.next((m) => m.t === 'notices' && m.ann.length === 0, 5000);
  assert.deepEqual(last.ann, []);
  assert.equal((await adm(owner, { a: 'ann.remove', id: 'gone' })).body.error, 'not_found');
  s2.close();
});

test('minimum version: older apps get update + 4011, never above the caller, null clears', async () => {
  const u = await user('oldapp');
  const n = await user('newapp');
  const sOld = await connectV(u, '0.9.7');
  const sNew = await connectV(n, '0.10.0');
  assert.equal((await adm(owner, { a: 'min.set', v: '0.11.0', app: '0.10.0' })).status, 400, 'above my own version');
  assert.equal((await adm(owner, { a: 'min.set', v: '0.10.0' })).status, 400, 'my version is required');
  assert.equal((await adm(owner, { a: 'min.set', v: 'banana', app: '0.10.0' })).status, 400);
  await ok(owner, { a: 'min.set', v: '0.10.0', app: '0.10.0' });
  assert.deepEqual(await sOld.next((m) => m.t === 'update'), { t: 'update', min: '0.10.0' });
  assert.equal((await sOld.closed).code, 4011);
  assert.equal((await sNew.next((m) => m.t === 'notices')).min, '0.10.0');
  await sNew.none((m) => m.t === 'update');
  // no v at all counts as old; new connections below the minimum are refused
  const noV = await connectV(u, null);
  assert.equal((await noV.closed).code, 4011);
  const again = await connectV(u, '0.9.99');
  assert.equal((await again.closed).code, 4011);
  assert.equal((await reg.call('/v1/notices')).body.min, '0.10.0');
  const ok2 = await connectV(u, '0.10.1');
  assert.equal(ok2.ready.notices.min, '0.10.0');
  await ok(owner, { a: 'min.set', v: null });
  assert.equal((await reg.call('/v1/notices')).body.min, null);
  const free = await connectV(n, null);
  assert.equal(free.ready.mode, 'normal');
  for (const s of [sNew, ok2, free]) s.close();
});

test('minimum version: never above the caller’s live app; the owner is never shut out by it', async () => {
  const up = await user('upd');
  await ok(owner, { a: 'admin.grant', uid: up.uid, perms: ['update'] });
  const live = await connectV(up, '0.10.0');
  assert.equal((await adm(up, { a: 'min.set', v: '99.0.0', app: '99.0.0' })).status, 400, 'its live socket says 0.10.0');
  await ok(up, { a: 'min.set', v: '0.10.0', app: '0.10.0' });
  // The owner's own app is older than the minimum: still connected, so it can clear it.
  const o = await connectV(owner, '0.9.0');
  assert.equal(o.ready?.mode, 'normal');
  await ok(owner, { a: 'min.set', v: null });
  await ok(owner, { a: 'admin.revoke', uid: up.uid });
  for (const s of [live, o]) s.close();
});

test('names: reserve, refuse claims and renames of it, free, force rename (no 7-day rule), account frame', async () => {
  await ok(owner, { a: 'name.reserve', name: 'Zelda', note: 'for a friend' });
  assert.equal((await adm(owner, { a: 'name.reserve', name: 'zelda' })).body.error, 'taken');
  const list = await ok(owner, { a: 'name.reserved' });
  assert.deepEqual(list.reserved.map((r) => [r.name, r.note, r.by]), [['zelda', 'for a friend', 'a']]);
  assert.deepEqual((await reg.call('/v1/check?name=zelda')).body, { ok: false, error: 'reserved' });
  const k = makeKeys();
  const t = await reg.authId(k, nextId++);
  assert.equal((await reg.claim(k, t.body.ticket, 'zelda')).body.error, 'reserved');
  assert.equal((await reg.claim(k, t.body.ticket, 'ze1da')).body.error, 'reserved', 'look-alike skeleton refused');
  const u = await user('zed');
  assert.equal((await reg.rename(u, 'zelda')).body.error, 'reserved');
  // an admin may give the reserved name to someone
  const s = await reg.connect(u.uid, u.k);
  const r = await ok(owner, { a: 'name.rename', uid: u.uid, name: 'Zelda' });
  assert.equal(r.username, 'zelda');
  assert.deepEqual(await s.next((m) => m.t === 'account'), { t: 'account', username: 'zelda' });
  assert.deepEqual((await ok(owner, { a: 'name.reserved' })).reserved, [], 'handing it out ends the reservation');
  // a second forced rename right away (no 7-day rule)
  await ok(owner, { a: 'name.rename', uid: u.uid, name: 'zed2' });
  assert.equal((await s.next((m) => m.t === 'account')).username, 'zed2');
  assert.equal((await adm(owner, { a: 'name.rename', uid: owner.uid, name: 'notowner' })).body.error, 'forbidden');
  assert.equal((await adm(owner, { a: 'name.rename', uid: u.uid, name: 'a' })).body.error, 'owner_only');
  const other = await user('takenname');
  assert.equal((await adm(owner, { a: 'name.rename', uid: u.uid, name: 'takenname' })).body.error, 'taken');
  // free a held name: the holder becomes u<uid8> and may pick a new name at once
  const fr = await ok(owner, { a: 'name.free', name: 'takenname' });
  assert.equal(fr.username, `u${other.uid.slice(0, 8)}`);
  assert.equal((await reg.lookup(u, { uid: other.uid })).body.username, fr.username);
  const rn = await reg.rename(other, 'picked.new');
  assert.equal(rn.status, 200, JSON.stringify(rn.body));
  // free a reserved name
  await ok(owner, { a: 'name.reserve', name: 'kept' });
  assert.equal((await ok(owner, { a: 'name.free', name: 'kept' })).freed, 'reserved');
  assert.equal((await adm(owner, { a: 'name.unreserve', name: 'kept' })).body.error, 'not_found');
  assert.equal((await adm(owner, { a: 'name.free', name: 'a' })).body.error, 'forbidden', 'the owner name cannot be freed');
  // the owner is exempt from reservations
  await ok(owner, { a: 'name.reserve', name: 'ownerpick' });
  s.close();
});

test('audit: actions recorded newest first with who did them; reads are not recorded; stats right needed', async () => {
  const u = await user('audited');
  await ok(owner, { a: 'ban', uid: u.uid, reason: 'audit me', until: null });
  await ok(owner, { a: 'unban', uid: u.uid });
  await ok(owner, { a: 'stats' });
  const a = await ok(owner, { a: 'audit' });
  assert.equal(a.audit[0].a, 'unban');
  assert.equal(a.audit[0].target, u.uid);
  assert.equal(a.audit[0].byName, 'a');
  assert.equal(a.audit[1].a, 'ban');
  assert.equal(a.audit[1].detail.reason, 'audit me');
  assert.ok(!a.audit.some((r) => r.a === 'stats' || r.a === 'audit'), 'reads are not audited');
  const older = await ok(owner, { a: 'audit', before: a.audit[0].id });
  assert.equal(older.audit[0].id, a.audit[1].id);
  const banOnly = await user('banonly');
  await ok(owner, { a: 'admin.grant', uid: banOnly.uid, perms: ['ban'] });
  assert.equal((await adm(banOnly, { a: 'audit' })).body.error, 'forbidden');
  // nothing in the audit or the admin tables holds a GitHub id
  for (const t of ['admins', 'bans', 'reserved', 'announcements', 'settings', 'audit']) {
    assert.ok(!JSON.stringify(reg.runtime.sql(`SELECT * FROM ${t}`)).includes(String(OWNER_ID)), t);
  }
});

test('the admin daily budget applies (me is free)', async () => {
  const r2 = await start({ env: { TEST_LIMITS: { adminDay: [3, DAY] } } });
  try {
    const o = await r2.signUp(OWNER_ID, 'a');
    const call = async (payload) => {
      const ts = r2.ts();
      const p = JSON.stringify(payload);
      return r2.call('/v1/admin', { uid: o.uid, ts, p, sig: o.k.sign(`snug-reg-v1\nadmin\n${o.uid}\n${ts}\n${p}`) });
    };
    for (let i = 0; i < 3; i++) assert.equal((await call({ a: 'stats' })).status, 200);
    assert.equal((await call({ a: 'stats' })).status, 429);
    assert.equal((await call({ a: 'me' })).status, 200, 'me is free');
  } finally {
    await r2.close();
  }
});
