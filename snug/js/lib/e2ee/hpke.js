// HPKE (RFC 9180), base mode, one fixed suite: DHKEM(X25519, HKDF-SHA256),
// HKDF-SHA256, AES-256-GCM (0x0020 / 0x0001 / 0x0002). It seals a 32-byte
// message key to one device prekey or history key. The HPKE itself is the
// vendored @hpke/core (vendor/hpke, see server/tools/vendor-hpke.mjs), which
// uses the platform's own X25519; only the files this suite needs are loaded.
import { CipherSuiteNative } from '../../../vendor/hpke/core/src/cipherSuiteNative.js';
import { DhkemX25519HkdfSha256 } from '../../../vendor/hpke/core/src/kems/dhkemX25519.js';
import { Aes256Gcm } from '../../../vendor/hpke/core/src/aeads/aesGcm.js';
import { HkdfSha256Native } from '../../../vendor/hpke/common/mod.js';
import { concat, utf8, u8 } from './bytes.js';

export const suite = new CipherSuiteNative({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256Native(), aead: new Aes256Gcm() });
export const ENC_LEN = 32;
const bytes = (x) => (typeof x === 'string' ? utf8(x) : x);

const importPub = (raw) => globalThis.crypto.subtle.importKey('raw', raw, { name: 'X25519' }, true, []);

/** enc ‖ ct for `pt` sealed to the raw 32-byte X25519 public key `pub`. */
export async function sealKey(pub, info, aad, pt) {
  const { ct, enc } = await suite.seal({ recipientPublicKey: await importPub(pub), info: bytes(info) }, pt, bytes(aad));
  return concat(u8(enc), u8(ct));
}

/**
 * Opens a blob made by sealKey with the recipient's CryptoKeyPair. Always the
 * pair, not just the private key: given only the private key the library
 * re-derives the public one, which a non-extractable key can't do.
 * Throws if anything (key, info, aad, enc or ct) is wrong.
 */
export async function openKey(pair, info, aad, blob) {
  if (!(blob instanceof Uint8Array) || blob.length <= ENC_LEN + 16) throw new Error('short wrap');
  const pt = await suite.open({ recipientKey: pair, enc: blob.slice(0, ENC_LEN), info: bytes(info) }, blob.slice(ENC_LEN), bytes(aad));
  return u8(pt);
}
