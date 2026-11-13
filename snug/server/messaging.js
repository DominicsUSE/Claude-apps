// Messaging extras, on the server: polls, link previews, forwarding, edit
// history, scheduled messages and stickers.
//
// - Polls: a question and 2 to 10 answers (each may carry an emoji), single or
//   multiple choice, open for 1 hour to 1 week. One vote per person per answer,
//   kept by the database's primary key, changeable while the poll is open; the
//   author (or anyone who can remove messages) can end it early. A poll can
//   hide its results until you have voted: then nobody's counts leave the
//   server for a person who hasn't voted, until it ends.
// - Link previews: after a message is sent or edited, its first three links
//   are fetched in the background through server/linkpreview.js (refusing
//   private addresses, pinned DNS, size and time limits), cached for hours, and
//   their picture is downloaded and stored as a Snug file in that conversation,
//   so a reader's browser never loads anything from another site. The author
//   (or a moderator) can remove a message's previews. <https://...> asks for none.
// - Forwarding copies a message you can read into another place you can post
//   in, with who wrote it and when; its files are copied too. The way back to
//   the original is only usable by people who can read the original.
// - Edit history: the last ten earlier versions of a message, for the people
//   who can read it. Gone with the message's content when it is deleted.
// - Scheduled messages: written now, sent by the server at the chosen time
//   (at most 30 days ahead, 25 waiting per person), checked again at send time.
// - Stickers: up to 30 per house (PNG, APNG or WebP, at most 512 KB and 320 by
//   320 pixels, read from the file), managed by roles with the Manage emoji
//   permission, sent by members of that house anywhere they can post.
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId, now } from './model.js';
import { limiter } from './auth.js';
import { safeFetch, readMeta, previewLinks } from './linkpreview.js';
import { emojiImage } from './emoji.js';
import { sniff } from './media.js';

export const POLL_HOURS = [1, 4, 8, 24, 72, 168];
export const POLL_MAX_ANSWERS = 10;
export const MAX_EDITS = 10;
export const MAX_SCHEDULED = 25;
export const SCHEDULE_MAX_MS = 30 * 86_400_000;
export const MAX_STICKERS = 30;
export const MAX_STICKER_BYTES = 512 * 1024;
export const MAX_STICKER_SIDE = 320;
const MSG_ID = /^m_[a-z0-9]{8,40}$/;
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const STICKER_NAME = /^[\p{L}\p{N}_ -]{2,30}$/u;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const HOUR = 3_600_000;

// --- Database -----------------------------------------------------------------
export function migrateMessaging(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      msg TEXT PRIMARY KEY,
      conv TEXT NOT NULL,
      by TEXT NOT NULL,
      question TEXT NOT NULL,
      answers TEXT NOT NULL,
      multi INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      ends INTEGER NOT NULL,
      ended INTEGER,
      closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS polls_open ON polls(closed, ends);
    CREATE TABLE IF NOT EXISTS poll_votes (
      msg TEXT NOT NULL,
      user TEXT NOT NULL,
      answer INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (msg, user, answer)
    );
    CREATE INDEX IF NOT EXISTS poll_votes_user ON poll_votes(user);
    CREATE TABLE IF NOT EXISTS msg_edits (
      msg TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS msg_edits_msg ON msg_edits(msg, ts);
    CREATE TABLE IF NOT EXISTS scheduled (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conv TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to TEXT,
      at INTEGER NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_at ON scheduled(at);
    CREATE INDEX IF NOT EXISTS scheduled_user ON scheduled(user);
    CREATE TABLE IF NOT EXISTS link_cache (
      url TEXT PRIMARY KEY,
      data TEXT,
      ok INTEGER NOT NULL,
      fetched INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS house_stickers (
      id TEXT PRIMARY KEY,
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      by TEXT NOT NULL,
      created INTEGER NOT NULL,
      UNIQUE (house, name)
    );`);
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  // Names and types are fixed here, never from input.
  for (const [c, type] of [['embeds', 'TEXT'], ['noembed', 'INTEGER'], ['fwd', 'TEXT'], ['sticker', 'TEXT']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE messages ADD COLUMN ${c} ${type}`);
  }
}

// --- Pictures -------------------------------------------------------------------
// What an image really is, and its size, from its bytes: PNG, GIF, WebP, JPEG.
export function imageInfo(buf) {
  const e = emojiImage(buf);
  if (e) return e;
  if (buf && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const mk = buf[i + 1];
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
        return { type: 'image/jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return { type: 'image/jpeg', w: 0, h: 0 };
  }
  return null;
}

// --- Ops ----------------------------------------------------------------------------
export function createMessagingOps({ db, M, hub, fail, ops = {} }) {
  const idOf = (v, name) => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const text = (v, { max, min = 0, name }) => {
    if (typeof v !== 'string') fail(`${name} is missing.`);
    const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (s.length < min) fail(`${name} can’t be empty.`);
    if (s.length > max) fail(`${name} can be at most ${max} characters.`);
    return s;
  };
  const readableConv = (user, conv) => (M.canRead(user, conv) ? M.where(conv) : fail('You don’t have access to this conversation.'));
  const canModerate = (user, conv, row) => row.author === user || (!!M.where(conv)?.house && M.can(user, M.where(conv).house, 'moderate'));
  const live = (conv, id) => { const r = M.liveMsg(idOf(id, 'message')); if (!r || r.conv !== conv) fail('That message was deleted.'); return r; };
  const cfg = { filesDir: null, previews: true, allowLoopback: false, tickMs: 1000 };
  // Someone timed out in a house (server/safety.js) can't vote either: voting is like reacting.
  const timedOut = (user, conv) => {
    const house = M.where(conv)?.house;
    if (!house) return false;
    try { return !!db.get('SELECT 1 FROM timeouts WHERE house = ? AND user = ? AND until > ?', house, user, Date.now()); } catch { return false; }
  };

  // Rate limits for everything here that writes or reaches other people,
  // registered with the hub so tests can reset them with the others.
  const L = {
    'poll.create': limiter({ capacity: 10, perSecond: 0.2 }),
    'poll.vote': limiter({ capacity: 20, perSecond: 2 }),
    'poll.end': limiter({ capacity: 10, perSecond: 0.5 }),
    'msg.forward': limiter({ capacity: 10, perSecond: 0.2 }),
    'msg.embeds': limiter({ capacity: 20, perSecond: 1 }),
    'sched.create': limiter({ capacity: 10, perSecond: 0.1 }),
    'sticker.send': limiter({ capacity: 10, perSecond: 1 }),
    'sticker.add': limiter({ capacity: 10, perSecond: 0.1 }),
    'msg.edits': limiter({ capacity: 20, perSecond: 2 }),
  };
  const slow = (name, user) => { if (!L[name].take(user)) fail('You’re going a little fast. Wait a moment and try again.'); };
  const previewLimit = limiter({ capacity: 30, perSecond: 0.5 });
  hub.extraLimits = [...(hub.extraLimits || []), ...Object.values(L), previewLimit];

  // ---------- Message views ----------
  const pollMsgs = new Set(db.all('SELECT msg FROM polls').map((r) => r.msg));
  const baseView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseView(row, rx);
    if (row.embeds && !row.noembed) { const e = json(row.embeds, null); if (e?.length) m.embeds = e; }
    if (row.noembed) m.noEmbeds = true;
    const x = extras.get(row.id);
    if (row.fwd || x?.fwd) m.fwd = row.fwd ? json(row.fwd, undefined) : x.fwd;
    if (row.sticker || x?.sticker) m.sticker = row.sticker ? json(row.sticker, undefined) : x.sticker;
    if (pollMsgs.has(row.id)) m.poll = pollView(row.id);
    return m;
  };

  // ---------- Polls ----------
  const pollRow = (mid) => db.get('SELECT * FROM polls WHERE msg = ?', mid);
  const isEnded = (p, t = Date.now()) => !!p.ended || p.ends <= t;
  function pollCounts(p) {
    const answers = json(p.answers, []);
    const counts = answers.map(() => 0);
    const voters = answers.map(() => []);
    for (const v of db.all('SELECT user, answer FROM poll_votes WHERE msg = ? ORDER BY ts', p.msg)) {
      if (counts[v.answer] == null) continue;
      counts[v.answer]++;
      if (voters[v.answer].length < 50) voters[v.answer].push(v.user);
    }
    return { counts, voters };
  }
  const totalOf = (mid) => db.get('SELECT COUNT(DISTINCT user) n FROM poll_votes WHERE msg = ?', mid).n;
  // What everyone may see. Counts are left out of a poll that hides its results, until it ends.
  function pollView(mid, p = pollRow(mid)) {
    if (!p) return undefined;
    const ended = isEnded(p);
    const v = {
      question: p.question, answers: json(p.answers, []), multi: !!p.multi, hidden: !!p.hidden,
      ends: p.ended || p.ends, ended, by: p.by, total: totalOf(mid),
    };
    if (!p.hidden || ended) Object.assign(v, pollCounts(p));
    return v;
  }
  // What one person may see: the results too, once they voted (or wrote it).
  function pollViewFor(user, mid, p = pollRow(mid)) {
    const v = pollView(mid, p);
    if (v && !v.counts && (p.by === user || db.get('SELECT 1 FROM poll_votes WHERE msg = ? AND user = ?', mid, user))) Object.assign(v, pollCounts(p));
    return v;
  }
  const myVotes = (user, mid) => db.all('SELECT answer FROM poll_votes WHERE msg = ? AND user = ? ORDER BY answer', mid, user).map((r) => r.answer);
  function pollChanged(conv, mid, voter) {
    const p = pollRow(mid);
    if (!p) return;
    if (!p.hidden || isEnded(p)) hub.toConv(conv, 'poll', { conv, id: mid, poll: pollView(mid, p) });
    else for (const u of M.audience(conv)) hub.toUser(u, 'poll', { conv, id: mid, poll: pollViewFor(u, mid, p) });
    if (voter) hub.toUser(voter, 'poll.mine', { id: mid, votes: myVotes(voter, mid) });
  }

  // ---------- Writing a message of our own kind (poll, sticker, forward) ----------
  // Sent through msg.send itself (as it stands at the time, with every wrapper
  // other parts of the server put round it: timeouts, blocks, slowmode, the word
  // filter, push), so a poll, a sticker or a forward is held to exactly the same
  // rules as a typed message. The extra parts ride along in `extras` while it
  // runs, so the message event already carries them, and are stored after.
  const extras = new Map();
  M.emptyOk = M.emptyOk || new WeakSet(); // server-made sends that may have no text (a forward without a note)
  function insertMessage(c, conv, mid, { text: body = '', files = [], sticker = null, fwd = null, foldExtra = '', replyTo = null }, before, undo) {
    const d = { conv, id: mid, text: body, files, ...(replyTo ? { replyTo } : {}) };
    if (fwd) M.emptyOk.add(d);
    extras.set(mid, { sticker, fwd });
    let r;
    try {
      before?.();
      r = ops['msg.send'](c, d);
    } catch (e) { undo?.(); throw e; } finally { extras.delete(mid); }
    db.run('UPDATE messages SET sticker = ?, fwd = ?, fold = ? WHERE id = ?', sticker ? JSON.stringify(sticker) : null, fwd ? JSON.stringify(fwd) : null,
      M.foldText(`${body} ${foldExtra}`, r?.m?.files || []), mid);
    return { m: M.withReactions([M.msg(mid)])[0] };
  }
  const retried = (c, conv, mid) => {
    const existing = M.msg(mid);
    if (!existing) return null;
    if (existing.author !== c.user || existing.conv !== conv) fail('That message id is already taken.');
    return { m: M.withReactions([existing])[0] };
  };
  const newMsgId = (v) => (typeof v === 'string' && MSG_ID.test(v) ? v : fail('That message id isn’t valid.'));

  // A copy of a file into another conversation (forwarding, stickers, previews).
  function copyFileTo(src, conv, owner, meta) {
    if (!cfg.filesDir || !existsSync(join(cfg.filesDir, src.id))) return null;
    const id = newId('f');
    copyFileSync(join(cfg.filesDir, src.id), join(cfg.filesDir, id));
    db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, owner, conv, src.name, src.type, src.size, Date.now(), meta === undefined ? src.meta ?? null : JSON.stringify(meta));
    return id;
  }

  // Copies made for a send that was then refused.
  function dropFiles(files) {
    for (const f of files) {
      db.run('DELETE FROM files WHERE id = ?', f.id);
      if (cfg.filesDir) try { unlinkSync(join(cfg.filesDir, f.id)); } catch { /* already gone */ }
    }
  }

  // ---------- Link previews ----------
  const queue = [];
  let running = 0;
  const MAX_RUNNING = 4;
  const slot = () => new Promise((r) => { if (running < MAX_RUNNING) { running++; r(); } else queue.push(r); });
  const release = () => { const next = queue.shift(); if (next) next(); else running--; };
  const pending = new Set(); // previews still being fetched, for tests and shutdown

  async function fetchMedia(url, maxBytes) {
    const r = await safeFetch(url, { maxBytes, timeoutMs: 6000, accept: 'image/*,video/mp4', allowLoopback: cfg.allowLoopback });
    if (r.status !== 200) return null;
    const img = imageInfo(r.body);
    if (img && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(img.type)) return { body: r.body, type: img.type, w: img.w || undefined, h: img.h || undefined };
    if (sniff(r.body) === 'mp4') return { body: r.body, type: 'video/mp4' };
    return null;
  }
  async function storeMedia(media) {
    const hash = createHash('sha256').update(media.body).digest('hex').slice(0, 40);
    await writeFile(join(cfg.filesDir, `lc_${hash}`), media.body, { mode: 0o600 });
    return { hash, type: media.type, w: media.w, h: media.h, size: media.body.length };
  }
  // A link's preview data, from the cache or the network. Null for nothing to show.
  async function lookupLink(url) {
    const hit = db.get('SELECT * FROM link_cache WHERE url = ?', url);
    if (hit && Date.now() - hit.fetched < (hit.ok ? 6 * HOUR : 15 * 60_000)
      && (!json(hit.data, {})?.media || existsSync(join(cfg.filesDir, `lc_${json(hit.data, {}).media.hash}`)))) return hit.ok ? json(hit.data, null) : null;
    await slot();
    let data = null;
    try {
      const r = await safeFetch(url, { maxBytes: 10 * 1024 * 1024, timeoutMs: 6000, accept: 'text/html,application/xhtml+xml,image/*,video/mp4;q=0.9,*/*;q=0.5', allowLoopback: cfg.allowLoopback });
      if (r.status === 200) {
        if (r.type === 'text/html' || r.type === 'application/xhtml+xml') {
          const meta = readMeta(r.body.toString('utf8'), r.url);
          let media;
          if (meta.image) {
            try { const got = await fetchMedia(meta.image, 4 * 1024 * 1024); if (got && got.type !== 'video/mp4') media = await storeMedia(got); } catch { /* a page without its picture */ }
          }
          if (meta.title || meta.description || media) data = { kind: 'link', title: meta.title, description: meta.description, site: meta.site, color: meta.color, media };
        } else {
          const img = imageInfo(r.body);
          if (img && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(img.type) && r.body.length <= 8 * 1024 * 1024) {
            data = { kind: 'image', media: await storeMedia({ body: r.body, type: img.type, w: img.w || undefined, h: img.h || undefined }) };
          } else if (sniff(r.body) === 'mp4') {
            data = { kind: 'video', media: await storeMedia({ body: r.body, type: 'video/mp4' }) };
          }
        }
      }
    } catch { data = null; } finally { release(); }
    db.run('INSERT INTO link_cache (url, data, ok, fetched) VALUES (?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET data = excluded.data, ok = excluded.ok, fetched = excluded.fetched',
      url, data ? JSON.stringify(data) : null, data ? 1 : 0, Date.now());
    return data;
  }
  // The previews for one message: fetched, their pictures copied into the
  // message's conversation, stored, and sent to everyone reading it.
  async function buildEmbeds(conv, mid) {
    const row = M.liveMsg(mid);
    if (!row || row.noembed || row.sys) return;
    const links = previewLinks(row.text, 3, { anyPort: cfg.allowLoopback });
    const out = [];
    if (links.length && cfg.previews && cfg.filesDir && previewLimit.take(row.author, links.length)) {
      for (const url of links) {
        const data = await lookupLink(url);
        if (!data) continue;
        const host = new URL(url).hostname.replace(/^www\./, '');
        const e = { kind: data.kind, url, host };
        if (data.kind === 'link') Object.assign(e, { title: data.title || undefined, description: data.description || undefined, site: data.site || undefined, color: data.color });
        if (data.media) {
          const src = join(cfg.filesDir, `lc_${data.media.hash}`);
          if (existsSync(src)) {
            const fid = newId('f');
            copyFileSync(src, join(cfg.filesDir, fid));
            const ext = data.media.type.split('/')[1];
            db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              fid, row.author, conv, `preview.${ext}`, data.media.type, data.media.size, Date.now(), JSON.stringify({ embed: true, w: data.media.w, h: data.media.h }));
            const ref = { id: fid, w: data.media.w, h: data.media.h };
            if (data.kind === 'video') e.video = ref; else e.image = ref;
          }
        }
        out.push(e);
      }
    }
    // The message may have been edited, deleted or stripped of previews meanwhile.
    const cur = M.liveMsg(mid);
    if (!cur || cur.noembed || cur.text !== row.text) return;
    const next = out.length ? JSON.stringify(out) : null;
    if (next === (cur.embeds || null)) return;
    db.run('UPDATE messages SET embeds = ? WHERE id = ?', next, mid);
    broadcast(conv, mid);
  }
  function queueEmbeds(conv, mid) {
    const p = buildEmbeds(conv, mid).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  }
  function broadcast(conv, mid) {
    const row = M.msg(mid);
    if (!row) return;
    const [m] = M.withReactions([row]);
    const t = conv.startsWith('t:') ? M.thread(conv) : null;
    hub.toConv(conv, 'msg', { conv, m, user: hub.userView(row.author), thread: t ? { id: t.id, conv: t.conv, root: t.root } : undefined });
  }

  // ---------- Scheduled messages ----------
  const schedView = (r) => ({ id: r.id, conv: r.conv, text: r.text, replyTo: r.reply_to || undefined, at: r.at, created: r.created });
  const schedFor = (user) => db.all('SELECT * FROM scheduled WHERE user = ? ORDER BY at', user).map(schedView);
  const schedChanged = (user) => hub.toUser(user, 'sched', { list: schedFor(user) });

  let ticks = 0;
  function tick() {
    const t = Date.now();
    for (const r of db.all('SELECT * FROM scheduled WHERE at <= ? ORDER BY at LIMIT 50', t)) {
      db.run('DELETE FROM scheduled WHERE id = ?', r.id);
      try {
        // Checked again now: the right to post may have gone since it was written.
        ops['msg.send']({ user: r.user, ws: null }, { conv: r.conv, id: newId('m'), text: r.text, replyTo: r.reply_to || undefined });
      } catch (e) {
        hub.toUser(r.user, 'sched.failed', { id: r.id, conv: r.conv, text: r.text, reason: e.message || 'It couldn’t be sent.' });
      }
      schedChanged(r.user);
    }
    for (const p of db.all('SELECT * FROM polls WHERE closed = 0 AND (ends <= ? OR ended IS NOT NULL) LIMIT 50', t)) {
      db.run('UPDATE polls SET closed = 1 WHERE msg = ?', p.msg);
      if (M.liveMsg(p.msg)) pollChanged(p.conv, p.msg);
    }
    // Earlier versions go with a deleted message's content (ten minutes of undo, then gone).
    if (++ticks % 30 === 0) {
      db.run('DELETE FROM msg_edits WHERE msg IN (SELECT id FROM messages WHERE deleted IS NOT NULL AND deleted < ?)', t - 11 * 60_000);
      db.run('UPDATE messages SET embeds = NULL, fwd = NULL, sticker = NULL WHERE deleted IS NOT NULL AND deleted < ? AND (embeds IS NOT NULL OR fwd IS NOT NULL OR sticker IS NOT NULL)', t - 11 * 60_000);
    }
  }

  // ---------- Stickers ----------
  const stickerView = (s) => s && { id: s.id, house: s.house, name: s.name, file: s.file, by: s.by, created: s.created };
  const stickersOf = (house) => db.all('SELECT * FROM house_stickers WHERE house = ? ORDER BY created', house).map(stickerView);
  const stickersChanged = (house) => hub.toUsers(db.all('SELECT user FROM members WHERE house = ?', house).map((r) => r.user), 'stickers', { house, list: stickersOf(house) });
  const needStickers = (user, house) => {
    if (!db.get('SELECT 1 FROM houses WHERE id = ?', house)) fail('That house doesn’t exist.');
    if (!M.isMember(house, user)) fail('You’re not a member of that house.');
    if (!M.can(user, house, 'emoji')) fail('Your role can’t manage stickers in this house.');
  };

  // ---------- Snapshot: scheduled messages, stickers, your poll votes ----------
  const baseSnap = hub.snapshotFor;
  if (baseSnap) {
    hub.snapshotFor = (u) => {
      const snap = baseSnap(u);
      snap.scheduled = schedFor(u);
      snap.stickers = Object.fromEntries(M.houseIdsOf(u).map((h) => [h, stickersOf(h)]));
      const votes = {};
      for (const v of db.all('SELECT msg, answer FROM poll_votes WHERE user = ? ORDER BY answer', u)) (votes[v.msg] ||= []).push(v.answer);
      snap.pollVotes = votes;
      return snap;
    };
  }
  const baseContent = hub.sendHouseContent;
  if (baseContent) {
    hub.sendHouseContent = (u, houseId) => {
      baseContent(u, houseId);
      hub.toUser(u, 'stickers', { house: houseId, list: stickersOf(houseId) });
    };
  }

  // ---------- Wrapped ops ----------
  const baseSend = ops['msg.send'];
  const baseEdit = ops['msg.edit'];
  const wrapped = {};
  if (baseSend) {
    wrapped['msg.send'] = (c, d) => {
      const fresh = typeof d.id === 'string' && !M.msg(d.id);
      const r = baseSend(c, d);
      if (fresh && r?.m?.id && /https?:\/\//.test(r.m.text || '')) queueEmbeds(typeof d.conv === 'string' ? d.conv : '', r.m.id);
      return r;
    };
  }
  if (baseEdit) {
    wrapped['msg.edit'] = (c, d) => {
      const before = typeof d.id === 'string' ? M.liveMsg(d.id) : null;
      if (before && pollMsgs.has(before.id)) fail('Polls can’t be edited. End it and start a new one instead.');
      if (before && (before.sticker || before.fwd) && !before.text && typeof d.text === 'string' && d.text.trim()) fail('Stickers and forwarded messages can’t be edited.');
      const r = baseEdit(c, d);
      const after = before && M.msg(before.id);
      if (after && after.text !== before.text) {
        db.tx(() => {
          db.run('INSERT INTO msg_edits (msg, text, ts) VALUES (?, ?, ?)', before.id, before.text, before.edited || before.ts);
          // Only the last ten earlier versions are kept.
          db.run(`DELETE FROM msg_edits WHERE msg = ? AND rowid NOT IN (SELECT rowid FROM msg_edits WHERE msg = ? ORDER BY ts DESC, rowid DESC LIMIT ${MAX_EDITS})`, before.id, before.id);
        });
        if (/https?:\/\//.test(after.text) || after.embeds) queueEmbeds(after.conv, after.id);
      }
      return r;
    };
  }

  const api = {
    // Called by server/index.js once the files folder and options are known.
    configure({ filesDir, previews = true, allowLoopback = false, tickMs = 1000 } = {}) {
      Object.assign(cfg, { filesDir, previews, allowLoopback, tickMs });
      const timer = setInterval(() => { try { tick(); } catch (e) { console.error('messaging tick', e); } }, tickMs);
      timer.unref?.();
      const baseClose = hub.close;
      hub.close = () => { clearInterval(timer); baseClose?.(); };
    },
    tick,
    // Tests: wait for previews still being fetched; change options without restarting.
    idle: () => Promise.all([...pending]),
    set: (patch) => { for (const k of ['previews', 'allowLoopback']) if (k in patch) cfg[k] = !!patch[k]; },
    reset: () => previewLimit.reset(),
  };
  hub.messaging = api;

  return {
    ...wrapped,

    // ----- Polls -----
    'poll.create'(c, d) {
      slow('poll.create', c.user);
      const conv = idOf(d.conv, 'conversation');
      const mid = newMsgId(d.id);
      const again = retried(c, conv, mid);
      if (again) return again;
      readableConv(c.user, conv);
      const question = text(d.question, { min: 1, max: 300, name: 'The question' });
      if (!Array.isArray(d.answers)) fail('Answers are missing.');
      const answers = d.answers.map((a, i) => {
        if (!a || typeof a !== 'object') fail('An answer isn’t valid.');
        const t = text(a.text, { min: 1, max: 55, name: `Answer ${i + 1}` });
        const emoji = a.emoji == null || a.emoji === '' ? undefined
          : (typeof a.emoji === 'string' && a.emoji.length <= 16 && EMOJI.test(a.emoji) ? a.emoji : fail('An answer’s emoji can be one emoji.'));
        return { id: i, text: t, ...(emoji ? { emoji } : {}) };
      });
      if (answers.length < 2) fail('A poll needs at least two answers.');
      if (answers.length > POLL_MAX_ANSWERS) fail(`A poll can have up to ${POLL_MAX_ANSWERS} answers.`);
      if (new Set(answers.map((a) => a.text.toLowerCase())).size !== answers.length) fail('Two answers say the same thing.');
      const hours = POLL_HOURS.includes(d.hours) ? d.hours : fail('Pick how long the poll stays open.');
      if (d.multi !== undefined && typeof d.multi !== 'boolean') fail('Multiple choice is yes or no.');
      if (d.hidden !== undefined && typeof d.hidden !== 'boolean') fail('Hiding results is yes or no.');
      const ends = Date.now() + hours * HOUR;
      if (pollMsgs.has(mid)) fail('That message id is already taken.');
      return insertMessage(c, conv, mid, { text: question, foldExtra: answers.map((a) => a.text).join(' ') }, () => {
        db.run('INSERT INTO polls (msg, conv, by, question, answers, multi, hidden, ends) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          mid, conv, c.user, question, JSON.stringify(answers), d.multi ? 1 : 0, d.hidden ? 1 : 0, ends);
        pollMsgs.add(mid);
      }, () => {
        db.run('DELETE FROM polls WHERE msg = ?', mid);
        pollMsgs.delete(mid);
      });
    },
    'poll.vote'(c, d) {
      slow('poll.vote', c.user);
      const conv = idOf(d.conv, 'conversation');
      readableConv(c.user, conv);
      const row = live(conv, d.id);
      const p = pollRow(row.id) || fail('That message isn’t a poll.');
      if (isEnded(p)) fail('This poll has ended.');
      if (timedOut(c.user, conv)) fail('You’re timed out in this house, so you can’t vote yet.');
      if (!Array.isArray(d.answers)) fail('Pick an answer.');
      const n = json(p.answers, []).length;
      const picks = [...new Set(d.answers)];
      if (!picks.every((a) => Number.isInteger(a) && a >= 0 && a < n)) fail('That answer isn’t one of the choices.');
      if (!p.multi && picks.length > 1) fail('This poll takes one answer.');
      const t = Date.now();
      db.tx(() => {
        db.run('DELETE FROM poll_votes WHERE msg = ? AND user = ?', row.id, c.user);
        for (const a of picks) db.run('INSERT INTO poll_votes (msg, user, answer, ts) VALUES (?, ?, ?, ?)', row.id, c.user, a, t);
      });
      pollChanged(conv, row.id, c.user);
      return { votes: myVotes(c.user, row.id) };
    },
    'poll.end'(c, d) {
      slow('poll.end', c.user);
      const conv = idOf(d.conv, 'conversation');
      readableConv(c.user, conv);
      const row = live(conv, d.id);
      const p = pollRow(row.id) || fail('That message isn’t a poll.');
      if (!canModerate(c.user, conv, { author: p.by })) fail('Only the person who started the poll can end it.');
      if (isEnded(p)) return {};
      db.run('UPDATE polls SET ended = ?, closed = 1 WHERE msg = ?', Date.now(), row.id);
      pollChanged(conv, row.id);
      return {};
    },
    'poll.view'(c, d) {
      const conv = idOf(d.conv, 'conversation');
      readableConv(c.user, conv);
      const row = live(conv, d.id);
      if (!pollRow(row.id)) fail('That message isn’t a poll.');
      return { poll: pollViewFor(c.user, row.id), votes: myVotes(c.user, row.id) };
    },

    // ----- Link previews -----
    'msg.embeds'(c, d) {
      slow('msg.embeds', c.user);
      const conv = idOf(d.conv, 'conversation');
      readableConv(c.user, conv);
      const row = live(conv, d.id);
      if (!canModerate(c.user, conv, row)) fail('Only the person who wrote it can remove its previews.');
      if (d.on === true) {
        if (row.author !== c.user) fail('Only the person who wrote it can bring its previews back.');
        db.run('UPDATE messages SET noembed = NULL WHERE id = ?', row.id);
        broadcast(conv, row.id);
        queueEmbeds(conv, row.id);
      } else {
        db.run('UPDATE messages SET noembed = 1, embeds = NULL WHERE id = ?', row.id);
        broadcast(conv, row.id);
      }
      return {};
    },

    // ----- Forwarding -----
    'msg.forward'(c, d) {
      slow('msg.forward', c.user);
      const conv = idOf(d.conv, 'conversation');
      const to = idOf(d.to, 'conversation');
      const mid = newMsgId(d.newId);
      const again = retried(c, to, mid);
      if (again) return again;
      readableConv(c.user, conv);
      const src = live(conv, d.id);
      if (src.sys) fail('Call records can’t be forwarded.');
      if (pollMsgs.has(src.id)) fail('Polls can’t be forwarded.');
      const comment = d.comment == null ? '' : text(d.comment, { max: 2000, name: 'Your note' });
      // A forward of a forward carries the original.
      const orig = src.fwd ? json(src.fwd, null) : null;
      const files = [];
      const srcFiles = json(src.files, []);
      const gate = M.postGate(c.user, to);
      if (!gate.ok) fail(gate.why);
      for (const f of srcFiles.slice(0, 6)) {
        const row = f.id && db.get('SELECT * FROM files WHERE id = ?', f.id);
        const nid = row && copyFileTo(row, to, c.user);
        if (nid) files.push({ ...f, id: nid });
      }
      const fwd = {
        conv, id: src.id, author: orig ? orig.author : src.author, ts: orig ? orig.ts : src.ts,
        text: orig ? orig.text : src.text,
        ...(src.sticker || orig?.sticker ? { sticker: json(src.sticker, null) || orig.sticker } : {}),
        ...(orig ? { conv: orig.conv, id: orig.id } : {}),
      };
      if (!fwd.text && !files.length) fail('That message has nothing left to forward.');
      return insertMessage(c, to, mid, { text: comment, files, fwd, foldExtra: fwd.text }, null, () => dropFiles(files));
    },

    // ----- Jump to a date: the first message on or after a time (else the last one before it) -----
    'msg.at'(c, d) {
      const conv = idOf(d.conv, 'conversation');
      readableConv(c.user, conv);
      const ts = Number.isInteger(d.ts) && d.ts >= 0 ? d.ts : fail('Pick a date.');
      const row = db.get('SELECT id, ts FROM messages WHERE conv = ? AND deleted IS NULL AND ts >= ? ORDER BY seq LIMIT 1', conv, ts)
        || db.get('SELECT id, ts FROM messages WHERE conv = ? AND deleted IS NULL ORDER BY seq DESC LIMIT 1', conv);
      return row ? { id: row.id, ts: row.ts } : { id: null };
    },

    // ----- Edit history -----
    'msg.edits'(c, d) {
      slow('msg.edits', c.user);
      const conv = idOf(d.conv, 'conversation');
      readableConv(c.user, conv);
      const row = live(conv, d.id);
      const edits = db.all('SELECT text, ts FROM msg_edits WHERE msg = ? ORDER BY ts DESC, rowid DESC LIMIT ?', row.id, MAX_EDITS);
      return { current: { text: row.text, ts: row.edited || row.ts }, edits };
    },

    // ----- Scheduled messages -----
    'sched.create'(c, d) {
      slow('sched.create', c.user);
      const conv = idOf(d.conv, 'conversation');
      if (conv.startsWith('t:') && !M.thread(conv)) fail('Start the thread with a message first.');
      const gate = M.postGate(c.user, conv);
      if (!gate.ok) fail(gate.why);
      const body = text(d.text, { min: 1, max: 4000, name: 'A message' });
      const at = Number.isInteger(d.at) ? d.at : fail('Pick when to send it.');
      if (at < Date.now() + 30_000) fail('Pick a time at least a minute from now.');
      if (at > Date.now() + SCHEDULE_MAX_MS) fail('Messages can be scheduled up to 30 days ahead.');
      if (db.get('SELECT COUNT(*) n FROM scheduled WHERE user = ?', c.user).n >= MAX_SCHEDULED) fail(`You can have up to ${MAX_SCHEDULED} messages waiting. Send or cancel one first.`);
      let replyTo = null;
      if (d.replyTo != null) replyTo = live(conv, d.replyTo).id;
      const sid = newId('sch');
      db.run('INSERT INTO scheduled (id, user, conv, text, reply_to, at, created) VALUES (?, ?, ?, ?, ?, ?, ?)', sid, c.user, conv, body, replyTo, at, Date.now());
      schedChanged(c.user);
      return { id: sid };
    },
    'sched.cancel'(c, d) {
      const sid = idOf(d.id, 'scheduled message');
      const r = db.get('SELECT * FROM scheduled WHERE id = ? AND user = ?', sid, c.user);
      if (!r) return { gone: true };
      db.run('DELETE FROM scheduled WHERE id = ?', sid);
      schedChanged(c.user);
      return { text: r.text, conv: r.conv };
    },
    'sched.list'(c) { return { list: schedFor(c.user) }; },

    // ----- Stickers -----
    'sticker.add'(c, d) {
      slow('sticker.add', c.user);
      const house = idOf(d.house, 'house');
      needStickers(c.user, house);
      const name = typeof d.name === 'string' ? d.name.trim() : '';
      if (!STICKER_NAME.test(name)) fail('Sticker names are 2 to 30 letters, numbers, spaces, dashes or underscores.');
      if (db.get('SELECT COUNT(*) n FROM house_stickers WHERE house = ?', house).n >= MAX_STICKERS) fail(`A house can have up to ${MAX_STICKERS} stickers. Remove one first.`);
      if (db.get('SELECT 1 FROM house_stickers WHERE house = ? AND lower(name) = lower(?)', house, name)) fail(`There’s already a sticker called ${name} in this house.`);
      const file = db.get('SELECT * FROM files WHERE id = ?', idOf(d.file, 'image'));
      if (!file || file.owner !== c.user || file.conv !== `sticker:${house}` || !json(file.meta, {}).sticker) fail('That image didn’t finish uploading. Choose it again.');
      if (db.get('SELECT 1 FROM house_stickers WHERE file = ?', file.id)) fail('That image is already a sticker. Choose it again.');
      const sid = newId('st');
      db.run('INSERT INTO house_stickers (id, house, name, file, by, created) VALUES (?, ?, ?, ?, ?, ?)', sid, house, name, file.id, c.user, Date.now());
      stickersChanged(house);
      return { sticker: stickerView(db.get('SELECT * FROM house_stickers WHERE id = ?', sid)) };
    },
    'sticker.remove'(c, d) {
      const s = db.get('SELECT * FROM house_stickers WHERE id = ?', idOf(d.id, 'sticker'));
      if (!s) return {};
      needStickers(c.user, s.house);
      db.run('DELETE FROM house_stickers WHERE id = ?', s.id);
      stickersChanged(s.house);
      return {};
    },
    'sticker.send'(c, d) {
      slow('sticker.send', c.user);
      const conv = idOf(d.conv, 'conversation');
      const mid = newMsgId(d.id);
      const again = retried(c, conv, mid);
      if (again) return again;
      const s = db.get('SELECT * FROM house_stickers WHERE id = ?', idOf(d.sticker, 'sticker')) || fail('That sticker was removed from its house.');
      if (!M.isMember(s.house, c.user)) fail('You can send stickers from houses you’re in.');
      const gate = M.postGate(c.user, conv);
      if (!gate.ok) fail(gate.why);
      let replyTo = null;
      if (d.replyTo != null) replyTo = live(conv, d.replyTo).id;
      const src = db.get('SELECT * FROM files WHERE id = ?', s.file) || fail('That sticker’s image is missing.');
      const meta = json(src.meta, {});
      const fid = copyFileTo(src, conv, c.user, { sticker: true, w: meta.w, h: meta.h }) || fail('That sticker’s image is missing.');
      const files = [{ kind: 'image', id: fid, name: src.name, size: src.size, w: meta.w, h: meta.h }];
      return insertMessage(c, conv, mid, { files, sticker: { id: s.id, name: s.name, house: s.house }, foldExtra: s.name, replyTo }, null, () => dropFiles(files));
    },
  };
}

// --- HTTP: sticker uploads and sticker images -------------------------------------
export function createMessagingHttp({ db, M, filesDir, sendJson, error, body, headers, uploadLimit }) {
  return async function messagingHttp(req, res, path, url, user) {
    if (req.method === 'POST' && path === '/api/files' && url.searchParams.has('sticker')) {
      const house = url.searchParams.get('sticker') || '';
      if (!/^[\w.-]{1,80}$/.test(house) || !db.get('SELECT 1 FROM houses WHERE id = ?', house)) { error(res, 404, 'That house doesn’t exist.'); return true; }
      if (!M.isMember(house, user)) { error(res, 403, 'You’re not a member of that house.'); return true; }
      if (!M.can(user, house, 'emoji')) { error(res, 403, 'Your role can’t manage stickers in this house.'); return true; }
      if (uploadLimit && !uploadLimit.take(user)) { error(res, 429, 'Too many uploads at once. Wait a moment.'); return true; }
      const size = Number(req.headers['content-length']);
      if (!size) { error(res, 400, 'That image is empty.'); return true; }
      if (size > MAX_STICKER_BYTES) { error(res, 413, 'Stickers can be up to 512 KB.'); return true; }
      let data;
      try { data = await body(req, MAX_STICKER_BYTES); } catch (e) {
        if (e.status === 413) { error(res, 413, 'Stickers can be up to 512 KB.'); return true; }
        throw e;
      }
      const img = emojiImage(data);
      if (!img || (img.type !== 'image/png' && img.type !== 'image/webp')) { error(res, 415, 'Stickers need to be PNG, APNG or WebP images.'); return true; }
      if (!img.w || !img.h) { error(res, 415, 'Snug couldn’t read that image’s size.'); return true; }
      if (img.w > MAX_STICKER_SIDE || img.h > MAX_STICKER_SIDE) { error(res, 422, `That image is ${img.w} by ${img.h} pixels. Stickers can be up to ${MAX_STICKER_SIDE} by ${MAX_STICKER_SIDE}.`); return true; }
      const name = (decodeURIComponent(String(req.headers['x-file-name'] || 'sticker')).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim() || 'sticker').slice(0, 120);
      const id = newId('f');
      await writeFile(join(filesDir, id), data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, user, `sticker:${house}`, name, img.type, data.length, Date.now(), JSON.stringify({ sticker: true, w: img.w, h: img.h }));
      sendJson(res, 201, { id, name, size: data.length, w: img.w, h: img.h, type: img.type });
      return true;
    }
    // A house's sticker images, for the picker: members of that house only.
    const m = /^\/api\/stickers\/(f_[a-z0-9]{8,40})$/.exec(path);
    if (req.method === 'GET' && m) {
      const row = db.get('SELECT * FROM files WHERE id = ?', m[1]);
      const house = row?.conv.startsWith('sticker:') ? row.conv.slice(8) : null;
      if (!row || !house || !M.isMember(house, user) || !FILE_ID.test(row.id)) { error(res, 404, 'Not found'); return true; }
      const { createReadStream } = await import('node:fs');
      headers(res, {
        'Content-Type': row.type, 'Content-Length': String(row.size), 'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.writeHead(200);
      createReadStream(join(filesDir, row.id)).pipe(res);
      return true;
    }
    return false;
  };
}
