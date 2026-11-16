// Working offline (0.12), as plain functions over state.
//
// - trimForCache: what goes into this device's copy (localStorage). The last
//   40 messages of each conversation are enough to open on; older ones load
//   from the server when scrolled to. Messages still waiting to send are
//   always kept. Search hits (cache) aren't kept.
// - queueOp / replayOp: changes made while offline (reactions, edits,
//   deletes, saves) wait in a queue instead of being undone at the next
//   snapshot. One entry per thing changed: the last change wins. After the
//   reconnect snapshot they are replayed onto it (so nothing flickers back)
//   and sent (js/store.js).

export const CACHE_PER_CONV = 40;

// skip(conv, m): messages left out of the copy altogether (0.13: unsent ones in encrypted conversations,
// which js/e2ee/local.js keeps sealed instead).
export function trimForCache(data, keep = CACHE_PER_CONV, skip = null) {
  const out = { ...data, msgs: {}, more: { ...(data.more || {}) }, cache: {} };
  for (const [conv, all] of Object.entries(data.msgs || {})) {
    const list = skip ? all.filter((m) => !skip(conv, m)) : all;
    if (list.length <= keep) { out.msgs[conv] = list; continue; }
    const cut = list.length - keep;
    out.msgs[conv] = list.filter((m, i) => i >= cut || m.state);
    out.more[conv] = true;
  }
  return out;
}

// The device copy as JSON (js/store.js). Nothing decrypted on this device is written: an
// end-to-end encrypted message keeps only its envelope (opened again after a reload), wherever it
// sits (conversations, pins, saved, the scheduled list). Local previews (blob: URLs) only work in
// this tab, so they are left out too.
const OPENED = ['text', 'files', 'sticker', 'fwd', 'enc', 'encRev', 'encFlags', 'encWhy', 'k'];
export function cacheJson(data, keep = CACHE_PER_CONV, skip = null) {
  return JSON.stringify(trimForCache(data, keep, skip), (k, v) => {
    if (k === 'src' && typeof v === 'string' && v.startsWith('blob:')) return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v) && v.e2ee && typeof v.id === 'string') {
      const out = { ...v };
      for (const f of OPENED) delete out[f];
      out.text = '';
      return out;
    }
    return v;
  });
}

// Changes that are safe to send late, in order, once each.
export const QUEUED_OPS = new Set(['react', 'msg.edit', 'msg.delete', 'msg.restore', 'saved.set', 'saved.note', 'highlight.set']);
// What a queued change is about: a later change to the same thing replaces it.
const subject = (op, d) => {
  if (op === 'react') return `react ${d.id} ${d.emoji}`;
  if (op === 'msg.delete' || op === 'msg.restore') return `exists ${d.id}`;
  if (op === 'saved.set') return `saved ${d.id}`;
  if (op === 'highlight.set') return `hl ${d.conv} ${d.id}`;
  return `${op} ${d.id}`;
};
export function queueOp(queue, op, d) {
  const key = subject(op, d);
  return [...queue.filter((x) => subject(x.op, x.d) !== key), { op, d, at: Date.now() }];
}

const msgIn = (S, conv, id) => (S.msgs[conv] || []).find((m) => m.id === id) || S.cache?.[id];
export function replayOp(S, op, d) {
  if (op === 'react') {
    const m = msgIn(S, d.conv, d.id);
    if (!m) return;
    const all = (m.reactions ||= {});
    const who = (all[d.emoji] ||= []).filter((u) => u !== S.me);
    if (d.on) who.push(S.me);
    if (who.length) all[d.emoji] = who; else delete all[d.emoji];
  } else if (op === 'msg.edit') {
    const m = msgIn(S, d.conv, d.id);
    if (m) { m.text = d.text; m.edited = m.edited || Date.now(); }
  } else if (op === 'msg.delete') {
    if (S.msgs[d.conv]) S.msgs[d.conv] = S.msgs[d.conv].filter((m) => m.id !== d.id);
  } else if (op === 'saved.set') {
    S.saved = (S.saved || []).filter((s) => s.id !== d.id);
    if (d.on) S.saved.unshift({ id: d.id, conv: d.conv, at: Date.now(), note: d.note || '' });
  } else if (op === 'saved.note') {
    const s = (S.saved || []).find((x) => x.id === d.id);
    if (s) s.note = d.note;
  } else if (op === 'highlight.set') {
    const room = S.rooms?.[d.conv];
    if (room) room.highlights = d.on ? [d.id, ...room.highlights.filter((x) => x !== d.id)] : room.highlights.filter((x) => x !== d.id);
  }
  // msg.restore: the snapshot has no deleted message to put back; the server's reply brings it.
}

// What this device keeps for a conversation that isn't sent yet (0.13): drafts, what each replies to, and
// attachments uploaded for a draft are split by conversation. For a private one (end-to-end encrypted, or
// seen encrypted) they never go to localStorage: js/e2ee/local.js keeps the text and reply sealed, and a
// private draft's attachments stay in this tab only. { open, sealed } with the same fields.
export function splitUnsent({ drafts = {}, reply = {}, files = {} }, isPrivate) {
  const open = { drafts: {}, reply: {}, files: {} }, sealed = { drafts: {}, reply: {}, files: {} };
  for (const [k, src] of Object.entries({ drafts, reply, files })) {
    for (const [conv, v] of Object.entries(src || {})) (isPrivate(conv) ? sealed : open)[k][conv] = v;
  }
  return { open, sealed };
}
