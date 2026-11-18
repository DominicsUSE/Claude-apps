// Controls: the shared buttons, fields, tabs, menus, dialogs and states every
// view builds with. DESIGN.md says when to use which. Styles live in
// css/base.css (.btn, .ib, .field, .menu, .modal, .toast, .tip, .empty,
// .skel) and css/components.css (the ui-* classes added in 0.15).
//
// Import from js/ui/kit.js, which re-exports all of this next to Avatar,
// Badge, Pres, Tile, Seg, Switch and Empty.
import { html, useState, useRef, useMemo } from '../../vendor/preact-htm.js';
import { openMenu, openModal, closeModal, toast } from '../store.js';
import { Icon } from './icons.js';
import { t } from '../lib/i18n.js';

// Join class names, skipping empty ones.
export const cx = (...parts) => parts.filter(Boolean).join(' ');

// A stable id for one mounted component (label/hint/error wiring, tabs).
let seq = 0;
export const useId = (prefix = 'ui') => useMemo(() => `${prefix}-${(seq += 1).toString(36)}`, []);

const warned = new Set();
const warnOnce = (msg) => { if (!warned.has(msg)) { warned.add(msg); console.warn(`[snug ui] ${msg}`); } };

// ---------- Buttons ----------

// variant -> the .btn modifier it draws with (css/base.css).
const VARIANT = { primary: 'primary', secondary: '', ghost: 'ghost', danger: 'danger', 'danger-solid': 'danger solid' };
const SIZE = { sm: 'sm', md: 'md', lg: 'lg' };

// An icon-only button: 32x32 (compact 28, sm 24; 44 on phones from CSS, or
// always with size="touch"). Its label is the accessible name and the
// tooltip (with an optional shortcut). pressed makes it a toggle.
export function IconButton({ icon, label, onClick, size, iconSize, cls = '', pressed, tip = true, tipKey, tipSide, danger, disabled, busy, ...rest }) {
  if (!label) warnOnce(`IconButton "${icon}" needs a label: it is the button's only name.`);
  const sz = iconSize || (size === 'sm' ? 16 : size === 'compact' ? 18 : 20);
  const c = cx('ib', size === 'sm' && 'sm', size === 'compact' && 'compact', size === 'touch' && 'touch', danger && 'danger', cls);
  return html`<button type="button" class=${c} aria-label=${label} data-tip=${tip ? label : undefined} data-key=${tipKey} data-tip-side=${tipSide}
    aria-pressed=${pressed === undefined ? undefined : String(!!pressed)} aria-busy=${busy ? 'true' : undefined} disabled=${disabled} onClick=${onClick} ...${rest}><${Icon} name=${icon} size=${sz} /></button>`;
}

// One button for every text action.
//   variant: primary (the one main action in a view) | secondary (default)
//            | ghost (low weight) | danger (outlined) | danger-solid (the
//            confirm button of a destructive dialog)
//   size: sm (28, dense rows) | md (36) | lg (40); default 32. 44 on phones.
//   loading: a spinner before the label; the button ignores clicks meanwhile.
//   icon / iconEnd: an icon name before / after the label.
//   No children and an icon: an icon-only button, so `label` is required.
export function Button({ variant = 'secondary', size, loading, icon, iconEnd, label, block, type = 'button', cls, children, disabled, ...rest }) {
  if (children == null && icon) {
    return html`<${IconButton} icon=${icon} label=${label} busy=${loading} disabled=${disabled} danger=${variant === 'danger' || variant === 'danger-solid'} cls=${cls} ...${rest} />`;
  }
  if (!(variant in VARIANT)) warnOnce(`Button variant "${variant}" is not one of ${Object.keys(VARIANT).join(', ')}.`);
  const c = cx('btn', VARIANT[variant], SIZE[size], block && 'block', cls);
  return html`<button type=${type} class=${c} aria-label=${label} aria-busy=${loading ? 'true' : undefined} disabled=${disabled} ...${rest}>
    ${icon && !loading && html`<${Icon} name=${icon} size=${16} />`}${children}${iconEnd && html`<${Icon} name=${iconEnd} size=${16} />`}
  </button>`;
}
export const PrimaryButton = (p) => html`<${Button} ...${p} variant="primary" />`;
export const SecondaryButton = (p) => html`<${Button} ...${p} variant="secondary" />`;
export const GhostButton = (p) => html`<${Button} ...${p} variant="ghost" />`;
export const DangerButton = ({ solid, ...p }) => html`<${Button} ...${p} variant=${solid ? 'danger-solid' : 'danger'} />`;

// ---------- Fields ----------

// The frame around any control: a label, the control, then a hint or an
// error (the error replaces the hint and is announced). `children` is a
// function given the ids to wire: ({ id, describedBy, invalid }) => control.
export function Field({ label, hint, error, id: given, optional, cls, children }) {
  const auto = useId('fld');
  const id = given || auto;
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return html`<div class=${cx('ui-field', error && 'has-error', cls)}>
    ${label && html`<label class="label" for=${id}>${label}${optional && html` <span class="ui-optional">(optional)</span>`}</label>`}
    ${children({ id, describedBy: errId || hintId, invalid: !!error })}
    ${error ? html`<p class="err" id=${errId} role="alert"><${Icon} name="alert" size=${14} />${error}</p>`
      : hint && html`<p class="hint" id=${hintId}>${hint}</p>`}
  </div>`;
}

// size: sm (32) | lg (40); default 36. Always 44 and 16px text on phones.
export function TextInput({ label, hint, error, id, optional, size, cls, fieldCls, type = 'text', ...rest }) {
  if (!label && !rest['aria-label']) warnOnce('TextInput needs a label or an aria-label.');
  return html`<${Field} label=${label} hint=${hint} error=${error} id=${id} optional=${optional} cls=${fieldCls}>
    ${({ id: fid, describedBy, invalid }) => html`<input id=${fid} type=${type} class=${cx('field', SIZE[size], cls)}
      aria-describedby=${describedBy} aria-invalid=${invalid ? 'true' : undefined} ...${rest} />`}
  <//>`;
}

export function TextArea({ label, hint, error, id, optional, rows = 3, cls, fieldCls, ...rest }) {
  if (!label && !rest['aria-label']) warnOnce('TextArea needs a label or an aria-label.');
  return html`<${Field} label=${label} hint=${hint} error=${error} id=${id} optional=${optional} cls=${fieldCls}>
    ${({ id: fid, describedBy, invalid }) => html`<textarea id=${fid} rows=${rows} class=${cx('field', cls)}
      aria-describedby=${describedBy} aria-invalid=${invalid ? 'true' : undefined} ...${rest}></textarea>`}
  <//>`;
}

// A search box: a magnifier, the field, and a clear button once there is
// text. The label is for screen readers (the placeholder shows the purpose).
export function SearchInput({ label, value = '', onInput, onClear, placeholder, size, cls, ...rest }) {
  const ref = useRef();
  const clear = () => { onClear ? onClear() : onInput?.({ currentTarget: { value: '' }, target: { value: '' } }); ref.current?.focus(); };
  return html`<div class=${cx('ui-search', SIZE[size], cls)}>
    <${Icon} name="search" size=${16} />
    <input ref=${ref} type="search" class="ui-search-in" aria-label=${label || placeholder} placeholder=${placeholder}
      value=${value} onInput=${onInput} onKeyDown=${(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); clear(); } }} ...${rest} />
    ${value && html`<${IconButton} icon="x" size="sm" label="Clear search" tip=${false} onClick=${clear} />`}
  </div>`;
}

// ---------- Tooltip ----------

// Tooltips are one global element (js/ui/overlays.js initTooltips) shown for
// anything carrying data-tip, after a short rest under a mouse or on keyboard
// focus, never on touch. tip() gives the attributes; spread them on a control:
//   <button ...${tip('Pin', { key: 'P' })}>
// Icon-only controls get theirs from IconButton.
export const tip = (text, { key, side } = {}) => ({ 'data-tip': text, 'data-key': key, 'data-tip-side': side });
// For a non-interactive thing that needs a tooltip (a truncated name, an
// icon): it becomes focusable so keyboard users can read it too.
export const Tooltip = ({ text, keys, side, children, cls }) =>
  html`<span class=${cx('ui-tip-host', cls)} tabindex="0" ...${tip(text, { key: keys, side })}>${children}</span>`;

// ---------- Menus ----------

// Menus are store state (openMenu) drawn by Menu in js/ui/overlays.js:
// arrow keys, Home/End, Enter, Esc and Tab, focus returns to the opener.
// Items: { label, icon, onSelect, danger, disabled, hint, checked } |
// { heading } | { sep: true }.

// A button that opens a menu below it.
export function Dropdown({ label, icon = 'chevron', items, align = 'start', menuLabel, variant = 'ghost', size, iconOnly, cls, children }) {
  const [open, setOpen] = useState(false);
  const show = (e) => {
    const list = typeof items === 'function' ? items() : items;
    setOpen(true);
    openMenu({ anchor: e.currentTarget.getBoundingClientRect(), items: list, align, label: menuLabel || label, onClose: () => setOpen(false) });
  };
  const common = { 'aria-haspopup': 'menu', 'aria-expanded': String(open), onClick: show };
  if (iconOnly) return html`<${IconButton} icon=${icon} label=${label} cls=${cls} ...${common} />`;
  return html`<${Button} variant=${variant} size=${size} iconEnd=${icon} cls=${cls} ...${common}>${children ?? label}<//>`;
}

// A context menu for anything: right click, the Menu key or Shift+F10.
//   <div ...${contextMenu(() => items, { label: 'Message' })}>
export function contextMenu(getItems, { label } = {}) {
  const at = (opts) => { const items = getItems(); if (items?.length) openMenu({ ...opts, items, label }); };
  return {
    onContextMenu: (e) => { e.preventDefault(); at({ x: e.clientX, y: e.clientY }); },
    onKeyDown: (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        at({ anchor: e.currentTarget.getBoundingClientRect() });
      }
    },
  };
}
export const openContextMenu = (e, items, opts = {}) => { e.preventDefault?.(); openMenu({ x: e.clientX, y: e.clientY, items, ...opts }); };

// ---------- Tabs ----------

// tabs: [{ id, label, icon, count, badge }]. Arrow keys move and select
// (automatic activation), Home/End jump. Give the panel TabPanel with the
// same `base` so each names the other.
export function Tabs({ tabs, value, onChange, label, base: given, cls }) {
  const auto = useId('tabs');
  const base = given || auto;
  const onKey = (e) => {
    const i = tabs.findIndex((x) => x.id === value);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(tabs[n].id);
    requestAnimationFrame(() => document.getElementById(`${base}-tab-${tabs[n].id}`)?.focus());
  };
  return html`<div class=${cx('ui-tabs', cls)} role="tablist" aria-label=${label} onKeyDown=${onKey}>
    ${tabs.map((x) => html`<button key=${x.id} id=${`${base}-tab-${x.id}`} type="button" class="ui-tab" role="tab"
      aria-selected=${String(x.id === value)} aria-controls=${`${base}-panel`} tabindex=${x.id === value ? '0' : '-1'} onClick=${() => onChange(x.id)}>
      ${x.icon && html`<${Icon} name=${x.icon} size=${16} />`}<span>${x.label}</span>
      ${x.badge > 0 ? html`<span class="badge">${x.badge > 99 ? '99+' : x.badge}</span>` : x.count > 0 && html`<span class="ui-tab-count num">${x.count}</span>`}
    </button>`)}
  </div>`;
}
export const TabPanel = ({ base, value, children, cls }) =>
  html`<div class=${cx('ui-tabpanel', cls)} id=${`${base}-panel`} role="tabpanel" aria-labelledby=${`${base}-tab-${value}`} tabindex="0">${children}</div>`;

// ---------- Dialogs ----------

// A dialog's content. Open it with openModal(MyDialog, props); ModalFrame
// (js/ui/overlays.js) traps focus, closes on Esc or a click on the scrim,
// returns focus to the opener, and names the dialog after its first heading.
//   function Rename() { return html`<${Modal} title="Rename" footer=${...}>...<//>`; }
export const Modal = ({ title, lead, children, footer }) => html`
  ${title && html`<h2>${title}</h2>`}
  ${lead && html`<p class="modal-lead">${lead}</p>`}
  ${children}
  ${footer && html`<div class="modal-foot">${footer}</div>`}`;

// Ask before something that can't be undone or that loses work. The safe
// choice has focus. danger: the confirm button is red.
export function ConfirmDialog({ title, text, action, danger, onConfirm, cancelLabel }) {
  return html`
    <h2>${title}</h2>
    ${text && html`<p class="modal-lead">${text}</p>`}
    <div class="modal-foot">
      <button type="button" class="btn" data-autofocus onClick=${closeModal}>${cancelLabel || t('common.cancel')}</button>
      <button type="button" class=${`btn ${danger ? 'danger solid' : 'primary'}`} onClick=${() => { closeModal(); onConfirm?.(); }}>${action}</button>
    </div>`;
}
export const confirmDialog = (opts) => openModal(ConfirmDialog, opts);

// ---------- Toasts ----------

// toast(text, { kind, undo }) lives in js/store.js. kind: success | error |
// info (or none: a plain confirmation). The kind shows as an icon and a
// word for screen readers, never as colour alone.
export const toastSuccess = (text, opts) => toast(text, { ...opts, kind: 'success' });
export const toastError = (text, opts) => toast(text, { ...opts, kind: 'error' });
export const toastInfo = (text, opts) => toast(text, { ...opts, kind: 'info' });

// ---------- States ----------

// Nothing here yet: one sentence and one way forward.
//   action: { label, onClick, variant } draws the button.
export function EmptyState({ icon, title, text, action, children, inline, cls }) {
  return html`<div class=${cx('empty', inline && 'inline', cls)}>
    ${icon && html`<${Icon} name=${icon} size=${24} />`}
    <h2>${title}</h2>
    ${text && html`<p>${text}</p>`}
    ${action && html`<${Button} variant=${action.variant || 'primary'} icon=${action.icon} onClick=${action.onClick}>${action.label}<//>`}
    ${children}
  </div>`;
}

// Quiet blocks in the shape of what is coming. They breathe, and hold still
// under reduced motion.
export const Skeleton = ({ w, h, circle, line, cls }) =>
  html`<span class=${cx('skel', circle && 'circle', line && 'line', cls)} aria-hidden="true" style=${`${w ? `width:${typeof w === 'number' ? `${w}px` : w};` : ''}${h ? `height:${typeof h === 'number' ? `${h}px` : h};` : ''}`}></span>`;

const WIDTHS = ['62%', '44%', '78%', '54%', '70%', '38%'];
// kind: list (rows with a circle) | lines (paragraph) | messages (chat) |
// cards (tiles in a grid). Announced once as "Loading…" (or label).
export function LoadingState({ kind = 'list', rows = 4, label, cls }) {
  const n = Array.from({ length: rows }, (_, i) => i);
  const body = {
    list: () => n.map((i) => html`<div key=${i} class="skel-row"><${Skeleton} circle w=${24} h=${24} /><${Skeleton} line w=${WIDTHS[i % 6]} /></div>`),
    lines: () => n.map((i) => html`<${Skeleton} key=${i} line w=${i === rows - 1 ? '40%' : WIDTHS[i % 6]} />`),
    messages: () => n.map((i) => html`<div key=${i} class="ui-skel-msg"><${Skeleton} circle w=${40} h=${40} /><div class="ui-skel-msg-body"><${Skeleton} line w=${120} /><${Skeleton} line w=${WIDTHS[i % 6]} /></div></div>`),
    cards: () => n.map((i) => html`<${Skeleton} key=${i} cls="ui-skel-card" />`),
  }[kind] || (() => null);
  return html`<div class=${cx('ui-loading', `k-${kind}`, cls)} role="status" aria-busy="true">
    <span class="sr">${label || 'Loading'}</span>${body()}
  </div>`;
}

// Something failed: what happened in plain words, and a retry when there is
// one. Never a stack trace, an address or a code.
export function ErrorState({ title, text, onRetry, retryLabel, inline, cls }) {
  return html`<div class=${cx('empty error ui-error', inline && 'inline', cls)} role="alert">
    <${Icon} name="alert" size=${24} />
    <h2>${title || 'That didn’t load'}</h2>
    ${text && html`<p>${text}</p>`}
    ${onRetry && html`<${Button} icon="history" onClick=${onRetry}>${retryLabel || t('common.tryAgain')}<//>`}
  </div>`;
}
