// The recovery key (v0.12): one secret that proves an account is yours without email.
// 20 random bytes R, shown once as 32 RFC 4648 base32 characters plus 4 check characters,
// in 9 groups of 4: ABCD-EFGH-...-WXYZ. Works in the browser and in Node (WebCrypto only).
//
// R itself never leaves the device. What is derived from it, with HKDF-SHA256 and salt
// "snug-recovery", depends on the use (a server only ever sees the first):
//   authKey  info "web-auth-v2\n<host>" sent to a host server, which keeps only a slow hash of it. <host>
//            is the page's host name (location.hostname), so a server's owner can't replay what people
//            send it on another server where the same key was saved (v0.12 review, second pass).
//            "web-auth-v1" (no host) is what 0.12.0 saved; it is sent alongside only to use such a key.
//   p2pSeed  info "p2p-rk-ed25519-v1"   seed of the Ed25519 key a desktop account is recovered with
//   backup   info "e2ee-backup-v1"      the end-to-end encryption backup key (js/lib/e2ee)
// None of them can be computed from another.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SALT = 'snug-recovery';
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

function base32(bytes) {
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  const out = [];
  let acc = 0, bits = 0;
  for (const ch of text) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
  }
  return new Uint8Array(out);
}

// The first 20 bits of SHA-256("snug-recovery-check-v1" || R), as 4 base32 characters.
async function checkChars(raw) {
  const tag = enc.encode('snug-recovery-check-v1');
  const buf = new Uint8Array(tag.length + raw.length);
  buf.set(tag); buf.set(raw, tag.length);
  const h = new Uint8Array(await subtle().digest('SHA-256', buf));
  const n = (h[0] << 12) | (h[1] << 4) | (h[2] >>> 4); // 20 bits
  let s = '';
  for (let i = 3; i >= 0; i--) s += B32[(n >>> (i * 5)) & 31];
  return s;
}

const group = (s) => s.match(/.{1,4}/g).join('-');

/** A new recovery key: { raw: Uint8Array(20), text: 'ABCD-...' } */
export async function newRecoveryKey() {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(20));
  return { raw, text: await formatRecoveryKey(raw) };
}

/** The 36-character text, grouped, for 20 raw bytes. */
export async function formatRecoveryKey(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 20) throw new TypeError('recovery key: 20 bytes');
  return group(base32(raw) + await checkChars(raw));
}

export const RECOVERY_ERRORS = {
  length: 'A recovery key has 36 letters and numbers, in 9 groups of 4.',
  chars: 'A recovery key only has the letters A to Z and the numbers 2 to 7.',
  check: 'One of the groups looks wrong. Check each one against your saved key.',
};

/**
 * Typed text -> { raw } or { error: 'length' | 'chars' | 'check', message }.
 * Case, spaces and dashes don't matter; 0, 1 and 8 are read as O, I and B (common misreads).
 */
export async function parseRecoveryKey(text) {
  const s = String(text || '').toUpperCase().replace(/[\s-]+/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  const fail = (error) => ({ error, message: RECOVERY_ERRORS[error] });
  if (s.length !== 36) return fail('length');
  if (!/^[A-Z2-7]+$/.test(s)) return fail('chars');
  const raw = unbase32(s.slice(0, 32));
  if (!raw || raw.length !== 20) return fail('chars');
  if (await checkChars(raw) !== s.slice(32)) return fail('check');
  return { raw };
}

async function hkdf(raw, info, length = 32) {
  const key = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT), info: enc.encode(info) }, key, length * 8);
  return new Uint8Array(bits);
}

/** What a 0.12.0 host server saw (no host name): still sent to use a key saved then. */
export const deriveAuthKey = (raw) => hkdf(raw, 'web-auth-v1');
/** What a host server may see, bound to its host name (lower case, as location.hostname): it stores only a slow hash. */
export const deriveAuthKeyV2 = (raw, host) => hkdf(raw, `web-auth-v2\n${String(host).toLowerCase()}`);
/** Seed of a desktop account's Ed25519 recovery key pair. */
export const deriveP2pSeed = (raw) => hkdf(raw, 'p2p-rk-ed25519-v1');
/** The end-to-end encryption backup key. */
export const deriveBackupKey = (raw) => hkdf(raw, 'e2ee-backup-v1');

/** The text of the file a person saves. */
export function recoveryFileText({ text, username, date = new Date() }) {
  return [
    'Snug recovery key',
    '',
    text,
    '',
    `Account: @${username}`,
    `Made: ${date.toISOString().slice(0, 10)}`,
    '',
    'This key lets you back into your account, and opens your encrypted messages, if you',
    'forget your password or lose this device. Snug can’t reset this key for you.',
    'Keep it somewhere safe and off this device. Anyone who has it can get into your account.',
    '',
  ].join('\n');
}
