// Places, structure and community: the rules shared by the server and the
// browser. The server decides; the browser uses the same functions only to
// draw what the server will allow (server/places.js).
//
// - Room permissions: a role's house-wide permissions give each room a
//   starting point (see, send, join voice, speak, manage); the room's
//   overrides then deny or allow per role and per member. Owners can always
//   do everything; people who manage rooms house-wide always see every room
//   and can always manage it, so nobody can lock the house out of a room.
// - Forum posts, stage rooms, house templates, the rail's folders and the
//   member list's groups.
import { HUES, RETIRED_HUES } from './util.js';

export const ROOM_PERMS = [
  { id: 'view', label: 'See the room', hint: 'Find it in the sidebar and read what is said in it.' },
  { id: 'send', label: 'Send messages', hint: 'Write here, start posts and reply in threads.' },
  { id: 'connect', label: 'Join voice', hint: 'Join the room’s voice or stage.' },
  { id: 'speak', label: 'Speak', hint: 'Talk in voice. On a stage, speak without being invited.' },
  { id: 'video', label: 'Share camera and screen', hint: 'Turn a camera on or share a screen in the room’s voice.' }, // voice and calls track
  { id: 'manage', label: 'Manage the room', hint: 'Rename it, change who can see it, add webhooks, run the stage.' },
];
export const ROOM_PERM_IDS = ROOM_PERMS.map((p) => p.id);
export const ROOM_KINDS = ['text', 'voice', 'news', 'forum', 'stage'];
export const VOICE_KINDS = ['voice', 'stage'];

// Limits, shared so the browser can say them before the server refuses.
export const PLACE_LIMITS = {
  postTitle: 100, tags: 20, tagName: 24, postTags: 5, overrides: 100, hooksPerRoom: 10, hookName: 40,
  hookContent: 2000, followsPerRoom: 10, folders: 20, folderName: 32, nick: 32, welcome: 400, interests: 12,
  interestLabel: 40, stageTopic: 120, roleIcon: 16,
};

const set = (list) => new Set(Array.isArray(list) ? list : []);

// What one person may do in one room.
//   housePerms: Set of the person's house-wide permission ids (all their roles)
//   owner: true for the owner role
//   kind: the room's kind; isPrivate: hidden from everyone without an override
//   overrides: [{ type: 'everyone'|'role'|'member', target, allow: [], deny: [] }]
//   roleIds: the person's roles; userId: the person
export function resolveRoom({ housePerms, owner = false, kind = 'text', isPrivate = false, overrides = [], roleIds = [], userId }) {
  if (owner) return { view: true, send: true, connect: true, speak: true, manage: true, video: true };
  const has = (p) => housePerms.has(p);
  const manager = has('rooms');
  const r = {
    view: !isPrivate,
    send: kind === 'news' ? has('announce') : has('post'),
    connect: VOICE_KINDS.includes(kind),
    // On a stage, only the people who run it speak without an invitation.
    speak: VOICE_KINDS.includes(kind) && (kind !== 'stage' || manager),
    manage: manager,
    video: VOICE_KINDS.includes(kind), // camera and screen: on for voice rooms unless an override turns it off
  };
  const apply = (deny, allow) => { for (const p of deny) if (p in r) r[p] = false; for (const p of allow) if (p in r) r[p] = true; };
  for (const o of overrides) if (o.type === 'everyone') apply(set(o.deny), set(o.allow));
  const roles = new Set(roleIds);
  const deny = new Set(), allow = new Set();
  for (const o of overrides) {
    if (o.type !== 'role' || !roles.has(o.target)) continue;
    set(o.deny).forEach((p) => deny.add(p));
    set(o.allow).forEach((p) => allow.add(p));
  }
  apply(deny, allow);
  for (const o of overrides) if (o.type === 'member' && o.target === userId) apply(set(o.deny), set(o.allow));
  if (manager) { r.view = true; r.manage = true; }
  if (!VOICE_KINDS.includes(kind)) { r.connect = false; r.speak = false; r.video = false; }
  if (!r.view) return { view: false, send: false, connect: false, speak: false, manage: false, video: false };
  if (!r.connect) { r.speak = false; r.video = false; }
  return r;
}

// The role a person's name takes its colour from: the highest role they have
// that has a colour. roles: the house's roles in order (owner first).
export function nameRole(roles, roleIds) {
  const mine = new Set(roleIds);
  return roles.find((r) => mine.has(r.id) && r.hue != null) || null;
}
// Their highest role shown on its own in the member list, if any.
export function hoistRole(roles, roleIds) {
  const mine = new Set(roleIds);
  return roles.find((r) => mine.has(r.id) && r.hoist !== false) || null;
}
// A role's icon, if any: the highest role with one.
export function iconRole(roles, roleIds) {
  const mine = new Set(roleIds);
  return roles.find((r) => mine.has(r.id) && r.icon) || null;
}

// Member list groups: online people under their highest shown role, then
// everyone online without one, then everyone offline.
export function memberGroups(roles, people, rolesOf) {
  const online = people.filter((u) => u.presence !== 'offline');
  const groups = roles.filter((r) => r.hoist !== false).map((r) => ({ id: r.id, name: r.name, role: r, list: [] }));
  const rest = { id: 'online', name: 'Online', list: [] };
  for (const u of online) {
    const r = hoistRole(roles, rolesOf(u.id));
    (r ? groups.find((g) => g.id === r.id) : rest)?.list.push(u);
  }
  return [...groups, rest, { id: 'offline', name: 'Offline', list: people.filter((u) => u.presence === 'offline') }].filter((g) => g.list.length);
}

// Forum posts: newest first, or by latest activity (last reply or the post).
export function sortPosts(posts, by = 'activity') {
  const key = (p) => (by === 'newest' ? p.ts : Math.max(p.ts, p.last || 0));
  return [...posts].sort((a, b) => key(b) - key(a));
}

// Move one item in a list to a new index (role order, house order).
export function moveTo(list, id, index) {
  const out = list.filter((x) => x !== id);
  out.splice(Math.max(0, Math.min(out.length, index)), 0, id);
  return out;
}

// The rail: houses in the person's order, with folders. Any house missing
// from the stored layout goes at the end; houses they left drop out.
export function railItems(layout, houseIds) {
  const have = new Set(houseIds);
  const used = new Set();
  const items = [];
  for (const it of layout?.items || []) {
    if (typeof it === 'string') {
      if (have.has(it) && !used.has(it)) { items.push(it); used.add(it); }
    } else if (it && typeof it === 'object' && Array.isArray(it.houses)) {
      const houses = it.houses.filter((h) => have.has(h) && !used.has(h));
      houses.forEach((h) => used.add(h));
      if (houses.length) items.push({ ...it, houses });
    }
  }
  for (const h of houseIds) if (!used.has(h)) items.push(h);
  return items;
}
export const railOrder = (items) => items.flatMap((it) => (typeof it === 'string' ? [it] : it.houses));

export const HUE_IDS = [...HUES.map(([v]) => v), ...RETIRED_HUES]; // retired ones show as the nearest (hueOf)

// House templates. Rooms with "only" are private to those roles.
export const TEMPLATES = [
  {
    id: 'friends', label: 'Friends', hint: 'A lounge, plans and a room to hang out in.',
    about: 'Our corner of the internet.',
    roles: [{ key: 'friend', name: 'Friend', hue: 142, perms: ['post', 'invite', 'pin'] }],
    groups: [
      { name: 'Rooms', rooms: [['Lounge', 'text', 'Everyday conversation'], ['Plans', 'text', 'What we are doing next'], ['Photos', 'text', 'Pictures from wherever we were']] },
      { name: 'Live', rooms: [['Hangout', 'voice', 'Drop in and talk']] },
    ],
  },
  {
    id: 'study', label: 'Study group', hint: 'Questions as posts, resources, a quiet room and office hours.',
    about: 'Learning together.',
    roles: [
      { key: 'tutor', name: 'Tutor', hue: 228, perms: ['post', 'announce', 'pin', 'highlight', 'moderate', 'invite'], icon: '🎓' },
      { key: 'student', name: 'Student', hue: null, perms: ['post', 'invite'] },
    ],
    groups: [
      { name: 'Study', rooms: [['Notices', 'news', 'News from the tutors'], ['Questions', 'forum', 'Ask one question per post', { tags: ['Maths', 'Science', 'Languages', 'Other'], required: true }], ['Resources', 'text', 'Links, notes and past papers']] },
      { name: 'Live', rooms: [['Study room', 'voice', 'Work quietly together'], ['Office hours', 'stage', 'Tutors answer questions live']] },
    ],
  },
  {
    id: 'gaming', label: 'Gaming', hint: 'Announcements, clips, looking for a group and squad rooms.',
    about: 'Where we squad up.',
    roles: [
      { key: 'mod', name: 'Moderator', hue: 255, perms: ['post', 'announce', 'pin', 'moderate', 'invite', 'kick', 'timeout', 'voicemod'], icon: '🛡️' },
      { key: 'player', name: 'Player', hue: null, perms: ['post', 'invite'] },
    ],
    groups: [
      { name: 'Hub', rooms: [['Announcements', 'news', 'Patch notes and game nights'], ['General', 'text', 'Anything goes'], ['Clips', 'text', 'Your best moments'], ['Looking for group', 'forum', 'Find people to play with', { tags: ['Casual', 'Ranked', 'Co-op'] }]] },
      { name: 'Voice', rooms: [['Squad 1', 'voice', 'Up to twelve'], ['Squad 2', 'voice', 'Up to twelve'], ['Stream nights', 'stage', 'Watch and listen together']] },
    ],
  },
  {
    id: 'club', label: 'Club', hint: 'Notices, events, ideas, meetings and a private committee room.',
    about: 'Our club, all in one place.',
    roles: [
      { key: 'committee', name: 'Committee', hue: 200, perms: ['post', 'announce', 'pin', 'highlight', 'moderate', 'invite', 'rooms'], icon: '⭐' },
      { key: 'member', name: 'Member', hue: null, perms: ['post', 'invite'] },
    ],
    groups: [
      { name: 'Club', rooms: [['Notices', 'news', 'News from the committee'], ['Lounge', 'text', 'Everyday conversation'], ['Ideas', 'forum', 'One idea per post', { tags: ['Events', 'Kit', 'Other'] }]] },
      { name: 'Meetings', rooms: [['Meetings', 'stage', 'Monthly meetings'], ['Committee', 'text', 'Only the committee sees this', { only: ['committee'] }]] },
    ],
  },
];

// A day's start in UTC, for the insights' day buckets.
export const dayOf = (ts) => Math.floor(ts / 86_400_000) * 86_400_000;

// Does this message mention a role I have (@Role name), where anyone may
// mention it? conv is a room or a thread in one.
export function mentionsRole(S, conv, m) {
  const roomId = conv.startsWith('t:') ? S.threads?.[conv]?.conv : conv;
  const h = S.houses?.[S.rooms?.[roomId]?.house];
  if (!h || !m.text || !m.text.includes('@')) return false;
  if (S.prefs?.rolesOff?.[h.id]) return false; // Suppress @role mentions for this house (js/inbox.js, server/inbox.js)
  const mine = new Set([h.members?.[S.me], ...(h.extra?.[S.me] || [])]);
  return h.roles.some((r, i) => i > 0 && mine.has(r.id) && r.mentionable !== false && roleMentioned(m.text, r.name));
}
// Does this text @mention a role by name? The browser (above) and the push
// service (server/places.js) both use it.
export function roleMentioned(text, name) {
  if (!text || !name || !text.includes('@')) return false;
  return new RegExp(`(^|[^\\w])@${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(text.toLowerCase());
}
