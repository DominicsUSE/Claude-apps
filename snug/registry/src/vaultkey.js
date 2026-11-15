// v0.10 vault keys: one random 32-byte key per GitHub account (keyed by ghh, so it survives release,
// re-claim and admin renames). The app encrypts its local data file with it; the registry never sees the
// file. Stored wrapped: k = b64u(iv12 || AES-GCM(wrapKey, key, aad = "snug-vault-key-v1\n" + ghh)),
// wrapKey = HKDF-SHA256(GH_HMAC_SECRET, salt "snug", info "vault-wrap-v1"). Mixed into Hub.prototype.
// POST /v1/vault/key {uid, ts, p:"{}", sig} (op "vault-key"), signed by the current or the pending key.
import { b64u, fromB64u, randomBytes } from './crypto.js';
import { fail } from './common.js';
import { DAY } from './limits.js';

const enc = new TextEncoder();
const wrapKeys = new Map(); // secret -> CryptoKey

async function wrapKeyFor(secret) {
  let k = wrapKeys.get(secret);
  if (!k) {
    const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    k = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('snug'), info: enc.encode('vault-wrap-v1') },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    if (wrapKeys.size > 4) wrapKeys.clear();
    wrapKeys.set(secret, k);
  }
  return k;
}

export async function wrapVaultKey(secret, ghh, raw) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`snug-vault-key-v1\n${ghh}`) }, await wrapKeyFor(secret), raw,
  ));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}

export async function unwrapVaultKey(secret, ghh, k) {
  const b = fromB64u(k);
  if (!b || b.length !== 12 + 32 + 16) throw new Error('vault key row damaged');
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: enc.encode(`snug-vault-key-v1\n${ghh}`) },
    await wrapKeyFor(secret), b.subarray(12),
  );
  return new Uint8Array(raw);
}

export const VaultKeyMixin = {
  async vaultKey(b, ip) {
    this.ipLimit('ipVault', ip);
    const secret = this.secret();
    let ghh = null;
    let row = await this.signedP(b, 'vault-key', { mutating: false, pending: true, maxP: 64 }, (acc) => {
      if (!this.budgets.take(acc.uid, 'vault', this.L.vaultDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
      ghh = acc.ghh;
      return this.row('SELECT k, kid FROM vault_keys WHERE ghh=?', ghh);
    });
    if (!row) {
      const k = await wrapVaultKey(secret, ghh, randomBytes(32));
      // --- synchronous: a concurrent first call may have won; whichever row is stored is the key ---
      this.sql.exec('INSERT OR IGNORE INTO vault_keys(ghh, k, kid, at) VALUES(?,?,1,?)', ghh, k, this.now());
      row = this.row('SELECT k, kid FROM vault_keys WHERE ghh=?', ghh);
    }
    const raw = await unwrapVaultKey(secret, ghh, row.k);
    return { key: b64u(raw), kid: row.kid };
  },
};
