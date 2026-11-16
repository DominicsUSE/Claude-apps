// Voice messages, pinned messages and GIFs, on the server.
//
// - Voice messages are ordinary uploads with an audio type. The type a browser
//   claims is checked against the file's first bytes, and the message stores
//   the length and a small waveform the sender's browser measured.
// - Pins belong to a room or a direct conversation, at most 50 each. In a
//   house, pinning needs the 'pin' or the 'moderate' permission; in a direct
//   conversation or group, anyone in it may pin.
// - GIFs: favourites are references to files you can read, synced to every
//   device. Search goes through a provider (server/gifs.js), and a GIF picked
//   from search is downloaded by the server and stored as a normal Snug file,
//   so no message ever loads from another site.
import { unlinkSync } from 'node:fs'; // sec-authz: the attachment sweep
import { join } from 'node:path';
import { newId } from './model.js';
import { limiter } from './auth.js';
import { stripInvisible } from '../js/lib/util.js'; // sec-authz
import { gifProviders } from './gifs.js'; // Openverse, Wikimedia Commons, Tenor, the registry
import { writeStored, copyStored } from './filecrypt.js'; // 0.14: files encrypted at rest

export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'];
export const MAX_PINS = 50;
export const MAX_GIF_FAVS = 200;
export const MAX_VOICE_SECONDS = 300;
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };

// What a file really is, from its first bytes.
export function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const s = (a, b) => buf.toString('latin1', a, b);
  if (buf[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'audio/mp4';
    if (brand === 'qt  ') return 'quicktime';
    return 'mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (s(0, 4) === 'OggS') return 'audio/ogg';
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

// Pictures, video and sound are only ever stored as what their bytes say they
// are; anything claiming to be one but holding something else (an HTML page
// named photo.png) is stored as application/octet-stream and only downloads.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

// The type an upload is stored with. Audio may arrive with codec parameters
// ("audio/webm;codecs=opus"); it keeps its audio type only if the bytes agree.
export function uploadType(header, data) {
  const t = String(header || '').split(';')[0].trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(t)) return 'application/octet-stream';
  const real = sniff(data);
  const octet = 'application/octet-stream';
  if (t === 'image/jpg' || t === 'image/pjpeg') return real === 'image/jpeg' ? 'image/jpeg' : octet;
  if (IMAGE_TYPES.includes(t)) return real === t ? t : octet;
  if (t === 'video/mp4') return real === 'mp4' ? t : octet;
  if (t === 'video/quicktime') return real === 'quicktime' || real === 'mp4' ? t : octet;
  if (t === 'video/webm') return real === 'webm' ? t : octet;
  if (AUDIO_TYPES.includes(t)) {
    const ok = (t === 'audio/webm' && real === 'webm')
      || (t === 'audio/ogg' && real === 'audio/ogg')
      || (t === 'audio/mp4' && (real === 'audio/mp4' || real === 'mp4'))
      || (t === 'audio/mpeg' && real === 'audio/mpeg');
    return ok ? t : octet;
  }
  if (t === 'audio/mp3' || t === 'audio/x-m4a') return real === 'audio/mpeg' && t === 'audio/mp3' ? 'audio/mpeg' : (real === 'audio/mp4' || real === 'mp4') && t === 'audio/x-m4a' ? 'audio/mp4' : octet;
  // SVG is kept as SVG (it downloads, never shows inline); any other picture,
  // video or sound type Snug can't check is just bytes.
  if (t === 'image/svg+xml') return t;
  if (/^(image|video|audio)\//.test(t)) return octet;
  return t;
}

export function fileKind(type, meta) {
  if (AUDIO_TYPES.includes(type)) return 'audio';
  if (VIDEO_TYPES.includes(type)) return 'video';
  return IMAGE_TYPES.includes(type) ? 'image' : 'file';
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
  // A recorded voice message (VoiceButton) says so; any other sound file shows as a file with a player.
  if (out.kind === 'audio' && f.voice === true) out.voice = true;
  if (out.kind === 'video' && f.duration != null) {
    if (typeof f.duration !== 'number' || !Number.isFinite(f.duration) || f.duration <= 0 || f.duration > 86400) fail('That video’s length isn’t valid.');
    out.duration = Math.round(f.duration * 10) / 10;
  }
  if (isGif(row)) out.gif = true;
  // An openly licensed GIF's credit, as the server stored it at import (server/gifs.js creditOf).
  if (meta.credit && typeof meta.credit.text === 'string') out.credit = { text: meta.credit.text.slice(0, 200), ...(typeof meta.credit.link === 'string' && /^https:\/\//.test(meta.credit.link) ? { link: meta.credit.link.slice(0, 500) } : {}) };
  if (out.kind === 'video' || out.kind === 'image') {
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
// ---------- sec-authz: attachments that nothing uses any more ----------
// A deleted message can be restored for ten minutes; after that its
// attachments and link-preview pictures are removed, row and bytes, unless
// another message still in use (or a saved GIF) names them. Conversation
// uploads never attached to anything are removed after a day. Pictures that
// belong to a person or a house (avatar:, banner:, emoji:, sticker:,
// housepic:, eventcover:) are never touched here.
export const UNDO_MS = 11 * 60_000;
export const UNATTACHED_MS = 24 * 3600_000;
const OWNED = /^(avatar|banner|emoji|sticker|housepic|eventcover|sound):/;
const FID = /f_[a-z0-9]{8,40}/g;
// Whether anything still wants a file: a message that isn't past its undo window names it, a saved GIF,
// a house emoji or sticker. Also used when a live message's previews are removed or rebuilt (server/messaging.js).
export function fileChecker(db) {
  const cols = new Set(db.all('PRAGMA table_info(messages)').map((c) => c.name));
  const refCols = ['files', 'embeds', 'fwd'].filter((c) => cols.has(c)); // fixed names, never input
  const refSql = refCols.map((c) => `instr(coalesce(${c}, ''), ?) > 0`).join(' OR ');
  const hasTable = (t) => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  // Still wanted: a message that isn't past its undo window names it, a saved GIF, a house emoji or sticker.
  // 0.12: a message past its disappearing time doesn't want its files any more (server/expiry.js).
  const live = cols.has('expires') ? ' AND (expires IS NULL OR expires > ?)' : '';
  const wanted = (fid, convs, exceptMsg, cutoff, now = Date.now()) => {
    for (const conv of new Set(convs.filter(Boolean))) {
      if (db.get(`SELECT 1 FROM messages WHERE conv = ? AND id != ? AND (deleted IS NULL OR deleted >= ?)${live} AND (${refSql}) LIMIT 1`, conv, exceptMsg || '', cutoff, ...(live ? [now] : []), ...refCols.map(() => fid))) return true;
    }
    if (hasTable('gif_favs') && db.get('SELECT 1 FROM gif_favs WHERE file = ?', fid)) return true;
    if (hasTable('house_emoji') && db.get('SELECT 1 FROM house_emoji WHERE file = ?', fid)) return true;
    if (hasTable('house_stickers') && db.get('SELECT 1 FROM house_stickers WHERE file = ?', fid)) return true;
    return false;
  };
  return { wanted, refCols, live };
}

export function createFileSweep({ db, filesDir, log = () => {} }) {
  const { wanted, refCols, live } = fileChecker(db);
  // review-media 3: where the one-time walk over older link-preview pictures has got to.
  db.run('CREATE TABLE IF NOT EXISTS sweep_marks (name TEXT PRIMARY KEY, mark INTEGER NOT NULL, until INTEGER NOT NULL)');
  const remove = (fid) => {
    db.run('DELETE FROM files WHERE id = ?', fid);
    try { unlinkSync(join(filesDir, fid)); } catch (e) { if (e.code !== 'ENOENT') log('error', 'file sweep', e); }
  };
  let mark = Date.now() - UNATTACHED_MS * 2; // after a restart, look back two days
  return function sweepFiles(now = Date.now()) {
    const cutoff = now - UNDO_MS;
    let removed = 0;
    // 1. Messages past their undo window that still name files.
    // 0.12: and messages that disappeared (no undo window for those).
    const gone = live ? ' OR (expires IS NOT NULL AND expires <= ?)' : '';
    const dead = db.all(`SELECT id, conv, ${refCols.join(', ')} FROM messages WHERE ((deleted IS NOT NULL AND deleted < ?)${gone}) AND (${refCols.map((c) => `${c} IS NOT NULL`).join(' OR ')}) LIMIT 500`, cutoff, ...(gone ? [now] : []));
    for (const m of dead) {
      const ids = new Set(refCols.flatMap((c) => String(m[c] || '').match(FID) || []));
      for (const fid of ids) {
        const f = db.get('SELECT id, conv FROM files WHERE id = ?', fid);
        if (!f || OWNED.test(f.conv)) continue;
        if (wanted(fid, [m.conv, f.conv], m.id, cutoff, now)) continue;
        remove(fid); removed++;
      }
      db.run(`UPDATE messages SET ${refCols.map((c) => `${c} = NULL`).join(', ')} WHERE id = ?`, m.id);
    }
    // 2. Uploads to a conversation that no message ever took up.
    const until = now - UNATTACHED_MS;
    if (until > mark) {
      // A few hundred per pass, oldest first, so one pass never holds the server for long.
      const batch = db.all('SELECT id, conv, meta, created FROM files WHERE created >= ? AND created < ? ORDER BY created LIMIT 200', mark, until);
      for (const f of batch) {
        if (OWNED.test(f.conv) || /"remote"\s*:\s*1/.test(f.meta || '')) continue; // a friend's file (server/peer.js keeps its own cache)
        if (wanted(f.id, [f.conv], '', cutoff, now)) continue;
        remove(f.id); removed++;
      }
      mark = batch.length === 200 ? batch[199].created : until;
    }
    // 3. Link-preview pictures that builds before this one left behind when previews were removed or
    // rebuilt (review-media 3): walked once, 2000 rows of the files table per pass, up to the last row
    // there when this build first ran. A picture younger than a day is step 2's.
    let s = db.get("SELECT mark, until FROM sweep_marks WHERE name = 'embeds'");
    if (!s) {
      s = { mark: 0, until: db.get('SELECT COALESCE(MAX(rowid), 0) n FROM files').n };
      db.run("INSERT INTO sweep_marks (name, mark, until) VALUES ('embeds', 0, ?)", s.until);
    }
    if (s.mark < s.until) {
      const to = Math.min(s.mark + 2000, s.until);
      for (const f of db.all(`SELECT id, conv FROM files WHERE rowid > ? AND rowid <= ? AND created < ? AND meta LIKE '%"embed":true%'`, s.mark, to, until)) {
        if (OWNED.test(f.conv)) continue;
        if (wanted(f.id, [f.conv], '', cutoff, now)) continue;
        remove(f.id); removed++;
      }
      db.run("UPDATE sweep_marks SET mark = ? WHERE name = 'embeds'", to);
    }
    return removed;
  };
}

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
        if (json(row.meta, {})?.spoiler) fail('A GIF sent as a spoiler can’t be saved to your GIFs.');
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
            if (!gif || !f.id || f.spoiler || seen.has(key)) continue; // spoilers stay where they were sent
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

// GIF search (server/gifs.js has the providers). Results, previews and picks
// all go through here; only addresses a search of ours returned are fetched.
export function createMediaHttp({ db, M, filesDir, sendJson, error, jsonBody, headers, env = process.env, fetch: fetchFn = globalThis.fetch, gifReg = null, room = () => null, hold = null }) {
  // review-media 1: the bytes of a copy count as in flight from the check until its files row exists.
  const reserve = hold || ((u, c, n) => { const r = room(u, c, n); return r ? { refused: r } : { release() {} }; });
  const providers = gifProviders(env, { fetch: fetchFn, reg: gifReg });
  const byId = new Map(providers.map((p) => [p.id, p]));
  const searchLimit = limiter({ capacity: 20, perSecond: 1 });
  const fetchLimit = limiter({ capacity: 60, perSecond: 4 });
  const saveLimit = limiter({ capacity: 20, perSecond: 0.5 });
  // What our searches returned, for an hour or two: a preview or a pick must be one of these, and its
  // credit comes from here, never from the browser.
  const known = new Map();      // url -> { p, credit, at }
  const results = new Map();    // `${p}\n${q}` -> { at, list }  (an hour: anonymous provider limits are tight)
  const previews = new Map();   // url -> { at, data, type }      (an hour, about 40 MB at most)
  let previewBytes = 0;
  const HOUR = 3600_000;
  const remember = (map, k, v, max) => { map.delete(k); map.set(k, v); while (map.size > max) map.delete(map.keys().next().value); };
  const knownUrl = (u) => { const k = known.get(String(u)); return k && Date.now() - k.at < 2 * HOUR ? k : null; };
  function keepPreview(u, got) {
    previews.delete(u);
    previews.set(u, { at: Date.now(), ...got });
    previewBytes += got.data.length;
    while (previewBytes > 40 * 1024 * 1024 && previews.size) { const [k, v] = previews.entries().next().value; previews.delete(k); previewBytes -= v.data.length; }
  }
  const gate = (user, conv) => M.postGate(user, conv.startsWith('t:') && !M.thread(conv) ? (M.liveMsg(conv.slice(2))?.conv || '') : conv);
  const view = (id, row, meta) => ({ id, name: row.name, size: row.size, kind: fileKind(row.type, meta), gif: true, w: meta.w, h: meta.h, ...(meta.credit ? { credit: meta.credit } : {}) });
  const sourceList = () => providers.map((p) => ({ id: p.id, label: p.label, note: p.note, ...(p.badge ? { badge: p.badge } : {}) }));

  async function mediaHttp(req, res, path, url, user) {
    if (!path.startsWith('/api/gifs')) return false;
    const post = req.method === 'POST';

    if (req.method === 'GET' && path === '/api/gifs/config') { sendJson(res, 200, { search: providers.length > 0, sources: sourceList() }); return true; }

    if (req.method === 'GET' && path === '/api/gifs') {
      if (!providers.length) { error(res, 404, 'GIF search isn’t set up on this server.'); return true; }
      const p = byId.get(String(url.searchParams.get('source') || '')) || providers[0];
      if (!searchLimit.take(user)) { error(res, 429, 'You’re searching a little fast. Wait a moment.'); return true; }
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      if (!q) { sendJson(res, 200, { results: [], source: p.id }); return true; }
      const key = `${p.id}\n${q.toLowerCase()}`;
      let hit = results.get(key);
      if (!hit || Date.now() - hit.at > HOUR) {
        let list;
        try { list = await p.search(q); } catch (e) {
          error(res, e.status === 429 ? 429 : 502, e.status === 429 ? `${p.label} is getting too many searches from this server. Try again in a few minutes.` : 'GIF search isn’t answering right now. Try again in a moment.');
          return true;
        }
        hit = { at: Date.now(), list };
        remember(results, key, hit, 300);
      }
      const now = Date.now();
      const out = hit.list.map((g) => {
        remember(known, g.url, { p: p.id, credit: g.credit || null, at: now }, 5000);
        remember(known, g.preview, { p: p.id, credit: null, at: now, preview: true }, 5000);
        return { id: g.id, title: g.title, url: g.url, preview: `/api/gifs/media?u=${encodeURIComponent(g.preview)}`, w: g.w, h: g.h, ...(g.credit ? { credit: g.credit } : {}) };
      });
      sendJson(res, 200, { results: out, source: p.id });
      return true;
    }

    // Search previews come through Snug too, so the browser never talks to the provider.
    if (req.method === 'GET' && path === '/api/gifs/media') {
      if (!providers.length) { error(res, 404, 'Not found'); return true; }
      const u = String(url.searchParams.get('u') || '');
      const k = knownUrl(u);
      if (!k || !byId.has(k.p)) { error(res, 403, 'That address isn’t one Snug fetches GIFs from.'); return true; }
      let got = previews.get(u);
      if (!got || Date.now() - got.at > HOUR) {
        if (!fetchLimit.take(user)) { error(res, 429, 'Too many at once. Wait a moment.'); return true; }
        got = await byId.get(k.p).fetch(u);
        if (got.err) { error(res, 502, got.err); return true; }
        keepPreview(u, got);
      }
      headers(res, { 'Content-Type': got.type, 'Content-Length': String(got.data.length), 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.writeHead(200);
      res.end(got.data);
      return true;
    }

    if (post && path === '/api/gifs/import') {
      if (!providers.length) { error(res, 404, 'GIF search isn’t set up on this server.'); return true; }
      const d = await jsonBody(req);
      const conv = typeof d.conv === 'string' ? d.conv : '';
      const g = gate(user, conv);
      if (!g.ok) { error(res, 403, g.why); return true; }
      const k = knownUrl(d.url);
      if (!k || k.preview || !byId.has(k.p)) { error(res, 403, 'That address isn’t one Snug fetches GIFs from. Search again and pick it from the results.'); return true; }
      if (!saveLimit.take(user)) { error(res, 429, 'Too many GIFs at once. Wait a moment.'); return true; }
      const got = await byId.get(k.p).fetch(String(d.url));
      if (got.err) { error(res, 422, got.err); return true; }
      const held = reserve(user, conv, got.data.length); // review-media 1: the quota and the disk floor, as for uploads
      if (held.refused) { error(res, held.refused.status, held.refused.message); return true; }
      const id = newId('f');
      const name = `${stripInvisible(String(d.title || 'GIF')).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 80) || 'GIF'}.${got.type === 'video/mp4' ? 'mp4' : got.type.split('/')[1]}`;
      // Openly licensed GIFs keep their credit (author, licence, where from) wherever they go.
      const meta = { gif: true, source: k.p, ...(k.credit ? { credit: k.credit } : {}) };
      if (Number.isInteger(d.w) && Number.isInteger(d.h) && d.w > 0 && d.h > 0) { meta.w = Math.min(8000, d.w); meta.h = Math.min(8000, d.h); }
      try {
        await writeStored(join(filesDir, id), got.data);
        db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user, conv, name, got.type, got.data.length, Date.now(), JSON.stringify(meta));
      } finally { held.release(); }
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
      const held = reserve(user, conv, src.size); // review-media 1: a copy counts like an upload, from the check on
      if (held.refused) { error(res, held.refused.status, held.refused.message); return true; }
      const id = newId('f');
      const meta = { ...json(src.meta, {}), gif: true };
      if (Number.isInteger(d.w) && Number.isInteger(d.h) && d.w > 0 && d.h > 0) { meta.w = Math.min(8000, d.w); meta.h = Math.min(8000, d.h); }
      try {
        await copyStored(join(filesDir, src.id), join(filesDir, id));
        db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user, conv, src.name, src.type, src.size, Date.now(), JSON.stringify(meta));
      } finally { held.release(); }
      sendJson(res, 201, view(id, src, meta));
      return true;
    }

    return false;
  }
  mediaHttp.reset = () => { searchLimit.reset(); fetchLimit.reset(); saveLimit.reset(); };
  return mediaHttp;
}
