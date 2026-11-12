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
with the password `snug-demo-1`. Open a second browser profile or a private
window and sign in as someone else to talk to yourself. `npm run seed --
--force` wipes the database and loads the sample data again.

Tests:

```bash
npm test            # rules (10) and the server with real sockets (21)
npm run test:e2e    # separate people in separate browsers (17), needs Playwright
```

## What is real, and what is not yet

Real, and covered by tests with separate users:

- Accounts, sign-in, sign-out, sign out everywhere, password change.
- Houses, rooms, roles and permissions, invitations by link and by username,
  member removal, newcomer onboarding.
- Messages, replies, threads, edits, deletes with undo, reactions, file and
  picture uploads. All stored in the database and delivered live.
- Direct messages and groups.
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
- **Rate limits**: per person for messages, typing, search and general
  actions; per address for sign-in and registration.
- **Voice signalling** is relayed only between people in the same voice
  room, and only members of the house can join it.

## What makes it different

Three things Snug is meant to be known for, chosen from the weak spots of
existing chat apps:

1. **Catch up instead of badges everywhere.** One view answers "what needs
   me?" first (mentions, replies to you, direct messages, followed threads,
   invitations), then summarises what happened in each room: how many
   messages, from whom, and the one message people reacted to most.
   It works as a triage list: `J`/`K` to move, `E` when done, `Enter` to
   open; on a phone, swipe an item left. Done items can be undone.
   Notification settings are one control per place with three choices:
   *Everything*, *Only what needs me*, *Nothing*. Rooms inherit from their
   house. The whole policy lives in `js/lib/attention.js`.
2. **Threads with a real place in the layout.** A thread opens in the side
   pane next to the conversation it came from, and an elbow line visibly
   branches it from its message. Threads you follow appear under their room
   in the sidebar while they have news, and replies in them count as
   needing you.
3. **Presence that says what someone is open to.** *Open to talk*, *Around*,
   *Focused* (holds pop-ups, everything waits in Catch up), *Away*, and
   *In a voice room*, which wins because it is the most useful thing to know.
   Each state has its own shape, not only its own colour.

Also: the back button and the phone's back gesture close the open room,
pane or dialog one layer at a time instead of leaving the app. A High
contrast setting (which also follows the system's contrast preference)
darkens secondary text and outlines and thickens the focus ring.
Newcomers to a house see three starter rooms and one first step, and
the rest opens after their first message. Saved messages take a note.
Search reads like a sentence (`from:sunniva in:"glaze lab" has:image`) and
the filter chips write those words for you. No promotions anywhere.

## Design system

All tokens are in `css/tokens.css`. The rules, briefly:

- **Layout.** One navigation column reads big to small from top to bottom:
  you, Catch up and Saved, direct conversations, then each house with its
  rooms. The conversation is the widest and lightest surface. People,
  details and threads appear in a context pane only when asked for. Below
  1180px the pane lies over the conversation instead of squeezing it.
- **Phone.** Its own product, not a squeezed desktop: tabs at the bottom
  (Catch up, Houses, Direct, You), one screen at a time pushed from the
  right, menus and dialogs as bottom sheets, long-press for message actions,
  44px targets.
- **Colour.** One green-grey hue for every neutral; depth comes from shade
  steps, never shadows. Only floating layers cast the single shadow. Amber is
  a highlighter: always a fill behind ink, never text, and it means one
  thing, *this is addressed to you*. Green means live or open to talk. Red
  means destructive or failed. The main button is ink, not a brand colour.
  People, roles and houses choose a hue only; the theme owns lightness and
  chroma, so every chosen colour stays readable in light and dark.
- **Type.** Atkinson Hyperlegible Next (bundled, OFL) for everything,
  Atkinson Hyperlegible Mono for code. Five sizes (12, 14, 16, 20, 24) and
  three weights (400 reading, 500 names and selection, 700 headings).
  Messages are 16px with a 46rem line cap.
- **Space.** 4px base: 4, 8, 12, 16, 24, 32, 48. Tight inside a message
  group, 16px between groups. Three densities: Snug, Regular, Roomy.
- **Radius.** 4px for controls, 8px for panels, media and floating layers,
  round for people. Houses are square, people are round.
- **Motion.** 120ms for hover and press, 180ms for things that enter.
  Position and opacity only. Off when the system asks for reduced motion.
- **Cards.** Only for things that are separate objects: attachments and
  floating layers. Never in the conversation or the sidebar.

## How it is built

```
server/
  index.js          HTTP: static files, accounts, uploads, security headers
  hub.js            WebSocket connections, presence, who gets which event, voice rooms
  ops.js            every action a client can ask for: validate, authorize, write, notify
  model.js          what a person may see, shaped for the client
  auth.js           password hashing, sessions, rate limiters
  db.js             SQLite schema and prepared statements
  seed.js           loads the sample data as real accounts
js/
  app.js            root: sign-in or app, desktop or phone, overlays, keyboard map
  store.js          state and every action; updates the screen at once, then tells the server
  server.js         the transport: WebSocket with reconnect, the offline send queue, live events
  voice.js          WebRTC voice: microphone, peer connections, who is speaking
  lib/              pure rules with tests: format, group, attention, search, perms
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

`Ctrl/Cmd K` jump anywhere or search. `Alt ↑/↓` previous or next place,
`Alt Shift ↓` next place with news. `Shift Tab` from an empty message box
moves into the messages, then `↑/↓` to move, `R` reply, `T` thread, `S`
save, `E` edit, `Enter` all actions. In Catch up, `J`/`K` move and `E`
marks done. `Esc` closes the top layer. `?` shows the full list.
