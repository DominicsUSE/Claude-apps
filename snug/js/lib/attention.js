// What counts as unread, and what counts as "needs you".
// This file is the whole notification policy. Every badge, dot, toast and
// Catch up entry is derived from the three functions below.
import { mentions } from './format.js';
import { mentionsRole } from './places.js'; // @Role mentions

export const LEVELS = ['all', 'mentions', 'muted'];
export const LEVEL_LABEL = { all: 'Everything', mentions: 'Only what needs me', muted: 'Nothing' };

export const isThread = (conv) => conv.startsWith('t:');

// A group is a direct conversation with more than one other person.
export const isGroup = (S, conv) => (S.dms[conv]?.members.length || 0) > 2;

// Which levels a place offers. A one-to-one conversation is always for you,
// so its only choice is whether to hear about it.
export const levelsFor = (S, kind, id) => (kind === 'dm' && !isGroup(S, id) ? ['all', 'muted'] : LEVELS);

// Thread -> its room; room or direct conversation -> itself.
export const parentOf = (S, conv) => (isThread(conv) ? S.threads[conv]?.conv : conv);

// One setting per place, three values. A room inherits from its house unless overridden.
export function levelOf(S, conv) {
  const id = parentOf(S, conv);
  const room = S.rooms[id];
  if (room) return room.notify || S.houses[room.house]?.notify || 'all';
  return S.dms[id]?.notify || 'all';
}

// A call record (written by the server) that I missed: someone else started
// it and I neither took part nor declined. Those need me; other call records
// are history, not news.
export function missedCall(S, m) {
  if (!m.call || m.author === S.me) return false;
  return !(m.call.joined || []).includes(S.me) && !(m.call.declined || []).includes(S.me);
}

// Is this message addressed to me: does it mention me, or reply to something I wrote?
// The message list highlights exactly these, so what is counted and what is shown agree.
// Highlight words and @everyone (js/account.js) count as mentions too.
export const forMeHooks = [];
export function forMe(S, conv, m) {
  if (m.author === S.me || m.sys) return false;
  if (forMeHooks.some((f) => f(S, conv, m))) return true;
  if (m.call) return missedCall(S, m);
  if (mentions(m.text, S.users[S.me]?.handle)) return true;
  if (mentionsRole(S, conv, m)) return true; // a role I have, and anyone may mention it (js/lib/places.js)
  if (m.replyTo) {
    const target = (S.msgs[conv] || []).find((x) => x.id === m.replyTo);
    if (target && target.author === S.me) return true;
  }
  return false;
}

// Does this one message need me personally?
// Direct messages (in a group set to "Only what needs me", only mentions and
// replies), mentions, replies to my messages, and replies in threads I follow.
// Everything else is "new activity": worth a dot, never a number.
export function needsMe(S, conv, m) {
  if (m.author === S.me || m.sys) return false;
  // Blocked people and unaccepted message requests never need me (js/views/safety.js).
  if (S.safety?.blocks?.includes(m.author) || S.safety?.requests?.some((r) => r.dm === conv)) return false;
  // A missed call is for me even in a group set to "Only what needs me".
  if (m.call) return missedCall(S, m);
  if (S.dms[conv] && !(isGroup(S, conv) && S.dms[conv].notify === 'mentions')) return true;
  if (forMe(S, conv, m)) return true;
  if (isThread(conv) && S.followed[conv]) return true;
  return false;
}

// Raw unread facts for one conversation, ignoring notification level.
export function unreadOf(S, conv) {
  const list = S.msgs[conv] || [];
  const since = S.read[conv] || 0;
  let count = 0, needs = 0, firstTs = null;
  const people = new Set();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.ts <= since) break;
    if (m.author === S.me || m.sys) continue;
    if (m.call && !missedCall(S, m)) continue;
    count++;
    firstTs = m.ts;
    people.add(m.author);
    if (needsMe(S, conv, m)) needs++;
  }
  return { count, needs, firstTs, people: [...people] };
}

export const threadsOf = (S, conv) =>
  Object.keys(S.threads).filter((t) => S.threads[t].conv === conv && (S.msgs[t] || []).length);

// What the navigation shows for a place: a soft dot, or a number.
// Threads I follow count towards their room.
export function attention(S, conv) {
  const level = levelOf(S, conv);
  if (level === 'muted') return { soft: false, needs: 0 };
  const own = unreadOf(S, conv);
  let needs = own.needs;
  let soft = own.count > 0;
  for (const t of threadsOf(S, conv)) {
    if (!S.followed[t]) continue;
    const u = unreadOf(S, t);
    needs += u.needs;
    soft = soft || u.count > 0;
  }
  return { soft: level === 'all' && soft, needs };
}

export function houseAttention(S, houseId) {
  let soft = false, needs = 0;
  for (const id of roomIds(S, houseId)) {
    const a = attention(S, id);
    soft = soft || a.soft;
    needs += a.needs;
  }
  return { soft, needs };
}

export const roomIds = (S, houseId) => S.houses[houseId].groups.flatMap((g) => g.rooms);

export function totalNeeds(S) {
  let n = (S.invites || []).length;
  for (const h of S.houseOrder) n += houseAttention(S, h).needs;
  for (const d of S.dmOrder) n += attention(S, d).needs;
  return n;
}
