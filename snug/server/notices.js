// v0.10: what the Snug registry tells this PC beyond P2P (design section 5.5): announcements, the
// minimum app version, this account's admin rights, a suspension (ban or timeout), and forced username
// changes. The registry enforces all of it; this module only shows it and relays the admin panel's calls.
//
//   createNotices({ db, M, hub, peer, log }) -> { state, viewFor(user), close() }
//   op admin.call {a, ...args}   owner only, never from a friend's PC; signed by this PC's key
//   event 'notices'               { ann, min } for everyone on this PC, plus { admin, ban, outdated } for the owner
//   snapshot.notices              the same
import { UserError } from './ops.js';
import { limiter } from './auth.js';
import { APP_VERSION } from './peersignal.js';

const fail = (m) => { throw new UserError(m); };
const isName = (s) => typeof s === 'string' && /^[a-z0-9_.]{1,32}$/.test(s);
const PERMS = new Set(['stats', 'names', 'ban', 'ann', 'update', 'grant']);
const MAX_WAIT = 2 ** 31 - 1;

const MESSAGES = {
  forbidden: 'You don’t have that admin right.',
  banned: 'Your Snug account is suspended.',
  not_found: 'Nobody by that name or id.',
  rate_limited: 'Too many admin actions. Try again later.',
  stale: 'This PC’s clock is off. Set it to the right time, then try again.',
  bad_signature: 'The registry didn’t accept this PC’s key. Sign in with GitHub again.',
};

function cleanAnn(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).filter((a) => a && typeof a.id === 'string' && typeof a.text === 'string').map((a) => ({
    id: a.id.slice(0, 64), text: a.text.slice(0, 500), level: a.level === 'warn' ? 'warn' : 'info',
    at: Number.isSafeInteger(a.at) ? a.at : 0, until: Number.isSafeInteger(a.until) ? a.until : null,
  }));
}

export function createNotices({ db, M, hub, peer, log = () => {} }) {
  const state = { ann: [], min: null, admin: [], ban: null, outdated: null };
  const owner = () => peer.identity?.self()?.user || null;
  const ownerOnly = (c) => { if (!c.user || c.user !== owner() || c.peer) fail('Only this PC’s Snug account can do that.'); };
  const limit = limiter({ capacity: 5, perSecond: 5 });
  let banTimer = null;

  const viewFor = (u) => {
    const v = { ann: state.ann, min: state.min };
    if (u && u === owner()) Object.assign(v, { admin: state.admin, ban: state.ban, outdated: state.outdated });
    return v;
  };
  const localUsers = () => db.all('SELECT id FROM users WHERE remote IS NOT 1 AND deleted IS NULL').map((r) => r.id);
  const pushAll = () => { for (const u of localUsers()) hub.toUser(u, 'notices', viewFor(u)); };
  const pushOwner = () => { const o = owner(); if (o) hub.toUser(o, 'notices', viewFor(o)); };

  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => { const s = baseSnap(u); s.notices = viewFor(u); return s; };

  hub.ops['admin.call'] = async (c, d) => {
    ownerOnly(c);
    if (!peer.enabled || !peer.reg?.signedCall) fail('Snug isn’t linked to the registry.');
    if (!d || typeof d.a !== 'string' || d.a.length > 32) fail('That admin action isn’t valid.');
    if (!limit.take(c.user)) fail('Slow down a little.');
    const payload = { ...d, app: APP_VERSION };
    let r;
    try {
      r = await peer.reg.signedCall('/v1/admin', 'admin', payload);
    } catch (e) {
      if (e.code === 'offline' || e.code === 'unavailable' || e.code === 'config_error') fail('Can’t reach Snug’s directory right now. Try again soon.');
      fail(MESSAGES[e.code] || (e.status && e.status < 500 && e.message) || 'Something went wrong. Try again.');
    }
    if (d.a === 'me' && Array.isArray(r?.perms)) setAdmin(r.perms);
    return r;
  };

  function setAdmin(perms) {
    const next = Array.isArray(perms) ? perms.filter((p) => PERMS.has(p)) : [];
    if (next.join() === state.admin.join()) return;
    state.admin = next;
    pushOwner();
  }
  function setNotices(n) {
    if (!n || typeof n !== 'object') return;
    state.ann = cleanAnn(n.ann);
    state.min = typeof n.min === 'string' && n.min.length <= 32 ? n.min : null;
    pushAll();
  }

  const HOUR = Number(process.env.SNUG_BAN_RETRY_MS) || 3600_000;
  function retryIn(ms) {
    clearTimeout(banTimer);
    banTimer = setTimeout(() => { banTimer = null; try { peer.stop(); peer.start(); } catch (e) { log('notices', 'restart', e.message); } }, Math.min(MAX_WAIT, ms));
    banTimer.unref?.();
  }
  if (peer.enabled && peer._signal) {
    const sig = peer._signal;
    sig.on('ready', (m) => {
      if (m.mode === 'xfer') return;
      const wasBlocked = state.ban || state.outdated;
      state.ban = null;
      state.outdated = null;
      clearTimeout(banTimer);
      state.admin = Array.isArray(m.admin) ? m.admin.filter((p) => PERMS.has(p)) : [];
      if (m.notices) setNotices(m.notices); else pushAll();
      if (wasBlocked) pushOwner();
    });
    sig.on('notices', (m) => setNotices(m));
    sig.on('admin', (m) => setAdmin(m.perms));
    sig.on('account', (m) => {
      if (!isName(m.username)) return;
      const self = peer.identity.self();
      const o = owner();
      if (!self || !o || self.username === m.username) return;
      peer.identity.setSelf({ username: m.username });
      // The local handle follows when nobody else on this PC holds it.
      if (!db.get('SELECT 1 FROM users WHERE handle = ? AND id != ?', m.username, o)) db.run('UPDATE users SET handle = ? WHERE id = ?', m.username, o);
      log('notices', 'the registry changed this account’s username');
      hub.userChanged(o);
      const status = peer.statusFor(o);
      hub.toUser(o, 'p2p', status ? { ...status, username: m.username } : { username: m.username });
    });
    sig.on('banned', (b) => {
      state.ban = { until: b.until ?? null, reason: b.reason || '' };
      clearTimeout(banTimer);
      // Try again when a timeout ends, and at least hourly: a suspension lifted early (or one "for good"
      // that is lifted) reconnects within the hour, not only after a restart (review 0.10 #4).
      retryIn(b.until ? Math.min(HOUR, Math.max(1000, b.until - Date.now() + 1500)) : HOUR);
      log('notices', 'this account is suspended', b.until ? `until ${new Date(b.until).toISOString()}` : 'for good');
      pushOwner();
    });
    sig.on('outdated', (o) => {
      state.outdated = { min: o.min || null };
      retryIn(HOUR); // the minimum may be lowered again
      if (o.min) state.min = o.min;
      log('notices', 'the registry needs a newer Snug', o.min || '');
      pushAll();
    });
  }

  return {
    state, viewFor,
    close() { clearTimeout(banTimer); banTimer = null; },
  };
}
