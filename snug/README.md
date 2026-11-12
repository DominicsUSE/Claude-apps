# Snug

A calm place for your people. Houses (communities) hold rooms, rooms hold
conversations, and any message can grow a thread. Direct messages, groups,
voice rooms, roles, search, saved messages and a single place to catch up.

![Snug on desktop: a room with a thread open beside it](docs/preview.png)

## Run it

No build step and no dependencies. Serve the folder and open it:

```bash
cd snug && python3 -m http.server 8765
```

Then open http://localhost:8765. Everything you change is kept in this
browser. **Settings > Connection > Start over** puts the sample data back.

Tests:

```bash
npm test            # rules: parsing, grouping, unread, search, permissions
npm run test:e2e    # drives the real app in Chromium (needs Playwright)
```

## What makes it different

Three things Snug is meant to be known for, chosen from the weak spots of
existing chat apps:

1. **Catch up instead of badges everywhere.** One view answers "what needs
   me?" first (mentions, replies to you, direct messages, followed threads,
   invitations), then summarises what happened in each room: how many
   messages, from whom, and the one message people reacted to most.
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

Also: newcomers to a house see three starter rooms and one first step, and
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

Plain ES modules, Preact with htm (vendored in `vendor/`, no build), one
state object.

```
js/
  app.js            root, desktop vs phone, overlays, keyboard map
  store.js          state, persistence and every action that changes state
  server.js         the transport: sending, queueing, failures, other people
  seed.js           sample houses, people and conversations
  lib/              pure rules with tests: format, group, attention, search, perms
  ui/               icons, shared pieces (avatar, presence, rich text), overlays
  views/            nav, stream (messages and composer), conversation, catch up,
                    search and quick jump, people, settings, dialogs
css/                tokens, base components, shell, conversation, other views
```

There is no backend yet. `js/server.js` is the only module that would talk
to one: it fakes latency, delivery, failures and the other people in the
sample houses. Replace it with a WebSocket client that keeps the same
exports and the rest of the app does not change.

## Keyboard

`Ctrl/Cmd K` jump anywhere or search. `Alt ↑/↓` previous or next place,
`Alt Shift ↓` next place with news. `Shift Tab` from an empty message box
moves into the messages, then `↑/↓` to move, `R` reply, `T` thread, `S`
save, `E` edit, `Enter` all actions. `Esc` closes the top layer. `?` shows
the full list.
