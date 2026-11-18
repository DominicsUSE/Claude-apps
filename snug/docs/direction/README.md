# Snug 0.7: design direction

This document describes the interface as it is in the code: the tokens in `css/tokens.css`, the shared classes in `css/base.css` and `css/shell.css`, the components in `js/ui/`, the views in `js/views/` and the rules in `js/lib/`. Where it and the code disagree, the code wins.

The 0.7 redesign changed the interface from a set of well-made components into a communication environment. Opening Snug should answer at once: where my conversations are, who is online, what is happening, where I can go and what I can do now. The interaction model borrows the practical habits of mature chat apps (density, a rail of community circles, a channel column, grouped messages, a hover toolbar, a member list, voice rooms that show who is inside) and keeps Snug's own identity: the Huddle, one violet used sparingly, warm charcoal and paper.

Screenshots come from a seeded server at 1440x900 (desktop) and 390x844 (phone).

## 1. Brand concept

**A place with someone in it.**

Most chat apps open on an empty channel list, a feed, or a server you have to pick. None of them tell you whether anyone is around. Snug opens on people: Home leads with who is around and where people are talking, every room shows who is in its voice rooms, and the member list says what each person is doing. Discover's heading is "Places with people in them."

The brand speaks quietly. The sign-in page is one centred form with the lockup at 24px and one line, "Your people are here." After it the brand is the Huddle on the Home button, a thin violet bar beside the place you are in, a few badges and the primary button.

- **It answers the question people open a chat app with.** "Is anyone here?" comes before "what did I miss?".
- **The mark is part of the interface.** The two cut-outs in the Huddle are the same circle as the presence dot on every avatar.
- **Warmth without a mascot.** One violet on warm charcoal and paper, rounded letterforms and short copy ("3 people talking", not "3 active users"). No character, no confetti, no gradient.

## 2. Logo

The symbol is the **Huddle**: an arch with two round cut-outs side by side at its foot, one a little larger. Two people sitting close in one place, or a pair of eyes looking out. In code it keeps its old name, `Nook`, in `js/ui/brand.js`. `docs/brand/BRAND.md` is the short brand sheet. The logo did not change in the 0.7 redesign.

![The lockup on the dark ground: violet Huddle and off-white wordmark](img/brand-lockup-dark.jpg)

![The lockup on the light ground: violet Huddle and near-black wordmark](img/brand-lockup-light.jpg)

| Part | Geometry (64-unit grid, `brand/nook.svg`) |
|---|---|
| Arch | 48 wide by 54 tall (x 8 to 56, y 6 to 60). A half-circle top (r 24), straight sides, a foot radius of 4 on both bottom corners. |
| Cut-outs | Circle r 8 at (23, 46) and circle r 6 at (41, 48): bottoms level, 6 units above the ground, 4 units apart. |
| Fill | One solid shape in Brand Violet `#8B5CF6` (`fill-rule="evenodd"`); the cut-outs show the ground. |

**Wordmark:** "snug", lowercase, Inter Bold, tracking -0.03em, outlined to paths; `currentColor` inside the app.

![App icon at 512px: charcoal rounded square, the violet Huddle](img/brand-app-icon-512.jpg)

**App icon:** a charcoal `#141516` rounded square (radius 22.5%) with the Huddle at 58% of its height. **Small sizes are redrawn, not scaled:** `brand/favicon.svg` and `brand/app-icon-small.svg` are drawn on the 16px grid, and `Nook` switches to that drawing at 24px and below.

![The favicon at a true 16px, enlarged 8x](img/brand-favicon-16-8x.jpg)

**Rules:** no stretching, rotating, effects or shadows. The cut-outs never move or fill in, except in the loading mark, where they open one after the other. The arch is never mint, amber, cyan, rose or red. The wordmark is never violet. The Huddle is never used for a person or a control, with one exception: the Home button in the rail.

## 3. Principles

1. **A communication environment, not a dashboard.** Four fixed levels (rail, context column, conversation, people or thread), lists of rows, one stream of messages. No dashboard grids, no card collections.
2. **Dense and calm.** Compact rows (32px), compact buttons (32px), tight message grouping, small metadata. "Clean" is not empty space: no 64 to 100px padding, no 32 to 48px headings.
3. **Depth from surfaces, not decoration.** Five surface steps carry hierarchy. Borders are rare, shadows only on floating layers, no gradients, no glass, no blobs.
4. **About 90% neutral, 10% colour.** Violet marks what is for you. Mint, amber and red carry presence and state. Everything else is warm grey.
5. **Icons for secondary actions.** Search, notifications, members, reply, edit, pin, mute are 32px icon buttons with an `aria-label` and a tooltip, not labelled buttons. One primary button per view at most.
6. **Social context everywhere.** Presence, activity ("In Lounge", "reading the forecast", "Last active 3 h ago"), who is in a voice room, who is talking.

The QA questions behind every screen: does it look like a dashboard, too many cards, too many pills, too much empty space, every button a call to action, everything rounded, everything violet, everything bordered, messages as cards? Does it feel like people communicate here?

## 4. Colour

Dark is the base theme. The Theme setting starts on Match device. Light, Paper and Sepia are warm paper themes; Midnight, Ash, Slate, Moss and Contrast dark are dark presets; people can also build their own (`js/lib/theme.js`). Components use role tokens only, never hex.

### Surfaces

| Role token | Dark | Light themes | Used for |
|---|---|---|---|
| `--surface-rail` | `#0E0F10` (bg-0) | bg-0 | The rail and the window |
| `--surface-chat` | `#0E0F10` (bg-0) | bg-1, the brightest | The conversation and the main content of every view |
| `--surface-chat-hover` | bg-1 | bg-2 | A message under the pointer |
| `--surface-nav` | `#141516` (bg-1) | bg-2 | Context column, your panel, people and thread panes |
| `--surface-2` | `#1A1C1D` (bg-2) | bg-2 | Composer, attachments, code, secondary blocks |
| `--surface-float` | `#1A1C1D` (bg-2) | bg-1 | Menus, popovers, dialogs |
| `--surface-input` | bg-2 | bg-1 | Text fields |
| `--surface-hover` | `#212324` (bg-3) | bg-3 | Hover on rows and controls |
| `--surface-sel` | `#292B2D` (bg-4) | bg-4 | Selected row, pressed, icon-button hover |

Every container that holds avatars also sets `--bg` to its own surface, because the presence dot and the speaking ring cut out in it.

Text: `--text-1` `#F4F1ED` (main), `--text-2` `#B8B4AE` (secondary, icons), `--text-3` `#96938E` (metadata; 4.5:1 on every dark surface; `#66615C` in light), `--text-disabled`. Lines (`--line-subtle`, `--line`, `--line-strong`) are used sparingly: the header's bottom edge, a field, a divider before a destructive menu item.

### Violet, in named roles

`--violet` `#8B5CF6` is the mark: the logo and thin indicators. Fills use `--brand`/`--accent`: `#996FF7` with near-black text in dark themes and `#763FF4` with white text in light ones, because white on `#8B5CF6` is only 4.23:1. Views use the roles, not the brand token:

- `--indicator`: the 3px bar beside the selected row, rail item or tab.
- `--attention`: count badges and mention pills (things that need you).
- `--mention-bg` and `--mention-edge`: a message that mentions you (a 9% tint and a 2px edge).
- `--rx-mine-bg` and `--rx-mine-edge`: your own reactions (other reactions sit on `--rx-bg`).
- The one primary button in a view.

A selected row is never violet: it is `--surface-sel` plus the indicator. Unread is neutral (`--unread`, the main text colour): bold text and a short pip at the column edge. The "New" line is rose with an uppercase NEW tag.

### Meaning colours

| Token | Dark | Meaning |
|---|---|---|
| `--online` / `--mint` | `#58C7A5` | Online, connected, speaking, "Going", camera or screen on |
| `--idle` / `--amber` | `#E8B65A` | Away, warnings, an event starting soon, a weak connection |
| `--busy` / `--error` | `#E05A5A` | Focused, destructive actions, failures, mic muted and deafened |
| `--offline` | `#686663` | The offline ring |
| `--cyan` | `#62B8D8` | Links, the "6 replies" link |

Light themes add `-ink` values (for example `--mint-ink`) for text, because the fill values are too light to read on paper. "In Lounge" uses mint-ink.

**Colours people choose.** People, roles and houses choose a hue only (`HUES` in `js/lib/util.js`); the theme owns lightness and chroma in OKLCH, so every name stays readable in every theme and no person reads as a status or as the brand.

**High contrast** (a setting that also follows `prefers-contrast: more`) mixes secondary text and lines toward the main text and thickens the focus ring to 3px.

## 5. Type

**Inter** for everything (bundled variable font, `cv11`, `cv05`, `ss03` on), **Atkinson Hyperlegible Mono** for code.

| Role | Size | Used for |
|---|---|---|
| `--t-heading` | 20px | Page and dialog titles (`h1`), the Home greeting, profile and house names |
| `--t-section` | 16px | Section headings (`h2`), the header title |
| `--t-msg` | 15px | Message text (14 in Compact density, 16 in Roomy) |
| `--t-body` / `--t-name` | 14px | Body, rows, controls, menus; author names at 600 |
| `--t-ui` | 13px | Secondary UI: topics, hints, chips, previews |
| `--t-meta` | 12px | Times, counts, uppercase section labels ("ONLINE — 5") |
| `--t-micro` | 11px | Badges, the hover time in the gutter |

`--t-24` and `--t-32` remain only for emoji-only messages and game glyphs. Sizes are rem, so the Text size setting scales them. Weights: 400 reading, 500 rows and names, 600 emphasis and unread.

## 6. Icons

One line set in `js/ui/icons.js` on a 20-unit grid. The stroke is compensated so it draws about 1.5px at any size. Sizes: **16px** in rows and inline, **18px** in menus and compact buttons, **20px** for controls, **24px** for major marks and empty states; 12 and 14px only inside metadata text. Text rooms show `#`, voice rooms a speaker (`KIND_ICON` in `js/ui/kit.js`), notices a megaphone. Presence is drawn in CSS, not with icons.

## 7. Shape and size

**People and communities are circles, controls are compact rectangles.**

| Radius | Value | Used for |
|---|---|---|
| `--r-row` | 4px | Nav, menu and list rows, tags, the name chip on a voice tile |
| `--r-btn` | 6px | Buttons, icon buttons, chips, segmented controls |
| `--r-menu` | 6px | Menus, popovers, tooltips, toasts |
| `--r-modal` / `--r-input` | 8px | Dialogs, text fields, the composer, voice tiles, the few real cards |
| `--r-media` | 12px | Images, video, a focused screen share |
| `--r-full` | 9999px | Avatars, count badges, switches; nothing else |
| `--r-tile` | 50% | Houses (the rail, Discover, the house page) |

| Height | Value | Used for |
|---|---|---|
| Row | 32px | Context column, menus, settings categories, autocomplete |
| Two-line row | 42px | Direct messages, the member list, Home's Online now |
| Rich row | 52px | Friends, search results |
| Header | 48px | Every view's top bar |
| User panel | 52px | The bottom of the context column |
| `.btn` | 32px | Default button; `.sm` 28 (dense rows), `.md` 36 (dialog actions), `.lg` 40 |
| `.ib` | 32px | Icon buttons; `.compact` 28, `.sm` 24 |
| `.field` | 36px | Text fields and selects |
| Touch | 44px | Every target under 760px and on coarse pointers |

Avatars: 40px in the stream, 32px in two-line rows, 24px in rows, 20px for voice participants, 16px in reply lines. Presence grows with the avatar and has a ring cut out in `--bg`.

## 8. Space and density

4px base: `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-6` 24 (20, 32, 40, 48 exist for gutters and scroll ends). Roles: `--gap-msg` 4px between messages, `--gap-ctl` 8px between controls, `--gap-sect` 16px between sections, `--gap-major` 24px between major regions.

One gutter runs through the app: rows sit 8px from the column edge with 8px inner padding, so icons, avatars and section labels line up 16px in, in the context column, the stream, the member list and the thread. Pages (Home, Friends, events, house, profile, Discover) pad 24px; stream-like lists (search, Catch up) use the stream's 16px.

Density is three token sets: Compact (32px avatars, 14px text), Regular (40px, 15px) and Roomy (40px, 16px, wider gaps). Message display can also be Compact (name and time inline, optional small avatars).

## 9. Layout

![A room: rail, context column with voice participants, the stream, the member list](img/desk-dark-room.jpg)

| Region | Width | Surface | Holds |
|---|---|---|---|
| Rail | 72px | `--surface-rail` | Home (the Huddle), Messages, Discover, your communities as 48px circles, folders, Create or join |
| Context column | 240px (resizable) | `--surface-nav` | What is in the chosen place, the voice strip, your 52px panel |
| Conversation | Fluid | `--surface-chat` | The view, under a 48px header |
| Pane | 248px (members), 320 to 400px (thread, details) | `--surface-nav` | People, a thread, details or pins, only when asked for |

Below 1180px the pane lies over the conversation instead of squeezing it. Below 760px the phone product takes over (section 13).

## 10. Navigation

**The rail.** Home is the Huddle on a neutral circle. Messages (with a count of direct messages that need you) and Discover are neutral circles; Create or join is a mint plus. Communities are circles in your order, in folders if you like. The left edge says what each is to you: a 40px indicator bar where you are, an 8px pip where something is new, 20px on hover, and a violet count badge cut out of the rail when something needs you.

**The context column**, per place:

- **Home:** Home, Catch up, Mentions, Friends, Messages, Saved; then VOICE (live rooms and who is in them), EVENTS (the next three) and RECENT conversations.
- **Messages:** direct messages and groups as 42px two-line rows: face with presence, name, then what they are doing ("In Lounge", a status, "Last active 3 h ago", "In a call now" or "4 members").
- **Discover:** For you, Communities, People, Events, then topics.
- **A house:** a 48px header button (name, "8 members · 5 online", the house menu), About, Events, then rooms by category with uppercase 11px labels, collapsible and draggable. Voice rooms show a count and list everyone inside as `.vroom-person` lines (20px face, thin mint speaking ring, mic-off, deafened, camera and screen marks). Followed threads with news appear under their room.

**Rows** have three states: transparent with muted text; hover `--surface-hover` with brighter text; selected `--surface-sel` with main text and the 3px indicator. Unread adds bold text and a pip; a count badge appears only for what needs you.

**Your panel** (52px): face with presence, name, status, then Mute microphone, Deafen and Settings icon buttons. Mute and deafen act on the call, or are remembered for the next one. While you are in a voice room or call, a strip above the panel reads "Voice connected" (room, house, timer, faces, leave).

**Headers** (48px): icon, name, topic (shrinks first), then icon buttons: call (direct messages), pins, notifications (the bell opens the notification-level menu), go to a date, members (`People, N here`, remembered per device), details, and a field-shaped "Search #room" that collapses to an icon when space is short.

**Movement.** Choosing the current place goes to its front page; choosing another reopens where you were. `Ctrl/Cmd K` jumps anywhere. `Alt Up/Down` moves through the column, `Alt Shift Down` goes to the next place with news, `Alt Left` goes back. Back closes the top layer, one at a time.

## 11. Components

The class names are the system; views compose them instead of restyling.

- **Buttons** `.btn` (secondary, neutral surface), `.btn.primary` (violet, one per view), `.btn.quiet`/`.ghost`, `.btn.danger`, `.btn.danger.solid` (confirming a destructive action), `.btn.on`/`[aria-pressed]`, `[aria-busy=true]` shows a spinner.
- **Icon buttons** `.ib`: hover `--surface-sel`, icon `--text-2` to `--text-1`; `.ib.on`, `.ib.alert` (muted mic, deafened), `.ib.danger`. `IconButton` in `js/ui/kit.js` always sets the `aria-label` and the tooltip.
- **Fields** `.field` (36px, radius 8, `--surface-input`), `.field.bad`/`[aria-invalid]`, `.label`, `.hint`, `.err`. Focus is an accent border and ring.
- **Controls** `.seg` (wraps), `.switch` (accent-tint track, accent knob), `.chip` (6px rectangle; selected is `--surface-sel`, never violet).
- **Counts and tags** `.badge` (violet pill), `.badge.quiet`, `.dot`, `.tag` (4px).
- **Menus** `.menu.float`: `--surface-float`, radius 6, padding 6, 32px rows with radius 4, 18px icons, a quick-reaction row, and a separator added automatically before the first destructive item.
- **Dialogs** `.modal.float`: radius 8, padding 24, a 20px title, actions right-aligned at 36px; bottom sheets on a phone. Used only when a task needs focus.
- **Tooltips** on anything with `data-tip`, after 350ms; the rail's sit to the right.
- **Toasts** `.toast`, `.toast.ok`, `.toast.bad`; undo where an action can be undone.
- **States** `.empty` (24px icon, a 16px heading, one sentence, one action; `.empty.inline` in lists), `.skel` skeletons in the shape of what is coming, `.spinner`, `.notice.info|warn|bad|ok`.

Every interactive element has rest, hover, focus-visible (one 2px ring in the text colour), pressed (a 1px move or a surface step), selected, disabled, loading and error states.

## 12. Screens

### Conversation

![A room with the hover toolbar on a message, reactions and the composer](img/desk-dark-thread.jpg)

**One continuous stream, no cards.** A run starts with a 40px avatar, the name (14/600 in its role colour) and the time (12px); follow-ups are compact and reveal their time in the gutter on hover. Rows are 4px 16px at the start of a run and 2px within it; runs are about 16px apart. A run breaks after 7 minutes, another author, a reply or a system line. Hover is `--surface-chat-hover`; a message that mentions you has the mention tint and edge; the message you are replying to stays marked.

**Hover toolbar:** Add a reaction, Reply, Thread, More actions; your own messages add Edit and Delete. Holding Shift also shows Save. Everything else is in the menu (right-click or More).

**Reactions** are 24px chips with radius 6 (`👍 4  ❤️ 2`); yours are violet-tinted. **Replies** show a thin spine and a 20px line above the message. **Threads** open in the pane; the stub under the message is 28px. **System lines** (calls, joins, pins, group changes) are one compact pattern with the icon in the avatar gutter. **Dividers:** a thin date line with a 12px label; the rose NEW line.

**The composer** is one bar on `--surface-2`: + (Upload a file, polls, stickers, scheduling), the text, GIF, emoji, voice message, and Send once there is something to send (Enter still sends). Reply, edit and long-paste bars attach to its top; "You're viewing older messages · Jump to present" attaches there too. Typing shows in a 24px line underneath. Drop files anywhere on the conversation.

### Member list

"ONLINE — 5", "OFFLINE — 2" and role groups as uppercase section labels; 42px rows with a 32px face and presence, the name in its role colour, and a second line saying what they are doing: "In Lounge" in mint, their status, or "Last active …". Offline rows are dimmed by colour, not opacity.

### Voice and calls

![A voice room: tiles for each person, the control bar, participants listed in the column](img/desk-dark-voice.jpg)

Voice rooms feel like rooms: who is inside is listed under the room in the column, with a count and a Join button on hover. Inside, each person is a 16:9 tile on `--surface-2` (radius 8) with the face in the middle and a name chip bottom-left that carries mic-off or deafened marks and the connection bars. Speaking is a 2px inset ring in the online colour, no glow. Tiles shrink as the room fills; with an activity or a screen share they become a strip under the large tile.

The control bar is 40px icon buttons in three groups (camera, screen, activities, react, soundboard | mic, deafen | settings, leave). Muted and deafened use the soft red tint, camera and screen on use mint, and Leave is a solid red 56x40 button with the phone-off icon. Direct and group calls use the same stage; people being rung show as dimmed tiles with "Ringing…". The incoming call is a compact 360x160 card: face, name, Decline, Accept and accept with video.

### Home

![Home: greeting, Live in voice, Conversations going, Coming up; Online now and Your communities on the right](img/desk-dark-home.jpg)

Home answers who is around, where people are talking, what is about to happen and whether anything needs you. A 20px greeting and a one-line summary, then Live in voice, Conversations going (two-line rows: room, house, "6 people talking", the latest line, a "4 new" count, faces) and Coming up. The right column has Online now (42px rows with what each person is doing), Your communities and Recommended. Section labels are 12px caps with a count, no boxes. Home ends: at most six conversations and three events.

### Friends

![Friends: tabs in the header, ONLINE and RECENTLY ACTIVE sections of rows](img/desk-dark-friends.jpg)

A social list, not a card grid. On desktop the tabs (Online, All, Pending, Blocked) and a small violet Add friend sit in the header. All is split into Favourites, ONLINE and OFFLINE. Rows are 52px: face with presence, name, the activity or "last wrote …", houses in common; hover shows Message, Call or Join (when they are in voice) and More.

### Direct messages

The same stream and composer as rooms. The header adds voice and video call buttons and Add people. Groups have an icon and a name; group changes are system lines.

### Discover

![Discover: topics in the column, communities as rows with live counts](img/desk-dark-discover.jpg)

Cards are allowed here and only here (with events): a calmer featured card, community rows with "3 members · 2 online · 1 person talking" in mint, topics in the column, events and people you might know through a shared house. The search field is a 40px field.

### Search and Quick jump

![Search for "pub": filter chips, 6 messages newest first](img/desk-dark-search.jpg)

**Search** reads like a sentence (`from:maya in:general has:image`); the 28px chips write those words for you. A "People and places" block (people, rooms, communities, groups) sits above "N MESSAGES, NEWEST FIRST"; matches are bold with a violet underline. **Quick jump** (`Ctrl/Cmd K`) groups results under People, Conversations, Rooms, Communities, Actions and Messages; the best match stays first and selected.

### Catch up and Mentions

![Catch up: For you items, then room summaries](img/desk-dark-catchup.jpg)

One view answers "what needs me?" first (mentions, replies to you, direct messages, followed threads, invitations), one item per conversation, then summarises each room: how many messages, from whom, and the one people reacted to most. It is a triage list: `J`/`K` move, `E` marks read, `Enter` opens; on a phone, swipe left; marking read can be undone. The tabs (For you, Mentions) sit in the header. The policy is one file, `js/lib/attention.js`: what needs you gets a violet count, everything else a pip, never a number. One notification setting per place: Everything, Only what needs me, or Nothing.

### Profiles

The profile card is 300px: a 56px banner strip, a 56px face, the name at 16px, status, about, roles as 4px tags, houses in common, a private note, then Message and Profile. The person page has a 120px banner, a 20px name and small-caps section labels.

### House page and events

![A house's About page: header band, Happening now, Upcoming events, members](img/desk-dark-house.jpg)

A short header band (80px house circle, name, description, live counts in mint, Invite people and Settings), then Happening now, upcoming events (flat date block, Going in mint) and the busiest rooms, with house rules and members on the right.

### Settings

![Settings on Appearance: compact category list, live preview, theme presets](img/desk-dark-settings-appearance.jpg)

A full layer with its own column: compact 32px categories with 12px caps group labels and a 28px "Find a setting" field, and a page column up to 720px. Rows are a label (14px) and hint (13px) on the left and the control on the right, at least 52px, with no cards. Changes apply at once; the newcomer welcome, which needs a draft, has a sticky save bar with Undo changes. House settings use the same layout.

### Sign-in

![Sign-in: one centred form with the lockup](img/desk-dark-signin.jpg)

One centred 420px panel (radius 8, padding 32) with the lockup at 24px, a 20px heading and a one-line subtitle; on a phone a plain top-aligned page. Errors sit under the field they are about.

## 13. Phone

![Phone room: header with Back, drawer, title, people and more](img/phone-dark-room.jpg)

The phone is its own product below 760px. Five tabs where thumbs are: Home, Messages, Discover, Catch up, You. Screens push from the right with a back arrow. In a community, a drawer (rail plus rooms) slides in from the left edge or from the header's Rooms button; choosing a house in it shows its rooms without leaving, choosing a room goes there. The member list is a bottom sheet. Headers show only what fits (Back, drawer, title, call buttons, people, More); the rest is in More. Menus and dialogs are bottom sheets; long-press opens message actions; every target is 44px.

## 14. Presence

Presence is shape first, colour second, attached to the avatar's edge:

| State | Mark | Meaning |
|---|---|---|
| Open to talk | Filled mint dot | Happy to be called or pulled into a room |
| Around | Mint ring with a centre dot | Here and reading |
| Focused | Red dot with a bar | Heads down; notifications wait in Catch up |
| Away | Amber half dot | Not at the screen |
| Offline | Grey ring | Not here, or appearing offline |
| In a voice room | Violet rounded rectangle with sound bars | Wins over the rest: join them |

Presence is never a dot alone: rows say what someone is doing ("In Lounge", a status, "Last active 3 h ago", "In a call now").

## 15. Motion

`--m-hover` 100ms for hover and press, `--m-control` 150ms for buttons and menus, `--m-panel` 220ms for panes, drawers and sheets. Position and opacity only, used for menus, navigation, reactions, presence, notifications and voice activity. All durations become 0 under reduced motion, and the loader and live pulse stop.

![The loading mark: a solid arch, the cut-outs opening one after the other](img/brand-loading-filmstrip.jpg)

The app's loading mark is the Huddle with its cut-outs opening one after the other: "people are arriving", not "wait".

## 16. Accessibility

- **Measured contrast.** Text passes WCAG AA (4.5:1, 3:1 for large text) in every preset; the screenshot harness checks every visible text. Violet fills use near-black text in dark themes and white in light ones. Disabled controls are the only exemption.
- **Never colour alone.** Presence has shapes, your reactions are `aria-pressed`, mentions have an edge as well as a tint, the New line has a label, unread has bold text as well as a pip.
- **Focus:** one 2px ring in the text colour (3px in high contrast); fields show an accent border and ring.
- **Keyboard:** everything reachable, roving focus in lists, the rail as a toolbar, `?` for the full list.
- **Screen readers:** every icon button is named and has a tooltip; presence marks are `role="img"` with labels; the trailing unread dot stays for screen readers when the pip shows it visually; loading is `role="status"`; the current page has `aria-current`.
- **Size:** three text sizes scale every rem value; three densities change spacing; 44px targets on touch.

## 17. Social mechanics

Snug wants people to come back because their people are there, not because the app pulls at them. It shows what is alive (presence, who is in voice, events with "3 going", communities in common) and deliberately does not do streaks, promotion, infinite feeds, read receipts, strangers suggested, or counts for anything that does not need you. "It's quiet right now" is an honest state.

## Not built yet

- **Social sign-in and email** (verification, password reset).
- **TURN relay and larger rooms.** Voice and video connect directly; above 12 people, or more than a few cameras, needs a media server.
- **Event reminders**, **native phone apps**, **more than one server process**.
- **Reporting from direct messages** and **server-side media for moderation**.
- **Composer suggestions for @everyone, @here and @Role**, editing scheduled messages, forwarding to several places at once.
- **Quick-reaction emoji in the hover toolbar** (they are in the menu's quick row) and **touch drag** for rail folders and role order.
