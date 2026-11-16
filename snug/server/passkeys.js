// Passkey sign-in for password accounts on a Snug server (v0.12).
//
// A passkey is an extra way in, never the only one: the password keeps working,
// and an account can hold up to 10 passkeys. Adding or removing one needs the
// password (and a code when two-factor sign-in is on). Signing in with one asks
// for nothing else: the authenticator already checked a PIN or biometric (user
// verification is required), so it counts as two factors, and Settings says so.
//
// Challenges live in memory for 5 minutes, single use, keyed by the SHA-256 of a
// ticket (as the two-factor tickets in server/account.js). The checks themselves
// are in server/webauthn.js; where passkeys can work at all is passkeyPlace there.
// Desktop accounts that sign in with GitHub or a recovery key have no password
// and don't use this.
import { randomBytes, createHash } from 'node:crypto';
import { limiter, readCookie, COOKIE } from './auth.js';
import { verifyRegistration, verifyAuthentication, passkeyPlace, WebAuthnError, ALGS, b64u } from './webauthn.js';
import { deviceLabel } from '../js/lib/account.js';

export const MAX_PASSKEYS = 10;
const CHALLENGE_MS = 5 * 60_000;
const MAX_CHALLENGES = 1000;
const PER_SOURCE = 30; // v0.12 review: outstanding challenges per IPv6 /48 (or IPv4 address), or per account
// ipOf gives an IPv6 address as its /64 ("a:b:c:d::/64"); the sign-in limits here count its /48.
const wideOf = (k) => (/::\/64$/.test(k) ? `${k.split(':').slice(0, 3).join(':')}::/48` : k);

export function migratePasskeys(db) {
  (db.raw ?? db).exec(`
    CREATE TABLE IF NOT EXISTS passkey_users (
      user TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE       -- 32 random bytes, base64url: the WebAuthn user.id (never the account id)
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,              -- credential id, base64url
      user TEXT NOT NULL,
      pub TEXT NOT NULL,                -- the public key as a JWK (JSON)
      alg INTEGER NOT NULL,             -- COSE algorithm: -8 Ed25519, -7 ES256, -257 RS256
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      name TEXT NOT NULL,
      backed INTEGER NOT NULL DEFAULT 0, -- synced to the person's other devices (a password manager or platform account)
      created INTEGER NOT NULL,
      used INTEGER
    );
    CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user);`);
}

// Everything about one account's passkeys goes: the account was deleted, or recovered (server/recovery.js).
export function forgetPasskeys(db, user) {
  db.run('DELETE FROM passkeys WHERE user = ?', user);
  db.run('DELETE FROM passkey_users WHERE user = ?', user);
}

const WORDS = {
  challenge: 'That took too long. Try again.',
  origin: 'That passkey was made for a different address.',
  rpid: 'That passkey was made for a different address.',
  verification: 'Your device didn’t check it was you (a PIN, fingerprint or face). Try again and confirm on your device.',
  presence: 'Your device didn’t confirm. Try again.',
  counter: 'That passkey was refused because it looks copied. Sign in with your password, then check your passkeys in Settings.',
  signature: 'That passkey didn’t match. Try again, or sign in with your password.',
  alg: 'That passkey uses a kind of key Snug doesn’t support. Try another device or password manager.',
};
const wordsFor = (code) => WORDS[code] || 'That passkey didn’t work. Try again, or sign in with your password.';

export function createPasskeys({
  db, M, hub, account, sendJson, error, jsonBody, ipOf, authLimit, httpsReq,
  rpId = null, hosts = null, loopback = false, desktop = false, extraOrigins = [],
}) {
  migratePasskeys(db);
  const challenges = new Map(); // sha256(ticket) -> { kind, user, challenge, until, rpId, origins }
  const optionLimit = limiter({ capacity: 10, perSecond: 10 / 60 }); // per address, sign-in options
  const wideLimit = limiter({ capacity: 30, perSecond: 30 / 60 });  // per /48, sign-in options (v0.12 review)
  const userLimit = limiter({ capacity: 6, perSecond: 0.1 });       // per account: begin, finish, rename, remove
  hub.extraLimits = [...(hub.extraLimits || []), optionLimit, wideLimit, userLimit];
  const key = (t) => createHash('sha256').update(String(t)).digest('hex');
  const place = (req) => passkeyPlace({ host: req.headers.host, https: httpsReq(req), rpId, hosts, loopback, desktop, extraOrigins });
  const tokenOf = (req) => readCookie(req.headers.cookie, COOKIE);

  // src: who asked (a /48 or IPv4 address, or u:<account>). A source keeps at most PER_SOURCE challenges,
  // and when the map is full the busiest source loses its oldest one, so a flood pushes out its own first.
  function newChallenge(entry, src) {
    const now = Date.now();
    for (const [k, c] of challenges) if (c.until < now) challenges.delete(k);
    const mine = [...challenges].filter(([, c]) => c.src === src);
    if (mine.length >= PER_SOURCE) challenges.delete(mine[0][0]);
    while (challenges.size >= MAX_CHALLENGES) {
      const count = new Map();
      for (const c of challenges.values()) count.set(c.src, (count.get(c.src) || 0) + 1);
      const top = [...count].sort((x, y) => y[1] - x[1])[0][0];
      for (const [k, c] of challenges) if (c.src === top) { challenges.delete(k); break; }
    }
    const ticket = randomBytes(24).toString('base64url');
    const challenge = b64u(randomBytes(32));
    challenges.set(key(ticket), { ...entry, src, challenge, until: now + CHALLENGE_MS });
    return { ticket, challenge };
  }
  // Single use: a ticket is gone the moment it is read, whatever happens next.
  function takeChallenge(ticket, kind) {
    const k = key(ticket || '');
    const c = challenges.get(k);
    challenges.delete(k);
    return c && c.kind === kind && c.until >= Date.now() ? c : null;
  }
  const handleOf = (user) => {
    const row = db.get('SELECT handle FROM passkey_users WHERE user = ?', user);
    if (row) return row.handle;
    const handle = b64u(randomBytes(32));
    db.run('INSERT INTO passkey_users (user, handle) VALUES (?, ?)', user, handle);
    return handle;
  };
  const listOf = (user) => db.all('SELECT id, name, backed, created, used FROM passkeys WHERE user = ? ORDER BY created', user)
    .map((p) => ({ id: p.id, name: p.name, synced: !!p.backed, created: p.created, used: p.used }));
  const changed = (user) => hub.toUser(user, 'account', { passkeys: listOf(user).length });
  const cleanName = (v, req) => {
    const s = String(v ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 40);
    return s || `${deviceLabel(req.headers['user-agent']) || 'Device'} passkey`.slice(0, 40);
  };
  // A passkey is for a password account: desktop GitHub and keypair accounts have none.
  const passwordAccount = (user) => !M.p2pOwner?.(user) && db.get('SELECT pass FROM users WHERE id = ?', user)?.pass !== '!';

  // ---------- No session: signing in ----------
  async function open(req, res, path) {
    if (req.method === 'GET' && path === '/api/passkey/config') {
      const p = place(req);
      sendJson(res, 200, { ok: p.ok, message: p.ok ? null : p.message });
      return true;
    }
    if (req.method !== 'POST') return false;
    if (path === '/api/passkey/options') {
      const ip = ipOf(req);
      if (!optionLimit.take(ip) || !wideLimit.take(wideOf(ip))) { error(res, 429, 'Too many attempts. Wait a minute and try again.'); return true; }
      const p = place(req);
      if (!p.ok) { error(res, 400, p.message); return true; }
      const { ticket, challenge } = newChallenge({ kind: 'login', rpId: p.rpId, origins: p.origins }, wideOf(ip));
      // No allowCredentials: the browser offers the passkeys it has for this site, so no
      // username is needed and the answer says nothing about which accounts exist.
      sendJson(res, 200, { ticket, options: { challenge, rpId: p.rpId, timeout: CHALLENGE_MS, userVerification: 'required', allowCredentials: [] } });
      return true;
    }
    if (path === '/api/passkey/login') {
      const ip = ipOf(req);
      if (!authLimit.take(`login-ip:${ip}`)) { M.audit?.('login', req, null, { ok: false, why: 'locked' }); error(res, 429, 'Too many attempts. Wait a few minutes and try again.'); return true; }
      const d = await jsonBody(req);
      const c = takeChallenge(d.ticket, 'login');
      if (!c) { error(res, 401, WORDS.challenge); return true; }
      const id = typeof d.credential?.id === 'string' ? d.credential.id : '';
      const row = id.length <= 1400 ? db.get('SELECT p.*, u.deleted FROM passkeys p JOIN users u ON u.id = p.user WHERE p.id = ?', id) : null;
      if (!row || row.deleted) {
        M.audit?.('login', req, null, { ok: false, why: 'passkey' });
        error(res, 401, 'That passkey isn’t set up for an account here. It may have been removed. Sign in with your password.');
        return true;
      }
      // A discoverable passkey names its account; it must be the one this passkey was added to.
      const uh = d.credential?.response?.userHandle;
      if (uh != null && uh !== db.get('SELECT handle FROM passkey_users WHERE user = ?', row.user)?.handle) {
        M.audit?.('login', req, row.user, { ok: false, why: 'passkey' });
        error(res, 401, wordsFor('signature'));
        return true;
      }
      let v;
      try {
        v = verifyAuthentication({ credential: d.credential, challenge: c.challenge, origins: c.origins, rpId: c.rpId, passkey: { id: row.id, jwk: JSON.parse(row.pub), alg: row.alg, counter: row.counter } });
      } catch (e) {
        const code = e instanceof WebAuthnError ? e.code : 'format';
        M.audit?.(code === 'counter' ? 'passkey.clone' : 'login', req, row.user, { ok: false, why: 'passkey' });
        error(res, 401, wordsFor(code));
        return true;
      }
      db.run('UPDATE passkeys SET counter = ?, backed = ?, used = ? WHERE id = ?', v.counter, v.backedUp ? 1 : 0, Date.now(), row.id);
      account.reactivate(row.user);
      sendJson(res, 200, { user: account.strip(M.userRow(row.user)) }, account.signIn(req, row.user, 'passkey'));
      return true;
    }
    return false;
  }

  // ---------- Signed in: Settings > Account and security > Passkeys ----------
  async function authed(req, res, path, user) {
    const post = req.method === 'POST';
    if (req.method === 'GET' && path === '/api/passkeys') {
      const p = place(req);
      sendJson(res, 200, { ok: p.ok, message: p.ok ? null : p.message, passwordAccount: passwordAccount(user), list: listOf(user), max: MAX_PASSKEYS });
      return true;
    }
    if (!post || !path.startsWith('/api/passkeys/')) return false;
    if (!userLimit.take(user)) { error(res, 429, 'You’re going a little fast. Wait a moment and try again.'); return true; }
    const d = await jsonBody(req);
    const step = async () => {
      const r = await M.stepUp(user, { password: d.password, code: typeof d.code === 'string' ? d.code.replace(/\s/g, '') : '', token: tokenOf(req) });
      if (r) error(res, r.status === 429 ? 429 : 401, r.message);
      return !r;
    };
    if (path === '/api/passkeys/begin') {
      if (!passwordAccount(user)) { error(res, 400, 'Passkeys are for accounts that sign in with a password.'); return true; }
      const p = place(req);
      if (!p.ok) { error(res, 400, p.message); return true; }
      const have = db.all('SELECT id, transports FROM passkeys WHERE user = ?', user);
      if (have.length >= MAX_PASSKEYS) { error(res, 400, `You have ${MAX_PASSKEYS} passkeys, the most an account can have. Remove one first.`); return true; }
      if (!await step()) return true;
      const row = M.userRow(user);
      const { ticket, challenge } = newChallenge({ kind: 'add', user, rpId: p.rpId, origins: p.origins }, `u:${user}`);
      sendJson(res, 200, {
        ticket,
        options: {
          challenge,
          rp: { name: 'Snug', id: p.rpId },
          user: { id: handleOf(user), name: row.handle, displayName: row.name || row.handle },
          pubKeyCredParams: [ALGS.EDDSA, ALGS.ES256, ALGS.RS256].map((alg) => ({ type: 'public-key', alg })),
          timeout: CHALLENGE_MS,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          excludeCredentials: have.map((k) => ({ type: 'public-key', id: k.id, transports: JSON.parse(k.transports || '[]') })),
        },
      });
      return true;
    }
    if (path === '/api/passkeys/finish') {
      const c = takeChallenge(d.ticket, 'add');
      if (!c || c.user !== user) { error(res, 401, WORDS.challenge); return true; }
      let v;
      try { v = verifyRegistration({ credential: d.credential, challenge: c.challenge, origins: c.origins, rpId: c.rpId }); } catch (e) {
        M.audit?.('passkey.add', req, user, { ok: false, why: 'passkey' });
        error(res, 400, wordsFor(e instanceof WebAuthnError ? e.code : 'format'));
        return true;
      }
      if (db.get('SELECT 1 FROM passkeys WHERE id = ?', v.id)) { error(res, 409, 'That passkey is already added.'); return true; }
      if (db.get('SELECT COUNT(*) n FROM passkeys WHERE user = ?', user).n >= MAX_PASSKEYS) { error(res, 400, `You have ${MAX_PASSKEYS} passkeys, the most an account can have.`); return true; }
      const name = cleanName(d.name, req);
      db.run('INSERT INTO passkeys (id, user, pub, alg, counter, transports, name, backed, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        v.id, user, JSON.stringify(v.jwk), v.alg, v.counter, JSON.stringify(v.transports), name, v.backedUp ? 1 : 0, Date.now());
      M.audit?.('passkey.add', req, user);
      changed(user);
      sendJson(res, 201, { passkey: listOf(user).find((p) => p.id === v.id) });
      return true;
    }
    const target = typeof d.id === 'string' ? db.get('SELECT id FROM passkeys WHERE id = ? AND user = ?', d.id, user) : null;
    if (path === '/api/passkeys/rename') {
      if (!target) { error(res, 404, 'That passkey is already gone.'); return true; }
      db.run('UPDATE passkeys SET name = ? WHERE id = ?', cleanName(d.name, req), target.id);
      M.audit?.('passkey.rename', req, user);
      changed(user);
      sendJson(res, 200, { list: listOf(user) });
      return true;
    }
    if (path === '/api/passkeys/remove') {
      if (!target) { error(res, 404, 'That passkey is already gone.'); return true; }
      if (!await step()) return true;
      db.run('DELETE FROM passkeys WHERE id = ?', target.id);
      M.audit?.('passkey.remove', req, user);
      changed(user);
      sendJson(res, 200, { list: listOf(user) });
      return true;
    }
    return false;
  }

  return {
    open, authed, listOf,
    reset: () => { challenges.clear(); optionLimit.reset(); wideLimit.reset(); userLimit.reset(); },
  };
}
