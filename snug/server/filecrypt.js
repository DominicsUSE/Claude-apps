// Attachment files at rest (0.14). Every file the server keeps in <data>/files (uploads, GIF and sticker
// copies, link-preview pictures, friends' files fetched between PCs, pictures restored from a data file) is
// written encrypted under a key derived from the data key (server/auth.js loadDataKey: data/secret.key,
// mode 0600 and wrapped by the OS key store on the desktop, or SNUG_DATA_KEY).
//
// Format, AES-256-GCM in 64 KiB segments so a Range read decrypts only the segments it needs:
//   "SNUGF1" | key id (8) | nonce prefix (8, random per file) | plaintext size (8, big-endian)
//   then one box per segment: ciphertext | tag (16). Segment i's nonce is prefix | i (32-bit, big-endian),
//   its AAD "snug:files\n<file id>\n<size>\n<i>", so a segment can't be moved, a file can't be renamed to
//   another id, and the size (and so the last segment) can't be changed without the tags failing.
// Key: HKDF-SHA-256(data key, info "snug:files"). The key id (an HMAC of the key) lets one process hold
// several servers' keys (tests) and lets a file under a key this server doesn't have be told apart.
//
// Files without the magic are 0.13 and older files in plaintext: read as they are. reencryptDir() seals
// them in the background, each run going on where the last stopped (SNUG_FILES_REENCRYPT=off turns that off). Sizes in the database stay plaintext
// sizes, so quotas are unchanged.
//
// What this protects, honestly: a copy of the files folder, or a disk backup, taken without secret.key (or
// without the OS key store on the desktop) shows no attachment's contents. It does not protect against
// someone who controls the running server or can read secret.key: the server decrypts files to send them.
// Uploads still arriving (files/partial) and friends' files still being fetched (*.part) are plaintext
// until they are complete. End-to-end encrypted attachments are already opaque to the server; this adds
// a layer under them.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { openSync, readSync, writeSync, closeSync, fstatSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
import { Readable } from 'node:stream';

export const MAGIC = Buffer.from('SNUGF1');
export const SEG = 64 * 1024;
const TAG = 16;
const HEAD = MAGIC.length + 8 + 8 + 8;

export const filesKey = (dataKey) => Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), Buffer.from('snug:files'), 32));
const keyIdOf = (key) => createHmac('sha256', key).update('snug:files/key-id').digest().subarray(0, 8);

const writers = new Map(); // resolved directory -> [{ key, id }]: new files there are sealed under the newest
const keys = new Map();    // key id (hex) -> key: what can be opened
/** New files in `dir` are sealed under a key from `dataKey`. Returns a function that stops that. */
export function useFilesKey(dir, dataKey) {
  const key = filesKey(dataKey);
  const entry = { key, id: keyIdOf(key) };
  const at = resolve(dir);
  keys.set(entry.id.toString('hex'), key);
  writers.set(at, [...(writers.get(at) || []), entry]);
  return () => {
    const left = (writers.get(at) || []).filter((e) => e !== entry);
    if (left.length) writers.set(at, left); else writers.delete(at);
  };
}
const writerFor = (path) => writers.get(resolve(dirname(path)))?.at(-1) || null;
/** Whether new files written into `dir` are encrypted. */
export const sealsIn = (dir) => writers.has(resolve(dir));

const segCount = (size) => Math.ceil(size / SEG);
const sealedLength = (size) => HEAD + size + segCount(size) * TAG;
const segPlainLen = (size, i) => Math.min(SEG, size - i * SEG);
const segOffset = (i) => HEAD + i * (SEG + TAG);
const ivOf = (prefix, i) => { const b = Buffer.alloc(12); prefix.copy(b, 0); b.writeUInt32BE(i, 8); return b; };
const aadOf = (fileId, size, i) => Buffer.from(`snug:files\n${fileId}\n${size}\n${i}`);
const damaged = (why) => Object.assign(new Error(`file damaged: ${why}`), { code: 'EFILEDAMAGED' });

function sealSeg(h, i, plain) {
  const c = createCipheriv('aes-256-gcm', h.key, ivOf(h.prefix, i), { authTagLength: TAG });
  c.setAAD(aadOf(h.fileId, h.size, i));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function openSeg(h, i, box) {
  if (box.length !== segPlainLen(h.size, i) + TAG) throw damaged('short segment');
  const d = createDecipheriv('aes-256-gcm', h.key, ivOf(h.prefix, i), { authTagLength: TAG });
  d.setAAD(aadOf(h.fileId, h.size, i));
  d.setAuthTag(box.subarray(box.length - TAG));
  try { return Buffer.concat([d.update(box.subarray(0, box.length - TAG)), d.final()]); } catch { throw damaged('tag'); }
}
function headerOf(w, fileId, size) {
  const prefix = randomBytes(8);
  const b = Buffer.alloc(HEAD);
  MAGIC.copy(b, 0); w.id.copy(b, 6); prefix.copy(b, 14); b.writeBigUInt64BE(BigInt(size), 22);
  return { buf: b, h: { key: w.key, prefix, fileId, size } };
}
// What a file is, from its first bytes and length: { sealed: false, size } (plaintext), or
// { sealed: true, size, key, prefix, fileId }. Throws for a sealed file that can't be opened here.
function inspect(head, length, path) {
  if (head.length < HEAD || !head.subarray(0, 6).equals(MAGIC)) return { sealed: false, size: length };
  const size = Number(head.readBigUInt64BE(22));
  const key = keys.get(head.subarray(6, 14).toString('hex'));
  const fits = Number.isSafeInteger(size) && sealedLength(size) === length;
  // A plaintext file that merely starts with the magic (an old upload) is read as it is.
  if (!key && !fits) return { sealed: false, size: length };
  if (!key) throw Object.assign(new Error('file sealed under a key this server does not have'), { code: 'EFILEKEY' });
  if (!fits) throw damaged('length');
  return { sealed: true, size, key, prefix: Buffer.from(head.subarray(14, 22)), fileId: basename(path) };
}
function inspectFd(fd, path) {
  const head = Buffer.alloc(HEAD);
  const got = readSync(fd, head, 0, HEAD, 0);
  return inspect(head.subarray(0, got), fstatSync(fd).size, path);
}
async function inspectHandle(fh, path) {
  const head = Buffer.alloc(HEAD);
  const { bytesRead } = await fh.read(head, 0, HEAD, 0);
  return inspect(head.subarray(0, bytesRead), (await fh.stat()).size, path);
}

// ---------- Reading ----------
function readExact(fd, len, pos) {
  const b = Buffer.alloc(len);
  let o = 0;
  while (o < len) { const n = readSync(fd, b, o, len - o, pos + o); if (!n) throw damaged('short'); o += n; }
  return b;
}
// Plaintext bytes start..end (inclusive) of an open sealed file, synchronously.
function rangeSync(fd, h, start, end) {
  const out = [];
  for (let i = Math.floor(start / SEG); i <= Math.floor(end / SEG); i++) {
    const plain = openSeg(h, i, readExact(fd, segPlainLen(h.size, i) + TAG, segOffset(i)));
    out.push(plain.subarray(Math.max(0, start - i * SEG), Math.min(plain.length, end - i * SEG + 1)));
  }
  return Buffer.concat(out);
}
/** { size } of a stored file's plaintext. */
export function storedSize(path) {
  const fd = openSync(path, 'r');
  try { return inspectFd(fd, path).size; } finally { closeSync(fd); }
}
/** `len` plaintext bytes of a stored file from `off` (fewer at the end), sealed or not. */
export function readStoredRangeSync(path, off, len) {
  const fd = openSync(path, 'r');
  try {
    const info = inspectFd(fd, path);
    const end = Math.min(info.size, off + len) - 1;
    if (end < off) return Buffer.alloc(0);
    if (!info.sealed) { const b = Buffer.alloc(end - off + 1); const n = readSync(fd, b, 0, b.length, off); return b.subarray(0, n); }
    return rangeSync(fd, info, off, end);
  } finally { closeSync(fd); }
}
/** A stored file's whole plaintext. */
export function readStoredSync(path) {
  const fd = openSync(path, 'r');
  try {
    const info = inspectFd(fd, path);
    if (!info.sealed) return readExact(fd, info.size, 0);
    return info.size ? rangeSync(fd, info, 0, info.size - 1) : Buffer.alloc(0);
  } finally { closeSync(fd); }
}
export async function readStored(path) {
  const chunks = [];
  for await (const c of storedReadStream(path)) chunks.push(c);
  return Buffer.concat(chunks);
}
// Segments of plaintext from an open handle, each yielded only once its tag has checked out.
async function* plainChunks(fh, info, start, end) {
  for (let i = Math.floor(start / SEG); i <= Math.floor(end / SEG); i++) {
    const len = segPlainLen(info.size, i) + TAG;
    const box = Buffer.alloc(len);
    const { bytesRead } = await fh.read(box, 0, len, segOffset(i));
    const plain = openSeg(info, i, box.subarray(0, bytesRead));
    yield plain.subarray(Math.max(0, start - i * SEG), Math.min(plain.length, end - i * SEG + 1));
  }
}
/**
 * For sending: from an open file handle, { size, stream } where stream gives plaintext bytes start..end.
 * For a sealed file the first segment is decrypted and checked before this resolves, so a damaged file is
 * refused before any status line goes out (it rejects with code EFILEDAMAGED or EFILEKEY). The handle is
 * closed when the stream ends.
 */
export async function plainStream(fh, path, range = null) {
  const info = await inspectHandle(fh, path);
  if (!info.sealed) return { size: info.size, stream: fh.createReadStream(range ? { start: range.start, end: range.end } : {}) };
  const start = range ? range.start : 0, end = range ? range.end : info.size - 1;
  if (end < start) { await fh.close(); return { size: 0, stream: Readable.from([]) }; }
  const it = plainChunks(fh, info, start, end);
  let first;
  try { first = await it.next(); } catch (e) { await fh.close().catch(() => {}); throw e; }
  async function* all() {
    try { if (!first.done) yield first.value; yield* it; } finally { await fh.close().catch(() => {}); }
  }
  return { size: info.size, stream: Readable.from(all(), { objectMode: false }) };
}
/** A readable stream of a stored file's plaintext (sealed or not). */
export function storedReadStream(path, range = null) {
  return Readable.from((async function* () {
    const fh = await open(path, 'r');
    const { stream } = await plainStream(fh, path, range);
    for await (const c of stream) yield c;
  })(), { objectMode: false });
}

// ---------- Writing ----------
const tmpOf = (dst) => join(dirname(dst), `.${basename(dst)}.${randomBytes(4).toString('hex')}.sealing`);
const rmQuiet = (p) => { try { unlinkSync(p); } catch { /* gone */ } };
function writeAll(fd, buf) { let o = 0; while (o < buf.length) o += writeSync(fd, buf, o, buf.length - o); }

/** Writes `data` as the stored file `path`: sealed when its folder has a key (useFilesKey), else plaintext. */
export function writeStoredSync(path, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const w = writerFor(path);
  const tmp = tmpOf(path);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    if (!w) writeAll(fd, buf);
    else {
      const { buf: head, h } = headerOf(w, basename(path), buf.length);
      writeAll(fd, head);
      for (let i = 0; i < segCount(buf.length); i++) writeAll(fd, sealSeg(h, i, buf.subarray(i * SEG, (i + 1) * SEG)));
    }
    closeSync(fd);
    renameSync(tmp, path);
  } catch (e) { try { closeSync(fd); } catch { /* closed */ } rmQuiet(tmp); throw e; }
}
export async function writeStored(path, data) { writeStoredSync(path, data); }

// Copies plaintext from a reader (len, read(off, n) -> Buffer) into `dst`, sealing when its folder has a key.
async function writeFrom(dst, size, read, yieldEvery = 0, stillWanted = null) {
  const w = writerFor(dst);
  const tmp = tmpOf(dst);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    let h = null;
    if (w) { const x = headerOf(w, basename(dst), size); h = x.h; await fh.write(x.buf); }
    for (let i = 0, off = 0; off < size; i++, off += SEG) {
      const plain = read(off, Math.min(SEG, size - off));
      await fh.write(h ? sealSeg(h, i, plain) : plain);
      if (yieldEvery && i % yieldEvery === yieldEvery - 1) await new Promise((r) => setImmediate(r));
    }
    await fh.close();
    // Re-encrypting: a file deleted meanwhile must not come back.
    if (stillWanted && !stillWanted()) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    renameSync(tmp, dst);
  } catch (e) { await fh.close().catch(() => {}); rmQuiet(tmp); throw e; }
}
function writeFromSync(dst, size, read) {
  const w = writerFor(dst);
  const tmp = tmpOf(dst);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    let h = null;
    if (w) { const x = headerOf(w, basename(dst), size); h = x.h; writeAll(fd, x.buf); }
    for (let i = 0, off = 0; off < size; i++, off += SEG) {
      const plain = read(off, Math.min(SEG, size - off));
      writeAll(fd, h ? sealSeg(h, i, plain) : plain);
    }
    closeSync(fd);
    renameSync(tmp, dst);
  } catch (e) { try { closeSync(fd); } catch { /* closed */ } rmQuiet(tmp); throw e; }
}
// A reader over a stored source file (sealed or plaintext), for the copies below.
function sourceOf(fd, path) {
  const info = inspectFd(fd, path);
  return { size: info.size, read: (off, n) => (info.sealed ? rangeSync(fd, info, off, off + n - 1) : readExact(fd, n, off)) };
}

/**
 * A plaintext file (an upload just assembled, a friend's file just fetched) stored as `dst`: sealed when its
 * folder has a key. The source is removed once `dst` is in place (dst may be the source itself: re-encrypting).
 */
export async function sealFile(src, dst) {
  const fd = openSync(src, 'r');
  let open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  try {
    const st = fstatSync(fd);
    const same = resolve(src) === resolve(dst);
    const unchanged = () => { try { const now = statSync(src); return now.ino === st.ino && now.size === st.size; } catch { return false; } };
    // Sealing in place: the source is closed before the sealed copy is renamed over it, since Windows won't
    // replace a file that is still open (Linux and macOS would).
    await writeFrom(dst, st.size, (off, n) => readExact(fd, n, off), 16, same ? () => { close(); return unchanged(); } : null);
  } finally { close(); }
  if (resolve(src) !== resolve(dst)) rmQuiet(src);
}
/** A stored file copied to a new id (GIF reuse, forwards, link previews): decrypted and sealed again for its new id. */
export async function copyStored(src, dst) {
  const fd = openSync(src, 'r');
  try { const s = sourceOf(fd, src); await writeFrom(dst, s.size, s.read, 16); } finally { closeSync(fd); }
}
export function copyStoredSync(src, dst) {
  const fd = openSync(src, 'r');
  try { const s = sourceOf(fd, src); writeFromSync(dst, s.size, s.read); } finally { closeSync(fd); }
}
/** Whether the stored file at `path` is sealed (false for plaintext; throws when it can't be read). */
export function isSealed(path) {
  const fd = openSync(path, 'r');
  try { return inspectFd(fd, path).sealed; } finally { closeSync(fd); }
}

// ---------- Re-encrypting older files ----------
const STORED = /^(f_|lc_)[A-Za-z0-9_-]{4,80}$/;
/**
 * Seals plaintext files left by older versions, a few at a time. keep(name): false for a file that is going
 * away (no row), which is left alone. Returns { sealed, checked }. Never touches files being written (*.part,
 * files/partial) or files it can't read.
 */
const cursors = new Map(); // resolved directory -> the last name a run checked there
export async function reencryptDir(dir, { limit = 200, keep = () => true, log = () => {} } = {}) {
  const out = { sealed: 0, checked: 0 };
  if (!sealsIn(dir)) return out;
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  // Each run goes on after the last name the one before checked, then round from the start, so files passed
  // over (or that fail to seal) never hold up the rest.
  const at = resolve(dir), from = cursors.get(at) ?? '';
  names = [...names.filter((n) => n > from), ...names.filter((n) => n <= from)];
  for (const name of names) {
    // A temp file a crash left mid-write: gone after an hour.
    if (name.startsWith('.') && name.endsWith('.sealing')) { try { if (statSync(join(dir, name)).mtimeMs < Date.now() - 3600_000) unlinkSync(join(dir, name)); } catch { /* gone */ } continue; }
    if (out.checked >= limit) break;
    if (!STORED.test(name)) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); if (!st.isFile() || isSealed(path)) continue; } catch { continue; }
    out.checked++;
    cursors.set(at, name);
    if (!keep(name)) continue;
    try {
      await sealFile(path, path);
      out.sealed++;
    } catch (e) { log('files', 're-encrypt', name, e.code || e.message); }
    await new Promise((r) => setImmediate(r));
  }
  return out;
}
export const _test = { HEAD, sealedLength };
