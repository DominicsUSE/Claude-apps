// The peer module (design sections 4-7, 9): makes this local server a "mini
// server" for its owner that talks straight to friends' PCs.
//
// - Friend requests, accepts, declines and removals travel as sealed knocks
//   through the registry (stored there until fetched).
// - Direct messages, edits, deletes, reactions, typing, profiles, call
//   signaling and media go over a link between the two PCs (server/peerlink.js).
// - A friend on another PC is a local "shadow" users row (u_<uid>, remote=1),
//   so every existing read path, permission check and op works unchanged:
//   inbound items are applied by calling the same ops as the shadow.
//
// Without a registry configured (tests, LAN servers, plain `npm start`) the
// module does nothing at all: no wrappers, no tables touched beyond migrations.
import { unlinkSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createIdentity } from './identity.js';
import { createRegClient } from './regclient.js';
import { createSignal } from './peersignal.js';
import { createLinks } from './peerlink.js';
import { createBlobs } from './peerblob.js';
import { migratePeer, createOutbox } from './peerdb.js';
import {
  canon, sha256, b64u, seal, parseBox, boxVerify, boxOpen, profileSign, profileVerify, newer, nextVer, keychangeSign,
  chainCheck, dmIdFor, remoteFileId, remoteMediaId, shadowId, randomEp, fingerprint, isUid, isKey, hsVerify,
} from './peercrypto.js';
import { UserError, rtcSignal } from './ops.js'; // sec-integrate: rtcSignal, the same check a local call member gets
import { limiter } from './auth.js';
import { uploadType, AUDIO_TYPES, VIDEO_TYPES } from './media.js';
import { imageInfo, POLL_HOURS } from './messaging.js';
import { HUES } from '../js/lib/util.js';

const DAY = 86_400_000;
// Files between PCs. A 0.11 PC refuses a whole message with a file over 10 MB,
// so bigger ones go only to PCs whose signed profile says they take them
// (`maxFile`); a PC that says nothing is treated as 0.11.
export const OLD_MAX_FILE = 10 * 1024 * 1024;
export const P2P_MAX_FILE = 100 * 1024 * 1024;
export function peerMaxFile(mediaJson) {
  let m = null;
  try { m = JSON.parse(mediaJson || 'null'); } catch { /* none */ }
  const n = m && Number.isSafeInteger(m.maxFile) ? m.maxFile : 0;
  return Math.min(P2P_MAX_FILE, Math.max(OLD_MAX_FILE, n));
}
const BLOB_HOUR = 300 * 1024 * 1024; // bytes fetched from one friend in an hour
const MAX_PIC = 2 * 1024 * 1024;
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const MSG_ID = /^m_[a-z0-9]{8,40}$/;
// 0.12: what this PC understands beyond 0.11, told to friends in its signed
// profile. A friend's PC is only sent these frames once its profile lists them
// (a 0.11 PC refuses a frame it doesn't know): thread replies over the link,
// pins, and the disappearing-messages timer. 0.13: polls (a poll, its votes and its end).
export const PEER_CAPS = ['thread', 'pin', 'ttl', 'poll'];
const TTLS = [0, 3_600_000, 86_400_000, 7 * 86_400_000, 30 * 86_400_000];
const CALL_ID = /^call_[a-z0-9]{8,40}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
// A registry username as stored there (js/lib/usernames.js); "1" and "a" are the owner's one-letter names.
const isUsername = (s) => typeof s === 'string' && /^[a-z0-9_.]{1,32}$/.test(s);
const PIC_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const SHOWN_TYPES = new Set([...PIC_TYPES, ...AUDIO_TYPES, ...VIDEO_TYPES]);
// Bidi overrides and zero-width characters, stripped from a friend's profile text (S27).
const INVISIBLE = /[‪-‮⁦-⁩​-‏﻿]/g;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const fail = (m) => { throw new UserError(m); };
const rid = () => b64u(randomBytes(12)).replace(/[-_]/g, 'x').toLowerCase();

export function createPeer({ db, M, hub, ops, filesDir, log = () => {}, opts = {} }) {
  migratePeer(db);
  // 0.12: each friend's capabilities, from their profile.
  if (!db.all('PRAGMA table_info(peers)').some((c) => c.name === 'caps')) db.run('ALTER TABLE peers ADD COLUMN caps TEXT');
  const identity = createIdentity({ dataDir: opts.dataDir ?? ':memory:', keyStore: opts.keyStore, db });
  const reg = createRegClient({ url: opts.registryUrl, identity, fetch: opts.fetch });
  const enabled = !!opts.registryUrl;
  const stats = {
    links: 0, direct: 0, relay: 0, directFail: 0, relayed: false, framesIn: 0, framesOut: 0, profilePushes: 0,
    profileApplied: 0, blobsFetched: 0, rejected: 0, knocksIn: 0, knocksOut: 0,
  };
  const P = {
    identity, reg, enabled,
    start() {}, stop() {}, close() {}, wake() {}, housekeep() {},
    isOwner: () => false, isRemote: () => false, isOnline: () => false,
    statusFor: () => null,
    approveRebind: async () => fail('Snug isn’t linked to a registry.'),
    cancelRebind: async () => fail('Snug isn’t linked to a registry.'),
    leaveAll: async () => {},
    missing: () => false,
    serveMissing: async () => false,
    stats: () => ({ ...stats, outbox: 0, held: 0 }),
    capsOf: () => [],
  };
  if (!enabled) return P;

  const outbox = createOutbox(db);
  const online = new Set();          // uids of friends the registry says are online
  const remote = new Set(db.all('SELECT id FROM users WHERE remote = 1').map((r) => r.id));
  let self = identity.self();
  const refreshSelf = () => { self = identity.self(); return self; };
  for (const k of ['setSelf', 'clearSelf']) { const f = identity[k]; identity[k] = (...a) => { const r = f(...a); refreshSelf(); return r; }; }
  const owner = () => (self && self.user) || null;
  const myUid = () => self?.uid || null;
  const active = () => !!(self?.uid && self.user && (self.state === 'ok' || self.state === 'moving'));
  const isRemote = (u) => typeof u === 'string' && remote.has(u);
  const uidOf = (u) => (isRemote(u) ? u.slice(2) : null);
  const peerOf = (uid) => db.get('SELECT * FROM peers WHERE uid = ?', uid);
  const toOwner = (ev, d) => { const o = owner(); if (o) hub.toUser(o, ev, d); };
  let rebindPending = null;          // {at, kver, ik, xk} on the old PC while a move is pending
  let registry = 'offline';
  let started = false;
  const p2pEvent = (extra = {}) => toOwner('p2p', { state: self?.state || null, registry, ...extra });
  // v0.10 B: groups across PCs (server/peergroups.js) fill these in; the defaults keep 0.9 behaviour.
  const G = {
    contact: () => false,          // uid -> true when they share a group across PCs with me
    watch: () => [],               // extra uids to watch (co-members)
    acked: () => {}, expired: () => {}, up: () => {}, online: () => {},
  };

  // ---------- Shadows (section 4) ----------
  function shadowHandle(uid, username) {
    const taken = db.get('SELECT id FROM users WHERE handle = ? AND id != ?', username, shadowId(uid));
    return taken ? `${username}.${uid.slice(0, 4)}`.slice(0, 32) : username;
  }
  // Make (or refresh) the local row for a friend on another PC, pinning their key on first sight (TOFU).
  function ensureShadow(info) {
    const { uid, username } = info;
    // The registry is checked too: its answer becomes a local handle and a pinned key (S26).
    if (!isUid(uid) || uid === myUid() || !isKey(info.ik) || !isKey(info.xk) || !isUsername(username)
      || !Number.isSafeInteger(info.kver) || info.kver < 1) fail('That person isn’t on Snug.');
    const id = shadowId(uid);
    const t = Date.now();
    db.tx(() => {
      if (!M.userRow(id)) {
        const hue = HUES[Math.floor(Math.random() * HUES.length)][0];
        db.run("INSERT INTO users (id, handle, name, pass, hue, created, remote) VALUES (?, ?, ?, '!', ?, ?, 1)", id, shadowHandle(uid, username), username, hue, t);
      }
      if (!peerOf(uid)) {
        db.run('INSERT INTO peers (user, uid, username, ik, xk, kver, pinned_at, out_ep) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id, uid, username, info.ik, info.xk, info.kver, t, randomEp());
        db.run('INSERT OR IGNORE INTO peer_keys (uid, kver, ik, xk, at) VALUES (?, ?, ?, ?, ?)', uid, info.kver, info.ik, info.xk, t);
      }
    });
    remote.add(id);
    return id;
  }
  async function shadowFor(uid) {
    if (peerOf(uid)) return shadowId(uid);
    const r = await reg.lookup({ uid });
    if (!r || r.uid !== uid) return null;
    return ensureShadow(r);
  }
  const friendState = (shadow) => M.friendRow(owner(), shadow)?.state || null;
  const isFriend = (shadow) => friendState(shadow) === 'friends';
  // A friend, or someone I share a group across PCs with (design 0.10 4.4).
  const isContact = (shadow) => isFriend(shadow) || !!G.contact(uidOf(shadow) || String(shadow).slice(2));
  const blockedEither = (shadow) => !!db.get('SELECT 1 FROM blocks WHERE (user = ? AND other = ?) OR (user = ? AND other = ?)', owner(), shadow, shadow, owner());
  // The one-to-one conversation with a friend on another PC: both PCs compute the same id (section 7.2).
  function ensureDm(uid) {
    const dm = dmIdFor(myUid(), uid);
    if (!db.get('SELECT 1 FROM dms WHERE id = ?', dm)) {
      db.tx(() => {
        db.run('INSERT INTO dms (id, name, created) VALUES (?, NULL, ?)', dm, Date.now());
        for (const u of [owner(), shadowId(uid)]) db.run('INSERT OR IGNORE INTO dm_members (dm, user) VALUES (?, ?)', dm, u);
      });
      for (const u of [owner(), shadowId(uid)]) hub.sendDm(u, dm);
    }
    return dm;
  }
  // The remote member of a conversation, if it is one-to-one with a friend on another PC.
  function remoteOfDm(conv) {
    if (typeof conv !== 'string' || !conv.startsWith('d_')) return null;
    const members = db.all('SELECT user FROM dm_members WHERE dm = ?', conv).map((r) => r.user);
    const r = members.filter(isRemote);
    return r.length === 1 && members.length === 2 ? r[0] : null;
  }
  hub.isRemoteDm = (dm) => !!remoteOfDm(dm);

  // ---------- Trust (section 6.1) ----------
  const lastLookup = new Map();
  // Check a signature from a friend; on a mismatch, look their key up again
  // (at most once in 10 minutes) and re-pin quietly or loudly by the chain.
  async function verifyFrom(uid, check) {
    const p = peerOf(uid);
    if (!p) return null;
    if (check(p.ik)) return p.ik;
    if (Date.now() - (lastLookup.get(uid) || 0) < 10 * 60_000) return null;
    lastLookup.set(uid, Date.now());
    if (lastLookup.size > 1000) lastLookup.delete(lastLookup.keys().next().value);
    let r;
    try { r = await reg.lookup({ uid }); } catch { return null; }
    if (!r || r.uid !== uid || !Array.isArray(r.chain)) return null;
    const known = db.all('SELECT kver, ik FROM peer_keys WHERE uid = ?', uid);
    const verdict = chainCheck(uid, { kver: p.kver, ik: p.ik }, r.chain, known);
    if (verdict === 'downgrade' || verdict === 'same') { log('peer', 'key refused', verdict); return null; }
    const cur = r.chain[r.chain.length - 1];
    if (!check(cur.ik)) return null;
    repin(uid, cur, verdict === 'loud');
    return cur.ik;
  }
  function repin(uid, key, loud) {
    const p = peerOf(uid);
    const t = Date.now();
    db.tx(() => {
      db.run('UPDATE peers SET ik = ?, xk = ?, kver = ?, pinned_at = ?, in_ep = \'\', in_seq = 0 WHERE uid = ?', key.ik, key.xk, key.kver, t, uid);
      db.run('INSERT OR IGNORE INTO peer_keys (uid, kver, ik, xk, at) VALUES (?, ?, ?, ?, ?)', uid, key.kver, key.ik, key.xk, t);
      if (loud) {
        db.run('UPDATE peers SET key_changed_at = ?, hold_before = ? WHERE uid = ?', t, t, uid);
        outbox.hold(p.user, t);
      }
    });
    if (loud) for (const id of outbox.heldMsgs(p.user)) toOwner('msg.state', { conv: dmIdFor(myUid(), uid), id, state: 'held' });
    toOwner('peer.key', { user: p.user, fingerprint: fingerprint(key.ik, key.xk), at: t, quiet: !loud });
  }

  // ---------- Signal socket ----------
  const signal = createSignal({ reg, identity, log });
  const relayIds = new Map(); // id -> uid, for err replies
  let relayN = 0;
  function relaySend(uid, box) {
    const id = `r${(++relayN).toString(36)}`;
    relayIds.set(id, uid);
    if (relayIds.size > 256) relayIds.delete(relayIds.keys().next().value);
    return signal.send({ t: 'relay', id, to: uid, box });
  }
  function sigSend(uid, obj) {
    const p = peerOf(uid);
    const m = identity.me();
    if (!p || !m) return false;
    const id = rid();
    return signal.send({ t: 'sig', id, to: uid, box: seal(m, uid, p.xk, { ...obj, id, ts: Math.round(reg.now()) }) });
  }
  const sigSeen = new Map();

  // ---------- Link host (the loopback renderer, section 5.2) ----------
  const hosts = [];                  // { ws, desktop, at }
  const currentHost = () => hosts.filter((h) => h.ws.readyState === 1).sort((a, b) => (b.desktop - a.desktop) || (b.at - a.at))[0] || null;
  const toHost = (ev, d) => { const h = currentHost(); if (!h) return false; h.ws.send(JSON.stringify({ t: 'ev', ev, d })); return true; };
  const host = {
    available: () => !!currentHost(),
    dial: (uid, sid, offer) => toHost('peer.dial', { peer: uid, sid, ice: hub.iceFor(owner()), ...(offer ? { offer } : {}) }),
    answer: (uid, sid, sdp) => toHost('peer.answer', { peer: uid, sid, sdp }),
    out: (uid, sid, fs) => toHost('peer.out', { peer: uid, sid, fs }),
    hangup: (uid, sid) => toHost('peer.hangup', { peer: uid, sid }),
  };

  // ---------- Links ----------
  const links = createLinks({
    me: () => identity.me(),
    now: () => reg.now(),
    db, outbox, stats, log,
    peerOf,
    online: (uid) => (online.has(uid) || reach.has(uid)) && active() && self.state === 'ok',
    verifyHs: (uid, hs) => verifyFrom(uid, (ik) => hsVerify(hs, ik)),
    relaySend, sigSend, host,
    hsInfo: () => ({ kver: Number(self?.kver) || 1, pv: Number(identity.get('profile_ver')) || 0 }),
    isUserError: (e) => e instanceof UserError,
    windowFor: (uid) => (blobs.busy(uid) ? 16 : 64),
    onFrame: (uid, Pf) => ingestEphemeral(uid, Pf),
    applyDurable: (uid, Pf) => ingestDurable(uid, Pf),
    onAcked: (uid, rows) => {
      const dm = dmIdFor(myUid(), uid);
      for (const r of rows) if (r.kind === 'dm.msg' && r.ref) toOwner('msg.state', { conv: dm, id: r.ref, state: 'delivered' });
      G.acked(uid, rows);
    },
    onUp: (uid, hs) => {
      retryN.delete(uid);
      // A co-member whose presence I'm not told (friends only on their PC) linked to me: the registry lets me
      // reach them for the rest of their session, so my messages go straight to them (review-media 4).
      if (!online.has(uid)) reach.add(uid);
      const p = peerOf(uid);
      db.run('UPDATE peers SET last_seen = ? WHERE uid = ?', Date.now(), uid);
      // The friend has a newer profile than the one kept here: ask for it.
      if (p && newer([hs.kver, hs.pv], [p.profile_kver, p.profile_ver]) && hs.pv > 0) links.sendEph(uid, 'profile.want', { have: [p.profile_kver, p.profile_ver] });
      syncMedia(uid);
      fetchPending(uid);
      G.up(uid);
    },
    onDown: (uid, why, wasUp) => { if (wasUp) blobs.peerDown(uid); else reach.delete(uid); if (why !== 'stopped') retrySoon(uid); },
    opts: { idleMs: opts.peerIdleMs, dialMs: opts.peerDialMs, maxLinks: opts.peerMaxLinks, direct: opts.peerDirect, hideIp: () => !!self?.hideIp },
  });

  // A link that ended (or never opened) with items still queued for an online friend tries
  // again a little later: 5 s, then doubling up to 5 min while it keeps failing. One timer
  // per such friend at most; a link that comes up resets the wait.
  const retryT = new Map();
  const retryN = new Map();        // uid -> failed tries in a row
  function retrySoon(uid) {
    if (retryT.has(uid) || !online.has(uid) || !outbox.after(shadowId(uid), 0, 1).length) return;
    const n = retryN.get(uid) || 0;
    retryN.set(uid, n + 1);
    const t = setTimeout(() => {
      retryT.delete(uid);
      if (online.has(uid) && outbox.after(shadowId(uid), 0, 1).length) links.want(uid);
    }, Math.min(300_000, 5000 * 2 ** Math.min(n, 6)));
    t.unref?.();
    retryT.set(uid, t);
  }

  // ---------- Blobs ----------
  // Progress of a friend's file arriving, for the person here (at most one event per percent).
  const lastPct = new Map();
  const blobProgress = (id, got, size) => {
    const pct = size ? Math.floor((got / size) * 100) : 100;
    if (lastPct.get(id) === pct) return;
    lastPct.set(id, pct);
    if (pct >= 100) lastPct.delete(id);
    if (lastPct.size > 100) lastPct.delete(lastPct.keys().next().value);
    toOwner('file.progress', { id, got, size });
  };
  let lastPartSweep = 0;
  const blobs = createBlobs({
    db, filesDir, stats, log, onProgress: blobProgress,
    sendEph: (uid, t, d) => links.sendEph(uid, t, d),
    canServe: (uid, row) => {
      const shadow = shadowId(uid);
      if (!isContact(shadow)) return false;
      const me = M.userRow(owner());
      if (row.conv === `avatar:${owner()}`) return isFriend(shadow) && me?.avatar === row.id;
      if (row.conv === `banner:${owner()}`) return isFriend(shadow) && me?.banner === row.id;
      return !json(row.meta, {}).remote && M.canRead(shadow, row.conv);
    },
  });

  // ---------- Outbound work, in order ----------
  let chain = Promise.resolve();
  const later = (fn) => { chain = chain.then(fn).catch((e) => log('peer', 'outbound', e.message)); return chain; };

  // ---------- Profile (section 7.4) ----------
  const ownerRow = () => M.userRow(owner());
  async function buildProfile() {
    const r = ownerRow();
    const v = hub.selfView(owner());
    const media = async (fileId) => {
      if (!fileId) return null;
      const f = db.get('SELECT id, type, size FROM files WHERE id = ?', fileId);
      if (!f) return null;
      const hash = await blobs.hashOf(f.id);
      return hash ? { hash, type: f.type, size: f.size } : null;
    };
    const avatar = await media(r.avatar);
    if (avatar && r.avatar_anim) avatar.anim = true;
    return {
      username: self.username, name: r.name, about: r.about || '', hue: r.hue, emoji: r.emoji || null,
      pronouns: r.pronouns || '', accent: Number.isInteger(r.accent) ? r.accent : null,
      interests: json(r.interests, []), links: json(r.links, []),
      status: v.status || '', statusEmoji: v.statusEmoji || null, statusUntil: v.statusUntil || null,
      presence: r.presence || 'around',
      decoration: r.decoration || null, decorationHue: Number.isInteger(r.decoration_hue) ? r.decoration_hue : null,
      nameStyle: json(r.name_style, null), profileColors: json(r.profile_colors, null),
      avatar, banner: await media(r.banner),
      maxFile: P2P_MAX_FILE, // 0.12: files this PC takes from friends (0.11 PCs ignore the field)
      caps: PEER_CAPS, // 0.12: a 0.11 PC ignores fields it doesn't know
    };
  }
  const friendShadows = () => db.all("SELECT f.other AS user FROM friends f JOIN users u ON u.id = f.other WHERE f.user = ? AND f.state = 'friends' AND u.remote = 1", owner()).map((r) => r.user);
  // Sign and queue the profile when it changed; `to` limits it to some friends (a new friend, a profile.want).
  function pushProfile(to = null, force = false) {
    return later(async () => {
      if (!active()) return;
      const p = await buildProfile();
      const h = b64u(sha256(canon(p)));
      let body = identity.get('profile_body');
      if (h !== identity.get('profile_hash') || !body) {
        const ver = nextVer(Number(identity.get('profile_ver')) || 0, Math.round(reg.now()));
        const snap = { uid: myUid(), kver: Number(self.kver) || 1, ver, ts: Math.round(reg.now()), p };
        body = JSON.stringify({ snap, sig: profileSign(identity.me().ikPriv, snap) });
        identity.set('profile_ver', ver);
        identity.set('profile_hash', h);
        identity.set('profile_body', body);
        stats.profilePushes++;
        to = null; // a change goes to every friend
      } else if (!to && !force) return;
      for (const shadow of to || friendShadows()) {
        const uid = uidOf(shadow);
        if (!uid || !isFriend(shadow)) continue;
        outbox.pushProfile(shadow, body, links.sentUpTo(uid));
        links.want(uid);
      }
    });
  }
  const profileHourly = limiter({ capacity: 20, perSecond: 20 / 3600 });
  const deferredProfile = new Map(); // uid -> {d, timer}
  function applyProfile(uid, d) {
    const p = peerOf(uid);
    const snap = d?.snap;
    if (!p || !snap || snap.uid !== uid || snap.kver !== p.kver || !profileVerify(p.ik, snap, d.sig)) fail('That profile isn’t signed by them.');
    if (!newer([snap.kver, snap.ver], [p.profile_kver, p.profile_ver])) return;
    if (!profileHourly.take(uid)) {
      // Over 20 in an hour: keep only the newest and apply it later (S11).
      const was = deferredProfile.get(uid);
      if (was) clearTimeout(was.timer);
      const timer = setTimeout(() => { deferredProfile.delete(uid); try { db.tx(() => applyProfile(uid, d)); } catch (e) { log('peer', 'profile', e.message); } }, 3_600_000 / 20);
      timer.unref?.();
      deferredProfile.set(uid, { d, timer });
      stats.profileDeferred = (stats.profileDeferred || 0) + 1;
      return;
    }
    const pr = snap.p;
    const clean = (s, max) => (typeof s === 'string' ? s.replace(INVISIBLE, '').slice(0, max) : '');
    const shadow = p.user;
    const c = { user: shadow, ws: null, peer: true };
    const upd = {
      name: clean(pr.name, 40).trim() || p.username, about: clean(pr.about, 400), hue: pr.hue, emoji: pr.emoji || null,
      pronouns: clean(pr.pronouns, 40), accent: pr.accent ?? null,
      interests: Array.isArray(pr.interests) ? pr.interests : [], links: Array.isArray(pr.links) ? pr.links : [],
      presence: ['open', 'around', 'focus', 'away', 'offline'].includes(pr.presence) ? pr.presence : 'around',
      decoration: pr.decoration ?? null, decorationHue: pr.decorationHue ?? null, nameStyle: pr.nameStyle ?? null, profileColors: pr.profileColors ?? null,
    };
    ops['me.update'](c, upd);
    const until = Number.isSafeInteger(pr.statusUntil) ? pr.statusUntil : null;
    const emoji = typeof pr.statusEmoji === 'string' && pr.statusEmoji.length <= 16 ? pr.statusEmoji : null;
    db.run('UPDATE users SET status = ?, status_emoji = ?, status_until = ? WHERE id = ?', clean(pr.status, 80), emoji, until, shadow);
    const mediaOk = (m, cap) => (m && HASH.test(m.hash) && Number.isSafeInteger(m.size) && m.size > 0 && m.size <= cap && PIC_TYPES.includes(m.type) ? { hash: m.hash, size: m.size, type: m.type, anim: !!m.anim } : null);
    db.run('UPDATE peers SET profile_kver = ?, profile_ver = ?, profile_sig = ?, media = ? WHERE uid = ?',
      snap.kver, snap.ver, d.sig, JSON.stringify({ avatar: mediaOk(pr.avatar, MAX_PIC), banner: mediaOk(pr.banner, MAX_PIC), ...(Number.isSafeInteger(pr.maxFile) && pr.maxFile > 0 ? { maxFile: pr.maxFile } : {}) }), uid);
    // 0.12: what their PC understands (none listed: a 0.11 PC).
    const caps = Array.isArray(pr.caps) ? [...new Set(pr.caps.filter((x) => typeof x === 'string' && /^[a-z0-9.]{1,24}$/.test(x)))].slice(0, 32) : [];
    const capsBefore = p.caps || '[]';
    db.run('UPDATE peers SET caps = ? WHERE uid = ?', JSON.stringify(caps), uid);
    // 0.13: what their conversations offer (polls, the timer) follows: the owner's page gets them again.
    if (JSON.stringify(caps) !== capsBefore && owner()) for (const r of db.all('SELECT dm FROM dm_members WHERE user = ?', shadow)) hub.sendDm(owner(), r.dm);
    stats.profileApplied++;
    hub.userChanged(shadow);
    // A new username: believed only if the registry agrees (section 6.2).
    if (typeof pr.username === 'string' && pr.username !== p.username) {
      reg.lookup({ uid }).then((r) => {
        if (r?.uid === uid && r.username === pr.username && isUsername(r.username)) {
          db.run('UPDATE peers SET username = ? WHERE uid = ?', r.username, uid);
          db.run('UPDATE users SET handle = ? WHERE id = ?', shadowHandle(uid, r.username), shadow);
          hub.userChanged(shadow);
        }
      }).catch(() => {});
    }
    queueMicrotask(() => syncMedia(uid));
  }
  // Bring a friend's picture and banner in line with their newest profile.
  const syncing = new Set();
  async function syncMedia(uid) {
    if (syncing.has(uid)) return;
    const p = peerOf(uid);
    if (!p) return;
    const want = json(p.media, {});
    const row = M.userRow(p.user);
    syncing.add(uid);
    try {
      for (const kind of ['avatar', 'banner']) {
        const m = want[kind];
        const cur = row?.[kind] ? json(db.get('SELECT meta FROM files WHERE id = ?', row[kind])?.meta, {}) : null;
        if (!m) { if (row?.[kind]) setPicture(p, kind, null); continue; }
        if (cur?.hash === m.hash && cur.have) continue;
        const id = remoteMediaId(uid, m.hash);
        const conv = `${kind}:${p.user}`;
        if (!db.get('SELECT 1 FROM files WHERE id = ?', id)) {
          db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            id, p.user, conv, kind, 'application/octet-stream', m.size, Date.now(), JSON.stringify({ hash: m.hash, remote: 1, have: 0 }));
        }
        if (!links.isUp(uid)) continue;
        const ok = await blobs.fetch(uid, { h: m.hash, size: m.size, id, cap: MAX_PIC });
        if (!ok) continue;
        // Never trust the sender's type: the bytes decide, with the same checks as an upload.
        const img = imageInfo(blobs.head(id));
        if (!img || !PIC_TYPES.includes(img.type) || img.w < 16 || img.h < 16 || img.w > 4096 || img.h > 4096) { dropFile(id); continue; }
        db.run('UPDATE files SET type = ?, meta = ? WHERE id = ?', img.type, JSON.stringify({ hash: m.hash, remote: 1, have: 1, w: img.w, h: img.h }), id);
        // The newest profile may have moved on while this was fetched.
        if (json(peerOf(uid)?.media, {})[kind]?.hash === m.hash) setPicture(p, kind, id);
      }
    } catch (e) { log('peer', 'media', e.message); } finally { syncing.delete(uid); }
  }
  function dropFile(id) {
    db.run('DELETE FROM files WHERE id = ?', id);
    try { unlinkSync(join(filesDir, id)); } catch { /* none */ }
  }
  function setPicture(p, kind, fileId) {
    const c = { user: p.user, ws: null, peer: true };
    try { ops['me.update'](c, { [kind]: fileId }); } catch (e) { log('peer', 'picture', e.message); return; }
    // The picture it replaced goes, bytes and all (S11).
    for (const r of db.all('SELECT id FROM files WHERE conv = ? AND id IS NOT ?', `${kind}:${p.user}`, fileId)) dropFile(r.id);
  }

  // ---------- Knocks: the friend graph (section 7.1) ----------
  function knock(uid, t, d = {}, xk = null) {
    const m = identity.me();
    const key = xk || peerOf(uid)?.xk;
    if (!m || !key) return null;
    const id = rid();
    const box = seal(m, uid, key, { t, id, ts: Math.round(reg.now()), from: m.uid, d });
    db.run('INSERT INTO peer_knocks (id, uid, kind, body, created) VALUES (?, ?, ?, ?, ?)', id, uid, t, box, Date.now());
    signal.send({ t: 'knock', id, to: uid, box });
    stats.knocksOut++;
    return id;
  }
  const knockWaiters = new Map();
  function resendKnocks() {
    for (const k of db.all('SELECT * FROM peer_knocks ORDER BY created LIMIT 200')) signal.send({ t: 'knock', id: k.id, to: k.uid, box: k.body });
  }
  function seenKnock(id) { return !!db.get('SELECT 1 FROM peer_seen WHERE id = ?', id); }
  function markSeen(id) {
    db.run('INSERT OR IGNORE INTO peer_seen (id, exp) VALUES (?, ?)', id, Date.now() + 8 * DAY);
    if (db.get('SELECT COUNT(*) n FROM peer_seen').n > 5000) db.run('DELETE FROM peer_seen WHERE id IN (SELECT id FROM peer_seen ORDER BY exp LIMIT 500)');
  }
  async function onKnock(m) {
    const { from, id, box } = m;
    const ack = () => signal.send({ t: 'knocked', ids: [id] });
    if (typeof id !== 'string' || id.length > 64) return;
    if (!isUid(from) || seenKnock(id)) { ack(); return; }
    stats.knocksIn++;
    try {
      const b = parseBox(box, 4096);
      if (!b) throw new UserError('bad box');
      let ik;
      if (from === myUid()) {
        // A restore list from my old PC, signed by the key before mine (section 7.1).
        const r = await reg.lookup({ uid: from });
        const old = r?.chain?.filter((e) => e.kver < r.kver).map((e) => e.ik) || [];
        ik = old.find((k) => boxVerify(from, myUid(), b, k));
      } else {
        if (!peerOf(from)) {
          const r = await reg.lookup({ uid: from });
          if (!r || r.uid !== from) throw new UserError('unknown sender');
          if (!boxVerify(from, myUid(), b, r.ik)) throw new UserError('bad signature');
          ensureShadow(r);
        }
        ik = await verifyFrom(from, (k) => boxVerify(from, myUid(), b, k));
      }
      if (!ik) throw new UserError('bad signature');
      const obj = boxOpen(identity.me(), from, b);
      // The outer id is what replays are remembered by, and nothing signs it: it must be the signed inner id,
      // or the same box could be replayed under a fresh id (an old "remove" ending a renewed friendship).
      if (obj.id !== id) throw new UserError('replayed');
      if (obj.from !== from || typeof obj.t !== 'string' || !Number.isSafeInteger(obj.ts) || Math.abs(obj.ts - reg.now()) > 7 * DAY) throw new UserError('stale');
      const fn = Object.hasOwn(KNOCKS, obj.t) ? KNOCKS[obj.t] : null;
      if (!fn) throw new UserError('unknown knock');
      await fn(from, obj.d || {});
    } catch (e) {
      if (!(e instanceof UserError)) log('peer', 'knock', e.message);
      stats.rejected++;
    }
    markSeen(id);
    ack();
  }
  const asShadow = (shadow) => ({ user: shadow, ws: null, peer: true });
  // 0.12: a friend's capabilities (tests can pretend a PC is older with _setCaps).
  const capsOverride = new Map();
  const capsOf = (uid) => (capsOverride.has(uid) ? capsOverride.get(uid) : json(peerOf(uid)?.caps, []) || []);
  const can = (shadow, cap) => !!shadow && capsOf(uidOf(shadow)).includes(cap);
  // The conversation a thread hangs off, so a thread reply goes where its conversation goes.
  const threadParent = (conv) => (typeof conv === 'string' && conv.startsWith('t:') ? (M.thread(conv)?.conv || M.liveMsg(conv.slice(2))?.conv || null) : null);
  // A friend's message, edit or reaction lands in the thread its message is in, if it's one of this conversation's.
  const convFor = (dm, id) => {
    const row = typeof id === 'string' ? M.msg(id) : null;
    if (row && row.conv !== dm && row.conv.startsWith('t:') && M.thread(row.conv)?.conv === dm) return row.conv;
    return dm;
  };
  const KNOCKS = {
    'friend.request': async (from) => {
      const shadow = shadowId(from);
      if (blockedEither(shadow)) return;
      // Already friends here (they moved to a new PC and asked again): just say yes.
      if (isFriend(shadow)) { knock(from, 'friend.accept'); return; }
      const r = ops['friend.request'](asShadow(shadow), { user: owner() });
      if (r?.state === 'friends') becameFriends(shadow);
    },
    'friend.accept': async (from) => {
      const shadow = shadowId(from);
      const was = isFriend(shadow);
      ops['friend.accept'](asShadow(shadow), { user: owner() });
      if (!was && isFriend(shadow)) becameFriends(shadow);
    },
    'friend.decline': async (from) => { ops['friend.decline'](asShadow(shadowId(from)), { user: owner() }); watchSoon(); },
    'friend.cancel': async (from) => { ops['friend.remove'](asShadow(shadowId(from)), { user: owner() }); watchSoon(); },
    'friend.remove': async (from) => {
      const shadow = shadowId(from);
      ops['friend.remove'](asShadow(shadow), { user: owner() });
      outbox.drop(shadow);
      links.close(from, 'unfriended');
      watchSoon();
    },
    // From my own old PC, after I approved a move: my friends, to be friends here too.
    restore: async (from, d) => {
      if (from !== myUid() || !Array.isArray(d.uids)) return;
      for (const uid of d.uids.slice(0, 500)) {
        if (!isUid(uid) || uid === myUid()) continue;
        try {
          const shadow = await shadowFor(uid);
          if (!shadow || M.friendRow(owner(), shadow)) continue;
          const t = Date.now();
          db.tx(() => {
            db.run("INSERT INTO friends (user, other, state, favorite, since) VALUES (?, ?, 'friends', 0, ?)", owner(), shadow, t);
            db.run("INSERT INTO friends (user, other, state, favorite, since) VALUES (?, ?, 'friends', 0, ?)", shadow, owner(), t);
          });
          hub.friendChanged(owner(), shadow);
          becameFriends(shadow, false);
        } catch (e) { log('peer', 'restore', e.message); }
      }
    },
  };
  function becameFriends(shadow, profile = true) {
    watchSoon();
    if (profile) pushProfile([shadow], true);
  }

  // Watch set: friends and people I asked, minus blocked ones (section 7.1).
  let watchT = null;
  const reach = new Set();     // uids not online to me that linked to me (they show presence to friends only)
  let quietNow = new Set();    // co-members told at the registry not to see me (friends only)
  function watchSoon() {
    clearTimeout(watchT);
    watchT = setTimeout(sendWatch, 1000);
    watchT.unref?.();
  }
  function sendWatch() {
    clearTimeout(watchT); watchT = null;
    if (!active()) return;
    const uids = db.all(`SELECT f.other AS user FROM friends f JOIN users u ON u.id = f.other
      WHERE f.user = ? AND f.state IN ('friends', 'outgoing') AND u.remote = 1
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user = f.user AND b.other = f.other) OR (b.user = f.other AND b.other = f.user))
      LIMIT 500`, owner()).map((r) => uidOf(r.user)).filter(Boolean);
    // Co-members of groups across PCs are watched too, so links to them can open. With presence for friends
    // only, they are watched quietly (review-media 4): the registry doesn't tell them I'm online and lets them
    // reach me only once my PC contacted theirs, which it does when they come online (checkIn). A registry
    // without quiet watches (ready.quiet) gets the old answer: they aren't watched at all.
    const fo = friendsOnlyNow();
    const canQuiet = signal.ready?.quiet === true;
    const quiet = [];
    if (!fo || canQuiet) for (const uid of G.watch()) {
      if (uids.length >= 500) break;
      if (isUid(uid) && uid !== myUid() && !uids.includes(uid) && remote.has(shadowId(uid)) && !blockedEither(shadowId(uid))) { uids.push(uid); if (fo) quiet.push(uid); }
    }
    signal.send({ t: 'watch', uids, ...(quiet.length ? { quiet } : {}) });
    const before = quietNow;
    quietNow = new Set(quiet);
    // Newly quiet: a link that was open before went up without my contact, so start it again.
    for (const uid of quietNow) if (!before.has(uid)) { links.close(uid, 'quiet'); checkIn(uid); }
    // Anyone no longer watched is no longer online to me.
    for (const uid of [...online]) if (!uids.includes(uid)) setOnline(uid, false);
  }
  // A quiet co-member online: open a link (after 0-5 s), so their PC may reach mine and their queue comes over.
  function checkIn(uid) {
    if (!online.has(uid)) return;
    const t = setTimeout(() => { if (quietNow.has(uid) && online.has(uid)) links.want(uid); }, Math.floor(Math.random() * 5000));
    t.unref?.();
  }
  function setOnline(uid, on) {
    const had = online.has(uid);
    if (on) { online.add(uid); reach.delete(uid); } else online.delete(uid);
    if (had === on) return;
    if (on && quietNow.has(uid)) checkIn(uid);
    if (!on) {
      links.close(uid, 'offline');
      // Gone: no retry waits for them, and their next visit starts the backoff afresh.
      clearTimeout(retryT.get(uid)); retryT.delete(uid); retryN.delete(uid);
    }
    const shadow = shadowId(uid);
    if (remote.has(shadow)) hub.presenceChanged(shadow);
    if (on && (outbox.after(shadow, 0, 1).length)) links.want(uid);
    G.online(uid, on);
  }

  // ---------- Inbound frames (section 5.4: one explicit table, S12) ----------
  const callLimit = limiter({ capacity: 10, perSecond: 10 / 3600 });
  const rtcPeerBytes = limiter({ capacity: 512 * 1024, perSecond: 64 * 1024 }); // sec-integrate: as server/ops.js rtcBytes
  const blobHourly = new Map(); // uid -> {at, bytes}
  const DURABLE = {
    'dm.msg': (uid, d, ts) => {
      const shadow = shadowId(uid);
      if (!isFriend(shadow)) fail('Not friends.');
      if (typeof d.id !== 'string' || !MSG_ID.test(d.id)) fail('Bad message id.');
      const dm = ensureDm(uid);
      // 0.12: a thread reply names its thread's first message (t). If that message isn't here, it
      // lands in the conversation as a reply to it, or as a plain message.
      const root = typeof d.t === 'string' && MSG_ID.test(d.t) ? M.liveMsg(d.t) : null;
      const conv = root && root.conv === dm && !root.sys ? `t:${root.id}` : dm;
      let replyTo = typeof d.replyTo === 'string' ? d.replyTo : null;
      if (conv !== dm && replyTo === d.t) replyTo = null;
      if (conv === dm && !replyTo && root?.conv === dm) replyTo = root.id;
      const files = acceptFiles(uid, conv, d.files);
      sendWithExtras({ ...asShadow(shadow), ts: Math.min(ts, Date.now() + 60_000) }, {
        conv, id: d.id, text: typeof d.text === 'string' ? d.text : '', files, ...(replyTo ? { replyTo } : {}),
      }, extrasIn(d));
      if (files.length) queueMicrotask(() => fetchPending(uid));
    },
    'dm.edit': (uid, d) => ops['msg.edit'](asShadow(shadowId(uid)), { conv: convFor(dmIdFor(myUid(), uid), d.id), id: d.id, text: d.text }),
    'dm.delete': (uid, d) => ops['msg.delete'](asShadow(shadowId(uid)), { conv: convFor(dmIdFor(myUid(), uid), d.id), id: d.id }),
    'dm.restore': (uid, d) => ops['msg.restore'](asShadow(shadowId(uid)), { conv: convFor(dmIdFor(myUid(), uid), d.id), id: d.id }),
    'dm.react': (uid, d) => ops.react(asShadow(shadowId(uid)), { conv: convFor(dmIdFor(myUid(), uid), d.id), id: d.id, emoji: d.emoji, on: d.on === true }),
    // 0.12, sent only to PCs that list the capability.
    'dm.pin': (uid, d) => {
      if (!isFriend(shadowId(uid))) fail('Not friends.');
      ops[d.on === true ? 'msg.pin' : 'msg.unpin'](asShadow(shadowId(uid)), { conv: dmIdFor(myUid(), uid), id: d.id });
    },
    'dm.ttl': (uid, d, ts) => {
      if (!isFriend(shadowId(uid))) fail('Not friends.');
      if (!TTLS.includes(d.ttl)) fail('Bad timer.');
      ops['conv.ttl']({ ...asShadow(shadowId(uid)), ts: Math.min(ts, Date.now() + 60_000) }, { conv: ensureDm(uid), ttl: d.ttl });
    },
    // 0.13, sent only to PCs that list 'poll': a poll, a vote (the voter's whole choice, latest wins), its end.
    'dm.poll': (uid, d, ts) => {
      const shadow = shadowId(uid);
      if (!isFriend(shadow)) fail('Not friends.');
      if (typeof d.id !== 'string' || !MSG_ID.test(d.id)) fail('Bad message id.');
      const dm = ensureDm(uid);
      const root = typeof d.t === 'string' && MSG_ID.test(d.t) ? M.liveMsg(d.t) : null;
      const conv = root && root.conv === dm && !root.sys ? `t:${root.id}` : dm;
      applyPoll({ ...asShadow(shadow), ts: Math.min(ts, Date.now() + 60_000) }, conv, d);
    },
    'dm.vote': (uid, d, ts) => {
      if (!isFriend(shadowId(uid))) fail('Not friends.');
      applyVote(shadowId(uid), convFor(dmIdFor(myUid(), uid), d.id), d.id, d.answers, Math.min(ts, Date.now() + 60_000));
    },
    'dm.pollend': (uid, d, ts) => {
      if (!isFriend(shadowId(uid))) fail('Not friends.');
      applyPollEnd(shadowId(uid), convFor(dmIdFor(myUid(), uid), d.id), d.id, Math.min(ts, Date.now()));
    },
    profile: (uid, d) => applyProfile(uid, d),
  };
  // ---------- Polls from friends' PCs (0.13), shared with groups across PCs ----------
  // The poll is made with the same op as the author's shadow, then closes when the author's PC said.
  function applyPoll(c, conv, d) {
    if (typeof d.id !== 'string' || !MSG_ID.test(d.id) || typeof d.question !== 'string' || !Array.isArray(d.answers) || d.answers.length > 10
      || !Number.isSafeInteger(d.ends)) fail('Bad poll.');
    if (M.msg(d.id)) return;
    const answers = d.answers.map((a) => ({ text: typeof a?.text === 'string' ? a.text : '', ...(typeof a?.emoji === 'string' && a.emoji ? { emoji: a.emoji } : {}) }));
    const longest = POLL_HOURS[POLL_HOURS.length - 1];
    ops['poll.create'](c, { conv, id: d.id, question: d.question, answers, hours: longest, multi: d.multi === true, hidden: d.hidden === true });
    const t = c.ts || Date.now();
    db.run('UPDATE polls SET ends = ? WHERE msg = ?', Math.max(0, Math.min(d.ends, t + longest * 3_600_000)), d.id);
    pollChanged(conv, d.id);
  }
  const pollOf = (conv, id) => {
    const row = typeof id === 'string' && MSG_ID.test(id) ? M.liveMsg(id) : null;
    return row && row.conv === conv ? db.get('SELECT * FROM polls WHERE msg = ?', id) : null;
  };
  // A vote: the voter's choices as they were at `ts`. An older vote than the one held changes nothing.
  function applyVote(user, conv, id, answers, ts) {
    const p = pollOf(conv, id);
    if (!p || !Array.isArray(answers) || answers.length > 10) return false;
    if ((p.ended && p.ended <= ts) || p.ends <= ts) return false;
    const n = json(p.answers, []).length;
    const picks = [...new Set(answers)];
    if (!picks.every((a) => Number.isInteger(a) && a >= 0 && a < n) || (!p.multi && picks.length > 1)) return false;
    const last = db.get('SELECT MAX(ts) t FROM poll_votes WHERE msg = ? AND user = ?', id, user)?.t;
    if (last && last > ts) return false;
    db.tx(() => {
      db.run('DELETE FROM poll_votes WHERE msg = ? AND user = ?', id, user);
      for (const a of picks) db.run('INSERT INTO poll_votes (msg, user, answer, ts) VALUES (?, ?, ?, ?)', id, user, a, ts);
    });
    pollChanged(conv, id);
    return true;
  }
  // Only the person who started a poll ends it; it ends at the time their PC said.
  function applyPollEnd(user, conv, id, at) {
    const p = pollOf(conv, id);
    if (!p || p.by !== user || p.ended) return false;
    db.run('UPDATE polls SET ended = ?, closed = 1 WHERE msg = ?', Math.min(at, Date.now()), id);
    // Votes cast after the author's end don't count anywhere.
    db.run('DELETE FROM poll_votes WHERE msg = ? AND ts > ?', id, Math.min(at, Date.now()));
    pollChanged(conv, id);
    return true;
  }
  // The only page that reads a conversation with friends on other PCs here is the owner's.
  function pollChanged(conv, id) {
    try {
      const v = ops['poll.view']({ user: owner(), ws: null }, { conv, id });
      toOwner('poll', { conv, id, poll: v.poll });
    } catch (e) { if (!(e instanceof UserError)) throw e; }
  }
  // Attachment metadata from a friend's PC (bytes come later from their PC): local file rows owned by their shadow.
  function acceptFiles(uid, conv, list) {
    const shadow = shadowId(uid);
    const files = [];
    for (const f of (Array.isArray(list) ? list : []).slice(0, 6)) {
      if (!f || typeof f.id !== 'string' || !FILE_ID.test(f.id) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > P2P_MAX_FILE || typeof f.hash !== 'string' || !HASH.test(f.hash)) fail('Bad attachment.');
      const id = remoteFileId(uid, f.id);
      const was = db.get('SELECT owner, conv FROM files WHERE id = ?', id);
      if (was && (was.owner !== shadow || was.conv !== conv)) fail('That attachment id is taken.');
      if (!was) {
        const name = (typeof f.name === 'string' ? f.name : 'file').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 120) || 'file';
        const type = typeof f.type === 'string' && SHOWN_TYPES.has(f.type) ? f.type : 'application/octet-stream';
        db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id, shadow, conv, name, type, f.size, Date.now(), JSON.stringify({ hash: f.hash, size: f.size, remote: 1, have: 0, rid: f.id, used: Date.now(), decl: type }));
      }
      files.push({ id, ...(Number.isInteger(f.w) && Number.isInteger(f.h) ? { w: f.w, h: f.h } : {}) });
    }
    return files;
  }
  // ---------- Forwarded messages and stickers (0.13) ----------
  // Out: the card as a friend's PC can show it (who wrote it by uid and name, when, the text, a sticker's name).
  // A PC without forwarded cards (0.11, 0.12.0) reads `text`: the note, the quoted message and who wrote it.
  function fwdOut(f) {
    if (!f || typeof f !== 'object') return null;
    const a = f.author === owner() ? myUid() : isRemote(f.author) ? uidOf(f.author) : null;
    const name = String(M.userRow(f.author)?.name || 'Someone').slice(0, 64);
    return {
      ...(a ? { a } : {}), name, ts: Number.isSafeInteger(f.ts) ? f.ts : 0, text: String(f.text || '').slice(0, 4000),
      ...(f.sticker?.name ? { sticker: { name: String(f.sticker.name).slice(0, 64) } } : {}),
    };
  }
  function fwdText(note, f) {
    const quoted = f.text ? f.text.split('\n').map((l) => `> ${l}`).join('\n') : '';
    const said = `${quoted}${quoted ? '\n' : ''}— ${f.name}, forwarded`;
    return [note, said].filter(Boolean).join('\n\n').slice(0, 4000);
  }
  // The extra fields of a message frame (dm.msg, a group's msg item) for one that is a forward or a sticker.
  function extrasOut(m) {
    const fwd = fwdOut(m.fwd);
    return {
      ...(fwd ? { text: fwdText(m.text || '', fwd), note: String(m.text || ''), fwd } : {}),
      ...(m.sticker?.name ? { sticker: { name: String(m.sticker.name).slice(0, 64) } } : {}),
    };
  }
  // In: the card as stored here, the author mapped to someone this PC knows (else only their name shows).
  const cleanName = (n) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 64) : '') || 'Someone';
  function extrasIn(d) {
    const out = {};
    const f = d && typeof d.fwd === 'object' && d.fwd ? d.fwd : null;
    if (f && typeof f.text === 'string' && f.text.length <= 4000 && Number.isSafeInteger(f.ts)) {
      const a = isUid(f.a) ? f.a : null;
      const author = a === myUid() ? owner() : a && M.userRow(shadowId(a)) ? shadowId(a) : null;
      out.fwd = { conv: null, id: null, author, name: cleanName(f.name), ts: f.ts, text: f.text, ...(f.sticker && typeof f.sticker.name === 'string' ? { sticker: { name: cleanName(f.sticker.name) } } : {}) };
      out.text = typeof d.note === 'string' ? d.note : '';
    }
    if (d && d.sticker && typeof d.sticker.name === 'string') out.sticker = { id: null, name: cleanName(d.sticker.name), house: null };
    return out.fwd || out.sticker ? out : null;
  }
  // Send a friend's message here with its card or sticker on it: the message event already carries them.
  const inExtras = new Map();
  const baseMsgView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseMsgView(row, rx);
    const x = inExtras.get(row.id);
    if (x?.fwd && !m.fwd) m.fwd = x.fwd;
    if (x?.sticker && !m.sticker) m.sticker = x.sticker;
    return m;
  };
  function sendWithExtras(c, d, x) {
    if (!x) return ops['msg.send'](c, d);
    if (x.fwd) { d.text = x.text; M.emptyOk?.add(d); }
    inExtras.set(d.id, x);
    let r;
    try { r = ops['msg.send'](c, d); } finally { inExtras.delete(d.id); }
    const row = M.msg(d.id);
    if (row && !row.fwd && !row.sticker) {
      db.run('UPDATE messages SET fwd = ?, sticker = ?, fold = ? WHERE id = ?', x.fwd ? JSON.stringify(x.fwd) : null, x.sticker ? JSON.stringify(x.sticker) : null,
        M.foldText(`${d.text || ''} ${x.fwd?.text || ''} ${x.sticker?.name || ''}`, json(row.files, [])), d.id);
    }
    return r;
  }
  function ingestDurable(uid, Pf) {
    const fn = Object.hasOwn(DURABLE, Pf.t) ? DURABLE[Pf.t] : null;
    if (!fn) fail('Unknown frame.');
    if (!Pf.d || typeof Pf.d !== 'object') fail('Bad frame.');
    fn(uid, Pf.d, Pf.ts);
  }
  const inCall = (uid) => {
    const dm = dmIdFor(myUid(), uid);
    return hub.callOf(dm) ? dm : null;
  };
  const EPHEMERAL = {
    typing: (uid) => { const shadow = shadowId(uid); if (isFriend(shadow)) ops.typing(asShadow(shadow), { conv: dmIdFor(myUid(), uid) }); },
    'profile.want': (uid) => { const s = shadowId(uid); if (isFriend(s)) pushProfile([s], true); },
    'blob.get': (uid, d) => { blobs.serve(uid, d); },
    'blob.part': (uid, d) => blobs.onPart(uid, d),
    'blob.miss': (uid, d) => blobs.onMiss(uid, d),
    'call.start': (uid, d) => {
      const shadow = shadowId(uid);
      if (!isFriend(shadow) || typeof d.call !== 'string' || !CALL_ID.test(d.call)) fail('Bad call.');
      if (!callLimit.take(uid)) fail('Too many calls.');
      const dm = ensureDm(uid);
      turnFor(uid);
      ops['call.start']({ user: shadow, ws: proxyFor(uid), peer: true, callId: d.call }, { dm, video: d.video === true });
    },
    'call.join': (uid, d) => {
      const dm = inCall(uid);
      if (!dm || hub.callOf(dm).id !== d.call) fail('No such call.');
      ops['call.join']({ user: shadowId(uid), ws: proxyFor(uid), peer: true }, { dm });
    },
    'call.decline': (uid, d) => {
      const dm = inCall(uid);
      if (!dm || hub.callOf(dm).id !== d.call) fail('No such call.');
      ops['call.decline'](asShadow(shadowId(uid)), { dm, call: d.call });
    },
    'voice.leave': (uid) => { const dm = dmIdFor(myUid(), uid); if (hub.voicePlaceOf(shadowId(uid)) === dm) hub.voiceLeave(shadowId(uid)); },
    'voice.state': (uid, d) => {
      const dm = inCall(uid);
      if (!dm || hub.voicePlaceOf(shadowId(uid)) !== dm) fail('Not in the call.');
      const s = {};
      for (const k of ['muted', 'deaf', 'camera', 'screen', 'listen']) if (typeof d[k] === 'boolean') s[k] = d[k];
      hub.voiceState(shadowId(uid), s);
    },
    rtc: (uid, d) => {
      const dm = inCall(uid);
      if (!dm || hub.voicePlaceOf(shadowId(uid)) !== dm || !d.data || typeof d.data !== 'object') fail('Not in the call.');
      // sec-integrate: a friend's PC gets the same signal check and byte budget as a call member here
      // (server/ops.js rtcSignal), so it can't flood this browser with junk signalling either.
      const data = rtcSignal(d.data);
      if (!rtcPeerBytes.take(uid, JSON.stringify(data).length)) fail('Too fast.');
      hub.rtcRelay(shadowId(uid), owner(), data);
    },
  };
  function ingestEphemeral(uid, Pf) {
    const fn = Object.hasOwn(EPHEMERAL, Pf.t) ? EPHEMERAL[Pf.t] : null;
    if (!fn) fail('Unknown frame.');
    fn(uid, Pf.d && typeof Pf.d === 'object' ? Pf.d : {});
  }
  // A stand-in socket for a friend in a call here: only their rtc signals go anywhere (section 7.5).
  const proxies = new Map();
  function proxyFor(uid) {
    let p = proxies.get(uid);
    if (!p) {
      p = {
        readyState: 1, peer: true,
        send(str) {
          let m;
          try { m = JSON.parse(str); } catch { return; }
          if (m?.t === 'ev' && m.ev === 'rtc' && m.d?.data) links.sendEph(uid, 'rtc', { data: m.d.data });
        },
        once() {}, on() {},
      };
      proxies.set(uid, p);
      if (proxies.size > 64) proxies.delete(proxies.keys().next().value);
    }
    return p;
  }

  // ---------- Attachments from friends (section 5.6) ----------
  const cacheBytes = () => (opts.peerCacheMB ?? 1024) * 1024 * 1024;
  function fetchPending(uid) {
    if (!links.isUp(uid)) return;
    const shadow = shadowId(uid);
    const rows = db.all("SELECT id, size, meta FROM files WHERE owner = ? AND json_extract(meta, '$.remote') = 1 AND json_extract(meta, '$.have') = 0 AND conv NOT LIKE 'avatar:%' AND conv NOT LIKE 'banner:%' AND json_extract(meta, '$.failed') IS NULL ORDER BY created DESC LIMIT 20", shadow);
    for (const r of rows) fetchAttachment(uid, r).catch(() => {});
  }
  function diskOk(need = 0) { try { const s = statfsSync(filesDir); return s.bavail * s.bsize >= 1024 ** 3 + need; } catch { return true; } }
  async function fetchAttachment(uid, row, eager = true) {
    const meta = json(row.meta, {});
    if (eager) {
      // Over the relay, big files wait for a direct link (F11); everything within 300 MB an hour from one
      // friend and a 1 GB disk floor past the file (S11).
      if (links.transportOf(uid) === 'relay' && row.size > MAX_PIC) return false;
      const b = blobHourly.get(uid) || { at: Date.now(), bytes: 0 };
      if (Date.now() - b.at > 3_600_000) { b.at = Date.now(); b.bytes = 0; }
      if (b.bytes + row.size > BLOB_HOUR || !diskOk(row.size)) return false;
      b.bytes += row.size;
      blobHourly.set(uid, b);
      if (blobHourly.size > 1000) blobHourly.delete(blobHourly.keys().next().value);
    }
    const ok = await blobs.fetch(uid, { h: meta.hash, size: row.size, id: row.id, cap: P2P_MAX_FILE });
    const now = db.get('SELECT meta FROM files WHERE id = ?', row.id);
    if (!now) return false;
    const m2 = json(now.meta, {});
    if (!ok) return false;
    // The bytes decide the type, never the sender (S4).
    const type = uploadType(m2.decl || 'application/octet-stream', blobs.head(row.id));
    db.run('UPDATE files SET type = ?, meta = ? WHERE id = ?', type, JSON.stringify({ ...m2, have: 1, used: Date.now() }), row.id);
    evict();
    return true;
  }
  // Remote attachment bytes are a cache: the least recently used go first past peerCacheMB.
  function evict() {
    const rows = db.all("SELECT id, size, meta FROM files WHERE json_extract(meta, '$.remote') = 1 AND json_extract(meta, '$.have') = 1 AND conv NOT LIKE 'avatar:%' AND conv NOT LIKE 'banner:%' ORDER BY json_extract(meta, '$.used')");
    let total = rows.reduce((n, r) => n + r.size, 0);
    for (const r of rows) {
      if (total <= cacheBytes()) break;
      try { unlinkSync(join(filesDir, r.id)); } catch { /* gone */ }
      db.run('UPDATE files SET meta = ? WHERE id = ?', JSON.stringify({ ...json(r.meta, {}), have: 0 }), r.id);
      total -= r.size;
    }
  }

  // ---------- TURN for calls (S28) ----------
  let turn = null; // { iceServers, exp, peer }
  async function turnFor(uid) {
    if (turn && turn.exp > Date.now() + 5 * 60_000) return;
    try {
      const r = await reg.turn(uid);
      if (!r?.iceServers?.length) return;
      turn = { iceServers: r.iceServers, exp: Date.now() + Math.min(7200, Number(r.ttl) || 3600) * 1000 };
      toOwner('ice', { ice: hub.iceFor(owner()), iceExp: turn.exp - 5 * 60_000 });
    } catch (e) { log('peer', 'turn', e.code || e.message); }
  }
  const baseIce = hub.iceFor;
  hub.iceFor = (u) => {
    const list = baseIce(u);
    if (u !== owner() || !turn || turn.exp <= Date.now()) return list;
    return [...(Array.isArray(list) ? list : []), ...turn.iceServers];
  };

  // ---------- Wrapping the read paths (section 4, S13) ----------
  const baseSees = M.sees;
  M.sees = (viewer, user) => (isRemote(user) && viewer !== owner() && viewer !== user ? false : baseSees(viewer, user));
  const baseContacts = M.contacts;
  M.contacts = (user) => (isRemote(user) ? baseContacts(user).filter((u) => u === owner()) : baseContacts(user));
  const baseView = M.userView;
  M.userView = (row, ...rest) => {
    const v = baseView(row, ...rest);
    if (v && row.remote) { v.remote = true; v.username = peerOf(row.id.slice(2))?.username || row.handle; }
    return v;
  };
  hub.remoteOnline = (u) => (isRemote(u) ? online.has(u.slice(2)) : undefined);
  const baseChanged = hub.userChanged;
  hub.userChanged = (u) => {
    baseChanged(u);
    if (u === owner() && active()) {
      pushProfile();
      // Invisible: the registry stops announcing me (section 7.3).
      const vis = visibleNow();
      if (vis !== lastVisible) { lastVisible = vis; signal.send({ t: 'visible', on: vis }); }
      const fo = friendsOnlyNow();
      if (fo !== lastFriendsOnly) { lastFriendsOnly = fo; watchSoon(); }
    }
  };
  let lastVisible = true;
  let lastFriendsOnly = false;
  // Invisible, or "who sees that I'm online: nobody" (server/privacy.js): the directory doesn't announce me.
  const visibleNow = () => ownerRow()?.presence !== 'offline' && M.presenceToAll?.(owner()) !== false;
  // "Who sees that I'm online: friends only" (server/privacy.js): group co-members aren't watched (sendWatch).
  function friendsOnlyNow() { return (M.prefsOf?.(owner()) || {}).presenceTo === 'friends'; }
  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnap(u);
    if (u === owner()) {
      snap.p2p = P.statusFor(u);
      snap.peerKeys = {};
      snap.peerWaiting = {};
      snap.peerHeld = {};
      for (const p of db.all('SELECT * FROM peers')) {
        snap.peerKeys[p.user] = { fingerprint: fingerprint(p.ik, p.xk), ...(p.key_changed_at ? { changedAt: p.key_changed_at, quiet: false } : {}) };
        const dm = dmIdFor(myUid(), p.uid);
        const w = outbox.waiting(p.user), h = outbox.heldMsgs(p.user);
        if (w.length) snap.peerWaiting[dm] = w;
        if (h.length) snap.peerHeld[dm] = h;
      }
      if (turn) snap.iceExp = turn.exp - 5 * 60_000;
    }
    return snap;
  };

  // ---------- Wrapping the ops (outermost, section 7) ----------
  const wrap = (name, fn) => { const base = ops[name]; ops[name] = (c, d) => fn(c, d || {}, base); };
  const mine = (c) => active() && c.user === owner() && !c.peer;
  const guestTouchesRemote = (c, users) => !c.peer && c.user !== owner() && users.some(isRemote);

  const localHandle = (d) => (typeof d.handle === 'string' ? db.get('SELECT id FROM users WHERE handle = ?', d.handle.trim().replace(/^@/, '').toLowerCase())?.id : undefined);
  wrap('friend.request', (c, d, base) => {
    if (c.peer) return base(c, d);
    const target = d.user !== undefined ? d.user : localHandle(d);
    if (!mine(c) || d.local === true || d.user !== undefined) {
      // LAN guests never reach a friend on another PC, by id or by name (S13, S27).
      if (isRemote(target) && !mine(c)) fail(d.user !== undefined ? 'That person isn’t on this PC.' : `Nobody is called @${String(d.handle).trim().replace(/^@/, '').toLowerCase()}.`);
      const r = base(c, d);
      if (mine(c) && isRemote(target)) afterRequest(target, r);
      return r;
    }
    // The owner adds people by their global Snug username (S27).
    const handle = typeof d.handle === 'string' ? d.handle.trim().replace(/^@/, '').toLowerCase() : '';
    if (!handle || handle.length > 32) fail('Type their Snug username.');
    if (handle === self.username) fail('That’s you. Try someone else’s username.');
    return (async () => {
      let r;
      try { r = await reg.lookup({ name: handle }); } catch (e) { fail(e.code === 'rate_limited' ? 'You’re going a little fast. Wait a moment and try again.' : 'Can’t reach Snug’s directory right now. Try again soon.'); }
      if (!r) fail(`No one is called @${handle}.`);
      if (r.uid === myUid()) fail('That’s you. Try someone else’s username.');
      const shadow = ensureShadow(r);
      if (r.username !== peerOf(r.uid).username) db.run('UPDATE peers SET username = ? WHERE uid = ?', r.username, r.uid);
      const res = base(c, { user: shadow });
      afterRequest(shadow, res);
      return res;
    })();
  });
  function afterRequest(shadow, res) {
    const uid = uidOf(shadow);
    if (res?.state === 'friends') { knock(uid, 'friend.accept'); becameFriends(shadow); } else if (res?.state === 'outgoing') { knock(uid, 'friend.request', { username: self.username }); watchSoon(); }
  }
  wrap('friend.accept', (c, d, base) => {
    if (c.peer || !isRemote(d.user)) return base(c, d);
    if (!mine(c)) fail('That person isn’t on this PC.');
    const was = isFriend(d.user);
    const r = base(c, d);
    if (!was && isFriend(d.user)) { knock(uidOf(d.user), 'friend.accept'); becameFriends(d.user); }
    return r;
  });
  wrap('friend.decline', (c, d, base) => {
    if (c.peer || !isRemote(d.user)) return base(c, d);
    if (!mine(c)) fail('That person isn’t on this PC.');
    const was = friendState(d.user);
    const r = base(c, d);
    if (was === 'incoming') knock(uidOf(d.user), 'friend.decline');
    return r;
  });
  wrap('friend.remove', (c, d, base) => {
    if (c.peer || !isRemote(d.user)) return base(c, d);
    if (!mine(c)) return base(c, d);
    const was = friendState(d.user);
    const r = base(c, d);
    if (was) {
      const uid = uidOf(d.user);
      outbox.drop(d.user);
      db.run('DELETE FROM peer_knocks WHERE uid = ?', uid);
      knock(uid, was === 'outgoing' ? 'friend.cancel' : was === 'incoming' ? 'friend.decline' : 'friend.remove');
      links.close(uid, 'unfriended');
      watchSoon();
    }
    return r;
  });
  wrap('block.set', (c, d, base) => {
    if (c.peer || !isRemote(d.user) || !mine(c)) return base(c, d);
    const was = friendState(d.user);
    const r = base(c, d);
    if (d.on === true) {
      const uid = uidOf(d.user);
      outbox.drop(d.user);
      db.run('DELETE FROM peer_knocks WHERE uid = ?', uid);
      // A block is never revealed: it looks like an unfriend, or nothing at all.
      if (was) knock(uid, was === 'outgoing' ? 'friend.cancel' : was === 'incoming' ? 'friend.decline' : 'friend.remove');
      links.close(uid, 'blocked');
      watchSoon();
    }
    return r;
  });
  wrap('dm.open', (c, d, base) => {
    const others = [...new Set(Array.isArray(d.users) ? d.users : [])].filter((u) => u !== c.user);
    if (c.peer || !others.some(isRemote)) return base(c, d);
    if (!mine(c)) fail('You can only message friends and people you share a house with.');
    if (others.length > 1) fail(others.every(isRemote) ? 'Group chats with friends on other PCs aren’t available yet.' : 'A group can have friends on other PCs or people on this PC, not both.');
    const shadow = others[0];
    if (!isFriend(shadow)) fail('You can only message friends on other PCs.');
    if (blockedEither(shadow)) fail(`You can’t message ${M.userRow(shadow).name}.`);
    const dm = ensureDm(uidOf(shadow));
    hub.sendDm(c.user, dm);
    return { id: dm };
  });
  // Houses stay on this PC: friends on other PCs can't be invited yet (section 8).
  if (ops['invite.user']) wrap('invite.user', (c, d, base) => { if (isRemote(localHandle(d))) fail('Friends on other PCs can’t join houses yet.'); return base(c, d); });
  // Adding people to a conversation with a friend on another PC would make it a group.
  if (ops['dm.add']) wrap('dm.add', (c, d, base) => { if (remoteOfDm(d.dm) || (Array.isArray(d.users) && d.users.some(isRemote))) fail('Group chats with friends on other PCs aren’t available yet.'); return base(c, d); });

  // A file bigger than a friend's PC takes would make it refuse the whole message: say so here instead.
  function fitsPeers(files, uids) {
    for (const f of Array.isArray(files) ? files.slice(0, 6) : []) {
      const row = typeof f?.id === 'string' ? db.get('SELECT size FROM files WHERE id = ?', f.id) : null;
      if (!row || row.size <= OLD_MAX_FILE) continue;
      for (const uid of uids) {
        const p = peerOf(uid);
        if (!p || row.size <= peerMaxFile(p.media)) continue;
        const who = M.userRow(p.user)?.name || p.username;
        fail(row.size > P2P_MAX_FILE
          ? `Files sent to friends on other PCs can be up to ${P2P_MAX_FILE / 1024 / 1024} MB.`
          : `${who}’s Snug takes files up to 10 MB until they update it. Send a smaller file, or ask them to update Snug.`);
      }
    }
  }
  // Messages: applied here as usual, then queued for the friend's PC.
  const sendable = (c, conv) => (mine(c) ? remoteOfDm(conv) : null);
  // Messages and what happens to them follow their thread's conversation (0.12, bug B3).
  const sendableMsg = (c, conv) => sendable(c, threadParent(conv) || conv);
  wrap('msg.send', (c, d, base) => {
    if (localOnly.has(d.id)) return base(c, d); // a poll's message: the poll itself goes (dm.poll)
    const shadow = sendableMsg(c, d.conv);
    if (!shadow) {
      const r = remoteOfDm(threadParent(d.conv) || d.conv);
      if (guestTouchesRemote(c, r ? [r] : [])) fail('You don’t have access to this conversation.');
      return base(c, d);
    }
    const fresh = typeof d.id === 'string' && !M.msg(d.id);
    if (fresh && (!isFriend(shadow) || blockedEither(shadow))) fail(`You can only message ${M.userRow(shadow).name} while you’re friends.`);
    if (fresh) fitsPeers(d.files, [uidOf(shadow)]);
    if (fresh && outbox.full(shadow)) fail(`Too many messages are waiting for ${M.userRow(shadow).name} to come online.`);
    const r = base(c, d);
    if (fresh && r?.m) {
      const m = r.m;
      const at = Math.round(reg.now());
      later(async () => {
        const files = [];
        for (const f of m.files || []) {
          const row = db.get('SELECT id, name, type, size FROM files WHERE id = ?', f.id);
          if (!row) continue;
          const hash = await blobs.hashOf(row.id);
          files.push({ id: row.id, name: row.name, type: row.type, size: row.size, hash, ...(f.w ? { w: f.w, h: f.h } : {}) });
        }
        // A thread reply (0.12): its thread's first message goes with it. A PC without threads over the
        // link (0.11) gets it as a reply to that message instead, so it still reads in context.
        const root = String(d.conv).startsWith('t:') ? String(d.conv).slice(2) : null;
        const thread = root ? (can(shadow, 'thread') ? { t: root } : (!m.replyTo ? { replyTo: root } : {})) : {};
        // A forward or a sticker (0.13) carries its card; `text` stays what an older PC shows.
        outbox.push(shadow, 'dm.msg', m.id, JSON.stringify({ id: m.id, text: m.text, ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...thread, ...(files.length ? { files } : {}), ...extrasOut(m) }), at);
        const uid = uidOf(shadow);
        if (!links.want(uid) || !links.isUp(uid)) toOwner('msg.state', { conv: d.conv, id: m.id, state: 'waiting' });
      });
    }
    return r;
  });
  const queueKind = (name, kind, pick) => wrap(name, (c, d, base) => {
    const shadow = sendableMsg(c, d.conv);
    const r = base(c, d);
    if (shadow) {
      const at = Math.round(reg.now());
      later(() => { outbox.push(shadow, kind, d.id, JSON.stringify(pick(d)), at); links.want(uidOf(shadow)); });
    }
    return r;
  });
  queueKind('msg.edit', 'dm.edit', (d) => ({ id: d.id, text: d.text }));
  queueKind('msg.delete', 'dm.delete', (d) => ({ id: d.id }));
  queueKind('msg.restore', 'dm.restore', (d) => ({ id: d.id }));
  queueKind('react', 'dm.react', (d) => ({ id: d.id, emoji: d.emoji, on: d.on === true }));
  // 0.12: pins and the disappearing-messages timer, only to PCs that understand them.
  const queueIf = (name, cap, kind, pick, refuse) => ops[name] && wrap(name, (c, d, base) => {
    const shadow = sendable(c, d.conv);
    if (shadow && !can(shadow, cap) && refuse) fail(refuse(shadow));
    const r = base(c, d);
    if (shadow && can(shadow, cap)) {
      const at = Math.round(reg.now());
      later(() => { outbox.push(shadow, kind, null, JSON.stringify(pick(d)), at); links.want(uidOf(shadow)); });
    }
    return r;
  });
  queueIf('msg.pin', 'pin', 'dm.pin', (d) => ({ id: d.id, on: true }));
  queueIf('msg.unpin', 'pin', 'dm.pin', (d) => ({ id: d.id, on: false }));
  const OLD_PC = (shadow) => `${M.userRow(shadow)?.name || 'Your friend'}’s Snug needs an update before messages can disappear here. Until then, nothing would be removed on their PC.`;
  queueIf('conv.ttl', 'ttl', 'dm.ttl', (d) => ({ ttl: d.ttl }), OLD_PC);
  // The dialog says why it can't be switched on yet (js/views/disappear.js).
  const baseDmView = M.dmView;
  M.dmView = (id, viewer) => {
    const v = baseDmView(id, viewer);
    const shadow = v && viewer === owner() ? remoteOfDm(id) : null;
    if (shadow && !can(shadow, 'ttl')) v.ttlBlocked = OLD_PC(shadow);
    return v;
  };
  // Polls (0.13): the poll, each vote and its end go to the friend's PC as their own frames, once its
  // profile says it understands them. An older PC would keep only the question: refused plainly instead.
  const OLD_POLL = (shadow) => `${M.userRow(shadow)?.name || 'Your friend'}’s Snug needs an update before you can share a poll here. Until then, they’d only see the question.`;
  const localOnly = new Set(); // ids of polls being made: their message goes as a poll, not as a dm.msg
  if (ops['poll.create']) wrap('poll.create', (c, d, base) => {
    const shadow = sendableMsg(c, d.conv);
    if (!shadow) {
      if (!c.peer && !mine(c) && remoteOfDm(threadParent(d.conv) || d.conv)) fail('You don’t have access to this conversation.');
      return base(c, d);
    }
    const fresh = typeof d.id === 'string' && !M.msg(d.id);
    if (fresh) {
      if (!isFriend(shadow) || blockedEither(shadow)) fail(`You can only message ${M.userRow(shadow).name} while you’re friends.`);
      if (!can(shadow, 'poll')) fail(OLD_POLL(shadow));
      if (outbox.full(shadow)) fail(`Too many messages are waiting for ${M.userRow(shadow).name} to come online.`);
    }
    if (fresh) localOnly.add(d.id);
    let r;
    try { r = base(c, d); } finally { localOnly.delete(d.id); }
    const p = fresh && r?.m ? db.get('SELECT * FROM polls WHERE msg = ?', r.m.id) : null;
    if (p) {
      const at = Math.round(reg.now());
      const root = String(d.conv).startsWith('t:') ? String(d.conv).slice(2) : null;
      later(() => {
        outbox.push(shadow, 'dm.poll', p.msg, JSON.stringify({ id: p.msg, question: p.question, answers: json(p.answers, []).map((a) => ({ text: a.text, ...(a.emoji ? { emoji: a.emoji } : {}) })), multi: !!p.multi, hidden: !!p.hidden, ends: p.ends, ...(root ? { t: root } : {}) }), at);
        links.want(uidOf(shadow));
      });
    }
    return r;
  });
  if (ops['poll.vote']) wrap('poll.vote', (c, d, base) => {
    const shadow = sendableMsg(c, d.conv);
    const r = base(c, d);
    if (shadow && can(shadow, 'poll') && Array.isArray(r?.votes)) {
      const at = Math.round(reg.now());
      later(() => { outbox.push(shadow, 'dm.vote', d.id, JSON.stringify({ id: d.id, answers: r.votes }), at); links.want(uidOf(shadow)); });
    }
    return r;
  });
  if (ops['poll.end']) wrap('poll.end', (c, d, base) => {
    const shadow = sendableMsg(c, d.conv);
    const was = shadow ? db.get('SELECT ended FROM polls WHERE msg = ?', d.id) : null;
    const r = base(c, d);
    if (shadow && can(shadow, 'poll') && was && !was.ended) {
      const at = Math.round(reg.now());
      later(() => { outbox.push(shadow, 'dm.pollend', d.id, JSON.stringify({ id: d.id }), at); links.want(uidOf(shadow)); });
    }
    return r;
  });
  const baseDmView2 = M.dmView;
  M.dmView = (id, viewer) => {
    const v = baseDmView2(id, viewer);
    const shadow = v && viewer === owner() ? remoteOfDm(id) : null;
    if (shadow && !can(shadow, 'poll')) v.pollBlocked = OLD_POLL(shadow);
    return v;
  };
  wrap('typing', (c, d, base) => {
    const r = base(c, d);
    const shadow = sendable(c, d.conv);
    if (shadow) {
      const uid = uidOf(shadow);
      // The first keystroke opens the link early (F8); typing itself only goes over an open one.
      if (!links.sendEph(uid, 'typing', {})) links.want(uid);
    }
    return r;
  });

  // Calls (section 7.5).
  wrap('call.start', (c, d, base) => {
    const shadow = sendable(c, d.dm);
    const r = base(c, d);
    if (shadow && r?.call) {
      const uid = uidOf(shadow);
      turnFor(uid);
      links.ready(uid, 10_000).then((ok) => { if (ok && hub.callOf(d.dm)?.id === r.call) links.sendEph(uid, 'call.start', { call: r.call, video: d.video === true }); });
    }
    return r;
  });
  wrap('call.join', (c, d, base) => {
    const shadow = sendable(c, d.dm);
    const r = base(c, d);
    if (shadow && r?.call) links.sendEph(uidOf(shadow), 'call.join', { call: r.call });
    return r;
  });
  wrap('call.decline', (c, d, base) => {
    const shadow = sendable(c, d.dm);
    const call = shadow ? hub.callOf(d.dm) : null;
    const r = base(c, d);
    if (shadow && call) links.sendEph(uidOf(shadow), 'call.decline', { call: call.id });
    return r;
  });
  wrap('voice.state', (c, d, base) => {
    const r = base(c, d);
    const place = mine(c) ? hub.voicePlaceOf(c.user) : null;
    const shadow = place && remoteOfDm(place);
    if (shadow) {
      const s = {};
      for (const k of ['muted', 'deaf', 'camera', 'screen', 'listen']) if (typeof d[k] === 'boolean') s[k] = d[k];
      links.sendEph(uidOf(shadow), 'voice.state', s);
    }
    return r;
  });
  hub.voiceHooks.left.push((u, place) => {
    if (u !== owner() || !active()) return;
    const shadow = remoteOfDm(place);
    if (shadow) links.sendEph(uidOf(shadow), 'voice.leave', {});
  });
  if (ops['ice.refresh']) wrap('ice.refresh', (c, d, base) => { const r = base(c, d); return c.user === owner() && turn ? { ...r, iceExp: turn.exp - 5 * 60_000 } : r; });

  // ---------- New ops: the link host and the owner's choices (section 9.5) ----------
  const L_host = limiter({ capacity: 20, perSecond: 2 });
  hub.addLimits?.({
    'peer.in': limiter({ capacity: 400, perSecond: 200 }),
    'peer.host': L_host, 'peer.sdp': L_host, 'peer.open': L_host, 'peer.closed': L_host, 'peer.busy': L_host, 'peer.drain': L_host,
  });
  const fromHost = (c) => { const h = currentHost(); if (!h || h.ws !== c.ws || c.user !== owner()) fail('Only this PC’s link host can do that.'); };
  const linkArgs = (d) => {
    if (!isUid(d.peer) || typeof d.sid !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(d.sid)) fail('That link isn’t valid.');
    return [d.peer, d.sid];
  };
  ops['peer.host'] = (c, d) => {
    if (!mine(c)) fail('Only this PC’s owner can host links.');
    if (!c.ws?.loopback) fail('Only Snug on this PC can host links.'); // F6
    const i = hosts.findIndex((h) => h.ws === c.ws);
    if (i >= 0) hosts.splice(i, 1);
    if (d.on === true) {
      hosts.push({ ws: c.ws, desktop: d.desktop === true, at: Date.now() });
      c.ws.once?.('close', () => {
        const j = hosts.findIndex((h) => h.ws === c.ws);
        if (j >= 0) hosts.splice(j, 1);
        links.hostGone();
      });
    } else links.hostGone();
    return { host: currentHost()?.ws === c.ws };
  };
  ops['peer.sdp'] = (c, d) => { fromHost(c); const [uid, sid] = linkArgs(d); if (typeof d.sdp !== 'string' || d.sdp.length > 12_000) fail('Bad description.'); links.onLocalSdp(uid, sid, d.sdp); return {}; };
  ops['peer.open'] = (c, d) => { fromHost(c); links.onOpen(...linkArgs(d)); return {}; };
  ops['peer.closed'] = (c, d) => { fromHost(c); links.onClosed(...linkArgs(d)); return {}; };
  ops['peer.busy'] = (c, d) => { fromHost(c); links.onBusy(...linkArgs(d), true); return {}; };
  ops['peer.drain'] = (c, d) => { fromHost(c); links.onBusy(...linkArgs(d), false); return {}; };
  ops['peer.in'] = (c, d) => {
    fromHost(c);
    const [uid, sid] = linkArgs(d);
    const fs = Array.isArray(d.fs) ? d.fs.slice(0, 16) : [];
    let size = 0;
    for (const f of fs) { if (typeof f !== 'string' || f.length > 64 * 1024) fail('Frame too big.'); size += f.length; }
    if (size > 400 * 1024) fail('Batch too big.');
    for (const f of fs) links.receive(uid, f, 'direct', sid);
    return {};
  };
  ops['peer.keyAck'] = (c, d) => {
    if (!mine(c) || !isRemote(d.user)) fail('That person isn’t a friend on another PC.');
    db.run('UPDATE peers SET key_changed_at = NULL, hold_before = NULL WHERE user = ?', d.user);
    const uid = uidOf(d.user);
    const released = outbox.release(d.user);
    const dm = dmIdFor(myUid(), uid);
    for (const r of released) if (r.kind === 'dm.msg') toOwner('msg.state', { conv: dm, id: r.ref, state: 'waiting' });
    const p = peerOf(uid);
    toOwner('peer.key', { user: d.user, fingerprint: fingerprint(p.ik, p.xk), at: null, quiet: true });
    links.want(uid);
    return {};
  };
  ops['peer.setHideIp'] = (c, d) => {
    if (!mine(c)) fail('Only this PC’s owner can change that.');
    identity.setSelf({ hideIp: d.on === true });
    if (self.hideIp) links.hostGone();
    p2pEvent({ hideIp: self.hideIp });
    return { hideIp: self.hideIp };
  };

  // ---------- Signal events ----------
  signal.on('ready', (m) => {
    registry = 'connected';
    if (m.mode === 'pending') {
      if (self.state !== 'moving') identity.setSelf({ state: 'moving', rebindAt: m.rebind?.at ?? self.rebindAt });
      p2pEvent({ rebindAt: m.rebind?.at ?? null });
      return;
    }
    if (self.state !== 'ok') identity.setSelf({ state: 'ok' });
    if (Number.isSafeInteger(m.kver) && m.kver !== self.kver) identity.setSelf({ kver: m.kver });
    lastVisible = visibleNow();
    sendWatch();
    if (!lastVisible) signal.send({ t: 'visible', on: false });
    resendKnocks();
    p2pEvent();
  });
  signal.on('down', () => {
    registry = 'offline';
    reach.clear(); quietNow = new Set(); // a new registry session starts both afresh
    for (const uid of [...online]) setOnline(uid, false);
    links.closeAll('registry down');
    p2pEvent();
  });
  signal.on('presence', (m) => { if (isUid(m.uid) && remote.has(shadowId(m.uid))) setOnline(m.uid, m.on === true); });
  signal.on('relay', (m) => { if (isUid(m.from) && typeof m.box === 'string' && remote.has(shadowId(m.from))) links.receive(m.from, m.box, 'relay'); });
  signal.on('sig', async (m) => {
    if (!isUid(m.from) || !remote.has(shadowId(m.from))) return;
    const b = parseBox(m.box);
    if (!b) return;
    const ik = await verifyFrom(m.from, (k) => boxVerify(m.from, myUid(), b, k));
    if (!ik) { stats.rejected++; return; }
    let obj;
    try { obj = boxOpen(identity.me(), m.from, b); } catch { stats.rejected++; return; }
    if (typeof obj.id !== 'string' || sigSeen.has(obj.id) || !Number.isSafeInteger(obj.ts) || Math.abs(obj.ts - reg.now()) > 5 * 60_000) return;
    sigSeen.set(obj.id, 1);
    if (sigSeen.size > 2000) sigSeen.delete(sigSeen.keys().next().value);
    if (isContact(shadowId(m.from))) links.onSig(m.from, obj);
  });
  signal.on('knock', (m) => { onKnock(m).catch((e) => log('peer', 'knock', e.message)); });
  signal.on('ok', (m) => {
    if (typeof m.id !== 'string') return;
    db.run('DELETE FROM peer_knocks WHERE id = ?', m.id);
    knockWaiters.get(m.id)?.(true);
  });
  signal.on('err', (m) => {
    const uid = relayIds.get(m.id);
    if (uid && (m.code === 'unavailable' || m.code === 'relay_unavailable')) {
      links.close(uid, m.code);
      if (m.code === 'unavailable') setOnline(uid, false);
    }
  });
  signal.on('rebind', (m) => {
    if (m.state !== 'pending' || !isKey(m.ik) || !isKey(m.xk)) return;
    rebindPending = { at: m.at, kver: m.kver, ik: m.ik, xk: m.xk };
    p2pEvent({ rebindPending: { at: m.at, fingerprint: fingerprint(m.ik, m.xk) } });
  });
  signal.on('revoked', () => {
    identity.setSelf({ state: 'revoked' });
    links.closeAll('revoked');
    p2pEvent({ state: 'revoked' });
  });
  signal.on('rebound', () => {
    // My move finished: this PC's key is the account's key now.
    identity.setSelf({ state: 'ok', rebindAt: null });
    identity.set('rebind_at', null);
    identity.dropBroken();
    p2pEvent();
  });
  signal.on('stopped', () => {
    identity.setSelf({ state: 'needs-signin' });
    p2pEvent({ state: 'needs-signin', stopped: true });
  });
  signal.on('offline', () => { if (registry !== 'offline') { registry = 'offline'; p2pEvent(); } });

  // ---------- The module's face ----------
  Object.assign(P, {
    start() {
      refreshSelf();
      if (!self?.uid || !self.user || self.state === 'revoked' || self.state === 'needs-signin') return false;
      identity.ensureKeys(); // keys load lazily, on the first start (F18)
      started = true;
      signal.start();
      return true;
    },
    stop() { started = false; signal.stop(); links.closeAll('stopped'); for (const uid of [...online]) setOnline(uid, false); },
    close() { P.stop(); blobs.close(); clearTimeout(watchT); for (const t of retryT.values()) clearTimeout(t); retryT.clear(); retryN.clear(); for (const v of deferredProfile.values()) clearTimeout(v.timer); deferredProfile.clear(); },
    wake() { if (started) signal.wake(); },
    isOwner: (u) => !!u && u === owner(),
    isRemote,
    isOnline: (uid) => online.has(uid),
    statusFor(u) {
      if (u !== owner() || !self) return { enabled: true, owner: false };
      const renamedAt = Number(identity.get('renamed_at')) || 0;
      return {
        enabled: true, owner: true, uid: self.uid, username: self.username, fingerprint: identity.fingerprint,
        keyProtected: identity.protected, state: self.state, registry,
        renameAt: renamedAt ? renamedAt + 7 * DAY : 0,
        ...(self.rebindAt ? { rebindAt: self.rebindAt } : {}),
        ...(rebindPending ? { rebindPending: { at: rebindPending.at, fingerprint: fingerprint(rebindPending.ik, rebindPending.xk), via: identity.get('move_via') || 'github' } } : {}),
        hideIp: !!self.hideIp, relayed: stats.relayed,
        // v0.12: a keypair account ('key') or a GitHub one ('gh'), and its recovery key (server/keyauth.js keeps these).
        // Short names: the snapshot never spells out the GitHub name (tests check no GitHub identity reaches it).
        kind: identity.get('kind') === 'key' ? 'key' : 'gh',
        recovery: { set: identity.get('rk_set') === '1', saved: identity.get('rk_saved') === '1', pendingAt: Number(identity.get('rk_pending_at')) || null },
        ghLinked: identity.get('gh_linked') === '1',
        ghChange: (() => { try { return JSON.parse(identity.get('gh_change') || 'null'); } catch { return null; } })(), // {change, at} or null
      };
    },
    // The old PC says "That was me" (section 6.4): my friends go to the new PC, then the registry moves now.
    async approveRebind() {
      const pend = rebindPending;
      if (!pend || !active()) fail('No move is waiting.');
      const uids = friendShadows().map(uidOf).filter(Boolean);
      const id = knock(myUid(), 'restore', { uids }, pend.xk);
      if (id) {
        await new Promise((resolve) => {
          const t = setTimeout(() => { knockWaiters.delete(id); resolve(false); }, 10_000);
          knockWaiters.set(id, (ok) => { clearTimeout(t); knockWaiters.delete(id); resolve(ok); });
        });
      }
      const prev = keychangeSign(identity.me().ikPriv, myUid(), pend.kver, pend.ik, pend.xk);
      const r = await reg.rebindApprove({ kver: pend.kver, ik: pend.ik, xk: pend.xk, prev });
      rebindPending = null;
      return r;
    },
    // v0.12: "Move to a new PC" with the pairing code shown there (server/keyauth.js id.moveAccept). My friends go
    // along in a restore list stored with the move (as approveRebind's), and the registry moves the account now.
    async moveAccept(code) {
      if (!active() || self.state !== 'ok') fail('Your account isn’t active on this PC right now.');
      const pk = await reg.signedCall('/v1/move/peek', 'move-peek', { code });
      const m = identity.me();
      const id = rid();
      const box = seal(m, myUid(), pk.xk, { t: 'restore', id, ts: Math.round(reg.now()), from: m.uid, d: { uids: friendShadows().map(uidOf).filter(Boolean) } });
      const prev = keychangeSign(m.ikPriv, myUid(), pk.kver, pk.ik, pk.xk);
      // A very long friend list doesn't fit a knock; the data file that follows the move carries it anyway.
      return reg.signedCall('/v1/move/accept', 'move-accept', { code, prev, ...(box.length <= 4096 ? { knock: { id, box } } : {}) });
    },
    async cancelRebind() {
      if (!active()) fail('This PC isn’t signed in.');
      const r = await reg.rebindCancel();
      rebindPending = null;
      p2pEvent({ rebindPending: null });
      return r;
    },
    // Account deleted: every friend hears it as an unfriend.
    async leaveAll() {
      if (!active()) return;
      const rows = db.all("SELECT f.other AS user, f.state FROM friends f JOIN users u ON u.id = f.other WHERE f.user = ? AND u.remote = 1", owner());
      const ids = rows.map((r) => knock(uidOf(r.user), r.state === 'outgoing' ? 'friend.cancel' : r.state === 'incoming' ? 'friend.decline' : 'friend.remove')).filter(Boolean);
      await Promise.all(ids.map((id) => new Promise((resolve) => {
        const t = setTimeout(() => { knockWaiters.delete(id); resolve(false); }, 5000);
        knockWaiters.set(id, (ok) => { clearTimeout(t); knockWaiters.delete(id); resolve(ok); });
      })));
    },
    missing: (row) => { const m = json(row?.meta, {}); return !!(m.remote && !m.have && !String(row.conv).includes(':')); },
    // A friend's attachment opened before its bytes are here (section 5.6). True when answered.
    async serveMissing(req, res, row) {
      const uid = uidOf(row.owner);
      const notHere = () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not here yet.', offline: !uid || !online.has(uid) }));
        return true;
      };
      if (!uid || !online.has(uid)) return notHere();
      const ok = await Promise.race([
        links.ready(uid, 10_000).then((up) => up && fetchAttachment(uid, row, false)),
        new Promise((r) => setTimeout(() => r(false), 15_000).unref?.()),
      ]);
      return ok ? false : notHere();
    },
    housekeep() {
      const t = Date.now();
      db.run('DELETE FROM peer_seen WHERE exp < ?', t);
      // review-media 5: leftover .part files, every half hour (it lists the files folder).
      if (t - lastPartSweep >= 30 * 60_000) { lastPartSweep = t; try { blobs.sweepParts(t); } catch (e) { log('peer', 'part sweep', e.code || e.message); } }
      if (!myUid()) return;
      const gone = outbox.expire(t);
      for (const r of gone) {
        if (r.kind === 'dm.msg' && r.ref) { const p = db.get('SELECT uid FROM peers WHERE user = ?', r.peer); if (p) toOwner('msg.state', { conv: dmIdFor(myUid(), p.uid), id: r.ref, state: 'failed' }); }
      }
      G.expired(gone);
      db.run('DELETE FROM peer_knocks WHERE created < ?', t - 30 * DAY);
    },
    stats: () => ({ ...stats, links: links.count(), linksOpened: stats.links, outbox: db.get('SELECT COUNT(*) n FROM peer_outbox').n, held: db.get(`SELECT COUNT(*) n FROM peer_outbox WHERE kind LIKE 'held:%'`).n }),
    // For tests and Track C: the internals that are safe to reach.
    _links: links, _signal: signal, _outbox: outbox, _ensureShadow: ensureShadow, _pushProfile: pushProfile,
    capsOf, // 0.12: what a friend's PC understands
    _setCaps: (uid, list) => { if (list === null) capsOverride.delete(uid); else capsOverride.set(uid, list); }, // tests: pretend a PC is older
    // Who is watched changed (Track C's import, groups across PCs).
    friendsChanged: () => watchSoon(),
    // v0.10 B: what server/peergroups.js needs from here.
    _g: {
      hooks: G, DURABLE, EPHEMERAL, owner, myUid, active, isRemote, uidOf, peerOf, isFriend, isContact, blockedEither,
      ensureShadow, shadowFor, verifyFrom, acceptFiles, fetchPending, later, toOwner, asShadow, outbox, links, online, fitsPeers, capsOf, threadParent, // fitsPeers, capsOf, threadParent: 0.12
      localOnly, applyPoll, applyVote, applyPollEnd, // 0.13: polls
      extrasOut, extrasIn, sendWithExtras, // 0.13: forwarded messages and stickers
      hashOf: (id) => blobs.hashOf(id), now: () => reg.now(), watchSoon, kver: () => Number(self?.kver) || 1,
    },
  });

  // Signed in on this PC already: connect at boot.
  if (self?.uid && self.user) queueMicrotask(() => P.start());
  return P;
}
