// House settings pages for places, structure and community: roles (with
// order, icons, "show separately", mentionable and extra roles), rooms and
// their access, the welcome for newcomers, and insights for owners.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { S, emit, openModal, updateRole, setRolePerm, addRole, removeRole, toast } from '../store.js';
import { call } from '../server.js';
import { PERMS, can, roleOf } from '../lib/perms.js';
import { HUES, hueOf, plural, fuzzy } from '../lib/util.js';
import { moveTo, PLACE_LIMITS as L } from '../lib/places.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Switch, Seg, RoomIcon } from '../ui/kit.js';
import { Confirm } from './modals.js';
import { act, rolesOf } from './places.js';

function Row({ label, hint, children, top }) {
  return html`<div class=${`set-row${top ? ' top' : ''}`}>
    <div class="set-label"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div>
    <div class="set-ctl">${children}</div>
  </div>`;
}
const isOwner = (house) => { const h = S.houses[house]; return !!h && roleOf(S, house)?.id === h.roles[0].id; };
const MANAGING = ['rooms', 'roles', 'kick', 'ban', 'timeout', 'voicemod', 'audit', 'moderate', 'emoji', 'nicks'];

// ---------- Roles ----------
function moveRole(house, id, index) {
  const h = S.houses[house];
  const ids = moveTo(h.roles.map((r) => r.id), id, index);
  if (ids[0] !== h.roles[0].id) return;
  h.roles = ids.map((r) => h.roles.find((x) => x.id === r));
  emit();
  act('role.move', { house, role: id, index: ids.indexOf(id) });
}
let dragRole = null;

export function PlacesRoles({ house }) {
  const h = S.houses[house];
  const [sel, setSel] = useState(h.roles[0].id);
  const [q, setQ] = useState('');
  const role = h.roles.find((r) => r.id === sel) || h.roles[0];
  const owner = h.roles[0].id === role.id;
  const count = (id) => Object.keys(h.members).filter((u) => rolesOf(house, u).includes(id)).length;
  const extraHolders = Object.keys(h.members).filter((u) => (h.extra?.[u] || []).includes(role.id));
  const candidates = Object.keys(h.members).filter((u) => S.users[u] && h.members[u] !== role.id && !extraHolders.includes(u) && q && fuzzy(q, S.users[u].name) >= 0).slice(0, 6);
  const setExtra = (u, on) => {
    const now = h.extra?.[u] || [];
    const next = on ? [...new Set([...now, role.id])] : now.filter((r) => r !== role.id);
    (h.extra ||= {})[u] = next;
    emit();
    act('member.roles', { house, user: u, roles: next });
  };
  const onKey = (r, i) => (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || i === 0) return;
    e.preventDefault();
    const to = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 1 || to >= h.roles.length) return;
    moveRole(house, r.id, to);
    requestAnimationFrame(() => document.querySelector(`[data-role="${r.id}"]`)?.focus());
  };
  return html`
    <h1>Roles</h1>
    <p class="lead">A role is a name, a colour, an icon and what it can do. People have one main role, set in Members, and can have more here. Higher roles come first; drag them, or press Alt and an arrow key.</p>
    <div class="role-list">
      <div class="role-pick" role="list" aria-label="Roles, highest first">
        ${h.roles.map((r, i) => html`<div key=${r.id} role="listitem" class="role-dnd" draggable=${i > 0 ? 'true' : 'false'}
          onDragStart=${() => { dragRole = r.id; }} onDragEnd=${() => { dragRole = null; }}
          onDragOver=${(e) => { if (dragRole && i > 0) e.preventDefault(); }}
          onDrop=${(e) => { e.preventDefault(); if (dragRole && dragRole !== r.id && i > 0) moveRole(house, dragRole, i); dragRole = null; }}>
          <button class=${`row${r.id === role.id ? ' sel' : ''}`} data-role=${r.id} aria-keyshortcuts=${i > 0 ? 'Alt+ArrowUp Alt+ArrowDown' : undefined} onClick=${() => setSel(r.id)} onKeyDown=${onKey(r, i)}>
            <span class="row-ic">${i > 0 ? html`<span class="grip" aria-hidden="true"><${Icon} name="grip" size=${14} /></span>` : null}<i class=${`hue-dot${r.hue == null ? ' none' : ''}`} style=${r.hue != null ? `--hue:${hueOf(r.hue)}` : ''}></i></span>
            <span class="grow trunc">${r.icon ? `${r.icon} ` : ''}${r.name}</span><span class="row-end faint num">${count(r.id)}</span>
          </button>
        </div>`)}
        <button class="row" onClick=${() => addRole(house).then((rid) => rid && setSel(rid))}><span class="row-ic"><${Icon} name="plus" size=${16} /></span><span class="grow">New role</span></button>
      </div>
      <div>
        <${Row} label="Name"><input class="field" style="width:200px" key=${role.id} value=${role.name} maxlength="24" aria-label="Role name" onChange=${(e) => e.target.value.trim() && updateRole(house, role.id, { name: e.target.value.trim() })} /><//>
        <${Row} label="Name colour" hint="People with this role show their name in it, unless a higher role has a colour too." top>
          <div class="swatches" role="group" aria-label="Role colour">
            <button class="swatch" style="--hue:0;--tile-c:0" aria-pressed=${String(role.hue == null)} aria-label="No colour" onClick=${() => updateRole(house, role.id, { hue: null })}></button>
            ${HUES.map(([v, name]) => html`<button key=${v} class="swatch strong" style=${`--hue:${v}`} aria-pressed=${String(role.hue != null && hueOf(role.hue) === v)} aria-label=${name} onClick=${() => updateRole(house, role.id, { hue: v })}></button>`)}
          </div>
        <//>
        <${Row} label="Icon" hint="One emoji beside their name. Leave it empty for none.">
          <input class="field" style="width:96px" key=${`${role.id}-icon`} value=${role.icon || ''} maxlength="16" aria-label="Role icon" onChange=${(e) => updateRole(house, role.id, { icon: e.target.value.trim() || null })} />
        <//>
        <${Row} label="Show separately" hint="Online people with this role get their own group in the member list.">
          <${Switch} on=${role.hoist !== false} label="Show separately in the member list" onChange=${(v) => updateRole(house, role.id, { hoist: v })} />
        <//>
        <${Row} label="Anyone can mention it" hint=${`@${role.name} reaches everyone with the role.`}>
          <${Switch} on=${role.mentionable !== false} label="Anyone can mention this role" onChange=${(v) => updateRole(house, role.id, { mentionable: v })} />
        <//>
        ${!owner && html`<div class="set-head">People who also have ${role.name}</div>
          ${extraHolders.map((u) => html`<div class="member-row" key=${u}><${Avatar} user=${S.users[u]} /><span class="grow">${S.users[u]?.name}</span>
            <button class="btn sm" onClick=${() => setExtra(u, false)}>Take away</button></div>`)}
          <input class="field" type="search" style="max-width:320px" placeholder=${`Give ${role.name} to…`} aria-label=${`Give ${role.name} to someone`} value=${q} onInput=${(e) => setQ(e.target.value)} />
          ${candidates.map((u) => html`<div class="member-row" key=${u}><${Avatar} user=${S.users[u]} /><span class="grow">${S.users[u].name}</span>
            <button class="btn sm primary" onClick=${() => { setExtra(u, true); setQ(''); }}>Give ${role.name}</button></div>`)}`}
        <div class="set-head">What ${role.name} can do</div>
        ${owner && html`<p class="hint">${role.name} is the owner role and can always do everything.</p>`}
        ${PERMS.map((p) => html`<${Row} key=${p.id} label=${p.label} hint=${p.hint}>
          <${Switch} on=${owner || role.perms.includes(p.id)} label=${p.label} onChange=${(v) => !owner && setRolePerm(house, role.id, p.id, v)} />
        <//>`)}
        ${!owner && html`<div style="margin-top:24px"><button class="btn danger" onClick=${() => openModal(Confirm, {
          title: `Remove ${role.name}?`, danger: true, action: 'Remove role',
          text: count(role.id) ? `${plural(count(role.id), 'person has', 'people have')} this role.` : 'Nobody has this role.',
          onConfirm: () => { removeRole(house, role.id); setSel(h.roles[0].id); },
        })}>Remove role</button></div>`}
      </div>
    </div>`;
}

// ---------- Rooms and their access ----------
export function RoomsPage({ house }) {
  const h = S.houses[house];
  const open = (id) => import('./places-access.js').then((m) => openModal(m.RoomAccess, { room: id }));
  return html`
    <h1>Rooms and access</h1>
    <p class="lead">Who can see, write, join and speak in each room. Private rooms show only to the roles and people you allow.</p>
    ${h.groups.map((g) => html`<div key=${g.id}>
      <div class="set-head">${g.name}</div>
      ${g.rooms.filter((r) => S.rooms[r]).map((r) => {
        const room = S.rooms[r];
        return html`<div class="member-row" key=${r}>
          <${RoomIcon} kind=${room.kind} />
          <span class="grow"><b style="font-weight:500">${room.name}</b>
            ${room.private ? html` <span class="pill"><${Icon} name="lock" size=${12} />Private</span>` : room.restricted ? html` <span class="pill">Custom access</span>` : null}
            <br /><span class="faint">${room.topic || ''}</span></span>
          ${room.perms?.manage && html`<button class="btn sm" aria-label=${`Access for ${room.name}`} onClick=${() => open(r)}>Access</button>`}
        </div>`;
      })}
    </div>`)}`;
}

// ---------- Welcome and interests ----------
export function WelcomePage({ house }) {
  const h = S.houses[house];
  const [welcome, setWelcome] = useState(h.welcome || '');
  const [list, setList] = useState((h.interests || []).map((i) => ({ ...i, roles: [...i.roles] })));
  const [error, setError] = useState('');
  const safe = h.roles.slice(1).filter((r) => !r.perms.some((p) => MANAGING.includes(p)));
  const upd = (i, patch) => setList(list.map((x, j) => (i === j ? { ...x, ...patch } : x)));
  const save = () => call('onboard.set', { house, welcome: welcome.trim(), interests: list.filter((x) => x.label.trim()).map((x) => ({ ...(x.id ? { id: x.id } : {}), label: x.label.trim(), ...(x.emoji ? { emoji: x.emoji } : {}), roles: x.roles })) })
    .then(() => { setError(''); toast('Welcome saved.'); }, (e) => setError(e.message));
  return html`
    <h1>Welcome</h1>
    <p class="lead">What new people see the first time they open ${h.name}: a few words, good rooms to start in (Newcomers page), and interests to pick that give them roles.</p>
    <${Row} label="Welcome" hint="A few friendly lines." top>
      <textarea class="field" style="width:320px" rows="4" maxlength=${L.welcome} aria-label="Welcome text" value=${welcome} onInput=${(e) => setWelcome(e.target.value)}></textarea>
    <//>
    <div class="set-head">Interests <span class="faint" style="font-weight:400">Each can give roles that don’t manage or moderate anything.</span></div>
    ${list.map((x, i) => html`<div class="interest-edit" key=${x.id || i}>
      <input class="field" style="width:64px" aria-label="Interest emoji" placeholder="🙂" maxlength="16" value=${x.emoji || ''} onInput=${(e) => upd(i, { emoji: e.target.value.trim() })} />
      <input class="field grow" aria-label="Interest" placeholder="Glazes" maxlength=${L.interestLabel} value=${x.label} onInput=${(e) => upd(i, { label: e.target.value })} />
      <div class="topic-chips" role="group" aria-label=${`Roles for ${x.label || 'this interest'}`}>
        ${safe.map((r) => html`<button type="button" key=${r.id} class="chip" aria-pressed=${String(x.roles.includes(r.id))} onClick=${() => upd(i, { roles: x.roles.includes(r.id) ? x.roles.filter((y) => y !== r.id) : [...x.roles, r.id] })}>${r.name}</button>`)}
      </div>
      <button class="ib sm" aria-label=${`Remove ${x.label || 'interest'}`} onClick=${() => setList(list.filter((_, j) => j !== i))}><${Icon} name="x" size=${16} /></button>
    </div>`)}
    <button class="btn" disabled=${list.length >= L.interests} onClick=${() => setList([...list, { label: '', roles: [] }])}><${Icon} name="plus" size=${16} />Add an interest</button>
    ${error && html`<p class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</p>`}
    <div style="margin-top:24px"><button class="btn primary" onClick=${save}>Save welcome</button></div>`;
}

// ---------- Insights (owners) ----------
const dayLabel = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
// One series as thin bars from a shared baseline. A hover and focus label on
// each bar; a table under it for screen readers and exact numbers.
function Bars({ title, series, tone }) {
  const max = Math.max(1, ...series.map((d) => d.n));
  const total = series.reduce((n, d) => n + d.n, 0);
  return html`<figure class="ins-chart">
    <figcaption><b>${title}</b><span class="num faint">${total}</span></figcaption>
    <div class=${`ins-bars ${tone}`} role="img" aria-label=${`${title}: ${total} over ${series.length} days, at most ${max} in a day`}>
      ${series.map((d) => html`<span key=${d.day} class="ins-bar" tabindex="-1" data-tip=${`${dayLabel(d.day)}: ${d.n}`} style=${`--h:${(d.n / max) * 100}%`}></span>`)}
    </div>
    <div class="ins-axis faint"><span>${dayLabel(series[0].day)}</span><span>${dayLabel(series[series.length - 1].day)}</span></div>
    <details class="ins-table"><summary>Show as a table</summary>
      <table><thead><tr><th scope="col">Day</th><th scope="col">${title}</th></tr></thead>
        <tbody>${series.filter((d) => d.n).map((d) => html`<tr key=${d.day}><td>${dayLabel(d.day)}</td><td class="num">${d.n}</td></tr>`)}</tbody></table>
    </details>
  </figure>`;
}
export function InsightsPage({ house }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    call('insights.get', { house, days }).then(setData, (e) => setError(e.message));
  }, [house, days]);
  const max = data ? Math.max(1, ...data.rooms.map((r) => r.n)) : 1;
  return html`
    <h1>Insights</h1>
    <p class="lead">How ${S.houses[house].name} is doing. Only owners see this. Days are in UTC.</p>
    <${Seg} label="Period" value=${days} options=${[[7, '7 days'], [30, '30 days'], [90, '90 days']]} onChange=${setDays} />
    ${error && html`<p class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</p>`}
    ${!data && !error && html`<p class="faint" aria-busy="true">Counting…</p>`}
    ${data && html`
      <div class="ins-tiles">
        <div class="ins-tile"><span class="num">${data.members}</span><span>members</span></div>
        <div class="ins-tile"><span class="num">${data.active}</span><span>wrote in the last 7 days</span></div>
        <div class="ins-tile"><span class="num">${data.joined.reduce((n, d) => n + d.n, 0)}</span><span>joined</span></div>
        <div class="ins-tile"><span class="num">${data.left.reduce((n, d) => n + d.n, 0)}</span><span>left</span></div>
      </div>
      <${Bars} title="Messages per day" series=${data.messages} tone="info" />
      <div class="ins-pair">
        <${Bars} title="Joined" series=${data.joined} tone="info" />
        <${Bars} title="Left" series=${data.left} tone="info" />
      </div>
      <figure class="ins-chart"><figcaption><b>Busiest rooms</b></figcaption>
        ${data.rooms.length
          ? html`<ul class="ins-rooms">${data.rooms.map((r) => html`<li key=${r.id}><span class="trunc"><${RoomIcon} kind=${r.kind} size=${16} />${r.name}</span>
              <span class="ins-hbar" style=${`--w:${(r.n / max) * 100}%`} aria-hidden="true"></span><span class="num">${r.n}</span></li>`)}</ul>`
          : html`<p class="faint">Nothing has been said in this period.</p>`}
      </figure>`}`;
}

export const PLACES_PAGES = [
  { id: 'rooms', label: 'Rooms and access', icon: 'lock', words: 'rooms private permissions overrides access webhooks follow tags forum', need: (house) => can(S, house, 'rooms') || Object.values(S.rooms).some((r) => r.house === house && r.perms?.manage) },
  { id: 'onboarding', label: 'Welcome', icon: 'smile', words: 'welcome onboarding interests roles newcomers', need: (house) => can(S, house, 'roles') },
  { id: 'insights', label: 'Insights', icon: 'chart', words: 'insights stats analytics members messages growth', need: (house) => isOwner(house) },
];
export const PLACES_VIEWS = { roles: PlacesRoles, rooms: RoomsPage, onboarding: WelcomePage, insights: InsightsPage };
