// The account's data file (design 0.10 sections 2 and 3): a sealed, automatically refreshed copy of the
// signed-in account's portable data, plus import, export, automatic backups and the PC-to-PC transfer.
//
//   createVault({ db, M, hub, peer, dataDir, filesDir, keyStore, log, http: { sendJson, error, body, headers } })
//     -> { enabled, status(), flush(), close(), http(req, res, path, url, user), importBuffer(buf), write(), backupNow() }
//
// Files (dataDir/vault/): <uid>.snugvault (the live copy), <uid>.key (the cached vault key, wrapped with the OS
// key store when it can be), backups/<uid>-<YYYYMMDD-HHmm>.snugvault (newest 5), incoming/<xid>.part|.json.
// Only the signed-in owner's <uid> files are ever opened.
//
// What the file guarantees: nobody can read it without the account's vault key (held by the registry, handed
// only to a device key of the same GitHub account), and any change made outside Snug is detected and the file
// refused. It is not undeletable, and an import only ever adds to this PC's data.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './ops.js';
import { seal, readHeader, decrypt, VaultError, MESSAGES, MAX_FILE, MAX_PAYLOAD, MAX_SECTION, CAPS, sha256hex } from './vaultfile.js';
import { createXfer, createXferSocket } from './vaultxfer.js';
import { dmIdFor, shadowId, remoteFileId, isUid, b64u, unb64u } from './peercrypto.js';
import { imageInfo } from './messaging.js';
import { newId } from './model.js';
import { APP_VERSION } from './peersignal.js';
import { cleanPrefs } from '../js/lib/account.js';
import { suspicious } from './seclog.js'; // sec-registry: alerts in the security log

const DAY = 86_400_000;
const MAX_PIC = 2 * 1024 * 1024;
const PIC_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const KEEP_BACKUPS = 5;
// Ops that never change what goes in the file (reads, voice, games, the link host's own frames).
const SKIP = /^(peer\.|typing$|presence\.idle$|search|admin\.|vault\.|sync$|history$|read\.|discover$|voice\.|call\.|rtc$|ice\.|unread\.|mentions\.|mention\.|insights\.|poll\.view$|msg\.at$|msg\.edits$|msg\.peek$|audit\.|invite\.list$|mod\.bans$|report\.list$|automod\.get$|sessions\.list$|friends\.mutual$|board\.|game\.|activity\.|sound\.play$|stage\.|house\.preview$|sched\.list$|hook\.list$|cmd\.)/;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const fail = (m) => { throw new UserError(m); };
const sleepSync = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* Windows rename retry only */ } };
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (t = new Date()) => `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
export const downloadName = (t = new Date()) => `Snug data ${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}.snugvault`;

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i >= 3 || !['EPERM', 'EBUSY'].includes(e.code)) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
      sleepSync(50); // Windows antivirus can hold the file a moment
    }
  }
}
const rm = (f) => { try { unlinkSync(f); } catch { /* gone */ } };

export function createVault({ db, M, hub, peer, dataDir, filesDir, keyStore = null, log = () => {}, http = {} }) {
  const off = {
    enabled: false, status: () => ({ enabled: false }), flush() {}, close() {}, http: async () => false,
    importBuffer: async () => { throw new VaultError('no_key'); }, write: async () => false, backupNow: async () => false,
  };
  if (!peer?.enabled || !dataDir || dataDir === ':memory:') return off;

  db.raw.exec('CREATE TABLE IF NOT EXISTS vault_meta (k TEXT PRIMARY KEY, v TEXT)');
  const meta = {
    get: (k) => db.get('SELECT v FROM vault_meta WHERE k = ?', k)?.v ?? null,
    set: (k, v) => { if (v == null) db.run('DELETE FROM vault_meta WHERE k = ?', k); else db.run('INSERT INTO vault_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, String(v)); },
    num: (k) => Number(db.get('SELECT v FROM vault_meta WHERE k = ?', k)?.v) || 0,
  };
  const env = process.env;
  const debounceMs = Number(env.SNUG_VAULT_DEBOUNCE_MS) || 30_000;
  const maxWaitMs = Number(env.SNUG_VAULT_MAX_WAIT_MS) || 5 * 60_000;
  const vdir = join(dataDir, 'vault');
  const bdir = join(vdir, 'backups');
  const ensureDir = (d) => mkdirSync(d, { recursive: true, mode: 0o700 });
  const self = () => peer.identity?.self?.() || null;
  const owner = () => self()?.user || null;
  const myUid = () => self()?.uid || null;
  const usable = () => { const s = self(); return !!(s?.uid && s.user && isUid(s.uid) && M.userRow(s.user)); };
  const liveFile = (uid = myUid()) => join(vdir, `${uid}.snugvault`);
  const keyFile = (uid = myUid()) => join(vdir, `${uid}.key`);
  const toOwner = (ev, d) => { const o = owner(); if (o) hub.toUser(o, ev, d); };
  const available = () => { try { return !!keyStore?.available?.(); } catch { return false; } };

  // ---------- The vault key (design 2.6) ----------
  let mem = null;        // { uid, key, kid, enc }
  let keyFetch = null;
  function readCache(uid) {
    const f = keyFile(uid);
    if (!existsSync(f)) return null;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (j.v !== 1 || !Number.isSafeInteger(j.kid) || typeof j.blob !== 'string') throw new Error('shape');
      const plain = j.enc === 'safeStorage' ? keyStore.decrypt(j.blob) : Buffer.from(j.blob, 'base64').toString('utf8');
      const key = unb64u(plain);
      if (key.length !== 32) throw new Error('length');
      return { uid, key, kid: j.kid, enc: j.enc === 'safeStorage' ? 'safeStorage' : 'none' };
    } catch (e) {
      // Another OS user, a wiped keyring or a damaged file: drop it and ask the registry again.
      log('vault', 'cached key unusable', e.message);
      rm(f);
      return null;
    }
  }
  function writeCache(uid, key, kid) {
    const plain = b64u(key);
    let enc = 'none';
    let blob = Buffer.from(plain, 'utf8').toString('base64');
    if (available()) {
      try { blob = keyStore.encrypt(plain); enc = 'safeStorage'; } catch { enc = 'none'; blob = Buffer.from(plain, 'utf8').toString('base64'); }
    }
    ensureDir(vdir);
    writeAtomic(keyFile(uid), JSON.stringify({ v: 1, enc, kid, blob }));
    return enc;
  }
  function cachedKeySync() {
    const uid = myUid();
    if (!uid) return null;
    if (mem?.uid === uid) return mem;
    const c = readCache(uid);
    if (c) mem = c;
    return c;
  }
  async function ensureKey(force = false) {
    const uid = myUid();
    if (!uid) throw new VaultError('no_key', 'signed out');
    if (!force) { const c = cachedKeySync(); if (c) return c; }
    if (!keyFetch) {
      keyFetch = (async () => {
        let r;
        try { r = await peer.reg.signedCall('/v1/vault/key', 'vault-key'); } catch (e) {
          // sec-registry REG-H1: the registry gives the key to the current key only, never to a pending move.
          if (self()?.state === 'moving' && (e.code === 'bad_signature' || e.status === 401)) throw new VaultError('not_yet', e.code);
          throw new VaultError('no_key', e.code || e.message);
        }
        const key = typeof r?.key === 'string' ? unb64u(r.key) : Buffer.alloc(0);
        if (key.length !== 32 || !Number.isSafeInteger(r.kid) || r.kid < 1) throw new VaultError('no_key', 'reply');
        if (myUid() !== uid) throw new VaultError('no_key', 'account changed');
        const enc = writeCache(uid, key, r.kid);
        mem = { uid, key, kid: r.kid, enc };
        return mem;
      })().finally(() => { keyFetch = null; });
    }
    return keyFetch;
  }
  // sec-registry REG-L1: the vault key can rotate. A file sealed with an older key (a backup, or the old PC's
  // file after a move) asks the registry for that key by kid; it is kept in memory only.
  const olderKeys = new Map(); // `${uid}:${kid}` -> { uid, key, kid }
  async function keyForKid(kid) {
    let key = await ensureKey();
    if (kid === key.kid) return key;
    if (kid > key.kid) {
      key = await ensureKey(true);
      if (kid === key.kid) return key;
      throw new VaultError('tampered', 'kid');
    }
    const uid = myUid();
    const hit = olderKeys.get(`${uid}:${kid}`);
    if (hit) return hit;
    let r;
    try { r = await peer.reg.signedCall('/v1/vault/key', 'vault-key', { kid }); } catch (e) {
      if (e.code === 'not_found') throw new VaultError('tampered', 'kid');
      throw new VaultError('no_key', e.code || e.message);
    }
    const raw = typeof r?.key === 'string' ? unb64u(r.key) : Buffer.alloc(0);
    if (raw.length !== 32 || r.kid !== kid || myUid() !== uid) throw new VaultError('no_key', 'reply');
    const k = { uid, key: raw, kid };
    if (olderKeys.size >= 8) olderKeys.delete(olderKeys.keys().next().value);
    olderKeys.set(`${uid}:${kid}`, k);
    return k;
  }
  // A new vault key (the user asked, or a move was stopped: a key holder may be in the wrong hands). Files
  // written from now on use it; older files and backups stay readable through keyForKid.
  async function rotateKey() {
    await peer.reg.signedCall('/v1/vault/rotate', 'vault-rotate');
    const k = await ensureKey(true);
    markDirty();
    await write({ force: true }).catch(() => {});
    return k.kid;
  }
  function cacheEnc() {
    if (mem?.uid === myUid()) return mem.enc;
    try { return JSON.parse(readFileSync(keyFile(), 'utf8')).enc === 'safeStorage' ? 'safeStorage' : 'none'; } catch { return null; }
  }

  // ---------- Building the payload (design 2.3) ----------
  function readPic(fileId) {
    if (!fileId) return null;
    const f = db.get('SELECT type, size FROM files WHERE id = ?', fileId);
    if (!f || f.size > MAX_PIC || !PIC_TYPES.includes(f.type)) return null;
    try {
      const data = readFileSync(join(filesDir, fileId));
      return data.length > MAX_PIC ? null : { type: f.type, data: data.toString('base64') };
    } catch { return null; }
  }
  function conversations(o, uid) {
    const rows = db.all(`SELECT d.id, m2.user AS other, (SELECT MAX(seq) FROM messages WHERE conv = d.id) AS last
      FROM dms d JOIN dm_members m1 ON m1.dm = d.id AND m1.user = ?
      JOIN dm_members m2 ON m2.dm = d.id AND m2.user != ?
      JOIN users u ON u.id = m2.user AND u.remote = 1
      WHERE (SELECT COUNT(*) FROM dm_members WHERE dm = d.id) = 2 ORDER BY last DESC`, o, o);
    return rows.filter((r) => isUid(r.other.slice(2)) && r.id === dmIdFor(uid, r.other.slice(2))).slice(0, CAPS.conversations);
  }
  function fileMeta(list) {
    const out = [];
    for (const f of (json(list, []) || []).slice(0, 6)) {
      const row = f?.id ? db.get('SELECT id, name, type, size, meta FROM files WHERE id = ?', f.id) : null;
      if (!row) continue;
      const m = json(row.meta, {}) || {};
      const hash = m.hash || db.get('SELECT hash FROM peer_hash WHERE file = ?', row.id)?.hash || null;
      const id = m.remote ? m.rid : row.id;
      if (typeof id !== 'string' || !/^f_[a-z0-9]{8,40}$/.test(id)) continue;
      out.push({ id, name: String(row.name).slice(0, 200), type: String(row.type).slice(0, 100), size: row.size, ...(hash && /^[A-Za-z0-9_-]{43}$/.test(hash) ? { hash } : {}) });
    }
    return out;
  }
  // 0.13: a conversation's disappearing timer, carried in the file and set again on import.
  const ttlOf = (conv) => db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conv_ttl'") ? (db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', conv)?.ttl || 0) : 0;
  // Everything but `at`; its hash says whether anything changed since the last write.
  function buildBody() {
    const o = owner();
    const uid = myUid();
    const r = db.get('SELECT * FROM users WHERE id = ?', o);
    const profile = {
      name: r.name, about: r.about || '', hue: r.hue, emoji: r.emoji || null,
      status: r.status || '', statusEmoji: r.status_emoji || null, statusUntil: r.status_until ?? null,
      pronouns: r.pronouns || '', accent: Number.isInteger(r.accent) ? r.accent : null,
      interests: json(r.interests, []), links: json(r.links, []), presence: r.presence || 'around',
      decoration: r.decoration || null, decorationHue: Number.isInteger(r.decoration_hue) ? r.decoration_hue : null,
      nameStyle: json(r.name_style, null), profileColors: json(r.profile_colors, null),
      avatar: readPic(r.avatar), banner: readPic(r.banner),
    };
    const pv = db.get('SELECT dm, friends, requests FROM privacy WHERE user = ?', o);
    const people = db.all('SELECT p.uid, p.username, p.ik, p.xk, p.kver, u.name FROM peers p JOIN users u ON u.id = p.user ORDER BY p.pinned_at LIMIT ?', CAPS.people)
      .filter((p) => p.uid !== uid).map((p) => ({ uid: p.uid, username: p.username, ik: p.ik, xk: p.xk, kver: p.kver, name: String(p.name || '').slice(0, 64) }));
    const keys = db.all('SELECT uid, kver, ik, xk FROM peer_keys WHERE uid != ? ORDER BY uid, kver LIMIT ?', uid, CAPS.people * 8);
    const friends = db.all('SELECT f.other, f.state, f.since, f.favorite FROM friends f JOIN users u ON u.id = f.other WHERE f.user = ? AND u.remote = 1 LIMIT ?', o, CAPS.people)
      .filter((f) => isUid(f.other.slice(2)) && ['friends', 'incoming', 'outgoing'].includes(f.state))
      .map((f) => ({ uid: f.other.slice(2), state: f.state, since: f.since, favorite: f.favorite ? 1 : 0 }));
    const blocks = db.all('SELECT b.other FROM blocks b JOIN users u ON u.id = b.other WHERE b.user = ? AND u.remote = 1 LIMIT ?', o, CAPS.people * 4)
      .map((b) => b.other.slice(2)).filter(isUid);
    const dms = [];
    let left = CAPS.messages;
    for (const c of conversations(o, uid)) {
      const peerUid = c.other.slice(2);
      const rows = left > 0 ? db.all('SELECT * FROM messages WHERE conv = ? AND sys IS NULL ORDER BY seq DESC LIMIT ?', c.id, Math.min(CAPS.perConversation, left)).reverse() : [];
      const rx = M.reactions(rows.map((m) => m.id));
      const msgs = [];
      const now = Date.now();
      for (const m of rows) {
        const a = m.author === o ? uid : m.author === c.other ? peerUid : null;
        if (!a || !/^m_[a-z0-9]{8,40}$/.test(m.id)) continue;
        if (m.expires && m.expires <= now) continue; // gone already (0.13)
        const x = { id: m.id, a, ts: m.ts, text: String(m.text || '').slice(0, CAPS.text) };
        if (m.expires) x.exp = m.expires; // 0.13: when it disappears (a 0.11 or 0.12 PC ignores it)
        if (m.reply_to && /^m_[a-z0-9]{8,40}$/.test(m.reply_to)) x.r = m.reply_to;
        if (m.edited) x.e = m.edited;
        if (m.deleted) x.d = m.deleted;
        const re = Object.entries(rx[m.id] || {}).flatMap(([e, us]) => us.map((u) => (u === o ? { u: uid, e } : u === c.other ? { u: peerUid, e } : null)).filter(Boolean)).slice(0, 200);
        if (re.length) x.x = re;
        if (m.files) { const f = fileMeta(m.files); if (f.length) x.f = f; }
        msgs.push(x);
      }
      left -= msgs.length;
      // 0.13: the disappearing timer (0 when off); its presence also says each message's `exp` is complete.
      dms.push({ peer: peerUid, ttl: ttlOf(c.id), msgs });
    }
    const sections = {};
    const ctx = { db, M, owner: o, myUid: uid, peer };
    for (const s of hub.vaultSections || []) {
      try {
        const data = s.export(ctx);
        if (data === undefined) continue;
        if (JSON.stringify(data).length > MAX_SECTION) { log('vault', 'section too big, left out', s.name); continue; }
        sections[s.name] = data;
      } catch (e) { log('vault', 'section export', s.name, e.message); }
    }
    return {
      v: 1, uid, username: self().username || '', app: APP_VERSION, profile,
      prefs: json(db.get('SELECT prefs FROM user_prefs WHERE user = ?', o)?.prefs, {}) || {},
      privacy: pv ? { dm: pv.dm, friends: pv.friends, requests: pv.requests } : null,
      people, keys, friends, blocks, dms, sections,
    };
  }
  // Seal the body; over 16 MiB (or 64 MiB of JSON) the oldest messages go first, then the pictures.
  function sealSized(body, key) {
    let b = body;
    for (let round = 0; round < 24; round++) {
      const payload = JSON.stringify({ ...b, at: Date.now() });
      if (payload.length <= MAX_PAYLOAD) {
        try {
          return seal({ key: key.key, uid: b.uid, kid: key.kid, seq: meta.num('last_seq') + 1, app: APP_VERSION, payload });
        } catch (e) { if (e.code !== 'too_big') throw e; }
      }
      const more = b.dms.some((c) => c.msgs.length);
      if (more) b = { ...b, dms: b.dms.map((c) => ({ ...c, msgs: c.msgs.slice(Math.ceil(c.msgs.length / 4)) })) };
      else if (b.profile?.avatar || b.profile?.banner) b = { ...b, profile: { ...b.profile, avatar: null, banner: null } };
      else if (Object.keys(b.sections).length) b = { ...b, sections: {} };
      else break;
    }
    throw new VaultError('too_big');
  }

  // ---------- Writing (design 2.6) ----------
  let dirty = false, dirtyAt = 0, timer = null, lastError = null, closed = false;
  function markDirty() {
    if (closed || !usable()) return;
    dirty = true;
    if (!dirtyAt) dirtyAt = Date.now();
    schedule();
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (closed) return;
    const wait = ms ?? Math.max(0, Math.min(debounceMs, dirtyAt + maxWaitMs - Date.now()));
    timer = setTimeout(() => { timer = null; write().catch((e) => log('vault', 'write', e.message)); }, wait);
    timer.unref?.();
  }
  // Synchronous: needs the key already in memory or in the cache.
  function writeNow({ force = false } = {}) {
    if (!usable()) return false;
    const key = cachedKeySync();
    if (!key) return false;
    const body = buildBody();
    const hash = sha256hex(JSON.stringify(body));
    if (!force && hash === meta.get('last_hash') && existsSync(liveFile())) { dirty = false; dirtyAt = 0; return true; }
    const buf = sealSized(body, key);
    ensureDir(vdir);
    writeAtomic(liveFile(), buf);
    meta.set('last_hash', hash);
    meta.set('last_seq', meta.num('last_seq') + 1);
    meta.set('last_write', Date.now());
    dirty = false;
    dirtyAt = 0;
    if (lastError) lastError = null;
    pushStatus();
    return true;
  }
  async function write(opts) {
    if (closed || !usable()) return false;
    try { await ensureKey(); } catch (e) {
      // No key yet (fresh device, registry offline): stay dirty, try again at the next ready.
      dirty = true;
      const code = e.code === 'not_yet' ? null : e.code; // a pending move: nothing is wrong, the key comes after it
      if (lastError !== code) { lastError = code; pushStatus(); }
      return false;
    }
    try { return writeNow(opts); } catch (e) {
      // Disk full or a write error: the old file stays (tmp + rename); try again at the next change.
      log('vault', 'write failed', e.code || e.message);
      dirty = true;
      lastError = e.code === 'too_big' ? 'too_big' : 'write';
      pushStatus();
      return false;
    }
  }
  function flush() {
    if (closed || !usable()) return;
    if (!dirty && existsSync(liveFile())) return;
    try { writeNow(); } catch (e) { log('vault', 'flush', e.message); }
  }

  // Every op that succeeds may change the data: mark dirty (owner's and friends' shadows' alike).
  for (const [name, fn] of Object.entries(hub.ops)) {
    if (typeof fn !== 'function' || SKIP.test(name)) continue;
    hub.ops[name] = function vaultWrapped(c, d) {
      const r = fn.call(this, c, d);
      if (r && typeof r.then === 'function') return r.then((v) => { markDirty(); return v; });
      markDirty();
      return r;
    };
  }

  // ---------- Import (design 2.5): merge, never delete, one transaction ----------
  const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
  const intOr = (n, f) => (Number.isSafeInteger(n) ? n : f);
  function picFile(o, kind, m, created) {
    if (!m) return null;
    const data = Buffer.from(m.data, 'base64');
    const img = imageInfo(data);
    if (!img || !PIC_TYPES.includes(img.type) || data.length > MAX_PIC) return undefined;
    if (kind === 'avatar' && (img.w < 64 || img.h < 64 || img.w > 2048 || img.h > 2048)) return undefined;
    const id = newId('f');
    writeFileSync(join(filesDir, id), data, { mode: 0o600 });
    created.push(id);
    db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, o, `${kind}:${o}`, kind, img.type, data.length, Date.now(), JSON.stringify({ w: img.w, h: img.h }));
    return { id, anim: img.type === 'image/gif' };
  }
  // 0.13: the timer as the file had it, unless this PC already has one for that conversation (a merge).
  const TTLS = [3_600_000, 86_400_000, 7 * 86_400_000, 30 * 86_400_000];
  function restoreTtl(conv, ttl, by, t) {
    if (!TTLS.includes(ttl) || !db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conv_ttl'")) return;
    db.run('INSERT INTO conv_ttl (conv, ttl, by, ts) VALUES (?, ?, ?, ?) ON CONFLICT (conv) DO NOTHING', conv, ttl, by, t);
  }
  function applyPayload(p, selfKeys = null) {
    const o = owner();
    const uid = myUid();
    const t = Date.now();
    const counts = { people: 0, friends: 0, conversations: 0, messages: 0 };
    const newFriends = [], newDms = [], created = [], newPins = [];
    try {
      db.tx(() => {
        // People: pin the keys the file knows; a live pin is never overridden.
        const known = new Set();
        for (const x of p.people) {
          if (x.uid === uid) continue;
          const had = !!db.get('SELECT 1 FROM peers WHERE uid = ?', x.uid);
          peer._ensureShadow({ uid: x.uid, username: x.username, ik: x.ik, xk: x.xk, kver: x.kver });
          if (!had) {
            newPins.push(x.uid);
            counts.people++;
            if (x.name) db.run('UPDATE users SET name = ? WHERE id = ?', clip(x.name, 64), shadowId(x.uid));
          }
          known.add(x.uid);
        }
        for (const k of p.keys) if (k.uid !== uid) db.run('INSERT OR IGNORE INTO peer_keys (uid, kver, ik, xk, at) VALUES (?, ?, ?, ?, ?)', k.uid, k.kver, k.ik, k.xk, t);
        const hasPeer = (u) => known.has(u) || !!db.get('SELECT 1 FROM peers WHERE uid = ?', u);
        // Friends: missing rows both ways, with the stored state; existing rows untouched.
        const mirror = { friends: 'friends', incoming: 'outgoing', outgoing: 'incoming' };
        for (const f of p.friends) {
          if (f.uid === uid || !hasPeer(f.uid)) continue;
          const s = shadowId(f.uid);
          if (db.get('SELECT 1 FROM friends WHERE user = ? AND other = ?', o, s)) continue;
          db.run('INSERT INTO friends (user, other, state, favorite, since) VALUES (?, ?, ?, ?, ?)', o, s, f.state, f.favorite ? 1 : 0, f.since);
          db.run('INSERT OR IGNORE INTO friends (user, other, state, favorite, since) VALUES (?, ?, ?, 0, ?)', s, o, mirror[f.state], f.since);
          newFriends.push(s);
          counts.friends++;
        }
        for (const b of p.blocks) if (b !== uid && hasPeer(b)) db.run('INSERT OR IGNORE INTO blocks (user, other, ts) VALUES (?, ?, ?)', o, shadowId(b), t);
        // Profile, settings and privacy: a restore is what the person asked for.
        const pr = p.profile;
        if (pr) {
          const cols = {
            name: clip(pr.name, 32).trim() || M.userRow(o).name, about: clip(pr.about, 4000), hue: intOr(pr.hue, M.userRow(o).hue),
            emoji: pr.emoji == null ? null : clip(pr.emoji, 32), status: clip(pr.status, 200), status_emoji: pr.statusEmoji == null ? null : clip(pr.statusEmoji, 32),
            status_until: Number.isSafeInteger(pr.statusUntil) ? pr.statusUntil : null, pronouns: clip(pr.pronouns, 40),
            accent: Number.isSafeInteger(pr.accent) ? pr.accent : null,
            interests: JSON.stringify(Array.isArray(pr.interests) ? pr.interests.filter((s) => typeof s === 'string').slice(0, 20).map((s) => s.slice(0, 40)) : []),
            links: JSON.stringify(Array.isArray(pr.links) ? pr.links.slice(0, 10) : []),
            presence: ['around', 'away', 'busy', 'offline', 'dnd', 'idle'].includes(pr.presence) ? pr.presence : 'around',
            decoration: pr.decoration == null ? null : clip(pr.decoration, 40), decoration_hue: Number.isSafeInteger(pr.decorationHue) ? pr.decorationHue : null,
            name_style: pr.nameStyle == null ? null : JSON.stringify(pr.nameStyle), profile_colors: pr.profileColors == null ? null : JSON.stringify(pr.profileColors),
          };
          const av = picFile(o, 'avatar', pr.avatar, created);
          const bn = picFile(o, 'banner', pr.banner, created);
          if (av !== undefined) { cols.avatar = av?.id ?? null; cols.avatar_anim = av?.anim ? 1 : null; }
          if (bn !== undefined) cols.banner = bn?.id ?? null;
          const keysOf = Object.keys(cols);
          db.run(`UPDATE users SET ${keysOf.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keysOf.map((k) => cols[k]), o);
        }
        if (p.prefs && Object.keys(p.prefs).length) {
          let clean = null;
          try { clean = cleanPrefs(p.prefs); } catch { clean = null; }
          if (clean) db.run('INSERT INTO user_prefs (user, prefs, updated) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET prefs = excluded.prefs, updated = excluded.updated', o, JSON.stringify(clean), t);
        }
        if (p.privacy && typeof p.privacy.dm === 'string' && typeof p.privacy.friends === 'string') {
          db.run('INSERT INTO privacy (user, dm, friends, requests) VALUES (?, ?, ?, ?) ON CONFLICT (user) DO UPDATE SET dm = excluded.dm, friends = excluded.friends, requests = excluded.requests',
            o, clip(p.privacy.dm, 20), clip(p.privacy.friends, 20), p.privacy.requests ? 1 : 0);
        }
        // One-to-one conversations with friends on other PCs.
        for (const c of p.dms) {
          if (c.peer === uid || !hasPeer(c.peer)) continue;
          const s = shadowId(c.peer);
          const dm = dmIdFor(uid, c.peer);
          if (!db.get('SELECT 1 FROM dms WHERE id = ?', dm)) {
            db.run('INSERT INTO dms (id, name, created) VALUES (?, NULL, ?)', dm, t);
            newDms.push(dm);
            counts.conversations++;
          }
          for (const u of [o, s]) db.run('INSERT OR IGNORE INTO dm_members (dm, user) VALUES (?, ?)', dm, u);
          const withTtl = Number.isSafeInteger(c.ttl); // 0.13 file: each message's exp is complete
          for (const m of c.msgs) {
            if (db.get('SELECT 1 FROM messages WHERE id = ?', m.id)) continue;
            if (Number.isSafeInteger(m.exp) && m.exp <= t) continue; // its time has passed: it stays gone
            const author = m.a === uid ? o : s;
            const files = [];
            for (const f of m.f || []) {
              let fid = f.id;
              if (m.a !== uid) {
                fid = remoteFileId(c.peer, f.id);
                const was = db.get('SELECT owner, conv FROM files WHERE id = ?', fid);
                if (was && (was.owner !== s || was.conv !== dm)) continue;
                if (!was && f.hash) {
                  db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    fid, s, dm, f.name.replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 120) || 'file', f.type, f.size, t,
                    JSON.stringify({ hash: f.hash, size: f.size, remote: 1, have: 0, rid: f.id, used: t, decl: f.type }));
                } else if (!was) continue;
              } else if (!db.get('SELECT 1 FROM files WHERE id = ? AND owner = ?', fid, o)) continue; // its bytes stayed on the other PC
              files.push({ kind: f.type.startsWith('image/') ? 'image' : 'file', id: fid, name: f.name, size: f.size });
            }
            const reply = m.r && db.get('SELECT 1 FROM messages WHERE id = ?', m.r) ? m.r : (m.r && c.msgs.some((x) => x.id === m.r) ? m.r : null);
            db.run('INSERT OR IGNORE INTO messages (id, conv, author, ts, text, fold, reply_to, files, edited, deleted, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              m.id, dm, author, m.ts, m.text, M.foldText(m.text, files), reply, files.length ? JSON.stringify(files) : null, m.e ?? null, m.d ?? null,
              Number.isSafeInteger(m.exp) ? m.exp : null);
            // A message the file says doesn't disappear doesn't get this PC's timer either.
            if (withTtl && !Number.isSafeInteger(m.exp)) db.run('UPDATE messages SET expires = NULL WHERE id = ?', m.id);
            counts.messages++;
            for (const x of m.x || []) db.run('INSERT OR IGNORE INTO reactions (msg, user, emoji, ts) VALUES (?, ?, ?, ?)', m.id, x.u === uid ? o : s, x.e, m.ts);
          }
          restoreTtl(dm, c.ttl, o, t);
        }
        // Other tracks' data (groups across PCs); a throw aborts everything.
        const ctx = { db, M, owner: o, myUid: uid, peer, selfKeys, restoreTtl };
        for (const s of hub.vaultSections || []) {
          if (p.sections && Object.hasOwn(p.sections, s.name)) s.import(p.sections[s.name], ctx);
        }
      });
    } catch (e) {
      for (const id of created) rm(join(filesDir, id));
      throw e;
    }
    return { counts, newFriends, newDms, newPins };
  }

  // sec-registry REG-L2: a key pinned from a data file (for someone this PC hadn't met) is only what the file
  // says. Checked with the registry as soon as it can be: a key that isn't in the person's key chain there is
  // replaced by the registry's (and the file's history rows for them go), so a forged file can't pin a fake
  // key or a kver-999 trap that refuses the real person's next key. Offline: checked at the next import or
  // when the shadow is next looked up.
  async function checkFilePins(uids) {
    for (const uid of uids.slice(0, 500)) {
      let r = null;
      try { r = await peer.reg.lookup({ uid }); } catch (e) { log('vault', 'pin check', e.code || e.message); return; }
      const pin = db.get('SELECT user, ik, xk, kver FROM peers WHERE uid = ?', uid);
      if (!pin) continue;
      const chain = Array.isArray(r?.chain) ? r.chain : [];
      const inChain = r && r.uid === uid && chain.some((k) => k.kver === pin.kver && k.ik === pin.ik && k.xk === pin.xk);
      if (inChain) continue;
      db.tx(() => {
        if (r && r.uid === uid && typeof r.ik === 'string' && typeof r.xk === 'string' && Number.isSafeInteger(r.kver)) {
          db.run('UPDATE peers SET ik = ?, xk = ?, kver = ?, pinned_at = ? WHERE uid = ?', r.ik, r.xk, r.kver, Date.now(), uid);
          const keep = new Set(chain.map((k) => `${k.kver}|${k.ik}`));
          for (const k of db.all('SELECT kver, ik FROM peer_keys WHERE uid = ?', uid)) {
            if (!keep.has(`${k.kver}|${k.ik}`)) db.run('DELETE FROM peer_keys WHERE uid = ? AND kver = ? AND ik = ?', uid, k.kver, k.ik);
          }
          for (const k of chain) db.run('INSERT OR IGNORE INTO peer_keys (uid, kver, ik, xk, at) VALUES (?, ?, ?, ?, ?)', uid, k.kver, k.ik, k.xk, Date.now());
        } else {
          // Not on Snug (any more): no pin at all; a later contact looks them up afresh.
          db.run('DELETE FROM peer_keys WHERE uid = ?', uid);
          db.run('DELETE FROM peers WHERE uid = ?', uid);
        }
      });
      log('vault', 'pin from a data file replaced by the registry’s', uid);
      suspicious({ what: 'a data file held a key the directory doesn’t know for someone (replaced)', user: owner() }, db);
    }
  }

  // Verify (all of it) then apply. Throws VaultError with a code; nothing is applied unless it returns.
  async function importBuffer(buf) {
    if (!usable()) throw new VaultError('no_key', 'signed out');
    if (!Buffer.isBuffer(buf) || buf.length > MAX_FILE) throw new VaultError('too_big');
    const parsed = readHeader(buf, myUid());
    const key = await keyForKid(parsed.header.kid);
    const p = decrypt(buf, parsed, key.key);
    // sec-registry REG-L2: my own key chain, so my own signed things in the file are checked too.
    let selfKeys = null;
    try {
      const r = await peer.reg.lookup({ uid: myUid() });
      if (r?.uid === myUid() && Array.isArray(r.chain)) selfKeys = [...new Set([peer.identity.me()?.ik, ...r.chain.map((k) => k.ik)].filter(Boolean))];
    } catch (e) { log('vault', 'own key chain', e.code || e.message); }
    const { counts, newFriends, newDms, newPins } = applyPayload(p, selfKeys);
    if (newPins.length) checkFilePins(newPins).catch((e) => log('vault', 'pin check', e.message));
    const o = owner();
    // After the commit: show it here, tell friends the profile, watch the people now known. Never knocks or messages.
    const row = M.userRow(o);
    if (row?.avatar) hub.dropAvatarFiles?.(o, row.avatar);
    for (const r of db.all('SELECT id FROM files WHERE conv = ? AND id IS NOT ?', `banner:${o}`, row?.banner ?? null)) {
      db.run('DELETE FROM files WHERE id = ?', r.id);
      rm(join(filesDir, r.id));
    }
    for (const s of newFriends) hub.sendFriend?.(o, s);
    for (const dm of newDms) hub.sendDm(o, dm);
    hub.userChanged(o);
    try { peer._pushProfile?.(); } catch { /* not signed in on the network yet */ }
    peer.friendsChanged?.();
    meta.set(`imp:${sha256hex(buf)}`, Date.now());
    markDirty();
    await write();
    pushStatus();
    return counts;
  }

  // ---------- Backups ----------
  const BACKUP = (uid) => new RegExp(`^${uid}-(\\d{8}-\\d{4})(?:-(\\d+))?\\.snugvault$`);
  function backups(uid = myUid()) {
    let names = [];
    try { names = readdirSync(bdir); } catch { return []; }
    const re = BACKUP(uid);
    return names.map((n) => { const m = re.exec(n); return m && { name: n, key: `${m[1]}-${pad(Number(m[2] || 1), 4)}` }; })
      .filter(Boolean).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }
  async function backupNow({ send = true } = {}) {
    const uid = myUid();
    if (!usable()) fail('Sign in with GitHub first.');
    await write();
    if (!existsSync(liveFile())) fail(MESSAGES.no_key);
    ensureDir(bdir);
    const base = `${uid}-${stamp()}`;
    let name = `${base}.snugvault`;
    for (let i = 2; existsSync(join(bdir, name)); i++) name = `${base}-${i}.snugvault`;
    copyFileSync(liveFile(), join(bdir, name));
    for (const b of backups(uid).slice(KEEP_BACKUPS)) rm(join(bdir, b.name));
    meta.set('last_backup', Date.now());
    pushStatus();
    if (send) sendToOther({ quiet: true }).catch(() => {});
    return name;
  }
  async function tick() {
    if (closed || !usable()) return;
    markDirty(); // anything changed outside an op is picked up within the hour
    const days = meta.num('backup_days');
    if (days > 0 && Date.now() - meta.num('last_backup') >= days * DAY) {
      try { await backupNow(); } catch (e) { log('vault', 'backup', e.message); }
    }
  }
  const hourly = setInterval(() => { tick(); }, 3600_000);
  hourly.unref?.();
  const first = setTimeout(() => { tick(); }, Math.min(10_000, debounceMs));
  first.unref?.();

  // ---------- PC to PC (design 3.3, 3.4) ----------
  let lastXfer = null;
  let x = null, xUid = null;
  const getFile = () => {
    try {
      const buf = readFileSync(liveFile());
      const { header } = readHeader(buf, myUid());
      return { buf, sha: sha256hex(buf), kid: header.kid, created: header.created };
    } catch { return null; }
  };
  function engine() {
    const uid = myUid();
    const me = peer.identity?.me?.();
    if (!uid || !me?.xkPriv) return null;
    if (x && xUid === uid) return x;
    x?.stop();
    xUid = uid;
    x = createXfer({
      uid, me: { ik: me.ik, xkPriv: me.xkPriv }, dir: join(vdir, 'incoming'), log,
      transport: { send: (to, box) => sock.send(to, box) },
      getFile,
      hasImported: (sha) => !!meta.get(`imp:${sha}`),
      wasSent: (sha, ik) => !!meta.get(`sent:${sha}:${ik}`),
      markSent: (sha, ik) => meta.set(`sent:${sha}:${ik}`, Date.now()),
      mayReceive,
      accept: async (buf, sha, from) => {
        const no = mayReceive(from);
        if (no) return { ok: false, why: no };
        try {
          const counts = await importBuffer(buf);
          if (meta.num('wait_until')) {
            meta.set('wait_until', null);
            meta.set('wait_done', 1);
            unwant('wait');
            toOwner('vault.xfer', { state: 'imported', counts });
          }
          return { ok: true };
        } catch (e) {
          log('vault', 'received file refused', e.code || e.message);
          return { ok: false, why: e.code || 'failed' };
        }
      },
      onProgress: (p) => { lastXfer = { ...p, at: Date.now() }; toOwner('vault.xfer', p); },
    });
    x.purge();
    return x;
  }
  const sock = createXferSocket({
    reg: peer.reg, identity: peer.identity, version: APP_VERSION, log,
    onBox: (ik, xk, box) => { engine()?.receive(ik, xk, box); },
    onChange: (what, code) => {
      if (what === 'closed' && (code === 4001 || code === 4003)) {
        // This key may not use xfer (too old, or the account moved on): stop trying for now.
        for (const k of [...wants.keys()]) if (k !== 'wait') unwant(k);
      }
      // The other PC (re)appeared: try now rather than at the backoff.
      if (what === 'peer' || what === 'ready') for (const w of wants.values()) { clearTimeout(w.retryT); w.retryT = null; }
      tryOffers();
      pushStatus();
    },
  });
  // Why the xfer socket is open: reason -> { until, target: ik | 'cur' | 'any' | null (receiver), waiters }
  const wants = new Map();
  // Who may give this PC a data file over xfer (sec-registry REG-H1). Only one case: this PC is the account's
  // current key, waits for its data after a move, and the sender is the key from before the move. Never a
  // pending move's key (it proved GitHub only: a takeover attempt the 72 h delay and Stop exist for), never
  // the current key while this PC is the pending one (it can't open the file yet), and the old key only once
  // (security review 0.10 #2). An import only merges, so a forged file could not be undone by Stop.
  function mayReceive(from) {
    const r = roleOf(from);
    if (r === 'old') return wants.has('wait') ? null : 'not_waiting';
    if (r === 'cur') return 'not_yet';
    // A pending move's key offering this (current) PC a file: what a takeover attempt looks like.
    if (r === 'pending') suspicious({ what: 'an unapproved new device offered this PC a data file (refused)', user: owner() }, db);
    return 'not_allowed';
  }
  // The role a key of this account has now: what the registry last said (xfer-peer), else from the key chain.
  function roleOf(ik) {
    const p = sock.peers().find((x) => x.ik === ik);
    if (p?.role) return p.role;
    const k = sock.keys;
    if (!k) return null;
    if (k.pending?.ik === ik) return 'pending';
    const chain = k.chain || [];
    if (chain.at(-1)?.ik === ik) return 'cur';
    return chain.some((c) => c.ik === ik) ? 'old' : null;
  }
  function want(reason, ms, target = null) {
    const w = wants.get(reason) || { waiters: [] };
    if (closed) return w;
    w.until = Date.now() + ms;
    w.target = target;
    clearTimeout(w.timer);
    const arm = (t) => {
      w.timer = setTimeout(() => {
        // A transfer under way finishes first (it has its own 30 s ack timeout).
        if (wants.get(reason) === w && w.busy) arm(5000); else unwant(reason, 'timeout');
      }, Math.min(t, 2 ** 31 - 1));
      w.timer.unref?.();
    };
    arm(ms);
    wants.set(reason, w);
    if (!engine()) return w;
    clearTimeout(closeT);
    sock.open();
    tryOffers();
    return w;
  }
  function unwant(reason, result = 'stopped') {
    const w = wants.get(reason);
    if (!w) return;
    clearTimeout(w.timer);
    clearTimeout(w.retryT);
    wants.delete(reason);
    for (const fn of w.waiters) fn(result);
    closeSoon();
    pushStatus();
  }
  // Closed a moment after the last reason goes, so the last reply (done, bad) still gets out.
  let closeT = null;
  function closeSoon() {
    clearTimeout(closeT);
    closeT = setTimeout(() => {
      closeT = null;
      if (wants.size) return;
      if (x?.sending() || x?.receiving()) { closeSoon(); return; }
      sock.close();
    }, 3000);
    closeT.unref?.();
  }
  function tryOffers() {
    if (!sock.connected) return;
    const peers = sock.peers();
    for (const [reason, w] of wants) {
      if (!w.target || w.busy || w.retryT) continue;
      // Never to the key from before a move (maybe a lost or stolen PC): security review 0.10 #2.
      const pick = w.target === 'any' ? peers.find((p) => p.role === 'cur' || p.role === 'pending')
        : w.target === 'cur' ? peers.find((p) => p.role === 'cur') : peers.find((p) => p.ik === w.target && p.role !== 'old');
      if (!pick) continue;
      w.busy = true;
      (async () => {
        await write();
        const res = await engine().send(pick);
        w.busy = false;
        if (res === 'failed') { retryLater(reason, w); return; }
        if (res === 'refused') w.why = lastXfer?.error || 'refused';
        w.result = res;
        unwant(reason, res);
      })().catch((e) => { w.busy = false; log('vault', 'xfer', e.message); retryLater(reason, w); });
    }
  }
  // A failed send is tried again while the reason lasts: 30 s, 2 min, then every 10 min (review 0.10 #2).
  // A new xfer-peer "on" still tries at once.
  const RETRY_MS = (process.env.SNUG_VAULT_RETRY_MS || '30000,120000,600000').split(',').map(Number);
  function retryLater(reason, w) {
    if (closed || wants.get(reason) !== w) return;
    w.fails = (w.fails || 0) + 1;
    clearTimeout(w.retryT);
    w.retryT = setTimeout(() => { w.retryT = null; if (wants.get(reason) === w) tryOffers(); }, RETRY_MS[Math.min(w.fails, RETRY_MS.length) - 1]);
    w.retryT.unref?.();
  }
  // "Send to my other device" and the backup's send step: 15 s to find the other PC.
  function sendToOther({ quiet = false } = {}) {
    if (!engine()) return quiet ? Promise.resolve(false) : Promise.reject(new UserError('Sign in with GitHub first.'));
    return new Promise((resolve, reject) => {
      const w = want(quiet ? 'backup' : 'manual', 15_000, 'any');
      w.waiters.push((res) => {
        if (res === 'done' || res === 'have' || res === 'skipped') resolve({ sent: true, result: res });
        else if (quiet) resolve(false);
        else if (res === 'refused' && w.why === 'not_yet') reject(new UserError('Your new PC gets your data once the move is done. Approve the move on this PC first.'));
        else if (res === 'refused') reject(new UserError('Your other PC didn’t take the file. It only takes one from the PC you moved away from, while it waits for it.'));
        else reject(new UserError('Your other PC isn’t connected. Open Snug there and sign in with GitHub; it waits for your data.'));
      });
    });
  }
  // The new PC waits up to 30 days for the old one; the old one sends when told about the move.
  function maybeWait() {
    const s = self();
    if (!s || meta.num('wait_done')) return;
    let until = meta.num('wait_until');
    if (!until && s.state === 'moving') { until = Date.now() + 30 * DAY; meta.set('wait_until', until); }
    if (until > Date.now() && !wants.has('wait')) want('wait', until - Date.now(), null);
    if (until && until <= Date.now()) meta.set('wait_until', null);
  }
  if (peer._signal) {
    peer._signal.on('ready', (m) => {
      if (m.mode === 'xfer') return;
      maybeWait();
      if (dirty || !existsSync(liveFile())) write().catch(() => {});
      pushStatus();
    });
    // sec-registry REG-H1: a pending move sends nothing. Its key proved GitHub only (maybe a phished sign-in);
    // the file goes once the move is done: approved here, or after 72 h ('revoked' below), to the new current key.
    peer._signal.on('rebind', (m) => {
      if (m.state !== 'pending' || typeof m.ik !== 'string') return;
      flush();
    });
    peer._signal.on('revoked', () => { flush(); want('old', DAY, 'cur'); });
  }
  // sec-registry REG-L1: Stop on a move (someone else signed in with this GitHub account): the vault key
  // gets a new kid, so a copy taken earlier can't open files written from now on.
  if (typeof peer.cancelRebind === 'function') {
    const cancel = peer.cancelRebind;
    peer.cancelRebind = async (...a) => {
      const r = await cancel(...a);
      if (usable()) rotateKey().catch((e) => log('vault', 'rotate after stop', e.code || e.message));
      return r;
    };
  }
  // sec-registry REG-H1: the new PC only takes a file while it waits, so the wait starts the moment this PC
  // becomes 'moving' (GitHub sign-in), not at the next 'ready': a move approved within seconds would
  // otherwise complete before this PC ever waited.
  if (peer.identity?.setSelf) {
    const setSelf = peer.identity.setSelf;
    peer.identity.setSelf = (...a) => { const r = setSelf(...a); if (self()?.state === 'moving' && !closed) queueMicrotask(maybeWait); return r; };
  }
  // Started after a move happened while this PC was off: deliver once in this run.
  queueMicrotask(() => {
    const s = self();
    if (!s) return;
    if (s.state === 'revoked') want('old', DAY, 'cur');
    else maybeWait();
  });

  // ---------- Status, ops, snapshot ----------
  function status() {
    if (!usable()) return { enabled: true, file: null };
    let file = null;
    try { const st = statSync(liveFile()); file = { at: meta.num('last_write') || Math.round(st.mtimeMs), size: st.size, seq: meta.num('last_seq') }; } catch { /* none yet */ }
    const wait = meta.num('wait_until');
    const enc = cacheEnc();
    return {
      enabled: true, file, protected: enc == null ? null : enc === 'safeStorage',
      backupDays: meta.num('backup_days'), lastBackup: meta.num('last_backup') || null, backups: backups().length,
      waiting: wait > Date.now() ? wait : null,
      other: { connected: sock.peers().length > 0 },
      xfer: lastXfer,
      error: lastError ? { code: lastError, text: MESSAGES[lastError] || 'Snug couldn’t save your data file. It tries again at the next change.' } : null,
    };
  }
  let statusT = null;
  function pushStatus() {
    if (statusT || closed) return;
    statusT = setTimeout(() => { statusT = null; if (!closed) toOwner('vault', status()); }, 50);
    statusT.unref?.();
  }
  const ownerOnly = (c) => { if (!c?.user || c.user !== owner() || c.peer) fail('Only this PC’s Snug account can do that.'); };
  hub.ops['vault.status'] = (c) => { ownerOnly(c); return status(); };
  hub.ops['vault.send'] = async (c) => { ownerOnly(c); return sendToOther(); };
  hub.ops['vault.setBackup'] = (c, d) => {
    ownerOnly(c);
    if (![0, 1, 3, 7].includes(d?.days)) fail('Pick how often to back up.');
    meta.set('backup_days', d.days);
    if (d.days) setTimeout(() => { tick(); }, 1000).unref?.();
    pushStatus();
    return status();
  };
  hub.ops['vault.rotateKey'] = async (c) => {
    ownerOnly(c);
    try { await rotateKey(); } catch (e) { if (e instanceof UserError) throw e; fail('Snug couldn’t reach its directory. Try again when you’re online.'); }
    return status();
  };
  hub.ops['vault.backupNow'] = async (c) => { ownerOnly(c); const name = await backupNow(); return { ...status(), name }; };
  hub.ops['vault.stopWaiting'] = (c) => {
    ownerOnly(c);
    meta.set('wait_until', null);
    meta.set('wait_done', 1);
    unwant('wait');
    return status();
  };
  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => { const s = baseSnap(u); if (u && u === owner()) s.vault = status(); return s; };

  // ---------- HTTP: GET /api/vault/file, POST /api/vault/import (owner only) ----------
  const { sendJson, error, body, headers } = http;
  async function handle(req, res, path, url, user) {
    if (!path.startsWith('/api/vault/')) return false;
    if (!user || user !== owner() || M.userRow(user)?.remote) { error(res, 404, 'Not found'); return true; }
    if (req.method === 'GET' && path === '/api/vault/file') {
      await write();
      if (!existsSync(liveFile())) { error(res, 409, lastError && MESSAGES[lastError] ? MESSAGES[lastError] : 'Your data file isn’t ready yet. Try again in a moment.'); return true; }
      const buf = readFileSync(liveFile());
      headers(res, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${downloadName()}"`, 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) });
      res.writeHead(200);
      res.end(buf);
      return true;
    }
    if (req.method === 'POST' && path === '/api/vault/import') {
      if (!String(req.headers['content-type'] || '').startsWith('application/octet-stream')) { error(res, 415, 'Send the data file as it is.'); return true; }
      if (Number(req.headers['content-length']) > MAX_FILE) { sendJson(res, 413, { error: MESSAGES.too_big, code: 'too_big' }); return true; }
      let data;
      try { data = await body(req, MAX_FILE); } catch (e) {
        if (e.status === 413) { sendJson(res, 413, { error: MESSAGES.too_big, code: 'too_big' }); return true; }
        throw e;
      }
      try {
        const counts = await importBuffer(data);
        sendJson(res, 200, { ok: true, counts });
      } catch (e) {
        if (e instanceof VaultError) { sendJson(res, 422, { error: e.message, code: e.code }); return true; }
        if (e instanceof UserError) { sendJson(res, 422, { error: e.message, code: 'refused' }); return true; }
        log('vault', 'import failed', e.message);
        sendJson(res, 422, { error: 'Snug couldn’t bring in that data file. Nothing was changed.', code: 'failed' });
      }
      return true;
    }
    error(res, 404, 'Not found');
    return true;
  }

  // Deleting the Snug account on this PC takes its data file, cached key, backups and half-received
  // files with it (review 0.10 #5). Signing in again later fetches the key and starts a new file.
  function forget(uid) {
    if (!uid || !isUid(uid)) return;
    clearTimeout(timer); timer = null; dirty = false;
    for (const k of [...wants.keys()]) unwant(k);
    x?.stop(); x = null; xUid = null;
    mem = null;
    rm(liveFile(uid)); rm(keyFile(uid));
    for (const b of backups(uid)) rm(join(bdir, b.name));
    const inc = join(vdir, 'incoming');
    try { for (const n of readdirSync(inc)) rm(join(inc, n)); } catch { /* none */ }
    for (const k of ['last_write', 'last_seq', 'last_backup', 'wait_until', 'wait_done']) meta.set(k, null);
    db.run("DELETE FROM vault_meta WHERE k LIKE 'imp:%' OR k LIKE 'sent:%'");
    lastXfer = null; lastError = null;
  }
  const baseDelete = M.p2pDelete;
  if (baseDelete) {
    M.p2pDelete = async (u, d, run) => {
      const uid = myUid();
      // 0.13: erasing asks friends' PCs that are online to delete their copies first, while they still
      // take frames from this account (server/peer.js eraseShared). Offline PCs keep theirs.
      if (d?.erase === true) await peer.eraseShared?.().catch((e) => log('peer', 'erase', e.message));
      const r = await baseDelete(u, d, run);
      forget(uid);
      return r;
    };
  }

  return {
    enabled: true, status, flush, importBuffer, write, backupNow, http: handle, backups, forget,
    sendToOther,
    busy: () => !!(x?.sending() || x?.receiving()), // a PC-to-PC transfer is running (the desktop app won't restart for an update)
    close() {
      closed = true;
      clearTimeout(timer); clearTimeout(statusT); clearInterval(hourly); clearTimeout(first); clearTimeout(closeT);
      for (const k of [...wants.keys()]) { clearTimeout(wants.get(k).timer); }
      wants.clear();
      x?.stop();
      sock.close();
    },
    // Tests: the internals that are safe to reach.
    _meta: meta, _tick: tick, _sock: sock, _dirty: () => dirty, _paths: { vdir, bdir, liveFile, keyFile },
  };
}
