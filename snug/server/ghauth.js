// Sign in with GitHub (design section 3): GitHub's Device Flow, run here in
// the local server, then the registry (server/regclient.js) for the Snug
// account. GitHub is used only to prove who someone is: its token goes to the
// registry once and is dropped, and no GitHub name or id is ever stored or
// shown. After sign-in the person has a Snug username and nothing else.
//
// Routes (loopback only, and 404 when no registry is configured):
//   GET  /api/gh/config           {enabled, owner, resume}: what the sign-in screen offers
//   POST /api/gh/start            {link?, purpose?} -> {flow, userCode, verificationUri, expiresIn}
//   POST /api/gh/wait             {flow} -> held up to 25 s, then {state, ...}
//   POST /api/gh/claim            {flow, username} -> {user} (cookie)
//   POST /api/gh/rebind           {flow} -> {user, state:'moving', at} (cookie)
//   POST /api/gh/cancel           {flow} -> {ok}
//   POST /api/gh/resume           -> {user} (cookie), desktop only (the per-launch resume cookie)
//   GET  /api/gh/check?name=&flow= -> {ok} | {ok:false, error, message}
// Ops: id.rename {username}, id.rebind {approve}.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HUES } from '../js/lib/util.js';
import { normalize, check } from '../js/lib/usernames.js';
import { nameMessage, localNameProblem } from '../js/lib/username-text.js';
import { createSession, sessionCookie, readCookie, COOKIE, tokenHash, SESSION_DAYS } from './auth.js';
import { UserError } from './ops.js';

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0'; } })();
const DAY = 86_400_000;
const HOLD_MS = 25_000;      // how long /api/gh/wait holds a request open
const MAX_FLOWS = 3;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const fail = (m) => { throw new UserError(m); };

// Registry and GitHub trouble, in words (never a code, never a response body).
function regMessage(e, name) {
  const code = e?.code;
  const known = nameMessage(code, name);
  if (known) return known;
  switch (code) {
    case 'rename_too_soon': return `You can change your username once every 7 days.${e.retryAt ? ` Next change: ${new Date(e.retryAt).toDateString()}.` : ''}`;
    case 'rebind_blocked': return 'Your other PC stopped a move in the last day. Try again tomorrow, and check your GitHub account’s security.';
    case 'bad_ticket': return 'That sign-in took too long. Start again.';
    case 'github_invalid': return 'GitHub didn’t accept that sign-in. Start again.';
    case 'github_unavailable': return 'GitHub is busy. Try again in a few minutes.';
    case 'stale': return 'This PC’s clock is off. Set it to the right time, then try again.';
    default: return 'Can’t reach Snug’s directory right now. Try again soon.';
  }
}

export function createGhAuth({ db, M, hub, peer, opts = {}, secure = false, log = () => {}, agentOf = () => '', userOf }) {
  const { registryUrl, githubClientId, githubBase = 'https://github.com', resumeSecret = null, trustProxy = false } = opts;
  const fetchFn = opts.fetch || globalThis.fetch;
  const enabled = !!(registryUrl && githubClientId && peer?.enabled);
  const deviceUri = `${githubBase}/login/device`;
  const flows = new Map(); // flow id -> {deviceCode, interval, expires, status, timer, waiters, ...}
  const identity = peer?.identity;
  const reg = peer?.reg;

  // From this machine, and addressed to it by name: a site whose name points at 127.0.0.1 (DNS
  // rebinding) also arrives from loopback, but with its own Host (and a matching Origin).
  const hostOk = (req) => { try { return LOCAL_NAMES.has(new URL(`http://${req.headers.host}`).hostname); } catch { return false; } };
  const loopback = (req) => LOOPBACK.has(req.socket.remoteAddress) && !trustProxy
    && !req.headers['x-forwarded-for'] && !req.headers.forwarded && hostOk(req);

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

  // ---------- GitHub Device Flow ----------
  async function github(path, params) {
    const res = await fetchFn(`${githubBase}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `Snug/${VERSION}` },
      body: new URLSearchParams(params).toString(),
    });
    if (res.status === 429 || res.status >= 500) throw Object.assign(new Error('busy'), { busy: true });
    const d = await res.json().catch(() => ({}));
    if (!res.ok && !d.error) throw Object.assign(new Error('github'), { busy: res.status === 403 });
    return d;
  }

  function settle(f, status, extra = {}) {
    if (f.status !== 'pending') return;
    clearTimeout(f.timer);
    Object.assign(f, extra, { status });
    for (const w of f.waiters) w();
    f.waiters.clear();
  }
  function dropFlow(id) {
    const f = flows.get(id);
    if (!f) return;
    clearTimeout(f.timer);
    for (const w of f.waiters) w();
    flows.delete(id);
  }

  // One timer per pending flow, at GitHub's interval: the only polling in P2P, and only while someone signs in.
  function schedule(id) {
    const f = flows.get(id);
    if (!f || f.status !== 'pending') return;
    f.timer = setTimeout(() => poll(id).catch((e) => { log('gh', 'poll', e.busy ? 'busy' : 'error'); const g = flows.get(id); if (g) settle(g, e.busy ? 'busy' : 'error'); }), f.interval * 1000);
    f.timer.unref?.();
  }
  async function poll(id) {
    const f = flows.get(id);
    if (!f || f.status !== 'pending') return;
    if (Date.now() > f.expires) { settle(f, 'expired'); return; }
    let d;
    try {
      d = await github('/login/oauth/access_token', { client_id: githubClientId, device_code: f.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    } catch (e) {
      if (++f.trouble > 3) { settle(f, 'busy'); return; }
      f.interval += 5;
      schedule(id);
      return;
    }
    if (!flows.has(id) || f.status !== 'pending') return; // cancelled while asking
    if (d.error === 'authorization_pending') { schedule(id); return; }
    if (d.error === 'slow_down') {
      if (++f.trouble > 3) { settle(f, 'busy'); return; }
      f.interval = (Number(d.interval) || f.interval) + 5;
      schedule(id);
      return;
    }
    if (d.error === 'expired_token') { settle(f, 'expired'); return; }
    if (d.error === 'access_denied') { settle(f, 'denied'); return; }
    let token = typeof d.access_token === 'string' ? d.access_token : null;
    d = null;
    if (!token) { log('gh', 'device flow', 'no token'); settle(f, 'error', { message: 'GitHub didn’t finish the sign-in. Start again.' }); return; }
    let a;
    try { a = await reg.authGithub(token); } catch (e) {
      log('gh', 'registry auth', e.code || 'error');
      settle(f, e.code === 'github_unavailable' || e.code === 'rate_limited' ? 'busy' : 'error', { message: regMessage(e) });
      return;
    } finally { token = null; }
    outcome(f, a);
  }

  // ---------- Local accounts ----------
  const self = () => identity.self();
  const userRow = (id) => (id ? M.userRow(id) : null);
  const handleFree = (handle, id) => !db.get('SELECT 1 FROM users WHERE handle = ? AND id != ?', handle, id || '');
  // The owner's local row for a registry account: u_<uid>, created on first sign-in.
  function ensureOwnerRow(uid, username) {
    const s = self();
    const id = s?.uid === uid && s.user && userRow(s.user) ? s.user : `u_${uid}`;
    if (!userRow(id)) {
      const handle = handleFree(username, id) ? username : `${username}.${uid.slice(0, 4)}`.slice(0, 32);
      const hue = HUES[Math.floor(Math.random() * HUES.length)][0];
      db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, '!', ?, ?)", id, handle, username, hue, Date.now());
    } else if (userRow(id).deleted) {
      // Deleted here without freeing the name (no GitHub check then): signing in again starts the row afresh.
      const handle = handleFree(username, id) ? username : `${username}.${uid.slice(0, 4)}`.slice(0, 32);
      db.run('UPDATE users SET deleted = NULL, deactivated = NULL, handle = ?, name = ?, presence = ? WHERE id = ?', handle, username, 'around', id);
      hub.userChanged(id);
    } else if (userRow(id).deactivated) {
      db.run('UPDATE users SET deactivated = NULL WHERE id = ?', id);
      hub.userChanged(id);
    }
    return id;
  }
  // Someone else's account already lives here: one Snug account per PC (design section 0).
  const otherAccount = (uid) => { const s = self(); return !!(s?.uid && s.uid !== uid); };

  // What the registry said about this GitHub account, turned into the flow's next step.
  function outcome(f, a) {
    const uid = a.account?.uid;
    if (f.purpose === 'release') {
      if (a.status === 'ok' && uid && uid === self()?.uid) settle(f, 'confirmed', { ticket: a.ticket });
      else settle(f, 'error', { message: 'That’s not the GitHub account this Snug account uses.' });
      return;
    }
    if (f.link && a.status !== 'new') { settle(f, 'error', { message: 'That GitHub account already has a Snug username. Use another GitHub account to connect this one.' }); return; }
    if (a.status === 'new') {
      if (otherAccount(null)) { settle(f, 'error', { message: 'This PC is linked to another Snug account.' }); return; }
      settle(f, 'choose-name', { ticket: a.ticket, owner: !!a.owner });
      return;
    }
    if (!uid || otherAccount(uid)) { settle(f, 'error', { message: 'This PC is linked to another Snug account.' }); return; }
    if (a.status === 'ok') {
      const user = ensureOwnerRow(uid, a.account.username);
      identity.setSelf({ uid, username: a.account.username, user, kver: a.account.kver, state: 'ok', renamedAt: a.account.renamedAt || null });
      peer.start();
      settle(f, 'signed-in', { user });
      return;
    }
    if (a.status === 'rebind') { settle(f, 'rebind', { ticket: a.ticket, username: a.account.username, uid }); return; }
    if (a.status === 'pending') {
      const user = ensureOwnerRow(uid, a.account.username);
      identity.setSelf({ uid, username: a.account.username, user, kver: a.account.kver, state: 'moving', rebindAt: a.at });
      peer.start();
      settle(f, 'moving', { user, at: a.at });
      return;
    }
    settle(f, 'error', { message: 'Something went wrong. Start again.' });
  }

  function signIn(res, req, user, body = {}) {
    const token = createSession(db, user, agentOf(req));
    send(res, 200, { ...body, user: M.userView(M.userRow(user), M.userRow(user).presence, true) }, { 'Set-Cookie': sessionCookie(token, { secure }) });
  }
  const oldestLocal = () => db.get("SELECT id FROM users WHERE remote IS NOT 1 AND deleted IS NOT 1 AND pass != '!' ORDER BY created, rowid LIMIT 1")?.id;
  const flowOf = (d) => (typeof d.flow === 'string' ? flows.get(d.flow) : null);

  // ---------- Routes with no session ----------
  async function open(req, res, path, url) {
    if (!path.startsWith('/api/gh/')) return false;
    const post = req.method === 'POST';
    if (path === '/api/gh/config' && req.method === 'GET') {
      if (!enabled || !loopback(req)) { send(res, 200, { enabled: false }); return true; }
      const s = self();
      const resumable = s?.user && (s.state === 'ok' || s.state === 'moving') && userRow(s.user) && !userRow(s.user).deleted && resumeOk(req);
      // A signed-in password account may connect GitHub if it is the PC's first account and the PC has no Snug account (S18).
      const me = userOf(req);
      const canLink = !!me && !s?.uid && me === oldestLocal();
      send(res, 200, { enabled: true, owner: !!(s?.user && userRow(s.user)), resume: resumable ? s.username : null, ...(canLink ? { canLink } : {}) });
      return true;
    }
    if (!enabled) { err(res, 404, 'Not found'); return true; }
    if (!loopback(req)) { err(res, 403, 'GitHub sign-in works only in the Snug app on this PC.'); return true; }

    if (post && path === '/api/gh/start') {
      const d = await json(req);
      const f = { status: 'pending', waiters: new Set(), trouble: 0 };
      if (d.purpose === 'release' || d.link === true) {
        const user = userOf(req);
        if (!user) { err(res, 401, 'Sign in first.'); return true; }
        if (d.purpose === 'release') {
          if (!peer.isOwner(user)) { err(res, 403, 'Only this PC’s Snug account can do that.'); return true; }
          f.purpose = 'release';
        } else {
          if (user !== oldestLocal()) { err(res, 403, 'Only the first account made on this PC can connect GitHub.'); return true; }
          if (self()?.uid) { err(res, 409, 'This PC is linked to another Snug account.'); return true; }
          f.link = user;
        }
      }
      let g;
      try { g = await github('/login/device/code', { client_id: githubClientId, scope: '' }); } catch (e) {
        log('gh', 'device code', e.busy ? 'busy' : 'error');
        err(res, 503, e.busy ? 'GitHub is busy. Try again in a few minutes.' : 'Can’t reach GitHub. Check your connection and try again.');
        return true;
      }
      if (!g.device_code || !g.user_code) { log('gh', 'device code', g.error || 'bad reply'); err(res, 502, 'GitHub didn’t start the sign-in. Try again in a few minutes.'); return true; }
      while (flows.size >= MAX_FLOWS) dropFlow(flows.keys().next().value);
      const id = randomBytes(16).toString('base64url');
      Object.assign(f, {
        deviceCode: g.device_code, userCode: String(g.user_code).slice(0, 16),
        interval: Math.min(Math.max(Number(g.interval) || 5, 1), 60),
        expires: Date.now() + Math.min(Number(g.expires_in) || 900, 900) * 1000,
      });
      flows.set(id, f);
      schedule(id);
      // Only GitHub's own device page is ever passed on (S19).
      const uri = typeof g.verification_uri === 'string' && g.verification_uri.startsWith(deviceUri) ? g.verification_uri : deviceUri;
      send(res, 200, { flow: id, userCode: f.userCode, verificationUri: uri, expiresIn: Math.round((f.expires - Date.now()) / 1000) });
      return true;
    }

    if (post && path === '/api/gh/wait') {
      const d = await json(req);
      const f = flowOf(d);
      if (!f) { send(res, 200, { state: 'expired' }); return true; }
      if (f.status === 'pending') {
        await new Promise((resolve) => {
          const t = setTimeout(done, HOLD_MS);
          function done() { clearTimeout(t); f.waiters.delete(done); resolve(); }
          f.waiters.add(done);
          res.on('close', done); // the app went away mid-wait
        });
      }
      if (res.writableEnded || res.destroyed) return true;
      if (!flows.has(d.flow)) { send(res, 200, { state: f.status === 'pending' ? 'expired' : f.status }); return true; }
      switch (f.status) {
        case 'pending': send(res, 200, { state: 'pending' }); break;
        case 'signed-in': flows.delete(d.flow); signIn(res, req, f.user, { state: 'signed-in' }); break;
        case 'moving': flows.delete(d.flow); signIn(res, req, f.user, { state: 'moving', at: f.at }); break;
        case 'choose-name': send(res, 200, { state: 'choose-name', owner: !!f.owner }); break;
        case 'rebind': send(res, 200, { state: 'rebind', username: f.username }); break;
        case 'confirmed': send(res, 200, { state: 'confirmed' }); break;
        default: flows.delete(d.flow); send(res, 200, { state: f.status, ...(f.message ? { message: f.message } : {}) });
      }
      return true;
    }

    if (post && path === '/api/gh/claim') {
      const d = await json(req);
      const f = flowOf(d);
      if (!f || f.status !== 'choose-name') { err(res, 409, 'That sign-in took too long. Start again.', 'bad_ticket'); return true; }
      const username = normalize(d.username).slice(0, 64);
      const problem = localNameProblem(username, { owner: f.owner });
      if (problem) { err(res, 400, problem, check(username, { owner: f.owner })); return true; }
      if (otherAccount(null)) { err(res, 409, 'This PC is linked to another Snug account.'); return true; }
      if (!handleFree(username, f.link)) { err(res, 409, 'That username is used by another account on this PC. Try another.', 'taken'); return true; }
      let account;
      try { ({ account } = await reg.claim(f.ticket, username)); } catch (e) {
        log('gh', 'claim', e.code || 'error');
        if (e.code === 'bad_ticket' || e.code === 'already_claimed') flows.delete(d.flow);
        err(res, e.status && e.status < 500 ? (e.status === 429 ? 429 : 409) : 502, regMessage(e, username), e.code);
        return true;
      }
      flows.delete(d.flow);
      let user;
      if (f.link) {
        // The account is GitHub-secured from now on: no password, no authenticator (section 3.3).
        user = f.link;
        db.run("UPDATE users SET handle = ?, pass = '!' WHERE id = ?", account.username, user);
        try { db.run('DELETE FROM totp WHERE user = ?', user); } catch { /* two-factor not set up */ }
      } else user = ensureOwnerRow(account.uid, account.username);
      identity.setSelf({ uid: account.uid, username: account.username, user, kver: account.kver, state: 'ok', renamedAt: null });
      peer.start();
      if (f.link) { hub.userChanged(user); send(res, 200, { user: M.userView(M.userRow(user), M.userRow(user).presence, true) }); return true; }
      signIn(res, req, user);
      return true;
    }

    if (post && path === '/api/gh/rebind') {
      const d = await json(req);
      const f = flowOf(d);
      if (!f || f.status !== 'rebind') { err(res, 409, 'That sign-in took too long. Start again.', 'bad_ticket'); return true; }
      let r;
      try { r = await reg.rebind(f.ticket); } catch (e) {
        log('gh', 'rebind', e.code || 'error');
        flows.delete(d.flow);
        err(res, e.status === 429 ? 429 : 409, regMessage(e), e.code);
        return true;
      }
      flows.delete(d.flow);
      const uid = r.uid || f.uid;
      const user = ensureOwnerRow(uid, f.username);
      identity.setSelf({ uid, username: f.username, user, state: 'moving', rebindAt: r.at });
      peer.start();
      signIn(res, req, user, { state: 'moving', at: r.at });
      return true;
    }

    if (post && path === '/api/gh/cancel') {
      const d = await json(req);
      if (typeof d.flow === 'string') dropFlow(d.flow);
      send(res, 200, { ok: true });
      return true;
    }

    if (post && path === '/api/gh/resume') {
      const s = self();
      if (!resumeOk(req) || !s?.user || !(s.state === 'ok' || s.state === 'moving') || !userRow(s.user) || userRow(s.user).deleted) {
        err(res, 403, 'Sign in with GitHub to continue.');
        return true;
      }
      if (userRow(s.user).deactivated) { db.run('UPDATE users SET deactivated = NULL WHERE id = ?', s.user); hub.userChanged(s.user); }
      signIn(res, req, s.user);
      return true;
    }

    if (req.method === 'GET' && path === '/api/gh/check') {
      const name = normalize(url.searchParams.get('name')).slice(0, 64);
      const f = flows.get(url.searchParams.get('flow') || '');
      const owner = !!f?.owner;
      const problem = localNameProblem(name, { owner });
      if (problem) { send(res, 200, { ok: false, error: check(name, { owner }), message: problem }); return true; }
      if (!handleFree(name, f?.link || self()?.user)) { send(res, 200, { ok: false, error: 'taken', message: 'That username is used by another account on this PC. Try another.' }); return true; }
      try {
        const r = await reg.check(name);
        // The registry checks names as a stranger would: an owner name is fine for the owner.
        if (r.ok || (owner && r.error === 'owner_only')) send(res, 200, { ok: true });
        else send(res, 200, { ok: false, error: r.error, message: regMessage({ code: r.error }, name) });
      } catch (e) {
        send(res, 200, { ok: null, error: e.code || 'unavailable', message: regMessage(e, name) });
      }
      return true;
    }
    err(res, 404, 'Not found');
    return true;
  }

  function resumeOk(req) {
    if (!resumeSecret) return false;
    const got = Buffer.from(String(readCookie(req.headers.cookie, 'snug_resume') || ''));
    const want = Buffer.from(String(resumeSecret));
    return got.length === want.length && timingSafeEqual(got, want);
  }

  // ---------- Routes for a signed-in person ----------
  async function authed(req, res, path, user) {
    // Sliding sign-in (S23): a session that is used keeps going, up to 90 days from sign-in.
    if (req.method === 'GET' && path === '/api/me') refresh(req, res);
    if (!enabled || !peer.isOwner(user)) return false;
    if (req.method === 'POST' && path === '/api/password') { err(res, 403, 'Your account is secured by GitHub sign-in.'); return true; }
    return false;
  }
  function refresh(req, res) {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token) return;
    const s = db.get('SELECT created, expires FROM sessions WHERE hash = ?', tokenHash(token));
    const now = Date.now();
    if (!s || s.expires - now > 15 * DAY) return;
    const next = Math.min(now + SESSION_DAYS * DAY, s.created + 90 * DAY);
    if (next <= s.expires) return;
    db.run('UPDATE sessions SET expires = ? WHERE hash = ?', next, tokenHash(token));
    res.setHeader('Set-Cookie', sessionCookie(token, { secure }).replace(/Max-Age=\d+/, `Max-Age=${Math.floor((next - now) / 1000)}`));
  }

  // ---------- Ops ----------
  if (enabled) {
    const ownerOnly = (c) => { if (!peer.isOwner(c.user) || c.peer) fail('Only this PC’s Snug account can do that.'); };
    // Change the Snug username: the registry first (7-day rule, uniqueness), then this PC.
    hub.ops['id.rename'] = async (c, d) => {
      ownerOnly(c);
      const s = self();
      if (s.state !== 'ok') fail('Your account isn’t active on this PC right now.');
      const username = normalize(d.username).slice(0, 64);
      const problem = localNameProblem(username, { owner: true }); // owner-only names: the registry decides
      if (problem) fail(problem);
      if (username === s.username) fail('That’s already your username.');
      if (!handleFree(username, c.user)) fail('That username is used by another account on this PC. Try another.');
      let account;
      try { ({ account } = await reg.rename(username)); } catch (e) { log('gh', 'rename', e.code || 'error'); fail(regMessage(e, username)); }
      identity.setSelf({ username: account.username, renamedAt: account.renamedAt || Date.now() });
      if (handleFree(account.username, c.user)) db.run('UPDATE users SET handle = ? WHERE id = ?', account.username, c.user);
      hub.userChanged(c.user);
      const status = peer.statusFor(c.user);
      hub.toUser(c.user, 'p2p', status);
      return { username: account.username, renameAt: account.renameAt || status.renameAt };
    };
    // The old PC's answer to a move (section 6.4).
    hub.ops['id.rebind'] = async (c, d) => {
      ownerOnly(c);
      try {
        if (d.approve === true) await peer.approveRebind();
        else await peer.cancelRebind();
      } catch (e) { if (e instanceof UserError) throw e; log('gh', 'rebind answer', e.code || 'error'); fail(regMessage(e)); }
      return {};
    };
    // P2P accounts have no password: these need GitHub instead (section 3.3).
    const noPassword = (name, text) => {
      const base = hub.ops[name];
      if (!base) return;
      hub.ops[name] = (c, d) => { if (peer.isOwner(c.user) && !c.peer) fail(text); return base(c, d); };
    };
    for (const n of ['totp.begin', 'totp.enable', 'totp.disable', 'totp.codes']) noPassword(n, 'Your account is secured by GitHub sign-in.');
    noPassword('me.handle', 'Your Snug username changes in Settings, under Account.');

    // Account delete and deactivate (server/account.js) for the P2P owner.
    M.p2pOwner = (u) => peer.isOwner(u);
    M.p2pDelete = async (u, d, run) => {
      const f = typeof d.flow === 'string' ? flows.get(d.flow) : null;
      const ticket = f?.status === 'confirmed' ? f.ticket : null;
      if (f) dropFlow(d.flow);
      await peer.leaveAll().catch(() => {}); // every friend hears it as an unfriend
      let released = false;
      if (ticket) {
        try { await reg.release(ticket); released = true; } catch (e) { log('gh', 'release', e.code || 'error'); }
      }
      peer.stop();
      run();
      db.run('DELETE FROM peer_knocks'); // already sent above; nothing waits for a later sign-in
      // Without the GitHub check the keys stay, so signing in again later can free the name.
      if (released) identity.forget();
      identity.clearSelf();
      return { released };
    };
  }

  return {
    enabled, open, authed,
    close() { for (const id of [...flows.keys()]) dropFlow(id); },
  };
}
