# Snug

A calm place for your people. Houses (communities) hold rooms, rooms hold
conversations, and any message can grow a thread. Direct messages, groups,
voice rooms, roles, search, saved messages and a single place to catch up.
Real accounts, a real database, live delivery between people.

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
npm test            # rules (18) and the server with real sockets (36)
npm run test:e2e    # separate people in separate browsers (23), needs Playwright
```

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

**Snug > Change where Snug runs** brings the choice back. To work on the app:

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
- Voice rooms: real audio between people over WebRTC. The server only
  introduces them to each other.
- Offline: the app opens from a copy on the device, what you write waits,
  and it sends once when the connection is back.

Not built yet, on purpose, because each needs outside infrastructure:

- **Email.** No address verification and no "forgot password". Until then an
  owner of the server resets a password in the database.
- **Push notifications when Snug is closed.** Needs a service worker and Web
  Push keys. Today notifications arrive only while a tab is open.
- **A TURN relay for voice.** Voice connects directly between people. People
  behind strict company or mobile networks need a relay; set the `SNUG_TURN_*`
  variables below once you run one (coturn is the usual choice). Only direct
  connections have been tested.
- **More than one server process.** Presence, voice membership and rate
  limits live in memory, so Snug runs as a single process. That is fine for
  communities in the thousands; beyond that it needs a shared message bus.
- **Voice rooms above 12 people.** Audio is a full mesh; larger rooms need a
  media server.

## Putting it online

Voice and desktop notifications need HTTPS (browsers only allow the
microphone on secure pages; `localhost` is the one exception). Run Snug
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
| `SNUG_DEMO_PASSWORD` | Password for the sample accounts when seeding | `snug-demo-1` |

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
- **Rate limits**: per person for messages, typing, search, friend requests
  (10 at once, then one every 10 seconds; at most 50 waiting), discovery and
  general actions; per address for sign-in and registration.
- **Discovery** lists only public houses, as counts and room names without
  member lists, and only people who already share a house or a friend with
  you, never anyone else. Presence shows only for people who share a place
  with you or are your friends. Favourites are visible only to you. Profile
  links must be `https://` addresses.
- **Voice signalling** is relayed only between people in the same voice
  room, and only members of the house can join it.

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

The idea is *a place with someone in it*. The symbol, the Nook, is a
doorway with a person (the presence dot) inside it; the brand sheet is in
`docs/brand/BRAND.md`. All tokens are in `css/tokens.css`. The rules, briefly:

- **Layout.** Three levels, always visible: the rail (Home, Messages,
  Discover, then your communities), the context column for the place you
  are in (Home's Catch up, Friends and Saved; your conversations; Discover's
  sections; a community's rooms and events), then the content. Your own
  panel sits at the bottom of the column. People, details and threads open
  in a side pane only when asked for. Below 1180px the pane lies over the
  conversation instead of squeezing it.
- **Phone.** Its own product, not a squeezed desktop: tabs at the bottom
  (Home, Messages, Discover, Catch up, You), communities reached from Home
  and Discover, one screen at a time pushed from the right, menus and
  dialogs as bottom sheets, long-press for message actions, 44px targets.
- **Shape.** Places are arches, people are circles, controls are
  rectangles. Buttons and inputs 6px, menus 8px, dialogs 12px.
- **Colour.** Dark is the default, warm paper is the light theme; depth
  comes from five surface steps, and only floating layers cast the single
  shadow. Coral is the brand and means *for you*: the main button, the
  selected place's bar, count badges, the New line, mentions. Mint means
  online or connected, amber idle or happening soon, cyan links, rose your
  own reactions, red destructive or failed. People, roles and houses choose
  a hue only; the theme owns lightness and chroma, and the offered hues stay
  clear of the semantic ones. No gradients.
- **Type.** Inter (bundled, OFL) for everything, Atkinson Hyperlegible Mono
  for code. Weights 400 reading, 500 names, 600 emphasis. Messages are
  16px (14px in Compact) with a line cap.
- **Space.** 4px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80. Three
  densities: Compact, Regular, Roomy.
- **Motion.** 100ms for hover and press, 160 to 240ms for things that
  enter. Position and opacity only. Off when the system asks for reduced
  motion.
- **Cards.** Only for things that are separate objects: attachments, events
  you can act on, community previews and floating layers. Lists are rows.

## How it is built

```
server/
  index.js          HTTP: static files, accounts, uploads, security headers
  hub.js            WebSocket connections, presence, who gets which event, voice rooms
  ops.js            every action a client can ask for: validate, authorize, write, notify
  model.js          what a person may see, shaped for the client
  auth.js           password hashing, sessions, rate limiters
  db.js             SQLite schema, prepared statements, and the column
                    migrations that bring an older database up to date
  seed.js           loads the sample data as real accounts
js/
  app.js            root: sign-in or app, desktop or phone, overlays, keyboard map
  store.js          state and every action; updates the screen at once, then tells the server
  server.js         the transport: WebSocket with reconnect, the offline send queue, live events
  voice.js          WebRTC voice: microphone, peer connections, who is speaking
  lib/              pure rules with tests: format, group, attention, search, perms,
                    social (friends, happening now, events, topics)
  ui/               icons, shared pieces (avatar, presence, rich text), overlays
  views/            auth, nav, stream (messages and composer), conversation, catch up,
                    search and quick jump, people, settings, dialogs
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

`Ctrl/Cmd K` jump anywhere or search. `Alt ↑/↓` previous or next place in
the column, `Alt Shift ↓` next place with news, `Alt ←` (`Cmd [` on a Mac)
back. `Shift Tab` from an empty message box
moves into the messages, then `↑/↓` to move, `R` reply, `T` thread, `S`
save, `E` edit, `Enter` all actions. In Catch up, `J`/`K` move and `E`
marks read. `Esc` closes the top layer; with nothing open it marks the open
place read, and `Shift Esc` marks the whole house read. `?` shows the full list.
