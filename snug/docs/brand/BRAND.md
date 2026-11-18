# Snug brand sheet

**Idea: a place with someone in it.** Snug is where your people already are.
The brand says that once, quietly, and then gets out of the way of the
conversation.

## The Huddle

<img src="../../brand/nook.svg" width="96" alt="The Huddle: a violet arch with two round cut-outs side by side at its foot">
<img src="../../brand/app-icon.svg" width="96" alt="The app icon: the violet Huddle on a charcoal rounded square">

An arch (straight sides, fully round top, rounded feet) with two round
cut-outs side by side at its foot, one a little larger than the other. Read
it as two people sitting close in one place, or as a pair of eyes looking
out: either way, someone is there. The circles are the same object as the
presence dot everywhere in the app. In code the component keeps its old
name, `Nook` (`js/ui/brand.js`), and the files keep theirs
(`brand/nook.svg`), so nothing that uses them had to change. It replaced the
Doorstep (an open archway with a person on its threshold) in 0.7.0.

### Construction (64 grid)

| Part | Geometry |
|---|---|
| Arch | 48 wide x 54 tall, x 8 to 56, y 6 to 60. Top is a half circle, r 24. Foot radius 4 on both bottom corners. |
| Cut-outs | Circle r 8 at (23, 46) and circle r 6 at (41, 48): bottoms level at y 54, 6 units above the ground; 4 units apart; 7 and 9 units clear of the sides. |
| Fill | One solid shape in Brand Violet `#8B5CF6` with `fill-rule="evenodd"`: the cut-outs show whatever is behind (charcoal on the app icon). |

Path: `M8 56V30a24 24 0 0 1 48 0v26a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4ZM15 46a8 8 0 1 0 16 0a8 8 0 1 0-16 0ZM35 48a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z`

Why it works: it is still built from exactly one arch (the community tile
shape) and circles (the presence dot), so the shape rule holds. Two unequal
circles read as two different people, not as a symmetric face or a
power socket. One solid shape survives a single colour, a white badge and a
16px tab better than the Doorstep's thin band did.

- **Clear space:** the large cut-out's diameter (16 units at 64) on every side.
- **Minimum sizes:** 16px for the symbol, using `brand/favicon.svg` (redrawn on
  the 16px grid: a 12 x 13 arch with 4px and 3px cut-outs, 1px apart, 2px clear
  of the sides and the foot, every edge on a whole pixel); 24px for the
  lockup's symbol height. The `Nook` component switches to the 16-grid drawing
  at 24px and below. Below 16px, use the presence dot alone.
- **App icon:** charcoal `#141516` rounded square (radius 22.5%), the Huddle
  at 58% of the height (11x the 64 grid). For 16 to 32px (taskbar, .ico) use
  `brand/app-icon-small.svg`: the arch grows to 12 x 12 of the 16px square so
  the cut-outs can stay 4px and 3px wide (a 2px cut-out renders as a square).

## Wordmark and lockup

<img src="../../brand/lockup.svg" height="56" alt="Snug lockup: the Huddle and the word snug">

<img src="../../brand/wordmark.svg" height="32" alt="snug wordmark">

"snug", lowercase, Inter Bold, tracking -0.03em, outlined to paths (no font
needed). `#F4F1ED` on dark, `#141516` on light (the files switch with
`prefers-color-scheme`; in the app it is `currentColor`). Lockup: symbol left,
symbol height = cap height x 1.4, about one large cut-out of space between them, the
symbol centred on the x-height. In code: `Nook`, `Wordmark`, `Lockup`,
`Loading` from `js/ui/brand.js`.

## Colour

- **Brand Violet** `#8B5CF6`: the mark, in every file in `brand/`.
- In the app the `--brand` token is the same violet moved just enough for its
  text to pass: `#996FF7` in dark themes (lifted 4 points, near-black text
  5.34:1) and `#763FF4` in light ones (deepened 6 points, white text 5.54:1).
  `#8B5CF6` itself takes neither (white 4.23:1, near-black 4.43:1), so it is
  never a fill with text on it. As text, violet is `--brand-ink`: `#B191F9` on
  dark (7.22:1 on the conversation surface) and `#6D28D9` on light (6.81:1).
  The full ramp and its contrast numbers are in `docs/direction/README.md`
  section 3.
- Violet is the primary button, the active-place bar, count badges, the "New"
  line, the edge of a mention, the voice moment, selection. It means *the
  brand* and *for you*. Never set long text on a violet field; never put
  violet behind a paragraph.
- Grounds: charcoal `#141516`, deepest `#0E0F10`, warm paper `#FBFAF8`.
- Mint, amber, cyan and rose carry meaning (online, soon, info and links,
  reactions you added) and are never used for the mark.

**Why violet.** Coral sat 5 to 7 degrees of hue from error red, so a count
that meant "for you" and a message that meant "failed" were the same family;
the old notes had to lean on lightness to tell them apart. Violet (OKLCH hue
289 to 297) is far from every meaning colour: 60 degrees from cyan links, 70
from rose, 120 from mint, more from amber and red. It is the one cool,
saturated colour in a warm charcoal and paper palette, so "for you" is found
at a glance without being loud. It also suits the Huddle: a solid violet
shape with two dark eyes is friendly without a mascot. The cost: violet is
nearer the purple of some big chat and streaming apps than coral was, so the
identity leans more on the Huddle shape and the warm grounds. Plum (hue 318)
left the colours people can pick for names, roles and houses because it sat
21 degrees from violet; a stored Plum shows as Clay rose.

## Shape rule

**Places are arches, people are circles, controls are rectangles.**

- Communities (houses) are arch tiles (`--r-arch`). With no icon of their own
  they get an empty doorway: <img src="../../brand/house-default.svg" width="24" alt="Default community tile">
- People are always round: avatars, presence, the two cut-outs in the Huddle.
- Buttons and inputs are 6px rectangles; menus 8px; the few real cards 12px.

## Loading and notifications

- **Loading:** the two arrive: the arch stands solid and the cut-outs open in
  it, the larger first, then the smaller, each growing from its foot over
  240ms (ease-out); they rest, close, and the 1.2s cycle repeats. Under
  reduced motion it is static and complete. Always `role="status"` with a
  label ("Opening Snug…").
- **Notifications:** the Huddle on the 24 grid (0.375 of the 64 grid);
  `brand/notify-badge.png` (96px) is the same as a white silhouette with the
  cut-outs clear, for the system to tint:
  <img src="../../brand/notify.svg" width="24" alt="Notification mark">

## Do

- Use the files in `brand/` as they are; scale them, do not redraw them.
- Put the violet Huddle on charcoal, paper, or any neutral from the palette.
- Use the mono version (`nook-mono.svg`, `currentColor`) on photos or busy grounds.

## Don't

- Don't stretch, rotate, outline or add effects:
  no gradients, glass, glows or shadows.
- Don't move, resize or fill the cut-outs: two unequal circles, bottoms
  level (the loading mark is the one exception, where they open in turn).
- Don't recolour the arch in a semantic colour (mint, amber, cyan, rose,
  red), or set the wordmark in violet.
- Don't use the arch for people or controls, or a circle for a place.

## Files

| File | Use |
|---|---|
| `brand/nook.svg`, `brand/nook-mono.svg` | The symbol, violet or `currentColor` |
| `brand/favicon.svg` | Browser tab, 16px grid, works on light and dark tabs |
| `brand/app-icon.svg`, `brand/app-icon-small.svg` | App icon, large and 16 to 32px |
| `brand/app-icon-512.png`, `-256.png`, `-192.png`, `apple-touch-icon.png` | Rendered icons (web manifest, iOS) |
| `brand/wordmark.svg`, `brand/lockup.svg` | Wordmark and lockup, outlined |
| `brand/notify.svg`, `brand/notify-badge.png` | Notifications (badge: white silhouette, 96px) |
| `brand/house-default.svg` | A community without an icon |
| `brand/manifest.json` | Web app manifest |
| `desktop/icon.png` (512), `desktop/icon.ico` (16, 24, 32, 48, 64, 128, 256) | Desktop app (copied to `desktop/build/` by `desktop/build.js`) |
