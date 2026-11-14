// Peer crypto (design section 1): encodings, canonical JSON, Ed25519 signing,
// the sealed box for one-shot messages through the registry, the link
// handshake and its AES-256-GCM session, signed profile snapshots, key-change
// continuity signatures and the ids both PCs derive from the same inputs.
// Pure functions over node:crypto; no state, no I/O.
import {
  createHash, createPublicKey, createPrivateKey, generateKeyPairSync, sign as edSign, verify as edVerify,
  diffieHellman, hkdfSync, randomBytes, createCipheriv, createDecipheriv,
} from 'node:crypto';

// ---------- Encodings ----------
export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export const sha256 = (data) => createHash('sha256').update(data).digest();

// Field shapes checked before anything goes into a signed string (S26).
export const UID = /^[a-z2-7]{16}$/;
export const isKey = (s) => typeof s === 'string' && s.length === 43 && /^[A-Za-z0-9_-]+$/.test(s);
export const isSig = (s) => typeof s === 'string' && s.length === 86 && /^[A-Za-z0-9_-]+$/.test(s);
export const isB64u = (s, bytes) => typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) && (bytes == null || unb64u(s).length === bytes);
export const isInt = (n) => Number.isSafeInteger(n);
export const isUid = (s) => typeof s === 'string' && UID.test(s);

// ---------- Canonical JSON (S26) ----------
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function canon(v, depth = 0) {
  if (depth > 8) throw new Error('too deep');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('bad number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map((x) => canon(x, depth + 1)).join(',')}]`;
  const proto = typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
  if (proto === Object.prototype || proto === null) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    for (const k of keys) if (BAD_KEYS.has(k)) throw new Error('bad key');
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error('not canonical');
}
// Parse with a byte cap checked first, then refuse anything canon() would refuse.
export function parseCapped(str, max) {
  if (typeof str !== 'string' || Buffer.byteLength(str) > max) return null;
  let v;
  try { v = JSON.parse(str); canon(v); } catch { return null; }
  return v;
}

// ---------- Keys ----------
export function newSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'jwk' }).x, priv: privateKey };
}
export function newDhKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { pub: publicKey.export({ format: 'jwk' }).x, priv: privateKey };
}
export const privToPkcs8 = (k) => k.export({ format: 'der', type: 'pkcs8' }).toString('base64');
export const privFromPkcs8 = (b64) => createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
export const pubOf = (priv) => createPublicKey(priv).export({ format: 'jwk' }).x;
// Raw public keys, parsed once and kept in a small LRU (section 11: 256).
const keyCache = new Map();
function pubKey(crv, x) {
  const k = `${crv}:${x}`;
  let o = keyCache.get(k);
  if (o) { keyCache.delete(k); keyCache.set(k, o); return o; }
  o = createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
  keyCache.set(k, o);
  if (keyCache.size > 256) keyCache.delete(keyCache.keys().next().value);
  return o;
}
export const edPub = (x) => pubKey('Ed25519', x);
export const xPub = (x) => pubKey('X25519', x);

export const signStr = (priv, str) => b64u(edSign(null, Buffer.from(str, 'utf8'), priv));
export function verifyStr(ik, str, sig) {
  if (!isKey(ik) || !isSig(sig)) return false;
  try { return edVerify(null, Buffer.from(str, 'utf8'), edPub(ik), unb64u(sig)); } catch { return false; }
}
export const dh = (priv, pubX) => diffieHellman({ privateKey: priv, publicKey: xPub(pubX) });
export const hkdf = (ikm, salt, info, len) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), len));

export function fingerprint(ik, xk) {
  const s = base32(sha256(Buffer.concat([unb64u(ik), unb64u(xk)]))).slice(0, 32).toUpperCase();
  return s.match(/.{4}/g).join(' ');
}

// ---------- AES-256-GCM ----------
export function gcmSeal(key, nonce, plain, aad) {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
export function gcmOpen(key, nonce, data, aad) {
  if (data.length < 16) throw new Error('short');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}

// ---------- Sealed box (section 1.3) ----------
// me: { uid, ikPriv }. Returns the box string.
export function seal(me, toUid, toXk, obj) {
  const e = newDhKeys();
  const k = hkdf(dh(e.priv, toXk), Buffer.concat([unb64u(e.pub), unb64u(toXk)]), `snug-seal-v1\n${me.uid}\n${toUid}`, 32);
  const n = randomBytes(12);
  const c = gcmSeal(k, n, Buffer.from(canon(obj), 'utf8'), `${me.uid}\n${toUid}`);
  const box = { v: 1, e: e.pub, n: b64u(n), c: b64u(c) };
  box.s = signStr(me.ikPriv, `snug-seal-v1\n${me.uid}\n${toUid}\n${box.e}\n${box.n}\n${box.c}`);
  return canon(box);
}
// Parse and check the shape of a box without keys (so the signer can be looked up first).
export function parseBox(str, max = 16 * 1024) {
  const b = parseCapped(str, max);
  if (!b || b.v !== 1 || !isKey(b.e) || !isB64u(b.n, 12) || typeof b.c !== 'string' || !isB64u(b.c) || !isSig(b.s)) return null;
  return b;
}
export const boxSigned = (fromUid, toUid, b) => `snug-seal-v1\n${fromUid}\n${toUid}\n${b.e}\n${b.n}\n${b.c}`;
export const boxVerify = (fromUid, toUid, b, fromIk) => verifyStr(fromIk, boxSigned(fromUid, toUid, b), b.s);
// me: { uid, xkPriv, xk }. Throws on any failure.
export function boxOpen(me, fromUid, b) {
  const k = hkdf(dh(me.xkPriv, b.e), Buffer.concat([unb64u(b.e), unb64u(me.xk)]), `snug-seal-v1\n${fromUid}\n${me.uid}`, 32);
  const plain = gcmOpen(k, unb64u(b.n), unb64u(b.c), `${fromUid}\n${me.uid}`).toString('utf8');
  const obj = parseCapped(plain, 16 * 1024);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bad box body');
  return obj;
}

// ---------- Link handshake (section 1.4) ----------
const withoutSig = (o) => { const { sig, ...rest } = o; return rest; };
export function hs1Make(me, toUid, { kver, pv, ep, rx, now }) {
  const eph = newDhKeys();
  const hs = { k: 'hs1', v: 1, from: me.uid, to: toUid, sid: b64u(randomBytes(12)), e: eph.pub, nA: b64u(randomBytes(16)), ts: now, kver, pv, ep, rx };
  hs.sig = signStr(me.ikPriv, `snug-hs1-v1\n${canon(hs)}`);
  return { hs, eph };
}
export function hs2Make(me, hs1, { kver, pv, ep, rx, now }) {
  const eph = newDhKeys();
  const hs = { k: 'hs2', sid: hs1.sid, e: eph.pub, nB: b64u(randomBytes(16)), ts: now, kver, pv, ep, rx, h1: b64u(sha256(canon(hs1))) };
  hs.sig = signStr(me.ikPriv, `snug-hs2-v1\n${canon(hs)}`);
  return { hs, eph };
}
const rxOk = (rx) => rx && typeof rx === 'object' && (rx.ep === '' || isB64u(rx.ep, 8)) && isInt(rx.upto) && rx.upto >= 0;
// Shape checks only; signatures need the pinned key (hsVerify).
export function hsShape(h) {
  if (!h || typeof h !== 'object' || !isSig(h.sig) || !isKey(h.e) || !isB64u(h.sid, 12) || !isInt(h.ts) || !isInt(h.kver) || !isInt(h.pv) || !isB64u(h.ep, 8) || !rxOk(h.rx)) return false;
  if (h.k === 'hs1') return h.v === 1 && isUid(h.from) && isUid(h.to) && isB64u(h.nA, 16);
  if (h.k === 'hs2') return isB64u(h.nB, 16) && isB64u(h.h1, 32);
  return false;
}
export const hsVerify = (h, ik) => verifyStr(ik, `snug-${h.k}-v1\n${canon(withoutSig(h))}`, h.sig);
export const hs2Binds = (hs2, hs1) => hs2.h1 === b64u(sha256(canon(hs1)));
// Session keys; `role` 'A' sent hs1. Returns { kOut, kIn, dirOut, dirIn }.
export function sessionKeys(role, myEph, theirE, hs1, hs2, uidA, uidB) {
  const keys = hkdf(dh(myEph.priv, theirE), Buffer.concat([unb64u(hs1.nA), unb64u(hs2.nB)]), `snug-link-v1\n${uidA}\n${uidB}\n${hs1.sid}`, 64);
  const kAB = keys.subarray(0, 32), kBA = keys.subarray(32, 64);
  return role === 'A' ? { kOut: kAB, kIn: kBA, dirOut: 1, dirIn: 2 } : { kOut: kBA, kIn: kAB, dirOut: 2, dirIn: 1 };
}
const frameNonce = (dir, n) => { const b = Buffer.alloc(12); b.writeUInt32BE(dir, 0); b.writeBigUInt64BE(BigInt(n), 4); return b; };
export const MAX_COUNTER = 2 ** 32;
// One data frame: P is the canonical inner string; signed then encrypted.
export function frameSeal(sess, sid, ikPriv, P) {
  const n = ++sess.nOut;
  const plain = JSON.stringify({ p: P, s: signStr(ikPriv, `snug-frame-v1\n${sid}\n${P}`) });
  const c = gcmSeal(sess.kOut, frameNonce(sess.dirOut, n), Buffer.from(plain, 'utf8'), sid);
  return JSON.stringify({ k: 'd', s: sid, n, c: b64u(c) });
}
// Returns the parsed inner { t, seq, ts, d } or null (replayed, tampered, wrong session).
export function frameOpen(sess, sid, peerIk, f) {
  if (f.s !== sid || !isInt(f.n) || f.n <= sess.nIn || f.n > MAX_COUNTER || typeof f.c !== 'string') return null;
  let plain;
  try { plain = gcmOpen(sess.kIn, frameNonce(sess.dirIn, f.n), unb64u(f.c), sid).toString('utf8'); } catch { return null; }
  sess.nIn = f.n;
  let o;
  try { o = JSON.parse(plain); } catch { return null; }
  if (!o || typeof o.p !== 'string' || !verifyStr(peerIk, `snug-frame-v1\n${sid}\n${o.p}`, o.s)) return null;
  const P = parseCapped(o.p, 48 * 1024);
  if (!P || typeof P.t !== 'string' || !isInt(P.seq) || P.seq < 0 || !isInt(P.ts)) return null;
  return P;
}

// ---------- Profile snapshot (section 1.5) ----------
export function profileSign(ikPriv, snap) {
  return signStr(ikPriv, `snug-profile-v1\n${snap.uid}\n${snap.kver}\n${snap.ver}\n${canon(snap.p)}`);
}
export function profileVerify(ik, snap, sig) {
  if (!snap || !isUid(snap.uid) || !isInt(snap.kver) || !isInt(snap.ver) || !snap.p || typeof snap.p !== 'object') return false;
  try { return verifyStr(ik, `snug-profile-v1\n${snap.uid}\n${snap.kver}\n${snap.ver}\n${canon(snap.p)}`, sig); } catch { return false; }
}
// (kver, ver) ordering (EPOCH): a key change always wins, then the version.
export const newer = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]);
export const nextVer = (prev, now) => Math.max((prev || 0) + 1, now);

// ---------- Key-change continuity (section 1.6) ----------
export const keychangeStr = (uid, kver, ik, xk) => `snug-keychange-v1\n${uid}\n${kver}\n${ik}\n${xk}`;
export const keychangeSign = (oldIkPriv, uid, kver, ik, xk) => signStr(oldIkPriv, keychangeStr(uid, kver, ik, xk));
// pinned: { kver, ik }; chain: [{kver, ik, xk, prev}] ascending; known: keys seen before ([{kver, ik}]).
// Returns 'same' | 'quiet' | 'loud' | 'downgrade'.
export function chainCheck(uid, pinned, chain, known = []) {
  if (!Array.isArray(chain) || !chain.length) return 'downgrade';
  for (const e of chain) if (!e || !isInt(e.kver) || !isKey(e.ik) || !isKey(e.xk) || (e.prev != null && !isSig(e.prev))) return 'downgrade';
  const cur = chain[chain.length - 1];
  if (cur.kver < pinned.kver) return 'downgrade';
  if (known.some((k) => k.ik === cur.ik && k.kver !== cur.kver)) return 'downgrade';
  if (cur.kver === pinned.kver) return cur.ik === pinned.ik ? 'same' : 'downgrade';
  const start = chain.findIndex((e) => e.kver === pinned.kver);
  if (start < 0 || chain[start].ik !== pinned.ik) return 'loud';
  for (let i = start + 1; i < chain.length; i++) {
    const prevE = chain[i - 1], e = chain[i];
    if (e.kver !== prevE.kver + 1 || !e.prev || !verifyStr(prevE.ik, keychangeStr(uid, e.kver, e.ik, e.xk), e.prev)) return 'loud';
  }
  return 'quiet';
}

// ---------- Ids both PCs agree on ----------
export const dmIdFor = (a, b) => `d_${base32(sha256(`snug-dm-v1\n${a < b ? a : b}\n${a < b ? b : a}`)).slice(0, 24)}`;
export const remoteFileId = (senderUid, fileId) => `f_r${base32(sha256(`${senderUid}\n${fileId}`)).slice(0, 24)}`;
export const remoteMediaId = (uid, hash) => `f_h${base32(sha256(`${uid}\n${hash}`)).slice(0, 24)}`;
export const shadowId = (uid) => `u_${uid}`;
export const randomEp = () => b64u(randomBytes(8));
