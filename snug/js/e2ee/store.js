// Where this device keeps its end-to-end encryption keys: IndexedDB database
// "snug-e2ee:<userId>", one per account. CryptoKey objects are stored as they
// are (the browser keeps non-extractable keys non-extractable across reloads);
// everything else secret (the account secret bundle, a recovery key not yet
// confirmed, the decrypted synced settings) is AES-GCM-encrypted under this
// device's storage key SK, itself a non-extractable key in the same database.
//
// Honest limit (said in Settings): script running in Snug's page can use every
// key here. Non-extractable only stops it from copying the device keys out.
import { utf8, fromUtf8, random } from '../lib/e2ee/bytes.js';
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
    close: () => db.close(),
  };
}
function mapKv() {
  const m = new Map(STORES.map((s) => [s, new Map()]));
  return { get: async (s, k) => m.get(s).get(k), put: async (s, k, v) => { m.get(s).set(k, v); }, del: async (s, k) => { m.get(s).delete(k); }, close() {} };
}

function wrap(kv, dbName) {
  let sk = null;
  async function storageKey() {
    if (sk) return sk;
    sk = await kv.get('dev', 'sk');
    if (!sk) { sk = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await kv.put('dev', 'sk', sk); }
    return sk;
  }
  async function seal(value, label) {
    const iv = random(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(label) }, await storageKey(), utf8(canon(value))));
    return { iv, ct };
  }
  async function unseal(box, label) {
    if (!box) return null;
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: utf8(label) }, await storageKey(), box.ct);
    return parseCanon(fromUtf8(new Uint8Array(pt)), 256 * 1024);
  }
  const sealedGet = async (store, key) => unseal(await kv.get(store, key), `${store}/${key}`);
  const sealedPut = async (store, key, value) => kv.put(store, key, value == null ? null : await seal(value, `${store}/${key}`));
  return {
    name: dbName,
    // This device: { d, dsk (CryptoKeyPair), dskPub, label, kind, kid, prekeys: { kid: { pair, pub, created, retired } } }
    getDevice: () => kv.get('dev', 'device'),
    putDevice: (dev) => kv.put('dev', 'device', dev),
    getAsb: () => sealedGet('asb', 'asb'),
    putAsb: (asb) => sealedPut('asb', 'asb', asb),
    getSecret: (k) => sealedGet('meta', k),
    putSecret: (k, v) => sealedPut('meta', k, v),
    getPlain: (k) => kv.get('pins', k),
    putPlain: (k, v) => kv.put('pins', k, v),
    close: () => kv.close(),
  };
}

/** The store for one account on this device. */
export async function openStore(userId) {
  const name = `snug-e2ee:${userId}`;
  return wrap(idbKv(await openDb(name)), name);
}
/** Forget this device's keys for an account (after "remove this device's keys"). */
export function deleteStore(userId) {
  return new Promise((resolve) => { const r = indexedDB.deleteDatabase(`snug-e2ee:${userId}`); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
}
/** In memory only: tests, and nothing persists. */
export const memStore = () => wrap(mapKv(), 'memory');
