// Message text to a token tree. No HTML strings anywhere, so nothing a person
// types can inject markup: the view turns tokens into elements.

const RULES = [
  // A backslash keeps the next markup character as itself: \*not italic\*.
  ['esc', /\\([*_~|`\\<>#[\]()-])/],
  ['code', /`([^`\n]+)`/],
  // Messaging: bold italic, underline, spoilers, masked links, timestamps and <links without a preview>.
  ['bi', /\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/],
  ['b', /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/],
  ['u', /__(?=\S)([\s\S]+?)(?<=\S)__/],
  ['spoiler', /\|\|(?=\S)([\s\S]+?)(?<=\S)\|\|/],
  ['s', /~~(?=\S)([\s\S]+?)(?<=\S)~~/],
  ['i', /(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/],
  ['i', /(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/],
  ['mlink', /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\))?[^\s<>()]*)\)/],
  ['ts', /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/],
  ['nolink', /<(https?:\/\/[^\s<>]+)>/],
  ['link', /https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"]/],
  // @everyone and @here (before people, so nobody named "here" takes them), <#room>.
  ['everyone', /(?<![\w@])@(everyone|here)(?![\w])/],
  ['room', /<#([\w:.-]{1,80})>/],
  ['at', /(?<![\w@])@([a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?)/i],
];

// What the parser needs from the app, set by js/views/rich.js (tests set their own):
//   role(after)  the role named at the start of `after` (the text after an @),
//                as { id, name, hue, len }, or null. Users win over roles.
//   origin       this Snug's own address, so its message links become cards.
//   roomName(id) a room's name if this person can see it, for plain().
export const formatHooks = { role: null, origin: '', roomName: null };
const MSG_LINK = /^\/m\/([\w:.-]{1,80})\/([\w.-]{1,80})\/?$/;
// A link to a message on this Snug: { conv, id }, or null.
export function messageLinkOf(url, origin = formatHooks.origin) {
  if (!origin || !url || !url.startsWith(`${origin}/m/`)) return null;
  const m = MSG_LINK.exec(url.slice(origin.length));
  return m ? { conv: decodeURIComponent(m[1]), id: m[2] } : null;
}
// Custom emoji (js/views/emoji-custom.js): <:name:id>, resolved when the message was sent.
export const CUSTOM_EMOJI = /<:([a-z0-9_]{2,32}):(em_[a-z0-9]{8,40})>/;
const CUSTOM_EMOJI_G = new RegExp(CUSTOM_EMOJI.source, 'g');
RULES.push(['emoji', CUSTOM_EMOJI]);

function inline(s) {
  const out = [];
  const text = (v) => { const last = out[out.length - 1]; if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v }); };
  while (s) {
    let best = null;
    for (const [t, re] of RULES) {
      const m = re.exec(s);
      if (m && (!best || m.index < best.m.index)) best = { t, m };
    }
    if (!best) { text(s); break; }
    const { t, m } = best;
    if (m.index) text(s.slice(0, m.index));
    if (t === 'esc') text(m[1]);
    else if (t === 'code') out.push({ t, v: m[1] });
    else if (t === 'link') { const ml = messageLinkOf(m[0]); out.push(ml ? { t: 'msglink', v: m[0], ...ml } : { t, v: m[0] }); }
    else if (t === 'nolink') out.push({ t: 'link', v: m[1] });
    else if (t === 'everyone') out.push({ t, v: m[1] });
    else if (t === 'room') out.push({ t, v: m[1] });
    else if (t === 'at') {
      const role = formatHooks.role?.(s.slice(m.index + 1));
      if (role) { out.push({ t: 'role', v: role.name, id: role.id, hue: role.hue ?? null }); s = s.slice(m.index + 1 + role.len); continue; }
      out.push({ t, v: m[1].toLowerCase() });
    }
    else if (t === 'emoji') out.push({ t, v: m[1], id: m[2] });
    else if (t === 'bi') out.push({ t: 'b', c: [{ t: 'i', c: inline(m[1]) }] });
    else if (t === 'mlink') out.push({ t, v: m[2], c: inline(m[1]) });
    else if (t === 'ts') out.push({ t, v: Number(m[1]), style: m[2] || 'f' });
    else out.push({ t, c: inline(m[1]) });
    s = s.slice(m.index + m[0].length);
  }
  return out;
}

// Lines that start a block: headings (# ## ###), subtext (-#), quotes (> and
// >>> for the rest of the message) and lists (- item, * item, 1. item).
const HEAD = /^(#{1,3}) +(\S.*)$/;
const SUB = /^-# +(\S.*)$/;
const QUOTE = /^> (.*)$/;
const QUOTE_ALL = /^>>> ([\s\S]*)$/;
const ITEM = /^( *)([-*•]|\d{1,3}[.)]) +(\S.*)$/;

function blocks(src, depth = 0) {
  const lines = src.split('\n');
  if (!lines.some((l) => HEAD.test(l) || SUB.test(l) || QUOTE.test(l) || ITEM.test(l))) return inline(src);
  const out = [];
  let run = [];
  const flush = () => { if (run.length) { out.push(...inline(run.join('\n'))); run = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = HEAD.exec(l))) { flush(); out.push({ t: 'h', level: m[1].length, c: inline(m[2]) }); }
    else if ((m = SUB.exec(l))) { flush(); out.push({ t: 'sub', c: inline(m[1]) }); }
    else if (depth === 0 && (m = QUOTE_ALL.exec(l))) {
      flush();
      out.push({ t: 'quote', c: blocks([m[1], ...lines.slice(i + 1)].join('\n'), 1) });
      break;
    } else if (depth === 0 && QUOTE.test(l)) {
      flush();
      const q = [];
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { q.push(m[1]); i++; }
      i--;
      out.push({ t: 'quote', c: blocks(q.join('\n'), 1) });
    } else if ((m = ITEM.exec(l))) {
      flush();
      const ordered = /\d/.test(m[2]);
      const items = [];
      const start = ordered ? parseInt(m[2], 10) : undefined;
      while (i < lines.length && (m = ITEM.exec(lines[i])) && /\d/.test(m[2]) === ordered) {
        items.push({ depth: Math.min(2, Math.floor(m[1].length / 2)), c: inline(m[3]) });
        i++;
      }
      i--;
      out.push({ t: 'list', ordered, ...(ordered ? { start } : {}), items });
    } else run.push(l);
  }
  flush();
  return out;
}

export function parse(text) {
  const out = [];
  const fence = /```([\w+#.-]*)\n?([\s\S]*?)```\n?/g;
  let last = 0, m;
  while ((m = fence.exec(text))) {
    if (m.index > last) out.push(...blocks(text.slice(last, m.index).replace(/\n$/, '')));
    out.push({ t: 'pre', lang: m[1].toLowerCase().slice(0, 20), v: m[2].replace(/\n$/, '') });
    last = fence.lastIndex;
  }
  if (last < text.length) out.push(...blocks(text.slice(last)));
  return out;
}

// Dynamic timestamps, <t:unix:style>, in the reader's own language and time zone.
//   t 4:20 PM   T 4:20:30 PM   d 12/11/2026   D 12 November 2026
//   f 12 November 2026 at 4:20 PM (default)   F Thursday, 12 November 2026 at 4:20 PM   R in 2 hours
export const STAMP_STYLES = ['t', 'T', 'd', 'D', 'f', 'F', 'R'];
const STAMP_OPTS = {
  t: { hour: 'numeric', minute: '2-digit' }, T: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  d: { dateStyle: 'short' }, D: { dateStyle: 'long' }, f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' },
};
export function fmtStamp(unix, style = 'f', now = Date.now(), locale = undefined) {
  const ms = Number(unix) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return String(unix);
  if (style === 'R') {
    const diff = (ms - now) / 1000;
    const abs = Math.abs(diff);
    const [n, unit] = abs < 60 ? [diff, 'second'] : abs < 3600 ? [diff / 60, 'minute'] : abs < 86400 ? [diff / 3600, 'hour']
      : abs < 30 * 86400 ? [diff / 86400, 'day'] : abs < 365 * 86400 ? [diff / (30 * 86400), 'month'] : [diff / (365 * 86400), 'year'];
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(n), unit);
  }
  return new Intl.DateTimeFormat(locale, STAMP_OPTS[style] || STAMP_OPTS.f).format(ms);
}

// One to three emoji and nothing else are shown large.
export function isJumbo(text) {
  // Each custom emoji counts as one emoji.
  const custom = text && text.includes('<:') ? text.match(CUSTOM_EMOJI_G) : null;
  if (custom) {
    const rest = text.replace(CUSTOM_EMOJI_G, '').trim();
    const more = rest ? (isJumbo(rest) ? (rest.match(/\p{Extended_Pictographic}/gu) || []).length : 99) : 0;
    return custom.length + more <= 3;
  }
  if (!text || text.length > 24) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|\s)+$/u.test(text)) return false;
  const count = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  return count >= 1 && count <= 3;
}

// Markup removed, for one-line previews.
export function plain(text) {
  return (text || '')
    .replace(/```[\w+#.-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/\|\|([\s\S]+?)\|\|/g, '[spoiler]') // a preview never gives a spoiler away
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g, (_, n, st) => fmtStamp(n, st || 'f'))
    .replace(/<(https?:\/\/[^\s<>]+)>/g, '$1')
    .replace(/^(?:#{1,3}|-#|>>>|>) +/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(CUSTOM_EMOJI_G, ':$1:') // custom emoji read as their name
    .replace(/<#([\w:.-]{1,80})>/g, (_, id) => `#${formatHooks.roomName?.(id) || 'unknown room'}`)
    .replace(/\s+/g, ' ')
    .trim();
}

export const mentions = (text, handle) =>
  new RegExp(`(?<![\\w@])@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text || '');
