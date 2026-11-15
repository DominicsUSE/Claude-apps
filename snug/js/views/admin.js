// v0.10 admin panel, suspension and announcement notices (design section 5.5).
// The registry decides and enforces every admin action (signed by this PC's key, permission-checked,
// audited); this is only a view. The server side is server/notices.js (op admin.call, event `notices`).
//   AdminButton        a thin "Admin" pill, only for accounts the registry says have admin rights
//   registerAdminPage  Settings > Admin: Overview, People, Names, Announcements, Updates, Admins, Audit
//   NoticeBar          announcements (dismissable), "suspended until…", "too old for the network"
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { S, toast, openModal, openLayer, subscribe, signOutHooks } from '../store.js';
import { call, on } from '../server.js';
import { Icon } from '../ui/icons.js';
import { Seg } from '../ui/kit.js';
import { Confirm } from './modals.js';

// ---------- State ----------
on('notices', (d) => { S.notices = { ...(S.notices || {}), ...d }; });
signOutHooks.push(() => { delete S.notices; });

export const adminPerms = () => (Array.isArray(S.notices?.admin) ? S.notices.admin : []);
const has = (p) => adminPerms().includes(p);
const adminCall = (d) => call('admin.call', d);
const fail = (e) => toast(e?.offline ? 'You’re offline. Try again once you’re back.' : (e?.message || 'Something went wrong. Try again.'));
const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const DISMISS_KEY = 'snug.annDismissed';
function dismissed() { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); } catch { return []; } }
function dismiss(id) { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed().filter((x) => x !== id), id].slice(-50))); } catch { /* private window */ } }

const openAdmin = () => import('./settings.js').then((m) => openLayer({ C: m.Settings, props: { page: 'admin' } }));

// ---------- The pill ----------
export function AdminButton() {
  if (!adminPerms().length || S.ui.phone || S.ui.layer || S.ui.modal) return null; // hidden while Settings or a dialog is open
  return html`<button class="admin-pill" id="admin-pill" onClick=${openAdmin} aria-label="Admin panel" data-tip="Admin panel"><${Icon} name="shield" size=${12} />Admin</button>`;
}

// ---------- Notices ----------
export function NoticeBar() {
  const n = S.notices;
  const [, bump] = useState(0);
  if (!n) return null;
  const items = [];
  if (n.ban) {
    const text = n.ban.until
      ? `Your Snug account is suspended until ${when(n.ban.until)}. Reason: ${n.ban.reason || 'none given'}. Friends on other PCs can’t reach you until then.`
      : `Your Snug account is suspended. Reason: ${n.ban.reason || 'none given'}. Friends on other PCs can’t reach you.`;
    items.push(html`<div class="notice-card warn" role="alert" id="notice-ban" key="ban"><${Icon} name="ban" size=${18} /><span>${text}</span></div>`);
  }
  if (n.outdated) {
    items.push(html`<div class="notice-card warn" role="alert" id="notice-outdated" key="old"><${Icon} name="alert" size=${18} /><span>This Snug is too old for the Snug network. Update Snug.</span></div>`);
  }
  const gone = new Set(dismissed());
  for (const a of n.ann || []) {
    if (gone.has(a.id)) continue;
    items.push(html`<div class=${`notice-card ${a.level === 'warn' ? 'warn' : 'info'}`} role="status" key=${a.id} data-ann=${a.id}>
      <${Icon} name=${a.level === 'warn' ? 'alert' : 'news'} size=${18} />
      <span>${a.text}</span>
      <button class="ib sm" aria-label="Dismiss this announcement" data-tip="Dismiss" onClick=${() => { dismiss(a.id); bump((x) => x + 1); }}><${Icon} name="x" size=${14} /></button>
    </div>`);
  }
  if (!items.length) return null;
  return html`<div class="notice-bar" aria-label="Announcements">${items}</div>`;
}

// ---------- Settings > Admin ----------
const ADMIN_PAGE = { id: 'admin', label: 'Admin', icon: 'shield', section: 'Admin', words: 'admin moderation ban timeout suspend names reserve rename announcements minimum version update audit stats' };
const TABS = [
  ['overview', 'Overview', 'stats'],
  ['people', 'People', 'ban'],
  ['names', 'Names', 'names'],
  ['ann', 'Announcements', 'ann'],
  ['update', 'Updates', 'update'],
  ['admins', 'Admins', 'grant'],
  ['audit', 'Audit', 'stats'],
];
const PERM_TEXT = { stats: 'Stats and audit', names: 'Usernames', ban: 'Bans and timeouts', ann: 'Announcements', update: 'Minimum version' };

export function registerAdminPage({ PAGES, VIEWS, Row }) {
  VIEWS.admin = () => html`<${AdminPage} Row=${Row} />`;
  // The page is listed only while the registry says this account has rights.
  const sync = () => {
    const want = adminPerms().length > 0;
    const i = PAGES.findIndex((p) => p.id === 'admin');
    if (want && i < 0) PAGES.push({ ...ADMIN_PAGE });
    else if (!want && i >= 0) PAGES.splice(i, 1);
  };
  subscribe(sync);
  sync();
}

function AdminPage({ Row }) {
  const tabs = TABS.filter(([, , p]) => has(p));
  const [tab, setTab] = useState(tabs[0]?.[0] || 'overview');
  if (!tabs.length) return html`<h1>Admin</h1><p class="lead">This account has no admin rights.</p>`;
  const cur = tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  const T = { overview: Overview, people: People, names: Names, ann: Announcements, update: Updates, admins: Admins, audit: Audit }[cur];
  return html`
    <h1>Admin</h1>
    <p class="lead">Changes here apply to the whole Snug network. The registry checks every action and keeps a log.</p>
    <div class="admin-tabs"><${Seg} label="Admin sections" value=${cur} options=${tabs.map(([id, label]) => [id, label])} onChange=${setTab} /></div>
    <div class="admin-body" key=${cur}><${T} Row=${Row} /></div>`;
}

/** Load once on mount; returns [data, reload]. */
function useAdmin(d) {
  const [data, setData] = useState(null);
  const load = () => adminCall(d).then(setData, (e) => { setData({ error: e.message }); });
  useEffect(() => { load(); }, []);
  return [data, load];
}

function Overview() {
  const [s, reload] = useAdmin({ a: 'stats' });
  if (!s) return html`<p class="faint" role="status">Loading…</p>`;
  if (s.error) return html`<p class="admin-err">${s.error}</p>`;
  const tiles = [
    ['Accounts', s.accounts], ['New today', s.new24h], ['New this week', s.new7d], ['Online now', s.online],
    ['Suspended', s.bans], ['Admins', s.admins], ['Waiting requests', s.knocks], ['Requests today', s.reqToday],
  ];
  return html`
    <div class="admin-stats" id="admin-stats">${tiles.map(([k, v]) => html`<div class="admin-stat" key=${k}><b>${Number(v).toLocaleString()}</b><span>${k}</span></div>`)}</div>
    ${s.relayOff && html`<p class="admin-err">The fallback relay is off for today: the network passed its daily request budget.</p>`}
    <button class="btn sm" onClick=${reload}>Refresh</button>`;
}

function FindPerson({ onFound, label = 'Find a person' }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const go = (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    adminCall({ a: 'user.find', q: q.trim() }).then(onFound, fail).finally(() => setBusy(false));
  };
  return html`<form class="admin-find" onSubmit=${go}>
    <input class="field" id="admin-find" placeholder="@username or account id" aria-label=${label} value=${q} onInput=${(e) => setQ(e.target.value)} maxlength="40" />
    <button class="btn primary" disabled=${busy}>Find</button>
  </form>`;
}

const DURATIONS = [['h1', '1 hour', 3600e3], ['d1', '1 day', 86400e3], ['d7', '7 days', 7 * 86400e3], ['d30', '30 days', 30 * 86400e3], ['ever', 'Until lifted', null]];

function PersonCard({ p, children }) {
  return html`<div class="admin-person" data-uid=${p.uid}>
    <div class="admin-person-h"><b>@${p.username}</b><span class="faint mono">${p.uid}</span></div>
    <div class="admin-person-m faint">
      Joined ${day(p.claimedAt)}${p.renamedAt ? ` · renamed ${day(p.renamedAt)}` : ''}${p.owner ? ' · owner' : p.perms?.length ? ` · admin (${p.perms.join(', ')})` : ''}
    </div>
    ${p.ban && html`<div class="admin-person-ban">Suspended ${p.ban.until ? `until ${when(p.ban.until)}` : 'until lifted'}: ${p.ban.reason}</div>`}
    ${children}
  </div>`;
}

function People() {
  const [p, setP] = useState(null);
  const [reason, setReason] = useState('');
  const [dur, setDur] = useState('d1');
  const [busy, setBusy] = useState(false);
  const [bans, reload] = useAdmin({ a: 'bans' });
  const refresh = () => (p ? adminCall({ a: 'user.find', q: p.uid }).then(setP, () => setP(null)) : null);
  const ban = () => {
    const d = DURATIONS.find(([k]) => k === dur);
    const until = d[2] ? Date.now() + d[2] : null;
    openModal(Confirm, {
      title: `Suspend @${p.username}?`, danger: true, action: 'Suspend',
      text: `${d[2] ? `For ${d[1]}.` : 'Until you lift it.'} Their Snug stops reaching friends on other PCs and shows them why.`,
      onConfirm: () => {
        setBusy(true);
        adminCall({ a: 'ban', uid: p.uid, reason: reason.trim(), until })
          .then(() => { toast(`@${p.username} is suspended.`); setReason(''); refresh(); reload(); }, fail).finally(() => setBusy(false));
      },
    });
  };
  const unban = (uid, name) => adminCall({ a: 'unban', uid }).then(() => { toast(`@${name}’s suspension is lifted. Their Snug reconnects within the hour.`); refresh(); reload(); }, fail);
  return html`
    <div class="set-head">Find someone</div>
    <${FindPerson} onFound=${setP} />
    ${p && html`<${PersonCard} p=${p}>
      ${p.owner ? html`<p class="faint">Nobody can act on the owner’s account.</p>` : html`
        ${p.ban ? html`<button class="btn sm" onClick=${() => unban(p.uid, p.username)}>Lift the suspension</button>` : html`
          <div class="admin-form">
            <input class="field" id="admin-reason" placeholder="Reason (they see this)" aria-label="Reason" maxlength="200" value=${reason} onInput=${(e) => setReason(e.target.value)} />
            <${Seg} label="How long" value=${dur} options=${DURATIONS.map(([k, t]) => [k, t])} onChange=${setDur} />
            <button class="btn sm danger" id="admin-ban" disabled=${busy || !reason.trim()} onClick=${ban}>Suspend</button>
          </div>`}`}
    <//>`}
    <div class="set-head">Suspended now</div>
    ${!bans ? html`<p class="faint">Loading…</p>` : bans.error ? html`<p class="admin-err">${bans.error}</p>` : !bans.bans.length ? html`<p class="faint">Nobody is suspended.</p>`
      : html`<ul class="admin-list" id="admin-bans">${bans.bans.map((b) => html`<li key=${b.uid}>
        <div class="grow"><b>@${b.username || b.uid}</b><span class="faint"> · ${b.until ? `until ${when(b.until)}` : 'until lifted'} · ${b.reason}${b.by ? ` · by @${b.by}` : ''}</span></div>
        <button class="btn sm" onClick=${() => unban(b.uid, b.username || b.uid)}>Lift</button>
      </li>`)}</ul>`}`;
}

function Names() {
  const [p, setP] = useState(null);
  const [newName, setNewName] = useState('');
  const [res, setRes] = useState('');
  const [note, setNote] = useState('');
  const [list, reload] = useAdmin({ a: 'name.reserved' });
  const rename = () => adminCall({ a: 'name.rename', uid: p.uid, name: newName.trim() })
    .then((r) => { toast(`Renamed to @${r.username}.`); setP({ ...p, username: r.username }); setNewName(''); }, fail);
  const free = () => openModal(Confirm, {
    title: `Free @${p.username}?`, danger: true, action: 'Free the name',
    text: 'Their account keeps working under a temporary name, and they can pick a new one at once.',
    onConfirm: () => adminCall({ a: 'name.free', name: p.username }).then((r) => { toast(`@${p.username} is free. They are @${r.username} for now.`); setP(null); }, fail),
  });
  const reserve = (e) => {
    e.preventDefault();
    adminCall({ a: 'name.reserve', name: res.trim(), note: note.trim() }).then(() => { toast(`@${res.trim().toLowerCase()} is reserved.`); setRes(''); setNote(''); reload(); }, fail);
  };
  const unreserve = (name) => adminCall({ a: 'name.unreserve', name }).then(() => { toast(`@${name} can be claimed again.`); reload(); }, fail);
  return html`
    <div class="set-head">Change someone’s username</div>
    <${FindPerson} onFound=${setP} />
    ${p && html`<${PersonCard} p=${p}>
      ${p.owner ? html`<p class="faint">Nobody can act on the owner’s account.</p>` : html`<div class="admin-form">
        <input class="field" id="admin-newname" placeholder="New username" aria-label="New username" maxlength="32" value=${newName} onInput=${(e) => setNewName(e.target.value)} />
        <button class="btn sm primary" disabled=${!newName.trim()} onClick=${rename}>Rename</button>
        <button class="btn sm danger" onClick=${free}>Free this name</button>
      </div>`}
    <//>`}
    <div class="set-head">Reserved names</div>
    <p class="faint">Nobody but the owner can claim a reserved name or one that looks like it. You can still give it to someone with Rename.</p>
    <form class="admin-form" onSubmit=${reserve}>
      <input class="field" id="admin-reserve" placeholder="Name" aria-label="Name to reserve" maxlength="32" value=${res} onInput=${(e) => setRes(e.target.value)} />
      <input class="field" placeholder="Note (only admins see it)" aria-label="Note" maxlength="200" value=${note} onInput=${(e) => setNote(e.target.value)} />
      <button class="btn sm primary" disabled=${!res.trim()}>Reserve</button>
    </form>
    ${!list ? html`<p class="faint">Loading…</p>` : list.error ? html`<p class="admin-err">${list.error}</p>` : !list.reserved.length ? html`<p class="faint">No names are reserved.</p>`
      : html`<ul class="admin-list" id="admin-reserved">${list.reserved.map((r) => html`<li key=${r.name}>
        <div class="grow"><b>@${r.name}</b>${r.note && html`<span class="faint"> · ${r.note}</span>`}</div>
        <button class="btn sm" onClick=${() => unreserve(r.name)}>Remove</button>
      </li>`)}</ul>`}`;
}

const ANN_FOR = [['ever', 'Until removed', null], ['d1', '1 day', 86400e3], ['d7', '7 days', 7 * 86400e3]];

function Announcements() {
  const [text, setText] = useState('');
  const [level, setLevel] = useState('info');
  const [dur, setDur] = useState('ever');
  const [busy, setBusy] = useState(false);
  const ann = S.notices?.ann || [];
  const add = (e) => {
    e.preventDefault();
    const d = ANN_FOR.find(([k]) => k === dur)[2];
    setBusy(true);
    adminCall({ a: 'ann.add', text: text.trim(), level, ...(d ? { until: Date.now() + d } : {}) })
      .then(() => { toast('Announced to everyone.'); setText(''); }, fail).finally(() => setBusy(false));
  };
  const remove = (id) => adminCall({ a: 'ann.remove', id }).then(() => toast('Announcement removed.'), fail);
  return html`
    <div class="set-head">New announcement</div>
    <p class="faint">Shown at the top of everyone’s Snug, on every PC. Up to 5 at a time.</p>
    <form class="admin-form col" onSubmit=${add}>
      <textarea class="field" id="admin-ann-text" rows="3" maxlength="500" placeholder="What everyone should know" aria-label="Announcement" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      <div class="admin-form">
        <${Seg} label="Kind" value=${level} options=${[['info', 'Info'], ['warn', 'Warning']]} onChange=${setLevel} />
        <${Seg} label="Show for" value=${dur} options=${ANN_FOR.map(([k, t]) => [k, t])} onChange=${setDur} />
        <button class="btn sm primary" id="admin-ann-add" disabled=${busy || !text.trim() || ann.length >= 5}>Announce</button>
      </div>
    </form>
    <div class="set-head">Showing now</div>
    ${!ann.length ? html`<p class="faint">No announcements.</p>` : html`<ul class="admin-list" id="admin-ann-list">${ann.map((a) => html`<li key=${a.id}>
      <div class="grow"><b>${a.level === 'warn' ? 'Warning' : 'Info'}</b><span class="faint"> · ${a.until ? `until ${when(a.until)}` : 'until removed'}</span><div>${a.text}</div></div>
      <button class="btn sm" onClick=${() => remove(a.id)}>Remove</button>
    </li>`)}</ul>`}`;
}

function Updates() {
  const [v, setV] = useState('');
  const min = S.notices?.min || null;
  const set = (value) => openModal(Confirm, {
    title: value ? `Require Snug ${value} or newer?` : 'Remove the minimum version?', danger: !!value, action: value ? 'Require it' : 'Remove',
    text: value ? 'Older Snugs stop reaching friends on other PCs at once and are told to update. You can’t set a version newer than your own.' : 'Every Snug version can use the network again.',
    onConfirm: () => adminCall({ a: 'min.set', v: value }).then(() => { toast(value ? `Snug ${value} or newer is required now.` : 'No minimum version now.'); setV(''); }, fail),
  });
  return html`
    <div class="set-head">Minimum Snug version</div>
    <p class="faint">${min ? html`Snug <b>${min}</b> or newer is required now.` : 'Any Snug version can use the network.'} Snug also updates itself whenever a new version is out.</p>
    <form class="admin-form" onSubmit=${(e) => { e.preventDefault(); if (/^\d+\.\d+\.\d+$/.test(v.trim())) set(v.trim()); else toast('Write a version like 0.10.0.'); }}>
      <input class="field" id="admin-min" placeholder="0.10.0" aria-label="Minimum version" maxlength="20" value=${v} onInput=${(e) => setV(e.target.value)} />
      <button class="btn sm primary" disabled=${!v.trim()}>Set minimum</button>
      ${min && html`<button type="button" class="btn sm" onClick=${() => set(null)}>Remove</button>`}
    </form>`;
}

function Admins() {
  const [list, reload] = useAdmin({ a: 'admins' });
  const [p, setP] = useState(null);
  const [perms, setPerms] = useState([]);
  const toggle = (k) => setPerms(perms.includes(k) ? perms.filter((x) => x !== k) : [...perms, k]);
  const grant = () => adminCall({ a: 'admin.grant', uid: p.uid, perms }).then(() => { toast(`@${p.username} has admin rights now.`); setP(null); setPerms([]); reload(); }, fail);
  const revoke = (uid, name) => adminCall({ a: 'admin.revoke', uid }).then(() => { toast(`@${name} is no longer an admin.`); reload(); }, fail);
  const pick = (found) => { setP(found); setPerms(found.perms || []); };
  return html`
    <div class="set-head">Give admin rights</div>
    <${FindPerson} onFound=${pick} />
    ${p && html`<${PersonCard} p=${p}>
      ${p.owner ? html`<p class="faint">The owner already has every right.</p>` : html`
        <div class="admin-perms" role="group" aria-label="Rights">${Object.entries(PERM_TEXT).map(([k, t]) => html`<label key=${k}><input type="checkbox" checked=${perms.includes(k)} onChange=${() => toggle(k)} /> ${t}</label>`)}</div>
        <button class="btn sm primary" id="admin-grant" disabled=${!perms.length} onClick=${grant}>Save rights</button>`}
    <//>`}
    <div class="set-head">Admins</div>
    ${!list ? html`<p class="faint">Loading…</p>` : list.error ? html`<p class="admin-err">${list.error}</p>` : !list.admins.length ? html`<p class="faint">Only you.</p>`
      : html`<ul class="admin-list" id="admin-admins">${list.admins.map((a) => html`<li key=${a.uid}>
        <div class="grow"><b>@${a.username || a.uid}</b><span class="faint"> · ${a.perms.map((k) => PERM_TEXT[k] || k).join(', ')}</span></div>
        <button class="btn sm" onClick=${() => revoke(a.uid, a.username || a.uid)}>Remove</button>
      </li>`)}</ul>`}`;
}

const ACTION_TEXT = {
  'user.find': 'looked up', 'name.rename': 'renamed', 'name.free': 'freed a name', 'name.reserve': 'reserved', 'name.unreserve': 'unreserved',
  ban: 'suspended', unban: 'lifted a suspension', 'ann.add': 'announced', 'ann.remove': 'removed an announcement', 'min.set': 'set the minimum version',
  'admin.grant': 'gave admin rights', 'admin.revoke': 'removed admin rights',
};

function Audit() {
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(true);
  const load = (before) => adminCall({ a: 'audit', ...(before ? { before } : {}) }).then((r) => {
    setRows((x) => (before ? [...(x || []), ...r.audit] : r.audit));
    setMore(r.audit.length === 50);
  }, (e) => setRows({ error: e.message }));
  useEffect(() => { load(); }, []);
  if (!rows) return html`<p class="faint">Loading…</p>`;
  if (rows.error) return html`<p class="admin-err">${rows.error}</p>`;
  if (!rows.length) return html`<p class="faint">Nothing yet.</p>`;
  return html`<ul class="admin-list audit" id="admin-audit">${rows.map((r) => html`<li key=${r.id}>
      <div class="grow"><b>@${r.byName || r.by}</b> ${ACTION_TEXT[r.a] || r.a}${r.target ? html` <span class="mono">${r.target}</span>` : ''}
        ${Object.keys(r.detail || {}).length > 0 && html`<div class="faint audit-detail">${Object.entries(r.detail).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')}</div>`}</div>
      <span class="faint">${when(r.at)}</span>
    </li>`)}</ul>
    ${more && html`<button class="btn sm" onClick=${() => load(rows[rows.length - 1].id)}>Older</button>`}`;
}
