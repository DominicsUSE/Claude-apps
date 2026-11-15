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
import { S, emit, findMsg, msgHooks, signOutHooks, toast } from '../store.js';
import { call, on, transportHooks, resyncNow } from '../server.js';
import { b64u, b64uOf } from '../lib/e2ee/bytes.js';
import * as obj from '../lib/e2ee/objects.js';
import { seal, open, OpenFailure } from '../lib/e2ee/envelope.js';
import { editSet, cmpTuple } from '../lib/e2ee/rules.js';
import { encryptFile, decryptFile } from '../lib/e2ee/attach.js';
import { sniff } from '../lib/sniff.js';
import { mentions } from '../lib/format.js';
import { E2, ring, readyHooks } from './manager.js';

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

// ---------- other people's keys ----------
const bundles = new Map(); // user -> { list, prekeys, at }
const knownDevs = new Map(); // user -> Map(device -> dsk): every device seen in a list we accepted
export const changed = new Map(); // user -> new aik, when someone's account key changed (a reset)
on('e2ee.devices', (d) => bundles.delete(d.user));

function remember(u, list) {
  const m = knownDevs.get(u) || new Map();
  for (const e of list.devs) m.set(e.d, e.dsk);
  knownDevs.set(u, m);
}
// A person's list, checked: under our own account key for ourselves; for others, its own
// signature and the key pinned for them (first sight pins it; a different one is a reset).
async function accept(u, list) {
  const { keys, meta } = ring;
  if (u === S.me) return (await obj.verifyList(list, b64uOf(keys.aikPub, 32))) ? list : null;
  const pin = meta?.pins?.[u] || null;
  const r = await obj.acceptList(pin && { aik: pin.aik, ver: pin.ver }, list);
  if (r.ok) {
    if (r.changed) ring.updateMeta((m) => { m.pins[u] = { aik: list.aik, ver: list.ver }; }).catch(() => {});
    return list;
  }
  if (r.why === 'aik-changed' && (await obj.verifyList(list))) {
    changed.set(u, list.aik);
    // Not verified before: the new key is pinned and the conversation says it changed.
    // Verified before: sending to them waits until the person chooses (sendGate).
    if (meta?.verified?.[u] !== pin.aik) ring.updateMeta((m) => { m.pins[u] = { aik: list.aik, ver: list.ver }; }).catch(() => {});
    return list;
  }
  return null;
}
async function fetchBundles(users, fresh = false) {
  const want = [...new Set(users)].filter((u) => fresh || !bundles.has(u));
  for (let i = 0; i < want.length; i += 10) {
    const r = await call('e2ee.bundles', { users: want.slice(i, i + 10) });
    for (const [u, b] of Object.entries(r.users)) {
      const list = b.list ? await accept(u, b.list) : null;
      if (list) remember(u, list);
      bundles.set(u, { list, prekeys: b.prekeys || {}, ready: !!b.ready });
    }
  }
  return users.map((u) => bundles.get(u));
}

/** Members a verified contact's send waits on: a verified person whose account key changed. */
export const sendGate = (members) => members.filter((u) => u !== S.me && changed.has(u) && ring.meta?.verified?.[u] && ring.meta.verified[u] !== changed.get(u));

// Recipients from verified lists and prekeys: every listed device with a valid prekey, and history keys.
async function recipients(users, fresh) {
  const got = await fetchBundles(users, fresh);
  const to = [], ar = [], lv = {};
  for (let i = 0; i < users.length; i++) {
    const u = users[i], b = got[i];
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
export async function uploadEncrypted(conv, blob, name) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { ct, meta } = await encryptFile(bytes);
  let res;
  try {
    res = await fetch(`/api/files?conv=${encodeURIComponent(conv)}&enc=1`, {
      method: 'POST', credentials: 'same-origin', body: ct,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'file' },
    });
  } catch { throw new Error(`Couldn’t upload ${name}. Check your connection and try again.`); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Couldn’t upload ${name}.`);
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
const opened = new Map(); // "id:rev" -> { body, flags } this device has opened (or sealed)
const keyOf = (id, rev) => `${id}:${rev}`;

async function sealAndSend(op, { conv, dm, id, kind, rev, users, body, re = null, extra = {} }) {
  const { dev } = ring;
  if (E2.status !== 'ready' || !dev) throw new Error('Turn on end-to-end encryption on this device to send here (Settings, Encryption).');
  const gate = sendGate(users);
  if (gate.length) throw Object.assign(new Error(`${S.users[gate[0]]?.name || 'Someone'}’s safety number changed. Check it in the conversation’s details before sending.`), { code: 'e2ee_gate' });
  let fresh = false;
  for (let tries = 0; tries < 3; tries++) {
    const rc = await recipients(users, fresh);
    const header = { conv: dm, place: conv, id, kind, rev, from: { u: S.me, d: dev.d }, ts: Date.now(), lv: rc.lv, ping: body.mentions || [], re };
    const { env, k, K } = await seal({ header, body, dsk: dev.dsk.privateKey, recipients: rc });
    opened.set(keyOf(id, rev), { body: { ...body, v: 1, conv: dm, place: conv, id, rev, from: header.from }, flags: [] });
    ring.store?.putSecret?.(`k:${keyOf(id, rev)}`, b64u(K)).catch?.(() => {});
    try {
      return await call(op, { conv, id, ...extra, e2ee: { ...env, k } });
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

/** An edit: a new envelope (rev + 1) for the original recipients who are still here. */
async function editEncrypted(conv, m, text) {
  const dm = rootDm(conv);
  const prev = m.e2ee?.h;
  if (!prev) throw new Error('Messages from before encryption was turned on can’t be edited here.');
  const before = opened.get(keyOf(m.id, prev.rev))?.body || {};
  const users = editSet(prev.to, membersOf(dm));
  const body = clean({ text, mentions: pingOf(text, users), files: before.files, sticker: before.sticker, fwd: before.fwd });
  await sealAndSend('msg.edit', { conv, dm, id: m.id, kind: 'edit', rev: prev.rev + 1, users, body });
}
msgHooks.edit = (conv, m, text) => {
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

/** Called for every message view that arrives. Opened before: filled in now; else queued. */
function see(m, conv) {
  if (m.enc === true && m.encRev === m.e2ee.h.rev) return;
  const key = keyOf(m.id, m.e2ee.h.rev);
  if (conv && conv !== m.e2ee.h.place) { failed(m, 'moved'); return; }
  m.encRev = m.e2ee.h.rev;
  const done = opened.get(key);
  if (done) { apply(m, done); return; }
  if (!m.enc || m.enc === true) m.enc = 'pending';
  const q = queue.get(key) || { views: new Set(), k: null };
  q.views.add(m);
  if (m.k) q.k = m.k;
  queue.set(key, q);
  clearTimeout(timer);
  timer = setTimeout(drain, 20);
}
// Message views inside any payload: { conv, m }, { conv, msgs: [...] }, { msgs: { conv: [...] } }, or anywhere else.
const isMsg = (o) => o && typeof o.id === 'string' && typeof o.author === 'string' && o.e2ee?.h;
export function scan(o, conv = null, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 7) return;
  if (Array.isArray(o)) { for (const x of o) scan(x, conv, depth + 1); return; }
  if (isMsg(o)) { see(o, conv); return; }
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object') continue;
    if (k === 'msgs' && !Array.isArray(v)) { for (const [c, list] of Object.entries(v)) scan(list, c, depth + 2); continue; }
    scan(v, (k === 'm' || k === 'msgs') && typeof o.conv === 'string' ? o.conv : null, depth + 1);
  }
}

async function drain() {
  if (!queue.size) return;
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
    try { Object.assign(wraps, (await call('e2ee.wraps', { ids: need.slice(i, i + 200) })).wraps); } catch { /* offline: opened from the cache or later */ }
  }
  const authors = [...new Set(batch.map(([, q]) => [...q.views][0].author))];
  try { await fetchBundles(authors); } catch { /* checked per message below */ }
  for (const [key, q] of batch) {
    const m = [...q.views][0];
    const id = key.slice(0, key.lastIndexOf(':'));
    try {
      const r = await openOne(m, q.k || wraps[id]?.k || {});
      opened.set(key, r);
      for (const v of q.views) apply(v, r);
      for (const fn of waiters.get(key) || []) fn(true);
    } catch (e) {
      const why = e instanceof OpenFailure ? e.reason : 'error';
      for (const v of q.views) failed(v, why);
      for (const fn of waiters.get(key) || []) fn(false);
    }
    waiters.delete(key);
  }
  emit();
}
async function openOne(m, wraps) {
  const { keys, dev, store } = ring;
  const h = m.e2ee.h;
  const senderDsk = knownDevs.get(m.author)?.get(h.from.d);
  if (!senderDsk) throw new OpenFailure('unknown device');
  const cachedKey = await store?.getSecret?.(`k:${keyOf(m.id, h.rev)}`).catch(() => null);
  const r = await open({
    env: m.e2ee, expect: { conv: h.conv, place: h.place, id: m.id, author: m.author },
    senderDsk: b64uOf(senderDsk, 32), me: { u: S.me, d: dev.d },
    keys: { device: (kid) => dev.prekeys[kid]?.pair || null, history: (e) => keys.ahk[e] || null, cached: cachedKey ? b64uOf(cachedKey, 32) : null },
    wraps,
  });
  // The thread a message says it is in must hang off the DM it says it is in.
  const t = h.place.startsWith('t:') ? S.threads[h.place] : null;
  if (t && t.conv !== h.conv) throw new OpenFailure('moved');
  if (!h.place.startsWith('t:') && h.place !== h.conv) throw new OpenFailure('moved');
  if (!cachedKey) store?.putSecret?.(`k:${keyOf(m.id, h.rev)}`, b64u(r.K)).catch?.(() => {});
  return { body: r.body, flags: r.flags };
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
  bundles.clear(); knownDevs.clear(); changed.clear(); opened.clear(); queue.clear(); fileKeys.clear(); parts.clear(); locked = [];
  for (const u of blobs.values()) URL.revokeObjectURL(u);
  blobs.clear();
});

// ---------- the transport's hooks (js/server.js) ----------
Object.assign(transportHooks, { scan, isEncrypted, sendEncrypted, uploadEncrypted, whenOpen });

// For the end-to-end checks.
export const _test = { opened, findMsg };
