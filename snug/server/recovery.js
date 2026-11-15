// "Forgot your password?" without email, for password accounts on a Snug server (v0.12).
//
// The recovery key R (js/lib/recovery.js) never reaches the server. The browser
// derives authKey = HKDF(R, "snug-recovery", "web-auth-v1") and sends only that;
// the server keeps a slow hash of it (scrypt, the same format and work as
// passwords, so unknown accounts take the same time). The same R also opens the
// end-to-end encryption backup (deriveBackupKey, a different HKDF label), which
// this server can't compute from authKey or its hash.
//
// Using a recovery key: username + authKey -> a 5-minute single-use ticket ->
// a new password. That signs out every device, removes the account's passkeys (in
// case someone else added one) and, if asked, turns off two-factor sign-in. A key
// works once; the person makes a new one straight after. Someone who has the key
// can take the account, as with a password; the screens say so.
//
// Limits: per address (the sign-in bucket) and per account (POLICIES.recover:
// 5 free tries, then waits from 15 minutes that double, kept in SQLite).
import { randomBytes, createHash } from 'node:crypto';
import {
  verifyPassword, hashPasswordAsync, burnPasswordCheck, passwordProblem, endAllSessions, recentAuth, readCookie, COOKIE, POLICIES, limiter,
} from './auth.js';
import { forgetPasskeys } from './passkeys.js';

const VERIFIER = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const LOGIN_HANDLE = /^[a-z0-9][a-z0-9_.-]{0,63}$/; // as server/account.js
const TICKET_MS = 5 * 60_000;
const NO_MATCH = 'That username and recovery key don’t match. A recovery key works once: if you used it before, use the newer one you saved then.';

export function migrateRecovery(db) {
  (db.raw ?? db).exec('CREATE TABLE IF NOT EXISTS recovery (user TEXT PRIMARY KEY, hash TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER)');
}

export function createRecovery({ db, M, hub, account, sendJson, error, jsonBody, ipOf, authLimit, log = () => {} }) {
  migrateRecovery(db);
  const G = account.guard;
  const tickets = new Map(); // sha256(ticket) -> { user, hash, until, tries }
  const finishLimit = limiter({ capacity: 20, perSecond: 20 / 900 });
  const userLimit = limiter({ capacity: 6, perSecond: 0.1 });
  hub.extraLimits = [...(hub.extraLimits || []), finishLimit, userLimit];
  const key = (t) => createHash('sha256').update(String(t)).digest('hex');
  const tokenOf = (req) => readCookie(req.headers.cookie, COOKIE);
  const status = (user) => {
    const r = db.get('SELECT created, used FROM recovery WHERE user = ?', user);
    return { set: !!r && !r.used, created: r?.created || null };
  };
  const passwordAccount = (user) => !M.p2pOwner?.(user) && db.get('SELECT pass FROM users WHERE id = ?', user)?.pass !== '!';

  // Settings and the reminder read it from the snapshot; deleting the account forgets the key.
  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnap(u);
    snap.account = { ...(snap.account || {}), recovery: status(u), passkeys: db.get('SELECT COUNT(*) n FROM passkeys WHERE user = ?', u)?.n || 0, passwordAccount: passwordAccount(u) };
    return snap;
  };
  account.deleteAccountHooks.push((u) => { db.run('DELETE FROM recovery WHERE user = ?', u); forgetPasskeys(db, u); });
  // The data export says whether a key exists and lists passkey names, never a key.
  const baseExport = M.exportExtra;
  M.exportExtra = (u) => ({
    ...(baseExport?.(u) || {}),
    recoveryKey: (() => { const s = status(u); return { made: s.created ? new Date(s.created).toISOString() : null, usable: s.set }; })(),
    passkeys: db.all('SELECT name, backed, created, used FROM passkeys WHERE user = ? ORDER BY created', u)
      .map((p) => ({ name: p.name, synced: !!p.backed, added: new Date(p.created).toISOString(), lastUsed: p.used ? new Date(p.used).toISOString() : null })),
  });

  // ---------- No session: using the key ----------
  async function open(req, res, path) {
    if (req.method !== 'POST') return false;
    if (path === '/api/recover') {
      const ip = ipOf(req);
      if (!authLimit.take(`recover-ip:${ip}`)) { M.audit?.('recovery.use', req, null, { ok: false, why: 'locked' }); error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
      const d = await jsonBody(req);
      const handle = String(d.handle || '').trim().toLowerCase().replace(/^@/, '');
      const proof = typeof d.proof === 'string' ? d.proof : '';
      const nope = () => error(res, 401, NO_MATCH);
      if (!LOGIN_HANDLE.test(handle) || !VERIFIER.test(proof)) { await burnPasswordCheck(proof); M.audit?.('recovery.use', req, null, { ok: false, why: 'unknown' }); nope(); return true; }
      const user = db.get('SELECT id, pass FROM users WHERE handle = ? AND deleted IS NULL', handle);
      const rec = user && passwordAccount(user.id) ? db.get('SELECT hash FROM recovery WHERE user = ? AND used IS NULL', user.id) : null;
      const acct = user ? `rec:${user.id}` : `rech:${handle}`;
      const wait = G.waitMs(acct, POLICIES.recover);
      if (wait) { M.audit?.('recovery.use', req, user?.id || null, { ok: false, why: 'locked' }); error(res, 429, `Too many tries. Wait ${Math.ceil(wait / 60_000)} minutes and try again.`); return true; }
      // Unknown accounts, accounts with no key and used keys cost the same check as a real one.
      const ok = rec ? (await verifyPassword(proof, rec.hash)).ok : await burnPasswordCheck(proof);
      if (!ok) {
        G.fail(acct, POLICIES.recover);
        M.audit?.('recovery.use', req, user?.id || null, { ok: false, why: user ? 'proof' : 'unknown' });
        nope();
        return true;
      }
      G.clear(acct);
      for (const [k, t] of tickets) if (t.until < Date.now()) tickets.delete(k);
      const ticket = randomBytes(24).toString('base64url');
      tickets.set(key(ticket), { user: user.id, hash: rec.hash, until: Date.now() + TICKET_MS, tries: 0 });
      sendJson(res, 200, { ticket, totp: !!account.totpOn(user.id) });
      return true;
    }
    if (path === '/api/recover/finish') {
      if (!finishLimit.take(ipOf(req))) { error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
      const d = await jsonBody(req);
      const k = key(d.ticket || '');
      const t = tickets.get(k);
      if (!t || t.until < Date.now() || ++t.tries > 5) { tickets.delete(k); error(res, 401, 'That took too long. Start again with your recovery key.'); return true; }
      const row = M.userRow(t.user);
      const password = typeof d.password === 'string' ? d.password : '';
      const weak = passwordProblem(password, { handle: row.handle, name: row.name });
      if (weak) { error(res, 400, weak); return true; } // the ticket stays for another try
      const pass = await hashPasswordAsync(password);
      // The key is spent exactly once, even with two finishes racing.
      if (!tickets.delete(k) || !db.run('UPDATE recovery SET used = ? WHERE user = ? AND hash = ? AND used IS NULL', Date.now(), t.user, t.hash).changes) {
        error(res, 401, 'That recovery key was just used. Start again.');
        return true;
      }
      const resetTwoFactor = d.resetTwoFactor === true && account.totpOn(t.user);
      const passkeysGone = db.get('SELECT COUNT(*) n FROM passkeys WHERE user = ?', t.user)?.n || 0;
      db.tx(() => {
        db.run('UPDATE users SET pass = ? WHERE id = ?', pass, t.user);
        if (resetTwoFactor) db.run('DELETE FROM totp WHERE user = ?', t.user);
        forgetPasskeys(db, t.user);
        endAllSessions(db, t.user); // always: the person may be taking the account back from someone
      });
      hub.endSessions(t.user);
      account.prunePush();
      M.audit?.('recovery.use', req, t.user, { why: resetTwoFactor ? 'two-factor-reset' : null });
      log('recovery', row.handle);
      account.reactivate(t.user);
      sendJson(res, 200, { user: account.strip(M.userRow(t.user)), totpReset: resetTwoFactor, passkeysRemoved: passkeysGone }, account.signIn(req, t.user, 'recovery'));
      return true;
    }
    return false;
  }

  // ---------- Signed in: Settings > Recovery key ----------
  async function authed(req, res, path, user) {
    if (req.method === 'GET' && path === '/api/recovery') { sendJson(res, 200, { ...status(user), passwordAccount: passwordAccount(user) }); return true; }
    if (req.method !== 'POST' || path !== '/api/recovery/set') return false;
    if (!userLimit.take(user)) { error(res, 429, 'You’re going a little fast. Wait a moment and try again.'); return true; }
    const d = await jsonBody(req);
    if (!passwordAccount(user)) { error(res, 400, 'This account’s recovery key is in Settings > Account.'); return true; }
    if (typeof d.verifier !== 'string' || !VERIFIER.test(d.verifier)) { error(res, 400, 'That recovery key isn’t valid. Make a new one.'); return true; }
    // Right after signing up, signing in or recovering (10 minutes), the session itself is enough;
    // later, or whenever a password is typed, the password (and a code) is checked.
    if (d.password !== undefined || !recentAuth(db, tokenOf(req))) {
      const r = await M.stepUp(user, { password: d.password, code: typeof d.code === 'string' ? d.code.replace(/\s/g, '') : '', token: tokenOf(req) });
      if (r) { error(res, r.status === 429 ? 429 : 401, r.message); return true; }
    }
    try { M.onRecoverySet?.(user, d); } catch (e) { error(res, 400, e.message); return true; } // e2ee: the backup under the new key, when that ships
    const hash = await hashPasswordAsync(d.verifier);
    const now = Date.now();
    db.run('INSERT INTO recovery (user, hash, created, used) VALUES (?, ?, ?, NULL) ON CONFLICT (user) DO UPDATE SET hash = excluded.hash, created = excluded.created, used = NULL', user, hash, now);
    M.audit?.('recovery.set', req, user);
    hub.toUser(user, 'account', { recovery: status(user) });
    sendJson(res, 200, { recovery: status(user) });
    return true;
  }

  return { open, authed, status, reset: () => { tickets.clear(); finishLimit.reset(); userLimit.reset(); } };
}
