// SQLite storage. One file, write-ahead logging, foreign keys on.
// Every query in the server goes through prepared statements with bound
// parameters; nothing user-supplied is ever spliced into SQL text.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  hue INTEGER NOT NULL DEFAULT 165,
  emoji TEXT,
  about TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  presence TEXT NOT NULL DEFAULT 'around',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user);

CREATE TABLE IF NOT EXISTS houses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mark TEXT NOT NULL,
  hue INTEGER NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  join_role TEXT,
  starter TEXT NOT NULL DEFAULT '[]',
  first_step TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hue INTEGER,
  perms TEXT NOT NULL DEFAULT '[]',
  pos INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  newcomer INTEGER NOT NULL DEFAULT 0,
  joined INTEGER NOT NULL,
  PRIMARY KEY (house, user)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user);
CREATE TABLE IF NOT EXISTS room_groups (
  id TEXT PRIMARY KEY,
  house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pos INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  grp TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL,
  highlights TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS rooms_house ON rooms(house);
CREATE TABLE IF NOT EXISTS dms (
  id TEXT PRIMARY KEY,
  name TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_members (
  dm TEXT NOT NULL REFERENCES dms(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (dm, user)
);
CREATE INDEX IF NOT EXISTS dm_members_user ON dm_members(user);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  conv TEXT NOT NULL,
  root TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_conv ON threads(conv);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conv TEXT NOT NULL,
  author TEXT NOT NULL REFERENCES users(id),
  ts INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  fold TEXT NOT NULL DEFAULT '',
  reply_to TEXT,
  files TEXT,
  edited INTEGER,
  deleted INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv, seq);
CREATE TABLE IF NOT EXISTS reactions (
  msg TEXT NOT NULL,
  user TEXT NOT NULL,
  emoji TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (msg, user, emoji)
);
CREATE TABLE IF NOT EXISTS reads (
  user TEXT NOT NULL,
  conv TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (user, conv)
);
CREATE TABLE IF NOT EXISTS follows (
  user TEXT NOT NULL,
  thread TEXT NOT NULL,
  PRIMARY KEY (user, thread)
);
CREATE TABLE IF NOT EXISTS saved (
  user TEXT NOT NULL,
  msg TEXT NOT NULL,
  conv TEXT NOT NULL,
  at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user, msg)
);
CREATE TABLE IF NOT EXISTS notify (
  user TEXT NOT NULL,
  place TEXT NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY (user, place)
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  by TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS personal_invites (
  house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  by TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (house, user)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  conv TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL
);
`;

export function openDb(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const fresh = path === ':memory:' || !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // The database file holds password hashes and private messages: owner only.
  if (path !== ':memory:' && fresh) { try { chmodSync(path, 0o600); } catch { /* not supported */ } }

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}
