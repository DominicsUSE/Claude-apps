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

export function createE2eeConv({ db, M, hub, fail, ops: all, on, verifyEd, account, deviceRow }) {
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
      return m;
    }
    if (!row.sys) { const s = sinceOf(row.conv); if (s != null && row.seq < s) m.legacy = true; }
    return m;
  };
  // Server search can't read these rows (their fold is empty); filters such as from: still skip them.
  const baseSearch = M.search;
  M.search = (...a) => baseSearch(...a).filter((h) => !h.m.e2ee);
  // A declared mention (the header's ping list) counts as a mention for notifications.
  M.pinged = (user, row) => !!row?.ping && json(row.ping, []).includes(user);

  // ---------- wraps: each socket gets its own ----------
  const historyTarget = (u) => `a:${u}:`;
  // A socket bound to no device gets nothing (it can't prove it holds any key).
  function wrapsFor(user, device, msg, rev) {
    if (!device) return {};
    const pre = historyTarget(user);
    const out = {};
    for (const w of db.all('SELECT target, wrap FROM e2ee_wraps WHERE msg = ? AND rev = ? AND (target = ? OR substr(target, 1, ?) = ?)',
      msg, rev, `d:${device}`, pre.length, pre)) out[w.target] = w.wrap;
    return out;
  }
  const prevView = hub.socketView;
  hub.socketView = (ws, ev, d) => {
    const v = prevView ? prevView(ws, ev, d) : d;
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
    if (kind === 'msg' && h.re !== (replyTo ?? null)) fail('That encrypted message doesn’t match where it was sent.');
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
        .map((e) => ({ id: row.id, author: row.author, e2ee: encEnv(e.enc), ts: e.ts })).filter((e) => e.e2ee);
      return { current: { id: row.id, author: row.author, e2ee: encEnv(row.enc), ts: row.edited || row.ts }, edits };
    };
  }

  // The wraps for messages fetched any other way (history, snapshot, search, mentions, pins, saved,
  // edit history): only conversations the caller can read, only its bound device and its own history keys.
  ops['e2ee.wraps'] = (c, d) => {
    if (!Array.isArray(d?.ids) || d.ids.length > 200) fail('Ask for up to 200 messages at a time.');
    const out = {};
    for (const x of d.ids) {
      const id = typeof x === 'string' ? x : x?.id;
      if (typeof id !== 'string') continue;
      const row = M.msg(id);
      if (!row?.enc || row.deleted || !M.canRead(c.user, row.conv)) continue;
      const rev = Number.isSafeInteger(x?.rev) ? x.rev : encEnv(row.enc)?.h.rev ?? 0;
      out[id] = { rev, k: wrapsFor(c.user, c.ws?.e2eeDevice || null, id, rev) };
    }
    return { wraps: out };
  };

  // ---------- features that need plaintext on the server ----------
  const refuseIn = (name, why, convOf = (d) => d?.conv) => {
    const base = all[name];
    if (!base) return;
    ops[name] = (c, d) => { if (encrypted(convOf(d))) fail(why); return base(c, d); };
  };
  refuseIn('poll.create', 'Polls aren’t available in encrypted conversations yet.');
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
      }
    });
  }

  return { ops, readyChanged, upgrade, encrypted, rootOf, members, ready, checkEnvelope, insertWraps, sweep, wrapsFor };
}
