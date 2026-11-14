// People: the hover card, your own presence menu, the people pane, and the
// pieces every people view shares (what someone is doing, the friend button,
// interests, links, communities in common).
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import {
  S, me, openPop, closePop, startDm, setPresence, setStatus, openLayer, convMeta, membersOf, voiceRoomOf, openConv, closePane,
  go, openMenu, openModal, sendFriendRequest, acceptFriend, declineFriend, removeFriend, setFavoriteFriend,
} from '../store.js';
import { togglePane } from '../store.js'; // the member list toggle (shell track)
import { roleOf } from '../lib/perms.js';
import { mutualHouses, friendState, safeLink } from '../lib/social.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Pres, Tile, PRESENCE, presenceLabel } from '../ui/kit.js';
import { nameAttrs, profileColours } from '../ui/kit.js'; // name styles and profile colours (css/appearance.css)
import { Settings } from './settings.js';
import { Confirm } from './modals.js';
import { hueOf, MIN, DAY, plural } from '../lib/util.js';
import { personItems } from './safety.js'; // block, report, moderate
import { houseFace, colourRole, rolesOf, RoleIconMark } from './places.js'; // nicknames, role colours and icons, every role
import { memberGroups } from '../lib/places.js'; // groups by roles shown separately
import { ProfileBanner, AboutText, Pronouns, PrivateNote, StatusEmoji, openCustomStatus } from './account.js'; // banner, pronouns, rich About, notes, custom status
import { setPresenceFor, presenceUntilNote, PRESENCE_TIMES } from '../inbox.js'; // presence for a while (server/inbox.js)

export function showProfile(user, anchor, house) {
  openPop({ anchor, side: S.ui.phone ? undefined : 'right', label: `${user.name}, profile`, C: ProfileCard, props: { id: user.id, house } });
}
export const openPerson = (id) => { closePop(); go({ type: 'person', id }); };
export const editProfile = () => { closePop(); openLayer({ C: Settings, props: { page: 'profile' } }); };

// ---------- What someone is doing ----------

// The newest message this person wrote that this device has seen.
// Where and when someone last wrote, among the conversations you can read.
export function lastWrote(id) {
  let best = null;
  for (const [conv, list] of Object.entries(S.msgs)) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].author === id) { if (!best || list[i].ts > best.ts) best = { ts: list[i].ts, conv }; break; }
    }
  }
  return best;
}

export function lastActive(id) {
  let t = 0;
  for (const list of Object.values(S.msgs)) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].author === id) { if (list[i].ts > t) t = list[i].ts; break; }
    }
  }
  return t;
}

export function ago(ts, now = Date.now()) {
  const d = now - ts;
  if (d < 2 * MIN) return 'just now';
  if (d < 60 * MIN) return `${Math.round(d / MIN)} min ago`;
  if (d < DAY) return `${Math.round(d / (60 * MIN))} h ago`;
  if (d < 2 * DAY) return 'yesterday';
  if (d < 30 * DAY) return `${Math.round(d / DAY)} days ago`;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(ts);
}

// One line: in a voice room beats a status, a status beats a presence word.
export function doingOf(u) {
  const room = u.presence !== 'offline' && voiceRoomOf(u.id);
  if (room) return { live: room, text: `In ${S.rooms[room].name}`, where: S.houses[S.rooms[room].house]?.name };
  // A status can be only an emoji: then the presence word goes with it.
  if ((u.status || u.statusEmoji) && u.presence !== 'offline') return { text: u.status || PRESENCE[u.presence]?.label || 'Around', status: true };
  if (u.presence === 'offline') {
    const t = lastActive(u.id);
    return { text: t ? `Offline · last wrote ${ago(t)}` : 'Offline' };
  }
  return { text: PRESENCE[u.presence]?.label || 'Around' };
}

export function Doing({ u }) {
  const d = doingOf(u);
  return html`<span class=${`doing${d.live ? ' is-live' : ''}`}>
    ${d.live && html`<${Icon} name="voice" size=${14} />`}
    <span class="trunc">${d.status ? html`<${StatusEmoji} u=${u} />` : ''}${d.text}${d.where ? html`<span class="doing-where"> · ${d.where}</span>` : ''}</span>
  </span>`;
}

// ---------- Friends ----------

export function confirmRemoveFriend(id) {
  const name = S.users[id]?.name || 'this person';
  openModal(Confirm, {
    title: `Remove ${name.split(' ')[0]} as a friend?`, danger: true, action: 'Remove friend',
    text: 'You’ll stop seeing each other’s presence unless you share a house. Your messages stay. You can send a new request any time.',
    onConfirm: () => removeFriend(id),
  });
}

export function friendMenu(id, anchor, { profile = true, house = null } = {}) {
  const f = S.friends[id];
  openMenu({
    anchor, align: 'end',
    items: [
      profile && { label: 'View profile', icon: 'user', onSelect: () => openPerson(id) },
      f?.state === 'friends' && { label: f.favorite ? 'Remove from favourites' : 'Add to favourites', icon: f.favorite ? 'starred' : 'star', onSelect: () => setFavoriteFriend(id, !f.favorite) },
      f?.state === 'friends' && { sep: true },
      f?.state === 'friends' && { label: 'Remove friend', icon: 'leave', danger: true, onSelect: () => confirmRemoveFriend(id) },
      ...personItems(id, house), // block or unblock, and in a house: report and moderate
    ],
  });
}

export function FavButton({ id, sm }) {
  const f = S.friends[id];
  if (f?.state !== 'friends') return null;
  const name = S.users[id]?.name || '';
  return html`<button class=${`ib fav${sm ? ' sm' : ''}${f.favorite ? ' on' : ''}`} aria-pressed=${String(!!f.favorite)}
    aria-label=${f.favorite ? `Remove ${name} from favourites` : `Add ${name} to favourites`} data-tip=${f.favorite ? 'Favourite' : 'Add to favourites'}
    onClick=${(e) => { e.stopPropagation(); setFavoriteFriend(id, !f.favorite); }}>
    <${Icon} name=${f.favorite ? 'starred' : 'star'} size=${sm ? 16 : 18} />
  </button>`;
}

// Add friend / Requested / Accept / Friends, whichever is true now.
// Whether the server will open a conversation with this person: friends,
// people you share a house with, and anyone already in a conversation with you.
export const canMessage = (id) => friendState(S, id) === 'friends' || mutualHouses(S, id).length > 0
  || S.dmOrder.some((d) => S.dms[d]?.members.includes(id));

export function FriendButton({ id, compact, primary }) {
  const [busy, setBusy] = useState(false);
  if (!id || id === S.me) return null;
  const state = friendState(S, id);
  const name = (S.users[id]?.name || '').split(' ')[0];
  const run = (p) => { setBusy(true); Promise.resolve(p).finally(() => setBusy(false)); };
  if (state === 'friends') {
    return html`<button class="btn friend-btn is-friends" aria-haspopup="menu" aria-label=${`Friends with ${name}. More`}
      onClick=${(e) => friendMenu(id, e.currentTarget.getBoundingClientRect(), { profile: false })}>
      <${Icon} name="user-check" size=${16} />${!compact && 'Friends'}<${Icon} name="chev-d" size=${14} />
    </button>`;
  }
  if (state === 'outgoing') {
    return html`<button class="btn friend-btn" aria-haspopup="menu" aria-busy=${busy ? 'true' : undefined}
      onClick=${(e) => openMenu({ anchor: e.currentTarget.getBoundingClientRect(), align: 'end', items: [
        { heading: `Waiting for ${name}` },
        { label: 'Cancel request', icon: 'x', onSelect: () => run(removeFriend(id)) },
      ] })}>
      <${Icon} name="check" size=${16} />Requested
    </button>`;
  }
  if (state === 'incoming') {
    return html`<span class="friend-pair">
      <button class="btn primary" aria-busy=${busy ? 'true' : undefined} disabled=${busy} onClick=${() => run(acceptFriend(id))}><${Icon} name="check" size=${16} />Accept</button>
      <button class="btn" disabled=${busy} onClick=${() => run(declineFriend(id))}>Decline</button>
    </span>`;
  }
  return html`<button class=${`btn friend-btn${primary ? ' primary' : ''}`} aria-busy=${busy ? 'true' : undefined} disabled=${busy} onClick=${() => run(sendFriendRequest(id))}>
    <${Icon} name="user-plus" size=${16} />${compact ? 'Add' : 'Add friend'}
  </button>`;
}

// ---------- A person's corner ----------

export function Interests({ list }) {
  if (!list?.length) return null;
  return html`<ul class="interests" aria-label="Interests">${list.map((i) => html`<li key=${i} class="interest">${i}</li>`)}</ul>`;
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function Links({ list }) {
  const safe = (list || []).map((l) => ({ ...l, url: safeLink(l.url) })).filter((l) => l.url);
  if (!safe.length) return null;
  return html`<ul class="plinks">${safe.map((l) => html`<li key=${l.url}>
    <a class="plink" href=${l.url} target="_blank" rel="noopener noreferrer">
      <${Icon} name="link" size=${16} />
      <span class="plink-label trunc">${l.label || domainOf(l.url)}</span>
      <span class="plink-dom trunc">${domainOf(l.url)}</span>
      <${Icon} name="external" size=${14} />
      <span class="sr">(opens in a new tab)</span>
    </a>
  </li>`)}</ul>`;
}

export function CommonHouses({ id, max = 6, names = true }) {
  const list = mutualHouses(S, id);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  return html`<ul class=${`common${names ? '' : ' tiles-only'}`}>
    ${shown.map((h) => html`<li key=${h}>
      <button class="common-item" aria-label=${names ? undefined : S.houses[h].name} data-tip=${names ? undefined : S.houses[h].name}
        onClick=${() => { closePop(); go({ type: 'house', id: h }); }}>
        <${Tile} house=${S.houses[h]} />${names && html`<span class="trunc">${S.houses[h].name}</span>`}
      </button>
    </li>`)}
    ${list.length > shown.length && html`<li class="common-more num">+${list.length - shown.length}</li>`}
  </ul>`;
}

// Small arch tiles for rows: where you both are.
export function SharedTiles({ id, max = 3 }) {
  const list = mutualHouses(S, id);
  if (!list.length) return null;
  const label = `Both in ${list.map((h) => S.houses[h].name).join(', ')}`;
  return html`<span class="shared-tiles" role="img" aria-label=${label} data-tip=${label}>
    ${list.slice(0, max).map((h) => html`<${Tile} key=${h} house=${S.houses[h]} />`)}
    ${list.length > max && html`<span class="shared-more num">+${list.length - max}</span>`}
  </span>`;
}

const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
export const memberSince = (u) => (u.since ? monthYear.format(u.since) : null);

// ---------- The hover card ----------

function ProfileCard({ id, house }) {
  const u = S.users[id];
  if (!u) return html`<div class="pcard"><p class="pcard-gone">This person isn’t visible to you any more.</p></div>`;
  const role = house ? roleOf(S, house, id) : null;
  const d = doingOf(u);
  const mine = id === S.me;
  const pc = profileColours(u);
  return html`<div class=${`pcard${pc.cls}`} style=${`--hue:${hueOf(u.hue)}${pc.style}`}>
    <${ProfileBanner} u=${u} />
    <div class="pcard-body">
      <div class="pcard-top">
        <button class="pcard-av" aria-label=${`Open ${u.name}’s profile`} onClick=${() => openPerson(id)}><${Avatar} user=${u} presence size=${56} /></button>
        <${FavButton} id=${id} sm />
      </div>
      <button class="pcard-name" ...${nameAttrs(u)} onClick=${() => openPerson(id)}>${u.name}</button>
      <div class="pcard-handle"><span class="secret">@${u.remote ? u.username || u.handle : u.handle}</span><${Pronouns} u=${u} /></div>
      <div class="pcard-line"><${Pres} user=${u} inline /><${Doing} u=${u} /></div>
      <${AboutText} u=${u} />
      ${role && html`<div class="profile-roles">
        <span class="role-tag"><i class=${`hue-dot${role.hue == null ? ' none' : ''}`} style=${role.hue != null ? `--hue:${hueOf(role.hue)}` : ''}></i>${role.name} in ${S.houses[house].name}</span>
      </div>`}
      ${!mine && mutualHouses(S, id).length > 0 && html`<div class="pcard-common">
        <span class="pcard-k">In common</span><${CommonHouses} id=${id} max=${5} names=${false} />
      </div>`}
      ${!mine && !u.deleted && html`<${PrivateNote} id=${id} />`}
      <div class="pcard-acts">
        ${mine
          ? html`<button class="btn primary" data-autofocus onClick=${editProfile}><${Icon} name="edit" size=${16} />Edit profile</button>`
          : canMessage(id) ? html`<button class="btn primary" data-autofocus onClick=${() => startDm([id])}><${Icon} name="room" size=${16} />Message</button>`
            : html`<${FriendButton} id=${id} primary />`}
        ${d.live && !mine && html`<button class="btn" onClick=${() => { closePop(); openConv(d.live); }}><${Icon} name="voice" size=${16} />Join</button>`}
        <button class="btn" onClick=${() => openPerson(id)}>Profile</button>
        ${!mine && html`<button class="ib" aria-label=${`More for ${u.name}`} aria-haspopup="menu" data-tip="More"
          onClick=${(e) => friendMenu(id, e.currentTarget.getBoundingClientRect(), { profile: false, house })}><${Icon} name="more" /></button>`}
      </div>
    </div>
  </div>`;
}

// ---------- Your presence ----------

// Presence says what you are open to, not just whether a light is on.
export function MePop() {
  const u = me();
  const [status, setText] = useState(u.status);
  const [forKey, setForKey] = useState(null); // the presence whose "for…" times are open
  const save = () => { if (status.trim() !== u.status) setStatus(status); };
  const until = presenceUntilNote(u); // "until 15:00" (js/inbox.js)
  return html`<div class="me-pop" role="menu">
    ${Object.entries(PRESENCE).map(([key, p]) => html`<div key=${key} class="pres-row">
      <button class="menu-item pres-opt" role="menuitemradio" aria-checked=${String(u.presence === key)}
        onClick=${() => { setPresenceFor(key); closePop(); }}>
        <i class=${`pres inline ${key}`}></i>
        <span class="grow">${p.label}<small>${u.presence === key && until ? `${p.label} ${until}` : p.hint}</small></span>
        ${u.presence === key && html`<span class="end"><${Icon} name="check" size=${16} /></span>`}
      </button>
      ${key !== 'around' && html`<button class=${`menu-item pres-for${forKey === key ? ' on' : ''}`} role="menuitem" aria-expanded=${String(forKey === key)}
        aria-label=${`${p.label} for a while`} data-tip="For how long" onClick=${() => setForKey(forKey === key ? null : key)}><${Icon} name="clock" size=${16} /><${Icon} name=${forKey === key ? 'chev-u' : 'chev-d'} size=${14} /></button>`}
      ${forKey === key && html`<div class="pres-times" role="group" aria-label=${`${p.label} for how long`}>
        ${PRESENCE_TIMES.map(([c, label]) => html`<button key=${c} class="chip" onClick=${() => { setPresenceFor(key, c); closePop(); }}>${label.replace(/^For /, '')}</button>`)}
      </div>`}
    </div>`)}
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" onClick=${() => { closePop(); openCustomStatus(); }}><${Icon} name="smile" /><span class="grow">${u.status || u.statusEmoji ? 'Change status' : 'Set a status'}<small>An emoji, and when it clears</small></span>${u.statusEmoji && html`<span class="end">${u.statusEmoji}</span>`}</button>
    <div class="status-in">
      <label class="label" for="status-field">Status line</label>
      <input id="status-field" class="field" placeholder="What are you up to?" maxlength="80" value=${status}
        onInput=${(e) => setText(e.target.value)} onBlur=${save}
        onKeyDown=${(e) => { if (e.key === 'Enter') { save(); closePop(); } }} />
    </div>
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" onClick=${() => openPerson(S.me)}><${Icon} name="user" /><span class="grow">Your profile</span></button>
    <button class="menu-item" role="menuitem" onClick=${() => openLayer({ C: Settings, props: { page: 'profile' } })}><${Icon} name="sliders" /><span class="grow">Settings</span></button>
    <button class="menu-item" role="menuitem" onClick=${() => openLayer({ C: Settings, props: { page: 'keys' } })}><${Icon} name="keys" /><span class="grow">Keyboard shortcuts</span></button>
  </div>`;
}

// ---------- The people pane ----------

function PersonRow({ u: real, house }) {
  const u = houseFace(real, house); // their nickname and picture here (js/views/places.js)
  const role = house ? colourRole(house, u.id) : null;
  const live = u.presence !== 'offline' && voiceRoomOf(u.id);
  const fav = S.friends[u.id]?.favorite;
  return html`<button class=${`person${u.presence === 'offline' ? ' is-off' : ''}`} onClick=${(e) => showProfile(u, e.currentTarget.getBoundingClientRect(), house)}>
    <${Avatar} user=${u} presence dim=${u.presence === 'offline'} speaking=${!!S.speaking[u.id]} />
    <span class="grow">
      <span class=${`person-name trunc${role?.hue != null ? ' role-name' : ''}`} style=${`display:block${role?.hue != null ? `;--hue:${hueOf(role.hue)}` : ''}`} ...${nameAttrs(u)}>${u.name}${u.id === S.me ? ' (you)' : ''}${house ? html` <${RoleIconMark} house=${house} uid=${u.id} />` : null}</span>
      <span class=${`person-sub trunc${live ? ' is-live' : ''}`} style="display:block">${live ? `In ${S.rooms[live].name}` : u.presence === 'offline' ? (u.status ? `${u.status} · ${offlineLine(u.id)}` : offlineLine(u.id)) : u.status || PRESENCE[u.presence].label}</span>
    </span>
    ${fav && html`<span class="person-fav" role="img" aria-label="Favourite"><${Icon} name="starred" size=${14} /></span>`}
  </button>`;
}

// ---------- The member list (shell track) ----------
// Offline people say when they were last around ("Last active 2 h ago").
const offlineLine = (id) => { const t = lastActive(id); return t ? `Last active ${ago(t)}` : 'Offline'; };

// The member list toggle remembers itself on this device: shown or hidden,
// it comes back that way next time (js/app.js restores it once at start).
const PEOPLE_KEY = 'snug.people';
const keepPeople = (on) => { try { localStorage.setItem(PEOPLE_KEY, on ? '1' : '0'); } catch { /* blocked */ } };
export const peopleWanted = () => { try { return localStorage.getItem(PEOPLE_KEY) === '1'; } catch { return false; } };
export function togglePeople() {
  togglePane('people');
  keepPeople(S.ui.pane?.type === 'people');
}

export function PeoplePane({ conv }) {
  // Closed by Esc or the close button (not replaced by a thread or details): remember that.
  useEffect(() => () => { if (!S.ui.pane) keepPeople(false); }, []);
  const meta = convMeta(conv);
  const ids = membersOf(conv);
  const users = ids.map((id) => S.users[id]).sort((a, b) => a.name.localeCompare(b.name));
  const house = meta?.house;
  let groups;
  if (house) {
    // Online people under their highest role shown separately, then Online, then Offline (js/lib/places.js).
    groups = memberGroups(S.houses[house].roles, users, (id) => rolesOf(house, id));
  } else groups = [{ name: 'In this conversation', list: users }];
  return html`<aside class="pane" aria-label="People">
    <header class="bar">
      ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${closePane}><${Icon} name="back" /></button>`}
      <h1 class="bar-title">People</h1>
      <span class="bar-sub num">${plural(users.length, 'person', 'people')}</span>
      <div class="bar-end">${!S.ui.phone && html`<button class="ib" aria-label="Close people" data-tip="Close" data-key="Esc" onClick=${closePane}><${Icon} name="x" /></button>`}</div>
    </header>
    <div class="pane-body">
      ${groups.filter((g) => g.list.length).map((g) => html`<div key=${g.name}>
        <div class="pane-sect"><span>${g.name}</span><span class="num">${g.list.length}</span></div>
        ${g.list.map((u) => html`<${PersonRow} key=${u.id} u=${u} house=${house} />`)}
      </div>`)}
    </div>
  </aside>`;
}

export { presenceLabel };
