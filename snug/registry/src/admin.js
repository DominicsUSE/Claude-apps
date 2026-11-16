// v0.10 admin: permissions, bans and timeouts, reserved names, announcements, the minimum app version and
// the audit log. Mixed into Hub.prototype (hub.js). Every call is signed by the admin's current device key
// with a monotonic ts (POST /v1/admin, op "admin"); the app's admin panel is only a view of this.
//
// Owner = the account whose GitHub id is in OWNER_GITHUB_IDS: every right, plus granting rights.
// Rules: only the owner grants or revokes; nobody acts on the owner; only the owner acts on an admin;
// an admin can't change their own rights or ban themselves.
import { check, normalize, skeleton, SHORT_NAMES } from '../../js/lib/usernames.js';
import { randomId } from './crypto.js';
import { fail, need, isUid, isKey, rawName, isUnique, isSemver, semverCmp } from './common.js';
import { DAY } from './limits.js';
import { normFp } from './keyacct.js';

export const ADMIN_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS admins (uid TEXT PRIMARY KEY, perms TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS bans (uid TEXT PRIMARY KEY, until INTEGER, reason TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS reserved (name TEXT PRIMARY KEY, skel TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '',
    by TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, text TEXT NOT NULL, level TEXT NOT NULL, at INTEGER NOT NULL,
    until INTEGER, by TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, a TEXT NOT NULL,
    target TEXT, detail TEXT NOT NULL DEFAULT '{}')`,
  // Vault keys (vaultkey.js): one per GitHub account, wrapped at rest. Kept on release and renames.
  'CREATE TABLE IF NOT EXISTS vault_keys (ghh TEXT PRIMARY KEY, k TEXT NOT NULL, kid INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL)',
  // sec-registry REG-M2: an owner-armed forced move: the account's next GitHub-proved move completes at once.
  'CREATE TABLE IF NOT EXISTS move_force (ghh TEXT PRIMARY KEY, until INTEGER NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)',
  // ... and the key it moved away from (the stolen device) gets no 'old' xfer role: it hands nothing over.
  'CREATE TABLE IF NOT EXISTS forced_old (uid TEXT NOT NULL, ik TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (uid, ik))',
];
const FORCE_FOR = 7 * DAY;

export const PERMS = ['stats', 'names', 'ban', 'ann', 'update'];
const ALL = [...PERMS, 'grant'];
const AUDIT_KEEP = 5000;
// sec-registry hardening: high-impact actions are not part of the 5000-row rotation (an admin can't push their
// own bans or renames out with reserve/unreserve spam); they are kept for a year instead.
const AUDIT_KEEP_HIGH_MS = 365 * DAY;
const HIGH_IMPACT = ['ban', 'unban', 'admin.grant', 'admin.revoke', 'min.set', 'name.rename', 'name.free', 'move.force', 'move.forced', 'vault.export'];
const ANN_MAX = 5;
const MAX_UNTIL = 10 * 365 * DAY;

// action -> the permission it needs ('any' = every account, admins or not). Reads are not audited.
const ACTIONS = {
  me: { perm: 'any', read: true },
  stats: { perm: 'stats', read: true },
  'user.find': { perm: ['names', 'ban'] },
  'name.rename': { perm: 'names' },
  'name.free': { perm: 'names' },
  'name.reserve': { perm: 'names' },
  'name.unreserve': { perm: 'names' },
  'name.reserved': { perm: 'names', read: true },
  ban: { perm: 'ban' },
  unban: { perm: 'ban' },
  bans: { perm: 'ban', read: true },
  'ann.add': { perm: 'ann' },
  'ann.remove': { perm: 'ann' },
  'min.set': { perm: 'update' },
  'admin.grant': { perm: 'grant' },
  'admin.revoke': { perm: 'grant' },
  admins: { perm: 'grant', read: true },
  audit: { perm: 'stats', read: true },
  // sec-registry REG-M2: account recovery when the current device is stolen (its key can cancel every move,
  // and release needs it). Owner only ('grant' is never given to admins), audited, on a GitHub-proved move.
  'move.force': { perm: 'grant' },
  // sec-registry REG-L6: an owner-only, audited copy of the vault key rows, still wrapped under the registry
  // secret (useless without it), so losing the Hub DO doesn't make every data file unreadable.
  'vault.export': { perm: 'grant' },
};

const skelOf = (n) => (SHORT_NAMES.includes(n) ? `#${n}` : skeleton(n));
const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '').slice(0, max + 1);

export const AdminMixin = {
  // ---------- reads used across the Hub ----------
  /** The active ban of uid, or null. Expired timeouts are deleted on sight. */
  banOf(uid) {
    const b = this.row('SELECT uid, until, reason, by, at FROM bans WHERE uid=?', uid);
    if (!b) return null;
    if (b.until != null && b.until <= this.now()) {
      this.sql.exec('DELETE FROM bans WHERE uid=?', uid);
      return null;
    }
    return b;
  },
  refuseBanned(uid) {
    const b = this.banOf(uid);
    if (b) fail('banned', { until: b.until ?? null, reason: b.reason });
  },
  reservedHit(name, skel) {
    return !!this.row('SELECT 1 AS x FROM reserved WHERE name=? OR skel=?', name, skel);
  },
  minVersion() {
    return this.noticeState().min;
  },
  /** True when app version v (missing = oldest) is below min. */
  below(v, min) {
    return !!min && (!isSemver(v) || semverCmp(v, min) < 0);
  },
  /** Rights of an account (needs owners() to have run once; onAuth and admin() await it first). */
  permsOfSync(acc) {
    if (!acc) return [];
    if ((this.ownerHashes || []).includes(acc.ghh)) return ALL.slice();
    const r = this.row('SELECT perms FROM admins WHERE uid=?', acc.uid);
    if (!r) return [];
    try {
      return JSON.parse(r.perms).filter((p) => PERMS.includes(p));
    } catch {
      return [];
    }
  },
  isOwnerAcc(acc) {
    return !!acc && (this.ownerHashes || []).includes(acc.ghh);
  },

  // ---------- notices: announcements + minimum version (memory cache) ----------
  noticeState() {
    if (!this._notices) {
      const min = this.row("SELECT v FROM settings WHERE k='min_version'")?.v || null;
      const ann = this.rows('SELECT id, text, level, at, until FROM announcements ORDER BY at, id')
        .map((r) => ({ id: r.id, text: r.text, level: r.level, at: r.at, until: r.until ?? null }));
      this._notices = { min, ann };
    }
    return this._notices;
  },
  notices() {
    const t = this.now();
    const s = this.noticeState();
    return { min: s.min, ann: s.ann.filter((a) => a.until == null || a.until > t) };
  },
  noticesHttp(ip) {
    this.ipLimit('ipCheck', ip);
    return this.notices();
  },
  /** Every app socket (normal and pending) gets the new notices. */
  broadcastNotices() {
    this._notices = null;
    const msg = { t: 'notices', ...this.notices() };
    for (const w of this.ctx.getWebSockets()) {
      if (w.readyState !== 1 || this.gone.has(w)) continue;
      const a = this.att(w);
      if (a && a.authed && (a.mode === 'normal' || a.mode === 'pending')) this.send(w, msg);
    }
  },
  adminSweep(t) {
    this.sql.exec('DELETE FROM bans WHERE until IS NOT NULL AND until<=?', t);
    this.sql.exec('DELETE FROM move_force WHERE until<=?', t);
    this.sql.exec('DELETE FROM move_force_key WHERE ghh NOT IN (SELECT ghh FROM move_force)');
    this.sql.exec('DELETE FROM forced_old WHERE until<=?', t);
    const gone = this.sql.exec('DELETE FROM announcements WHERE until IS NOT NULL AND until<=?', t).rowsWritten;
    if (gone) this._notices = null;
  },

  // ---------- POST /v1/admin ----------
  async admin(b, ip) {
    this.ipLimit('ipAdmin', ip);
    await this.owners();
    const pendFp = await this.pendingFpFor(b); // move.force {fp}: the waiting move's security code (keyacct.js)
    return this.signedP(b, 'admin', { mutating: true }, (acc, d) => {
      need(typeof d.a === 'string' && Object.hasOwn(ACTIONS, d.a));
      const spec = ACTIONS[d.a];
      const perms = this.permsOfSync(acc);
      if (d.a === 'me') return { perms };
      if (!this.budgets.take(acc.uid, 'admin', this.L.adminDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
      const wanted = [].concat(spec.perm);
      if (!wanted.some((p) => perms.includes(p))) fail('forbidden');
      this.refuseBanned(acc.uid);
      const ctx = { acc, owner: this.isOwnerAcc(acc), target: null, detail: null, pendFp };
      const out = this.tx(() => {
        const r = this[`adm_${d.a.replace('.', '_')}`](d, ctx);
        if (!spec.read) this.audit(acc.uid, d.a, ctx.target, ctx.detail ?? argsOf(d));
        return r;
      });
      ctx.after?.();
      return out;
    });
  },

  audit(by, a, target, detail) {
    let s = JSON.stringify(detail || {});
    if (s.length > 1000) s = JSON.stringify({ cut: s.slice(0, 990) });
    this.sql.exec('INSERT INTO audit(at, by, a, target, detail) VALUES(?,?,?,?,?)', this.now(), by, a, target ?? null, s);
    const high = HIGH_IMPACT.map(() => '?').join(',');
    this.sql.exec(`DELETE FROM audit WHERE a NOT IN (${high}) AND id <= (SELECT MAX(id) FROM audit) - ?`, ...HIGH_IMPACT, AUDIT_KEEP);
    this.sql.exec(`DELETE FROM audit WHERE a IN (${high}) AND at < ?`, ...HIGH_IMPACT, this.now() - AUDIT_KEEP_HIGH_MS);
  },

  /** The target account by uid, with the owner/admin rules applied. */
  targetAcc(uid, ctx, { self = false } = {}) {
    need(isUid(uid));
    const t = this.accountByUid(uid);
    if (!t) fail('not_found');
    if (this.isOwnerAcc(t)) fail('forbidden');
    if (!self && t.uid === ctx.acc.uid) fail('bad_request');
    if (!ctx.owner && this.row('SELECT 1 AS x FROM admins WHERE uid=?', t.uid)) fail('forbidden');
    ctx.target = t.uid;
    return t;
  },
  accountFrame(uid, username) {
    for (const w of this.sockets(uid, (a) => a.mode === 'normal')) this.send(w, { t: 'account', username });
  },
  nameOf(uid) {
    return this.row('SELECT username FROM accounts WHERE uid=?', uid)?.username ?? null;
  },

  // ---------- actions ----------
  adm_stats() {
    const t = this.now();
    const n = (q, ...b) => Number(this.row(q, ...b).n);
    let online = 0;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.readyState === 1 && !this.gone.has(w) && this.att(w);
      if (a && a.authed && a.mode === 'normal') online++;
    }
    const req = Math.round(this.budgets.value('*', 'req20', DAY) / 20);
    const off = Number(this.env.RELAY_OFF_AT) || 60000;
    return {
      accounts: n('SELECT COUNT(*) AS n FROM accounts'),
      new24h: n('SELECT COUNT(*) AS n FROM accounts WHERE claimed_at>?', t - DAY),
      new7d: n('SELECT COUNT(*) AS n FROM accounts WHERE claimed_at>?', t - 7 * DAY),
      online,
      bans: n('SELECT COUNT(*) AS n FROM bans WHERE until IS NULL OR until>?', t),
      admins: n('SELECT COUNT(*) AS n FROM admins'),
      knocks: n('SELECT COUNT(*) AS n FROM knocks'),
      reqToday: req,
      relayOff: req > off,
    };
  },

  adm_user_find(d, ctx) {
    need(typeof d.q === 'string' && d.q.length <= 40);
    const q = d.q.trim().replace(/^@/, '');
    let acc = null;
    if (isUid(q)) acc = this.accountByUid(q);
    if (!acc && rawName(q)) acc = this.accountByName(normalize(q));
    if (!acc) fail('not_found');
    ctx.target = acc.uid;
    const ban = this.banOf(acc.uid);
    return {
      uid: acc.uid, username: acc.username, claimedAt: acc.claimed_at, renamedAt: acc.renamed_at ?? null, kver: acc.kver,
      ban: ban ? { until: ban.until ?? null, reason: ban.reason, at: ban.at, by: this.nameOf(ban.by) } : null,
      perms: this.permsOfSync(acc), owner: this.isOwnerAcc(acc),
    };
  },

  adm_name_rename(d, ctx) {
    const t = this.targetAcc(d.uid, ctx);
    need(typeof d.name === 'string');
    if (!rawName(d.name)) fail('invalid_name');
    const name = normalize(d.name);
    if (name === t.username) return { uid: t.uid, username: name };
    const ce = check(name, { owner: false });
    if (ce && ce !== 'reserved') fail(ce); // an admin may hand out a reserved name
    const skel = skelOf(name);
    try {
      this.sql.exec('UPDATE accounts SET username=?, skel=?, renamed_at=? WHERE uid=?', name, skel, this.now(), t.uid);
    } catch (e) {
      if (isUnique(e)) fail('taken');
      throw e;
    }
    this.sql.exec('DELETE FROM reserved WHERE name=? OR skel=?', name, skel);
    ctx.detail = { from: t.username, to: name };
    ctx.after = () => this.accountFrame(t.uid, name);
    return { uid: t.uid, username: name };
  },

  adm_name_free(d, ctx) {
    need(typeof d.name === 'string');
    if (!rawName(d.name)) fail('not_found');
    const name = normalize(d.name);
    ctx.target = name;
    if (this.sql.exec('DELETE FROM reserved WHERE name=?', name).rowsWritten) return { freed: 'reserved', name };
    const held = this.accountByName(name);
    if (!held) fail('not_found');
    const t = this.targetAcc(held.uid, ctx);
    for (const nn of [`u${t.uid.slice(0, 8)}`, `u${t.uid}`]) {
      try {
        this.sql.exec('UPDATE accounts SET username=?, skel=?, renamed_at=NULL WHERE uid=?', nn, skeleton(nn), t.uid);
        this.metaUpsert(t.ghh, 'renamed_at', null);
        ctx.detail = { name, to: nn };
        ctx.after = () => this.accountFrame(t.uid, nn);
        return { freed: 'account', name, uid: t.uid, username: nn };
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
    }
    return fail('taken');
  },

  adm_name_reserve(d, ctx) {
    need(typeof d.name === 'string');
    if (!rawName(d.name)) fail('invalid_name');
    const name = normalize(d.name);
    const ce = check(name, { owner: true });
    if (ce === 'invalid_name') fail(ce);
    const skel = skelOf(name);
    if (this.row('SELECT 1 AS x FROM accounts WHERE username=? OR skel=?', name, skel)) fail('taken');
    const note = cleanText(d.note ?? '', 200);
    need(note.length <= 200);
    try {
      this.sql.exec('INSERT INTO reserved(name, skel, note, by, at) VALUES(?,?,?,?,?)', name, skel, note, ctx.acc.uid, this.now());
    } catch (e) {
      if (isUnique(e)) fail('taken');
      throw e;
    }
    ctx.target = name;
    return { name, note };
  },

  adm_name_unreserve(d, ctx) {
    need(typeof d.name === 'string');
    const name = rawName(d.name) ? normalize(d.name) : '';
    if (!name || !this.sql.exec('DELETE FROM reserved WHERE name=?', name).rowsWritten) fail('not_found');
    ctx.target = name;
    return { ok: true };
  },

  adm_name_reserved() {
    return {
      reserved: this.rows('SELECT name, note, by, at FROM reserved ORDER BY name LIMIT 1000')
        .map((r) => ({ name: r.name, note: r.note, at: r.at, by: this.nameOf(r.by) })),
    };
  },

  adm_ban(d, ctx) {
    const t = this.targetAcc(d.uid, ctx);
    const reason = cleanText(d.reason, 200);
    need(reason.length >= 1 && reason.length <= 200);
    const now = this.now();
    const until = d.until ?? null;
    need(until === null || (Number.isSafeInteger(until) && until > now && until <= now + MAX_UNTIL));
    this.sql.exec(
      'INSERT INTO bans(uid, until, reason, by, at) VALUES(?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET until=excluded.until, reason=excluded.reason, by=excluded.by, at=excluded.at',
      t.uid, until, reason, ctx.acc.uid, now,
    );
    if (until) this.ensureAlarm(until);
    // sec-registry hardening: knocks the banned account left in other people's inboxes go too (except its own).
    this.sql.exec('DELETE FROM knocks WHERE frm=? AND to_uid<>?', t.uid, t.uid);
    ctx.detail = { reason, until };
    ctx.after = () => {
      for (const w of this.sockets(t.uid, (a) => a.mode === 'normal' || a.mode === 'pending')) {
        this.send(w, { t: 'banned', until, reason });
        this.closeWs(w, 4010, 'banned');
      }
    };
    return { uid: t.uid, username: t.username, ban: { until, reason, at: now } };
  },

  adm_unban(d, ctx) {
    const t = this.targetAcc(d.uid, ctx);
    const n = this.sql.exec('DELETE FROM bans WHERE uid=?', t.uid).rowsWritten;
    return { ok: true, was: n > 0 };
  },

  adm_bans() {
    const t = this.now();
    return {
      bans: this.rows(`SELECT b.uid, b.until, b.reason, b.by, b.at, a.username FROM bans b LEFT JOIN accounts a ON a.uid=b.uid
        WHERE b.until IS NULL OR b.until>? ORDER BY b.at DESC LIMIT 500`, t)
        .map((r) => ({ uid: r.uid, username: r.username ?? null, until: r.until ?? null, reason: r.reason, at: r.at, by: this.nameOf(r.by) })),
    };
  },

  adm_ann_add(d, ctx) {
    const text = cleanText(d.text, 500);
    need(text.length >= 1 && text.length <= 500);
    const level = d.level ?? 'info';
    need(level === 'info' || level === 'warn');
    const now = this.now();
    const until = d.until ?? null;
    need(until === null || (Number.isSafeInteger(until) && until > now && until <= now + MAX_UNTIL));
    if (this.notices().ann.length >= ANN_MAX) fail('bad_request', { message: `At most ${ANN_MAX} announcements at a time.` });
    const id = randomId(12);
    this.sql.exec('INSERT INTO announcements(id, text, level, at, until, by) VALUES(?,?,?,?,?,?)', id, text, level, now, until, ctx.acc.uid);
    if (until) this.ensureAlarm(until);
    this._notices = null;
    ctx.target = id;
    ctx.detail = { text: text.slice(0, 200), level, until };
    ctx.after = () => this.broadcastNotices();
    return { id, ann: this.notices().ann };
  },

  adm_ann_remove(d, ctx) {
    need(typeof d.id === 'string' && d.id.length <= 64);
    if (!this.sql.exec('DELETE FROM announcements WHERE id=?', d.id).rowsWritten) fail('not_found');
    this._notices = null;
    ctx.target = d.id;
    ctx.after = () => this.broadcastNotices();
    return { ann: this.notices().ann };
  },

  adm_min_set(d, ctx) {
    const v = d.v ?? null;
    need(v === null || isSemver(v));
    // A safety rail, not a guarantee (both versions are what the caller's app says): never above the
    // caller's own app, as sent and as its live socket says. The owner is never closed for being
    // below the minimum (hub.js onAuth and below), so a bad minimum can always be cleared.
    if (v !== null && !(isSemver(d.app) && semverCmp(v, d.app) <= 0)) fail('bad_request', { message: 'That is newer than your own Snug.' });
    // Another admin also needs a live app at least that new (the owner can't be shut out, so can always undo it).
    const live = this.sockets(ctx.acc.uid, (a) => a.mode === 'normal').map((w) => this.att(w)?.v).filter(isSemver);
    if (v !== null && !ctx.owner && !live.some((x) => semverCmp(v, x) <= 0)) fail('bad_request', { message: 'That is newer than your own Snug.' });
    if (v === null) this.sql.exec("DELETE FROM settings WHERE k='min_version'");
    else this.sql.exec("INSERT INTO settings(k, v) VALUES('min_version', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", v);
    this._notices = null;
    ctx.detail = { v };
    ctx.after = () => {
      this.broadcastNotices();
      if (!v) return;
      for (const w of this.ctx.getWebSockets()) {
        if (w.readyState !== 1 || this.gone.has(w)) continue;
        const a = this.att(w);
        if (a && a.authed && (a.mode === 'normal' || a.mode === 'pending') && this.below(a.v, v) && !this.isOwnerAcc(this.accountByUid(a.uid))) {
          this.send(w, { t: 'update', min: v });
          this.closeWs(w, 4011, 'update');
        }
      }
    };
    return { min: v };
  },

  adm_admin_grant(d, ctx) {
    const t = this.targetAcc(d.uid, ctx);
    need(Array.isArray(d.perms) && d.perms.length >= 1 && d.perms.length <= PERMS.length && d.perms.every((p) => PERMS.includes(p)));
    const perms = PERMS.filter((p) => d.perms.includes(p));
    this.sql.exec(
      'INSERT INTO admins(uid, perms, by, at) VALUES(?,?,?,?) ON CONFLICT(uid) DO UPDATE SET perms=excluded.perms, by=excluded.by, at=excluded.at',
      t.uid, JSON.stringify(perms), ctx.acc.uid, this.now(),
    );
    ctx.detail = { perms };
    ctx.after = () => {
      for (const w of this.sockets(t.uid, (a) => a.mode === 'normal')) this.send(w, { t: 'admin', perms });
    };
    return { uid: t.uid, username: t.username, perms };
  },

  adm_admin_revoke(d, ctx) {
    const t = this.targetAcc(d.uid, ctx);
    if (!this.sql.exec('DELETE FROM admins WHERE uid=?', t.uid).rowsWritten) fail('not_found');
    ctx.after = () => {
      for (const w of this.sockets(t.uid, (a) => a.mode === 'normal')) this.send(w, { t: 'admin', perms: [] });
    };
    return { ok: true };
  },

  adm_admins() {
    return {
      admins: this.rows('SELECT d.uid, d.perms, d.by, d.at, a.username FROM admins d LEFT JOIN accounts a ON a.uid=d.uid ORDER BY d.at')
        .map((r) => ({ uid: r.uid, username: r.username ?? null, perms: JSON.parse(r.perms), at: r.at, by: this.nameOf(r.by) })),
    };
  },

  /**
   * sec-registry REG-M2. {uid, fp | ik}: a pending move completes now (unapproved: prev = null, so friends
   * see a loud key change). v0.12 review H3: the force is bound to one key, fp (the security code the new
   * PC shows) or ik (its device key): the account's next move of exactly that key within 7 days completes at
   * once, past the 24 h block and the old key's Stop; a move of that key already waiting completes now.
   * Moves of any other key get the normal wait. Second pass: {uid} alone is refused (bad_request), since
   * someone with the recovery key or the GitHub login can swap their own key into the waiting move between
   * the owner checking the account and running the force.
   * Owner only; never on the owner.
   */
  adm_move_force(d, ctx) {
    if (!ctx.owner) fail('forbidden');
    if (d.ik !== undefined) need(isKey(d.ik));
    const fp = d.fp === undefined ? null : normFp(d.fp);
    if (d.fp !== undefined) need(fp && d.ik === undefined);
    const bind = d.ik !== undefined ? `ik:${d.ik}` : fp ? `fp:${fp}` : null;
    if (!bind) fail('bad_request', { message: 'Name the new PC: fp (its security code) or ik.' });
    const t = this.targetAcc(d.uid, ctx);
    const now = this.now();
    const p = this.pending(t.uid);
    const same = bind === `ik:${p?.ik}` || (ctx.pendFp?.ik === p?.ik && bind === `fp:${ctx.pendFp?.fp}`);
    if (p && same) {
      ctx.detail = { state: 'done' };
      this.markForcedOld(t);
      this.markVaultRotate(t.ghh); // REG-L1: the forced-out device holds the old vault key
      ctx.after = () => this.completeRebind(t.uid, null);
      return { state: 'done' };
    }
    this.tx(() => {
      this.sql.exec('INSERT OR REPLACE INTO move_force(ghh, until, by, at) VALUES(?,?,?,?)', t.ghh, now + FORCE_FOR, ctx.acc.uid, now);
      this.sql.exec('INSERT OR REPLACE INTO move_force_key(ghh, k) VALUES(?,?)', t.ghh, bind);
      this.metaUpsert(t.ghh, 'rebind_block_until', null);
    });
    ctx.detail = { state: 'armed', until: now + FORCE_FOR, key: bind };
    return { state: 'armed', until: now + FORCE_FOR };
  },
  markForcedOld(acc) {
    this.sql.exec('INSERT OR REPLACE INTO forced_old(uid, ik, until) VALUES(?,?,?)', acc.uid, acc.ik, this.now() + 31 * DAY);
  },
  /**
   * A forced move armed for this account and the moving key (ik, and fp: its security code), used once, or
   * null. A force bound to another key stays armed for it; one armed before forces were bound to a key (no
   * move_force_key row) applies to no move (v0.12 review H3).
   */
  takeMoveForce(ghh, ik, fp) {
    const r = this.row('SELECT * FROM move_force WHERE ghh=?', ghh);
    if (!r) return null;
    const k = this.row('SELECT k FROM move_force_key WHERE ghh=?', ghh)?.k;
    if (!k || (k !== `ik:${ik}` && !(fp && k === `fp:${fp}`))) return null;
    this.sql.exec('DELETE FROM move_force WHERE ghh=?', ghh);
    this.sql.exec('DELETE FROM move_force_key WHERE ghh=?', ghh);
    return r.until > this.now() ? r : null;
  },

  adm_vault_export(d, ctx) {
    if (!ctx.owner) fail('forbidden');
    const after = d.after ?? '';
    need(typeof after === 'string' && after.length <= 64);
    const rows = this.rows('SELECT ghh, kid, k, at FROM vault_keys WHERE ghh>? ORDER BY ghh LIMIT 200', after);
    const old = rows.length
      ? this.rows('SELECT ghh, kid, k, at FROM vault_keys_old WHERE ghh>? AND ghh<=? ORDER BY ghh, kid', after, rows.at(-1).ghh)
      : [];
    ctx.detail = { after, n: rows.length };
    const wrap = this.env.VAULT_WRAP_SECRET ? 'vault-wrap-v2 (VAULT_WRAP_SECRET), rows not yet re-wrapped: vault-wrap-v1' : 'vault-wrap-v1';
    return { wrap, rows, old, next: rows.length === 200 ? rows.at(-1).ghh : null };
  },

  adm_audit(d) {
    const before = d.before ?? null;
    need(before === null || (Number.isSafeInteger(before) && before > 0));
    const rows = before
      ? this.rows('SELECT * FROM audit WHERE id<? ORDER BY id DESC LIMIT 50', before)
      : this.rows('SELECT * FROM audit ORDER BY id DESC LIMIT 50');
    return {
      audit: rows.map((r) => {
        let detail = {};
        try {
          detail = JSON.parse(r.detail);
        } catch {
          /* kept empty */
        }
        return { id: r.id, at: r.at, by: r.by, byName: this.nameOf(r.by), a: r.a, target: r.target ?? null, detail };
      }),
    };
  },
};

function argsOf(d) {
  const { a, app, ...rest } = d; // eslint-disable-line no-unused-vars
  return rest;
}
