// Getting someone in: reading an invitation they pasted, saying plainly why
// an invitation doesn't work, checking a new account's fields all at once,
// and choosing where a newcomer lands. Pure functions, shared by the client
// (js/views/auth.js, modals.js, nav.js) and the server (server/community.js).
import { canPost } from './perms.js';
import { VOICE_KINDS } from './places.js';

// The code inside whatever someone pasted: a full link (https://host/join/<code>),
// an app link (snug://join/<code>), a path (/join/<code>) or the bare code.
// Codes are 3 to 40 letters, numbers, dashes or underscores (3: a house's own
// word, server/community.js). null when nothing in it looks like a code.
export function parseInvite(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /(?:^|\/)join\/([\w-]{3,40})(?=$|[/?#\s])/i.exec(s);
  if (m) return m[1];
  return /^[\w-]{3,40}$/.test(s) ? s : null;
}

// Why an invitation row can't be used, or null when it can. Mirrors the checks
// in server/safety.js invite.accept (revoked, use limit, expiry).
export function inviteProblem(inv, now = Date.now()) {
  if (!inv) return 'unknown';
  if (inv.revoked) return 'revoked';
  if (inv.max_uses && inv.uses >= inv.max_uses) return 'used';
  if (inv.expires < now) return 'expired';
  return null;
}

// What to tell the person, for each reason. Every one ends with what to do.
export const INVITE_WHY = {
  unknown: 'This link doesn’t match any invitation on this Snug. Check it was copied in full, or ask for a new one.',
  expired: 'This invitation has expired. Ask the person who sent it for a new link.',
  used: 'This invitation has been used as many times as it allows. Ask for a new link.',
  revoked: 'Whoever made this invitation has turned it off. Ask for a new link.',
};
export const inviteWhy = (reason) => INVITE_WHY[reason] || INVITE_WHY.unknown;

// The same rules as the server (server/index.js HANDLE, server/account.js
// register, server/auth.js passwordProblem), so every problem shows at once,
// next to its field, before anything is sent. The server still checks
// everything, including the list of common passwords.
const HANDLE = /^[a-z0-9](?:[a-z0-9_.-]{0,22}[a-z0-9])?$/;
export function signupProblems({ handle = '', name = '', password = '' } = {}) {
  const out = {};
  const h = String(handle).trim().toLowerCase().replace(/^@/, '');
  if (!h) out.handle = 'Pick a username.';
  else if (/\s/.test(h)) out.handle = 'Usernames can’t have spaces. Try a dot or a dash instead.';
  else if (h.length > 24) out.handle = 'Usernames can be up to 24 characters.';
  else if (!HANDLE.test(h)) out.handle = 'Use only letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.';
  const n = String(name).trim();
  if (!n) out.name = 'Tell people what to call you.';
  else if (n.length > 40) out.name = 'Your name can be up to 40 characters.';
  if (password.length < 8) out.password = password ? `Passwords need at least 8 characters. That’s ${password.length}.` : 'Choose a password of at least 8 characters.';
  else {
    const squash = password.toLowerCase().replace(/[^a-z0-9]/g, '');
    const inIt = [h, n].some((w) => { const x = w.toLowerCase().replace(/[^a-z0-9]/g, ''); return x.length >= 3 && squash.includes(x); });
    if (inIt) out.password = 'Your password can’t contain your username or name.';
  }
  return out;
}

// Which field a server sign-up refusal is about (it sends one sentence).
export function signupField(message = '', status = 0) {
  if (status === 409 || /^Usernames|username\b.*taken|is taken/i.test(message)) return 'handle';
  if (/^Your name/i.test(message)) return 'name';
  if (/password/i.test(message)) return 'password';
  return null;
}

// Newcomers see their starter rooms and every voice and stage room: there is
// no history in a voice room to earn, and hearing people is how many people
// say hello. The rest joins the sidebar after their first message; every room
// can be read before that (server/ops.js never gated reading).
export function newcomerSees(house, roomId, kind) {
  return !house?.newcomer || house.starter.includes(roomId) || VOICE_KINDS.includes(kind);
}

// Where someone lands after joining: the first starter room they can write
// in, then any text room they can write in, then the first starter room.
// Never a notice room they can only read, never a voice room.
export function landingRoom(S, houseId) {
  const h = S.houses[houseId];
  if (!h) return null;
  const all = h.groups.flatMap((g) => g.rooms).filter((r) => S.rooms[r]);
  const writable = (r) => !VOICE_KINDS.includes(S.rooms[r].kind) && canPost(S, r).ok;
  return h.starter.filter((r) => S.rooms[r]).find(writable) || all.find(writable) || h.starter.find((r) => S.rooms[r]) || all[0] || null;
}

// The people a "New message" can go to: the server's rule (server/model.js
// dmPeers): anyone you share a house with, anyone already in a conversation
// with you, and accepted friends. A pending request is not enough.
export function messageable(S) {
  const out = new Set();
  for (const h of Object.values(S.houses)) if (h.joined) for (const u of Object.keys(h.members || {})) out.add(u);
  for (const d of Object.values(S.dms)) for (const u of d.members || []) out.add(u);
  for (const [u, f] of Object.entries(S.friends || {})) if (f.state === 'friends') out.add(u);
  out.delete(S.me);
  return out;
}

// Why someone can't be messaged yet, in words that say what would change it.
export function whyNotMessageable(S, id) {
  const f = S.friends?.[id]?.state;
  if (f === 'outgoing') return 'You can message them once they accept your friend request.';
  if (f === 'incoming') return 'They asked to be friends. Accept on the Friends page to message them.';
  return 'You can message friends and people you share a house with. Send a friend request first.';
}

// Addresses only this computer or this network can open. An invitation made
// on one of these won't work for someone elsewhere.
export function localOnly(hostname = '') {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)) return 'computer';
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h.endsWith('.local')) return 'network';
  return null;
}

// Something typed into "Add a friend" that is an email address, not a username.
export const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim().replace(/^@/, ''));
