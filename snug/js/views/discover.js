// Discover ({ type: 'discover', section, topic }): editorial, not a feed.
// One community gets the stage, then what is happening right now, topics,
// new places and people you might know. Every community opens a preview with
// its rules, rooms and events before you join.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, emit, go, back, discover, joinPublicHouse, openModal, closeModal } from '../store.js';
import { call } from '../server.js';
import { TOPICS, eventState } from '../lib/social.js';
import { hueOf, plural, nameList, fmtTime, sameDay, DAY } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack, RoomIcon, Empty } from '../ui/kit.js';
import { Loading } from '../ui/brand.js';
import { FriendButton, openPerson } from './people.js';

const Back = () => S.ui.phone && S.ui.depth > 0 && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`;

// ---------- Shared caches ----------
// Every cache here belongs to one account and goes stale: they are emptied
// when someone else signs in, and each answer is reused only while fresh, so
// browsing topics doesn't spend the server's discover allowance.
const FRESH = 30_000, PREVIEW_FRESH = 60_000, KNOWN_FRESH = 5 * 60_000;
let owner = null;
function own() {
  if (owner === S.me) return;
  owner = S.me;
  known.clear(); primedAt = 0; previews.clear(); results.clear(); eventsFor.clear();
}

// People you might know, kept so profiles can say how many friends you share.
const known = new Map();
let primedAt = 0;
function remember(people) { for (const p of people || []) known.set(p.user.id, p); }
export function mutualFriendsOf(id) {
  own();
  if (Date.now() - primedAt > KNOWN_FRESH) {
    primedAt = Date.now();
    call('discover', { q: '', topic: null }).then((r) => { remember(r.people); emit(); }, () => {});
  }
  return known.get(id)?.mutualFriends ?? null;
}

// Previews, so the stage, "Happening now" and the preview dialog share one fetch.
const previews = new Map();
function loadPreview(id, fresh) {
  own();
  const hit = previews.get(id);
  if (!fresh && hit && Date.now() - hit.at < PREVIEW_FRESH) return hit.p;
  const p = call('house.preview', { house: id }).catch((e) => { previews.delete(id); throw e; });
  previews.set(id, { p, at: Date.now() });
  return p;
}

// ---------- Small pieces ----------

// The house's icon clipped to the arch when it has one (server/community.js), its mark and hue otherwise.
const ArchTile = ({ house, size = 'md' }) => html`<span class=${`arch arch-${size}${house.icon ? ' pic' : ''}`} style=${`--hue:${hueOf(house.hue)}`} aria-hidden="true">${house.mark}${house.icon
  ? html`<img src=${`/api/housepics/${house.icon}`} alt="" loading="lazy" decoding="async" onError=${(e) => e.currentTarget.remove()} />` : null}</span>`;
// A public house's banner across the top of its card.
const Banner = ({ house, cls = '' }) => (house.banner
  ? html`<div class=${`d-banner ${cls}`} aria-hidden="true"><img src=${`/api/housepics/${house.banner}`} alt="" loading="lazy" onError=${(e) => { e.currentTarget.parentNode.hidden = true; }} /></div>` : null);

function LiveLine({ h }) {
  const bits = [];
  if (h.inVoice) bits.push(html`<span class="live-voice"><${Icon} name="voice" size=${14} />${h.inVoice} in voice</span>`);
  if (h.talking) bits.push(html`<span class="live-talk"><i class="pres inline open"></i>${plural(h.talking, 'person', 'people')} talking</span>`);
  if (!bits.length && h.online) bits.push(html`<span class="live-talk"><i class="pres inline around"></i>${h.online} online</span>`);
  if (!bits.length) return null;
  return html`<span class="live-line">${bits}</span>`;
}

function Counts({ h }) {
  return html`<span class="d-counts num">${h.topic && html`<span>${h.topic}</span>`}<span>${plural(h.members, 'member')}</span>${h.online > 0 && html`<span>${h.online} online</span>`}</span>`;
}

function FriendsThere({ ids, size = 24 }) {
  const users = (ids || []).map((u) => S.users[u]).filter(Boolean);
  if (!users.length) return null;
  const names = users.map((u) => u.name.split(' ')[0]);
  return html`<span class="friends-there"><${Stack} users=${users} max=${4} size=${size} /><span>${nameList(names)} ${users.length === 1 ? 'is' : 'are'} here</span></span>`;
}

function JoinButton({ id, primary = true, label = 'Join' }) {
  const [busy, setBusy] = useState(false);
  return html`<button class=${`btn${primary ? ' primary' : ''}`} aria-busy=${busy ? 'true' : undefined} disabled=${busy}
    onClick=${(e) => { e.stopPropagation(); setBusy(true); joinPublicHouse(id).then((r) => { if (!r) setBusy(false); }); }}>
    ${busy ? 'Joining…' : label}
  </button>`;
}

export function openPreview(id) { openModal(HousePreview, { house: id, wide: true }); }

// ---------- The stage: one community, big ----------

function Featured({ h }) {
  return html`<section class=${`d-feature${h.banner ? ' has-banner' : ''}`} style=${`--hue:${hueOf(h.hue)}`} aria-labelledby=${`feat-${h.id}`}>
    <${Banner} house=${h} cls="d-feature-banner" />
    <button class="d-feature-art" onClick=${() => openPreview(h.id)} aria-label=${`Take a look at ${h.name}`} tabindex="-1">
      <${ArchTile} house=${h} size="lg" />
    </button>
    <div class="d-feature-text">
      <div class="d-kicker">${h.inVoice || h.talking ? 'Lively right now' : 'Worth a look'}</div>
      <h2 class="d-feature-name" id=${`feat-${h.id}`}><button class="link-like" onClick=${() => openPreview(h.id)}>${h.name}</button></h2>
      <${Counts} h=${h} />
      ${h.about && html`<p class="d-feature-about">${h.about}</p>`}
      <div class="d-feature-live"><${LiveLine} h=${h} /><${FriendsThere} ids=${h.friends} /></div>
      <div class="d-feature-acts">
        <${JoinButton} id=${h.id} />
        <button class="btn" onClick=${() => openPreview(h.id)}>Take a look</button>
      </div>
    </div>
  </section>`;
}

// ---------- Happening now ----------

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const shortDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
function whenText(e, now) {
  const st = eventState(e, now);
  if (st === 'now') return 'On now';
  if (st === 'soon') return `In ${Math.max(1, Math.round((e.starts - now) / 60000))} min`;
  if (sameDay(e.starts, now)) return `${new Date(e.starts).getHours() < 17 ? 'Today' : 'Tonight'} ${fmtTime(e.starts)}`;
  if (e.starts - now < 6 * DAY) return `${weekday.format(e.starts)} ${fmtTime(e.starts)}`;
  return shortDay.format(e.starts);
}

function Happening({ houses, events, limit }) {
  const now = Date.now();
  const live = houses.filter((h) => h.inVoice > 0 || h.talking > 0);
  const evs = events.filter((x) => eventState(x.e, now) !== 'past');
  const items = [
    ...evs.filter((x) => eventState(x.e, now) === 'now').map((x) => ({ k: `e${x.e.id}`, kind: 'event', ...x })),
    ...live.map((h) => ({ k: `h${h.id}`, kind: 'live', h })),
    ...evs.filter((x) => eventState(x.e, now) !== 'now').map((x) => ({ k: `e${x.e.id}`, kind: 'event', ...x })),
  ].slice(0, limit || 99);
  if (!items.length) return null;
  return html`<section class="d-sect" aria-labelledby="d-now">
    <h2 class="d-head" id="d-now"><span class="d-live-dot" aria-hidden="true"></span>Happening now</h2>
    <ul class="d-now">
      ${items.map((it) => (it.kind === 'live'
        ? html`<li key=${it.k}><button class="d-now-row" onClick=${() => openPreview(it.h.id)}>
            <${ArchTile} house=${it.h} size="sm" />
            <span class="d-now-main">
              <span class="d-now-title trunc">${it.h.name}</span>
              <span class="d-now-sub"><${LiveLine} h=${it.h} /></span>
            </span>
            ${it.h.friends?.length > 0 && html`<${Stack} users=${it.h.friends.map((u) => S.users[u]).filter(Boolean)} max=${3} size=${24} />`}
          </button></li>`
        : html`<li key=${it.k}><button class="d-now-row" onClick=${() => openPreview(it.h.id)}>
            <span class=${`d-when ${eventState(it.e, now)}`} aria-hidden="true"><${Icon} name="calendar" size=${16} /></span>
            <span class="d-now-main">
              <span class="d-now-title trunc">${it.e.title}</span>
              <span class="d-now-sub trunc"><b class=${`d-when-text ${eventState(it.e, now)}`}>${whenText(it.e, now)}</b> · ${it.h.name}${it.e.roomName ? ` · ${it.e.roomName}` : ''}</span>
            </span>
            ${it.e.goingCount > 0 && html`<span class="d-going num">${it.e.goingCount} going</span>`}
          </button></li>`))}
    </ul>
  </section>`;
}

// ---------- Lists ----------

function HouseRow({ h, card }) {
  return html`<li class=${`d-house${card ? ' d-card' : ''}`} style=${`--hue:${hueOf(h.hue)}`}>
    <button class="d-house-main" onClick=${() => openPreview(h.id)}>
      <${ArchTile} house=${h} size="md" />
      <span class="d-house-text">
        <span class="d-house-name trunc">${h.name}</span>
        ${h.about && html`<span class="d-house-about">${h.about}</span>`}
        <span class="d-house-meta"><${Counts} h=${h} /><${LiveLine} h=${h} /></span>
      </span>
    </button>
    <div class="d-house-acts"><${JoinButton} id=${h.id} primary=${false} /></div>
  </li>`;
}

function PersonItem({ p }) {
  const u = S.users[p.user.id] || p.user;
  return html`<li class="d-person">
    <button class="d-person-main" onClick=${() => openPerson(u.id)}>
      <${Avatar} user=${u} size=${48} presence=${u.presence !== 'offline'} />
      <span class="d-person-text">
        <span class="d-person-name trunc">${u.name}</span>
        <span class="d-person-why">${p.reason || `@${u.handle}`}</span>
        ${u.interests?.length > 0 && html`<span class="d-person-int trunc">${u.interests.slice(0, 3).join(' · ')}</span>`}
      </span>
    </button>
    <${FriendButton} id=${u.id} compact />
  </li>`;
}

export function PeopleYouMightKnow({ people, limit = 6, title = 'People you might know' }) {
  const list = (people || []).filter((p) => !S.friends[p.user.id] || S.friends[p.user.id].state !== 'friends').slice(0, limit);
  if (!list.length) return null;
  return html`<section class="d-sect" aria-labelledby="d-people">
    <h2 class="d-head" id="d-people">${title}</h2>
    <p class="d-note">People you share a house or a friend with. Nobody else shows up here.</p>
    <ul class="d-people">${list.map((p) => html`<${PersonItem} key=${p.user.id} p=${p} />`)}</ul>
  </section>`;
}

// ---------- The page ----------

// Section ids match the route (no section means For you), as the nav column uses them.
const SECTIONS = [['for-you', 'For you'], ['communities', 'Communities'], ['people', 'People'], ['events', 'Events']];
// The last answer per search, so switching topic or section never flashes empty.
const results = new Map();
const eventsFor = new Map();

export function Discover() {
  const v = S.ui.view.type === 'discover' ? S.ui.view : { type: 'discover' };
  const section = SECTIONS.some(([k]) => k === v.section) ? v.section : 'for-you';
  const topic = TOPICS.includes(v.topic) ? v.topic : null;
  const [q, setQ] = useState(() => S.ui.discoverQ || '');
  const [query, setQuery] = useState(() => (S.ui.discoverQ || '').trim());
  const key0 = `${topic || ''}|${query}`;
  own();
  const [state, setState] = useState(() => (results.has(key0) ? { status: 'refreshing', data: results.get(key0).r } : { status: 'loading', data: null }));
  const [events, setEvents] = useState(() => eventsFor.get(key0) || []);
  const [tries, setTries] = useState(0);
  const seq = useRef(0);
  const force = useRef(false);

  // Typing settles for a moment before asking the server.
  useEffect(() => { S.ui.discoverQ = q; const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  useEffect(() => {
    const n = ++seq.current;
    const key = `${topic || ''}|${query}`;
    const hit = results.get(key);
    // A fresh answer for the same search is shown as is: no new request on remount or topic flips.
    if (hit && !force.current && Date.now() - hit.at < FRESH) {
      setState({ status: 'ready', data: hit.r });
      setEvents(eventsFor.get(key) || []);
      return;
    }
    force.current = false;
    setState((s) => ({ status: s.data ? 'refreshing' : 'loading', data: s.data }));
    discover({ q: query, topic }).then((r) => {
      if (n !== seq.current) return;
      if (!r) { setState({ status: 'error', data: null }); return; }
      remember(r.people);
      results.set(key, { r, at: Date.now() });
      setState({ status: 'ready', data: r });
      // Events live in previews: look into the liveliest few.
      const pick = r.houses.slice(0, 4);
      Promise.all(pick.map((h) => loadPreview(h.id).then((p) => (p.events || []).map((e) => ({ e, h })), () => [])))
        .then((lists) => {
          const evs = lists.flat().sort((a, b) => a.e.starts - b.e.starts);
          eventsFor.set(key, evs);
          if (n === seq.current) setEvents(evs);
        });
    });
  }, [query, topic, tries]);

  // On the phone's Discover tab this screen is the tab itself: change it in
  // place instead of pushing a second Discover over it.
  const route = (sec, top) => {
    const view = { type: 'discover', ...(sec !== 'for-you' ? { section: sec } : {}), ...(top ? { topic: top } : {}) };
    if (S.ui.phone && S.ui.depth === 0) { S.ui.view = view; emit(); } else go(view);
  };
  const setSection = (sec) => route(sec, topic);
  const setTopic = (t) => route(section, t === topic ? null : t);

  const data = state.data;
  const houses = data?.houses || [];
  const searching = !!query;
  const featured = !searching && section === 'for-you' ? houses[0] : null;
  const rest = houses.filter((h) => h !== featured);
  const newest = [...rest].sort((a, b) => b.created - a.created);

  let body;
  if (state.status === 'loading') body = html`<div class="d-state"><${Loading} label="Looking around" /></div>`;
  else if (state.status === 'error') {
    body = html`<div class="empty error" role="alert">
      <${Icon} name="offline" size=${24} />
      <h2>Discover didn’t load</h2>
      <p>Snug couldn’t reach the server just now. Your houses and messages are fine.</p>
      <button class="btn" onClick=${() => { force.current = true; setTries((t) => t + 1); }}>Try again</button>
    </div>`;
  } else if (!houses.length && !data.people.length) {
    body = html`<${Empty} icon="compass" title=${searching ? `Nothing matches “${query}”` : topic ? `No ${topic} communities yet` : 'Nothing new to find right now'}
      text=${searching ? 'Try a shorter word, or pick a topic.' : 'Public communities you haven’t joined show up here. Start one and make it public, and it might be the next one people find.'}>
      ${(searching || topic) && html`<button class="btn" onClick=${() => { setQ(''); setQuery(''); if (topic) route(section, null); }}>Show everything</button>`}
    <//>`;
  } else if (searching) {
    body = html`
      ${houses.length > 0 && html`<section class="d-sect" aria-labelledby="d-res">
        <h2 class="d-head" id="d-res">Communities <span class="count num">${houses.length}</span></h2>
        <ul class="d-houses">${houses.map((h) => html`<${HouseRow} key=${h.id} h=${h} />`)}</ul>
      </section>`}
      <${PeopleYouMightKnow} people=${data.people} limit=${12} title="People" />`;
  } else if (section === 'people') {
    body = html`<${PeopleYouMightKnow} people=${data.people} limit=${30} />
      ${!data.people.length && html`<${Empty} icon="people" title="No one to suggest yet" text="Join a house or add a friend, and people you’re connected to will show up here." />`}`;
  } else if (section === 'events') {
    body = html`<${Happening} houses=${houses} events=${events} />
      ${!houses.some((h) => h.inVoice || h.talking) && !events.length && html`<${Empty} icon="calendar" title="It’s quiet out there" text="Live voice rooms and events in public communities show up here." />`}`;
  } else if (section === 'communities') {
    // Cards for the communities (brief 22), with what is live and who you
    // might know beside them.
    body = html`<div class="d-cols">
      <div class="d-col-main">
        <section class="d-sect" aria-labelledby="d-all">
          <h2 class="d-head" id="d-all">${topic || 'All communities'} <span class="count num">${houses.length}</span></h2>
          <ul class="d-houses d-cards">${houses.map((h) => html`<${HouseRow} key=${h.id} h=${h} card />`)}</ul>
        </section>
      </div>
      <div class="d-col-side">
        <${Happening} houses=${houses} events=${events} limit=${4} />
        <${PeopleYouMightKnow} people=${data.people} limit=${5} />
      </div>
    </div>`;
  } else {
    body = html`
      ${featured && html`<${Featured} h=${featured} />`}
      <div class="d-cols">
        <div class="d-col-main">
          <${Happening} houses=${rest} events=${events} limit=${5} />
          ${newest.length > 0 && html`<section class="d-sect" aria-labelledby="d-new">
            <h2 class="d-head" id="d-new">${topic ? `More in ${topic}` : 'New communities'}</h2>
            <ul class="d-houses">${newest.slice(0, 6).map((h) => html`<${HouseRow} key=${h.id} h=${h} />`)}</ul>
          </section>`}
        </div>
        <div class="d-col-side">
          <${PeopleYouMightKnow} people=${data.people} limit=${5} />
        </div>
      </div>`;
  }

  return html`<section class="main view discover-view" aria-label="Discover">
    <header class="bar">
      <${Back} />
      <h1 class="bar-title"><${Icon} name="compass" />Discover</h1>
      ${state.status === 'refreshing' && html`<span class="bar-sub" role="status">Updating…</span>`}
    </header>
    <div class="view-body">
      <div class="d-wrap">
        <div class="d-top">
          <label class="d-search">
            <${Icon} name="search" size=${18} />
            <input type="search" placeholder="Search communities, people, interests" aria-label="Search communities and people" value=${q}
              maxlength="80" onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} />
          </label>
          ${S.ui.phone && html`<div class="d-chips" role="group" aria-label="Topics">
            ${TOPICS.map((t) => html`<button key=${t} class="chip" aria-pressed=${String(topic === t)} onClick=${() => setTopic(t)}>${t}</button>`)}
          </div>`}
          ${S.ui.phone && !searching && html`<nav class="d-tabs" aria-label="Discover sections">
            ${SECTIONS.map(([k, label]) => html`<button key=${k} class="d-tab" aria-current=${section === k ? 'page' : undefined} onClick=${() => setSection(k)}>${label}</button>`)}
          </nav>`}
        </div>
        ${body}
      </div>
    </div>
  </section>`;
}

// ---------- Preview before joining ----------

const dayMonth = (ts) => {
  const d = new Date(ts);
  return { day: d.getDate(), mon: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(d) };
};

export function HousePreview({ house }) {
  const [st, setSt] = useState({ status: 'loading', p: null, err: '' });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setSt({ status: 'loading', p: null, err: '' });
    loadPreview(house, tries > 0).then((p) => live && setSt({ status: 'ready', p, err: '' }),
      (e) => live && setSt({ status: 'error', p: null, err: e.offline ? 'You’re offline. Try again once you’re back.' : e.message }));
    return () => { live = false; };
  }, [house, tries]);

  if (st.status === 'loading') return html`<div class="hp-state"><${Loading} label="Opening the door" /></div>`;
  if (st.status === 'error') {
    return html`<div class="hp-state" role="alert">
      <h2>Couldn’t open this community</h2>
      <p class="modal-lead">${st.err}</p>
      <div class="modal-foot"><button class="btn" onClick=${closeModal}>Close</button><button class="btn primary" data-autofocus onClick=${() => setTries((t) => t + 1)}>Try again</button></div>
    </div>`;
  }
  const h = st.p;
  const joined = h.joined || S.houses[h.id]?.joined;
  const now = Date.now();
  const rules = (h.rules || '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
  const events = (h.events || []).filter((e) => eventState(e, now) !== 'past');
  return html`<div class="hp" style=${`--hue:${hueOf(h.hue)}`}>
    <${Banner} house=${h} cls="hp-banner" />
    <div class="hp-head">
      <${ArchTile} house=${h} size="lg" />
      <div class="hp-id">
        <h2 id="hp-title">${h.name}</h2>
        <${Counts} h=${h} />
        <${LiveLine} h=${h} />
      </div>
    </div>
    ${h.about && html`<p class="hp-about">${h.about}</p>`}
    ${h.friends?.length > 0 && html`<div class="hp-friends"><${FriendsThere} ids=${h.friends} /></div>`}

    ${events.length > 0 && html`<section class="hp-sect" aria-labelledby="hp-ev">
      <h3 id="hp-ev">Coming up</h3>
      <ul class="hp-events">${events.slice(0, 3).map((e) => {
        const dm = dayMonth(e.starts);
        const es = eventState(e, now);
        return html`<li key=${e.id} class="hp-event">
          <span class=${`hp-date ${es}`} aria-hidden="true"><b class="num">${dm.day}</b><span>${dm.mon}</span></span>
          <span class="hp-ev-main">
            <span class="hp-ev-title">${e.title}</span>
            <span class="hp-ev-sub"><b class=${`d-when-text ${es}`}>${whenText(e, now)}</b>${e.roomName ? ` · ${e.roomName}` : ''}${e.goingCount ? ` · ${e.goingCount} going` : ''}</span>
          </span>
        </li>`;
      })}</ul>
    </section>`}

    <section class="hp-sect" aria-labelledby="hp-rooms">
      <h3 id="hp-rooms">Rooms <span class="count num">${h.rooms.length}</span></h3>
      <ul class="hp-rooms">${h.rooms.map((r, i) => html`<li key=${i}><${RoomIcon} kind=${r.kind} size=${16} /><span class="trunc">${r.name}</span></li>`)}</ul>
    </section>

    <section class="hp-sect" aria-labelledby="hp-rules">
      <h3 id="hp-rules">House rules</h3>
      ${rules.length
        ? html`<ol class="hp-rules">${rules.map((r, i) => html`<li key=${i}>${r}</li>`)}</ol>`
        : html`<p class="pp-empty">No written rules. Be kind; the people who run it will say if something’s off.</p>`}
    </section>

    <div class="modal-foot hp-foot">
      <span class="hp-foot-note">${joined ? 'You’re in.' : 'You join as a newcomer. Leave any time.'}</span>
      <button class="btn" onClick=${closeModal}>Not now</button>
      ${joined
        ? html`<button class="btn primary" data-autofocus onClick=${() => { closeModal(); go({ type: 'house', id: h.id }); }}>Open</button>`
        : html`<${JoinButton} id=${h.id} label="Join" />`}
    </div>
  </div>`;
}

