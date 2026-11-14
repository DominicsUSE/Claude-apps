// The social side of Snug: friends, what is happening right now, events.
// Pure functions of the state, shared by the views and (for the rules) the server.
import { MIN, DAY } from './util.js';

// What a house can say it is about. The server only accepts these.
export const TOPICS = ['Games', 'Music', 'Art & making', 'Tech', 'Study', 'Sports', 'Local', 'Books', 'Film & TV', 'Just chatting'];

// Limits the server enforces, here so the forms can say them too.
export const LIMITS = { interests: 8, interest: 24, links: 3, linkLabel: 40, linkUrl: 200, rules: 2000, eventTitle: 80, eventAbout: 500 };

// An event with no end time counts as two hours long.
export const EVENT_LENGTH = 2 * 60 * MIN;
export const eventEnd = (e) => e.ends ?? e.starts + EVENT_LENGTH;

// 'now' | 'soon' (starts within the hour) | 'later' | 'past'
export function eventState(e, now) {
  if (now >= eventEnd(e)) return 'past';
  if (now >= e.starts) return 'now';
  return e.starts - now <= 60 * MIN ? 'soon' : 'later';
}

const PRESENCE_ORDER = { open: 0, around: 1, focus: 2, away: 3, offline: 4 };
const rank = (S, id) => PRESENCE_ORDER[S.users[id]?.presence] ?? 4;
const byName = (S) => (a, b) => (S.users[a]?.name || '').localeCompare(S.users[b]?.name || '');

export const friendState = (S, id) => S.friends?.[id]?.state || null;
export const isFriend = (S, id) => friendState(S, id) === 'friends';

// Friends who are online: favourites first, then the most reachable, then by name.
export function friendsOnline(S) {
  return Object.keys(S.friends || {})
    .filter((id) => isFriend(S, id) && S.users[id] && rank(S, id) < 4)
    .sort((a, b) => (S.friends[b].favorite - S.friends[a].favorite) || (rank(S, a) - rank(S, b)) || byName(S)(a, b));
}

// Every friend: online before offline, then the same order as above.
export function friendsList(S) {
  const off = (id) => (rank(S, id) === 4 ? 1 : 0);
  return Object.keys(S.friends || {})
    .filter((id) => isFriend(S, id))
    .sort((a, b) => (off(a) - off(b)) || (S.friends[b].favorite - S.friends[a].favorite) || (rank(S, a) - rank(S, b)) || byName(S)(a, b));
}

// Requests waiting on you ('incoming') or on them ('outgoing'), newest first.
export function friendRequests(S, state = 'incoming') {
  return Object.keys(S.friends || {})
    .filter((id) => S.friends[id].state === state)
    .sort((a, b) => S.friends[b].since - S.friends[a].since);
}

// Rooms in houses you have joined, and your direct conversations.
function liveConvs(S) {
  const rooms = Object.keys(S.rooms).filter((r) => S.houses[S.rooms[r].house]?.joined);
  return [...rooms, ...(S.dmOrder || [])];
}

// Conversations where something is happening: people writing in the last
// 15 minutes, someone typing, or people in the voice room. Liveliest first.
export function activeConversations(S, now) {
  const out = [];
  for (const conv of liveConvs(S)) {
    const list = S.msgs[conv] || [];
    const talking = new Set(list.filter((m) => m.ts > now - 15 * MIN && !m.state).map((m) => m.author)).size;
    const typing = (S.typing?.[conv] || []).filter((u) => u !== S.me).length;
    const inVoice = (S.voice?.[conv] || []).length;
    if (!talking && !typing && !inVoice) continue;
    const read = S.read?.[conv] || 0;
    const newCount = list.filter((m) => m.ts > read && m.author !== S.me && !m.state).length;
    const last = list.length ? list[list.length - 1].ts : 0;
    out.push({ conv, talking, typing, inVoice, newCount, last });
  }
  const score = (x) => x.inVoice * 3 + x.talking * 2 + x.typing;
  return out.sort((a, b) => (score(b) - score(a)) || (b.last - a.last));
}

// Voice rooms with people in them, fullest first.
export function liveVoice(S) {
  return Object.entries(S.voice || {})
    .filter(([room, people]) => people.length && S.houses[S.rooms[room]?.house]?.joined)
    .map(([conv, people]) => ({ conv, people: [...people] }))
    .sort((a, b) => b.people.length - a.people.length);
}

// Events in your houses that are happening now or start within 14 days, soonest first.
export function upcomingEvents(S, now, { house } = {}) {
  return Object.values(S.events || {})
    .filter((e) => (!house || e.house === house) && S.houses[e.house]?.joined)
    .filter((e) => { const st = eventState(e, now); return st !== 'past' && e.starts <= now + 14 * DAY; })
    .sort((a, b) => a.starts - b.starts);
}

// Houses you have joined that this person is also in.
export function mutualHouses(S, userId) {
  return (S.houseOrder || []).filter((h) => S.houses[h]?.joined && S.houses[h].members?.[userId]);
}

export function greeting(now) {
  const h = new Date(now).getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Interests and links, cleaned the way the server cleans them.
export function cleanInterests(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const v = raw.replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

// A web address that is safe to show as a link: https only, no passwords in it.
export function safeLink(url) {
  if (typeof url !== 'string') return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  return u.href;
}
