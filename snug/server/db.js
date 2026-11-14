// SQLite storage. One file, write-ahead logging, foreign keys on.
// Every query in the server goes through prepared statements with bound
// parameters; nothing user-supplied is ever spliced into SQL text.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrateMessaging } from './messaging.js'; // polls, link previews, edit history, scheduled messages, stickers
import { migrateAppearance } from './appearance.js'; // profile pictures and styling (server/appearance.js)
import { migrateAccount } from './account.js'; // profile fields, settings sync, notes, two-factor, session devices (server/account.js)
import { migratePlaces } from './places.js'; // room overrides, extra roles, forums, webhooks, folders, onboarding (server/places.js)
import { migrateChat } from './chat.js'; // silent messages, reply mentions, @everyone without the right, dice rolls (server/chat.js)
import { migrateCommunity } from './community.js'; // pictures, verification, custom links, event covers, spam rules, new permissions (server/community.js)
import { migrateInbox } from './inbox.js'; // timed mutes, presence for a while, dismissed mentions, held usernames (server/inbox.js)
import { migrateDms } from './dms.js'; // closed, pinned and named conversations, group owners and icons (server/dms.js)

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

-- Friends: two rows per pair, one from each person's side. "state" is how
-- the pair looks to "user" ('friends', 'outgoing' or 'incoming'), and
-- "favorite" is that person's private star. Both rows change together.
CREATE TABLE IF NOT EXISTS friends (
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  since INTEGER NOT NULL,
  PRIMARY KEY (user, other)
);
CREATE INDEX IF NOT EXISTS friends_other ON friends(other);
-- After a request is declined or taken back, "user" may not ask "other"
-- again until a day after "ts", so a request can't be used to nag.
CREATE TABLE IF NOT EXISTS friend_cooldown (
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  PRIMARY KEY (user, other)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  room TEXT,
  title TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  starts INTEGER NOT NULL,
  ends INTEGER,
  by TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_house ON events(house, starts);
CREATE TABLE IF NOT EXISTS event_rsvps (
  event TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  PRIMARY KEY (event, user)
);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an
// existing table alone, so each one is added here if the table lacks it.
const COLUMNS = [
  ['users', 'interests', "TEXT NOT NULL DEFAULT '[]'"],
  ['users', 'links', "TEXT NOT NULL DEFAULT '[]'"],
  ['houses', 'public', 'INTEGER NOT NULL DEFAULT 0'],
  ['houses', 'topic', 'TEXT'],
  ['houses', 'rules', "TEXT NOT NULL DEFAULT ''"],
  // Server-written lines in a conversation (call records), as JSON. Null for people's messages.
  ['messages', 'sys', 'TEXT'],
];

export function migrate(db) {
  for (const [table, column, type] of COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    // Names and types come from the list above, never from input.
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  migrateMessagesExtras(db);
  migrateCustomEmoji(db); // custom emoji per house (server/emoji.js)
  migrateSafety(db); // blocks, privacy, moderation, audit log (server/safety.js)
  migrateMessaging(db); // polls, link previews, edit history, scheduled messages, stickers (server/messaging.js)
  migratePlaces(db); // places, structure and community (server/places.js)
  migrateVoiceOpts(db); // soundboard, voice room limits and bitrate (server/voiceopts.js)
  migrateAccount(db); // profile fields, settings sync, notes, two-factor, session devices (server/account.js)
  migrateAppearance(db); // profile pictures and styling (server/appearance.js)
  migrateChat(db); // text and messages (server/chat.js)
  migrateCommunity(db); // houses and community (server/community.js)
  migrateInbox(db); // inbox and notifications (server/inbox.js)
  migrateDms(db); // direct conversations and groups (server/dms.js)
}

// --- Voice options (server/voiceopts.js) ----------------------------------------
// Each house's soundboard, who may use it, and each voice room's user limit and bitrate.
function migrateVoiceOpts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS house_sounds (
      id TEXT PRIMARY KEY,
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      emoji TEXT,
      file TEXT NOT NULL,
      volume REAL NOT NULL DEFAULT 1,
      by TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS house_sounds_house ON house_sounds(house);`);
  // Names and types are fixed here, never from input.
  for (const [table, column, type] of [
    ['rooms', 'user_limit', 'INTEGER NOT NULL DEFAULT 0'],
    ['rooms', 'bitrate', 'INTEGER NOT NULL DEFAULT 64'],
    ['houses', 'sound_open', 'INTEGER NOT NULL DEFAULT 1'],
  ]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
// --- end voice options ------------------------------------------------------------

// --- Safety, privacy and moderation (server/safety.js) ----------------------
// Blocks and privacy per person, message requests, bans, timeouts, voice
// moderation, the audit log, reports, the word filter, rule acceptance, and
// columns for slowmode, member screening and invitation limits.
function migrateSafety(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      other TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      PRIMARY KEY (user, other)
    );
    CREATE INDEX IF NOT EXISTS blocks_other ON blocks(other);
    CREATE TABLE IF NOT EXISTS privacy (
      user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      dm TEXT NOT NULL DEFAULT 'houses',
      friends TEXT NOT NULL DEFAULT 'everyone',
      requests INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dm_requests (
      dm TEXT NOT NULL REFERENCES dms(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      by TEXT NOT NULL,
      ts INTEGER NOT NULL,
      declined INTEGER,
      PRIMARY KEY (dm, user)
    );
    CREATE TABLE IF NOT EXISTS bans (
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      by TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,
      PRIMARY KEY (house, user)
    );
    CREATE TABLE IF NOT EXISTS timeouts (
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      until INTEGER NOT NULL,
      by TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (house, user)
    );
    CREATE TABLE IF NOT EXISTS voice_mod (
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mute INTEGER NOT NULL DEFAULT 0,
      deaf INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (house, user)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_house ON audit(house, id);
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      by TEXT,
      user TEXT,
      msg TEXT,
      conv TEXT,
      text TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      handled_by TEXT,
      handled_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS reports_house ON reports(house, status, ts);
    CREATE TABLE IF NOT EXISTS automod (
      house TEXT PRIMARY KEY REFERENCES houses(id) ON DELETE CASCADE,
      words TEXT NOT NULL DEFAULT '[]',
      links INTEGER NOT NULL DEFAULT 0,
      action TEXT NOT NULL DEFAULT 'block',
      timeout_ms INTEGER NOT NULL DEFAULT 300000,
      exempt TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS rule_accepts (
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      PRIMARY KEY (house, user)
    );`);
  // Names and types are fixed here, never from input.
  for (const [table, column, type] of [
    ['rooms', 'slowmode', 'INTEGER NOT NULL DEFAULT 0'],
    ['houses', 'screening', 'INTEGER NOT NULL DEFAULT 0'],
    ['invites', 'max_uses', 'INTEGER NOT NULL DEFAULT 0'],
    ['invites', 'uses', 'INTEGER NOT NULL DEFAULT 0'],
    ['invites', 'revoked', 'INTEGER'],
  ]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
// --- end safety ---------------------------------------------------------------

// --- Custom emoji (server/emoji.js) -----------------------------------------
// Each house's emoji, and where emoji were used outside their own house (so
// the readers of those conversations may see the image).
function migrateCustomEmoji(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS house_emoji (
      id TEXT PRIMARY KEY,
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      by TEXT NOT NULL,
      created INTEGER NOT NULL,
      UNIQUE (house, name)
    );
    CREATE INDEX IF NOT EXISTS house_emoji_file ON house_emoji(file);
    CREATE TABLE IF NOT EXISTS emoji_uses (
      emoji TEXT NOT NULL,
      conv TEXT NOT NULL,
      PRIMARY KEY (emoji, conv)
    );`);
}
// --- end custom emoji -------------------------------------------------------

// --- Messages extras (voice messages, pins, GIFs) ---------------------------
// Pinned messages per conversation, the GIFs each person saved (references to
// files they can read), and a details column on files (GIF flag, size).
function migrateMessagesExtras(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pins (
      conv TEXT NOT NULL,
      msg TEXT NOT NULL,
      by TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (conv, msg)
    );
    CREATE TABLE IF NOT EXISTS gif_favs (
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file TEXT NOT NULL,
      at INTEGER NOT NULL,
      w INTEGER,
      h INTEGER,
      PRIMARY KEY (user, file)
    );`);
  if (!db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'meta')) db.exec('ALTER TABLE files ADD COLUMN meta TEXT');
}
// --- end messages extras ----------------------------------------------------

export function openDb(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const fresh = path === ':memory:' || !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  // The database file holds password hashes and private messages: owner only.
  if (path !== ':memory:' && fresh) { try { chmodSync(path, 0o600); } catch { /* not supported */ } }

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    // One transaction; a tx inside another becomes a savepoint, so an op that
    // wraps another (and both use tx) still rolls back as one.
    tx(fn) {
      if (depth > 0) {
        const sp = `tx${depth}`;
        db.exec(`SAVEPOINT ${sp}`);
        depth++;
        try { const r = fn(); db.exec(`RELEASE ${sp}`); return r; } catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e; } finally { depth--; }
      }
      db.exec('BEGIN');
      depth++;
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
    },
    close: () => db.close(),
  };
}
