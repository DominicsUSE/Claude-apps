# Changelog

Snug's releases, newest first. Every version's files stay on the releases page
(<https://github.com/DominicsUSE/Claude-apps/releases?q=snug-v>); the desktop app updates itself and never
goes back to an older version on its own (README, "Install, update, go back").

## 0.13.0

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

### Known limits

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
- Lithuanian is partial and unreviewed. Polls don't work with friends on other PCs (they are refused rather
  than half-working). Calls through a real TURN relay have only been tested against a simulated one.
- Devices on 0.12 builds from before the release can't link to 0.12.0 devices (the link code changed).

## 0.11.1

- Updates install themselves, with the review's fixes.

## 0.11.0

- Security hardening across the server, the registry, the desktop app and CI.
