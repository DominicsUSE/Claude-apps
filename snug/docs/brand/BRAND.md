# Snug brand sheet

**Idea: a place with someone in it.** Snug is where your people already are.
The brand says that once, quietly, and then gets out of the way of the
conversation.

## The Nook

<img src="../../brand/nook.svg" width="96" alt="The Nook: a coral doorway with a round person cut out of its lower half">
<img src="../../brand/app-icon.svg" width="96" alt="The app icon: the Nook on a charcoal rounded square">

A doorway (straight sides, fully round top, a small foot radius) with a person
(a circle) standing in it. The circle is the same object as the presence dot
everywhere in the app: when you see the dot, someone is there.

### Construction (64 grid)

| Part | Geometry |
|---|---|
| Doorway | 40 wide x 56 tall, x 12 to 52, y 4 to 60. Top is a half circle, r 20. Foot radius 4 (2px at 32px). |
| Person | Circle r 9 at (32, 42): centred, 9 units above the threshold, 11 from each side. |
| Fill | Doorway in Brand Coral; the person is cut out (negative space), or off-white `#F4F1ED` on the app icon. |

Why centred and low: centred, the mark is calm and symmetric and snaps to
the pixel grid at every size; a little less space below the person than
beside it makes them *sit* in the doorway instead of floating. The circle is
45% of the doorway's width: big enough to read as a person, small enough to
leave the doorway around them. Taller than wide (1 : 1.4), with a person in
it, so it reads as a door and not a tombstone or a bullet.

- **Clear space:** one person (the dot's diameter, 18 units at 64) on every side.
- **Minimum sizes:** 16px for the symbol, using `brand/favicon.svg` (redrawn on
  the 16px grid: 10 x 14 doorway, 4px person on whole pixels); 24px for the
  lockup's symbol height. Below 16px, use the presence dot alone.
- **App icon:** charcoal `#141516` rounded square (radius 22.5%), the Nook at
  60% of the height, person in `#F4F1ED`. For 16 to 32px (taskbar, .ico) use
  `brand/app-icon-small.svg`, drawn on the 16px grid with a bigger Nook.

## Wordmark and lockup

<img src="../../brand/lockup.svg" height="56" alt="Snug lockup: the Nook and the word snug">

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
- People are always round: avatars, presence, the dot in the Nook.
- Buttons and inputs are 6px rectangles; menus 8px; the few real cards 12px.

## Loading and notifications

- **Loading:** the person settles into the doorway: the dot drops in from above
  and fades in over 240ms (ease-out), rests, fades, repeats every 1.2s. Under
  reduced motion it is static and complete. Always `role="status"` with a
  label ("Opening Snug…").
- **Notifications:** the Nook as a 2-unit outline with the person filled:
  <img src="../../brand/notify.svg" width="24" alt="Notification mark">

## Do

- Use the files in `brand/` as they are; scale them, do not redraw them.
- Put the coral Nook on charcoal, paper, or any neutral from the palette.
- Use the mono version (`nook-mono.svg`, `currentColor`) on photos or busy grounds.

## Don't

- Don't stretch, rotate, outline (except the notification mark) or add effects:
  no gradients, glass, glows or shadows.
- Don't move the person: not to the top, not off-centre, not outside the doorway.
- Don't recolour the doorway in a semantic colour (mint, amber, red), or set the
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
