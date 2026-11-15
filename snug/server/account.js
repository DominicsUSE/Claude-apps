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
// - Sign-in hardening (sec-auth): sign-up, sign-in and sign-out live here.
//   Wrong passwords and codes count in SQLite (server/auth.js createAuthGuard)
//   per account, per account and address, and per second factor, with
//   exponential waits after a free allowance; a browser that signed in to the
//   account before (the snug_known cookie) skips the account-wide wait, so a
//   stranger can't lock the owner out. Every check of a password or code by a
//   signed-in session (step-up) shares one counter. The TOTP secret is stored
//   encrypted (AES-256-GCM) and backup codes as HMACs, both under the data
//   key kept outside the database (<data>/secret.key). Every sign-in, failure
//   and security change goes to the auth_events table (30 days by default,
//   SNUG_LOG_DAYS; addresses truncated) and the log as one JSON line, never with a password, code,
//   secret or token; a burst of failures logs a "suspicious" line; other
//   devices hear about a new sign-in.
// - Data: export everything you wrote as JSON, or as a zip with the files you
//   uploaded and a readable copy of your messages; deactivate (sign in again
//   to come back); delete (your messages stay, as "Deleted user", unless you
//   choose to erase them: server/privacy.js eraseAuthored).
// - Failure counters (privacy): the address part of a per-account-and-address
//   key is an HMAC under the data key, never the address itself.
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { sendFile, suspicious, securityEvent } from './seclog.js'; // sec-web W1; sec-integrate: the audit trail feeds the detectors directly
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { newId } from './model.js';
import { zipWriter } from './zip.js'; // privacy: Download my data as one zip
import {
  limiter, verifyPassword, hashPasswordAsync, burnPasswordCheck, passwordProblem, tokenHash, createSession, sessionCookie, endAllSessions, endSession,
  readCookie, COOKIE, sessionValid, recentAuth, markAuth, createAuthGuard, POLICIES, loadDataKey, subKey, seal, unseal, isSealed, maskIp,
  configureSessions, MAX_PASSWORD, SESSION_DAYS, idleMs,
} from './auth.js';
import { HUES, stripInvisible } from '../js/lib/util.js'; // sec-authz: stripInvisible
import { imageInfo } from './messaging.js';
import { cleanPrefs, upgradePrefs, mergePrefs, inQuiet, hasKeyword, everyonePing, MAX_PREFS_BYTES, deviceLabel } from '../js/lib/account.js';

export { deviceLabel };
export const BACKUP_CODES = 10;
export const MAX_BANNER_BYTES = 2 * 1024 * 1024;
export const TICKET_MS = 5 * 60_000;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const likeSafe = (v) => String(v).replace(/[\\%_]/g, (ch) => `\\${ch}`); // a value inside LIKE, matched as itself

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
// 0.10.1 stored an unsalted SHA-256 of each backup code. Now that digest is keyed
// with the data key and the account (HMAC-SHA256), so a copy of the database
// alone can't be searched offline, and the same code gives a different value
// for every account. Old rows are rewrapped the first time they are read.
const legacyBackup = (code) => createHash('sha256').update(`snug-backup:${String(code).toLowerCase().replace(/[^a-z0-9]/g, '')}`).digest('hex');
const wrapBackup = (key, user, legacy) => `h2:${createHmac('sha256', key).update(`${user}:${legacy}`).digest('hex')}`;
const backupHash = (key, user, code) => wrapBackup(key, user, legacyBackup(code));
// Unbiased characters: bytes past the last whole multiple of 31 are skipped.
function randomCode(n) {
  let s = '';
  while (s.length < n) for (const x of randomBytes(16)) if (x < 248 && s.length < n) s += CODE_ALPHA[x % 31];
  return s;
}
function makeBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODES; i++) { const s = randomCode(8); codes.push(`${s.slice(0, 4)}-${s.slice(4)}`); }
  return codes;
}

// ---------- Security core: one per database ----------
// The data key, the failure counters and the audit trail, shared by the ops
// (made first, in server/ops.js) and the HTTP routes (which load the key and
// pass the log, before the server takes any request).
const CORES = new WeakMap();
const tooMany = (ms) => `Too many tries. Wait ${ms > 90_000 ? `${Math.ceil(ms / 60_000)} minutes` : 'a minute'} and try again.`;
function core(db) {
  let c = CORES.get(db);
  if (c) return c;
  c = { key: null, derived: null, log: () => {}, guard: createAuthGuard(db), windows: new Map(), pruned: 0, keepDays: 30 };
  // privacy: an address as a failure-counter key: an HMAC, so the table never holds the address.
  c.addrKey = (ip) => createHmac('sha256', c.keys().addr).update(String(ip || '')).digest('base64url').slice(0, 22);
  // The hourly sweep: sign-in history past keepDays (SNUG_LOG_DAYS), failure counters past two days.
  c.prune = (now = Date.now()) => {
    c.pruned = now;
    try { db.run('DELETE FROM auth_events WHERE ts < ?', now - c.keepDays * 86_400_000); c.guard.prune(); } catch { /* closing */ }
  };
  c.setKey = (k) => { c.key = k; c.derived = null; };
  // sec-review: false while the data key is a throwaway (secret.key couldn't be read, server/auth.js): nothing
  // may then be sealed or wrapped with it, or it would stay unreadable once the real key is back.
  c.usable = () => !c.key?.unusable;
  c.keys = () => {
    if (!c.key) c.key = randomBytes(32); // only when the ops run without the HTTP side (never in the server)
    return (c.derived ||= { enc: subKey(c.key, 'totp-secret'), backup: subKey(c.key, 'backup-codes'), device: subKey(c.key, 'known-device'), addr: subKey(c.key, 'failure-address') });
  };
  // A burst of failures for one account or one address: one "suspicious" line an hour.
  const bump = (k, limit, what, extra) => {
    const now = Date.now();
    const w = c.windows.get(k);
    if (!w || w.start < now - 3_600_000) { c.windows.set(k, { start: now, n: 1, told: false }); }
    else if (++w.n > limit && !w.told) {
      w.told = true;
      c.log('suspicious', JSON.stringify({ what, failures: w.n, window: '1h', ...extra }));
      suspicious({ source: 'auth', what, failures: w.n, ...extra }, db); // sec-web: db picks this server's seclog; never throws
    }
    if (c.windows.size > 20_000) for (const [key, v] of c.windows) if (v.start < now - 3_600_000) c.windows.delete(key);
  };
  // One security event: a row in auth_events and a JSON log line. Never a password,
  // code, secret, ticket or token; addresses truncated (1.2.3.x, 2001:db8:1::/48);
  // `why` is one of a few fixed words.
  c.audit = (event, { user = null, ip = '', agent = '', ok = true, why = null } = {}) => {
    const now = Date.now();
    const masked = maskIp(ip);
    try { db.run('INSERT INTO auth_events (ts, user, event, ok, ip, agent, why) VALUES (?, ?, ?, ?, ?, ?, ?)', now, user, event, ok ? 1 : 0, masked, String(agent || '').slice(0, 80), why); } catch { /* closing */ }
    const line = { event, ok, ...(user ? { user } : {}), ...(masked ? { ip: masked } : {}), ...(agent ? { agent: String(agent).slice(0, 80) } : {}), ...(why ? { why } : {}) };
    c.log('audit', JSON.stringify(line));
    securityEvent({ source: 'auth', ...line }, db); // sec-web; never throws
    if (!ok) {
      if (user) bump(`u:${user}`, 20, 'auth failures for one account', { user });
      if (ip) bump(`i:${masked}`, 100, 'auth failures from one address', { ip: masked });
    }
    if (now - c.pruned > 3_600_000) c.prune(now);
  };
  CORES.set(db, c);
  return c;
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
  add('sessions', 'auth_at', 'INTEGER'); // sec-auth: when this session last proved who it is (server/auth.js recentAuth)
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user TEXT,
      event TEXT NOT NULL,
      ok INTEGER NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT '',
      why TEXT
    );
    CREATE INDEX IF NOT EXISTS auth_events_user ON auth_events(user, ts);
    CREATE INDEX IF NOT EXISTS auth_events_ts ON auth_events(ts);
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
  const C = core(db);
  R.prefs = (u) => upgradePrefs(json(db.get('SELECT prefs FROM user_prefs WHERE user = ?', u)?.prefs, {}));
  // The two-factor row with its secrets decrypted (null when they don't decrypt
  // with this data key). Plain 0.10.1 secrets and backup digests are upgraded here.
  R.sealTotp = (u, secret) => seal(C.keys().enc, `totp:${u}`, secret);
  R.backupHash = (u, code) => backupHash(C.keys().backup, u, code);
  R.keyUsable = () => C.usable();
  R.totp = (u) => {
    const row = db.get('SELECT * FROM totp WHERE user = ?', u);
    if (!row) return row;
    const out = { ...row };
    for (const col of ['secret', 'pending']) {
      const v = row[col];
      if (!v) continue;
      if (isSealed(v)) out[col] = unseal(C.keys().enc, `totp:${u}`, v);
      else if (C.usable()) db.run(`UPDATE totp SET ${col} = ? WHERE user = ? AND ${col} = ?`, R.sealTotp(u, v), u, v); // col is one of the two names above
    }
    const list = json(row.backup, []);
    // sec-review: with a throwaway key, 0.10.1 digests stay as they are (and don't match: backup codes fail closed).
    if (C.usable() && list.some((h) => /^[0-9a-f]{64}$/.test(h))) {
      out.backup = JSON.stringify(list.map((h) => (/^[0-9a-f]{64}$/.test(h) ? wrapBackup(C.keys().backup, u, h) : h)));
      db.run('UPDATE totp SET backup = ? WHERE user = ? AND backup = ?', out.backup, u, row.backup);
    }
    return out;
  };
  R.totpOn = (u) => !!R.totp(u)?.enabled;
  R.notes = (u) => Object.fromEntries(db.all('SELECT target, note FROM user_notes WHERE user = ?', u).map((r) => [r.target, r.note]));
  // A second factor: a fresh TOTP code (not one already used) or an unused backup code.
  R.verifySecond = (u, code, now = Date.now()) => {
    const row = R.totp(u);
    if (!row?.enabled || typeof code !== 'string') return null;
    const c = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(c)) {
      if (!row.secret) return null; // not readable with this data key: never a known key
      const s = totpMatch(unbase32(row.secret), c, { now, after: row.step });
      if (s < 0) return null;
      // Only one sign-in per code: the step is burnt even if a later check fails.
      const r = db.run('UPDATE totp SET step = ? WHERE user = ? AND step < ?', s, u, s);
      return r.changes ? 'totp' : null;
    }
    const list = json(row.backup, []);
    const h = R.backupHash(u, c);
    if (!c || !list.includes(h)) return null;
    const r = db.run('UPDATE totp SET backup = ? WHERE user = ? AND backup = ?', JSON.stringify(list.filter((x) => x !== h)), u, row.backup);
    return r.changes ? 'backup' : null; // two uses of one code at once: only the first counts
  };

  // ---------- Step-up: a signed-in session proving it again ----------
  // One counter per account for every path that checks a password or code for
  // someone already signed in (two-factor settings, a new password, a new
  // username, delete, deactivate, house transfer and delete, GitHub link): five
  // free failures, then waits that double. Password failures also count toward
  // the account's sign-in lockout. Returns null, or { status, field, message }.
  const G = C.guard;
  R.stepFail = (u, field, what) => {
    G.fail(`su:${u}`, POLICIES.stepUp);
    if (field === 'password') G.fail(`pw:${u}`, POLICIES.password);
    if (field === 'code') G.fail(`code:${u}`, POLICIES.code);
    C.audit('stepup', { user: u, ok: false, why: field });
    void what;
  };
  R.stepWait = (u) => G.waitMs(`su:${u}`, POLICIES.stepUp);
  R.stepUp = async (u, { password, code, token = null, needPassword = true, needCode = true, what = '' } = {}) => {
    const wait = R.stepWait(u);
    if (wait) { C.audit('stepup', { user: u, ok: false, why: 'locked' }); return { status: 429, field: 'wait', message: tooMany(wait) }; }
    const row = db.get('SELECT pass FROM users WHERE id = ?', u);
    if (needPassword) {
      const r = await verifyPassword(typeof password === 'string' ? password : '', row?.pass);
      if (!r.ok) { R.stepFail(u, 'password', what); return { status: 401, field: 'password', message: 'Your password isn’t right.' }; }
      if (r.upgrade) await R.rehash(u, password);
    }
    if (needCode && R.totpOn(u) && !R.verifySecond(u, typeof code === 'string' ? code : '')) {
      R.stepFail(u, 'code', what);
      return { status: 401, field: 'code', message: 'Type a code from your authenticator app, or a backup code.' };
    }
    G.clear(`su:${u}`);
    markAuth(db, token);
    return null;
  };
  // A stored hash older or cheaper than today's, replaced after a right password.
  R.rehash = (u, password) => hashPasswordAsync(password)
    .then((h) => { db.run("UPDATE users SET pass = ? WHERE id = ? AND pass != '!'", h, u); }).catch(() => {});
  return R;
}

// ---------- Ops ----------
export function createAccountOps({ db, M, hub, fail, ops = {} }) {
  const R = reads(db);
  const keyCheck = () => { if (!R.keyUsable()) fail('Two-factor settings can’t be changed right now: Snug can’t read its key file. Restart Snug, or ask whoever runs this server.'); };
  const idOf = (v, name) => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const text = (v, { max, name }) => {
    if (typeof v !== 'string') fail(`${name} is missing.`);
    const s = stripInvisible(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim(); // sec-authz: stripInvisible
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
  // sec-auth: through the shared step-up counter; while it says wait, the op is refused with how long.
  M.totpOn = R.totpOn;
  M.verifySecond = (u, code) => {
    const wait = R.stepWait(u);
    if (wait) fail(tooMany(wait));
    const r = R.verifySecond(u, code);
    if (r) core(db).guard.clear(`su:${u}`); else R.stepFail(u, 'code', 'op');
    return r;
  };
  // A password typed by a signed-in person (server/inbox.js me.handle): true or false, or refused while waiting.
  M.passwordOk = async (u, password) => {
    const r = await R.stepUp(u, { password, needCode: false, what: 'op' });
    if (r?.field === 'wait') fail(r.message);
    return !r;
  };
  M.stepUp = R.stepUp;
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
  const audit = (event, c, extra = {}) => core(db).audit(event, { user: c.user, agent: c.ws?.agent || '', ...extra });
  // Password (and code, when two-factor is on) for an op; the op's own words for each failure.
  async function stepUp(c, d, { needCode = true, words = {} } = {}) {
    const r = await R.stepUp(c.user, { password: d.password, code: typeof d.code === 'string' ? d.code.replace(/\s/g, '') : '', token: c.ws?.token, needCode });
    if (r) fail(words[r.field] || r.message);
  }
  // Every session but this one ends: after a password change, or turning on two-factor sign-in.
  function endOthers(c) {
    const mine = currentHash(c);
    const others = db.all('SELECT hash FROM sessions WHERE user = ? AND hash != ?', c.user, mine || '');
    for (const s of others) {
      db.run('DELETE FROM sessions WHERE hash = ?', s.hash);
      try { db.run('DELETE FROM push_subs WHERE session = ?', s.hash); } catch { /* push not set up */ }
    }
    hub.endSessions(c.user, c.ws?.token);
    return others.length;
  }

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
      // e2eeDevice: the end-to-end encryption device bound on that session (server/e2ee.js), so signing it out can remove its keys too.
      return {
        sessions: db.all('SELECT * FROM sessions WHERE user = ? AND expires > ? AND COALESCE(seen, created) > ? ORDER BY COALESCE(seen, created) DESC', c.user, Date.now(), Date.now() - idleMs(db))
          .map((s) => ({ id: s.hash.slice(0, 16), agent: s.agent || 'Unknown device', created: s.created, seen: s.seen || s.created, current: s.hash === mine, ...(s.e2ee_device ? { e2eeDevice: s.e2ee_device } : {}) })),
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
      audit('sessions.revoke', c);
      return {};
    },
    'sessions.revokeOthers'(c) {
      slow('sessions', c.user);
      if (!currentHash(c)) fail('Snug can’t tell which device this is.');
      const ended = endOthers(c);
      audit('sessions.revokeOthers', c);
      return { ended };
    },
    // sec-auth: the account's recent sign-ins and security changes (Settings > Account): device, time, truncated address.
    'auth.recent'(c) {
      const alertsFor = (u) => {
        try {
          return db.all("SELECT ts, ip, detail FROM security_events WHERE user = ? AND kind = 'alert' ORDER BY ts DESC LIMIT 10", u).map((r) => {
            let what = '';
            try { what = String(JSON.parse(r.detail).what || '').slice(0, 120); } catch { /* kept empty */ }
            return { at: r.ts, event: 'alert', ok: false, ip: r.ip, agent: '', what };
          });
        } catch { return []; } // no security log (ops without the server)
      };
      slow('sessions', c.user);
      return {
        events: [
          ...db.all('SELECT ts, event, ok, ip, agent FROM auth_events WHERE user = ? ORDER BY ts DESC, id DESC LIMIT 30', c.user)
            .map((e) => ({ at: e.ts, event: e.event, ok: !!e.ok, ip: e.ip, agent: e.agent })),
          ...alertsFor(c.user), // sec-integrate: suspicious-activity alerts for this account (server/seclog.js)
        ].sort((a, b) => b.at - a.at).slice(0, 30),
      };
    },

    // Two-factor sign-in.
    'totp.begin'(c) {
      slow('totp', c.user);
      keyCheck(); // sec-review: never sealed under a throwaway data key
      if (R.totpOn(c.user)) fail('Two-factor sign-in is already on.');
      const secret = base32(randomBytes(20));
      db.run('INSERT INTO totp (user, pending, created) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET pending = excluded.pending', c.user, R.sealTotp(c.user, secret), Date.now());
      const handle = M.userRow(c.user).handle;
      const uri = `otpauth://totp/${encodeURIComponent(`Snug:${handle}`)}?secret=${secret}&issuer=Snug&algorithm=SHA1&digits=6&period=30`;
      return { secret, uri };
    },
    async 'totp.enable'(c, d) {
      slow('totp', c.user);
      keyCheck(); // sec-review: never sealed under a throwaway data key
      const row = R.totp(c.user);
      if (row?.enabled) fail('Two-factor sign-in is already on.');
      if (!row?.pending) fail('Start again: Snug has no code waiting for you.');
      // The password first: a stolen session alone can't lock the owner out
      // behind an authenticator that isn't theirs.
      await stepUp(c, d, { needCode: false });
      const s = totpMatch(unbase32(row.pending), typeof d.code === 'string' ? d.code.replace(/\s/g, '') : '');
      if (s < 0) { R.stepFail(c.user, 'code', 'totp.enable'); fail('That code isn’t right. Check the time on your phone and type the newest code.'); }
      const codes = makeBackupCodes();
      const r = db.run('UPDATE totp SET secret = pending, pending = NULL, enabled = 1, step = ?, backup = ? WHERE user = ? AND enabled = 0', s, JSON.stringify(codes.map((x) => R.backupHash(c.user, x))), c.user);
      if (!r.changes) fail('Two-factor sign-in is already on.');
      // Whoever else was signed in (perhaps the reason for turning it on) signs in again, with a code.
      const ended = endOthers(c);
      sendAccount(c.user, { totp: true, backupLeft: codes.length }, c.ws);
      audit('totp.enable', c);
      return { codes, ended };
    },
    async 'totp.disable'(c, d) {
      slow('totp', c.user);
      if (!R.totpOn(c.user)) fail('Two-factor sign-in is already off.');
      await stepUp(c, d, { words: { code: 'That code isn’t right.' } });
      db.run('DELETE FROM totp WHERE user = ?', c.user);
      sendAccount(c.user, { totp: false, backupLeft: 0 }, c.ws);
      audit('totp.disable', c);
      return {};
    },
    async 'totp.codes'(c, d) {
      slow('totp', c.user);
      keyCheck(); // sec-review: never sealed under a throwaway data key
      if (!R.totpOn(c.user)) fail('Turn on two-factor sign-in first.');
      await stepUp(c, d, { words: { code: 'That code isn’t right.' } });
      const codes = makeBackupCodes();
      db.run('UPDATE totp SET backup = ? WHERE user = ?', JSON.stringify(codes.map((x) => R.backupHash(c.user, x))), c.user);
      sendAccount(c.user, { backupLeft: codes.length }, c.ws);
      audit('totp.codes', c);
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
const HANDLE = /^[a-z0-9](?:[a-z0-9_.-]{0,22}[a-z0-9])?$/;
// What a sign-in may name: wider than new usernames (older or moved-aside ones, such as name-old2), never an address-like key clash (keys are namespaced).
const LOGIN_HANDLE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const KNOWN = 'snug_known';
const KNOWN_DAYS = 180;

export function createAccountHttp({
  db, M, hub, filesDir, sendJson, error, jsonBody, body, headers, ipOf, secure, authLimit, uploadLimit, log = () => {},
  dataDir = null, keyStore = null, desktop = false,
  dataKey = null, // sec-integrate: the key server/index.js already loaded (one load, one log line)
  logDays = 30, // privacy: how long sign-in history is kept (SNUG_LOG_DAYS)
}) {
  const R = reads(db);
  const C = core(db);
  C.log = log;
  C.keepDays = logDays;
  C.setKey(dataKey || loadDataKey({ dataDir, keyStore, log }));
  // On the desktop (one person, their own PC) a session may sit unused as long as it lasts.
  configureSessions(db, { idleDays: desktop ? SESSION_DAYS : undefined });
  const G = C.guard;
  const tickets = new Map(); // sha256(ticket) -> { user, until, tries }
  const deleteAccountHooks = []; // more of the account to forget, inside the delete's transaction
  const exportLimit = limiter({ capacity: 3, perSecond: 3 / 3600 });
  hub.extraLimits = [...(hub.extraLimits || []), exportLimit];
  const agentOf = (req) => deviceLabel(req.headers['user-agent']);
  const ticketKey = (t) => createHash('sha256').update(String(t)).digest('hex');
  const strip = (row) => M.userView(row, row.presence, true);
  const tokenOf = (req) => readCookie(req.headers.cookie, COOKIE);
  const who = (req, user = null) => ({ user, ip: ipOf(req), agent: agentOf(req) });
  const prunePush = () => { try { db.run('DELETE FROM push_subs WHERE session IS NULL OR session NOT IN (SELECT hash FROM sessions WHERE expires > ?)', Date.now()); } catch { /* push not set up */ } };
  const tooManyRes = (res, ms) => sendJson(res, 429, { error: tooMany(ms) }, { 'Retry-After': String(Math.ceil(ms / 1000)) });

  // The browser that signed in to an account before: an HMAC-signed note of the
  // account and when (OWASP's device cookie). It skips the account-wide sign-in
  // wait, so a stranger guessing at someone's password can't lock them out.
  const deviceMac = (uid, at) => createHmac('sha256', C.keys().device).update(`${uid}.${at}`).digest('base64url').slice(0, 32);
  const knownCookie = (uid) => {
    const at = Date.now();
    return `${KNOWN}=${uid}.${at}.${deviceMac(uid, at)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${KNOWN_DAYS * 86_400}${secure ? '; Secure' : ''}`;
  };
  function knownDevice(req, uid) {
    const v = readCookie(req.headers.cookie, KNOWN);
    const m = /^([\w-]{1,64})\.(\d{1,15})\.([\w-]{32})$/.exec(v || '');
    if (!m || m[1] !== uid || Number(m[2]) < Date.now() - KNOWN_DAYS * 86_400_000) return false;
    const want = Buffer.from(deviceMac(m[1], m[2])), got = Buffer.from(m[3]);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // A new session for someone who just proved who they are: the audit trail, a
  // word to their other devices, and the cookies. `how`: password, totp, register.
  function signedIn(req, user, how) {
    const token = createSession(db, user, agentOf(req));
    const agent = agentOf(req);
    C.audit('login', { ...who(req, user), ok: true, why: how });
    if (how !== 'register') hub.toUser(user, 'account', { newSignIn: { agent: agent || 'Unknown device', at: Date.now() } });
    return { 'Set-Cookie': [sessionCookie(token, { secure }), knownCookie(user)].flat() };
  }
  // GitHub sign-in (server/ghauth.js) makes its own session; it reports here.
  M.onSignIn = (req, user, how) => {
    C.audit('login', { ...who(req, user), ok: true, why: how });
    hub.toUser(user, 'account', { newSignIn: { agent: agentOf(req) || 'Unknown device', at: Date.now() } });
  };
  M.audit = (event, req, user, extra = {}) => C.audit(event, { ...(req ? who(req, user) : { user }), ...extra });

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
  // Null, or { status, message }.
  async function confirm(req, user, d, { handle = false, del = false } = {}) {
    const row = M.userRow(user);
    const typed = String(d.confirm || '').trim().replace(/^@/, '').toLowerCase() === row.handle.toLowerCase();
    // p2p: a GitHub-secured account has no password; typing the username confirms instead (server/ghauth.js).
    if (M.p2pOwner?.(user)) {
      if (!typed) return { status: 401, message: `Type your username, ${row.handle}, to confirm.` };
      // sec-auth AUTH-10: deleting needs GitHub's confirmation, or a sign-in on this session in the last 10 minutes.
      if (del && !M.p2pConfirmed?.(d.flow) && !recentAuth(db, tokenOf(req))) {
        C.audit('account.delete', { ...who(req, user), ok: false, why: 'reauth' });
        return { status: 401, message: 'Confirm on GitHub first (or sign out and back in), then delete.' };
      }
      return null;
    }
    const r = await R.stepUp(user, { password: d.password, code: d.code, token: tokenOf(req), needCode: false });
    if (r) return r;
    if (handle && !typed) return { status: 401, message: `Type your username, ${row.handle}, to confirm.` };
    const c = await R.stepUp(user, { code: d.code, token: tokenOf(req), needPassword: false });
    if (c) return c;
    return null;
  }
  const cookieGone = () => ({ 'Set-Cookie': sessionCookie('', { secure, clear: true }) });

  // ---------- Sign-up, sign-in and sign-out ----------
  async function register(req, res) {
    if (!authLimit.take(`reg:${ipOf(req)}`)) return error(res, 429, 'Too many attempts. Wait a few minutes and try again.');
    const d = await jsonBody(req);
    const handleV = String(d.handle || '').trim().toLowerCase().replace(/^@/, '');
    const name = String(d.name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
    const password = String(d.password || '');
    if (!HANDLE.test(handleV)) return error(res, 400, 'Usernames are 2 to 24 letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.');
    if (!name || name.length > 40) return error(res, 400, 'Your name can be 1 to 40 characters.');
    const weak = passwordProblem(password, { handle: handleV, name });
    if (weak) return error(res, 400, weak);
    const taken = () => db.get('SELECT 1 FROM users WHERE handle = ?', handleV) || M.handleHeld?.(handleV); // held: given up in the last 7 days (server/inbox.js)
    if (taken()) return error(res, 409, `@${handleV} is taken. Try another username.`);
    const pass = await hashPasswordAsync(password);
    const id = newId('u');
    const hue = HUES[Math.floor(Math.random() * HUES.length)][0];
    try {
      if (taken()) throw new Error('taken');
      db.run('INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, ?, ?, ?)', id, handleV, name, pass, hue, Date.now());
    } catch { return error(res, 409, `@${handleV} is taken. Try another username.`); } // the same name, a moment apart
    log('register', handleV);
    return sendJson(res, 201, { user: M.userView(M.userRow(id), 'around') }, signedIn(req, id, 'register'));
  }

  // Sign-in (AUTH-1, 3, 12): per address (in memory), then the account's own
  // counters in SQLite: per account and address (5 free), per account (20 free,
  // skipped by a browser that signed in to it before). Only failures count.
  // Unknown accounts are counted and timed like real ones.
  async function login(req, res) {
    const d = await jsonBody(req);
    const handleV = String(d.handle || '').trim().toLowerCase().replace(/^@/, '');
    const password = typeof d.password === 'string' ? d.password : '';
    const ip = ipOf(req);
    if (!authLimit.take(`login-ip:${ip}`)) { C.audit('login', { ...who(req), ok: false, why: 'locked' }); return error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); }
    const nope = () => error(res, 401, 'That username and password don’t match.');
    if (!LOGIN_HANDLE.test(handleV) || !password || password.length > MAX_PASSWORD) { await burnPasswordCheck(password); C.audit('login', { ...who(req), ok: false, why: 'unknown' }); return nope(); }
    const row = db.get('SELECT * FROM users WHERE handle = ?', handleV);
    const acct = row ? `pw:${row.id}` : `pwh:${handleV}`;
    const pair = `${acct}|${C.addrKey(ip)}`; // privacy: never the address itself
    const wait = Math.max(G.waitMs(pair, POLICIES.pair), row && knownDevice(req, row.id) ? 0 : G.waitMs(acct, POLICIES.password));
    if (wait) { C.audit('login', { ...who(req, row?.id), ok: false, why: 'locked' }); return tooManyRes(res, wait); }
    const v = row ? await verifyPassword(password, row.pass) : { ok: await burnPasswordCheck(password) };
    if (!v.ok) {
      G.fail(acct, POLICIES.password);
      G.fail(pair, POLICIES.pair);
      C.audit('login', { ...who(req, row?.id), ok: false, why: row ? 'password' : 'unknown' });
      return nope();
    }
    G.clear(pair);
    if (v.upgrade) await R.rehash(row.id, password); // once per old hash
    // Two-factor sign-in asks for a code before any session exists.
    const gate = loginGate(row);
    if (gate) { C.audit('login', { ...who(req, row.id), ok: true, why: 'password-then-code' }); return sendJson(res, 200, gate); }
    return sendJson(res, 200, { user: M.userView(row, row.presence, true) }, signedIn(req, row.id, 'password'));
  }

  function logout(req, res) {
    const token = tokenOf(req);
    const user = token ? sessionValid(db, token) : null;
    endSession(db, token);
    if (user) { hub.endToken?.(user, tokenHash(token)); C.audit('logout', who(req, user)); } // AUTH-9: its sockets close too
    prunePush();
    return sendJson(res, 200, {}, cookieGone());
  }

  // A new password (moved here from server/index.js): the current one, a code when two-factor is on, a password that isn't common.
  async function changePassword(req, res, user) {
    if (!authLimit.take(`pw:${user}`)) return error(res, 429, 'Too many attempts. Wait a few minutes and try again.');
    const d = await jsonBody(req);
    const row = M.userRow(user);
    const r = await R.stepUp(user, { password: d.current, token: tokenOf(req), needCode: false });
    if (r) return r.field === 'wait' ? error(res, 429, r.message) : error(res, 401, 'Your current password isn’t right.');
    const next = String(d.next || '');
    const weak = passwordProblem(next, { handle: row.handle, name: row.name, current: String(d.current) });
    if (weak) return error(res, 400, weak);
    const c = await R.stepUp(user, { code: d.code, token: tokenOf(req), needPassword: false });
    if (c) return error(res, c.status, c.field === 'wait' ? c.message : 'Type a code from your authenticator app, or a backup code.');
    db.run('UPDATE users SET pass = ? WHERE id = ?', await hashPasswordAsync(next), user);
    // Every other device has to sign in again with the new password.
    endAllSessions(db, user);
    hub.endSessions(user);
    prunePush(); // this device re-sends its subscription when it reconnects
    C.audit('password.change', who(req, user));
    const fresh = createSession(db, user, agentOf(req));
    return sendJson(res, 200, {}, { 'Set-Cookie': sessionCookie(fresh, { secure }) });
  }

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

  // Failure counters name the account or the handle typed; once it's gone they have no use (privacy).
  function forgetFailures(user, handle) {
    db.run("DELETE FROM auth_failures WHERE key IN (?, ?, ?, ?) OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'",
      `pw:${user}`, `su:${user}`, `code:${user}`, `pwh:${handle}`, `${likeSafe(`pw:${user}`)}|%`, `${likeSafe(`pwh:${handle}`)}|%`);
  }
  function deleteAccount(user, { erase = false } = {}) {
    const c = { user, ws: null };
    const handle = M.userRow(user)?.handle || '';
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
      M.e2eeForget?.(user); // end-to-end encryption keys, backup and their wraps (server/e2ee-conv.js)
      try { db.run('DELETE FROM push_subs WHERE user = ?', user); } catch { /* push not set up */ }
      for (const f of deleteAccountHooks) f(user); // v0.12: passkeys and the recovery key (server/passkeys.js, server/recovery.js)
      endAllSessions(db, user);
      forgetFailures(user, handle);
    });
    hub.endSessions(user);
    // privacy: "erase what I wrote" (server/privacy.js): messages, files, reactions, sign-in and security history.
    if (erase && M.eraseAuthored) M.eraseAuthored(user);
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
    const messages = db.all('SELECT id, conv, ts, text, reply_to, files, edited, enc FROM messages WHERE author = ? AND deleted IS NULL ORDER BY ts', user).map((m) => {
      if (!places.has(m.conv)) places.set(m.conv, where(m.conv));
      // End-to-end encrypted: the server has only the envelope, so that is what is exported (see encryptedNote).
      if (m.enc) return { id: m.id, conv: m.conv, where: places.get(m.conv), at: new Date(m.ts).toISOString(), encrypted: json(m.enc, null) };
      return {
        id: m.id, conv: m.conv, where: places.get(m.conv), at: new Date(m.ts).toISOString(), text: m.text,
        ...(m.reply_to ? { replyTo: m.reply_to } : {}), ...(m.edited ? { edited: new Date(m.edited).toISOString() } : {}),
        ...(m.files ? { files: json(m.files, []).map((f) => f.name || f.id || f) } : {}),
      };
    });
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    // privacy: the whole of every direct conversation I'm in, both sides (and their threads); nobody else's.
    const convMsgs = (conv) => db.all('SELECT id, conv, author, ts, text, reply_to, files, edited FROM messages WHERE (conv = ? OR conv IN (SELECT id FROM threads WHERE conv = ?)) AND deleted IS NULL ORDER BY ts', conv, conv)
      .map((m) => ({
        id: m.id, ...(m.conv !== conv ? { thread: m.conv } : {}), from: handleOf(m.author), at: iso(m.ts), text: m.text,
        ...(m.reply_to ? { replyTo: m.reply_to } : {}), ...(m.edited ? { edited: iso(m.edited) } : {}),
        ...(m.files ? { files: json(m.files, []).map((f) => f.name || f.id || f) } : {}),
      }));
    const dms = db.all('SELECT dm FROM dm_members WHERE user = ?', user).map((r) => ({
      id: r.dm, name: db.get('SELECT name FROM dms WHERE id = ?', r.dm)?.name || null,
      members: db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY rowid', r.dm).map((x) => handleOf(x.user)),
      messages: convMsgs(r.dm),
    }));
    const tryAll = (sql, ...a) => { try { return db.all(sql, ...a); } catch { return []; } }; // tables a module may not have made
    const extra = {
      signIns: tryAll('SELECT ts, event, ok, ip, agent, why FROM auth_events WHERE user = ? ORDER BY ts DESC', user)
        .map((e) => ({ at: iso(e.ts), event: e.event, ok: !!e.ok, address: e.ip, device: e.agent, ...(e.why ? { why: e.why } : {}) })),
      securityEvents: tryAll('SELECT ts, kind, ip, agent, detail FROM security_events WHERE user = ? ORDER BY ts DESC', user)
        .map((e) => ({ at: iso(e.ts), kind: e.kind, address: e.ip, device: e.agent, detail: json(e.detail, {}) })),
      reactions: tryAll('SELECT msg, emoji, ts FROM reactions WHERE user = ? ORDER BY ts', user).map((r) => ({ message: r.msg, emoji: r.emoji, at: iso(r.ts) })),
      pollVotes: tryAll('SELECT msg, answer, ts FROM poll_votes WHERE user = ? ORDER BY ts', user).map((r) => ({ poll: r.msg, answer: r.answer, at: iso(r.ts) })),
      scheduled: tryAll('SELECT conv, text, at, created FROM scheduled WHERE user = ? ORDER BY at', user).map((r) => ({ conv: r.conv, where: where(r.conv), text: r.text, at: iso(r.at), made: iso(r.created) })),
      pushDevices: tryAll('SELECT created FROM push_subs WHERE user = ?', user).map((r) => ({ added: iso(r.created) })),
      files: tryAll('SELECT id, conv, name, type, size, created FROM files WHERE owner = ? ORDER BY created', user)
        .map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, added: iso(f.created), where: /^[a-z]+:/.test(f.conv) && !f.conv.startsWith('t:') ? f.conv.split(':')[0] : where(f.conv) })),
    };
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
      ...(messages.some((m) => m.encrypted) ? { encryptedNote: 'Messages in end-to-end encrypted conversations are exported as this server stores them: encrypted envelopes. The server can’t read them, so it can’t export their text; your devices can.' } : {}),
      ...extra,
    };
  }

  // privacy: the same data as one zip: snug-data.json, a readable messages.txt,
  // README.txt, and the files I uploaded under files/. Written entry by entry.
  async function exportZip(res, user) {
    const data = exportFor(user);
    headers(res, {
      'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="snug-${data.account.handle}-${new Date().toISOString().slice(0, 10)}.zip"`,
    });
    res.writeHead(200);
    const write = (buf) => new Promise((resolve, reject) => {
      if (res.destroyed) { reject(new Error('gone')); return; }
      if (res.write(buf)) resolve(); else res.once('drain', resolve);
    });
    const z = zipWriter(write);
    try {
      await z.add('README.txt', exportReadme(data));
      await z.add('snug-data.json', JSON.stringify(data, null, 2));
      await z.add('messages.txt', exportText(data));
      const MAX = 1024 * 1024 * 1024; // 1 GB of files; the list in snug-data.json names every one either way
      let total = 0;
      for (const f of data.files) {
        if (total + f.size > MAX) break;
        const bytes = await readAll(join(filesDir, f.id));
        if (!bytes) continue; // gone from the files folder
        total += bytes.length;
        await z.add(`files/${f.id}-${f.name.replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'file'}`, bytes, new Date(f.added));
      }
      await z.end();
      res.end();
    } catch { try { res.destroy(); } catch { /* gone */ } }
  }
  const readAll = (path) => new Promise((resolve) => {
    const chunks = [];
    createReadStream(path).on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', () => resolve(null));
  });
  const exportReadme = (d) => [
    `Your Snug data, as of ${d.exported}.`,
    '',
    'snug-data.json  Everything below in one file a program can read: your profile, settings,',
    '                notes, friends, houses, every message you wrote, the whole of each direct',
    '                conversation you are in, your reactions and poll votes, scheduled messages,',
    '                sign-in history (addresses shortened, as stored), security events and devices.',
    'messages.txt    The same messages, to read: your messages in houses, and your direct conversations.',
    'files/          The files you uploaded (pictures, documents, voice messages).',
    '',
    'Other people\'s messages in houses are not included: they are theirs. Messages in your',
    'direct conversations are included because you are in them.',
  ].join('\n');
  function exportText(d) {
    const out = [];
    const line = (m, who) => `${m.at.slice(0, 16).replace('T', ' ')}  ${who}: ${m.text}${m.files ? ` [files: ${m.files.join(', ')}]` : ''}`;
    const byPlace = new Map();
    for (const m of d.messages) { if (!byPlace.has(m.where)) byPlace.set(m.where, []); byPlace.get(m.where).push(m); }
    for (const [place, list] of byPlace) {
      if (place === 'direct conversation' || place === 'thread in a direct conversation') continue; // below, with both sides
      out.push(`== ${place} (your messages) ==`, ...list.map((m) => line(m, d.account.handle)), '');
    }
    for (const c of d.conversations) {
      out.push(`== ${c.name || c.members.join(', ')} (direct conversation) ==`, ...c.messages.map((m) => line(m, m.from)), '');
    }
    return out.join('\n');
  }

  // Routes that need no session: the second step of signing in.
  async function open(req, res, path) {
    if (req.method !== 'POST') return false;
    if (path === '/api/register') { await register(req, res); return true; }
    if (path === '/api/login') { await login(req, res); return true; }
    if (path === '/api/logout') { logout(req, res); return true; }
    if (path !== '/api/login/totp') return false;
    if (!authLimit.take(`totp:${ipOf(req)}`)) { error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
    const d = await jsonBody(req);
    const key = ticketKey(d.ticket || '');
    const t = tickets.get(key);
    if (!t || t.until < Date.now()) { tickets.delete(key); error(res, 401, 'That sign-in took too long. Start again with your password.'); return true; }
    if (++t.tries > 5) { tickets.delete(key); C.audit('login.code', { ...who(req, t.user), ok: false, why: 'ticket' }); error(res, 429, 'Too many wrong codes. Start again with your password.'); return true; }
    // And per account, whatever the address and however many tickets: someone
    // with the password and many addresses gets ten guesses, then waits that
    // grow from 15 minutes (kept in SQLite, so a restart doesn't reset them).
    const wait = G.waitMs(`code:${t.user}`, POLICIES.code);
    if (wait) { C.audit('login.code', { ...who(req, t.user), ok: false, why: 'locked' }); error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
    if (!R.verifySecond(t.user, String(d.code || ''))) {
      G.fail(`code:${t.user}`, POLICIES.code);
      C.audit('login.code', { ...who(req, t.user), ok: false, why: 'code' });
      error(res, 401, 'That code isn’t right. Type the newest code from your app, or a backup code.');
      return true;
    }
    tickets.delete(key);
    G.clear(`code:${t.user}`);
    reactivate(t.user);
    sendJson(res, 200, { user: strip(M.userRow(t.user)) }, signedIn(req, t.user, 'totp'));
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
    if (req.method === 'GET' && path === '/api/account/export.zip') {
      if (!exportLimit.take(user)) { error(res, 429, 'You can download your data three times an hour. Try again later.'); return true; }
      await exportZip(res, user);
      return true;
    }
    if (post && path === '/api/password') { await changePassword(req, res, user); return true; } // sec-auth: from server/index.js
    if (post && (path === '/api/account/delete' || path === '/api/account/deactivate')) {
      if (!authLimit.take(`acct:${user}`)) { error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
      const d = await jsonBody(req);
      const del = path === '/api/account/delete';
      const why = await confirm(req, user, d, { handle: del, del });
      if (why) { error(res, why.status === 429 ? 429 : 401, why.message); return true; }
      C.audit(del ? 'account.delete' : 'account.deactivate', who(req, user));
      if (del) {
        const owned = soleOwnerOf(user);
        if (owned.length) { error(res, 409, `You’re the only owner of ${owned.join(', ')}. Give someone else the owner role first, or remove everyone else.`); return true; }
        // p2p: friends on other PCs hear it first; the username is freed after a fresh GitHub check (server/ghauth.js).
        const erase = d.erase === true; // privacy: erase what I wrote, or keep it by "Deleted user"
        if (M.p2pOwner?.(user)) { const r = await M.p2pDelete(user, d, () => deleteAccount(user, { erase })); sendJson(res, 200, { released: r.released }, cookieGone()); return true; }
        deleteAccount(user, { erase });
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
      sendFile(res, join(filesDir, row.id)); // sec-web W1: 404 when the bytes are gone, never an unhandled stream error (server/seclog.js)
      return true;
    }
    return false;
  }

  return {
    open, authed, loginGate, agentOf, totpOn: R.totpOn, verifySecond: R.verifySecond, audit: M.audit,
    // v0.12: passkey sign-in and account recovery (server/passkeys.js, server/recovery.js) make sessions the same way.
    signIn: signedIn, reactivate, strip, guard: G, prunePush, deleteAccountHooks,
    // Tests: forget every rate limit, the failure counters included.
    reset: () => { exportLimit.reset(); G.reset(); C.windows.clear(); },
    prune: () => C.prune(), // privacy: tests run the sign-in history sweep
  };
}
