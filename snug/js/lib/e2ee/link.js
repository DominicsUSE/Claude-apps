// Adding a device with another one at hand. The trusted device shows a
// one-time code; the person types it on the new device. The server relays
// everything but never sees the code, so it can't vouch for keys it swapped in:
//   Kc   = HKDF-SHA256(code, salt "snug-e2ee-v1/link", info linkId)
//   tag1 = HMAC(Kc, "snug-e2ee-v1/link-b\n" + canon({linkId, u, d, dsk, prekey}))  new device -> trusted one
//   tag2 = HMAC(Kc, "snug-e2ee-v1/link-a\n" + b64u(SHA-256(box)) + "\n" + canon(devlist))  trusted -> new
// One attempt per code and ten minutes per link make guessing 60 bits hopeless.
import { b64u, b64uOf, crockford, normCrockford, equal, random, utf8 } from './bytes.js';
import { canon } from './canon.js';
import { hkdf, hmac, sha256 } from './sig.js';

export const CODE_CHARS = 12;

/** 60 random bits as 12 Crockford base32 characters, shown XXXX-XXXX-XXXX. */
export function newLinkCode() {
  const raw = crockford(random(8)).slice(0, CODE_CHARS);
  return { code: raw, text: raw.match(/.{4}/g).join('-') };
}
/** What someone typed -> the 12-character code, or null. Case, dashes and spaces don't matter; O/I/L read as 0/1/1. */
export function parseLinkCode(text) {
  const s = normCrockford(text);
  return s && s.length === CODE_CHARS ? s : null;
}

export const linkKey = (code, linkId) => hkdf(utf8(code), 'snug-e2ee-v1/link', linkId, 32);

export async function tag1(Kc, { linkId, u, d, dsk, prekey }) {
  return b64u(await hmac(Kc, `snug-e2ee-v1/link-b\n${canon({ linkId, u, d, dsk, prekey })}`));
}
export async function tag2(Kc, box, devlist) {
  return b64u(await hmac(Kc, `snug-e2ee-v1/link-a\n${b64u(await sha256(box))}\n${canon(devlist)}`));
}
export const sameTag = (a, b) => equal(b64uOf(a, 32) || new Uint8Array(0), b64uOf(b, 32) || new Uint8Array(1));
