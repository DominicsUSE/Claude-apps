// Keypair accounts on this PC (v0.12, design identity.md section 1.7): a Snug account that needs no GitHub
// account. The account is this PC's device key plus a recovery key derived from a 20-byte secret the person
// is shown once (js/lib/recovery.js). The registry side is registry/src/keyacct.js; GitHub sign-in
// (server/ghauth.js) stays as an optional path and as a second way to move.
//
// Routes (loopback only, the app window only in the desktop app, 404 without a registry):
//   GET  /api/id/config            {enabled, github, owner, resume}
//   GET  /api/id/check?name=       {ok} | {ok:false, error, message}
//   POST /api/id/create {username} -> {user, recovery:{code}} (cookie). The proof of work runs in a worker.
//   POST /api/id/cancel {flow?}    stops a create (or a pairing-code wait)
//   POST /api/id/move/start        -> {flow, code, expiresIn}: the pairing code for the old PC
//   POST /api/id/move/wait {flow}  held up to 25 s -> {state: 'waiting'|'expired'|'signed-in', user?}
//   POST /api/id/recover {code}    the recovery key -> {state:'moving', at, user} (cookie)
//   POST /api/id/resume            -> {user} (cookie), desktop only (the per-launch resume cookie)
// Signed in (this PC's account only):
//   GET  /api/id/recovery          {code, username} while the person hasn't confirmed they saved it
//   POST /api/id/recovery/confirm {last}
// Ops: id.recoveryShow, id.recoveryConfirm, id.recoveryNew {old?}, id.recoveryCancel {code, what?},
//      id.recoveryCancelGh {flow, what?}, id.movePeek {code}, id.moveAccept {code}, id.linkGithub {flow, code?},
//      id.unlinkGithub {code?}, id.releaseCheck {code}. what = 'key' | 'link' (none: both); code on link and
//      unlink = the recovery key, which makes the change at once (v0.12 review, second pass).
//      v0.13: id.linkCancel, id.linkCancelGh {flow}, id.recoveryDrop: this PC (or the GitHub account a waiting
//      link would add) calls off a waiting change that would only add a way in.
//
// What this does not do: nothing here makes one person equal one account, and the recovery key is the only
// way back for someone who loses this PC without GitHub linked. Snug can't reset it.
import { randomBytes } from 'node:crypto';
import { normalize, check } from '../js/lib/usernames.js';
import { localNameProblem } from '../js/lib/username-text.js';
import { newRecoveryKey, formatRecoveryKey, parseRecoveryKey, deriveP2pSeed } from '../js/lib/recovery.js';
import { createSession, sessionCookie } from './auth.js';
import { edFromSeed, pubOf, signStr, fingerprint } from './peercrypto.js';
import { solvePow } from './pow.js';
import { createOwnerRows } from './ownerrow.js';
import { secRecord } from './seclog.js';
import { UserError } from './ops.js';

const HOLD_MS = 25_000;
const MAX_FLOWS = 3;
const RELEASE_MS = 10 * 60_000;
const fail = (m) => { throw new UserError(m); };
export const SHORT_NAME_TEXT = 'Usernames of 2 or 3 characters are open to new accounts after 30 days. Pick a longer one for now.';

/** The recovery key's Ed25519 pair, derived from the 20-byte secret: {pub, sign(str)}. */
export async function recoverySigner(raw) {
  const priv = edFromSeed(await deriveP2pSeed(raw));
  return { pub: pubOf(priv), sign: (s) => signStr(priv, s) };
}
// The last group typed back, read like a recovery key (case, dashes, and 0/1/8 for O/I/B don't matter).
const lastGroup = (s) => String(s || '').toUpperCase().replace(/[\s-]+/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');

export function createKeyAuth({ db, M, hub, peer, gh, opts = {}, secure = false, log = () => {}, agentOf = () => '' }) {
  const { registryUrl, ghWindowOnly = false, movePollMs = 3000 } = opts;
  const enabled = !!(registryUrl && peer?.enabled);
  const identity = peer?.identity;
  const reg = peer?.reg;
  const regMessage = gh?.regMessage || ((e) => e?.message || 'Can’t reach Snug’s directory right now. Try again soon.');
  const { userRow, handleFree, ensureOwnerRow } = enabled ? createOwnerRows({ db, M, hub, identity, log }) : {};
  const self = () => identity.self();
  let job = null;              // the create in progress: an AbortController
  let unsupported = false;     // the registry answered 404 for keypair routes (KEY_ACCOUNTS off there)
  const moves = new Map();     // flow -> {hid, code, exp}
  const releases = new Map();  // flow -> {raw, exp}: a delete confirmed with the recovery key

  function send(res, status, body, extra = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }
  const err = (res, status, message, code) => send(res, status, { error: message, ...(code ? { code } : {}) });
  async function json(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return {};
    const parts = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 4096) throw Object.assign(new Error('too big'), { status: 413 }); parts.push(c); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') || {}; } catch { return {}; }
  }
  // The Worker's own 404 (its keypair routes switched off) says "not_found"; the Hub's says "Not found.".
  const routeOff = (e) => e?.status === 404 && e.message === 'not_found';
  const statusOf = (e) => (e.status === 429 ? 429 : e.status && e.status < 500 ? 409 : 502);

  // ---------- account state this PC keeps (shown in Settings > Account; peer.statusFor reads it) ----------
  function pushStatus() {
    const o = self()?.user;
    if (o) hub.toUser(o, 'p2p', peer.statusFor(o));
  }
  // What the registry says about the account: its kind, recovery key and GitHub link, and how a move started.
  // v0.12 review, second pass: a PC still moving in asks too (the registry takes the pending key here), so the
  // owner who lost the old PC sees changes waiting on the account in time to cancel them.
  async function refreshKind() {
    const s = self();
    if (!s?.uid || (s.state !== 'ok' && s.state !== 'moving') || unsupported) return;
    let k;
    try { k = await reg.signedCall('/v1/account/kind', 'account-kind', {}); } catch (e) {
      if (routeOff(e)) unsupported = true;
      return;
    }
    identity.set('kind', k.kind === 'key' ? 'key' : 'github');
    identity.set('rk_set', k.recovery?.set ? '1' : '0');
    identity.set('rk_pending_at', k.recovery?.pendingAt || null);
    // The current recovery key as the registry has it (v0.12 review): a key replaced since (a new one took
    // effect after its 7 days, or the account moved) no longer signs anyone back in on this PC.
    if (k.recovery && 'rk' in k.recovery) identity.set('rk', k.recovery.rk || null);
    identity.set('gh_linked', k.github?.linked && k.kind === 'key' ? '1' : '0');
    // A GitHub link or unlink waiting its 7 days (v0.12 review H3).
    identity.set('gh_change', k.kind === 'key' && k.github?.pending ? JSON.stringify(k.github.pending) : null);
    identity.set('move_via', k.move?.via || null);
    // A recovery key this PC never showed (made on another PC, or it moved here) counts as saved.
    if (k.recovery?.set && identity.get('rk_saved') == null) identity.set('rk_saved', '1');
    pushStatus();
    return true;
  }
  if (enabled && peer._signal) {
    peer._signal.on('ready', () => { refreshKind().catch(() => {}); }); // a pending socket too (moving in)
    peer._signal.on('rebind', () => { refreshKind().catch(() => {}); });
    peer._signal.on('recovery', () => { refreshKind().catch(() => {}); });
  }

  // ---------- names ----------
  // A keypair account's username: the usual rules, and no 2 or 3 character names in its first 30 days.
  function nameProblem(name) {
    const p = localNameProblem(name, { owner: false });
    if (p) return { message: p, code: check(name, { owner: false }) };
    if (name.length <= 3) return { message: SHORT_NAME_TEXT, code: 'too_new' };
    return null;
  }

  function signIn(res, req, user, body = {}) {
    const token = createSession(db, user, agentOf(req));
    M.onSignIn?.(req, user, 'key'); // sec-auth: the audit trail and a word to the account's other devices
    send(res, 200, { ...body, user: M.userView(M.userRow(user), M.userRow(user).presence, true) }, { 'Set-Cookie': sessionCookie(token, { secure }) });
  }
  // This PC holds an account that is in use here (one Snug account per PC).
  const holdsAccount = () => { const s = self(); return !!(s?.uid && s.state !== 'gone'); };
  const reusable = () => { const s = self(); return s?.state === 'gone' && s.user && userRow(s.user) ? s.user : null; };

  // ---------- routes with no session ----------
  async function open(req, res, path, url) {
    if (!path.startsWith('/api/id/') || path.startsWith('/api/id/recovery')) return false; // those need a session: authed()
    const post = req.method === 'POST';
    const windowOk = gh?.loopback?.(req) && !(ghWindowOnly && !gh.resumeOk(req));
    if (path === '/api/id/config' && req.method === 'GET') {
      if (!enabled || !windowOk) { send(res, 200, { enabled: false }); return true; }
      const s = self();
      const resumable = s?.user && (s.state === 'ok' || s.state === 'moving') && userRow(s.user) && !userRow(s.user).deleted && gh.resumeOk(req);
      send(res, 200, { enabled: !unsupported, github: !!gh?.enabled, owner: !!(s?.user && userRow(s.user)), resume: resumable ? s.username : null });
      return true;
    }
    if (!enabled) { err(res, 404, 'Not found'); return true; }
    if (!windowOk) {
      if (gh?.loopback?.(req)) secRecord(db, 'access.refused', { req, detail: { path: path.slice(0, 60), why: 'not the app window' } });
      err(res, 403, 'This works only in the Snug app on this PC.');
      return true;
    }

    if (req.method === 'GET' && path === '/api/id/check') {
      const name = normalize(url.searchParams.get('name')).slice(0, 64);
      const p = nameProblem(name);
      if (p) { send(res, 200, { ok: false, error: p.code, message: p.message }); return true; }
      if (!handleFree(name, reusable() || self()?.user)) { send(res, 200, { ok: false, error: 'taken', message: 'That username is used by another account on this PC. Try another.' }); return true; }
      try {
        const r = await reg.check(name);
        if (r.ok) send(res, 200, { ok: true });
        else send(res, 200, { ok: false, error: r.error, message: regMessage({ code: r.error }, name) });
      } catch (e) {
        send(res, 200, { ok: null, error: e.code || 'unavailable', message: regMessage(e, name) });
      }
      return true;
    }

    if (post && path === '/api/id/create') {
      const d = await json(req);
      const username = normalize(d.username).slice(0, 64);
      const p = nameProblem(username);
      if (p) { err(res, 400, p.message, p.code); return true; }
      if (holdsAccount()) { err(res, 409, 'This PC is linked to another Snug account.'); return true; }
      const reuse = reusable();
      if (!handleFree(username, reuse)) { err(res, 409, 'That username is used by another account on this PC. Try another.', 'taken'); return true; }
      if (job) { err(res, 409, 'Your account is already being set up. Wait a moment.'); return true; }
      job = new AbortController();
      const ctl = job;
      try {
        const { raw, text } = await newRecoveryKey();
        const rk = await recoverySigner(raw);
        const { ik } = identity.ensureKeys();
        const pw = await reg.pow();
        const nonce = await solvePow(pw.c, ik, pw.bits, { signal: ctl.signal });
        const { account } = await reg.register({ username, c: pw.c, nonce, rk });
        // The account this PC had before the registry was reset: its row and chats stay, under the new account.
        if (reuse) { peer.stop(); identity.clearSelf(); }
        const user = ensureOwnerRow(account.uid, account.username, reuse);
        identity.setSelf({ uid: account.uid, username: account.username, user, kver: account.kver, state: 'ok', renamedAt: null });
        for (const [k, v] of [['kind', 'key'], ['rk', rk.pub], ['rk_set', '1'], ['rk_saved', '0'], ['gh_linked', '0']]) identity.set(k, v);
        identity.saveRecovery(raw);
        peer.start();
        log('id', 'created a keypair account');
        signIn(res, req, user, { recovery: { code: text } });
      } catch (e) {
        if (e.cancelled) err(res, 409, 'Stopped. Nothing was set up.', 'cancelled');
        else if (routeOff(e)) { unsupported = true; err(res, 503, 'Snug’s directory can’t make accounts without GitHub yet. Use GitHub instead.', 'unsupported'); }
        else { log('id', 'create', e.code || e.message); err(res, statusOf(e), regMessage(e, username), e.code); }
      } finally {
        if (job === ctl) job = null;
      }
      return true;
    }

    if (post && path === '/api/id/cancel') {
      const d = await json(req);
      if (job) job.abort();
      if (typeof d.flow === 'string') moves.delete(d.flow);
      send(res, 200, { ok: true });
      return true;
    }

    if (post && path === '/api/id/move/start') {
      if (holdsAccount()) { err(res, 409, 'This PC is linked to another Snug account.'); return true; }
      let r;
      try { r = await reg.moveHello(); } catch (e) {
        log('id', 'move hello', e.code || 'error');
        if (routeOff(e)) { unsupported = true; err(res, 503, 'Snug’s directory can’t do this yet. Use GitHub instead.', 'unsupported'); return true; }
        err(res, statusOf(e), regMessage(e), e.code);
        return true;
      }
      while (moves.size >= MAX_FLOWS) moves.delete(moves.keys().next().value);
      const id = randomBytes(16).toString('base64url');
      const expiresIn = Math.max(1, Math.round((r.exp - reg.now()) / 1000));
      moves.set(id, { hid: r.hid, code: r.code, exp: Date.now() + expiresIn * 1000 });
      send(res, 200, { flow: id, code: r.code, expiresIn });
      return true;
    }

    if (post && path === '/api/id/move/wait') {
      const d = await json(req);
      const f = typeof d.flow === 'string' ? moves.get(d.flow) : null;
      if (!f) { send(res, 200, { state: 'expired' }); return true; }
      const end = Date.now() + HOLD_MS;
      let gone = false;
      res.on('close', () => { gone = true; });
      for (;;) {
        let w = null;
        try { w = await reg.moveWait(f.hid); } catch (e) {
          if (e.code === 'rate_limited') { send(res, 200, { state: 'waiting' }); return true; } // the app asks again
          if (e.code !== 'offline' && e.code !== 'rate_limited' && e.code !== 'unavailable') { moves.delete(d.flow); err(res, statusOf(e), regMessage(e), e.code); return true; }
        }
        if (gone || res.writableEnded) return true;
        if (!moves.has(d.flow)) { send(res, 200, { state: 'expired' }); return true; } // cancelled
        if (w?.state === 'done') {
          moves.delete(d.flow);
          const a = w.account;
          if (holdsAccount() && self().uid !== a.uid) { err(res, 409, 'This PC is linked to another Snug account.'); return true; }
          const user = ensureOwnerRow(a.uid, a.username, reusable());
          // 'moving' until the signal socket says the key is current: the data file from the old PC is
          // only taken while this PC waits for it (server/vault.js).
          identity.setSelf({ uid: a.uid, username: a.username, user, kver: a.kver, state: 'moving', renamedAt: a.renamedAt || null });
          peer.start();
          log('id', 'moved here with a pairing code');
          signIn(res, req, user, { state: 'signed-in' });
          return true;
        }
        if (w?.state === 'expired' || Date.now() > f.exp) { moves.delete(d.flow); send(res, 200, { state: 'expired' }); return true; }
        if (Date.now() + movePollMs > end) { send(res, 200, { state: 'waiting' }); return true; }
        await new Promise((r) => setTimeout(r, movePollMs));
      }
    }

    if (post && path === '/api/id/recover') {
      const d = await json(req);
      const parsed = await parseRecoveryKey(typeof d.code === 'string' ? d.code.slice(0, 200) : '');
      if (parsed.error) { err(res, 400, parsed.message, parsed.error); return true; }
      const s = self();
      const rk = await recoverySigner(parsed.raw);
      // This PC's own account, signed out here: the recovery key proves it's theirs, so it signs them back in
      // (no move: the account is already on this PC).
      if (s?.uid && (s.state === 'ok' || s.state === 'moving') && s.user && userRow(s.user) && !userRow(s.user).deleted && identity.get('rk') === rk.pub) {
        signIn(res, req, s.user, { state: 'signed-in' });
        return true;
      }
      if (s?.uid && !['gone', 'revoked', 'needs-signin'].includes(s.state)) { err(res, 409, 'This PC is already linked to a Snug account.'); return true; }
      // v0.12 review: a PC that still holds an account (moved away or stopped) takes only that account's own
      // recovery key, checked here, before the registry starts a 72 h move of some other account to this PC.
      // Second pass: the key this PC stored may be stale (replaced on another PC, or never stored), so on a
      // mismatch the registry is asked whose key it is (nothing changes there) and only another uid is refused.
      if (s?.uid && s.state !== 'gone' && identity.get('rk') !== rk.pub) {
        let whose;
        try { whose = await reg.recoveryWhose(rk); } catch (e) {
          log('id', 'recover whose', e.code || 'error');
          err(res, statusOf(e), regMessage(e), e.code);
          return true;
        }
        if (!whose) { err(res, 404, 'That recovery key doesn’t match a Snug account. Check each group against the key you saved.', 'not_found'); return true; }
        if (whose.uid !== s.uid) { err(res, 409, 'This PC is linked to another Snug account.'); return true; }
      }
      let r;
      try { r = await reg.recover(rk); } catch (e) {
        log('id', 'recover', e.code || 'error');
        if (routeOff(e)) err(res, 503, 'Snug’s directory can’t do this yet. Use GitHub instead.', 'unsupported');
        else if (e.code === 'not_found') err(res, 404, 'That recovery key doesn’t match a Snug account. Check each group against the key you saved.', 'not_found');
        else err(res, statusOf(e), regMessage(e), e.code);
        return true;
      }
      if (s?.uid && s.uid !== r.uid && s.state !== 'gone') { err(res, 409, 'This PC is linked to another Snug account.'); return true; }
      const user = ensureOwnerRow(r.uid, r.account.username, reusable());
      identity.setSelf({ uid: r.uid, username: r.account.username, user, kver: r.account.kver, state: 'moving', rebindAt: r.at });
      // The person has the key in hand: it counts as saved. Its kind is read once the move is done.
      for (const [k, v] of [['rk', rk.pub], ['rk_set', '1'], ['rk_saved', '1']]) identity.set(k, v);
      identity.dropRecovery();
      peer.start();
      log('id', 'recovery move started');
      signIn(res, req, user, { state: 'moving', at: r.at });
      return true;
    }

    if (post && path === '/api/id/resume') {
      const s = self();
      if (!gh?.resumeOk(req) || !s?.user || !(s.state === 'ok' || s.state === 'moving') || !userRow(s.user) || userRow(s.user).deleted) {
        err(res, 403, 'Sign in to continue.');
        return true;
      }
      if (userRow(s.user).deactivated) { db.run('UPDATE users SET deactivated = NULL WHERE id = ?', s.user); hub.userChanged(s.user); }
      signIn(res, req, s.user);
      return true;
    }
    err(res, 404, 'Not found');
    return true;
  }

  // ---------- the recovery key, until the person shows they saved it ----------
  async function shownKey() {
    const raw = identity.takeRecovery();
    return raw ? formatRecoveryKey(raw) : null;
  }
  async function confirmSaved(last) {
    const text = await shownKey();
    if (!text) fail('Your recovery key is already saved.');
    if (lastGroup(last) !== text.slice(-4)) fail('That isn’t the end of your recovery key. Check the last group of what you saved.');
    identity.dropRecovery();
    identity.set('rk_saved', '1');
    pushStatus();
  }

  async function authed(req, res, path, user) {
    if (!path.startsWith('/api/id/')) return false;
    if (!enabled || !peer.isOwner(user)) { err(res, 404, 'Not found'); return true; }
    if (req.method === 'GET' && path === '/api/id/recovery') {
      const code = await shownKey();
      if (!code) { err(res, 404, 'Your recovery key is already saved.'); return true; }
      send(res, 200, { code, username: self().username });
      return true;
    }
    if (req.method === 'POST' && path === '/api/id/recovery/confirm') {
      const d = await json(req);
      try { await confirmSaved(d.last); } catch (e) { err(res, 400, e.message); return true; }
      send(res, 200, { ok: true });
      return true;
    }
    err(res, 404, 'Not found');
    return true;
  }

  // ---------- ops ----------
  if (enabled) {
    const ownerOnly = (c) => { if (!peer.isOwner(c.user) || c.peer) fail('Only this PC’s Snug account can do that.'); };
    const active = () => { if (self()?.state !== 'ok') fail('Your account isn’t active on this PC right now.'); };
    // Cancelling a change waiting on the account also works on a PC that is moving in (second pass).
    const activeOrMoving = () => { if (!['ok', 'moving'].includes(self()?.state)) fail('Your account isn’t active on this PC right now.'); };
    const whatOf = (w) => { if (w !== undefined && w !== 'key' && w !== 'link') fail('Choose what to cancel.'); return w; };
    // What a cancel changes in this PC's saved state: the new recovery key (and the copy this PC kept to show
    // once) and/or the GitHub change. A cancel of the GitHub change leaves a new recovery key alone.
    const afterCancel = (what) => {
      if (what !== 'link') { identity.set('rk_pending_at', null); identity.dropRecovery(); identity.set('rk_saved', '1'); }
      if (what !== 'key') identity.set('gh_change', null);
      pushStatus();
    };
    const reg2 = async (fn, msgs = {}) => {
      try { return await fn(); } catch (e) {
        if (e instanceof UserError) throw e;
        log('id', 'registry', e.code || 'error');
        fail(msgs[e.code] || regMessage(e));
        return null;
      }
    };
    const keyOf = async (text) => {
      const p = await parseRecoveryKey(typeof text === 'string' ? text.slice(0, 200) : '');
      if (p.error) fail(p.message);
      return p;
    };
    hub.ops['id.recoveryShow'] = async (c) => {
      ownerOnly(c);
      const code = await shownKey();
      if (!code) fail('Your recovery key is already saved. Make a new one if you lost it.');
      return { code, username: self().username };
    };
    hub.ops['id.recoveryConfirm'] = async (c, d) => { ownerOnly(c); await confirmSaved(d.last); return {}; };
    // A new recovery key. With the old one typed, it replaces it now; without, it starts in 7 days and the
    // old one can cancel it (someone with only this PC can't lock the real owner out at once).
    hub.ops['id.recoveryNew'] = async (c, d) => {
      ownerOnly(c);
      active();
      const old = d.old ? await recoverySigner((await keyOf(d.old)).raw) : null;
      const { raw, text } = await newRecoveryKey();
      const rk = await recoverySigner(raw);
      const r = await reg2(() => reg.signedCall('/v1/recovery/set', 'recovery-set', (t, u) => {
        const msg = `snug-reg-v1\nrecovery-set\n${u}\n${rk.pub}\n${t}`;
        return { rk: rk.pub, rsigNew: rk.sign(msg), ...(old ? { rsigOld: old.sign(msg) } : {}) };
      }), { bad_signature: 'That old recovery key isn’t the one your account has. Check it, or leave it empty.' });
      identity.saveRecovery(raw);
      identity.set('rk_saved', '0');
      if (r.state === 'set') { identity.set('rk', rk.pub); identity.set('rk_set', '1'); identity.set('rk_pending_at', null); } else identity.set('rk_pending_at', r.at);
      pushStatus();
      return { code: text, state: r.state, at: r.at || null, username: self().username };
    };
    hub.ops['id.recoveryCancel'] = async (c, d) => {
      ownerOnly(c);
      const what = whatOf(d.what);
      const rk = await recoverySigner((await keyOf(d.code)).raw);
      await reg2(() => reg.recoveryCancel(rk, what), { bad_signature: 'That isn’t your current recovery key.', not_found: 'Your account has no recovery key yet.' });
      afterCancel(what);
      return {};
    };
    const codeMsgs = { not_found: 'That code isn’t right or has expired. Make a new one on your new PC.', bad_request: 'That code is for this PC. Type it on your other PC instead.', key_in_use: 'That code belongs to a PC that already has an account.' };
    hub.ops['id.movePeek'] = async (c, d) => {
      ownerOnly(c);
      active();
      const pk = await reg2(() => reg.signedCall('/v1/move/peek', 'move-peek', { code: String(d.code || '').slice(0, 32) }), codeMsgs);
      return { fingerprint: fingerprint(pk.ik, pk.xk) };
    };
    hub.ops['id.moveAccept'] = async (c, d) => {
      ownerOnly(c);
      active();
      await reg2(() => peer.moveAccept(String(d.code || '').slice(0, 32)), codeMsgs);
      log('id', 'moved this account to another PC with a pairing code');
      return {};
    };
    // The recovery key typed with a link or unlink (optional): the change happens at once (second pass).
    const coSigner = async (code) => (code ? (await recoverySigner((await keyOf(code)).raw)).sign : undefined);
    const rkWrong = { bad_signature: 'That isn’t your current recovery key. Check it, or leave it empty.' };
    hub.ops['id.linkGithub'] = async (c, d) => {
      ownerOnly(c);
      active();
      const rsign = await coSigner(d.code);
      const ticket = gh?.takeTicket?.(d.flow, 'link-account');
      if (!ticket) fail('That GitHub sign-in took too long. Start again.');
      const r = await reg2(() => reg.signedCall('/v1/link/github', 'link-github', { ticket }, { rsign }), {
        ...rkWrong,
        already_claimed: 'That GitHub account already has a Snug username. Use another GitHub account.',
        already_linked: 'A GitHub account is already linked. Unlink it first.',
        forbidden: 'That GitHub account can’t be linked.',
      });
      // v0.12 review H3: without the recovery key the link works after 7 days (an older registry linked at once
      // and said only ok)
      if (r.state === 'pending') identity.set('gh_change', JSON.stringify({ change: 'link', at: r.at }));
      else { identity.set('gh_linked', '1'); identity.set('gh_change', null); }
      pushStatus();
      return { state: r.state || 'set', at: r.at || null };
    };
    hub.ops['id.unlinkGithub'] = async (c, d = {}) => {
      ownerOnly(c);
      active();
      const rsign = await coSigner(d.code);
      const r = await reg2(() => reg.signedCall('/v1/link/github/remove', 'unlink-github', {}, { rsign }), rkWrong);
      if (r.state === 'pending') identity.set('gh_change', JSON.stringify({ change: 'unlink', at: r.at }));
      else { identity.set('gh_linked', '0'); identity.set('gh_change', null); }
      pushStatus();
      return { state: r.state || 'done', at: r.at || null };
    };
    // GitHub sign-in stops a change waiting on the account (one this PC's account didn't ask for, perhaps): a
    // GitHub account's new recovery key; a keypair account's new recovery key or unlink, through its linked
    // GitHub (second pass). Also from a PC that is moving in. The flow is /api/gh/start {purpose:
    // 'recovery-cancel'} (server/ghauth.js).
    hub.ops['id.recoveryCancelGh'] = async (c, d) => {
      ownerOnly(c);
      activeOrMoving();
      const what = whatOf(d.what);
      const ticket = gh?.takeTicket?.(d.flow, 'recovery-cancel');
      if (!ticket) fail('That GitHub sign-in took too long. Start again.');
      await reg2(() => reg.recoveryCancelGh(ticket, what), { not_found: 'That GitHub account isn’t linked to your Snug account.' });
      afterCancel(what);
      return {};
    };
    // v0.13: this PC calls off a change it asked for that would only add a way in: a GitHub link still waiting
    // (the unlink route drops a waiting link at once), or a GitHub account's first recovery key. That puts back
    // what was there, so the device alone may; anything that removes or replaces a way in still needs the
    // recovery key or GitHub.
    const ghChange = () => { try { return JSON.parse(identity.get('gh_change') || 'null'); } catch { return null; } };
    hub.ops['id.linkCancel'] = async (c) => {
      ownerOnly(c);
      active();
      await refreshKind();
      if (ghChange()?.change !== 'link') fail('No GitHub link is waiting.');
      await reg2(() => reg.signedCall('/v1/link/github/remove', 'unlink-github', {}));
      afterCancel('link');
      return {};
    };
    // The GitHub account a waiting link would add calls it off: a 'link-account' sign-in (that GitHub account
    // is not linked yet, so it signs in as new) and its ticket on /v1/recovery/cancel.
    hub.ops['id.linkCancelGh'] = async (c, d) => {
      ownerOnly(c);
      active();
      const ticket = gh?.takeTicket?.(d.flow, 'link-account');
      if (!ticket) fail('That GitHub sign-in took too long. Start again.');
      let r = null;
      try { r = await reg.recoveryCancelGh(ticket, 'link'); } catch (e) {
        log('id', 'registry', e.code || 'error');
        if (e.code !== 'not_found') fail(regMessage(e));
      }
      // Review: ok can mean the registry stopped another account's wait for that GitHub (or, before 0.13, a
      // change on the account it is linked to), and not_found is also what a registry from before 0.13 says
      // for any waiting link. So only this PC's account as the registry has it now says whether it's gone (if
      // the registry can't be asked, an ok is taken at its word and a not_found isn't).
      const fresh = await refreshKind();
      if (fresh ? ghChange()?.change === 'link' : !r) {
        if (r) fail('That isn’t the GitHub account waiting to be linked.');
        fail('Snug’s directory didn’t cancel it: that may not be the GitHub account waiting to be linked, or the directory can’t cancel with GitHub yet. Cancel it from this PC instead.');
      }
      afterCancel('link');
      return {};
    };
    hub.ops['id.recoveryDrop'] = async (c) => {
      ownerOnly(c);
      active();
      if (!identity.get('rk_pending_at')) await refreshKind();
      if (!identity.get('rk_pending_at')) fail('No recovery key is waiting.');
      try { await reg.signedCall('/v1/recovery/drop', 'recovery-drop', { what: 'key' }); } catch (e) {
        log('id', 'registry', e.code || 'error');
        if (e.code === 'forbidden') fail('Your account has a recovery key: type it to cancel the new one.');
        if (e.status !== 404) fail(regMessage(e));
        // Nothing waits any more, or a registry from before 0.13 that doesn't know the route.
        await refreshKind();
        if (identity.get('rk_pending_at')) fail('Snug’s directory can’t cancel it from this PC yet. Cancel it with GitHub instead.');
      }
      afterCancel('key');
      return {};
    };
    // Delete: the recovery key frees the username (server/account.js asks M.p2pConfirmed, then M.p2pDelete).
    hub.ops['id.releaseCheck'] = async (c, d) => {
      ownerOnly(c);
      const p = await keyOf(d.code);
      const rk = await recoverySigner(p.raw);
      const known = identity.get('rk');
      if (known && known !== rk.pub) fail('That isn’t your account’s recovery key.');
      for (const [k, v] of releases) if (v.exp < Date.now()) releases.delete(k);
      const flow = randomBytes(16).toString('base64url');
      releases.set(flow, { raw: p.raw, exp: Date.now() + RELEASE_MS });
      return { flow };
    };
    const liveRelease = (flow) => { const f = typeof flow === 'string' ? releases.get(flow) : null; return f && f.exp > Date.now() ? f : null; };
    M.p2pKeyConfirmed = (flow) => !!liveRelease(flow);
    M.p2pKeyRelease = (flow) => {
      const f = liveRelease(flow);
      if (!f) return null;
      releases.delete(flow);
      return async () => {
        const rk = await recoverySigner(f.raw);
        await reg.signedCall('/v1/release/key', 'release-key', {}, { rsign: rk.sign });
      };
    };
  }

  return {
    enabled, open, authed, refreshKind,
    close() { if (job) job.abort(); moves.clear(); releases.clear(); },
  };
}
