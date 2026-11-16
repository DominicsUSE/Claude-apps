// What this device keeps for an end-to-end encrypted conversation before it is sent (review L2): the
// draft, what it replies to, and messages waiting for the connection (or that failed). None of it goes
// to localStorage as text (js/store.js leaves it out); it is sealed under this device's storage key
// (js/e2ee/store.js, "meta/local.unsent") and comes back once the keys are open after a reload, when a
// waiting message is sent. Attachments uploaded for such a draft stay in this tab only. A conversation
// counts as private once it is encrypted, or this device has seen it encrypted.
import { S, emit, unsentHooks, signOutHooks, markLocal, isLocalMsg } from '../store.js';
import { retry } from '../server.js';
import { splitUnsent } from '../lib/offline.js';
import { E2, ring, readyHooks } from './manager.js';
import { encryptedSince, fileKeyOf, keepFileKey } from './conv.js';

const KEY = 'local.unsent';
const MAX = 200 * 1024; // what a sealed entry may hold (js/e2ee/store.js reads up to 256 KB)
const isPrivate = (conv) => encryptedSince(conv) != null;
unsentHooks.private = isPrivate;

let restored = false; // nothing is written before what was sealed has been read back (or it would be lost)
let last = null;
let writing = Promise.resolve();
const FILE = ['id', 'kind', 'name', 'size', 'w', 'h', 'duration', 'peaks', 'voice', 'spoiler', 'alt', 'gif'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
// A message of this device's that isn't on the server yet, as kept: its text, reply and attachments with
// their keys (an encrypted attachment can't be sent again without them).
function keptMsg(m) {
  const files = (m.files || []).map((f) => ({ ...pick(f, FILE), key: fileKeyOf(f.id) || undefined }));
  return { ...pick(m, ['id', 'author', 'ts', 'text', 'replyTo', 'silent', 'replyPing', 'sticker', 'fwd']), state: m.state === 'failed' ? 'failed' : 'queued', ...(m.error ? { error: String(m.error).slice(0, 300) } : {}), ...(files.length ? { files } : {}) };
}
function snapshot() {
  const { sealed } = splitUnsent({ drafts: S.drafts, reply: S.ui.reply }, isPrivate);
  const msgs = {};
  for (const [conv, list] of Object.entries(S.msgs)) {
    if (!isPrivate(conv)) continue;
    const mine = list.filter((m) => m.state && m.author === S.me && isLocalMsg(m)).map(keptMsg);
    if (mine.length) msgs[conv] = mine;
  }
  const empty = !Object.keys(sealed.drafts).length && !Object.keys(sealed.reply).length && !Object.keys(msgs).length;
  return empty ? null : JSON.stringify({ v: 1, user: S.me, drafts: sealed.drafts, reply: sealed.reply, msgs });
}
/** Seals what the encrypted conversations have unsent (js/store.js persist calls this). */
function keep() {
  const store = ring.store;
  if (!restored || !store || !S.me) return;
  const json = snapshot();
  if (json === last || (json && json.length > MAX)) return; // too much to seal: it stays in this tab only
  last = json;
  writing = writing.then(() => store.putSecret(KEY, json)).catch(() => {});
}
unsentHooks.keep = keep;

// Read back once the keys are open: drafts not typed over since, replies, and waiting messages (sent now).
async function restore() {
  if (restored || !ring.store) return;
  let rec = null;
  try { rec = JSON.parse((await ring.store.getSecret(KEY)) || 'null'); } catch { rec = null; }
  restored = true;
  if (!rec || rec.v !== 1 || rec.user !== S.me) { keep(); return; }
  for (const [conv, text] of Object.entries(rec.drafts || {})) {
    if (typeof text !== 'string' || S.drafts[conv]) continue;
    // An open composer takes it the way a quote does (js/views/stream.js); otherwise it waits in S.drafts.
    if (typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('snug:compose', { detail: { conv, text } }));
    if (!S.drafts[conv]) S.drafts[conv] = text;
  }
  for (const [conv, id] of Object.entries(rec.reply || {})) if (typeof id === 'string' && !S.ui.reply[conv]) S.ui.reply[conv] = id;
  const again = [];
  for (const [conv, list] of Object.entries(rec.msgs || {})) {
    if (!Array.isArray(list)) continue;
    const have = new Set((S.msgs[conv] || []).map((m) => m.id));
    for (const x of list) {
      if (!x || typeof x.id !== 'string' || x.author !== S.me || have.has(x.id)) continue;
      const files = (x.files || []).map((f) => { if (f.key) keepFileKey(f.id, f.key); const { key, ...view } = f; return view; });
      const m = markLocal({ ...x, ...(files.length ? { files } : {}) });
      if (!files.length) delete m.files;
      (S.msgs[conv] ||= []).push(m);
      if (m.state === 'queued') again.push([conv, m]);
    }
    S.msgs[conv]?.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }
  emit();
  for (const [conv, m] of again) retry(conv, m);
}
readyHooks.push(() => { if (E2.status === 'ready') restore().catch(() => { restored = true; }); });
signOutHooks.unshift(() => {
  // Before the store closes (js/e2ee/manager.js): the next sign-in here starts with nothing unsent.
  if (restored) ring.store?.putSecret(KEY, null).catch(() => {});
  restored = false; last = null;
});
