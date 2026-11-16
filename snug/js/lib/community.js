// Houses and community: rules shared by the server (server/community.js) and
// the browser (js/views/community-settings.js). The server applies every one
// of them; the browser uses them only to explain, preview and count down.
import { fold } from './util.js';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// ---------- Categories ----------
export const GROUP_NAME_MAX = 40;
export const MAX_GROUPS = 50;

// ---------- House pictures ----------
// Kinds, their byte limits and the largest side in pixels. The type always
// comes from the bytes, never from what the browser says.
export const PICTURES = {
  icon: { label: 'Icon', bytes: 1024 * 1024, maxPx: 512, minPx: 32, square: true },
  banner: { label: 'Banner', bytes: 2 * 1024 * 1024, maxPx: 4096, minPx: 64, square: false },
  splash: { label: 'Invitation background', bytes: 2 * 1024 * 1024, maxPx: 4096, minPx: 64, square: false },
};
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const COVER_BYTES = 2 * 1024 * 1024;

// ---------- Events ----------
export const LOCATION_MAX = 100;
export const RSVP_KINDS = ['going', 'interested'];
export const REMIND_LEAD = 15 * MIN;

// ---------- Verification and pausing invitations ----------
// none; an account older than 5 minutes; older than a day and a member for 10 minutes.
export const VERIFY_LEVELS = [
  ['none', 'None', 'Anyone in the house can take part at once.'],
  ['low', 'Account older than 5 minutes', 'New accounts wait a few minutes before writing, reacting or joining voice.'],
  ['high', 'Account older than a day, here for 10 minutes', 'For houses that get raided: newcomers settle in before taking part.'],
];
export const VERIFY_IDS = VERIFY_LEVELS.map(([v]) => v);
// When this person may take part, or 0 if they already can. account: when
// the account was made; joined: when they joined this house.
export function verifyWaitUntil(level, { account = 0, joined = 0 } = {}) {
  if (level === 'low') return account + 5 * MIN;
  if (level === 'high') return Math.max(account + DAY, joined + 10 * MIN);
  return 0;
}
// Hours to pause invitations for; 0 means until someone lifts it.
export const PAUSE_HOURS = [1, 6, 24, 0];
export const NEVER = 8_640_000_000_000_000;
export const pauseLabel = (h) => (h ? `${h} hour${h === 1 ? '' : 's'}` : 'Until I lift it');

// ---------- Custom invitation links ----------
export const VANITY = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const RESERVED = new Set([
  'admin', 'api', 'app', 'help', 'join', 'login', 'logout', 'register', 'settings', 'snug', 'support', 'staff',
  'official', 'invite', 'invites', 'discover', 'home', 'about', 'security', 'mod', 'mods', 'moderator', 'owner', 'system',
]);
// Why this word can't be a link, or '' if it can.
export function vanityProblem(word) {
  if (typeof word !== 'string') return 'Pick a word for the link.';
  const w = word.trim().toLowerCase();
  if (w.length < 3 || w.length > 32) return 'Links are 3 to 32 characters.';
  if (!VANITY.test(w)) return 'Use lowercase letters, numbers and dashes, starting and ending with a letter or number.';
  if (RESERVED.has(w)) return `“${w}” is kept for Snug itself. Try another word.`;
  return '';
}

// ---------- Automatic moderation: spam rules ----------
export const SPAM_ACTIONS = [['block', 'Block the message'], ['flag', 'Let it through and flag it'], ['timeout', 'Block it and time the person out']];
export const SPAM_ACTION_IDS = SPAM_ACTIONS.map(([v]) => v);
export const SPAM_RULES = [
  { id: 'mentions', label: 'Too many mentions', hint: 'More different people or roles mentioned in one message than this.', min: 3, max: 50, def: 5, unit: 'mentions' },
  { id: 'flood', label: 'Flooding', hint: 'The same words this many times in 30 seconds, or more messages than this in 10 seconds.', min: 3, max: 20, def: 5, unit: 'messages' },
  { id: 'invites', label: 'Invitations to other houses', hint: 'Snug invitation links that lead somewhere other than this house.' },
  { id: 'caps', label: 'Shouting', hint: 'More than 70% capital letters in a message with over 20 letters.' },
];
export const SPAM_DEFAULT = Object.freeze({
  mentions: 0, mentionsAction: 'block', flood: 0, floodAction: 'timeout', invites: false, invitesAction: 'block',
  caps: false, capsAction: 'flag', exemptRooms: [],
});
export const FLOOD_SAME_MS = 30_000;
export const FLOOD_BURST_MS = 10_000;

// Distinct @mentions in a message: people, roles and @everyone, once each.
export function mentionCount(text) {
  if (!text) return 0;
  const seen = new Set();
  for (const m of String(text).matchAll(/(^|[^\w@])@([\p{L}\p{N}_.-]{1,40})/gu)) seen.add(m[2].toLowerCase().replace(/[.-]+$/, ''));
  return seen.size;
}
// Over 70% capitals, in a message with more than 20 letters.
export function shouting(text) {
  const letters = [...String(text || '').replace(/https?:\/\/\S+/g, '').replace(/<a?:\w+:\w+>/g, '')].filter((c) => /\p{L}/u.test(c));
  if (letters.length <= 20) return false;
  const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return upper / letters.length > 0.7;
}
// Codes in Snug invitation links in a message: /join/<code>, any host.
export function inviteCodes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:^|[\s(<])(?:https?:\/\/)?[\w.-]*(?::\d+)?\/join\/([\w-]{3,40})/gi)) out.push(m[1]);
  return [...new Set(out)];
}
// Flooding, from this person's recent messages in the house ({ ts, text }),
// the new one not included. limit: the rule's number.
export function flooding(recent, text, now, limit) {
  if (!limit) return false;
  const f = fold(text || '').trim();
  const same = f ? recent.filter((r) => r.ts > now - FLOOD_SAME_MS && r.text === f).length + 1 : 0;
  const burst = recent.filter((r) => r.ts > now - FLOOD_BURST_MS).length + 1;
  return same >= limit || burst > limit * 2;
}

// ---------- Moving rooms and categories (the browser's preview of room.move) ----------
// groups: [{ id, rooms: [ids] }] in order. Each returns a new list.
export function placeRoom(groups, room, group, to) {
  const out = groups.map((g) => ({ ...g, rooms: g.rooms.filter((r) => r !== room) }));
  const g = out.find((x) => x.id === group);
  if (!g) return groups;
  g.rooms.splice(Math.max(0, Math.min(to, g.rooms.length)), 0, room);
  return out;
}
export function placeGroup(groups, group, to) {
  const i = groups.findIndex((g) => g.id === group);
  if (i < 0) return groups;
  const out = [...groups];
  const [g] = out.splice(i, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, g);
  return out;
}
// Where one step up (-1) or down (+1) takes a room: the next place in its
// category, or across into the one before or after. Null at either end.
export function stepRoom(groups, room, dir) {
  const gi = groups.findIndex((g) => g.rooms.includes(room));
  if (gi < 0) return null;
  const ri = groups[gi].rooms.indexOf(room);
  if (dir < 0) {
    if (ri > 0) return { group: groups[gi].id, to: ri - 1 };
    return gi > 0 ? { group: groups[gi - 1].id, to: groups[gi - 1].rooms.length } : null;
  }
  if (ri < groups[gi].rooms.length - 1) return { group: groups[gi].id, to: ri + 1 };
  return gi < groups.length - 1 ? { group: groups[gi + 1].id, to: 0 } : null;
}
