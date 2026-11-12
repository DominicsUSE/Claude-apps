// Message text to a token tree. No HTML strings anywhere, so nothing a person
// types can inject markup: the view turns tokens into elements.

const RULES = [
  ['code', /`([^`\n]+)`/],
  ['b', /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/],
  ['s', /~~(?=\S)([\s\S]+?)(?<=\S)~~/],
  ['i', /(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/],
  ['i', /(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/],
  ['link', /https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"]/],
  ['at', /(?<![\w@])@([a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?)/i],
];

function inline(s) {
  const out = [];
  while (s) {
    let best = null;
    for (const [t, re] of RULES) {
      const m = re.exec(s);
      if (m && (!best || m.index < best.m.index)) best = { t, m };
    }
    if (!best) { out.push({ t: 'text', v: s }); break; }
    const { t, m } = best;
    if (m.index) out.push({ t: 'text', v: s.slice(0, m.index) });
    if (t === 'code') out.push({ t, v: m[1] });
    else if (t === 'link') out.push({ t, v: m[0] });
    else if (t === 'at') out.push({ t, v: m[1].toLowerCase() });
    else out.push({ t, c: inline(m[1]) });
    s = s.slice(m.index + m[0].length);
  }
  return out;
}

export function parse(text) {
  const out = [];
  const fence = /```(\w*)\n?([\s\S]*?)```\n?/g;
  let last = 0, m;
  while ((m = fence.exec(text))) {
    if (m.index > last) out.push(...inline(text.slice(last, m.index).replace(/\n$/, '')));
    out.push({ t: 'pre', lang: m[1], v: m[2].replace(/\n$/, '') });
    last = fence.lastIndex;
  }
  if (last < text.length) out.push(...inline(text.slice(last)));
  return out;
}

// One to three emoji and nothing else are shown large.
export function isJumbo(text) {
  if (!text || text.length > 24) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|\s)+$/u.test(text)) return false;
  const count = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  return count >= 1 && count <= 3;
}

// Markup removed, for one-line previews.
export function plain(text) {
  return (text || '')
    .replace(/```\w*\n?([\s\S]*?)```/g, '$1')
    .replace(/\*\*|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const mentions = (text, handle) =>
  new RegExp(`(?<![\\w@])@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text || '');
