// The root. Picks the desktop frame or the phone product, mounts the floating
// layers, and owns the global keyboard map.
import { html, render, useEffect, useLayoutEffect } from '../vendor/preact-htm.js';
import {
  S, emit, useStore, me, go, openConv, back, setTab, closePane, closeMenu, closePop, closeModal, closeLayer,
  closeQuick, closeLightbox, openQuick, openLayer, openModal, openPop, markHouseRead, markConvRead, applyPrefs, convMeta, isOnline, loadCache,
} from './store.js';
import { api, startTransport } from './server.js';
import { voiceStats } from './voice.js';
import { attention, houseAttention, totalNeeds, roomIds } from './lib/attention.js';
import { Icon } from './ui/icons.js';
import { Avatar, Pres, PRESENCE, presenceLabel } from './ui/kit.js';
import { Menu, Pop, ModalFrame, Toasts, Lightbox, initTooltips } from './ui/overlays.js';
import { Nav, NavDirect, NavHouses, LiveDock, MOD } from './views/nav.js';
import { Conversation, ThreadPane, DetailsPane } from './views/conversation.js';
import { PeoplePane, MePop } from './views/people.js';
import { CatchUp, Saved } from './views/catchup.js';
import { Search, QuickJump } from './views/search.js';
import { Settings } from './views/settings.js';
import { NewMessage, JoinByLink } from './views/modals.js';
import { Auth, Splash } from './views/auth.js';

function MainView() {
  const v = S.ui.view;
  if (v.type === 'conv' && convMeta(v.id)) return html`<${Conversation} key=${v.id} conv=${v.id} />`;
  if (v.type === 'saved') return html`<${Saved} />`;
  if (v.type === 'search') return html`<${Search} />`;
  return html`<${CatchUp} />`;
}

function PaneView() {
  const p = S.ui.pane;
  const v = S.ui.view;
  if (!p) return null;
  if (p.type === 'thread') return html`<${ThreadPane} key=${p.id} tid=${p.id} />`;
  if (v.type !== 'conv') return null;
  if (p.type === 'people') return html`<${PeoplePane} conv=${v.id} />`;
  if (p.type === 'details') return html`<${DetailsPane} conv=${v.id} />`;
  return null;
}

function Desktop() {
  const pane = PaneView();
  return html`<div class=${`app${pane ? ' has-pane' : ''}`}>
    <${Nav} />
    <${MainView} />
    ${pane}
  </div>`;
}

// The phone is its own product: one screen at a time, tabs where thumbs are.
const TABS = [
  { id: 'home', label: 'Catch up', icon: 'tray' },
  { id: 'rooms', label: 'Houses', icon: 'house' },
  { id: 'direct', label: 'Direct', icon: 'room' },
  { id: 'you', label: 'You', icon: 'user' },
];

function TabHead({ title, children }) {
  return html`<header class="bar"><h1 class="bar-title">${title}</h1><div class="bar-end">${children}</div></header>`;
}

function YouTab() {
  const u = me();
  const row = (icon, label, run, end) => html`<button class="row" onClick=${run}><span class="row-ic"><${Icon} name=${icon} /></span><span class="grow">${label}</span>${end && html`<span class="row-end faint">${end}</span>`}</button>`;
  return html`<div class="you-tab">
    <div class="you-card">
      <${Avatar} user=${u} presence />
      <div class="grow"><div class="profile-name">${u.name}</div><div class="faint">@${u.handle}</div></div>
    </div>
    <button class="btn block" style="justify-content:flex-start" onClick=${(e) => openPop({ anchor: e.currentTarget.getBoundingClientRect(), label: 'Presence and status', C: MePop, props: {} })}>
      <${Pres} user=${u} inline /><span class="grow trunc" style="text-align:left">${presenceLabel(u)}${u.status ? `. ${u.status}` : ''}</span><${Icon} name="chev-d" size=${16} />
    </button>
    <div class="you-list">
      ${row('save', 'Saved messages', () => go({ type: 'saved' }), S.saved.length || '')}
      ${row('search', 'Search messages', () => go({ type: 'search', q: '' }))}
      ${row('bell', 'Notifications', () => openLayer({ C: Settings, props: { page: 'notify' } }))}
      ${row('eye', 'Appearance', () => openLayer({ C: Settings, props: { page: 'look' } }))}
      ${row('sliders', 'All settings', () => openLayer({ C: Settings, props: {} }))}
    </div>
  </div>`;
}

function Phone() {
  const tab = S.ui.tab === 'rooms' || S.ui.tab === 'direct' || S.ui.tab === 'you' ? S.ui.tab : 'home';
  const needs = totalNeeds(S);
  const directNeeds = S.dmOrder.reduce((n, d) => n + attention(S, d).needs, 0);
  const houseNeeds = needs - directNeeds - S.invites.length;
  const counts = { home: needs, rooms: houseNeeds, direct: directNeeds, you: 0 };
  const v = S.ui.view;
  const pane = PaneView();
  let body;
  if (tab === 'home') body = html`<${CatchUp} />`;
  else if (tab === 'rooms') {
    body = html`<${TabHead} title="Houses">
      <button class="ib" aria-label="Jump to or search" onClick=${() => openQuick()}><${Icon} name="search" /></button>
    <//><div class="nav-scroll"><${NavHouses} /></div>`;
  } else if (tab === 'direct') {
    body = html`<${TabHead} title="Direct">
      <button class="ib" aria-label="New message" onClick=${() => openModal(NewMessage)}><${Icon} name="compose" /></button>
    <//><div class="nav-scroll"><${NavDirect} /></div>`;
  } else body = html`<${TabHead} title="You" /><${YouTab} />`;

  return html`<div class="phone">
    <div class="screen root" aria-hidden=${S.ui.depth > 0 ? 'true' : undefined}>
      <div class="tab-body">${body}</div>
      ${!isOnline() && html`<div class="conn" role="status"><${Icon} name="offline" size=${16} />Can\u2019t reach Snug. Messages wait and send when it\u2019s back.</div>`}
      <${LiveDock} />
      <nav class="tabs" role="tablist" aria-label="Sections">
        ${TABS.map((t) => html`<button key=${t.id} class="tab" role="tab" aria-selected=${String(tab === t.id)} onClick=${() => setTab(t.id)}>
          <${Icon} name=${t.icon} size=${22} />${t.label}
          ${counts[t.id] > 0 && html`<span class="badge">${counts[t.id]}</span>`}
        </button>`)}
      </nav>
    </div>
    ${S.ui.depth > 0 && html`<div class="screen push" key=${v.type === 'conv' ? v.id : v.type}><${MainView} /></div>`}
    ${pane && html`<div class="screen push" key=${`${S.ui.pane.type}${S.ui.pane.id || ''}`}>${pane}</div>`}
  </div>`;
}

function Overlays() {
  const u = S.ui;
  return html`
    ${u.layer && html`<${u.layer.C} ...${u.layer.props} />`}
    ${u.quick && html`<${QuickJump} />`}
    ${u.modal && html`<${ModalFrame} modal=${u.modal} key=${u.modal.k} />`}
    ${u.pop && html`<${Pop} pop=${u.pop} key=${u.pop.k} />`}
    ${u.menu && html`<${Menu} menu=${u.menu} key=${u.menu.k} />`}
    <${Lightbox} />
    <${Toasts} />`;
}

// The back button and the phone's back gesture close what is open, one layer
// at a time, instead of leaving the app. Each open layer owns one history
// entry, and each entry records how many layers were open when it was made.
let pushed = 0;
function layers() {
  const u = S.ui;
  return (u.phone && u.depth > 0 ? 1 : 0) + (u.pane ? 1 : 0)
    + (u.lightbox || u.menu || u.pop || u.quick || u.modal || u.layer ? 1 : 0);
}
function syncHistory() {
  const want = layers();
  while (pushed < want) history.pushState({ snug: ++pushed }, '');
  if (pushed > want) {
    // Closed from inside the app: step back over the entries it no longer needs.
    history.go(want - pushed);
    pushed = want;
  }
}
addEventListener('popstate', (e) => {
  pushed = e.state?.snug || 0;
  for (let i = 0; i < 4 && layers() > pushed; i++) closeTop();
});

function App() {
  useStore();
  useLayoutEffect(syncHistory);
  const inside = S.auth === 'in' && S.ready;
  // Arrived by an invitation link: offer to join once signed in.
  useEffect(() => {
    if (inside && S.ui.joinCode && !S.ui.modal) openModal(JoinByLink, { code: S.ui.joinCode });
  }, [inside, S.ui.joinCode]);
  if (!inside) {
    document.title = 'Snug';
    if (S.auth === 'out') return html`<${Auth} /><${Toasts} />`;
    return html`<${Splash} unreachable=${S.auth === 'unreachable'} onRetry=${boot} />`;
  }
  const needs = totalNeeds(S);
  document.title = needs ? `(${needs}) Snug` : 'Snug';
  return html`${S.ui.phone ? html`<${Phone} />` : html`<${Desktop} />`}<${Overlays} />`;
}

// Keyboard
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

function navOrder() {
  const out = [...S.dmOrder];
  for (const h of S.houseOrder) {
    const house = S.houses[h];
    out.push(...roomIds(S, h).filter((r) => !house.newcomer || house.starter.includes(r)));
  }
  return out;
}

function step(dir, unreadOnly) {
  const list = navOrder();
  const cur = S.ui.view.type === 'conv' ? list.indexOf(S.ui.view.id) : -1;
  for (let i = 1; i <= list.length; i++) {
    const id = list[(cur + dir * i + list.length * 2) % list.length];
    const a = attention(S, id);
    if (!unreadOnly || a.needs || a.soft) return openConv(id);
  }
  return undefined;
}

function closeTop() {
  const u = S.ui;
  if (u.lightbox) return closeLightbox();
  if (u.menu) return closeMenu();
  if (u.pop) return closePop();
  if (u.quick) return closeQuick();
  if (u.modal) return closeModal();
  if (u.layer) return closeLayer();
  if (u.pane) return closePane();
  if (u.phone && u.depth > 0) return back();
  return false;
}

function onKey(e) {
  if (S.auth !== 'in' || !S.ready) return undefined;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (mod && !e.shiftKey && k.toLowerCase() === 'k') { e.preventDefault(); return S.ui.quick ? closeQuick() : openQuick(); }
  if (mod && e.shiftKey && k.toLowerCase() === 'f') { e.preventDefault(); return go({ type: 'search', q: '' }); }
  // Esc closes the top layer; with nothing to close it marks the open place read,
  // as people expect from other chat apps. Shift+Esc marks the whole house read.
  // Marking everything read is a button in Catch up, never a stray key.
  if (k === 'Escape') {
    if (!e.shiftKey && closeTop() !== false) { e.preventDefault(); return undefined; }
    const conv = S.ui.view.type === 'conv' ? S.ui.view.id : null;
    if (!conv || S.ui.modal || S.ui.layer || S.ui.quick || S.ui.menu || S.ui.pop) return undefined;
    const house = S.rooms[conv]?.house;
    if (e.shiftKey && house) {
      if (houseAttention(S, house).soft || houseAttention(S, house).needs) { e.preventDefault(); markHouseRead(house); }
    } else if (attention(S, conv).soft || attention(S, conv).needs) { e.preventDefault(); markConvRead(conv); }
    return undefined;
  }
  if (S.ui.modal || S.ui.layer || S.ui.quick || S.ui.menu || S.ui.pop) return undefined;
  if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); return step(k === 'ArrowUp' ? -1 : 1, e.shiftKey); }

  const t = e.target;
  // Shift+Tab from the message box goes up into the messages, newest first.
  if (k === 'Tab' && e.shiftKey && t.matches?.('.composer textarea') && !t.value) {
    const last = t.closest('.stream')?.querySelector('.msg[tabindex="0"]');
    if (last) { e.preventDefault(); last.focus(); }
    return undefined;
  }
  if (typing(t) || mod || e.altKey) return undefined;
  if (k === '?') { e.preventDefault(); return openLayer({ C: Settings, props: { page: 'keys' } }); }
  // Start typing anywhere and it goes into the message box.
  if (k.length === 1 && !t.closest?.('.msg, [role="menu"], [role="dialog"]')) {
    const box = document.querySelector('.main .composer textarea');
    if (box) box.focus();
  }
  return undefined;
}

// Boot
const phoneQuery = matchMedia('(max-width: 759px)');
S.ui.phone = phoneQuery.matches;
phoneQuery.addEventListener('change', (e) => { S.ui.phone = e.matches; emit(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', emit);
applyPrefs();
document.addEventListener('keydown', onKey);
initTooltips();
render(html`<${App} />`, document.getElementById('app'));

// Who is this? A valid session opens the app (from the device copy first, so
// it is instant), no session shows sign-in, and no network opens the device
// copy if there is one.
async function boot() {
  const link = /^\/join\/([\w-]{6,40})$/.exec(location.pathname);
  if (link) { S.ui.joinCode = link[1]; history.replaceState(history.state, '', '/'); }
  S.auth = 'checking';
  emit();
  try {
    const r = await api('/api/me');
    S.me = r.user.id;
    S.ice = r.ice;
    S.auth = 'in';
    loadCache(r.user.id);
    startTransport();
  } catch (e) {
    if (e.status === 401) S.auth = 'out';
    else if (loadCache()) { S.auth = 'in'; startTransport(); } else S.auth = 'unreachable';
  }
  emit();
}
boot();
// Exposed for the end-to-end checks and for poking at state in the console.
window.snug = { S, emit, voiceStats };
