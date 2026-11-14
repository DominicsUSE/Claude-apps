// Text and messages, on the server.
//
// - msg.send learns silent messages ("@silent " or silent: true: unread, but
//   no sound and no push), replyPing: false (a reply that doesn't notify the
//   person replied to), per-file spoiler and alt text (checked, cleaned and run
//   through the house word filter), and @everyone/@here from someone who may
//   not post notices (stored as noPing, so no client ever lights it up).
// - cmd.roll: the server rolls the dice (crypto.randomInt) from the spec alone
//   and posts the result through msg.send, so timeouts, slowmode, blocks and
//   the word filter all apply. A roll can't be edited.
// - msg.peek: one message for a message link's quote card, only for someone
//   who can read its conversation (room overrides included). Missing and
//   forbidden get the same answer.
import { randomInt } from 'node:crypto';
import { limiter } from './auth.js';
import { everyonePing } from '../js/lib/account.js';
import { parseRoll, rollText, silentPrefix, ROLL_MAX_DICE, ROLL_MAX_SIDES } from '../js/lib/commands.js';

export const MAX_ALT = 1024;
const MSG_ID = /^m_[a-z0-9]{8,40}$/;
const ANY_ID = /^[\w:.-]{1,80}$/;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const NO_PEEK = 'You can’t see that message.';

// Columns on messages. Names and types are fixed here, never from input.
export function migrateChat(db) {
  for (const [column, type] of [
    ['silent', 'INTEGER'], // 1: no sound, no push
    ['reply_ping', 'INTEGER'], // 0: a reply that doesn't notify the person replied to
    ['noping', 'INTEGER'], // 1: @everyone/@here from someone who may not post notices
    ['cmd', 'TEXT'], // JSON: a command's result written by the server ({ roll })
  ]) {
    if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${type}`);
  }
}

export function createChatOps({ db, M, hub, fail, ops }) {
  const L = {
    'cmd.roll': limiter({ capacity: 5, perSecond: 1 / 3 }),
    'msg.peek': limiter({ capacity: 30, perSecond: 2 }),
  };
  hub.extraLimits = [...(hub.extraLimits || []), ...Object.values(L)];
  const slow = (name, user) => { if (!L[name].take(user)) fail('You’re going a little fast. Wait a moment and try again.'); };
  const convId = (v) => (typeof v === 'string' && ANY_ID.test(v) ? v : fail('That conversation isn’t valid.'));

  // What a send in progress carries, so the message event already has it.
  const pending = new Map();
  const baseView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseView(row, rx);
    const p = pending.get(row.id);
    if (row.silent || p?.silent) m.silent = true;
    if (row.reply_ping === 0 || p?.replyPing === false) m.replyPing = false;
    if (row.noping || p?.noPing) m.noPing = true;
    const cmd = row.cmd ? json(row.cmd, null) : p?.cmd;
    if (cmd) m.cmd = cmd;
    if (p?.files && Array.isArray(m.files)) m.files = m.files.map((f) => (p.files.has(f.id) ? { ...f, ...p.files.get(f.id) } : f));
    return m;
  };

  // A file's spoiler flag and description, checked.
  function fileExtras(user, conv, list) {
    const out = new Map();
    for (const f of (Array.isArray(list) ? list : []).slice(0, 6)) {
      if (!f || typeof f !== 'object' || typeof f.id !== 'string') continue;
      const x = {};
      if (f.spoiler !== undefined) {
        if (typeof f.spoiler !== 'boolean') fail('Spoiler is yes or no.');
        if (f.spoiler) x.spoiler = true;
      }
      if (f.alt !== undefined && f.alt !== null) {
        if (typeof f.alt !== 'string') fail('A description is text.');
        const alt = f.alt.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (alt.length > MAX_ALT) fail(`A description can be at most ${MAX_ALT} characters.`);
        if (alt) {
          // The same word filter as the message itself (a blocked word refuses the send).
          const flag = M.filterExtra?.(user, conv, alt);
          if (flag) x.flag = flag;
          x.alt = alt;
        }
      }
      if (Object.keys(x).length) out.set(f.id, x);
    }
    return out;
  }

  const baseSend = ops['msg.send'];
  const baseEdit = ops['msg.edit'];
  const sendWrapped = (c, d) => {
    if (!d || typeof d !== 'object') fail('That message isn’t valid.');
    if (typeof d.id === 'string' && M.msg(d.id)) return baseSend(c, d); // a retry: already landed
    const conv = typeof d.conv === 'string' ? d.conv : '';
    if (d.silent !== undefined && typeof d.silent !== 'boolean') fail('Silent is yes or no.');
    if (d.replyPing !== undefined && typeof d.replyPing !== 'boolean') fail('Reply mention is on or off.');
    let silent = d.silent === true;
    if (typeof d.text === 'string') {
      const sp = silentPrefix(d.text);
      if (sp.silent) { silent = true; d.text = sp.text; }
    }
    // Only checked once the conversation is known to be readable (the base op refuses otherwise).
    // A thread's first reply: the thread doesn't exist yet, so its room or conversation decides.
    const where = conv.startsWith('t:') && !M.thread(conv) ? (M.liveMsg(conv.slice(2))?.conv || '') : conv;
    const files = where && M.canRead(c.user, where) ? fileExtras(c.user, where, d.files) : new Map();
    const w = M.where(where);
    const house = w?.house || null;
    const noPing = !!house && typeof d.text === 'string' && !!everyonePing(d.text) && !M.can(c.user, house, 'announce');
    const mid = typeof d.id === 'string' ? d.id : '';
    const prev = pending.get(mid) || {};
    const p = { ...prev, silent, replyPing: d.replyPing === false && d.replyTo != null ? false : undefined, noPing, files };
    pending.set(mid, p);
    let r;
    try { r = baseSend(c, d); } finally { pending.delete(mid); }
    const row = r?.m?.id && M.msg(r.m.id);
    if (row) {
      const stored = json(row.files, null);
      const merged = stored && files.size ? stored.map((f) => {
        const x = files.get(f.id);
        if (!x) return f;
        const { flag, ...keep } = x;
        return { ...f, ...keep };
      }) : stored;
      db.run('UPDATE messages SET silent = ?, reply_ping = ?, noping = ?, cmd = ?, files = ? WHERE id = ?',
        p.silent ? 1 : null, p.replyPing === false ? 0 : null, p.noPing ? 1 : null, p.cmd ? JSON.stringify(p.cmd) : null,
        merged ? JSON.stringify(merged) : null, row.id);
      // A spoiler GIF never becomes anyone's favourite or a "recent" GIF.
      for (const [fid, x] of files) {
        if (!x.spoiler) continue;
        const fr = db.get('SELECT meta FROM files WHERE id = ?', fid);
        if (fr) db.run('UPDATE files SET meta = ? WHERE id = ?', JSON.stringify({ ...json(fr.meta, {}), spoiler: true }), fid);
      }
      for (const x of files.values()) if (x.flag) M.fileFlag?.({ house: x.flag.house, user: c.user, msg: row.id, conv, body: x.alt, note: `Image description. ${x.flag.note}` });
      return { ...r, m: M.withReactions([M.msg(row.id)])[0] };
    }
    return r;
  };

  const wrapped = {};
  if (baseSend) wrapped['msg.send'] = sendWrapped;
  if (baseEdit) {
    wrapped['msg.edit'] = (c, d) => {
      const before = typeof d?.id === 'string' ? M.liveMsg(d.id) : null;
      if (before?.cmd) fail('Dice rolls can’t be edited.');
      const r = baseEdit(c, d);
      // An edit that adds @everyone is held to the same rule as a send.
      const after = before && M.msg(before.id);
      if (after && after.text !== before.text) {
        const house = M.where(after.conv)?.house;
        const noPing = !!house && !!everyonePing(after.text) && !M.can(c.user, house, 'announce');
        if (!!after.noping !== noPing) {
          db.run('UPDATE messages SET noping = ? WHERE id = ?', noPing ? 1 : null, after.id);
          const [m] = M.withReactions([M.msg(after.id)]);
          const t = after.conv.startsWith('t:') ? M.thread(after.conv) : null;
          hub.toConv(after.conv, 'msg', { conv: after.conv, m, user: hub.userView(after.author), thread: t ? { id: t.id, conv: t.conv, root: t.root } : undefined });
        }
      }
      return r;
    };
  }

  return {
    ...wrapped,

    // /roll [NdM]. The client sends only the spec; the numbers are the server's.
    'cmd.roll'(c, d) {
      const conv = convId(d.conv);
      const mid = typeof d.id === 'string' && MSG_ID.test(d.id) ? d.id : fail('That message id isn’t valid.');
      const existing = M.msg(mid);
      if (existing) {
        if (existing.author !== c.user || existing.conv !== conv || !existing.cmd) fail('That message id is already taken.');
        return { m: M.withReactions([existing])[0] };
      }
      if (d.spec !== undefined && typeof d.spec !== 'string') fail('Roll like /roll 2d6.');
      const spec = parseRoll(d.spec) || fail(`Roll like /roll 2d6: up to ${ROLL_MAX_DICE} dice, each with 2 to ${ROLL_MAX_SIDES} sides.`);
      slow('cmd.roll', c.user);
      const rolls = Array.from({ length: spec.n }, () => randomInt(1, spec.sides + 1));
      const total = rolls.reduce((a, b) => a + b, 0);
      pending.set(mid, { cmd: { roll: { n: spec.n, sides: spec.sides, rolls, total } } });
      try {
        return ops['msg.send'](c, { conv, id: mid, text: rollText(spec, rolls) });
      } finally { pending.delete(mid); }
    },

    // One message for a message link's card.
    'msg.peek'(c, d) {
      slow('msg.peek', c.user);
      const conv = typeof d?.conv === 'string' && ANY_ID.test(d.conv) ? d.conv : null;
      const row = conv && typeof d.id === 'string' && ANY_ID.test(d.id) ? M.liveMsg(d.id) : null;
      if (!row || row.conv !== conv || !M.canRead(c.user, conv)) fail(NO_PEEK);
      const [m] = M.withReactions([row]);
      const t = conv.startsWith('t:') ? M.thread(conv) : null;
      return { conv, m, user: hub.userView(row.author), thread: t ? { conv: t.conv, root: t.root } : undefined };
    },
  };
}
