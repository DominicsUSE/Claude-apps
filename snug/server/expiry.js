// Disappearing messages (0.12): an optional timer per conversation.
//
// - conv_ttl holds the timer for a room or a direct conversation or group.
//   Threads follow their conversation.
// - A trigger gives every new message in such a conversation an expiry
//   (its time plus the timer), whichever code path inserts it: plain
//   messages, polls, stickers, forwards, scheduled ones, and messages that
//   arrive from a friend's PC (each PC applies the timer it knows, to the
//   sender's timestamp, so all copies expire together).
// - The minute sweep (server/index.js) wipes expired messages at once, with
//   no undo window: text, search words, earlier versions, previews, polls,
//   reactions, pins and saved marks. The file sweep then removes their
//   attachments (server/media.js).
//
// What it can't do, and the app says so: people can copy or screenshot a
// message before it goes, and the server's encrypted snapshots
// (server/dbbackup.js) keep a copy until they roll over.
import { UserError } from './ops.js';
import { newId, now } from './model.js';

// What is left of a message's link previews once their words go: only the ids of the pictures Snug copied
// (null when there are none), so the file sweep (server/media.js) can still remove those files.
const FILE_ID = /f_[a-z0-9]{8,40}/g;
export function embedFileRefs(embeds) {
  const ids = [...new Set(String(embeds || '').match(FILE_ID) || [])];
  return ids.length ? JSON.stringify(ids.map((id) => ({ kind: 'gone', image: { id } }))) : null;
}

export const TTLS = [0, 3_600_000, 86_400_000, 7 * 86_400_000, 30 * 86_400_000];
const TTL_WORDS = { 3_600_000: '1 hour', 86_400_000: '1 day', [7 * 86_400_000]: '7 days', [30 * 86_400_000]: '30 days' };
const fail = (m) => { throw new UserError(m); };

export function migrateExpiry(db) {
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'expires')) db.exec('ALTER TABLE messages ADD COLUMN expires INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conv_ttl (conv TEXT PRIMARY KEY, ttl INTEGER NOT NULL, by TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_expires ON messages(expires) WHERE expires IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS messages_ttl_ai AFTER INSERT ON messages
      WHEN new.expires IS NULL AND (new.sys IS NULL OR json_extract(new.sys, '$.act') IS NOT 'ttl')
    BEGIN
      UPDATE messages SET expires = new.ts + (SELECT ttl FROM conv_ttl WHERE conv =
        CASE WHEN new.conv LIKE 't:%' THEN (SELECT conv FROM threads WHERE id = new.conv) ELSE new.conv END)
      WHERE seq = new.seq;
    END;
  `);
}

export function createExpiry({ db, M, hub, ops, clock = Date.now }) {
  migrateExpiry(db.raw || db);
  const has = (t) => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  const cols = new Set(db.all('PRAGMA table_info(messages)').map((c) => c.name));

  M.ttlOf = (conv) => db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', conv)?.ttl || 0;
  // Clients get each message's expiry, so they hide it on time even offline.
  const baseMsgView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseMsgView(row, rx);
    if (row.expires) m.expires = row.expires;
    return m;
  };
  const baseDmView = M.dmView;
  M.dmView = (id, viewer) => {
    const v = baseDmView(id, viewer);
    const ttl = v && M.ttlOf(id);
    if (ttl) v.ttl = ttl;
    return v;
  };
  const baseHouseView = M.houseView;
  M.houseView = (houseId, viewer) => {
    const v = baseHouseView(houseId, viewer);
    if (v?.rooms) for (const r of db.all('SELECT t.conv, t.ttl FROM conv_ttl t JOIN rooms r ON r.id = t.conv WHERE r.house = ?', houseId)) if (v.rooms[r.conv]) v.rooms[r.conv].ttl = r.ttl;
    return v;
  };

  // Who may change the timer: either person (or anyone) in a direct
  // conversation or group; in a house, people who may manage rooms.
  function check(user, conv) {
    const w = typeof conv === 'string' ? M.where(conv) : null;
    if (!w || w.type === 'thread' || !M.canRead(user, conv)) fail('You don’t have access to this conversation.');
    if (w.type === 'room' && !M.can(user, w.house, 'rooms')) fail('Your role can’t change disappearing messages in this house.');
    return w;
  }
  ops['conv.ttl'] = (c, d) => {
    const ttl = TTLS.includes(d.ttl) ? d.ttl : fail('Pick off, 1 hour, 1 day, 7 days or 30 days.');
    const w = check(c.user, d.conv);
    const conv = d.conv;
    if (M.ttlOf(conv) === ttl) return {};
    db.tx(() => {
      if (ttl) db.run('INSERT INTO conv_ttl (conv, ttl, by, ts) VALUES (?, ?, ?, ?) ON CONFLICT (conv) DO UPDATE SET ttl = excluded.ttl, by = excluded.by, ts = excluded.ts', conv, ttl, c.user, Date.now());
      else db.run('DELETE FROM conv_ttl WHERE conv = ?', conv);
    });
    // A line in the conversation, like a group change (rendered by js/views/dm-manage.js DmLine).
    const mid = newId('m');
    const who = M.userRow(c.user)?.name || 'Someone';
    const text = ttl ? `${who} set messages to disappear after ${TTL_WORDS[ttl]}` : `${who} turned off disappearing messages`;
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, sys) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, conv, c.user, c.ts ?? now(), text, M.foldText(text, []), JSON.stringify({ kind: 'dm', act: 'ttl', by: c.user, ttl }));
    const [m] = M.withReactions([M.msg(mid)]);
    hub.toConv(conv, 'msg', { conv, m, user: hub.userView(c.user) });
    if (w.type === 'room') hub.houseChanged(w.house);
    else for (const r of db.all('SELECT user FROM dm_members WHERE dm = ?', conv)) hub.sendDm(r.user, conv);
    return {};
  };

  // Undo can't bring back a message that disappeared.
  const baseRestore = ops['msg.restore'];
  ops['msg.restore'] = (c, d) => {
    const row = typeof d?.id === 'string' ? M.msg(d.id) : null;
    // The sweep marks a message that disappeared as deleted at its expiry time.
    if (row?.expires && (row.expires <= clock() || row.deleted === row.expires)) fail('That message has disappeared.');
    return baseRestore(c, d);
  };

  // Wipe what has expired, in batches. `t` is the sweep's clock (tests pass their own).
  // Link previews keep only the ids of their pictures, so the file sweep can still find and remove them
  // (review-media 3); their words go now.
  const blank = ['fwd', 'sticker'].filter((c) => cols.has(c)).map((c) => `, ${c} = NULL`).join('');
  const embedsCol = cols.has('embeds');
  return {
    sweep(t = clock()) {
      const rows = db.all("SELECT id, conv, expires FROM messages WHERE expires IS NOT NULL AND expires <= ? AND (deleted IS NULL OR text != '' OR fold != '') LIMIT 1000", t);
      if (!rows.length) return 0;
      db.tx(() => {
        for (const r of rows) {
          // files stay named until the file sweep has removed them (it reads expires too).
          db.run(`UPDATE messages SET deleted = coalesce(deleted, ?), text = '', fold = ''${blank} WHERE id = ?`, r.expires, r.id);
          if (embedsCol) db.run('UPDATE messages SET embeds = ? WHERE id = ?', embedFileRefs(db.get('SELECT embeds FROM messages WHERE id = ?', r.id)?.embeds), r.id);
          if (has('forum_posts')) db.run("UPDATE forum_posts SET title = '', tags = '[]' WHERE msg = ?", r.id);
          db.run('DELETE FROM reactions WHERE msg = ?', r.id);
          for (const tbl of ['msg_edits', 'polls', 'poll_votes', 'pins']) if (has(tbl)) db.run(`DELETE FROM ${tbl} WHERE msg = ?`, r.id);
          if (has('saved')) db.run('DELETE FROM saved WHERE msg = ?', r.id);
        }
      });
      for (const r of rows) hub.toConv(r.conv, 'msg.del', { conv: r.conv, id: r.id });
      return rows.length;
    },
  };
}
