// Every user-facing sentence about end-to-end encryption, in one place, so the
// wording can be checked against what the design actually protects (SECURITY.md
// and the e2ee spec's threat model). Rules: say what is encrypted and who can
// still see what; never "unhackable", "anonymous", "military-grade" or
// "zero-knowledge"; never call a house room secure or encrypted.

export const COPY = {
  name: 'End-to-end encryption',
  short: 'End-to-end encrypted',

  setupTitle: 'Turn on end-to-end encryption for your messages',
  setupBody: 'Direct messages and groups with people who have it on are encrypted on your device, and can be read only on your devices and theirs. This server stores them encrypted.',
  setupStill: 'The server still sees who talks to whom, when, and how much. Rooms in houses aren’t end-to-end encrypted.',
  inviteTitle: 'Encrypt your direct messages',
  inviteBody: 'Turn on end-to-end encryption so direct messages and groups are readable only on your devices and theirs.',
  setupNotHere: 'Not on this computer',
  setupOn: 'Turn on',
  setupBusy: 'Making your keys…',
  setupLater: 'You can turn it on later in Settings, Encryption.',

  keyTitle: 'Save your recovery key',
  keyWhy: 'Without this key, losing all your devices means losing your encrypted messages. Anyone with this key and your password can read them.',
  keyKeep: 'Keep it somewhere safe and off this device: a password manager, or printed and put away.',
  keyConfirm: 'To check you saved it, type the last group of four.',
  keyConfirmWrong: 'That isn’t the last group. Look at the key again.',
  keyLater: 'Later',
  keyDone: 'I’ve saved it',
  keyReminder: 'You haven’t confirmed you saved your recovery key.',

  browserNote: 'In a browser, Snug’s code comes from this server each time you open it. Whoever runs the server could change it to read your messages. The Snug app uses its own built-in code.',
  plainHttp: 'This server’s address isn’t https. Encrypted messages and attachments stay encrypted, but everything else (your password, room messages, names, who talks to whom) crosses the network readable to anyone on it.',
  storageNote: 'Script running in Snug’s page can use the keys on this device and read your account keys (needed on all your devices).',
  storageSealed: 'This computer’s own keys are sealed with the system key store, which that script can open too.',
  storagePlain: 'This device’s own keys can’t be copied out by that script, but they aren’t sealed: a copy of the stored data (the browser profile, or Snug’s data folder) includes them.',
  storageOld: 'This computer’s own keys were made before Snug sealed them with the system key store, so a copy of Snug’s data folder includes them. Reset encryption, or renew this computer’s key from another device, to get sealed ones.',
  unsupported: {
    insecure: 'This address isn’t secure (http), so the browser won’t do encryption here. Use the https address, or the Snug app.',
    old: 'This browser is too old for end-to-end encryption. Update it, or use the Snug app.',
    storage: 'This browser won’t keep keys (private window storage is off). Use a normal window.',
    locked: 'This computer’s encryption keys are locked: the system key store that protects them can’t open them now (it changed, or Snug’s data was copied from another computer). If it doesn’t come back, remove the keys here and add this computer again with another device or your recovery key.',
  },
  keyStoreNone: 'Your encryption keys aren’t protected by the system key store on this computer, so a copy of Snug’s data folder includes your account keys, recovery key and message keys.',
  keyStoreLockedAction: 'Remove this computer’s keys',

  pendingTitle: 'Approve this browser',
  pendingBody: 'Approve this browser from another device, or enter your recovery key, to read encrypted messages.',
  linkApprove: (label) => `Approve ${label}, signed in just now?`,
  linkShowCode: 'Type this on your new device. Never tell it to anyone, even someone who says they’re from Snug.',
  linkTypeCode: 'Type the code your other device shows.',
  linkMismatch: 'The code didn’t match. Start again on the new device.',
  linkDone: 'This device can now read your encrypted messages.',
  recoverTitle: 'Use your recovery key',
  recoverBody: 'Type the recovery key you saved when you turned on encryption.',
  recoverDone: 'Your encryption keys are back on this device.',

  verifyTitle: 'Safety number',
  verifyHow: 'Compare these numbers with the other person, in person or on a call. If they match, nobody (including this server) has put different keys between you.',
  verifyMark: 'Mark as verified',
  verifyUnmark: 'Remove verification',
  verified: 'Verified',
  notVerified: 'Not verified',
  identityChanged: (name) => `${name}’s safety number changed. Compare it again before trusting it.`,
  notReady: (name) => `${name} hasn’t set up end-to-end encryption yet.`,

  history: 'Let my new devices read my encrypted history',
  historyOnHint: 'On: a new device, or your recovery key, opens messages from before it was added. Anyone who later gets an unlocked device of yours, or your recovery key and password, can read that history too.',
  historyOffHint: 'Off: each device reads only messages sent while it was set up.',
  devicesTitle: 'Your devices',
  deviceKind: { web: 'Browser (code from this server)', app: 'Snug app (built-in code)' },
  removeDevice: 'Remove',
  removeDeviceBody: 'That device stops getting new encrypted messages, and history and settings sent from now on use new keys it doesn’t have. You also get a new recovery key to save, since the device could open your old backup. It keeps what it already had, including your account key.',
  lostLabel: 'It was lost or stolen',
  lostHint: 'Tell me what else to do.',
  lostWarn: 'Removing it isn’t enough if someone else has it: the device keeps your account key, so with your password, or with this server’s help, they could add a device of their own to your account, and the people you talk to would encrypt to it. Reset encryption to replace your account key, then sign out everywhere (Settings, Account).',
  ownAdded: (label) => `A device was added to your account: ${label}. If it isn’t yours, someone with your password or an old device of yours added it: remove it, then reset encryption.`,
  ownAddedMine: 'It’s mine',
  ownAddedReview: 'Review devices',
  staleRemove: (label) => `Remove “${label}” and continue?`,
  staleRemoveBody: 'It hasn’t been online for a long time, so it can’t get your new keys. Removing it also makes a new recovery key to save.',
  staleRemoveAction: 'Remove it and continue',
  exposedTitle: 'My keys may be exposed',
  exposedBody: 'Makes a new history key, a new key for your synced settings and a new recovery key, and gives them only to your devices. It protects what is sent from now on. It can’t take back what someone already opened with the old keys, and it doesn’t replace your account key: if that may be exposed, reset encryption.',
  exposedAction: 'Make new keys',
  metaProblem: {
    rollback: 'The server sent older synced encryption settings (verification marks, pinned keys, which conversations are encrypted) than this device has seen. Snug keeps using this device’s copy and won’t change them until you choose.',
    missing: 'The server no longer has your synced encryption settings, though this device has seen them. Snug keeps using this device’s copy and won’t change them until you choose.',
    damaged: 'Your synced encryption settings on the server can’t be opened. Snug keeps using this device’s copy and won’t change them until you choose.',
  },
  metaRepair: 'Put this device’s copy back on the server',
  ownChanges: 'Recent changes to your devices',
  selfAdded: (label) => `A device was added: ${label}.`,
  selfRemoved: (label) => `A device was removed: ${label}.`,
  serverSees: 'The server still sees who talks to whom, when, and how much; group names, reactions and pictures of groups; and which devices you have.',
  roomsNot: 'Room messages are stored on this server and can be read by whoever runs it and by moderators. They aren’t end-to-end encrypted.',

  resetTitle: 'Reset end-to-end encryption',
  resetBody: 'For when you’ve lost every device and your recovery key, or a device was stolen. You get new keys and a new recovery key. Messages encrypted before can’t be read any more, on any device. Everyone you talk to sees that your safety number changed.',
  resetStolen: 'If a device was stolen, remove it first if you can, then reset, then sign out everywhere (Settings, Account): a stolen device that’s still trusted holds your account key.',
  resetAction: 'Reset encryption',
  resetDone: 'Encryption was reset. Save your new recovery key.',

  // Conversations (spec 16.4)
  convOn: 'End-to-end encrypted',
  convPanel: 'Messages and attachments are encrypted on your device and can be read only on the devices of the people here. This server stores them encrypted. It still sees who talks to whom, when, and how much. Group names, reactions and pictures of the group aren’t encrypted.',
  convNotOn: 'Not end-to-end encrypted',
  convNot: (names, many) => `Not end-to-end encrypted. ${names} ${many ? 'haven’t' : 'hasn’t'} set up encryption yet. Messages are stored readable on this server.`,
  convNotYou: 'Not end-to-end encrypted. Turn it on for this device in Settings, Encryption. Messages are stored readable on this server.',
  convOff: 'Not end-to-end encrypted. Messages are stored readable on this server.',
  webMember: (name) => `${name} also reads this in a browser, with code served by this server.`,
  onLine: 'Messages are end-to-end encrypted from here on.',
  legacyLine: 'Messages above were sent before end-to-end encryption and are stored readable on this server.',
  legacyItem: 'Not end-to-end encrypted',
  serverNote: 'Snug note (not encrypted)',
  decrypting: 'Decrypting…',
  cantDecrypt: 'Couldn’t decrypt this message.',
  cantDecryptFile: 'Couldn’t decrypt this attachment.',
  locked: 'Encrypted message. Approve this browser from another device, or enter your recovery key, to read it.',
  encryptedQuote: 'Encrypted message',
  gifNote: 'The server sees what you search for and which GIF you pick. The GIF you send is encrypted on your device.',
  previewsOff: 'Link previews aren’t made in encrypted conversations.',
  pollsOff: 'Polls aren’t available in encrypted conversations yet.',
  rollOff: '/roll isn’t available in encrypted conversations: a fair roll needs the server to see the result.',
  joinedNote: 'Messages from before someone joins stay readable only to the people who were here.',
  changedLine: (name) => `${name}’s safety number changed. If you didn’t expect this, compare it again in Details.`,
  addedLine: (name, label) => `${name} added a device (${label}). If you didn’t expect this, compare your safety number in Details.`,
  removedLine: (name, label) => `${name} removed a device (${label}).`,
  newDeviceNote: (name, label) => `${name} added a device this week (${label}). What you send here is encrypted to it too. If you didn’t expect this, compare your safety number in Details.`,
  unsealed: 'Not encrypted – delivered by the server',
  unsealedHint: 'This conversation is end-to-end encrypted, but this message came without encryption: the server wrote or changed it. Don’t trust what it says.',
  removedDeviceItem: (name) => `Sent from a device ${name} has since removed`,
  gate: (name) => `${name}’s safety number changed since you verified it. Compare it again, or send anyway.`,
  sendAnyway: 'I understand, send anyway',
  verifyAgain: 'Verify again',
  downgraded: 'This server says this conversation isn’t encrypted any more. Snug won’t send here in plain text.',
  p2p: (name) => `Encrypted between your PC and ${name}’s PC. Stored readable on each PC.`,
  forwardPlain: (where) => `This will post the message unencrypted in ${where}.`,
  why: { moved: 'it was moved from where it was sent', signature: 'its signature didn’t check out', 'no key': 'this device has no key for it', 'unknown device': 'it came from a device Snug can’t check', 'removed device': 'it came from a device that was removed before it reached the server', commitment: 'its key doesn’t match what the sender signed', reply: 'the reply it shows doesn’t match what was sent', ciphertext: 'it was changed', author: 'its author doesn’t match', malformed: 'it’s damaged', body: 'its content doesn’t match its header', revision: 'it’s an older version', error: 'something went wrong' },
};

// Words that must never appear in user-facing encryption copy or the docs.
export const BANNED = ['unhackable', 'anonymous', 'military-grade', 'zero-knowledge'];

/**
 * 0.14: the storage line of “What it does and doesn’t do” for this device. Keys are sealed only in the
 * Snug app with a working system key store and a device key made there (manager.js deviceKeySealed()).
 */
export function storageNoteFor({ kind, keyStore, sealed }) {
  const app = kind === 'app';
  const rest = app && keyStore === 'os' ? (sealed ? COPY.storageSealed : COPY.storageOld) : COPY.storagePlain;
  return `${COPY.storageNote} ${rest}`;
}
