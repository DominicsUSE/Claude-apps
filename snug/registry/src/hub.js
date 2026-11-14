// Hub: the single SQLite Durable Object (idFromName("hub")). Accounts, name uniqueness, key history,
// pending moves, tickets, hibernatable signaling sockets, presence, sealed signaling, relay and knocks.
// Everything is local to this one object: no DO-to-DO calls.
//
// Concurrency rule: the only awaits are WebCrypto and outbound fetch. Every read-check-write on SQLite
// happens in one synchronous block after the last await (see signed() / withTicket()).
import { check, normalize, skeleton, OWNER_NAMES } from '../../js/lib/usernames.js';
import { b64u, fromB64u, sha256, hmacHex, verifyEd25519, randomBytes, randomId } from './crypto.js';
import { checkToken, githubMode, GhError, TOKEN_RE } from './github.js';
import { DEFAULT_LIMITS, Windows, Budgets, HOUR, DAY } from './limits.js';
import { platform, now as clockNow } from './platform.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    uid TEXT PRIMARY KEY, ghh TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE, skel TEXT NOT NULL UNIQUE,
    ik TEXT NOT NULL, xk TEXT NOT NULL, kver INTEGER NOT NULL DEFAULT 1,
    claimed_at INTEGER NOT NULL, renamed_at INTEGER, key_at INTEGER NOT NULL, last_ts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ghh_meta (
    ghh TEXT PRIMARY KEY, renamed_at INTEGER, released_at INTEGER, rebind_block_until INTEGER)`,
  `CREATE TABLE IF NOT EXISTS keys (
    uid TEXT NOT NULL, kver INTEGER NOT NULL, ik TEXT NOT NULL, xk TEXT NOT NULL, prev TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (uid, kver))`,
  `CREATE TABLE IF NOT EXISTS pending_rebind (
    uid TEXT PRIMARY KEY, ik TEXT NOT NULL, xk TEXT NOT NULL, at INTEGER NOT NULL, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tickets (
    h TEXT PRIMARY KEY, ghh TEXT NOT NULL, owner INTEGER NOT NULL, ik TEXT NOT NULL, xk TEXT NOT NULL, exp INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS watch (uid TEXT PRIMARY KEY, uids TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS knocks (
    to_uid TEXT NOT NULL, frm TEXT NOT NULL, id TEXT NOT NULL, box TEXT NOT NULL, ts INTEGER NOT NULL,
    PRIMARY KEY (to_uid, frm, id))`,
  `CREATE INDEX IF NOT EXISTS knocks_to ON knocks(to_uid, ts)`,
  // win = start of the counting window in ms (a day or an hour); uid '*' = global. Purged after 2 days.
  `CREATE TABLE IF NOT EXISTS budget (
    uid TEXT NOT NULL, win INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (uid, win, kind))`,
];

const STATUS = {
  bad_request: 400, invalid_name: 400, reserved: 400, owner_only: 403, taken: 409, already_claimed: 409,
  rename_too_soon: 409, rebind_blocked: 409, github_invalid: 401, github_unavailable: 502, bad_signature: 401,
  stale: 401, bad_ticket: 401, not_found: 404, rate_limited: 429, config_error: 500, turn_unavailable: 502,
};
const MESSAGES = {
  bad_request: 'The request was malformed.',
  invalid_name: 'Use 2-32 lowercase letters, numbers, dots or underscores (no dot or underscore at the ends or twice in a row).',
  reserved: 'That name is reserved.',
  owner_only: 'That name is reserved.',
  taken: 'That name is taken.',
  already_claimed: 'This GitHub account already has a Snug username.',
  rename_too_soon: 'You can change your username once every 7 days.',
  rebind_blocked: 'A move to a new PC was stopped recently. Try again later.',
  github_invalid: 'GitHub did not accept that sign-in.',
  github_unavailable: 'GitHub could not be reached. Try again.',
  bad_signature: 'The request signature is not valid.',
  stale: 'The request is too old or was replayed. Check your clock.',
  bad_ticket: 'That sign-in has expired. Sign in with GitHub again.',
  not_found: 'Not found.',
  rate_limited: 'Too many requests. Try again later.',
  config_error: 'The registry is not configured correctly.',
  turn_unavailable: 'Relay servers are unavailable.',
};

const UID_RE = /^[a-z2-7]{16}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RAW_NAME_RE = /^[A-Za-z0-9_.]{1,32}$/;
const TS_WINDOW = 5 * 60_000;
const TICKET_TTL = 10 * 60_000;
const REBIND_DELAY = 72 * HOUR;
const REBIND_BLOCK = 24 * HOUR;
const RENAME_EVERY = 7 * DAY;
const KNOCK_TTL = 30 * DAY;
const AUTH_TIMEOUT = 10_000;
const KEEP_KEYS = 5;
const MAX_FRAME = 65536 + 1024; // relay box plus envelope
const MAX_SMALL_FRAME = 20 * 1024;
const MAX_SIG_BOX = 16 * 1024;
const MAX_RELAY_BOX = 65536;
const MAX_KNOCK_BOX = 4096;
const OK_MAX = 20; // invisible senders: peers they contacted this session may reply

class ApiError extends Error {
  constructor(code, extra) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}
const fail = (code, extra) => {
  throw new ApiError(code, extra);
};
const need = (cond) => {
  if (!cond) fail('bad_request');
};
const isUid = (s) => typeof s === 'string' && UID_RE.test(s);
const isKey = (s) => typeof s === 'string' && s.length === 43 && fromB64u(s)?.length === 32;
const isSig = (s) => typeof s === 'string' && s.length === 86 && fromB64u(s)?.length === 64;
const isTicket = isKey; // 32 random bytes, b64url
const isTs = (n) => Number.isSafeInteger(n) && n > 0;
const rawName = (s) => typeof s === 'string' && RAW_NAME_RE.test(s);
const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));

/** IPv4 -> the address (/32); IPv6 -> its /64. Never stored; only fed to an HMAC for memory buckets. */
export function ipPrefix(ip) {
  const s = String(ip || '').trim().replace(/%.*$/, '');
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4) return v4[1];
  if (!s.includes(':')) return s || 'unknown';
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const parts = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - (tail ? tail.split(':').length : 0))).fill('0'), ...(tail ? tail.split(':') : [])];
  return `${parts.slice(0, 4).map((p) => (parseInt(p, 16) || 0).toString(16)).join(':')}::/64`;
}

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.now = () => clockNow(env);
    const testLimits = typeof env.TEST_CLOCK === 'function' && env.TEST_LIMITS ? env.TEST_LIMITS : {};
    this.L = { ...DEFAULT_LIMITS, ...testLimits };
    this.win = new Windows(this.now);
    this.budgets = new Budgets(this.sql, this.now);
    this.watchCache = new Map(); // uid -> Set | null, bounded
    this.gone = new WeakSet();
    this.alarmAt = undefined;
    this.ownerHashes = null; // [ghh] for OWNER_GITHUB_IDS
    for (const q of SCHEMA) this.sql.exec(q);
    platform(env).autoResponse(ctx, 'ping', 'pong');
  }

  // ---------- small helpers ----------
  row(q, ...b) {
    return this.sql.exec(q, ...b).toArray()[0] || null;
  }
  rows(q, ...b) {
    return this.sql.exec(q, ...b).toArray();
  }
  tx(fn) {
    return this.ctx.storage.transactionSync ? this.ctx.storage.transactionSync(fn) : fn();
  }
  secret() {
    const s = this.env.GH_HMAC_SECRET;
    if (typeof s !== 'string' || s.length < 16) fail('config_error');
    return s;
  }
  json(status, obj) {
    const t = this.now();
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'content-type': 'application/json', 'x-snug-now': String(t) },
    });
  }
  fresh(ts) {
    const t = this.now();
    if (Math.abs(ts - t) > TS_WINDOW) fail('stale');
  }
  ipLimit(kind, ip) {
    const s = this.win.hit(`${kind}|${ip}`, this.L[kind]);
    if (s) fail('rate_limited', { retryAfter: s });
  }
  retryAfter(ms) {
    const t = this.now();
    return Math.max(1, Math.ceil((Math.floor(t / ms) * ms + ms - t) / 1000));
  }
  async ipKey(req) {
    return hmacHex(this.secret(), `ip\n${ipPrefix(req.headers.get('cf-connecting-ip'))}`);
  }
  async owners() {
    if (!this.ownerHashes) {
      const ids = String(this.env.OWNER_GITHUB_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const secret = this.secret();
      this.ownerHashes = await Promise.all(ids.map((id) => hmacHex(secret, `gh:${id}`)));
    }
    return this.ownerHashes;
  }
  ownerIds() {
    return String(this.env.OWNER_GITHUB_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  afterBudget() {
    if (this.budgets.dirty) this.ensureAlarm(this.now() + 60_000);
  }
  /** Make sure the alarm fires no later than t. Calls are chained so two of them never race. */
  ensureAlarm(t) {
    this.alarmChain = (this.alarmChain || Promise.resolve()).then(async () => {
      if (this.alarmAt === undefined) this.alarmAt = (await this.ctx.storage.getAlarm()) ?? null;
      if (this.alarmAt && this.alarmAt <= t && this.alarmAt > this.now()) return;
      this.alarmAt = t;
      await this.ctx.storage.setAlarm(t);
    }).catch(() => {});
  }

  // ---------- account rows ----------
  pending(uid) {
    return this.row('SELECT * FROM pending_rebind WHERE uid=?', uid);
  }
  /** Completes a due pending move lazily, so every reader sees the post-move state. */
  settle(acc) {
    if (!acc) return null;
    const p = this.pending(acc.uid);
    if (p && p.at <= this.now()) {
      this.completeRebind(acc.uid, null);
      return this.row('SELECT * FROM accounts WHERE uid=?', acc.uid);
    }
    return acc;
  }
  accountByUid(uid) {
    return this.settle(this.row('SELECT * FROM accounts WHERE uid=?', uid));
  }
  accountByGhh(ghh) {
    return this.settle(this.row('SELECT * FROM accounts WHERE ghh=?', ghh));
  }
  accountByName(name) {
    return this.settle(this.row('SELECT * FROM accounts WHERE username=?', name));
  }
  ticket(h) {
    return this.row('SELECT * FROM tickets WHERE h=? AND exp>?', h, this.now());
  }
  view(a) {
    const t = this.now();
    const next = a.renamed_at ? a.renamed_at + RENAME_EVERY : 0;
    return {
      uid: a.uid, username: a.username, kver: a.kver, claimedAt: a.claimed_at,
      renamedAt: a.renamed_at ?? null, renameAt: next > t ? next : 0,
    };
  }
  metaUpsert(ghh, col, val) {
    this.sql.exec(`INSERT INTO ghh_meta(ghh, ${col}) VALUES(?,?) ON CONFLICT(ghh) DO UPDATE SET ${col}=excluded.${col}`, ghh, val);
  }

  /** Verify a request signed by uid's current key, then run fn(account) synchronously. */
  async signed(uid, ts, sig, msg, mutating, fn) {
    need(isUid(uid) && isTs(ts) && isSig(sig));
    this.fresh(ts);
    const acc = this.accountByUid(uid);
    if (!acc) fail('not_found');
    if (!(await verifyEd25519(acc.ik, sig, msg))) fail('bad_signature');
    // --- synchronous from here ---
    const cur = this.accountByUid(uid);
    if (!cur || cur.ik !== acc.ik) fail('bad_signature');
    if (mutating) {
      if (ts <= cur.last_ts) fail('stale');
      this.sql.exec('UPDATE accounts SET last_ts=? WHERE uid=?', ts, uid);
      cur.last_ts = ts;
    }
    return fn(cur);
  }

  /** Verify a request signed by the key a ticket was issued to, then run fn(ticketRow) synchronously. */
  async withTicket(ticket, ts, sig, msgFor, fn) {
    need(isTicket(ticket) && isTs(ts) && isSig(sig));
    this.fresh(ts);
    const h = await sha256(ticket);
    const t = this.ticket(h);
    if (!t) fail('bad_ticket');
    if (!(await verifyEd25519(t.ik, sig, msgFor(t)))) fail('bad_signature');
    const t2 = this.ticket(h); // --- synchronous from here ---
    if (!t2) fail('bad_ticket');
    return fn(t2, h);
  }

  // ---------- HTTP ----------
  async fetch(req) {
    const url = new URL(req.url);
    this.budgets.bump('*', 'req20', DAY, 20);
    try {
      if (url.pathname === '/v1/ws') return await this.upgrade(req, url);
      const ip = await this.ipKey(req);
      let body = null;
      if (req.method === 'POST') {
        const text = await req.text();
        try {
          body = JSON.parse(text);
        } catch {
          fail('bad_request');
        }
        need(body && typeof body === 'object' && !Array.isArray(body));
      }
      return this.json(200, await this.route(url, body, ip));
    } catch (e) {
      if (e instanceof ApiError) {
        return this.json(STATUS[e.code] || 400, { error: e.code, message: MESSAGES[e.code] || e.code, ...e.extra, now: this.now() });
      }
      console.error('registry: internal error', e && e.name, url.pathname); // never the body or message (may hold a token)
      return this.json(500, { error: 'server_error', message: 'Internal error.', now: this.now() });
    } finally {
      this.afterBudget();
    }
  }

  route(url, body, ip) {
    switch (url.pathname) {
      case '/v1/auth/github': return this.auth(body, ip);
      case '/v1/claim': return this.claim(body, ip);
      case '/v1/rebind': return this.rebind(body, ip);
      case '/v1/rebind/approve': return this.approve(body, ip);
      case '/v1/rebind/cancel': return this.cancel(body, ip);
      case '/v1/rename': return this.rename(body, ip);
      case '/v1/release': return this.release(body, ip);
      case '/v1/check': return this.checkName(url.searchParams.get('name'), ip);
      case '/v1/lookup': return this.lookup(body, ip);
      case '/v1/turn': return this.turn(body, ip);
      default: fail('not_found');
    }
  }

  async auth(b, ip) {
    this.ipLimit('ipAuth', ip);
    const { token, ik, xk, ts, sig } = b;
    need(typeof token === 'string' && TOKEN_RE.test(token)); // shape first: no GitHub call for junk
    need(isKey(ik) && isKey(xk) && isTs(ts) && isSig(sig));
    this.fresh(ts);
    if (!(await verifyEd25519(ik, sig, `snug-reg-v1\nauth\n${ik}\n${xk}\n${ts}`))) fail('bad_signature');
    const secret = this.secret();
    try {
      githubMode(this.env);
    } catch {
      fail('config_error');
    }
    if (!this.budgets.take('*', 'auth', this.L.authGlobal)) fail('rate_limited', { retryAfter: this.retryAfter(HOUR) });
    let id;
    try {
      ({ id } = await checkToken(this.env, token, this.env.__fetch || fetch));
    } catch (e) {
      if (e instanceof GhError) fail(e.code);
      throw e;
    }
    const ghh = await hmacHex(secret, `gh:${id}`);
    const owner = this.ownerIds().includes(String(id));
    id = null;
    const ticket = b64u(randomBytes(32));
    const h = await sha256(ticket);
    // --- synchronous from here ---
    const t = this.now();
    this.sql.exec('INSERT INTO tickets(h,ghh,owner,ik,xk,exp) VALUES(?,?,?,?,?,?)', h, ghh, owner ? 1 : 0, ik, xk, t + TICKET_TTL);
    this.ensureAlarm(t + TICKET_TTL);
    const acc = this.accountByGhh(ghh);
    if (!acc) return { status: 'new', owner, ticket };
    const p = this.pending(acc.uid);
    if (acc.ik === ik && acc.xk === xk) {
      return { status: 'ok', account: this.view(acc), ticket, ...(p ? { rebind: { at: p.at } } : {}) };
    }
    if (p && p.ik === ik && p.xk === xk) return { status: 'pending', at: p.at, account: this.view(acc), ticket };
    return { status: 'rebind', account: this.view(acc), ticket };
  }

  async claim(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { ticket, username, ts, sig } = b;
    need(typeof username === 'string');
    if (!rawName(username)) fail('invalid_name');
    return this.withTicket(ticket, ts, sig, () => `snug-reg-v1\nclaim\n${ticket}\n${username}\n${ts}`, (t, h) => {
      if (this.accountByGhh(t.ghh)) fail('already_claimed');
      const meta = this.row('SELECT * FROM ghh_meta WHERE ghh=?', t.ghh);
      const last = Math.max(meta?.renamed_at || 0, meta?.released_at || 0);
      if (last && this.now() - last < RENAME_EVERY) fail('rename_too_soon', { retryAt: last + RENAME_EVERY });
      const name = normalize(username);
      const ce = check(name, { owner: !!t.owner });
      if (ce) fail(ce);
      const skel = OWNER_NAMES.includes(name) ? `#${name}` : skeleton(name);
      const now = this.now();
      for (let i = 0; ; i++) {
        const uid = randomId(16);
        try {
          this.tx(() => {
            this.sql.exec(
              'INSERT INTO accounts(uid,ghh,username,skel,ik,xk,kver,claimed_at,renamed_at,key_at,last_ts) VALUES(?,?,?,?,?,?,1,?,NULL,?,?)',
              uid, t.ghh, name, skel, t.ik, t.xk, now, now, ts,
            );
            this.sql.exec('INSERT INTO keys(uid,kver,ik,xk,prev,at) VALUES(?,1,?,?,NULL,?)', uid, t.ik, t.xk, now);
            this.sql.exec('DELETE FROM tickets WHERE h=?', h);
          });
          return { account: this.view(this.row('SELECT * FROM accounts WHERE uid=?', uid)) };
        } catch (e) {
          if (!isUnique(e)) throw e;
          const m = String(e.message);
          if (/accounts\.uid/.test(m) && i < 3) continue;
          if (/accounts\.ghh/.test(m)) fail('already_claimed');
          fail('taken');
        }
      }
    });
  }

  async rebind(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { ticket, ts, sig } = b;
    return this.withTicket(ticket, ts, sig, () => `snug-reg-v1\nrebind\n${ticket}\n${ts}`, (t, h) => {
      const acc = this.accountByGhh(t.ghh);
      if (!acc) fail('not_found');
      if (acc.ik === t.ik && acc.xk === t.xk) fail('bad_request');
      const now = this.now();
      const meta = this.row('SELECT rebind_block_until FROM ghh_meta WHERE ghh=?', t.ghh);
      if (meta?.rebind_block_until > now) fail('rebind_blocked', { retryAt: meta.rebind_block_until });
      const old = this.pending(acc.uid);
      const same = old && old.ik === t.ik && old.xk === t.xk;
      const at = same ? old.at : now + REBIND_DELAY;
      this.tx(() => {
        this.sql.exec('INSERT OR REPLACE INTO pending_rebind(uid,ik,xk,at,created) VALUES(?,?,?,?,?)', acc.uid, t.ik, t.xk, at, same ? old.created : now);
        this.sql.exec('DELETE FROM tickets WHERE h=?', h);
      });
      if (old && !same) this.closeSockets(acc.uid, (a) => a.mode === 'pending', 4006, 'move stopped');
      if (!same) {
        const msg = { t: 'rebind', state: 'pending', at, kver: acc.kver + 1, ik: t.ik, xk: t.xk };
        for (const w of this.sockets(acc.uid, (a) => a.mode === 'normal')) this.send(w, msg);
      }
      this.ensureAlarm(at);
      return { status: 'pending', uid: acc.uid, at };
    });
  }

  async approve(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { uid, kver, ik, xk, prev } = b;
    need(isUid(uid) && Number.isSafeInteger(kver) && isKey(ik) && isKey(xk) && isSig(prev));
    const acc = this.accountByUid(uid);
    const p = acc && this.pending(uid);
    if (!acc || !p || p.ik !== ik || p.xk !== xk || kver !== acc.kver + 1) fail('not_found');
    if (!(await verifyEd25519(acc.ik, prev, `snug-keychange-v1\n${uid}\n${kver}\n${ik}\n${xk}`))) fail('bad_signature');
    // --- synchronous from here ---
    const cur = this.accountByUid(uid);
    const p2 = cur && this.pending(uid);
    if (!cur || cur.ik !== acc.ik || !p2 || p2.ik !== ik || p2.xk !== xk) fail('not_found');
    this.completeRebind(uid, prev);
    return { ok: true };
  }

  async cancel(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { uid, ts, sig } = b;
    return this.signed(uid, ts, sig, `snug-reg-v1\nrebind-cancel\n${uid}\n${ts}`, true, (acc) => {
      const p = this.pending(uid);
      if (p) {
        this.tx(() => {
          this.sql.exec('DELETE FROM pending_rebind WHERE uid=?', uid);
          this.metaUpsert(acc.ghh, 'rebind_block_until', this.now() + REBIND_BLOCK);
        });
        this.closeSockets(uid, (a) => a.mode === 'pending', 4006, 'move stopped');
        for (const w of this.sockets(uid, (a) => a.mode === 'normal')) this.send(w, { t: 'rebind', state: 'stopped' });
      }
      return { ok: true };
    });
  }

  async rename(b, ip) {
    this.ipLimit('ipRename', ip);
    const { uid, username, ts, sig } = b;
    need(typeof username === 'string');
    if (!rawName(username)) fail('invalid_name');
    const owners = await this.owners();
    return this.signed(uid, ts, sig, `snug-reg-v1\nrename\n${uid}\n${username}\n${ts}`, true, (acc) => {
      const name = normalize(username);
      if (name === acc.username) return { account: this.view(acc) };
      const now = this.now();
      if (acc.renamed_at && now - acc.renamed_at < RENAME_EVERY) fail('rename_too_soon', { retryAt: acc.renamed_at + RENAME_EVERY });
      const ce = check(name, { owner: owners.includes(acc.ghh) });
      if (ce) fail(ce);
      const skel = OWNER_NAMES.includes(name) ? `#${name}` : skeleton(name);
      try {
        this.tx(() => {
          this.sql.exec('UPDATE accounts SET username=?, skel=?, renamed_at=? WHERE uid=?', name, skel, now, uid);
          this.metaUpsert(acc.ghh, 'renamed_at', now);
        });
      } catch (e) {
        if (isUnique(e)) fail('taken');
        throw e;
      }
      return { account: this.view(this.row('SELECT * FROM accounts WHERE uid=?', uid)) };
    });
  }

  async release(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { uid, ticket, ts, sig } = b;
    need(isTicket(ticket));
    const h = await sha256(ticket);
    return this.signed(uid, ts, sig, `snug-reg-v1\nrelease\n${uid}\n${ticket}\n${ts}`, true, (acc) => {
      const t = this.ticket(h);
      if (!t || t.ghh !== acc.ghh) fail('bad_ticket');
      this.tx(() => {
        for (const q of ['accounts', 'keys', 'pending_rebind', 'watch']) this.sql.exec(`DELETE FROM ${q} WHERE uid=?`, uid);
        this.sql.exec('DELETE FROM knocks WHERE to_uid=?', uid);
        this.sql.exec('DELETE FROM tickets WHERE h=?', h);
        this.metaUpsert(acc.ghh, 'released_at', this.now());
      });
      this.closeSockets(uid, () => true, 4003, 'revoked');
      this.watchCache.delete(uid);
      return { ok: true };
    });
  }

  checkName(name, ip) {
    this.ipLimit('ipCheck', ip);
    if (!rawName(name)) return { ok: false, error: 'invalid_name' };
    const n = normalize(name);
    const ce = check(n);
    if (ce) return { ok: false, error: ce };
    if (this.row('SELECT 1 AS x FROM accounts WHERE username=? OR skel=?', n, skeleton(n))) return { ok: false, error: 'taken' };
    return { ok: true };
  }

  async lookup(b, ip) {
    this.ipLimit('ipLookup', ip);
    const { uid, ts, sig, q } = b;
    need(q && typeof q === 'object');
    let qs;
    if (typeof q.name === 'string') {
      if (!rawName(q.name)) fail('not_found');
      qs = q.name;
    } else {
      need(isUid(q.uid));
      qs = q.uid;
    }
    return this.signed(uid, ts, sig, `snug-reg-v1\nlookup\n${uid}\n${ts}\n${qs}`, false, () => {
      if (!this.budgets.take(uid, 'lookup', this.L.lookupDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
      const r = typeof q.name === 'string' ? this.accountByName(normalize(q.name)) : this.accountByUid(q.uid);
      if (!r) fail('not_found');
      const chain = this.rows('SELECT kver, ik, xk, prev FROM keys WHERE uid=? ORDER BY kver', r.uid)
        .map((k) => ({ kver: k.kver, ik: k.ik, xk: k.xk, prev: k.prev ?? null }));
      return { uid: r.uid, username: r.username, ik: r.ik, xk: r.xk, kver: r.kver, chain };
    });
  }

  async turn(b, ip) {
    const { TURN_KEY_ID: keyId, TURN_KEY_TOKEN: token } = this.env;
    if (!keyId || !token) fail('not_found');
    this.ipLimit('ipTurn', ip);
    const { uid, peer, ts, sig } = b;
    need(isUid(peer));
    await this.signed(uid, ts, sig, `snug-reg-v1\nturn\n${uid}\n${peer}\n${ts}`, false, () => {
      if (peer === uid || !this.accountByUid(peer)) fail('not_found');
      if (!this.budgets.take(uid, 'turn', this.L.turnDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
    });
    const ttl = 7200;
    const base = String(this.env.TURN_API || 'https://rtc.live.cloudflare.com/v1/turn/keys').replace(/\/+$/, '');
    let res;
    try {
      res = await (this.env.__fetch || fetch)(`${base}/${encodeURIComponent(keyId)}/credentials/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
      });
    } catch {
      fail('turn_unavailable');
    }
    const out = res.ok ? await res.json().catch(() => null) : null;
    const ice = out && out.iceServers;
    if (!ice) fail('turn_unavailable');
    return { iceServers: Array.isArray(ice) ? ice : [ice], ttl };
  }

  // ---------- rebind completion ----------
  completeRebind(uid, prev) {
    const acc = this.row('SELECT * FROM accounts WHERE uid=?', uid);
    const p = this.pending(uid);
    if (!acc || !p) return;
    const now = this.now();
    const kver = acc.kver + 1;
    this.tx(() => {
      this.sql.exec('UPDATE accounts SET ik=?, xk=?, kver=?, key_at=? WHERE uid=?', p.ik, p.xk, kver, now, uid);
      this.sql.exec('INSERT OR REPLACE INTO keys(uid,kver,ik,xk,prev,at) VALUES(?,?,?,?,?,?)', uid, kver, p.ik, p.xk, prev, now);
      this.sql.exec('DELETE FROM keys WHERE uid=? AND kver<=?', uid, kver - KEEP_KEYS);
      this.sql.exec('DELETE FROM pending_rebind WHERE uid=?', uid);
    });
    this.closeSockets(uid, (a) => a.mode === 'normal', 4003, 'revoked');
    this.closeSockets(uid, (a) => a.mode === 'pending' && a.ik === p.ik, 4004, 'rebound');
  }

  // ---------- sockets ----------
  att(ws) {
    try {
      return ws.deserializeAttachment() || null;
    } catch {
      return null;
    }
  }
  /** Open, authenticated sockets of uid matching pred(attachment). */
  sockets(uid, pred) {
    const out = [];
    for (const w of this.ctx.getWebSockets(uid)) {
      if (w.readyState !== 1 || this.gone.has(w)) continue;
      const a = this.att(w);
      if (a && a.authed && pred(a)) out.push(w);
    }
    return out;
  }
  normalSocket(uid) {
    return this.sockets(uid, (a) => a.mode === 'normal')[0] || null;
  }
  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* closed */
    }
  }
  closeWs(ws, code, reason) {
    this.cleanup(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
  closeSockets(uid, pred, code, reason) {
    for (const w of this.sockets(uid, pred)) this.closeWs(w, code, reason);
  }
  watchSet(uid) {
    if (this.watchCache.has(uid)) {
      const s = this.watchCache.get(uid);
      this.watchCache.delete(uid);
      this.watchCache.set(uid, s);
      return s;
    }
    const r = this.row('SELECT uids FROM watch WHERE uid=?', uid);
    const s = r ? new Set(JSON.parse(r.uids)) : null;
    if (this.watchCache.size >= 1000) this.watchCache.delete(this.watchCache.keys().next().value);
    this.watchCache.set(uid, s);
    return s;
  }
  /** u's normal socket if u is online and watches me. */
  mutualOnline(me, u) {
    const w = this.normalSocket(u);
    if (!w) return null;
    const s = this.watchSet(u);
    return s && s.has(me) ? w : null;
  }
  /** Socket of `to` if a sig/relay from `me` may be delivered; else null (one answer for every reason). */
  deliverable(me, to) {
    if (to === me) return null;
    const mine = this.watchSet(me);
    if (!mine || !mine.has(to)) return null;
    const w = this.mutualOnline(me, to);
    if (!w) return null;
    const ta = this.att(w);
    if (!ta.visible && !(ta.ok || []).includes(me)) return null;
    return w;
  }
  /** Socket gone (closed by either side). Idempotent. Presence off + watch row delete if no other normal socket. */
  cleanup(ws) {
    if (this.gone.has(ws)) return;
    this.gone.add(ws);
    const a = this.att(ws);
    if (a && a.authed && a.mode === 'normal' && !this.normalSocket(a.uid)) {
      const set = this.watchSet(a.uid);
      if (set && a.visible) {
        for (const u of set) {
          const w = this.mutualOnline(a.uid, u);
          if (w) this.send(w, { t: 'presence', uid: a.uid, on: false });
        }
      }
      this.sql.exec('DELETE FROM watch WHERE uid=?', a.uid);
      this.watchCache.delete(a.uid);
    }
    this.budgets.flush();
  }

  async upgrade(req, url) {
    const uid = url.searchParams.get('uid');
    need(isUid(uid));
    const ip = await this.ipKey(req);
    this.ipLimit('ipWs', ip);
    let unauth = 0;
    for (const w of this.ctx.getWebSockets(uid)) {
      const a = w.readyState === 1 && this.att(w);
      if (a && !a.authed) unauth++;
    }
    if (unauth >= this.L.unauthPerUid[0]) fail('rate_limited', { retryAfter: 10 });
    const p = platform(this.env);
    const { client, server } = p.newPair();
    this.ctx.acceptWebSocket(server, [uid]);
    const at = this.now();
    const n = b64u(randomBytes(16));
    server.serializeAttachment({ uid, authed: false, at, n });
    this.send(server, { t: 'challenge', n, now: at });
    this.ensureAlarm(at + AUTH_TIMEOUT);
    return p.upgradeResponse(client, { 'x-snug-now': String(at) });
  }

  async webSocketMessage(ws, msg) {
    this.budgets.bump('*', 'req20', DAY, 1);
    try {
      const a = this.att(ws);
      if (!a || this.gone.has(ws)) return;
      if (typeof msg !== 'string') return this.closeWs(ws, 1003, 'text only');
      if (msg.length > MAX_FRAME) {
        if (!a.authed) return this.closeWs(ws, 4001, 'bad auth');
        return this.send(ws, { t: 'err', id: null, code: 'too_big' });
      }
      let f = null;
      try {
        f = JSON.parse(msg);
      } catch {
        /* ignored below */
      }
      if (!f || typeof f !== 'object' || typeof f.t !== 'string') {
        if (!a.authed) this.closeWs(ws, 4001, 'bad auth');
        return;
      }
      if (!a.authed) return await this.onAuth(ws, a, f);
      if (a.mode !== 'normal') return;
      const id = typeof f.id === 'string' && ID_RE.test(f.id) ? f.id : null;
      if (f.t !== 'relay' && msg.length > MAX_SMALL_FRAME) return this.send(ws, { t: 'err', id, code: 'too_big' });
      switch (f.t) {
        case 'watch': return this.onWatch(ws, a, f);
        case 'visible': return this.onVisible(ws, a, f);
        case 'sig':
        case 'relay': return this.onForward(ws, a, f, id);
        case 'knock': return this.onKnock(ws, a, f, id);
        case 'knocked': return this.onKnocked(a, f);
        default: return undefined;
      }
    } finally {
      this.afterBudget();
    }
  }

  async webSocketClose(ws, code) {
    this.cleanup(ws);
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, 'bye');
    } catch {
      /* already closed */
    }
    this.afterBudget();
  }

  async webSocketError(ws) {
    this.cleanup(ws);
    this.afterBudget();
  }

  async onAuth(ws, a, f) {
    if (f.t !== 'auth' || f.uid !== a.uid || !isSig(f.sig)) return this.closeWs(ws, 4001, 'bad auth');
    const uid = a.uid;
    const acc = this.accountByUid(uid);
    if (!acc) return this.closeWs(ws, 4003, 'revoked');
    const msg = `snug-reg-v1\nsignal\n${uid}\n${a.n}`;
    const p = this.pending(uid);
    let mode = null;
    let ik = null;
    if (await verifyEd25519(acc.ik, f.sig, msg)) [mode, ik] = ['normal', acc.ik];
    else if (p && (await verifyEd25519(p.ik, f.sig, msg))) [mode, ik] = ['pending', p.ik];
    else {
      for (const k of this.rows('SELECT ik FROM keys WHERE uid=? AND kver<?', uid, acc.kver)) {
        if (await verifyEd25519(k.ik, f.sig, msg)) return this.closeWs(ws, 4003, 'revoked');
      }
      return this.closeWs(ws, 4001, 'bad auth');
    }
    // --- synchronous from here ---
    if (ws.readyState !== 1 || this.gone.has(ws)) return undefined;
    const cur = this.accountByUid(uid);
    const p2 = cur && this.pending(uid);
    if (!cur) return this.closeWs(ws, 4003, 'revoked');
    if (mode === 'pending' && cur.ik === ik) mode = 'normal'; // the move completed meanwhile
    if (mode === 'normal' && cur.ik !== ik) return this.closeWs(ws, 4003, 'revoked');
    if (mode === 'pending' && (!p2 || p2.ik !== ik)) return this.closeWs(ws, 4006, 'move stopped');
    if (!this.budgets.take(uid, 'connect', this.L.connect)) return this.closeWs(ws, 4029, 'rate limited');
    const att = { uid, authed: true, mode, visible: f.visible !== false, at: this.now(), ik };
    ws.serializeAttachment(att);
    const ready = { t: 'ready', mode, kver: cur.kver, ping: Number(this.env.PING_SECONDS) || 90, now: this.now() };
    if (mode === 'pending') {
      ready.rebind = { at: p2.at };
      return this.send(ws, ready);
    }
    for (const w of this.sockets(uid, (x) => x.mode === 'normal')) if (w !== ws) this.closeWs(w, 4002, 'replaced');
    if (p2) ready.rebind = { at: p2.at, kver: cur.kver + 1, ik: p2.ik, xk: p2.xk };
    this.send(ws, ready);
    const mine = this.watchSet(uid);
    if (mine) for (const u of mine) this.exchangePresence(ws, att, u);
    for (const k of this.rows('SELECT frm, id, box, ts FROM knocks WHERE to_uid=? ORDER BY ts LIMIT 100', uid)) {
      this.send(ws, { t: 'knock', from: k.frm, id: k.id, box: k.box, ts: k.ts });
    }
    return undefined;
  }

  /** Both directions of "on" between me (socket ws) and u, if u is online and we watch each other. */
  exchangePresence(ws, a, u) {
    const w = this.mutualOnline(a.uid, u);
    if (!w) return;
    if (a.visible) this.send(w, { t: 'presence', uid: a.uid, on: true });
    if (this.att(w).visible) this.send(ws, { t: 'presence', uid: u, on: true });
  }

  onWatch(ws, a, f) {
    const me = a.uid;
    if (!Array.isArray(f.uids)) return this.send(ws, { t: 'err', id: null, code: 'bad_request' });
    if (f.uids.length > this.L.watchMax[0]) return this.send(ws, { t: 'err', id: null, code: 'too_many' });
    if (this.win.hit(`watch|${me}`, this.L.watchHour) || !this.budgets.take(me, 'watch', this.L.watchDay)) {
      return this.send(ws, { t: 'err', id: null, code: 'rate_limited' });
    }
    const next = new Set(f.uids.filter((u) => isUid(u) && u !== me));
    const prev = this.watchSet(me) || new Set();
    this.sql.exec('INSERT OR REPLACE INTO watch(uid, uids) VALUES(?,?)', me, JSON.stringify([...next]));
    this.watchCache.set(me, next);
    for (const u of prev) {
      if (next.has(u) || !a.visible) continue;
      const w = this.mutualOnline(me, u); // we were mutual; now we are not
      if (w) this.send(w, { t: 'presence', uid: me, on: false });
    }
    for (const u of next) if (!prev.has(u)) this.exchangePresence(ws, a, u);
  }

  onVisible(ws, a, f) {
    const on = !!f.on;
    if (a.visible === on) return;
    a.visible = on;
    if (on) delete a.ok;
    ws.serializeAttachment(a);
    const mine = this.watchSet(a.uid);
    if (!mine) return;
    for (const u of mine) {
      const w = this.mutualOnline(a.uid, u);
      if (w) this.send(w, { t: 'presence', uid: a.uid, on });
    }
  }

  onForward(ws, a, f, id) {
    const me = a.uid;
    const relay = f.t === 'relay';
    if (!id || !isUid(f.to) || typeof f.box !== 'string') return this.send(ws, { t: 'err', id, code: 'bad_request' });
    if (f.box.length > (relay ? MAX_RELAY_BOX : MAX_SIG_BOX)) return this.send(ws, { t: 'err', id, code: 'too_big' });
    if (relay) {
      const off = Number(this.env.RELAY_OFF_AT) || 60000;
      if (this.budgets.value('*', 'req20', DAY) > off * 20) return this.send(ws, { t: 'err', id, code: 'relay_unavailable' });
      if (this.win.hit(`relay|${me}`, this.L.relayBurst) || !this.budgets.take(me, 'relay', this.L.relayDay)
        || !this.budgets.take(me, 'relayB', this.L.relayBytesDay, f.box.length)) {
        return this.send(ws, { t: 'err', id, code: 'rate_limited' });
      }
    } else if (this.win.hit(`sig|${me}`, this.L.sigMin) || !this.budgets.take(me, 'sig', this.L.sigDay)) {
      return this.send(ws, { t: 'err', id, code: 'rate_limited' });
    }
    const w = this.deliverable(me, f.to);
    if (!w) return this.send(ws, { t: 'err', id, code: 'unavailable' });
    this.send(w, { t: f.t, from: me, box: f.box });
    if (!a.visible) {
      const ok = a.ok || [];
      if (!ok.includes(f.to)) {
        ok.push(f.to);
        a.ok = ok.slice(-OK_MAX);
        ws.serializeAttachment(a);
      }
    }
    return undefined;
  }

  onKnock(ws, a, f, id) {
    const me = a.uid;
    if (!id || !isUid(f.to) || typeof f.box !== 'string') return this.send(ws, { t: 'err', id, code: 'bad_request' });
    if (f.box.length > MAX_KNOCK_BOX) return this.send(ws, { t: 'err', id, code: 'too_big' });
    const now = this.now();
    if (f.to === me) {
      // Self-knock: only while a move is pending; carries the restore list to the new key. At most one.
      if (!this.pending(me)) return this.send(ws, { t: 'err', id, code: 'unavailable' });
      if (!this.budgets.take(me, 'knock', this.L.knockDay)) return this.send(ws, { t: 'err', id, code: 'rate_limited' });
      this.tx(() => {
        this.sql.exec('DELETE FROM knocks WHERE to_uid=? AND frm=?', me, me);
        this.sql.exec('INSERT INTO knocks(to_uid,frm,id,box,ts) VALUES(?,?,?,?,?)', me, me, id, f.box, now);
      });
      this.ensureAlarm(now + KNOCK_TTL);
      return this.send(ws, { t: 'ok', id });
    }
    if (!this.budgets.take(me, 'knock', this.L.knockDay) || !this.budgets.take(`${me}>${f.to}`, 'knockP', this.L.knockPairDay)) {
      return this.send(ws, { t: 'err', id, code: 'rate_limited' });
    }
    const exists = this.row('SELECT 1 AS x FROM accounts WHERE uid=?', f.to);
    if (exists) {
      this.tx(() => {
        const per = this.row('SELECT COUNT(*) AS n FROM knocks WHERE to_uid=? AND frm=?', f.to, me).n;
        const over = per - this.L.knockPerSender[0] + 1;
        if (over > 0) {
          this.sql.exec('DELETE FROM knocks WHERE rowid IN (SELECT rowid FROM knocks WHERE to_uid=? AND frm=? ORDER BY ts, rowid LIMIT ?)', f.to, me, over);
        }
        const total = this.row('SELECT COUNT(*) AS n FROM knocks WHERE to_uid=?', f.to).n;
        const evict = total - this.L.knockBox[0] + 1;
        if (evict > 0) {
          this.sql.exec('DELETE FROM knocks WHERE rowid IN (SELECT rowid FROM knocks WHERE to_uid=? ORDER BY ts, rowid LIMIT ?)', f.to, evict);
        }
        this.sql.exec('INSERT OR IGNORE INTO knocks(to_uid,frm,id,box,ts) VALUES(?,?,?,?,?)', f.to, me, id, f.box, now);
      });
      this.ensureAlarm(now + KNOCK_TTL);
    }
    this.send(ws, { t: 'ok', id }); // the same answer whether stored, pushed, or the target does not exist
    const w = exists && this.normalSocket(f.to);
    if (w) this.send(w, { t: 'knock', from: me, id, box: f.box, ts: now });
    return undefined;
  }

  onKnocked(a, f) {
    if (!Array.isArray(f.ids)) return;
    const ids = f.ids.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 200);
    if (!ids.length) return;
    this.sql.exec(`DELETE FROM knocks WHERE to_uid=? AND id IN (${ids.map(() => '?').join(',')})`, a.uid, ...ids);
  }

  // ---------- alarm ----------
  async alarm() {
    this.alarmAt = null;
    const t = this.now();
    let next = Infinity;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.readyState === 1 && this.att(w);
      if (!a || a.authed) continue;
      if (t - a.at >= AUTH_TIMEOUT) this.closeWs(w, 4005, 'auth timeout');
      else next = Math.min(next, a.at + AUTH_TIMEOUT);
    }
    for (const r of this.rows('SELECT uid FROM pending_rebind WHERE at<=?', t)) this.completeRebind(r.uid, null);
    this.budgets.flush();
    this.sql.exec('DELETE FROM tickets WHERE exp<=?', t);
    this.sql.exec('DELETE FROM knocks WHERE ts<=?', t - KNOCK_TTL);
    this.sql.exec('DELETE FROM budget WHERE win<?', t - 2 * DAY);
    const r = this.row(`SELECT (SELECT MIN(at) FROM pending_rebind) AS p, (SELECT MIN(exp) FROM tickets) AS e,
      (SELECT MIN(ts) FROM knocks) AS k`);
    if (r.p != null) next = Math.min(next, r.p);
    if (r.e != null) next = Math.min(next, r.e);
    if (r.k != null) next = Math.min(next, r.k + KNOCK_TTL);
    if (this.budgets.dirty) next = Math.min(next, t + 60_000);
    if (next < Infinity) this.ensureAlarm(Math.max(next, t + 1));
  }
}
