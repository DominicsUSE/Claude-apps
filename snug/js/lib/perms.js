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
// Moderation (server/safety.js, js/views/safety*.js). Acting on a person also
// needs a role above theirs; nobody can act on an owner.
PERMS.push(
  { id: 'kick', label: 'Remove people', hint: 'Remove someone from the house. They can come back with a new invitation.' },
  { id: 'ban', label: 'Ban people', hint: 'Remove someone and keep them out, optionally with their recent messages.' },
  { id: 'timeout', label: 'Time people out', hint: 'Stop someone writing, reacting and talking for a while.' },
  { id: 'voicemod', label: 'Moderate voice', hint: 'Mute, deafen, move and disconnect people in voice rooms.' },
  { id: 'audit', label: 'See the house log', hint: 'Read who changed what in this house.' },
);
// Places (server/places.js): nicknames per house.
PERMS.push(
  { id: 'nick', label: 'Change nickname', hint: 'Pick their own name and picture in this house.' },
  { id: 'nicks', label: 'Manage nicknames', hint: 'Change other people’s names and pictures here, below their own role.' },
);
// Soundboard (server/voiceopts.js, js/views/voiceopts*.js). Using it is open to
// everyone unless the house turns that off; then only these roles may.
PERMS.push(
  { id: 'soundboard', label: 'Use the soundboard', hint: 'Play this house’s sounds in its voice rooms, even when the house keeps the soundboard to some roles.' },
  { id: 'sounds', label: 'Manage sounds', hint: 'Add, rename and remove this house’s soundboard sounds, and choose who may play them.' },
);

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
  // Extra roles count too (js/lib/places.js, server/places.js).
  return role.perms.includes(perm) || (house.extra?.[userId] || []).some((id) => house.roles.find((r) => r.id === id)?.perms.includes(perm));
}

// Can this person write in this conversation, and if not, why?
export function canPost(S, conv) {
  const room = S.rooms[conv];
  if (!room) return { ok: true };
  // The server works out each room's permissions with its overrides (server/places.js).
  if (room.perms && !room.perms.send && !(room.kind === 'news' && !can(S, room.house, 'announce'))) {
    return { ok: false, why: `You can’t send messages in ${room.name}.` }; // notice rooms say who can, below
  }
  if (room.perms?.send) return { ok: true };
  if (room.kind === 'news' && !can(S, room.house, 'announce')) {
    const who = S.houses[room.house].roles.filter((r, i) => i === 0 || r.perms.includes('announce')).map((r) => r.name);
    return { ok: false, why: `Only ${who.join(' and ')} can post in ${room.name}. You can still react and reply in threads.` };
  }
  if (!can(S, room.house, 'post')) return { ok: false, why: 'Your role can read this room but not write in it.' };
  return { ok: true };
}
