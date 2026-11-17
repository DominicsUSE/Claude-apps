# Snug design system

The reference for anyone changing Snug's screens. Tokens live in `css/tokens.css`, shared styles in
`css/base.css` and `css/components.css`, shared components in `js/ui/` (import everything from
`js/ui/kit.js`). `tests/logic-design.test.js` guards the rules it can check. To see every component in
both themes, open the sheet from the browser console:

```js
Promise.all([import('/js/store.js'), import('/js/ui/gallery.js')]).then(([s, g]) => s.openLayer({ C: g.Gallery, props: {} }))
```

## Character

A calm, warm place to talk. People are circles, houses are circles in the rail, controls are compact
rectangles. Depth comes from surface steps, not shadows. Violet (`--brand`, `css/brand.css`) is about 10% of a
screen: the main action, the selected mark, unread and mention marks, the logo. No gradients, no glass, no
bounce, nothing that moves for longer than 200ms. Words are plain and honest: say what the server can see; never
"100% anonymous" or "untraceable". Snug's own spaces are **houses** with **rooms**.

## Tokens

Use the semantic or role names below in new CSS. Raw `--bg-N`, hex colours and literal numbers are for
`tokens.css` and theme files only.

| Group | Tokens | Notes |
|---|---|---|
| Colour (semantic) | `--color-bg` `--color-surface` `--color-elevated` `--color-hover` `--color-active` `--color-border` `--color-border-strong` `--color-primary` (+`-hover`, `--color-on-primary`) `--color-secondary` (+`-hover`, `--color-on-secondary`) `--color-success` `--color-warning` `--color-danger` `--color-info` `--color-text` `--color-text-secondary` `--color-muted` `--color-disabled` `--color-focus` | Each points at a role, so all ten themes and custom accents follow. |
| Colour (status pairs) | `--success-soft/-ink` `--warning-soft/-ink` `--info-soft/-ink` `--danger` `--danger-soft` `--on-danger` | Soft = background, ink = text on it. Amber or mint as small text: use the `-ink`. |
| Surfaces (roles) | `--surface-rail` `--surface-chat` `--surface-nav` `--surface-2` `--surface-float` `--surface-hover` `--surface-sel` `--surface-input` | Dark: conversation deepest, nav one up. Light: conversation brightest. |
| Type sizes | `--t-heading` 20, `--t-section` 16, `--t-body` 14, `--t-msg` 15, `--t-ui` 13, `--t-meta` 12, `--t-micro` 12; raw `--t-11` (rare caps only), `--t-24`/`--t-32` (display glyphs only) | rem, so the Text size setting scales them. 12px is the floor for words. |
| Emoji and inputs | `--t-emoji` 22, `--t-emoji-l` 28, `--t-emoji-xl` 44, `--t-input-touch` (16px min) | |
| Weight / line height | `--w-regular/medium/semibold/bold`; `--lh-display 1.15` `--lh-heading 1.25` `--lh-ui 1.3` `--lh-body 1.45` | |
| Space | `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 20 · `--s-6` 24 · `--s-8` 32 · `--s-10` 40 · `--s-12` 48 · `--s-16` 64 · `--s-20` 80 | 4px grid. 1-2px only for borders and hairline gaps. |
| Radius | `--r-row` 4 · `--r-btn` 6 · `--r-menu` 6 · `--r-modal` 8 · `--r-input` 8 · `--r-media` 12 · `--r-full` · `--r-tile` (houses) | `--r-xs/sm/md/lg/xl` are deprecated aliases; don't use them. |
| Elevation | `--elev-0` none · `--elev-1` raised control · `--elev-2` menus, popovers, toasts · `--elev-3` dialogs, sheets; `--ring-focus` `--ring-sel` | Shadows only under floating layers. `--shadow-sm/md/lg` are the per-theme raw values behind them. |
| Motion | `--m-fast` 100 · `--m-standard` 150 · `--m-smooth` 180 · `--m-slow` 200; roles `--m-hover` `--m-control` `--m-panel`; `--ease-out` (entering) `--ease-in-out` (state changes) | All become 0ms with reduced motion (device or Settings). |
| Layers | `--z-pane` 5 · `--z-dock` 30 · `--z-drawer` 31 · `--z-banner` 40 · `--z-layer` 45 · `--z-scrim` 50 · `--z-pop` 55 · `--z-quick` 58 · `--z-menu` 60 · `--z-viewer` 65 · `--z-toast` 70 · `--z-tip` 80 · `--z-skip` 1000 | Literal 1-8 only for stacking inside one component. |
| Sizes | `--h-xs` 24 · `--h-28` · `--h-sm` 32 · `--h-36` · `--h-md` 40 · `--h-lg` 48 · `--h-field` 36 · `--tap-min` 44 | Phones and `(pointer: coarse)`: anything pressed is 44px. |
| Tooltip / media | `--tip-bg` `--tip-ink` `--tip-muted`; `--on-media` `--media-scrim` | |
| Text size hook | `--text-scale` on `:root` (`data-text="s|l|xl"` sets 0.875/1.125/1.25) | Multiplies the root font size; the px layout grid stays. |

Breakpoints (media queries can't read variables): phone `max-width: 759px`, tablet `760-1179px`, desktop
`min-width: 1180px`, wide `min-width: 1440px`.

Contrast: `text-1` 7:1 and `text-2`/`text-3` 4.5:1 on every surface, button text 4.5:1 on its fill, in dark and
light (checked by the test). Dark is layered warm greys (`#0E0F10` to `#292B2D`), never pure black.

## Components (`import { … } from '../ui/kit.js'`)

| Component | Props | Use |
|---|---|---|
| `Button` | `variant` primary/secondary/ghost/danger/danger-solid, `size` sm/md/lg, `loading`, `icon`, `iconEnd`, `block`, `type`, `cls`, `label` | One primary per view. No children + `icon` = icon-only, and `label` is required. Also `PrimaryButton`, `SecondaryButton`, `GhostButton`, `DangerButton({solid})`. |
| `IconButton` | `icon`, `label` (required), `size` sm/compact/touch, `pressed`, `danger`, `busy`, `tip`, `tipKey`, `tipSide`, `cls` | Label is the name and the tooltip. `pressed` makes a toggle. |
| `TextInput`, `TextArea` | `label`, `hint`, `error`, `optional`, `id`, `size` sm/lg (inputs), `rows`, any input attribute | Error replaces the hint, sets `aria-invalid`, is announced. |
| `SearchInput` | `label`, `value`, `onInput`, `onClear`, `placeholder`, `size` | Clear button appears with text; Esc clears. |
| `Field` | `label`, `hint`, `error`, `id`, `children({ id, describedBy, invalid })` | Wrap any other control (select, custom). |
| `Tabs`, `TabPanel` | `tabs [{id,label,icon,count,badge}]`, `value`, `onChange`, `label`, `base` | Arrow keys, Home/End. Same `base` on both. |
| `Dropdown` | `label`, `items`, `icon`, `align`, `iconOnly`, `variant`, `size` | A button that opens a menu below it. |
| `contextMenu(getItems, {label})` | spread on an element | Right click, Menu key, Shift+F10. `openContextMenu(e, items)` for one-offs. |
| Menu items | `{label, icon, onSelect, danger, disabled, hint, checked}`, `{heading}`, `{sep:true}` | Drawn by `Menu` (overlays.js): arrows, Home/End, Enter, Esc, focus returns. |
| `Modal` | `title`, `lead`, `footer`, children | Content for `openModal(C, props)`. The frame traps focus, Esc/scrim closes, focus returns, the first heading names it (or `props.label`). |
| `ConfirmDialog` / `confirmDialog(opts)` | `title`, `text`, `action`, `danger`, `onConfirm`, `cancelLabel` | Cancel has focus. `Confirm` in views/modals.js is the same component. |
| `tip(text, {key, side})`, `Tooltip` | attributes / `text`, `keys`, `side` | Mouse rest or keyboard focus, never touch. Hidden when a layer covers its owner. |
| `toast(text, opts)` (store), `toastSuccess` `toastError` `toastInfo` | `undo`, `kind` | Kind shows an icon and a word for screen readers. Errors stay 7s. |
| `Avatar` | `user`, `size`, `presence`, `speaking`, `dim`, `onClick` | Presence is shape first, colour second. |
| `Badge` | `n`, `quiet`, `alert`, `label` | Violet = needs you; quiet = doesn't. |
| `Spinner` | `label`, `size` sm/lg | |
| `EmptyState` (`Empty`) | `icon`, `title`, `text`, `action {label,onClick,variant,icon}`, `inline` | One sentence, one way forward. |
| `LoadingState`, `Skeleton` | `kind` list/lines/messages/cards, `rows`, `label` / `w`, `h`, `circle`, `line` | Shape of what is coming; still under reduced motion. |
| `ErrorState` | `title`, `text`, `onRetry`, `retryLabel`, `inline` | Plain words, a retry if there is one. |
| `Seg`, `Switch` | as before | Switch takes effect at once; Seg picks one of a few. |

## Rules

Do:
- Build from the components; if one is missing a variant, add it there, not in the view.
- Use semantic tokens; let themes do the work. Check light and dark, 375 and 1280, at least.
- Give every icon-only control a label, every field a label, every dialog a heading.
- Keep focus visible (`:focus-visible` ring in `--focus`), and keep hover, press and selected distinct.
- Respect reduced motion: animate with `--m-*` tokens so they zero out.
- Say states plainly: what happened, what to do, no codes, addresses, keys or tokens on screen.

Don't:
- Add raw hex, px font sizes, literal z-index above 8, or durations over 200ms.
- Put violet behind text in large areas, or use colour alone for meaning (add an icon or word).
- Hand-roll a spinner, skeleton, empty or error block; use the components.
- Nest `role="menu"` content that isn't a menu item (wrap rows in `role="group"`).
- Show a tooltip on touch, or let one outlive its owner.
- Put the caret in a popover's search field on a touch screen (the keyboard covers the sheet); `data-autofocus`
  is honoured on desktop only, and focus always returns to the opener when a layer closes.
- Restyle moderation views (reports, bans, timeouts, audit log) beyond swapping in tokens.
