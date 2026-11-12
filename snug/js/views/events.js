// Events: something planned in a house, at a time, maybe in a room. A row you
// can act on (say you're going), a list for a house or for all of them, and
// the dialog that plans one.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import {
  S, go, openConv, openMenu, openModal, closeModal, createEvent, rsvpEvent, deleteEvent, convMeta, toast,
} from '../store.js';
import { can } from '../lib/perms.js';
import { roomIds } from '../lib/attention.js';
import { eventState, LIMITS } from '../lib/social.js';
import { sameDay, plural, DAY, MIN } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Stack, Tile, RoomIcon, Empty } from '../ui/kit.js';
import { Confirm } from './modals.js';

const rectOf = (e) => e.currentTarget.getBoundingClientRect();

// Re-render every half minute so "Soon" becomes "Live" without a reload.
export function useNow(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return Date.now();
}

// The backend lets people who may post notices or manage rooms plan events.
export const canPlan = (houseId) => !!S.houses[houseId]?.joined && (can(S, houseId, 'announce') || can(S, houseId, 'rooms'));
const plannable = () => (S.houseOrder || []).filter(canPlan);
const canCancel = (e) => e.by === S.me || canPlan(e.house);

// Dates and times in the person's own locale.
const monFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const tFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const range = (a, b) => (tFmt.formatRange ? tFmt.formatRange(a, b) : `${tFmt.format(a)} – ${tFmt.format(b)}`);

export function dayLabel(ts, now = Date.now()) {
  if (sameDay(ts, now)) return 'Today';
  if (sameDay(ts, now + DAY)) return 'Tomorrow';
  if (ts > now && ts - now < 6 * DAY) return wdFmt.format(ts);
  return dateFmt.format(ts);
}

export function whenText(e, now = Date.now()) {
  const day = dayLabel(e.starts, now);
  if (!e.ends) return `${day}, ${tFmt.format(e.starts)}`;
  if (sameDay(e.starts, e.ends)) return `${day}, ${range(e.starts, e.ends)}`;
  return `${day}, ${tFmt.format(e.starts)} – ${dateFmt.format(e.ends)}, ${tFmt.format(e.ends)}`;
}

function soonText(e, now) {
  const m = Math.max(1, Math.round((e.starts - now) / MIN));
  return `In ${m} min`;
}

export function StateTag({ e, now }) {
  const st = eventState(e, now);
  if (st === 'now') return html`<span class="ev-tag now"><i aria-hidden="true"></i>Live</span>`;
  if (st === 'soon') return html`<span class="ev-tag soon">${soonText(e, now)}</span>`;
  if (st === 'past') return html`<span class="ev-tag past">Ended</span>`;
  return null;
}

function DateBlock({ ts, state }) {
  return html`<span class=${`ev-date ${state}`} aria-hidden="true">
    <span class="ev-mon">${monFmt.format(ts)}</span><b class="ev-day num">${new Date(ts).getDate()}</b>
  </span>`;
}

function eventMenu(e, anchor) {
  openMenu({
    anchor, align: 'end',
    items: [
      e.room && convMeta(e.room) && { label: `Open ${S.rooms[e.room].name}`, icon: S.rooms[e.room].kind === 'voice' ? 'voice' : 'room', onSelect: () => openConv(e.room) },
      { label: `Events in ${S.houses[e.house].name}`, icon: 'calendar', onSelect: () => go({ type: 'house', id: e.house, about: true, events: true }) },
      canCancel(e) && { sep: true },
      canCancel(e) && {
        label: 'Cancel event', icon: 'trash', danger: true,
        onSelect: () => openModal(Confirm, {
          title: `Cancel ${e.title}?`, danger: true, action: 'Cancel event',
          text: `It disappears for everyone in ${S.houses[e.house].name}, including the ${plural(e.going.length, 'person', 'people')} going.`,
          onConfirm: () => deleteEvent(e.id),
        }),
      },
    ],
  });
}

// One event. `ev` is an event from S.events, or one from a house preview
// (goingCount, friendsGoing, roomName), which can be looked at but not joined.
export function EventRow({ ev, compact, showHouse }) {
  const now = useNow();
  const e = ev;
  const st = eventState(e, now);
  const member = !!S.houses[e.house]?.joined && Array.isArray(e.going);
  const goingIds = member ? e.going : (e.friendsGoing || []);
  const count = member ? e.going.length : (e.goingCount ?? goingIds.length);
  const going = member && e.going.includes(S.me);
  const faces = goingIds.map((id) => S.users[id]).filter(Boolean);
  const room = e.room && S.rooms[e.room];
  const roomName = room?.name || e.roomName;
  const house = S.houses[e.house];
  const open = () => {
    if (!member) return;
    if (room && convMeta(e.room)) openConv(e.room);
    else go({ type: 'house', id: e.house, about: true, events: true });
  };
  const toggle = () => {
    rsvpEvent(e.id, !going).then((r) => { if (r && !going) toast(`You’re going to ${e.title}`); });
  };
  return html`<div class=${`ev-row ${st}${compact ? ' compact' : ''}${going ? ' going' : ''}`}>
    <${DateBlock} ts=${e.starts} state=${st} />
    <div class="ev-main">
      <div class="ev-line">
        <${StateTag} e=${e} now=${now} />
        ${member
          ? html`<button class="ev-title trunc" onClick=${open}>${e.title}</button>`
          : html`<span class="ev-title trunc">${e.title}</span>`}
      </div>
      <div class="ev-meta">
        <span class="num">${whenText(e, now)}</span>
        ${roomName && html`<span class="ev-where">${room ? html`<${RoomIcon} kind=${room.kind} size=${14} />` : html`<${Icon} name="room" size=${14} />`}${roomName}</span>`}
        ${showHouse && house && html`<span class="ev-where"><${Tile} house=${house} />${house.name}</span>`}
      </div>
      ${!compact && e.about && html`<p class="ev-about">${e.about}</p>`}
    </div>
    <div class="ev-side">
      ${count > 0 && html`<span class="ev-going" aria-label=${`${count} going`}>
        ${faces.length > 0 && html`<${Stack} users=${faces} max=${3} size=${20} />`}
        <span class="num">${count} going</span>
      </span>`}
      ${member && st !== 'past' && html`<button class=${`btn ev-rsvp${going ? ' on' : ''}`} aria-pressed=${String(going)}
        aria-label=${going ? `Going to ${e.title}. Press to say you can’t make it` : `Say you’re going to ${e.title}`}
        data-tip=${going ? 'You’re going. Press to change' : null} onClick=${toggle}>
        <${Icon} name=${going ? 'check' : 'plus'} size=${16} />Going
      </button>`}
      ${member && !compact && html`<button class="ib" aria-label=${`More about ${e.title}`} data-tip="More" onClick=${(x) => eventMenu(e, rectOf(x))}><${Icon} name="more" /></button>`}
    </div>
  </div>`;
}

// Events still to come (or happening), for one house or every house you are in.
export function upcomingFor(house, now = Date.now()) {
  return Object.values(S.events || {})
    .filter((e) => (house ? e.house === house : true) && S.houses[e.house]?.joined && eventState(e, now) !== 'past')
    .sort((a, b) => a.starts - b.starts);
}

export function openCreateEvent(house) { openModal(CreateEvent, { house }); }

export function EventList({ house, limit, title = 'Upcoming events', head = true, skipLive = false }) {
  const now = useNow();
  const every = upcomingFor(house, now);
  // On a page that already shows what is live, the list is what comes next.
  const all = skipLive ? every.filter((e) => eventState(e, now) !== 'now') : every;
  const liveOnly = skipLive && every.length > 0 && !all.length;
  const list = limit ? all.slice(0, limit) : all;
  const allowed = house ? canPlan(house) : plannable().length > 0;
  const create = allowed && html`<button class="btn" onClick=${() => openCreateEvent(house)}><${Icon} name="plus" size=${16} />Create event</button>`;
  return html`<section class="ev-list" aria-label=${title}>
    ${head && html`<div class="pl-head">
      <h2>${title}</h2>${all.length > 0 && html`<span class="count num">${all.length}</span>`}
      ${all.length > 0 && create}
    </div>`}
    ${list.length
      ? html`<div class="ev-rows">${list.map((e) => html`<${EventRow} key=${e.id} ev=${e} showHouse=${!house} />`)}</div>`
      : liveOnly
        ? html`<p class="ev-none">Nothing else planned after what’s on now.${create && html` ${create}`}</p>`
        : html`<div class="ev-empty">
          <${Icon} name="calendar" size=${24} />
          <div class="grow">
            <b>Nothing planned yet</b>
            <p>${allowed
              ? 'A listening night, a ride, a work session: put a time on it and people can say they’re coming.'
              : `When someone plans something${house ? ` in ${S.houses[house]?.name}` : ''}, it shows up here.`}</p>
          </div>
          ${create}
        </div>`}
    ${limit && all.length > limit && html`<button class="btn quiet pl-more" onClick=${() => go({ type: 'house', id: house, about: true, events: true })}>
      See all ${all.length} events<${Icon} name="chev-r" size=${16} />
    </button>`}
  </section>`;
}

// ---------- Planning one ----------

const pad = (n) => String(n).padStart(2, '0');
const dateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const at = (date, time) => (date && time ? new Date(`${date}T${time}`).getTime() : NaN);

function Err({ id, text }) {
  return text ? html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${14} />${text}</div>` : null;
}

export function CreateEvent({ house }) {
  const choices = plannable();
  const [houseId, setHouseId] = useState(house && canPlan(house) ? house : choices[0]);
  const next = new Date(Date.now() + 60 * MIN);
  next.setMinutes(0, 0, 0);
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('');
  const [date, setDate] = useState(dateValue(next));
  const [time, setTime] = useState(timeValue(next));
  const [hasEnd, setHasEnd] = useState(false);
  const [endTime, setEndTime] = useState(timeValue(new Date(next.getTime() + 2 * 60 * MIN)));
  const [room, setRoom] = useState('');
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);

  if (!houseId) {
    return html`<h2>Plan an event</h2>
      <p class="modal-lead">Events are planned by people who post notices or look after the rooms in a house. Ask one of them, or start your own house.</p>
      <div class="modal-foot"><button class="btn" data-autofocus onClick=${closeModal}>Close</button></div>`;
  }
  const h = S.houses[houseId];
  const rooms = roomIds(S, houseId).map((id) => S.rooms[id]);

  const starts = at(date, time);
  let ends = hasEnd ? at(date, endTime) : null;
  const nextDay = hasEnd && ends <= starts;
  if (nextDay) ends += DAY;

  const check = () => {
    const out = {};
    const t = title.trim();
    if (!t) out.title = 'Give it a name people will recognise.';
    else if (t.length > LIMITS.eventTitle) out.title = `Keep the name under ${LIMITS.eventTitle} characters.`;
    if (about.length > LIMITS.eventAbout) out.about = `That’s ${about.length - LIMITS.eventAbout} characters too long.`;
    if (!Number.isFinite(starts)) out.when = 'Pick a day and a start time.';
    else if (starts < Date.now() - 5 * MIN) out.when = 'That time has already passed. Pick a later one.';
    else if (starts > Date.now() + 365 * DAY) out.when = 'Events can be planned up to a year ahead.';
    if (hasEnd && !Number.isFinite(ends)) out.end = 'Pick an end time, or remove it.';
    return out;
  };
  const set = (f, key) => (e) => { f(e.target.value); if (errs[key] || errs.form) setErrs({ ...errs, [key]: '', form: '' }); };

  const submit = (e) => {
    e.preventDefault();
    const found = check();
    if (Object.values(found).some(Boolean)) {
      setErrs(found);
      const first = ['title', 'about', 'when', 'end'].find((k) => found[k]);
      document.getElementById(`ev-${first}`)?.focus();
      return;
    }
    setBusy(true);
    const name = title.trim();
    createEvent(houseId, { title: name, about: about.trim(), starts, ends: hasEnd ? ends : null, room: room || null }).then((r) => {
      if (r?.event) toast(`${name} is on the calendar`);
      else { setBusy(false); setErrs({ form: 'It didn’t save. Check the details and try again.' }); }
    });
  };

  return html`<form class="form ev-form" onSubmit=${submit} novalidate>
    <div>
      <h2>Plan an event</h2>
      <p class="modal-lead" style="margin:0">${choices.length > 1 && !house ? 'Pick the house it’s in.' : `Everyone in ${h.name} can see it and say they’re going.`}</p>
    </div>
    ${choices.length > 1 && !house && html`<div>
      <label class="label" for="ev-house">House</label>
      <select id="ev-house" class="field" value=${houseId} onChange=${(e) => { setHouseId(e.target.value); setRoom(''); }}>
        ${choices.map((id) => html`<option key=${id} value=${id}>${S.houses[id].name}</option>`)}
      </select>
    </div>`}
    <div>
      <label class="label" for="ev-title">Name</label>
      <input id="ev-title" class="field" data-autofocus maxlength=${LIMITS.eventTitle + 20} placeholder="Friday listening night" value=${title}
        aria-invalid=${String(!!errs.title)} aria-describedby="ev-title-msg" onInput=${set(setTitle, 'title')} />
      <${Err} id="ev-title-msg" text=${errs.title} />
    </div>
    <div>
      <label class="label" for="ev-about">What’s happening <span class="faint">(optional)</span></label>
      <textarea id="ev-about" class="field" rows="3" placeholder="Bring a record. We play one side each." value=${about}
        aria-invalid=${String(!!errs.about)} aria-describedby="ev-about-msg" onInput=${set(setAbout, 'about')}></textarea>
      ${errs.about ? html`<${Err} id="ev-about-msg" text=${errs.about} />` : html`<div class="hint" id="ev-about-msg">${about.length > LIMITS.eventAbout - 80 ? `${LIMITS.eventAbout - about.length} characters left` : 'A line or two is plenty.'}</div>`}
    </div>
    <fieldset class="ev-when">
      <legend class="label">When</legend>
      <div class="ev-when-row">
        <input id="ev-when" class="field" type="date" aria-label="Day" value=${date} min=${dateValue(new Date())}
          aria-invalid=${String(!!errs.when)} aria-describedby="ev-when-msg" onInput=${set(setDate, 'when')} />
        <input class="field" type="time" aria-label="Starts at" value=${time} step="300"
          aria-invalid=${String(!!errs.when)} aria-describedby="ev-when-msg" onInput=${set(setTime, 'when')} />
        ${hasEnd
          ? html`<span class="ev-to" aria-hidden="true">to</span>
              <input id="ev-end" class="field" type="time" aria-label="Ends at" value=${endTime} step="300"
                aria-invalid=${String(!!errs.end)} aria-describedby="ev-when-msg" onInput=${set(setEndTime, 'end')} />
              <button type="button" class="ib" aria-label="Remove end time" data-tip="No end time" onClick=${() => { setHasEnd(false); setErrs({ ...errs, end: '' }); }}><${Icon} name="x" size=${16} /></button>`
          : html`<button type="button" class="btn quiet" onClick=${() => setHasEnd(true)}><${Icon} name="plus" size=${16} />End time</button>`}
      </div>
      ${errs.when || errs.end
        ? html`<${Err} id="ev-when-msg" text=${errs.when || errs.end} />`
        : html`<div class="hint" id="ev-when-msg">${Number.isFinite(starts) ? `${whenText({ starts, ends: hasEnd ? ends : null })}${nextDay ? '. Ends the next day.' : ''}${hasEnd ? '' : '. Without an end time it shows for two hours.'}` : 'Your local time.'}</div>`}
    </fieldset>
    <div>
      <label class="label" for="ev-room">Room <span class="faint">(optional)</span></label>
      <select id="ev-room" class="field ev-select" value=${room} onChange=${(e) => setRoom(e.target.value)}>
        <option value="">No particular room</option>
        ${rooms.map((r) => html`<option key=${r.id} value=${r.id}>${r.kind === 'voice' ? 'Voice: ' : ''}${r.name}</option>`)}
      </select>
      <div class="hint">People can jump straight there when it starts.</div>
    </div>
    <${Err} text=${errs.form} />
    <div class="modal-foot" style="margin-top:0">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" disabled=${busy} aria-busy=${String(busy)}>${busy ? 'Planning…' : 'Create event'}</button>
    </div>
  </form>`;
}
