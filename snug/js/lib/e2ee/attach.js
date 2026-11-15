// Encrypted attachments: the whole file sealed once with AES-256-GCM under a
// fresh random key and nonce. The key, nonce and a SHA-256 of the ciphertext
// travel inside the encrypted message; the server only ever stores the
// ciphertext. Snug files are at most 10 MB and are read whole anyway, so there
// is no chunking.
import { b64u, b64uOf, equal, random, utf8 } from './bytes.js';
import { aesSeal, aesOpen, sha256 } from './sig.js';

const AAD = utf8('snug-e2ee-v1/file');

/** bytes -> { ct, meta: { k, n, csha } } (meta values are b64u, ready for the message body). */
export async function encryptFile(bytes) {
  const k = random(32), n = random(12);
  const ct = await aesSeal(k, n, bytes, AAD);
  return { ct, meta: { k: b64u(k), n: b64u(n), csha: b64u(await sha256(ct)) } };
}

/** Throws if the ciphertext was changed (hash first, then the AEAD tag). */
export async function decryptFile(ct, meta) {
  const k = b64uOf(meta?.k, 32), n = b64uOf(meta?.n, 12), csha = b64uOf(meta?.csha, 32);
  if (!k || !n || !csha) throw new Error('file key missing');
  if (!equal(await sha256(ct), csha)) throw new Error('file changed');
  return aesOpen(k, n, ct, AAD);
}
