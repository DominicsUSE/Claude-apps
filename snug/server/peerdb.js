// Local tables for the peer-to-peer side (design section 4). Additive and safe
// to run on every start. Also the small helpers the rest of the peer code
// shares: peer_self as a key/value map, the peers rows and the outbox.
import { randomEp } from './peercrypto.js';

export function migratePeer(wrapped) {
  const db = wrapped.raw || wrapped;
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'remote')) {
    db.exec('ALTER TABLE users ADD COLUMN remote INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_self (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peers (
      user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      uid TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      ik TEXT NOT NULL, xk TEXT NOT NULL, kver INTEGER NOT NULL,
      pinned_at INTEGER NOT NULL,
      key_changed_at INTEGER,
      hold_before INTEGER,
      profile_kver INTEGER NOT NULL DEFAULT 0, profile_ver INTEGER NOT NULL DEFAULT 0, profile_sig TEXT,
      out_ep TEXT NOT NULL,
      out_seq INTEGER NOT NULL DEFAULT 0,
      in_ep TEXT NOT NULL DEFAULT '',
      in_seq INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      media TEXT
    );
    CREATE TABLE IF NOT EXISTS peer_keys (
      uid TEXT NOT NULL, kver INTEGER NOT NULL, ik TEXT NOT NULL, xk TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (uid, kver)
    );
    CREATE TABLE IF NOT EXISTS peer_outbox (
      peer TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, body TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY (peer, seq)
    );
    CREATE TABLE IF NOT EXISTS peer_knocks (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS peer_seen (id TEXT PRIMARY KEY, exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_hash (hash TEXT PRIMARY KEY, file TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE);
  `);
  // 'media' was not in the first cut of the table: the avatar and banner a friend's newest profile names.
  if (!db.prepare('PRAGMA table_info(peers)').all().some((c) => c.name === 'media')) db.exec('ALTER TABLE peers ADD COLUMN media TEXT');
}

// peer_self as a map of strings.
export function selfStore(db) {
  return {
    get: (k) => db.get('SELECT v FROM peer_self WHERE k = ?', k)?.v ?? null,
    set: (k, v) => (v == null ? db.run('DELETE FROM peer_self WHERE k = ?', k)
      : db.run('INSERT INTO peer_self (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, String(v))),
    all: () => Object.fromEntries(db.all('SELECT k, v FROM peer_self').map((r) => [r.k, r.v])),
    clear: () => db.run('DELETE FROM peer_self'),
  };
}

export const OUTBOX_MAX = 5000;
export const OUTBOX_DAYS = 30;
export const HELD = 1_000_000_000;

// The durable, ordered per-peer outbox (section 5.4, 5.4.1, 5.5).
export function createOutbox(db) {
  const O = {};
  O.peer = (user) => db.get('SELECT * FROM peers WHERE user = ?', user);
  O.count = (user) => db.get('SELECT COUNT(*) n FROM peer_outbox WHERE peer = ?', user).n;
  O.full = (user) => O.count(user) >= OUTBOX_MAX;
  // Append a row; returns its seq.
  O.push = (user, kind, ref, body, at = Date.now()) => db.tx(() => {
    const p = O.peer(user);
    if (!p) throw new Error('no such peer');
    const seq = p.out_seq + 1;
    if (seq >= HELD) throw new Error('outbox sequence exhausted');
    db.run('UPDATE peers SET out_seq = ? WHERE user = ?', seq, user);
    db.run('INSERT INTO peer_outbox (peer, seq, kind, ref, body, created) VALUES (?, ?, ?, ?, ?, ?)', user, seq, kind, ref ?? null, body, at);
    return seq;
  });
  // A profile row not yet sent in this link session is replaced in place (F2); otherwise appended.
  O.pushProfile = (user, body, sentUpTo = 0) => {
    const row = db.get(`SELECT seq FROM peer_outbox WHERE peer = ? AND kind = 'profile' AND seq > ? AND seq < ${HELD} ORDER BY seq DESC LIMIT 1`, user, sentUpTo);
    if (row) { db.run('UPDATE peer_outbox SET body = ?, created = ? WHERE peer = ? AND seq = ?', body, Date.now(), user, row.seq); return row.seq; }
    return O.push(user, 'profile', null, body);
  };
  // Live rows only: rows held after a loud key change are kept aside (kind 'held:<kind>', seq above HELD).
  O.after = (user, seq, limit = 64) => db.all(`SELECT * FROM peer_outbox WHERE peer = ? AND seq > ? AND seq < ${HELD} ORDER BY seq LIMIT ?`, user, seq, limit);
  O.minSeq = (user) => db.get(`SELECT MIN(seq) s FROM peer_outbox WHERE peer = ? AND seq < ${HELD}`, user).s;
  O.held = (user) => db.all(`SELECT * FROM peer_outbox WHERE peer = ? AND seq >= ${HELD} ORDER BY seq`, user);
  // A loud key change (section 6.1): what was written before it waits for the owner's OK.
  // The rest is renumbered so the live sequence stays contiguous.
  O.hold = (user, before) => db.tx(() => {
    const rows = db.all(`SELECT seq FROM peer_outbox WHERE peer = ? AND seq < ${HELD} AND created < ? AND kind != 'profile' ORDER BY seq`, user, before);
    const base = (db.get(`SELECT MAX(seq) s FROM peer_outbox WHERE peer = ? AND seq >= ${HELD}`, user).s || HELD);
    rows.forEach((r, i) => db.run("UPDATE peer_outbox SET seq = ?, kind = 'held:' || kind WHERE peer = ? AND seq = ?", base + i + 1, user, r.seq));
    if (rows.length) O.renumber(user);
    return rows.length;
  });
  // The owner said OK: held rows go back at the end of the live sequence, in order.
  O.release = (user) => db.tx(() => {
    const rows = O.held(user);
    if (!rows.length) return [];
    db.run(`DELETE FROM peer_outbox WHERE peer = ? AND seq >= ${HELD}`, user);
    for (const r of rows) O.push(user, r.kind.replace(/^held:/, ''), r.ref, r.body, r.created);
    return rows.map((r) => ({ kind: r.kind.replace(/^held:/, ''), ref: r.ref }));
  });
  // Delete rows up to `upto`; returns them (for delivered notices).
  O.ack = (user, upto) => db.tx(() => {
    const rows = db.all(`SELECT seq, kind, ref FROM peer_outbox WHERE peer = ? AND seq <= ? AND seq < ${HELD}`, user, upto);
    if (rows.length) db.run(`DELETE FROM peer_outbox WHERE peer = ? AND seq <= ? AND seq < ${HELD}`, user, upto);
    return rows;
  });
  // The peer lost my epoch: new epoch, pending rows renumbered from 1 in order (F1).
  O.renumber = (user) => db.tx(() => {
    const rows = db.all(`SELECT seq FROM peer_outbox WHERE peer = ? AND seq < ${HELD} ORDER BY seq`, user);
    // Two passes so the primary key never collides.
    db.run(`UPDATE peer_outbox SET seq = -seq WHERE peer = ? AND seq < ${HELD}`, user);
    rows.forEach((r, i) => db.run('UPDATE peer_outbox SET seq = ? WHERE peer = ? AND seq = ?', i + 1, user, -r.seq));
    const ep = randomEp();
    db.run('UPDATE peers SET out_ep = ?, out_seq = ? WHERE user = ?', ep, rows.length, user);
    return ep;
  });
  // Rows past their 30 days.
  O.expire = (now = Date.now()) => db.tx(() => {
    const rows = db.all('SELECT peer, seq, kind, ref FROM peer_outbox WHERE created < ?', now - OUTBOX_DAYS * 86_400_000);
    if (rows.length) db.run('DELETE FROM peer_outbox WHERE created < ?', now - OUTBOX_DAYS * 86_400_000);
    return rows;
  });
  O.drop = (user) => db.run('DELETE FROM peer_outbox WHERE peer = ?', user);
  O.waiting = (user) => db.all(`SELECT ref FROM peer_outbox WHERE peer = ? AND kind = 'dm.msg' AND seq < ${HELD} ORDER BY seq`, user).map((r) => r.ref);
  O.heldMsgs = (user) => db.all(`SELECT ref FROM peer_outbox WHERE peer = ? AND kind = 'held:dm.msg' ORDER BY seq`, user).map((r) => r.ref);
  return O;
}
