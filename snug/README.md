# Snug

A calm place for your people. Houses (communities) hold rooms, rooms hold
conversations, and any message can grow a thread. Direct messages, groups,
voice rooms, roles, search, saved messages and a single place to catch up.
Make it yours: profile pictures and decorations, themes and a theme
builder, your own accent, fonts, chat display, sounds and keyboard
shortcuts. Real accounts, a real database, live delivery between people.

![Snug on desktop: a room with a thread open beside it](docs/preview.png)

## Run it

Snug is a real multi-user app: a Node server, a SQLite database and a
WebSocket connection per open tab. It needs Node 22.13 or newer.

```bash
cd snug
npm install
npm start
```

Then open http://127.0.0.1:8787 and create an account. A new account starts
empty: create a house, then invite people with a link.

To start with the sample houses and people instead:

```bash
npm run seed
npm start
```

Sign in as `robin` (or `ines`, `tomasz`, `priya`, `jonas`, `bex` and others)
with the password `snug-demo-1`. Robin has friends (one request waiting each
way), two public houses to find in Discover and three events: one on now, one
tonight and one next week, all timed from when you seed. Open a second browser profile or a private
window and sign in as someone else to talk to yourself. `npm run seed --
--force` wipes the database and loads the sample data again.

Tests:

```bash
npm test            # rules (27) and the server with real sockets (94)
npm run test:e2e    # separate people in separate browsers (91), needs Playwright
```

`test:e2e` runs every `tests/e2e*.test.js` one file at a time: the core
flows (23), calls in direct messages and groups (10), camera and screen
sharing (9), voice messages, pins and GIFs (4), custom emoji (3),
notifications when Snug is closed (4), safety, privacy and moderation (5),
messaging (11: rich text, polls, forwarding, previews, scheduling, stickers,
search), places, structure and community (8: private rooms, forums, stages,
roles and nicknames, rail folders, webhooks, templates, welcome and
insights), voice and video options (6: devices, push to talk, volume per
person, soundboard, room limits and bitrate, the floating call, live
processing, deafen, sounds and leaving when alone), account, profile and
appearance (6: settings that follow you, the quick switcher, status and
invisible, two-factor sign-in, devices, notes and streamer mode) and the
settings structure across all of them (2). Each also runs alone: `npm run
test:e2e:calls`, `test:e2e:video`, `test:e2e:messages`, `test:e2e:emoji`,
`test:e2e:notify`, `test:e2e:safety`, `test:e2e:messaging`,
`test:e2e:places`, `test:e2e:voice-options`, `test:e2e:account`,
`test:e2e:integration`. The notifications file uses Playwright's newer
headless Chromium (`channel: 'chromium'`).

## The desktop app

Snug also ships as a Windows app (`desktop/`): one file to install or run,
with the server inside it. Every change to `snug/` builds it on GitHub's
Windows machines (`.github/workflows/build-snug-windows.yml`), runs Snug's
tests there, and drives the packaged app before publishing:

- Open **Actions > Snug Windows app**, pick the latest run and download
  **Snug-Windows-Installer** (Start menu and desktop shortcuts) or
  **Snug-Windows-Portable** (one `.exe` that runs without installing).
- Builds on the default branch also publish both as a release (`snug-v<version>`).

The app is not code-signed, so the first time Windows may show "Windows
protected your PC": click **More info**, then **Run anyway**.

On first run it asks where Snug should run:

- **On this computer.** The server runs inside the app and the database
  lives in your app-data folder (**Snug > Open the data folder**). Switch on
  *Let people on my network join* and others on the same Wi-Fi can open the
  address from **Snug > Copy the address for other people**, in a browser or
  in their own Snug app. Over that plain address they can write but not use
  voice, because browsers only allow the microphone on secure pages.
- **Join a Snug.** Type the address of a Snug that someone else runs.

**Snug > Change where Snug runs** brings the choice back.

Closing the window keeps Snug running in the system tray (the menu bar on a
Mac), so its connection stays open and notifications keep arriving; the
first close says so. The tray menu has **Open Snug** and **Quit**; Quit stops
the server and closes the database cleanly. Turn this off with **Snug > Keep
Snug running when the window is closed** or the same switch in Settings >
Notifications (stored in `desktop.json`). Opening Snug again while it runs in
the tray brings the window back. Clicking a notification shows the window on
the conversation. Tested under Xvfb on Linux (the window hides, the server
keeps answering, a message from a second person notifies and the click
opens it, tray Quit exits); the tray icon itself and the system's
notification banner were not looked at on a real Windows or Mac desktop.
An incoming call brings the window up, from the tray too, without taking
the focus from whatever you are typing in, flashes it in the taskbar and
shows a system notification ("Lou Brandt is calling") that closes when the
ring stops; the window then shows the incoming-call screen. Tested under Xvfb (the hidden
window comes back, the notification is recorded, the screen shows and goes
when the caller gives up); the banner itself was not seen.

**Desktop settings** (Settings > Desktop app, mirrored in the Snug menu, kept
in `desktop.json`): open Snug when you sign in to your computer (it starts in
the tray), start minimised, minimise to the tray, hardware acceleration
(applies after **Restart now**), and checking for a newer Snug. The window
opens where you left it (size, place, maximised), unless that place is no
longer on any screen, and its background follows your Snug theme.

**The unread number on the icon**: the same number as the tab title, as the
app's badge (macOS, Linux) or a taskbar overlay drawn by the app (Windows,
"3 unread"), and in the tray tooltip ("Snug: 3 for you"). A new mention while
the window isn't focused flashes it. Settings > Desktop app turns the number
off; an installed web app shows it too.

**Global mute and deafen keys**: two shortcuts (two of Ctrl, Alt and Shift
with one key, or one of them with an F key, so nothing other apps rely on,
like Ctrl+C or Alt+F4, is taken) that work while you are in a voice room or
call, even when another app is in front. They are held only while you are in voice;
clashes and keys another app has taken are reported.

**snug:// links**: `snug://join/<code>` opens the invitation in the app
(**Copy app link** in the invite box) and `snug://open/<place>[/<message>]`
opens a room or conversation, from a click, a second launch or macOS's
open-url. Anything else is ignored; the server still refuses what you may not
read. **Away** follows the computer: locked, asleep or idle for five
minutes, and back when it is unlocked or used again.

**A newer Snug**: once a day the installed app asks GitHub for the latest
release (10 seconds, 1 MB at most) and shows a strip with **Get it** (opens
the release page in your browser). Nothing downloads. Off in settings or with
`SNUG_UPDATE_CHECK=0`; running from source doesn't ask.

Tested by `desktop/test.js` under Xvfb: the badge count and the flash when a
second person mentions you while another window has the focus, the overlay
image drawn, the theme colour (and bad colours refused), open at login and
minimise to tray, the Snug menu entries, the global keys held only in voice
and their press toggling mute and deafen, a second launch with a join link
showing the invitation and a malformed link doing nothing, locking the
computer (as the app reports it) turning you Away and unlocking back, the update check
against a local stand-in (newer shows, the same version and failures stay
silent), and the window's place kept across launches with an off-screen
place falling back to the centre. Not seen: the real taskbar overlay, the
macOS dock badge, login items (Linux has none; the setting is recorded),
Windows' protocol registration, and the computer really locking.

To work on the app:

```bash
cd snug/desktop && npm install && npm start
```

```bash
npm test    # drives the real app window; on Linux run it under xvfb-run -a
```

## What is real, and what is not yet

Real, and covered by tests with separate users:

- Accounts, sign-in, sign-out, sign out everywhere, password change.
- Houses, rooms, roles and permissions, invitations by link and by username,
  member removal, newcomer onboarding.
- Messages, replies, threads, edits, deletes with undo, reactions, file and
  picture uploads. All stored in the database and delivered live.
- Direct messages and groups, with friends or people you share a house with.
- Friends: requests by username, accept, decline, remove, private favourites.
  Friends see each other's presence without sharing a house.
- Discovery of public houses (by topic or name) and of people you are
  connected to through a house or a mutual friend; joining a public house
  without an invitation.
- Events in houses, with who is going, live to everyone in the house.
- Presence from real connections, typing notices, unread state and saved
  messages synced across a person's devices.
- Search over every stored message a person may read.
- In-app notes and desktop notifications while a tab is open.
- Notifications when Snug is closed (Settings > Notifications > *Notify me
  when Snug is closed*): Web Push through the browser's own push service, with
  a service worker at `/sw.js`. The server keeps one VAPID key per data
  folder, encrypts each note to the device (RFC 8291 aes128gcm, RFC 8292
  VAPID, node:crypto only), and sends one only for what needs you (direct
  messages, mentions, replies, followed threads; never muted places or while
  Focused) and only while none of your Snug tabs is connected, at most five
  at once then one every 20 seconds. One notification per conversation;
  clicking opens it in an open Snug tab or a new one. Signing out removes the
  device. Tested against a local mock push service (decrypting each push and
  checking its signature) and with Chromium's real service worker
  (`npm run test:e2e:notify`); delivery
  through Google's push service could not be reached from the test machine,
  so a real Chrome or Firefox push has not been seen end to end.
- Voice rooms: real audio between people over WebRTC. The server only
  introduces them to each other.
- Camera and screen sharing in voice rooms, on the same peer-to-peer
  connections: camera at 640x360 to 1280x720, screen share with its sound
  where the browser offers it, stopped by the browser's own "Stop sharing".
  Someone joining late gets what is already on. Screens take the large tile
  with the rest in a strip; click any tile to make it large; full screen for
  a shared screen. The desktop app answers a screen share with its own picker
  of screens and windows. Tested with Chromium's fake camera and screen
  (`npm run test:e2e:video`) and in the desktop app under Xvfb; real cameras,
  and system sound (Windows only, in the desktop app), have not been tested
  here. Not tested either: the browser's own "Stop sharing" bar (headless
  Chromium has none, so the test ends the track instead), the macOS system
  picker, full screen actually filling the screen (only the button is
  checked), and the desktop video test on the Windows build machines. Video
  rides the same mesh as audio, with bitrate capped as the room grows, so more
  than a few cameras at once will strain it.
- Calls in direct messages and groups: the phone and camera buttons in a
  conversation's header start a voice or video call, on the same WebRTC
  code as voice rooms (a call is a voice place keyed by the conversation),
  with the same stage: tiles, camera, screen share, mute, deafen, hang up.
  Starting one rings everyone else in the conversation on every device they
  have open: an incoming-call screen with the caller's circle, name, *Voice
  call* or *Video call*, **Accept** (mint), **Accept with video** and
  **Decline**, a ringtone made with WebAudio (no sound files) that stops on
  any outcome, Enter to accept and Esc to decline (outside text fields: a
  ring never takes the focus from the composer, so a message being typed
  keeps its Enter and Esc), announced to screen readers, a bottom sheet on
  a phone. If the microphone can't start, nothing is sent and the call
  keeps ringing, so the incoming screen comes back. Picking up on one device stops the
  ring on the others ("You answered on another device"). A ring lasts 30
  seconds. In a one-to-one call, Decline or no answer ends it for the caller
  with *Declined* or *No answer* and Call again; in a group the others keep
  ringing until their own timeout and the call goes on while anyone is in
  it, with a *Call in progress* strip and Join for anyone not in it. Someone
  already in a call (or a voice room) still sees the ring, and accepting
  moves them: one live call per person. Calling, joining or joining a voice
  room from inside a call asks first, saying whether the call ends (one to
  one) or goes on without you (a group). A conversation set to Nothing, or
  being Focused, shows the call without a ringtone. The conversation gets
  records written by the server: *Missed call*, *Declined call* or *Call ·
  4m 12s* with who started it, shown as system lines that nobody can edit,
  delete, react to, pin or thread off. A missed call counts as needing you
  (even in a group set to Only what needs me, on the badge and in push);
  calls you took part in or declined are history, shown as quiet lines and
  never counted. A record doesn't move anyone's read marker, so messages
  sent before or during the call stay unread. Conversations with a live call carry a mint phone mark in
  the lists, and the dock at the bottom of the column shows the call and
  takes you back to it. With Snug closed, the callee's devices get a push,
  "Name is calling", that opens the conversation and stays on screen until
  the ring stops; then it is replaced by a quiet note (*Missed call*, *You
  answered on another device*) and the missed call record, if any. Up to 12 people in a call (a group holds at most
  10). Starting calls is limited to four at once, then one every 15
  seconds. Tested with real sockets (`npm test`) and in Chromium with its
  fake microphone and camera (`npm run test:e2e:calls`, with the ring
  shortened to 5 seconds by `SNUG_RING_MS`, which only the test runner
  honours). Not tested: the ringtone actually being heard (the test checks
  it starts and stops), a browser notification for a ring in a background
  tab, a ring push arriving through a real push service (only the mock), a
  12-person call, and calls on real phones and networks. Calls respect
  muting, Focused, quiet hours and blocks (a blocked person can't call you,
  and a group call never rings someone who blocked the caller).
- Offline: the app opens from a copy on the device, what you write waits,
  and it sends once when the connection is back.
- Voice messages: hold the microphone to record (or tap to start and tap
  Send), up to 5 minutes, with a live timer and level meter; Esc (or sliding
  left on a phone) cancels. They play in a compact row with a waveform, seeking
  and 1x, 1.5x, 2x. Audio types are checked against the file's bytes, and
  files answer Range requests so playback can seek. Recorded and played back
  in Chromium with its fake microphone (`npm run test:e2e:messages`); sliding
  left to cancel on a phone and pausing when scrolled away are built but have
  no automated test.
- Pinned messages: up to 50 per room or conversation, pinned by roles with
  the Pin messages or Remove messages permission (anyone in a direct
  conversation or group), live to everyone who can read, listed from the pin
  in the header. Someone who joins a house sees its pins from their next
  sync, not at once.
- GIFs: star any GIF to keep it in Your GIFs on every device, and pick from
  GIFs posted in your places. Search is optional (see `SNUG_GIF_PROVIDER`);
  a GIF picked from search is downloaded by the server and stored as a Snug
  file, so no message loads from another site. Tested against a local stand-in
  for the provider, not against Tenor itself.
- Custom emoji per house: up to 100, added in House settings > Emoji by roles
  with the Manage emoji permission (PNG, GIF or WebP, up to 256 KB and 256 by
  256 pixels, checked from the file on the server). Type `:name:` (with
  suggestions after two letters) or pick them from their house's section of
  the emoji picker; they work in messages and reactions, live to everyone. Used
  in a direct message, the people there see them too; a removed emoji reads as
  its `:name:`. Images are served only to people allowed to see them.
  `npm run test:e2e:emoji` drives it with two people in two browsers. Using
  one in a direct message is covered by the server tests only, and the Emoji
  settings page has not been driven on a phone (only looked at, at 390px).

- **Settings in one structure** (`js/views/settings.js`): personal settings
  in two sections (You: Profile, Account and security, Privacy and safety,
  Your data; App: Notifications, Voice and video, Appearance, Text and
  messages, Accessibility, Streamer mode, Keyboard, and Desktop app inside
  the desktop app) and house settings in four (House; Rooms and newcomers;
  Moderation; Owners). Each house page shows only to people with its
  permission; "Find a setting" matches the words on each page (the whole
  phrase, or every word as the start of one of the page's words; loose
  letter-by-letter matching only on page names) and stays first in the row
  of tabs on a phone. The integration test searches for an option from each
  track (ringtone, theme builder, skin tone, decoration, rebind) and expects
  exactly the page it lives on. Each room's slowmode, user limit and
  bitrate sit with its Access button on Rooms and access. Covered by `npm run
  test:e2e:integration` (2 tests, one on a 390px phone), and by one server
  test (the "integration" block at the end of `tests/server.test.js`) for
  the rules the tracks share: one role hierarchy across moderation, member
  and role changes with extra roles counted, changes made by every track in
  the house log, role mentions for pushes, events whose room went private,
  and blocks stopping poll votes.

- Safety, privacy and moderation (`server/safety.js`, `js/views/safety*.js`),
  every rule applied on the server:
  - **Blocking** from a profile or a message's menu. A blocked person can't
    start a conversation with you, write or react in your one-to-one
    conversation, call you (nor ring you in a group call), send you a friend
    request, or reach you with a mention or a push. Blocking ends a
    friendship and takes back pending requests. In houses you share, their
    messages fold to "Blocked message" with Show. Settings > Privacy and
    safety lists them, with Unblock. The person blocked isn't told.
  - **Privacy**: who can start a conversation with you (everyone, people in
    your houses, friends only), who can send you friend requests (everyone,
    friends of friends, nobody), and **message requests**: a conversation
    from someone who isn't your friend waits behind Accept, Decline and Block,
    never notifies, and can't call you until you accept (replying accepts it).
    People with no house in common always land there. Declining leaves the
    conversation; the same person can't ask again for a day.
  - **Moderation**, each with its own permission (Remove people, Ban people,
    Time people out, Moderate voice, See the house log) and only on people
    whose best role (extra roles count) sits below yours; nobody can act on
    an owner. The same hierarchy now guards changing someone's role, removing
    them, and editing or deleting a role: someone who isn't an owner only
    reaches people and roles below their own. Remove; ban
    (with a reason, optionally deleting their last 24 hours or 7 days of
    messages; bans hold against links, invitations and Discover; House
    settings > Bans to unban); time out for 60 seconds to a week (no writing,
    editing, reacting, threads or voice, and none of their role's powers:
    pinning, managing rooms, roles, webhooks, events, invitations or emoji,
    or moderating others; reading and deleting their own messages still
    work; with a countdown in their message box); in
    voice, mute and deafen (holding across rejoining until lifted), move and
    disconnect, from a button on the stage.
  - **Reports** of a message or a person, with a reason and a note, go to the
    house's moderators (people who can remove messages): House settings >
    Reports, with resolve, dismiss and reopen. In direct messages, block.
  - **House log**: who did what to roles (and their order and extra roles),
    rooms (and their access, tags, webhooks, slowmode, user limit and
    bitrate), settings, the welcome, members and nicknames, bans, timeouts,
    voice, messages deleted by moderators, emoji, stickers, the soundboard and
    invitations, filtered by kind and by person.
  - **Slowmode** per room, 5 seconds to 6 hours, set on House settings >
    Rooms and access, with a countdown above the message box; roles that can
    remove messages skip it.
  - **Word and link filter** per house: blocked words (whole words, any case
    or accent, `*` for "starts with") and links; block, flag to Reports, or
    block and time out; roles to skip (extra roles count). Owners and roles
    that manage the house always skip it. Forum post titles go through it
    too; a flagged title goes to Reports.
  - **Invitation links** that expire (30 minutes to never) or run out (1 to
    100 uses), listed with their uses and who made them, and revocable.
  - **Member screening**: with the house rules written (House settings >
    Filter and screening), newcomers read and accept them before they can
    write, react or join voice.
  Covered by `npm test` (7 server tests with real sockets, 2 rules tests) and
  `npm run test:e2e:safety` (5 tests, separate browsers, one on a phone).
  Limits: a server mute is enforced by honest browsers (the muted person's
  microphone track is switched off and everyone else's browser stops playing
  them); audio is peer to peer, so a modified client could still send sound
  to people whose browsers ignore the flag. The receiving side was checked
  through the voice state, not by measuring the audio element.

- Messaging (`server/messaging.js`, `server/linkpreview.js`, `js/views/messaging.js`,
  `js/views/rich.js`), every rule checked on the server:
  - **Rich text**: bold, italic, bold italic, __underline__, ~~strikethrough~~,
    ||spoilers|| (hidden from sight and from screen readers until clicked),
    inline code, fenced code blocks with a language label, Copy and light
    highlighting (JavaScript and TypeScript, JSON, Python, CSS, HTML and XML,
    shell, SQL, Go, Rust; nothing downloaded), quotes (`>` and `>>>`), headings
    (`#`, `##`, `###`), lists, subtext (`-#`), `\` to escape, and masked links
    `[text](https://...)` that show their real host on hover and ask before
    opening a host you haven't trusted. Built from tokens, never from HTML.
    Select text in the message box for a formatting bar, or use Ctrl (⌘) + B,
    I, U, E (code), K (link), Shift+X (strikethrough).
  - **Dynamic times**: `<t:unix:style>` (t, T, d, D, f, F, R) reads in each
    reader's own language and time zone; + > Insert a time picks one.
  - **Polls** from the + by the message box: 2 to 10 answers with optional
    emoji, one or many choices, open 1 hour to 1 week, results live, votes
    changeable, one vote per person per answer (kept by the database),
    optionally hidden until you vote (the server sends nobody's counts to
    someone who hasn't voted, until it ends), ended early by its author or a
    moderator, closed by the server on time. Voting follows the same rules as
    reacting: a timeout, unaccepted house rules or a block stop it.
  - **Link previews**: the server fetches up to three links per message (title,
    description, site and picture from Open Graph tags; pictures and MP4 videos
    linked directly show as themselves). It resolves each host itself and
    refuses loopback, private, link-local and cloud metadata addresses, CGNAT,
    multicast and reserved ranges (IPv4 and IPv6, IPv4 inside IPv6 too),
    connects only to the address it checked, follows at most three redirects
    and checks each one, allows ports 80, 443, 8080 and 8443 only, stops at
    6 seconds and at 10 MB (4 MB for a page's picture), and caches for hours.
    Pictures are stored as Snug files in the conversation, so a reader's
    browser never loads another site. The author or a moderator removes a
    message's previews; `<https://...>` asks for none; Settings > Appearance >
    Link previews hides them; `SNUG_LINK_PREVIEWS=0` turns fetching off.
  - **Forward** a message (from its menu) to any room or conversation you can
    post in, with a note: who wrote it and when travel with it, files are
    copied, and "Go to message" shows only to people who can read the original.
  - **Edit history**: the last ten earlier versions, for everyone who can read
    the message; gone with its content when it is deleted.
  - **Scheduled messages**: + > Schedule a message, up to 30 days ahead and 25
    waiting; listed above the box with Cancel; sent by the server on time and
    checked again then (someone removed meanwhile is told it wasn't sent).
  - **Stickers**: up to 30 per house in House settings > Emoji (PNG, APNG or
    WebP, up to 512 KB and 320 by 320 pixels, read from the file), sent from
    + > Send a sticker by members of that house, anywhere they can post.
  - **Mark unread** from a message, a bar to **jump to the first unread** (or
    mark it read), and **go to a date** from the calendar in a conversation's header.
  - **Search filters**: `mentions:`, `before:`, `after:`, `during:` (a day,
    month or year in your time zone), `pinned:true`, `has:poll`, `has:sticker`,
    `has:video`, as chips, with suggestions while you type an operator.
  - Typing notices and per-conversation drafts were already there.
  Covered by `npm test` (7 server tests with real sockets, 2 rules tests) and
  `npm run test:e2e:messaging` (11 tests, two people in two browsers, one on a
  phone). Link previews were tested against a stand-in site on this machine,
  which only the test runner may reach; real sites were not fetched from here.
  Not tested: Go, Rust and SQL highlighting in a browser (unit tests only),
  APNG animation (checked as PNG), forwarding a voice message, and the
  scheduler under a server restart (scheduled messages are stored, so they
  survive one, but no test restarts the server between scheduling and sending).

- **Places, structure and community** (`server/places.js`, `js/lib/places.js`,
  `js/views/places*.js`, `css/structure.css`):
  - **Room permissions**: per room, overrides for everyone, for a role and for
    one person (see the room, send messages, join voice, speak, manage the
    room), and **private rooms**. One resolver answers every server check:
    reading (live delivery, history, threads, search, files, push, the
    snapshot), writing, joining and speaking in voice, and managing a room.
    A person's own setting beats their roles'; across roles, "on" beats
    "off". Owners, and people who manage rooms house-wide, always see every
    room, so nobody can lock the house out. Discovery and previews hide
    rooms that not everyone in the house can see. The room's access dialog
    has **Check a person**: what one member can do there, worked out by the
    server's own resolver. Highlights, events, pins and forum posts in a room
    follow it too; an event made before its room went private still shows to
    the house, without the room, to people who can't see it.
  - **Roles**: more than one per person (extra roles add permissions), an
    emoji icon, **show separately** in the member list (online people under
    their highest such role, then Online, then Offline), **mentionable**
    (`@Role name` counts as a mention for everyone with it, in the browser and
    for phone notifications alike), colours from the
    theme-safe hue list only, and order by **drag** or **Alt and an arrow**.
    Managers who aren't owners can only move, give or take roles below their own.
  - **Per-house nicknames and pictures** (an emoji and a colour), with the
    *Change nickname* and *Manage nicknames* permissions.
  - **Forum rooms**: posts with a title, a body and the room's tags (a room
    can require one), sorted by latest activity or newest, as a list or a
    grid; each post opens as its own thread, which you can follow from its card.
    The author, or whoever manages the room, can change a post's title and
    tags; titles go through the house's word filter like any message.
  - **Notice rooms other houses can follow**: someone who manages a room in
    another house can have new notices copied there, posted by a bot that
    says where they came from. Private notice rooms can't be followed and
    stop copying.
  - **Stage rooms**: speakers and an audience on the same voice connections;
    the audience is muted by the server, raises a hand, is invited to speak
    or moved back by the people who run the stage, and sees a live topic.
  - **Webhooks** per room: a secret address (only its hash is stored) that
    takes `POST {"content", "username", "avatar_url"}` and posts with a
    **Bot** badge; 5 at once then one every 2 seconds per hook, 30 per
    address; new address or delete at any time. `avatar_url` must be https
    and is kept but never fetched or shown: Snug loads no images from other
    sites, so no server-side fetch and no readers' addresses leak.
  - **Rail folders**: drag a house onto another to make a folder, name and
    colour it, open and close it; drag or Alt and an arrow to reorder. Kept
    on the server, so every device has the same rail.
  - **Welcome for newcomers** (House settings > Newcomers, one page): the
    role newcomers join as, the starter rooms, a few lines of welcome, and
    interests to pick that grant roles (never roles that manage or moderate anything).
  - **House templates** (Friends, Study group, Gaming, Club) and copying the
    structure of a house you manage (rooms, roles, access; never messages or members).
  - **Insights** for owners: members, who wrote this week, joins and leaves
    and messages per day, the busiest rooms (7, 30 or 90 days, with a table view).
  Covered by `npm test` (2 tests of the resolver and the shared rules in
  `tests/logic.test.js`, 13 server tests with real sockets, in the "places"
  block of `tests/server.test.js`) and `npm run test:e2e:places` (8 tests,
  two people in two browsers). Not tested: role mentions through a real
  push service (the server's rule is tested), dragging on a touch screen (folders and role order also work from the
  keyboard and menus), and stage audio limits beyond the server's mute: in a
  peer-to-peer call a modified client could still send sound, which every
  other Snug ignores because the server marks it muted.

- **Houses and community** (`server/community.js`, `js/lib/community.js`,
  `js/views/community*.js`, `css/community.css`):
  - **Categories and room order**: make, rename, reorder and delete
    categories (a category's rooms move to the one you pick; the last one
    stays). Drag rooms between categories and drag categories, in the sidebar
    and in House settings > Rooms and access; there, focus a room's or a
    category's grip and press **Alt and an arrow** (across categories at the
    ends; a live region says where it landed). In the sidebar a room's menu
    has Move up, Move down and Move to, so the keyboard works there too
    without taking over Alt and an arrow, which already moves between places.
    Needs *Manage rooms* (and managing that room); ids from another house are
    refused, positions are renumbered in one transaction, and each change is
    in the house log.
  - **House pictures**: an **icon** (square PNG, JPEG, WebP or GIF, up to 1 MB
    and 512 px) drawn inside the circle wherever the house appears, with the
    letter and colour behind it if it can't load; a **banner** (2 MB) at the
    top of the house's sidebar and on Discover cards for public houses; an
    **invitation background** (2 MB) behind the card a link opens. The type
    comes from the bytes. Members always see them; the icon and background
    also go to anyone holding a valid invitation link (or a personal
    invitation) and to everyone for a public house; the banner to members and
    public previews; anyone else gets 404. *Manage the house*, audited and rate-limited.
  - **Danger zone** (House settings > Overview, owners): **transfer
    ownership** to a member, optionally stepping down one role, and **delete
    the house**: its exact name. Both need a two-factor code when the owner
    uses two-factor sign-in. Rooms, messages, threads, files, webhooks, events and
    the house log go in one transaction; voice rooms close and every member's
    devices hear that it's gone.
  - **Finer permissions**: *Manage the house* (settings, pictures,
    screening, welcome, soundboard settings), *Plan events* (create, and edit
    or cancel anyone's), *Manage webhooks* and *Add reactions* (taking back
    your own reaction always works). The role newcomers join with stays with
    *Manage roles and members*: below an owner, a role under your own that
    manages nothing. Each role got them once from what they
    replace (*Manage roles and members* gives the house and webhooks, *Post
    notices* or *Manage rooms* give events, *Manage rooms* webhooks too, and
    every role reactions), so nobody lost anything; after that they are
    separate switches in the role editor.
  - **Events**: the planner, or a role that plans events, **edits** an event
    live for everyone; **Somewhere else** (up to 100 characters, an https link
    shown as text and never fetched); a **cover** (PNG, JPEG or WebP up to
    2 MB, members only); **Interested** beside **Going**, counted apart.
    **Reminders** 15 minutes before and at the start, in the app and as a
    push to closed devices (never for a muted house, while Focused or in
    quiet hours), with Join for a voice or stage room.
  - **Spam rules** (Filter and screening): too many distinct mentions (3 to
    50), flooding (the same words N times in 30 seconds, or more than 2N
    messages in 10), invitation links to other houses, and shouting (over
    70% capitals in more than 20 letters). Each has its own action (block,
    flag to Reports, or block and time out), checked before a message is
    stored, in the same place as the word filter; hits go in the house log.
    Rooms can be exempted, besides the roles the filter already skips.
  - **Verification and pausing**: a verification level (none; an account
    older than 5 minutes; older than a day and in the house for 10 minutes)
    that stops newcomers writing, reacting and joining voice until then, with
    a countdown above the message box; moderators and owners never wait.
    **Pause invitations** for 1, 6 or 24 hours or until lifted: links, open
    joining and personal invitations are refused with a note. **Moderators
    need two-factor sign-in** (owners): removing, banning, timing out and
    deleting others' messages are refused without it. *Manage the house* or
    *Ban people*; audited.
  - **The house's own link**: owners set `/join/<word>` (3 to 32 of a-z, 0-9
    and dashes, unique ignoring case, a few words kept for Snug, a few changes
    an hour). It joins like an invitation, so bans, the pause and screening
    still apply; clearing it frees the word.
  - **Newcomers**: *Announce newcomers in* a room writes "Name joined the
    house." (a line from the server, with **Say hi**), seen only by people who
    can see that room, a few at most per minute during a rush of joins.
    *Notifications for new members* starts them on Everything or Only mentions.
  Covered by `npm test` (`tests/logic-community.test.js`: 10 tests of the
  shared rules, the permission list and the backfill; `tests/server-community.test.js`:
  22 server tests with real sockets) and `npm run test:e2e:community` (5
  tests, two people in two browsers; the icon test also checks the house's
  own page and the sign-up page a link opens before an account exists). Not
  built: the invitation background on that sign-up page (the icon shows
  there; the join card after sign-in shows the background), and a banner on
  the phone's house screen. Not tested: dragging on a touch screen (the menus
  and keys do the same), and a reminder push through a real push service (who
  would get one is tested).

- **Voice and video options** (`server/voiceopts.js`, `js/voiceopts.js`,
  `js/views/voiceopts*.js`, `css/voiceopts.css`):
  - **Devices**: choose the microphone, the speaker (where the browser can
    send sound to a chosen output) and the camera, in Settings > Voice and
    video. A microphone check with a level meter and "hear yourself", and a
    camera preview. A device that has gone falls back to the default, saying so.
  - **Input mode**: voice activity, with sensitivity set automatically or by
    hand on the live meter, or **push to talk** with a key you pick, an
    on-screen hold button (phones too), and a release delay. In the desktop
    app the key also works while another app is in front (a global shortcut;
    the system only reports presses and their repeats, so the microphone
    closes shortly after they stop).
  - **Noise suppression, echo cancellation and automatic gain**, changed
    during a call without anyone's connection being renegotiated: what is
    sent goes through one WebAudio graph whose track never changes.
  - **Each person's volume** (0 to 200%) and a **mute only you hear**, in voice
    rooms and calls, remembered per person on this device.
  - **Soundboard**: up to 24 short sounds per house (any audio file, turned
    into a WAV of at most 5.2 seconds and 512 KB, checked again from the file
    on the server), each with a name, an emoji and a volume. Playing one
    mixes it into your own voice, so everyone in the room hears it; the room
    sees who played what. Needs to be in a voice room of that house and not
    muted; one sound every 3 seconds per person and 6 per 10 seconds per
    room. *Manage sounds* adds and removes them; a house can keep playing to
    roles with *Use the soundboard*. Managed in House settings > Soundboard.
  - **The call follows you**: a floating, draggable call (mouse or arrow
    keys) while you look at other places, with the speakers, a shared screen
    or camera, and the controls; **picture in picture** for a shared screen or
    camera where the browser supports it.
  - **Screen share quality**: 720p, 1080p or source; 15, 30 or 60 frames a
    second; with or without sound.
  - **Sounds** for people joining and leaving and for muting (made with
    WebAudio), each switchable; **deafening mutes you too** (or not); hearing
    again puts your mute back how it was; **leave a voice room after a chosen
    time alone**.
  - **Per voice room**: a **user limit** the server enforces (people who
    moderate voice may still join) and an audio **bitrate** every browser in
    the room applies, both set on House settings > Rooms and access.
  Covered by `npm test` (3 server tests in the "voice options" block of
  `tests/server.test.js`: upload and permission rules, playing and its
  cooldowns, room limits), `npm run test:e2e:voice-options` (6 tests, two
  and three people in separate browsers with fake devices: device lists and
  checks, push to talk gating what is sent, volume on the element that plays
  someone, a sound arriving at the other person, the limit, the bitrate
  reaching the sender and the floating call, processing switched in a call
  under the same sent track, deafen and its mute, the join, leave and mute
  sounds, leaving after a while alone, and volume and a mute only you
  hear in a direct call) and one desktop test (the global key). Not tested: real hardware
  (a second real microphone or speaker, `setSinkId` on a real output),
  picture in picture (headless Chromium offers neither kind), the automatic
  sensitivity against real speech, and the global key pressed on a real
  keyboard (the test sends the press the system would).

- **Account, profile, appearance and security** (`server/account.js`,
  `js/lib/account.js`, `js/lib/qr.js`, `js/account.js`, `js/views/account.js`,
  `css/account.css`), every rule checked on the server:
  - **Presence**: Open to talk and Around (online), Away (idle), Focused (do
    not disturb: no pop-ups, sounds or phone notifications; optionally calls
    from favourite friends still ring) and Offline (invisible: the server shows
    you as offline to everyone while you stay connected). **Auto-idle** after
    5 minutes to an hour without keyboard or mouse: shown as Away to others
    only while every reporting tab is idle, never changing what you picked.
  - **Custom status**: an emoji and a line, clearing after 30 minutes, 1 or 4
    hours, at the end of your day, or never. The server stops showing it the
    moment it runs out and tells everyone.
  - **Profile**: pronouns, an accent hue (theme-safe, like every chosen
    colour), a banner picture (PNG, JPEG, GIF or WebP up to 2 MB, read from its
    bytes, served only to people who may see you), an About of up to 400
    characters with message formatting, and **private notes** on people that
    only your own devices ever receive. Per-house names and pictures are the
    nicknames in Places.
  - **Appearance** (`server/appearance.js`, `js/lib/colour.js`,
    `js/lib/theme.js`, `js/views/appearance.js`, `css/appearance.css`),
    saved on the server and applied at once on every device, with a sticky
    **live preview** drawn with the real message component:
    - **Themes** as named cards: match the device, Dark, Light, **Midnight**
      (true black), **Ash**, **Slate**, **Moss**, **Paper**, **Sepia** and
      **Contrast dark**; also in the quick switcher by name. Every preset's
      text reaches 4.5:1 on its surfaces (checked from the CSS by a test).
    - **Theme builder**: four colours (background, panels, text, accent) and
      a dark or light base. Every other token is derived, with live contrast
      badges; up to 5 saved themes. Share one as a code
      (`snug-theme:1:` and base64url JSON) and import it on any account.
    - **Accent**: violet (Snug's own), cyan, mint, amber, rose, neutral, or any
      hex colour, for the primary button, switches, the selected row, the
      active tab and the focus ring. It is nudged per theme so fills reach
      3:1 and accent text 4.5:1; a colour that would need more than a small
      nudge on any built-in theme is refused. Violet stays the brand and "for
      you" (mentions, the New line, badges) whatever the accent. An accent
      saved as coral (Snug's colour before violet) reads as violet.
    - **Chat**: times always or on hover, big emoji on or off, emoji size,
      reactions shown or hidden, GIFs and animated custom emoji (match
      motion, always, on hover, never: a still frame until pointed at),
      spoilers on click or always shown (text and attachments alike), other people's name styles on or
      off, and a faint chat background (dots, grid, arches, grain; off with
      high contrast).
    - **Text**: Inter, the device's own sans or serif, Atkinson Hyperlegible
      or Atkinson Hyperlegible Mono, and a code font; text size 12 to 20 px;
      zoom 80 to 150%; 12 or 24-hour clock. **Cozy or compact** messages,
      pictures in compact, spacing, line height, saturation, role colours on
      names, and the sidebar's width (drag its edge, or arrow keys on the grip).
    - **This device only**: theme, zoom, text size, spacing, display and
      sidebar width can stay on one device (kept in its browser), with
      Reset to synced.
    - **No flash on opening**: the look last applied on a device (custom
      theme and accent colours included) is put on the page by `js/boot.js`
      before anything else runs; only plain attribute values and hex or
      `rgb()` colours are accepted from that copy.
    - No custom CSS. Every setting is a value from a fixed list, a number in
      a range, or (custom themes, accents, profile colours) a `#rrggbb` hex
      colour that the server runs through the same contrast checks before
      it keeps it. The page applies colours one custom property at a time,
      never as CSS text.
  - **Profile picture and style**: upload a picture (PNG, JPEG, GIF or WebP,
    up to 2 MB, 64 to 2048 px, read from its bytes), cropped square with zoom
    in the browser, previewed at 24, 40 and 96 px. It is served only while
    it is your current picture and only to people who may see you (a
    stranger, someone you blocked, or a missing file all get the same 404).
    GIF pictures stay still until pointed at, and always under reduced
    motion. **Decorations** around the circle (ring, double ring, dotted,
    arch halo, leaves, stars) in a theme-safe hue, **name styles** (font,
    weight, hue; role colours still win) and two **profile colours** for your
    card, each refused unless dark or light text reads 4.5:1 on it.
  - **Accessibility**: Atkinson Hyperlegible (shipped in `fonts/`, OFL),
    underlined links, contrast (standard, high or match the device), a focus
    ring that always shows, motion (reduced or match the device), and reading new messages aloud with the browser's own voice (off
    unless you turn it on).
  - **Quick switcher** (`Ctrl`/`⌘ K`): houses, rooms, conversations and
    people by fuzzy search, the places you were just in first, and actions
    (mute or mark this place read, mark everything read, themes, presence,
    invisible, set or clear a status, streamer mode). `Ctrl`/`⌘ /` opens the
    keyboard shortcuts sheet.
  - **Notifications**: sounds made with WebAudio, one each for mentions,
    direct messages and other messages, from nine built-in sounds or five
    packs (Snug soft, Bell, Wood, Glass, Minimal), with a volume and a play
    button per row (the older single sound still applies until you pick);
    sounds off per house, message text in notifications on or off,
    **quiet hours** (no sounds, pop-ups or pushes; the server checks them for
    pushes in your time zone), **highlight words** that count as mentions
    (also for pushes), and **@everyone and @here** (from people who may post
    notices) counted as mentions unless you turn that off for a house.
  - **Streamer mode** (`Ctrl`/`⌘ Shift S`, Settings, or View in the desktop app): usernames,
    invitation codes, two-factor secrets and notification text are hidden.
  - **Security**: change your password (every other device signs out; with
    two-factor on it needs a code). **Two-factor sign-in** with TOTP (RFC
    6238, `node:crypto`, one 30-second step of drift either way, a used code
    refused after), set up from a QR code drawn on the device (no network),
    ten single-use backup codes stored hashed, and required at every sign-in
    (the password alone gets a five-minute ticket good for five tries). The
    **devices** list shows each session's browser and system and when it was
    last used; sign one out, or every other one, and their sockets close at once.
  - **Your data**: download everything you wrote as one JSON file (three times
    an hour); **deactivate** (signed out everywhere, shown offline, back when
    you sign in); **delete** with your password, your typed username and a code
    if two-factor is on: you leave every house and friendship, your messages
    stay as "Deleted user", and the only owner of a house with other people in
    it is asked to hand it over first.
  Covered by `npm test` (10 server tests in the "account" block of
  `tests/server.test.js`: settings sync and validation, invisible and
  auto-idle, expiring statuses, notes, profile fields and banner access,
  sessions, TOTP against the RFC 6238 and RFC 4226 vectors with drift and
  replay, two-factor sign-in with tickets and backup codes, export, delete and
  deactivate, quiet hours and highlight words; and 2 rules tests: the QR
  encoder matched module for module against the Python `qrcode` library,
  and the settings rules) and `npm run test:e2e:account` (6 tests in
  separate browsers: theme, compact, text size, clock and font applied and
  carried to a second browser and back live; the quick switcher's fuzzy
  search, recent places, actions and the shortcuts sheet; a custom status,
  invisible and auto-idle as a friend sees them; setting up two-factor from
  the QR code and signing in with a code and a backup code; signing out
  another device; pronouns, a private note and streamer mode). Not tested:
  sounds actually heard and speech actually spoken (headless Chromium), a
  real authenticator app scanning the code (the test reads the key as text),
  quiet hours and highlight words through a real push service, and every
  option on a phone (only Appearance was looked at, at 390px). The desktop
  app has **View > Streamer mode** (`Ctrl`/`⌘ Shift S`), checked by one
  desktop test.
- Text and messages (`server/chat.js`, `js/views/chat.js`, `js/lib/emojis.js`,
  `js/lib/commands.js`, `js/views/viewer.js`):
  - **Every emoji.** The full Unicode set (1,898 emoji, generated once and
    offline into `js/lib/emoji-data.js`, nothing fetched) in nine categories
    with a tab row, search by name then keyword, a skin tone picked once (it
    follows you, and goes on every emoji that takes one, in the picker,
    autocomplete and `:shortcodes:`), and **Frequently used** from your own
    counts. `:wave:` becomes 👋 when sent; unknown names stay as typed.
    Reactions take skin tones, ZWJ families and subdivision flags.
  - **Mentions.** `@` suggests people, the house's mentionable roles (with
    their colour) and, only for people who may post notices, `@everyone` and
    `@here` with how many people each notifies. A non-announcer's `@everyone`
    is stored as such and lights up nobody. `#` suggests rooms you can see and
    sends a room link (`<#id>`) that shows as a pill and opens the room, or
    reads **#unknown room** to someone who can't see it: names come only from
    the reader's own app, never the server.
  - **Message links.** **Copy message link** on any message
    (`https://<snug>/m/<conversation>/<message>`), and **Copy ID** with
    Settings > Text and messages. A link pasted into text shows as a quote card
    (who, where, the first 200 characters, Jump) for people who can read it,
    and is never fetched as a preview. Opening one after signing in lands on
    the message. `msg.peek` answers the same for missing and forbidden.
  - **Attachments.** Each one can be marked as a spoiler and given a
    description (alt text, up to 1,024 characters, through the house word
    filter). Spoilers stay covered, without even loading, until clicked or
    Entered; descriptions are the picture's alt text and open from an
    **ALT** badge. Forwarding keeps both; spoiler GIFs never become
    favourites or "recent". Uploads are typed by their bytes (PNG, JPEG, GIF,
    WebP, MP4, QuickTime, WebM, MP3, Ogg, M4A); anything mislabelled, and
    every SVG, only downloads.
  - **Players.** Videos play inline with their first frame as a poster, our
    own controls (play, a keyboard seek slider, time, mute, volume, full
    screen, picture in picture, download) and 44px targets on a phone. A
    sound file shows its name, length and a seek bar; only recordings are
    "Voice message". Text and code files up to 100 KB show their first ten
    lines, highlighted, with Expand, Copy and Download.
  - **The media viewer.** A dialog that keeps focus and gives it back to the
    thumbnail: `←`/`→` (or a swipe) through the message's pictures and videos
    and then the conversation's, "3 of 8", zoom by click, `+`/`-`, the wheel
    or a pinch, drag to pan, Open original, Download with the file's name,
    the description, and Jump.
  - **Slash commands** with argument chips: `/me`, `/shrug`, `/tableflip`,
    `/unflip`, `/lenny`, `/spoiler`, `/silent`, `/nick`, `/poll q | a | b`
    (opens the poll prefilled), `/giphy q` (opens the GIF picker with the
    words), `/status`, `/open`, `/around`, `/focus`, `/away`, and
    `/roll 2d6` (up to 20 dice of 2 to 1,000 sides): the server rolls with
    `crypto.randomInt` from the spec alone and posts "rolled 2d6: 3 + 5 = 8",
    which can't be edited, under slowmode and timeouts like any message.
    An unknown command says so instead of sending.
  - **Silent messages and reply mentions.** `@silent ` (or `/silent`) sends
    without a sound or a push; it still counts as unread and carries a
    bell-off mark. The reply banner's **@ On/Off** decides whether the
    person replied to is notified (remembered on this device); an `@mention`
    in the text still notifies.
  - **Quick edits.** **Quote** in the message menu; `s/old/new` edits your
    last message; `+:emoji:` reacts to the last one; `//text` sends "/text".
    A counter appears from 3,500 characters, Send turns off past 4,000, and
    pasting more offers **Send as a file** (`message.txt`).
  Tested by `tests/logic-chat.test.js` (10), `tests/server-chat.test.js` (7)
  and `tests/e2e-chat.test.js` (10 tests in two browsers). Not tested: the
  pinch and swipe gestures (no touch in the test browser), full screen and
  picture in picture (headless), and an Ogg or QuickTime video playing.

- **Voice and calls: reconnect, devices, quality, activities, ringing**
  (`server/activities.js`, `server/hub.js`, `js/voice.js`, `js/activities.js`,
  `js/views/activities.js`, `js/lib/netquality.js`, `js/lib/games.js`):
  - **Reconnect.** A connection that drops (anything but a tab closing or
    reloading) keeps its voice place for 20 seconds, shown to others as
    *Reconnecting…* in amber. The browser keeps the microphone, camera and
    screen, joins the same room or call again as soon as the socket is back
    and calls everyone afresh, with mute and deafen as they were. Every
    permission check runs again on the way back (a ban, a timeout or a lost
    "Join voice" refuses it and frees the place at once); only the full-room
    check is skipped for the held place. A one-to-one call is not ended by a
    drop, only by the grace running out.
  - **Devices in the call.** The call's options menu lists microphones,
    speakers and cameras and switches at once. A chosen microphone that is
    unplugged falls back to the default with a toast; a new system default is
    followed when none was chosen; a microphone whose track ends is captured
    again. **You're muted**: talking while muted for about 1.5 seconds shows
    an amber note with Unmute, at most once a minute (a copy of the raw
    microphone is listened to; nothing is sent). Settings > Voice and video >
    Calls turns it off.
  - **Connection quality** from WebRTC's statistics every 2 seconds: round
    trip on the connection in use, packets lost since the last poll, jitter,
    what you send, direct or relayed. Good (under 150 ms and 2%), fair, poor
    (over 400 ms or 8%), in mint, amber and rose bars beside each person and
    in *Voice connected*, which opens everyone's numbers and a hint when your
    own uplink is struggling.
  - **Activities.** A shared whiteboard (five token colours, four pen sizes,
    undo your own last stroke, clear by the starter or a voice moderator,
    export as PNG), tic-tac-toe and Connect Four, in the call's focus slot.
    The server keeps the board, the seats and whose turn it is, refuses
    moves out of turn or into a full column, and sends them only to the people
    in that voice place; it all ends when the place empties. At most 256
    points a stroke and 2,000 strokes; drawing is rate limited (20 at once,
    then 5 a second, and per room).
  - **Voice reactions** float up from your tile (static under reduced
    motion): eight fixed emoji or the house's own, one a second and eight in
    ten seconds.
  - **Ring again** in a group call: a Ring button beside people who declined
    or didn't answer (once every 30 seconds per person).
  - **Ringing settings:** four ringtones with a preview, ring volume, the
    device the ring plays on (where the browser allows), and **who can ring
    me** (everyone, friends, nobody), enforced on the server where every ring
    and its push start; an unrung call still ends as missed after the usual
    ring time.
  - Also: a call clock (mm:ss, then h:mm:ss) in the stage, the floating call
    and the dock; the room permission **Share camera and screen** (on by
    default; refused on the server and turned off mid-call when taken away);
    camera resolution and frame rate, mirror, microphone volume and output
    volume; and short-lived TURN credentials (below).
  Tested by `tests/logic-voice.test.js` (5), `tests/server-voice.test.js`
  (13), `tests/e2e-voice-extra.test.js` (8) and `tests/e2e-activities.test.js`
  (4, in two browsers). Not tested: a real network drop (the tests close the
  socket without a clean goodbye), a real device being unplugged (the track's
  end is simulated), the ring's output device, and TURN through a real relay.

- **Inbox, groups and notifications** (`server/inbox.js`, `server/dms.js`,
  `js/inbox.js`, `js/views/mentions.js`, `js/views/dm-manage.js`):
  - **Unread counts from the server.** `unread.counts` (also in the snapshot,
    and sent with a house's content when you join) counts every conversation
    you may read (private rooms included only if you can see them) since your
    read point, in SQL: how many, how many need you, the first unread message.
    "Needs you" follows the browser's rules: your @username, a mentionable
    role you hold, @everyone/@here from someone who may post notices (unless
    turned off for that house), highlight words, replies to you (not when the
    reply's mention was turned off), threads you follow, direct messages.
    Blocked people, unaccepted message requests and muted places don't count.
    The browser takes the larger of its own count and the server's, so a
    mention older than the 60 messages a device loaded still shows on the
    badge, the tab title and the room.
  - **Catch up > Mentions**: mentions and replies from the last 30 days, read
    or not, each checked against what you may read; filter by house, leave
    out @role or @everyone, **Jump** (loading the history between), and
    **Dismiss** (kept on the server, with undo). J and K move, E dismisses,
    Enter jumps.
  - **Direct conversations and groups**: **Close** (it leaves your list, its
    messages stay, and a new message brings it back), **Pin to top** (up to
    10), and for groups **Rename** (1 to 40 characters), **Change icon** (an
    emoji and one of the eight colours), **Add people** (up to 10 in all; only
    friends or people you share a house with, nobody blocked either way, and
    their message privacy is respected; adding to a one-to-one conversation
    starts a new group) and **Leave group** (you lose its history). The owner
    can remove people from the header's members list; when the owner leaves,
    the longest member takes over. Each change writes a line in the
    conversation.
  - **Timed mutes**: *Mute for…* 15 minutes, 1, 8 or 24 hours, or until you
    turn it back on, from a house's, room's or conversation's menu, which then
    says "Muted until 14:30". The server works out the time and refuses other
    values; an expired mute counts as unset everywhere (badges, push, rings),
    and the server tells your devices when it ends.
  - **Suppress @role mentions** per house (its menu): role mentions there no
    longer count or push.
  - **Presence for a while**: Focused (or any presence) *for* 30 minutes, 1,
    2, 4 or 8 hours or today, from the presence menu, which says "Focused
    until 15:00". The server returns you to Around when it ends and tells
    everyone; Focused stops pushes only until then.
  - **Friends**: a **Blocked** tab with Unblock, a filter box above Online and
    All (Escape clears), and **mutual friends** on a profile (a count that
    opens into their circles; the server answers only for people you may see).
  - **Change your username** (Settings > Profile): the usual rules, your
    password (and two-factor code when on), two changes an hour, and your old
    username held for you for 7 days (your last two old names at most).
  - **Landmarks**: *Skip to messages* is the first Tab stop; F6 and Shift+F6
    move between places, the sidebar, the main view, the side pane and the
    call dock; the main view is the page's one `<main>`.
  Tested by `tests/logic-shell.test.js` (7), `tests/server-shell.test.js`
  (10) and `tests/e2e-shell.test.js` (6, two browsers for groups). Not
  tested: the Catch up *For you* list itself shows only what this device has
  loaded (the old mention shows in Mentions and on the badges). The quick
  switcher also has *Focused for 30 minutes … the rest of today* and
  *Mentions*.

Not built yet, on purpose, because each needs outside infrastructure:

- **Email.** No address verification and no "forgot password". Until then an
  owner of the server resets a password in the database.
- **A TURN relay for voice.** Voice connects directly between people. People
  behind strict company or mobile networks need a relay; set the `SNUG_TURN_*`
  variables below once you run one (coturn is the usual choice). With
  `SNUG_TURN_SECRET` each person gets their own 12-hour credential; the
  credential itself is tested, but only direct connections have been tested,
  never a call through a real relay.
- **More than one server process.** Presence, voice membership and rate
  limits live in memory, so Snug runs as a single process. That is fine for
  communities in the thousands; beyond that it needs a shared message bus.
- **Voice rooms above 12 people.** Audio is a full mesh; larger rooms need a
  media server. The same media server would let more than a few cameras run
  at once.

Built, but not seen end to end from the test machine:

- **Real push delivery.** The server's pushes were decrypted and checked
  against a mock push service, and Chromium's service worker showed them, but
  Google's push service (and so a real Chrome push) could not be reached from
  here; Firefox's and Apple's were not tried. Apple's needs a real
  `SNUG_PUSH_CONTACT`.
- **GIF search against Tenor.** Tested against a local stand-in for its API;
  the real service needs a key and was not reached.
- **Real cameras and screens.** Only Chromium's fake devices and the desktop
  app under Xvfb.

## Putting it online

Voice and notifications need HTTPS (browsers only allow the microphone,
service workers and push on secure pages; `localhost` is the one exception). Run Snug
behind a reverse proxy that terminates TLS and passes WebSocket upgrades on
`/ws`, and set:

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT`, `HOST` | Where to listen | `8787`, `127.0.0.1` |
| `SNUG_DATA` | Folder for the database and uploaded files | `./data` |
| `SNUG_SECURE=1` | Mark the session cookie `Secure` (set this behind HTTPS) | off |
| `SNUG_TRUST_PROXY=1` | Read the client address and scheme from `X-Forwarded-*` | off |
| `SNUG_ORIGINS` | Extra allowed page origins, comma separated | none |
| `SNUG_STUN` | STUN servers for voice | Google's public server |
| `SNUG_TURN_URL`, `SNUG_TURN_USER`, `SNUG_TURN_PASS` | TURN relay for voice | none |
| `SNUG_TURN_SECRET` | Shared secret of the TURN server's REST API (coturn `use-auth-secret`): each person gets their own credential, `<expiry>:<user id>` with a base64 HMAC-SHA1, valid 12 hours and refreshed by the `ice.refresh` op. When set, `SNUG_TURN_USER`/`SNUG_TURN_PASS` are never sent | none |
| `SNUG_PUSH_CONTACT` | Contact the push services see in each VAPID token (`mailto:` or `https:`); Apple's requires a real one | `mailto:snug@example.invalid` |
| `SNUG_DEMO_PASSWORD` | Password for the sample accounts when seeding | `snug-demo-1` |
| `SNUG_GIF_PROVIDER=tenor`, `SNUG_TENOR_KEY` | Turn on GIF search through Tenor (v2 API). Searches and previews go through the server; media is fetched only from Tenor's media hosts, at most 10 MB, GIF, WebP or MP4 by content | off: no Search tab |

Back up the `data` folder; it is the whole state. Change the sample password
before seeding anything that faces the internet, or better, do not seed there.

## Security

- **Passwords**: scrypt with a per-user salt. Sign-in is limited to 10
  attempts per 15 minutes per address and per username, and takes the same
  time whether or not the account exists.
- **Sessions**: a random 256-bit token in an `HttpOnly`, `SameSite=Lax`
  cookie. The database keeps only its hash. Changing a password or signing
  out everywhere ends every session and closes its live connections.
- **Authorization is on the server.** Every action is checked against the
  database: membership for reading, role permissions for acting. The same
  permission rules file (`js/lib/perms.js`) runs in the browser to decide
  what to show and on the server to decide what to allow.
- **Cross-site requests**: WebSocket upgrades and state-changing requests are
  refused unless they come from Snug's own origin.
- **Input**: every field is type- and length-checked. SQL only ever runs as
  prepared statements with bound values.
- **Rendering**: message text becomes a token tree and then elements, never
  HTML. A strict Content-Security-Policy allows scripts only from Snug itself.
- **Uploads**: 10 MB limit, fetched only by people who can read the
  conversation, served with `nosniff` and a sandboxing policy. Anything that
  is not a known image type downloads instead of opening.
  Soundboard sounds must be plain PCM WAV (format, length and size read from
  the file on the server) and are fetched only by members of their house.
- **Rate limits**: per person for messages, typing, search, friend requests
  (10 at once, then one every 10 seconds; at most 50 waiting), discovery and
  general actions; per address for sign-in and registration.
- **Discovery** lists only public houses, as counts and room names without
  member lists, and only people who already share a house or a friend with
  you, never anyone else. Presence shows only for people who share a place
  with you or are your friends. Favourites are visible only to you. Profile
  links must be `https://` addresses.
- **Blocks, privacy and moderation** are checked on the server for every
  action they touch (conversations, calls, rings, friend requests, pushes,
  invitations, sending, reacting, poll votes, voice). One role hierarchy
  (`outranks` and `roleBelow` in `js/lib/safety.js`, counting extra roles)
  decides moderation, role and member changes, nicknames and role order:
  people who aren't owners only reach people and roles below their own.
  One room resolver (`resolveRoom` in `js/lib/places.js`) decides what each
  person can see and do in every room. Reports, blocks, moderation actions, new conversations,
  invitation links and filter changes are rate limited.
- **Voice signalling** is relayed only between people in the same voice
  room or call. Only members of the house can join a voice room; only the
  people in a conversation can start, join, decline or see its call, and
  its ringing and call state go to them alone.

## What makes it different

Three things Snug is meant to be known for, chosen from the weak spots of
existing chat apps:

1. **Catch up instead of badges everywhere.** One view answers "what needs
   me?" first (mentions, replies to you, direct messages, followed threads,
   invitations), then summarises what happened in each room: how many
   messages, from whom, and the one message people reacted to most.
   Each conversation is one item however many messages it holds, so a busy
   group is one line to deal with. It works as a triage list: `J`/`K` to
   move, `E` to mark read, `Enter` to open; on a phone, swipe an item left.
   Marking read can be undone.
   Notification settings are one control per place with three choices:
   *Everything*, *Only what needs me*, *Nothing*. Rooms inherit from their
   house; groups can choose *Only what needs me* too (mentions and replies).
   Mentions and replies to you are counted and highlighted by the same rule;
   direct messages and followed threads are counted without a highlight. The whole policy lives in `js/lib/attention.js`.
2. **Threads with a real place in the layout.** A thread opens in the side
   pane next to the conversation it came from, and an elbow line visibly
   branches it from its message. Threads you follow appear under their room
   in the sidebar while they have news, and replies in them count as
   needing you.
3. **Presence that says what someone is open to.** *Open to talk*, *Around*,
   *Focused* (holds pop-ups, everything waits in Catch up), *Away*, and
   *In a voice room*, which wins because it is the most useful thing to know.
   Each state has its own shape, not only its own colour: a filled dot, a
   ring around a dot, a dot with a bar, a half dot, and an empty ring for
   offline.

Also: the back button and the phone's back gesture close the open room,
pane or dialog one layer at a time instead of leaving the app. A High
contrast setting (which also follows the system's contrast preference)
darkens secondary text and outlines and thickens the focus ring.
Newcomers to a house see three starter rooms and one first step, and
the rest opens after their first message. Saved messages take a note.
Search reads like a sentence (`from:sunniva in:"glaze lab" has:image`) and
the filter chips write those words for you. No promotions anywhere.

## Design system

The idea is *a place with someone in it*. The symbol, the Huddle, is an
arch with two round cut-outs (two presence dots) side by side at its foot:
two people sitting close in one place. It is Brand Violet `#8B5CF6`; the
brand sheet is in `docs/brand/BRAND.md` and the reasons for it are in
`docs/direction/README.md` section 2. All tokens are in `css/tokens.css`. The rules, briefly:

- **Layout.** Four levels, like a communication app rather than a
  dashboard: a 72px rail (Home, Messages, Discover, your communities as
  48px circles, Create or join), a 240px context column for the place you
  are in (Home, Catch up, Mentions, Friends, Messages, Saved, live voice,
  events and recent conversations; your conversations; Discover's sections;
  a community's rooms by category, with everyone in a voice room listed
  under it), the conversation, then people or a thread in a side pane when
  asked for (member list 248px, thread 320 to 400px). A 52px panel at the
  bottom of the column holds your face, status, mute, deafen and settings;
  the voice strip sits above it while you are in a call. Headers are 48px:
  name, topic, then icon buttons (pins, notifications, members, details,
  search). Below 1180px the pane lies over the conversation.
- **Phone.** Its own product, not a squeezed desktop: tabs at the bottom
  (Home, Messages, Discover, Catch up, You), a drawer (rail plus rooms)
  from the left edge in a community, the member list as a bottom sheet,
  one screen at a time pushed from the right, menus and dialogs as bottom
  sheets, long-press for message actions, 44px targets.
- **Messages.** One continuous stream, no cards. A run from one person
  shows the 40px avatar, name (14px, 600, role colour) and time once;
  follow-ups are compact and show their time in the gutter on hover. Runs
  break after 7 minutes, another author, a reply or a system line. Hover
  shows a small toolbar (react, reply, thread, more; edit and delete on your
  own). Reactions are small 24px chips; yours are violet-tinted. One
  composer: + (upload, poll, more), text, GIF, emoji, voice message, and
  Send once there is something to send; drop files anywhere on the
  conversation.
- **Shape.** People and communities are circles, controls are compact
  rectangles: nav and menu rows 4px, buttons and menus 6px, dialogs and
  inputs 8px, large media 12px. Full rounding only for avatars, count
  badges and true pills. Rows are 32px (42px with a second line), buttons
  32px (28 in dense rows, 36 to 40 for a dialog's main action), icon
  buttons 32px.
- **Colour.** Dark is the default, warm paper is the light theme. Depth
  comes from surface steps, not borders or shadows: rail and conversation
  `#0E0F10`, navigation `#141516`, secondary and menus `#1A1C1D`, hover
  `#212324`, selected `#292B2D` (light themes flip so the conversation is
  the brightest). Only floating layers cast a shadow. Violet is used
  sparingly and means *for you*: the one primary button in a view, the 3px
  bar beside the selected place, count badges, the edge of a message that
  mentions you, your own reactions (`#996FF7` with near-black text in dark
  themes, `#763FF4` with white text in light ones, so text on it reaches
  4.5:1). A selected row is a neutral surface, never violet. Unread is
  neutral: bold text and a short white pip. Mint means online, connected or
  speaking, amber idle or happening soon, cyan links, red busy, destructive
  or failed. People, roles and houses choose a hue only; the theme owns
  lightness and chroma. No gradients.
- **Type.** Inter (bundled, OFL) for everything, Atkinson Hyperlegible Mono
  for code. 20px page and dialog titles, 16px section headings, 14px body
  and controls, 13px secondary, 12px metadata, 11px badges. Messages are
  15px (14px in Compact, 16px in Roomy).
- **Icons.** One line set on a 20-unit grid that draws about 1.5px at any
  size: 16px in rows, 18px in menus, 20px for controls, 24px for major
  marks. Text rooms show `#`, voice rooms a speaker.
- **Space.** 4px base. 4 to 8px between messages, 8 to 12px between
  controls, 16px between sections, 24px between major regions. Three
  densities: Compact, Regular, Roomy.
- **Motion.** 100ms for hover, 150ms for buttons and menus, 220ms for
  panels. Position and opacity only. Off when the system asks for reduced
  motion.
- **Cards.** Only for separate objects: attachments, events you can act on,
  Discover's community previews and floating layers. Everything else is a
  row with a hover state.

The full reference is `docs/direction/README.md`.

## How it is built

```
server/
  index.js          HTTP: static files, accounts, uploads, security headers
  hub.js            WebSocket connections, presence, who gets which event, voice rooms
                    and calls (ringing, timeouts, call records)
  ops.js            every action a client can ask for: validate, authorize, write, notify
  model.js          what a person may see, shaped for the client
  auth.js           password hashing, sessions, rate limiters
  db.js             SQLite schema, prepared statements, and the column
                    migrations that bring an older database up to date
  seed.js           loads the sample data as real accounts
  safety.js         blocks, privacy, moderation, reports, the filter, the house log,
                    and the one role hierarchy (M.outranks, M.roleBelow, M.rankOf)
  messaging.js      polls, forwarding, edit history, scheduled messages, stickers
  linkpreview.js    the only outside fetch: link previews behind DNS-resolved SSRF checks
  places.js         the room resolver behind every read and write check, roles,
                    forums, stages, webhooks, rail, welcome, templates, insights
  voiceopts.js      soundboard, voice room limit and bitrate
  account.js        settings sync, status, idle, notes, sessions, two-factor, your data
  appearance.js     profile pictures, decorations, name styles, profile colours, saved
                    themes and the accent (checked for contrast on the server)
  chat.js           silent messages, reply mentions, per-file spoiler and alt text,
                    /roll, message links (msg.peek)
  activities.js     whiteboard, tic-tac-toe and Connect Four in voice, voice reactions,
                    ring again, who can ring you, short-lived TURN credentials
  community.js      categories and room order, house pictures, delete and transfer,
                    events, spam rules, verification, paused invitations, custom links
  inbox.js          unread counts and mentions from the server, timed mutes,
                    presence for a while, @role suppression, username changes
  dms.js            closing, pinning and managing groups (rename, icon, add, leave, remove)
                    (ops.js merges each one in, in that order; M.auditLate() then logs
                    the later modules' changes)
js/
  app.js            root: sign-in or app, desktop or phone, overlays, keyboard map
  store.js          state and every action; updates the screen at once, then tells the server
  server.js         the transport: WebSocket with reconnect, the offline send queue, live events
  voice.js          WebRTC voice for voice rooms and calls: microphone, camera, screen
                    share, peer connections (perfect negotiation), who is speaking
  calls.js          calls in direct messages and groups: start, accept, decline,
                    the WebAudio ringtone, notifications for a ring
  activities.js     the whiteboard and games inside a voice place
  inbox.js          server unread counts merged with the device's, timed mutes, groups
  desktop.js        the desktop app bridge: badge, theme colour, global keys, deep links
  landmarks.js      skip link and F6 order between the parts of the screen
  lib/              pure rules with tests: format, group, attention, search, perms,
                    social (friends, happening now, events, topics), safety
                    (hierarchy, filter), places (resolveRoom), account, highlight, qr,
                    theme and colour (contrast), keys (shortcuts), emojis and
                    emoji-data, commands (slash commands), community, games,
                    netquality, inbox
  ui/               icons, shared pieces (avatar, presence, rich text), overlays
  views/            auth, nav, stream (messages and composer), conversation, catch up,
                    search and quick jump, people, settings (one layer, pages in
                    sections, arranged in settings.js), dialogs, calls, and each
                    feature area's own views (safety, messaging, places, voiceopts, account)
css/                tokens, base components, shell, conversation, other views
tests/              logic, server integration (real sockets), browser end-to-end
```

The browser needs no build step: plain ES modules and Preact with htm,
vendored in `vendor/`. The server has one dependency, `ws`. The database is
SQLite through Node's built-in `node:sqlite`.

**How a message travels.** The composer shows your message at once and gives
it an id. The transport sends it; the server checks you may post, stores it
with the next sequence number, and delivers it to everyone who can read that
conversation, including your other devices. If the connection is down the
message waits on screen and is sent when the connection returns. Because the
id travels with it, a second copy of the same message is ignored, so a
retry can never post twice. Order everywhere is the server's sequence.

**Reconnecting.** The connection retries with growing pauses (1s up to 15s)
and immediately when the network or the tab comes back. Every connect
begins with a full picture from the server, so nothing is missed.

## Keyboard

Settings > Keyboard lists every shortcut you can change: press Record, then
the keys. It says when the browser keeps a combination (`Ctrl W`, `T`, `N`,
`L` and the like), when Snug uses it for something fixed, or when another
shortcut has it, and each can be reset (or all at once). The server checks
every saved combination. Voice shortcuts work while you type, in a call:
`Ctrl/Cmd Shift M` mute, `Ctrl/Cmd Shift D` deafen, `Ctrl/Cmd Shift V`
camera, `Ctrl/Cmd Shift H` leave or hang up, `Ctrl/Cmd Shift Enter` answer
a ringing call; each is announced to screen readers. The defaults:

`Ctrl/Cmd K` jump anywhere or search. `Alt ↑/↓` previous or next place in
the column, `Alt Shift ↓` next place with news, `Alt ←` (`Cmd [` on a Mac)
back. `Shift Tab` from an empty message box
moves into the messages, then `↑/↓` to move, `R` reply, `T` thread, `S`
save, `E` edit, `Enter` all actions. In Catch up, `J`/`K` move and `E`
marks read. `Esc` closes the top layer; with nothing open it marks the open
place read, and `Shift Esc` marks the whole house read. `?` shows the full list.
