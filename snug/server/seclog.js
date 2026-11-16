// Security events, suspicious-activity alerts and log redaction (sec-web W4, W5),
// and one safe way to send a stored file (W1).
//
// - security_events: one row per event that matters for an account or for
//   spotting an attack (a refused cross-site request, a refused Host, a rate
//   limit hit, an alert). Never a password, code, token or cookie: addresses
//   are truncated (1.2.3.x, 2001:db8:1::/48), the browser string is cut to 80
//   characters and details are redacted. Rows go after 14 days (SNUG_LOG_DAYS), and each
//   account keeps at most 500. Sign-ins and account changes are kept by the
//   auth layer (auth_events, server/account.js); its events come here too, so
//   the detectors see them and the owner sees one list.
// - Detectors keep short windows in memory and write one `alert` row and one
//   log line per burst per hour: many failed sign-ins for one account or from
//   one address, a sign-in from a new device right after such a burst, many
//   rate-limited or refused requests from one address.
// - redact() makes any value safe for a log line: webhook tokens, bearer
//   tokens, cookies, `token=`-style values and JSON secrets are masked, control
//   characters are escaped (so a %0A in an address can't forge a line), and it
//   is cut to a sane length. redactLog() wraps a logger so every caller gets it.
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { maskIp, limiter } from './auth.js';
import { deviceLabel } from '../js/lib/account.js'; // 0.14: the kind of device, not the browser's full string

// ---------- Redaction ----------
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const esc = (c) => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const SECRET_KEYS = 'password|passwd|pwd|pass|token|access_token|refresh_token|id_token|secret|client_secret|api[_-]?key|apikey|key|code|ticket|session|sig|signature|auth|totp|otp|backup|cookie|authorization|resume';
const RULES = [
  [/(\/api\/hooks\/[^/\s?#]+\/)[^\s?#"'<>]+/g, '$1***'],                                  // webhook address tokens
  [/\b(bearer|basic|token|bot)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1$2***'],                    // Authorization schemes
  [/\b((?:set-)?cookie|authorization|x-api-key)(\s*:\s*)[^\n]*/gi, '$1$2***'],              // whole header values
  [/((?:__Host-)?snug_[a-z]+=)[^;\s"',]+/gi, '$1***'],                                       // our cookies wherever they appear
  [new RegExp(`\\b(${SECRET_KEYS})=([^&\\s"';,]+)`, 'gi'), '$1=***'],                        // query strings, form bodies
  [new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"***"'],    // JSON
  [/\bscrypt\$[^\s"']+/g, 'scrypt$***'],                                                    // password hashes
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
];
function text(v) {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}
export function redact(v, max = 2000) {
  let s = text(v);
  if (s.length > max * 4) s = s.slice(0, max * 4); // bound the work before the patterns run
  for (const [re, to] of RULES) s = s.replace(re, to);
  s = s.replace(CTRL, esc);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
// A logger whose every argument is redacted (numbers and booleans pass through).
export const redactLog = (fn) => (...a) => fn(...a.map((x) => (typeof x === 'number' || typeof x === 'boolean' ? x : redact(x))));

// ---------- Events and detectors ----------
const DAY = 86_400_000;
const KEEP_DAYS = 14; // privacy: 90 before 0.12, 30 before 0.14; the server owner sets it with SNUG_LOG_DAYS (server/privacy.js)
const PER_USER = 500;
const ANON_ROWS = 20_000;
// Kinds an attacker can make a lot of: stored at most 10 a minute per address and kind.
const NOISY = new Set(['ratelimit.hit', 'origin.refused', 'host.refused', 'file.missing', 'csp.violation', 'socket.evicted', 'access.refused', 'filter.blocked']); // sec-integrate: the last three
const AUTH_FAIL = new Set(['login', 'login.code', 'stepup', 'totp', 'github.link']);
const INSTANCES = new WeakMap(); // db -> seclog, for modules that only hold the db (server/account.js)

function windows() {
  const w = new Map();
  return {
    // Count one hit for `key` and return how many fell in the last `ms`.
    hit(key, ms, now) {
      let a = w.get(key);
      if (!a) { a = []; w.set(key, a); }
      a.push(now);
      while (a.length && a[0] < now - ms) a.shift();
      if (a.length > 1000) a.splice(0, a.length - 1000);
      if (w.size > 20_000) for (const [k, v] of w) if (!v.length || v[v.length - 1] < now - 3_600_000) w.delete(k);
      return a.length;
    },
    count(key, ms, now) { const a = w.get(key) || []; return a.filter((t) => t >= now - ms).length; },
  };
}

export function createSeclog({ db, log = () => {}, ipOf = (req) => req?.socket?.remoteAddress || '', now = () => Date.now(), keepDays = KEEP_DAYS }) {
  const KEEP_MS = keepDays * DAY;
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user TEXT,
      kind TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS security_events_user ON security_events(user, ts);
    CREATE INDEX IF NOT EXISTS security_events_ts ON security_events(ts);
  `);
  const store = limiter({ capacity: 10, perSecond: 10 / 60 });
  const storeAll = limiter({ capacity: 300, perSecond: 20 });
  const win = windows();
  const told = new Map(); // alert key -> when it was last raised

  function insert(kind, { user = null, ip = '', agent = '', detail = null }) {
    const d = detail ? redact(detail, 500) : '{}';
    try { db.run('INSERT INTO security_events (ts, user, kind, ip, agent, detail) VALUES (?, ?, ?, ?, ?, ?)', now(), user, kind, ip, agent, d); } catch { /* closing */ }
  }
  // One alert per key per hour: a row (for the account's owner when there is one) and a log line.
  function alert(key, what, extra = {}) {
    const t = now();
    if ((told.get(key) || 0) > t - 3_600_000) return false;
    told.set(key, t);
    if (told.size > 20_000) for (const [k, v] of told) if (v < t - 3_600_000) told.delete(k);
    const detail = { what, ...extra };
    insert('alert', { user: extra.user || null, ip: extra.ip || '', detail });
    log('security alert', JSON.stringify(detail));
    return true;
  }

  // Record one event. `req` fills in the (truncated) address and browser.
  function record(kind, { req = null, user = null, ip = null, agent = null, detail = null } = {}) {
    const t = now();
    const masked = maskIp(ip ?? (req ? ipOf(req) : '')) || '';
    // 0.14: "Chrome on Windows", as sign-in history and the device list keep it; the full browser string is
    // close to a fingerprint. An agent passed in is a label already (an alert, a test).
    const raw = agent ?? req?.headers?.['user-agent'];
    const ua = (agent != null ? String(agent) : raw ? deviceLabel(raw) : '').replace(CTRL, '').slice(0, 80);
    const keep = !NOISY.has(kind) || (store.take(`${kind}|${masked}`) && storeAll.take('all'));
    if (keep) {
      insert(kind, { user, ip: masked, agent: ua, detail });
      log('security', kind, JSON.stringify({ ...(user ? { user } : {}), ...(masked ? { ip: masked } : {}), ...(detail || {}) }));
    }
    // Detectors.
    if (kind === 'ratelimit.hit' && masked) {
      const n = win.hit(`rl|${masked}`, 10 * 60_000, t);
      if (n > 20) alert(`rl|${masked}`, 'many rate-limited requests from one address', { ip: masked, count: n, window: '10m' });
    }
    if ((kind === 'origin.refused' || kind === 'host.refused') && masked) {
      const n = win.hit(`xs|${masked}`, 10 * 60_000, t);
      if (n > 10) alert(`xs|${masked}`, 'many refused cross-site or foreign-host requests from one address', { ip: masked, count: n, window: '10m' });
    }
  }

  // An event from the auth layer (server/account.js): it is already stored in
  // auth_events, so only the detectors run here.
  function observe(e = {}) {
    const t = now();
    const user = typeof e.user === 'string' ? e.user : null;
    const ip = typeof e.ip === 'string' ? e.ip : '';
    if (AUTH_FAIL.has(e.event) && e.ok === false) {
      if (user) {
        const n = win.hit(`af|${user}`, 15 * 60_000, t);
        if (n > 5) alert(`af|${user}`, 'many failed sign-in attempts for this account', { user, count: n, window: '15m', ...(ip ? { ip } : {}) });
      }
      if (ip) {
        const n = win.hit(`afip|${ip}`, 15 * 60_000, t);
        if (n > 30) alert(`afip|${ip}`, 'many failed sign-in attempts from one address', { ip, count: n, window: '15m' });
      }
    }
    // A sign-in that worked right after a burst of failures, from a device or
    // address this account has not signed in from before: maybe a takeover.
    if (e.event === 'login' && e.ok === true && user && win.count(`af|${user}`, 60 * 60_000, t) >= 5) {
      let seen = 0;
      try { seen = db.get('SELECT COUNT(*) n FROM auth_events WHERE user = ? AND event = ? AND ok = 1 AND ip = ? AND agent = ?', user, 'login', ip, String(e.agent || '')).n; } catch { /* no auth layer */ }
      if (seen <= 1) alert(`new|${user}`, 'sign-in from a new device or address right after many failed attempts', { user, ...(ip ? { ip } : {}) });
    }
  }

  // The account's own security activity, newest first: its sign-ins and account
  // changes (auth_events) and the alerts and other events kept here.
  function list(user, limit = 50) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const mine = db.all('SELECT id, ts, kind, ip, agent, detail FROM security_events WHERE user = ? ORDER BY ts DESC, id DESC LIMIT ?', user, n).map((r) => {
      let what;
      if (r.kind === 'alert') { try { what = JSON.parse(r.detail).what; } catch { /* kept as is */ } }
      return { ts: r.ts, kind: r.kind, ok: r.kind !== 'alert', ip: r.ip, agent: r.agent, ...(what ? { what } : {}) };
    });
    let auth = [];
    try {
      auth = db.all('SELECT ts, event, ok, ip, agent, why FROM auth_events WHERE user = ? ORDER BY ts DESC, id DESC LIMIT ?', user, n)
        .map((r) => ({ ts: r.ts, kind: r.event, ok: !!r.ok, ip: r.ip || '', agent: r.agent || '', ...(r.why ? { why: r.why } : {}) }));
    } catch { /* no auth layer */ }
    return [...mine, ...auth].sort((a, b) => b.ts - a.ts).slice(0, n);
  }

  // The 60-second sweep: keepDays (30 by default), 500 rows per account, 20,000 without one.
  function prune(at = now()) {
    try {
      db.run('DELETE FROM security_events WHERE ts < ?', at - KEEP_MS);
      db.run(`DELETE FROM security_events WHERE id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user ORDER BY ts DESC, id DESC) rn FROM security_events WHERE user IS NOT NULL) WHERE rn > ?)`, PER_USER);
      db.run('DELETE FROM security_events WHERE user IS NULL AND id NOT IN (SELECT id FROM security_events WHERE user IS NULL ORDER BY id DESC LIMIT ?)', ANON_ROWS);
    } catch { /* closing */ }
  }

  const api = { record, observe, alert: (what, extra = {}) => alert(`ext|${what}|${extra.user || extra.ip || ''}`, what, extra), list, prune, reset: () => { store.reset(); storeAll.reset(); } };
  INSTANCES.set(db, api);
  return api;
}

// For modules that only hold the database (server/account.js forwards its
// audit lines here through a guarded dynamic import).
// sec-integrate: for modules that only hold the database (server/hub.js, ops.js,
// places.js, ghauth.js): record one event in this server's security log.
export function secRecord(db, kind, opts = {}) { try { if (db) INSTANCES.get(db)?.record(kind, opts); } catch { /* never fail a request */ } }
export function securityEvent(e, db) { try { if (db) INSTANCES.get(db)?.observe(e); } catch { /* never fail a request */ } }
export function suspicious(e, db) {
  try { if (db) INSTANCES.get(db)?.alert(String(e?.what || 'suspicious activity'), { ...(e?.user ? { user: e.user } : {}), ...(e?.ip ? { ip: e.ip } : {}), ...(e?.failures ? { count: e.failures } : {}) }); } catch { /* never fail a request */ }
}

// ---------- Sending a stored file (W1) ----------
// Opens the file before the status line goes out, so a row whose bytes are gone
// (deleted or replaced mid-download, a database restored without its files)
// is a plain 404 instead of an unhandled stream error that ends the process.
// Headers already set with res.setHeader are kept for the 200; on a 404 the
// file's own headers are dropped. Never throws or rejects.
const KEEP_ON_404 = new Set(['x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy', 'strict-transport-security', 'x-frame-options', 'set-cookie']);
export async function sendFile(res, path, { status = 200, range = null, onMissing = null } = {}) {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (e) {
    try { onMissing?.(e); } catch { /* ignore */ }
    try {
      if (res.headersSent) { res.destroy(); return false; }
      for (const h of res.getHeaderNames()) if (!KEEP_ON_404.has(h)) res.removeHeader(h);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch { try { res.destroy(); } catch { /* gone */ } }
    return false;
  }
  try {
    if (!res.headersSent) res.writeHead(status);
    const src = fh.createReadStream(range ? { start: range.start, end: range.end } : {});
    pipeline(src, res, (err) => { if (err) { try { res.destroy(); } catch { /* gone */ } } });
  } catch {
    try { await fh.close(); } catch { /* closed */ }
    try { res.destroy(); } catch { /* gone */ }
  }
  return true;
}
