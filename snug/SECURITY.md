# Security policy for Snug

## Reporting a vulnerability

Please report security problems **privately**, never in a public issue, pull request or discussion.

1. Open <https://github.com/DominicsUSE/Claude-apps/security/advisories/new> (repository **Security** tab,
   **Report a vulnerability**). This is GitHub's private vulnerability reporting: only you and the
   maintainers can see the report.
2. Say which part is affected (the web/local server, the desktop app, the registry at
   `snug-registry.snugapp.workers.dev`), the version (Settings, About, or `package.json`), the steps to
   reproduce, and what an attacker gains.
3. Do not include anyone else's data, and do not test against accounts that are not yours.

What happens next: an acknowledgement within 7 days, an assessment within 14, and a fix in a new release as
fast as the severity calls for. A fixed desktop release is pushed to every install by the built-in updater,
and the registry can refuse versions below a minimum. You are credited in the advisory unless you ask not to
be. Good-faith research that follows this policy is welcome and will not be pursued.

Problems in a dependency (Electron, `ws`, Cloudflare Workers) go to that project too; tell us as well, so
Snug can ship the patched version.

## Supported versions

| Version | Supported |
| --- | --- |
| The latest release (0.12.x) | Yes |
| Anything older | No. The desktop updater moves every install to the latest release, and the registry can refuse old versions (`min_version`). |

Security fixes go into the newest release only; there are no backports.

## Security model

### What Snug protects

- **Accounts.** Passwords (web and LAN accounts) are stored as scrypt hashes, with common passwords (about
  38,000) refused, two-factor sign-in (TOTP with backup codes) and slowing lockouts that a stranger cannot
  use to lock the owner out. Desktop (P2P) accounts have no password at all. Since v0.12 they need no
  GitHub account either: the account is the PC's device key plus a recovery key (20 random bytes shown
  once; the registry keeps only the public half of a key derived from it, `registry/src/keyacct.js`).
  GitHub accounts still work: their token is checked once by the registry and revoked, never stored.
- **Server accounts that forgot their password** (v0.12). A recovery key resets the password with no email:
  the server keeps only a scrypt hash of a key derived from it, so a database thief or the server's owner
  can't use it. Using it signs out every device and removes passkeys; a key works once. Anyone holding the
  key and the username can do the same, so it is as sensitive as the password, and it gets past two-factor
  sign-in (someone who forgot a password has often lost the phone too). So replacing a key needs the
  password (and a code): a session alone may save only a first key, within 10 minutes of signing up or of
  using the old key. Wrong keys are counted per account and address, so tries from elsewhere can't lock the
  owner out. The owner's `npm run reset-password` deletes the key too. Optional **passkeys** add a sign-in
  that phishing pages can't replay (bound to the server's domain); only their public halves are stored.
  Since 0.13 a passkey checked just now (single-use challenge for that account, user verification
  required) can replace the password and code when you change the password, remove a passkey, replace a
  recovery key, turn two-factor sign-in on or off, make new backup codes, or deactivate or delete the
  account (the username is still typed to delete). Changing your username, and deleting or handing over a
  house, still ask for the password or code. A failed check counts like a wrong password.
  The same recovery key now also seals the encryption backup when saved on a device with encryption
  unlocked, so whoever holds it can both reset the password and read the encrypted history
  backup, as the README always said it would.
- **Account takeover with a recovery key.** Someone who copies the recovery key only starts a **move**,
  which waits 72 hours unless the current PC approves. The current PC is told it was the recovery key, can
  stop it, and can then replace the key with the old one in hand (the copy stops working at once). The copy
  can't stop the PC from pressing Stop: the recovery key and the device key keep separate replay counters,
  and signed changes can be dated at most a minute ahead.
- **A stolen current PC.** The PC's key alone can't add a second proof at once: a new recovery key set
  without the old one, a GitHub account's first recovery key, and linking or unlinking GitHub on an account
  without GitHub all wait 7 days. The recovery key cancels them; so does a GitHub sign-in (a GitHub
  account's own, or the linked GitHub of an account without GitHub, which can cancel an unlink or a new
  recovery key). The person can do this from a new PC while the account moves there: it shows the waiting
  changes. Since 0.13 the PC's key alone may also cancel a waiting GitHub link or a first recovery key: that
  only puts back what was there (the PC could already replace a waiting change with its own), while a
  waiting unlink, or a key that replaces one, still needs the recovery key or GitHub. The PC's key can't replace a linked GitHub (unlink first, which waits), and deleting the account
  through a linked GitHub needs a link that has worked for at least 7 days. With the device and the recovery
  key together, a link or unlink happens at once. If the thief has the PC and the person has only the linked
  GitHub (no recovery key), neither side can remove the other's proof; the registry owner settles it. The
  registry owner's forced move (`move.force`) must name the security code (or key) of the person's new PC,
  so the thief can't use it up with a move of its own or swap one in. The PC's key can still move the account at once with a pairing code and stop
  other moves; recovery from that is the registry owner's forced move (`registry/SECURITY.md`).
- **Account takeover through GitHub.** Someone who phishes or steals the GitHub login only starts a
  **move**, which waits 72 hours (or the approval of the current PC). The current PC is told and can stop it.
  Until then the newcomer gets no vault key and no data file.
- **Sessions.** Random 256-bit tokens in `HttpOnly`, `SameSite`, `__Host-`/`Secure` cookies (over HTTPS).
  Only a hash is stored. Sessions expire, and a password change or "sign out everywhere" ends the rest.
- **Who can see and do what.** Every action is authorized on the server against the database (membership,
  roles, blocks, privacy settings). The browser only decides what to show.
- **Messages between PCs.** Friends on different PCs talk over an end-to-end encrypted link (signed X25519
  handshake, then AES-256-GCM, forward secret and replay-safe). The registry relays sealed frames and never
  sees content. Each friend's key is pinned and a change is shown loudly.
- **Data at rest that matters most.** Device identity keys are wrapped with the operating system's key store
  (Electron `safeStorage`). Two-factor secrets and database snapshots are encrypted with AES-256-GCM under a
  data key kept outside the database. The portable data file (`.snugvault`) is AES-256-GCM encrypted and
  tamper-evident, under a key the registry holds wrapped and hands only to the account's current device.
- **The desktop app itself.** Sandboxed, context-isolated renderers with no Node access, navigation and new
  windows locked to Snug's own origin, Electron fuses that turn off `RunAsNode`, `NODE_OPTIONS` and the
  inspector and enforce asar integrity, and an updater that installs only files whose SHA-256 matches the
  release's checksum file (and, once a key is pinned, that file's Ed25519 signature).
- **Common web attacks.** Prepared SQL statements only; messages rendered as a token tree, never as HTML; a
  strict Content-Security-Policy with scripts only from Snug; cross-site requests and WebSocket upgrades
  refused unless they come from Snug's origin; `Host` checking against DNS rebinding; outbound fetches limited
  (GIFs: only the provider's media hosts, no redirects; link previews: public addresses only, each redirect
  checked, time and size caps); rate limits per person and per
  address.

### End-to-end encrypted conversations (0.12, offered by default; `SNUG_E2EE=off` stops offering it)

Direct messages and groups whose members have all turned on encryption are end-to-end encrypted:
messages, edits, replies, thread replies, attachments, GIFs, stickers and scheduled messages. Against
theft of the database, WAL, snapshots, files folder or disk, an operator or admin who reads stored rows,
logs or backups, and server bugs that leak rows, the server holds only ciphertext. The server can't alter
an encrypted message, move it to another message, conversation, thread or revision, show an older
revision as current, or forge its author (AEAD binding with a key commitment in the signed header, a
device signature, a device list signed by the account key, and checks of every copy a client shows,
including the newest revision this device has opened, per copy). A message the server adds to an
encrypted conversation without encryption, after the point where this device saw it turn encrypted, is
shown as "Not encrypted – delivered by the server", not as the other person's, also in notifications and
the phone's conversation list; nothing else the server sets on a message (a "still sending" state, a system
flag, its order in a list) exempts it, and that point is lowered to the first envelope seen. Rows the server
places before that point are shown as messages from before encryption ("Not end-to-end encrypted"), which
the server could always write. Each device keeps, sealed under its own storage key, the newest synced
settings, its own device list and each contact's account key, list and devices it has seen; it never
lowers these marks (putting its own settings back after a rollback writes above the highest version it
saw), so the server can't roll them back without the device saying so, and while they are behind no key
change goes out. A device added with a code gets the approving device's settings, their version and the
encrypted conversations in the sealed box; a device recovered with the recovery key gets the version and
the conversations from the backup as of its last key change. Not covered: a device's first run after
upgrading from 0.12.0 (and a backup last written by 0.12.0) has no such mark, so the server can still
serve it older settings that once. Where a device saw a conversation encrypted it refuses to send there in
plain text. Key substitution by the server is caught when two people compare safety numbers; a contact's
new safety number and added or removed devices stay as lines in the conversation (the latest few from
before the loaded messages are pinned above them), and a message from a device its author removed says so
on the message.

Removing a device (from another device, by itself, or by leaving it out when recovering) starts a new
history key, and from another device a new key for the synced settings and a new recovery key (so the
backup the removed device could open with your password is replaced), all sealed only to the devices that
stay; the server then gives history keys only to connections of trusted devices. Switching history back on
also starts a new history key (the server refuses one that doesn't). A removed device keeps everything it
already had, including the account identity key: with your password, or with a malicious server's help,
it can sign a device list that adds a device of its own, and the people you talk to would then encrypt to
that device. Your other devices raise an alert over everything when your list gains a device they didn't
add, and "It was lost or stolen" says to reset encryption, which is the only thing that replaces the
account key. Messages from a removed device are accepted only if both the device's own timestamp and the
server's arrival time are within ten minutes of the removal. "My keys may be exposed" (Settings,
Encryption) makes a new history key, settings key and recovery key; it protects what is sent afterwards,
not what was already opened with the old keys. A device that hasn't been online for over a month (no valid
prekey) is left out of the weekly history key and named in Settings; a change you make yourself stops and
offers to remove it.

It does not protect against whoever serves the browser's JavaScript (an operator who changes the code
can read messages in a browser; the desktop app runs its own built-in code, also when it joins another server, except on a server's own page, which its window title names; when it joins another server, the server's `/api` answers reach the page only as data: the page's policy allows scripts and workers only from the app's own folders (never from `/api`), and every answer is marked nosniff with a sandboxing Content-Security-Policy and can't widen a service worker's scope; the window itself never navigates to the server's `/api/` (only to an attachment download, whose redirects are watched). Electron's protocol handler never sees `Sec-Fetch-Dest`, so nothing relies on it. In the desktop app's own page, the storage key that seals the device's secrets (account and history keys, the recovery key, message keys, settings, unsent drafts) is derived from a secret the operating system's key store (Electron `safeStorage`) protects, so a copy of the data folder alone doesn't open them; on a computer without one (Linux with no keyring) it is a plain browser key in IndexedDB, as in a browser, and Settings says so. The device's own signing and prekey private keys are non-extractable browser keys in IndexedDB on every platform, so a copy of the data folder still opens messages sealed to that device while its prekey is kept, up to three weeks), membership decided by the
server (ghost members), withheld or delayed messages, metadata (who, when, how much, members, devices,
IP addresses; the full list is below and at `GET /api/privacy`), compromised devices and people in the conversation, history readable
with the history key (on by default) or the recovery key and password, messages sent before a
conversation turned encrypted, and calls that aren't labelled end-to-end encrypted (below). There is no per-message forward secrecy, no deniability and no
automatic recovery after a compromise: a prekey stays usable to senders for up to 30 days, a history key
for a week, and nothing heals on its own until you remove the device, make new keys or reset. In a
browser (not the desktop app), the server's code can also roll back what the page keeps, since it is the
same code.

**Protocol, briefly** (full design in the v0.12 e2ee spec; code in `js/lib/e2ee/`, `js/e2ee/`,
`server/e2ee.js`, `server/e2ee-conv.js`): WebCrypto only (Ed25519, X25519, HKDF-SHA256, HMAC,
AES-256-GCM); HPKE base mode (RFC 9180, suite X25519/HKDF-SHA256/AES-256-GCM) from the vendored
`@hpke/core` (checked against the RFC's test vectors). Each account has an identity key (Ed25519) that
signs its device list, and a history key (X25519) per epoch (weekly, and after any device leaves; the
server refuses a list that reuses an epoch number with another key or goes back). Each device has a non-extractable
signing key and a weekly prekey (X25519) signed by it. A message gets a fresh 32-byte key; the body
(padded) is sealed with AES-256-GCM with the signed header as associated data; the header names the
conversation, place, message id, revision, author and device, recipients and declared mentions, and is
signed by the device together with a commitment to the message key (SHA-256 over a label, the key and the
nonce; envelopes from 0.12.0 clients have none and are read as before, except from a sending device this
device has already seen commit, which can't leave it out); the key is sealed with HPKE to every current
trusted device of every member and to each member's current history key. The account keys moving between
devices carry a serial and the device list version they were sealed at, and a device takes only newer
ones that keep every history key it holds (so a 0.12.0 device's weekly key, which doesn't bump the serial,
is still taken). Nothing decrypted is written to
the browser's localStorage copy (encrypted messages are kept there as envelopes); drafts, what they reply to and
messages waiting to send in an encrypted conversation are kept sealed under the device's storage key, not there. The server refuses a recipient set that isn't exactly the current
one (`e2ee_stale`), so a client fetches newer keys and seals again. Attachments are sealed whole with
AES-256-GCM under a key carried in the message. Safety numbers follow libsignal's numeric fingerprint
(version 0) over the account keys. A new device is added with a 12-character one-time code shown on a
trusted device and typed on the new one (HMAC over the exact keys, name and kind involved), or with the recovery key
(160 random bits; it opens an AES-256-GCM backup of the account keys). No external audit has been done;
the protocol description should be reviewed by someone outside the implementation before any wording
stronger than "end-to-end encrypted" is used.

**Less metadata (0.14).** Each device publishes the features it handles as an object signed by its own
signing key (`caps`, separate from the device list, which 0.12/0.13 clients check field by field); the
server can't add a feature, and a client keeps the features it has seen for a device, so once a device has
seen them the server can't take one away to make it fall back. A feature is used in a conversation only when every trusted device of
every member signed for it; until then the older form keeps working. Then: reactions are one sealed
envelope per person and message (kind `react`, the person's set of emoji, at most 20); poll votes and a
poll's end are sealed envelopes (kind `vote`; only the poll's author can end it, and both the server and
each client check that), counted on each device, with the end judged by the sender's clock; the poll itself
is a sealed message (the server is told only that it is a poll, so it can refuse one where an older device
couldn't count it, naming that device); a group's name, icon and hue are one sealed envelope (kind `info`)
that a member's device seals again when someone joins, and the server keeps no name for it; the message a
reply answers is inside the sealed body (a thread still names its root, since the server delivers it as its
own conversation), and a reply's author is notified through a declared mention; attachments are padded
before sealing (a version byte, a 4-byte length, the file, zeros up to 4 KiB steps to 64 KiB, then steps of
1.25×, never past the server's file limit; files sealed before open as before; a padded file forwarded to a
conversation where a device can't read padding is decrypted and sealed again unpadded). Each of these envelopes is sealed and signed like a message,
under an id that names its slot, message and author (so the server can't move one), with a revision that
only goes up (the server refuses an older one; a device refuses one older than it has seen). Once a
conversation can seal them, the server refuses the plain form (taking back an old plain reaction still
works). A re-seal of a group's information for members (it writes no line) is accepted only when someone in
the group can't open the newest revision, and a member's device that knows the revision right before keeps
that name and icon if a re-seal changes them. When a group's information is first sealed, the server
rewrites earlier "named the group" lines to say only who renamed it. Push notifications for encrypted
conversations name only the sender, and with "Hide names in notifications" not even that. Link previews are
never made there (the server has no text to look at).

Limits: the first time a device sees another device, the server can withhold that device's features; the
client then uses the older form there with no label (plain reactions, a plain group rename whose name
reaches the server, plain reply links). Revision checks are per device, so a new or signed-out device can be
shown an older revision. Someone added to a group sees "Encrypted group" until a member's device seals the
information again, and can't check that re-seal against the revision before. The data download has
encrypted messages as envelopes and leaves out sealed reactions, votes and group information.

**What the server still sees of encrypted conversations** (the list in `server/e2ee-conv.js`, served by
`GET /api/privacy` and repeated in the README): who wrote each message and where; when it was sent, edited
or deleted; padded sizes of messages and files; members, who added or removed whom, and the owner; that a
group was renamed or its icon changed; declared mentions; the root of each thread; that someone reacted,
voted or ended a poll, and when; read positions; typing; presence; pins and saves; devices; IP addresses
and sign-in history; GIF searches; call records and call set-up; and everything in house rooms, which
aren't end-to-end encrypted. The sizes and timing of all of these, and of the sealed envelopes, can still
say something about what is in them.

### End-to-end encrypted calls (0.14)

On top of WebRTC's DTLS-SRTP, every encoded frame of the microphone, camera, screen and screen sound is sealed
on the sending device with AES-256-GCM (WebCrypto, `js/lib/callcrypt.js`, run in `js/callcrypt-worker.js`
through `RTCRtpScriptTransform` or `createEncodedStreams`). The frame is `header | ciphertext+tag | counter(8) |
key id(1)`: the codec header (VP8 10 or 3 bytes, Opus 1) stays readable for the packetiser and is
authenticated; video asks for VP8; a codec whose packetiser reads the payload (H264) isn't sealed and the call
then isn't labelled end-to-end encrypted. Each device makes its own 32-byte key (HKDF-SHA256 to the frame key),
sends it to each other person sealed with HPKE to each device in their signed device list and signed with its
device Ed25519 key (`js/e2ee/callkeys.js`, rtc signal `ck`, size-capped by the server), and encrypts to that
person only after they acknowledge it. A new key on every join and leave; a receiver keeps the previous one
about 2 seconds after the new one is in use; everything is wiped when the call ends. Once a sender's frames
open, anything from them that doesn't (plain, damaged, wrong key) is dropped, never played. The label says
*End-to-end encrypted* only when every connection is; otherwise *Encrypted in transit only (DTLS-SRTP)* with
the reason. Every offer and answer carries `a=x-snug-fp`, the device's signature over the call, both people,
the certificate fingerprint and ICE username; one that doesn't verify against the sender's signed device list,
or a missing one from a device that signs its keys, ends that connection with a warning. Each device keeps, on
itself only (sealed in its encryption store, never sent), which of a person's devices have signed a call with
it; an unsigned offer or answer from that person later ends the connection with the same warning while one of
those devices is still in their signed device list (or no list can be checked), so a server can't strip
signatures and call keys to make a 0.14 device look like an older Snug. The server marking someone as a friend
on another PC doesn't skip this, and the record is read even when the server's hello says encryption is off.
Once none of those devices is listed (removed, or encryption reset) the call goes on *in transit only* with a
notice, except for a verified contact whose new account key hasn't been accepted (stopped). A server that says
it offers no encryption at all (the host turned `SNUG_E2EE` off) gets the same notice, and the record is kept.
Calling from a browser without encryption keys while a signing device is still listed is stopped too, and that
browser says why when the call starts. A first call with someone is not covered (nothing to remember yet), nor
is a reset faked for a contact who isn't verified (as for messages). With both sides signed the security code is 12 digits from both device keys and fingerprints
(*Verified device*).

It does not hide who is in which call, when, for how long or how much was sent (the server and any relay see
that), it trusts the device lists as for messages (a server could add a device to an account; Snug shows new
devices), it doesn't cover calls with someone who hasn't turned encryption on, an older Snug, a browser without
encoded transforms, or P2P calls with friends on other PCs (these say *in transit only*), and whoever serves the
web client's JavaScript could change it. A server could also withhold call keys so a call falls back to
*in transit only* (the label then says so); withholding signatures as well works only on a first call between
two devices, with someone whose signing devices have all left their list, or by turning encryption off for the
whole server (said in the call and everywhere else). Not reviewed by anyone outside the implementation.

### What Snug cannot protect against

- **A compromised device.** Malware running as you, or someone with your unlocked PC, can read what you can
  read. Keys wrapped by the OS key store protect against other users and offline copying of the disk, not
  against code running in your session. If the OS key store is unavailable, Snug says the key file is "not
  protected by the OS", and Settings > Encryption says the encryption keys aren't protected by it either.
- **The machine that hosts a server.** Houses and their conversations live in that server's SQLite database,
  which is not encrypted as a whole. Whoever runs a Snug server, or gets its disk, can read its houses. Use
  full-disk encryption and keep `data/secret.key` (or `SNUG_DATA_KEY`) stored apart from backups.
- **Stored data at rest (0.14), what is and isn't covered.** Attachment files in `data/files` (uploads,
  GIF, sticker and link-preview copies, pictures, friends' files fetched between PCs) are encrypted on disk
  (`server/filecrypt.js`: AES-256-GCM in 64 KiB segments, each with its own tag, under a key derived with
  HKDF from the data key; a changed, moved or cut segment is refused, never sent). Database snapshots were
  already encrypted; since 0.14 a damaged database put aside at a restore is sealed the same way and deleted
  after 7 days, and restore or snapshot temp files a crash left are removed at start. This protects a copied
  `files` or `backups` folder, or a disk backup, taken **without** `secret.key` (or, on the desktop, without
  the OS key store that wraps it). It does **not** protect against someone who controls the running server
  or can read `secret.key`: the server decrypts files to send them. The live `snug.db` (and its WAL) is still
  not encrypted. Files from before 0.14 are read as they are and sealed in the background, a few hundred
  every 15 minutes, including files no database row names any more (left by a crash, a failed delete or an
  older version: sealed, not deleted) (`SNUG_FILES_REENCRYPT=off` stops that); uploads still arriving (`files/partial`) and friends' files still
  being fetched (`*.part`) are plaintext until complete. If `secret.key` can't be read at start, new files
  are stored unencrypted for that run (a throwaway key would lose them) and the log says so.
- **This device's copy of messages (0.14).** In the desktop app, the cached messages, drafts, reply targets,
  draft attachments and changes waiting to send are AES-GCM blobs in IndexedDB under the device storage key,
  which comes from a secret the OS key store protects (made even when end-to-end encryption is off; 0.13's
  plaintext copy in localStorage is moved and deleted the first time). New device signing keys and new
  prekey private keys are kept the same way (PKCS#8 sealed under that key, used as non-extractable keys);
  older ones stay plain browser keys until they age out (prekeys) or the computer is renewed in Settings >
  Encryption (signing key, offered when another device can approve). In a browser the copy stays in
  localStorage: browser storage isn't protected against someone who copies the profile, and Settings > Your
  data says so and can turn the copy off (memory only). Anyone using the computer as you can open Snug and
  read it either way.
- **The registry operator.** The registry holds every account's vault key (wrapped under its own secrets). Its
  operator, or anyone who obtains both the Durable Object data and those secrets, could decrypt a data file
  they also obtain. The registry never sees messages between PCs.
- **Metadata.** The registry sees who is online, which accounts signal each other and when, each account's
  list of friends and group co-members (to tell them who is online), and IP addresses (stored only as keyed
  hashes or truncated). Cloudflare, which runs the registry and the TURN relays, sees connecting addresses. Calls go through the relay
  by default when the registry offers one (0.14); without one they go peer to peer, so the other side of a call
  sees your IP address.
- **Calls and the server in the middle.** Calls are encrypted between the people in them (DTLS-SRTP), and the
  offers that carry each side's certificate fingerprint pass through the Snug server. Since 0.14 a device with
  encryption keys signs its fingerprint, and the other side refuses a connection whose fingerprint doesn't match
  (above); media is also end-to-end encrypted when the call says so. Without keys on both sides (or with an
  older Snug) only the 0.13 6-digit code remains: about 20 bits, so a server in the middle can keep making
  certificates until both codes match (about a million tries). It only helps if people compare it.
- **Your IP address in calls.** With a TURN relay, calls and voice rooms are relay-only by default (0.14), and
  only relay candidates leave the device, so the people in a call see the relay's address, not yours. The
  relay's operator sees your address, when and how much. TURN credentials last an hour and their username is a
  hash of the person and the day keyed with a key only Snug's server holds (not the secret the relay shares), not
  the account id; a static TURN login (no `SNUG_TURN_SECRET`) is the
  same for everyone and never expires, and the server warns about it at startup. On a Snug server without a
  relay a call connects directly and the other people see your address; Snug says so before you join. The
  desktop app's PC-to-PC calls with friends get a relay from the registry when the call starts; if the registry
  has none, the call connects directly without that notice, unless *Hide my IP from friends* is on (then it
  doesn't connect). Anyone can turn
  *Hide my IP address* off.
- **People you talk to.** Anyone in a conversation can copy, screenshot or forward it. Deleting a message
  removes it from Snug, not from someone else's copy.
- **Disappearing messages are not unrecoverable.** The timer (0.12) removes a message from Snug's database,
  search index and attachments when it is due, and devices hide it on time. Before then anyone can copy it;
  the encrypted daily database snapshots (`server/dbbackup.js`, seven kept) can hold a copy for up to a week;
  a friend's PC on an older or modified Snug could keep it (Snug only offers the timer when every friend's
  PC says it supports it, and can't check what a modified one does).
- **A stolen GitHub account combined with an absent owner.** If the current PC is offline for the whole
  72-hour wait, a move started with a stolen GitHub login completes. Keep GitHub two-factor sign-in on.
- **A stolen recovery key combined with an absent owner,** the same way. And a lost PC plus a lost recovery key
  (with no GitHub linked) means the account is gone: nobody, including Snug, can reset it.
- **One person, many accounts.** Accounts without GitHub cost a proof of work (checked again at sign-up
  against the difficulty then), address budgets (3 a day per /48), more work for an IPv6 /32 that made 20 or
  more sign-ups in a day (it is not a refusal, so everyone sharing a tunnel broker's or carrier's /32 can
  still sign up) and a global budget over a sliding hour. These slow down mass sign-ups; they do not stop someone with many addresses.
- **The same recovery key on two servers.** The proof a browser sends for a server account's recovery key
  is bound to the server's host name (`web-auth-v2`), so the owner of one server can't use it on another.
  A key saved by 0.12.0 used the unbound proof (`web-auth-v1`); it still works, once, and the browser sends
  that old proof alongside when using a key, so until such a key is replaced the old exposure remains for
  it. Since 0.13, Home and Settings ask the person to make a new key while their key is such an old one. A key saved at one address of a server (say `localhost`) works only at that address; the server says
  which. Snug makes a new key for each account; don't type one account's key into another server.

### Privacy and data kept

The plain-language version for people using Snug is the privacy page (Settings > Privacy guide, or `/privacy`),
built from `js/lib/privacy.js` and `GET /api/privacy` (`server/privacy.js`).

- Sign-in history (`auth_events`) and security events are kept 14 days by default (`SNUG_LOG_DAYS`, 1 to 365;
  30 before 0.14), with addresses truncated (1.2.3.x, /48) and a coarse device label ("Chrome on Windows"),
  not the raw User-Agent (0.14: security events and encryption audit rows too). Failed sign-in counters last
  2 days and hold an address only as an HMAC under the data key. Sessions store a device label, never an
  address. Logs never print a full address.
- 0.14 retention (`server/retention.js`, hourly): house join/leave rows (`member_log`, owners' insights) go
  after 90 days, with when each house's log began kept in `member_log_began` so insights count the same;
  link-preview cache rows and their cached pictures after 24 hours; friend-request cooldowns after their day.
  Last use of sessions, encryption devices and friends' PCs (`sessions.seen`, `e2ee_devices.seen`,
  `peers.last_seen`) is stored as the UTC day and written at most daily; idle expiry counts whole days.
  Still kept as before: moderation records (reports, bans, timeouts, audit log), call records as messages,
  reactions, read positions, pins, push subscriptions (until the session ends), and in end-to-end encrypted
  conversations who sends to whom, when, sizes and declared mentions.
- Sign-in history (`auth_events`) and security events are kept 30 days by default (`SNUG_LOG_DAYS`, 1 to 365),
  with addresses truncated (1.2.3.x, /48). Failed sign-in counters last 2 days and hold an address only as an
  HMAC under the data key. Sessions store a device label, never an address. Logs never print a full address.
- Calls (0.14): nothing is recorded. A call's record in the conversation stores who started it, voice or video,
  how it went, when, how long and who missed it (not who took part or declined; 0.12/0.13 clients get the
  members who didn't miss it, worked out when read). The disappearing-messages sweep and erasing the author's
  account cut it down to how it went; erasing someone also takes them off others' records. Who is in a call
  right now is kept in memory only.
- Who sees that someone is online (everyone sharing a place, friends only, nobody) and typing are applied to
  every frame the server sends (`hub.outFilter`), not only in the browser: presence, status (words, picture and
  end time, and no frame at all when it changes), the "last wrote" lines, house voice-room lists and a stage's
  speakers and raised hands for people not in the room, and houses' online and in-voice counts. Message
  times and who is in a voice room, for people in it, stay visible. A voice room with a user limit still
  refuses someone when it is full, so a room that looks empty but says it's full shows that someone hidden
  is in it (letting them in instead would break the limit). In P2P mode, friends only watches group
  co-members who aren't friends "quietly" at the registry: it sends them no presence, and their PCs can signal
  (sig, relay, TURN) to the PC only after it has contacted them in its current registry session, the same
  answer as offline otherwise. The PC contacts each such co-member when they come online, so group messages,
  files and calls keep connecting directly; a modified client on their side can therefore still tell when the
  PC is online. A registry without quiet watches (no `quiet` in its `ready` frame) gets the older behaviour:
  those co-members aren't watched, so neither side can open a link to the other; a member who gets a group
  message straight from its author offers it to the other online members (0.13), so it still arrives through
  a friend of both.
- In P2P mode, link previews for links friends send are off unless the PC's owner turns them on, since the
  fetch reveals the PC's address to the linked site.
- Deleting an account can erase what the person wrote (messages, files, reactions, poll votes, sign-in and
  security history); report rows moderators already hold stay. Encrypted database snapshots keep up to 7
  days, so erased content can survive that long in a snapshot. In P2P mode (0.13), before the account is
  released, each friend's PC gets a delete for the person's messages in their conversation (and groups across
  PCs a signed delete item); the PC waits up to 8 seconds for those online to take them. Only the most recent
  messages are asked for: up to 5,000 per friend (fewer if that friend's PC already has frames waiting) and
  2,000 per group, and a member whose PC has 5,000 frames waiting gets none; older ones stay on their PCs. A
  PC that is offline then keeps its copy, and a modified Snug can ignore the request: it is a request, not a
  guarantee. Deleted messages'
  text is cleared on those PCs after the usual 10-minute undo window.
- 0.13 frames between PCs (polls and votes, group-call signalling, forwarded cards) are sent only to PCs
  whose signed profile (or, for group co-members who aren't friends, link-authenticated inventory frame)
  lists the capability. They are checked like other frames: a vote only counts for the voter's own stand-in
  and only before the poll ended, only the poll's author can end it, and group-call signalling is accepted
  only from members whose stand-in is in that call. "Before the poll ended" is judged by the time the voter's
  PC puts on the vote (at most a minute ahead of the receiving PC's clock), since a vote made offline arrives
  late and still counts; so a modified PC can backdate a vote and have it counted after the poll ended.
- A forwarded card from a friend's PC says who wrote the forwarded message, and a modified PC can put any
  name and words there. The receiving PC ties the card to someone's account (their picture and name as this
  PC knows them) only when it holds a message of theirs with those exact words; otherwise the card shows the
  name it was given and says Snug can't check who wrote it.
- Snug sends no telemetry, analytics or crash reports, and the web client loads nothing from other origins
  (CSP `default-src 'self'`; tested in `tests/e2e-privacy.test.js`). Outside parties it does reach: the STUN
  server (Google by default when no TURN relay is configured; with `SNUG_TURN_URL` and no `SNUG_STUN`, the
  relay's own address since 0.14, so whoever runs that relay sees addresses; `SNUG_STUN=none` turns it off; the desktop app uses Cloudflare's STUN once it
  has relay details from the registry), a TURN relay if configured, the browser's push service, the registry
  and Cloudflare (P2P), GitHub (desktop update checks: at start and every 22 to 26 hours, or only when asked,
  Settings > Desktop app), and GIF providers (only server-side or through the registry).
- Desktop first-run page (0.13): its **Privacy** link starts a short-lived copy of the app's server on
  127.0.0.1 only, with an empty temporary data folder, and shows `/privacy` in a separate window on an in-memory
  session (no permissions, other links open in the browser). Closing the window stops that server and deletes
  the folder. A pasted `https://host/join/<code>` saves only the origin; the code is handed to the page once
  as a `snug://join/<code>` link, which the page checks like any other.

## Controls in place

| Area | Control | Where |
| --- | --- | --- |
| Passwords | scrypt (N=2^15, r=8, p=3), common-password list, no username in the password, rehash on sign-in | `server/auth.js` |
| Brute force | Per-address and per-account limits with doubling waits kept in the database; IPv6 grouped by prefix | `server/auth.js`, `registry/src` |
| Two-factor | TOTP encrypted under the data key, backup codes stored as HMACs, attempt limits | `server/account.js` |
| Recovery key (server accounts) | Only scrypt(HKDF(key)) stored; per-address and per-account-and-address limits; single use; every session ended on use; replacing it needs the password; the owner's reset deletes it | `server/recovery.js`, `server/tools/reset-password.js` |
| Passkeys | Single-use 5-minute challenges (at most 30 outstanding per /48 or account; when the map is full the busiest /32 or IPv4 /24 loses its oldest; sign-in options limited per /64 and /48), origin and RP ID checks, user verification required, counter regression refused, RP ID never from the `Host` header alone | `server/webauthn.js`, `server/passkeys.js` |
| Sessions | 256-bit tokens, hashed at rest, `__Host-` cookies, absolute and idle expiry, revoke-all | `server/auth.js` |
| Authorization | Server-side checks on every op, one shared permission and role model | `js/lib/perms.js`, `js/lib/safety.js`, `js/lib/places.js` |
| Input and output | Type and length checks on every field, prepared SQL, token-tree rendering, strict CSP | `server/`, `js/`, `server/index.js` |
| CSRF, rebinding, SSRF | Origin checks, `Host` allow-list, outbound fetches checked per hop (allow-lists, no private addresses) | `server/index.js`, `server/media.js`, `server/linkpreview.js` |
| Transport | HTTPS with HSTS behind a TLS proxy (`SNUG_SECURE=1`); E2E links between PCs; TLS to the registry | `README.md` (Putting it online) |
| Encryption at rest | AES-256-GCM for TOTP secrets, snapshots and data files; OS key store for device keys and the desktop app's encryption storage key; HMACs for GitHub ids | `server/vault.js`, `server/vaultfile.js`, `server/dbbackup.js`, `server/identity.js` |
| Audit and detection | `auth_events` and `security_events` tables, JSON log lines without secrets, burst detection with `suspicious` alerts, "new sign-in" notices, alerts in Settings > Account > Recent activity; refused cross-site requests and sockets, foreign `Host` names, rate-limit hits (HTTP, sockets and socket ops), evicted sockets, refused role-hierarchy changes, filtered webhook posts and CSP reports all reach one log; signed and audited registry admin actions | `server/seclog.js`, `registry/src/admin.js` |
| Error handling | Users see plain messages; stack traces and internals stay in the server log | `server/` |
| Backup and recovery | Daily encrypted, integrity-checked database snapshots with automatic restore of the newest good one; the portable data file; registry point-in-time recovery | `server/dbbackup.js`, `server/vault.js`, `registry/SECURITY.md` |
| Desktop hardening | Sandbox, context isolation, navigation lock, Electron fuses, hardened runtime on macOS, verified updates | `desktop/main.js`, `desktop/fuses.js`, `desktop/updater.js` |
| Release integrity | Release jobs only in the protected `release` environment; build jobs skip npm install scripts; read-only tokens elsewhere; every action pinned to a commit and every container image to a digest; SHA256SUMS per platform, Ed25519-signed when the update key is set; GitHub build provenance attestations; Windows Authenticode signing as soon as a credential is configured (see "Code signing") | `.github/workflows/`, `desktop/release.sh`, `desktop/workflows.test.js` |
| Registry | Signed device-key requests, move delay, wrapped vault keys, bans, minimum version, per-address and global budgets | `registry/SECURITY.md` |

### Automated security testing (all free and open source)

`.github/workflows/security.yml` runs on every push and pull request and every week:

| Tool | What it checks | Fails the build on |
| --- | --- | --- |
| `npm audit` | Known advisories in `snug/`, `snug/registry`, `snug/desktop` (development tools included) | high or critical |
| [OSV-Scanner](https://github.com/google/osv-scanner) | Every lockfile in the repository against the OSV database | high or critical in `snug/` (the rest is reported) |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secrets anywhere in the git history (`snug/.gitleaks.toml`) | any finding |
| [CodeQL](https://codeql.github.com) | Snug's JavaScript and the workflows, `security-extended` queries | high or critical from precise queries |
| [Semgrep CE](https://github.com/semgrep/semgrep) | `p/javascript`, `p/nodejs`, `p/owasp-top-ten`, `p/secrets` over `snug/` (`snug/.semgrepignore`) | severity ERROR, security, confidence above low |
| [Electronegativity](https://github.com/doyensec/electronegativity) | Electron misconfigurations in `snug/desktop` | high or critical, firm or certain |
| [OWASP ZAP](https://www.zaproxy.org) baseline | A seeded Snug server started on the runner: headers, cookies, CSP, information leaks on the HTTP routes (passive; it does not attack, and it doesn't exercise the WebSocket operations). Official image pinned by digest; accepted alerts with the reason in `.github/security/zap-rules.tsv`; reports kept as the `zap-baseline` artifact | high risk |
| Dependency review | New dependencies in a pull request | high or critical |
| Workflow rules (`desktop/workflows.test.js`) | Least-privilege tokens, actions pinned to commits, images pinned to digests, no kept credentials, release and signing jobs in the `release` environment, signing credentials only in signing jobs, every signature checked | any rule broken |

Every report also goes to the repository's code scanning alerts. `.github/security/gate.mjs` decides what
fails; a finding that a person checked and found not exploitable goes into `.github/security/reviewed.json`
with the reason, by rule and file. Tests, mocks, generated and third-party code are reported but never fail.

[Dependabot](../.github/dependabot.yml) proposes updates weekly for the three npm folders and the pinned
actions, grouped, and security updates as soon as an advisory appears. Routine updates wait 7 days after a
release, which keeps most hijacked versions out.

The same checks run locally from `snug/` (install the tools first: `gitleaks`, `osv-scanner`, `semgrep`;
Electronegativity runs through `npx`; the ZAP scan needs Docker):

```sh
npm run audit:deps       # npm audit, three folders, high and above
npm run audit:secrets    # gitleaks over the whole history
npm run audit:osv        # OSV-Scanner over every lockfile, gated on snug/
npm run audit:electron   # Electronegativity over desktop/
npm run lint:security    # Semgrep with the four rule packs
npm run audit:all        # all of the above
npm run audit:zap        # ZAP baseline against a seeded server (Docker; ZAP_PORT=8787 by default)
```

Security regression tests live with the other tests (`npm test`, `tests/server-sec-*.test.js`,
`registry/test/`, `desktop/*.test.js`).

## For maintainers

- Turn on **Private vulnerability reporting**, **Dependabot alerts and security updates**, **Secret scanning
  with push protection** and **Code scanning** in the repository's security settings (all free for public
  repositories), and require the `Security scans` checks on the default branch.
- Never rotate `GH_HMAC_SECRET` and never change `HUB_NAME`: see `registry/SECURITY.md`.
- Keep `SNUG_UPDATE_SIGNING_KEY` and every code-signing credential only in the protected `release` environment
  (Settings > Environments > release: deployment branches limited to the release branches; add yourself as a
  required reviewer if you want to approve each release).

### Update signing (turn it on once)

The release jobs already sign `SHA256SUMS-<platform>.txt` whenever the `SNUG_UPDATE_SIGNING_KEY` secret exists
(`desktop/release.sh`, `desktop/sign-sums.js`); the app only *requires* a signature once a public key is pinned.
Do this on your own computer, never in CI, and never commit or paste the private key anywhere:

1. `cd snug/desktop && node sign-sums.js --new-key snug-update-key.pem` writes the private key (owner-only file)
   and prints its public key. Make a second, backup key the same way (`snug-update-key-backup.pem`) and keep
   both files offline (a password manager or an encrypted USB stick), apart from each other.
2. GitHub: Settings > Environments > release > Add environment secret `SNUG_UPDATE_SIGNING_KEY`, value: the whole
   contents of `snug-update-key.pem` (from `-----BEGIN PRIVATE KEY-----` to the end line).
3. Ship one release as it is (the key exists, nothing pinned yet): its checksum files get `.sig` files next to
   them (`sign-sums.js` checks each signature before it is uploaded, so a bad key fails the release job).
4. Put both printed public keys in `UPDATE_PUBKEYS` in `desktop/updater.js` (main first, backup second), run
   `node --test updater.test.js release.test.js`, and release that version. From then on an update without a
   valid signature by one of the pinned keys is never offered or installed, and `release.sh` refuses to publish
   without the key. If the main key is lost or leaks: sign with the backup, and pin a new backup in the next
   release.

### Code signing (Windows; switch it on when you have a credential)

`build-snug-windows.yml` signs the app, then the installer and the portable exe, as soon as the repository
variable `SNUG_WINDOWS_SIGNING` is set; each signature is checked with `Get-AuthenticodeSignature`. Signed files
can still get a SmartScreen warning for a while after each new version until they gain download reputation.

- **SignPath Foundation (free for qualifying open-source projects).** Apply at <https://signpath.org> (OSI
  licence, public repository, builds on GitHub-hosted runners, MFA for maintainers). When accepted: in SignPath,
  create the project and two artifact configurations by pasting `desktop/signpath/snug-app.xml` (slug
  `snug-app`) and `desktop/signpath/snug-installers.xml` (slug `snug-installers`); link the project to this
  repository with the GitHub connector (trusted build system). In GitHub: environment `release` secret
  `SIGNPATH_API_TOKEN` (a CI user's API token); repository variables `SIGNPATH_ORGANIZATION_ID`,
  `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` (for example `release-signing`); then variable
  `SNUG_WINDOWS_SIGNING` = `signpath`.
- **A certificate you bought (PFX).** Environment `release` secrets `WIN_CSC_LINK` (the `.pfx` file as base64:
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))` in PowerShell, or `base64 -w0 cert.pfx`)
  and `WIN_CSC_KEY_PASSWORD`; then variable `SNUG_WINDOWS_SIGNING` = `pfx`. Certificates whose key must stay on
  a hardware token can't be used this way; use SignPath or a cloud signing service.
- Azure Trusted Signing also works with signtool but is a paid service; it is not wired up.
- A misspelt `SNUG_WINDOWS_SIGNING` fails the build. With signing on, a signing failure stops the release; it
  never falls back to unsigned files. Remove the variable to go back to unsigned releases.

macOS: the app is ad-hoc signed with the hardened runtime. Notarization (no Gatekeeper warning) needs the paid
Apple Developer Program; `build-snug-mac.yml` says what to add if you join.
