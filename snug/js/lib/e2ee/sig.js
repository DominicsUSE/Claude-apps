// WebCrypto helpers for end-to-end encryption: Ed25519 keys and signatures,
// SHA-2, HKDF, HMAC and AES-256-GCM. Browser and Node alike; no curve code of
// our own. Every signature covers "snug-e2ee-v1/<type>\n" + canonical JSON, so
// a signature made for one purpose can't be replayed as another (and none of
// them can pass for a P2P signature, which uses other prefixes).
import { canon, unsigned } from './canon.js';
import { utf8, b64u, b64uOf } from './bytes.js';

const subtle = () => globalThis.crypto.subtle;
export const PREFIX = 'snug-e2ee-v1/';

export const sha256 = async (b) => new Uint8Array(await subtle().digest('SHA-256', b));
export const sha512 = async (b) => new Uint8Array(await subtle().digest('SHA-512', b));

export async function hkdf(ikm, salt, info, len = 32) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const enc = (x) => (typeof x === 'string' ? utf8(x) : x);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc(salt), info: enc(info) }, key, len * 8));
}

export async function hmac(keyBytes, data) {
  const key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', key, typeof data === 'string' ? utf8(data) : data));
}

// AES-256-GCM with a raw 32-byte key and a 12-byte nonce.
async function aesKey(raw, use) { return subtle().importKey('raw', raw, 'AES-GCM', false, [use]); }
export async function aesSeal(raw, nonce, pt, aad) {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await aesKey(raw, 'encrypt'), pt));
}
/** Throws when the key, nonce, associated data or ciphertext is wrong. */
export async function aesOpen(raw, nonce, ct, aad) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await aesKey(raw, 'decrypt'), ct));
}

// Ed25519. Device keys are made non-extractable: script on the page can use
// them but not copy them out. Account keys are made extractable only long
// enough to put them in the account secret bundle.
export const newSigningPair = (extractable = false) => subtle().generateKey({ name: 'Ed25519' }, extractable, ['sign', 'verify']);
export const rawPublic = async (pub) => new Uint8Array(await subtle().exportKey('raw', pub));
export const pkcs8Of = async (priv) => new Uint8Array(await subtle().exportKey('pkcs8', priv));
export const importSigning = (pkcs8, extractable = false) => subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, extractable, ['sign']);
export const importVerify = (raw) => subtle().importKey('raw', raw, { name: 'Ed25519' }, true, ['verify']);

export const signBytes = async (priv, data) => new Uint8Array(await subtle().sign({ name: 'Ed25519' }, priv, data));
/** False (never a throw) for a malformed key or signature. */
export async function verifyBytes(pubRaw, sig, data) {
  try {
    if (!(pubRaw instanceof Uint8Array) || pubRaw.length !== 32 || !(sig instanceof Uint8Array) || sig.length !== 64) return false;
    return await subtle().verify({ name: 'Ed25519' }, await importVerify(pubRaw), sig, data);
  } catch { return false; }
}

export const signedText = (t, obj) => utf8(`${PREFIX}${t}\n${canon(unsigned(obj))}`);
export async function signObject(priv, t, obj) {
  return { ...unsigned(obj), sig: b64u(await signBytes(priv, signedText(t, obj))) };
}
export async function verifyObject(pubRaw, t, obj) {
  if (!obj || typeof obj !== 'object') return false;
  const sig = b64uOf(obj.sig, 64);
  if (!sig) return false;
  try { return await verifyBytes(pubRaw, sig, signedText(t, obj)); } catch { return false; }
}

// X25519 key pairs (device prekeys and history keys). The private half only
// ever derives bits; its public half is always exportable.
export const newDhPair = (extractable = false) => subtle().generateKey({ name: 'X25519' }, extractable, ['deriveBits']);
export async function importDhPair(pkcs8, pubRaw, extractable = false) {
  const privateKey = await subtle().importKey('pkcs8', pkcs8, { name: 'X25519' }, extractable, ['deriveBits']);
  const publicKey = await subtle().importKey('raw', pubRaw, { name: 'X25519' }, true, []);
  return { privateKey, publicKey };
}
