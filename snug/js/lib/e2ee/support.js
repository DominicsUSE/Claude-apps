// Can this browser do end-to-end encryption? Checked by trying, not by
// version numbers: a secure context, X25519 and Ed25519 in WebCrypto, AES-GCM,
// HKDF, and a non-extractable key surviving a trip through IndexedDB (private
// windows in some browsers refuse that). Firefox 130+, Safari 17+ and current
// Chrome are expected to pass; the answer says why when one doesn't.

export async function supported({ idb = globalThis.indexedDB } = {}) {
  if (globalThis.isSecureContext === false) return { ok: false, reason: 'insecure' };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { ok: false, reason: globalThis.isSecureContext === false ? 'insecure' : 'old' };
  let x;
  try {
    x = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const y = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    await subtle.deriveBits({ name: 'X25519', public: y.publicKey }, x.privateKey, 256);
    const e = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const s = await subtle.sign({ name: 'Ed25519' }, e.privateKey, new Uint8Array(1));
    if (!(await subtle.verify({ name: 'Ed25519' }, e.publicKey, s, new Uint8Array(1)))) return { ok: false, reason: 'old' };
    const a = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, a, new Uint8Array(1));
    const h = await subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) }, h, 256);
  } catch { return { ok: false, reason: 'old' }; }
  if (idb === null) return { ok: true }; // Node tests: no IndexedDB to try
  if (!idb) return { ok: false, reason: 'storage' };
  try { await idbRoundTrip(idb, x.privateKey); } catch { return { ok: false, reason: 'storage' }; }
  return { ok: true };
}

function idbRoundTrip(idb, key) {
  const name = 'snug-e2ee-probe';
  return new Promise((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('k');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('k', 'readwrite');
      tx.objectStore('k').put(key, 'k');
      const get = tx.objectStore('k').get('k');
      tx.oncomplete = () => { db.close(); idb.deleteDatabase(name); get.result?.type === 'private' ? resolve() : reject(new Error('lost')); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
