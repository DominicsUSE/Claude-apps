// Notifications when Snug is closed: Web Push.
//
// The browser gives each device a push address (an endpoint on its maker's
// push service) and two keys. When a message needs someone who has no Snug
// open anywhere, the server encrypts a short note to those keys (RFC 8291,
// aes128gcm) and posts it to the endpoint, signed with this server's own
// VAPID key (RFC 8292). Only node:crypto; no push library.
//
// Who gets one: the same rules as the in-app badge (js/lib/attention.js,
// needsMe), applied on the server with each person's own settings: muted
// places send nothing, Focused sends nothing, and nothing is sent while any
// of the person's sockets is open (the open app notifies by itself then).
import {
  createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign,
  createCipheriv,
} from 'node:crypto';
import { limiter, readCookie, tokenHash, COOKIE } from './auth.js';
import { mentions, plain } from '../js/lib/format.js';

const MAX_SUBS = 10;            // devices per person; the oldest goes first
const TTL = 24 * 3600;          // a note older than a day is not worth showing
const PREVIEW = 180;            // characters of the message in the note
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// ---------- Schema (additive, guarded) ----------
function migrate(db) {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS push_vapid (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public TEXT NOT NULL,
      private TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created INTEGER NOT NULL,
      session TEXT
    );
    CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user, created);`);
  // Each device is tied to the sign-in that turned it on (sessions.hash), so
  // signing out, signing out everywhere, a new password or an expired session
  // all stop its notifications.
  if (!db.all('PRAGMA table_info(push_subs)').some((c) => c.name === 'session')) db.raw.exec('ALTER TABLE push_subs ADD COLUMN session TEXT');
}

// One VAPID key pair per data folder, made on first use and kept in the database.
function vapidKeys(db) {
  let row = db.get('SELECT * FROM push_vapid WHERE id = 1');
  if (!row) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
    db.run('INSERT OR IGNORE INTO push_vapid (id, public, private, created) VALUES (1, ?, ?, ?)', b64u(pub), JSON.stringify(jwk), Date.now());
    row = db.get('SELECT * FROM push_vapid WHERE id = 1');
  }
  return { publicKey: row.public, privateKey: createPrivateKey({ key: JSON.parse(row.private), format: 'jwk' }) };
}

// ---------- RFC 8292: the VAPID token ----------
export function vapidToken(endpoint, privateKey, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

// ---------- RFC 8291: encrypting the note ----------
// One record: salt(16) | rs(4) | idlen(1) | sender public key(65) | ciphertext+tag.
export function encrypt(payload, p256dh, authSecret) {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || auth.length !== 16) throw new Error('bad subscription keys');
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([65]), asPublic, body]);
}

// Push addresses must be https, on port 443, on one of the browsers' own push
// services (Chrome and most others, Firefox, Safari, Edge). Nothing else, so a
// subscription can never make this server post to a host of someone's choosing.
// A test may also allow plain http to this machine (a mock push service).
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com$/,
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/,
];
export function checkEndpoint(raw, allowLocal) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (String(raw).length > 1024 || u.username || u.password || u.hash) return null;
  if (allowLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.href;
  if (u.protocol !== 'https:' || u.port !== '') return null;
  if (!PUSH_HOSTS.some((re) => re.test(u.hostname))) return null;
  return u.href;
}

export function createPush({ db, M, hub, origins, log = () => {}, allowLocal = false, subject, fetchImpl = fetch }) {
  migrate(db);
  const keys = vapidKeys(db);
  const contact = subject || process.env.SNUG_PUSH_CONTACT || 'mailto:snug@example.invalid';
  // Per person: five at once, then one every 20 seconds. Notes in one
  // conversation also replace each other on the device (same tag).
  const rate = limiter({ capacity: 5, perSecond: 0.05 });
  const subsLimit = limiter({ capacity: 10, perSecond: 0.2 });
  const stats = { sent: 0, gone: 0, failed: 0 };

  const levelFor = (user, w) => {
    if (w.dm) return M.notifyOf(user, w.dm) || 'all';
    const room = w.type === 'thread' ? w.parent : w.id;
    return M.notifyOf(user, room) || M.notifyOf(user, w.house) || 'all';
  };

  // The server's copy of needsMe (js/lib/attention.js), plus the notification
  // level and Focused rules the client applies before notifying.
  function needs(user, conv, w, row) {
    if (row.author === user) return false;
    const u = M.userRow(user);
    if (!u || u.presence === 'focus') return false;
    const level = levelFor(user, w);
    if (level === 'muted') return false;
    const forMe = mentions(row.text, u.handle)
      || (!!row.reply_to && db.get('SELECT author FROM messages WHERE id = ?', row.reply_to)?.author === user);
    if (w.type === 'dm') {
      const group = db.get('SELECT COUNT(*) n FROM dm_members WHERE dm = ?', w.dm).n > 2;
      if (!(group && level === 'mentions')) return true;
    }
    if (forMe) return true;
    return w.type === 'thread' && !!db.get('SELECT 1 FROM follows WHERE user = ? AND thread = ?', user, conv);
  }

  function noteFor(user, conv, w, row) {
    const who = M.userRow(row.author)?.name || 'Someone';
    let where = '';
    const roomName = (id) => M.room(id)?.name || 'a room';
    const dmTitle = (id) => {
      const d = db.get('SELECT name FROM dms WHERE id = ?', id);
      if (d?.name) return d.name;
      return db.all('SELECT u.name FROM dm_members m JOIN users u ON u.id = m.user WHERE m.dm = ? AND m.user != ? ORDER BY m.rowid', id, user).map((r) => r.name).join(', ');
    };
    const isGroup = (id) => db.get('SELECT COUNT(*) n FROM dm_members WHERE dm = ?', id).n > 2;
    if (w.type === 'room') where = `in ${roomName(w.id)}`;
    else if (w.type === 'thread') where = `in a thread in ${w.dm ? dmTitle(w.dm) : roomName(w.parent)}`;
    else if (isGroup(w.dm)) where = `in ${dmTitle(w.dm)}`;
    const text = plain(row.text) || 'Sent an attachment';
    return {
      title: where ? `${who} ${where}` : who,
      body: text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1)}…` : text,
      conv, msg: row.id, tag: `snug:${conv}`,
    };
  }

  async function deliver(sub, payload) {
    let res;
    try {
      res = await fetchImpl(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(TTL), Urgency: 'high',
          Authorization: `vapid t=${vapidToken(sub.endpoint, keys.privateKey, contact)}, k=${keys.publicKey}`,
        },
        body: encrypt(JSON.stringify(payload), sub.p256dh, sub.auth),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch (e) { stats.failed++; log('push failed', e.message); return; }
    // The answer's body is never needed: drop it unread rather than buffer it.
    res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) {
      // The browser dropped this subscription: forget it.
      db.run('DELETE FROM push_subs WHERE endpoint = ?', sub.endpoint);
      stats.gone++;
    } else if (res.ok) stats.sent++;
    else { stats.failed++; log('push refused', res.status); }
  }

  // Called after a new message is stored and delivered live.
  function onMessage(conv, msgId) {
    const row = M.liveMsg(msgId);
    const w = row && M.where(conv);
    if (!w) return Promise.resolve();
    // One query for the devices of everyone who could see it; most people
    // have none, so the per-person checks run only for those who do.
    const byUser = new Map();
    for (const s of db.all(`SELECT p.* FROM push_subs p JOIN sessions s ON s.hash = p.session AND s.expires > ?
      WHERE p.user IN (SELECT value FROM json_each(?))`, Date.now(), JSON.stringify([...new Set(M.audience(conv))]))) {
      if (!byUser.has(s.user)) byUser.set(s.user, []);
      byUser.get(s.user).push(s);
    }
    const jobs = [];
    for (const [user, subs] of byUser) {
      if (user === row.author || hub.connected(user)) continue;
      if (!needs(user, conv, w, row)) continue;
      if (!rate.take(user)) continue;
      const note = noteFor(user, conv, w, row);
      for (const s of subs) jobs.push(deliver(s, note));
    }
    return Promise.all(jobs);
  }

  // Forget devices whose sign-in has ended (signed out, signed out
  // everywhere, a new password, or expired).
  function prune() {
    db.run('DELETE FROM push_subs WHERE session IS NULL OR session NOT IN (SELECT hash FROM sessions WHERE expires > ?)', Date.now());
  }

  // HTTP: GET /api/push/key, POST /api/push/subscribe, POST /api/push/unsubscribe.
  // Returns true when it answered.
  async function http(req, res, path, user, { sendJson, error, jsonBody }) {
    if (!path.startsWith('/api/push/')) return false;
    if (req.method === 'GET' && path === '/api/push/key') { sendJson(res, 200, { key: keys.publicKey }); return true; }
    if (req.method !== 'POST' || !['/api/push/subscribe', '/api/push/unsubscribe'].includes(path)) return false;
    // Only Snug's own page may change where your notifications go.
    if (!req.headers.origin || !origins(req).includes(req.headers.origin)) { error(res, 403, 'Cross-site request refused.'); return true; }
    if (!subsLimit.take(user)) { error(res, 429, 'Too many changes at once. Wait a moment.'); return true; }
    const d = await jsonBody(req);
    const endpoint = checkEndpoint(d?.endpoint, allowLocal);
    if (path === '/api/push/unsubscribe') {
      if (endpoint) db.run('DELETE FROM push_subs WHERE endpoint = ? AND user = ?', endpoint, user);
      sendJson(res, 200, {});
      return true;
    }
    if (!endpoint) { error(res, 400, 'That push address isn’t one Snug can use.'); return true; }
    const p256dh = typeof d.keys?.p256dh === 'string' ? d.keys.p256dh : '';
    const auth = typeof d.keys?.auth === 'string' ? d.keys.auth : '';
    const pk = unb64u(p256dh);
    if (pk.length !== 65 || pk[0] !== 4 || unb64u(auth).length !== 16) { error(res, 400, 'Those push keys aren’t valid.'); return true; }
    try { createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pk.subarray(1, 33)), y: b64u(pk.subarray(33)) }, format: 'jwk' }); } catch {
      error(res, 400, 'Those push keys aren’t valid.'); return true;
    }
    const token = readCookie(req.headers.cookie, COOKIE);
    const session = token ? tokenHash(token) : null;
    const keyP = b64u(pk), keyA = b64u(unb64u(auth));
    const taken = db.tx(() => {
      // The same device signing in as someone else moves to them: it still has
      // the same keys. Someone who only knows the address does not have the
      // auth secret, so they cannot take another person's device.
      const old = db.get('SELECT user, p256dh, auth FROM push_subs WHERE endpoint = ?', endpoint);
      if (old && old.user !== user && (old.p256dh !== keyP || old.auth !== keyA)) return true;
      db.run(`INSERT INTO push_subs (endpoint, user, p256dh, auth, created, session) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (endpoint) DO UPDATE SET user = excluded.user, p256dh = excluded.p256dh, auth = excluded.auth,
          created = excluded.created, session = excluded.session`,
      endpoint, user, keyP, keyA, Date.now(), session);
      const extra = db.all('SELECT endpoint FROM push_subs WHERE user = ? ORDER BY created DESC, rowid DESC LIMIT -1 OFFSET ?', user, MAX_SUBS);
      for (const r of extra) db.run('DELETE FROM push_subs WHERE endpoint = ?', r.endpoint);
      return false;
    });
    if (taken) { error(res, 409, 'That push address belongs to another device.'); return true; }
    sendJson(res, 201, { ok: true });
    return true;
  }

  return { http, onMessage, prune, publicKey: keys.publicKey, stats, reset: () => { rate.reset(); subsLimit.reset(); } };
}
