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
  friends: 'Only your friends see when you’re online, your status and when you last wrote. Everyone else sees you as offline and, unless they are in it with you, not in a voice room. Everyone still sees when each message was sent.',
  nobody: 'Nobody sees when you’re online, your status or when you last wrote, and your typing isn’t shown. Only people in a voice room with you see you there.',
};

// "this Snug at chat.example.org" (or the address with its port, for a PC on a home network).
export const snugAt = (host) => (host ? `this Snug at ${host}` : 'this Snug');

// Sections of { id, title, items } for the mode the app is in.
export function whoSeesWhat({
  mode = 'host', host = '', https = true, e2ee = false, presenceTo = 'everyone', stun = 'google', turn = false,
  linkPreviews = true, friendPreviews = false, turnStatic = false,
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
        turn
          ? 'To set up a call, your PC asks a STUN server for your public address: Cloudflare’s once it has relay details from the directory (it asks for them when a call starts), otherwise Google’s. That server sees your address, not the call.'
          : 'To set up a call, your PC asks Google’s STUN server for your public address. Google sees that address, not the call.',
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
        // calls C1, C3, C4 (0.14)
        turn
          ? 'Calls go through this Snug’s relay server by default, so people in a call don’t see your internet address (you can turn that off). The relay sees your address, when and how much, not what is said. Calls labelled “End-to-end encrypted” can’t be heard or seen by the server or the relay; others are encrypted in transit only.'
          : 'Voice and video go straight between devices, encrypted, so people in a call can see each other’s internet address; Snug says so before you join. Calls labelled “End-to-end encrypted” can’t be heard or seen by the server; others are encrypted in transit only.',
        ...(turnStatic ? ['This Snug’s relay uses one login for everyone that never expires, so the relay can’t tell people apart, but anyone with a copy of the login can use the relay.'] : []),
        stun === 'google'
          ? `To set up calls, your browser asks a Google server (STUN) for your public address. Google sees that address, not the call. Whoever runs ${here} can turn this off (SNUG_STUN=none) or use their own relay instead.`
          : stun === 'none' ? 'Calls don’t ask any outside server for your address.'
            : stun === 'relay' ? `To set up calls, your browser asks ${here}’s TURN relay server (the same one that passes calls on) for your public address, so no separate STUN company is asked. Whoever runs that relay sees your address, not the call.`
              : 'To set up calls, your browser asks this Snug’s chosen STUN server for your public address. Whoever runs that server sees your address, not the call.',
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

// What this Snug stores and for how long, from GET /api/privacy (server/privacy.js; the windows the server
// really purges at, server/retention.js). `e2ee`: this server offers end-to-end encryption. `desktopApp`:
// running in the desktop app, whose update checks go to GitHub (`updates`: auto | notify | manual).
// `p2p`: the desktop app's own account, which also uses the Snug directory.
export function keptFor(a = {}, { e2ee = false, desktopApp = false, updates = 'auto', p2p = false } = {}) {
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  const hours = (n) => `${n} hour${n === 1 ? '' : 's'}`;
  const out = [
    `Sign-in history and security events: ${days(a.logDays ?? 14)}, with internet addresses shortened (like 203.0.113.x) and the kind of device (like “Firefox on Windows”), not your browser’s full details.`,
    `Failed sign-in counters: ${a.failureHours ?? 48} hours, with addresses stored only as a keyed hash.`,
    `Deleted messages can be brought back for 10 minutes; after about ${a.undoMinutes ?? 11} minutes their text is gone from the database.`,
    `Signed-in devices: until you sign out, ${days(a.sessionDays ?? 30)} at most${a.idleDays && a.idleDays < (a.sessionDays ?? 30) ? `, or ${days(a.idleDays)} unused` : ''}. Snug stores the kind of device, not your address.`,
    ...(a.activity === 'day' ? ['When each device or encryption key was last used: the day only, not the time.'] : []),
    'Messages, files and your profile: until you delete them or your account.',
    'Call records (who called, whether it was answered or missed, and how long it lasted): a line in that conversation, kept like its messages.',
    'Reactions, where you’ve read up to, pins and saved messages: until you remove them, or the message goes.',
    ...(a.memberLogDays ? [`When someone joins or leaves a house: ${days(a.memberLogDays)}, so its owners can see how many joined and left each day.`] : []),
    ...(a.linkCacheHours ? [`Link previews: the linked address and the preview fetched for it, ${hours(a.linkCacheHours)}. A preview shown under a message stays with that message.`] : []),
    ...(a.friendCooldownHours ? [`Friend requests that were declined or taken back: ${hours(a.friendCooldownHours)}, so the same request can’t be sent again at once.`] : []),
    `Notifications while Snug is closed: the push address your browser gave (run by its maker, like Google, Mozilla or Apple) is kept until that sign-in ends. Each note is encrypted to your device; the push service sees when one arrives and holds it ${hours(a.pushTtlHours ?? 24)} at most.`,
    'GIF searches: the words go to the GIF service through this Snug (or the Snug directory), so the service never sees your address. Results are cached for an hour (in this Snug’s memory, or in the directory’s Cloudflare cache, keyed by the words searched), not saved in the database.',
  ];
  if (e2ee) {
    out.push('In end-to-end encrypted conversations the server can’t read messages, but it stores who sends to whom and when, how big each message is, and who is mentioned (so they can be notified).');
    out.push('Encryption device records (the device’s name, kind, when it was added and the day it was last used): until the device is removed or encryption is reset. Removed devices stay listed as removed.');
  }
  if (a.backupDays) out.push(`Encrypted backups of the database are kept for ${days(a.backupDays)}, so something you delete can stay in a backup that long.`);
  if (p2p) out.push('The Snug directory keeps your account, your friends list (to tell you when they come online) and roughly when your PC last connected (updated at most once a day). It stores internet addresses only as a keyed hash, for abuse limits that go after 2 days.');
  if (desktopApp) {
    out.push(updates === 'manual'
      ? 'Updates: the app asks GitHub for a new version only when you ask (Settings > Desktop app). GitHub then sees your internet address.'
      : `Updates: the app asks GitHub for a new version when it starts and about once a day after, so GitHub sees your internet address and that Snug is running. ${updates === 'notify' ? 'It tells you about a new version and installs it when you say.' : 'It installs a new version by itself.'} You can change this in Settings > Desktop app.`);
  }
  return out;
}

// "Active today", or "Last active 2 Nov 2026": a day is all the server keeps (server/auth.js activeDay),
// read in UTC so the date is the one the server stored.
export function lastActive(ts, now = Date.now()) {
  const day = (t) => Math.floor(t / 86_400_000);
  if (day(ts) >= day(now)) return 'Active today';
  return `Last active ${new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}`;
}
