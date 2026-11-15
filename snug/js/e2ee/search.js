// Search inside end-to-end encrypted conversations, on this device (the v0.12
// e2ee spec, section 15). The server can't search them (it has no text), so the
// search page also looks through the decrypted messages this device holds, with
// the same query rules as everywhere else (js/lib/search.js), and can load and
// decrypt further back (up to 2000 messages per conversation) when asked.
// Nothing is written to disk: there is no stored plaintext index in v0.12.
import { S, emit } from '../store.js';
import { loadHistory } from '../server.js';
import { runSearch } from '../lib/search.js';
import { isEncrypted, whenOpen } from './conv.js';
import { E2 } from './manager.js';

export const DEEP_LIMIT = 2000;
const encryptedConvs = () => Object.keys(S.msgs).filter(isEncrypted);
export const hasEncrypted = () => Object.values(S.dms).some((d) => d.e2ee);

/** Hits among the decrypted messages of encrypted conversations already on this device. */
export function searchEncrypted(p, limit = 80) {
  if (E2.status !== 'ready') return [];
  // Only encrypted messages: older plain ones in the same conversation are in the server's results already.
  const msgs = Object.fromEntries(encryptedConvs().map((c) => [c, S.msgs[c].filter((m) => m.e2ee && m.enc === true)]));
  return runSearch({ ...S, msgs }, p, limit);
}

/** Loads older pages of every encrypted conversation (up to DEEP_LIMIT messages each) and waits for them to open. */
export async function loadEncryptedHistory(onProgress = () => {}) {
  const dms = Object.values(S.dms).filter((d) => d.e2ee).map((d) => d.id);
  let done = 0;
  for (const conv of dms) {
    while (S.more[conv] && (S.msgs[conv] || []).length < DEEP_LIMIT) {
      const before = (S.msgs[conv] || []).find((m) => m.seq != null)?.seq;
      const r = await loadHistory(conv, { before });
      if (!r.msgs.length) break;
    }
    done += 1;
    onProgress(done, dms.length);
  }
  // Wait for what was loaded to be opened (each message settles opened or not).
  const waiting = encryptedConvs().flatMap((c) => S.msgs[c]).filter((m) => m.e2ee && m.enc !== true && m.enc !== 'failed' && m.enc !== 'locked');
  await Promise.all(waiting.map((m) => new Promise((r) => whenOpen(m, r))));
  emit();
}
