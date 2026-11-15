// Keypair accounts (v0.12): a Snug account that needs no GitHub account. Mixed into the Hub like
// admin.js and vaultkey.js, and switched on with KEY_ACCOUNTS = "1" (wrangler.toml vars).
//
// The account is its device key (ik/xk, as for every account) plus a recovery key rk: an Ed25519 key whose
// seed the app derives from the 20-byte recovery secret it shows the person once (js/lib/recovery.js).
// GitHub's one-account-per-person rule is replaced by speed bumps, not a guarantee: a proof of work, per
// address and global sign-up budgets, smaller budgets for new accounts, and a purge of accounts that never
// connect. Someone with many addresses and spare CPU can still make accounts slowly (README says so).
//
// The account row is an ordinary `accounts` row whose ghh is the permanent anchor "a:<uid>": GitHub hashes
// are 64 hex characters, so the two never collide, and every ghh-keyed table (vault keys, moves, renames)
// works unchanged. Nothing here changes a route, field, signed string or socket frame that 0.11 uses.
//
// Concurrency rule (hub.js): every read-check-write happens in one synchronous block after the last await.
import { check, normalize, skeleton } from '../../js/lib/usernames.js';
import { b64u, sha256, hmacHex, verifyEd25519, randomBytes, randomId } from './crypto.js';
import {
  fail, need, ID_RE, isUid, isKey, isSig, isTs, rawName, isUnique, semverCmp, isSemver, REBIND_DELAY, REBIND_BLOCK, KNOCK_TTL, MAX_KNOCK_BOX,
} from './common.js';
import { MIN, DAY } from './limits.js';

export const KEY_SCHEMA = [
  // the recovery key of an account (keypair accounts always have one; GitHub accounts may add one)
  'CREATE TABLE IF NOT EXISTS recovery_keys (uid TEXT PRIMARY KEY, rk TEXT NOT NULL UNIQUE, at INTEGER NOT NULL)',
  // a new recovery key set by the device alone: it takes effect at `at` unless the current recovery key cancels it
  'CREATE TABLE IF NOT EXISTS recovery_pending (uid TEXT PRIMARY KEY, rk TEXT NOT NULL, at INTEGER NOT NULL, created INTEGER NOT NULL)',
  // a GitHub account linked to a keypair account as an optional second proof
  'CREATE TABLE IF NOT EXISTS gh_links (uid TEXT PRIMARY KEY, ghh TEXT NOT NULL UNIQUE, at INTEGER NOT NULL)',
  // keypair account bookkeeping for the abuse rules
  'CREATE TABLE IF NOT EXISTS key_meta (uid TEXT PRIMARY KEY, created INTEGER NOT NULL, first_auth INTEGER, seen INTEGER)',
  // how a pending move was started: 'recovery' | 'code' (no row = 'github', as for every 0.11 move)
  'CREATE TABLE IF NOT EXISTS pending_via (uid TEXT PRIMARY KEY, via TEXT NOT NULL)',
  // pairing codes for "move from my other PC": h = sha256(code), hid = the new PC's handle for polling
  `CREATE TABLE IF NOT EXISTS move_codes (h TEXT PRIMARY KEY, hid TEXT NOT NULL UNIQUE, ik TEXT NOT NULL, xk TEXT NOT NULL,
    exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, uid TEXT, done INTEGER)`,
  // proof-of-work challenges already used (until they expire)
  'CREATE TABLE IF NOT EXISTS pow_spent (h TEXT PRIMARY KEY, exp INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS key_meta_new ON key_meta(first_auth, created)',
];

// Additive error codes: 0.11 clients never call the routes that return them.
export const KEY_STATUS = { pow_invalid: 400, too_new: 409, key_in_use: 409, recovery_pending: 409, move_pending: 409 };
export const KEY_MESSAGES = {
  pow_invalid: 'The setup check failed. Try again.',
  too_new: 'New accounts can do that later.',
  key_in_use: 'That key already belongs to an account.',
  recovery_pending: 'A new recovery key is waiting to take effect.',
  move_pending: 'A move to a new PC is waiting. Stop it first.',
};

// path -> Hub method. Every route is POST.
export const KEY_ROUTES = {
  '/v1/pow': 'pow',
  '/v1/register': 'register',
  '/v1/recover': 'recover',
  '/v1/move/hello': 'moveHello',
  '/v1/move/wait': 'moveWait',
  '/v1/move/peek': 'movePeek',
  '/v1/move/accept': 'moveAccept',
  '/v1/recovery/set': 'recoverySet',
  '/v1/recovery/cancel': 'recoveryCancel',
  '/v1/link/github': 'linkGithub',
  '/v1/link/github/remove': 'unlinkGithub',
  '/v1/release/key': 'releaseKey',
  '/v1/account/kind': 'accountKind',
};

export const keyAccountsOn = (env) => String(env?.KEY_ACCOUNTS ?? '') === '1';
export const isKeyAcc = (acc) => !!acc && typeof acc.ghh === 'string' && acc.ghh.startsWith('a:');

const POW_TTL = 10 * MIN;
const POW_MAX = 28;
const MOVE_CODE_TTL = 10 * MIN;
const MOVE_TRIES = 5;
const RECOVERY_DELAY = 7 * DAY;     // a recovery key set without the old one
const NEW_FOR = 72 * 3_600_000;     // smaller budgets for this long after registration
const FIRST_RENAME_AFTER = 7 * DAY;
const SHORT_NAME_AFTER = 30 * DAY;  // names of 2 or 3 characters
const NEVER_CONNECTED = 7 * DAY;
const NEW_FRAMES = '0.12.0';        // sockets of this app version or newer get the new frame types
// Crockford base32: no I, L, O or U, so a code read aloud or copied by hand is hard to get wrong.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const HID_RE = /^[A-Za-z0-9_-]{22}$/;

/** A typed pairing code -> its 10 characters, or null. Case, spaces and dashes don't matter; O, I and L read as 0, 1, 1. */
export function normCode(s) {
  if (typeof s !== 'string' || s.length > 32) return null;
  const c = s.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(c) ? c : null;
}
const showCode = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;

/** The p of a signedP body, read early (before signedP itself checks it) for the fields that need an await. */
function earlyP(b) {
  if (!b || typeof b.p !== 'string' || b.p.length > 8192) return null;
  try {
    const p = JSON.parse(b.p);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

/** Leading zero bits of a digest. */
function zeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}
export const powInput = (c, ik, nonce) => `snug-pow-v1\n${c}\n${ik}\n${nonce}`;
export const registerStr = ({ ik, xk, rk, username, c, nonce, ts }) => `snug-reg-v1\nregister\n${ik}\n${xk}\n${rk}\n${username}\n${c}\n${nonce}\n${ts}`;
export const recoverStr = ({ rk, ik, xk, ts }) => `snug-reg-v1\nrecover\n${rk}\n${ik}\n${xk}\n${ts}`;
const keychangeStr = (uid, kver, ik, xk) => `snug-keychange-v1\n${uid}\n${kver}\n${ik}\n${xk}`;

export const KeyAcctMixin = {
  keyRoute(path, b, ip) {
    const m = Object.hasOwn(KEY_ROUTES, path) ? KEY_ROUTES[path] : null;
    if (!m || !keyAccountsOn(this.env)) fail('not_found');
    return this[m](b, ip);
  },

  // ---------- small reads ----------
  rkOf(uid) {
    return this.row('SELECT rk FROM recovery_keys WHERE uid=?', uid)?.rk ?? null;
  },
  viaOf(uid) {
    return this.row('SELECT via FROM pending_via WHERE uid=?', uid)?.via ?? 'github';
  },
  setVia(uid, via) {
    if (via) this.sql.exec('INSERT OR REPLACE INTO pending_via(uid, via) VALUES(?,?)', uid, via);
    else this.sql.exec('DELETE FROM pending_via WHERE uid=?', uid);
  },
  linkedGhh(uid) {
    return this.row('SELECT ghh FROM gh_links WHERE uid=?', uid)?.ghh ?? null;
  },
  /** The keypair account a GitHub account is linked to, as a raw row (accountByGhh settles it). */
  linkedAccount(ghh) {
    return this.row('SELECT a.* FROM gh_links g JOIN accounts a ON a.uid=g.uid WHERE g.ghh=?', ghh);
  },
  /** True when k is already some account's device key (current or pending) or recovery key. */
  keyInUse(k, exceptUid = null) {
    const r = this.row(`SELECT uid FROM accounts WHERE ik=? UNION SELECT uid FROM pending_rebind WHERE ik=?
      UNION SELECT uid FROM recovery_keys WHERE rk=? UNION SELECT uid FROM recovery_pending WHERE rk=? LIMIT 2`, k, k, k, k);
    return !!r && r.uid !== exceptUid;
  },
  liveCode(h) {
    return this.row('SELECT * FROM move_codes WHERE h=? AND exp>? AND done IS NULL', h, this.now());
  },
  /** A keypair account in its first 72 hours gets the smaller budgets (L.new*). */
  limitFor(acc, kind) {
    const fresh = isKeyAcc(acc) && acc.claimed_at > this.now() - NEW_FOR;
    const k = `new${kind[0].toUpperCase()}${kind.slice(1)}`;
    return fresh && this.L[k] ? this.L[k] : this.L[kind];
  },
  /** Send a frame only to the account's 0.12+ app sockets (0.11 never sees a new frame type). */
  sendNew(uid, msg) {
    for (const w of this.sockets(uid, (a) => a.mode === 'normal' && isSemver(a.v) && semverCmp(a.v, NEW_FRAMES) >= 0)) this.send(w, msg);
  },
  /** Every row of the new tables for uid (release, delete, purge). */
  dropKeyRows(uid) {
    for (const t of ['recovery_keys', 'recovery_pending', 'gh_links', 'key_meta', 'pending_via']) this.sql.exec(`DELETE FROM ${t} WHERE uid=?`, uid);
  },
  /** Delete an account outright (release with the recovery key, never-connected purge). */
  dropAccount(acc) {
    this.tx(() => {
      for (const q of ['accounts', 'keys', 'pending_rebind', 'watch']) this.sql.exec(`DELETE FROM ${q} WHERE uid=?`, acc.uid);
      this.sql.exec('DELETE FROM knocks WHERE to_uid=?', acc.uid);
      this.dropKeyRows(acc.uid);
      this.metaUpsert(acc.ghh, 'released_at', this.now());
    });
    this.closeSockets(acc.uid, () => true, 4003, 'revoked');
    this.watchCache.delete(acc.uid);
  },

  // ---------- proof of work ----------
  powBits() {
    const base = Math.min(POW_MAX, Math.max(1, Math.floor(Number(this.env.POW_BITS) || 20)));
    const n = this.budgets.value('*', 'reg', this.L.regGlobal[1]);
    return Math.min(POW_MAX, base + (n > 30 ? Math.ceil(Math.log2(n / 30)) : 0));
  },
  async powMac(exp, bits, rand) {
    return (await hmacHex(this.secret(), `pow\nregister\n${exp}\n${bits}\n${rand}`)).slice(0, 32);
  },
  async pow(b, ip) {
    this.ipLimit('ipPow', ip);
    need(b.purpose === 'register');
    const bits = this.powBits();
    const exp = this.now() + POW_TTL;
    const rand = b64u(randomBytes(16));
    return { c: `1.${exp}.${bits}.${rand}.${await this.powMac(exp, bits, rand)}`, bits, exp };
  },
  /** Checks a solved challenge (MAC, expiry, the work itself); returns its exp. Spent-ness is checked later, synchronously. */
  async powCheck(c, ik, nonce) {
    const parts = typeof c === 'string' ? c.split('.') : [];
    if (parts.length !== 5 || parts[0] !== '1') fail('pow_invalid');
    const [, e, bs, rand, mac] = parts;
    const exp = Number(e);
    const bits = Number(bs);
    if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(bits) || bits < 1 || bits > POW_MAX || !/^[A-Za-z0-9_-]{22}$/.test(rand)) fail('pow_invalid');
    if (exp <= this.now() || exp > this.now() + POW_TTL) fail('pow_invalid');
    if (mac !== await this.powMac(exp, bits, rand)) fail('pow_invalid');
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(powInput(c, ik, nonce))));
    if (zeroBits(d) < bits) fail('pow_invalid');
    return exp;
  },

  // ---------- POST /v1/register ----------
  async register(b, ip) {
    this.ipLimit('ipAccount', ip);
    this.ipLimit('ipRegister', ip);
    const { ik, xk, rk, username, c, nonce, ts, sig, rsig } = b;
    need(isKey(ik) && isKey(xk) && isKey(rk) && rk !== ik && rk !== xk && ik !== xk && isTs(ts) && isSig(sig) && isSig(rsig));
    need(typeof c === 'string' && c.length <= 200 && typeof nonce === 'string' && /^\d{1,20}$/.test(nonce));
    need(typeof username === 'string');
    if (!rawName(username)) fail('invalid_name');
    this.fresh(ts);
    const name = normalize(username);
    const ce = check(name, { owner: false });
    if (ce) fail(ce);
    // Short names are scarce: a keypair account can take one only after 30 days (at rename).
    if (name.length <= 3) fail('too_new', { what: 'short_name' });
    const skel = skeleton(name);
    if (this.reservedHit(name, skel)) fail('reserved');
    const exp = await this.powCheck(c, ik, nonce);
    const msg = registerStr({ ik, xk, rk, username, c, nonce, ts });
    if (!(await verifyEd25519(ik, sig, msg)) || !(await verifyEd25519(rk, rsig, msg))) fail('bad_signature');
    const ch = await sha256(c);
    // --- synchronous from here ---
    if (this.row('SELECT 1 AS x FROM pow_spent WHERE h=?', ch)) fail('pow_invalid');
    if (this.keyInUse(ik) || this.keyInUse(rk) || this.keyInUse(xk)) fail('key_in_use');
    if (!this.budgets.take('*', 'reg', this.L.regGlobal)) fail('rate_limited', { retryAfter: this.retryAfter(this.L.regGlobal[1]) });
    const now = this.now();
    for (let i = 0; ; i++) {
      const uid = randomId(16);
      try {
        this.tx(() => {
          this.sql.exec(
            'INSERT INTO accounts(uid,ghh,username,skel,ik,xk,kver,claimed_at,renamed_at,key_at,last_ts) VALUES(?,?,?,?,?,?,1,?,NULL,?,?)',
            uid, `a:${uid}`, name, skel, ik, xk, now, now, ts,
          );
          this.sql.exec('INSERT INTO keys(uid,kver,ik,xk,prev,at) VALUES(?,1,?,?,NULL,?)', uid, ik, xk, now);
          this.sql.exec('INSERT INTO recovery_keys(uid,rk,at) VALUES(?,?,?)', uid, rk, now);
          this.sql.exec('INSERT INTO key_meta(uid,created,first_auth,seen) VALUES(?,?,NULL,NULL)', uid, now);
          this.sql.exec('INSERT INTO pow_spent(h,exp) VALUES(?,?)', ch, exp);
        });
        this.ensureAlarm(Math.min(exp, now + NEVER_CONNECTED));
        return { account: this.view(this.row('SELECT * FROM accounts WHERE uid=?', uid)) };
      } catch (e) {
        if (!isUnique(e)) throw e;
        const m = String(e.message);
        if (/accounts\.uid/.test(m) && i < 3) continue;
        if (/recovery_keys|pow_spent/.test(m)) fail(/pow_spent/.test(m) ? 'pow_invalid' : 'key_in_use');
        fail('taken');
      }
    }
  },

  // ---------- POST /v1/recover: the old PC is lost; the recovery key starts a 72 h move ----------
  async recover(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { rk, ik, xk, ts, sig, rsig } = b;
    need(isKey(rk) && isKey(ik) && isKey(xk) && ik !== rk && ik !== xk && isTs(ts) && isSig(sig) && isSig(rsig));
    this.fresh(ts);
    const r0 = this.row('SELECT uid FROM recovery_keys WHERE rk=?', rk);
    if (!r0) fail('not_found');
    const msg = recoverStr({ rk, ik, xk, ts });
    if (!(await verifyEd25519(rk, rsig, msg)) || !(await verifyEd25519(ik, sig, msg))) fail('bad_signature');
    // --- synchronous from here ---
    const r = this.row('SELECT uid FROM recovery_keys WHERE rk=?', rk);
    const acc = r && r.uid === r0.uid ? this.accountByUid(r.uid) : null;
    if (!acc) fail('not_found');
    this.refuseBanned(acc.uid);
    if (acc.ik === ik) fail('bad_request');
    if (this.keyInUse(ik, acc.uid) || this.keyInUse(xk)) fail('key_in_use');
    const now = this.now();
    // An owner-armed recovery (admin move.force) completes this move at once, as for a GitHub-proved one.
    const forced = this.row('SELECT 1 AS x FROM move_force WHERE ghh=? AND until>?', acc.ghh, now) && this.takeMoveForce(acc.ghh);
    if (forced) {
      this.tx(() => {
        this.sql.exec('INSERT OR REPLACE INTO pending_rebind(uid,ik,xk,at,created) VALUES(?,?,?,?,?)', acc.uid, ik, xk, now, now);
        this.setVia(acc.uid, 'recovery');
        this.audit(forced.by, 'move.forced', acc.uid, { kver: acc.kver + 1 });
        this.markForcedOld(acc);
        this.markVaultRotate(acc.ghh);
      });
      this.closeSockets(acc.uid, (a) => a.mode === 'pending' || a.mode === 'xfer', 4006, 'move stopped');
      this.completeRebind(acc.uid, null);
      return { status: 'pending', uid: acc.uid, account: this.view(this.accountByUid(acc.uid)), at: now };
    }
    const meta = this.row('SELECT rebind_block_until FROM ghh_meta WHERE ghh=?', acc.ghh);
    if (meta?.rebind_block_until > now) fail('rebind_blocked', { retryAt: meta.rebind_block_until });
    const old = this.pending(acc.uid);
    const same = old && old.ik === ik && old.xk === xk;
    const at = same ? old.at : now + REBIND_DELAY;
    this.tx(() => {
      this.sql.exec('INSERT OR REPLACE INTO pending_rebind(uid,ik,xk,at,created) VALUES(?,?,?,?,?)', acc.uid, ik, xk, at, same ? old.created : now);
      this.setVia(acc.uid, 'recovery');
    });
    if (old && !same) this.closeSockets(acc.uid, (a) => a.mode === 'pending' || (a.mode === 'xfer' && a.ik === old.ik), 4006, 'move stopped');
    if (!same) {
      // The existing frame, unchanged: a 0.12 app asks /v1/account/kind how the move started.
      const m = { t: 'rebind', state: 'pending', at, kver: acc.kver + 1, ik, xk };
      for (const w of this.sockets(acc.uid, (a) => a.mode === 'normal')) this.send(w, m);
    }
    this.ensureAlarm(at);
    return { status: 'pending', uid: acc.uid, account: this.view(acc), at };
  },

  // ---------- pairing code: "my other PC is here" ----------
  async moveHello(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { ik, xk, ts, sig } = b;
    need(isKey(ik) && isKey(xk) && ik !== xk && isTs(ts) && isSig(sig));
    this.fresh(ts);
    if (!(await verifyEd25519(ik, sig, `snug-reg-v1\nmove-hello\n${ik}\n${xk}\n${ts}`))) fail('bad_signature');
    const code = randomId(10, CROCKFORD);
    const hid = b64u(randomBytes(16));
    const h = await sha256(code);
    // --- synchronous from here ---
    if (this.keyInUse(ik) || this.keyInUse(xk)) fail('key_in_use');
    const exp = this.now() + MOVE_CODE_TTL;
    this.tx(() => {
      this.sql.exec('DELETE FROM move_codes WHERE ik=? AND done IS NULL', ik); // one live code per new PC
      this.sql.exec('INSERT INTO move_codes(h,hid,ik,xk,exp,tries,uid,done) VALUES(?,?,?,?,?,0,NULL,NULL)', h, hid, ik, xk, exp);
    });
    this.ensureAlarm(exp);
    return { code: showCode(code), hid, exp };
  },

  async moveWait(b, ip) {
    this.ipLimit('ipMoveWait', ip);
    const { hid, ts, sig } = b;
    need(typeof hid === 'string' && HID_RE.test(hid) && isTs(ts) && isSig(sig));
    this.fresh(ts);
    const s = this.win.hit(`moveWait|${hid}`, this.L.moveWait);
    if (s) fail('rate_limited', { retryAfter: s });
    const row0 = this.row('SELECT ik FROM move_codes WHERE hid=?', hid);
    if (!row0) return { state: 'expired' };
    if (!(await verifyEd25519(row0.ik, sig, `snug-reg-v1\nmove-wait\n${hid}\n${ts}`))) fail('bad_signature');
    // --- synchronous from here ---
    const row = this.row('SELECT * FROM move_codes WHERE hid=?', hid);
    if (!row || row.ik !== row0.ik) return { state: 'expired' };
    if (row.done && row.uid) {
      const acc = this.accountByUid(row.uid);
      return acc && acc.ik === row.ik ? { state: 'done', account: this.view(acc) } : { state: 'expired' };
    }
    return row.exp > this.now() ? { state: 'waiting' } : { state: 'expired' };
  },

  /** The old PC reads the new PC's keys for a typed code (it shows their security code before moving). */
  async movePeek(b, ip) {
    this.ipLimit('ipAccount', ip);
    const code = normCode(earlyP(b)?.code);
    if (!code) fail('not_found');
    const h = await sha256(code);
    return this.signedP(b, 'move-peek', { mutating: false }, (acc) => {
      this.refuseBanned(acc.uid);
      if (!this.budgets.take(acc.uid, 'movePeek', this.L.movePeek)) fail('rate_limited', { retryAfter: this.retryAfter(this.L.movePeek[1]) });
      const row = this.liveCode(h);
      if (!row) fail('not_found');
      if (row.tries >= MOVE_TRIES) {
        this.sql.exec('DELETE FROM move_codes WHERE h=?', h);
        fail('not_found');
      }
      this.sql.exec('UPDATE move_codes SET tries=tries+1 WHERE h=?', h);
      if (row.ik === acc.ik) fail('bad_request');
      if (this.keyInUse(row.ik)) fail('key_in_use');
      return { ik: row.ik, xk: row.xk, kver: acc.kver + 1 };
    });
  },

  /**
   * The old PC moves the account now: p = {code, prev, knock?}. prev is its signature over the new keys (as
   * /v1/rebind/approve), so friends see a quiet, verified key change. knock = {id, box}: the restore list for
   * the new PC (a self-knock, as peer.approveRebind() sends while a move is pending), stored in the same step.
   */
  async moveAccept(b, ip) {
    this.ipLimit('ipAccount', ip);
    const pre = earlyP(b);
    const code = normCode(pre?.code);
    need(code && isSig(pre.prev) && isUid(b.uid));
    const knock = pre.knock;
    if (knock !== undefined) need(knock && typeof knock.id === 'string' && ID_RE.test(knock.id) && typeof knock.box === 'string' && knock.box.length <= MAX_KNOCK_BOX);
    const h = await sha256(code);
    const acc0 = this.accountByUid(b.uid);
    const row0 = this.liveCode(h);
    if (!acc0 || !row0) fail('not_found');
    if (!(await verifyEd25519(acc0.ik, pre.prev, keychangeStr(acc0.uid, acc0.kver + 1, row0.ik, row0.xk)))) fail('bad_signature');
    return this.signedP(b, 'move-accept', { mutating: true }, (acc) => {
      if (acc.ik !== acc0.ik || acc.kver !== acc0.kver) fail('bad_signature');
      this.refuseBanned(acc.uid);
      const row = this.liveCode(h);
      if (!row || row.ik !== row0.ik || row.xk !== row0.xk) fail('not_found');
      if (row.ik === acc.ik) fail('bad_request');
      if (this.keyInUse(row.ik)) fail('key_in_use');
      const old = this.pending(acc.uid);
      const now = this.now();
      this.tx(() => {
        this.sql.exec('INSERT OR REPLACE INTO pending_rebind(uid,ik,xk,at,created) VALUES(?,?,?,?,?)', acc.uid, row.ik, row.xk, now, now);
        this.setVia(acc.uid, 'code');
        // done rows stay a little longer, so the new PC's next wait still finds them
        this.sql.exec('UPDATE move_codes SET uid=?, done=?, exp=? WHERE h=?', acc.uid, now, Math.max(row.exp, now + MOVE_CODE_TTL), h);
        if (knock) {
          this.sql.exec('DELETE FROM knocks WHERE to_uid=? AND frm=?', acc.uid, acc.uid);
          this.sql.exec('INSERT INTO knocks(to_uid,frm,id,box,ts) VALUES(?,?,?,?,?)', acc.uid, acc.uid, knock.id, knock.box, now);
        }
      });
      if (knock) this.ensureAlarm(now + KNOCK_TTL);
      if (old && old.ik !== row.ik) this.closeSockets(acc.uid, (a) => a.mode === 'pending' || (a.mode === 'xfer' && a.ik === old.ik), 4006, 'move stopped');
      this.completeRebind(acc.uid, pre.prev);
      return { ok: true };
    });
  },

  // ---------- recovery key rotation ----------
  /** p = {rk, rsigNew, rsigOld?}: both rsigs over "snug-reg-v1\nrecovery-set\n<uid>\n<rk>\n<ts>". */
  async recoverySet(b, ip) {
    this.ipLimit('ipAccount', ip);
    const pre = earlyP(b);
    need(pre && isKey(pre.rk) && isSig(pre.rsigNew) && (pre.rsigOld === undefined || isSig(pre.rsigOld)) && isUid(b.uid) && isTs(b.ts));
    const msg = `snug-reg-v1\nrecovery-set\n${b.uid}\n${pre.rk}\n${b.ts}`;
    if (!(await verifyEd25519(pre.rk, pre.rsigNew, msg))) fail('bad_signature');
    const cur0 = this.rkOf(b.uid);
    const withOld = pre.rsigOld !== undefined;
    if (withOld && (!cur0 || !(await verifyEd25519(cur0, pre.rsigOld, msg)))) fail('bad_signature');
    return this.signedP(b, 'recovery-set', { mutating: true }, (acc) => {
      this.refuseBanned(acc.uid);
      const cur = this.rkOf(acc.uid);
      if (cur !== cur0) fail('bad_signature');
      if (pre.rk === acc.ik || this.keyInUse(pre.rk)) fail('key_in_use');
      const p = this.pending(acc.uid);
      const recMove = !!p && this.viaOf(acc.uid) === 'recovery';
      // Without the old key, a device can't replace it while someone's recovery move is waiting.
      if (cur && !withOld && recMove) fail('move_pending');
      if (!this.budgets.take(acc.uid, 'recSet', this.L.recSet)) fail('rate_limited', { retryAfter: this.retryAfter(this.L.recSet[1]) });
      const now = this.now();
      if (!cur || withOld) {
        this.tx(() => {
          this.sql.exec('INSERT OR REPLACE INTO recovery_keys(uid,rk,at) VALUES(?,?,?)', acc.uid, pre.rk, now);
          this.sql.exec('DELETE FROM recovery_pending WHERE uid=?', acc.uid);
          // The device and the old key together end a move someone started with a copy of that key.
          if (recMove) {
            this.sql.exec('DELETE FROM pending_rebind WHERE uid=?', acc.uid);
            this.setVia(acc.uid, null);
          }
        });
        if (recMove) {
          this.closeSockets(acc.uid, (a) => a.mode === 'pending' || (a.mode === 'xfer' && a.ik === p.ik), 4006, 'move stopped');
          for (const w of this.sockets(acc.uid, (a) => a.mode === 'normal')) this.send(w, { t: 'rebind', state: 'stopped' });
        }
        return { state: 'set' };
      }
      const at = now + RECOVERY_DELAY;
      this.sql.exec('INSERT OR REPLACE INTO recovery_pending(uid,rk,at,created) VALUES(?,?,?,?)', acc.uid, pre.rk, at, now);
      this.sendNew(acc.uid, { t: 'recovery', state: 'pending', at });
      this.ensureAlarm(at);
      return { state: 'pending', at };
    });
  },

  /** The current recovery key stops a new one set by the device alone. */
  async recoveryCancel(b, ip) {
    this.ipLimit('ipAccount', ip);
    const { uid, ts, rsig } = b;
    need(isUid(uid) && isTs(ts) && isSig(rsig));
    this.fresh(ts);
    const cur0 = this.rkOf(uid);
    if (!cur0) fail('not_found');
    if (!(await verifyEd25519(cur0, rsig, `snug-reg-v1\nrecovery-cancel\n${uid}\n${ts}`))) fail('bad_signature');
    // --- synchronous from here ---
    const acc = this.accountByUid(uid);
    if (!acc || this.rkOf(uid) !== cur0) fail('bad_signature');
    if (ts <= acc.last_ts) fail('stale');
    this.tx(() => {
      this.sql.exec('UPDATE accounts SET last_ts=? WHERE uid=?', ts, uid);
      this.sql.exec('DELETE FROM recovery_pending WHERE uid=?', uid);
    });
    this.sendNew(uid, { t: 'recovery', state: 'cancelled' });
    return { ok: true };
  },

  // ---------- an optional GitHub link ----------
  /** p = {ticket}: a fresh /v1/auth/github ticket (status new) issued to this account's current key. */
  async linkGithub(b, ip) {
    this.ipLimit('ipAccount', ip);
    const pre = earlyP(b);
    need(pre && isKey(pre.ticket));
    const h = await sha256(pre.ticket);
    return this.signedP(b, 'link-github', { mutating: true }, (acc) => {
      this.refuseBanned(acc.uid);
      if (!isKeyAcc(acc)) fail('bad_request');
      const t = this.ticket(h);
      if (!t || t.ik !== acc.ik) fail('bad_ticket');
      if (t.owner) fail('forbidden'); // the owner's GitHub account stays a GitHub account
      if (this.accountByGhh(t.ghh)) fail('already_claimed');
      try {
        this.tx(() => {
          this.sql.exec('INSERT OR REPLACE INTO gh_links(uid,ghh,at) VALUES(?,?,?)', acc.uid, t.ghh, this.now());
          this.sql.exec('DELETE FROM tickets WHERE h=?', h);
        });
      } catch (e) {
        if (isUnique(e)) fail('already_claimed');
        throw e;
      }
      return { ok: true };
    });
  },
  async unlinkGithub(b, ip) {
    this.ipLimit('ipAccount', ip);
    return this.signedP(b, 'unlink-github', { mutating: true }, (acc) => {
      this.sql.exec('DELETE FROM gh_links WHERE uid=?', acc.uid);
      return { ok: true };
    });
  },

  // ---------- delete with the recovery key (frees the name) ----------
  async releaseKey(b, ip) {
    this.ipLimit('ipAccount', ip);
    need(isUid(b.uid) && isTs(b.ts) && typeof b.p === 'string' && isSig(b.rsig));
    const cur0 = this.rkOf(b.uid);
    if (!cur0) fail('not_found');
    if (!(await verifyEd25519(cur0, b.rsig, `snug-reg-v1\nrelease-key\n${b.uid}\n${b.ts}\n${b.p}`))) fail('bad_signature');
    return this.signedP(b, 'release-key', { mutating: true }, (acc) => {
      this.refuseBanned(acc.uid);
      if (this.rkOf(acc.uid) !== cur0) fail('bad_signature');
      this.dropAccount(acc);
      return { ok: true };
    });
  },

  async accountKind(b, ip) {
    this.ipLimit('ipLookup', ip);
    return this.signedP(b, 'account-kind', { mutating: false }, (acc) => {
      const rp = this.row('SELECT at FROM recovery_pending WHERE uid=?', acc.uid);
      const p = this.pending(acc.uid);
      return {
        kind: isKeyAcc(acc) ? 'key' : 'github',
        recovery: { set: !!this.rkOf(acc.uid), pendingAt: rp?.at ?? null },
        github: { linked: isKeyAcc(acc) ? !!this.linkedGhh(acc.uid) : true },
        move: p ? { via: this.viaOf(acc.uid), at: p.at } : null,
      };
    });
  },

  // ---------- hooks called from hub.js ----------
  /**
   * After a move completed. An unapproved one (prev null: the 72 h timer or a forced move) means the two
   * proofs disagreed, and the one that started the move won: a recovery move drops a linked GitHub, a GitHub
   * move drops a GitHub account's recovery key. Either way the data file key rotates (the device left behind
   * may be in the wrong hands). 0.11 clients don't see any of this.
   */
  afterMove(acc, prev) {
    const via = this.viaOf(acc.uid);
    if (!prev) {
      if (isKeyAcc(acc) && via === 'recovery') this.sql.exec('DELETE FROM gh_links WHERE uid=?', acc.uid);
      if (!isKeyAcc(acc) && via === 'github') {
        this.sql.exec('DELETE FROM recovery_keys WHERE uid=?', acc.uid);
        this.sql.exec('DELETE FROM recovery_pending WHERE uid=?', acc.uid);
      }
      this.markVaultRotate(acc.ghh);
    }
    this.setVia(acc.uid, null);
  },
  /** A normal socket authenticated: abuse bookkeeping, and the frames only 0.12 understands. */
  afterReady(ws, acc, v) {
    if (isKeyAcc(acc)) {
      const t = this.now();
      const m = this.row('SELECT first_auth, seen FROM key_meta WHERE uid=?', acc.uid);
      if (m && (!m.first_auth || !m.seen || t - m.seen > DAY)) {
        this.sql.exec('UPDATE key_meta SET first_auth=COALESCE(first_auth, ?), seen=? WHERE uid=?', t, t, acc.uid);
      }
    }
    if (!isSemver(v) || semverCmp(v, NEW_FRAMES) < 0) return;
    const rp = this.row('SELECT at FROM recovery_pending WHERE uid=?', acc.uid);
    if (rp) this.send(ws, { t: 'recovery', state: 'pending', at: rp.at });
  },
  /** Keypair names: the first rename after 7 days, a name of 2 or 3 characters after 30. */
  keyRenameRule(acc, name) {
    if (!isKeyAcc(acc)) return;
    const t = this.now();
    if (!acc.renamed_at && t < acc.claimed_at + FIRST_RENAME_AFTER) fail('too_new', { retryAt: acc.claimed_at + FIRST_RENAME_AFTER });
    if (name.length <= 3 && t < acc.claimed_at + SHORT_NAME_AFTER) fail('too_new', { retryAt: acc.claimed_at + SHORT_NAME_AFTER, what: 'short_name' });
  },
  /** Alarm work for the new tables; returns the next time it needs the alarm (or Infinity). */
  keySweep(t) {
    for (const r of this.rows('SELECT uid, rk FROM recovery_pending WHERE at<=?', t)) {
      try {
        this.tx(() => {
          this.sql.exec('INSERT OR REPLACE INTO recovery_keys(uid,rk,at) VALUES(?,?,?)', r.uid, r.rk, t);
          this.sql.exec('DELETE FROM recovery_pending WHERE uid=?', r.uid);
        });
        this.sendNew(r.uid, { t: 'recovery', state: 'set' });
      } catch (e) {
        if (!isUnique(e)) throw e;
        this.sql.exec('DELETE FROM recovery_pending WHERE uid=?', r.uid); // that key went to someone else meanwhile
      }
    }
    this.sql.exec('DELETE FROM move_codes WHERE exp<=?', t);
    this.sql.exec('DELETE FROM pow_spent WHERE exp<=?', t);
    // Accounts whose device never connected within 7 days free their names. Banned ones are kept.
    const gone = this.rows(`SELECT a.* FROM key_meta m JOIN accounts a ON a.uid=m.uid
      WHERE m.first_auth IS NULL AND m.created<=? AND m.uid NOT IN (SELECT uid FROM bans) LIMIT 200`, t - NEVER_CONNECTED);
    const idleDays = Number(this.env.KEY_ACCOUNT_IDLE_DAYS) || 0;
    if (idleDays > 0) {
      gone.push(...this.rows(`SELECT a.* FROM key_meta m JOIN accounts a ON a.uid=m.uid
        WHERE m.seen IS NOT NULL AND m.seen<=? AND m.uid NOT IN (SELECT uid FROM bans) LIMIT 200`, t - idleDays * DAY)
        .filter((a) => !this.normalSocket(a.uid)));
    }
    for (const a of gone) this.dropAccount(a);
    const r = this.row(`SELECT (SELECT MIN(at) FROM recovery_pending) AS rp, (SELECT MIN(exp) FROM move_codes) AS mc,
      (SELECT MIN(exp) FROM pow_spent) AS ps, (SELECT MIN(created) FROM key_meta WHERE first_auth IS NULL) AS kc`);
    let next = Infinity;
    for (const v of [r.rp, r.mc, r.ps, r.kc == null ? null : r.kc + NEVER_CONNECTED]) if (v != null) next = Math.min(next, v);
    return next;
  },
};

// Not used by the Hub itself; exported for tests that need the same numbers.
export const KEY_TIMES = { POW_TTL, MOVE_CODE_TTL, MOVE_TRIES, RECOVERY_DELAY, NEW_FOR, FIRST_RENAME_AFTER, SHORT_NAME_AFTER, NEVER_CONNECTED, REBIND_DELAY, REBIND_BLOCK };
