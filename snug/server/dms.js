// Direct conversations and groups, managed (server side).
//
// - dm.hide / dm.show: close a conversation from your list (its messages stay);
//   a new message in it brings it back.
// - dm.pin: up to 10 conversations pinned to the top of your list.
// - Groups only: dm.rename (1-40 characters), dm.icon (an emoji and a hue),
//   dm.add (up to 10 people in all; each one someone you may message: a
//   friend or someone you share a house or conversation with, no block
//   either way with anyone in it, and their message privacy allows it),
//   dm.leave (you lose its history) and dm.kick (the group's owner only).
//   Adding people to a one-to-one conversation starts a new group.
// Changes write a line into the conversation, as a call record does.
import { limiter } from './auth.js';
import { newId, now } from './model.js';
import { HUES } from '../js/lib/util.js';

export const MAX_GROUP = 10;
export const MAX_PINNED = 10;
const ANY_ID = /^[\w:.-]{1,80}$/;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const HUE_SET = new Set(HUES.map(([h]) => h));
const SLOW = 'You’re going a little fast. Wait a moment and try again.';

export function migrateDms(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  for (const [t, c, type] of [
    ['dm_members', 'hidden', 'INTEGER'], // 1: closed from this person's list
    ['dm_members', 'pinned', 'INTEGER'], // when pinned (ms); null: not pinned
    ['dms', 'owner', 'TEXT'], // a group's owner; null: its first member
    ['dms', 'icon', 'TEXT'], // a group's emoji
    ['dms', 'icon_hue', 'INTEGER'], // and its hue
  ]) if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
}

export function createDmOps({ db, M, hub, fail, ops: all }) {
  const L = {
    list: limiter({ capacity: 30, perSecond: 1 }), // hide, show, pin: only your own list
    group: limiter({ capacity: 10, perSecond: 0.2 }), // rename, icon, add, leave, kick: everyone in it hears
  };
  hub.extraLimits = [...(hub.extraLimits || []), ...Object.values(L)];
  const slow = (name, key) => { if (!L[name].take(key)) fail(SLOW); };
  const idOf = (v, name = 'conversation') => (typeof v === 'string' && ANY_ID.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const members = (dm) => db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY rowid', dm).map((r) => r.user);
  const ownerOf = (dm) => db.get('SELECT owner FROM dms WHERE id = ?', dm)?.owner || members(dm)[0] || null;
  const blockedEither = (a, b) => { try { return !!db.get('SELECT 1 FROM blocks WHERE (user = ? AND other = ?) OR (user = ? AND other = ?)', a, b, b, a); } catch { return false; } };
  const name = (u) => M.userRow(u)?.name || 'Someone';
  const shareHouse = (a, b) => !!db.get('SELECT 1 FROM members m1 JOIN members m2 ON m1.house = m2.house WHERE m1.user = ? AND m2.user = ? LIMIT 1', a, b);
  const shareDm = (a, b) => {
    try {
      return !!db.get(`SELECT 1 FROM dm_members d1 JOIN dm_members d2 ON d1.dm = d2.dm
        WHERE d1.user = ? AND d2.user = ? AND NOT EXISTS (SELECT 1 FROM dm_requests r WHERE r.dm = d1.dm) LIMIT 1`, a, b);
    } catch { // no message requests table: every shared conversation counts
      return !!db.get('SELECT 1 FROM dm_members d1 JOIN dm_members d2 ON d1.dm = d2.dm WHERE d1.user = ? AND d2.user = ? LIMIT 1', a, b);
    }
  };
  const ops = {};

  function mine(user, dmId) {
    const dm = idOf(dmId);
    if (!db.get('SELECT 1 FROM dms WHERE id = ?', dm) || !M.inDm(dm, user)) fail('You’re not in that conversation.');
    return dm;
  }
  // A group stays a group when people leave: the first group change writes its owner down.
  const isGroup = (dm) => members(dm).length > 2 || !!db.get('SELECT owner FROM dms WHERE id = ?', dm)?.owner;
  // The one group test (notify.set, dm.open and unread counts use it too).
  M.isGroupDm = isGroup;
  function group(user, dmId) {
    const dm = mine(user, dmId);
    if (!isGroup(dm)) fail('That’s a conversation between two people. Add someone to start a group.');
    db.run('UPDATE dms SET owner = (SELECT user FROM dm_members WHERE dm = ? ORDER BY rowid LIMIT 1) WHERE id = ? AND owner IS NULL', dm, dm);
    return dm;
  }

  // What each person sees of a conversation: owner, icon, and their own pin and closed state.
  const baseView = M.dmView;
  M.dmView = (id, viewer) => {
    const v = baseView(id, viewer);
    if (!v) return v;
    const d = db.get('SELECT owner, icon, icon_hue FROM dms WHERE id = ?', id);
    const me = db.get('SELECT hidden, pinned FROM dm_members WHERE dm = ? AND user = ?', id, viewer);
    if (v.members.length > 2 || d?.owner) { v.group = true; v.owner = d?.owner || v.members[0]; }
    if (d?.icon) v.icon = { emoji: d.icon, hue: d.icon_hue ?? null };
    if (me?.hidden) v.hidden = true;
    if (me?.pinned) v.pinned = me.pinned;
    return v;
  };

  // A line in the conversation, written by the server: "Ada renamed the group".
  const baseMsgView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseMsgView(row, rx);
    if (m.call && m.call.kind === 'dm') { m.dmLine = { ...m.call }; delete m.dmLine.kind; delete m.call; m.sys = true; }
    return m;
  };
  function line(dm, by, act, extra = {}) {
    const mid = newId('m');
    const text = lineText(act, by, extra);
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, sys) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, dm, by, now(), text, M.foldText(text, []), JSON.stringify({ kind: 'dm', act, by, ...extra }));
    const [m] = M.withReactions([M.msg(mid)]);
    hub.toConv(dm, 'msg', { conv: dm, m, user: hub.userView(by) });
  }
  function lineText(act, by, x) {
    const who = name(by);
    if (act === 'rename') return x.name ? `${who} named the group ${x.name}` : `${who} removed the group’s name`;
    if (act === 'icon') return `${who} changed the group’s icon`;
    if (act === 'add') return `${who} added ${(x.users || []).map(name).join(', ')}`;
    if (act === 'leave') return `${who} left the group`;
    if (act === 'kick') return `${who} removed ${name(x.user)}`;
    return '';
  }
  const tellAll = (dm) => { for (const u of members(dm)) hub.sendDm(u, dm); };

  // ---------- Your own list ----------
  ops['dm.hide'] = (c, d) => {
    slow('list', c.user);
    const dm = mine(c.user, d.dm);
    db.run('UPDATE dm_members SET hidden = 1 WHERE dm = ? AND user = ?', dm, c.user);
    hub.sendDm(c.user, dm);
    return {};
  };
  ops['dm.show'] = (c, d) => {
    slow('list', c.user);
    const dm = mine(c.user, d.dm);
    db.run('UPDATE dm_members SET hidden = NULL WHERE dm = ? AND user = ?', dm, c.user);
    hub.sendDm(c.user, dm);
    return {};
  };
  ops['dm.pin'] = (c, d) => {
    slow('list', c.user);
    const dm = mine(c.user, d.dm);
    if (typeof d.on !== 'boolean') fail('Pinned is on or off.');
    if (d.on) {
      const have = db.get('SELECT pinned FROM dm_members WHERE dm = ? AND user = ?', dm, c.user)?.pinned;
      if (!have && db.get('SELECT COUNT(*) n FROM dm_members WHERE user = ? AND pinned IS NOT NULL', c.user).n >= MAX_PINNED) {
        fail(`You can pin up to ${MAX_PINNED} conversations. Unpin one first.`);
      }
      if (!have) db.run('UPDATE dm_members SET pinned = ?, hidden = NULL WHERE dm = ? AND user = ?', Date.now(), dm, c.user);
    } else db.run('UPDATE dm_members SET pinned = NULL WHERE dm = ? AND user = ?', dm, c.user);
    hub.sendDm(c.user, dm);
    return {};
  };

  // A new message brings a closed conversation back for everyone in it.
  ops['msg.send'] = ((base) => (c, d) => {
    const r = base(c, d);
    const conv = typeof d.conv === 'string' ? d.conv : '';
    if (conv.startsWith('d') || db.get('SELECT 1 FROM dms WHERE id = ?', conv)) {
      const hidden = db.all('SELECT user FROM dm_members WHERE dm = ? AND hidden = 1', conv).map((x) => x.user);
      if (hidden.length) {
        db.run('UPDATE dm_members SET hidden = NULL WHERE dm = ? AND hidden = 1', conv);
        for (const u of hidden) hub.sendDm(u, conv);
      }
    }
    return r;
  })(all['msg.send']);

  // ---------- Groups ----------
  ops['dm.rename'] = (c, d) => {
    slow('group', c.user);
    const dm = group(c.user, d.dm);
    let label = null;
    if (d.name !== null && d.name !== '') {
      if (typeof d.name !== 'string') fail('The name is missing.');
      // No control or direction-changing characters, as other names (server/ops.js str).
      label = d.name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().replace(/\s+/g, ' ');
      if (!label) fail('The name can’t be empty.');
      if ([...label].length > 40) fail('The name can be at most 40 characters.');
    }
    const before = db.get('SELECT name FROM dms WHERE id = ?', dm)?.name || null;
    if (before === label) return {};
    db.run('UPDATE dms SET name = ? WHERE id = ?', label, dm);
    line(dm, c.user, 'rename', { name: label });
    tellAll(dm);
    return {};
  };

  ops['dm.icon'] = (c, d) => {
    slow('group', c.user);
    const dm = group(c.user, d.dm);
    let emoji = null, hueV = null;
    if (d.emoji !== null && d.emoji !== undefined && d.emoji !== '') {
      if (typeof d.emoji !== 'string' || d.emoji.length > 16 || !EMOJI.test(d.emoji)) fail('The icon can be one emoji.');
      emoji = d.emoji;
      if (d.hue !== undefined && d.hue !== null) {
        if (!Number.isInteger(d.hue) || !HUE_SET.has(d.hue)) fail('Pick one of the colours.');
        hueV = d.hue;
      }
    }
    db.run('UPDATE dms SET icon = ?, icon_hue = ? WHERE id = ?', emoji, hueV, dm);
    line(dm, c.user, 'icon', {});
    tellAll(dm);
    return {};
  };

  // Who may be added: someone you may message, no block either way with
  // anyone already in it, and their message privacy allows you.
  function addable(user, target, already) {
    const row = M.userRow(target);
    if (!row) fail('That person doesn’t exist.');
    // The same rule as dm.open (server/safety.js): a friend, or someone you
    // share a house or an accepted conversation with. A conversation still
    // waiting on a message request doesn't count, so adding can't skip it.
    const friends = M.areFriends(user, target);
    const near = shareHouse(user, target) || shareDm(user, target);
    if (!friends && !near) fail('You can only add friends and people you share a house with.');
    for (const m of [user, ...already]) if (blockedEither(m, target)) fail(`You can’t add ${row.name}.`);
    let p;
    try { p = db.get('SELECT dm, requests FROM privacy WHERE user = ?', target); } catch { p = null; }
    if (p?.dm === 'friends' && !friends) fail(`${row.name} only takes messages from friends.`);
    if (p?.requests && !friends) fail(`${row.name} takes message requests only. Write to them first.`);
    return row;
  }

  ops['dm.add'] = (c, d) => {
    slow('group', c.user);
    const dm = mine(c.user, d.dm);
    const list = Array.isArray(d.users) ? [...new Set(d.users.map((u) => idOf(u, 'person')))] : fail('Pick someone to add.');
    const now0 = members(dm);
    const adding = list.filter((u) => !now0.includes(u));
    if (!adding.length) fail('Pick someone who isn’t here yet.');
    if (now0.length + adding.length > MAX_GROUP) fail(`A group can have up to ${MAX_GROUP} people.`);
    try { if (db.get('SELECT 1 FROM dm_requests WHERE dm = ? AND declined IS NULL', dm)) fail('Wait until your message request is accepted.'); } catch (e) { if (e.message.startsWith('Wait')) throw e; }
    for (const u of adding) addable(c.user, u, now0);
    const t = Date.now();
    if (!isGroup(dm)) {
      // A one-to-one conversation stays as it is: the new people start a new group.
      const all3 = [...now0, ...adding];
      const id = newId('d');
      db.tx(() => {
        db.run('INSERT INTO dms (id, name, created, owner) VALUES (?, NULL, ?, ?)', id, t, c.user);
        for (const u of [c.user, ...all3.filter((u) => u !== c.user)]) db.run('INSERT INTO dm_members (dm, user) VALUES (?, ?)', id, u);
      });
      line(id, c.user, 'add', { users: adding });
      tellAll(id);
      return { id, created: true };
    }
    db.tx(() => {
      for (const u of adding) {
        db.run('INSERT INTO dm_members (dm, user) VALUES (?, ?)', dm, u);
        // History is there to read, but none of it counts as unread.
        db.run('INSERT INTO reads (user, conv, ts) VALUES (?, ?, ?) ON CONFLICT (user, conv) DO UPDATE SET ts = excluded.ts', u, dm, t);
      }
    });
    line(dm, c.user, 'add', { users: adding });
    tellAll(dm);
    for (const u of adding) hub.sendSelf(u, { read: { [dm]: t } });
    return { id: dm };
  };

  // Out of a group: no more messages, no history, and the line says so.
  function remove(dm, user, by, act) {
    if (hub.voicePlaceOf?.(user) === dm) { try { hub.voiceLeave(user); } catch { /* already gone */ } }
    const owner = ownerOf(dm);
    db.tx(() => {
      db.run('DELETE FROM dm_members WHERE dm = ? AND user = ?', dm, user);
      db.run('DELETE FROM notify WHERE user = ? AND place = ?', user, dm);
      db.run('DELETE FROM reads WHERE user = ? AND conv = ?', user, dm);
      // The owner leaving hands the group to whoever has been in it longest.
      if (owner === user) db.run('UPDATE dms SET owner = (SELECT user FROM dm_members WHERE dm = ? ORDER BY rowid LIMIT 1) WHERE id = ?', dm, dm);
    });
    hub.toUser(user, 'dm.gone', { id: dm });
    if (!members(dm).length) return;
    line(dm, by, act, act === 'kick' ? { user } : {});
    tellAll(dm);
  }
  ops['dm.leave'] = (c, d) => {
    slow('group', c.user);
    const dm = group(c.user, d.dm);
    remove(dm, c.user, c.user, 'leave');
    return {};
  };
  ops['dm.kick'] = (c, d) => {
    slow('group', c.user);
    const dm = group(c.user, d.dm);
    const target = idOf(d.user, 'person');
    if (ownerOf(dm) !== c.user) fail('Only the group’s owner can remove people.');
    if (target === c.user) fail('To go, leave the group.');
    if (!M.inDm(dm, target)) fail('That person isn’t in this group.');
    remove(dm, target, c.user, 'kick');
    return {};
  };

  return ops;
}
