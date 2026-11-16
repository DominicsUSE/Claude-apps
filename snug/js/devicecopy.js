// This device's copy of messages, sealed in the desktop app (0.14). Wires js/store.js (copyHooks) to the
// account's store (js/e2ee/store.js, shared with encryption): a storage key derived from a secret under the
// OS key store is made even when encryption isn't turned on, and the device copy, drafts, reply targets,
// draft attachments and the offline queue are kept as AES-GCM blobs under it in IndexedDB. The first time,
// what 0.13 kept in localStorage in plaintext is moved over and deleted (js/lib/devicecopy.js).
//
// Only on the app's own page, where the bridge to the key store exists (preload.js snugApp.e2eeStoreKey).
// Without a key store (Linux basic_text) the copy stays as in a browser, and Settings says the keys aren't
// protected by the system key store.
import { copyHooks, signOutHooks } from './store.js';
import { sharedStore } from './e2ee/store.js';
import { migrateCopy, readCopy, copyWriter } from './lib/devicecopy.js';

let store = null, writer = null;
copyHooks.open = async (userId) => {
  const st = await sharedStore(userId, () => window.snugApp.e2eeStoreKey());
  await st.ready(); // throws when the key store can't open it (locked): nothing is replaced
  if (st.protection() !== 'os') return null;
  await migrateCopy(localStorage, st, userId);
  const got = await readCopy(st);
  store = st;
  writer = copyWriter(st);
  return got;
};
copyHooks.write = (name, text) => { writer?.write(name, text); };
// On sign-out the sealed copy is deleted. The deletes are started at once (each opens its IndexedDB transaction
// right away), from a hook that runs before encryption closes the shared store (js/e2ee/manager.js).
function forget() {
  for (const name of ['cache', 'drafts', 'reply', 'ops', 'files']) { try { store?.putSealedText(`copy.${name}`, null).catch(() => {}); } catch { /* closed */ } }
  store = null; writer = null;
}
copyHooks.clear = forget;
signOutHooks.unshift(forget);
