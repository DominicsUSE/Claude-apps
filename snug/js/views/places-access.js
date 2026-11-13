// A room's access, webhooks, followed notices and forum tags, for the people
// who manage it. Every change goes to the server, which checks it again.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { S, closeModal, toast, person } from '../store.js';
import { call } from '../server.js';
import { fmtWhen } from '../lib/util.js';
import { ROOM_PERMS, VOICE_KINDS, PLACE_LIMITS as L } from '../lib/places.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Seg, Switch, copyText } from '../ui/kit.js';
import { act } from './places.js';

const STATE = [['deny', 'Off'], ['inherit', 'As usual'], ['allow', 'On']];

function OverrideRow({ room, o, label, face }) {
  const perms = ROOM_PERMS.filter((p) => VOICE_KINDS.includes(room.kind) || (p.id !== 'connect' && p.id !== 'speak'));
  const stateOf = (p) => (o.allow.includes(p) ? 'allow' : o.deny.includes(p) ? 'deny' : 'inherit');
  const set = (p, v) => {
    const allow = o.allow.filter((x) => x !== p), deny = o.deny.filter((x) => x !== p);
    if (v === 'allow') allow.push(p);
    if (v === 'deny') deny.push(p);
    act('room.override', { room: room.id, type: o.type, ...(o.type === 'everyone' ? {} : { target: o.target }), allow, deny });
  };
  return html`<div class="ovr" role="group" aria-label=${`Access for ${label}`}>
    <div class="ovr-head">${face}<b class="grow trunc">${label}</b>
      ${o.type !== 'everyone' && html`<button class="ib sm" aria-label=${`Remove the override for ${label}`} data-tip="Remove" onClick=${() => act('room.override', { room: room.id, type: o.type, target: o.target, allow: [], deny: [] })}><${Icon} name="x" size=${16} /></button>`}
    </div>
    ${perms.map((p) => html`<div class="ovr-row" key=${p.id}>
      <span class="ovr-label"><b>${p.label}</b><span>${p.hint}</span></span>
      <${Seg} label=${`${p.label} for ${label}`} value=${stateOf(p.id)} options=${STATE} onChange=${(v) => set(p.id, v)} />
    </div>`)}
  </div>`;
}

function AccessTab({ room }) {
  const h = S.houses[room.house];
  const list = room.overrides || [];
  const [adding, setAdding] = useState([]);
  const entries = [
    list.find((o) => o.type === 'everyone') || { type: 'everyone', target: '*', allow: [], deny: [] },
    ...list.filter((o) => o.type !== 'everyone'),
    ...adding.filter((a) => !list.some((o) => o.type === a.type && o.target === a.target)),
  ];
  const roleName = (id) => h.roles.find((r) => r.id === id)?.name || 'A role';
  const freeRoles = h.roles.slice(1).filter((r) => !entries.some((o) => o.type === 'role' && o.target === r.id));
  const freePeople = Object.keys(h.members).filter((u) => S.users[u] && !entries.some((o) => o.type === 'member' && o.target === u));
  return html`
    <div class="set-inline">
      <div class="grow"><b id="room-private">Private room</b>
        <span>${room.private ? 'Only the roles and people turned on below can see it, plus owners and people who manage rooms.' : 'Everyone in the house can see it.'}</span></div>
      <${Switch} on=${room.private} label="Private room" onChange=${(v) => act('room.private', { room: room.id, on: v })} />
    </div>
    <p class="hint">Each role and person starts from what their roles allow in the whole house. “On” and “Off” here change that for this room only; a person’s own setting wins over their roles’.</p>
    <div class="ovr-add">
      <select class="field" aria-label="Add a role" value="" onChange=${(e) => { if (e.target.value) setAdding([...adding, { type: 'role', target: e.target.value, allow: [], deny: [] }]); e.target.value = ''; }}>
        <option value="">Add a role…</option>${freeRoles.map((r) => html`<option key=${r.id} value=${r.id}>${r.name}</option>`)}
      </select>
      <select class="field" aria-label="Add a person" value="" onChange=${(e) => { if (e.target.value) setAdding([...adding, { type: 'member', target: e.target.value, allow: [], deny: [] }]); e.target.value = ''; }}>
        <option value="">Add a person…</option>${freePeople.map((u) => html`<option key=${u} value=${u}>${S.users[u].name}</option>`)}
      </select>
    </div>
    ${entries.map((o) => html`<${OverrideRow} key=${`${o.type}:${o.target}`} room=${room} o=${o}
      label=${o.type === 'everyone' ? 'Everyone' : o.type === 'role' ? roleName(o.target) : person(o.target).name}
      face=${o.type === 'member' ? html`<${Avatar} user=${person(o.target)} size=${24} />` : html`<${Icon} name=${o.type === 'everyone' ? 'people' : 'shield'} size=${18} />`} />`)}
    <${CheckPerson} room=${room} />`;
}

// What one person can do here once every role and override is counted,
// worked out by the server's own resolver (room.perms).
function CheckPerson({ room }) {
  const h = S.houses[room.house];
  const [who, setWho] = useState('');
  const [res, setRes] = useState(null); // { user, perms } | { user, error }
  const people = Object.keys(h.members).filter((u) => S.users[u]).sort((a, b) => person(a).name.localeCompare(person(b).name));
  const sig = JSON.stringify([room.overrides || [], room.private, h.roles, h.members, h.extra || {}]);
  useEffect(() => {
    if (!who) { setRes(null); return undefined; }
    let live = true;
    setRes({ user: who, busy: true });
    call('room.perms', { room: room.id, user: who }).then((r) => live && setRes({ user: who, perms: r.perms }), (e) => live && setRes({ user: who, error: e.message }));
    return () => { live = false; };
  }, [who, sig]);
  const perms = ROOM_PERMS.filter((p) => VOICE_KINDS.includes(room.kind) || (p.id !== 'connect' && p.id !== 'speak'));
  return html`<section class="ovr-check" aria-labelledby="ovr-check-h">
    <h3 id="ovr-check-h">Check a person</h3>
    <p class="hint">See what someone can do in ${room.name} with all of their roles and the settings above.</p>
    <select class="field" aria-label="Person to check" value=${who} onChange=${(e) => setWho(e.target.value)}>
      <option value="">Pick a person…</option>${people.map((u) => html`<option key=${u} value=${u}>${person(u).name}</option>`)}
    </select>
    ${res?.busy && html`<p class="faint" aria-busy="true">Checking…</p>`}
    ${res?.error && html`<p class="err" role="alert"><${Icon} name="alert" size=${14} />${res.error}</p>`}
    ${res?.perms && html`<ul class="ovr-result" aria-live="polite" aria-label=${`What ${person(res.user).name} can do`}>
      ${perms.map((p) => html`<li key=${p.id} class=${res.perms[p.id] ? 'yes' : 'no'}>
        <${Icon} name=${res.perms[p.id] ? 'check' : 'x'} size=${16} /><span>${p.label}</span><span class="sr">${res.perms[p.id] ? ": yes" : ": no"}</span>
      </li>`)}
    </ul>`}
  </section>`;
}

function HooksTab({ room, follows }) {
  const [hooks, setHooks] = useState(null);
  const [name, setName] = useState('');
  const [shown, setShown] = useState(null); // { id, url }: an address shown once
  const [error, setError] = useState('');
  const load = () => call('hook.list', { room: room.id }).then((r) => setHooks(r.hooks), (e) => setError(e.message));
  useEffect(() => { load(); }, [room.id]);
  const full = (url) => `${location.origin}${url}`;
  const create = (e) => {
    e.preventDefault();
    call('hook.create', { room: room.id, name: name.trim() || 'Webhook' }).then((r) => { setShown({ id: r.hook.id, url: full(r.url) }); setName(''); load(); }, (err) => setError(err.message));
  };
  const mine = (hooks || []).filter((x) => x.kind === (follows ? 'follow' : 'webhook'));
  if (!hooks) return error ? html`<p class="err" role="alert">${error}</p>` : html`<p class="faint" aria-busy="true">Loading…</p>`;
  return html`
    ${follows
      ? html`<p class="hint">Notice rooms in other houses that copy their new notices into ${room.name}.</p>`
      : html`<p class="hint">A webhook is a secret address. Anything that can send a POST with JSON <code>{"content": "…", "username": "…"}</code> to it posts here, marked as a bot. Treat the address like a password.</p>
        <form class="ovr-add" onSubmit=${create}>
          <input class="field" aria-label="Webhook name" placeholder="Name, like Kiln sensor" maxlength=${L.hookName} value=${name} onInput=${(e) => { setName(e.target.value); setError(''); }} />
          <button class="btn primary" disabled=${mine.length >= L.hooksPerRoom}><${Icon} name="plus" size=${16} />New webhook</button>
        </form>`}
    ${error && html`<p class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</p>`}
    ${shown && html`<div class="hook-url" role="status">
      <b>Copy this address now. It won’t be shown again.</b>
      <code class="trunc">${shown.url}</code>
      <button class="btn sm" onClick=${() => copyText(shown.url)}><${Icon} name="copy" size=${16} />Copy</button>
    </div>`}
    ${mine.length
      ? html`<ul class="hook-list">${mine.map((x) => html`<li key=${x.id} class="hook-item">
          <${Icon} name=${follows ? 'news' : 'hook'} size=${18} />
          <span class="grow"><b>${x.name}</b><span class="faint">${follows && x.source ? ` From ${x.source.room} in ${x.source.house}.` : ''} Added by ${person(x.by).name}, ${fmtWhen(x.created)}</span></span>
          ${!follows && html`<button class="btn sm" onClick=${() => call('hook.regen', { hook: x.id }).then((r) => setShown({ id: x.id, url: full(r.url) }), (e) => toast(e.message))}>New address</button>`}
          <button class="btn sm danger" onClick=${() => call('hook.delete', { hook: x.id }).then(() => { if (shown?.id === x.id) setShown(null); load(); }, (e) => toast(e.message))}>${follows ? 'Stop following' : 'Delete'}</button>
        </li>`)}</ul>`
      : html`<p class="faint">${follows ? 'No notice rooms copy into this room.' : 'No webhooks yet.'}</p>`}`;
}

function TagsTab({ room }) {
  const [tags, setTags] = useState((room.tags || []).map((t) => ({ ...t })));
  const [required, setRequired] = useState(!!room.tagRequired);
  const [error, setError] = useState('');
  const save = () => call('forum.tags', { room: room.id, tags: tags.filter((t) => t.name.trim()).map((t) => ({ ...(t.id ? { id: t.id } : {}), name: t.name.trim(), ...(t.emoji ? { emoji: t.emoji } : {}) })), required })
    .then(() => toast('Tags saved.'), (e) => setError(e.message));
  const upd = (i, patch) => setTags(tags.map((t, j) => (i === j ? { ...t, ...patch } : t)));
  return html`
    <p class="hint">Tags help people find posts. Everyone picks from these when they post.</p>
    ${tags.map((t, i) => html`<div class="tag-edit" key=${t.id || i}>
      <input class="field" style="width:64px" aria-label="Tag emoji" placeholder="🙂" maxlength="16" value=${t.emoji || ''} onInput=${(e) => upd(i, { emoji: e.target.value.trim() })} />
      <input class="field grow" aria-label="Tag name" maxlength=${L.tagName} value=${t.name} onInput=${(e) => upd(i, { name: e.target.value })} />
      <button class="ib sm" aria-label=${`Remove ${t.name || 'tag'}`} onClick=${() => setTags(tags.filter((_, j) => j !== i))}><${Icon} name="x" size=${16} /></button>
    </div>`)}
    <button class="btn" disabled=${tags.length >= L.tags} onClick=${() => setTags([...tags, { name: '' }])}><${Icon} name="plus" size=${16} />Add a tag</button>
    <div class="set-inline"><div class="grow"><b>Posts need a tag</b><span>People have to pick at least one.</span></div><${Switch} on=${required} label="Posts need a tag" onChange=${setRequired} /></div>
    ${error && html`<p class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</p>`}
    <div class="modal-foot" style="margin-top:0"><button class="btn primary" onClick=${save}>Save tags</button></div>`;
}

export function RoomAccess({ room: id }) {
  const room = S.rooms[id];
  const [tab, setTab] = useState('access');
  if (!room) return html`<p>That room is gone.</p><div class="modal-foot"><button class="btn" onClick=${closeModal}>Close</button></div>`;
  const tabs = [['access', 'Access'], ...(['text', 'news'].includes(room.kind) ? [['hooks', 'Webhooks'], ['follows', 'Followed notices']] : []), ...(room.kind === 'forum' ? [['tags', 'Tags']] : [])];
  return html`<div class="room-access">
    <h2>${room.name}</h2>
    ${tabs.length > 1 && html`<${Seg} label="Room settings" value=${tab} options=${tabs} onChange=${setTab} />`}
    <div class="room-access-body">
      ${tab === 'access' && html`<${AccessTab} room=${room} />`}
      ${tab === 'hooks' && html`<${HooksTab} room=${room} />`}
      ${tab === 'follows' && html`<${HooksTab} room=${room} follows />`}
      ${tab === 'tags' && html`<${TagsTab} room=${room} />`}
    </div>
    <div class="modal-foot"><button class="btn" data-autofocus onClick=${closeModal}>Done</button></div>
  </div>`;
}
