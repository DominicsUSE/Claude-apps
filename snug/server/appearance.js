// Customisation on the server (server/appearance.js).
//
// - Profile pictures: uploaded at POST /api/files?avatar (PNG, JPEG, WebP or
//   GIF, checked from the bytes, up to 2 MB, 64 to 2048 pixels a side) and
//   served at GET /api/avatars/<file> only while it is the owner's current
//   picture and only to people who may see them (a stranger, someone they
//   blocked, or a missing file all get the same 404).
// - Profile styling: an avatar decoration and its hue, a name style (font,
//   weight, hue) and two profile colours. Every value comes from a fixed list
//   or is a hex colour checked for readable text (js/lib/theme.js,
//   js/lib/colour.js). me.update is wrapped; changes are rate limited.
// - Settings: a "custom:<id>" theme has to name one of the person's saved
//   themes; every other rule is in cleanPrefs (js/lib/account.js).
import { writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { newId } from './model.js';
import { limiter } from './auth.js';
import { imageInfo } from './messaging.js';
import { cleanPrefs, mergePrefs } from '../js/lib/account.js';
import { DECORATION_IDS, HUE_IDS, cleanNameStyle, cleanProfileColors, customId } from '../js/lib/theme.js';

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const AVATAR_PX = [64, 2048];
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };

// ---------- Database (additive; safe to run on every start) ----------
export function migrateAppearance(db) {
  const add = (table, column, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  add('users', 'avatar', 'TEXT');
  add('users', 'avatar_anim', 'INTEGER');
  add('users', 'decoration', 'TEXT');
  add('users', 'decoration_hue', 'INTEGER');
  add('users', 'name_style', 'TEXT');
  add('users', 'profile_colors', 'TEXT');
}

// ---------- Ops ----------
export function createAppearanceOps({ db, M, hub, fail, ops = {} }) {
  const L = { profile: limiter({ capacity: 20, perSecond: 0.5 }) };
  hub.extraLimits = [...(hub.extraLimits || []), ...Object.values(L)];
  const slow = (name, user) => { if (!L[name].take(user)) fail('You’re going a little fast. Wait a moment and try again.'); };
  const blocked = (owner, viewer) => { try { return !!db.get('SELECT 1 FROM blocks WHERE user = ? AND other = ?', owner, viewer); } catch { return false; } };
  M.avatarVisible = (owner, viewer) => {
    const row = M.userRow(owner);
    return !!row && !row.deleted && M.sees(viewer, owner) && (viewer === owner || !blocked(owner, viewer));
  };

  // --- How people look: the picture and styling, for anyone who may see them ---
  const baseView = M.userView;
  M.userView = (row, ...rest) => {
    const v = baseView(row, ...rest);
    if (!v) return v;
    if (row.deleted) return v;
    if (row.avatar) { v.img = `/api/avatars/${row.avatar}`; if (row.avatar_anim) v.imgAnim = true; }
    if (row.decoration) { v.decoration = row.decoration; v.decorationHue = Number.isInteger(row.decoration_hue) ? row.decoration_hue : null; }
    const ns = json(row.name_style, null);
    if (ns) v.nameStyle = ns;
    const pc = json(row.profile_colors, null);
    if (pc) v.profileColors = pc;
    return v;
  };
  // Someone you may not see: no picture or styling (their picture would 404 anyway).
  const baseHidden = M.hiddenView;
  M.hiddenView = (row) => {
    const v = baseHidden(row);
    if (v) for (const k of ['img', 'imgAnim', 'decoration', 'decorationHue', 'nameStyle', 'profileColors']) delete v[k];
    return v;
  };

  // A deleted account loses its picture and styling (server/account.js tells
  // everyone through hub.userChanged once the account is gone).
  const baseChanged = hub.userChanged;
  hub.userChanged = (u) => {
    const row = M.userRow(u);
    if (row?.deleted && (row.avatar || row.decoration || row.name_style || row.profile_colors)) {
      db.run('UPDATE users SET avatar = NULL, avatar_anim = NULL, decoration = NULL, decoration_hue = NULL, name_style = NULL, profile_colors = NULL WHERE id = ?', u);
      hub.dropAvatarFiles?.(u, null);
    }
    return baseChanged(u);
  };

  // --- Export: what the account's picture and styling are ---
  const baseExport = M.exportExtra;
  M.exportExtra = (user) => {
    const row = M.userRow(user);
    return {
      ...(baseExport?.(user) || {}),
      appearance: {
        picture: row.avatar ? { file: row.avatar, type: db.get('SELECT type FROM files WHERE id = ?', row.avatar)?.type || null } : null,
        decoration: row.decoration ? { id: row.decoration, hue: row.decoration_hue ?? null } : null,
        nameStyle: json(row.name_style, null),
        profileColors: json(row.profile_colors, null),
      },
    };
  };

  const out = {};
  const baseUpdate = ops['me.update'];
  out['me.update'] = (c, d) => {
    if (!d || typeof d !== 'object') fail('That change isn’t valid.');
    const mine = {};
    const touched = ['avatar', 'decoration', 'decorationHue', 'nameStyle', 'profileColors'].some((k) => d[k] !== undefined);
    if (touched) slow('profile', c.user);
    if (d.avatar !== undefined) {
      if (d.avatar === null) { mine.avatar = null; mine.avatar_anim = null; }
      else {
        const f = typeof d.avatar === 'string' && FILE_ID.test(d.avatar) ? db.get('SELECT owner, conv, type FROM files WHERE id = ?', d.avatar) : null;
        if (!f || f.owner !== c.user || f.conv !== `avatar:${c.user}`) fail('Upload the picture first.');
        mine.avatar = d.avatar;
        mine.avatar_anim = f.type === 'image/gif' ? 1 : null;
      }
    }
    if (d.decoration !== undefined) {
      if (d.decoration !== null && !DECORATION_IDS.includes(d.decoration)) fail('Pick one of the decorations.');
      mine.decoration = d.decoration;
      if (d.decoration === null) mine.decoration_hue = null;
    }
    if (d.decorationHue !== undefined) {
      if (d.decorationHue !== null && !HUE_IDS.includes(d.decorationHue)) fail('Pick one of the decoration colours.');
      mine.decoration_hue = d.decorationHue;
    }
    if (d.nameStyle !== undefined) {
      try { const ns = cleanNameStyle(d.nameStyle); mine.name_style = ns ? JSON.stringify(ns) : null; } catch (e) { fail(e.message); }
    }
    if (d.profileColors !== undefined) {
      try { const pc = cleanProfileColors(d.profileColors); mine.profile_colors = pc ? JSON.stringify(pc) : null; } catch (e) { fail(e.message); }
    }
    const rest = { ...d };
    for (const k of ['avatar', 'decoration', 'decorationHue', 'nameStyle', 'profileColors']) delete rest[k];
    // All or nothing: if the rest of the change is refused, none of it is kept,
    // and the old picture's files go only once the new one is saved.
    const r = db.tx(() => {
      // Column names come from the fixed list above, never from input.
      for (const [k, v] of Object.entries(mine)) db.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, c.user);
      return baseUpdate(c, rest);
    });
    if ('avatar' in mine) hub.dropAvatarFiles?.(c.user, mine.avatar);
    return r;
  };

  // A custom theme has to be one of yours (saved now, or before).
  const basePrefs = ops['prefs.set'];
  if (basePrefs) {
    out['prefs.set'] = (c, d) => {
      const patch = cleanPrefs(d?.prefs, fail); // prefs.set itself is rate limited (server/account.js)
      const id = customId(patch.theme);
      if (id || patch.customThemes !== undefined) {
        const now = mergePrefs(M.prefsOf ? M.prefsOf(c.user) : {}, patch);
        const tid = customId(now.theme);
        if (tid && !(now.customThemes || []).some((t) => t.id === tid)) {
          if (id) fail('Save that theme before you use it.');
          d = { ...d, prefs: { ...d.prefs, theme: null } }; // the theme in use was removed: back to the default
        }
      }
      return basePrefs(c, d);
    };
  }
  return out;
}

// ---------- HTTP: uploading and serving profile pictures ----------
export function createAppearanceHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit }) {
  // Remove a person's picture files other than `keep` (old ones, and uploads never used).
  hub.dropAvatarFiles = (user, keep) => {
    const rows = db.all('SELECT id FROM files WHERE conv = ? AND id IS NOT ?', `avatar:${user}`, keep ?? null);
    for (const r of rows) {
      db.run('DELETE FROM files WHERE id = ?', r.id);
      unlink(join(filesDir, r.id)).catch(() => {});
    }
  };
  return async function appearanceHttp(req, res, path, url, user) {
    if (req.method === 'POST' && path === '/api/files' && url.searchParams.has('avatar')) {
      if (uploadLimit && !uploadLimit.take(user)) { error(res, 429, 'Too many uploads at once. Wait a moment.'); return true; }
      const size = Number(req.headers['content-length']);
      if (!size) { error(res, 400, 'That picture is empty.'); return true; }
      if (size > MAX_AVATAR_BYTES) { error(res, 413, 'Pictures can be up to 2 MB.'); return true; }
      let data;
      try { data = await body(req, MAX_AVATAR_BYTES); } catch (e) { if (e.status === 413) { error(res, 413, 'Pictures can be up to 2 MB.'); return true; } throw e; }
      const img = imageInfo(data);
      if (!img || !AVATAR_TYPES.includes(img.type)) { error(res, 415, 'Pictures need to be PNG, JPEG, GIF or WebP.'); return true; }
      if (!(img.w >= AVATAR_PX[0] && img.h >= AVATAR_PX[0])) { error(res, 422, `Pictures need to be at least ${AVATAR_PX[0]} pixels on each side.`); return true; }
      if (img.w > AVATAR_PX[1] || img.h > AVATAR_PX[1]) { error(res, 422, `Pictures can be up to ${AVATAR_PX[1]} pixels on each side.`); return true; }
      const id = newId('f');
      await writeFile(join(filesDir, id), data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, user, `avatar:${user}`, 'avatar', img.type, data.length, Date.now(), JSON.stringify({ w: img.w, h: img.h }));
      sendJson(res, 201, { id, w: img.w, h: img.h, type: img.type });
      return true;
    }
    // A picture: only someone's current one, only to people who may see them.
    const m = /^\/api\/avatars\/(f_[a-z0-9]{8,40})$/.exec(path);
    if (req.method === 'GET' && m) {
      const row = db.get('SELECT * FROM files WHERE id = ?', m[1]);
      const owner = row?.conv?.startsWith('avatar:') ? row.conv.slice(7) : null;
      if (!row || !owner || M.userRow(owner)?.avatar !== row.id || !M.avatarVisible(owner, user)) { error(res, 404, 'Not found'); return true; }
      headers(res, {
        'Content-Type': row.type, 'Content-Length': String(row.size), 'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
      });
      res.writeHead(200);
      createReadStream(join(filesDir, row.id)).pipe(res);
      return true;
    }
    return false;
  };
}
