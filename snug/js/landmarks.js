// Landmarks for keyboard and screen-reader users:
// - "Skip to messages", the first thing Tab reaches: visible on focus, it
//   moves the focus to the composer (or the main view when there is none).
// - F6 and Shift+F6 cycle the regions: places (rail), the sidebar, the main
//   view, the side pane (people, thread, details) and the call dock. Its own
//   listener, so it works while typing and inside any view.
// The main view itself is the one <main> landmark (js/app.js).
import { S } from './store.js';

export const REGIONS = [
  ['.rail', 'Places'],
  ['.ctx', 'Sidebar'],
  ['#main', 'Main'],
  ['.pane', 'Side pane'],
  ['.dock', 'Call'],
];

function regions() {
  // The main landmark has no box of its own (display: contents), so it counts as shown when its view is.
  const shown = (el) => el.getClientRects().length > 0 || !!el.firstElementChild?.getClientRects().length;
  return REGIONS.map(([sel]) => document.querySelector(sel)).filter((el) => el && shown(el));
}

// Focus something useful inside a region: what was last focused there, the
// selected row, the composer, or the region itself.
function enter(el) {
  const pick = el.matches('#main')
    ? el.querySelector('.composer textarea:not([disabled])') || el.querySelector('h1, .bar-title')
    : el.querySelector('[aria-current="page"], [aria-selected="true"], .row.sel') || el.querySelector('button, a[href], input, textarea, [tabindex="0"]');
  const target = pick || el;
  if (!target.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: false });
  announce(el);
}

let live = null;
function announce(el) {
  const name = el.getAttribute('aria-label') || REGIONS.find(([sel]) => el.matches(sel))?.[1] || '';
  if (!live) {
    live = document.createElement('div');
    live.className = 'sr';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.id = 'region-announce';
    document.body.append(live);
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = name; }, 30);
}

export function cycle(back = false) {
  const list = regions();
  if (!list.length) return null;
  const at = list.findIndex((el) => el.contains(document.activeElement));
  const next = at < 0 ? (back ? list.length - 1 : 0) : (at + (back ? -1 : 1) + list.length) % list.length;
  enter(list[next]);
  return list[next];
}

addEventListener('keydown', (e) => {
  if (e.key !== 'F6' || e.altKey || e.ctrlKey || e.metaKey) return;
  if (S.auth !== 'in' || !S.ready) return;
  // A dialog or menu keeps the focus inside it.
  if (S.ui.modal || S.ui.menu || S.ui.pop || S.ui.quick || S.ui.layer || S.ui.lightbox) return;
  e.preventDefault();
  cycle(e.shiftKey);
}, true);

// ---------- Skip link ----------
function skip(e) {
  e.preventDefault();
  const main = document.getElementById('main') || document.querySelector('main');
  const box = main?.querySelector('.composer textarea:not([disabled])');
  if (box) { box.focus(); return; }
  if (main) { main.setAttribute('tabindex', '-1'); main.focus(); }
}
function mountSkip() {
  if (document.querySelector('.skip-link')) return;
  const a = document.createElement('a');
  a.className = 'skip-link';
  a.href = '#main';
  a.textContent = 'Skip to messages';
  a.addEventListener('click', skip);
  document.body.prepend(a);
}
if (document.body) mountSkip(); else addEventListener('DOMContentLoaded', mountSkip);
