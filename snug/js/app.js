// The root. Picks the desktop frame or the phone product, mounts the floating
// layers, and owns the global keyboard map.
import { html, render, useEffect, useLayoutEffect } from '../vendor/preact-htm.js';
import {
  S, emit, useStore, me, go, openConv, back, setTab, closePane, closeMenu, closePop, closeModal, closeLayer,
  closeQuick, closeLightbox, openQuick, openLayer, openModal, openPop, markHouseRead, markConvRead, applyPrefs, convMeta, isOnline, loadCache,
} from './store.js';
import { api, startTransport } from './server.js';
import { voiceStats, toggleMute, toggleDeaf, toggleCamera, leaveVoice } from './voice.js';
import { incoming, acceptCall } from './calls.js';
import { actionFor, actionById } from './lib/keys.js'; // changeable shortcuts (Settings > Keyboard)
import { attention, houseAttention, totalNeeds, roomIds } from './lib/attention.js';
import { friendRequests } from './lib/social.js';
import { Icon } from './ui/icons.js';
import { Avatar, Pres, Tile, Empty, presenceLabel } from './ui/kit.js';
import { Menu, Pop, ModalFrame, Toasts, Lightbox, initTooltips } from './ui/overlays.js';
import { Nav, NavDirect, HouseRooms, LiveDock, houseMenu, syncSpace, goBack, contextPlaces, dmAttention, homeNeeds } from './views/nav.js';
import { Conversation, ThreadPane, DetailsPane } from './views/conversation.js';
import { PinsPane } from './views/media.js'; // pinned messages
import { PeoplePane, MePop } from './views/people.js';
import { CatchUp, Saved } from './views/catchup.js';
import { Search, QuickJump } from './views/search.js';
import { Settings } from './views/settings.js';
import { NewMessage, JoinByLink } from './views/modals.js';
import { Auth, Splash } from './views/auth.js';
import { Home } from './views/home.js';
import { Friends } from './views/friends.js';
import { Discover } from './views/discover.js';
import { PersonPage } from './views/person.js';
import { HousePage } from './views/house.js';
import { IncomingCall } from './views/calls.js'; // calls in direct conversations and groups
import { ringtonePlaying } from './calls.js';
import { MiniCall, afkCheck } from './views/voiceopts.js'; // the floating call while you look elsewhere
import { voiceDebug } from './voiceopts.js';
import { applyAppearance, goIdle, soundsPlayed, soundLog } from './account.js'; // settings that follow you, auto-idle, sounds (js/account.js)
import { openShortcuts, toggleStreamer } from './views/account.js'; // Ctrl+/ and Ctrl+Shift+S
import { openMessageLink } from './views/chat.js'; // message links: /m/<conversation>/<message>
import './inbox.js'; // server unread counts, groups leaving, timed mutes (js/inbox.js)
import './landmarks.js'; // Skip to messages, F6 between regions
import { desktopTest } from './desktop.js'; // the desktop app's badge, global voice keys, idle, snug:// links
import { UpdateStrip } from './views/desktop-settings.js'; // a newer Snug is out

const rectOf = (e) => e.currentTarget.getBoundingClientRect();

// Desktop Messages with no conversation open (there are none yet).
function MessagesEmpty() {
  return html`<section class="main view" aria-label="Messages">
    <header class="bar"><h1 class="bar-title"><${Icon} name="room" />Messages</h1></header>
    <div class="view-body">
      <${Empty} icon="room" title="No conversations yet" text="Write to a friend, or to someone you met in one of your communities. Groups start the same way.">
        <button class="btn primary" onClick=${() => openModal(NewMessage)}><${Icon} name="compose" size=${16} />New message</button>
      <//>
    </div>
  </section>`;
}

// A community on a phone: its rooms first, its front page one tap away.
function PhoneHouse({ id }) {
  const h = S.houses[id];
  if (!h?.joined) return html`<${HousePage} id=${id} />`;
  return html`<section class="main view phone-house" aria-label=${h.name}>
    <header class="bar">
      <button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>
      <h1 class="bar-title"><${Tile} house=${h} /><span class="trunc">${h.name}</span></h1>
      <div class="bar-end">
        <button class="ib" aria-label=${`${h.name} menu`} onClick=${(e) => houseMenu(id, { anchor: rectOf(e) })}><${Icon} name="more" /></button>
      </div>
    </header>
    <div class="nav-scroll"><${HouseRooms} id=${id} /></div>
  </section>`;
}

function MainView() {
  const v = S.ui.view;
  switch (v.type) {
    case 'conv': if (convMeta(v.id)) return html`<${Conversation} key=${v.id} conv=${v.id} />`; break;
    case 'catchup': return html`<${CatchUp} />`;
    case 'saved': return html`<${Saved} />`;
    case 'search': return html`<${Search} />`;
    case 'friends': return html`<${Friends} />`;
    case 'discover': return html`<${Discover} />`;
    case 'person': return html`<${PersonPage} key=${v.id} id=${v.id} />`;
    case 'house': return S.ui.phone && !v.about ? html`<${PhoneHouse} key=${v.id} id=${v.id} />` : html`<${HousePage} key=${v.id} id=${v.id} />`;
    case 'messages': return S.dmOrder.length ? html`<${Home} />` : html`<${MessagesEmpty} />`;
    default: break;
  }
  return html`<${Home} />`;
}

function PaneView() {
  const p = S.ui.pane;
  const v = S.ui.view;
  if (!p) return null;
  if (p.type === 'thread') return html`<${ThreadPane} key=${p.id} tid=${p.id} />`;
  if (v.type !== 'conv') return null;
  if (p.type === 'people') return html`<${PeoplePane} conv=${v.id} />`;
  if (p.type === 'details') return html`<${DetailsPane} conv=${v.id} />`;
  if (p.type === 'pins') return html`<${PinsPane} conv=${v.id} />`;
  return null;
}

function Desktop() {
  const pane = PaneView();
  return html`<div class=${`app${pane ? ' has-pane' : ''}`}>
    <${Nav} />
    <main id="main" class="main-land" aria-label="Main"><${MainView} /></main>
    ${pane}
  </div>`;
}

// The phone is its own product: one screen at a time, tabs where thumbs are.
const TABS = [
  { id: 'home', label: 'Home', icon: 'house' },
  { id: 'messages', label: 'Messages', icon: 'room' },
  { id: 'discover', label: 'Discover', icon: 'compass' },
  { id: 'catchup', label: 'Catch up', icon: 'tray' },
  { id: 'you', label: 'You', icon: 'user' },
];

function TabHead({ title, children }) {
  return html`<header class="bar"><h1 class="bar-title">${title}</h1><div class="bar-end">${children}</div></header>`;
}

function YouTab() {
  const u = isOnline() ? me() : { ...me(), presence: 'offline' };
  const requests = friendRequests(S, 'incoming').length;
  const row = (icon, label, run, end) => html`<button class="row" onClick=${run}><span class="row-ic"><${Icon} name=${icon} /></span><span class="grow">${label}</span>${end && html`<span class="row-end">${end}</span>`}</button>`;
  return html`<div class="you-tab">
    <button class="you-card" onClick=${() => go({ type: 'person', id: S.me })} aria-label=${`${u.name}, open your profile`}>
      <${Avatar} user=${u} presence />
      <span class="grow"><span class="profile-name" style="display:block">${u.name}</span><span class="faint">@${u.handle}</span></span>
      <${Icon} name="chev-r" size=${16} />
    </button>
    <button class="btn block you-status" onClick=${(e) => openPop({ anchor: e.currentTarget.getBoundingClientRect(), label: 'Presence and status', C: MePop, props: {} })}>
      <${Pres} user=${u} inline /><span class="grow trunc" style="text-align:left">${presenceLabel(u)}${u.status ? `. ${u.status}` : ''}</span><${Icon} name="chev-d" size=${16} />
    </button>
    <${LiveDock} />
    <div class="you-list">
      ${row('people', 'Friends', () => go({ type: 'friends' }), requests ? html`<span class="badge">${requests}</span>` : '')}
      ${row('save', 'Saved messages', () => go({ type: 'saved' }), S.saved.length ? html`<span class="faint num">${S.saved.length}</span>` : '')}
      ${row('search', 'Search messages', () => go({ type: 'search', q: '' }))}
      ${row('bell', 'Notifications', () => openLayer({ C: Settings, props: { page: 'notify' } }))}
      ${row('eye', 'Appearance', () => openLayer({ C: Settings, props: { page: 'look' } }))}
      ${row('sliders', 'All settings', () => openLayer({ C: Settings, props: {} }))}
    </div>
  </div>`;
}

function Phone() {
  const tab = TABS.some((t) => t.id === S.ui.tab) ? S.ui.tab : 'home';
  const counts = { home: homeNeeds(), messages: dmAttention().needs, discover: 0, catchup: totalNeeds(S), you: 0 };
  const v = S.ui.view;
  const pane = PaneView();
  let body;
  if (tab === 'home') body = html`<${Home} />`;
  else if (tab === 'messages') {
    body = html`<${TabHead} title="Messages">
      <button class="ib" aria-label="Jump to or search" onClick=${() => openQuick()}><${Icon} name="search" /></button>
      <button class="ib" aria-label="New message" onClick=${() => openModal(NewMessage)}><${Icon} name="compose" /></button>
    <//><div class="nav-scroll"><${NavDirect} /></div>`;
  } else if (tab === 'discover') body = html`<${Discover} />`;
  else if (tab === 'catchup') body = html`<${CatchUp} />`;
  else body = html`<${TabHead} title="You" /><${YouTab} />`;

  return html`<div class="phone">
    <div class="screen root" aria-hidden=${S.ui.depth > 0 ? 'true' : undefined}>
      <div class="tab-body">${body}</div>
      ${!isOnline() && html`<div class="conn" role="status"><${Icon} name="offline" size=${16} />Can\u2019t reach Snug. Messages wait and send when it\u2019s back.</div>`}
      ${tab !== 'you' && html`<${LiveDock} />`}
      <nav class="tabs" role="tablist" aria-label="Sections">
        ${TABS.map((t) => html`<button key=${t.id} class="tab" role="tab" aria-selected=${String(tab === t.id)} onClick=${() => setTab(t.id)}>
          <${Icon} name=${t.icon} size=${22} />${t.label}
          ${counts[t.id] > 0 && html`<span class="badge" aria-label=${`${counts[t.id]} for you`}>${counts[t.id] > 99 ? '99+' : counts[t.id]}</span>`}
        </button>`)}
      </nav>
    </div>
    ${S.ui.depth > 0 && html`<div class="screen push" key=${v.type === 'conv' || v.type === 'house' || v.type === 'person' ? `${v.type}${v.id}` : v.type}><main id="main" class="main-land" aria-label="Main"><${MainView} /></main></div>`}
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
    <${IncomingCall} />
    <${MiniCall} />
    <${UpdateStrip} />
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

// Desktop has no pushed screens, so a Back button (store back()) dropping the
// depth to 0 means "the view before this one".
let lastDepth = 0;
function desktopBack() {
  const was = lastDepth;
  lastDepth = S.ui.depth;
  if (!S.ui.phone && S.auth === 'in' && S.ready && was > 0 && S.ui.depth === 0) goBack();
}

function App() {
  useStore();
  useLayoutEffect(syncHistory);
  useLayoutEffect(desktopBack);
  const inside = S.auth === 'in' && S.ready;
  // Arrived by an invitation link: offer to join once signed in.
  useEffect(() => {
    if (inside && S.ui.joinCode && !S.ui.modal) openModal(JoinByLink, { code: S.ui.joinCode });
  }, [inside, S.ui.joinCode]);
  useEffect(() => {
    if (inside && S.ui.msgLink) { const { conv, id } = S.ui.msgLink; S.ui.msgLink = null; openMessageLink(conv, id); }
  }, [inside, S.ui.msgLink]);
  if (!inside) {
    document.title = 'Snug';
    if (S.auth === 'out') return html`<${Auth} /><${Toasts} />`;
    return html`<${Splash} unreachable=${S.auth === 'unreachable'} onRetry=${boot} />`;
  }
  syncSpace();
  const needs = totalNeeds(S);
  document.title = needs ? `(${needs}) Snug` : 'Snug';
  return html`${S.ui.phone ? html`<${Phone} />` : html`<${Desktop} />`}<${Overlays} />`;
}

// Keyboard
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

// Every conversation, in the order the places come in the rail.
function navOrder() {
  const out = [...S.dmOrder];
  for (const h of S.houseOrder) {
    const house = S.houses[h];
    out.push(...roomIds(S, h).filter((r) => !house.newcomer || house.starter.includes(r)));
  }
  return out;
}

// Alt+Up/Down: the next place in the context column. Alt+Shift+Up/Down: the
// next conversation with something unread, wherever it is.
function step(dir, unreadOnly) {
  if (!unreadOnly) {
    const list = contextPlaces();
    if (!list.length) return undefined;
    const cur = list.findIndex((p) => p.sel);
    const next = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
    return list[next].run();
  }
  const list = navOrder();
  const cur = S.ui.view.type === 'conv' ? list.indexOf(S.ui.view.id) : -1;
  for (let i = 1; i <= list.length; i++) {
    const id = list[(cur + dir * i + list.length * 2) % list.length];
    const a = attention(S, id);
    if (a.needs || a.soft) return openConv(id);
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

// What each changeable shortcut does (js/lib/keys.js names them and holds
// the defaults; Settings > Keyboard changes them). `typing` actions work while
// writing; the rest wait until no layer is open.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const here = () => (S.ui.view.type === 'conv' ? S.ui.view.id : null);
const inCall = () => !!S.call;
const RUN = {
  quick: () => (S.ui.quick ? closeQuick() : openQuick()),
  search: () => go({ type: 'search', q: '' }),
  shortcuts: () => openShortcuts(), // js/views/account.js
  streamer: () => toggleStreamer(),
  prevPlace: () => step(-1, false), nextPlace: () => step(1, false),
  prevUnread: () => step(-1, true), nextUnread: () => step(1, true),
  markRead: () => { const c = here(); if (c && (attention(S, c).soft || attention(S, c).needs)) markConvRead(c); },
  markHouseRead: () => { const h = S.rooms[here()]?.house; if (h && (houseAttention(S, h).soft || houseAttention(S, h).needs)) markHouseRead(h); },
  mute: () => { toggleMute(); if (S.call) announce(S.call.muted ? 'Muted' : 'Unmuted'); },
  deafen: () => { toggleDeaf(); if (S.call) announce(S.call.deaf ? 'Deafened' : 'Hearing again'); },
  camera: () => { toggleCamera()?.then?.(() => S.call && announce(S.call.camera ? 'Camera on' : 'Camera off')); },
  hangup: () => { leaveVoice(); announce('Left the call'); },
  answer: () => { const r = incoming(); if (r) { acceptCall(r.dm); announce('Answered'); } },
};
const READY = { mute: inCall, deafen: inCall, camera: inCall, hangup: inCall, answer: () => !!incoming() };
// A polite live region for what a shortcut just did.
let liveEl = null;
function announce(text) {
  if (!liveEl) { liveEl = document.createElement('div'); liveEl.className = 'sr'; liveEl.setAttribute('role', 'status'); liveEl.setAttribute('aria-live', 'polite'); liveEl.id = 'key-announce'; document.body.append(liveEl); }
  liveEl.textContent = '';
  setTimeout(() => { liveEl.textContent = text; }, 30);
}

function onKey(e) {
  if (S.auth !== 'in' || !S.ready) return undefined;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  const act = e.isComposing ? null : actionFor(e, S.prefs.keys, isMac);
  const layer = S.ui.modal || S.ui.layer || S.ui.quick || S.ui.menu || S.ui.pop || S.ui.lightbox;
  if (act && (!READY[act] || READY[act]())) {
    const a = actionById(act);
    const writing = typing(e.target) && !!e.target.value;
    if ((a.global || !layer) && (a.typing || !writing)) {
      if (act !== 'markHouseRead' || !S.ui.hold[here()]) { e.preventDefault(); RUN[act](); return undefined; }
    }
  }
  // Esc closes the top layer; with nothing to close it marks the open place read,
  // as people expect from other chat apps. Shift+Esc marks the whole house read.
  // Marking everything read is a button in Catch up, never a stray key.
  if (k === 'Escape') {
    if (e.isComposing) return undefined;
    if (!e.shiftKey && closeTop() !== false) { e.preventDefault(); return undefined; }
    const conv = S.ui.view.type === 'conv' ? S.ui.view.id : null;
    if (!conv || S.ui.modal || S.ui.layer || S.ui.quick || S.ui.menu || S.ui.pop || S.ui.lightbox) return undefined;
    // Not while writing a draft, and not over an unread mark you just set yourself.
    if ((typing(e.target) && e.target.value) || S.ui.hold[conv]) return undefined;
    if (!e.shiftKey && (attention(S, conv).soft || attention(S, conv).needs)) { e.preventDefault(); markConvRead(conv); }
    return undefined;
  }
  if (S.ui.modal || S.ui.layer || S.ui.quick || S.ui.menu || S.ui.pop) return undefined;
  // Alt+arrows (places) and the other changeable keys run above (js/lib/keys.js).
  // Back to the previous view: Alt+Left, or Cmd+[ on a Mac. Not while writing,
  // where those keys move the caret.
  if (!S.ui.phone && !typing(e.target) && ((e.altKey && !mod && k === 'ArrowLeft') || (e.metaKey && k === '['))) {
    e.preventDefault();
    goBack();
    return undefined;
  }

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
// Home is where Snug opens, unless you were somewhere else last time.
try { if (!localStorage.getItem('snug.last')) S.ui.view = { type: 'home' }; } catch { S.ui.view = { type: 'home' }; }
const phoneQuery = matchMedia('(max-width: 759px)');
S.ui.phone = phoneQuery.matches;
phoneQuery.addEventListener('change', (e) => { S.ui.phone = e.matches; emit(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', emit);
applyPrefs();
applyAppearance();
document.addEventListener('keydown', onKey);
initTooltips();
render(html`<${App} />`, document.getElementById('app'));

// Who is this? A valid session opens the app (from the device copy first, so
// it is instant), no session shows sign-in, and no network opens the device
// copy if there is one.
async function boot() {
  const link = /^\/join\/([\w-]{3,40})$/.exec(location.pathname); // 3: a house's own link (server/community.js)
  if (link) { S.ui.joinCode = link[1]; history.replaceState(history.state, '', '/'); }
  // A message link, /m/<conversation>/<message>: opened once signed in (js/views/chat.js).
  const ml = /^\/m\/([\w:.-]{1,80})\/([\w.-]{1,80})\/?$/.exec(location.pathname);
  if (ml) { S.ui.msgLink = { conv: ml[1], id: ml[2] }; history.replaceState(history.state, '', '/'); }
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
window.snug = { S, emit, voiceStats, ringtone: ringtonePlaying };
window.snug.voiceDebug = voiceDebug; // voice options (js/voiceopts.js)
window.snug.account = { goIdle, sounds: () => soundsPlayed, soundLog }; // js/account.js
window.snug.toggleStreamer = toggleStreamer; // the desktop app's View > Streamer mode
window.snug.desktop = desktopTest; // js/desktop.js
window.snug.voiceAfk = afkCheck; // leaving a voice room after a while alone (js/views/voiceopts.js)
// Voice and calls track: dropping the socket as a lost connection would, a microphone unplugging,
// the muted note, and the last ringtone played (js/voice.js, js/calls.js).
import('./voice.js').then((v) => import('./calls.js').then((c) => import('./server.js').then((srv) => {
  window.snug.voiceTest = {
    dropSocket: srv.dropSocket, endMic: v.simulateMicEnded, mutedWatch: v.mutedWatch, resetMutedWarn: v.resetMutedWarn,
    lastRing: () => c.lastRing, previewRingtone: c.previewRingtone,
  };
})));
