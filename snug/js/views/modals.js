// Dialogs. Each one asks for a single decision and has one main button.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import {
  S, closeModal, createRoom, updateRoom, createHouse, joinHouse, joinByCode, startDm, openConv, openModal, toast,
} from '../store.js';
import { roomIds } from '../lib/attention.js';
import { fuzzy, plural, HUES, hueOf } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Tile, RoomIcon, Seg, copyText } from '../ui/kit.js';
import { call, api } from '../server.js';


export function Confirm({ title, text, action, danger, onConfirm }) {
  return html`
    <h2>${title}</h2>
    <p class="modal-lead">${text}</p>
    <div class="modal-foot">
      <button class="btn" data-autofocus onClick=${closeModal}>Cancel</button>
      <button class=${`btn ${danger ? 'danger' : 'primary'}`} onClick=${() => { closeModal(); onConfirm(); }}>${action}</button>
    </div>`;
}

const KINDS = [['text', 'Conversation'], ['voice', 'Voice'], ['news', 'Notices']];
const KIND_HINT = {
  text: 'Everyone with access can write.',
  voice: 'People drop in and talk. It has a text side too.',
  news: 'Only roles that can post notices write here. Everyone else reads, reacts and replies in threads.',
};

// Create a room, or edit one when `room` is given.
export function RoomForm({ house, group, room }) {
  const existing = room ? S.rooms[room] : null;
  const houseId = existing ? existing.house : house;
  const [name, setName] = useState(existing?.name || '');
  const [kind, setKind] = useState(existing?.kind || 'text');
  const [topic, setTopic] = useState(existing?.topic || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return setError('Give the room a name.');
    const clash = roomIds(S, houseId).some((id) => id !== room && S.rooms[id].name.toLowerCase() === clean.toLowerCase());
    if (clash) return setError(`There\u2019s already a room called ${clean} in this house.`);
    setBusy(true);
    const done = existing ? updateRoom(room, { name: clean, topic: topic.trim() }) : createRoom(houseId, group, { name: clean, kind, topic: topic.trim() });
    done.catch((err) => { setBusy(false); setError(err.offline ? 'You\u2019re offline. Try again when you\u2019re back.' : err.message); });
    return undefined;
  };

  return html`<form class="form" onSubmit=${submit} novalidate>
    <h2>${existing ? `Edit ${existing.name}` : `New room in ${S.houses[houseId].name}`}</h2>
    <div>
      <label class="label" for="room-name">Name</label>
      <input id="room-name" class=${`field${error ? ' bad' : ''}`} data-autofocus maxlength="40" placeholder="Glaze lab" value=${name}
        aria-invalid=${String(!!error)} aria-describedby="room-name-msg" onInput=${(e) => { setName(e.target.value); setError(''); }} />
      ${error
        ? html`<div class="err" id="room-name-msg" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`
        : html`<div class="hint" id="room-name-msg">Plain words work best. Capitals and spaces are fine.</div>`}
    </div>
    ${!existing && html`<div>
      <span class="label">Kind</span>
      <${Seg} label="Kind of room" value=${kind} options=${KINDS} onChange=${setKind} />
      <div class="hint">${KIND_HINT[kind]}</div>
    </div>`}
    <div>
      <label class="label" for="room-topic">What it’s for</label>
      <input id="room-topic" class="field" maxlength="80" placeholder="Recipes, tests and what went wrong" value=${topic} onInput=${(e) => setTopic(e.target.value)} />
      <div class="hint">One line. Shown at the top of the room.</div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" disabled=${busy}>${existing ? 'Save changes' : 'Create room'}</button>
    </div>
  </form>`;
}

export function Invite({ house }) {
  const h = S.houses[house];
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [handle, setHandle] = useState('');
  const [sent, setSent] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    call('invite.create', { house }).then((r) => setLink(`${location.origin}/join/${r.code}`), (e) => setLinkError(e.offline ? 'You\u2019re offline, so a link can\u2019t be made right now.' : e.message));
  }, []);
  const byName = (e) => {
    e.preventDefault();
    if (!handle.trim()) return setError('Type a username.');
    setError(''); setSent('');
    call('invite.user', { house, handle: handle.trim() }).then((r) => { setSent(`${r.name} is invited. They\u2019ll find it in Catch up.`); setHandle(''); }, (err) => setError(err.offline ? 'You\u2019re offline. Try again when you\u2019re back.' : err.message));
    return undefined;
  };
  return html`
    <h2>Invite people to ${h.name}</h2>
    <p class="modal-lead">Anyone with this link can join as ${h.roles.find((r) => r.id === h.joinRole)?.name || 'a member'} for the next 14 days. They start with ${plural(h.starter.length, 'room')} and one first step, and the rest opens up once they take part.</p>
    <div class="copy-row">
      <input class="field" readonly value=${link || (linkError ? '' : 'Making a link\u2026')} aria-label="Invitation link" onFocus=${(e) => e.target.select()} />
      <button class="btn primary" data-autofocus disabled=${!link} onClick=${() => copyText(link)}><${Icon} name="copy" size=${16} />Copy link</button>
    </div>
    ${linkError && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${linkError}</div>`}
    <form class="form" style="margin-top:24px" onSubmit=${byName} novalidate>
      <div>
        <label class="label" for="invite-handle">Or invite someone already on Snug</label>
        <div class="copy-row">
          <input id="invite-handle" class=${`field${error ? ' bad' : ''}`} placeholder="username" value=${handle} autocomplete="off" onInput=${(e) => { setHandle(e.target.value); setError(''); }} />
          <button class="btn" type="submit">Invite</button>
        </div>
        ${error ? html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>` : sent ? html`<div class="hint" role="status">${sent}</div>` : null}
      </div>
    </form>
    <div class="modal-foot"><button class="btn" onClick=${closeModal}>Done</button></div>`;
}

// Arriving from an invitation link. The preview is public, so it works before joining.
export function JoinByLink({ code }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/api/invite/${encodeURIComponent(code)}`).then(setInfo, (e) => setError(e.message)); }, []);
  const go = () => {
    setBusy(true);
    joinByCode(code).catch((e) => { setBusy(false); setError(e.offline ? 'You\u2019re offline. Try again when you\u2019re back.' : e.message); });
  };
  if (error && !info) {
    return html`<h2>That invitation doesn\u2019t work</h2><p class="modal-lead">${error}</p>
      <div class="modal-foot"><button class="btn" data-autofocus onClick=${() => { S.ui.joinCode = null; closeModal(); }}>Close</button></div>`;
  }
  if (!info) return html`<div class="skel" style="height:120px"></div>`;
  const h = info.house;
  const already = S.houseOrder.some((id) => S.houses[id]?.name === h.name && S.houses[id]?.joined);
  return html`<div class="join-card">
    <div class="join-head">
      <span class="tile lg" style=${`--hue:${hueOf(h.hue)}`}>${h.mark}</span>
      <div><h2 style="margin:0">${h.name}</h2><div class="faint">${plural(h.members, 'member')}${info.by ? `. ${info.by} invited you` : ''}</div></div>
    </div>
    ${h.about && html`<p>${h.about}</p>`}
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot" style="margin-top:0">
      <button class="btn" onClick=${() => { S.ui.joinCode = null; closeModal(); }}>Not now</button>
      <button class="btn primary" data-autofocus disabled=${busy} onClick=${go}>${already ? 'Open' : `Join ${h.name}`}</button>
    </div>
  </div>`;
}

// What a house looks like from the doorstep, before you join.
export function JoinPreview({ house }) {
  const h = S.houses[house];
  const members = Object.keys(h.members).map((id) => S.users[id]).filter(Boolean);
  const here = members.filter((u) => u.presence !== 'offline').length;
  return html`<div class="join-card">
    <div class="join-head">
      <${Tile} house=${h} lg />
      <div><h2 style="margin:0">${h.name}</h2><div class="faint">${plural(members.length, 'member')}, ${here} here now</div></div>
    </div>
    <p>${h.about}</p>
    <div>
      <div class="label">You’ll start with ${plural(h.starter.length, 'room')}</div>
      <div class="join-rooms">
        ${h.starter.map((id) => html`<div key=${id}><${RoomIcon} kind=${S.rooms[id].kind} size=${16} /><span><b style="font-weight:500;color:var(--ink)">${S.rooms[id].name}</b> ${S.rooms[id].topic}</span></div>`)}
      </div>
      <div class="hint">The other ${plural(roomIds(S, house).length - h.starter.length, 'room')} appear once you’ve said hello.</div>
    </div>
    <div class="modal-foot" style="margin-top:0">
      <button class="btn" onClick=${closeModal}>Not now</button>
      <button class="btn primary" data-autofocus onClick=${() => joinHouse(house).catch((e) => toast(e.offline ? 'You\u2019re offline. Try again when you\u2019re back.' : e.message))}>Join ${h.name}</button>
    </div>
  </div>`;
}

export function AddHouse() {
  const [name, setName] = useState('');
  const [hue, setHue] = useState(HUES[5][0]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the house a name.');
    setBusy(true);
    createHouse({ name: name.trim(), hue }).catch((err) => { setBusy(false); setError(err.offline ? 'You\u2019re offline. Try again when you\u2019re back.' : err.message); });
    return undefined;
  };
  return html`<form class="form" onSubmit=${submit} novalidate>
    <h2>Start a house</h2>
    ${S.invites.length > 0 && html`<div>
      <span class="label">Or accept an invitation</span>
      ${S.invites.map((inv) => html`<button type="button" key=${inv.house} class="menu-item" style="min-height:44px" onClick=${() => openModal(JoinPreview, { house: inv.house })}>
        <${Tile} house=${S.houses[inv.house]} /><span class="grow trunc">${S.houses[inv.house].name}</span><span class="end">from ${(S.users[inv.from]?.name || 'someone').split(' ')[0]}</span>
      </button>`)}
    </div>`}
    <div>
      <label class="label" for="house-name">Name</label>
      <input id="house-name" class=${`field${error ? ' bad' : ''}`} data-autofocus maxlength="40" placeholder="Night shift bakers" value=${name}
        aria-invalid=${String(!!error)} onInput=${(e) => { setName(e.target.value); setError(''); }} />
      ${error ? html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`
        : html`<div class="hint">It starts with three rooms and a voice room. Rename or add more any time.</div>`}
    </div>
    <div>
      <span class="label">Colour</span>
      <div class="swatches" role="group" aria-label="House colour">
        ${HUES.map(([v, name]) => html`<button type="button" key=${v} class="swatch strong" style=${`--hue:${v}`} aria-pressed=${String(hue === v)} aria-label=${name} onClick=${() => setHue(v)}></button>`)}
      </div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" disabled=${busy}>Create house</button>
    </div>
  </form>`;
}

export function NewMessage() {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const people = Object.values(S.users).filter((u) => u.id !== S.me)
    .map((u) => ({ u, s: Math.max(fuzzy(q, u.name), fuzzy(q, u.handle)) }))
    .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.u.name.localeCompare(b.u.name)).map((x) => x.u);
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return html`
    <h2>New message</h2>
    <p class="modal-lead">Pick one person, or several for a group.</p>
    <input class="field" data-autofocus placeholder="Find someone" aria-label="Find someone" value=${q} onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && people[0] && q) { e.preventDefault(); toggle(people[0].id); setQ(''); } }} />
    <div class="picked" style="margin-top:8px">
      ${picked.map((id) => html`<button key=${id} class="chip on" onClick=${() => toggle(id)} aria-label=${`Remove ${S.users[id].name}`}>${S.users[id].name}<${Icon} name="x" size=${14} /></button>`)}
    </div>
    <div class="pick-list" role="listbox" aria-multiselectable="true">
      ${people.map((u) => html`<button key=${u.id} class="menu-item" role="option" aria-selected=${String(picked.includes(u.id))} onClick=${() => toggle(u.id)}>
        <${Avatar} user=${u} presence /><span class="grow trunc">${u.name}</span>
        ${picked.includes(u.id) && html`<span class="end"><${Icon} name="check" size=${16} /></span>`}
      </button>`)}
      ${!people.length && html`<div class="picker-none">Nobody called “${q}”</div>`}
    </div>
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn primary" disabled=${!picked.length} onClick=${() => startDm(picked)}>${picked.length > 1 ? 'Start group' : 'Start conversation'}</button>
    </div>`;
}

export function RoomBrowser({ house }) {
  const h = S.houses[house];
  return html`
    <h2>Rooms in ${h.name}</h2>
    <p class="modal-lead">${h.newcomer ? 'Have a look around. Every room joins your sidebar after your first message.' : 'Every room in this house.'}</p>
    <div class="pick-list">
      ${roomIds(S, house).map((id) => {
        const r = S.rooms[id];
        return html`<button key=${id} class="menu-item" style="min-height:48px" onClick=${() => { closeModal(); openConv(id); }}>
          <${RoomIcon} kind=${r.kind} />
          <span class="grow"><span style="display:block;font-weight:500">${r.name}</span><span class="faint trunc" style="display:block;font-size:var(--t-12)">${r.topic}</span></span>
        </button>`;
      })}
    </div>
    <div class="modal-foot"><button class="btn" data-autofocus onClick=${closeModal}>Close</button></div>`;
}
