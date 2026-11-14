// This PC's device keys (design section 1.2) and who it is on the registry
// (peer_self). The private keys stay in the local server (Electron main):
// they never reach the renderer.
//
// <dataDir>/identity.json = { v: 1, enc: 'safeStorage' | 'none', blob, created }
// blob is the JSON { ik_priv_pkcs8_b64, xk_priv_pkcs8_b64 }, wrapped with the
// keyStore (Electron safeStorage) when it is available at the time of writing.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  newSigningKeys, newDhKeys, privToPkcs8, privFromPkcs8, pubOf, signStr, fingerprint as fp,
} from './peercrypto.js';
import { migratePeer, selfStore } from './peerdb.js';

const sleepSync = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* a few ms, Windows rename retry only */ } };
function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i >= 3 || !['EPERM', 'EBUSY'].includes(e.code)) throw e;
      sleepSync(50); // F13: Windows antivirus can hold the file a moment
    }
  }
}

export function createIdentity({ dataDir, keyStore = null, db }) {
  migratePeer(db);
  const store = selfStore(db);
  const memory = dataDir === ':memory:';
  const file = memory ? null : join(dataDir, 'identity.json');
  let keys = null;       // { ikPriv, xkPriv, ik, xk }
  let enc = 'none';

  const available = () => { try { return !!keyStore?.available?.(); } catch { return false; } };

  function save(k) {
    enc = 'none';
    if (memory) return;
    const plain = JSON.stringify({ ik_priv_pkcs8_b64: privToPkcs8(k.ikPriv), xk_priv_pkcs8_b64: privToPkcs8(k.xkPriv) });
    let blob = Buffer.from(plain, 'utf8').toString('base64');
    if (available()) {
      try { blob = keyStore.encrypt(plain); enc = 'safeStorage'; } catch { enc = 'none'; } // encryptString throws under xvfb
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeAtomic(file, JSON.stringify({ v: 1, enc, blob, created: Date.now() }));
  }
  const fromPriv = (ikPriv, xkPriv) => ({ ikPriv, xkPriv, ik: pubOf(ikPriv), xk: pubOf(xkPriv) });
  function make() {
    const s = newSigningKeys(), x = newDhKeys();
    const k = fromPriv(s.priv, x.priv);
    save(k);
    return k;
  }
  function load() {
    if (keys) return keys;
    if (memory || !existsSync(file)) return null;
    try {
      const f = JSON.parse(readFileSync(file, 'utf8'));
      if (f.v !== 1) throw new Error('version');
      const plain = f.enc === 'safeStorage' ? keyStore.decrypt(f.blob) : Buffer.from(f.blob, 'base64').toString('utf8');
      const j = JSON.parse(plain);
      keys = fromPriv(privFromPkcs8(j.ik_priv_pkcs8_b64), privFromPkcs8(j.xk_priv_pkcs8_b64));
      enc = f.enc === 'safeStorage' ? 'safeStorage' : 'none';
      return keys;
    } catch {
      // Another OS user, a wiped keyring or a damaged file: keep it aside, start
      // again, and the next GitHub sign-in becomes a move (rebind).
      try { renameSync(file, join(dataDir, `identity.broken-${Date.now()}.json`)); } catch { /* gone already */ }
      keys = make();
      if (store.get('uid')) store.set('state', 'needs-signin');
      return keys;
    }
  }

  const I = {
    // Create the keys if there are none yet (the first GitHub sign-in).
    ensureKeys() { if (!load()) keys = make(); return { ik: keys.ik, xk: keys.xk }; },
    has: () => !!load(),
    get ik() { return load()?.ik || null; },
    get xk() { return load()?.xk || null; },
    get fingerprint() { const k = load(); return k ? fp(k.ik, k.xk) : null; },
    get protected() { load(); return enc === 'safeStorage'; },
    sign(str) { if (!load()) I.ensureKeys(); return signStr(keys.ikPriv, str); },
    // For peercrypto: { uid, ikPriv, xkPriv, ik, xk }. Never leaves the server.
    me() { const k = load(); return k && { uid: store.get('uid'), ikPriv: k.ikPriv, xkPriv: k.xkPriv, ik: k.ik, xk: k.xk }; },
    self() {
      const v = store.all();
      if (!v.uid) return null;
      return {
        uid: v.uid, username: v.username || '', user: v.user || null, kver: Number(v.kver) || 1, state: v.state || 'ok',
        rebindAt: v.rebind_at ? Number(v.rebind_at) : null, hideIp: v.hide_ip === '1',
      };
    },
    setSelf(obj) {
      const map = { uid: 'uid', username: 'username', user: 'user', kver: 'kver', state: 'state', rebindAt: 'rebind_at', hideIp: 'hide_ip', renamedAt: 'renamed_at' };
      db.tx(() => { for (const [k, col] of Object.entries(map)) if (obj[k] !== undefined) store.set(col, k === 'hideIp' ? (obj[k] ? '1' : '0') : obj[k]); });
    },
    get: store.get, set: store.set,
    clearSelf() { store.clear(); },
    // Forget the keys (account deleted): the file goes, the next sign-in makes new ones.
    forget() { keys = null; if (!memory) { try { unlinkSync(file); } catch { /* none */ } } },
    // After a move completes, the files kept aside are no longer needed (S29).
    dropBroken() {
      if (memory) return 0;
      let n = 0;
      for (const f of readdirSync(dataDir)) if (/^identity\.broken-\d+\.json$/.test(f)) { try { unlinkSync(join(dataDir, f)); n++; } catch { /* busy */ } }
      return n;
    },
  };
  return I;
}
