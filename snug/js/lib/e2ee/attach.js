// Encrypted attachments: the whole file sealed once with AES-256-GCM under a
// fresh random key and nonce. The key, nonce and a SHA-256 of the ciphertext
// travel inside the encrypted message; the server only ever stores the
// ciphertext. Snug files are at most 10 MB and are read whole anyway, so there
// is no chunking.
//
// Padding (0.14): where every device in the conversation can read it, the file
// is sealed as [version 1][length, 4 bytes][the file][zeros] grown to a size
// bucket (padBucket), so the server sees roughly how big a file is, not its
// exact size. The message says so (`p: 1`); files from before open as they were.
// A bucket is never bigger than the server's file limit (`max`): a file near the limit is padded to the
// limit itself, and one too close for the 5-byte header is sealed unpadded, so padding never stops an upload.
import { b64u, b64uOf, equal, random, utf8 } from './bytes.js';
import { aesSeal, aesOpen, sha256 } from './sig.js';

const AAD = utf8('snug-e2ee-v1/file');
const HEAD = 5;

/** The padded size for a plaintext of n bytes: 4 KiB steps up to 64 KiB, then steps of 1.25x (4 KiB aligned). */
export function padBucket(n) {
  if (n <= 65536) return Math.max(4096, Math.ceil(n / 4096) * 4096);
  let s = 65536;
  while (s < n) s = Math.ceil((s * 1.25) / 4096) * 4096;
  return s;
}
/** Every size padBucket gives up to `max` (for tests and the docs). */
export function padBuckets(max) {
  const out = [];
  for (let s = 4096; s <= max; s = padBucket(s + 1)) out.push(s);
  return out;
}
/** AES-GCM adds a 16-byte tag: the ciphertext of a padded file is its bucket plus 16. */
export const TAG = 16;

function padded(bytes, max) {
  if (bytes.length > 0xffffffff) throw new Error('file too large');
  const out = new Uint8Array(Math.min(padBucket(bytes.length + HEAD), max));
  out[0] = 1;
  new DataView(out.buffer).setUint32(1, bytes.length);
  out.set(bytes, HEAD);
  return out;
}

/**
 * bytes -> { ct, meta: { k, n, csha[, p] } } (meta values are b64u, ready for the message body).
 * pad: grow to a bucket, at most `max` bytes before the tag (the server's file limit).
 */
export async function encryptFile(bytes, { pad = false, max = Infinity } = {}) {
  if (pad && bytes.length + HEAD > max) pad = false;
  const k = random(32), n = random(12);
  const ct = await aesSeal(k, n, pad ? padded(bytes, max) : bytes, AAD);
  return { ct, meta: { k: b64u(k), n: b64u(n), csha: b64u(await sha256(ct)), ...(pad ? { p: 1 } : {}) } };
}

/** Throws if the ciphertext was changed (hash first, then the AEAD tag). */
export async function decryptFile(ct, meta) {
  const k = b64uOf(meta?.k, 32), n = b64uOf(meta?.n, 12), csha = b64uOf(meta?.csha, 32);
  if (!k || !n || !csha) throw new Error('file key missing');
  if (!equal(await sha256(ct), csha)) throw new Error('file changed');
  const pt = await aesOpen(k, n, ct, AAD);
  if (meta.p === undefined) return pt;
  if (meta.p !== 1 || pt.length < HEAD || pt[0] !== 1) throw new Error('file padding');
  const len = new DataView(pt.buffer, pt.byteOffset, pt.length).getUint32(1);
  if (HEAD + len > pt.length || pt.subarray(HEAD + len).some((b) => b !== 0)) throw new Error('file padding');
  return pt.slice(HEAD, HEAD + len);
}
