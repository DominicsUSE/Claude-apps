// What Snug can honestly say about who can see what (Settings > Privacy and
// safety, and the privacy page: js/views/privacy.js). Plain functions, so the
// words for each mode can be tested without a browser (tests/logic-privacy.test.js).
//
// Two modes:
// - host: a Snug server (a website, or someone's desktop app that other people
//   join over their network). Everything is stored on that server.
// - p2p: the desktop app's own account, talking to friends on other PCs.
// Rules for every line here: never "anonymous", "unhackable" or "only you can
// read it" unless it is true for this mode and this conversation; say who runs
// what; say what a lawful request could reach.

export const PRESENCE_TO = [['everyone', 'Everyone I share a place with'], ['friends', 'Friends only'], ['nobody', 'Nobody']];
const presenceLine = {
  everyone: 'People who share a house, a conversation or a friendship with you see when you’re online, and when you last wrote.',
  friends: 'Only your friends see when you’re online and when you last wrote. Everyone else sees you as offline.',
  nobody: 'Nobody sees when you’re online or when you last wrote, and your typing isn’t shown.',
};

// "this Snug at chat.example.org" (or the address with its port, for a PC on a home network).
export const snugAt = (host) => (host ? `this Snug at ${host}` : 'this Snug');

// Sections of { id, title, items } for the mode the app is in.
export function whoSeesWhat({
  mode = 'host', host = '', https = true, e2ee = false, presenceTo = 'everyone', stun = 'google', turn = false,
  linkPreviews = true, friendPreviews = false,
} = {}) {
  const here = snugAt(host);
  const sections = [];
  if (mode === 'p2p') {
    sections.push({
      id: 'messages', title: 'Your messages',
      items: [
        'Messages, pictures and files with friends on other PCs travel encrypted between your PC and theirs. The Snug directory passes them on sealed and can’t read them.',
        'They are stored readable on each PC: yours and your friend’s. Anyone who can use either PC, or copies its disk, can read them. Snug can’t delete the copy on a friend’s PC.',
        'People who join your PC over your home network keep their messages on your PC, so you, as its owner, could read them.',
      ],
    });
    sections.push({
      id: 'directory', title: 'The Snug directory',
      items: [
        'The directory (Snug’s registry, run on Cloudflare) sees when you’re online, which accounts are your friends or share a group with you (it keeps that list to tell you when they come online), and when your PC contacts theirs.',
        'It keeps the key to your data file (.snugvault), wrapped under its own secrets, and gives it only to your current PC. Someone with both your data file and the directory’s secrets could open the file.',
        'It stores your internet address only as a keyed hash or shortened, to limit abuse.',
      ],
    });
    sections.push({
      id: 'network', title: 'Your network and hosting companies',
      items: [
        'Your internet provider and anyone on your network can see that your PC talks to the Snug directory and to friends’ PCs, when, and how much. Not what you say.',
        turn
          ? 'Calls go straight between PCs when they can, encrypted. When they can’t, a relay on Cloudflare passes them on: it sees both addresses, not the sound or picture. With “Hide my IP from friends” on, Snug uses the relay whenever one is available.'
          : 'Calls go straight between PCs, encrypted, so the other side of a call sees your internet address.',
        friendPreviews
          ? 'Previews for links friends send are on: your PC fetches those sites, so they see your internet address.'
          : 'Links friends send don’t get a preview unless you turn that on, because fetching a preview would show the site your internet address. Links you send get previews fetched by your PC.',
      ],
    });
  } else {
    sections.push({
      id: 'messages', title: 'Your messages',
      items: [
        `Messages, files and profiles are stored on the server ${here} runs on. Whoever runs it can read houses and rooms, and could be made to hand them over.`,
        e2ee
          ? 'Direct messages and groups marked “End-to-end encrypted” can be read only on the devices of the people in them. The server stores them scrambled; it still sees who talks to whom, when, and who is in each group. Settings > Encryption says whether yours are.'
          : `Direct messages are stored on the same server and are not end-to-end encrypted: whoever runs ${here} could read them.`,
        'People in a conversation can copy, screenshot or forward what they see there.',
      ],
    });
    sections.push({
      id: 'network', title: 'Your network and hosting companies',
      items: [
        https
          ? `Your internet provider and anyone on your network can see that you use ${here}, when, and how much. The connection is encrypted, so not what you say.`
          : `This Snug uses a plain connection (http), so anyone on your network could read what you send to ${here}. Use it only on a network you trust.`,
        `The company hosting ${here}, if there is one, can see what the server stores, like the person who runs it.`,
        'Voice and video go straight between devices when they can, encrypted, so people in a call can see each other’s internet address. A relay server, if this Snug has one, passes calls on without hearing them.',
        stun === 'google'
          ? 'To set up calls, your browser asks a Google server (STUN) for your public address. Google sees that address, not the call.'
          : stun === 'none' ? 'Calls don’t ask any outside server for your address.' : 'To set up calls, your browser asks this Snug’s chosen STUN server for your public address.',
        linkPreviews
          ? `Link previews are fetched by ${here}, not your device, so linked sites see the server’s address, not yours.`
          : 'Link previews are turned off on this Snug.',
      ],
    });
  }
  sections.push({ id: 'online', title: 'When you’re online', items: [presenceLine[presenceTo] || presenceLine.everyone] });
  sections.push({
    id: 'never', title: 'What Snug never does',
    items: [
      'Snug sends no analytics, diagnostics or crash reports anywhere, and shows no ads. It asks for no email address or phone number.',
      'Snug is not anonymous. The people you talk to, and whoever runs the servers above, know your username and can see the activity described here.',
    ],
  });
  return sections;
}

// How long this Snug keeps things, from GET /api/privacy (server/privacy.js).
export function keptFor(a = {}) {
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  const out = [
    `Sign-in history and security events: ${days(a.logDays ?? 30)}, with internet addresses shortened (like 203.0.113.x).`,
    `Failed sign-in counters: ${a.failureHours ?? 48} hours, with addresses stored only as a keyed hash.`,
    `Deleted messages can be brought back for 10 minutes; after about ${a.undoMinutes ?? 11} minutes their text is gone from the database.`,
    `Signed-in devices: until you sign out, ${days(a.sessionDays ?? 30)} at most${a.idleDays && a.idleDays < (a.sessionDays ?? 30) ? `, or ${days(a.idleDays)} unused` : ''}. Snug stores the kind of device, not your address.`,
    'Messages, files and your profile: until you delete them or your account.',
  ];
  if (a.backupDays) out.push(`Encrypted backups of the database are kept for ${days(a.backupDays)}, so something you delete can stay in a backup that long.`);
  return out;
}
