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
  storageNote: 'Script running in Snug’s page can use the keys on this device. They can’t be copied out of the browser, but your account keys (needed on all your devices) can be read by that script.',
  unsupported: {
    insecure: 'This address isn’t secure (http), so the browser won’t do encryption here. Use the https address, or the Snug app.',
    old: 'This browser is too old for end-to-end encryption. Update it, or use the Snug app.',
    storage: 'This browser won’t keep keys (private window storage is off). Use a normal window.',
  },

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
  removeDeviceBody: 'That device stops getting new encrypted messages. It keeps what it already had.',
  serverSees: 'The server still sees who talks to whom, when, and how much; group names, reactions and pictures of groups; and which devices you have.',
  roomsNot: 'Room messages are stored on this server and can be read by whoever runs it and by moderators. They aren’t end-to-end encrypted.',
};

// Words that must never appear in user-facing encryption copy or the docs.
export const BANNED = ['unhackable', 'anonymous', 'military-grade', 'zero-knowledge'];
