// Friends ({ type: 'friends', tab }): who is around, everyone, requests, and
// adding someone by username. Rows, not cards. Favourites sit on top.
// Arrow keys move through the rows, Enter opens a profile.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, go, back, startDm, openConv, acceptFriend, declineFriend, removeFriend } from '../store.js';
import { call } from '../server.js';
import { friendsOnline, friendsList, friendRequests, isFriend } from '../lib/social.js';
import { plural } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Empty } from '../ui/kit.js';
import { Doing, doingOf, FavButton, SharedTiles, friendMenu, openPerson, lastActive, ago } from './people.js';
import { PeopleYouMightKnow } from './discover.js';

const Back = () => S.ui.phone && S.ui.depth > 0 && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`;
const TABS = ['online', 'all', 'requests', 'add'];
const RECENT = 3 * 86_400_000;

// ---------- Rows ----------

// Roving tabindex: one row in the tab order, arrows move between rows.
function onListKey(e) {
  const row = e.target.closest?.('.f-row');
  if (!row || e.target !== row) return;
  const rows = [...e.currentTarget.querySelectorAll('.f-row')];
  const i = rows.indexOf(row);
  let next = -1;
  if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, i + 1);
  else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = rows.length - 1;
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPerson(row.dataset.id); return; }
  if (next < 0) return;
  e.preventDefault();
  rows.forEach((r, j) => r.setAttribute('tabindex', j === next ? '0' : '-1'));
  rows[next].focus();
}

function Row({ id, first, kind = 'friend', children }) {
  const u = S.users[id];
  if (!u) return null;
  const d = doingOf(u);
  const f = S.friends[id];
  return html`<li class=${`f-row${u.presence === 'offline' ? ' is-off' : ''}`} data-id=${id} tabindex=${first ? '0' : '-1'} aria-label=${`${u.name}, ${d.text}${f?.favorite ? ', favourite' : ''}`}
      onClick=${(e) => { if (!e.target.closest('button')) openPerson(id); }}
      onFocus=${(e) => { if (e.target === e.currentTarget) e.currentTarget.closest('.f-list')?.querySelectorAll('.f-row').forEach((r) => r.setAttribute('tabindex', r === e.currentTarget ? '0' : '-1')); }}>
      <${Avatar} user=${u} presence speaking=${!!S.speaking[id]} />
      <span class="f-text">
        <span class="f-name"><span class="trunc">${u.name}</span>${f?.favorite && kind === 'friend' && html`<span class="f-star" aria-hidden="true"><${Icon} name="starred" size=${12} /></span>`}<span class="f-handle trunc">@${u.handle}</span></span>
        ${kind === 'friend' && html`<span class="f-sub"><${Doing} u=${u} /></span>`}
        ${kind !== 'friend' && html`<span class="f-sub"><span class="trunc">${kind === 'incoming' ? `Sent you a request ${ago(f.since)}` : `You asked ${ago(f.since)}`}</span></span>`}
      </span>
      <span class="f-end"><${SharedTiles} id=${id} /></span>
      <span class="f-acts">${children}</span>
  </li>`;
}

function FriendActions({ id }) {
  const u = S.users[id];
  const live = doingOf(u).live;
  return html`
    <button class="ib" aria-label=${`Message ${u.name}`} data-tip="Message" onClick=${() => startDm([id])}><${Icon} name="room" size=${18} /></button>
    ${live && html`<button class="ib live" aria-label=${`Join ${u.name} in ${S.rooms[live].name}`} data-tip=${`Join in ${S.rooms[live].name}`} onClick=${() => openConv(live)}><${Icon} name="voice" size=${18} /></button>`}
    <${FavButton} id=${id} />
    <button class="ib" aria-label=${`More for ${u.name}`} aria-haspopup="menu" data-tip="More" onClick=${(e) => friendMenu(id, e.currentTarget.getBoundingClientRect())}><${Icon} name="more" size=${18} /></button>`;
}

function RequestActions({ id, incoming }) {
  const [busy, setBusy] = useState(false);
  const u = S.users[id];
  const run = (p) => { setBusy(true); Promise.resolve(p).finally(() => setBusy(false)); };
  if (incoming) {
    return html`
      <button class="btn primary" disabled=${busy} aria-busy=${busy ? 'true' : undefined} onClick=${() => run(acceptFriend(id))}>Accept</button>
      <button class="btn" disabled=${busy} aria-label=${`Decline ${u.name}`} onClick=${() => run(declineFriend(id))}>Decline</button>`;
  }
  return html`<button class="btn quiet" disabled=${busy} aria-label=${`Cancel request to ${u.name}`} onClick=${() => run(removeFriend(id))}>Cancel</button>`;
}

function Group({ title, count, note, ids, render, start }) {
  if (!ids.length) return null;
  return html`<section class="f-group" aria-label=${title}>
    <h2 class="f-head">${title}${count != null && html` <span class="count num">${count}</span>`}</h2>
    ${note && html`<p class="f-note">${note}</p>`}
    <ul class="f-list-part">${ids.map((id, i) => render(id, start === 0 && i === 0))}</ul>
  </section>`;
}

const friendRow = (id, first) => html`<${Row} key=${id} id=${id} first=${first}><${FriendActions} id=${id} /><//>`;

// ---------- Tabs ----------

function OnlineTab() {
  const online = friendsOnline(S);
  const favs = online.filter((id) => S.friends[id].favorite);
  const rest = online.filter((id) => !S.friends[id].favorite);
  const now = Date.now();
  const recent = friendsList(S)
    .filter((id) => S.users[id]?.presence === 'offline')
    .map((id) => [id, lastActive(id)])
    .filter(([, t]) => t && now - t < RECENT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);
  if (!friendsList(S).length) return html`<${NoFriends} />`;
  if (!online.length && !recent.length) {
    return html`<${Empty} icon="people" title="Nobody’s around right now" text="Friends show up here when they’re online, with what they’re up to.">
      <button class="btn" onClick=${() => go({ type: 'friends', tab: 'all' })}>See all friends</button>
    <//>`;
  }
  return html`<div class="f-list" onKeyDown=${onListKey}>
    <${Group} title="Favourites" ids=${favs} render=${friendRow} start=${0} />
    <${Group} title=${favs.length ? 'Also online' : 'Online'} count=${rest.length} ids=${rest} render=${friendRow} start=${favs.length ? 1 : 0} />
    ${!online.length && html`<p class="f-quiet">No friends online right now.</p>`}
    <${Group} title="Recently active" note="Offline now, but wrote something in the last few days." ids=${recent} render=${friendRow} start=${online.length ? 1 : 0} />
  </div>`;
}

// No friends at all: the honest empty state is the way to add one, right here.
const NoFriends = () => html`<${AddTab} title="No friends here yet" focus=${false}
  lead="Add someone by their username, or pick from people you already share a house with. You’ll see when they’re around." />`;

function AllTab() {
  const all = friendsList(S);
  if (!all.length) return html`<${NoFriends} />`;
  const favs = all.filter((id) => S.friends[id].favorite);
  const rest = all.filter((id) => !S.friends[id].favorite);
  return html`<div class="f-list" onKeyDown=${onListKey}>
    <${Group} title="Favourites" count=${favs.length} ids=${favs} render=${friendRow} start=${0} />
    <${Group} title="Everyone" count=${rest.length} ids=${rest} render=${friendRow} start=${favs.length ? 1 : 0} />
  </div>`;
}

function RequestsTab() {
  const incoming = friendRequests(S, 'incoming');
  const outgoing = friendRequests(S, 'outgoing');
  if (!incoming.length && !outgoing.length) {
    return html`<${Empty} icon="check" title="No requests waiting" text="When someone asks to be your friend, it shows up here. Requests you send wait here too.">
      <button class="btn" onClick=${() => go({ type: 'friends', tab: 'add' })}>Add a friend</button>
    <//>`;
  }
  return html`<div class="f-list" onKeyDown=${onListKey}>
    <${Group} title="Waiting on you" count=${incoming.length} ids=${incoming} start=${0}
      render=${(id, first) => html`<${Row} key=${id} id=${id} first=${first} kind="incoming"><${RequestActions} id=${id} incoming /><//>`} />
    <${Group} title="Sent" count=${outgoing.length} note="Waiting for them to say yes. Cancel any time." ids=${outgoing} start=${incoming.length ? 1 : 0}
      render=${(id, first) => html`<${Row} key=${id} id=${id} first=${first} kind="outgoing"><${RequestActions} id=${id} /><//>`} />
  </div>`;
}

function AddTab({ title = 'Add a friend', lead = 'Friends see each other’s presence and can message any time, even without a house in common.', focus = true }) {
  const [handle, setHandle] = useState('');
  const [st, setSt] = useState({ status: 'idle' });
  const [people, setPeople] = useState(null);
  const input = useRef();
  useEffect(() => {
    if (focus && !S.ui.phone) input.current?.focus();
    let live = true;
    call('discover', { q: '', topic: null }).then((r) => live && setPeople(r.people), () => live && setPeople([]));
    return () => { live = false; };
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    const v = handle.trim().replace(/^@/, '');
    if (!v) { setSt({ status: 'error', text: 'Type a username first, like @ines.' }); input.current?.focus(); return; }
    setSt({ status: 'sending' });
    try {
      const r = await call('friend.request', { handle: v });
      const name = S.users[r.user]?.name || `@${v}`;
      setSt({ status: 'done', user: r.user, friends: r.state === 'friends', name });
      setHandle('');
    } catch (err) {
      setSt({ status: 'error', text: err.offline ? 'You’re offline. Try again once you’re back.' : err.message });
      input.current?.focus();
    }
  };
  const bad = st.status === 'error';
  return html`<div class="f-add">
    <h2 class="f-add-title">${title}</h2>
    <p class="f-add-lead">${lead}</p>
    <form class="f-add-form" onSubmit=${submit} novalidate>
      <label class="sr" for="f-add-handle">Username</label>
      <div class=${`f-add-field${bad ? ' bad' : ''}${st.status === 'done' ? ' ok' : ''}`}>
        <span class="f-at" aria-hidden="true">@</span>
        <input id="f-add-handle" ref=${input} autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="username" maxlength="40"
          value=${handle} aria-invalid=${bad ? 'true' : undefined} aria-describedby="f-add-msg"
          onInput=${(e) => { setHandle(e.target.value); if (st.status !== 'idle' && st.status !== 'sending') setSt({ status: 'idle' }); }} />
        <button class="btn primary" type="submit" disabled=${st.status === 'sending' || !handle.trim()} aria-busy=${st.status === 'sending' ? 'true' : undefined}>
          ${st.status === 'sending' ? 'Sending…' : 'Send request'}
        </button>
      </div>
      <div id="f-add-msg" class="f-add-msg" role=${bad ? 'alert' : 'status'} aria-live="polite">
        ${bad && html`<span class="err-line"><${Icon} name="alert" size=${16} />${st.text}</span>`}
        ${st.status === 'done' && html`<span class="ok-line"><${Icon} name="check" size=${16} />
          ${st.friends ? html`You and <b>${st.name}</b> are friends now.` : html`Request sent to <b>${st.name}</b>. You’ll see it under Requests until they answer.`}
          ${st.user && S.users[st.user] && html`<button class="btn quiet" type="button" onClick=${() => openPerson(st.user)}>View profile</button>`}
        </span>`}
        ${st.status === 'idle' && html`<span class="f-add-hint">Usernames are on every profile, under the name. Capitals don’t matter.</span>`}
      </div>
    </form>
    ${people === null
      ? html`<p class="f-quiet">Looking for people you might know…</p>`
      : html`<${PeopleYouMightKnow} people=${people.filter((p) => !isFriend(S, p.user.id))} limit=${6} />`}
  </div>`;
}

// ---------- The page ----------

export function Friends() {
  const v = S.ui.view;
  const tab = TABS.includes(v.tab) ? v.tab : 'online';
  const online = friendsOnline(S).length;
  const all = friendsList(S).length;
  const incoming = friendRequests(S, 'incoming').length;
  const outgoing = friendRequests(S, 'outgoing').length;
  const tabs = [
    { id: 'online', label: 'Online', count: online },
    { id: 'all', label: 'All', count: all },
    { id: 'requests', label: 'Requests', count: incoming, badge: true, more: outgoing },
    { id: 'add', label: 'Add friend', icon: 'user-plus' },
  ];
  const pick = (id) => go({ type: 'friends', tab: id });
  const onTabKey = (e) => {
    const i = TABS.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
      pick(next);
      requestAnimationFrame(() => document.getElementById(`f-tab-${next}`)?.focus());
    }
  };
  const Body = { online: OnlineTab, all: AllTab, requests: RequestsTab, add: AddTab }[tab];
  return html`<section class="main view friends-view" aria-label="Friends">
    <header class="bar">
      <${Back} />
      <h1 class="bar-title"><${Icon} name="people" />Friends</h1>
      ${online > 0 && html`<span class="bar-sub num">${online} online</span>`}
    </header>
    <div class="f-tabs" role="tablist" aria-label="Friends" onKeyDown=${onTabKey}>
      ${tabs.map((t) => html`<button key=${t.id} id=${`f-tab-${t.id}`} class=${`f-tab${t.id === 'add' ? ' add' : ''}`} role="tab" aria-selected=${String(tab === t.id)}
        aria-controls="f-panel" tabindex=${tab === t.id ? '0' : '-1'} onClick=${() => pick(t.id)}
        aria-label=${t.badge ? `Requests: ${plural(incoming, 'waiting on you', 'waiting on you')}, ${outgoing} sent` : undefined}>
        ${t.icon && html`<${Icon} name=${t.icon} size=${16} />`}<span class="f-tab-label">${t.label}</span>
        ${t.badge ? (t.count > 0 && html`<span class="badge">${t.count}</span>`) : t.count != null && html`<span class="f-tab-count num">${t.count}</span>`}
      </button>`)}
    </div>
    <div class="view-body" id="f-panel" role="tabpanel" aria-labelledby=${`f-tab-${tab}`}>
      <div class="f-wrap"><${Body} key=${tab} /></div>
    </div>
  </section>`;
}
