// Accounts and sessions.
// Passwords: scrypt with a random salt per user, compared in constant time.
// Sessions: a random 256-bit token in an HttpOnly cookie; the database only
// stores its SHA-256, so a leaked database does not leak live sessions.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 30;
export const COOKIE = 'snug_session';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function checkPassword(password, stored) {
  const [kind, salt, key] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, SCRYPT);
  return timingSafeEqual(want, got);
}

// Run the same work for unknown accounts, so response time does not reveal
// which handles exist.
const DUMMY = hashPassword(randomBytes(12).toString('hex'));
export const burnPasswordCheck = (password) => { checkPassword(password, DUMMY); return false; };

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function createSession(db, userId, agent = '') {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  // agent and seen: the device list in Settings > Account (server/account.js).
  db.run('INSERT INTO sessions (hash, user, created, expires, agent, seen) VALUES (?, ?, ?, ?, ?, ?)',
    tokenHash(token), userId, now, now + SESSION_DAYS * 86_400_000, String(agent).slice(0, 80), now);
  return token;
}

export function sessionUser(db, token) {
  if (!token || token.length > 100) return null;
  const row = db.get('SELECT user, expires, seen FROM sessions WHERE hash = ?', tokenHash(token));
  if (!row) return null;
  if (row.expires < Date.now()) { db.run('DELETE FROM sessions WHERE hash = ?', tokenHash(token)); return null; }
  // When this device was last used, to the minute (server/account.js).
  if (!row.seen || row.seen < Date.now() - 60_000) db.run('UPDATE sessions SET seen = ? WHERE hash = ?', Date.now(), tokenHash(token));
  return row.user;
}

export const endSession = (db, token) => token && db.run('DELETE FROM sessions WHERE hash = ?', tokenHash(token));
export const endAllSessions = (db, userId) => db.run('DELETE FROM sessions WHERE user = ?', userId);

// Percent-decoding that never throws: a malformed header or address is kept as
// it came instead of failing the request (or, outside a try, the server).
export const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return safeDecode(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, { secure, clear } = {}) {
  const parts = [`${COOKIE}=${clear ? '' : encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${clear ? 0 : SESSION_DAYS * 86_400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Token buckets keyed by anything: an IP, a user, a user plus an action.
export function limiter({ capacity, perSecond }) {
  const buckets = new Map();
  return {
    reset: () => buckets.clear(),
    take(key, cost = 1) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
      b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSecond);
      b.at = now;
      if (b.tokens < cost) return false;
      b.tokens -= cost;
      if (buckets.size > 50_000) buckets.clear();
      return true;
    },
  };
}
