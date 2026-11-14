import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { start, makeKeys, verify, OWNER_ID, DAY, HOUR } from './helpers.js';
import { startMockGithub } from '../mock-github.js';
import { ipPrefix } from '../src/hub.js';

let reg;
before(async () => {
  reg = await start();
});
after(() => reg.close());

test('health is answered by the Worker without a DO request', async () => {
  const before = reg.runtime.stats.doRequests;
  const r = await reg.call('/v1/health');
  assert.deepEqual(r.body, { ok: true, v: 2 });
  assert.equal(reg.runtime.stats.doRequests, before);
  assert.equal((await reg.call('/v1/nope')).status, 404);
  assert.equal((await reg.call('/v1/claim')).status, 405);
});

test('bodies over 16 KB are refused by the Worker', async () => {
  const before = reg.runtime.stats.doRequests;
  const r = await reg.call('/v1/claim', { pad: 'x'.repeat(17 * 1024) });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'bad_request');
  assert.equal(reg.runtime.stats.doRequests, before);
});

test('auth for a new user gives an opaque ticket; claim creates the account', async () => {
  const k = makeKeys();
  const a = await reg.authId(k, 1001);
  assert.equal(a.status, 200);
  assert.equal(a.body.status, 'new');
  assert.equal(a.body.owner, false);
  assert.match(a.body.ticket, /^[A-Za-z0-9_-]{43}$/);
  const ghh = createHmac('sha256', reg.env.GH_HMAC_SECRET).update('gh:1001').digest('hex');
  assert.ok(!a.body.ticket.includes(ghh.slice(0, 16)));
  const c = await reg.claim(k, a.body.ticket, 'Alice');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.account.username, 'alice');
  assert.match(c.body.account.uid, /^[a-z2-7]{16}$/);
  assert.equal(c.body.account.kver, 1);
  assert.equal(c.body.account.renamedAt, null);
  assert.equal(c.body.account.renameAt, 0);
  // the ticket was single use
  const again = await reg.claim(k, a.body.ticket, 'alice2');
  assert.equal(again.body.error, 'bad_ticket');
  // same GitHub id + same key -> ok; a second claim -> already_claimed (one name per GitHub account)
  const a2 = await reg.authId(k, 1001);
  assert.equal(a2.body.status, 'ok');
  assert.equal(a2.body.account.uid, c.body.account.uid);
  const c2 = await reg.claim(k, a2.body.ticket, 'alice_two');
  assert.equal(c2.status, 409);
  assert.equal(c2.body.error, 'already_claimed');
});

test('names are unique case-insensitively and by look-alike skeleton; a failed claim keeps the ticket', async () => {
  await reg.signUp(1101, 'bob');
  const k = makeKeys();
  const a = await reg.authId(k, 1102);
  for (const name of ['Bob', 'BOB', 'b0b', 'b.o.b']) {
    const r = await reg.claim(k, a.body.ticket, name);
    assert.equal(r.status, 409, name);
    assert.equal(r.body.error, 'taken', name);
  }
  await reg.signUp(1103, 'bob.x');
  assert.equal((await reg.claim(k, a.body.ticket, 'bob_x')).body.error, 'taken');
  for (const [name, code] of [['bob_', 'invalid_name'], ['b', 'invalid_name'], ['x'.repeat(33), 'invalid_name'], ['bob x', 'invalid_name'],
    ['bób', 'invalid_name'], ['admin', 'reserved'], ['snug.help', 'reserved'], ['1', 'owner_only'], ['a', 'owner_only']]) {
    const r = await reg.claim(k, a.body.ticket, name);
    assert.equal(r.body.error, code, name);
  }
  const ok = await reg.claim(k, a.body.ticket, 'Carol');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.username, 'carol');
});

test('check endpoint mirrors the rules and uniqueness', async () => {
  await reg.signUp(1201, 'dave');
  const q = async (n) => (await reg.call(`/v1/check?name=${encodeURIComponent(n)}`)).body;
  assert.deepEqual(await q('dave'), { ok: false, error: 'taken' });
  assert.deepEqual(await q('DAVE'), { ok: false, error: 'taken' });
  assert.deepEqual(await q('d.ave'), { ok: false, error: 'taken' });
  assert.deepEqual(await q('support'), { ok: false, error: 'reserved' });
  assert.deepEqual(await q('a'), { ok: false, error: 'owner_only' });
  assert.deepEqual(await q('x'), { ok: false, error: 'invalid_name' });
  assert.deepEqual(await q('free.name'), { ok: true });
});

test('owner names: only OWNER_GITHUB_IDS may claim "1" and "a"', async () => {
  const k = makeKeys();
  const a = await reg.authId(k, OWNER_ID);
  assert.equal(a.body.owner, true);
  const c = await reg.claim(k, a.body.ticket, 'A');
  assert.equal(c.status, 200);
  assert.equal(c.body.account.username, 'a');
  // the owner may rename to the other owner name
  const owner = { uid: c.body.account.uid, k };
  const r = await reg.rename(owner, '1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.username, '1');
  // check tells a held owner name (taken) from a free one (owner_only), so the owner's PC can see its account is gone
  assert.equal((await reg.call('/v1/check?name=1')).body.error, 'taken');
  assert.equal((await reg.call('/v1/check?name=a')).body.error, 'owner_only');
  // nobody else, even after "a" was freed by the rename
  const k2 = makeKeys();
  const a2 = await reg.authId(k2, 1301);
  assert.equal(a2.body.owner, false);
  assert.equal((await reg.claim(k2, a2.body.ticket, 'a')).body.error, 'owner_only');
  assert.equal((await reg.claim(k2, a2.body.ticket, '1')).body.error, 'owner_only');
});

test('rename: frees the old name at once, then at most once per 7 days', async () => {
  const u = await reg.signUp(1401, 'erin');
  const r1 = await reg.rename(u, 'Erin.B'); // the first claim does not count as a rename
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.account.username, 'erin.b');
  assert.ok(r1.body.account.renameAt > reg.clock.now());
  // old name claimable by someone else immediately
  const other = await reg.signUp(1402, 'erin');
  assert.equal(other.account.username, 'erin');
  // same name again is a no-op, not a rename
  assert.equal((await reg.rename(u, 'erin.b')).status, 200);
  const r2 = await reg.rename(u, 'erin.c');
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, 'rename_too_soon');
  assert.equal(r2.body.retryAt, r1.body.account.renamedAt + 7 * DAY);
  await reg.clock.advance(7 * DAY - 60_000);
  assert.equal((await reg.rename(u, 'erin.c')).body.error, 'rename_too_soon');
  await reg.clock.advance(61_000);
  const r3 = await reg.rename(u, 'erin.c');
  assert.equal(r3.status, 200);
  assert.equal(r3.body.account.username, 'erin.c');
  // rename to a taken / reserved / invalid name
  await reg.clock.advance(7 * DAY + 1000);
  assert.equal((await reg.rename(u, 'Erin')).body.error, 'taken');
  assert.equal((await reg.rename(u, 'staff')).body.error, 'reserved');
  assert.equal((await reg.rename(u, 'e')).body.error, 'invalid_name');
  assert.equal((await reg.rename(u, 'a')).body.error, 'owner_only');
});

test('signed calls: bad signature, stale ts, ts replay', async () => {
  const u = await reg.signUp(1501, 'frank');
  const ts = reg.ts();
  const bad = await reg.call('/v1/rename', { uid: u.uid, username: 'frank2', ts, sig: makeKeys().sign(`snug-reg-v1\nrename\n${u.uid}\nfrank2\n${ts}`) });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'bad_signature');
  const old = reg.clock.now() - 6 * 60_000;
  const stale = await reg.call('/v1/rename', { uid: u.uid, username: 'frank2', ts: old, sig: u.k.sign(`snug-reg-v1\nrename\n${u.uid}\nfrank2\n${old}`) });
  assert.equal(stale.body.error, 'stale');
  assert.ok(Math.abs(stale.body.now - reg.clock.now()) < 5000);
  const ts2 = reg.ts();
  const body = { uid: u.uid, username: 'frank', ts: ts2, sig: u.k.sign(`snug-reg-v1\nrename\n${u.uid}\nfrank\n${ts2}`) };
  assert.equal((await reg.call('/v1/rename', body)).status, 200);
  assert.equal((await reg.call('/v1/rename', body)).body.error, 'stale'); // replay of the same ts
  // malformed fields are refused before any signature work
  assert.equal((await reg.call('/v1/rename', { ...body, uid: 'NOT-A-UID' })).body.error, 'bad_request');
  assert.equal((await reg.call('/v1/rename', { ...body, sig: 'abc' })).body.error, 'bad_request');
  assert.equal((await reg.call('/v1/rename', { ...body, username: 'frank\nx' })).body.error, 'invalid_name');
  assert.equal((await reg.call('/v1/rename', '[1]')).body.error, 'bad_request');
});

test('lookup: needs a signature, returns exactly the public fields, no GitHub data', async () => {
  const g = await reg.signUp(987654321, 'gina');
  const h = await reg.signUp(1601, 'hank');
  const r = await reg.lookup(h, { name: 'GINA' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ['chain', 'ik', 'kver', 'uid', 'username', 'xk']);
  assert.equal(r.body.uid, g.uid);
  assert.equal(r.body.ik, g.k.ik);
  assert.equal(r.body.xk, g.k.xk);
  assert.deepEqual(r.body.chain, [{ kver: 1, ik: g.k.ik, xk: g.k.xk, prev: null }]);
  assert.deepEqual((await reg.lookup(h, { uid: g.uid })).body, r.body);
  assert.equal((await reg.lookup(h, { name: 'nobody.here' })).status, 404);
  assert.equal((await reg.lookup(h, { name: 'bad name' })).status, 404);
  const ts = reg.ts();
  const forged = await reg.call('/v1/lookup', { uid: h.uid, ts, q: { name: 'gina' }, sig: makeKeys().sign(`snug-reg-v1\nlookup\n${h.uid}\n${ts}\ngina`) });
  assert.equal(forged.body.error, 'bad_signature');
  const anon = await reg.call('/v1/lookup', { q: { name: 'gina' } });
  assert.equal(anon.body.error, 'bad_request');
  // nothing stored holds the numeric GitHub id or a login
  for (const t of ['accounts', 'ghh_meta', 'keys', 'pending_rebind', 'tickets', 'watch', 'knocks', 'budget']) {
    const dump = JSON.stringify(reg.runtime.sql(`SELECT * FROM ${t}`));
    assert.ok(!dump.includes('987654321'), t);
    assert.ok(!dump.includes('hidden'), t);
  }
});

test('lookup daily budget per uid', async () => {
  const r2 = await start({ env: { TEST_LIMITS: { lookupDay: [3, DAY] } } });
  try {
    const u = await r2.signUp(1, 'ivan');
    for (let i = 0; i < 3; i++) assert.equal((await r2.lookup(u, { name: 'ivan' })).status, 200);
    const r = await r2.lookup(u, { name: 'ivan' });
    assert.equal(r.status, 429);
    assert.ok(r.body.retryAfter > 0);
  } finally {
    await r2.close();
  }
});

test('release: needs the device signature and a fresh GitHub ticket; re-claim within 7 days is refused', async () => {
  const u = await reg.signUp(1701, 'jane');
  const fresh = (await reg.authId(u.k, 1701)).body.ticket;
  const otherTicket = (await reg.authId(makeKeys(), 1702)).body.ticket;
  const rel = (k, ticket) => reg.signed('/v1/release', k, { uid: u.uid, ticket }, (ts) => ['release', u.uid, ticket, ts]);
  assert.equal((await rel(u.k, otherTicket)).body.error, 'bad_ticket');
  assert.equal((await rel(makeKeys(), fresh)).body.error, 'bad_signature');
  const ok = await rel(u.k, fresh);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // the name is free at once
  const taker = await reg.signUp(1703, 'jane');
  assert.equal(taker.account.username, 'jane');
  // the same GitHub account is "new" again but cannot claim for 7 days
  const k = makeKeys();
  const a = await reg.authId(k, 1701);
  assert.equal(a.body.status, 'new');
  const c = await reg.claim(k, a.body.ticket, 'jane2');
  assert.equal(c.body.error, 'rename_too_soon');
  assert.ok(c.body.retryAt > reg.clock.now());
});

test('GitHub: other app tokens, malformed tokens, revocation, headers', async () => {
  const k = makeKeys();
  const foreign = reg.github.issueToken({ id: 1801, clientId: 'Iv1.someone-else' });
  assert.equal((await reg.auth(k, foreign)).body.error, 'github_invalid');
  const n = reg.github.calls.length;
  const junk = await reg.auth(k, 'not-a-token');
  assert.equal(junk.status, 400);
  assert.equal(reg.github.calls.length, n, 'no GitHub call for a malformed token');
  const token = reg.github.issueToken({ id: 1802 });
  assert.equal((await reg.auth(k, token)).body.status, 'new');
  const mine = reg.github.calls.filter((c) => c.token === token);
  assert.deepEqual(mine.map((c) => c.method), ['POST', 'DELETE'], 'checked then revoked');
  assert.equal((await reg.auth(k, token)).body.error, 'github_invalid', 'revoked token cannot be reused');
  for (const c of reg.github.calls) {
    assert.equal(c.ua, 'snug-registry');
    assert.equal(c.apiVersion, '2022-11-28');
  }
});

test('GitHub unreachable gives github_unavailable', async () => {
  const r2 = await start({ env: { GITHUB_API: 'http://127.0.0.1:9' } });
  try {
    assert.equal((await r2.auth(makeKeys(), 'gho_' + 'x'.repeat(36))).body.error, 'github_unavailable');
  } finally {
    await r2.close();
  }
});

test('config: unchecked mode only against a local GitHub; empty client secret fails closed', async () => {
  const gh = await startMockGithub();
  const token = 'gho_' + 'y'.repeat(36);
  try {
    const bad = await start({ githubMock: gh, env: { ALLOW_UNCHECKED_TOKENS: '1', GITHUB_API: 'https://api.github.com' } });
    try {
      const r = await bad.auth(makeKeys(), token);
      assert.equal(r.status, 500);
      assert.equal(r.body.error, 'config_error');
    } finally {
      await bad.close();
    }
    const noSecret = await start({ githubMock: gh, env: { GH_CLIENT_SECRET: '' } });
    try {
      assert.equal((await noSecret.auth(makeKeys(), token)).body.error, 'config_error');
    } finally {
      await noSecret.close();
    }
    const dev = await start({ githubMock: gh, env: { ALLOW_UNCHECKED_TOKENS: '1', GH_CLIENT_SECRET: '' } });
    try {
      const r = await dev.auth(makeKeys(), gh.issueToken({ id: 77 }));
      assert.equal(r.body.status, 'new');
      assert.equal(gh.calls.at(-1).path, '/user');
    } finally {
      await dev.close();
    }
  } finally {
    await gh.close();
  }
});

test('ip prefixes: IPv4 /32, IPv6 /64', () => {
  assert.equal(ipPrefix('203.0.113.7'), '203.0.113.7');
  assert.equal(ipPrefix('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipPrefix('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(ipPrefix('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(ipPrefix('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipPrefix('::1'), '0:0:0:0::/64');
});

test('rate limits: per IP (IPv6 by /64) and the global auth cap', async () => {
  const r2 = await start({ limits: { ...{}, authGlobal: [2, HOUR] }, trustClientIp: true });
  try {
    // check: 30/min per IP (production value)
    for (let i = 0; i < 30; i++) assert.equal((await r2.call('/v1/check?name=zed', undefined, { ip: '2001:db8:aa:1::1' })).status, 200);
    const limited = await r2.call('/v1/check?name=zed', undefined, { ip: '2001:db8:aa:1:ffff::2' }); // same /64
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
    assert.ok(limited.body.retryAfter > 0 && limited.body.retryAfter <= 60);
    assert.equal((await r2.call('/v1/check?name=zed', undefined, { ip: '2001:db8:aa:2::1' })).status, 200); // other /64
    assert.equal((await r2.call('/v1/check?name=zed', undefined, { ip: '198.51.100.1' })).status, 200);
    // global auth cap: 2/h across all IPs
    assert.equal((await r2.authId(makeKeys(), 1, { ip: '198.51.100.10' })).status, 200);
    assert.equal((await r2.authId(makeKeys(), 2, { ip: '198.51.100.11' })).status, 200);
    const g = await r2.authId(makeKeys(), 3, { ip: '198.51.100.12' });
    assert.equal(g.status, 429);
    // per-IP auth: 10/h
    for (let i = 0; i < 10; i++) await r2.auth(makeKeys(), 'bad', { ip: '192.0.2.50' });
    assert.equal((await r2.auth(makeKeys(), 'bad', { ip: '192.0.2.50' })).status, 429);
  } finally {
    await r2.close();
  }
});

test('the GitHub token never appears in Worker/Hub console output', async () => {
  const out = [];
  const saved = {};
  for (const m of ['log', 'error', 'warn', 'info', 'debug']) {
    saved[m] = console[m];
    console[m] = (...a) => out.push(a.map(String).join(' '));
  }
  const tokens = [];
  try {
    const k = makeKeys();
    for (const id of [1901, 1902]) {
      const t = reg.github.issueToken({ id });
      tokens.push(t);
      await reg.auth(k, t);
    }
    const t3 = reg.github.issueToken({ id: 1903, clientId: 'other' });
    tokens.push(t3);
    await reg.auth(k, t3);
    const broken = `{"token":"${tokens[0]}",`; // malformed JSON containing a token
    await fetch(`${reg.url}/v1/auth/github`, { method: 'POST', body: broken, headers: { 'content-type': 'application/json' } });
  } finally {
    Object.assign(console, saved);
  }
  const all = out.join('\n');
  for (const t of tokens) assert.ok(!all.includes(t));
});

test('TURN: 404 when not configured; per-call credentials when configured', async () => {
  const a = await reg.signUp(2001, 'kim');
  const b = await reg.signUp(2002, 'lee');
  const turn = (r, u, peer) => r.signed('/v1/turn', u.k, { uid: u.uid, peer }, (ts) => ['turn', u.uid, peer, ts]);
  assert.equal((await turn(reg, a, b.uid)).status, 404);
  const r2 = await start({ env: { TURN_KEY_ID: 'key1', TURN_KEY_TOKEN: 'turn-token', TEST_LIMITS: { turnDay: [2, DAY] } } });
  try {
    r2.runtime.env.TURN_API = `${r2.github.url}/turn`;
    const x = await r2.signUp(1, 'mia');
    const y = await r2.signUp(2, 'ned');
    const ok = await turn(r2, x, y.uid);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Array.isArray(ok.body.iceServers));
    // Same shape as Cloudflare's live answer (checked 2026-11-14); the registry adds TLS on 443.
    assert.ok(ok.body.iceServers[0].urls.includes('turns:turn.cloudflare.com:443?transport=tcp'));
    assert.ok(ok.body.ttl <= 7200);
    assert.equal((await turn(r2, x, 'aaaaaaaaaaaaaaaa')).status, 404);
    assert.equal((await turn(r2, x, y.uid)).status, 200);
    assert.equal((await turn(r2, x, y.uid)).status, 429);
  } finally {
    await r2.close();
  }
});

test('stored account rows verify against the claimed key', async () => {
  const u = await reg.signUp(2101, 'olga');
  const row = reg.runtime.sql('SELECT * FROM accounts WHERE uid=?', u.uid)[0];
  assert.equal(row.ik, u.k.ik);
  const sig = u.k.sign('x');
  assert.ok(verify(row.ik, sig, 'x'));
});
