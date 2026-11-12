// Roles and permissions. A role is a name, a hue and a list of permissions.
// The first role in a house is its owner role and always has everything.

export const PERMS = [
  { id: 'post', label: 'Send messages', hint: 'Write in rooms and threads.' },
  { id: 'announce', label: 'Post notices', hint: 'Write in notice rooms, which are read-only for everyone else.' },
  { id: 'highlight', label: 'Curate highlights', hint: 'Add and remove a room’s highlighted messages.' },
  { id: 'moderate', label: 'Remove messages', hint: 'Delete messages written by other people.' },
  { id: 'pin', label: 'Pin messages', hint: 'Pin and unpin messages in rooms. People who can remove messages can pin too.' },
  { id: 'rooms', label: 'Manage rooms', hint: 'Create, rename and delete rooms.' },
  { id: 'invite', label: 'Invite people', hint: 'Create invitation links.' },
  { id: 'roles', label: 'Manage roles and members', hint: 'Edit roles, and change who has them.' },
];
// Custom emoji per house (server/emoji.js, js/views/emoji-custom.js).
PERMS.push({ id: 'emoji', label: 'Manage emoji', hint: 'Add, rename and remove this house’s custom emoji.' });

export function roleOf(S, houseId, userId = S.me) {
  const house = S.houses[houseId];
  if (!house) return null;
  const id = house.members[userId];
  return house.roles.find((r) => r.id === id) || null;
}

export function can(S, houseId, perm, userId = S.me) {
  const house = S.houses[houseId];
  const role = roleOf(S, houseId, userId);
  if (!house || !role) return false;
  if (house.roles[0].id === role.id) return true;
  return role.perms.includes(perm);
}

// Can this person write in this conversation, and if not, why?
export function canPost(S, conv) {
  const room = S.rooms[conv];
  if (!room) return { ok: true };
  if (room.kind === 'news' && !can(S, room.house, 'announce')) {
    const who = S.houses[room.house].roles.filter((r, i) => i === 0 || r.perms.includes('announce')).map((r) => r.name);
    return { ok: false, why: `Only ${who.join(' and ')} can post in ${room.name}. You can still react and reply in threads.` };
  }
  if (!can(S, room.house, 'post')) return { ok: false, why: 'Your role can read this room but not write in it.' };
  return { ok: true };
}
