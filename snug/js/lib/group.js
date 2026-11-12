// Turns a flat list of messages into what the conversation draws: day
// dividers, the "New" line, and messages flagged as grouped under the one above.
import { sameDay, MIN } from './util.js';

export const GROUP_WINDOW = 5 * MIN;

export function buildItems(list, { marker = null, me = null } = {}) {
  const items = [];
  let prev = null;
  let marked = false;
  for (const m of list) {
    let broke = false;
    if (!prev || !sameDay(prev.ts, m.ts)) {
      items.push({ type: 'day', ts: m.ts, key: `d${m.ts}` });
      broke = true;
    }
    if (!marked && marker != null && m.ts >= marker && m.author !== me) {
      items.push({ type: 'new', key: 'new' });
      marked = true;
      broke = true;
    }
    const grouped = !broke && prev && prev.author === m.author && !m.replyTo && !m.sys && !prev.sys && !m.call && !prev.call
      && m.ts - prev.ts < GROUP_WINDOW;
    items.push({ type: 'msg', m, grouped: !!grouped, key: m.id });
    prev = m;
  }
  return items;
}
