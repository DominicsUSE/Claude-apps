// Media between PCs (design section 5.6): content-addressed (sha256), sent in
// parts of at most 24 KB over a link, fetched only when needed, written
// contiguously into a .part file that may never pass the size declared by the
// message or profile that refers to it, checked against its hash, then kept.
// One transfer per friend and four in all; the rest wait in a short queue.
import { createReadStream, openSync, writeSync, closeSync, unlinkSync, renameSync, readSync, fstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const PART = 24 * 1024;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const HASH = /^[A-Za-z0-9_-]{43}$/;

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('base64url')));
  });
}

export function createBlobs({ db, filesDir, sendEph, canServe, log = () => {}, stats }) {
  const active = new Map();   // uid -> transfer
  const queue = [];           // { uid, job, resolve }
  let total = 0;

  // The hash of a local file, computed once (streamed, F18) and remembered.
  async function hashOf(fileId) {
    const row = db.get('SELECT id, meta FROM files WHERE id = ?', fileId);
    if (!row) return null;
    const meta = json(row.meta, {});
    if (meta.hash) return meta.hash;
    const hash = await hashFile(join(filesDir, row.id));
    const fresh = db.get('SELECT meta FROM files WHERE id = ?', fileId);
    if (!fresh) return null;
    db.run('UPDATE files SET meta = ? WHERE id = ?', JSON.stringify({ ...json(fresh.meta, {}), hash }), fileId);
    db.run('INSERT INTO peer_hash (hash, file) VALUES (?, ?) ON CONFLICT (hash) DO UPDATE SET file = excluded.file', hash, fileId);
    return hash;
  }

  // ---------- Serving my files ----------
  let serving = 0;
  async function serve(uid, d) {
    const h = d?.h, o = d?.o, n = Math.min(8, Math.max(1, Number(d?.n) || 1));
    if (typeof h !== 'string' || !HASH.test(h) || !Number.isSafeInteger(o) || o < 0) return;
    const ref = db.get('SELECT file FROM peer_hash WHERE hash = ?', h);
    const row = ref && db.get('SELECT * FROM files WHERE id = ?', ref.file);
    if (!row || !canServe(uid, row) || o > row.size) { sendEph(uid, 'blob.miss', { h }); return; }
    if (serving >= 8) { sendEph(uid, 'blob.miss', { h, busy: true }); return; }
    serving++;
    let fd;
    try {
      fd = openSync(join(filesDir, row.id), 'r');
      let off = o;
      for (let i = 0; i < n && off < row.size; i++) {
        const buf = Buffer.alloc(Math.min(PART, row.size - off));
        const got = readSync(fd, buf, 0, buf.length, off);
        if (!sendEph(uid, 'blob.part', { h, o: off, d: buf.subarray(0, got).toString('base64') })) break;
        off += got;
        await new Promise((r) => setImmediate(r)); // F18: let the main thread breathe between parts
      }
    } catch (e) { log('peer', 'blob serve', e.code || e.message); sendEph(uid, 'blob.miss', { h }); } finally {
      if (fd != null) try { closeSync(fd); } catch { /* closed */ }
      serving--;
    }
  }

  // ---------- Fetching a friend's file ----------
  // job: { h, size, id (local file id), cap }. Resolves true when the file is on disk and matches its hash.
  function fetch(uid, job) {
    if (!HASH.test(job.h) || !Number.isSafeInteger(job.size) || job.size < 0 || job.size > job.cap) return Promise.resolve(false);
    if (active.get(uid)?.job.id === job.id) return active.get(uid).promise;
    const queued = queue.find((q) => q.uid === uid && q.job.id === job.id);
    if (queued) return queued.promise;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    if (queue.length >= 100) return Promise.resolve(false);
    queue.push({ uid, job, resolve, promise });
    next();
    return promise;
  }
  function next() {
    for (let i = 0; i < queue.length && total < 4; i++) {
      const q = queue[i];
      if (active.has(q.uid)) continue;
      queue.splice(i, 1);
      i--;
      begin(q);
    }
  }
  function begin(q) {
    const path = join(filesDir, `${q.job.id}.part`);
    let fd;
    try { fd = openSync(path, 'w', 0o600); } catch { q.resolve(false); return; }
    const t = { ...q, path, fd, written: 0, hash: createHash('sha256'), timer: null };
    active.set(q.uid, t);
    total++;
    if (q.job.size === 0) { finish(t); return; }
    ask(t);
  }
  function ask(t) {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => end(t, false, 'timeout'), 20_000);
    t.timer.unref?.();
    // One outstanding request per friend, up to 8 parts (S4).
    if (!sendEph(t.uid, 'blob.get', { h: t.job.h, o: t.written, n: 8 })) end(t, false, 'link down');
  }
  function onPart(uid, d) {
    const t = active.get(uid);
    if (!t || d?.h !== t.job.h || typeof d.d !== 'string') return;
    // Only the next bytes, never past the declared size (S4).
    if (d.o !== t.written) { end(t, false, 'out of order'); return; }
    const buf = Buffer.from(d.d, 'base64');
    if (!buf.length || buf.length > PART || t.written + buf.length > t.job.size) { end(t, false, 'too big'); return; }
    try { writeSync(t.fd, buf); } catch { end(t, false, 'write'); return; }
    t.hash.update(buf);
    t.written += buf.length;
    if (t.written === t.job.size) { finish(t); return; }
    if (t.written % (8 * PART) === 0) ask(t);
    else { clearTimeout(t.timer); t.timer = setTimeout(() => end(t, false, 'timeout'), 20_000); t.timer.unref?.(); }
  }
  function onMiss(uid, d) { const t = active.get(uid); if (t && d?.h === t.job.h) end(t, false, 'missing'); }
  function finish(t) {
    if (t.hash.digest('base64url') !== t.job.h) { end(t, false, 'hash'); return; }
    try { closeSync(t.fd); t.fd = null; renameSync(t.path, join(filesDir, t.job.id)); } catch { end(t, false, 'rename'); return; }
    stats.blobsFetched++;
    end(t, true);
  }
  function end(t, ok, why) {
    if (active.get(t.uid) !== t) return;
    clearTimeout(t.timer);
    active.delete(t.uid);
    total--;
    if (t.fd != null) try { closeSync(t.fd); } catch { /* closed */ }
    if (!ok) { try { unlinkSync(t.path); } catch { /* none */ } log('peer', 'blob failed', why); }
    t.resolve(ok);
    next();
  }
  function peerDown(uid) {
    const t = active.get(uid);
    if (t) end(t, false, 'link down');
  }
  // The first bytes of a fetched file, for sniffing its real type.
  function head(fileId, n = 64 * 1024) {
    const p = join(filesDir, fileId);
    if (!existsSync(p)) return Buffer.alloc(0);
    const fd = openSync(p, 'r');
    try { const size = Math.min(n, fstatSync(fd).size); const b = Buffer.alloc(size); readSync(fd, b, 0, size, 0); return b; } finally { closeSync(fd); }
  }
  return {
    hashOf, serve, fetch, onPart, onMiss, peerDown, head,
    busy: (uid) => active.has(uid),
    close() { for (const t of [...active.values()]) end(t, false, 'closing'); queue.splice(0).forEach((q) => q.resolve(false)); },
  };
}
