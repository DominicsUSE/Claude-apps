// Accounts and sessions.
// Passwords: scrypt (OWASP cost: N=2^15, r=8, p=3) with a random salt per
// user, run on libuv's thread pool (never on the event loop) a few at a time,
// compared in constant time. The stored form names its own cost
// (scrypt$v2$N$r$p$salt$key), so it can be raised later; 0.10.1 hashes
// (scrypt$salt$key, N=2^14) still verify and are rewritten at the next sign-in.
// Sessions: a random 256-bit token in an HttpOnly cookie; the database only
// stores its SHA-256, so a leaked database does not leak live sessions.
// Sessions end after 30 days, or after 14 days unused (sec-auth AUTH-13).
import { scrypt, scryptSync, randomBytes, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { isIP } from 'node:net';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCRYPT = { N: 32768, r: 8, p: 3 };
const LEGACY = { N: 16384, r: 8, p: 1 };
const maxmem = ({ N, r }) => 256 * N * r + 1024 * 1024; // twice what scrypt needs
export const SESSION_DAYS = 30;
export const IDLE_DAYS = 14;
export const COOKIE = 'snug_session';
// Over HTTPS the cookie is __Host-snug_session: Secure, Path=/, no Domain, so no
// sibling subdomain or plain-HTTP attacker can set one (cookie tossing).
export const HOST_COOKIE = `__Host-${COOKIE}`;

// ---------- Passwords ----------
// Passwords are at most 200 characters (sign-up and change refuse longer ones).
export const MAX_PASSWORD = 200;
const encode = (prm, salt, key) => `scrypt$v2$${prm.N}$${prm.r}$${prm.p}$${salt.toString('base64')}$${key.toString('base64')}`;
// What a stored hash says about itself, or null when it is not a usable hash
// ('!' for accounts with no password). Parameters out of a sane range are
// refused, so a tampered row can't make one check eat the machine.
function parse(stored) {
  const f = String(stored ?? '').split('$');
  if (f[0] !== 'scrypt') return null;
  let prm, salt, key;
  if (f.length === 3) { prm = LEGACY; [, salt, key] = f; }
  else if (f.length === 7 && f[1] === 'v2') {
    prm = { N: Number(f[2]), r: Number(f[3]), p: Number(f[4]) };
    [, , , , , salt, key] = f;
    const pow2 = Number.isInteger(prm.N) && prm.N >= 1024 && prm.N <= 2 ** 20 && (prm.N & (prm.N - 1)) === 0;
    if (!pow2 || !Number.isInteger(prm.r) || prm.r < 1 || prm.r > 32 || !Number.isInteger(prm.p) || prm.p < 1 || prm.p > 16) return null;
  } else return null;
  if (!salt || !key) return null;
  const s = Buffer.from(salt, 'base64'), k = Buffer.from(key, 'base64');
  if (s.length < 8 || k.length < 16 || k.length > 64) return null;
  return { prm, salt: s, key: k, current: f.length === 7 && prm.N * prm.p >= SCRYPT.N * SCRYPT.p && prm.r >= SCRYPT.r };
}

// At most two hashes at once (each needs 32 MiB), and a bounded queue: a flood
// of sign-ins waits its turn instead of starving the thread pool or memory.
const POOL = { busy: 0, max: 2, queue: [], maxQueue: 256 };
function scryptAsync(password, salt, len, prm) {
  return new Promise((resolve, reject) => {
    const run = () => {
      POOL.busy++;
      scrypt(String(password), salt, len, { ...prm, maxmem: maxmem(prm) }, (e, key) => {
        POOL.busy--;
        const next = POOL.queue.shift();
        if (next) next();
        if (e) reject(e); else resolve(key);
      });
    };
    if (POOL.busy < POOL.max) run();
    else if (POOL.queue.length >= POOL.maxQueue) reject(Object.assign(new Error('busy'), { status: 503 }));
    else POOL.queue.push(run);
  });
}

// Synchronous: only for scripts (npm run seed) and test fixtures.
export function hashPassword(password) {
  const salt = randomBytes(16);
  return encode(SCRYPT, salt, scryptSync(String(password), salt, 32, { ...SCRYPT, maxmem: maxmem(SCRYPT) }));
}
export async function hashPasswordAsync(password) {
  const salt = randomBytes(16);
  return encode(SCRYPT, salt, await scryptAsync(password, salt, 32, SCRYPT));
}
// { ok, upgrade }: upgrade means the stored hash is older or cheaper than today's and
// should be replaced (with hashPasswordAsync of the same password) now that it matched.
// A row with no usable hash still costs one full check, so timing does not tell
// password-less accounts (friends on other PCs, bots, deleted) from unknown ones.
export async function verifyPassword(password, stored) {
  const h = parse(stored);
  if (!h || typeof password !== 'string' || password.length > MAX_PASSWORD) { await burnPasswordCheck(password); return { ok: false, upgrade: false }; }
  const got = await scryptAsync(password, h.salt, h.key.length, h.prm);
  const ok = timingSafeEqual(h.key, got);
  return { ok, upgrade: ok && !h.current };
}
// Synchronous and slow (it blocks the event loop): kept for scripts. The server uses verifyPassword.
export function checkPassword(password, stored) {
  const h = parse(stored);
  if (!h) return false;
  return timingSafeEqual(h.key, scryptSync(String(password), h.salt, h.key.length, { ...h.prm, maxmem: maxmem(h.prm) }));
}
// The same work for unknown accounts, so response time does not reveal which handles exist.
export async function burnPasswordCheck(password) {
  await scryptAsync(typeof password === 'string' ? password.slice(0, MAX_PASSWORD) : '', randomBytes(16), 32, SCRYPT);
  return false;
}

// Passwords people actually use (NIST SP 800-63B 5.1.1.2): at least 8
// characters, at most 200, anything allowed, but not one of the most common
// passwords (the top of SecLists' xato-net 10-million list, MIT licence,
// server/common-passwords.txt) and not the username or name.
let COMMON = null;
const commonSet = () => {
  if (!COMMON) {
    try { COMMON = new Set(readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter((s) => s && !s.startsWith('# '))); } catch { COMMON = new Set(); }
  }
  return COMMON;
};
export function passwordProblem(password, { handle = '', name = '', current = null } = {}) {
  if (typeof password !== 'string' || password.length < 8 || password.length > MAX_PASSWORD) return 'Passwords need at least 8 characters.';
  const low = password.toLowerCase();
  const squash = low.replace(/[^a-z0-9]/g, '');
  if (commonSet().has(low) || /^(.)\1+$/.test(low) || '01234567890123456789'.includes(low) || 'abcdefghijklmnopqrstuvwxyz'.includes(low)) return 'That password is one of the most common ones. Pick something harder to guess, like a few unrelated words.';
  for (const w of [handle, name]) {
    const x = String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (x.length >= 3 && squash.includes(x)) return 'Your password can’t contain your username or name.';
  }
  if (current != null && password === current) return 'That’s your current password. Pick a new one.';
  return null;
}

// ---------- Sessions ----------
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
// Per database: how long a session may go unused (index.js sets a longer one on the desktop).
const POLICY = new WeakMap();
export const configureSessions = (db, { idleDays = IDLE_DAYS } = {}) => POLICY.set(db, { idleMs: idleDays * 86_400_000 });
export const idleMs = (db) => POLICY.get(db)?.idleMs ?? IDLE_DAYS * 86_400_000;

export function createSession(db, userId, agent = '', how = null) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  // agent and seen: the device list in Settings > Account (server/account.js).
  // auth_at: when this person last proved who they are on this session (password, code or GitHub).
  // how: how the session began ('register', 'password', 'recovery', ...; v0.12 review M5, server/recovery.js).
  db.run('INSERT INTO sessions (hash, user, created, expires, agent, seen, auth_at, how) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    tokenHash(token), userId, now, now + SESSION_DAYS * 86_400_000, String(agent).slice(0, 80), now, now, how);
  return token;
}
/** How this session began (createSession `how`), or null. */
export function sessionHow(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  return db.get('SELECT how FROM sessions WHERE hash = ?', tokenHash(token))?.how ?? null;
}

function liveRow(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const row = db.get('SELECT user, expires, seen, created FROM sessions WHERE hash = ?', tokenHash(token));
  if (!row) return null;
  const now = Date.now();
  if (row.expires < now || (row.seen || row.created) < now - idleMs(db)) { db.run('DELETE FROM sessions WHERE hash = ?', tokenHash(token)); return null; }
  return row;
}
export function sessionUser(db, token) {
  const row = liveRow(db, token);
  if (!row) return null;
  // When this device was last used, to the minute (server/account.js).
  if (!row.seen || row.seen < Date.now() - 60_000) db.run('UPDATE sessions SET seen = ? WHERE hash = ?', Date.now(), tokenHash(token));
  return row.user;
}
// The same check without counting as use: for the socket heartbeat (server/hub.js).
export const sessionValid = (db, token) => liveRow(db, token)?.user || null;
// Signed in (or confirmed with a password, code or GitHub) on this session within `ms`.
export function recentAuth(db, token, ms = 10 * 60_000) {
  if (!token || typeof token !== 'string' || token.length > 100) return false;
  const row = db.get('SELECT auth_at FROM sessions WHERE hash = ?', tokenHash(token));
  return !!row?.auth_at && row.auth_at > Date.now() - ms;
}
export const markAuth = (db, token) => token && db.run('UPDATE sessions SET auth_at = ? WHERE hash = ?', Date.now(), tokenHash(token));

export const endSession = (db, token) => token && db.run('DELETE FROM sessions WHERE hash = ?', tokenHash(token));
export const endAllSessions = (db, userId) => db.run('DELETE FROM sessions WHERE user = ?', userId);

// Percent-decoding that never throws: a malformed header or address is kept as
// it came instead of failing the request (or, outside a try, the server).
export const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

// One value per name. Two cookies with the same name (cookie tossing from a
// sibling subdomain) count as none. For the session cookie, __Host-snug_session
// wins over the old snug_session name (0.10.1 and plain-HTTP servers).
export function readCookie(header, name) {
  const values = (n) => {
    const out = [];
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === n) out.push(safeDecode(part.slice(i + 1).trim()));
    }
    return out;
  };
  if (name === COOKIE) {
    const host = values(HOST_COOKIE);
    if (host.length) return host.length === 1 ? host[0] : null;
  }
  const v = values(name);
  return v.length === 1 ? v[0] : null;
}

export function sessionCookie(token, { secure, clear } = {}) {
  const make = (name) => {
    const parts = [`${name}=${clear ? '' : encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${clear ? 0 : SESSION_DAYS * 86_400}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  };
  if (!secure) return make(COOKIE);
  // Signing out over HTTPS clears both names.
  return clear ? [make(HOST_COOKIE), make(COOKIE)] : make(HOST_COOKIE);
}
// Behind an HTTPS proxy without SNUG_SECURE: every session cookie this response
// sets becomes the Secure __Host- one (server/index.js, per request).
export function secureCookies(res) {
  const set = res.setHeader.bind(res);
  res.setHeader = (k, v) => {
    if (String(k).toLowerCase() !== 'set-cookie') return set(k, v);
    const out = [];
    for (const c of [v].flat()) {
      const s = String(c);
      if (!s.startsWith(`${COOKIE}=`)) { out.push(s); continue; }
      const sec = /;\s*Secure/i.test(s) ? s : `${s}; Secure`;
      out.push(`__Host-${sec}`);
      if (/Max-Age=0/.test(s)) out.push(sec);
    }
    return set(k, out.length === 1 ? out[0] : out);
  };
}

// ---------- Client addresses ----------
// Plain IPv4 for IPv4-mapped IPv6, no brackets, no port; '' when it isn't an address.
export function normIp(v) {
  let s = String(v || '').trim().toLowerCase();
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  if (s.startsWith('::ffff:') && isIP(s.slice(7)) === 4) s = s.slice(7);
  const pct = s.indexOf('%');
  if (pct > 0) s = s.slice(0, pct);
  return isIP(s) ? s : '';
}
function v6Groups(ip) {
  let s = ip;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s); // an IPv4 tail, as in 64:ff9b::1.2.3.4
  if (m) { const [a, b, c, d] = m[1].split('.').map(Number); s = `${s.slice(0, -m[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = s.split('::');
  const H = head ? head.split(':') : [];
  const T = tail === undefined ? [] : (tail ? tail.split(':') : []);
  const mid = tail === undefined ? [] : Array(Math.max(0, 8 - H.length - T.length)).fill('0');
  return [...H, ...mid, ...T].map((g) => g.padStart(4, '0'));
}
export function isPrivateIp(ip) {
  const s = normIp(ip);
  if (isIP(s) === 4) {
    const [a, b] = s.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(s) === 6) {
    const g = v6Groups(s);
    const first = parseInt(g[0], 16);
    return s === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}
// The client's address. With `hops` proxies in front (SNUG_TRUST_PROXY=<hops>), the
// entry each proxy appended counts from the right of X-Forwarded-For; entries further
// left are whatever the client sent. The header is believed only from a loopback or
// private peer (the proxy itself); anyone else gets their socket address.
export function clientIp(req, hops) {
  const remote = normIp(req.socket?.remoteAddress) || String(req.socket?.remoteAddress || '');
  const n = hops === true ? 1 : Math.max(0, Math.floor(Number(hops) || 0));
  if (!n || !isPrivateIp(remote)) return remote;
  const list = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return remote;
  return normIp(list[Math.max(0, list.length - n)]) || remote;
}
// The key a per-address limit uses: an IPv4 address, or the /64 of an IPv6 one
// (one subscriber usually gets a whole /64).
export function ipKey(ip) {
  const s = normIp(ip);
  if (isIP(s) !== 6) return s || String(ip || '');
  return `${v6Groups(s).slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
// For logs and the sign-in list: never a whole address.
export function maskIp(ip) {
  const s = normIp(ip);
  if (isIP(s) === 4) return s.replace(/\.\d+$/, '.x');
  if (isIP(s) === 6) return `${v6Groups(s).slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/48`;
  return '';
}

// ---------- Rate limits ----------
// Token buckets keyed by anything: an IP, a user, a user plus an action.
// Never cleared in bulk (that would hand every drained bucket a refill):
// past `max` keys, full buckets go first (a full bucket is the same as none),
// then the fullest, so drained ones are the last to be forgotten.
export function limiter({ capacity, perSecond, max = 50_000 }) {
  const buckets = new Map();
  const level = (b, now) => Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSecond);
  function prune(now) {
    for (const [k, b] of buckets) if (level(b, now) >= capacity) buckets.delete(k);
    const keep = Math.floor(max * 0.9);
    if (buckets.size <= keep) return;
    const byLevel = [...buckets].map(([k, b]) => [k, level(b, now)]).sort((x, y) => y[1] - x[1]);
    for (let i = 0; buckets.size > keep && i < byLevel.length; i++) buckets.delete(byLevel[i][0]);
  }
  return {
    reset: () => buckets.clear(),
    size: () => buckets.size,
    take(key, cost = 1) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= max) prune(now);
        b = { tokens: capacity, at: now };
        buckets.set(key, b);
      }
      b.tokens = level(b, now);
      b.at = now;
      if (b.tokens < cost) return false;
      b.tokens -= cost;
      return true;
    },
  };
}

// Failure counters that outlive restarts and floods (SQLite): per account, per
// account and address, per second factor. After `free` failures each further one
// waits twice as long as the last (baseMs, 2x, 4x... up to maxMs); a key with no
// failure for forgetMs starts again from zero.
export const POLICIES = {
  password: { free: 20, baseMs: 60_000, maxMs: 30 * 60_000, forgetMs: 86_400_000 },   // per account, every address
  pair: { free: 5, baseMs: 60_000, maxMs: 15 * 60_000, forgetMs: 3_600_000 },          // per account and address
  code: { free: 10, baseMs: 15 * 60_000, maxMs: 4 * 3_600_000, forgetMs: 86_400_000 },  // second factor
  stepUp: { free: 5, baseMs: 60_000, maxMs: 30 * 60_000, forgetMs: 86_400_000 },       // a signed-in session re-entering its password or code
  recover: { free: 5, baseMs: 15 * 60_000, maxMs: 4 * 3_600_000, forgetMs: 86_400_000 }, // v0.12: recovery keys tried for one account (server/recovery.js)
};
export function createAuthGuard(db) {
  (db.raw ?? db).exec('CREATE TABLE IF NOT EXISTS auth_failures (key TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL)');
  const until = (row, p) => (row && row.count >= p.free ? row.last + Math.min(p.maxMs, p.baseMs * 2 ** Math.min(30, row.count - p.free)) : 0);
  const fresh = (row, p, now) => (row && row.last > now - p.forgetMs ? row : null);
  const g = {
    // Milliseconds to wait before this key may try again (0: go ahead).
    waitMs(key, p) {
      const now = Date.now();
      const row = fresh(db.get('SELECT count, last FROM auth_failures WHERE key = ?', key), p, now);
      return Math.max(0, until(row, p) - now);
    },
    fail(key, p) {
      const now = Date.now();
      const row = fresh(db.get('SELECT count, last FROM auth_failures WHERE key = ?', key), p, now);
      const count = (row?.count || 0) + 1;
      db.run('INSERT INTO auth_failures (key, count, last) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET count = excluded.count, last = excluded.last', key, count, now);
      return count;
    },
    count: (key) => db.get('SELECT count FROM auth_failures WHERE key = ?', key)?.count || 0,
    clear: (key) => db.run('DELETE FROM auth_failures WHERE key = ?', key),
    reset: () => db.run('DELETE FROM auth_failures'),
    prune: () => db.run('DELETE FROM auth_failures WHERE last < ?', Date.now() - 2 * 86_400_000),
  };
  return g;
}

// ---------- The data key: secrets kept outside the database ----------
// 32 random bytes in <dataDir>/secret.key (mode 0600; wrapped with the OS key
// store on the desktop), or SNUG_DATA_KEY (base64 or hex). It encrypts the
// two-factor secrets and keys the backup-code hashes (server/account.js), so a
// copy of snug.db alone can't produce codes. Back it up apart from the database:
// without it, two-factor sign-in can't be checked.
export function loadDataKey({ dataDir, keyStore = null, env = process.env, log = () => {} } = {}) {
  const fromEnv = String(env.SNUG_DATA_KEY || '').trim();
  if (fromEnv) {
    const k = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, 'hex') : Buffer.from(fromEnv, 'base64');
    if (k.length === 32) return k;
    log('security', 'SNUG_DATA_KEY must be 32 bytes (base64 or hex); using the key file instead');
  }
  if (!dataDir || dataDir === ':memory:') return randomBytes(32);
  const file = join(dataDir, 'secret.key');
  const canWrap = () => { try { return !!keyStore?.available?.(); } catch { return false; } };
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      const b64 = j.enc === 'safeStorage' ? keyStore.decrypt(j.blob) : j.blob;
      const k = Buffer.from(String(b64), 'base64');
      if (j.v === 1 && k.length === 32) return k;
      throw new Error('bad key file');
    } catch (e) {
      // Never replace an unreadable key: that would make every stored secret unreadable for good.
      log('security', 'secret.key could not be read; two-factor codes will not verify until it is restored', e.message);
      // sec-integrate: marked, so nothing is ever written under this throwaway key (server/index.js skips the
      // database snapshots: seven of them would otherwise replace every good one with unreadable files).
      return Object.assign(randomBytes(32), { unusable: true });
    }
  }
  const k = randomBytes(32);
  let enc = 'none', blob = k.toString('base64');
  if (canWrap()) { try { blob = keyStore.encrypt(blob); enc = 'safeStorage'; } catch { enc = 'none'; blob = k.toString('base64'); } }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, enc, blob, created: Date.now() }), { mode: 0o600 });
  renameSync(tmp, file);
  return k;
}
export const subKey = (key, purpose) => createHmac('sha256', key).update(`snug:${purpose}`).digest();
// AES-256-GCM, bound to `context` (for example the account it belongs to): "v1:" + base64url(iv | tag | ciphertext).
export function seal(key, context, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(context)));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}
export const isSealed = (v) => typeof v === 'string' && v.startsWith('v1:');
// The plain text, or null when it was not sealed with this key and context.
export function unseal(key, context, v) {
  if (!isSealed(v)) return null;
  try {
    const b = Buffer.from(v.slice(3), 'base64url');
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12), { authTagLength: 16 }); // sec-web: a cut-short tag is refused, never checked as a short one
    d.setAAD(Buffer.from(String(context)));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}
