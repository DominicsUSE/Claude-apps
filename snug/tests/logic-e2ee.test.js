// End-to-end encryption, the pure parts (js/lib/e2ee, js/lib/sniff.js) and the
// vendored HPKE library. Runs in Node with its WebCrypto, the same API the
// browser uses. Each group matches a part of the e2ee spec, section 23.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b64u, unb64u, b64uOf, utf8, base32, crockford, normCrockford, equal, random, concat } from '../js/lib/e2ee/bytes.js';
import { canon, parseCanon } from '../js/lib/e2ee/canon.js';
import { canon as peerCanon } from '../server/peercrypto.js';
import { suite, sealKey, openKey } from '../js/lib/e2ee/hpke.js';
import * as sig from '../js/lib/e2ee/sig.js';
import * as obj from '../js/lib/e2ee/objects.js';
import * as rules from '../js/lib/e2ee/rules.js';
import * as env from '../js/lib/e2ee/envelope.js';
import { encryptFile, decryptFile } from '../js/lib/e2ee/attach.js';
import { safetyNumber, fingerprintHash, groupsOf5 } from '../js/lib/e2ee/fingerprint.js';
import * as link from '../js/lib/e2ee/link.js';
import * as backup from '../js/lib/e2ee/backup.js';
import { COPY, BANNED } from '../js/lib/e2ee/copy.js';
import { supported } from '../js/lib/e2ee/support.js';
import { newRecoveryKey, parseRecoveryKey, deriveBackupKey, deriveAuthKey } from '../js/lib/recovery.js';
import { sniff as sniffBrowser } from '../js/lib/sniff.js';
import { sniff as sniffServer } from '../server/media.js';
import { rewriteCommon } from '../server/tools/vendor-hpke.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');
const subtle = globalThis.crypto.subtle;

// ---------- vendored HPKE ----------
function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

test('vendored HPKE: every file matches SHA256SUMS and nothing extra is there', () => {
  const dir = join(ROOT, 'vendor', 'hpke');
  const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
  const listed = new Map(sums.map(([h, f]) => [f, h]));
  const files = walk(dir).map((p) => relative(dir, p).split(sep).join('/')).filter((f) => f !== 'SHA256SUMS');
  assert.deepEqual(files.sort(), [...listed.keys()].sort());
  for (const f of files) assert.equal(createHash('sha256').update(readFileSync(join(dir, f))).digest('hex'), listed.get(f), f);
  assert.match(readFileSync(join(dir, 'core', 'LICENSE'), 'utf8'), /MIT License/);
  assert.match(readFileSync(join(dir, 'common', 'LICENSE'), 'utf8'), /MIT License/);
});

test('vendored HPKE: no bare import specifier is left (the browser loads it as is)', () => {
  const dir = join(ROOT, 'vendor', 'hpke');
  for (const p of walk(dir).filter((f) => f.endsWith('.js'))) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (/^\s*(\*|\/\/)/.test(line)) continue; // doc comments
      const m = /^\s*(?:import|export)\b.*?\bfrom\s*"([^"]+)"/.exec(line);
      if (m) assert.match(m[1], /^\.\.?\//, `${relative(dir, p)}: ${m[1]}`);
      // The only dynamic import is the library's Node <= 18 fallback, never reached where globalThis.crypto exists.
      const dyn = /\bimport\("([^"]+)"\)/.exec(line);
      if (dyn) assert.equal(dyn[1], 'crypto', `${relative(dir, p)}: ${dyn[1]}`);
    }
  }
  assert.equal(rewriteCommon('import { a } from "@hpke/common";\n * } from "@hpke/common";', 'src/kems/x.js'),
    'import { a } from "../../../common/mod.js";\n * } from "@hpke/common";');
});

test('HPKE: every RFC 9180 test vector for base mode, X25519, HKDF-SHA256, AES-256-GCM', async () => {
  const fx = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'hpke-x25519-sha256-aes256gcm.json'), 'utf8'));
  assert.match(fx.source, /cfrg\/draft-irtf-cfrg-hpke/);
  assert.ok(fx.vectors.length >= 1);
  for (const v of fx.vectors) {
    assert.deepEqual([v.mode, v.kem_id, v.kdf_id, v.aead_id], [0, 0x20, 1, 2]);
    const kem = suite.kem;
    const skR = await kem.importKey('raw', hex(v.skRm), false);
    const pkR = await kem.importKey('raw', hex(v.pkRm), true);
    const skE = await kem.importKey('raw', hex(v.skEm), false);
    const pkE = await kem.importKey('raw', hex(v.pkEm), true);
    // Key derivation from the vector's ikm gives the same keys.
    const dR = await kem.deriveKeyPair(hex(v.ikmR).buffer);
    assert.equal(toHex(await kem.serializePublicKey(dR.publicKey)), v.pkRm);
    const sender = await suite.createSenderContext({ recipientPublicKey: pkR, info: hex(v.info), ekm: { privateKey: skE, publicKey: pkE } });
    assert.equal(toHex(sender.enc), v.enc);
    const recipient = await suite.createRecipientContext({ recipientKey: { privateKey: skR, publicKey: pkR }, enc: hex(v.enc), info: hex(v.info) });
    for (const e of v.encryptions) {
      assert.equal(toHex(await sender.seal(hex(e.pt), hex(e.aad))), e.ct);
      assert.equal(toHex(await recipient.open(hex(e.ct), hex(e.aad))), e.pt);
    }
    for (const x of v.exports) {
      assert.equal(toHex(await sender.export(hex(x.exporter_context), x.L)), x.exported_value);
      assert.equal(toHex(await recipient.export(hex(x.exporter_context), x.L)), x.exported_value);
    }
  }
});

test('HPKE seal/open: 80-byte wraps, a non-extractable recipient pair works, and any change fails', async () => {
  const pair = await sig.newDhPair(false);
  assert.equal(pair.privateKey.extractable, false);
  const pub = await sig.rawPublic(pair.publicKey);
  const K = random(32);
  const w = await sealKey(pub, 'info', 'aad', K);
  assert.equal(w.length, 80);
  assert.equal(toHex(await openKey(pair, 'info', 'aad', w)), toHex(K));
  await assert.rejects(openKey(pair, 'other', 'aad', w));
  await assert.rejects(openKey(pair, 'info', 'other', w));
  const badEnc = w.slice(); badEnc[3] ^= 1;
  await assert.rejects(openKey(pair, 'info', 'aad', badEnc));
  const badCt = w.slice(); badCt[50] ^= 1;
  await assert.rejects(openKey(pair, 'info', 'aad', badCt));
  await assert.rejects(openKey(await sig.newDhPair(false), 'info', 'aad', w));
});

// ---------- bytes and canonical JSON ----------
test('bytes: base64url round trips, refuses padding and stray bits; base32 alphabets', () => {
  for (let n = 0; n < 40; n++) { const b = random(n); assert.equal(toHex(unb64u(b64u(b))), toHex(b)); }
  assert.equal(b64u(utf8('hi?')), 'aGk_');
  assert.equal(unb64u('aGk='), null);
  assert.equal(unb64u('aGl'), null, 'non-zero leftover bits');
  assert.equal(b64uOf(b64u(random(31)), 32), null);
  assert.equal(base32(hex('00443214c74254b635cf84653a56d7c675be77df')), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  assert.equal(crockford(hex('00443214c74254b635cf84653a56d7c675be77df')), '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  assert.equal(normCrockford('abcd-efgh ilo0'), 'ABCDEFGH1100');
  assert.equal(normCrockford('U'), null);
  assert.ok(equal(utf8('ab'), utf8('ab')));
  assert.ok(!equal(utf8('ab'), utf8('ac')));
  assert.ok(!equal(utf8('ab'), utf8('abc')));
  assert.equal(toHex(concat(hex('01'), hex('0203'))), '010203');
});

function randomValue(depth = 0) {
  const r = Math.random();
  if (depth > 3 || r < 0.3) return [null, true, false, 0, -1.5, 1e21, 'x', 'é "\\', ''][Math.floor(Math.random() * 9)];
  if (r < 0.6) return Array.from({ length: Math.floor(Math.random() * 4) }, () => randomValue(depth + 1));
  const o = {};
  for (let i = 0; i < Math.floor(Math.random() * 5); i++) o[`k${Math.floor(Math.random() * 20)}${'zyx'[i % 3]}`] = randomValue(depth + 1);
  return o;
}
test('canon: same output as server/peercrypto.js canon on 1000 random objects', () => {
  for (let i = 0; i < 1000; i++) { const v = randomValue(); assert.equal(canon(v), peerCanon(v)); }
  assert.equal(canon({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
});
test('canon: refuses __proto__, NaN, Infinity, depth over 8 and non-plain objects', () => {
  assert.throws(() => canon(JSON.parse('{"__proto__":1}')));
  assert.throws(() => canon({ constructor: 1 }));
  assert.throws(() => canon(NaN));
  assert.throws(() => canon({ a: Infinity }));
  let deep = 1; for (let i = 0; i < 10; i++) deep = [deep];
  assert.throws(() => canon(deep));
  assert.throws(() => canon(new Date()));
  assert.equal(parseCanon('{"a":1}').a, 1);
  assert.equal(parseCanon('{"__proto__":1}'), null);
  assert.equal(parseCanon('"' + 'x'.repeat(100) + '"', 50), null);
});

// ---------- signed objects ----------
async function account(u = 'u_alice', ndev = 1, { kind = 'web' } = {}) {
  const aik = await sig.newSigningPair(true);
  const aikPub = b64u(await sig.rawPublic(aik.publicKey));
  const devs = [];
  for (let i = 0; i < ndev; i++) {
    const dsk = await sig.newSigningPair(false);
    const pk = await sig.newDhPair(false);
    const d = obj.newDeviceId();
    const pkPub = await sig.rawPublic(pk.publicKey);
    devs.push({ d, dsk, pk, pkPub, kid: 1, entry: { d, dsk: b64u(await sig.rawPublic(dsk.publicKey)), kind, label: `Device ${i}`, added: 1000 + i } });
  }
  const hist = await sig.newDhPair(false);
  const histPub = await sig.rawPublic(hist.publicKey);
  const list = await obj.makeList(aik.privateKey, { u, ver: 1, ts: Date.now(), aik: aikPub, devs: devs.map((x) => x.entry), arc: { e: 1, pub: b64u(histPub), at: Date.now() } });
  return { u, aik, aikPub, devs, list, hist, histPub };
}

test('objects: a device list signs and verifies; a changed field or another key fails', async () => {
  const a = await account('u_alice', 2);
  assert.ok(await obj.verifyList(a.list));
  assert.ok(await obj.verifyList(a.list, unb64u(a.aikPub)));
  assert.equal(obj.listProblem(a.list), null);
  assert.ok(!(await obj.verifyList({ ...a.list, ver: 2 })));
  assert.ok(!(await obj.verifyList({ ...a.list, devs: a.list.devs.slice(1) })));
  const other = await account('u_bob');
  assert.ok(!(await obj.verifyList(a.list, unb64u(other.aikPub))));
  assert.match(obj.newDeviceId(), /^dv_[A-Z2-7]{20}$/);
  assert.notEqual(obj.newDeviceId(), obj.newDeviceId());
  assert.equal(obj.listProblem({ ...a.list, devs: [...a.list.devs, a.list.devs[0]] }), 'device', 'duplicate device');
  assert.equal(obj.listProblem({ ...a.list, extra: 1 }), 'fields');
});

test('objects: pin on first sight, refuse rollback and forks, detect an account key change', async () => {
  const a = await account();
  const first = await obj.acceptList(null, a.list);
  assert.ok(first.ok && first.first);
  const v2 = await obj.makeList(a.aik.privateKey, { ...a.list, ver: 2, ts: Date.now() });
  const second = await obj.acceptList(first.pin, v2);
  assert.ok(second.ok && second.changed);
  assert.deepEqual(await obj.acceptList(second.pin, a.list), { ok: false, why: 'rollback' });
  const fork = await obj.makeList(a.aik.privateKey, { ...a.list, ver: 2, ts: Date.now() + 5 });
  assert.deepEqual(await obj.acceptList(second.pin, fork), { ok: false, why: 'rollback' });
  assert.equal((await obj.acceptList(second.pin, v2)).changed, false);
  const reset = await account(); // same user, new account key
  assert.deepEqual(await obj.acceptList(second.pin, { ...reset.list, ver: 3 }), { ok: false, why: 'bad' }, 'tampered ver breaks the signature');
  const resetSigned = await obj.makeList(reset.aik.privateKey, { ...reset.list, ver: 3 });
  assert.deepEqual(await obj.acceptList(second.pin, resetSigned), { ok: false, why: 'aik-changed' });
  assert.deepEqual(await obj.acceptList(null, { ...a.list, sig: b64u(random(64)) }), { ok: false, why: 'bad' });
});

test('objects: a prekey with the wrong device key, user, device or an old timestamp is refused', async () => {
  const a = await account();
  const d = a.devs[0];
  const now = Date.now();
  const pk = await obj.makePrekey(d.dsk.privateKey, { u: a.u, d: d.d, kid: 1, pub: b64u(d.pkPub), ts: now });
  assert.ok(await obj.verifyPrekey(pk, { u: a.u, d: d.d, dsk: d.entry.dsk, now }));
  const other = await sig.newSigningPair(false);
  assert.ok(!(await obj.verifyPrekey(pk, { u: a.u, d: d.d, dsk: await sig.rawPublic(other.publicKey), now })));
  assert.ok(!(await obj.verifyPrekey(pk, { u: 'u_bob', d: d.d, dsk: d.entry.dsk, now })));
  assert.ok(!(await obj.verifyPrekey(pk, { u: a.u, d: obj.newDeviceId(), dsk: d.entry.dsk, now })));
  assert.ok(!(await obj.verifyPrekey(pk, { u: a.u, d: d.d, dsk: d.entry.dsk, now: now + 31 * 86_400_000 })));
  assert.ok(!(await obj.verifyPrekey({ ...pk, kid: 2 }, { u: a.u, d: d.d, dsk: d.entry.dsk, now })));
});

test('objects: a device the server lists but the signed list lacks is never used', async () => {
  const a = await account('u_alice', 2);
  const ghost = obj.newDeviceId();
  const use = obj.signedDevices(a.list, [a.devs[0].d, ghost, a.devs[1].d]);
  assert.deepEqual(use.map((d) => d.d), [a.devs[0].d, a.devs[1].d]);
  const diff = obj.listDiff({ devs: [a.list.devs[0]] }, a.list);
  assert.deepEqual(diff.added.map((d) => d.d), [a.devs[1].d]);
});

// ---------- rules ----------
test('rules: requiredSet with the previous-kid grace, removed and pending devices, history-off members', () => {
  const now = 10_000_000;
  const accounts = { u_a: { hist: true, epoch: 3 }, u_b: { hist: false, epoch: 1 } };
  const devices = [
    { id: 'dv_A1', user: 'u_a', state: 'trusted' }, { id: 'dv_A2', user: 'u_a', state: 'removed' },
    { id: 'dv_B1', user: 'u_b', state: 'trusted' }, { id: 'dv_B2', user: 'u_b', state: 'pending' },
  ];
  const prekeys = [
    { device: 'dv_A1', kid: 4, retired: null }, { device: 'dv_A1', kid: 3, retired: now - 30 * 60_000 },
    { device: 'dv_A2', kid: 1, retired: null }, { device: 'dv_B1', kid: 2, retired: null },
    { device: 'dv_B1', kid: 1, retired: now - 2 * 3600_000 }, { device: 'dv_B2', kid: 1, retired: null },
  ];
  const req = rules.requiredSet({ members: ['u_b', 'u_a', 'u_c'], accounts, devices, prekeys, now });
  assert.deepEqual(req.to, [['u_a', 'dv_A1', 4], ['u_b', 'dv_B1', 2]]);
  assert.deepEqual(req.alt, { dv_A1: 3 });
  assert.deepEqual(req.ar, [['u_a', 3]]);
  assert.deepEqual(req.missing, ['u_c']);
  assert.deepEqual(rules.checkRecipients(req, req.to, req.ar), { ok: true });
  assert.deepEqual(rules.checkRecipients(req, [['u_a', 'dv_A1', 3], ['u_b', 'dv_B1', 2]], req.ar), { ok: true }, 'previous kid inside the hour');
  assert.deepEqual(rules.checkRecipients(req, [['u_a', 'dv_A1', 4], ['u_b', 'dv_B1', 1]], req.ar), { ok: false, users: ['u_b'] }, 'previous kid after the hour');
  assert.deepEqual(rules.checkRecipients(req, [['u_a', 'dv_A1', 4]], req.ar), { ok: false, users: ['u_b'] }, 'missing device');
  assert.deepEqual(rules.checkRecipients(req, [...req.to, ['u_a', 'dv_A2', 1]], req.ar), { ok: false, users: ['u_a'] }, 'removed device');
  assert.deepEqual(rules.checkRecipients(req, [...req.to, ['u_b', 'dv_B2', 1]], req.ar), { ok: false, users: ['u_b'] }, 'pending device');
  assert.deepEqual(rules.checkRecipients(req, req.to, [...req.ar, ['u_b', 1]]), { ok: false, users: ['u_b'] }, 'history wrap for a member with history off');
  assert.deepEqual(rules.checkRecipients(req, req.to, []), { ok: false, users: ['u_a'] }, 'history wrap missing');
  assert.deepEqual(rules.wrapKeys(req.to, req.ar), ['d:dv_A1', 'd:dv_B1', 'a:u_a:3']);
});

test('rules: editSet excludes people who joined later and people who left', () => {
  assert.deepEqual(rules.editSet([['u_a', 'dv_1', 1], ['u_a', 'dv_2', 1], ['u_b', 'dv_3', 1], ['u_c', 'dv_4', 2]], ['u_a', 'u_c', 'u_new']), ['u_a', 'u_c']);
  assert.ok(rules.eligible({ members: ['u_a', 'u_b'] }));
  assert.ok(!rules.eligible({ members: ['u_a', 'u_b'] }, (u) => u === 'u_b'), 'a P2P shadow member');
  assert.ok(!rules.eligible({ members: ['u_a', 'u_b'], peer: true }), 'a peer group');
});

// ---------- envelope ----------
function recipientsOf(accounts, { history = true } = {}) {
  const to = [], ar = [];
  for (const a of accounts) {
    for (const d of a.devs) to.push([a.u, d.d, d.kid, d.pkPub]);
    if (history) ar.push([a.u, 1, a.histPub]);
  }
  to.sort(rules.cmpTuple); ar.sort(rules.cmpTuple);
  return { to, ar };
}
const header = (from, extra = {}) => ({ conv: 'd_conv1', place: 'd_conv1', id: 'm_abcdefgh12', kind: 'msg', rev: 0, from, ts: 1763200000123, lv: {}, ping: [], re: null, ...extra });
const keysFor = (a, d, { cached = null } = {}) => ({ device: (kid) => (kid === d.kid ? d.pk : null), history: (e) => (e === 1 ? a.hist : null), cached });
const expectOf = (h) => ({ conv: h.conv, place: h.place, id: h.id, author: h.from.u });

test('envelope: a 1:1 round trip, both sides, both devices', async () => {
  const a = await account('u_alice', 2), b = await account('u_bob', 1);
  const from = { u: a.u, d: a.devs[0].d };
  const h = header(from);
  const { env: e, k } = await env.seal({ header: h, body: { text: 'see you at 6', mentions: [], files: [] }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b]) });
  assert.equal(e.h.to.length, 3);
  for (const [who, dev] of [[b, b.devs[0]], [a, a.devs[1]], [a, a.devs[0]]]) {
    const r = await env.open({ env: e, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: who.u, d: dev.d }, keys: keysFor(who, dev), wraps: k });
    assert.equal(r.body.text, 'see you at 6');
    assert.deepEqual(r.flags, []);
  }
});

test('envelope: a group of 10 people with 10 devices each (110 wraps) round trips', async () => {
  const people = [];
  for (let i = 0; i < 10; i++) people.push(await account(`u_p${i}`, 10));
  const sender = people[0];
  const h = header({ u: sender.u, d: sender.devs[0].d });
  const { env: e, k } = await env.seal({ header: h, body: { text: 'hello all' }, dsk: sender.devs[0].dsk.privateKey, recipients: recipientsOf(people) });
  assert.equal(Object.keys(k).length, 110);
  assert.ok(env.wireSize(e, k) < env.CAPS.total, `wire ${env.wireSize(e, k)}`);
  const last = people[9], dev = last.devs[9];
  const r = await env.open({ env: e, expect: expectOf(h), senderDsk: unb64u(sender.devs[0].entry.dsk), me: { u: last.u, d: dev.d }, keys: keysFor(last, dev), wraps: k });
  assert.equal(r.body.text, 'hello all');
});

test('envelope: tampering with any header field, the nonce, ciphertext, signature or a wrap is rejected', async () => {
  const a = await account('u_alice'), b = await account('u_bob');
  const h = header({ u: a.u, d: a.devs[0].d }, { ping: [b.u] });
  const sealed = await env.seal({ header: h, body: { text: 'secret', mentions: [b.u] }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b], { history: false }) });
  const base = { expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: keysFor(b, b.devs[0]) };
  const ok = await env.open({ ...base, env: sealed.env, wraps: sealed.k });
  assert.equal(ok.body.text, 'secret');
  const fails = async (label, e, k = sealed.k, extra = {}) => {
    await assert.rejects(env.open({ ...base, ...extra, env: e, wraps: k }), (err) => err instanceof env.OpenFailure, label);
  };
  for (const [field, value] of [['ts', h.ts + 1], ['ping', []], ['re', 'm_other12345'], ['lv', { u_x: 1 }], ['kind', 'edit'], ['rev', 1], ['from', { u: a.u, d: obj.newDeviceId() }]]) {
    await fails(`header ${field}`, { ...sealed.env, h: { ...sealed.env.h, [field]: value } });
  }
  const flip = (s) => { const b = unb64u(s); b[b.length - 1] ^= 1; return b64u(b); };
  await fails('nonce', { ...sealed.env, n: flip(sealed.env.n) });
  await fails('ciphertext', { ...sealed.env, c: flip(sealed.env.c) });
  await fails('signature', { ...sealed.env, sig: flip(sealed.env.sig) });
  await fails('my wrap', sealed.env, { ...sealed.k, [`d:${b.devs[0].d}`]: flip(sealed.k[`d:${b.devs[0].d}`]) });
  // Another device's wrap opened with my key: wrong info, wrong key.
  await fails('a wrap meant for someone else', sealed.env, { [`d:${b.devs[0].d}`]: sealed.k[`d:${a.devs[0].d}`] });
  await fails('signed by another device', sealed.env, sealed.k, { senderDsk: unb64u(b.devs[0].entry.dsk) });
});

test('envelope: ciphertext moved to another message, conversation, thread or revision is rejected', async () => {
  const a = await account('u_alice'), b = await account('u_bob');
  const h = header({ u: a.u, d: a.devs[0].d });
  const s = await env.seal({ header: h, body: { text: 'x' }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b]) });
  const base = { env: s.env, wraps: s.k, senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: keysFor(b, b.devs[0]) };
  for (const expect of [{ ...expectOf(h), id: 'm_otherid123' }, { ...expectOf(h), conv: 'd_other' }, { ...expectOf(h), place: 't:m_root1234' }, { ...expectOf(h), rev: 1 }, { ...expectOf(h), author: b.u }]) {
    await assert.rejects(env.open({ ...base, expect }), env.OpenFailure);
  }
});

test('envelope: body binding (a body sealed for another place is refused) and mentions that differ from ping are flagged', async () => {
  const a = await account('u_alice'), b = await account('u_bob');
  // A malicious sender's header says one place, the encrypted body another.
  const h = header({ u: a.u, d: a.devs[0].d });
  const K = random(32), n = random(12);
  const rec = recipientsOf([a, b]);
  const hFull = { ...h, v: 1, s: env.SUITE, to: rec.to.map(([u, d, kid]) => [u, d, kid]), ar: rec.ar.map(([u, e]) => [u, e]) };
  const badBody = env.pad({ v: 1, conv: h.conv, place: 't:m_elsewhere1', id: h.id, rev: 0, from: h.from, text: 'x' });
  const c = await sig.aesSeal(K, n, utf8(canon(badBody)), env.aadOf(hFull));
  const hh = await env.headerHash(hFull);
  const sg = await sig.signBytes(a.devs[0].dsk.privateKey, utf8(`snug-e2ee-v1/env\n${b64u(hh)}\n${b64u(n)}\n${b64u(await sig.sha256(c))}`));
  const k = { [`d:${b.devs[0].d}`]: b64u(await sealKey(b.devs[0].pkPub, env.wrapInfo(b.u, b.devs[0].d, 1), hh, K)) };
  await assert.rejects(env.open({ env: { h: hFull, n: b64u(n), c: b64u(c), sig: b64u(sg) }, wraps: k, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: keysFor(b, b.devs[0]) }),
    (e) => e.reason === 'body');
  const s = await env.seal({ header: header({ u: a.u, d: a.devs[0].d }, { ping: [] }), body: { text: '@bob', mentions: [b.u] }, dsk: a.devs[0].dsk.privateKey, recipients: rec });
  const r = await env.open({ env: s.env, wraps: s.k, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: keysFor(b, b.devs[0]) });
  assert.deepEqual(r.flags, ['mentions']);
});

test('envelope: padding buckets of 256 bytes to 4 KB, then 1 KB', () => {
  assert.deepEqual([1, 256, 257, 4096, 4097, 5121].map(env.bucket), [256, 256, 512, 4096, 5120, 6144]);
  for (const text of ['', 'hi', 'x'.repeat(300), 'é'.repeat(2000), 'y'.repeat(4000)]) {
    const p = env.pad({ text, v: 1 });
    const len = utf8(canon(p)).length;
    assert.equal(len, env.bucket(len), `${text.length} chars -> ${len} bytes`);
  }
});

test('envelope: the history wrap opens without the device prekey; with history off a deleted prekey can’t open it', async () => {
  const a = await account('u_alice'), b = await account('u_bob');
  const h = header({ u: a.u, d: a.devs[0].d });
  const on = await env.seal({ header: h, body: { text: 'kept' }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b]) });
  // A new device of Bob's with only the history key (it wasn't in `to`).
  const newDev = { d: obj.newDeviceId(), kid: 1, pk: await sig.newDhPair() };
  const r = await env.open({ env: on.env, wraps: on.k, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: newDev.d }, keys: keysFor(b, newDev) });
  assert.equal(r.body.text, 'kept');
  const off = await env.seal({ header: h, body: { text: 'gone' }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b], { history: false }) });
  assert.equal(Object.keys(off.k).filter((x) => x.startsWith('a:')).length, 0);
  await assert.rejects(env.open({ env: off.env, wraps: off.k, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: { device: () => null, history: () => b.hist } }),
    (e) => e.reason === 'no key');
  // A key cached from an earlier decrypt still opens it on the device that had it.
  const cached = await env.open({ env: off.env, wraps: {}, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: { cached: off.K } });
  assert.equal(cached.body.text, 'gone');
});

test('envelope: header shape and size caps', async () => {
  const a = await account('u_alice');
  const h = header({ u: a.u, d: a.devs[0].d });
  await assert.rejects(env.seal({ header: { ...h, kind: 'poll' }, body: {}, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a]) }));
  await assert.rejects(env.seal({ header: h, body: { text: 'x'.repeat(4001) }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a]) }));
  await assert.rejects(env.seal({ header: { ...h, ping: Array.from({ length: 11 }, (_, i) => `u_${i}`) }, body: {}, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a]) }));
  assert.equal(env.headerProblem({ ...h, v: 1, s: env.SUITE, to: [], ar: [] }), 'recipients');
  assert.equal(env.headerProblem({ ...h, v: 1, s: env.SUITE, to: [['u', 'd', 1]], ar: [], kind: 'sched' }), 'at');
});

// ---------- attachments ----------
test('attach: sizes 0, 1, 1 MiB and 10 MiB round trip; a flipped byte fails the hash and the AEAD', async () => {
  for (const n of [0, 1, 1 << 20, 10 << 20]) {
    const bytes = new Uint8Array(n); for (let i = 0; i < n; i += 4093) bytes[i] = i & 255;
    const { ct, meta } = await encryptFile(bytes);
    assert.equal(ct.length, n + 16);
    assert.equal((await decryptFile(ct, meta)).length, n);
  }
  const { ct, meta } = await encryptFile(utf8('hello file'));
  const bad = ct.slice(); bad[0] ^= 1;
  await assert.rejects(decryptFile(bad, meta), /file changed/);
  // Matching hash but a broken tag (someone also replaced csha): the AEAD still refuses.
  await assert.rejects(decryptFile(bad, { ...meta, csha: b64u(await sig.sha256(bad)) }));
});

// ---------- safety numbers ----------
test('fingerprint: libsignal’s published vectors (displayable and the raw hash behind the scannable one)', async () => {
  const alice = { id: '+14152222222', key: hex('0506863bc66d02b40d27b8d49ca7c09e9239236f9d7d25d6fcca5ce13c7064d868') };
  const bob = { id: '+14153333333', key: hex('05f781b6fb32fed9ba1cf2de978d4d5da28dc34046ae814402b5c0dbd96fda907b') };
  assert.equal(await safetyNumber(alice, bob), '300354477692869396892869876765458257569162576843440918079131');
  assert.equal(await safetyNumber(bob, alice), '300354477692869396892869876765458257569162576843440918079131', 'symmetric');
  assert.equal(toHex((await fingerprintHash(alice.key, alice.id)).slice(0, 32)), '1e301a0353dce3dbe7684cb8336e85136cdc0ee96219494ada305d62a7bd61df');
  assert.equal(toHex((await fingerprintHash(bob.key, bob.id)).slice(0, 32)), 'd62cbf73a11592015b6b9f1682ac306fea3aaf3885b84d12bca631e9d4fb3a4d');
});
test('fingerprint: unchanged by device changes, changed by a new account key; 12 groups of 5', async () => {
  const a = await account('u_alice', 1), b = await account('u_bob', 1);
  const n1 = await safetyNumber({ id: a.u, key: unb64u(a.aikPub) }, { id: b.u, key: unb64u(b.aikPub) });
  const a2 = await account('u_alice', 3); // new devices, but compare with a's AIK
  const n2 = await safetyNumber({ id: a.u, key: unb64u(a.aikPub) }, { id: b.u, key: unb64u(b.aikPub) });
  assert.equal(n1, n2);
  const n3 = await safetyNumber({ id: a.u, key: unb64u(a2.aikPub) }, { id: b.u, key: unb64u(b.aikPub) });
  assert.notEqual(n1, n3);
  assert.equal(groupsOf5(n1).length, 12);
});

// ---------- linking a device ----------
test('link: code format, typed forms, and tags that catch substituted keys, lists and boxes', async () => {
  const { code, text } = link.newLinkCode();
  assert.match(text, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(link.parseLinkCode(text.toLowerCase().replace(/-/g, ' ')), code);
  assert.equal(link.parseLinkCode('ABCD-EFGH'), null);
  const Kc = await link.linkKey(code, 'lk_1');
  assert.notEqual(toHex(Kc), toHex(await link.linkKey(code, 'lk_2')), 'bound to the link id');
  const fields = { linkId: 'lk_1', u: 'u_a', d: 'dv_X', dsk: b64u(random(32)), prekey: { kid: 1, pub: b64u(random(32)) } };
  const t1 = await link.tag1(Kc, fields);
  assert.ok(link.sameTag(t1, await link.tag1(Kc, { ...fields })));
  assert.ok(!link.sameTag(t1, await link.tag1(Kc, { ...fields, dsk: b64u(random(32)) })), 'substituted dsk');
  assert.ok(!link.sameTag(t1, await link.tag1(Kc, { ...fields, prekey: { kid: 1, pub: b64u(random(32)) } })), 'substituted prekey');
  assert.ok(!link.sameTag(t1, await link.tag1(await link.linkKey(link.newLinkCode().code, 'lk_1'), fields)), 'another code');
  const box = random(200), list = { ver: 2, devs: ['a'] };
  const t2 = await link.tag2(Kc, box, list);
  assert.ok(link.sameTag(t2, await link.tag2(Kc, box, { ...list })));
  assert.ok(!link.sameTag(t2, await link.tag2(Kc, box, { ver: 2, devs: ['a', 'b'] })), 'substituted list');
  const box2 = box.slice(); box2[0] ^= 1;
  assert.ok(!link.sameTag(t2, await link.tag2(Kc, box2, list)), 'substituted box');
});

// ---------- backup, recovery key, synced meta ----------
test('backup: the recovery key opens the backup; a wrong key or a blob moved to another user or version fails', async () => {
  const asb = await backup.newAsb('u_alice');
  assert.equal(backup.asbProblem(asb), null);
  const aik = await backup.asbAikPublic(asb);
  const rk = await newRecoveryKey();
  const bk = await deriveBackupKey(rk.raw);
  const blob = await backup.sealBackup(asb, bk, { ver: 1, aik });
  assert.deepEqual(await backup.openBackup(blob, bk, 'u_alice'), asb);
  const parsed = await parseRecoveryKey(rk.text.toLowerCase());
  assert.deepEqual(await backup.openBackup(blob, await deriveBackupKey(parsed.raw), 'u_alice'), asb);
  await assert.rejects(backup.openBackup(blob, await deriveBackupKey((await newRecoveryKey()).raw), 'u_alice'));
  await assert.rejects(backup.openBackup(blob, bk, 'u_bob'));
  await assert.rejects(backup.openBackup({ ...blob, ver: 2 }, bk, 'u_alice'));
  // BK and the key a host server sees for password recovery are unrelated.
  assert.notEqual(toHex(bk), toHex(await deriveAuthKey(rk.raw)));
  // Working keys are non-extractable and the account key's public half matches.
  const keys = await backup.loadAsb(asb);
  assert.equal(keys.aik.extractable, false);
  assert.equal(keys.ahk[1].privateKey.extractable, false);
  assert.equal(keys.aikPub, aik);
  const signed = await sig.signObject(keys.aik, 'test', { a: 1 });
  assert.ok(await sig.verifyObject(unb64u(aik), 'test', signed));
  const { asb: next, e } = await backup.addEpoch(asb);
  assert.equal(e, 2);
  assert.deepEqual(Object.keys(next.ahk), ['1', '2']);
  assert.equal(backup.asbProblem(await backup.newAsb('u_x', { history: false })), null);
});

test('backup: any one-character change of a recovery key is caught by the check characters', async () => {
  const rk = await newRecoveryKey();
  const chars = rk.text.replace(/-/g, '');
  let caught = 0, total = 0;
  for (let i = 0; i < chars.length; i++) {
    for (const c of 'ACKQZ27') {
      if (c === chars[i]) continue;
      total++;
      const r = await parseRecoveryKey(chars.slice(0, i) + c + chars.slice(i + 1));
      if (r.error) caught++;
    }
  }
  assert.equal(caught, total);
});

test('meta: sealed under SYNC, bound to the user and version', async () => {
  const sync = random(32);
  const m = { verified: { u_b: 'aik' }, pins: { u_b: { aik: 'x', ver: 2 } }, convs: { d_1: 10 } };
  const blob = await backup.sealMeta(m, sync, { u: 'u_a', ver: 3 });
  assert.deepEqual(await backup.openMeta(blob, sync, { u: 'u_a', ver: 3 }), m);
  await assert.rejects(backup.openMeta(blob, sync, { u: 'u_a', ver: 4 }));
  await assert.rejects(backup.openMeta(blob, random(32), { u: 'u_a', ver: 3 }));
});

// ---------- sniff, support, copy ----------
test('sniff: the browser port gives the server’s answers', () => {
  const samples = [
    [0x89, ...utf8('PNG'), 0, 0], [0xff, 0xd8, 0xff, 0xe0], [...utf8('GIF89a')], [...utf8('GIF87a')],
    [...utf8('RIFF'), 0, 0, 0, 0, ...utf8('WEBP')], [0, 0, 0, 0, ...utf8('ftypM4A '), 0], [0, 0, 0, 0, ...utf8('ftypqt  ')],
    [0, 0, 0, 0, ...utf8('ftypisom')], [0x1a, 0x45, 0xdf, 0xa3], [...utf8('OggS')], [...utf8('ID3'), 4], [0xff, 0xfb, 0x90, 0],
    [...utf8('<html>')], [1, 2], [], [...utf8('%PDF-1.7')],
  ];
  for (const s of samples) assert.equal(sniffBrowser(new Uint8Array(s)), sniffServer(Buffer.from(s)), JSON.stringify(s));
});

test('support: Node’s WebCrypto passes the capability check (IndexedDB skipped)', async () => {
  assert.deepEqual(await supported({ idb: null }), { ok: true });
  assert.deepEqual(await supported({ idb: undefined }), { ok: false, reason: 'storage' });
});

test('copy: no banned claims in encryption wording or the docs; rooms are never called encrypted', () => {
  const texts = [JSON.stringify(COPY, (k, v) => (typeof v === 'function' ? v('Ines') : v))];
  for (const f of ['README.md', 'SECURITY.md']) texts.push(readFileSync(join(ROOT, f), 'utf8'));
  for (const t of texts) for (const w of BANNED) assert.ok(!t.toLowerCase().includes(w), `"${w}" appears`);
  assert.match(COPY.roomsNot, /aren’t end-to-end encrypted/);
  assert.ok(!/secure/i.test(COPY.roomsNot));
});

test('copy (0.14): “sealed with the system key store” is said only of an app device whose keys are sealed', async () => {
  const { storageNoteFor } = await import('../js/lib/e2ee/copy.js');
  const SEALED = /sealed with the system key store/;
  const all = [
    [{ kind: 'app', keyStore: 'os', sealed: true }, true],
    [{ kind: 'app', keyStore: 'os', sealed: false }, false], // made before 0.14
    [{ kind: 'app', keyStore: 'os', sealed: null }, true], // no keys on this computer yet: any made here are sealed
    [{ kind: 'app', keyStore: 'none', sealed: false }, false], // no key store on this computer
    [{ kind: 'app', keyStore: 'locked', sealed: true }, false],
    [{ kind: 'web', keyStore: 'none', sealed: false }, false], // a browser, or the app on a server's own page
    [{ kind: 'web', keyStore: 'os', sealed: true }, false],
  ];
  for (const [where, sealed] of all) {
    const t = storageNoteFor(where);
    assert.match(t, /^Script running in Snug’s page can use the keys on this device and read your account keys/, JSON.stringify(where));
    assert.equal(SEALED.test(t), sealed, `${JSON.stringify(where)}: ${t}`);
    for (const w of BANNED) assert.ok(!t.toLowerCase().includes(w), `"${w}" appears`);
  }
  // Unsealed keys: the note says a copy of the stored data includes them; an old app device is told how to seal them.
  assert.match(storageNoteFor({ kind: 'web', keyStore: 'none', sealed: false }), /aren’t sealed/);
  assert.match(storageNoteFor({ kind: 'app', keyStore: 'os', sealed: false }), /made before.*Reset encryption/s);
  assert.match(storageNoteFor({ kind: 'app', keyStore: 'none', sealed: false }), /aren’t sealed/);
  assert.doesNotMatch(storageNoteFor({ kind: 'app', keyStore: 'os', sealed: null }), /made before/);
});

// ---------- review fixes (L1, L3, M2, M3, H1) ----------
import * as hw from '../js/lib/e2ee/highwater.js';

test('envelope (L1): the signed header commits to the message key; a wrap carrying another key is refused; old envelopes without it still open', async () => {
  const a = await account('u_alice'), b = await account('u_bob');
  const h = header({ u: a.u, d: a.devs[0].d });
  const s = await env.seal({ header: h, body: { text: 'committed' }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b], { history: false }) });
  const want = await sig.sha256(concat(utf8('snug-e2ee-v1/kc'), s.K, unb64u(s.env.n)));
  assert.equal(s.env.h.kc, b64u(want), 'kc = SHA-256("snug-e2ee-v1/kc" || K || n), in the signed header');
  const base = { env: s.env, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: keysFor(b, b.devs[0]) };
  assert.equal((await env.open({ ...base, wraps: s.k })).body.text, 'committed');
  // The sender (or anyone who can make a wrap for b) hands b a different key: refused before decrypting.
  const other = random(32);
  const hh = await env.headerHash(s.env.h);
  const forged = b64u(await sealKey(b.devs[0].pkPub, env.wrapInfo(b.u, b.devs[0].d, 1), hh, other));
  await assert.rejects(env.open({ ...base, wraps: { [`d:${b.devs[0].d}`]: forged } }), (e) => e instanceof env.OpenFailure && e.reason === 'commitment');
  await assert.rejects(env.open({ ...base, wraps: {}, keys: keysFor(b, b.devs[0], { cached: other }) }), (e) => e.reason === 'commitment', 'a cached key that isn’t this message’s');
  // An envelope sealed by a 0.12.0 client (no kc) still opens, and its header still passes the server's shape check.
  const old = await env.seal({ header: h, body: { text: 'from before' }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b], { history: false }), commit: false });
  assert.equal(old.env.h.kc, undefined);
  assert.equal(env.envelopeProblem(old.env), null);
  assert.equal((await env.open({ ...base, env: old.env, wraps: old.k })).body.text, 'from before');
  assert.equal(env.headerProblem({ ...s.env.h, kc: 'short' }), 'header', 'a malformed commitment');
});

test('link (L3): the code’s tag covers the new device’s label and kind, so the server can’t rename it on the way', async () => {
  const Kc = await link.linkKey(link.newLinkCode().code, 'lk_1');
  const fields = { linkId: 'lk_1', u: 'u_a', d: 'dv_X', dsk: b64u(random(32)), prekey: { kid: 1, pub: b64u(random(32)) }, label: 'Firefox on Windows', kind: 'web' };
  const t1 = await link.tag1(Kc, fields);
  assert.ok(!link.sameTag(t1, await link.tag1(Kc, { ...fields, label: 'Snug app on Windows' })), 'a substituted label');
  assert.ok(!link.sameTag(t1, await link.tag1(Kc, { ...fields, kind: 'app' })), 'a substituted kind');
  assert.ok(link.sameTag(t1, await link.tag1(Kc, { ...fields })));
});

test('objects (M3): a pin keeps the list’s hash, so a different list under the same version is caught without keeping the list', async () => {
  const a = await account();
  const first = await obj.acceptList(null, a.list);
  assert.equal(first.pin.h, await obj.listHash(a.list));
  assert.equal(first.pin.list, undefined, 'the pin is small enough for the synced settings');
  const fork = await obj.makeList(a.aik.privateKey, { ...a.list, ts: a.list.ts + 1 });
  assert.deepEqual(await obj.acceptList({ aik: first.pin.aik, ver: first.pin.ver, h: first.pin.h }, fork), { ok: false, why: 'rollback' });
  assert.equal((await obj.acceptList({ aik: first.pin.aik, ver: 1 }, fork)).ok, true, 'an old pin with no hash: version and key only, as before');
});

test('highwater (H1, M3): synced settings and the own device list never go back below what this device has seen', () => {
  assert.equal(hw.metaCheck(null, { ver: 3, blob: 'x' }), 'take', 'first sight on this device');
  assert.equal(hw.metaCheck({ ver: 3 }, { ver: 4, blob: 'x' }), 'take');
  assert.equal(hw.metaCheck({ ver: 3 }, { ver: 3, blob: 'x' }), 'same');
  assert.equal(hw.metaCheck({ ver: 3 }, { ver: 2, blob: 'x' }), 'rollback');
  assert.equal(hw.metaCheck({ ver: 3 }, { ver: 0, blob: null }), 'missing', 'gone after it was seen');
  assert.equal(hw.listCheck(null, { ver: 2 }, 'h2'), 'ok');
  assert.equal(hw.listCheck({ ver: 2, h: 'h2' }, { ver: 3 }, 'h3'), 'ok');
  assert.equal(hw.listCheck({ ver: 2, h: 'h2' }, { ver: 2 }, 'h2'), 'ok');
  assert.equal(hw.listCheck({ ver: 2, h: 'h2' }, { ver: 2 }, 'hX'), 'fork');
  assert.equal(hw.listCheck({ ver: 3, h: 'h3' }, { ver: 2 }, 'h2'), 'rollback');
});

test('backup (M2): the account keys carry a serial; a box with an older one, or a different one under the same serial, is refused', async () => {
  const asb = await backup.newAsb('u_alice');
  assert.equal(backup.asbProblem(asb), null);
  const next = backup.bumpAsb(asb);
  assert.equal(next.n, 1);
  assert.equal(backup.asbProblem(next), null);
  assert.equal(backup.asbOrder(asb, next), 'newer', 'no serial counts as 0');
  assert.equal(backup.asbOrder(next, asb), 'older');
  assert.equal(backup.asbOrder(next, { ...next }), 'same');
  assert.equal(backup.asbOrder(next, { ...next, sync: b64u(random(32)) }), 'fork');
  assert.equal(backup.asbProblem({ ...asb, n: -1 }), 'asb');
});

// ---------- second review pass (M2, L1, H1) ----------
test('backup (M2, second pass): a box from a 0.12.0 device (no serial bump) with a newer list version is taken when it keeps every history key; an older one or one that drops a key is not', async () => {
  const asb = backup.bumpAsb(await backup.newAsb('u_alice'), {}); // n 1, as a fixed device left it at list version 4
  const fixed = backup.bumpAsb((await backup.addEpoch(asb)).asb); // n 2: an ordinary newer box
  assert.equal(backup.asbAccept(asb, fixed, { ver: 5, localVer: 4 }), 'take');
  // A 0.12.0 device's weekly rotation: the same serial (it copies n), a new epoch, a newer list version.
  const old = (await backup.addEpoch(asb)).asb;
  assert.equal(backup.asbOrder(asb, old), 'fork', 'what the first pass refused for good');
  assert.equal(backup.asbAccept(asb, old, { ver: 5, localVer: 4 }), 'take');
  const { n: _n, ...noSerial } = old; // eslint-disable-line no-unused-vars
  assert.equal(backup.asbAccept(asb, noSerial, { ver: 5, localVer: 4 }), 'take', 'a 0.12.0 ASB with no serial at all');
  // The same box replayed at a list version this device already passed: stale, never taken.
  assert.equal(backup.asbAccept(asb, old, { ver: 4, localVer: 4 }), 'stale');
  assert.equal(backup.asbAccept(asb, old, { ver: 3, localVer: 4 }), 'stale');
  // A newer list version that drops or replaces a history key this device holds: refused (and kept for a retry).
  const { 1: _gone, ...fewer } = old.ahk; // eslint-disable-line no-unused-vars
  assert.equal(backup.asbAccept(asb, { ...old, ahk: fewer }, { ver: 6, localVer: 4 }), 'refuse');
  assert.equal(backup.asbAccept(asb, { ...old, ahk: { ...old.ahk, 1: fixed.ahk[2] } }, { ver: 6, localVer: 4 }), 'refuse');
  assert.equal(backup.asbAccept(asb, { ...asb }, { ver: 6, localVer: 4 }), 'same');
  // No list version known here (a device from before this pass): the serial decides, as before.
  assert.equal(backup.asbAccept(asb, fixed, { ver: 5, localVer: 0 }), 'take');
  assert.equal(backup.asbAccept(fixed, asb, { ver: 5, localVer: 0 }), 'stale');
});

test('envelope (L1, second pass): once a sender device has committed to its keys, an envelope from it without kc is refused', async () => {
  const a = await account('u_alice'), b = await account('u_bob');
  const h = header({ u: a.u, d: a.devs[0].d });
  const old = await env.seal({ header: h, body: { text: 'no commitment' }, dsk: a.devs[0].dsk.privateKey, recipients: recipientsOf([a, b], { history: false }), commit: false });
  const base = { env: old.env, expect: expectOf(h), senderDsk: unb64u(a.devs[0].entry.dsk), me: { u: b.u, d: b.devs[0].d }, keys: keysFor(b, b.devs[0]), wraps: old.k };
  assert.equal((await env.open(base)).body.text, 'no commitment', 'from a device never seen committing');
  await assert.rejects(env.open({ ...base, expect: { ...expectOf(h), requireKc: true } }), (e) => e instanceof env.OpenFailure && e.reason === 'commitment');
});

test('highwater (H1, second pass): settings are written above both the server’s version and the highest this device has seen', () => {
  assert.equal(hw.metaWriteVer(3, null), 4);
  assert.equal(hw.metaWriteVer(3, { ver: 2 }), 4);
  assert.equal(hw.metaWriteVer(1, { ver: 5 }), 6, 'after a rollback to 1, a repair writes at 6, not 2');
  assert.equal(hw.metaWriteVer(0, { ver: 7 }), 8, 'gone from the server');
});

test('storage key under the OS key store: a 0.12.0 store is sealed again without losing anything; locked when the secret is gone', async () => {
  const { _test: T, StoreLocked } = await import('../js/e2ee/store.js');
  const { b64u: enc, random: rnd } = await import('../js/lib/e2ee/bytes.js');
  const kv = T.mapKv();
  // As 0.12.0: no key store. A raw storage key in the database, secrets sealed under it.
  const old = T.wrap(kv, 'snug-e2ee:u1');
  await old.putAsb({ v: 1, aik: 'account keys' });
  await old.putSecret('rk', 'RECOVERY-KEY');
  await old.putSecret('convs', { d_1: 4 });
  assert.equal(old.protection(), 'none');
  const sk0 = await kv.get('dev', 'sk');
  assert.ok(sk0, 'the old kind of storage key');
  const secret = enc(rnd(32));
  const os = (r) => async () => r;
  // With a key store: moved over, every secret still there, and the old key gone.
  const up = T.wrap(kv, 'snug-e2ee:u1', os({ protected: true, key: secret }));
  assert.deepEqual(await up.getAsb(), { v: 1, aik: 'account keys' });
  assert.equal(await up.getSecret('rk'), 'RECOVERY-KEY');
  assert.deepEqual(await up.getSecret('convs'), { d_1: 4 });
  assert.equal(up.protection(), 'os');
  assert.equal(await kv.get('dev', 'sk'), undefined, 'no storage key left that opens anything by itself');
  assert.deepEqual(Object.keys(await kv.get('dev', 'skw')).sort(), ['check', 'salt', 'v']);
  // The sealed boxes no longer open with the old key.
  const box = await kv.get('meta', 'rk');
  await assert.rejects(globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: new TextEncoder().encode('meta/rk') }, sk0, box.ct));
  // Opened again later with the same secret.
  const again = T.wrap(kv, 'snug-e2ee:u1', os({ protected: true, key: secret }));
  assert.equal(await again.getSecret('rk'), 'RECOVERY-KEY');
  // The key store gone, or another secret: locked, and nothing is replaced.
  for (const r of [{ protected: false, why: 'locked' }, { protected: false, why: 'unavailable' }, { protected: true, key: enc(rnd(32)) }, null]) {
    const locked = T.wrap(kv, 'snug-e2ee:u1', os(r));
    await assert.rejects(locked.ready(), (e) => e instanceof StoreLocked && e.code === 'e2ee_locked');
    assert.equal(locked.protection(), 'locked');
  }
  assert.equal(await kv.get('dev', 'sk'), undefined);
  assert.equal(await T.wrap(kv, 'snug-e2ee:u1', os({ protected: true, key: secret })).getSecret('rk'), 'RECOVERY-KEY', 'still opens with the right secret');
  // No key store from the start: today's behaviour.
  const kv2 = T.mapKv();
  const plain = T.wrap(kv2, 'snug-e2ee:u2', os({ protected: false, why: 'unavailable' }));
  await plain.putSecret('rk', 'X');
  assert.equal(plain.protection(), 'none');
  assert.ok(await kv2.get('dev', 'sk'));
  // A new store with a key store: never a raw key.
  const kv3 = T.mapKv();
  const fresh = T.wrap(kv3, 'snug-e2ee:u3', os({ protected: true, key: secret }));
  await fresh.putSecret('rk', 'Y');
  assert.equal(await kv3.get('dev', 'sk'), undefined);
  assert.equal(await fresh.getSecret('rk'), 'Y');
  // Parallel first uses move it over once.
  const kv4 = T.mapKv();
  const o4 = T.wrap(kv4, 'snug-e2ee:u4');
  await o4.putSecret('a', 1); await o4.putSecret('b', 2);
  const u4 = T.wrap(kv4, 'snug-e2ee:u4', os({ protected: true, key: secret }));
  assert.deepEqual(await Promise.all([u4.getSecret('a'), u4.getSecret('b'), u4.ready().then(() => 'ok')]), [1, 2, 'ok']);
});

test('rules (0.14): a group’s information is sealed again only for someone it doesn’t cover; such a re-seal keeps the name and icon', () => {
  const h = { to: [['u1', 'd1', 1], ['u2', 'd2', 1]], ar: [['u3', 1]] };
  assert.equal(rules.uncovered(['u1', 'u2', 'u3'], h), false);
  assert.equal(rules.uncovered(['u1', 'u2', 'u3', 'u4'], h), true);
  assert.equal(rules.uncovered(['u1'], h), false, 'someone leaving needs nothing sealed again');
  const prev = { name: 'Pottery club', icon: '🏺', hue: 30 };
  // A re-seal for members (no line in the conversation) that changes the name or icon: the one before stays.
  assert.deepEqual(rules.resealed('members', prev, { name: 'Renamed quietly', icon: '🏺', hue: 30 }), prev);
  assert.deepEqual(rules.resealed('members', prev, { name: 'Pottery club', icon: '🐸', hue: 30 }), prev);
  assert.deepEqual(rules.resealed('members', prev, { ...prev }), prev);
  // A rename (which writes a line) changes it; with nothing known before, the device takes what it opened.
  assert.deepEqual(rules.resealed('name', prev, { name: 'Glaze night', icon: '🏺', hue: 30 }), { name: 'Glaze night', icon: '🏺', hue: 30 });
  assert.deepEqual(rules.resealed('members', null, { name: 'New here', icon: null, hue: null }), { name: 'New here', icon: null, hue: null });
});

test('copy (0.14): the conversation panel says reactions, polls and group names are encrypted once everyone is on 0.14', () => {
  assert.doesNotMatch(COPY.convPanel, /Group names, reactions and pictures of the group aren’t encrypted/);
  assert.match(COPY.convPanel, /Reactions, polls and a group’s name and icon are encrypted too once everyone here is on Snug 0\.14 or later/);
});
