// Safety numbers: libsignal's NumericFingerprintGenerator (version 0 hashing,
// 5200 iterations), over each person's account identity key and their user id
// on this server. Built from account keys only, so adding or removing a device
// doesn't change it; a reset (new account key) does.
//
// Per person: h = SHA-512(0x0000 ‖ key ‖ id ‖ key), then 5199 more rounds of
// h = SHA-512(h ‖ key). The first 30 bytes become six 5-digit numbers. The two
// people's 30 digits are joined smaller first, so both see the same 60 digits.
// tests/logic-e2ee.test.js checks this against libsignal's published vectors.
import { concat, utf8 } from './bytes.js';
import { sha512 } from './sig.js';

export const ITERATIONS = 5200;

export async function fingerprintHash(key, id, iterations = ITERATIONS) {
  const idBytes = typeof id === 'string' ? utf8(id) : id;
  let h = await sha512(concat(new Uint8Array([0, 0]), key, idBytes, key));
  for (let i = 1; i < iterations; i++) h = await sha512(concat(h, key));
  return h;
}

export function digits30(h) {
  let s = '';
  for (let i = 0; i < 30; i += 5) {
    let n = 0n;
    for (let j = 0; j < 5; j++) n = (n << 8n) | BigInt(h[i + j]);
    s += String(n % 100000n).padStart(5, '0');
  }
  return s;
}

/** 60 digits for two people, each { id, key } (key: raw account key bytes). Same answer either way round. */
export async function safetyNumber(a, b, iterations = ITERATIONS) {
  const [x, y] = await Promise.all([a, b].map(async (p) => digits30(await fingerprintHash(p.key, p.id, iterations))));
  return x < y ? x + y : y + x;
}

/** "12345 67890 …": 12 groups of 5, as people read them aloud. */
export const groupsOf5 = (s) => s.match(/\d{5}/g) || [];
