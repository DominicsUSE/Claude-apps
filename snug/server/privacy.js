// Privacy controls on the server (server/privacy.js).
//
// - Who sees that you're online: everyone who already shares a house, a
//   conversation or a friendship with you (the default), friends only, or
//   nobody (prefs.presenceTo, js/lib/account.js). Every frame the hub sends
//   passes hub.outFilter, which shows you as offline to anyone the setting
//   leaves out, marks you `hideActive` so their app leaves out "Recently here"
//   and "last wrote" lines, and drops your typing notes to them. Messages
//   still carry the time they were sent; the setting can't hide that.
// - Typing: with prefs.typing off, while invisible, or with presence set to
//   nobody, the server sends no typing note for you at all (here and to
//   friends on other PCs). The app also stops showing other people's.
// - Link previews for links friends on other PCs send (desktop): fetching a
//   preview shows the linked site this PC's address, so it happens only when
//   the PC's owner turned prefs.friendPreviews on. Links you send still get
//   previews, fetched by your own PC as before.
// - What this Snug keeps, and for how long: GET /api/privacy (no sign-in),
//   read by Settings > Privacy and the privacy page (js/views/privacy.js),
//   so the words there come from the server's real settings.
// - Erasing what you wrote, when you delete your account and choose to:
//   eraseAuthored() below.
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { idleMs, SESSION_DAYS } from './auth.js';

// How long sign-in history and security events are kept, in days. The server
// owner can change it with SNUG_LOG_DAYS (1 to 365).
export const LOG_DAYS = 30;
export function logDaysFrom(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : LOG_DAYS;
}
// Failed sign-in counters (server/auth.js createAuthGuard prune).
export const FAILURE_HOURS = 48;
// Deleted messages can be brought back for this long; then their text is gone (server/index.js sweep).
export const UNDO_MINUTES = 11;

// Which STUN servers calls ask, and whether a TURN relay is set (server/voiceopts.js iceConfig).
export function iceFacts(ice) {
  const list = [].concat(typeof ice === 'function' ? ice('privacy-check') : ice).filter(Boolean);
  const urls = list.flatMap((s) => [].concat(s.urls || []));
  const stun = urls.filter((u) => /^stuns?:/.test(u));
  return {
    stun: !stun.length ? 'none' : stun.every((u) => /\.l\.google\.com/.test(u)) ? 'google' : 'custom',
    turn: urls.some((u) => /^turns?:/.test(u)),
  };
}

const PRESENCE_TO = new Set(['everyone', 'friends', 'nobody']);
// Files that belong to a house rather than to a conversation (server/media.js OWNED): they stay with the house.
const HOUSE_FILE = /^(emoji|sticker|housepic|eventcover|sound):/;

export function createPrivacy({ db, M, hub, ops, peer = null, facts = {}, filesDir = null, log = () => {} }) {
  const prefs = (u) => M.prefsOf?.(u) || {};
  // Only people who changed the presence setting are looked at on every frame.
  const narrow = new Map(); // user -> 'friends' | 'nobody'
  const remember = (u) => {
    const v = prefs(u).presenceTo;
    if (PRESENCE_TO.has(v) && v !== 'everyone') narrow.set(u, v); else narrow.delete(u);
  };
  try {
    for (const r of db.all("SELECT user FROM user_prefs WHERE prefs LIKE '%presenceTo%'")) remember(r.user);
  } catch { /* no account tables yet */ }

  // Whether `viewer` may see that `user` is online.
  M.presenceVisible = (viewer, user) => {
    if (viewer === user) return true;
    const to = narrow.get(user);
    if (!to) return true;
    return to === 'friends' && M.areFriends(viewer, user);
  };
  M.presenceToAll = (user) => narrow.get(user) !== 'nobody';
  // "How many are online" in Discover doesn't count people who show to nobody.
  const baseOnline = hub.isOnline;
  if (baseOnline) hub.isOnline = (u) => baseOnline(u) && M.presenceToAll(u);
  const quietTyping = (u) => prefs(u).typing === false || narrow.get(u) === 'nobody' || M.userRow(u)?.presence === 'offline';

  // ---------- Every frame out ----------
  const masked = (v) => ({ ...v, presence: 'offline', idle: false, hideActive: true });
  const isView = (v) => v && typeof v === 'object' && typeof v.id === 'string' && 'presence' in v;
  // A copy of `users` with the people this viewer may not see as online shown offline (the same object when nobody is).
  function maskUsers(viewer, users) {
    let out = users;
    for (const [id, v] of Object.entries(users)) {
      if (!isView(v) || M.presenceVisible(viewer, id)) continue;
      if (out === users) out = { ...users };
      out[id] = masked(v);
    }
    return out;
  }
  // A list of { user: view, ... } (Discover's people): each item masked; the same array when nothing changed.
  function maskList(viewer, list) {
    let out = list;
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object' || !isView(item.user) || M.presenceVisible(viewer, item.user.id)) return;
      if (out === list) out = [...list];
      out[i] = { ...item, user: masked(item.user) };
    });
    return out;
  }
  // Where people appear in a frame: `user`, a `users` map, or lists of { user } one level down.
  function maskData(viewer, ev, d) {
    if (!d || typeof d !== 'object') return d;
    if (Array.isArray(d)) return maskList(viewer, d);
    if (ev === 'typing') return M.presenceVisible(viewer, d.user) ? d : null;
    if (ev === 'presence') return M.presenceVisible(viewer, d.user) ? d : { ...d, presence: 'offline', hideActive: true };
    let out = d;
    if (isView(d.user) && !M.presenceVisible(viewer, d.user.id)) out = { ...out, user: masked(d.user) };
    for (const [k, v] of Object.entries(d)) {
      if (k === 'users' && v && typeof v === 'object' && !Array.isArray(v)) {
        const u = maskUsers(viewer, v);
        if (u !== v) out = { ...out, users: u };
      } else if (Array.isArray(v) && v.length && isView(v[0]?.user)) {
        const l = maskList(viewer, v);
        if (l !== v) out = { ...out, [k]: l };
      }
    }
    return out;
  }
  // Returns the frame to send, or null for none.
  hub.outFilter = (viewer, msg) => {
    if (!narrow.size || !viewer || !msg) return msg;
    if (msg.t === 'ev') {
      const d = maskData(viewer, msg.ev, msg.d);
      if (d === null) return null;
      return d === msg.d ? msg : { ...msg, d };
    }
    if ((msg.t === 'hello' || msg.t === 'ack') && msg.d) {
      const d = maskData(viewer, '', msg.d);
      return d === msg.d ? msg : { ...msg, d };
    }
    return msg;
  };

  // ---------- Ops ----------
  // Settings that change who sees what: everyone who could see you hears it at once.
  const basePrefs = ops['prefs.set'];
  if (basePrefs) {
    ops['prefs.set'] = (c, d) => {
      const before = narrow.get(c.user) || 'everyone';
      const r = basePrefs(c, d);
      remember(c.user);
      if ((narrow.get(c.user) || 'everyone') !== before) hub.userChanged(c.user); // p2p: also tells the directory (server/peer.js)
      return r;
    };
  }
  // Outermost (after server/peer.js), so nothing goes to friends on other PCs either.
  const baseTyping = ops.typing;
  if (baseTyping) ops.typing = (c, d) => (!c.peer && quietTyping(c.user) ? {} : baseTyping(c, d));

  // ---------- Link previews for links friends on other PCs send ----------
  const owner = () => peer?.identity?.self?.()?.user || null;
  M.previewAllowed = (author) => {
    if (!peer?.isRemote?.(author)) return true;
    const o = owner();
    return !!o && prefs(o).friendPreviews === true;
  };

  // ---------- Erasing what someone wrote ----------
  // Messages (rooms, threads, direct conversations), their earlier versions,
  // poll questions, forum titles, pins of them, reactions and poll votes, the
  // files they uploaded to conversations, their sign-in history and security
  // events. Rows stay as "Message deleted" so replies and threads keep their
  // place. House emoji, stickers, pictures and sounds stay with the house.
  // Returns { messages, files }.
  function eraseAuthored(user) {
    const now = Date.now();
    const has = (t) => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
    const cols = new Set(db.all('PRAGMA table_info(messages)').map((c) => c.name));
    const extra = ['embeds', 'fwd', 'sticker'].filter((c) => cols.has(c)).map((c) => `, ${c} = NULL`).join(''); // fixed names
    const mine = db.all('SELECT id, conv FROM messages WHERE author = ?', user);
    const files = db.all('SELECT id, conv FROM files WHERE owner = ?', user).filter((f) => !HOUSE_FILE.test(f.conv));
    db.tx(() => {
      db.run(`UPDATE messages SET text = '', fold = '', files = NULL${extra}, deleted = COALESCE(deleted, ?) WHERE author = ?`, now, user);
      for (const [table, col] of [['msg_edits', 'msg'], ['pins', 'msg'], ['polls', 'msg'], ['poll_votes', 'msg']]) {
        if (has(table)) db.run(`DELETE FROM ${table} WHERE ${col} IN (SELECT id FROM messages WHERE author = ?)`, user);
      }
      if (has('forum_posts')) db.run("UPDATE forum_posts SET title = '', tags = '[]' WHERE msg IN (SELECT id FROM messages WHERE author = ?)", user);
      db.run('DELETE FROM reactions WHERE user = ?', user);
      if (has('poll_votes')) db.run('DELETE FROM poll_votes WHERE user = ?', user);
      if (has('scheduled')) db.run('DELETE FROM scheduled WHERE user = ?', user);
      if (has('gif_favs')) db.run('DELETE FROM gif_favs WHERE user = ?', user);
      for (const f of files) db.run('DELETE FROM files WHERE id = ?', f.id);
      db.run('DELETE FROM auth_events WHERE user = ?', user);
      if (has('security_events')) db.run('DELETE FROM security_events WHERE user = ?', user);
    });
    if (filesDir) {
      for (const f of files) {
        try { unlinkSync(join(filesDir, f.id)); } catch (e) { if (e.code !== 'ENOENT') log('error', 'erase file', e.code); }
      }
    }
    // Everyone reading those conversations drops the messages now, not at their next reload.
    for (const m of mine) {
      try { hub.toConv(m.conv, 'msg.del', { conv: m.conv, id: m.id }); } catch { /* a conversation that's gone */ }
    }
    return { messages: mine.length, files: files.length };
  }

  // ---------- What this Snug keeps ----------
  const about = () => ({
    ...facts, logDays: facts.logDays ?? LOG_DAYS, failureHours: FAILURE_HOURS, undoMinutes: UNDO_MINUTES,
    sessionDays: SESSION_DAYS, idleDays: Math.round(idleMs(db) / 86_400_000), diagnostics: false,
  });

  return { eraseAuthored, about, quietTyping };
}
