// Floating layers: one menu, one popover, one dialog, one toast style.
// They all close the same way: Escape, or a click outside.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, closeMenu, closePop, closeModal, dismissToast, closeLightbox } from '../store.js';
import { clamp } from '../lib/util.js';
import { Icon } from './icons.js';
import { Avatar } from './kit.js';

const EDGE = 8;

function place(el, anchor, { x, y, align } = {}) {
  const r = el.getBoundingClientRect();
  let left, top;
  if (anchor) {
    left = align === 'end' ? anchor.right - r.width : anchor.left;
    top = anchor.bottom + 4;
    if (top + r.height > innerHeight - EDGE && anchor.top - r.height - 4 > EDGE) top = anchor.top - r.height - 4;
  } else {
    left = x;
    top = y + r.height > innerHeight - EDGE ? y - r.height : y;
  }
  return {
    left: clamp(left, EDGE, Math.max(EDGE, innerWidth - r.width - EDGE)),
    top: clamp(top, EDGE, Math.max(EDGE, innerHeight - r.height - EDGE)),
  };
}

function useOutside(ref, close) {
  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('resize', close);
    };
  }, []);
}

// Focus goes into the layer when it opens and back to where it was when it closes.
function useReturnFocus() {
  useEffect(() => {
    const prev = document.activeElement;
    return () => { if (prev && prev.isConnected && prev !== document.body) prev.focus({ preventScroll: true }); };
  }, []);
}

export function Menu({ menu }) {
  const ref = useRef();
  const [pos, setPos] = useState(null);
  const [act, setAct] = useState(-1);
  // No separator at either end, and never two in a row.
  const items = menu.items.filter(Boolean).filter((it, i, all) => !it.sep || (i > 0 && i < all.length - 1 && !all[i + 1].sep));
  const live = items.map((it, i) => (it.label && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useReturnFocus();
  useOutside(ref, closeMenu);
  useLayoutEffect(() => {
    setPos(place(ref.current, menu.anchor, menu));
    ref.current.focus({ preventScroll: true });
  }, []);

  const run = (it) => { closeMenu(); it.onSelect?.(); };
  const onKey = (e) => {
    const at = live.indexOf(act);
    if (e.key === 'ArrowDown') { e.preventDefault(); setAct(live[(at + 1) % live.length]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAct(live[(at - 1 + live.length) % live.length]); }
    else if (e.key === 'Home') { e.preventDefault(); setAct(live[0]); }
    else if (e.key === 'End') { e.preventDefault(); setAct(live[live.length - 1]); }
    else if ((e.key === 'Enter' || e.key === ' ') && act >= 0) { e.preventDefault(); run(items[act]); }
    else if (e.key === 'Tab') { e.preventDefault(); closeMenu(); }
  };

  return html`
    <div class="menu-scrim" onClick=${closeMenu}></div>
    <div class="menu float" role="menu" tabindex="-1" ref=${ref} onKeyDown=${onKey}
      style=${pos ? `left:${pos.left}px;top:${pos.top}px` : 'visibility:hidden'}>
      ${menu.quick && html`<div class="menu-quick">
        ${menu.quick.emoji.map((e) => html`<button key=${e} aria-label=${`React with ${e}`} onClick=${() => { closeMenu(); menu.quick.onPick(e); }}>${e}</button>`)}
      </div><div class="menu-sep"></div>`}
      ${items.map((it, i) => {
        if (it.sep) return html`<div class="menu-sep" key=${i}></div>`;
        if (it.heading) return html`<div class="menu-label" key=${i}>${it.heading}</div>`;
        const radio = it.checked !== undefined;
        return html`<button key=${i} class=${`menu-item${it.danger ? ' danger' : ''}${act === i ? ' act' : ''}`}
          role=${radio ? 'menuitemradio' : 'menuitem'} aria-checked=${radio ? String(it.checked) : undefined}
          disabled=${it.disabled} tabindex="-1" onMouseMove=${() => act !== i && setAct(i)} onClick=${() => run(it)}>
          ${it.icon && html`<${Icon} name=${it.icon} />`}
          <span class="grow trunc">${it.label}</span>
          ${(it.checked || it.hint) && html`<span class="end">${it.hint && html`<span class="key-hint">${it.hint}</span>`}${it.checked && html`<${Icon} name="check" size=${16} />`}</span>`}
        </button>`;
      })}
    </div>`;
}

export function Pop({ pop }) {
  const ref = useRef();
  const [pos, setPos] = useState(null);
  useReturnFocus();
  useOutside(ref, closePop);
  useLayoutEffect(() => {
    setPos(place(ref.current, pop.anchor, pop));
    const target = ref.current.querySelector('[data-autofocus]') || ref.current;
    target.focus({ preventScroll: true });
  }, []);
  return html`<div class="pop float" ref=${ref} tabindex="-1" role="dialog" aria-label=${pop.label}
    style=${pos ? `left:${pos.left}px;top:${pos.top}px` : 'visibility:hidden'}>
    <${pop.C} ...${pop.props} />
  </div>`;
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// A dialog is only for decisions that block everything else.
export function ModalFrame({ modal }) {
  const ref = useRef();
  useReturnFocus();
  useLayoutEffect(() => {
    const el = ref.current;
    (el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE) || el).focus();
  }, []);
  const trap = (e) => {
    if (e.key !== 'Tab') return;
    const list = [...ref.current.querySelectorAll(FOCUSABLE)];
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && closeModal()}>
    <div class=${`modal float${modal.props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" tabindex="-1" ref=${ref} onKeyDown=${trap}>
      <${modal.C} ...${modal.props} />
    </div>
  </div>`;
}

export function Toasts() {
  if (!S.ui.toasts.length) return null;
  return html`<div class="toasts" role="status" aria-live="polite">
    ${S.ui.toasts.map((t) => {
      if (t.note) {
        const u = S.users[t.note.user];
        return html`<button key=${t.id} class="toast note" onClick=${() => { dismissToast(t.id); t.run?.(); }}>
          <${Avatar} user=${u} />
          <span class="grow">
            <b style="font-weight:500">${u.name}</b> <span class="faint">${t.note.where}</span>
            <span class="trunc" style="display:block">${t.text}</span>
          </span>
        </button>`;
      }
      return html`<div key=${t.id} class="toast">
        <span class="toast-text">${t.text}</span>
        ${t.undo && html`<button class="btn" onClick=${() => { dismissToast(t.id); t.undo(); }}><${Icon} name="undo" size=${16} />Undo</button>`}
      </div>`;
    })}
  </div>`;
}

export function Lightbox() {
  const lb = S.ui.lightbox;
  if (!lb) return null;
  return html`<div class="lightbox" onClick=${closeLightbox} role="dialog" aria-label=${lb.alt}>
    <img src=${lb.src} alt=${lb.alt} />
  </div>`;
}

// Tooltips: one element, shown after a short rest on anything with data-tip.
export function initTooltips() {
  let tip = null, timer = null, owner = null;
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; owner = null; };
  const show = (el) => {
    hide();
    if (!el.isConnected) return;
    owner = el;
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = el.dataset.tip;
    if (el.dataset.key) { const k = document.createElement('kbd'); k.textContent = el.dataset.key; tip.append(k); }
    document.body.append(tip);
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    // data-tip-side="right" (the rail): beside the item instead of above it.
    if (el.dataset.tipSide === 'right') {
      tip.style.left = `${r.right + 8}px`;
      tip.style.top = `${clamp(r.top + r.height / 2 - t.height / 2, EDGE, innerHeight - t.height - EDGE)}px`;
      return;
    }
    let top = r.top - t.height - 6;
    if (top < EDGE) top = r.bottom + 6;
    tip.style.left = `${clamp(r.left + r.width / 2 - t.width / 2, EDGE, innerWidth - t.width - EDGE)}px`;
    tip.style.top = `${top}px`;
  };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tip]');
    if (el === owner) return;
    hide();
    if (el) timer = setTimeout(() => show(el), 450);
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && el.matches(':focus-visible')) show(el);
  });
  for (const ev of ['pointerdown', 'keydown', 'focusout', 'wheel']) document.addEventListener(ev, hide, true);
}
