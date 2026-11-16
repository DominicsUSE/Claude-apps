# Changelog

Snug's releases, newest first. Every version's files stay on the releases page
(<https://github.com/DominicsUSE/Claude-apps/releases?q=snug-v>); the desktop app updates itself and never
goes back to an older version on its own (README, "Install, update, go back").

## 0.14.0

### Calls: private by default

- **End-to-end encrypted calls.** When everyone in a call has turned on end-to-end encryption and their browser
  can encrypt frames, voice, camera, screen and screen sound are sealed on each device with keys only the
  devices of the people in the call get (sealed to their devices, new on every join and leave, wiped when the
  call ends). The call says *End-to-end encrypted*, or *Encrypted in transit only* and why. DM calls, group
  calls and house voice rooms; P2P calls with friends on other PCs stay *in transit only*.
- **Connections signed by the device.** Each side signs its certificate fingerprint; a connection whose
  fingerprint doesn't match is stopped with a warning. Both signed: a 12-digit code and *Verified device*.
- **No quiet downgrade to unsigned.** A device remembers who signed calls with it; a later unsigned call from
  them is stopped with the same warning while that signing device is still in their list.
- **Hide my IP address is on by default** whenever the server has a relay (the old default moves to it); only
  relay candidates leave the device. With no relay, Snug says before you join who will see your IP address.
- **TURN credentials last an hour** and no longer name your account; fetched again before they run out. With
  TURN set, the relay answers STUN, not an outside server. A static TURN login gets a startup warning.
- **Smaller call records:** who started it, how it went, when, how long, and who missed it, no longer who took
  part. The disappearing-messages sweep and account erasure cut it down further. Older records still read.
- **Fix: group calls across PCs.** Two people who joined moments apart weren't connected to each other (each
  PC's copy of the call didn't have the other yet, so neither started the connection). Now, after a short wait
  with no connection, one of them starts it.

### Fixes

- **Fix: GIF search in the desktop app gave only an error.** Openverse turns away nearly all anonymous calls
  from the registry (it limits them per address, and every Cloudflare Worker shares one). The registry can now
  ask Openverse with its own credentials (`OPENVERSE_CLIENT_ID`/`OPENVERSE_CLIENT_SECRET`), passes a search to
  the next GIF site in `GIF_PROVIDERS` when one refuses, and the error names the site that refused instead of
  blaming your PC. Search still goes through the registry, so GIF sites never see your address.

### Privacy: less tracking, shorter retention

- **What Snug stores and for how long**: the privacy page and README list everything the server keeps, with
  the real windows from `GET /api/privacy`: call records, the house join log, link previews, push addresses,
  reactions and read positions, what end-to-end encrypted conversations still reveal, GIF searches, the STUN
  and TURN operators, the directory, and desktop update checks.
- The server forgets on its own, hourly: house join and leave rows after 90 days (insights count the same),
  the link-preview cache after 24 hours, declined friend requests after a day.
- Sign-in history and security events: 14 days by default (was 30). Security events keep the kind of device
  ("Chrome on Windows"), not the browser's full string.
- When a device, encryption key or friend's PC was last used is stored to the day, written at most daily.
  Settings > Account says *Active today* or *Last active 2 Nov 2026*.
- Calls: with a TURN relay set (`SNUG_TURN_URL`) and no `SNUG_STUN`, the relay answers STUN instead of Google
  (whoever runs the relay sees addresses; the privacy page doesn't claim who that is). The
  desktop app drops Google's STUN once it has Cloudflare relay details. Without a relay, Google is named on the
  privacy page, with `SNUG_STUN=none`.
- Desktop app: update checks at start and then about once a day with jitter (were hourly). **Settings >
  Desktop app > Updates**: *Automatically*, *Tell me* or *Only when I ask*.

### Stored data encrypted

- **Attachment files are encrypted on disk** (AES-256-GCM in 64 KiB segments under a key from
  `data/secret.key`). Range requests still work; a damaged segment is refused, never sent. Older files stay
  readable and are sealed in the background (`SNUG_FILES_REENCRYPT=off` to skip). This protects a copied
  files folder or disk backup without `secret.key`, not a running server.
- **No plaintext database copies left behind**: a damaged database put aside at a restore is sealed with the
  backup key (and deleted after 7 days); 0.13's plaintext `snug.db.damaged-*` and crash temp files are
  sealed or removed at start.
- **Desktop app: this device's copy of messages is sealed** under the storage key the OS key store protects
  (cache, drafts, reply targets, draft attachments, changes waiting to send), even with encryption off. 0.13's
  plaintext copy is moved over and deleted. New device signing keys and prekeys are sealed too; Settings >
  Encryption offers *Renew this computer's key* for one made before.
- **Browsers: Settings > Your data > Keep a copy of messages on this device** (on by default), saying that
  browser storage isn't protected against someone copying the profile. Off keeps the copy in this tab only.
- Tests check that saving, using and adopting a recovery key never sends the key, its text or its backup
  key, and that what the server keeps can't open the encryption backup.
- **Going back to 0.13 or older**: files 0.14 stored or sealed can't be opened there (attachments, avatars,
  stickers, emoji, sounds, link-preview pictures), and the desktop app's copy of messages, drafts and changes
  waiting to send don't carry back. Returning to 0.14 makes them readable again.

### Encrypted chats: less metadata

- **Less for the server to see in end-to-end encrypted DMs and groups**, once everyone's devices are on 0.14
  (each device signs what it can handle; until then the older form keeps working):
  - Reactions are encrypted; each device counts them. An older Snug that tries a plain reaction there is told to update.
  - A group's name and icon are encrypted to its members. The server keeps no name (older Snug shows
    "Encrypted group"), lines say who renamed the group but not to what, and someone added gets the name too.
  - Polls work in encrypted conversations again, encrypted with their votes; each device counts. "Hide results"
    isn't offered there (nobody could enforce it). If someone is still on an older Snug, it names their device.
  - The message a reply answers is inside the encrypted message; its author is notified by a mention.
  - Encrypted attachments are padded to size steps, so the server sees roughly how big a file is.
  - Padding never takes a file past the server's file limit, and a padded file forwarded to someone on an
    older Snug is sealed again unpadded so it opens whole.
  - When a group's name is first sealed, earlier "named the group" lines lose the name too.
  - If your device can't check what everyone's devices handle (keys not ready, or the server doesn't answer),
    a reaction, reply or group rename isn't sent rather than going in the older form; try again. An attachment
    goes up padded and is checked again when the message is sent.
  - Limits (README, "Limits of the 0.14 sealing"): the first time your device sees a device, the server could
    hold its features back and make yours use the older form; a new device can be shown an older revision;
    someone added sees "Encrypted group" until a member's device seals the name again; the data download
    leaves out sealed reactions, votes and group names.
- Push notifications for encrypted conversations name only the sender, never the group or who else is in it.
  New: **Hide names in notifications** (Settings > Encryption): no sender or place in any pushed
  notification, and the note that replaces a ring names no caller. Message text in unencrypted
  conversations still follows *Show message text*.
- One list of what the server still sees of encrypted conversations, in the README, Settings > Encryption
  and `GET /api/privacy`.

## 0.13.0


### Changed

- **English only**: the Lithuanian translation and Settings > Appearance > Language are gone. A device, an
  account or a 0.12.0 client that still says Lithuanian gets English, with no error. The clock's first choice
  reads *Match my browser*.

### New

- Paste an invitation link (or a code) into the quick switcher (`Ctrl`/`⌘ K`): *Join with this invitation*
  joins and opens the house, or says why the link doesn't work. A link's row comes first; a bare code's comes after
  any room or person the text matches, so Enter still opens a room called "glazebatch24".
- House settings > Overview: **Show every room to newcomers**. On for new Friends and Gaming houses.
- *Mute for…* confirms with "Muted until 22:40" (or "Muted") and **Undo**.
- Phones: **double-tap a message to react** (❤️, or your pick in Settings > Text and messages, or off).
- The privacy page lists disappearing messages, with what they can't do.
- Desktop first-run page: a **Privacy** link, a layout its own CSP allows, and a pasted invitation link
  (`https://host/join/<code>`) opens that invitation once you're in.
- PDF previews show text in fonts a file doesn't carry (pdf.js's character maps and standard fonts, fetched
  from your Snug when needed). Message pictures load as they come into view.
- An automated accessibility check (axe-core, tests only) on the main screens; it fixed the font choices'
  ARIA.

### Friends on other PCs

- **Polls** work in direct conversations and groups with friends on other PCs: the poll, everyone's votes
  (only each person's latest counts) and its end reach every PC, so all show the same counts. If someone's
  Snug is older, or a group member's PC hasn't been in touch yet so Snug can't tell, the poll is refused and
  the message names them.
- **Group calls** in groups with friends on other PCs, up to the 12 people a call holds. Audio and video go
  between the people's browsers as in any call; the PCs only pass the connection messages.
- **Forwarding** a message to friends on other PCs brings the whole message: the forwarded card with who
  wrote it, its pictures and files, and a sticker. Older PCs show it as quoted text with the files.
- The **data file** keeps the disappearing-messages timer and when each message disappears, so a move to a
  new PC keeps them; messages whose time has passed aren't brought back. 0.11 and 0.12 still read the file.
- **Erasing your account** now asks friends' PCs that are online to delete their copies of your most recent
  messages (up to 5,000 with each friend and 2,000 in each group). PCs that are offline at that moment, or
  that run a changed copy of Snug, keep theirs, and so do older messages; the dialog says which friends' PCs
  are offline.
- Fixes: a forward with no note didn't reach a friend's PC; a copy of a friend's file couldn't be passed
  on and could be dropped from the cache; with presence for friends only and an older directory, group
  messages between people who aren't friends waited for a link to reopen.

### Private conversations

- The desktop app protects the key that seals your encryption keys with the operating system's key store
  (safeStorage). A 0.12 profile is moved over the first time, without losing keys or messages. Without a
  key store (some Linux setups), Settings > Encryption says so.
- If the key store can't open the keys any more (it was reset, or the data folder was copied to another
  computer), Settings > Encryption offers to remove this computer's keys; the computer is then added again
  with another device or the recovery key, and its new keys are protected by the key store.
- Drafts and messages waiting to send in encrypted conversations are no longer kept as text in the
  browser's storage; they are sealed on the device and come back after a reload.
- Messages from someone who has left a group can still be checked and opened after a reload or on a new
  device.
- Join mode never shows one of the server's `/api` answers as the window's page. The screen-share picker
  runs no inline script.

### Calls

- The screen stays on while you are in a call or voice (where the browser allows it), and the system's call
  controls (lock screen, headset button, desktop media controls, where offered) mute, turn the camera on and
  off, and hang up.
- A security code per person in the connection details: matching codes, read out loud, make it much harder for
  anyone, the server included, to sit in the middle of the connection. It is only 6 digits, so it is not a
  guarantee (see SECURITY.md).
- Screen share: choose **Text and slides** or **Motion and games**; resolution, frame rate and data saver
  now change a share that is already running.
- New test: send limits drop when a voice room grows past 3 other people and come back when it shrinks
  (five browsers).

### Accounts

- One recovery key for both: a password recovery key you save also becomes your end-to-end encryption
  recovery key on a device with encryption on, and a new encryption recovery key is offered as your
  password recovery key too. A key saved by 0.12.0 keeps working; Home and Settings ask you to replace it.
  After "Forgot your password?" on a browser where encryption isn't unlocked within two minutes, Home and
  Settings say your encrypted history still opens with the previous key, and offer a new key that does
  both once encryption is unlocked.
- A passkey can stand in for your password (and code) when you change the password, remove a passkey,
  replace a recovery key, turn two-factor sign-in on or off, make new backup codes, or deactivate or delete
  your account. Changing your name or username tells your passkey provider, where supported.
- Desktop: a GitHub link still waiting, or a GitHub account's first recovery key, can be cancelled from the
  same PC or with GitHub (registry: `/v1/recovery/drop`, and `/v1/recovery/cancel` takes the waiting link's
  GitHub account, and stops every link waiting for it). Cancelling a waiting link with GitHub needs that
  updated registry; until then Snug says so and you cancel from the same PC. Nothing changes for 0.11 and
  0.12 apps.
- Registry: the optional `KEY_ACCOUNT_IDLE_DAYS` purge (still off by default) keeps accounts with a GitHub
  account linked, and now runs on its own.

### Known limits

- Friends on other PCs still can't join houses (a house lives on one PC and its people join over the LAN
  or a link). Group calls with friends on other PCs have only been tested on one machine, not through a
  real TURN relay.
- The desktop app's own signing and prekey private keys are still browser keys in its storage, not sealed
  by the key store, and they open messages sent to that device while its prekey is kept (up to three
  weeks), so a copy of the data folder still opens recent messages. Attachments added to a draft in an
  encrypted conversation aren't kept across a reload.
- Once 0.13 has moved a desktop app's encryption keys under the key store, 0.12 can't open them: a desktop
  app taken back to 0.12 can't read encrypted messages until it is updated again, or until that computer is
  removed from another device and added again.

## 0.12.0

### Private conversations

- Direct messages and groups can be **end-to-end encrypted** (on by default; `SNUG_E2EE=off` stops offering
  it). Text, edits, replies, files, pictures, GIFs, stickers, polls, scheduled messages and forwards are sealed
  on your devices (HPKE and Ed25519, in the browser's own crypto) and only the devices of the people in the
  conversation can open them. The server stores and relays envelopes it can't read. Conversations from before
  0.12 stay as they were until someone switches them on, and every screen says which kind you are in.
- Each person's devices hold their keys; a recovery key (shown once at sign-up or in Settings > Encryption)
  brings history back on a new device. Linking a new device needs a code from one you already have.
- Safety numbers per contact, and lasting lines in the conversation when a contact's key or devices change.
  A message the server adds without encryption is marked "Not encrypted – delivered by the server"; an older
  copy of your synced settings, device list or a message revision is refused instead of shown.
- Removing a device (or "It was lost or stolen") starts new history, settings and recovery keys, so it can't
  read what is sent afterwards. "My keys may be exposed" does the same by hand. Nothing heals on its own:
  a device that was copied while unlocked can read what it already had.
- Search over encrypted conversations runs only on your device; the server's index never sees their text.
- The desktop app's join mode keeps the app's code pinned to the version you installed, so a server can't
  change the page that does the encryption.
- **Not encrypted:** rooms in houses, reactions, who talks to whom and when, profile pictures and names,
  voice and video beyond WebRTC's own link encryption, and conversations with friends on other PCs (which
  travel encrypted between PCs and are stored readable on each PC). SECURITY.md describes the protocol and
  its limits; it has not had an outside review yet.

### Accounts

- The desktop app no longer needs a GitHub account: a new account can be just a key made on your PC
  (with a small proof-of-work against floods), with a recovery key to move it to another PC. GitHub sign-in
  still works, and a key account can be linked to GitHub later. Adding a second way in, or moving an account,
  waits 7 days and can be stopped from any PC you still have.
- Passkeys on host servers (Settings > Account), and a recovery key that resets a forgotten password, since
  Snug asks for no email. Server owners can reset a password with `node tools/reset-password.js`.

### Privacy

- Settings > Privacy and safety opens with **Who can see what** for the mode you are in; the full guide is at
  `/privacy`, signed in or out.
- Who sees when you're online (everyone, friends, nobody) is enforced by the server, including status, last
  seen, typing and voice rooms. The typing switch stops both sending and showing typing.
- Deleting your account asks whether to keep your messages as "Deleted user" or erase them, files included.
- **Download my data**: one zip with your data as JSON, a readable messages.txt and your uploaded files.
- Sign-in history and security events are kept 30 days (`SNUG_LOG_DAYS`); failed sign-ins store a keyed
  hash, not your address. Snug sends no diagnostics. `SNUG_STUN=none` stops Google's STUN server from seeing
  callers.
- In the desktop app, links friends send aren't fetched for previews unless you turn that on.
- **Disappearing messages** per conversation or room: off, 1 hour, 1 day, 7 days or 30 days.

### New

- **Files up to 100 MB** by default (`SNUG_MAX_FILE_MB`), uploaded in resumable pieces with progress and a
  cancel button, with per-person and per-house storage limits (`SNUG_QUOTA_MB`, `SNUG_HOUSE_QUOTA_MB`).
  Previews for PDF (pdf.js), SVG (as a picture, never as a page) and text files.
- **GIF search with no paid key**: Openverse by default, Wikimedia Commons if the server turns it on, Tenor
  if the owner has a key, and in the desktop app through the directory so your address isn't sent to them.
- **Voice**: join to listen only, automatic reconnection, quality that adapts to the connection, calls through
  a relay by default where the server has one ("Hide my IP address"), and a phone layout with words under the
  buttons. Voice rooms show in the room list straight away.
- **Phones and browsers**: the web app installs as an app (PWA) and opens offline, messages wait in a queue
  while offline and send when the connection is back, and Settings > Connection says what is going on.
- **Languages**: English and Lithuanian (Settings > Appearance > Language). The Lithuanian covers the main
  screens and still needs a native speaker's review; the rest of the app is in English for now.
- Full-text search (SQLite FTS5) ranked by relevance, finding word starts, folding accents and offering close
  matches. Quiet hours per weekday. Threads and pins with friends on other PCs.
- First steps: a "Start or join a house" dialog that accepts any kind of invite link, invites that say why they
  don't work (expired, used up, revoked), every sign-up problem shown at once, and new houses opening their
  invite dialog.

### Fixed

- The tester panel's findings, among them: the last message hidden under the composer on phones, phone Back
  leaving the house, invite links pasted in the wrong place failing silently, and the Messages list not being
  ordered by the latest activity.
- From the 0.12 security review: storage limits that copying a file could get round, a close-match search
  that hinted at messages you can't read, leftovers after messages disappeared, presence and stage details
  shown to people who shouldn't see them, and several account-recovery races (all with tests).

### Installing and security

- An install page (`docs/install.html`, at `/docs/install.html` on any Snug server, linked from
  Settings > Desktop app in a browser) and the same steps in every release's notes: which file to pick, the
  Windows and Mac warnings, checking a download's SHA-256 against `SHA256SUMS-*.txt`, and
  `gh attestation verify`.
- Windows code signing is wired up and switches on as soon as the project has a SignPath Foundation account or
  a certificate; every signature is checked in CI. Until then the files are unsigned and Windows warns, and the
  page says so.
- A weekly and per-push OWASP ZAP baseline scan of a seeded server joins the security checks; High-risk alerts
  fail the build.
- Help pages are served with their own strict Content-Security-Policy (no script at all).

### Known limits

- Files are not signed yet, so Windows and macOS warn when you install (see the install page).
- No outside security review of the encryption protocol yet. Desktop keys are not yet wrapped by the
  operating system's key store.
- Polls don't work with friends on other PCs (they are refused rather
  than half-working). Calls through a real TURN relay have only been tested against a simulated one.
- Devices on 0.12 builds from before the release can't link to 0.12.0 devices (the link code changed).

## 0.11.1

- Updates install themselves, with the review's fixes.

## 0.11.0

- Security hardening across the server, the registry, the desktop app and CI.
