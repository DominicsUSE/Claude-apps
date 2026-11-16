// This device's copy of messages, sealed (0.14): the pure parts, over a store from js/e2ee/store.js.
//
// In the desktop app (its own page, where the device storage key SK is derived from a secret under the
// operating system's key store), the device copy, drafts, reply targets, attachments waiting in a draft and
// the queue of changes made offline are kept as AES-GCM blobs under SK in IndexedDB ("meta/copy.<name>"),
// not in localStorage. A copy of the app's data folder alone opens none of it. js/devicecopy.js wires this
// to js/store.js.
//
// migrateCopy() moves what 0.13 kept in localStorage in plaintext: read, sealed, then deleted.

/** What 0.13 kept in localStorage, by name. */
export const COPY_NAMES = { cache: 'snug.cache', drafts: 'snug.drafts', reply: 'snug.reply', ops: 'snug.ops', files: 'snug.draftFiles' };
const entry = (name) => `copy.${name}`;
const parse = (text) => { try { return text == null ? null : JSON.parse(text); } catch { return null; } };

/** { cache, drafts, reply, ops, files }: each parsed, or null. Throws if the store can't be opened (locked). */
export async function readCopy(store) {
  const out = {};
  for (const name of Object.keys(COPY_NAMES)) out[name] = parse(await store.getSealedText(entry(name)));
  return out;
}

/** Writes in order, one at a time per name (a slow older write never lands after a newer one). */
export function copyWriter(store) {
  let chain = Promise.resolve();
  const last = new Map();
  return {
    write(name, text) {
      if (last.get(name) === text) return chain;
      last.set(name, text);
      chain = chain.then(() => store.putSealedText(entry(name), text)).catch(() => {});
      return chain;
    },
    idle: () => chain,
  };
}

/**
 * Moves 0.13 plaintext entries from localStorage (ls: getItem/removeItem) into the sealed store, then deletes
 * them. A sealed entry already there is newer and is kept. A cached copy that belongs to someone else is
 * deleted, never moved. Returns the names moved.
 */
export async function migrateCopy(ls, store, userId) {
  const moved = [];
  for (const [name, key] of Object.entries(COPY_NAMES)) {
    let text = null;
    try { text = ls.getItem(key); } catch { /* storage off */ }
    if (text == null) continue;
    const mine = name !== 'cache' || parse(text)?.me === userId;
    if (mine && (await store.getSealedText(entry(name))) == null) {
      await store.putSealedText(entry(name), text);
      moved.push(name);
    }
    try { ls.removeItem(key); } catch { /* storage off */ }
  }
  return moved;
}
