// Passkeys for password accounts (v0.12, server/webauthn.js and server/passkeys.js), with a software
// authenticator (tests/helpers/authenticator.js) in place of a browser. Requests carry their own Host
// header, so the same server is reached as http://localhost:<port> (passkeys work) and as
// http://127.0.0.1:<port> (they can't: an IP address is never an RP ID).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { startServer } from '../server/index.js';
import { cborDecode, parseAuthData, coseToJwk, passkeyPlace, verifyRegistration, verifyAuthentication, WebAuthnError } from '../server/webauthn.js';
import { makeAuthenticator, cbor } from './helpers/authenticator.js';
import { totpAt, unbase32 } from '../server/account.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-passkeys-'));
let srv, port, LH, ORIGIN;
const logs = [];
const realLog = console.log;
test.before(async () => {
  console.log = (...a) => logs.push(a.join(' '));
  srv = await startServer({ port: 0, dataDir: dir, quiet: false });
  port = srv.port;
  LH = `localhost:${port}`;
  ORIGIN = `http://${LH}`;
});
test.beforeEach(() => srv.resetLimits());
test.after(async () => { console.log = realLog; await srv.close(); rmSync(dir, { recursive: true, force: true }); });

// One request with an exact Host header (fetch can't set it).
function call(method, path, body, { host = LH, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = request({
      host: '127.0.0.1', port, method, path,
      headers: { host, origin: origin ?? `http://${host}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(cookie ? { cookie } : {}) },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: j, cookie: [res.headers['set-cookie'] || []].flat().map((c) => c.split(';')[0]).find((c) => c.startsWith('snug_session=')) }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const PW = 'a long passkey password';
async function register(handle) {
  const r = await call('POST', '/api/register', { handle, name: handle, password: PW });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.user.id, cookie: r.cookie };
}
async function addPasskey(who, a = makeAuthenticator(), extra = {}) {
  const b = await call('POST', '/api/passkeys/begin', { password: PW, ...extra }, { cookie: who.cookie });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const f = await call('POST', '/api/passkeys/finish', { ticket: b.body.ticket, credential: a.create(b.body.options, { origin: ORIGIN }), name: 'Test key' }, { cookie: who.cookie });
  return { a, begin: b, finish: f };
}
async function signInWith(a, opts = {}) {
  const o = await call('POST', '/api/passkey/options', {});
  assert.equal(o.status, 200, JSON.stringify(o.body));
  return call('POST', '/api/passkey/login', { ticket: o.body.ticket, credential: a.get(o.body.options, { origin: ORIGIN, ...opts }) });
}
const code = (e) => { try { e(); } catch (x) { return x instanceof WebAuthnError ? x.code : x.message; } return 'none'; };

// ---------- the verifier on its own ----------
test('webauthn: CBOR refuses trailing bytes, indefinite lengths and duplicate keys', () => {
  assert.deepEqual([...cborDecode(cbor(new Map([[1, 2], ['a', Buffer.from([1])]])))], [[1, 2], ['a', Buffer.from([1])]]);
  assert.equal(code(() => cborDecode(Buffer.concat([cbor(1), Buffer.from([0])]))), 'cbor');
  assert.equal(code(() => cborDecode(Buffer.from([0x5f, 0x41, 0x00, 0xff]))), 'cbor');
  assert.equal(code(() => cborDecode(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]))), 'cbor');
  assert.equal(code(() => cborDecode(Buffer.from([0x59, 0xff, 0xff]))), 'cbor', 'a length past the end');
});

test('webauthn: COSE keys become JWKs only for Ed25519, P-256 and RSA of 2048 bits or more', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const m = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(ec.x, 'base64url')], [-3, Buffer.from(ec.y, 'base64url')]]);
  assert.equal(coseToJwk(m).alg, -7);
  const off = new Map(m); off.set(-3, Buffer.alloc(32, 7)); // not on the curve
  assert.equal(code(() => coseToJwk(off)), 'key');
  assert.equal(code(() => coseToJwk(new Map([[1, 2], [3, -35]]))), 'alg', 'ES384 is not offered');
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  assert.equal(code(() => coseToJwk(new Map([[1, 3], [3, -257], [-1, Buffer.from(small.n, 'base64url')], [-2, Buffer.from(small.e, 'base64url')]]))), 'key');
});

test('webauthn: registration checks the challenge, origin, RP ID, presence, verification and cross-origin frames', () => {
  const a = makeAuthenticator();
  const options = { challenge: 'Y2hhbGxlbmdl', rp: { id: 'example.org' }, user: { id: 'aGFuZGxl' } };
  const ok = { challenge: options.challenge, origins: ['https://example.org'], rpId: 'example.org' };
  const cred = a.create(options, { origin: 'https://example.org' });
  const v = verifyRegistration({ credential: cred, ...ok });
  assert.equal(v.id, a.id);
  assert.equal(v.alg, -7);
  assert.equal(parseAuthData(cborDecode(Buffer.from(cred.response.attestationObject, 'base64url')).get('authData')).flags.uv, true);
  assert.equal(code(() => verifyRegistration({ credential: cred, ...ok, challenge: 'b3RoZXI' })), 'challenge');
  assert.equal(code(() => verifyRegistration({ credential: a.create(options, { origin: 'https://evil.example' }), ...ok })), 'origin');
  assert.equal(code(() => verifyRegistration({ credential: a.create(options, { origin: 'https://example.org', rpId: 'evil.example' }), ...ok })), 'rpid');
  assert.equal(code(() => verifyRegistration({ credential: a.create(options, { origin: 'https://example.org', clientExtra: { crossOrigin: true } }), ...ok })), 'origin');
  assert.equal(code(() => verifyRegistration({ credential: makeAuthenticator({ uv: false }).create(options, { origin: 'https://example.org' }), ...ok })), 'verification');
  assert.equal(code(() => verifyRegistration({ credential: makeAuthenticator({ up: false }).create(options, { origin: 'https://example.org' }), ...ok })), 'presence');
  assert.equal(code(() => verifyRegistration({ credential: { ...cred, id: makeAuthenticator().id, rawId: undefined }, ...ok })), 'format', 'the id must be the one in the authenticator data');
});

test('webauthn: sign-in checks the signature with the saved key, and a counter that goes backwards is refused', () => {
  const a = makeAuthenticator({ kind: 'ed25519' });
  const reg = verifyRegistration({ credential: a.create({ challenge: 'cmVn', rp: { id: 'localhost' }, user: { id: 'dQ' } }, { origin: 'http://localhost:1' }), challenge: 'cmVn', origins: ['http://localhost:1'], rpId: 'localhost' });
  const saved = { id: reg.id, jwk: reg.jwk, alg: reg.alg, counter: reg.counter };
  const get = (o) => a.get({ challenge: 'c2lnbg', rpId: 'localhost' }, { origin: 'http://localhost:1', ...o });
  const check = (cred, passkey = saved) => verifyAuthentication({ credential: cred, challenge: 'c2lnbg', origins: ['http://localhost:1'], rpId: 'localhost', passkey });
  assert.equal(check(get({ counter: 5 })).counter, 5);
  assert.equal(code(() => check(get({ counter: 5 }), { ...saved, counter: 5 })), 'counter');
  assert.equal(code(() => check(get({ counter: 3 }), { ...saved, counter: 5 })), 'counter');
  const forged = get({ counter: 9 });
  forged.response.signature = makeAuthenticator({ kind: 'ed25519' }).get({ challenge: 'c2lnbg', rpId: 'localhost' }, { origin: 'http://localhost:1' }).response.signature;
  assert.equal(code(() => check(forged)), 'signature');
  // A synced passkey always says 0: allowed every time.
  const s = makeAuthenticator({ synced: true });
  const sreg = verifyRegistration({ credential: s.create({ challenge: 'cmVn', rp: { id: 'localhost' }, user: { id: 'dQ' } }, { origin: 'http://localhost:1' }), challenge: 'cmVn', origins: ['http://localhost:1'], rpId: 'localhost' });
  assert.equal(sreg.backedUp, true);
  const sp = { id: sreg.id, jwk: sreg.jwk, alg: sreg.alg, counter: 0 };
  for (let i = 0; i < 2; i++) assert.equal(verifyAuthentication({ credential: s.get({ challenge: 'c2lnbg', rpId: 'localhost' }, { origin: 'http://localhost:1' }), challenge: 'c2lnbg', origins: ['http://localhost:1'], rpId: 'localhost', passkey: sp }).counter, 0);
});

test('webauthn: where passkeys work; the Host header alone never chooses the RP ID', () => {
  const p = (o) => passkeyPlace(o);
  assert.deepEqual(p({ host: 'snug.example.org', https: true, hosts: ['snug.example.org'] }), { ok: true, rpId: 'snug.example.org', origins: ['https://snug.example.org'] });
  assert.equal(p({ host: 'chat.example.org', https: true, hosts: ['snug.example.org', 'chat.example.org'], rpId: 'example.org' }).rpId, 'example.org');
  assert.equal(p({ host: 'chat.example.org', https: true, hosts: ['snug.example.org', 'chat.example.org'] }).why, 'setup', 'several names and no SNUG_RP_ID');
  assert.equal(p({ host: 'snug.example.org', https: false, hosts: ['snug.example.org'] }).why, 'insecure', 'plain http on a public name');
  assert.equal(p({ host: '192.168.1.20:8787', https: false, loopback: false }).why, 'insecure', 'LAN address');
  assert.equal(p({ host: '127.0.0.1:8787', loopback: true }).why, 'insecure', 'loopback by IP');
  assert.equal(p({ host: 'localhost:8787', loopback: true }).rpId, 'localhost');
  assert.equal(p({ host: 'localhost:8787', loopback: false }).why, 'setup', 'localhost on a public bind proves nothing');
  assert.equal(p({ host: 'evil.example', https: true }).why, 'setup', 'no configured name: the Host header is not believed');
  assert.equal(p({ host: 'evil.example', https: true, rpId: 'example.org' }).why, 'setup', 'a host outside the RP ID');
  assert.equal(p({ host: 'localhost:1', loopback: true, desktop: true }).why, 'desktop');
  assert.match(p({ host: '10.0.0.2' }).message, /HTTPS with a domain name/);
});

// ---------- the server ----------
test('passkeys: add one in Settings (password needed), sign out, sign in with it, no password and no code', async () => {
  const ana = await register('pk-ana');
  assert.equal((await call('POST', '/api/passkeys/begin', { password: 'wrong password' }, { cookie: ana.cookie })).status, 401);
  const { a, begin, finish } = await addPasskey(ana);
  assert.equal(begin.body.options.rp.id, 'localhost');
  assert.equal(begin.body.options.authenticatorSelection.userVerification, 'required');
  assert.notEqual(begin.body.options.user.id, ana.id, 'the WebAuthn user id is random, never the account id');
  assert.equal(finish.status, 201, JSON.stringify(finish.body));
  assert.equal(finish.body.passkey.name, 'Test key');
  const list = await call('GET', '/api/passkeys', null, { cookie: ana.cookie });
  assert.equal(list.body.ok, true);
  assert.equal(list.body.list.length, 1);
  const out = await signInWith(a);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.user.id, ana.id);
  assert.ok(out.cookie, 'a session cookie');
  assert.equal((await call('GET', '/api/me', null, { cookie: out.cookie })).body.user.id, ana.id);
  assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'login' AND why = 'passkey' AND ok = 1", ana.id), 'audited');
  assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'passkey.add'", ana.id));
});

test('passkeys: a challenge works once; a wrong origin, a missing PIN check or an unknown passkey are refused', async () => {
  const bo = await register('pk-bo');
  const { a } = await addPasskey(bo);
  const o = await call('POST', '/api/passkey/options', {});
  const cred = a.get(o.body.options, { origin: ORIGIN });
  assert.equal((await call('POST', '/api/passkey/login', { ticket: o.body.ticket, credential: cred })).status, 200);
  assert.equal((await call('POST', '/api/passkey/login', { ticket: o.body.ticket, credential: a.get(o.body.options, { origin: ORIGIN }) })).status, 401, 'replayed challenge');
  const o2 = await call('POST', '/api/passkey/options', {});
  const bad = await call('POST', '/api/passkey/login', { ticket: o2.body.ticket, credential: a.get(o2.body.options, { origin: 'http://localhost:1' }) });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /different address/);
  a.uv = false;
  const o3 = await call('POST', '/api/passkey/options', {});
  assert.match((await call('POST', '/api/passkey/login', { ticket: o3.body.ticket, credential: a.get(o3.body.options, { origin: ORIGIN }) })).body.error, /PIN, fingerprint or face/);
  a.uv = true;
  const stranger = makeAuthenticator();
  stranger.userHandle = 'eA';
  const o4 = await call('POST', '/api/passkey/options', {});
  const r4 = await call('POST', '/api/passkey/login', { ticket: o4.body.ticket, credential: stranger.get(o4.body.options, { origin: ORIGIN }) });
  assert.equal(r4.status, 401);
  assert.match(r4.body.error, /isn’t set up/);
});

test('passkeys: a counter that goes backwards (a copied authenticator) is refused and audited', async () => {
  const cy = await register('pk-cy');
  const { a } = await addPasskey(cy);
  assert.equal((await signInWith(a, { counter: 7 })).status, 200);
  const r = await signInWith(a, { counter: 4 });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /looks copied/);
  assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'passkey.clone' AND ok = 0", cy.id));
  assert.equal((await signInWith(a, { counter: 8 })).status, 200);
});

test('passkeys: removing one needs the password; a removed passkey no longer signs in; rename works', async () => {
  const di = await register('pk-di');
  const { a } = await addPasskey(di);
  const id = (await call('GET', '/api/passkeys', null, { cookie: di.cookie })).body.list[0].id;
  assert.equal((await call('POST', '/api/passkeys/rename', { id, name: 'Work laptop' }, { cookie: di.cookie })).body.list[0].name, 'Work laptop');
  assert.equal((await call('POST', '/api/passkeys/remove', { id, password: 'nope nope nope' }, { cookie: di.cookie })).status, 401);
  assert.equal((await call('POST', '/api/passkeys/remove', { id, password: PW }, { cookie: di.cookie })).status, 200);
  assert.equal((await signInWith(a)).status, 401);
  assert.ok(srv.db.get("SELECT 1 FROM auth_events WHERE user = ? AND event = 'passkey.remove'", di.id));
});

test('passkeys: with two-factor on, adding needs the code too; signing in with the passkey does not', async () => {
  const ed = await register('pk-ed');
  // Turn on two-factor with the ops over a socket (as Settings does).
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: ed.cookie, origin: ORIGIN, host: LH } });
  const acks = new Map();
  let seq = 0;
  await new Promise((r) => ws.on('message', (b) => { const m = JSON.parse(b); if (m.t === 'hello') r(); if (m.t === 'ack') acks.get(m.id)?.(m); }));
  const op = (o, d) => new Promise((r) => { const id = ++seq; acks.set(id, r); ws.send(JSON.stringify({ t: 'op', id, op: o, d })); });
  const begun = await op('totp.begin', {});
  const secret = unbase32(begun.d.secret);
  assert.ok((await op('totp.enable', { password: PW, code: totpAt(secret, Date.now()) })).ok);
  ws.close();
  const noCode = await call('POST', '/api/passkeys/begin', { password: PW }, { cookie: ed.cookie });
  assert.equal(noCode.status, 401);
  const { a, finish } = await addPasskey(ed, makeAuthenticator(), { code: totpAt(secret, Date.now() + 30_000) });
  assert.equal(finish.status, 201, JSON.stringify(finish.body));
  const r = await signInWith(a);
  assert.equal(r.status, 200, 'no code asked');
  assert.ok(r.cookie);
});

test('passkeys: reached by IP address, Settings says why and nothing can be added; sign-in options are refused', async () => {
  const fa = await register('pk-fa');
  const host = `127.0.0.1:${port}`;
  const login = await call('POST', '/api/login', { handle: 'pk-fa', password: PW }, { host });
  const cfg = await call('GET', '/api/passkey/config', null, { host });
  assert.equal(cfg.body.ok, false);
  assert.match(cfg.body.message, /HTTPS with a domain name/);
  const list = await call('GET', '/api/passkeys', null, { host, cookie: login.cookie });
  assert.equal(list.body.ok, false);
  assert.equal((await call('POST', '/api/passkeys/begin', { password: PW }, { host, cookie: login.cookie })).status, 400);
  assert.equal((await call('POST', '/api/passkey/options', {}, { host })).status, 400);
  void fa;
});

test('passkeys: a challenge made for localhost can\'t be finished from another origin', async () => {
  const ga = await register('pk-ga');
  const b = await call('POST', '/api/passkeys/begin', { password: PW }, { cookie: ga.cookie });
  const a = makeAuthenticator();
  const f = await call('POST', '/api/passkeys/finish', { ticket: b.body.ticket, credential: a.create(b.body.options, { origin: `http://127.0.0.1:${port}` }) }, { cookie: ga.cookie });
  assert.equal(f.status, 400);
  assert.equal((await call('GET', '/api/passkeys', null, { cookie: ga.cookie })).body.list.length, 0);
});

test('passkeys: deleting the account removes its passkeys; the export lists names, never keys', async () => {
  const ha = await register('pk-ha');
  await addPasskey(ha);
  const exp = await call('GET', '/api/account/export', null, { cookie: ha.cookie });
  assert.equal(exp.body.passkeys.length, 1);
  assert.equal(exp.body.passkeys[0].name, 'Test key');
  assert.ok(!JSON.stringify(exp.body.passkeys).includes('"x"'), 'no key material');
  const del = await call('POST', '/api/account/delete', { password: PW, confirm: 'pk-ha' }, { cookie: ha.cookie });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM passkeys WHERE user = ?', ha.id).n, 0);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM passkey_users WHERE user = ?', ha.id).n, 0);
});

test('passkeys: no log line carries a credential, signature or challenge', () => {
  const all = logs.join('\n');
  assert.ok(!/attestationObject|clientDataJSON|"signature"/.test(all));
});
