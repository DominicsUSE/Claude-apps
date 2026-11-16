// End-to-end encrypted conversations on this device: sealing what we send and
// opening what arrives (the v0.12 e2ee spec, sections 7 to 9).
//
// Sending: the text, attachment keys and mentions go into a body sealed with a
// fresh random key; that key is sealed to every trusted device of every member
// (from their signed device lists, checked here, never taken on the server's
// word) and to each member's history key. If the server says someone's keys
// changed (e2ee_stale), we fetch them again and seal again with the same
// message id.
//
// Receiving: every message view that arrives (events, snapshots, any op's
// answer) passes through scan(). An envelope we have opened before gets its
// text at once; a new one is opened in the background and the page redraws.
// Until then, or if it can't be opened, the message says so: never ciphertext.
// Notifications for an encrypted message wait until it is open.
import { S, emit, findMsg, msgHooks, signOutHooks, toast, subscribe, isLocalMsg } from '../store.js';
import { call, on, transportHooks, resyncNow, uploadLimits } from '../server.js';
import { needsChunks, uploadBlob } from '../lib/upload.js';
import { b64u, b64uOf } from '../lib/e2ee/bytes.js';
import { canon } from '../lib/e2ee/canon.js';
import { COPY } from '../lib/e2ee/copy.js';
import * as obj from '../lib/e2ee/objects.js';
import { seal, open, OpenFailure } from '../lib/e2ee/envelope.js';
import { editSet, cmpTuple } from '../lib/e2ee/rules.js';
import { encryptFile, decryptFile } from '../lib/e2ee/attach.js';
import { sniff } from '../lib/sniff.js';
import { mentions } from '../lib/format.js';
import { E2, ring, readyHooks, pinHooks } from './manager.js';
import './local.js'; // drafts and unsent messages of encrypted conversations, sealed (review L2)

// ---------- which conversations are encrypted ----------
/** The DM a conversation lives in (itself, or the DM a thread hangs off), or null for rooms. */
export function rootDm(conv) {
  if (typeof conv !== 'string') return null;
  if (S.dms[conv]) return conv;
  if (!conv.startsWith('t:')) return null;
  const t = S.threads[conv];
  if (t) return S.dms[t.conv] ? t.conv : null;
  const rootId = conv.slice(2);
  for (const [c, list] of Object.entries(S.msgs)) if (S.dms[c] && list.some((m) => m.id === rootId)) return c;
  return null;
}
export const isEncrypted = (conv) => !!S.dms[rootDm(conv)]?.e2ee;
// Conversations are encrypted one way only. Each one this device has seen encrypted is remembered
// here (sealed, review H1) and in the synced settings; if the server later says one isn't, Snug
// refuses to send there (spec 12.3), and from where it turned encrypted (e2eeSince, as first seen)
// a message without an envelope is shown as not encrypted, delivered by the server (review H2).
const seenEncrypted = (dm) => (dm ? ring.encryptedConvs?.()?.[dm] || ring.meta?.convs?.[dm] || null : null);
export const downgraded = (conv) => { const dm = rootDm(conv); return !!dm && !S.dms[dm]?.e2ee && !!seenEncrypted(dm); };
function rememberEncrypted(dm) {
  if (!dm || E2.status !== 'ready' || ring.encryptedConvs?.()?.[dm]) return;
  ring.rememberConv(dm, seenEncrypted(dm) || S.dms[dm]?.e2eeSince || 1).catch(() => {});
}
// Every conversation the server reports encrypted is remembered as soon as this device is ready.
subscribe(() => { if (E2.status === 'ready') for (const [id, d] of Object.entries(S.dms)) if (d.e2ee) rememberEncrypted(id); });
/** Where an encrypted conversation began, as this device first saw it (null: not encrypted). */
export function encryptedSince(conv) {
  const dm = rootDm(conv);
  if (!dm) return null;
  const pinned = seenEncrypted(dm);
  if (pinned) return typeof pinned === 'number' ? pinned : 1;
  return S.dms[dm]?.e2ee ? S.dms[dm].e2eeSince || 1 : null;
}
/**
 * A message in an encrypted conversation that came without an envelope: the server wrote or
 * changed it, so it is shown as not encrypted, delivered by the server. Exempt: the lines the
 * server writes (calls, people joining or added, renames: rendered as lines, never as someone's
 * message) and messages this device made that the server hasn't sent back yet. Nothing else the
 * server sets (a `state`, `sys`) exempts a row (review H2, second pass).
 */
export function unsealed(conv, m) {
  if (!m || m.e2ee || m.call || m.join || m.dmLine) return false;
  if (m.state && m.author === S.me && isLocalMsg(m)) return false;
  const since = encryptedSince(conv);
  if (since == null) return false;
  return !(typeof m.seq === 'number' && m.seq < since);
}
/** A row from before the conversation turned encrypted (as this device pinned it): marked as not encrypted. */
export function beforeEncryption(conv, m) {
  if (!m || m.e2ee || m.call || m.join || m.dmLine || m.state) return false;
  const since = encryptedSince(conv);
  return since != null && typeof m.seq === 'number' && m.seq < since;
}

// ---------- other people's keys ----------
const bundles = new Map(); // user -> { list, prekeys, at }
export const changed = new Map(); // user -> new aik, when someone's account key changed (a reset)
// Someone's devices or keys changed: forget their keys; if we share an encrypted conversation, look
// again now, so a changed safety number shows before anyone sends.
on('e2ee.devices', (d) => {
  bundles.delete(d.user);
  if (d.user !== S.me && E2.status === 'ready' && Object.values(S.dms).some((x) => x.e2ee && x.members.includes(d.user))) fetchBundles([d.user]).then(emit, () => {});
});

// A pin changed (a safety number change accepted, a new list): the next send or open fetches again.
pinHooks.push((u) => bundles.delete(u));

// A person's list, checked (js/e2ee/manager.js): ours under our own account key and never older
// than one this device has seen; others' against the key, version and hash pinned for them here
// (first sight pins it; a different key is a reset). { list } or { list: null, problem }.
async function accept(u, list) {
  if (u === S.me) {
    try { return { list: await ring.checkOwnList(list) }; } catch (e) { return { list: null, problem: e.message }; }
  }
  const r = await ring.acceptContact(u, list);
  if (r.changedAik) changed.set(u, r.changedAik);
  if (!r.list && r.why === 'rollback') return { list: null, problem: `The server sent an older list of ${S.users[u]?.name || 'someone'}’s devices than this device has seen, so Snug won’t use it.` };
  return { list: r.list };
}
async function fetchBundles(users, fresh = false) {
  const want = [...new Set(users)].filter((u) => fresh || !bundles.has(u));
  for (let i = 0; i < want.length; i += 10) {
    const r = await call('e2ee.bundles', { users: want.slice(i, i + 10) });
    for (const [u, b] of Object.entries(r.users)) {
      const got = b.list ? await accept(u, b.list) : { list: null };
      bundles.set(u, { list: got.list, problem: got.problem || null, prekeys: b.prekeys || {}, ready: !!b.ready });
    }
  }
  return users.map((u) => bundles.get(u));
}

// calls C1/C2 (js/e2ee/callkeys.js): one person's devices that have a valid prekey, from their
// signed device list as checked here (never on the server's word): [{ d, dsk, kid, pub }].
export async function callDevices(u, fresh = false) {
  const [b] = await fetchBundles([u], fresh);
  if (b?.problem) throw new Error(b.problem);
  const out = [];
  for (const e of b?.list?.devs || []) {
    const p = b.prekeys[e.d];
    if (p && (await obj.verifyPrekey(p, { u, d: e.d, dsk: e.dsk }))) out.push({ d: e.d, dsk: e.dsk, kid: p.kid, pub: b64uOf(p.pub, 32) });
  }
  return out;
}

/** Members a verified contact's send waits on: a verified person whose account key changed. */
export const sendGate = (members) => members.filter((u) => u !== S.me && changed.has(u) && ring.meta?.verified?.[u] && ring.meta.verified[u] !== changed.get(u));

// Recipients from verified lists and prekeys: every listed device with a valid prekey, and history keys.
async function recipients(users, fresh) {
  const got = await fetchBundles(users, fresh);
  const to = [], ar = [], lv = {};
  for (let i = 0; i < users.length; i++) {
    const u = users[i], b = got[i];
    if (b?.problem) throw new Error(b.problem); // a rolled-back list: never sealed to, never skipped quietly
    if (!b?.list) continue;
    lv[u] = b.list.ver;
    for (const e of b.list.devs) {
      const p = b.prekeys[e.d];
      if (p && (await obj.verifyPrekey(p, { u, d: e.d, dsk: e.dsk }))) to.push([u, e.d, p.kid, b64uOf(p.pub, 32)]);
    }
    if (b.list.arc) ar.push([u, b.list.arc.e, b64uOf(b.list.arc.pub, 32)]);
  }
  return { to: to.sort(cmpTuple), ar: ar.sort(cmpTuple), lv };
}

// ---------- attachments ----------
const fileKeys = new Map(); // uploaded file id -> body part { k, n, csha, name, type, size }
// An unsent message's attachment keys, kept sealed with it across a reload (js/e2ee/local.js).
export const fileKeyOf = (id) => fileKeys.get(id) || null;
export function keepFileKey(id, part) {
  if (typeof id === 'string' && part && typeof part.k === 'string' && typeof part.n === 'string' && !fileKeys.has(id)) fileKeys.set(id, part);
}
const blobs = new Map(); // file id -> blob: URL of the decrypted bytes
const kindOf = (type, voice) => (type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') || voice ? 'audio' : 'file');
const SHOWABLE = { 'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1 };
// What the decrypted bytes are (never the sender's word): only these display or play inline.
function shownType(bytes, f) {
  const s = sniff(bytes);
  if (SHOWABLE[s]) return s;
  const audio = f.voice || String(f.type || '').startsWith('audio/');
  if (s === 'mp4') return audio ? 'audio/mp4' : 'video/mp4';
  if (s === 'webm') return audio ? 'audio/webm' : 'video/webm';
  if (s === 'quicktime') return 'video/quicktime';
  if (s && s.startsWith('audio/')) return s;
  return 'application/octet-stream';
}

/** Encrypts a file on this device and uploads only the ciphertext. */
// A big file goes up in resumable parts (js/lib/upload.js), still only as ciphertext.
export async function uploadEncrypted(conv, blob, name, { onProgress, signal } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { ct, meta } = await encryptFile(bytes);
  let data;
  if (needsChunks(ct.length)) {
    data = await uploadBlob({ fetch: (...a) => fetch(...a), conv, blob: new Blob([ct]), name, onProgress, signal, limits: await uploadLimits(), enc: true });
  } else {
    let res;
    try {
      res = await fetch(`/api/files?conv=${encodeURIComponent(conv)}&enc=1`, {
        method: 'POST', credentials: 'same-origin', body: ct, signal,
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'file' },
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`Couldn’t upload ${name}. Check your connection and try again.`);
    }
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Couldn’t upload ${name}.`);
  }
  const type = shownType(bytes, { type: blob.type });
  fileKeys.set(data.id, { ...meta, name, type, size: bytes.length });
  blobs.set(data.id, URL.createObjectURL(new Blob([bytes], { type })));
  return { id: data.id, name, size: bytes.length, kind: kindOf(type) };
}
// A file already on the server in the clear (a GIF picked from the server's search, a sticker):
// fetched, encrypted and uploaded again, so the message itself only points at ciphertext.
async function reupload(conv, f) {
  const res = await fetch(f.from || `/api/files/${f.id}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Couldn’t attach ${f.name || 'that file'}.`);
  const blob = await res.blob();
  return uploadEncrypted(conv, blob, f.name || 'file');
}

const parts = new Map(); // file id -> its body part (key, nonce, hash), for files in opened messages
/**
 * A copy of attachment f (from a message on screen) for encrypted conversation `to`: an encrypted
 * file is copied on the server as it is (its key goes in the new message); a plain one is fetched,
 * encrypted here and uploaded.
 */
export async function copyEncryptedFile(to, f) {
  const part = parts.get(f.id) || fileKeys.get(f.id);
  if (f.encFile && part) {
    const { id } = await call('e2ee.file.copy', { id: f.id, to });
    fileKeys.set(id, { k: part.k, n: part.n, csha: part.csha, name: part.name || f.name, type: part.type, size: part.size });
    if (blobs.has(f.id)) blobs.set(id, blobs.get(f.id));
    return { ...f, id, encFile: undefined };
  }
  const up = await reupload(to, { ...f, from: f.src || `/api/files/${f.id}` });
  return { ...f, id: up.id, encFile: undefined };
}

// ---------- sealing ----------
const membersOf = (dm) => [...(S.dms[dm]?.members || [])].sort();
const pingOf = (text, users) => users.filter((u) => u !== S.me && mentions(text || '', S.users[u]?.handle)).slice(0, 10);
const opened = new Map(); // "id:rev" -> { body, flags, fp } this device has opened (or sealed)
const keyOf = (id, rev) => `${id}:${rev}`;
// The whole envelope, so a copy shown again must be this exact envelope (review H2).
const fingerprint = (e) => { try { return canon({ h: e.h, n: e.n, c: e.c, sig: e.sig }); } catch { return null; } };
const topRev = new Map(); // message id -> highest revision opened here (older ones are refused)
const revLoaded = new Set(); // message ids whose newest revision in this device's store is in topRev

async function sealAndSend(op, { conv, dm, id, kind, rev, users, body, re = null, at, extra = {} }) {
  const { dev } = ring;
  if (E2.status !== 'ready' || !dev) throw new Error('Turn on end-to-end encryption on this device to send here (Settings, Encryption).');
  const gate = sendGate(users);
  if (gate.length) throw Object.assign(new Error(`${S.users[gate[0]]?.name || 'Someone'}’s safety number changed. Check it in the conversation’s details before sending.`), { code: 'e2ee_gate' });
  let fresh = false;
  for (let tries = 0; tries < 3; tries++) {
    const rc = await recipients(users, fresh);
    const header = { conv: dm, place: conv, id, kind, rev, from: { u: S.me, d: dev.d }, ts: Date.now(), lv: rc.lv, ping: body.mentions || [], re, ...(at !== undefined ? { at } : {}) };
    const { env, k, K } = await seal({ header, body, dsk: dev.dsk.privateKey, recipients: rc });
    opened.set(keyOf(id, rev), { body: { ...body, v: 1, conv: dm, place: conv, id, rev, from: header.from }, flags: [], fp: fingerprint(env), mine: true });
    ring.store?.putSecret?.(`k:${keyOf(id, rev)}`, b64u(K)).catch?.(() => {});
    try {
      const r = await call(op, { conv, id, ...extra, e2ee: { ...env, k } });
      if (op !== 'sched.create') noteRev(id, rev);
      return r;
    } catch (e) {
      if (e.code !== 'e2ee_stale') throw e;
      for (const u of Object.keys(e.data?.users || {})) bundles.delete(u);
      fresh = true;
    }
  }
  throw new Error('Someone’s encryption keys keep changing. Try again in a moment.');
}

/** Sends message m (from js/server.js send) into an encrypted conversation; resolves with the server's answer. */
export async function sendEncrypted(conv, m) {
  const dm = rootDm(conv);
  rememberEncrypted(dm);
  const users = membersOf(dm);
  const files = [];
  for (const f of m.files || []) {
    let id = f.id;
    if (!fileKeys.has(id)) { const up = await reupload(conv, f); id = up.id; f.id = id; }
    const key = fileKeys.get(id);
    files.push(clean({ id, k: key.k, n: key.n, csha: key.csha, name: f.name || key.name, type: key.type, size: key.size,
      w: f.w, h: f.h, duration: f.duration, peaks: f.peaks, voice: f.voice || undefined, spoiler: f.spoiler || undefined, alt: f.alt || undefined, gif: f.gif || undefined }));
  }
  const body = clean({ text: m.text || '', mentions: pingOf(m.text, users), files, sticker: m.sticker || undefined, fwd: m.fwd || undefined, silent: m.silent || undefined, replyPing: m.replyPing });
  return sealAndSend('msg.send', {
    conv, dm, id: m.id, kind: 'msg', rev: 0, users, body, re: m.replyTo || null,
    extra: clean({ text: '', files: files.map((f) => ({ id: f.id })), replyTo: m.replyTo, silent: m.silent || undefined, replyPing: m.replyPing }),
  });
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newMsgId = () => `m_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALNUM[b % 36]).join('')}`;
export const SCHEDULE_MAX = 14 * 86_400_000;
/** A scheduled message in an encrypted conversation: sealed now (for the people here now), sent by the server later. */
export async function scheduleEncrypted(conv, text, at, replyTo) {
  if (at > Date.now() + SCHEDULE_MAX) throw new Error('In encrypted conversations, messages can be scheduled up to 14 days ahead.');
  const dm = rootDm(conv);
  const users = membersOf(dm);
  const body = { text, mentions: pingOf(text, users) };
  return sealAndSend('sched.create', { conv, dm, id: newMsgId(), kind: 'sched', rev: 0, users, body, re: replyTo || null, at, extra: clean({ text: '', at, replyTo }) });
}

/** An edit: a new envelope (rev + 1) for the original recipients who are still here. */
async function editEncrypted(conv, m, text) {
  const dm = rootDm(conv);
  const prev = m.e2ee?.h;
  if (!prev) throw new Error('Messages from before encryption was turned on can’t be edited here.');
  const before = opened.get(keyOf(m.id, prev.rev))?.body || {};
  const users = editSet(prev.to, membersOf(dm));
  const body = clean({ text, mentions: pingOf(text, users), files: before.files, sticker: before.sticker, fwd: before.fwd });
  // The reply it was sent as stays in the signed header of every revision (checked when opened).
  const re = prev.kind === 'edit' && prev.kc === undefined ? (m.replyTo ?? null) : (prev.re ?? null); // a 0.12.0 edit carried none
  await sealAndSend('msg.edit', { conv, dm, id: m.id, kind: 'edit', rev: prev.rev + 1, users, body, re });
}
msgHooks.edit = (conv, m, text) => {
  if (downgraded(conv)) { toast(COPY.downgraded); resyncNow(); return true; } // never edited in plain text
  if (!isEncrypted(conv)) return false;
  editEncrypted(conv, m, text).catch((e) => { toast(e.message); resyncNow(); });
  return true;
};

// ---------- opening ----------
const queue = new Map(); // "id:rev" -> { views: Set, conv }
const waiters = new Map(); // "id:rev" -> [callbacks for notifications]
let timer = null;

function apply(m, r) {
  const b = r.body;
  m.text = b.text || '';
  m.files = (b.files || []).map((f) => ({
    id: f.id, kind: kindOf(f.type || '', f.voice), name: f.name || 'file', size: f.size || 0, w: f.w, h: f.h, duration: f.duration, peaks: f.peaks,
    voice: f.voice, spoiler: f.spoiler, alt: f.alt, gif: f.gif, encFile: true, src: blobs.get(f.id),
  }));
  if (!m.files.length) delete m.files;
  if (b.sticker) m.sticker = b.sticker;
  if (b.fwd) m.fwd = b.fwd;
  m.enc = true;
  m.encFp = r.fp;
  if (r.flags.length) m.encFlags = r.flags;
  for (const p of b.files || []) parts.set(p.id, p);
  for (const f of m.files || []) if (!f.src) loadFile(f, b.files.find((x) => x.id === f.id));
}
function failed(m, why) { m.enc = 'failed'; m.encWhy = why; m.text = ''; delete m.files; }

const loading = new Map();
function loadFile(view, part) {
  if (!part || blobs.has(part.id)) { view.src = blobs.get(part?.id); return; }
  if (!loading.has(part.id)) {
    loading.set(part.id, (async () => {
      const res = await fetch(`/api/files/${part.id}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('gone');
      const bytes = await decryptFile(new Uint8Array(await res.arrayBuffer()), part);
      const type = shownType(bytes, part);
      blobs.set(part.id, URL.createObjectURL(new Blob([bytes], { type })));
      return type;
    })());
  }
  loading.get(part.id).then((type) => {
    view.src = blobs.get(part.id);
    view.kind = kindOf(type, part.voice);
    emit();
  }, () => { view.broken = true; emit(); });
}

// What a message view says around its envelope must match the envelope: the author, and the reply
// it was sent as. Edits from 0.12.0 clients (no key commitment, kc) carry no reply, so for those only
// a reply they do name is checked.
function aroundOk(m) {
  const h = m.e2ee.h;
  if (m.author !== h.from?.u) return 'author';
  const re = m.replyTo ?? null;
  const lenient = h.kind === 'edit' && h.kc === undefined;
  if (lenient ? (h.re != null && h.re !== re) : (h.re ?? null) !== re) return 'reply';
  return null;
}
function noteRev(id, rev) {
  if (rev <= (topRev.get(id) ?? -1)) return;
  topRev.set(id, rev);
  if (rev > 0) ring.store?.putSecret?.(`rev:${id}`, rev).catch?.(() => {});
}
/** Called for every message view that arrives. Opened before: filled in now; else queued. older: an edit history's earlier versions. */
function see(m, conv, older = false) {
  if (m.enc === true && m.encRev === m.e2ee.h.rev && m.encFp === fingerprint(m.e2ee)) return;
  const h = m.e2ee.h;
  const key = keyOf(m.id, h.rev);
  if (conv && conv !== h.place) { failed(m, 'moved'); return; }
  const around = aroundOk(m);
  if (around) { failed(m, around); return; }
  if (!older && h.rev < (topRev.get(m.id) ?? -1)) { failed(m, 'revision'); return; }
  m.encRev = h.rev;
  const done = opened.get(key);
  // Opened before: only this exact envelope gets that text (the server can't show it elsewhere, or as
  // someone else's). As the current revision only once this device's stored newest revision is known.
  // (A revision sealed here is the newest this device has: it was made from the one shown.)
  if (done && done.fp === fingerprint(m.e2ee) && (older || done.mine || revLoaded.has(m.id))) { apply(m, done); return; }
  if (!m.enc || m.enc === true) m.enc = 'pending';
  const q = queue.get(key) || { views: new Set(), k: null, conv: null };
  q.views.add(m);
  // Whether a view is an edit history's earlier version is a property of that view, never of the
  // queue entry it shares with others (review H2-rev): one payload can't exempt the current view.
  if (older) olderViews.add(m); else olderViews.delete(m);
  if (m.k && Object.keys(m.k).length) q.k = m.k;
  if (conv) q.conv = conv;
  queue.set(key, q);
  clearTimeout(timer);
  timer = setTimeout(drain, 20);
}
// Message views inside any payload: { conv, m }, { conv, msgs: [...] }, { msgs: { conv: [...] } }, or anywhere else.
const isMsg = (o) => o && typeof o.id === 'string' && typeof o.author === 'string' && o.e2ee?.h;
const olderViews = new WeakSet(); // views that are an edit history's earlier versions (msg.edits only)
export function scan(o, conv = null, depth = 0, older = false) {
  if (!o || typeof o !== 'object' || depth > 7) return;
  if (Array.isArray(o)) { for (const x of o) scan(x, conv, depth + 1, older); return; }
  if (isMsg(o)) { see(o, conv, older); return; }
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object') continue;
    if (k === 'msgs' && !Array.isArray(v)) { for (const [c, list] of Object.entries(v)) scan(list, c, depth + 2, older); continue; }
    scan(v, (k === 'm' || k === 'msgs') && typeof o.conv === 'string' ? o.conv : null, depth + 1, older);
  }
}
/** An op's answer. Only the edit history (msg.edits) has earlier versions, and only under its `edits`. */
export function scanReply(d, op) {
  if (op === 'msg.edits' && d && typeof d === 'object') {
    scan(d.current);
    if (Array.isArray(d.edits)) for (const x of d.edits) if (isMsg(x)) see(x, null, true);
    return;
  }
  scan(d);
}

async function drain() {
  if (!queue.size) return;
  if (E2.settling) { timer = setTimeout(drain, 50); return; } // keys still loading for this connection
  const { keys, dev } = ring;
  const batch = [...queue.entries()];
  queue.clear();
  if (E2.status !== 'ready' || !keys || !dev) {
    for (const [, q] of batch) for (const m of q.views) if (m.enc !== true) { m.enc = 'locked'; locked.push(m); }
    emit();
    return;
  }
  // Wraps for views that didn't come with their own (history, snapshot, search, ...), 200 at a time.
  const need = batch.filter(([, q]) => !q.k).map(([key]) => { const i = key.lastIndexOf(':'); return { id: key.slice(0, i), rev: Number(key.slice(i + 1)) }; });
  const wraps = {};
  for (let i = 0; i < need.length; i += 200) {
    try {
      const r = await call('e2ee.wraps', { ids: need.slice(i, i + 200) });
      // Per revision (two revisions of one message in a batch each get theirs); servers before that answer by id.
      for (const [id, w] of Object.entries(r.wraps || {})) if (w && !wraps[`${id}:${w.rev}`]) wraps[`${id}:${w.rev}`] = w;
      Object.assign(wraps, r.revs || {});
    } catch { /* offline: opened from the cache or later */ }
  }
  const authors = [...new Set(batch.map(([, q]) => [...q.views][0].author))];
  try { await fetchBundles(authors); } catch { /* checked per message below */ }
  for (const [key, q] of batch) {
    const m = [...q.views][0];
    try {
      const prev = opened.get(key);
      const r = prev && prev.fp === fingerprint(m.e2ee) ? prev : await openOne(m, q.k || wraps[key]?.k || {}, q);
      opened.set(key, r);
      rememberEncrypted(r.body.conv);
      // The revision check, per view (review H2-rev): a current view older than the newest revision
      // this device has opened (kept in its store) is refused, whatever else shares its envelope.
      const h = m.e2ee.h;
      const top = Math.max(Number(await ring.store?.getSecret?.(`rev:${m.id}`).catch(() => 0)) || 0, topRev.get(m.id) ?? -1);
      if (top > (topRev.get(m.id) ?? -1)) topRev.set(m.id, top);
      revLoaded.add(m.id);
      let current = false, any = false;
      for (const v of q.views) {
        if (fingerprint(v.e2ee) !== r.fp) { failed(v, 'ciphertext'); continue; } // only this exact envelope gets its text
        if (!olderViews.has(v) && h.rev < top) { failed(v, 'revision'); continue; }
        apply(v, r);
        any = true;
        if (olderViews.has(v)) continue;
        current = true;
        // The first envelope seen in a DM bounds where encryption began (review H2, second pass).
        if (typeof v.seq === 'number' && v.seq > 0) ring.lowerConv?.(r.body.conv, v.seq).catch?.(() => {});
      }
      if (current) noteRev(m.id, h.rev);
      for (const fn of waiters.get(key) || []) fn(any);
    } catch (e) {
      const why = e instanceof OpenFailure ? e.reason : 'error';
      for (const v of q.views) failed(v, why);
      for (const fn of waiters.get(key) || []) fn(false);
    }
    waiters.delete(key);
  }
  emit();
}
async function openOne(m, wraps, q = {}) {
  const { keys, dev, store } = ring;
  const h = m.e2ee.h;
  // The sending device, from the newest list of the author's this device accepted (review L4): one
  // that has since been removed still checks messages it sealed before it left, flagged as such;
  // one sealed after it left is refused.
  const sender = await ring.senderKey(m.author, h.from.d);
  if (!sender) throw new OpenFailure('unknown device');
  // h.ts is the sender's word (a lost device can backdate it); the server's time for the row counts
  // too (review L4, second pass): one that reached the server after the removal is refused.
  if (sender.goneAt && (h.ts > sender.goneAt + 10 * 60_000 || (Number(m.ts) || 0) > sender.goneAt + 10 * 60_000)) throw new OpenFailure('removed device');
  // Where the row really is: the conversation it was delivered in, when known (review H2).
  const place = q.conv || h.place;
  const dm = rootDm(place);
  if (dm && dm !== h.conv) throw new OpenFailure('moved');
  const kcKey = `kc:${m.author}:${h.from.d}`;
  const requireKc = !!(await store?.getSecret?.(kcKey).catch(() => null));
  const cachedKey = await store?.getSecret?.(`k:${keyOf(m.id, h.rev)}`).catch(() => null);
  const r = await open({
    env: m.e2ee, expect: { conv: dm || h.conv, place, id: m.id, author: m.author, requireKc },
    senderDsk: b64uOf(sender.dsk, 32), me: { u: S.me, d: dev.d },
    keys: { device: (kid) => dev.prekeys[kid]?.pair || null, history: (e) => keys.ahk[e] || null, cached: cachedKey ? b64uOf(cachedKey, 32) : null },
    wraps,
  });
  if ((h.rev === 0) !== (h.kind !== 'edit')) throw new OpenFailure('revision');
  if (h.kind === 'sched' && Math.abs((m.ts || 0) - h.at) > 2 * 60_000) throw new OpenFailure('time');
  // The thread a message says it is in must hang off the DM it says it is in.
  const t = h.place.startsWith('t:') ? S.threads[h.place] : null;
  if (t && t.conv !== h.conv) throw new OpenFailure('moved');
  if (!h.place.startsWith('t:') && h.place !== h.conv) throw new OpenFailure('moved');
  if (!cachedKey) store?.putSecret?.(`k:${keyOf(m.id, h.rev)}`, b64u(r.K)).catch?.(() => {});
  // This sender device commits to its keys: from now on an envelope from it without kc is refused (review L1).
  if (h.kc !== undefined && !requireKc) store?.putSecret?.(kcKey, 1).catch?.(() => {});
  return { body: r.body, flags: sender.goneAt ? [...r.flags, 'removed-device'] : r.flags, fp: fingerprint(m.e2ee) };
}

/** Runs fn(true) once message m is open (or fn(false) if it can't be): notifications wait for this. */
export function whenOpen(m, fn) {
  if (m.enc === true) { fn(true); return; }
  if (m.enc === 'failed' || m.enc === 'locked') { fn(false); return; }
  const key = keyOf(m.id, m.e2ee.h.rev);
  waiters.set(key, [...(waiters.get(key) || []), fn]);
}

// Messages that arrived before this device had its keys: opened once it does.
let locked = [];
readyHooks.push(() => {
  const again = locked;
  locked = [];
  for (const m of again) if (m.enc === 'locked') { m.enc = null; see(m); }
});
signOutHooks.push(() => {
  bundles.clear(); changed.clear(); opened.clear(); topRev.clear(); revLoaded.clear(); queue.clear(); fileKeys.clear(); parts.clear(); locked = [];
  for (const u of blobs.values()) URL.revokeObjectURL(u);
  blobs.clear();
});

// ---------- the transport's hooks (js/server.js) ----------
Object.assign(transportHooks, { scan, scanReply, isEncrypted, downgraded, sendEncrypted, uploadEncrypted, whenOpen, unsealed, encryptedSince });
// Opened again after a reload: the device copy keeps only envelopes (js/lib/offline.js cacheJson).
readyHooks.push(() => { for (const [c, list] of Object.entries(S.msgs)) scan(list, c); });

// For the end-to-end checks.
export const _test = { opened, findMsg, topRev };
