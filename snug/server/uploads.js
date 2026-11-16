// Files people attach, on the server: the one-request upload (POST /api/files)
// and chunked, resumable uploads for big files (/api/uploads).
//
// Both stream to disk; no upload is ever held whole in memory. Both check the
// same things before a byte is stored: that you may post in the conversation,
// the per-file limit, your quota and the house's quota (uploads still in
// progress count, so two at once can't slip past), and that the disk keeps a
// floor of free space. The type is checked against the file's first bytes
// once it is complete, exactly as before (server/media.js uploadType).
//
// Chunked protocol (also used for end-to-end encrypted attachments, which are
// opaque bytes sent as application/octet-stream):
//   GET  /api/uploads                     -> { maxFile, chunk, used, quota }
//   POST /api/uploads {conv,name,size,type} -> 201 { id, chunk, received: 0 }
//   POST /api/uploads/<id>?offset=N       body: raw bytes, at most `chunk`,
//                                           N must equal what the server has -> { received }
//                                           (409 { received } otherwise: carry on from there)
//   GET  /api/uploads/<id>                -> { id, size, received, chunk } (to resume)
//   POST /api/uploads/<id>/done           -> 201 { id: 'f_…', name, size, kind } (the same as /api/files)
//   POST /api/uploads/<id>/cancel         -> {}
// Every call is POST or GET, so the server's cross-site check covers them all.
import { createWriteStream, statfsSync, openSync, readSync, closeSync, writeFileSync, unlinkSync, statSync, truncateSync, readdirSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import { newId } from './model.js';
import { uploadType, fileKind } from './media.js';
import { cleanFileName } from '../js/lib/util.js';
import { safeDecode } from './auth.js';
import { sealFile } from './filecrypt.js'; // 0.14: stored encrypted at rest

const MB = 1024 * 1024;
const ABANDONED_MS = 24 * 3600_000;
const MAX_OPEN = 8; // unfinished uploads per person

// Limits from the environment (sizes in MB), with defaults for a host server.
// A setting that isn't a whole number keeps its default; 0 turns a quota off.
export function uploadLimits(env = process.env) {
  const mb = (k, d) => (/^\d{1,7}$/.test(String(env[k] ?? '')) ? Number(env[k]) : d) * MB;
  return {
    maxFile: Math.max(MB, mb('SNUG_MAX_FILE_MB', 100)),
    chunk: 4 * MB,
    quota: mb('SNUG_QUOTA_MB', 2048),
    houseQuota: mb('SNUG_HOUSE_QUOTA_MB', 10240),
    diskFloor: mb('SNUG_DISK_FLOOR_MB', 1024),
  };
}

// "600 KB", "100 MB", "1.5 GB": for messages that name a limit.
export function sizeText(n) {
  if (n >= 1024 * MB) return `${Math.round((n / (1024 * MB)) * 10) / 10} GB`;
  if (n >= MB) return `${Math.round((n / MB) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, expose: true, extra });

// `encrypted(conv)` says whether a conversation is end-to-end encrypted (server/e2ee-conv.js). Such a
// conversation takes only files encrypted on the device (?enc=1 or { enc: true }): stored as an opaque blob
// named "file", never sniffed; the real name, type and key travel inside the encrypted message.
export function createUploads({ db, M, filesDir, sendJson, error, jsonBody, uploadLimit, encrypted = () => false, opts = {}, log = () => {} }) {
  const L = { ...uploadLimits(opts.env || process.env), ...Object.fromEntries(Object.entries(opts).filter(([k, v]) => ['maxFile', 'chunk', 'quota', 'houseQuota', 'diskFloor'].includes(k) && Number.isFinite(v))) };
  const statfs = opts.statfs || ((p) => statfsSync(p));
  const partDir = join(filesDir, 'partial');
  mkdirSync(partDir, { recursive: true, mode: 0o700 });
  db.raw.exec(`CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, conv TEXT NOT NULL, house TEXT, name TEXT NOT NULL, type TEXT NOT NULL,
    size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, touched INTEGER NOT NULL
  )`);
  db.raw.exec('CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner)');
  try { db.raw.exec('ALTER TABLE uploads ADD COLUMN enc INTEGER'); } catch { /* already there */ }
  const GCM_TAG = 16; // what AES-GCM adds to an encrypted file
  // Throws unless the upload's encryption matches the conversation's.
  function encMatches(conv, enc) {
    const encConv = !!encrypted(realConv(conv));
    if (enc !== encConv) throw httpError(409, encConv ? 'This conversation is end-to-end encrypted. Reload Snug to attach files here.' : 'This conversation isn’t end-to-end encrypted.');
  }
  const writing = new Set(); // upload ids with a part being written right now

  // A not-yet-started thread ("t:<message>") belongs to its root's conversation.
  const realConv = (conv) => (conv.startsWith('t:') && !M.thread(conv) ? (M.liveMsg(conv.slice(2))?.conv || '') : conv);

  // One-request uploads still streaming (they have no row): { user, house, size } by temp id. review-media 1.
  const inflight = new Map();
  const inflightSum = (pick) => { let n = 0; for (const f of inflight.values()) if (pick(f)) n += f.size; return n; };

  // Bytes a person has stored (files they own) plus uploads they have under way.
  const usedBy = (user, except = '') => db.get('SELECT COALESCE(SUM(size), 0) n FROM files WHERE owner = ?', user).n
    + db.get('SELECT COALESCE(SUM(size), 0) n FROM uploads WHERE owner = ? AND id != ?', user, except).n
    + inflightSum((f) => f.user === user);
  // Bytes stored in a house's rooms and threads, plus uploads under way into it.
  const usedInHouse = (house, except = '') => db.get(`SELECT COALESCE(SUM(size), 0) n FROM files WHERE conv IN (SELECT id FROM rooms WHERE house = ?)
      OR conv IN (SELECT t.id FROM threads t JOIN rooms r ON r.id = t.conv WHERE r.house = ?)`, house, house).n
    + db.get('SELECT COALESCE(SUM(size), 0) n FROM uploads WHERE house = ? AND id != ?', house, except).n
    + inflightSum((f) => f.house === house);
  // Free space, less what unfinished uploads have been promised but not yet written.
  function freeDisk(except = '') {
    let free;
    try { const s = statfs(filesDir); free = Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
    const owed = db.get('SELECT COALESCE(SUM(MAX(size - received, 0)), 0) n FROM uploads WHERE id != ?', except).n + inflightSum(() => true);
    return free - owed;
  }

  // Everything checked before a byte is stored. Throws an error with a status and a message for people.
  function admit(user, conv, size, except = '', enc = false) {
    const gate = M.postGate(user, realConv(conv));
    if (!gate.ok) throw httpError(403, gate.why);
    encMatches(conv, enc);
    if (size > L.maxFile + (enc ? GCM_TAG : 0)) throw httpError(413, `Files can be up to ${sizeText(L.maxFile)} on this server.`);
    return roomFor(user, conv, size, except);
  }
  // The quotas and the disk floor: for uploads and for every copy the server makes (forwards, stickers, GIFs,
  // link previews; review-media 1). Throws an error with a status and a message for people.
  function roomFor(user, conv, size, except = '') {
    if (L.quota && usedBy(user, except) + size > L.quota) {
      throw httpError(413, `There’s no more room for your files on this server (${sizeText(L.quota)} each). Delete messages with big files, or ask whoever runs the server for more room.`);
    }
    const house = M.where(realConv(conv))?.house || null;
    if (house && L.houseQuota && usedInHouse(house, except) + size > L.houseQuota) {
      throw httpError(413, `This house is out of room for files (${sizeText(L.houseQuota)} on this server). Ask whoever runs the server for more room.`);
    }
    if (freeDisk(except) - size < L.diskFloor) throw httpError(507, 'The server is nearly out of disk space, so it can’t take this file right now. Try a smaller one, or tell whoever runs the server.');
    return { house };
  }

  // The first bytes of a file on disk, for the type check.
  function head(path, n = 4096) {
    const fd = openSync(path, 'r');
    try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { closeSync(fd); }
  }
  // Streams a request body into a file at `start`, refusing more than `max` bytes. Resolves the bytes written.
  async function streamTo(req, path, { start = 0, max, flags }) {
    let n = 0;
    const cap = new Transform({
      transform(c, _e, cb) { n += c.length; if (n > max) cb(httpError(413, 'too big')); else cb(null, c); },
    });
    await pipeline(req, cap, createWriteStream(path, { flags, start, mode: 0o600 }));
    return n;
  }
  const rm = (p) => { try { unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') log('error', 'upload cleanup', e); } };
  // 0.14: the assembled plaintext is sealed into place under the files key (server/filecrypt.js) and removed.
  async function storeFile({ user, conv, name, header, path, size, enc = false }) {
    const type = enc ? 'application/octet-stream' : uploadType(header, head(path));
    const id = newId('f');
    await sealFile(path, join(filesDir, id));
    db.run('INSERT INTO files (id, owner, conv, name, type, size, created, enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user, conv, enc ? 'file' : name, type, size, Date.now(), enc ? 1 : null);
    return { id, name: enc ? 'file' : name, size, kind: enc ? 'file' : fileKind(type) };
  }
  const fail = (res, e) => (e.extra ? sendJson(res, e.status, { error: e.message, ...e.extra }) : error(res, e.status, e.message));

  // POST /api/files?conv=…: one request, streamed to disk, the same checks as a chunked upload.
  async function single(req, res, url, user) {
    if (!uploadLimit.take(user)) return error(res, 429, 'Too many uploads at once. Wait a moment.');
    const conv = url.searchParams.get('conv') || '';
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0) return error(res, 411, 'Snug needs the file’s size. Try attaching it again.');
    const enc = url.searchParams.get('enc') === '1';
    let house;
    try { ({ house } = admit(user, conv, size, '', enc)); } catch (e) { if (e.expose) return fail(res, e); throw e; }
    const name = enc ? 'file' : cleanFileName(safeDecode(String(req.headers['x-file-name'] || 'file'))); // sec-authz: no bidi or zero-width characters (js/lib/util.js)
    const sid = newId('s');
    const tmp = join(partDir, sid);
    // Counted while it streams, so a second upload at the same time can't slip past the quota or the floor.
    inflight.set(sid, { user, house, size });
    try {
      let got;
      try { got = await streamTo(req, tmp, { max: size, flags: 'w' }); } catch (e) {
        rm(tmp);
        if (e.status === 413) return error(res, 413, 'That file is bigger than it said it was.');
        throw e;
      }
      if (got !== size) { rm(tmp); return error(res, 400, 'The file didn’t arrive whole. Try again.'); }
      let stored;
      try { stored = await storeFile({ user, conv, name, header: req.headers['content-type'], path: tmp, size, enc }); } finally { rm(tmp); }
      return sendJson(res, 201, stored);
    } finally { inflight.delete(sid); }
  }

  const UP = /^\/api\/uploads\/(u_[a-z0-9]{8,40})(\/done|\/cancel)?$/;
  async function http(req, res, path, url, user) {
    if (path !== '/api/uploads' && !path.startsWith('/api/uploads/')) return false;
    const post = req.method === 'POST';
    try {
      if (path === '/api/uploads' && req.method === 'GET') {
        sendJson(res, 200, { maxFile: L.maxFile, chunk: L.chunk, used: usedBy(user), quota: L.quota || null });
        return true;
      }
      if (path === '/api/uploads' && post) {
        if (!uploadLimit.take(user)) throw httpError(429, 'Too many uploads at once. Wait a moment.');
        const d = await jsonBody(req);
        const conv = typeof d.conv === 'string' ? d.conv : '';
        const size = d.size;
        if (!Number.isSafeInteger(size) || size <= 0) throw httpError(400, 'That file’s size isn’t valid.');
        if (db.get('SELECT COUNT(*) n FROM uploads WHERE owner = ?', user).n >= MAX_OPEN) throw httpError(429, 'You have too many uploads under way. Let them finish first.');
        const enc = d.enc === true;
        const { house } = admit(user, conv, size, '', enc);
        const name = enc ? 'file' : cleanFileName(typeof d.name === 'string' ? d.name : 'file');
        const type = !enc && typeof d.type === 'string' ? d.type.slice(0, 100) : 'application/octet-stream';
        const id = newId('u');
        writeFileSync(join(partDir, id), '', { mode: 0o600, flag: 'wx' });
        const now = Date.now();
        db.run('INSERT INTO uploads (id, owner, conv, house, name, type, size, received, created, touched, enc) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)', id, user, conv, house, name, type, size, now, now, enc ? 1 : null);
        sendJson(res, 201, { id, chunk: L.chunk, received: 0 });
        return true;
      }
      const m = UP.exec(path);
      if (!m) throw httpError(404, 'Not found');
      const row = db.get('SELECT * FROM uploads WHERE id = ? AND owner = ?', m[1], user);
      if (!row) throw httpError(404, 'That upload has ended. Attach the file again.');
      const part = join(partDir, row.id);
      if (!m[2] && req.method === 'GET') { sendJson(res, 200, { id: row.id, size: row.size, received: row.received, chunk: L.chunk }); return true; }
      if (!post) throw httpError(405, 'Method not allowed');
      if (m[2] === '/cancel') {
        db.run('DELETE FROM uploads WHERE id = ?', row.id);
        if (!writing.has(row.id)) rm(part);
        sendJson(res, 200, {});
        return true;
      }
      if (m[2] === '/done') {
        if (row.received !== row.size) throw httpError(409, 'That upload isn’t finished yet.', { received: row.received });
        if (writing.has(row.id)) throw httpError(409, 'That upload is still being written.', { received: row.received });
        // Permission may have changed while it uploaded.
        const gate = M.postGate(user, realConv(row.conv));
        if (!gate.ok) throw httpError(403, gate.why);
        encMatches(row.conv, !!row.enc);
        if (statSync(part).size !== row.size) truncateSync(part, row.size);
        // Still counted (the row stays) and not written to while it is sealed; a cancel meanwhile wins.
        writing.add(row.id);
        let stored;
        try { stored = await storeFile({ user, conv: row.conv, name: row.name, header: row.type, path: part, size: row.size, enc: !!row.enc }); } finally { writing.delete(row.id); rm(part); }
        if (!db.get('SELECT 1 FROM uploads WHERE id = ?', row.id)) {
          db.run('DELETE FROM files WHERE id = ?', stored.id);
          rm(join(filesDir, stored.id));
          throw httpError(404, 'That upload was cancelled.');
        }
        db.run('DELETE FROM uploads WHERE id = ?', row.id);
        sendJson(res, 201, stored);
        return true;
      }
      // A part. Only the next bytes, never past the declared size, never two at once.
      const offset = Number(url.searchParams.get('offset'));
      if (!Number.isSafeInteger(offset) || offset !== row.received || writing.has(row.id)) {
        throw httpError(409, 'That part is out of order. Carry on from where the server is.', { received: row.received });
      }
      const len = Number(req.headers['content-length']);
      const max = Math.min(L.chunk, row.size - offset);
      if (Number.isFinite(len) && len > max) throw httpError(413, 'That part is too big.');
      writing.add(row.id);
      let n;
      try {
        n = await streamTo(req, part, { start: offset, max, flags: 'r+' });
      } catch (e) {
        // A cut connection or a part too big: nothing past `received` counts, and the next try overwrites it.
        if (e.status === 413) throw httpError(413, 'That part is too big.');
        if (res.destroyed || req.aborted || e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'ECONNRESET') { res.destroy(); return true; }
        throw e;
      } finally { writing.delete(row.id); }
      if (!db.get('SELECT 1 FROM uploads WHERE id = ?', row.id)) { rm(part); throw httpError(404, 'That upload was cancelled.'); }
      db.run('UPDATE uploads SET received = ?, touched = ? WHERE id = ?', offset + n, Date.now(), row.id);
      sendJson(res, 200, { received: offset + n });
      return true;
    } catch (e) {
      if (!e.expose) throw e;
      fail(res, e);
      return true;
    }
  }

  // Uploads nobody touched for a day: row and bytes. Part files with no row (a crash) go too.
  function sweep(now = Date.now()) {
    let removed = 0;
    for (const r of db.all('SELECT id FROM uploads WHERE touched < ? LIMIT 500', now - ABANDONED_MS)) {
      if (writing.has(r.id)) continue;
      db.run('DELETE FROM uploads WHERE id = ?', r.id);
      rm(join(partDir, r.id));
      removed++;
    }
    let names = [];
    try { names = readdirSync(partDir); } catch { /* none */ }
    for (const n of names) {
      if (writing.has(n) || (n.startsWith('u_') && db.get('SELECT 1 FROM uploads WHERE id = ?', n))) continue;
      try { if (statSync(join(partDir, n)).mtimeMs < now - ABANDONED_MS) rm(join(partDir, n)); } catch { /* gone */ }
    }
    return removed;
  }

  // For server-side copies: null when there's room, or the refusal ({ status, message }).
  function room(user, conv, size) {
    try { roomFor(user, conv, Number(size) || 0); return null; } catch (e) { if (e.expose) return { status: e.status, message: e.message }; throw e; }
  }
  // For copies written with an await between the check and the files row (GIF reuse and import):
  // { refused } or { release }. The bytes count as in flight until release(), so copies made at the
  // same time can't all pass the check before any is stored (review-media 1).
  function hold(user, conv, size) {
    const n = Number(size) || 0;
    let house;
    try { ({ house } = roomFor(user, conv, n)); } catch (e) { if (e.expose) return { refused: { status: e.status, message: e.message } }; throw e; }
    const sid = newId('s');
    inflight.set(sid, { user, house, size: n });
    return { release: () => { inflight.delete(sid); } };
  }

  return { http, single, sweep, room, hold, limits: L };
}
