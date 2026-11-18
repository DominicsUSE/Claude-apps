// Where this device keeps its end-to-end encryption keys: IndexedDB database
// "snug-e2ee:<userId>", one per account. CryptoKey objects are stored as they
// are (the browser keeps non-extractable keys non-extractable across reloads);
// everything else secret (the account secret bundle, a recovery key not yet
// confirmed, the decrypted synced settings) is AES-GCM-encrypted under this
// device's storage key SK, itself a non-extractable key in the same database.
//
// In the desktop app (its own page only), SK is instead derived from a secret
// the app keeps under the operating system's key store (desktop/main.js,
// snugApp.e2eeStoreKey), so what is in IndexedDB opens nothing by itself: the
// database holds only a salt and a check value ("skw"). A 0.12.0 profile is
// moved over the first time: every sealed entry is opened with the old SK and
// sealed again under the new one, all written in one transaction with the old
// SK removed. With no key store (Linux basic_text, a browser) SK stays as it
// was (said in Settings). If the key store can't give the secret back (it
// changed, or the data was copied to another computer) the store is "locked":
// nothing is replaced, and Settings says so.
//
// 0.14: the same SK, made even when encryption isn't turned on, seals this device's copy of messages,
// drafts, reply targets and the offline queue in the desktop app (putSealedText, js/devicecopy.js), and
// (where SK is under the OS key store) new prekey private keys and new device signing keys
// (sealBytes/openBytes, js/e2ee/manager.js): kept as PKCS#8 sealed under SK, imported non-extractable
// into memory when the keys are opened.
//
// Honest limit (said in Settings): script running in Snug's page can use every
// key here. Non-extractable only stops it from copying the device keys out. In a
// browser, and for device keys made before 0.14, the device's own signing and
// prekey private keys are non-extractable browser keys in IndexedDB, not sealed
// under SK.
import { utf8, fromUtf8, random, b64uOf } from '../lib/e2ee/bytes.js';
import { canon, parseCanon } from '../lib/e2ee/canon.js';

const STORES = ['dev', 'asb', 'pins', 'keys', 'meta'];
const subtle = () => globalThis.crypto.subtle;

function req(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }

function openDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('blocked'));
  });
}

// A key-value layer with the same calls over IndexedDB or a Map (tests, and as a fallback).
function idbKv(db) {
  const run = (store, mode, fn) => { const tx = db.transaction(store, mode); return req(fn(tx.objectStore(store))); };
  return {
    get: (s, k) => run(s, 'readonly', (o) => o.get(k)),
    put: (s, k, v) => run(s, 'readwrite', (o) => o.put(v, k)),
    del: (s, k) => run(s, 'readwrite', (o) => o.delete(k)),
    keys: (s) => run(s, 'readonly', (o) => o.getAllKeys()),
    // Several writes as one transaction: all of them or none. ops: [[store, key, value | undefined (delete)]]
    batch: (ops) => new Promise((resolve, reject) => {
      const tx = db.transaction([...new Set(ops.map((x) => x[0]))], 'readwrite');
      for (const [st, k, v] of ops) { const o = tx.objectStore(st); if (v === undefined) o.delete(k); else o.put(v, k); }
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('aborted'));
    }),
    close: () => db.close(),
  };
}
function mapKv() {
  const m = new Map(STORES.map((s) => [s, new Map()]));
  return {
    get: async (s, k) => m.get(s).get(k), put: async (s, k, v) => { m.get(s).set(k, v); }, del: async (s, k) => { m.get(s).delete(k); },
    keys: async (s) => [...m.get(s).keys()],
    batch: async (ops) => { for (const [st, k, v] of ops) { if (v === undefined) m.get(st).delete(k); else m.get(st).set(k, v); } },
    close() {},
  };
}

// Entries sealed under SK (sealedPut): moved to a new SK together.
const SEALED = ['asb', 'meta'];
const CHECK = 'snug-e2ee-v1/store-check';
/** The store is protected by the OS key store, but it can't give the secret back now. */
export class StoreLocked extends Error {
  constructor() { super('This device’s encryption keys are locked by the system key store.'); this.code = 'e2ee_locked'; }
}
// SK from the key store's secret: HKDF-SHA-256 with a random salt kept in the database, non-extractable.
async function derive(secret, salt, dbName) {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(`snug-e2ee-v1/store\n${dbName}`) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const gcm = async (key, label, bytes) => { const iv = random(12); return { iv, ct: new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(label) }, key, bytes)) }; };
const ungcm = async (key, label, box) => new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: utf8(label) }, key, box.ct));

// osKey: () => Promise<{ protected, key (32 bytes, base64url), why } | null> (the desktop bridge), or null.
function wrap(kv, dbName, osKey = null) {
  let skP = null;
  let protection = osKey ? null : 'none'; // 'os' | 'none' | 'locked', once known
  const secret = async () => {
    const r = await osKey?.().catch(() => null);
    if (r?.protected && typeof r.key === 'string') { try { const k = b64uOf(r.key, 32); if (k) return { key: k }; } catch { /* not a key */ } }
    return { why: r?.why || 'unavailable' };
  };
  async function load() {
    const w = await kv.get('dev', 'skw');
    if (w) {
      const s = await secret();
      if (!s.key) { protection = 'locked'; throw new StoreLocked(); }
      const k = await derive(s.key, w.salt, dbName);
      s.key.fill(0);
      try { await ungcm(k, CHECK, w.check); } catch { protection = 'locked'; throw new StoreLocked(); }
      protection = 'os';
      return k;
    }
    const old = await kv.get('dev', 'sk');
    const s = osKey ? await secret() : {};
    if (s.key) {
      // New, or a 0.12.0 profile: SK from the key store's secret; anything sealed under the old SK sealed again.
      const salt = random(32);
      const k = await derive(s.key, salt, dbName);
      s.key.fill(0);
      const ops = [];
      if (old) {
        for (const st of SEALED) {
          for (const key of await kv.keys(st)) {
            const box = await kv.get(st, key);
            if (!box) continue;
            const label = `${st}/${key}`;
            ops.push([st, key, await gcm(k, label, await ungcm(old, label, box))]);
          }
        }
      }
      ops.push(['dev', 'skw', { v: 1, salt, check: await gcm(k, CHECK, utf8('ok')) }], ['dev', 'sk', undefined]);
      await kv.batch(ops);
      protection = 'os';
      return k;
    }
    protection = 'none';
    if (old) return old;
    const k = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await kv.put('dev', 'sk', k);
    return k;
  }
  // One load at a time (seals in parallel share it); a failed one is tried again next time.
  const storageKey = () => (skP ||= load().catch((e) => { skP = null; throw e; }));
  async function seal(value, label) {
    return gcm(await storageKey(), label, utf8(canon(value)));
  }
  async function unseal(box, label) {
    if (!box) return null;
    return parseCanon(fromUtf8(await ungcm(await storageKey(), label, box)), 256 * 1024);
  }
  // The key first: loading it may seal every entry again (a 0.12.0 profile), so the entry is read after.
  const sealedGet = async (store, key) => { await storageKey(); return unseal(await kv.get(store, key), `${store}/${key}`); };
  const sealedPut = async (store, key, value) => kv.put(store, key, value == null ? null : await seal(value, `${store}/${key}`));
  // 0.14: text of any size (the device copy), and raw bytes (PKCS#8 private keys), sealed under SK.
  const textPut = async (key, text) => kv.put('meta', key, text == null ? null : await gcm(await storageKey(), `meta/${key}`, utf8(text)));
  const textGet = async (key) => { await storageKey(); const box = await kv.get('meta', key); return box ? fromUtf8(await ungcm(await storageKey(), `meta/${key}`, box)) : null; };
  return {
    name: dbName,
    /** Loads the storage key now (moving a 0.12.0 profile over); throws StoreLocked if the key store won't open it. */
    ready: () => storageKey(),
    /** 'os': under the OS key store; 'none': not (no key store here); 'locked'; null before ready(). */
    protection: () => protection,
    // This device: { d, dsk (CryptoKeyPair), dskPub, label, kind, kid, prekeys: { kid: { pair, pub, created, retired } } }
    getDevice: () => kv.get('dev', 'device'),
    putDevice: (dev) => kv.put('dev', 'device', dev),
    getAsb: () => sealedGet('asb', 'asb'),
    putAsb: (asb) => sealedPut('asb', 'asb', asb),
    getSecret: (k) => sealedGet('meta', k),
    putSecret: (k, v) => sealedPut('meta', k, v),
    /** 0.14: a sealed text entry (null deletes it; the delete is started at once, so it lands before a close). */
    getSealedText: (k) => textGet(k),
    putSealedText: (k, text) => (text == null ? kv.del('meta', k) : textPut(k, text)),
    /** 0.14: bytes sealed under SK with a label, as { iv, ct } kept by the caller. */
    sealBytes: async (label, bytes) => gcm(await storageKey(), label, bytes),
    openBytes: async (label, box) => ungcm(await storageKey(), label, box),
    getPlain: (k) => kv.get('pins', k),
    putPlain: (k, v) => kv.put('pins', k, v),
    close: () => kv.close(),
  };
}

/** The store for one account on this device (osKey: the desktop app's key store bridge, if any). */
export async function openStore(userId, osKey = null) {
  const name = `snug-e2ee:${userId}`;
  return wrap(idbKv(await openDb(name)), name, osKey);
}
// 0.14: one store per account in this page, shared by encryption (js/e2ee/manager.js) and the device copy
// (js/devicecopy.js), so they never make two storage keys at once. Closing it lets the next call open it again.
const shared = new Map();
export function sharedStore(userId, osKey = null) {
  if (!shared.has(userId)) {
    const p = openStore(userId, osKey).then((st) => {
      const close = st.close;
      st.close = () => { if (shared.get(userId) === p) shared.delete(userId); close(); };
      return st;
    });
    p.catch(() => { if (shared.get(userId) === p) shared.delete(userId); });
    shared.set(userId, p);
  }
  return shared.get(userId);
}
/**
 * calls C2: the shared store only if this device already has one for the account (never made here),
 * with its storage key loaded; null otherwise (no store, a browser that can't list its databases, locked).
 */
export async function existingStore(userId, osKey = null) {
  if (!shared.has(userId)) {
    const all = typeof indexedDB?.databases === 'function' ? await indexedDB.databases().catch(() => null) : null;
    if (!all?.some((x) => x.name === `snug-e2ee:${userId}`)) return null;
  }
  const st = await sharedStore(userId, osKey);
  await st.ready();
  return st;
}
/** Forget this device's keys for an account (after "remove this device's keys"). */
export function deleteStore(userId) {
  shared.delete(userId);
  return new Promise((resolve) => { const r = indexedDB.deleteDatabase(`snug-e2ee:${userId}`); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
}
/** In memory only: tests, and nothing persists. */
export const memStore = (osKey = null) => wrap(mapKv(), 'memory', osKey);
export const _test = { wrap, mapKv };
