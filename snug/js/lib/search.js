// Search that reads like a sentence: plain words plus a few operators.
//   from:ines  in:"glaze lab"  has:image|file|link  is:saved
import { fold } from './util.js';
import { parentOf } from './attention.js';

const OP = /(?:^|\s)(from|in|has|is):(?:"([^"]*)"|(\S+))/gi;

export function parseQuery(q) {
  const out = { terms: [], from: [], in: [], has: [], saved: false };
  const rest = (q || '').replace(OP, (_, key, quoted, bare) => {
    const val = fold(quoted ?? bare);
    const k = key.toLowerCase();
    if (k === 'is') { if (val === 'saved') out.saved = true; }
    else if (val) out[k].push(val);
    return ' ';
  });
  out.terms = fold(rest).split(/\s+/).filter(Boolean);
  return out;
}

export const isEmptyQuery = (p) => !p.terms.length && !p.from.length && !p.in.length && !p.has.length && !p.saved;

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
        (h === 'link' && /https?:\/\//.test(m.text || '')))) continue;
      const hay = fold(`${m.text || ''} ${files.map((f) => f.name).join(' ')}`);
      if (!p.terms.every((t) => hay.includes(t))) continue;
      hits.push({ conv, m });
    }
  }
  hits.sort((a, b) => b.m.ts - a.m.ts);
  return hits.slice(0, limit);
}
