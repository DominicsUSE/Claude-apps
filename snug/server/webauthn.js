// Passkeys (WebAuthn level 3), checked with node:crypto only (v0.12).
//
// Why not a library: the server only needs "none" attestation and three
// signature algorithms (Ed25519, ES256, RS256), which is a CBOR reader, the
// authenticator data layout and crypto.verify. A library would bring about ten
// packages, mostly for attestation formats Snug never asks for.
//
// What is checked, on both ceremonies: the challenge this server made (single
// use, held by server/passkeys.js), the page origin, the RP ID hash, user
// presence and user verification (PIN or biometric), and the type. On sign-in:
// the signature over authenticatorData || SHA-256(clientDataJSON) with the key
// saved at registration, and the signature counter (a counter that goes
// backwards means a copied authenticator; synced passkeys always say 0).
// The attestation statement is not checked: Snug asks for "none", so it never
// trusts a device maker, and the key is bound to the account by the signed-in
// session that registered it.
import { createHash, createPublicKey, verify as cryptoVerify, constants } from 'node:crypto';
import { isIP } from 'node:net';

export class WebAuthnError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const no = (code) => { throw new WebAuthnError(code); };

export const ALGS = { EDDSA: -8, ES256: -7, RS256: -257 };
const sha256 = (b) => createHash('sha256').update(b).digest();
const B64U = /^[A-Za-z0-9_-]*$/;
export const b64u = (buf) => Buffer.from(buf).toString('base64url');
// base64url text to bytes, or a refusal when it isn't base64url or is too long.
export function unb64u(s, max, code = 'format') {
  if (typeof s !== 'string' || !B64U.test(s) || s.length > Math.ceil((max * 4) / 3) + 2) no(code);
  return Buffer.from(s, 'base64url');
}

// ---------- CBOR (RFC 8949), only what WebAuthn uses ----------
// Integers, byte and text strings, arrays, maps, true/false/null. Definite
// lengths only, at most 16 levels deep, never past the end of the input.
export function cborFirst(buf, start = 0) {
  let i = start;
  const need = (n) => { if (i + n > buf.length) no('cbor'); };
  const item = (depth) => {
    if (depth > 16) no('cbor');
    need(1);
    const b = buf[i++];
    const major = b >> 5, info = b & 31;
    let n;
    if (info < 24) n = info;
    else if (info === 24) { need(1); n = buf[i]; i += 1; }
    else if (info === 25) { need(2); n = buf.readUInt16BE(i); i += 2; }
    else if (info === 26) { need(4); n = buf.readUInt32BE(i); i += 4; }
    else if (info === 27) { need(8); const v = buf.readBigUInt64BE(i); i += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) no('cbor'); n = Number(v); }
    else no('cbor'); // indefinite lengths and reserved values
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { need(n); const v = buf.subarray(i, i + n); i += n; return Buffer.from(v); }
      case 3: { need(n); const v = buf.toString('utf8', i, i + n); i += n; return v; }
      case 4: { if (n > 1024) no('cbor'); const a = []; for (let k = 0; k < n; k++) a.push(item(depth + 1)); return a; }
      case 5: {
        if (n > 256) no('cbor');
        const m = new Map();
        for (let k = 0; k < n; k++) {
          const key = item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') no('cbor');
          if (m.has(key)) no('cbor');
          m.set(key, item(depth + 1));
        }
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        return no('cbor'); // floats and undefined: never in WebAuthn data Snug reads
      default: return no('cbor'); // tags
    }
  };
  const value = item(0);
  return { value, end: i };
}
export function cborDecode(buf) {
  const { value, end } = cborFirst(buf, 0);
  if (end !== buf.length) no('cbor');
  return value;
}

// ---------- Authenticator data (WebAuthn 6.1) ----------
export const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };
export function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) no('authdata');
  const f = buf[32];
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags: { up: !!(f & FLAGS.UP), uv: !!(f & FLAGS.UV), be: !!(f & FLAGS.BE), bs: !!(f & FLAGS.BS), at: !!(f & FLAGS.AT), ed: !!(f & FLAGS.ED) },
    counter: buf.readUInt32BE(33),
  };
  let i = 37;
  if (out.flags.at) {
    if (buf.length < i + 18) no('authdata');
    out.aaguid = buf.subarray(i, i + 16);
    const len = buf.readUInt16BE(i + 16);
    i += 18;
    if (len < 16 || len > 1023 || buf.length < i + len) no('authdata');
    out.credId = Buffer.from(buf.subarray(i, i + len));
    i += len;
    const { value, end } = cborFirst(buf, i);
    if (!(value instanceof Map)) no('key');
    out.coseKey = value;
    i = end;
  }
  if (out.flags.ed) {
    const { value, end } = cborFirst(buf, i);
    if (!(value instanceof Map)) no('authdata');
    i = end;
  }
  if (i !== buf.length) no('authdata');
  return out;
}

// ---------- COSE keys (RFC 9053) to JWK ----------
export function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  const bytes = (k, len) => { const v = m.get(k); if (!Buffer.isBuffer(v) || (len && v.length !== len)) no('key'); return b64u(v); };
  let jwk;
  if (alg === ALGS.ES256) {
    if (kty !== 2 || m.get(-1) !== 1) no('key');
    jwk = { kty: 'EC', crv: 'P-256', x: bytes(-2, 32), y: bytes(-3, 32) };
  } else if (alg === ALGS.EDDSA) {
    if (kty !== 1 || m.get(-1) !== 6) no('key');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: bytes(-2, 32) };
  } else if (alg === ALGS.RS256) {
    if (kty !== 3) no('key');
    jwk = { kty: 'RSA', n: bytes(-1), e: bytes(-2) };
    if (Buffer.from(jwk.n, 'base64url').length < 256) no('key'); // at least 2048 bits
  } else no('alg');
  try { createPublicKey({ key: jwk, format: 'jwk' }); } catch { no('key'); } // a point not on the curve, a bad modulus
  return { jwk, alg };
}

function verifySig(alg, jwk, data, sig) {
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  try {
    if (alg === ALGS.ES256) return cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, sig);
    if (alg === ALGS.RS256) return cryptoVerify('sha256', data, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
    if (alg === ALGS.EDDSA) return cryptoVerify(null, data, key, sig);
  } catch { return false; }
  return false;
}

// clientDataJSON: the type, this server's challenge, an origin it expects, and not from inside another site's frame.
function clientData(raw, { type, challenge, origins }) {
  let c;
  try { c = JSON.parse(raw.toString('utf8')); } catch { no('client'); }
  if (!c || c.type !== type) no('type');
  if (typeof c.challenge !== 'string' || c.challenge !== challenge) no('challenge');
  if (!origins.includes(c.origin)) no('origin');
  if (c.crossOrigin === true || c.topOrigin !== undefined) no('origin');
  return c;
}

function common(credential) {
  if (!credential || typeof credential !== 'object' || credential.type !== 'public-key' || !credential.response || typeof credential.response !== 'object') no('format');
  const id = unb64u(credential.id, 1023);
  if (id.length < 16 || (credential.rawId !== undefined && credential.rawId !== credential.id)) no('format');
  return { id, r: credential.response };
}

/**
 * A new passkey. Returns { id (base64url), jwk, alg, counter, backedUp, transports }.
 * `origins`: the page origins this server accepts; `rpId`: its RP ID.
 */
export function verifyRegistration({ credential, challenge, origins, rpId, algs = [ALGS.EDDSA, ALGS.ES256, ALGS.RS256] }) {
  const { id, r } = common(credential);
  const cdRaw = unb64u(r.clientDataJSON, 4096);
  clientData(cdRaw, { type: 'webauthn.create', challenge, origins });
  const att = cborDecode(unb64u(r.attestationObject, 16384));
  if (!(att instanceof Map) || typeof att.get('fmt') !== 'string' || !Buffer.isBuffer(att.get('authData'))) no('format');
  const ad = parseAuthData(att.get('authData'));
  if (!ad.rpIdHash.equals(sha256(rpId))) no('rpid');
  if (!ad.flags.up) no('presence');
  if (!ad.flags.uv) no('verification');
  if (!ad.flags.at || !ad.credId.equals(id)) no('format');
  if (ad.flags.bs && !ad.flags.be) no('authdata'); // "backed up" without "can be backed up" is invalid
  const { jwk, alg } = coseToJwk(ad.coseKey);
  if (!algs.includes(alg)) no('alg');
  const transports = Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === 'string' && /^[a-z-]{1,20}$/.test(t)).slice(0, 8) : [];
  return { id: b64u(id), jwk, alg, counter: ad.counter, backedUp: ad.flags.bs, transports };
}

/**
 * A sign-in with a saved passkey ({ jwk, alg, counter }). Returns { counter, backedUp }.
 * Throws 'counter' when the authenticator's counter did not go up (a copied authenticator).
 */
export function verifyAuthentication({ credential, challenge, origins, rpId, passkey }) {
  const { id, r } = common(credential);
  if (b64u(id) !== passkey.id) no('format');
  const cdRaw = unb64u(r.clientDataJSON, 4096);
  clientData(cdRaw, { type: 'webauthn.get', challenge, origins });
  const adRaw = unb64u(r.authenticatorData, 4096);
  const ad = parseAuthData(adRaw);
  if (!ad.rpIdHash.equals(sha256(rpId))) no('rpid');
  if (!ad.flags.up) no('presence');
  if (!ad.flags.uv) no('verification');
  if (ad.flags.at) no('authdata');
  const sig = unb64u(r.signature, 1024);
  if (!verifySig(passkey.alg, passkey.jwk, Buffer.concat([adRaw, sha256(cdRaw)]), sig)) no('signature');
  // Checked after the signature, so only the real authenticator (or a copy of it) can trip it.
  if ((ad.counter !== 0 || passkey.counter !== 0) && ad.counter <= passkey.counter) no('counter');
  return { counter: ad.counter, backedUp: ad.flags.bs };
}

// ---------- Where passkeys work ----------
// WebAuthn needs a secure context (https, or http://localhost) and an RP ID that is
// a domain equal to, or a parent of, the page's host; never an IP address. The RP ID
// is never taken from the Host header on its own: it comes from SNUG_RP_ID, the only
// SNUG_HOSTS name, or "localhost" on a server that only listens on this machine, and
// the request's host must sit inside it.
export const PLACE_WORDS = {
  desktop: 'Passkeys aren’t used in the desktop app: it signs you in on this PC by itself.',
  insecure: 'Passkeys need this server to use HTTPS with a domain name.',
  setup: 'Passkeys aren’t set up on this server yet. Whoever runs it can set SNUG_HOSTS (or SNUG_RP_ID) to its domain name.',
};
export function passkeyPlace({ host, https = false, rpId = null, hosts = null, loopback = false, desktop = false, extraOrigins = [] }) {
  const off = (why) => ({ ok: false, why, message: PLACE_WORDS[why] });
  if (desktop) return off('desktop');
  let name;
  try { name = new URL(`http://${String(host || '')}`).hostname.toLowerCase(); } catch { return off('insecure'); }
  if (!name || isIP(name.replace(/^\[|\]$/g, ''))) return off('insecure');
  if (!https && name !== 'localhost') return off('insecure');
  const clean = (h) => String(h).trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  let rp;
  if (rpId) rp = clean(rpId);
  else if (hosts?.length === 1) rp = clean(hosts[0]);
  else if (!hosts?.length && loopback && name === 'localhost') rp = 'localhost';
  else return off('setup');
  if (!rp || isIP(rp) || !(name === rp || name.endsWith(`.${rp}`))) return off('setup');
  const origin = `${https ? 'https' : 'http'}://${String(host).toLowerCase()}`;
  const inside = (o) => { try { const h = new URL(o).hostname.toLowerCase(); return h === rp || h.endsWith(`.${rp}`); } catch { return false; } };
  return { ok: true, rpId: rp, origins: [...new Set([origin, ...extraOrigins.filter(inside)])] };
}
