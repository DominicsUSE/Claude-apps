// The main column for a room or direct conversation, plus the two context
// panes that belong to it: a thread, and the room's details.
import { html } from '../../vendor/preact-htm.js';
import {
  S, person, convMeta, membersOf, togglePane, closePane, back, go,
  toggleFollow, setNotify, openModal, jumpToMsg, findMsg, openConv,
} from '../store.js';
import { levelOf, levelsFor, LEVEL_LABEL, isThread } from '../lib/attention.js';
import { can } from '../lib/perms.js';
import { fmtWhen, plural } from '../lib/util.js';
import { plain } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack, Tile, RoomIcon, Seg, presenceLabel } from '../ui/kit.js';
import { Stream, Message, focusComposer } from './stream.js';
import { RequestBanner } from './safety.js'; // message requests
import { JumpToDate } from './messaging.js'; // go to a date
import { Stage, VoiceControls } from './stage.js'; // the voice stage, shared by voice rooms and calls (voice and calls track)
import { RoomForm, RoomBrowser, Invite } from './modals.js';
import { landingRoom } from '../lib/onboarding.js'; // where a newcomer lands, so the welcome sits there
import { showProfile } from './people.js';
import { PinsButton, pinsOf } from './media.js'; // pinned messages
import { ForumView, StageRoom, RoomPlaces } from './places.js'; // forum and stage rooms; access, follows and nicknames in details
import { CallButtons, CallStrip, CallEndNote } from './calls.js'; // calls in direct conversations and groups
import { notifyMenu, openDrawer, roomMenu, dmMenu } from './nav.js'; // the header's bell, the phone's drawer (shell track)
import { openMenu } from '../store.js';
import { togglePeople } from './people.js'; // the member list toggle, remembered (shell track)
import { DmHeaderButtons, dmHeaderItems } from './dm-manage.js'; // Add people and the members of a group (server/dms.js)
import { DirectLine, KeyBanner, remoteOf, GroupLine, isPeerGroup } from './p2p.js'; // a friend on another PC: how it travels, and a changed security code
import { EncLabel, EncDetail, RoomEncNote } from './e2ee-conv.js'; // end-to-end encryption labels in conversations
import { TtlButton, ttlMenuItem } from './disappear.js'; // 0.12: disappearing messages
import { t } from '../lib/i18n.js'; // words in the chosen language (js/locales)

export { VoiceControls }; // the shell's dock imports it from here (js/views/nav.js)

const Back = () => S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`;

export function Welcome({ house, inPage }) {
  const h = S.houses[house];
  const step = h.firstStep || { room: landingRoom(S, house) || h.starter[0], label: 'Say hello', draft: '' };
  const start = () => {
    if (step.draft && !S.drafts[step.room]) S.drafts[step.room] = step.draft;
    openConv(step.room);
    focusComposer(step.room);
  };
  return html`<div class="welcome">
    ${inPage
      ? html`<div class="welcome-head"><div><span class="welcome-kicker">You’re new here</span><h2>Welcome to ${h.name}. Start with hello.</h2></div></div>`
      : html`<div class="welcome-head"><${Tile} house=${h} lg /><div><span class="welcome-kicker">You’re new here</span><h2>Welcome to ${h.name}</h2><div class="faint">${h.about}</div></div></div>`}
    <p>${h.showAllRooms ? `Every room in ${h.name} is in your list already, and you can read them all now. These are good places to start.` : `You can read every room in ${h.name} now. Your list starts with these and the voice rooms; the rest join it after your first message.`}</p>
    <div class="welcome-rooms">
      ${h.starter.map((id) => html`<button class="welcome-room" key=${id} onClick=${() => openConv(id)}>
        <${RoomIcon} kind=${S.rooms[id].kind} /><span><b>${S.rooms[id].name}</b> <span>${S.rooms[id].topic}</span></span>
      </button>`)}
    </div>
    <div class="welcome-acts">
      <button class="btn primary" onClick=${start}>${step.label}</button>
      <button class="btn" onClick=${() => openModal(RoomBrowser, { house })}>Look around first</button>
    </div>
  </div>`;
}

function Intro({ conv, meta }) {
  const empty = !(S.msgs[conv] || []).length;
  if (meta.room) {
    const h = S.houses[meta.house];
    const welcome = h.newcomer && landingRoom(S, meta.house) === conv;
    return html`
      ${welcome && html`<${Welcome} house=${meta.house} />`}
      <div class="start">
        <span class="start-mark" aria-hidden="true"><${RoomIcon} kind=${meta.kind} size=${28} /></span>
        <h2>${meta.title}</h2>
        <p>${meta.topic ? `${meta.topic}. ` : ''}${empty ? 'Nothing has been said here yet. Start the conversation below.' : `This is where ${meta.title} begins.`}</p>
        ${empty && (can(S, meta.house, 'invite') || can(S, meta.house, 'rooms')) && html`<div class="acts">
          ${can(S, meta.house, 'invite') && html`<button class="btn primary" onClick=${() => openModal(Invite, { house: meta.house })}><${Icon} name="user-plus" size=${16} />Invite people</button>`}
          ${can(S, meta.house, 'rooms') && html`<button class="btn" onClick=${() => openModal(RoomForm, { room: conv })}><${Icon} name="edit" size=${16} />Edit room</button>`}
        </div>`}
        ${empty && can(S, meta.house, 'invite') && Object.keys(h.members || {}).length < 2 && html`<p class="faint start-invite-note">It\u2019s just you so far. Send your people the invitation link so they can join.</p>`}
      </div>`;
  }
  return html`<div class="start">
    ${meta.user && html`<span class="start-mark" aria-hidden="true"><${Avatar} user=${meta.user} size=${56} /></span>`}
    <h2>${meta.title}</h2>
    <p>${meta.user
      ? `This is the start of your conversation with ${meta.user.name.split(' ')[0]}. Only the two of you are in it.`
      : `A group of ${meta.dm.members.length}. Only the people in it can see it here.`}${empty ? ' Say hello to start the conversation.' : ''}</p>
  </div>`;
}

// Phone header (shell track): what does not fit beside the title goes here.
function headerMore(conv, meta, level, anchor) {
  openMenu({
    anchor,
    items: [
      ...(meta.dm ? dmHeaderItems(conv, anchor) : []),
      pinsOf(conv).length > 0 && { label: `Pinned messages (${pinsOf(conv).length})`, icon: 'pin', onSelect: () => togglePane('pins') },
      ttlMenuItem(conv),
      { label: level === 'muted' ? 'Notifications (muted)' : 'Notifications', icon: level === 'muted' ? 'bell-off' : 'bell', onSelect: () => setTimeout(() => notifyMenu(conv, { anchor }), 0) },
      // Go to a date opens its own popover from the (hidden) calendar button beside this menu's button.
      { label: 'Go to a date', icon: 'calendar', onSelect: goToDate },
      { label: 'Search here', icon: 'search', onSelect: () => go({ type: 'search', q: `in:"${meta.title.toLowerCase()}" ` }) },
      { label: 'Details', icon: 'info', onSelect: () => togglePane('details') },
    ],
  });
}

// Desktop header: the room's More menu starts with what moved out of the bar
// (brief 15: notifications, members, search and more stay in it).
const goToDate = () => setTimeout(() => document.querySelector('.main .bar .bar-date-src button')?.click(), 0);
function barMoreItems(conv, meta, pane) {
  return [
    !isThread(conv) && { label: 'Go to a date', icon: 'calendar', onSelect: goToDate },
    !isThread(conv) && ttlMenuItem(conv),
    meta.room && { label: pane === 'details' ? 'Hide details' : 'Details', icon: 'info', onSelect: () => togglePane('details') },
    { sep: true },
  ];
}

// "2 of 5 others online", never "0 here", which read as if nobody was in it.
const onlineNote = (on, others, inVoice) => `${others > 0 ? `${on} of ${others} ${others === 1 ? 'other' : 'others'} online` : 'just you'}${inVoice ? `, ${inVoice} in voice` : ''}`;

export function Conversation({ conv }) {
  const meta = convMeta(conv);
  if (!meta) return null;
  const pane = S.ui.pane?.type;
  const members = membersOf(conv).map((id) => S.users[id]);
  const here = members.filter((u) => u.presence !== 'offline' && u.id !== S.me);
  const first = meta.user?.name.split(' ')[0];
  const inVoice = meta.room ? (S.voice[conv] || []).length : 0;
  const level = levelOf(S, conv);
  const phone = S.ui.phone;
  // In a live voice room or call the stage takes the room; an empty chat folds away.
  const live = S.call?.room === conv && (meta.kind === 'voice' || !!meta.dm);
  const chatEmpty = !(S.msgs[conv] || []).some((m) => !m.call);
  return html`<section class=${`main conv kind-${meta.kind}${live ? ' voice-live' : ''}${live && chatEmpty ? ' chat-empty' : ''}`} aria-label=${meta.title}>
    <header class="bar">
      <${Back} />
      <h1 class="bar-title trunc">
        ${meta.user ? html`<${Avatar} user=${meta.user} size=${24} presence />` : meta.room ? html`<${RoomIcon} kind=${meta.kind} />` : html`<${Icon} name="people" />`}
        <span class="trunc">${meta.title}</span>
      </h1>
      ${meta.dm && html`<${EncLabel} conv=${conv} onOpen=${() => togglePane('details')} />`}
      ${phone && meta.house && html`<button class="ib drawer-btn title-switch" aria-label="Rooms and places" data-tip="Rooms and places" onClick=${openDrawer}><${Icon} name="chev-d" size=${16} /></button>`}
      ${meta.topic && html`<span class="bar-sub trunc">${meta.topic}</span>`}
      ${meta.user && html`<span class="bar-sub trunc">${presenceLabel(meta.user)}${meta.user.status ? `. ${meta.user.status}` : ''}</span>`}
      ${meta.dm && !phone && remoteOf(conv) && html`<${DirectLine} conv=${conv} />`}
      ${meta.dm && !phone && isPeerGroup(conv) && html`<${GroupLine} conv=${conv} />`}
      <div class="bar-end">
        <${TtlButton} conv=${conv} />
        ${meta.dm && html`<${CallButtons} conv=${conv} />`}
        ${meta.dm && !phone && html`<${DmHeaderButtons} conv=${conv} />`}
        ${!phone && html`<${PinsButton} conv=${conv} />`}
        ${!phone && html`<button class=${`ib${level === 'muted' ? ' is-muted' : ''}`} aria-label="Notifications" aria-haspopup="menu" data-tip=${level === 'muted' ? 'Muted' : 'Notifications'}
          onClick=${(e) => notifyMenu(conv, { anchor: e.currentTarget.getBoundingClientRect() })}><${Icon} name=${level === 'muted' ? 'bell-off' : 'bell'} /></button>`}
        <span class="bar-date-src" aria-hidden="true"><${JumpToDate} conv=${conv} /></span>
        ${!meta.user && !(phone && meta.dm) && html`<button class=${`ib${pane === 'people' ? ' on' : ''}`} aria-pressed=${String(pane === 'people')} aria-label=${`People, ${onlineNote(here.length, members.length - 1, inVoice)}`}
          data-tip=${pane === 'people' ? 'Hide the member list' : `Show the member list (${onlineNote(here.length, members.length - 1, inVoice)})`} onClick=${togglePeople}><${Icon} name="people" /></button>`}
        ${phone
          ? html`<button class="ib" aria-label="More" aria-haspopup="menu" data-tip="More" onClick=${(e) => headerMore(conv, meta, level, e.currentTarget.getBoundingClientRect())}><${Icon} name="more-v" /></button>`
          : html`${!meta.room && html`<button class=${`ib${pane === 'details' ? ' on' : ''}`} aria-pressed=${String(pane === 'details')} aria-label="Details" data-tip="Details and notifications" onClick=${() => togglePane('details')}><${Icon} name="info" /></button>`}
            <button class="ib bar-more" aria-label="More options" aria-haspopup="menu" data-tip="More" onClick=${(e) => (meta.room ? roomMenu : dmMenu)(conv, { anchor: e.currentTarget.getBoundingClientRect() }, barMoreItems(conv, meta, pane))}><${Icon} name="more" /></button>
            <button class="bar-search" aria-label=${`Search in ${meta.title}`} onClick=${() => go({ type: 'search', q: `in:"${meta.title.toLowerCase()}" ` })}>
              <span class="bar-search-text trunc">Search ${meta.room ? meta.title : ''}</span><${Icon} name="search" size=${16} />
            </button>`}
      </div>
    </header>
    ${meta.kind === 'voice' && html`<${Stage} roomId=${conv} />`}
    ${meta.kind === 'stage' && html`<${StageRoom} conv=${conv} />`}
    ${meta.dm && (S.call?.room === conv
      ? html`<${Stage} roomId=${conv} dm />`
      : html`<${CallStrip} conv=${conv} /><${CallEndNote} conv=${conv} />`)}
    ${meta.dm && html`<${RequestBanner} conv=${conv} />`}
    ${meta.dm && html`<${KeyBanner} conv=${conv} />`}
    ${meta.kind === 'forum' ? html`<${ForumView} key=${conv} conv=${conv} />` : html`<${Stream} key=${conv} conv=${conv} intro=${html`<${Intro} conv=${conv} meta=${meta} />`}
      placeholder=${t('composer.messageTo', { name: meta.user ? first : `${meta.room && meta.kind === 'text' ? '#' : ''}${meta.title}` })} short=${t('composer.messageShort')} />`}
  </section>`;
}

export function ThreadPane({ tid }) {
  const meta = convMeta(tid);
  const thread = S.threads[tid];
  if (!meta || !thread) return null;
  const n = (S.msgs[tid] || []).length;
  const following = !!S.followed[tid];
  const intro = html`
    ${meta.root
      ? html`<${Message} conv=${thread.conv} m=${meta.root} inThread />`
      : html`<div class="older-msg">The message this thread started from was deleted.</div>`}
    <div class="thread-count">${n ? plural(n, 'reply', 'replies') : 'No replies yet. Yours will be the first.'}</div>`;
  return html`<aside class="pane thread-pane" aria-label="Thread">
    <header class="bar">
      ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${closePane}><${Icon} name="back" /></button>`}
      <h1 class="bar-title"><${Icon} name="thread" />Thread</h1>
      <span class="bar-sub trunc">${meta.where}</span>
      <div class="bar-end">
        <button class=${`ib${following ? ' on' : ''}`} aria-pressed=${String(following)} aria-label=${following ? 'Stop following this thread' : 'Follow this thread'}
          data-tip=${following ? 'Following. New replies reach Catch up.' : 'Follow to hear about new replies'} onClick=${() => toggleFollow(tid)}><${Icon} name=${following ? 'bell' : 'bell-off'} /></button>
        ${!S.ui.phone && html`<button class="ib" aria-label="Close thread" data-tip="Close" data-key="Esc" onClick=${closePane}><${Icon} name="x" /></button>`}
      </div>
    </header>
    <${Stream} key=${tid} conv=${tid} intro=${intro} placeholder=${t('composer.replyThread')} short=${t('composer.replyShort')} />
  </aside>`;
}

const LEVEL_HINT = {
  all: 'A dot for anything new, a number when something needs you.',
  mentions: 'Stays quiet unless you’re mentioned, replied to, or a thread you follow moves.',
  muted: 'No dots, no numbers, no pop-ups. Messages are still here when you visit.',
};

export function NotifyControl({ kind, id, level }) {
  const options = levelsFor(S, kind, id).map((l) => [l, LEVEL_LABEL[l]]);
  return html`<${Seg} label="Notify me about" value=${level} options=${options} onChange=${(l) => setNotify(kind, id, l)} />`;
}

export function DetailsPane({ conv }) {
  const meta = convMeta(conv);
  if (!meta) return null;
  const room = meta.room;
  const level = levelOf(S, conv);
  const files = (S.msgs[conv] || []).flatMap((m) => (m.files || []).map((f) => ({ f, m }))).reverse().slice(0, 8);
  const highlights = room ? room.highlights.map((id) => findMsg(conv, id)).filter(Boolean) : [];
  return html`<aside class="pane" aria-label="Details">
    <header class="bar">
      ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${closePane}><${Icon} name="back" /></button>`}
      <h1 class="bar-title">Details</h1>
      <div class="bar-end">${!S.ui.phone && html`<button class="ib" aria-label="Close details" data-tip="Close" data-key="Esc" onClick=${closePane}><${Icon} name="x" /></button>`}</div>
    </header>
    <div class="pane-body pad">
      <div class="detail">
        ${room
          ? html`<h2 style="display:flex;gap:8px;align-items:center"><${RoomIcon} kind=${room.kind} />${room.name}</h2>
              <p class="sub">${room.topic || 'No description yet.'}</p>
              <p class="faint">In ${S.houses[room.house].name}</p>
              ${(can(S, room.house, 'rooms') || room.perms?.manage) && html`<div><button class="btn" onClick=${() => openModal(RoomForm, { room: conv })}><${Icon} name="edit" size=${16} />Edit room</button></div>`}
              <${RoomPlaces} conv=${conv} />
              <${RoomEncNote} />`
          : meta.user
            ? html`<button class="person" style="margin:0 -8px;width:calc(100% + 16px)" onClick=${(e) => showProfile(meta.user, e.currentTarget.getBoundingClientRect())}>
                <${Avatar} user=${meta.user} presence /><span class="grow"><span class="person-name" style="display:block">${meta.user.name}</span><span class="person-sub" style="display:block">${presenceLabel(meta.user)}</span></span>
              </button>`
            : html`<h2>${meta.title}</h2><p class="sub">${meta.dm.members.map((id) => S.users[id].name.split(' ')[0]).join(', ')}</p>`}
      </div>
      ${meta.dm && html`<${EncDetail} dm=${meta.dm} />`}
      <div class="detail">
        <h3>Notify me about</h3>
        <${NotifyControl} kind=${room ? 'room' : 'dm'} id=${conv} level=${level} />
        <p class="hint" style="margin:0">${LEVEL_HINT[level]}${room && !room.notify ? ` Same as the rest of ${S.houses[room.house].name}.` : ''}</p>
      </div>
      ${room && html`<div class="detail">
        <h3>Highlights</h3>
        ${highlights.length
          ? highlights.map((m) => html`<button class="hl" key=${m.id} onClick=${() => jumpToMsg(conv, m.id)}>
              <span class="hl-meta">${person(m.author).name}, ${fmtWhen(m.ts)}</span>
              <span class="hl-text">${plain(m.text)}</span>
            </button>`)
          : html`<p class="sub">Nothing highlighted yet. ${can(S, room.house, 'highlight') ? 'Open a message’s menu and choose Add to room highlights.' : 'People who look after this room can pin the messages worth keeping.'}</p>`}
      </div>`}
      <div class="detail">
        <h3>Files</h3>
        ${files.length
          ? files.map(({ f, m }, i) => html`<button class="hl" key=${i} onClick=${() => jumpToMsg(conv, m.id)}>
              <span style="display:flex;gap:8px;align-items:center"><${Icon} name=${f.kind === 'image' ? 'image' : 'file'} size=${16} /><span class="trunc">${f.name}</span></span>
              <span class="hl-meta">${person(m.author).name}, ${fmtWhen(m.ts)}</span>
            </button>`)
          : html`<p class="sub">No files have been shared here.</p>`}
      </div>
    </div>
  </aside>`;
}
