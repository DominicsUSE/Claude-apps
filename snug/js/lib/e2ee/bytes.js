// Byte helpers for end-to-end encryption, the same in the browser and in Node
// (no Buffer): base64url without padding, UTF-8, joining, a compare that takes
// the same time wherever the first difference is, and base32 (RFC 4648 for
// device ids, Crockford for the one-time code people type).

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s) => te.encode(String(s));
export const fromUtf8 = (b) => td.decode(b);

export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function b64u(bytes) {
  const b = u8(bytes);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) out += B64[(n >> 6) & 63];
    if (i + 2 < b.length) out += B64[n & 63];
  }
  return out;
}

/** base64url (no padding) -> bytes, or null for anything else (padding, other alphabets, stray bits). */
export function unb64u(text) {
  if (typeof text !== 'string' || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0, bits = 0, at = 0;
  for (const ch of text) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) return null;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 255; }
  }
  if (acc & ((1 << bits) - 1)) return null; // leftover bits must be zero: one text per byte string
  return out;
}

/** base64url of exactly `len` bytes, or null. */
export function b64uOf(text, len) {
  const b = unb64u(text);
  return b && (len === undefined || b.length === len) ? b : null;
}

/** Equal length and bytes, in time that doesn't depend on where they differ. */
export function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function base32With(alphabet, bytes) {
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += alphabet[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}
export const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const base32 = (bytes) => base32With(RFC4648, bytes);
export const crockford = (bytes) => base32With(CROCKFORD, bytes);

/** Typed Crockford text -> its canonical form (I, L -> 1; O -> 0; no U; dashes and spaces ignored), or null. */
export function normCrockford(text) {
  const s = String(text || '').toUpperCase().replace(/[\s-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]*$/.test(s) ? s : null;
}
