// Account, profile, presence and security on the server (server/account.js).
//
// - Settings that follow you (appearance, accessibility, notifications):
//   one JSON blob per person, every change checked by cleanPrefs
//   (js/lib/account.js), sent to your other devices at once.
// - Presence: Focused is "do not disturb" and Offline is "invisible"
//   (server/hub.js already shows an invisible person as offline to everyone).
//   Auto-idle: each open tab reports whether its person has stopped using it;
//   when every reporting tab is idle, someone who is Open or Around shows as
//   Away to others, without changing what they picked.
// - Custom status: an emoji and a line that clear on their own (30 minutes
//   to never). The server stops showing it the moment it expires and a sweep
//   tells everyone.
// - Profile: pronouns, an accent hue (the theme owns its lightness), a banner
//   picture (checked from its bytes, served only to people who may see you),
//   a longer About with rich text, and private notes on people (only the
//   writer's own devices ever get them).
// - Security: sessions with the device and when each was last used; sign
//   one out, or every other one. Two-factor sign-in with TOTP (RFC 6238,
//   HMAC-SHA1, 30 seconds, 6 digits, one step of drift either way; a code
//   that was used once is refused after), and ten single-use backup codes
//   (stored hashed). Turning it on needs the password; turning it off, new
//   backup codes, a new password, deactivating and deleting all need the
//   password and, when it is on, a code.
// - Data: export everything you wrote as JSON; deactivate (sign in again to
//   come back); delete (your messages stay, as "Deleted user").
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { newId } from './model.js';
import { limiter, checkPassword, tokenHash, createSession, sessionCookie, endAllSessions } from './auth.js';
import { imageInfo } from './messaging.js';
import { cleanPrefs, upgradePrefs, mergePrefs, inQuiet, hasKeyword, everyonePing, MAX_PREFS_BYTES, deviceLabel } from '../js/lib/account.js';

export { deviceLabel };
export const BACKUP_CODES = 10;
export const MAX_BANNER_BYTES = 2 * 1024 * 1024;
export const TICKET_MS = 5 * 60_000;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const FILE_ID = /^f_[a-z0-9]{8,40}$/;

// ---------- TOTP (RFC 4226 / RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
  return String(n).padStart(digits, '0');
}
export const STEP_S = 30;
export const stepAt = (ms) => Math.floor(ms / 1000 / STEP_S);
export const totpAt = (key, ms, digits = 6) => hotp(key, stepAt(ms), digits);
// The time step a code belongs to (one step of drift either way), only if it
// is newer than `after` (the last step this account used), else -1.
export function totpMatch(key, code, { now = Date.now(), window = 1, after = -Infinity } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return -1;
  const cur = stepAt(now);
  let hit = -1;
  for (let s = cur - window; s <= cur + window; s++) {
    // Compare every candidate in constant time; never stop early on a match.
    if (timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code)) && s > after) hit = s;
  }
  return hit;
}
const CODE_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const backupHash = (code) => createHash('sha256').update(`snug-backup:${String(code).toLowerCase().replace(/[^a-z0-9]/g, '')}`).digest('hex');
function makeBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODES; i++) {
    const b = randomBytes(8);
    const s = [...b].map((x) => CODE_ALPHA[x % CODE_ALPHA.length]).join('');
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return codes;
}

// ---------- Database ----------
export function migrateAccount(db) {
  const add = (table, column, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  add('users', 'pronouns', "TEXT NOT NULL DEFAULT ''");
  add('users', 'accent', 'INTEGER');
  add('users', 'banner', 'TEXT');
  add('users', 'status_emoji', 'TEXT');
  add('users', 'status_until', 'INTEGER');
  add('users', 'deactivated', 'INTEGER');
  add('users', 'deleted', 'INTEGER');
  add('sessions', 'seen', 'INTEGER');
  add('sessions', 'agent', "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      prefs TEXT NOT NULL DEFAULT '{}',
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_notes (
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      note TEXT NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY (user, target)
    );
    CREATE TABLE IF NOT EXISTS totp (
      user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret TEXT,
      pending TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      step INTEGER NOT NULL DEFAULT 0,
      backup TEXT NOT NULL DEFAULT '[]',
      created INTEGER NOT NULL
    );`);
}

// Reads shared by the ops and the HTTP routes.
function reads(db) {
  const R = {};
  R.prefs = (u) => upgradePrefs(json(db.get('SELECT prefs FROM user_prefs WHERE user = ?', u)?.prefs, {}));
  R.totp = (u) => db.get('SELECT * FROM totp WHERE user = ?', u);
  R.totpOn = (u) => !!R.totp(u)?.enabled;
  R.notes = (u) => Object.fromEntries(db.all('SELECT target, note FROM user_notes WHERE user = ?', u).map((r) => [r.target, r.note]));
  // A second factor: a fresh TOTP code (not one already used) or an unused backup code.
  R.verifySecond = (u, code, now = Date.now()) => {
    const row = R.totp(u);
    if (!row?.enabled || typeof code !== 'string') return null;
    const c = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(c)) {
      const s = totpMatch(unbase32(row.secret), c, { now, after: row.step });
      if (s < 0) return null;
      // Only one sign-in per code: the step is burnt even if a later check fails.
      const r = db.run('UPDATE totp SET step = ? WHERE user = ? AND step < ?', s, u, s);
      return r.changes ? 'totp' : null;
    }
    const list = json(row.backup, []);
    const h = backupHash(c);
    if (!c || !list.includes(h)) return null;
    db.run('UPDATE totp SET backup = ? WHERE user = ?', JSON.stringify(list.filter((x) => x !== h)), u);
    return 'backup';
  };
  return R;
}

// ---------- Ops ----------
export function createAccountOps({ db, M, hub, fail, ops = {} }) {
  const R = reads(db);
  const idOf = (v, name) => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const text = (v, { max, name }) => {
    if (typeof v !== 'string') fail(`${name} is missing.`);
    const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (s.length > max) fail(`${name} can be at most ${max} characters.`);
    return s;
  };
  const L = {
    prefs: limiter({ capacity: 40, perSecond: 2 }),
    status: limiter({ capacity: 10, perSecond: 0.2 }),
    idle: limiter({ capacity: 10, perSecond: 0.2 }),
    note: limiter({ capacity: 20, perSecond: 0.5 }),
    sessions: limiter({ capacity: 10, perSecond: 0.2 }),
    totp: limiter({ capacity: 6, perSecond: 0.1 }),
    profile: limiter({ capacity: 20, perSecond: 0.5 }),
  };
  const slow = (name, user) => { if (!L[name].take(user)) fail('You’re going a little fast. Wait a moment and try again.'); };
  hub.extraLimits = [...(hub.extraLimits || []), ...Object.values(L)];

  // --- Auto-idle: user -> Map<socket, idle> ---
  const idle = new Map();
  const isIdle = (u) => { const m = idle.get(u); return !!m && m.size > 0 && [...m.values()].every(Boolean); };

  // --- People as others see them ---
  // `self` is the person looking at themselves (server/hub.js selfView, sign-in).
  const baseView = M.userView;
  M.userView = (row, presence, self = false) => {
    const v = baseView(row, presence);
    if (!v) return v;
    const live = row.status_until == null || row.status_until > Date.now();
    if (!live) v.status = '';
    v.statusEmoji = live && row.status_emoji ? row.status_emoji : null;
    v.statusUntil = live && row.status_until ? row.status_until : null;
    v.pronouns = row.pronouns || '';
    v.accent = Number.isInteger(row.accent) ? row.accent : null;
    v.banner = row.banner || null;
    v.idle = false;
    if (row.deleted) { v.deleted = true; v.presence = 'offline'; v.status = ''; v.statusEmoji = null; }
    else if (row.deactivated) { v.presence = 'offline'; v.status = ''; v.statusEmoji = null; }
    else if ((presence === 'open' || presence === 'around') && isIdle(row.id)) { v.presence = 'away'; v.idle = true; }
    // Invisible: a status they change would show they're here, so only they see it.
    if (!self && row.presence === 'offline') { v.status = ''; v.statusEmoji = null; v.statusUntil = null; }
    return v;
  };
  const baseHidden = M.hiddenView;
  M.hiddenView = (row) => { const v = baseHidden(row); if (v) { v.statusEmoji = null; v.statusUntil = null; v.idle = false; } return v; };

  // --- Push: quiet hours keep the phone quiet; highlight words and @everyone count as mentions ---
  const baseQuiet = M.quietFor;
  M.quietFor = (user, author, conv) => {
    if (baseQuiet?.(user, author, conv)) return true;
    return inQuiet(R.prefs(user).quiet);
  };
  // Used by push (server/push.js: previews off or streamer mode keep a note's
  // words off the lock screen) and calls (server/hub.js: quiet hours ring quietly).
  M.prefsOf = (user) => R.prefs(user);
  M.quietHours = (user) => inQuiet(R.prefs(user).quiet);
  // Deleting a house and two-factor for moderators (server/community.js) ask for the same second factor.
  M.totpOn = R.totpOn; M.verifySecond = R.verifySecond;
  const baseForMe = M.forMeExtra; // role mentions (server/places.js)
  M.forMeExtra = (user, row, w) => {
    if (baseForMe?.(user, row, w)) return true;
    const p = R.prefs(user);
    if (hasKeyword(row.text, p.keywords)) return true;
    // @everyone pushes; @here is for whoever is online, so it never needs a push.
    if (w.house && everyonePing(row.text) === 'everyone' && !p.everyoneOff?.[w.house] && M.can(row.author, w.house, 'announce')) return true;
    return false;
  };

  // --- Expiring statuses ---
  hub.sweepStatuses = () => {
    const t = Date.now();
    const gone = db.all('SELECT id FROM users WHERE status_until IS NOT NULL AND status_until <= ?', t);
    if (!gone.length) return 0;
    db.run("UPDATE users SET status = '', status_emoji = NULL, status_until = NULL WHERE status_until IS NOT NULL AND status_until <= ?", t);
    for (const r of gone) hub.userChanged(r.id);
    return gone.length;
  };
  // Once the database closes (the server stopped), the sweep stops too.
  const sweep = setInterval(() => { try { hub.sweepStatuses(); } catch { clearInterval(sweep); } }, 15_000);
  sweep.unref?.();

  // --- Snapshot: your settings, notes and two-factor state ---
  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnap(u);
    const t = R.totp(u);
    snap.account = { prefs: R.prefs(u), notes: R.notes(u), totp: !!t?.enabled, backupLeft: t?.enabled ? json(t.backup, []).length : 0 };
    return snap;
  };

  const sendAccount = (u, d, exceptWs) => hub.toUser(u, 'account', d, exceptWs);
  const currentHash = (c) => (c.ws?.token ? tokenHash(c.ws.token) : null);

  const out = {
    // Settings that follow you. Only the names and values in PREF_RULES are kept.
    'prefs.set'(c, d) {
      slow('prefs', c.user);
      const patch = cleanPrefs(d.prefs, fail);
      const next = mergePrefs(R.prefs(c.user), patch);
      const s = JSON.stringify(next);
      if (s.length > MAX_PREFS_BYTES) fail('That’s more settings than Snug can keep.');
      db.run('INSERT INTO user_prefs (user, prefs, updated) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET prefs = excluded.prefs, updated = excluded.updated', c.user, s, Date.now());
      sendAccount(c.user, { prefs: next }, c.ws);
      return { prefs: next };
    },

    // A custom status: emoji and words, cleared by the server when it runs out.
    'status.set'(c, d) {
      slow('status', c.user);
      const words = d.text === undefined ? '' : text(d.text, { max: 80, name: 'Your status' });
      let emoji = null;
      if (d.emoji != null && d.emoji !== '') {
        if (typeof d.emoji !== 'string' || d.emoji.length > 16 || !EMOJI.test(d.emoji)) fail('The status picture can be one emoji.');
        emoji = d.emoji;
      }
      const t = Date.now();
      const choice = d.clear ?? 'never';
      let until = null;
      if (choice === '30m') until = t + 30 * 60_000;
      else if (choice === '1h') until = t + 3_600_000;
      else if (choice === '4h') until = t + 4 * 3_600_000;
      else if (choice === 'today') {
        // The browser knows when its own day ends; a day can last 25 hours when
        // the clocks go back, so anything past 26 hours away isn't "today".
        if (!Number.isFinite(d.until) || d.until <= t || d.until > t + 26 * 3_600_000) fail('“Today” needs the end of your day.');
        until = Math.floor(d.until);
      } else if (choice !== 'never') fail('That isn’t one of the times a status can clear.');
      if (!words && !emoji) until = null;
      db.run('UPDATE users SET status = ?, status_emoji = ?, status_until = ? WHERE id = ?', words, emoji, until, c.user);
      // Someone invisible changing their status: only their own devices hear.
      if (M.userRow(c.user).presence === 'offline') hub.toUser(c.user, 'user', { user: hub.selfView(c.user) });
      else hub.userChanged(c.user);
      return { until };
    },

    // This tab's person stopped (or started) using it.
    'presence.idle'(c, d) {
      slow('idle', c.user);
      const before = isIdle(c.user);
      let m = idle.get(c.user);
      if (!m) { m = new Map(); idle.set(c.user, m); }
      if (c.ws && !m.has(c.ws)) {
        c.ws.once?.('close', () => {
          const was = isIdle(c.user);
          m.delete(c.ws);
          if (!m.size) idle.delete(c.user);
          if (was !== isIdle(c.user)) hub.userChanged(c.user);
        });
      }
      m.set(c.ws || 'x', d.idle === true);
      if (before !== isIdle(c.user)) hub.userChanged(c.user);
      return { idle: isIdle(c.user) };
    },

    // Private notes on people: nobody else ever receives them.
    'note.set'(c, d) {
      slow('note', c.user);
      const target = idOf(d.user, 'person');
      if (target === c.user || !M.userRow(target)) fail('That person isn’t here.');
      const note = text(d.note ?? '', { max: 256, name: 'A note' });
      if (note) db.run('INSERT INTO user_notes (user, target, note, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user, target) DO UPDATE SET note = excluded.note, updated = excluded.updated', c.user, target, note, Date.now());
      else db.run('DELETE FROM user_notes WHERE user = ? AND target = ?', c.user, target);
      sendAccount(c.user, { note: { user: target, note } }, c.ws);
      return {};
    },

    // Sessions: every device signed in as you.
    'sessions.list'(c) {
      slow('sessions', c.user);
      const mine = currentHash(c);
      return {
        sessions: db.all('SELECT hash, agent, created, seen FROM sessions WHERE user = ? AND expires > ? ORDER BY COALESCE(seen, created) DESC', c.user, Date.now())
          .map((s) => ({ id: s.hash.slice(0, 16), agent: s.agent || 'Unknown device', created: s.created, seen: s.seen || s.created, current: s.hash === mine })),
      };
    },
    'sessions.revoke'(c, d) {
      slow('sessions', c.user);
      if (typeof d.id !== 'string' || !/^[0-9a-f]{16}$/.test(d.id)) fail('That session isn’t valid.');
      const row = db.all('SELECT hash FROM sessions WHERE user = ?', c.user).find((s) => s.hash.startsWith(d.id));
      if (!row) fail('That session has already ended.');
      if (row.hash === currentHash(c)) fail('That’s this device. Use Sign out instead.');
      db.run('DELETE FROM sessions WHERE hash = ?', row.hash);
      try { db.run('DELETE FROM push_subs WHERE session = ?', row.hash); } catch { /* push not set up */ }
      hub.endToken?.(c.user, row.hash);
      return {};
    },
    'sessions.revokeOthers'(c) {
      slow('sessions', c.user);
      const mine = currentHash(c);
      if (!mine) fail('Snug can’t tell which device this is.');
      const others = db.all('SELECT hash FROM sessions WHERE user = ? AND hash != ?', c.user, mine);
      for (const s of others) {
        db.run('DELETE FROM sessions WHERE hash = ?', s.hash);
        try { db.run('DELETE FROM push_subs WHERE session = ?', s.hash); } catch { /* push not set up */ }
      }
      hub.endSessions(c.user, c.ws.token);
      return { ended: others.length };
    },

    // Two-factor sign-in.
    'totp.begin'(c) {
      slow('totp', c.user);
      if (R.totpOn(c.user)) fail('Two-factor sign-in is already on.');
      const secret = base32(randomBytes(20));
      db.run('INSERT INTO totp (user, pending, created) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET pending = excluded.pending', c.user, secret, Date.now());
      const handle = M.userRow(c.user).handle;
      const uri = `otpauth://totp/${encodeURIComponent(`Snug:${handle}`)}?secret=${secret}&issuer=Snug&algorithm=SHA1&digits=6&period=30`;
      return { secret, uri };
    },
    'totp.enable'(c, d) {
      slow('totp', c.user);
      const row = R.totp(c.user);
      if (row?.enabled) fail('Two-factor sign-in is already on.');
      if (!row?.pending) fail('Start again: Snug has no code waiting for you.');
      // The password first: a stolen session alone can't lock the owner out
      // behind an authenticator that isn't theirs.
      if (!checkPassword(String(d.password || ''), M.userRow(c.user).pass)) fail('Your password isn’t right.');
      const s = totpMatch(unbase32(row.pending), typeof d.code === 'string' ? d.code.replace(/\s/g, '') : '');
      if (s < 0) fail('That code isn’t right. Check the time on your phone and type the newest code.');
      const codes = makeBackupCodes();
      db.run('UPDATE totp SET secret = pending, pending = NULL, enabled = 1, step = ?, backup = ? WHERE user = ?', s, JSON.stringify(codes.map(backupHash)), c.user);
      sendAccount(c.user, { totp: true, backupLeft: codes.length }, c.ws);
      return { codes };
    },
    'totp.disable'(c, d) {
      slow('totp', c.user);
      if (!R.totpOn(c.user)) fail('Two-factor sign-in is already off.');
      if (!checkPassword(String(d.password || ''), M.userRow(c.user).pass)) fail('Your password isn’t right.');
      if (!R.verifySecond(c.user, String(d.code || ''))) fail('That code isn’t right.');
      db.run('DELETE FROM totp WHERE user = ?', c.user);
      sendAccount(c.user, { totp: false, backupLeft: 0 }, c.ws);
      return {};
    },
    'totp.codes'(c, d) {
      slow('totp', c.user);
      if (!R.totpOn(c.user)) fail('Turn on two-factor sign-in first.');
      if (!checkPassword(String(d.password || ''), M.userRow(c.user).pass)) fail('Your password isn’t right.');
      if (!R.verifySecond(c.user, String(d.code || ''))) fail('That code isn’t right.');
      const codes = makeBackupCodes();
      db.run('UPDATE totp SET backup = ? WHERE user = ?', JSON.stringify(codes.map(backupHash)), c.user);
      sendAccount(c.user, { backupLeft: codes.length }, c.ws);
      return { codes };
    },
  };

  // Profile: pronouns, accent, banner and a longer About, then the rest as before.
  const baseUpdate = ops['me.update'];
  out['me.update'] = (c, d) => {
    const mine = {};
    if (d.pronouns !== undefined || d.accent !== undefined || d.banner !== undefined || d.about !== undefined) slow('profile', c.user);
    if (d.pronouns !== undefined) mine.pronouns = text(d.pronouns, { max: 40, name: 'Pronouns' });
    if (d.accent !== undefined) mine.accent = d.accent === null ? null : (Number.isInteger(d.accent) && d.accent >= 0 && d.accent < 360 ? d.accent : fail('Pick one of the colours.'));
    if (d.banner !== undefined) {
      if (d.banner === null) mine.banner = null;
      else {
        const f = typeof d.banner === 'string' && FILE_ID.test(d.banner) ? db.get('SELECT owner, conv FROM files WHERE id = ?', d.banner) : null;
        if (!f || f.owner !== c.user || f.conv !== `banner:${c.user}`) fail('Upload the banner picture first.');
        mine.banner = d.banner;
      }
    }
    if (d.about !== undefined) mine.about = text(d.about, { max: 400, name: 'About you' });
    for (const [k, v] of Object.entries(mine)) db.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, c.user); // k is one of the four names above
    const rest = { ...d };
    for (const k of ['pronouns', 'accent', 'banner', 'about']) delete rest[k];
    if (rest.presence !== undefined) idle.delete(c.user); // picking a presence by hand wins over being idle
    if (rest.status !== undefined) db.run('UPDATE users SET status_until = NULL WHERE id = ?', c.user); // a line typed by hand stays until changed
    return baseUpdate(c, rest);
  };

  return out;
}

// ---------- HTTP: two-factor sign-in, export, deactivate, delete, banners ----------
export function createAccountHttp({ db, M, hub, filesDir, sendJson, error, jsonBody, body, headers, ipOf, secure, authLimit, uploadLimit, log = () => {} }) {
  const R = reads(db);
  const tickets = new Map(); // sha256(ticket) -> { user, until, tries }
  const exportLimit = limiter({ capacity: 3, perSecond: 3 / 3600 });
  hub.extraLimits = [...(hub.extraLimits || []), exportLimit];
  const agentOf = (req) => deviceLabel(req.headers['user-agent']);
  const ticketKey = (t) => createHash('sha256').update(String(t)).digest('hex');
  const strip = (row) => M.userView(row, row.presence, true);

  // After a correct password: either sign in now (null) or ask for the second step.
  function loginGate(row) {
    if (!R.totpOn(row.id)) { reactivate(row.id); return null; }
    for (const [k, t] of tickets) if (t.until < Date.now()) tickets.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    tickets.set(ticketKey(ticket), { user: row.id, until: Date.now() + TICKET_MS, tries: 0 });
    return { totp: true, ticket };
  }
  function reactivate(user) {
    if (M.userRow(user)?.deactivated) { db.run('UPDATE users SET deactivated = NULL WHERE id = ?', user); hub.userChanged(user); }
  }
  // Password, typed handle (for delete) and the second factor when it is on.
  function confirm(user, d, { handle = false } = {}) {
    const row = M.userRow(user);
    if (!checkPassword(String(d.password || ''), row.pass)) return 'Your password isn’t right.';
    if (handle && String(d.confirm || '').trim().replace(/^@/, '').toLowerCase() !== row.handle.toLowerCase()) return `Type your username, ${row.handle}, to confirm.`;
    if (R.totpOn(user) && !R.verifySecond(user, String(d.code || ''))) return 'Type a code from your authenticator app, or a backup code.';
    return null;
  }
  const cookieGone = () => ({ 'Set-Cookie': sessionCookie('', { secure, clear: true }) });

  function soleOwnerOf(user) {
    const out = [];
    for (const m of db.all('SELECT house FROM members WHERE user = ?', user)) {
      const others = db.get('SELECT COUNT(*) n FROM members WHERE house = ? AND user != ?', m.house, user).n;
      if (!others || !M.isOwner(user, m.house)) continue;
      const ownerRole = db.get('SELECT id FROM roles WHERE house = ? ORDER BY pos LIMIT 1', m.house).id;
      if (db.get('SELECT COUNT(*) n FROM members WHERE house = ? AND role = ?', m.house, ownerRole).n < 2) out.push(db.get('SELECT name FROM houses WHERE id = ?', m.house).name);
    }
    return out;
  }

  function deleteAccount(user) {
    const c = { user, ws: null };
    hub.voiceLeave?.(user);
    for (const m of db.all('SELECT house FROM members WHERE user = ?', user)) {
      try { hub.ops['house.leave'](c, { house: m.house }); } catch (e) { log('account delete: leave', e.message); db.run('DELETE FROM members WHERE house = ? AND user = ?', m.house, user); }
    }
    for (const f of db.all('SELECT other FROM friends WHERE user = ?', user)) {
      try { hub.ops['friend.remove'](c, { user: f.other }); } catch { /* already gone */ }
    }
    db.run('DELETE FROM friends WHERE user = ? OR other = ?', user, user);
    db.tx(() => {
      db.run(`UPDATE users SET name = 'Deleted user', handle = ?, pass = '!', about = '', status = '', status_emoji = NULL, status_until = NULL,
        emoji = NULL, hue = 165, interests = '[]', links = '[]', pronouns = '', accent = NULL, banner = NULL, presence = 'offline', deleted = 1, deactivated = NULL WHERE id = ?`,
      `deleted-${randomBytes(6).toString('hex')}`, user);
      db.run('DELETE FROM user_prefs WHERE user = ?', user);
      db.run('DELETE FROM user_notes WHERE user = ? OR target = ?', user, user);
      db.run('DELETE FROM totp WHERE user = ?', user);
      db.run('DELETE FROM saved WHERE user = ?', user);
      db.run('DELETE FROM notify WHERE user = ?', user);
      db.run('DELETE FROM personal_invites WHERE user = ?', user);
      db.run('DELETE FROM scheduled WHERE user = ?', user); // nothing goes out later as "Deleted user"
      try { db.run('DELETE FROM push_subs WHERE user = ?', user); } catch { /* push not set up */ }
      endAllSessions(db, user);
    });
    hub.endSessions(user);
    hub.userChanged(user);
  }

  function exportFor(user) {
    const row = M.userRow(user);
    const handleOf = (id) => M.userRow(id)?.handle || id;
    const houses = db.all('SELECT h.id, h.name FROM members m JOIN houses h ON h.id = m.house WHERE m.user = ?', user);
    const where = (conv) => {
      const w = M.where(conv);
      if (!w) return 'gone';
      if (w.type === 'room') return `${db.get('SELECT name FROM houses WHERE id = ?', w.house)?.name} / ${w.room.name}`;
      if (w.type === 'dm') return 'direct conversation';
      return w.house ? 'thread in a room' : 'thread in a direct conversation';
    };
    const places = new Map();
    const messages = db.all('SELECT id, conv, ts, text, reply_to, files, edited FROM messages WHERE author = ? AND deleted IS NULL ORDER BY ts', user).map((m) => {
      if (!places.has(m.conv)) places.set(m.conv, where(m.conv));
      return {
        id: m.id, conv: m.conv, where: places.get(m.conv), at: new Date(m.ts).toISOString(), text: m.text,
        ...(m.reply_to ? { replyTo: m.reply_to } : {}), ...(m.edited ? { edited: new Date(m.edited).toISOString() } : {}),
        ...(m.files ? { files: json(m.files, []).map((f) => f.name || f.id || f) } : {}),
      };
    });
    const dms = db.all('SELECT dm FROM dm_members WHERE user = ?', user).map((r) => ({
      id: r.dm, name: db.get('SELECT name FROM dms WHERE id = ?', r.dm)?.name || null,
      members: db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY rowid', r.dm).map((x) => handleOf(x.user)),
    }));
    return {
      app: 'Snug', exported: new Date().toISOString(),
      account: {
        id: row.id, handle: row.handle, name: row.name, pronouns: row.pronouns || '', about: row.about, status: row.status,
        created: new Date(row.created).toISOString(), interests: json(row.interests, []), links: json(row.links, []),
        twoFactor: R.totpOn(user),
      },
      settings: R.prefs(user),
      ...(M.exportExtra?.(user) || {}), // more parts of the account (server/appearance.js: picture and styling)
      notes: Object.entries(R.notes(user)).map(([id, note]) => ({ person: handleOf(id), note })),
      friends: db.all('SELECT other, state, favorite, since FROM friends WHERE user = ?', user).map((f) => ({ person: handleOf(f.other), state: f.state, favorite: !!f.favorite, since: f.since ? new Date(f.since).toISOString() : null })),
      houses,
      conversations: dms,
      sessions: db.all('SELECT agent, created, seen FROM sessions WHERE user = ?', user).map((s) => ({ device: s.agent, created: new Date(s.created).toISOString(), lastSeen: new Date(s.seen || s.created).toISOString() })),
      messages,
    };
  }

  // Routes that need no session: the second step of signing in.
  async function open(req, res, path) {
    if (!(req.method === 'POST' && path === '/api/login/totp')) return false;
    if (!authLimit.take(`totp:${ipOf(req)}`)) { error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
    const d = await jsonBody(req);
    const key = ticketKey(d.ticket || '');
    const t = tickets.get(key);
    if (!t || t.until < Date.now()) { tickets.delete(key); error(res, 401, 'That sign-in took too long. Start again with your password.'); return true; }
    if (++t.tries > 5) { tickets.delete(key); error(res, 429, 'Too many wrong codes. Start again with your password.'); return true; }
    // And per account, whatever the address and however many tickets: someone
    // with the password and many addresses still gets ten guesses per 15 minutes.
    if (!authLimit.take(`totp-user:${t.user}`)) { error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
    if (!R.verifySecond(t.user, String(d.code || ''))) { error(res, 401, 'That code isn’t right. Type the newest code from your app, or a backup code.'); return true; }
    tickets.delete(key);
    reactivate(t.user);
    const token = createSession(db, t.user, agentOf(req));
    sendJson(res, 200, { user: strip(M.userRow(t.user)) }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    return true;
  }

  // Routes for a signed-in person.
  async function authed(req, res, path, url, user) {
    const post = req.method === 'POST';
    if (req.method === 'GET' && path === '/api/account/export') {
      if (!exportLimit.take(user)) { error(res, 429, 'You can download your data three times an hour. Try again later.'); return true; }
      const data = exportFor(user);
      sendJson(res, 200, data, { 'Content-Disposition': `attachment; filename="snug-${data.account.handle}-${new Date().toISOString().slice(0, 10)}.json"` });
      return true;
    }
    if (post && (path === '/api/account/delete' || path === '/api/account/deactivate')) {
      if (!authLimit.take(`acct:${user}`)) { error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
      const d = await jsonBody(req);
      const del = path === '/api/account/delete';
      const why = confirm(user, d, { handle: del });
      if (why) { error(res, 401, why); return true; }
      if (del) {
        const owned = soleOwnerOf(user);
        if (owned.length) { error(res, 409, `You’re the only owner of ${owned.join(', ')}. Give someone else the owner role first, or remove everyone else.`); return true; }
        deleteAccount(user);
      } else {
        db.run('UPDATE users SET deactivated = 1 WHERE id = ?', user);
        db.run('DELETE FROM scheduled WHERE user = ?', user); // a deactivated account doesn't post
        endAllSessions(db, user);
        try { db.run('DELETE FROM push_subs WHERE user = ?', user); } catch { /* push not set up */ }
        hub.endSessions(user);
        hub.userChanged(user);
      }
      sendJson(res, 200, {}, cookieGone());
      return true;
    }
    if (post && path === '/api/files' && url.searchParams.has('banner')) {
      if (uploadLimit && !uploadLimit.take(user)) { error(res, 429, 'Too many uploads at once. Wait a moment.'); return true; }
      const size = Number(req.headers['content-length']);
      if (!size) { error(res, 400, 'That picture is empty.'); return true; }
      if (size > MAX_BANNER_BYTES) { error(res, 413, 'Banners can be up to 2 MB.'); return true; }
      let data;
      try { data = await body(req, MAX_BANNER_BYTES); } catch (e) { if (e.status === 413) { error(res, 413, 'Banners can be up to 2 MB.'); return true; } throw e; }
      const img = imageInfo(data);
      if (!img || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(img.type)) { error(res, 415, 'Banners need to be PNG, JPEG, GIF or WebP pictures.'); return true; }
      const id = newId('f');
      await writeFile(join(filesDir, id), data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, user, `banner:${user}`, 'banner', img.type, data.length, Date.now(), JSON.stringify({ w: img.w, h: img.h }));
      sendJson(res, 201, { id, w: img.w, h: img.h, type: img.type });
      return true;
    }
    // A banner: only someone's current one, only to people who may see them.
    const b = /^\/api\/banners\/(f_[a-z0-9]{8,40})$/.exec(path);
    if (req.method === 'GET' && b) {
      const row = db.get('SELECT * FROM files WHERE id = ?', b[1]);
      const owner = row?.conv.startsWith('banner:') ? row.conv.slice(7) : null;
      if (!row || !owner || M.userRow(owner)?.banner !== row.id || !M.sees(user, owner)) { error(res, 404, 'Not found'); return true; }
      headers(res, {
        'Content-Type': row.type, 'Content-Length': String(row.size), 'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.writeHead(200);
      createReadStream(join(filesDir, row.id)).pipe(res);
      return true;
    }
    return false;
  }

  return { open, authed, loginGate, agentOf, totpOn: R.totpOn, verifySecond: R.verifySecond, reset: () => exportLimit.reset() };
}
