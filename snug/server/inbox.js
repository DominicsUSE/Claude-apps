// Inbox and notifications, on the server.
//
// - unread.counts: per conversation this person can read (room permissions
//   included), how many messages arrived since their read point and how many
//   need them, counted from the database, so a mention older than the page a
//   client loaded still shows. Also sent with the snapshot and with a house's
//   content when someone joins.
// - mentions.list / mention.dismiss: the last 30 days of mentions and replies,
//   read or not, each checked with M.canRead; dismissed ones stay hidden.
// - Timed mutes: notify.set takes until ('15m', '1h', '8h', '24h', 'never');
//   the server works out the time. An expired mute counts as unset
//   everywhere (M.notifyOf), and a sweep tells the person's devices.
// - Suppress @role mentions per house (the rolesOff setting).
// - Presence for a set time: me.update takes presenceUntil; an expired one
//   reads as Around everywhere (M.userRow) and a sweep tells everyone.
// - friends.mutual: friends you have in common with someone you may see.
// - me.handle: change your username (password, second factor when on, two
//   changes an hour, the old name held for 7 days; only the last two held).
import { limiter, checkPassword } from './auth.js';
import { mentions } from '../js/lib/format.js';
import { everyonePing, hasKeyword } from '../js/lib/account.js';
import { MUTE_FOR, PRESENCE_FOR, untilFor } from '../js/lib/inbox.js';

const DAY = 86_400_000;
const MENTION_DAYS = 30;
const HANDLE = /^[a-z0-9](?:[a-z0-9_.-]{0,22}[a-z0-9])?$/;
const HOLD = 7 * DAY;
export const NEEDS_SCAN = 100; // newest candidate messages checked per conversation for unread.counts
export const NEEDS_BUDGET = 1500; // and across all of them, per call
export const HELD_MAX = 2; // old usernames one account holds at once
const ANY_ID = /^[\w:.-]{1,80}$/;
const SLOW = 'You’re going a little fast. Wait a moment and try again.';

// Additive, guarded: each column or table only if it is missing.
export function migrateInbox(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  // When a timed mute ends (ms). Null: until changed.
  if (!has('notify', 'until')) db.exec('ALTER TABLE notify ADD COLUMN until INTEGER');
  // When a presence chosen for a while ends (ms). Null: until changed.
  if (!has('users', 'presence_until')) db.exec('ALTER TABLE users ADD COLUMN presence_until INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mention_dismiss (
      user TEXT NOT NULL,
      msg TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (user, msg)
    );
    CREATE TABLE IF NOT EXISTS handle_released (
      handle TEXT NOT NULL COLLATE NOCASE,
      user TEXT NOT NULL,
      ts INTEGER NOT NULL,
      until INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS handle_released_handle ON handle_released(handle);
    CREATE INDEX IF NOT EXISTS handle_released_user ON handle_released(user, ts);
  `);
}

export function createInboxOps({ db, M, hub, fail, ops: all }) {
  const L = {
    counts: limiter({ capacity: 3, perSecond: 0.1 }),
    mentions: limiter({ capacity: 10, perSecond: 1 }),
    dismiss: limiter({ capacity: 30, perSecond: 2 }),
    mutual: limiter({ capacity: 20, perSecond: 0.5 }),
    handle: limiter({ capacity: 5, perSecond: 0.05 }),
  };
  hub.extraLimits = [...(hub.extraLimits || []), ...Object.values(L)];
  const slow = (name, key) => { if (!L[name].take(key)) fail(SLOW); };
  const idOf = (v, name = 'id') => (typeof v === 'string' && ANY_ID.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const prefs = (u) => M.prefsOf?.(u) || {};
  const blocked = (u) => { try { return new Set(db.all('SELECT other FROM blocks WHERE user = ?', u).map((r) => r.other)); } catch { return new Set(); } };
  const pendingDms = (u) => { try { return new Set(db.all('SELECT dm FROM dm_requests WHERE user = ? AND declined IS NULL', u).map((r) => r.dm)); } catch { return new Set(); } };
  const ops = {};

  // ---------- Timed mutes ----------
  const baseNotifyOf = M.notifyOf;
  M.notifyOf = (user, place) => {
    const row = db.get('SELECT level, until FROM notify WHERE user = ? AND place = ?', user, place);
    if (!row) return baseNotifyOf(user, place);
    if (row.until != null && row.until <= Date.now()) return undefined;
    return row.level;
  };
  M.notifyUntil = (user, place) => {
    const row = db.get('SELECT until FROM notify WHERE user = ? AND place = ?', user, place);
    return row?.until != null && row.until > Date.now() ? row.until : null;
  };
  const baseHouseView = M.houseView;
  M.houseView = (id, viewer) => {
    const v = baseHouseView(id, viewer);
    if (!v || !v.house.joined) return v;
    const until = M.notifyUntil(viewer, id);
    if (until) v.house.notifyUntil = until;
    for (const r of Object.values(v.rooms)) { const u = M.notifyUntil(viewer, r.id); if (u) r.notifyUntil = u; }
    return v;
  };
  const baseDmView = M.dmView;
  M.dmView = (id, viewer) => {
    const v = baseDmView(id, viewer);
    if (!v) return v;
    // dmView reads the level through M.notifyOf, so an expired mute is already gone.
    const until = M.notifyUntil(viewer, id);
    if (until) v.notifyUntil = until; else delete v.notifyUntil;
    return v;
  };

  const resendPlace = (user, place) => {
    const room = M.room(place);
    if (room) return hub.sendHouse(user, room.house);
    if (db.get('SELECT 1 FROM houses WHERE id = ?', place)) return hub.sendHouse(user, place);
    return hub.sendDm(user, place);
  };

  ops['notify.set'] = ((base) => (c, d) => {
    let until = null;
    if (d.until !== undefined && d.until !== null) {
      if (!MUTE_FOR.includes(d.until)) fail('Pick one of the times.');
      if (d.level !== 'muted') fail('Only muting can last a set time.');
      until = untilFor(d.until);
    }
    const r = base(c, d);
    const place = d.id;
    const row = db.get('SELECT until FROM notify WHERE user = ? AND place = ?', c.user, place);
    if (row && row.until !== until) {
      db.run('UPDATE notify SET until = ? WHERE user = ? AND place = ?', until, c.user, place);
      resendPlace(c.user, place);
      schedule('mute', until);
    }
    return r;
  })(all['notify.set']);

  // Expired mutes: drop them and tell that person's devices.
  hub.sweepMutes = () => {
    const t = Date.now();
    const gone = db.all('SELECT user, place FROM notify WHERE until IS NOT NULL AND until <= ?', t);
    if (!gone.length) return 0;
    db.run('DELETE FROM notify WHERE until IS NOT NULL AND until <= ?', t);
    for (const r of gone) { try { resendPlace(r.user, r.place); } catch { /* the place went away */ } }
    return gone.length;
  };

  // ---------- Presence for a set time ----------
  const baseUserRow = M.userRow;
  M.userRow = (id) => {
    const r = baseUserRow(id);
    if (r && r.presence_until != null && r.presence_until <= Date.now()) return { ...r, presence: 'around', presence_until: null };
    return r;
  };
  const baseUserView = M.userView;
  M.userView = (row, presence, self = false) => {
    const v = baseUserView(row, presence, self);
    if (v && self) v.presenceUntil = row.presence_until != null && row.presence_until > Date.now() ? row.presence_until : null;
    return v;
  };
  ops['me.update'] = ((base) => (c, d) => {
    let until;
    if (d.presenceUntil !== undefined && d.presenceUntil !== null) {
      if (d.presence === undefined) fail('Pick a presence to set for a while.');
      if (!PRESENCE_FOR.includes(d.presenceUntil)) fail('Pick one of the times.');
      if (d.presenceUntil === 'today' && d.endOfDay !== undefined && !Number.isInteger(d.endOfDay)) fail('That time isn’t valid.');
      // Around is where a timed presence returns to, so it needs no time.
      until = d.presence === 'around' ? null : untilFor(d.presenceUntil, Date.now(), d.endOfDay);
    }
    const before = db.get('SELECT presence_until FROM users WHERE id = ?', c.user)?.presence_until ?? null;
    const r = base(c, d);
    // A presence chosen without a time lasts until changed; with one, until then.
    if (d.presence !== undefined) {
      const next = until ?? null;
      db.run('UPDATE users SET presence_until = ? WHERE id = ?', next, c.user);
      if (next) schedule('presence', next);
      // The base op already told everyone; tell them again only if the end changed.
      if (next !== before) hub.userChanged(c.user);
    }
    return r;
  })(all['me.update']);
  hub.sweepPresence = () => {
    const t = Date.now();
    const gone = db.all('SELECT id FROM users WHERE presence_until IS NOT NULL AND presence_until <= ?', t);
    if (!gone.length) return 0;
    db.run("UPDATE users SET presence = 'around', presence_until = NULL WHERE presence_until IS NOT NULL AND presence_until <= ?", t);
    for (const r of gone) hub.userChanged(r.id);
    return gone.length;
  };

  // One timer for the next expiry of each kind, plus a slow sweep for safety.
  const timers = {};
  function schedule(kind, until) {
    if (!until) return;
    const at = timers[kind]?.at;
    if (at && at <= until) return;
    clearTimeout(timers[kind]?.t);
    const t = setTimeout(() => {
      timers[kind] = null;
      try { (kind === 'mute' ? hub.sweepMutes : hub.sweepPresence)(); } catch { return; }
      const next = kind === 'mute'
        ? db.get('SELECT MIN(until) t FROM notify WHERE until IS NOT NULL')?.t
        : db.get('SELECT MIN(presence_until) t FROM users WHERE presence_until IS NOT NULL')?.t;
      if (next) schedule(kind, next);
    }, Math.min(2 ** 31 - 1, Math.max(0, until - Date.now()) + 50));
    t.unref?.();
    timers[kind] = { at: until, t };
  }
  const sweep = setInterval(() => { try { hub.sweepMutes(); hub.sweepPresence(); } catch { clearInterval(sweep); } }, 30_000);
  sweep.unref?.();
  try {
    schedule('mute', db.get('SELECT MIN(until) t FROM notify WHERE until IS NOT NULL')?.t);
    schedule('presence', db.get('SELECT MIN(presence_until) t FROM users WHERE presence_until IS NOT NULL')?.t);
  } catch { /* fresh database */ }

  // ---------- Suppress @role mentions (rolesOff) ----------
  // With roles off for a house, only highlight words and @everyone from
  // someone who may post notices still count (as server/account.js does).
  const baseForMe = M.forMeExtra;
  M.forMeExtra = (user, row, w) => {
    if (w?.house && prefs(user).rolesOff?.[w.house]) {
      const p = prefs(user);
      if (hasKeyword(row.text, p.keywords)) return true;
      return everyonePing(row.text) === 'everyone' && !row.noping && !p.everyoneOff?.[w.house] && M.can(row.author, w.house, 'announce');
    }
    return !!baseForMe?.(user, row, w);
  };

  // ---------- What needs this person, counted on the server ----------
  // The same rules as needsMe in js/lib/attention.js: a mention of your
  // username, a role you hold, @everyone/@here from someone who may post
  // notices (unless off for that house), highlight words, a reply to you
  // (unless the reply's mention was turned off), every message in a thread
  // you follow and in a direct conversation (a group set to "Only what needs
  // me" excepted).
  function forMe(user, handle, row, w, p) {
    if (mentions(row.text, handle)) return 'mention';
    if (row.reply_to && row.reply_ping !== 0 && (row.reply_author !== undefined ? row.reply_author : db.get('SELECT author FROM messages WHERE id = ?', row.reply_to)?.author) === user) return 'reply';
    if (M.forMeExtra(user, row, w)) return everyonePing(row.text) === 'everyone' && !row.noping ? 'everyone' : 'role';
    if (w?.house && everyonePing(row.text) === 'here' && !row.noping && !p.everyoneOff?.[w.house] && M.can(row.author, w.house, 'announce')) return 'everyone';
    return null;
  }

  // { [conv]: { count, needs, firstSeq, upTo } } for convs with anything unread.
  // One call asks the same few questions thousands of times (may this author
  // post notices here?), so their answers are kept for that call only.
  M.unreadCounts = (user, only = null) => {
    const can0 = M.can, memo = new Map();
    M.can = (u, h, perm) => {
      const k = `${u}\n${h}\n${perm}`;
      if (!memo.has(k)) memo.set(k, can0(u, h, perm));
      return memo.get(k);
    };
    try { return countUnread(user, only); } finally { M.can = can0; }
  };
  const countUnread = (user, only) => {
    const me = M.userRow(user);
    if (!me) return {};
    let convs = M.readable(user);
    if (only) { const want = new Set(only); convs = convs.filter((c) => want.has(c)); }
    if (!convs.length) return {};
    const out = {};
    const skip = pendingDms(user);
    const blocks = [...blocked(user)];
    const p = prefs(user);
    const followed = new Set(db.all('SELECT thread FROM follows WHERE user = ?', user).map((r) => r.thread));
    const noBlocks = blocks.length ? ` AND m.author NOT IN (${blocks.map(() => '?').join(',')})` : '';
    // node:sqlite is synchronous, so this work is bounded: the newest NEEDS_SCAN
    // candidates per conversation, and NEEDS_BUDGET checked in JS per call.
    // Past the budget, only mentions of your username and replies to you are
    // counted, in SQL. Badges show 99+ long before either cap matters.
    let budget = NEEDS_BUDGET;
    const handleLike = `%@${me.handle.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
    for (let i = 0; i < convs.length; i += 400) {
      const chunk = convs.slice(i, i + 400).filter((c) => !skip.has(c) && !(c.startsWith('t:') && skip.has(M.thread(c)?.conv)));
      if (!chunk.length) continue;
      const rows = db.all(`SELECT m.conv, COUNT(*) n, MIN(m.seq) first, MAX(m.ts) last, COALESCE(r.ts, 0) since
        FROM messages m LEFT JOIN reads r ON r.user = ? AND r.conv = m.conv
        WHERE m.conv IN (${chunk.map(() => '?').join(',')}) AND m.ts > COALESCE(r.ts, 0)
          AND m.author != ? AND m.deleted IS NULL AND m.sys IS NULL${noBlocks}
        GROUP BY m.conv`, user, ...chunk, user, ...blocks);
      for (const r of rows) {
        const w = M.where(r.conv);
        if (!w) continue;
        const level = levelFor(user, w);
        let needs = 0;
        if (level !== 'muted') {
          const dmAll = w.type === 'dm' && !(level === 'mentions' && (M.isGroupDm ? M.isGroupDm(w.dm) : db.get('SELECT COUNT(*) n FROM dm_members WHERE dm = ?', w.dm).n > 2));
          if (dmAll || (w.type === 'thread' && followed.has(r.conv))) needs = r.n;
          else {
            // Only the unread messages that could be for me: an @, a reply, or any word when highlight words are set.
            if (budget > 0) {
              const wide = p.keywords?.length ? '' : " AND (m.text LIKE '%@%' OR m.reply_to IS NOT NULL)";
              const cand = db.all(`SELECT m.*, (SELECT q.author FROM messages q WHERE q.id = m.reply_to) AS reply_author
                FROM messages m WHERE m.conv = ? AND m.ts > ? AND m.author != ? AND m.deleted IS NULL AND m.sys IS NULL${noBlocks}${wide}
                ORDER BY m.seq DESC LIMIT ${Math.min(NEEDS_SCAN, budget)}`, r.conv, r.since, user, ...blocks);
              budget -= cand.length;
              for (const row of cand) if (forMe(user, me.handle, row, w, p)) needs++;
            } else {
              needs = db.get(`SELECT COUNT(*) n FROM (SELECT 1 FROM messages m WHERE m.conv = ? AND m.ts > ? AND m.author != ? AND m.deleted IS NULL AND m.sys IS NULL${noBlocks}
                AND (m.text LIKE ? ESCAPE '\\' OR (m.reply_to IS NOT NULL AND COALESCE(m.reply_ping, 1) != 0
                  AND (SELECT q.author FROM messages q WHERE q.id = m.reply_to) = ?)) ORDER BY m.seq DESC LIMIT ${NEEDS_SCAN})`,
              r.conv, r.since, user, ...blocks, handleLike, user).n;
            }
          }
        }
        out[r.conv] = { count: r.n, needs, firstSeq: r.first, upTo: r.last };
      }
    }
    return out;
  };
  const levelFor = (user, w) => {
    if (w.dm && !w.house) return M.notifyOf(user, w.dm) || 'all';
    const room = w.type === 'thread' ? w.parent : w.id;
    return M.notifyOf(user, room) || M.notifyOf(user, w.house) || 'all';
  };

  ops['unread.counts'] = (c) => {
    slow('counts', c.user);
    return { unread: M.unreadCounts(c.user) };
  };

  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnap(u);
    try { snap.unread = M.unreadCounts(u); } catch { snap.unread = {}; }
    return snap;
  };
  const baseContent = hub.sendHouseContent;
  hub.sendHouseContent = (u, houseId) => {
    baseContent(u, houseId);
    const rooms = db.all('SELECT id FROM rooms WHERE house = ?', houseId).map((r) => r.id);
    const convs = M.readable(u).filter((c) => rooms.includes(c) || (c.startsWith('t:') && rooms.includes(M.thread(c)?.conv)));
    hub.toUser(u, 'unread', { unread: M.unreadCounts(u, convs), convs });
  };

  // ---------- Mentions inbox ----------
  ops['mentions.list'] = (c, d) => {
    slow('mentions', c.user);
    const limit = d.limit === undefined ? 25 : (Number.isInteger(d.limit) && d.limit >= 1 && d.limit <= 50 ? d.limit : fail('That limit isn’t valid.'));
    const before = d.before === undefined || d.before === null ? Number.MAX_SAFE_INTEGER : (Number.isInteger(d.before) && d.before > 0 ? d.before : fail('That position isn’t valid.'));
    const house = d.house === undefined || d.house === null ? null : idOf(d.house, 'house');
    if (house && !M.isMember(house, c.user)) fail('You’re not a member of that house.');
    const withRoles = d.roles !== false;
    const withEveryone = d.everyone !== false;
    const me = M.userRow(c.user);
    const p = prefs(c.user);
    let convs = M.readable(c.user);
    if (house) convs = convs.filter((conv) => M.where(conv)?.house === house);
    if (!convs.length) return { items: [], users: {}, threads: {}, more: false };
    const blocks = [...blocked(c.user)];
    const noBlocks = blocks.length ? ` AND author NOT IN (${blocks.map(() => '?').join(',')})` : '';
    const since = Date.now() - MENTION_DAYS * DAY;
    const items = [];
    let cursor = before, scanned = 0, more = false;
    for (;;) {
      const rows = db.all(`SELECT * FROM messages WHERE conv IN (${convs.map(() => '?').join(',')}) AND seq < ? AND ts > ?
          AND author != ? AND deleted IS NULL AND sys IS NULL${noBlocks}
          AND (text LIKE '%@%' OR (reply_to IS NOT NULL AND COALESCE(reply_ping, 1) != 0 AND reply_to IN (SELECT id FROM messages WHERE author = ?)))
          AND id NOT IN (SELECT msg FROM mention_dismiss WHERE user = ?)
        ORDER BY seq DESC LIMIT 200`, ...convs, cursor, since, c.user, ...blocks, c.user, c.user);
      for (const row of rows) {
        if (items.length >= limit) { more = true; break; }
        cursor = row.seq;
        if (!M.canRead(c.user, row.conv)) continue;
        const why = forMe(c.user, me.handle, row, M.where(row.conv), p);
        if (!why || (why === 'role' && !withRoles) || (why === 'everyone' && !withEveryone)) continue;
        items.push({ conv: row.conv, why, row });
      }
      scanned += rows.length;
      if (more || rows.length < 200) break;
      // A long run of messages with an @ that isn't for me: stop and let the next page go on from here.
      if (scanned >= 3000) { more = true; break; }
    }
    const views = M.withReactions(items.map((it) => it.row));
    const convsOut = [...new Set(items.map((it) => it.conv))];
    return {
      items: items.map((it, i) => ({ conv: it.conv, why: it.why, m: views[i] })),
      users: hub.usersFor(items.map((it) => it.row.author)),
      threads: hub.threadsFor(convsOut),
      more,
      next: more ? cursor : null,
    };
  };

  ops['mention.dismiss'] = (c, d) => {
    slow('dismiss', c.user);
    const msg = idOf(d.id, 'message');
    const row = M.msg(msg);
    if (!row || !M.canRead(c.user, row.conv)) fail('That message isn’t there any more.');
    if (d.undo === true) db.run('DELETE FROM mention_dismiss WHERE user = ? AND msg = ?', c.user, msg);
    else {
      db.run('INSERT OR IGNORE INTO mention_dismiss (user, msg, ts) VALUES (?, ?, ?)', c.user, msg, Date.now());
      // Keep the list small: a year of dismissals at most.
      db.run('DELETE FROM mention_dismiss WHERE user = ? AND ts < ?', c.user, Date.now() - 365 * DAY);
    }
    hub.toUser(c.user, 'mention.dismiss', { id: msg, undo: d.undo === true });
    return {};
  };

  // ---------- Mutual friends ----------
  ops['friends.mutual'] = (c, d) => {
    slow('mutual', c.user);
    const target = idOf(d.user, 'person');
    if (target === c.user) return { users: [] };
    if (!M.userRow(target) || !M.sees(c.user, target)) fail('You can’t see that person.');
    const b = blocked(c.user);
    if (b.has(target) || blocked(target).has(c.user)) fail('You can’t see that person.');
    const ids = db.all(`SELECT f1.other AS id FROM friends f1 JOIN friends f2 ON f2.other = f1.other
      WHERE f1.user = ? AND f1.state = 'friends' AND f2.user = ? AND f2.state = 'friends' LIMIT 200`, c.user, target).map((r) => r.id)
      // Friends who blocked me, or whom I blocked, stay out.
      .filter((u) => !b.has(u) && !blocked(u).has(c.user) && M.sees(c.user, u));
    return { users: ids };
  };

  // ---------- Change your username ----------
  ops['me.handle'] = (c, d) => {
    slow('handle', c.user);
    const handle = typeof d.handle === 'string' ? d.handle.trim().toLowerCase().replace(/^@/, '') : fail('Type a username.');
    if (!HANDLE.test(handle)) fail('Usernames are 2 to 24 letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.');
    const u = M.userRow(c.user);
    if (typeof d.password !== 'string' || d.password.length > 200 || !checkPassword(d.password, u.pass)) fail('That password isn’t right.');
    if (M.totpOn?.(c.user) && !M.verifySecond?.(c.user, typeof d.code === 'string' ? d.code : '')) fail('That code isn’t right. Use a fresh code from your app or a backup code.');
    if (handle === u.handle.toLowerCase()) fail('That’s already your username.');
    const t = Date.now();
    if (db.get('SELECT COUNT(*) n FROM handle_released WHERE user = ? AND ts > ?', c.user, t - 3_600_000).n >= 2) fail('You can change your username twice an hour. Try again later.');
    const held = db.get('SELECT user FROM handle_released WHERE handle = ? AND until > ? ORDER BY ts DESC LIMIT 1', handle, t);
    if (db.get('SELECT 1 FROM users WHERE handle = ? AND id != ?', handle, c.user) || (held && held.user !== c.user)) fail(`@${handle} is taken. Try another username.`);
    db.tx(() => {
      db.run('INSERT INTO handle_released (handle, user, ts, until) VALUES (?, ?, ?, ?)', u.handle, c.user, t, t + HOLD);
      // Only your last HELD_MAX old names stay held, so one account can't sit on a pile of them.
      db.run(`UPDATE handle_released SET until = ? WHERE user = ? AND until > ? AND rowid NOT IN
        (SELECT rowid FROM handle_released WHERE user = ? AND until > ? ORDER BY ts DESC, rowid DESC LIMIT ${HELD_MAX})`, t, c.user, t, c.user, t);
      db.run('UPDATE users SET handle = ? WHERE id = ?', handle, c.user);
      db.run('DELETE FROM handle_released WHERE until < ?', t - DAY);
    });
    hub.userChanged(c.user);
    return { handle };
  };
  // For sign-up (server/index.js): a name someone gave up in the last 7 days is still theirs.
  M.handleHeld = (handle) => !!db.get('SELECT 1 FROM handle_released WHERE handle = ? AND until > ?', handle, Date.now());

  return ops;
}
