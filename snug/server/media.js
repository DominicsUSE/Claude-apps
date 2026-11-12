// Voice messages, pinned messages and GIFs, on the server.
//
// - Voice messages are ordinary uploads with an audio type. The type a browser
//   claims is checked against the file's first bytes, and the message stores
//   the length and a small waveform the sender's browser measured.
// - Pins belong to a room or a direct conversation, at most 50 each. In a
//   house, pinning needs the 'pin' or the 'moderate' permission; in a direct
//   conversation or group, anyone in it may pin.
// - GIFs: favourites are references to files you can read, synced to every
//   device. Search goes through a provider (Tenor) only when a key is set, and
//   a GIF picked from search is downloaded by the server and stored as a
//   normal Snug file, so no message ever loads from another site.
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from './model.js';
import { limiter } from './auth.js';

export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'];
export const MAX_PINS = 50;
export const MAX_GIF_FAVS = 200;
export const MAX_VOICE_SECONDS = 300;
const MAX_FILE = 10 * 1024 * 1024;
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };

// What a file really is, from its first bytes.
export function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const s = (a, b) => buf.toString('latin1', a, b);
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && s(4, 8) === 'ftyp') return s(8, 11) === 'M4A' ? 'audio/mp4' : 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (s(0, 4) === 'OggS') return 'audio/ogg';
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

// The type an upload is stored with. Audio may arrive with codec parameters
// ("audio/webm;codecs=opus"); it keeps its audio type only if the bytes agree.
export function uploadType(header, data) {
  const t = String(header || '').split(';')[0].trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(t)) return 'application/octet-stream';
  const real = sniff(data);
  if (t === 'video/mp4') return real === 'mp4' ? t : 'application/octet-stream';
  if (!AUDIO_TYPES.includes(t)) return t;
  const ok = (t === 'audio/webm' && real === 'webm')
    || (t === 'audio/ogg' && real === 'audio/ogg')
    || (t === 'audio/mp4' && (real === 'audio/mp4' || real === 'mp4'))
    || (t === 'audio/mpeg' && real === 'audio/mpeg');
  return ok ? t : 'application/octet-stream';
}

export function fileKind(type, meta) {
  if (AUDIO_TYPES.includes(type)) return 'audio';
  if (type === 'video/mp4' && meta?.gif) return 'video';
  return type.startsWith('image/') ? 'image' : 'file';
}
const isGif = (row) => row.type === 'image/gif' || !!json(row.meta, {})?.gif;

// Called by msg.send for each attachment: voice length and waveform, and
// whether it is a GIF (so people can save it to their GIFs).
export function decorateFile(out, row, f, fail) {
  const meta = json(row.meta, {});
  out.kind = fileKind(row.type, meta);
  if (out.kind === 'audio') {
    if (f.duration != null) {
      if (typeof f.duration !== 'number' || !Number.isFinite(f.duration) || f.duration <= 0) fail('That voice message’s length isn’t valid.');
      if (f.duration > MAX_VOICE_SECONDS + 1) fail('Voice messages can be up to 5 minutes.');
      out.duration = Math.round(f.duration * 10) / 10;
    }
    if (f.peaks != null) {
      if (!Array.isArray(f.peaks) || !f.peaks.length || f.peaks.length > 128 || !f.peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
        fail('That voice message’s waveform isn’t valid.');
      }
      out.peaks = f.peaks;
    }
  }
  if (isGif(row)) out.gif = true;
  if (out.kind === 'video' || (out.gif && out.kind === 'image')) {
    const w = Number.isInteger(f.w) ? f.w : meta.w, h = Number.isInteger(f.h) ? f.h : meta.h;
    if (Number.isInteger(w) && Number.isInteger(h)) { out.w = Math.min(8000, Math.max(1, w)); out.h = Math.min(8000, Math.max(1, h)); }
  }
  return out;
}

// Range: bytes=a-b. Null for the whole file, 'bad' for a range that can't be
// served. A header that doesn't parse, or asks for several ranges, is ignored
// (RFC 9110 14.2): the whole file, not an error.
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    if (Number(m[2]) === 0) return 'bad'; // the last zero bytes
    start = Math.max(0, size - Number(m[2])); end = size - 1;
  } else {
    start = Number(m[1]);
    if (m[2] !== '' && Number(m[2]) < start) return null; // not a valid range
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!size || start >= size) return 'bad';
  return { start, end };
}

// The conversation a file was shared in (a file shared in a not-yet-started thread belongs to its root's conversation).
function fileConv(M, row) {
  if (!row) return null;
  return row.conv.startsWith('t:') && !M.thread(row.conv) ? M.liveMsg(row.conv.slice(2))?.conv : row.conv;
}
const readableFile = (M, user, row) => { const c = fileConv(M, row); return !!c && M.canRead(user, c); };

// Pins in one conversation, newest first. Pins on deleted messages don't show.
export function pinsOf(db, M, conv) {
  return db.all('SELECT msg AS id, by, at FROM pins WHERE conv = ? ORDER BY at DESC', conv)
    .filter((p) => M.liveMsg(p.id)?.conv === conv);
}

export function gifFavsFor(db, M, user) {
  return db.all('SELECT g.file, g.w, g.h, g.at, f.* FROM gif_favs g JOIN files f ON f.id = g.file WHERE g.user = ? ORDER BY g.at DESC', user)
    .filter((r) => readableFile(M, user, r))
    .map((r) => ({ id: r.file, name: r.name, size: r.size, w: r.w ?? undefined, h: r.h ?? undefined, kind: fileKind(r.type, json(r.meta, {})), at: r.at }));
}

// Added to every snapshot: pins in each readable room and conversation, and your GIFs.
export function addMediaSnapshot(db, M, user, snap) {
  const pins = {};
  const loaded = new Set(Object.values(snap.msgs || {}).flat().map((m) => m.id));
  const need = [];
  for (const conv of M.readable(user)) {
    if (conv.startsWith('t:')) continue;
    const list = pinsOf(db, M, conv);
    if (!list.length) continue;
    pins[conv] = list;
    for (const p of list) if (!loaded.has(p.id)) need.push(p.id);
  }
  for (const m of M.withReactions(need.map(M.liveMsg).filter(Boolean))) {
    snap.cache[m.id] = m;
    if (!snap.users[m.author]) { const u = M.userView(M.userRow(m.author), 'offline'); if (u) snap.users[m.author] = u; }
  }
  snap.pins = pins;
  snap.gifFavs = gifFavsFor(db, M, user);
  return snap;
}

// Ops over the socket.
export function createMediaOps({ db, M, hub, fail, ops = {} }) {
  const convId = (v) => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail('That conversation isn’t valid.'));
  // The same id check as the other message ops: older and sample messages have short ids.
  const msgId = (v) => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail('That message isn’t valid.'));

  function pinTarget(user, d) {
    const conv = convId(d.conv);
    const w = M.where(conv);
    if (!w || !M.canRead(user, conv)) fail('You don’t have access to this conversation.');
    if (w.type === 'thread') fail('Pins belong to rooms and conversations, not threads.');
    if (w.house && !M.can(user, w.house, 'pin') && !M.can(user, w.house, 'moderate')) fail('Your role can’t pin messages in this house.');
    const row = M.liveMsg(msgId(d.id));
    if (!row || row.conv !== conv) fail('That message was deleted.');
    return { conv, row };
  }
  function pinsChanged(conv, row, by, on) {
    const [m] = M.withReactions([row]);
    hub.toConv(conv, 'pins', { conv, pins: pinsOf(db, M, conv), id: row.id, on, by, m, users: hub.usersFor([row.author, by]) });
  }

  // Deleting or restoring a pinned message changes the pins everyone sees.
  const repin = (name) => {
    const base = ops[name];
    return base && ((c, d) => {
      const r = base(c, d);
      const conv = typeof d.conv === 'string' ? d.conv : '';
      if (typeof d.id === 'string' && db.get('SELECT 1 FROM pins WHERE conv = ? AND msg = ?', conv, d.id)) {
        hub.toConv(conv, 'pins', { conv, pins: pinsOf(db, M, conv) });
      }
      return r;
    });
  };
  const wrapped = Object.fromEntries(['msg.delete', 'msg.restore'].map((n) => [n, repin(n)]).filter(([, f]) => f));

  return {
    ...wrapped,
    'msg.pin'(c, d) {
      const { conv, row } = pinTarget(c.user, d);
      if (db.get('SELECT 1 FROM pins WHERE conv = ? AND msg = ?', conv, row.id)) return {};
      // Pins on deleted messages don't count against the limit.
      if (pinsOf(db, M, conv).length >= MAX_PINS) fail(`A conversation can have up to ${MAX_PINS} pinned messages. Unpin one first.`);
      db.run('INSERT INTO pins (conv, msg, by, at) VALUES (?, ?, ?, ?)', conv, row.id, c.user, Date.now());
      pinsChanged(conv, row, c.user, true);
      return {};
    },
    'msg.unpin'(c, d) {
      const { conv, row } = pinTarget(c.user, d);
      if (!db.run('DELETE FROM pins WHERE conv = ? AND msg = ?', conv, row.id).changes) return {};
      pinsChanged(conv, row, c.user, false);
      return {};
    },

    // Save a GIF you can see to your GIFs, or take it out. Every device hears.
    'gif.fav'(c, d) {
      const file = typeof d.file === 'string' && FILE_ID.test(d.file) ? d.file : fail('That GIF isn’t valid.');
      if (d.on === true) {
        const row = db.get('SELECT * FROM files WHERE id = ?', file);
        if (!row || !readableFile(M, c.user, row)) fail('That GIF is no longer here.');
        if (!isGif(row)) fail('Only GIFs can be saved to your GIFs.');
        if (!db.get('SELECT 1 FROM gif_favs WHERE user = ? AND file = ?', c.user, file)) {
          if (db.get('SELECT COUNT(*) n FROM gif_favs WHERE user = ?', c.user).n >= MAX_GIF_FAVS) fail(`You can keep up to ${MAX_GIF_FAVS} GIFs. Remove one first.`);
          const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 8000 ? v : null);
          db.run('INSERT INTO gif_favs (user, file, at, w, h) VALUES (?, ?, ?, ?, ?)', c.user, file, Date.now(), dim(d.w), dim(d.h));
        }
      } else db.run('DELETE FROM gif_favs WHERE user = ? AND file = ?', c.user, file);
      hub.toUser(c.user, 'gifs', { favs: gifFavsFor(db, M, c.user) });
      return {};
    },

    // GIFs posted in conversations you can read, newest first, each one once.
    'gif.recent'(c) {
      const convs = M.readable(c.user);
      const out = [];
      const seen = new Set();
      for (let i = 0; i < convs.length && out.length < 30; i += 500) {
        const chunk = convs.slice(i, i + 500);
        const rows = db.all(`SELECT conv, author, ts, files FROM messages WHERE files IS NOT NULL AND deleted IS NULL
          AND conv IN (${chunk.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 1500`, ...chunk);
        for (const r of rows) {
          for (const f of json(r.files, [])) {
            const gif = f.gif || (f.kind === 'image' && /\.gif$/i.test(f.name || ''));
            const key = `${f.size}:${f.name}`;
            if (!gif || !f.id || seen.has(key)) continue;
            seen.add(key);
            out.push({ id: f.id, name: f.name, size: f.size, w: f.w, h: f.h, kind: f.kind, by: r.author, conv: r.conv, ts: r.ts });
          }
        }
      }
      out.sort((a, b) => b.ts - a.ts);
      return { gifs: out.slice(0, 30) };
    },
  };
}

// The GIF provider. Search is on only with SNUG_GIF_PROVIDER=tenor and a key.
// SNUG_TENOR_BASE points the provider at a local stand-in in tests; then only
// that stand-in's own host may serve media.
const TENOR_MEDIA_HOSTS = ['media.tenor.com', 'media1.tenor.com', 'c.tenor.com', 'media.tenor.co'];
export function gifConfig(env = process.env) {
  const enabled = env.SNUG_GIF_PROVIDER === 'tenor' && !!env.SNUG_TENOR_KEY;
  const base = (env.SNUG_TENOR_BASE || 'https://tenor.googleapis.com').replace(/\/+$/, '');
  const test = !!env.SNUG_TENOR_BASE;
  return {
    enabled, key: env.SNUG_TENOR_KEY || '', base,
    hosts: test ? [new URL(base).host] : TENOR_MEDIA_HOSTS,
    protocol: test ? new URL(base).protocol : 'https:',
  };
}

// HTTP routes under /api/gifs. Returns true when it answered the request.
export function createMediaHttp({ db, M, filesDir, sendJson, error, jsonBody, headers, env = process.env }) {
  const gif = gifConfig(env);
  const searchLimit = limiter({ capacity: 20, perSecond: 1 });
  const fetchLimit = limiter({ capacity: 60, perSecond: 4 });
  const saveLimit = limiter({ capacity: 20, perSecond: 0.5 });

  const allowed = (raw) => {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    return u.protocol === gif.protocol && gif.hosts.includes(u.host) && !u.username && !u.password ? u : null;
  };
  // Only from the provider's media hosts, never following a redirect elsewhere, at most 10 MB.
  async function download(u) {
    let res;
    try { res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000) }); } catch { return { err: 'The GIF couldn’t be fetched. Try another.' }; }
    if (res.status !== 200 || !res.body) return { err: 'The GIF couldn’t be fetched. Try another.' };
    if (Number(res.headers.get('content-length')) > MAX_FILE) return { err: 'That GIF is over 10 MB. Try another.' };
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > MAX_FILE) return { err: 'That GIF is over 10 MB. Try another.' };
      chunks.push(c);
    }
    const data = Buffer.concat(chunks);
    const real = sniff(data);
    const type = real === 'image/gif' || real === 'image/webp' ? real : real === 'mp4' ? 'video/mp4' : null;
    if (!type) return { err: 'That isn’t a GIF Snug can show.' };
    return { data, type };
  }
  const gate = (user, conv) => M.postGate(user, conv.startsWith('t:') && !M.thread(conv) ? (M.liveMsg(conv.slice(2))?.conv || '') : conv);
  const view = (id, row, meta) => ({ id, name: row.name, size: row.size, kind: fileKind(row.type, meta), gif: true, w: meta.w, h: meta.h });

  async function mediaHttp(req, res, path, url, user) {
    if (!path.startsWith('/api/gifs')) return false;
    const post = req.method === 'POST';

    if (req.method === 'GET' && path === '/api/gifs/config') { sendJson(res, 200, { search: gif.enabled }); return true; }

    if (req.method === 'GET' && path === '/api/gifs') {
      if (!gif.enabled) { error(res, 404, 'GIF search isn’t set up on this server.'); return true; }
      if (!searchLimit.take(user)) { error(res, 429, 'You’re searching a little fast. Wait a moment.'); return true; }
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      if (!q) { sendJson(res, 200, { results: [] }); return true; }
      const api = `${gif.base}/v2/search?${new URLSearchParams({ q, key: gif.key, client_key: 'snug', limit: '24', media_filter: 'gif,tinygif,mediumgif,mp4', contentfilter: 'medium' })}`;
      let data;
      try {
        const r = await fetch(api, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(String(r.status));
        data = await r.json();
      } catch { error(res, 502, 'GIF search isn’t answering right now. Try again in a moment.'); return true; }
      const results = (Array.isArray(data?.results) ? data.results : []).map((g) => {
        const f = g?.media_formats || {};
        const send = f.mediumgif || f.gif || f.tinygif || f.mp4;
        const prev = f.tinygif || f.mediumgif || f.gif;
        if (!send?.url || !prev?.url || !allowed(send.url) || !allowed(prev.url)) return null;
        const [w, h] = Array.isArray(send.dims) ? send.dims : [];
        return {
          id: String(g.id || ''), title: String(g.content_description || g.title || 'GIF').slice(0, 120),
          url: send.url, preview: `/api/gifs/media?u=${encodeURIComponent(prev.url)}`,
          w: Number.isInteger(w) ? w : undefined, h: Number.isInteger(h) ? h : undefined,
        };
      }).filter(Boolean);
      sendJson(res, 200, { results });
      return true;
    }

    // Search previews come through Snug too, so the browser never talks to the provider.
    if (req.method === 'GET' && path === '/api/gifs/media') {
      if (!gif.enabled) { error(res, 404, 'Not found'); return true; }
      const u = allowed(url.searchParams.get('u'));
      if (!u) { error(res, 403, 'That address isn’t one Snug fetches GIFs from.'); return true; }
      if (!fetchLimit.take(user)) { error(res, 429, 'Too many at once. Wait a moment.'); return true; }
      const got = await download(u);
      if (got.err) { error(res, 502, got.err); return true; }
      headers(res, { 'Content-Type': got.type, 'Content-Length': String(got.data.length), 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.writeHead(200);
      res.end(got.data);
      return true;
    }

    if (post && path === '/api/gifs/import') {
      if (!gif.enabled) { error(res, 404, 'GIF search isn’t set up on this server.'); return true; }
      const d = await jsonBody(req);
      const conv = typeof d.conv === 'string' ? d.conv : '';
      const g = gate(user, conv);
      if (!g.ok) { error(res, 403, g.why); return true; }
      const u = allowed(d.url);
      if (!u) { error(res, 403, 'That address isn’t one Snug fetches GIFs from.'); return true; }
      if (!saveLimit.take(user)) { error(res, 429, 'Too many GIFs at once. Wait a moment.'); return true; }
      const got = await download(u);
      if (got.err) { error(res, 422, got.err); return true; }
      const id = newId('f');
      const name = `${String(d.title || 'GIF').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 80) || 'GIF'}.${got.type === 'video/mp4' ? 'mp4' : got.type.split('/')[1]}`;
      const meta = { gif: true, source: 'tenor' };
      if (Number.isInteger(d.w) && Number.isInteger(d.h) && d.w > 0 && d.h > 0) { meta.w = Math.min(8000, d.w); meta.h = Math.min(8000, d.h); }
      await writeFile(join(filesDir, id), got.data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user, conv, name, got.type, got.data.length, Date.now(), JSON.stringify(meta));
      sendJson(res, 201, view(id, { name, size: got.data.length, type: got.type }, meta));
      return true;
    }

    // Send one of your GIFs (or a recent one) somewhere else: the file is copied
    // into that conversation, so it stays readable there whatever happens to the original.
    if (post && path === '/api/gifs/use') {
      const d = await jsonBody(req);
      const conv = typeof d.conv === 'string' ? d.conv : '';
      const g = gate(user, conv);
      if (!g.ok) { error(res, 403, g.why); return true; }
      const src = typeof d.file === 'string' && FILE_ID.test(d.file) ? db.get('SELECT * FROM files WHERE id = ?', d.file) : null;
      if (!src || !readableFile(M, user, src)) { error(res, 404, 'That GIF is no longer here.'); return true; }
      if (!isGif(src)) { error(res, 400, 'That isn’t a GIF.'); return true; }
      if (!saveLimit.take(user)) { error(res, 429, 'Too many GIFs at once. Wait a moment.'); return true; }
      const id = newId('f');
      const meta = { ...json(src.meta, {}), gif: true };
      if (Number.isInteger(d.w) && Number.isInteger(d.h) && d.w > 0 && d.h > 0) { meta.w = Math.min(8000, d.w); meta.h = Math.min(8000, d.h); }
      await copyFile(join(filesDir, src.id), join(filesDir, id));
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user, conv, src.name, src.type, src.size, Date.now(), JSON.stringify(meta));
      sendJson(res, 201, view(id, src, meta));
      return true;
    }

    return false;
  }
  mediaHttp.reset = () => { searchLimit.reset(); fetchLimit.reset(); saveLimit.reset(); };
  return mediaHttp;
}
