// WebCrypto-only helpers (run unchanged in workerd and in Node 22).

const enc = new TextEncoder();

export function b64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url (no padding) decode; returns null on anything malformed. */
export function fromB64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return b64u(out) === s ? out : null; // rejects non-canonical trailing bits
  } catch {
    return null;
  }
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(str) {
  return hex(await crypto.subtle.digest('SHA-256', typeof str === 'string' ? enc.encode(str) : str));
}

const hmacKeys = new Map(); // secret -> CryptoKey (one or two entries in practice)
export async function hmacHex(secret, msg) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (hmacKeys.size > 4) hmacKeys.clear();
    hmacKeys.set(secret, key);
  }
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

const edKeys = new Map(); // ik (b64u) -> CryptoKey, bounded LRU
const ED_CACHE = 1000;

/** Verify an Ed25519 signature (b64u, 86 chars) by raw public key `ik` (b64u, 43 chars) over a UTF-8 string. */
export async function verifyEd25519(ik, sig, msg) {
  const sigBytes = fromB64u(sig);
  if (!sigBytes || sigBytes.length !== 64) return false;
  let key = edKeys.get(ik);
  try {
    if (!key) {
      const raw = fromB64u(ik);
      if (!raw || raw.length !== 32) return false;
      key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    } else edKeys.delete(ik);
    edKeys.set(ik, key);
    if (edKeys.size > ED_CACHE) edKeys.delete(edKeys.keys().next().value);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, enc.encode(msg));
  } catch {
    return false;
  }
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Random id from `alphabet` (default base32 lower: a-z2-7), unbiased. */
export function randomId(len = 16, alphabet = 'abcdefghijklmnopqrstuvwxyz234567') {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}
