// End-to-end encrypted conversations, on the server (the v0.12 e2ee spec,
// sections 7, 8, 10, 15 and 16). The key directory is in server/e2ee.js; this
// is what changes for a direct conversation or group once it is encrypted.
//
// The server never sees a message key. For a conversation whose DM has
// e2ee = 1 it:
// - refuses plain text (a stale tab, an old bundle, a downgrade attempt);
// - checks each envelope: its header names this conversation, place, message
//   and author, the sending socket is bound to the device that signed it, the
//   signature checks out, and the key was sealed to exactly the current
//   members' trusted devices and history keys (else e2ee_stale, so the client
//   fetches newer keys and seals again with the same message id);
// - stores the envelope with no text, and one row per sealed key ("wrap");
// - hands each socket only its own device's wraps and its own history wraps;
// - keeps doing what it can without the text: declared mentions ("ping")
//   drive notifications, push says "New message", search skips these rows,
//   and features that need plaintext on the server (polls, /roll, server-side
//   forwarding, link previews) are off there.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canon, parseCanon } from '../js/lib/e2ee/canon.js';
import { b64u, b64uOf } from '../js/lib/e2ee/bytes.js';
import { envelopeProblem, CAPS } from '../js/lib/e2ee/envelope.js';
import { requiredSet, checkRecipients, wrapKeys, editSet } from '../js/lib/e2ee/rules.js';
import { newId, now } from './model.js';

const P = 'snug-e2ee-v1/';
const SKEW = 10 * 60_000;
const WRAP_BYTES = 80;
export const RELOAD = 'This conversation is end-to-end encrypted. Reload Snug to send here.';
export const NOT_READY = (name) => `${name} needs to open an up-to-date Snug and turn on end-to-end encryption once before joining an encrypted group.`;
const sha256 = (s) => createHash('sha256').update(s).digest();
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };

// What the server still sees of end-to-end encrypted DMs and groups (0.14): the one list, served
// by GET /api/privacy (server/privacy.js facts) and repeated in the README (tests check both).
export const SERVER_SEES = [
  { id: 'who', text: 'Who wrote each message, and in which conversation' },
  { id: 'when', text: 'When each message was sent, edited or deleted' },
  { id: 'sizes', text: 'Roughly how long each message is and how big each file is (both padded to size steps)' },
  { id: 'members', text: 'Who is in each DM and group, who added or removed whom, and who owns a group' },
  { id: 'info', text: 'That someone renamed a group or changed its icon (not the new name or icon)' },
  { id: 'mentions', text: 'Who a message mentions or notifies about a reply, so they get a notification' },
  { id: 'threads', text: 'Which message a thread hangs off' },
  { id: 'side', text: 'That someone reacted to a message, voted in a poll or ended one, and when (not the emoji, the vote or the poll)' },
  { id: 'reads', text: 'How far each person has read' },
  { id: 'typing', text: 'Who is typing (unless typing notes are off)' },
  { id: 'presence', text: 'Who is online, and their status' },
  { id: 'pins', text: 'Which messages are pinned or saved' },
  { id: 'devices', text: 'Each account’s devices, their names and when they were last used' },
  { id: 'ips', text: 'Your IP address while you’re connected, and your sign-in history' },
  { id: 'gifs', text: 'GIF searches, which go through the server' },
  { id: 'calls', text: 'Calls: who called, when, who joined, and the connection set-up between devices' },
  { id: 'rooms', text: 'Everything in house rooms: rooms aren’t end-to-end encrypted' },
];

export function createE2eeConv({ db, M, hub, fail, ops: all, on, verifyEd, account, deviceRow, capable = () => false, lacking = () => [] }) {
  const ops = {};
  const hasRemote = db.all('PRAGMA table_info(users)').some((c) => c.name === 'remote');
  const members = (dm) => db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', dm).map((r) => r.user);
  const nameOf = (u) => M.userRow(u)?.name || 'Someone';
  const encEnv = (s) => { const e = parseCanon(s, 128 * 1024); return e && !envelopeProblem(e) ? e : null; };

  // ---------- which conversations are encrypted ----------
  // The DM a conversation lives in (itself, or the DM a thread hangs off; a
  // thread's first reply names a root message whose conversation decides).
  function rootOf(conv) {
    if (typeof conv !== 'string') return null;
    if (conv.startsWith('t:') && !M.thread(conv)) conv = M.liveMsg(conv.slice(2))?.conv || '';
    const w = M.where(conv);
    return w && !w.house && w.dm ? w.dm : null;
  }
  const dmRow = (dm) => db.get('SELECT e2ee, e2ee_since FROM dms WHERE id = ?', dm);
  const since = new Map(); // conv -> e2ee_since of its DM (null: not encrypted); cleared on upgrade
  function sinceOf(conv) {
    if (since.has(conv)) return since.get(conv);
    const dm = rootOf(conv);
    if (!dm) { if (M.where(conv)) since.set(conv, null); return null; }
    const r = dmRow(dm);
    const v = r?.e2ee === 1 ? r.e2ee_since : null;
    since.set(conv, v);
    return v;
  }
  const encrypted = (conv) => sinceOf(conv) != null;
  // Ready: account keys and at least one trusted device with a live prekey.
  const ready = (u) => !!account(u) && !!db.get(`SELECT 1 FROM e2ee_devices d JOIN e2ee_prekeys p ON p.device = d.id AND p.retired IS NULL
    WHERE d.user = ? AND d.state = 'trusted' LIMIT 1`, u);
  const isRemote = (u) => hasRemote && !!db.get('SELECT 1 FROM users WHERE id = ? AND remote = 1', u);
  // A DM can be encrypted unless someone in it is on another PC (P2P keeps its own transport).
  const eligible = (dm) => { const m = members(dm); return m.length >= 2 && !m.some(isRemote) && !hub.isRemoteDm?.(dm); };

  // Turns a DM encrypted when everyone in it is ready (one way: never back).
  function upgrade(dm) {
    if (!on || !dm) return false;
    const r = dmRow(dm);
    if (!r || r.e2ee === 1 || !eligible(dm) || !members(dm).every(ready)) return false;
    const legacy = !!db.get('SELECT 1 FROM messages WHERE (conv = ? OR conv IN (SELECT id FROM threads WHERE conv = ?)) AND sys IS NULL AND deleted IS NULL LIMIT 1', dm, dm);
    const mid = newId('m');
    const by = members(dm)[0];
    db.tx(() => {
      const next = (db.get('SELECT COALESCE(MAX(seq), 0) n FROM messages').n || 0) + 1;
      db.run('UPDATE dms SET e2ee = 1, e2ee_since = ? WHERE id = ?', next, dm);
      const text = 'Messages are end-to-end encrypted from here on.';
      db.run('INSERT INTO messages (id, conv, author, ts, text, fold, sys) VALUES (?, ?, ?, ?, ?, ?, ?)',
        mid, dm, by, now(), text, '', JSON.stringify({ kind: 'dm', act: 'e2ee', by, ...(legacy ? { legacy: true } : {}) }));
    });
    since.clear();
    const [m] = M.withReactions([M.msg(mid)]);
    hub.toConv(dm, 'msg', { conv: dm, m, user: hub.userView(by) });
    for (const u of members(dm)) hub.sendDm(u, dm);
    return true;
  }
  // When someone becomes ready, every eligible DM they're in may upgrade.
  function readyChanged(u) {
    if (!on || !ready(u)) return;
    for (const r of db.all('SELECT d.id FROM dms d JOIN dm_members m ON m.dm = d.id WHERE m.user = ? AND d.e2ee IS NULL', u)) upgrade(r.id);
  }

  // ---------- views ----------
  const baseDmView = M.dmView;
  M.dmView = (id, viewer) => {
    const v = baseDmView(id, viewer);
    if (!v) return v;
    const r = dmRow(id);
    if (r?.e2ee === 1) { v.e2ee = true; v.e2eeSince = r.e2ee_since; }
    return v;
  };
  // An encrypted row carries its envelope and no text; rows from before the
  // conversation was encrypted are marked legacy (stored readable here).
  const baseMsgView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseMsgView(row, rx);
    if (row.enc) {
      const e = encEnv(row.enc);
      if (e) m.e2ee = e;
      m.text = '';
      const side = sideOf(row.id);
      if (side.length) m.side = side; // 0.14: sealed reactions and poll votes (opaque here)
      return m;
    }
    if (!row.sys) { const s = sinceOf(row.conv); if (s != null && row.seq < s) m.legacy = true; }
    return m;
  };
  // Server search can't read these rows (their fold is empty); filters such as from: still skip them.
  const baseSearch = M.search;
  M.search = (...a) => { const all = baseSearch(...a); const hits = all.filter((h) => !h.m.e2ee); if (all.close) hits.close = true; return hits; }; // keeps 0.12's close-match flag
  // A declared mention (the header's ping list) counts as a mention for notifications.
  M.pinged = (user, row) => !!row?.ping && json(row.ping, []).includes(user);

  // ---------- wraps: each socket gets its own ----------
  const historyTarget = (u) => `a:${u}:`;
  // A socket bound to no device gets nothing (it can't prove it holds any key), and only a trusted
  // device gets its account's history wraps: a device still waiting to be added, or one being
  // removed, holds no history key it should use (review H3).
  const trustedDevice = (user, device) => { const r = device && deviceRow(device); return !!r && r.user === user && r.state === 'trusted'; };
  function wrapsFor(user, device, msg, rev) {
    if (!trustedDevice(user, device)) return {};
    const pre = historyTarget(user);
    const out = {};
    for (const w of db.all('SELECT target, wrap FROM e2ee_wraps WHERE msg = ? AND rev = ? AND (target = ? OR substr(target, 1, ?) = ?)',
      msg, rev, `d:${device}`, pre.length, pre)) out[w.target] = w.wrap;
    return out;
  }
  const prevView = hub.socketView;
  hub.socketView = (ws, ev, d) => {
    const v = prevView ? prevView(ws, ev, d) : d;
    if (ev === 'sched' && Array.isArray(v?.list) && ws.user) return { ...v, list: v.list.map((x) => (x?.m?.e2ee ? { ...x, m: { ...x.m, k: schedWraps(ws.user, ws.e2eeDevice, x.id) } } : x)) };
    if (ev === 'e2ee.side' && v?.e2ee && ws.user) return { ...v, k: wrapsFor(ws.user, ws.e2eeDevice, v.e2ee.h.id, v.e2ee.h.rev) };
    if (ev === 'dm' && v?.dm?.info?.e2ee && ws.user) {
      const h = v.dm.info.e2ee.h;
      return { ...v, dm: { ...v.dm, info: { ...v.dm.info, k: wrapsFor(ws.user, ws.e2eeDevice, h.id, h.rev) } } };
    }
    if (ev !== 'msg' || !v?.m?.e2ee || !ws.user) return v;
    const k = wrapsFor(ws.user, ws.e2eeDevice, v.m.id, v.m.e2ee.h.rev);
    return Object.keys(k).length ? { ...v, m: { ...v.m, k } } : v;
  };

  // ---------- checking an envelope ----------
  function recipientState(users) {
    const accounts = {}, devices = [], prekeys = [];
    for (const u of users) {
      const a = account(u);
      if (a) accounts[u] = { hist: !!a.hist, epoch: a.epoch };
      for (const d of db.all("SELECT id, user, state FROM e2ee_devices WHERE user = ? AND state = 'trusted'", u)) {
        devices.push(d);
        for (const p of db.all('SELECT device, kid, retired FROM e2ee_prekeys WHERE device = ?', d.id)) prekeys.push(p);
      }
    }
    return { accounts, devices, prekeys };
  }
  const stale = (users) => fail('Someone’s encryption keys changed. Snug is sealing it again.', {
    code: 'e2ee_stale', data: { users: Object.fromEntries(users.map((u) => [u, { ver: account(u)?.ver || 0 }])) },
  });
  /**
   * The checks of spec 7.4 for one envelope. kind: msg | edit | sched; users: who it must be sealed to.
   * sched: sent by the server later, so no bound socket (the device must still be trusted).
   */
  function checkEnvelope(c, e2ee, { dm, place, id, kind, rev, users, replyTo = null, sched = false }) {
    if (!e2ee || typeof e2ee !== 'object' || Array.isArray(e2ee)) fail(RELOAD);
    let size;
    try { size = Buffer.byteLength(canon(e2ee)); } catch { fail('That encrypted message isn’t valid.'); }
    if (size > CAPS.total) fail('That encrypted message is too large.');
    const env = { h: e2ee.h, n: e2ee.n, c: e2ee.c, sig: e2ee.sig };
    const why = envelopeProblem(env);
    if (why) fail(`That encrypted message isn’t valid (${why}).`);
    const { h } = env;
    if (h.conv !== dm || h.place !== place || h.id !== id || h.kind !== kind || h.rev !== rev) fail('That encrypted message doesn’t match where it was sent.');
    if (h.from.u !== c.user) fail('That encrypted message names someone else as its author.');
    const dev = deviceRow(h.from.d);
    if (!dev || dev.user !== c.user || dev.state !== 'trusted') fail('That encrypted message was sealed on a device your account doesn’t trust.');
    if (!sched && c.ws?.e2eeDevice !== dev.id) fail('Send encrypted messages from the device that sealed them. Reload Snug and try again.');
    if (Math.abs(h.ts - Date.now()) > SKEW) fail('This device’s clock is off by more than ten minutes. Fix the clock and try again.');
    if (kind !== 'edit' && h.re !== (replyTo ?? null)) fail('That encrypted message doesn’t match where it was sent.');
    const mem = new Set(members(dm));
    if (new Set(h.ping).size !== h.ping.length || h.ping.some((u) => !mem.has(u))) fail('A mention in that message isn’t someone in this conversation.');
    const hh = sha256(`${P}hdr\n${canon(h)}`);
    if (!verifyEd(dev.dsk, env.sig, `${P}env\n${b64u(hh)}\n${env.n}\n${b64u(sha256(Buffer.from(b64uOf(env.c))))}`)) fail('That encrypted message’s signature doesn’t check out.');
    const req = requiredSet({ members: users, ...recipientState(users), now: Date.now() });
    if (req.missing.length) stale(req.missing);
    const check = checkRecipients(req, h.to, h.ar);
    if (!check.ok) stale(check.users.length ? check.users : users);
    const k = e2ee.k;
    if (!k || typeof k !== 'object' || Array.isArray(k)) fail('That encrypted message has no keys.');
    const want = wrapKeys(h.to, h.ar).sort();
    if (canon(Object.keys(k).sort()) !== canon(want) || want.some((t) => b64uOf(k[t])?.length !== WRAP_BYTES)) fail('That encrypted message’s keys don’t match its recipients.');
    return { env, k, h };
  }
  function insertWraps(id, h, k) {
    const kids = new Map(h.to.map(([, d, kid]) => [`d:${d}`, kid]));
    for (const [target, wrap] of Object.entries(k)) {
      db.run('INSERT OR REPLACE INTO e2ee_wraps (msg, rev, target, kid, wrap) VALUES (?, ?, ?, ?, ?)', id, h.rev, target, kids.get(target) ?? null, wrap);
    }
  }

  // ---------- sending ----------
  // The core insert (server/ops.js msg.send) calls this inside its transaction,
  // so every wrapper after it, push included, sees the stored envelope.
  const pending = new Map();
  M.onMsgInsert = (mid) => {
    const v = pending.get(mid);
    if (!v) return;
    db.run("UPDATE messages SET enc = ?, ping = ?, fold = '', files = ? WHERE id = ?",
      canon(v.env), v.h.ping.length ? JSON.stringify(v.h.ping) : null, v.files.length ? JSON.stringify(v.files) : null, mid);
    insertWraps(mid, v.h, v.k);
  };
  function encFiles(c, conv, list) {
    const out = [];
    for (const f of (Array.isArray(list) ? list : []).slice(0, 6)) {
      const row = typeof f?.id === 'string' && db.get('SELECT * FROM files WHERE id = ? AND owner = ? AND conv = ?', f.id, c.user, conv);
      if (!row) fail('One of the attachments didn’t finish uploading. Remove it and attach it again.');
      if (!row.enc) fail('Attachments here are encrypted on your device first. Reload Snug and attach it again.');
      out.push({ id: row.id, enc: 1, kind: 'file', size: row.size });
    }
    return out;
  }
  const baseSend = all['msg.send'];
  ops['msg.send'] = (c, d) => {
    const conv = typeof d?.conv === 'string' ? d.conv : '';
    const dm = d && typeof d === 'object' ? rootOf(conv) : null;
    if (!dm || !encrypted(conv)) {
      if (d?.e2ee !== undefined) fail('This conversation isn’t end-to-end encrypted. Reload Snug.');
      return baseSend(c, d);
    }
    if (typeof d.id === 'string' && M.msg(d.id)) return baseSend(c, d); // a retry: the first copy landed
    if (d.e2ee == null || (typeof d.text === 'string' && d.text !== '')) fail(RELOAD);
    const replyTo = d.replyTo ?? null;
    // 0.14: where every device can read it, the message replied to is inside the sealed body.
    if (replyTo != null && capable(members(dm), 're')) fail(UPDATE('Replies in this conversation are encrypted'));
    // An encrypted poll: everyone's devices must count votes themselves (server/e2ee-conv.js side blobs).
    if (d.poll !== undefined) {
      if (d.poll !== true) fail('That poll isn’t valid.');
      if (!capable(members(dm), 'poll')) fail(oldDevices('Encrypted polls need everyone here on Snug 0.14 or later', lacking(members(dm), 'poll')), { code: 'e2ee_old_devices' });
    }
    const v = checkEnvelope(c, d.e2ee, { dm, place: conv, id: d.id, kind: 'msg', rev: 0, users: members(dm), replyTo });
    v.files = encFiles(c, conv, d.files);
    const inner = { conv, id: d.id, text: '', files: v.files.map((f) => ({ id: f.id })), ...(replyTo ? { replyTo } : {}) };
    if (d.silent !== undefined) inner.silent = d.silent;
    if (d.replyPing !== undefined) inner.replyPing = d.replyPing;
    M.emptyOk?.add(inner);
    pending.set(d.id, v);
    try { return baseSend(c, inner); } finally { pending.delete(d.id); }
  };

  // Edits: a new envelope (rev + 1) sealed to the original recipients still
  // here; the previous one moves to the edit history with its wraps.
  const MAX_EDITS = 10;
  const baseEdit = all['msg.edit'];
  ops['msg.edit'] = (c, d) => {
    const conv = typeof d?.conv === 'string' ? d.conv : '';
    const dm = rootOf(conv);
    if (!dm || !encrypted(conv)) {
      if (d?.e2ee !== undefined) fail('This conversation isn’t end-to-end encrypted. Reload Snug.');
      return baseEdit(c, d);
    }
    if (!M.canRead(c.user, conv)) fail('You don’t have access to this conversation.');
    const row = typeof d.id === 'string' && M.liveMsg(d.id);
    if (!row || row.conv !== conv) fail('That message was deleted.');
    if (row.author !== c.user) fail('You can only edit your own messages.');
    if (d.e2ee == null || (typeof d.text === 'string' && d.text !== '')) fail(RELOAD);
    const old = encEnv(row.enc) || fail('Messages from before encryption was turned on can’t be edited here. Delete it and send it again.');
    const users = editSet(old.h.to, members(dm));
    const v = checkEnvelope(c, d.e2ee, { dm, place: conv, id: row.id, kind: 'edit', rev: old.h.rev + 1, users });
    db.tx(() => {
      db.run('INSERT INTO msg_edits (msg, text, ts, enc, rev) VALUES (?, ?, ?, ?, ?)', row.id, '', row.edited || row.ts, row.enc, old.h.rev);
      db.run(`DELETE FROM msg_edits WHERE msg = ? AND rowid NOT IN (SELECT rowid FROM msg_edits WHERE msg = ? ORDER BY ts DESC, rowid DESC LIMIT ${MAX_EDITS})`, row.id, row.id);
      db.run('DELETE FROM e2ee_wraps WHERE msg = ? AND rev != ? AND rev NOT IN (SELECT rev FROM msg_edits WHERE msg = ? AND rev IS NOT NULL)', row.id, v.h.rev, row.id);
      db.run('UPDATE messages SET enc = ?, ping = ? WHERE id = ?', canon(v.env), v.h.ping.length ? JSON.stringify(v.h.ping) : null, row.id);
      insertWraps(row.id, v.h, v.k);
    });
    // The rest of the edit (edited time, the event to everyone) is the ordinary one.
    return baseEdit(c, { conv, id: row.id, text: '' });
  };
  const baseEdits = all['msg.edits'];
  if (baseEdits) {
    ops['msg.edits'] = (c, d) => {
      const r = baseEdits(c, d);
      const row = typeof d?.id === 'string' && M.liveMsg(d.id);
      if (!row?.enc) return r;
      const edits = db.all('SELECT enc, ts FROM msg_edits WHERE msg = ? AND enc IS NOT NULL ORDER BY ts DESC, rowid DESC LIMIT ?', row.id, MAX_EDITS)
        .map((e) => ({ id: row.id, author: row.author, e2ee: encEnv(e.enc), ts: e.ts, ...(row.reply_to ? { replyTo: row.reply_to } : {}) })).filter((e) => e.e2ee);
      return { current: { id: row.id, author: row.author, e2ee: encEnv(row.enc), ts: row.edited || row.ts, ...(row.reply_to ? { replyTo: row.reply_to } : {}) }, edits };
    };
  }

  // The wraps for messages fetched any other way (history, snapshot, search, mentions, pins, saved,
  // edit history): only conversations the caller can read, only its bound device and its own history keys.
  // Answered per revision in `revs` ("id:rev"); `wraps` (by id, the last revision asked for) stays
  // for clients that read it. The caller's own scheduled messages (not sent yet) are answered too.
  ops['e2ee.wraps'] = (c, d) => {
    if (!Array.isArray(d?.ids) || d.ids.length > 200) fail('Ask for up to 200 messages at a time.');
    const out = {}, revs = {};
    let mine = null;
    for (const x of d.ids) {
      const id = typeof x === 'string' ? x : x?.id;
      if (typeof id !== 'string') continue;
      if (/^(react|vote|end|info):/.test(id)) {
        const k = sideKey(c.user, id);
        if (k) { const rev = Number.isSafeInteger(x?.rev) ? x.rev : k.rev; revs[`${id}:${rev}`] = out[id] = { rev, k: wrapsFor(c.user, c.ws?.e2eeDevice || null, id, rev) }; }
        continue;
      }
      const row = M.msg(id);
      if (!row) {
        mine ||= new Map(db.all('SELECT id, enc FROM scheduled WHERE user = ? AND enc IS NOT NULL', c.user).map((r) => [parseCanon(r.enc, 256 * 1024)?.env?.h?.id, r.id]));
        if (mine.has(id)) revs[`${id}:0`] = out[id] = { rev: 0, k: schedWraps(c.user, c.ws?.e2eeDevice || null, mine.get(id)) };
        continue;
      }
      if (!row.enc || row.deleted || !M.canRead(c.user, row.conv)) continue;
      const rev = Number.isSafeInteger(x?.rev) ? x.rev : encEnv(row.enc)?.h.rev ?? 0;
      revs[`${id}:${rev}`] = out[id] = { rev, k: wrapsFor(c.user, c.ws?.e2eeDevice || null, id, rev) };
    }
    return { wraps: out, revs };
  };

  // ---------- features that need plaintext on the server ----------
  const refuseIn = (name, why, convOf = (d) => d?.conv) => {
    const base = all[name];
    if (!base) return;
    ops[name] = (c, d) => { if (encrypted(convOf(d))) fail(why); return base(c, d); };
  };
  refuseIn('poll.create', 'Polls aren’t available in encrypted conversations on this version. Update Snug to start an encrypted poll.'); // 0.14 seals them (msg.send poll)
  refuseIn('cmd.roll', '/roll isn’t available in encrypted conversations: a fair roll needs the server to see the result.');
  refuseIn('sticker.send', 'Stickers here are encrypted on your device first. Reload Snug and send it again.');
  const baseForward = all['msg.forward'];
  if (baseForward) {
    ops['msg.forward'] = (c, d) => {
      const src = typeof d?.id === 'string' ? M.msg(d.id) : null;
      if (src?.enc || encrypted(d?.to)) fail('Encrypted messages are forwarded from your device. Reload Snug and try again.');
      return baseForward(c, d);
    };
  }


  // ---------- 0.14: sealed reactions, poll votes, private room information ----------
  // Each is an envelope like a message's (js/lib/e2ee/envelope.js kinds react, vote, info), sealed
  // to the members' devices and history keys and signed by the sending device. The server keeps one
  // per message, person and slot (react, vote, end), or one per group (info), with its wraps, and
  // relays it; it can't read any of them. A newer revision replaces the older one (rev only goes up).
  // A feature is used in a conversation once every device of every member signed for it (capable).
  const UPDATE = (what) => `${what}. Update Snug to do this here.`;
  const oldDevices = (what, list) => {
    const named = list.slice(0, 5).map((x) => `${nameOf(x.user)}’s ${x.label}`);
    return `${what}. Still on an older Snug: ${named.join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}.`;
  };
  const SLOTS = { react: 'react', vote: 'vote', end: 'vote' }; // slot -> envelope kind
  function sideOf(msg) {
    return db.all('SELECT user, slot, env FROM e2ee_side WHERE msg = ? ORDER BY user, slot', msg)
      .map((r) => ({ user: r.user, slot: r.slot, e2ee: encEnv(r.env) })).filter((x) => x.e2ee);
  }
  // A wrap request for a side blob or a group's information: only for someone who can read it.
  function sideKey(user, id) {
    const [slot, a, ...rest] = id.split(':');
    if (slot === 'info') {
      const r = a && rest.length === 0 && db.get('SELECT info_rev FROM dms WHERE id = ? AND info_enc IS NOT NULL', a);
      return r && M.inDm(a, user) ? { rev: r.info_rev } : null;
    }
    const r = db.get('SELECT rev, msg FROM e2ee_side WHERE msg = ? AND user = ? AND slot = ?', a, rest.join(':'), slot);
    const row = r && M.liveMsg(r.msg);
    return row && M.canRead(user, row.conv) ? { rev: r.rev } : null;
  }
  function replaceWraps(key, h, k) {
    db.run('DELETE FROM e2ee_wraps WHERE msg = ?', key);
    insertWraps(key, h, k);
  }
  ops['e2ee.side'] = (c, d) => {
    const conv = typeof d?.conv === 'string' ? d.conv : '';
    const dm = rootOf(conv);
    if (!dm || !encrypted(conv)) fail('This conversation isn’t end-to-end encrypted. Reload Snug.');
    if (!M.canRead(c.user, conv)) fail('You don’t have access to this conversation.');
    const row = typeof d.msg === 'string' && M.liveMsg(d.msg);
    if (!row || row.conv !== conv) fail('That message was deleted.');
    if (!row.enc) fail('Messages from before encryption was turned on can’t take encrypted reactions or votes.');
    const slot = Object.hasOwn(SLOTS, d.slot) ? d.slot : fail('That isn’t valid.');
    const gate = M.postGate(c.user, dm);
    if (!gate.ok) fail(gate.why);
    if (slot === 'end' && row.author !== c.user) fail('Only the person who started the poll can end it.');
    const key = `${slot}:${row.id}:${c.user}`;
    const prev = db.get('SELECT rev FROM e2ee_side WHERE msg = ? AND user = ? AND slot = ?', row.id, c.user, slot);
    const rev = d.e2ee?.h?.rev;
    if (!Number.isSafeInteger(rev) || rev <= (prev?.rev ?? -1)) fail('That was changed on another device. Snug is trying again.', { code: 'e2ee_side_rev', data: { rev: prev?.rev ?? -1 } });
    const v = checkEnvelope(c, d.e2ee, { dm, place: conv, id: key, kind: SLOTS[slot], rev, users: members(dm) });
    if (v.h.ping.length) fail('That encrypted reaction isn’t valid.');
    db.tx(() => {
      db.run('INSERT OR REPLACE INTO e2ee_side (msg, user, slot, rev, env) VALUES (?, ?, ?, ?, ?)', row.id, c.user, slot, rev, canon(v.env));
      replaceWraps(key, v.h, v.k);
    });
    hub.toConv(conv, 'e2ee.side', { conv, msg: row.id, user: c.user, slot, e2ee: v.env });
    return { rev };
  };
  // A plain reaction where every device can seal one is refused (a stale tab, an older Snug): taking
  // one back is still fine, it says nothing new.
  const baseReact = all.react;
  if (baseReact) {
    ops.react = (c, d) => {
      const conv = typeof d?.conv === 'string' ? d.conv : '';
      const dm = rootOf(conv);
      // Rows from before the conversation turned encrypted keep plain reactions (they have no envelope).
      if (dm && encrypted(conv) && d.on !== false && (typeof d.id === 'string' && M.liveMsg(d.id)?.enc) && capable(members(dm), 'react')) fail('Reactions in this conversation are encrypted. Update Snug to react here.');
      return baseReact(c, d);
    };
  }

  // A group's name, icon and hue, sealed (kind info). The server keeps no name for it; older Snug
  // shows "Encrypted group". Lines in the conversation say who changed what, never the new name.
  const INFO_LABEL = 'Encrypted group';
  const infoOf = (dm) => { const r = db.get('SELECT info_enc, info_rev FROM dms WHERE id = ?', dm); const e = r?.info_enc ? encEnv(r.info_enc) : null; return e ? { e2ee: e, rev: r.info_rev } : null; };
  const dmView2 = M.dmView;
  M.dmView = (id, viewer) => {
    const v = dmView2(id, viewer);
    if (!v) return v;
    const info = infoOf(id);
    if (info) { v.info = { e2ee: info.e2ee }; v.name = INFO_LABEL; delete v.icon; }
    return v;
  };
  const infoLine = (dm, by, what) => {
    const mid = newId('m');
    const text = what === 'icon' ? `${nameOf(by)} changed the group’s icon` : `${nameOf(by)} renamed the group`;
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, sys) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, dm, by, now(), text, '', JSON.stringify({ kind: 'dm', act: what === 'icon' ? 'icon' : 'info', by, enc: true }));
    const [m] = M.withReactions([M.msg(mid)]);
    hub.toConv(dm, 'msg', { conv: dm, m, user: hub.userView(by) });
  };
  // A group named before 0.14: its earlier rename lines name it. Sealing it the first time takes the name
  // out of them ("Ada renamed the group", as a sealed rename reads), and out of the search index with them.
  function scrubNames(dm) {
    for (const r of db.all("SELECT id, text, sys FROM messages WHERE conv = ? AND sys LIKE '%\"act\":\"rename\"%'", dm)) {
      let x;
      try { x = JSON.parse(r.sys); } catch { continue; }
      if (x?.kind !== 'dm' || x.act !== 'rename' || !x.name) continue;
      const tail = ` named the group ${x.name}`;
      const text = `${r.text.endsWith(tail) ? r.text.slice(0, -tail.length) : nameOf(x.by)} renamed the group`;
      db.run('UPDATE messages SET text = ?, fold = ?, sys = ? WHERE id = ?', text, '', JSON.stringify({ kind: 'dm', act: 'info', by: x.by, enc: true }), r.id);
    }
  }
  ops['e2ee.info'] = (c, d) => {
    const dm = typeof d?.dm === 'string' ? d.dm : '';
    if (!db.get('SELECT 1 FROM dms WHERE id = ?', dm) || !M.inDm(dm, c.user)) fail('You’re not in that conversation.');
    if (!encrypted(dm)) fail('This conversation isn’t end-to-end encrypted. Reload Snug.');
    if (!M.isGroupDm?.(dm)) fail('That’s a conversation between two people. Add someone to start a group.');
    const users = members(dm);
    if (!capable(users, 'info')) fail(oldDevices('A private group name needs everyone here on Snug 0.14 or later', lacking(users, 'info')), { code: 'e2ee_old_devices' });
    const what = ['name', 'icon', 'members'].includes(d.what) ? d.what : fail('That isn’t valid.');
    const was = db.get('SELECT info_rev, info_enc FROM dms WHERE id = ?', dm);
    const prev = was?.info_rev ?? -1;
    const rev = d.e2ee?.h?.rev;
    if (!Number.isSafeInteger(rev) || rev <= prev) fail('The group was changed on another device. Snug is trying again.', { code: 'e2ee_side_rev', data: { rev: prev } });
    const key = `info:${dm}`;
    const v = checkEnvelope(c, d.e2ee, { dm, place: dm, id: key, kind: 'info', rev, users });
    if (v.h.ping.length) fail('That isn’t valid.');
    db.tx(() => {
      // The readable name and icon go: from now on only members' devices know them.
      db.run('UPDATE dms SET info_enc = ?, info_rev = ?, name = NULL, icon = NULL, icon_hue = NULL WHERE id = ?', canon(v.env), rev, dm);
      replaceWraps(key, v.h, v.k);
      if (!was?.info_enc) scrubNames(dm);
    });
    if (what !== 'members') infoLine(dm, c.user, what);
    for (const u of users) hub.sendDm(u, dm);
    return { rev };
  };
  // Once a group's information is sealed, a plain rename or icon change (an older Snug) is refused.
  for (const name of ['dm.rename', 'dm.icon']) {
    const base = all[name];
    if (!base) continue;
    ops[name] = (c, d) => {
      const dm = typeof d?.dm === 'string' ? d.dm : '';
      if (encrypted(dm) && (infoOf(dm) || capable(members(dm), 'info'))) fail('This group’s name and icon are encrypted. Update Snug to change them.');
      return base(c, d);
    };
  }

  // ---------- conversations: open, add, encrypt ----------
  const baseOpen = all['dm.open'];
  ops['dm.open'] = (c, d) => {
    const r = baseOpen(c, d);
    if (r?.id) upgrade(r.id);
    return r;
  };
  const baseAdd = all['dm.add'];
  if (baseAdd) {
    ops['dm.add'] = (c, d) => {
      const dm = typeof d?.dm === 'string' ? d.dm : '';
      if (encrypted(dm) && Array.isArray(d.users)) {
        for (const u of d.users) if (typeof u === 'string' && !M.inDm(dm, u) && !ready(u)) fail(NOT_READY(nameOf(u)));
        // A group whose name is sealed: someone whose devices can't open it would see none of it.
        const fresh = d.users.filter((u) => typeof u === 'string' && !M.inDm(dm, u));
        if (infoOf(dm) && fresh.length && !capable(fresh, 'info')) fail(oldDevices('This group’s name is encrypted, so new people need Snug 0.14 or later', lacking(fresh, 'info')), { code: 'e2ee_old_devices' });
      }
      const r = baseAdd(c, d);
      if (r?.created) upgrade(r.id);
      return r;
    };
  }
  // A member asks for an upgrade that didn't happen by itself.
  ops['dm.encrypt'] = (c, d) => {
    const dm = typeof d?.dm === 'string' ? d.dm : '';
    if (!db.get('SELECT 1 FROM dms WHERE id = ?', dm) || !M.inDm(dm, c.user)) fail('You’re not in that conversation.');
    if (encrypted(dm)) return { e2ee: true };
    if (!on) fail('End-to-end encryption isn’t turned on for this server.');
    if (!eligible(dm)) fail('Conversations with friends on other PCs use their own encryption.');
    const missing = members(dm).filter((u) => !ready(u));
    if (missing.length) fail(`${missing.map(nameOf).join(', ')} ${missing.length === 1 ? 'hasn’t' : 'haven’t'} set up end-to-end encryption yet.`);
    upgrade(dm);
    return { e2ee: true };
  };

  // ---------- scheduled messages ----------
  // Sealed now for the people here now, sent later as it was sealed. Prekeys
  // used now are kept at least 14 days after they retire, so that is the limit.
  // If the group changes meanwhile it isn't sent (the author is told why).
  const SCHED_MAX = 14 * 86_400_000;
  const baseSched = all['sched.create'];
  if (baseSched) {
    ops['sched.create'] = (c, d) => {
      const conv = typeof d?.conv === 'string' ? d.conv : '';
      const dm = rootOf(conv);
      if (!dm || !encrypted(conv)) {
        if (d?.e2ee !== undefined) fail('This conversation isn’t end-to-end encrypted. Reload Snug.');
        return baseSched(c, d);
      }
      if (d.e2ee == null || (typeof d.text === 'string' && d.text !== '')) fail(RELOAD);
      const at = Number.isSafeInteger(d.at) ? d.at : fail('Pick when to send it.');
      if (at > Date.now() + SCHED_MAX) fail('In encrypted conversations, messages can be scheduled up to 14 days ahead.');
      if (typeof d.id !== 'string' || !/^m_[a-z0-9]{8,40}$/.test(d.id) || M.msg(d.id)) fail('That message id isn’t valid.');
      const users = members(dm);
      if (d.replyTo != null && capable(users, 're')) fail(UPDATE('Replies in this conversation are encrypted'));
      const v = checkEnvelope(c, d.e2ee, { dm, place: conv, id: d.id, kind: 'sched', rev: 0, users, replyTo: d.replyTo ?? null });
      if (v.h.at !== at) fail('That encrypted message doesn’t match when it should be sent.');
      // The ordinary checks (posting allowed, time, how many waiting) with a placeholder text, then the envelope instead.
      const r = baseSched(c, { conv, text: 'encrypted', at, ...(d.replyTo != null ? { replyTo: d.replyTo } : {}) });
      db.run("UPDATE scheduled SET text = '', enc = ?, members = ? WHERE id = ?", canon({ env: v.env, k: v.k }), JSON.stringify(users), r.id);
      hub.toUser(c.user, 'sched', { list: db.all('SELECT * FROM scheduled WHERE user = ? ORDER BY at', c.user).map((x) => schedRow(x)) });
      return r;
    };
  }
  // What the author's own list shows of one: the envelope; each socket then gets only its own
  // device's wrap and, on a trusted device, its history wraps (socketView, e2ee.wraps). A snapshot
  // goes out before the socket proves its device, so it carries no `k` at all (an empty one made
  // 0.12.0 clients think the wraps were there and never ask e2ee.wraps).
  function schedRow(r) {
    const v = { id: r.id, conv: r.conv, text: r.text, replyTo: r.reply_to || undefined, at: r.at, created: r.created };
    const s = r.enc ? parseCanon(r.enc, 256 * 1024) : null;
    if (s?.env) v.m = { id: s.env.h.id, author: r.user, ts: r.at, e2ee: s.env, ...(r.reply_to ? { replyTo: r.reply_to } : {}) };
    return v;
  }
  function schedWraps(user, device, schedId) {
    if (!trustedDevice(user, device)) return {};
    const r = db.get('SELECT enc FROM scheduled WHERE id = ? AND user = ?', schedId, user);
    const s = r?.enc ? parseCanon(r.enc, 256 * 1024) : null;
    if (!s?.k) return {};
    const pre = historyTarget(user);
    return Object.fromEntries(Object.entries(s.k).filter(([t]) => t === `d:${device}` || t.startsWith(pre)));
  }
  M.schedView = schedRow;
  M.sendScheduledEnc = (r) => {
    const s = parseCanon(r.enc, 256 * 1024);
    const env = s?.env && encEnv(canon(s.env));
    const dm = rootOf(r.conv);
    if (!env || !dm || !encrypted(r.conv)) fail('It couldn’t be sent.');
    if (canon(members(dm)) !== r.members) fail('Your scheduled message wasn’t sent because the group changed. Send it again if you still want to.');
    const dev = deviceRow(env.h.from.d);
    if (!dev || dev.state !== 'trusted') fail('Your scheduled message wasn’t sent because the device that sealed it was removed.');
    if (M.msg(env.h.id)) fail('It was already sent.');
    // Devices removed since get nothing; devices added since have no wrap (history wraps cover them).
    // A history key replaced since (weekly, or after a device was removed, which may hold it) gets
    // nothing either: only each account's current history epoch is kept.
    const k = {};
    for (const [t, w] of Object.entries(s.k)) {
      if (t.startsWith('d:') && deviceRow(t.slice(2))?.state !== 'trusted') continue;
      if (t.startsWith('a:')) {
        const [, u, e] = t.split(':');
        if (Number(e) !== account(u)?.epoch) continue;
      }
      k[t] = w;
    }
    const v = { env, k, h: env.h, files: [] };
    const inner = { conv: r.conv, id: env.h.id, text: '', ...(r.reply_to ? { replyTo: r.reply_to } : {}) };
    M.emptyOk?.add(inner);
    pending.set(env.h.id, v);
    try { return baseSend({ user: r.user, ws: null }, inner); } finally { pending.delete(env.h.id); }
  };

  // ---------- attachments forwarded between encrypted conversations ----------
  // The ciphertext is copied as it is; its key travels inside the new message.
  const cfg = { filesDir: null };
  ops['e2ee.file.copy'] = (c, d) => {
    const src = typeof d?.id === 'string' && db.get('SELECT * FROM files WHERE id = ?', d.id);
    const from = src && (src.conv.startsWith('t:') && !M.thread(src.conv) ? M.liveMsg(src.conv.slice(2))?.conv : src.conv);
    if (!src || !src.enc || !from || !M.canRead(c.user, from)) fail('That attachment isn’t there any more.');
    const to = typeof d.to === 'string' ? d.to : '';
    const gate = M.postGate(c.user, to.startsWith('t:') && !M.thread(to) ? (M.liveMsg(to.slice(2))?.conv || '') : to);
    if (!gate.ok) fail(gate.why);
    if (!encrypted(to)) fail('Attachments are copied this way only into encrypted conversations.');
    if (!cfg.filesDir || !existsSync(join(cfg.filesDir, src.id))) fail('That attachment isn’t there any more.');
    const full = cfg.room?.(c.user, to, src.size); // review-media 1: the quota and the disk floor, as for uploads
    if (full) fail(full.message);
    const id = newId('f');
    copyFileSync(join(cfg.filesDir, src.id), join(cfg.filesDir, id));
    db.run('INSERT INTO files (id, owner, conv, name, type, size, created, enc) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', id, c.user, to, 'file', 'application/octet-stream', src.size, Date.now());
    return { id };
  };

  // ---------- account deletion (spec 11.10) ----------
  // The key directory goes: nobody can seal to this account any more, and nothing is left to unwrap.
  M.e2eeForget = (u) => {
    const devs = db.all('SELECT id FROM e2ee_devices WHERE user = ?', u).map((r) => r.id);
    for (const d of devs) {
      db.run('DELETE FROM e2ee_wraps WHERE target = ?', `d:${d}`);
      db.run('DELETE FROM e2ee_prekeys WHERE device = ?', d);
      db.run('DELETE FROM e2ee_asb_boxes WHERE device = ?', d);
    }
    const pre = historyTarget(u);
    db.run('DELETE FROM e2ee_wraps WHERE substr(target, 1, ?) = ?', pre.length, pre);
    for (const r of db.all('SELECT msg, slot FROM e2ee_side WHERE user = ?', u)) db.run('DELETE FROM e2ee_wraps WHERE msg = ?', `${r.slot}:${r.msg}:${u}`);
    db.run('DELETE FROM e2ee_side WHERE user = ?', u);
    for (const t of ['e2ee_links', 'e2ee_backup', 'e2ee_meta', 'e2ee_accounts', 'e2ee_devices']) db.run(`DELETE FROM ${t} WHERE user = ?`, u);
  };

  // ---------- housekeeping ----------
  // A deleted message's envelope, wraps and earlier versions go with its
  // content once the ten minutes of undo are over (as server/index.js does for text).
  function sweep(t = Date.now()) {
    const gone = db.all('SELECT id FROM messages WHERE deleted IS NOT NULL AND deleted < ? AND enc IS NOT NULL', t - 11 * 60_000).map((r) => r.id);
    if (!gone.length) return;
    db.tx(() => {
      for (const id of gone) {
        db.run('UPDATE messages SET enc = NULL, ping = NULL WHERE id = ?', id);
        db.run('DELETE FROM e2ee_wraps WHERE msg = ?', id);
        db.run('DELETE FROM msg_edits WHERE msg = ?', id);
        for (const r of db.all('SELECT user, slot FROM e2ee_side WHERE msg = ?', id)) db.run('DELETE FROM e2ee_wraps WHERE msg = ?', `${r.slot}:${id}:${r.user}`);
        db.run('DELETE FROM e2ee_side WHERE msg = ?', id);
      }
    });
  }

  const configure = ({ filesDir, room }) => { cfg.filesDir = filesDir; cfg.room = room; };
  return { ops, configure, readyChanged, upgrade, encrypted, rootOf, members, ready, checkEnvelope, insertWraps, sweep, wrapsFor };
}
