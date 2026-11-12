// People: the profile card, your own presence menu, and the people pane.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, me, openPop, closePop, startDm, setPresence, setStatus, openLayer, convMeta, membersOf, voiceRoomOf, openConv, closePane } from '../store.js';
import { roleOf } from '../lib/perms.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Pres, PRESENCE, presenceLabel } from '../ui/kit.js';
import { Settings } from './settings.js';

export function showProfile(user, anchor, house) {
  openPop({ anchor, label: `${user.name}, profile`, C: ProfileCard, props: { id: user.id, house } });
}

function ProfileCard({ id, house }) {
  const u = S.users[id];
  const role = house ? roleOf(S, house, id) : null;
  const live = u.presence !== 'offline' && voiceRoomOf(id);
  return html`<div class="profile">
    <div class="profile-head">
      <${Avatar} user=${u} presence />
      <div class="grow">
        <div class="profile-name">${u.name}</div>
        <div class="faint">@${u.handle}</div>
      </div>
    </div>
    <div class="profile-line"><${Pres} user=${u} inline /><span>${presenceLabel(u)}${u.status ? `. ${u.status}` : ''}</span></div>
    ${u.about && html`<p>${u.about}</p>`}
    ${role && html`<div class="profile-roles">
      <span class="role-tag"><i class=${`hue-dot${role.hue == null ? ' none' : ''}`} style=${role.hue != null ? `--hue:${role.hue}` : ''}></i>${role.name} in ${S.houses[house].name}</span>
    </div>`}
    <div class="profile-acts">
      ${id === S.me
        ? html`<button class="btn" data-autofocus onClick=${() => openLayer({ C: Settings, props: { page: 'profile' } })}>Edit profile</button>`
        : html`<button class="btn primary" data-autofocus onClick=${() => startDm([id])}>Message</button>
          ${live && html`<button class="btn" onClick=${() => { closePop(); openConv(live); }}><${Icon} name="voice" size=${16} />Go to ${S.rooms[live].name}</button>`}`}
    </div>
  </div>`;
}

// Presence says what you are open to, not just whether a light is on.
export function MePop() {
  const u = me();
  const [status, setText] = useState(u.status);
  const save = () => { if (status.trim() !== u.status) setStatus(status); };
  return html`<div class="me-pop" role="menu">
    ${Object.entries(PRESENCE).map(([key, p]) => html`<button key=${key} class="menu-item pres-opt" role="menuitemradio" aria-checked=${String(u.presence === key)}
      onClick=${() => { setPresence(key); closePop(); }}>
      <i class=${`pres inline ${key}`}></i>
      <span class="grow">${p.label}<small>${p.hint}</small></span>
      ${u.presence === key && html`<span class="end"><${Icon} name="check" size=${16} /></span>`}
    </button>`)}
    <div class="menu-sep"></div>
    <div class="status-in">
      <label class="label" for="status-field">Status line</label>
      <input id="status-field" class="field" placeholder="What are you up to?" maxlength="80" value=${status}
        onInput=${(e) => setText(e.target.value)} onBlur=${save}
        onKeyDown=${(e) => { if (e.key === 'Enter') { save(); closePop(); } }} />
    </div>
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" onClick=${() => openLayer({ C: Settings, props: { page: 'profile' } })}><${Icon} name="sliders" /><span class="grow">Settings</span></button>
    <button class="menu-item" role="menuitem" onClick=${() => openLayer({ C: Settings, props: { page: 'keys' } })}><${Icon} name="keys" /><span class="grow">Keyboard shortcuts</span></button>
  </div>`;
}

function PersonRow({ u, house }) {
  const role = house ? roleOf(S, house, u.id) : null;
  const live = u.presence !== 'offline' && voiceRoomOf(u.id);
  return html`<button class="person" onClick=${(e) => showProfile(u, e.currentTarget.getBoundingClientRect(), house)}>
    <${Avatar} user=${u} presence dim=${u.presence === 'offline'} speaking=${!!S.speaking[u.id]} />
    <span class="grow">
      <span class=${`person-name trunc${role?.hue != null ? ' role-name' : ''}`} style=${`display:block${role?.hue != null ? `;--hue:${role.hue}` : ''}`}>${u.name}${u.id === S.me ? ' (you)' : ''}</span>
      <span class=${`person-sub trunc${live ? ' is-live' : ''}`} style="display:block">${live ? `In ${S.rooms[live].name}` : u.status || PRESENCE[u.presence].label}</span>
    </span>
  </button>`;
}

export function PeoplePane({ conv }) {
  const meta = convMeta(conv);
  const ids = membersOf(conv);
  const users = ids.map((id) => S.users[id]).sort((a, b) => a.name.localeCompare(b.name));
  const house = meta?.house;
  let groups;
  if (house) {
    const h = S.houses[house];
    const online = users.filter((u) => u.presence !== 'offline');
    groups = h.roles.map((r) => ({ name: r.name, list: online.filter((u) => h.members[u.id] === r.id) }));
    groups.push({ name: 'Offline', list: users.filter((u) => u.presence === 'offline') });
  } else groups = [{ name: 'In this conversation', list: users }];
  return html`<aside class="pane" aria-label="People">
    <header class="bar">
      ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${closePane}><${Icon} name="back" /></button>`}
      <h1 class="bar-title">People</h1>
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
