// v0.10 vault keys: one random 32-byte key per GitHub account (keyed by ghh, so it survives release,
// re-claim and admin renames). The app encrypts its local data file with it; the registry never sees the
// file. Stored wrapped: k = b64u(iv12 || AES-GCM(wrapKey, key, aad = "snug-vault-key-v1\n" + ghh)),
// wrapKey = HKDF-SHA256(GH_HMAC_SECRET, salt "snug", info "vault-wrap-v1"). Mixed into Hub.prototype.
// POST /v1/vault/key {uid, ts, p:"{}", sig} (op "vault-key"), signed by the current key only.
// sec-registry REG-H1: never the pending move's key. That key has proved GitHub only, which is exactly what
// the 72 h delay and the old PC's Stop button guard against; it gets the key once the move completes.
import { b64u, fromB64u, randomBytes } from './crypto.js';
import { fail, need } from './common.js';
import { DAY } from './limits.js';

const enc = new TextEncoder();
const wrapKeys = new Map(); // secret -> CryptoKey

async function wrapKeyFor(secret, info = 'vault-wrap-v1') {
  const id = `${info}\n${secret}`;
  let k = wrapKeys.get(id);
  if (!k) {
    const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    k = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('snug'), info: enc.encode(info) },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    if (wrapKeys.size > 4) wrapKeys.clear();
    wrapKeys.set(id, k);
  }
  return k;
}
// sec-registry hardening: an optional dedicated secret for wrapping vault keys (VAULT_WRAP_SECRET, 32+
// characters), apart from GH_HMAC_SECRET, which also keys the GitHub id and address HMACs. When it is set,
// new rows are wrapped with it and older rows are re-wrapped as they are read; GH_HMAC_SECRET is never rotated
// and still opens rows not yet re-wrapped. Once set, VAULT_WRAP_SECRET must never change or be removed.
export function wrapSecretOf(env) {
  const s = env.VAULT_WRAP_SECRET;
  return typeof s === 'string' && s.length >= 32 ? s : null;
}

// kid 1 rows keep the AAD they were made with; later kids bind the kid too (sec-registry REG-L1).
const aadFor = (ghh, kid) => enc.encode(kid > 1 ? `snug-vault-key-v1\n${ghh}\n${kid}` : `snug-vault-key-v1\n${ghh}`);

export async function wrapVaultKey(secret, ghh, raw, kid = 1, wrapSecret = null) {
  const iv = randomBytes(12);
  const wk = wrapSecret ? await wrapKeyFor(wrapSecret, 'vault-wrap-v2') : await wrapKeyFor(secret);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(ghh, kid) }, wk, raw,
  ));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}

export async function unwrapVaultKey(secret, ghh, k, kid = 1, wrapSecret = null) {
  return (await unwrapWith(secret, ghh, k, kid, wrapSecret)).raw;
}
/** {raw, legacy}: legacy = opened with GH_HMAC_SECRET although a dedicated wrap secret is set. */
async function unwrapWith(secret, ghh, k, kid, wrapSecret) {
  const b = fromB64u(k);
  if (!b || b.length !== 12 + 32 + 16) throw new Error('vault key row damaged');
  const open = async (wk) => new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: aadFor(ghh, kid) }, wk, b.subarray(12),
  ));
  if (wrapSecret) {
    try { return { raw: await open(await wrapKeyFor(wrapSecret, 'vault-wrap-v2')), legacy: false }; } catch { /* an older row */ }
  }
  return { raw: await open(await wrapKeyFor(secret)), legacy: !!wrapSecret };
}

export const VAULT_SCHEMA = [
  // sec-registry REG-L1: the keys a GitHub account had before a rotation (still wrapped), so its older data
  // files and backups stay readable by its current key; and accounts whose key rotates at its next fetch.
  'CREATE TABLE IF NOT EXISTS vault_keys_old (ghh TEXT NOT NULL, kid INTEGER NOT NULL, k TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (ghh, kid))',
  'CREATE TABLE IF NOT EXISTS vault_rotate (ghh TEXT PRIMARY KEY, at INTEGER NOT NULL)',
];
const KEEP_OLD = 20;

export const VaultKeyMixin = {
  /**
   * POST /v1/vault/key, signed by the current key. p "{}" (0.10.1): the newest key. p {"kid": n}: that key,
   * for an older data file or backup (sec-registry REG-L1).
   */
  async vaultKey(b, ip) {
    this.ipLimit('ipVault', ip);
    const secret = this.secret();
    let ghh = null;
    let want = null;
    let rotate = false;
    let row = await this.signedP(b, 'vault-key', { mutating: false, maxP: 64 }, (acc, d) => {
      if (d.kid !== undefined) {
        need(Number.isSafeInteger(d.kid) && d.kid >= 1);
        want = d.kid;
      }
      if (!this.budgets.take(acc.uid, 'vault', this.L.vaultDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
      ghh = acc.ghh;
      rotate = want === null && !!this.row('SELECT 1 AS x FROM vault_rotate WHERE ghh=?', ghh);
      return this.row('SELECT k, kid FROM vault_keys WHERE ghh=?', ghh);
    });
    const ws = wrapSecretOf(this.env);
    if (want !== null && (!row || want !== row.kid)) {
      const old = this.row('SELECT k, kid FROM vault_keys_old WHERE ghh=? AND kid=?', ghh, want);
      if (!old) fail('not_found');
      const o = await unwrapWith(secret, ghh, old.k, old.kid, ws);
      if (o.legacy) await this.rewrapRow('vault_keys_old', ghh, old, o.raw, ws);
      return { key: b64u(o.raw), kid: old.kid };
    }
    if (!row) {
      const k = await wrapVaultKey(secret, ghh, randomBytes(32), 1, ws);
      // --- synchronous: a concurrent first call may have won; whichever row is stored is the key ---
      this.sql.exec('INSERT OR IGNORE INTO vault_keys(ghh, k, kid, at) VALUES(?,?,1,?)', ghh, k, this.now());
      this.sql.exec('DELETE FROM vault_rotate WHERE ghh=?', ghh);
      row = this.row('SELECT k, kid FROM vault_keys WHERE ghh=?', ghh);
    } else if (rotate) {
      row = await this.rotateVaultKey(ghh);
    }
    const o = await unwrapWith(secret, ghh, row.k, row.kid, ws);
    if (o.legacy) await this.rewrapRow('vault_keys', ghh, row, o.raw, ws);
    return { key: b64u(o.raw), kid: row.kid };
  },
  /** Re-wrap a row read with GH_HMAC_SECRET under the dedicated secret, if nobody changed it meanwhile. */
  async rewrapRow(table, ghh, row, raw, ws) {
    const k = await wrapVaultKey(null, ghh, raw, row.kid, ws);
    // --- synchronous ---
    this.sql.exec(`UPDATE ${table} SET k=? WHERE ghh=? AND kid=? AND k=?`, k, ghh, row.kid, row.k);
  },

  /** POST /v1/vault/rotate {uid, ts, p:"{}", sig} (op "vault-rotate", current key, monotonic ts) -> {kid}. */
  async vaultRotate(b, ip) {
    this.ipLimit('ipVault', ip);
    const ghh = await this.signedP(b, 'vault-rotate', { mutating: true, maxP: 64 }, (acc) => {
      if (!this.budgets.take(acc.uid, 'vaultRot', this.L.vaultRotDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
      return acc.ghh;
    });
    const row = await this.rotateVaultKey(ghh);
    return { kid: row.kid };
  },

  /** A new newest key for ghh; the one before is kept (wrapped) for older files. Returns the new row. */
  async rotateVaultKey(ghh) {
    const secret = this.secret();
    for (let i = 0; i < 3; i++) {
      const cur = this.row('SELECT k, kid, at FROM vault_keys WHERE ghh=?', ghh);
      const kid = (cur?.kid || 0) + 1;
      const k = await wrapVaultKey(secret, ghh, randomBytes(32), kid, wrapSecretOf(this.env));
      // --- synchronous: only if no one rotated meanwhile ---
      const now2 = this.row('SELECT kid FROM vault_keys WHERE ghh=?', ghh);
      if ((now2?.kid || 0) !== (cur?.kid || 0)) continue;
      this.tx(() => {
        if (cur) this.sql.exec('INSERT OR REPLACE INTO vault_keys_old(ghh, kid, k, at) VALUES(?,?,?,?)', ghh, cur.kid, cur.k, cur.at);
        this.sql.exec('INSERT OR REPLACE INTO vault_keys(ghh, k, kid, at) VALUES(?,?,?,?)', ghh, k, kid, this.now());
        this.sql.exec('DELETE FROM vault_keys_old WHERE ghh=? AND kid<=?', ghh, kid - 1 - KEEP_OLD);
        this.sql.exec('DELETE FROM vault_rotate WHERE ghh=?', ghh);
      });
      return this.row('SELECT k, kid FROM vault_keys WHERE ghh=?', ghh);
    }
    return fail('rate_limited', { retryAfter: 1 });
  },
  /** The account's key rotates at its next fetch (a device that held it may be in the wrong hands). */
  markVaultRotate(ghh) {
    if (this.row('SELECT 1 AS x FROM vault_keys WHERE ghh=?', ghh)) {
      this.sql.exec('INSERT OR REPLACE INTO vault_rotate(ghh, at) VALUES(?,?)', ghh, this.now());
    }
  },
};
