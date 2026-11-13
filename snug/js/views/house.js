// A community's front page. "This is a place": who is here now, what is
// happening, what is planned, its rooms and its people. For a house you are
// not in yet, the same page from the doorstep, with a way in.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import {
  S, back, go, openConv, openModal, openLayer, previewHouse, joinPublicHouse, joinHouse, declineInvite, toast, person,
} from '../store.js';
import { can, roleOf } from '../lib/perms.js';
import { roomIds, unreadOf } from '../lib/attention.js';
import { eventState } from '../lib/social.js';
import { plain } from '../lib/format.js';
import { plural, hueOf, fmtWhen, nameList, MIN } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack, RoomIcon, Empty } from '../ui/kit.js';
import { Loading } from '../ui/brand.js';
import { Welcome } from './conversation.js';
import { Invite, RoomBrowser } from './modals.js';
import { HouseSettings } from './settings.js';
import { houseMenu } from './nav.js';
import { showProfile } from './people.js';
import { joinVoice } from '../voice.js';
import { leavingCall } from '../calls.js';
import { EventList, EventRow, upcomingFor, useNow, canPlan, openCreateEvent } from './events.js';

const rectOf = (e) => e.currentTarget.getBoundingClientRect();
const offline = (e) => (e?.offline ? 'You’re offline. Try again once you’re back.' : e?.message);
const rulesOf = (text) => (text || '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
const first = (name) => (name || '').split(' ')[0];

// ---------- Pieces shared by the member and visitor pages ----------

// The house's icon clipped to the arch when it has one (server/community.js),
// over its mark and hue, which show if the picture can't load.
function Arch({ house }) {
  return html`<span class=${`pl-arch${house.icon ? ' pic' : ''}`} style=${`--hue:${hueOf(house.hue)}`} aria-hidden="true">${house.mark}${house.icon
    ? html`<img src=${`/api/housepics/${house.icon}`} alt="" decoding="async" onError=${(e) => e.currentTarget.remove()} />` : null}</span>`;
}

// "here" never counts you. At zero there is no green dot: nobody else is around.
function Counts({ here, voice, members, member }) {
  return html`<p class="pl-counts">
    ${here > 0 ? html`<span><i class="pres inline open" aria-hidden="true"></i><b class="num">${here}</b> here now</span>`
      : html`<span>${member ? 'Just you right now' : 'Quiet right now'}</span>`}
    ${voice > 0 && html`<span class="pl-live"><${Icon} name="voice" size=${16} /><b class="num">${voice}</b> in voice</span>`}
    <span><b class="num">${members}</b> ${members === 1 ? 'member' : 'members'}</span>
  </p>`;
}

// The events page's side column: the last few that are over, compact.
function PastEvents({ house }) {
  const now = useNow();
  const past = Object.values(S.events || {}).filter((e) => e.house === house && eventState(e, now) === 'past')
    .sort((a, b) => b.starts - a.starts).slice(0, 5);
  return html`<section class="pl-sect" aria-labelledby="pl-past">
    <div class="pl-head"><h2 id="pl-past">Past</h2>${past.length > 0 && html`<span class="count num">${past.length}</span>`}</div>
    ${past.length
      ? html`<div class="ev-rows">${past.map((e) => html`<${EventRow} key=${e.id} ev=${e} compact />`)}</div>`
      : html`<p class="pl-note">Finished events show up here.</p>`}
  </section>`;
}

function Band({ house, topic, isPublic, here, voice, members, member, children }) {
  return html`<header class="pl-band" style=${`--hue:${hueOf(house.hue)}`}>
    <${Arch} house=${house} />
    <div class="pl-id">
      <div class="pl-kicker">
        ${topic && html`<span class="pl-topic">${topic}</span>`}
        <span>${isPublic ? 'Open to everyone' : 'Invitation only'}</span>
      </div>
      <h1 class="pl-name">${house.name}</h1>
      ${house.about && html`<p class="pl-about">${house.about}</p>`}
      <${Counts} here=${here} voice=${voice} members=${members} member=${member} />
    </div>
    ${children && html`<div class="pl-acts">${children}</div>`}
  </header>`;
}

function Rules({ text, open: start }) {
  const rules = rulesOf(text);
  const [open, setOpen] = useState(!!start);
  return html`<section class="pl-sect" aria-labelledby="pl-rules">
    <button class="pl-toggle" aria-expanded=${String(open)} aria-controls="pl-rules-list" onClick=${() => setOpen(!open)}>
      <h2 id="pl-rules">House rules</h2>
      ${rules.length > 0 && html`<span class="count num">${rules.length}</span>`}
      <span class=${`pl-chev${open ? '' : ' shut'}`}><${Icon} name="chev-d" size=${16} /></span>
    </button>
    ${open && (rules.length
      ? html`<ol class="pl-rules" id="pl-rules-list">${rules.map((r, i) => html`<li key=${i}>${r}</li>`)}</ol>`
      : html`<p class="pl-note" id="pl-rules-list">No written rules. Be kind; the people who run it will say if something’s off.</p>`)}
  </section>`;
}

function Bar({ house, title, children }) {
  return html`<header class="bar">
    ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`}
    <h1 class="bar-title trunc">${title}</h1>
    ${house && html`<span class="bar-sub trunc">${house.name}</span>`}
    <div class="bar-end">${children}</div>
  </header>`;
}

// ---------- A house you are in ----------

function voiceIn(id) {
  return roomIds(S, id).filter((r) => (S.rooms[r]?.kind === 'voice' || S.rooms[r]?.kind === 'stage') && (S.voice[r] || []).length)
    .map((r) => ({ room: S.rooms[r], people: S.voice[r].map((u) => S.users[u]).filter(Boolean) }))
    .sort((a, b) => b.people.length - a.people.length);
}

function Happening({ id, now }) {
  const voice = voiceIn(id);
  const live = upcomingFor(id, now).filter((e) => eventState(e, now) === 'now');
  if (!voice.length && !live.length) return null;
  return html`<section class="pl-sect pl-happening" aria-labelledby="pl-now">
    <div class="pl-head"><h2 id="pl-now"><i class="pl-pulse" aria-hidden="true"></i>Happening now</h2></div>
    <div class="pl-now-list">
      ${voice.map(({ room, people }) => {
        const inIt = S.call?.room === room.id;
        const speaking = people.filter((u) => S.speaking[u.id]).length;
        return html`<div class="pl-voice" key=${room.id}>
          <button class="pl-voice-main" onClick=${() => openConv(room.id)} aria-label=${`${room.name}, ${plural(people.length, 'person', 'people')} in voice. Open the room`}>
            <span class="pl-voice-name"><${Icon} name="voice" size=${16} />${room.name}</span>
            <span class="pl-voice-faces"><${Stack} users=${people} max=${5} size=${28} /></span>
            <span class="pl-voice-sub">${speaking ? `${nameList(people.filter((u) => S.speaking[u.id]).map((u) => first(u.name)))} talking` : `${nameList(people.map((u) => (u.id === S.me ? 'You' : first(u.name))))}`}</span>
          </button>
          ${inIt
            ? html`<span class="pl-in">You’re in</span>`
            : html`<button class="btn" onClick=${() => leavingCall(room.id, () => { openConv(room.id); joinVoice(room.id); })}><${Icon} name="voice" size=${16} />Join</button>`}
        </div>`;
      })}
      ${live.map((e) => html`<${EventRow} key=${e.id} ev=${e} compact />`)}
    </div>
  </section>`;
}

function activity(r, now) {
  const list = (S.msgs[r] || []).filter((m) => !m.state);
  const last = list[list.length - 1];
  const talking = new Set(list.filter((m) => m.ts > now - 15 * MIN).map((m) => m.author)).size;
  return { last, talking };
}

function RoomLine({ id, now }) {
  const r = S.rooms[id];
  const { last, talking } = activity(id, now);
  const people = (S.voice[id] || []).map((u) => S.users[u]).filter(Boolean);
  const u = unreadOf(S, id);
  const typing = (S.typing[id] || []).filter((x) => x !== S.me).length;
  let act = null;
  if (people.length) act = html`<span class="pl-room-act live"><${Stack} users=${people} max=${3} size=${20} /><span class="num">${people.length} in voice</span></span>`;
  else if (typing) act = html`<span class="pl-room-act"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>typing</span></span>`;
  else if (talking > 1) act = html`<span class="pl-room-act warm"><span><span class="num">${talking}</span> talking</span></span>`;
  else if (last) act = html`<span class="pl-room-act faint num">${fmtWhen(last.ts, now)}</span>`;
  const preview = last
    ? html`<b>${last.author === S.me ? 'You' : first(person(last.author).name)}</b> ${plain(last.text) || 'shared a file'}`
    : r.topic || 'Nothing said yet.';
  return html`<button class=${`pl-room${u.count ? ' unread' : ''}`} onClick=${() => openConv(id)}>
    <span class="pl-room-ic"><${RoomIcon} kind=${r.kind} /></span>
    <span class="pl-room-main">
      <span class="pl-room-name">${r.name}${u.count > 0 && html`<i class="dot" aria-label="Unread"></i>`}</span>
      <span class="pl-room-last trunc">${preview}</span>
    </span>
    ${act}
  </button>`;
}

// Desktop: the context column already lists every room, so the page shows
// only where it's busiest. Phone has no column, so it keeps the full list.
function busiest(id, now) {
  const h = S.houses[id];
  const ids = roomIds(S, id).filter((r) => !h.newcomer || h.starter.includes(r));
  const score = (r) => { const a = activity(r, now); return [(S.voice[r] || []).length, a.talking, a.last?.ts || 0]; };
  return ids.map((r) => [r, score(r)])
    .sort((a, b) => (b[1][0] - a[1][0]) || (b[1][1] - a[1][1]) || (b[1][2] - a[1][2]))
    .slice(0, 3).map(([r]) => r);
}

function Rooms({ id, now }) {
  const h = S.houses[id];
  if (!S.ui.phone) {
    const top = busiest(id, now);
    if (!top.length) return null;
    return html`<section class="pl-sect" aria-labelledby="pl-rooms">
      <div class="pl-head"><h2 id="pl-rooms">Busiest rooms</h2>
        ${can(S, id, 'rooms') && html`<button class="btn quiet" onClick=${() => openModal(RoomBrowser, { house: id })}>Browse all</button>`}
      </div>
      <div class="pl-group">${top.map((r) => html`<${RoomLine} key=${r} id=${r} now=${now} />`)}</div>
    </section>`;
  }
  const hidden = h.newcomer ? roomIds(S, id).length - h.starter.length : 0;
  return html`<section class="pl-sect" aria-labelledby="pl-rooms">
    <div class="pl-head"><h2 id="pl-rooms">Rooms</h2><span class="count num">${roomIds(S, id).length}</span>
      ${can(S, id, 'rooms') && html`<button class="btn quiet" onClick=${() => openModal(RoomBrowser, { house: id })}>Browse all</button>`}
    </div>
    ${h.groups.map((g) => {
      const rooms = h.newcomer ? g.rooms.filter((r) => h.starter.includes(r)) : g.rooms;
      if (!rooms.length) return null;
      return html`<div class="pl-group" key=${g.id}>
        <h3 class="pl-group-name">${g.name}</h3>
        ${rooms.map((r) => html`<${RoomLine} key=${r} id=${r} now=${now} />`)}
      </div>`;
    })}
    ${hidden > 0 && html`<button class="pl-more-rooms" onClick=${() => openModal(RoomBrowser, { house: id })}>
      <${Icon} name="chev-r" size=${16} /><span><b>${plural(hidden, 'more room')}</b> open after your first message. Have a look now.</span>
    </button>`}
  </section>`;
}

const RANK = { open: 0, around: 1, focus: 2, away: 3, offline: 4 };

function Members({ id }) {
  const h = S.houses[id];
  const [all, setAll] = useState(false);
  const pos = (u) => h.roles.findIndex((r) => r.id === h.members[u.id]);
  const people = Object.keys(h.members).map((u) => S.users[u]).filter(Boolean)
    .sort((a, b) => (RANK[a.presence] - RANK[b.presence]) || (pos(a) - pos(b)) || a.name.localeCompare(b.name));
  const online = people.filter((u) => u.id !== S.me && u.presence !== 'offline').length;
  const shown = all ? people : people.slice(0, 8);
  return html`<section class="pl-sect" aria-labelledby="pl-members">
    <div class="pl-head"><h2 id="pl-members">Members</h2><span class="count num">${people.length}</span><span class="pl-head-note num">${online ? `${online} online` : 'Just you online'}</span></div>
    <ul class="pl-people">
      ${shown.map((u) => {
        const role = roleOf(S, id, u.id);
        const showRole = role && (role.hue != null || h.roles[0].id === role.id);
        return html`<li key=${u.id}><button class="pl-person" onClick=${(e) => showProfile(u, rectOf(e), id)}>
          <${Avatar} user=${u} size=${32} presence />
          <span class="grow trunc">${u.id === S.me ? `${u.name} (you)` : u.name}</span>
          ${showRole && html`<span class=${`pl-role${role.hue != null ? ' hued' : ''}`} style=${role.hue != null ? `--hue:${hueOf(role.hue)}` : ''}>${role.name}</span>`}
        </button></li>`;
      })}
    </ul>
    ${people.length > 8 && html`<button class="btn quiet pl-more" aria-expanded=${String(all)} onClick=${() => setAll(!all)}>
      ${all ? 'Show fewer' : `Show all ${people.length}`}
    </button>`}
  </section>`;
}

function MemberPage({ id, events }) {
  const now = useNow();
  const h = S.houses[id];
  const members = Object.keys(h.members).filter((u) => S.users[u]);
  const here = members.filter((u) => u !== S.me && S.users[u].presence !== 'offline').length;
  const voice = roomIds(S, id).reduce((n, r) => n + (S.voice[r] || []).length, 0);
  const owner = can(S, id, 'roles');
  const settings = () => openLayer({ C: HouseSettings, props: { house: id } });
  const actions = html`
    ${can(S, id, 'invite') && html`<button class="ib" aria-label=${`Invite people to ${h.name}`} data-tip="Invite people" onClick=${() => openModal(Invite, { house: id })}><${Icon} name="user-plus" /></button>`}
    ${owner && html`<button class="ib" aria-label="House settings" data-tip="House settings" onClick=${settings}><${Icon} name="sliders" /></button>`}
    <button class="ib" aria-label=${`${h.name} menu`} aria-haspopup="menu" data-tip="More" onClick=${(e) => houseMenu(id, { anchor: rectOf(e) })}><${Icon} name="more" /></button>`;

  if (events) {
    return html`<section class="main view pl-page" aria-label=${`Events in ${h.name}`}>
      <${Bar} house=${h} title=${html`<${Icon} name="calendar" />Events`}>${actions}<//>
      <div class="view-body"><div class="pl-cols pl-events">
        <p class="pl-lead pl-span">${canPlan(id) ? `Plan something and everyone in ${h.name} can say they’re coming.` : `What’s planned in ${h.name}. Say you’re going and the people running it know who to expect.`}</p>
        <div class="pl-main"><${EventList} house=${id} title="Coming up" /></div>
        <aside class="pl-aside" aria-label="Past events"><${PastEvents} house=${id} /></aside>
      </div></div>
    </section>`;
  }

  return html`<section class="main view pl-page" aria-label=${h.name}>
    <${Bar} title=${html`<${Icon} name="house" />About`} house=${h}>${actions}<//>
    <div class="view-body">
      <${Band} house=${h} topic=${h.topic} isPublic=${h.public} here=${here} voice=${voice} members=${members.length} member>
        ${can(S, id, 'invite') && html`<button class="btn" onClick=${() => openModal(Invite, { house: id })}><${Icon} name="user-plus" size=${16} />Invite people</button>`}
        ${owner && html`<button class="btn quiet" onClick=${settings}><${Icon} name="sliders" size=${16} />Settings</button>`}
      <//>
      ${h.newcomer && html`<div class="pl-welcome"><${Welcome} house=${id} inPage /></div>`}
      <div class="pl-cols">
        <div class="pl-main">
          <${Happening} id=${id} now=${now} />
          <${EventList} house=${id} limit=${3} skipLive />
          <${Rooms} id=${id} now=${now} />
        </div>
        <aside class="pl-aside" aria-label="About this house">
          <${Rules} text=${h.rules} open=${h.newcomer} />
          <${Members} id=${id} />
        </aside>
      </div>
    </div>
  </section>`;
}

// ---------- From the doorstep ----------

// Invited: the house is already known (its rooms and members came with the invitation).
function InvitedPage({ id }) {
  const h = S.houses[id];
  const inv = S.invites.find((i) => i.house === id);
  const [busy, setBusy] = useState(false);
  const members = Object.keys(h.members || {}).filter((u) => S.users[u]);
  const here = members.filter((u) => S.users[u].presence !== 'offline').length;
  const voice = roomIds(S, id).reduce((n, r) => n + (S.voice[r] || []).length, 0);
  const join = () => { setBusy(true); joinHouse(id).catch((e) => { setBusy(false); toast(offline(e)); }); };
  return html`<section class="main view pl-page" aria-label=${h.name}>
    <${Bar} title=${html`<${Icon} name="house" />${h.name}`} />
    <div class="view-body">
      <${Band} house=${h} topic=${h.topic} isPublic=${h.public} here=${here} voice=${voice} members=${members.length}>
        <button class="btn primary" disabled=${busy} aria-busy=${String(busy)} onClick=${join}>${busy ? 'Joining…' : `Join ${h.name}`}</button>
        ${inv && html`<button class="btn quiet" onClick=${() => { declineInvite(id); back(); }}>Not now</button>`}
        ${inv && html`<span class="pl-note">${first(person(inv.from).name)} invited you.</span>`}
      <//>
      <div class="pl-cols">
        <div class="pl-main">
          <section class="pl-sect" aria-labelledby="pl-start">
            <div class="pl-head"><h2 id="pl-start">You’ll start with ${plural(h.starter.length, 'room')}</h2></div>
            ${h.starter.filter((r) => S.rooms[r]).map((r) => html`<div class="pl-room static" key=${r}>
              <span class="pl-room-ic"><${RoomIcon} kind=${S.rooms[r].kind} /></span>
              <span class="pl-room-main"><span class="pl-room-name">${S.rooms[r].name}</span><span class="pl-room-last trunc">${S.rooms[r].topic}</span></span>
            </div>`)}
            <p class="pl-note">The other ${plural(Math.max(0, roomIds(S, id).length - h.starter.length), 'room')} open once you’ve said hello.</p>
          </section>
        </div>
        <aside class="pl-aside"><${Rules} text=${h.rules} open /></aside>
      </div>
    </div>
  </section>`;
}

// Public: everything comes from a preview the server makes for visitors.
const previews = new Map();

function PublicPage({ id }) {
  // Keyed by account too, so a preview never carries over to the next person who signs in.
  const pkey = `${S.me}:${id}`;
  const [st, setSt] = useState(() => (previews.has(pkey) ? { status: 'ready', p: previews.get(pkey) } : { status: 'loading' }));
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (!previews.has(pkey) || tries) setSt((s) => (s.p ? s : { status: 'loading' }));
    previewHouse(id).then((p) => {
      if (!live) return;
      if (p) { previews.set(pkey, p); setSt({ status: 'ready', p }); } else if (!previews.has(pkey)) setSt({ status: 'error' });
    });
    return () => { live = false; };
  }, [id, tries]);

  if (st.status === 'loading') {
    return html`<section class="main view pl-page" aria-label="Community"><${Bar} title="Community" />
      <div class="view-body pl-state"><${Loading} label="Opening the door" /></div></section>`;
  }
  if (st.status === 'error') {
    return html`<section class="main view pl-page" aria-label="Community"><${Bar} title="Community" />
      <div class="view-body"><${Empty} icon="house" title="Couldn’t open this community" text="It may have become private, or you’re offline.">
        <div style="display:flex;gap:8px"><button class="btn" onClick=${() => go({ type: 'discover' })}>Back to Discover</button><button class="btn primary" onClick=${() => setTries((t) => t + 1)}>Try again</button></div>
      <//></div></section>`;
  }
  const h = st.p;
  const now = Date.now();
  const events = (h.events || []).filter((e) => eventState(e, now) !== 'past');
  const friends = (h.friends || []).map((u) => S.users[u]).filter(Boolean);
  const join = () => {
    setBusy(true);
    joinPublicHouse(id).then((r) => { if (!r) setBusy(false); else previews.delete(pkey); });
  };
  return html`<section class="main view pl-page" aria-label=${h.name}>
    <${Bar} title=${html`<${Icon} name="compass" />Community`} />
    <div class="view-body">
      <${Band} house=${h} topic=${h.topic} isPublic here=${h.online} voice=${h.inVoice} members=${h.members}>
        <button class="btn primary" disabled=${busy} aria-busy=${String(busy)} onClick=${join}>${busy ? 'Joining…' : `Join ${h.name}`}</button>
        <span class="pl-note">You join as a newcomer. Leave any time.</span>
      <//>
      ${friends.length > 0 && html`<p class="pl-friends"><${Stack} users=${friends} max=${4} size=${24} />
        <span><b>${nameList(friends.map((u) => first(u.name)))}</b> ${friends.length === 1 ? 'is' : 'are'} here. ${friends.length === 1 ? 'A friend' : 'Friends'} of yours.</span></p>`}
      <div class="pl-cols">
        <div class="pl-main">
          ${(h.inVoice > 0 || h.talking > 0) && html`<section class="pl-sect pl-happening" aria-labelledby="pl-now">
            <div class="pl-head"><h2 id="pl-now"><i class="pl-pulse" aria-hidden="true"></i>Happening now</h2></div>
            <p class="pl-note">${[h.inVoice > 0 && `${plural(h.inVoice, 'person', 'people')} in voice`, h.talking > 0 && `${plural(h.talking, 'person', 'people')} talking in the last few minutes`].filter(Boolean).join(', ')}.</p>
          </section>`}
          ${events.length > 0 && html`<section class="pl-sect ev-list" aria-labelledby="pl-ev">
            <div class="pl-head"><h2 id="pl-ev">Coming up</h2><span class="count num">${events.length}</span></div>
            <div class="ev-rows">${events.slice(0, 4).map((e) => html`<${EventRow} key=${e.id} ev=${e} />`)}</div>
          </section>`}
          <section class="pl-sect" aria-labelledby="pl-rooms">
            <div class="pl-head"><h2 id="pl-rooms">Rooms</h2><span class="count num">${h.rooms.length}</span></div>
            <ul class="pl-room-names">${h.rooms.map((r, i) => html`<li key=${i}><${RoomIcon} kind=${r.kind} size=${16} /><span class="trunc">${r.name}</span></li>`)}</ul>
          </section>
        </div>
        <aside class="pl-aside"><${Rules} text=${h.rules} open /></aside>
      </div>
    </div>
  </section>`;
}

export function HousePage({ id }) {
  const h = S.houses[id];
  const v = S.ui.view;
  if (h?.joined) return html`<${MemberPage} id=${id} events=${v.type === 'house' && !!v.events} />`;
  if (h && S.invites.some((i) => i.house === id)) return html`<${InvitedPage} id=${id} />`;
  return html`<${PublicPage} key=${id} id=${id} />`;
}

export { openCreateEvent };
