// Search that reads like a sentence: plain words plus a few operators.
//   from:ines  in:"glaze lab"  has:image|file|link|poll|sticker|video  is:saved
//   mentions:ines  before:2026-11-01  after:2026-10  during:2026-11-12  pinned:true
// Dates are days, months or years in the searcher's own time zone.
import { fold } from './util.js';
import { parentOf } from './attention.js';

const OP = /(?:^|\s)(from|in|has|is|mentions|before|after|during|pinned):(?:"([^"]*)"|(\S+))/gi;
export const SEARCH_OPS = ['from', 'in', 'has', 'mentions', 'before', 'after', 'during', 'pinned', 'is'];
export const HAS_KINDS = ['image', 'file', 'link', 'poll', 'sticker', 'video', 'embed'];

// The newer filters (mentions, dates, pinned) are only present when used, so
// a query without them parses to the same shape as before.
export function parseQuery(q) {
  const out = { terms: [], from: [], in: [], has: [], saved: false };
  const rest = (q || '').replace(OP, (_, key, quoted, bare) => {
    const val = fold(quoted ?? bare);
    const k = key.toLowerCase();
    if (k === 'is') { if (val === 'saved') out.saved = true; else if (val === 'pinned') out.pinned = true; }
    else if (k === 'pinned') { if (val === 'true' || val === 'yes') out.pinned = true; }
    else if (k === 'mentions') { if (val) (out.mentions ||= []).push(val.replace(/^@/, '')); }
    else if (k === 'before' || k === 'after' || k === 'during') { if (dateRange(val)) out[k] = val; }
    else if (val) out[k].push(val);
    return ' ';
  });
  out.terms = fold(rest).split(/\s+/).filter(Boolean);
  return out;
}

export const isEmptyQuery = (p) => !p.terms.length && !p.from.length && !p.in.length && !p.has.length && !p.saved
  && !p.mentions?.length && !p.before && !p.after && !p.during && !p.pinned;

// A day (2026-11-12), month (2026-11) or year (2026) as [start, end) in
// milliseconds, in a time zone given as Date#getTimezoneOffset() minutes.
export function dateRange(v, tz = new Date().getTimezoneOffset()) {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) - 1 : null, d = m[3] ? Number(m[3]) : null;
  if (y < 1970 || y > 9999 || (mo != null && (mo < 0 || mo > 11)) || (d != null && (d < 1 || d > 31))) return null;
  const at = (yy, mm, dd) => Date.UTC(yy, mm, dd) + tz * 60_000;
  if (d != null) { const s = at(y, mo, d); if (new Date(s - tz * 60_000).getUTCMonth() !== mo) return null; return [s, at(y, mo, d + 1)]; }
  if (mo != null) return [at(y, mo, 1), at(y, mo + 1, 1)];
  return [at(y, 0, 1), at(y + 1, 0, 1)];
}

// Does a message's time pass the date filters?
export function inDates(p, ts, tz) {
  if (p.before) { const r = dateRange(p.before, tz); if (r && !(ts < r[0])) return false; }
  if (p.after) { const r = dateRange(p.after, tz); if (r && !(ts >= r[1])) return false; }
  if (p.during) { const r = dateRange(p.during, tz); if (r && !(ts >= r[0] && ts < r[1])) return false; }
  return true;
}

// Add, replace or remove one operator in a query string.
export function setOp(q, key, value) {
  const stripped = (q || '').replace(new RegExp(`(?:^|\\s)${key}:(?:"[^"]*"|\\S+)`, 'gi'), '').trim();
  if (!value) return stripped;
  const v = /\s/.test(value) ? `"${value}"` : value;
  return `${stripped} ${key}:${v}`.trim();
}

function convName(S, conv) {
  const id = parentOf(S, conv);
  if (S.rooms[id]) return S.rooms[id].name;
  const dm = S.dms[id];
  if (!dm) return '';
  return dm.name || dm.members.filter((u) => u !== S.me).map((u) => S.users[u].name).join(' ');
}

function visible(S, conv) {
  const id = parentOf(S, conv);
  const room = S.rooms[id];
  if (room) return !!S.houses[room.house]?.joined;
  return !!S.dms[id];
}

export function runSearch(S, p, limit = 80) {
  if (isEmptyQuery(p)) return [];
  const saved = new Set(S.saved.map((s) => s.id));
  const hits = [];
  for (const conv of Object.keys(S.msgs)) {
    if (!visible(S, conv)) continue;
    const where = fold(convName(S, conv));
    if (p.in.length && !p.in.every((v) => where.includes(v))) continue;
    for (const m of S.msgs[conv]) {
      if (m.sys) continue;
      if (p.saved && !saved.has(m.id)) continue;
      if (p.from.length) {
        const u = S.users[m.author];
        const who = fold(`${u.name} ${u.handle}`);
        if (!p.from.every((v) => who.includes(v))) continue;
      }
      const files = m.files || [];
      if (p.has.length && !p.has.every((h) =>
        (h === 'image' && files.some((f) => f.kind === 'image')) ||
        (h === 'file' && files.some((f) => f.kind === 'file')) ||
        (h === 'link' && /https?:\/\//.test(m.text || '')) ||
        (h === 'poll' && !!m.poll) || (h === 'sticker' && !!m.sticker) ||
        (h === 'video' && files.some((f) => f.kind === 'video')) || (h === 'embed' && !!m.embeds?.length))) continue;
      if (!inDates(p, m.ts)) continue;
      if (p.pinned && !(S.pins?.[parentOf(S, conv)] || []).some((x) => x.id === m.id)) continue;
      if (p.mentions?.length && !p.mentions.every((h) => new RegExp(`(?<![\\w@])@${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(m.text || ''))) continue;
      const hay = fold(`${m.text || ''} ${files.map((f) => f.name).join(' ')}`);
      if (!p.terms.every((t) => hay.includes(t))) continue;
      hits.push({ conv, m });
    }
  }
  hits.sort((a, b) => b.m.ts - a.m.ts);
  return hits.slice(0, limit);
}
