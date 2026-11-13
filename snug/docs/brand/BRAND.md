# Snug brand sheet

**Idea: a place with someone in it.** Snug is where your people already are.
The brand says that once, quietly, and then gets out of the way of the
conversation.

## The Doorstep

<img src="../../brand/nook.svg" width="96" alt="The Doorstep: a coral open archway with a round coral person standing on its threshold">
<img src="../../brand/app-icon.svg" width="96" alt="The app icon: the Doorstep on a charcoal rounded square, the person off-white">

An open archway (straight sides, fully round top, rounded outer feet, the
opening running down to the ground) with a person (a circle) standing on its
threshold. The circle is the same object as the presence dot everywhere in the
app: when you see the dot, someone is there. In code the component keeps its
old name, `Nook` (`js/ui/brand.js`), and the files keep theirs
(`brand/nook.svg`), so nothing that uses them had to change.
`docs/direction/README.md` section 2 has the reasons and the concepts that
were rejected.

### Construction (64 grid)

| Part | Geometry |
|---|---|
| Archway | 52 wide x 54 tall, x 6 to 58, y 5 to 59. Top is a half circle, outer r 26. Foot radius 4 on the outer corners. |
| Opening | 28 wide (x 18 to 46) with an r 14 top, open to the ground, so the band is 12 units everywhere. |
| Person | Circle r 9 at (32, 50): standing on the threshold line, 5 units clear of each side of the opening. |
| Fill | Archway and person both solid Brand Coral; the opening shows the ground. On the app icon the person is off-white `#F4F1ED`. |

Why open and standing: a closed door with a hole in it reads as a tombstone or
a keyhole; an opening that reaches the floor reads as a way in. The person on
the step, rather than floating in the middle, reads as arriving, or as someone
at your door. It is built from exactly one arch (the community tile shape) and
one circle (the presence dot).

- **Clear space:** one person (the dot's diameter, 18 units at 64) on every side.
- **Minimum sizes:** 16px for the symbol, using `brand/favicon.svg` (redrawn on
  the 16px grid: a 12 x 13 archway, 3px band, 6px opening, 4px person, every
  edge on a whole pixel); 24px for the lockup's symbol height. The `Nook`
  component switches to the 16-grid drawing at 24px and below. Below 16px, use
  the presence dot alone.
- **App icon:** charcoal `#141516` rounded square (radius 22.5%), the Doorstep
  at about 58% of the height, person in `#F4F1ED`. For 16 to 32px (taskbar,
  .ico) use `brand/app-icon-small.svg`, drawn on the 16px grid with a 2px band.

## Wordmark and lockup

<img src="../../brand/lockup.svg" height="56" alt="Snug lockup: the Doorstep and the word snug">

<img src="../../brand/wordmark.svg" height="32" alt="snug wordmark">

"snug", lowercase, Inter Bold, tracking -0.03em, outlined to paths (no font
needed). `#F4F1ED` on dark, `#141516` on light (the files switch with
`prefers-color-scheme`; in the app it is `currentColor`). Lockup: symbol left,
symbol height = cap height x 1.4, one person of space between them, the
symbol centred on the x-height. In code: `Nook`, `Wordmark`, `Lockup`,
`Loading` from `js/ui/brand.js`.

## Colour

- **Brand Coral** `#F05A47` (dark) / `#E04B38` (light). The symbol, the primary
  button, the active-place bar, count badges, the "New" line, the voice moment.
  Coral means *the brand* and *for you*.
- Text on coral is `#111211`. Never set long text on a coral field; never put
  coral behind a paragraph.
- Grounds: charcoal `#141516`, deepest `#0E0F10`, warm paper `#FBFAF8`.
- Mint, amber, cyan and rose carry meaning (online, soon, info, warmth) and are
  never used for the mark.

## Shape rule

**Places are arches, people are circles, controls are rectangles.**

- Communities (houses) are arch tiles (`--r-arch`). With no icon of their own
  they get an empty doorway: <img src="../../brand/house-default.svg" width="24" alt="Default community tile">
- People are always round: avatars, presence, the person on the Doorstep.
- Buttons and inputs are 6px rectangles; menus 8px; the few real cards 12px.

## Loading and notifications

- **Loading:** the person arrives on the doorstep: the dot drops onto the threshold from above
  and fades in over 240ms (ease-out), rests, fades, repeats every 1.2s. Under
  reduced motion it is static and complete. Always `role="status"` with a
  label ("Opening Snug…").
- **Notifications:** the Doorstep redrawn on the 24 grid (a 4-unit band, a
  7-unit person); `brand/notify-badge.png` is the same as a white silhouette:
  <img src="../../brand/notify.svg" width="24" alt="Notification mark">

## Do

- Use the files in `brand/` as they are; scale them, do not redraw them.
- Put the coral Doorstep on charcoal, paper, or any neutral from the palette.
- Use the mono version (`nook-mono.svg`, `currentColor`) on photos or busy grounds.

## Don't

- Don't stretch, rotate, outline or add effects:
  no gradients, glass, glows or shadows.
- Don't move the person: it stays on the threshold, centred (the loading mark
  is the one exception, where it steps onto it).
- Don't recolour the archway in a semantic colour (mint, amber, red), or set the
  wordmark in coral.
- Don't use the arch for people or controls, or a circle for a place.

## Files

| File | Use |
|---|---|
| `brand/nook.svg`, `brand/nook-mono.svg` | The symbol, coral or `currentColor` |
| `brand/favicon.svg` | Browser tab, 16px grid, works on light and dark tabs |
| `brand/app-icon.svg`, `brand/app-icon-small.svg` | App icon, large and 16 to 32px |
| `brand/app-icon-512.png`, `-256.png`, `-192.png`, `apple-touch-icon.png` | Rendered icons (web manifest, iOS) |
| `brand/wordmark.svg`, `brand/lockup.svg` | Wordmark and lockup, outlined |
| `brand/notify.svg` | Notifications |
| `brand/house-default.svg` | A community without an icon |
| `brand/manifest.json` | Web app manifest |
| `desktop/icon.png` (512), `desktop/icon.ico` (16 to 256) | Desktop app |
