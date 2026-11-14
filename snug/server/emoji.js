// Custom emoji per house, on the server.
//
// - A house keeps up to 100 emoji, each a name ([a-z0-9_], 2 to 32 characters,
//   unique in the house) and a small image: PNG, GIF or WebP, at most 256 KB and
//   256 by 256 pixels. The size is read from the file's own header here, never
//   taken from the browser. Adding, renaming and removing needs the 'emoji'
//   permission (owners always have it).
// - Messages carry emoji as <:name:id> tokens, resolved by the sender's browser.
//   An emoji can be used in a conversation by members of its house, or anywhere
//   it already appears. Each use outside its house is recorded (emoji_uses), so
//   the people reading that conversation, and only they, may see the image.
// - Every message view carries the metadata of the emoji it uses (m.emoji) that
//   its readers may see. A token for an emoji that is gone, or that its reader
//   may not see, gets no metadata, and the browser shows the plain :name:.
// - Reactions use the same token as their key: <:name:id>.
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from './model.js';
import { safeDecode } from './auth.js';

export const MAX_EMOJI = 100;
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_EMOJI_SIDE = 256;
export const EMOJI_NAME = /^[a-z0-9_]{2,32}$/;
const TOKEN_G = /<:([a-z0-9_]{2,32}):(em_[a-z0-9]{8,40})>/g;
const KEY = /^<:([a-z0-9_]{2,32}):(em_[a-z0-9]{8,40})>$/;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };

// What an emoji image is, and how big, from its first bytes. Null if it is not
// a PNG, GIF or WebP whose size can be read.
export function emojiImage(buf) {
  if (!buf || buf.length < 16) return null;
  const s = (a, b) => buf.toString('latin1', a, b);
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && s(12, 16) === 'IHDR') {
    return { type: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return { type: 'image/gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length >= 30 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') {
    const chunk = s(12, 16);
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { type: 'image/webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { type: 'image/webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { type: 'image/webp', w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

export const emojiView = (e) => e && { id: e.id, house: e.house, name: e.name, file: e.file, by: e.by, created: e.created };
export const tokenOf = (e) => `<:${e.name}:${e.id}>`;

// Shared reads, used by the ops, the snapshot and the file route.
export function emojiReads(db, M) {
  const R = {};
  R.row = (id) => (typeof id === 'string' ? db.get('SELECT * FROM house_emoji WHERE id = ?', id) : undefined);
  R.list = (house) => db.all('SELECT * FROM house_emoji WHERE house = ? ORDER BY name', house).map(emojiView);
  // The house a conversation belongs to, threads (even not yet started ones) included.
  R.convHouse = (conv) => {
    const w = M.where(conv);
    if (w) return w.house || null;
    if (typeof conv === 'string' && conv.startsWith('t:')) return M.where(M.liveMsg(conv.slice(2))?.conv || '')?.house || null;
    return null;
  };
  // A thread shares its parent conversation's readers, so a use there counts too.
  const keys = (conv) => {
    if (!conv.startsWith('t:')) return [conv];
    const parent = M.thread(conv)?.conv || M.liveMsg(conv.slice(2))?.conv;
    return parent ? [conv, parent] : [conv];
  };
  R.visibleIn = (e, conv) => R.convHouse(conv) === e.house
    || keys(conv).some((k) => db.get('SELECT 1 FROM emoji_uses WHERE emoji = ? AND conv = ?', e.id, k));
  R.canUse = (user, e, conv) => M.isMember(e.house, user) || R.visibleIn(e, conv);
  // Record that an emoji appears in a conversation outside its house. True if new.
  R.use = (e, conv) => R.convHouse(conv) !== e.house && db.run('INSERT OR IGNORE INTO emoji_uses (emoji, conv) VALUES (?, ?)', e.id, conv).changes > 0;
  // Metadata for the emoji a message's text and reactions use, as its readers may see it.
  R.metaFor = (conv, text, reactionKeys = []) => {
    const ids = new Set();
    if (text && text.includes('<:')) for (const x of text.matchAll(TOKEN_G)) ids.add(x[2]);
    for (const k of reactionKeys) { const x = KEY.exec(k); if (x) ids.add(x[2]); }
    if (!ids.size) return null;
    const out = {};
    for (const id of ids) {
      const e = R.row(id);
      if (e && R.visibleIn(e, conv)) out[id] = { name: e.name, file: e.file, house: e.house };
    }
    return Object.keys(out).length ? out : null;
  };
  // An emoji image: the people in its house, the person who uploaded it (before
  // it is added), and the readers of any conversation it has been used in.
  R.fileReadable = (user, row) => {
    if (!row || !row.conv.startsWith('emoji:')) return false;
    const e = db.get('SELECT * FROM house_emoji WHERE file = ?', row.id);
    if (!e) return row.owner === user && M.isMember(row.conv.slice(6), user);
    if (M.isMember(e.house, user)) return true;
    return db.all('SELECT conv FROM emoji_uses WHERE emoji = ?', e.id).some((u) => M.canRead(user, u.conv));
  };
  return R;
}

// Added to every snapshot: the emoji of each house this person is in.
export function addEmojiSnapshot(db, M, user, snap) {
  const R = emojiReads(db, M);
  snap.emoji = Object.fromEntries(M.houseIdsOf(user).map((h) => [h, R.list(h)]));
  return snap;
}

// Ops over the socket, plus the wrappers that teach existing ops about emoji.
export function createEmojiOps({ db, M, hub, fail, ops = {} }) {
  const R = emojiReads(db, M);
  const idOf = (v, name) => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const members = (house) => db.all('SELECT user FROM members WHERE house = ?', house).map((r) => r.user);
  const need = (user, house) => {
    if (!db.get('SELECT 1 FROM houses WHERE id = ?', house)) fail('That house doesn’t exist.');
    if (!M.isMember(house, user)) fail('You’re not a member of that house.');
    if (!M.can(user, house, 'emoji')) fail('Your role can’t manage emoji in this house.');
  };
  const nameOf = (v) => {
    if (typeof v !== 'string' || !v.trim()) fail('Give the emoji a name.');
    const n = v.trim().replace(/^:+|:+$/g, '');
    if (n.length < 2) fail('Emoji names need at least 2 characters.');
    if (n.length > 32) fail('Emoji names can be at most 32 characters.');
    if (!EMOJI_NAME.test(n)) fail('Emoji names use lowercase letters, numbers and underscores only.');
    return n;
  };
  const changed = (house) => hub.toUsers(members(house), 'emoji', { house, list: R.list(house) });

  // Every message view carries the emoji metadata its readers may see.
  const baseView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseView(row, rx);
    const meta = R.metaFor(row.conv, row.text, rx ? Object.keys(rx) : []);
    if (meta) m.emoji = meta;
    return m;
  };

  // Someone who joins a house gets its emoji along with its rooms.
  const baseContent = hub.sendHouseContent;
  if (baseContent) {
    hub.sendHouseContent = (u, houseId) => {
      baseContent(u, houseId);
      hub.toUser(u, 'emoji', { house: houseId, list: R.list(houseId) });
    };
  }

  // Sending and editing record where emoji from other houses are used. The
  // record is written first, so the message event already carries the emoji,
  // and taken back if the send is refused.
  const recording = (name) => {
    const base = ops[name];
    return base && ((c, d) => {
      const conv = typeof d.conv === 'string' ? d.conv : '';
      const text = typeof d.text === 'string' ? d.text : '';
      const added = [];
      if (conv && text.includes('<:') && M.canRead(c.user, conv.startsWith('t:') ? (M.thread(conv)?.conv || M.liveMsg(conv.slice(2))?.conv || '') : conv)) {
        for (const x of text.slice(0, 4000).matchAll(TOKEN_G)) {
          const e = R.row(x[2]);
          if (e && R.canUse(c.user, e, conv) && R.use(e, conv)) added.push(e.id);
        }
      }
      try { return base(c, d); } catch (err) {
        for (const id of added) db.run('DELETE FROM emoji_uses WHERE emoji = ? AND conv = ?', id, conv);
        throw err;
      }
    });
  };

  // Reactions with a custom emoji: the key is its token. Anything else goes to
  // the original react op unchanged.
  const baseReact = ops.react;
  const react = (c, d) => {
    if (typeof d.emoji !== 'string' || !d.emoji.startsWith('<:')) return baseReact(c, d);
    const conv = idOf(d.conv, 'conversation');
    if (!M.canRead(c.user, conv)) fail('You don’t have access to this conversation.');
    const row = M.liveMsg(idOf(d.id, 'message'));
    if (!row || row.conv !== conv) fail('That message was deleted.');
    const k = KEY.exec(d.emoji) || fail('Reactions are emoji only.');
    const e = R.row(k[2]);
    if (d.on === true) {
      if (!e) fail('That emoji was removed from its house.');
      if (!R.canUse(c.user, e, conv)) fail('You can react with emoji from your own houses, or ones already used here.');
      const key = tokenOf(e);
      const kinds = db.get('SELECT COUNT(DISTINCT emoji) n FROM reactions WHERE msg = ?', row.id).n;
      const has = db.get('SELECT 1 FROM reactions WHERE msg = ? AND emoji = ?', row.id, key);
      if (!has && kinds >= 20) fail('This message has as many different reactions as it can take.');
      R.use(e, conv);
      db.run('INSERT OR IGNORE INTO reactions (msg, user, emoji, ts) VALUES (?, ?, ?, ?)', row.id, c.user, key, Date.now());
    } else {
      // Whatever name it had when it was added.
      for (const r of db.all('SELECT emoji FROM reactions WHERE msg = ? AND user = ?', row.id, c.user)) {
        if (KEY.exec(r.emoji)?.[2] === k[2]) db.run('DELETE FROM reactions WHERE msg = ? AND user = ? AND emoji = ?', row.id, c.user, r.emoji);
      }
    }
    const reactions = M.reactions([row.id])[row.id] || {};
    hub.toConv(conv, 'react', { conv, id: row.id, reactions, emoji: R.metaFor(conv, '', Object.keys(reactions)) || undefined });
    return {};
  };

  const wrapped = Object.fromEntries(['msg.send', 'msg.edit'].map((n) => [n, recording(n)]).filter(([, f]) => f));
  if (baseReact) wrapped.react = react;

  return {
    ...wrapped,

    'emoji.add'(c, d) {
      const house = idOf(d.house, 'house');
      need(c.user, house);
      const name = nameOf(d.name);
      if (db.get('SELECT COUNT(*) n FROM house_emoji WHERE house = ?', house).n >= MAX_EMOJI) fail(`A house can have up to ${MAX_EMOJI} emoji. Remove one first.`);
      if (db.get('SELECT 1 FROM house_emoji WHERE house = ? AND name = ?', house, name)) fail(`There’s already an emoji called :${name}: in this house.`);
      const file = db.get('SELECT * FROM files WHERE id = ?', idOf(d.file, 'image'));
      if (!file || file.owner !== c.user || file.conv !== `emoji:${house}` || !json(file.meta, {}).emoji) fail('That image didn’t finish uploading. Choose it again.');
      if (db.get('SELECT 1 FROM house_emoji WHERE file = ?', file.id)) fail('That image is already an emoji. Choose it again.');
      const eid = newId('em');
      db.run('INSERT INTO house_emoji (id, house, name, file, by, created) VALUES (?, ?, ?, ?, ?, ?)', eid, house, name, file.id, c.user, Date.now());
      changed(house);
      return { emoji: emojiView(R.row(eid)) };
    },

    'emoji.rename'(c, d) {
      const e = R.row(idOf(d.id, 'emoji')) || fail('That emoji was removed.');
      need(c.user, e.house);
      const name = nameOf(d.name);
      if (name === e.name) return { emoji: emojiView(e) };
      if (db.get('SELECT 1 FROM house_emoji WHERE house = ? AND name = ? AND id != ?', e.house, name, e.id)) fail(`There’s already an emoji called :${name}: in this house.`);
      const oldKey = tokenOf(e);
      const next = { ...e, name };
      db.tx(() => {
        db.run('UPDATE house_emoji SET name = ? WHERE id = ?', name, e.id);
        // Reactions follow the new name; messages keep their tokens, which find the emoji by id.
        db.run('UPDATE OR IGNORE reactions SET emoji = ? WHERE emoji = ?', tokenOf(next), oldKey);
        db.run('DELETE FROM reactions WHERE emoji = ?', oldKey);
      });
      changed(e.house);
      return { emoji: emojiView(R.row(e.id)) };
    },

    'emoji.remove'(c, d) {
      const e = R.row(idOf(d.id, 'emoji'));
      if (!e) return {};
      need(c.user, e.house);
      const uses = db.all('SELECT conv FROM emoji_uses WHERE emoji = ?', e.id).map((r) => r.conv);
      db.tx(() => {
        db.run('DELETE FROM house_emoji WHERE id = ?', e.id);
        db.run('DELETE FROM emoji_uses WHERE emoji = ?', e.id);
        db.run('DELETE FROM files WHERE id = ?', e.file);
      });
      M.emojiUnlink?.(e.file);
      changed(e.house);
      // Everyone who could see it, in its house or where it was used, shows the plain name from now on.
      hub.toUsers([...members(e.house), ...uses.flatMap((u) => M.audience(u))], 'emoji.gone', { id: e.id, house: e.house });
      return {};
    },
  };
}

// The upload route: POST /api/files?emoji=<house>. Returns true when it answered.
export function createEmojiHttp({ db, M, filesDir, sendJson, error, body, uploadLimit }) {
  M.emojiUnlink = (file) => { unlink(join(filesDir, file)).catch(() => {}); };
  return async function emojiHttp(req, res, path, url, user) {
    if (req.method !== 'POST' || path !== '/api/files' || !url.searchParams.has('emoji')) return false;
    const house = url.searchParams.get('emoji') || '';
    if (!/^[\w.-]{1,80}$/.test(house) || !db.get('SELECT 1 FROM houses WHERE id = ?', house)) { error(res, 404, 'That house doesn’t exist.'); return true; }
    if (!M.isMember(house, user)) { error(res, 403, 'You’re not a member of that house.'); return true; }
    if (!M.can(user, house, 'emoji')) { error(res, 403, 'Your role can’t manage emoji in this house.'); return true; }
    if (uploadLimit && !uploadLimit.take(user)) { error(res, 429, 'Too many uploads at once. Wait a moment.'); return true; }
    const size = Number(req.headers['content-length']);
    if (!size) { error(res, 400, 'That image is empty.'); return true; }
    if (size > MAX_EMOJI_BYTES) { error(res, 413, 'Emoji images can be up to 256 KB.'); return true; }
    let data;
    try { data = await body(req, MAX_EMOJI_BYTES); } catch (e) {
      if (e.status === 413) { error(res, 413, 'Emoji images can be up to 256 KB.'); return true; }
      throw e;
    }
    const img = emojiImage(data);
    if (!img) { error(res, 415, 'Emoji need to be PNG, GIF or WebP images.'); return true; }
    if (!img.w || !img.h) { error(res, 415, 'Snug couldn’t read that image’s size.'); return true; }
    if (img.w > MAX_EMOJI_SIDE || img.h > MAX_EMOJI_SIDE) {
      error(res, 422, `That image is ${img.w} by ${img.h} pixels. Emoji can be up to ${MAX_EMOJI_SIDE} by ${MAX_EMOJI_SIDE}.`);
      return true;
    }
    const name = (safeDecode(String(req.headers['x-file-name'] || 'emoji')).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim() || 'emoji').slice(0, 120);
    const id = newId('f');
    await writeFile(join(filesDir, id), data, { mode: 0o600 });
    db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, user, `emoji:${house}`, name, img.type, data.length, Date.now(), JSON.stringify({ emoji: true, w: img.w, h: img.h }));
    sendJson(res, 201, { id, name, size: data.length, w: img.w, h: img.h, type: img.type });
    return true;
  };
}
