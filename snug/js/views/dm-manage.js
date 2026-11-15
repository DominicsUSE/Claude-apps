// Managing direct conversations and groups: the menu items (close, pin,
// rename, icon, add people, leave), their dialogs, the header's Add people
// and members popover, and the line a change writes into the conversation.
// The server checks every rule again (server/dms.js).
import { html, useState } from '../../vendor/preact-htm.js';
import { EncLine, ServerNoteMark } from './e2ee-conv.js';
import { S, closeModal, closePop, openModal, openPop, openConv, convMeta, person, go } from '../store.js';
import { fuzzy, HUES } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar } from '../ui/kit.js';
import { Confirm } from './modals.js';
import { ttlLabel } from '../lib/expiry.js'; // 0.12: the disappearing-messages line
import { hideDm, pinDm, renameDm, iconDm, addToDm, leaveDm, kickFromDm, isGroupDm } from '../inbox.js';
import { isPeerGroup, remoteOf } from './p2p.js'; // groups with friends on other PCs (server/peergroups.js)

export const MAX_GROUP = 10;
export const MAX_PEER_GROUP = 25; // a group between PCs (server/grouplog.js)
// A conversation with friends on other PCs takes only friends on other PCs; any other takes only people here.
const acrossPcs = (id) => isPeerGroup(id) || !!remoteOf(id);
const maxFor = (id) => (acrossPcs(id) ? MAX_PEER_GROUP : MAX_GROUP);
const firstName = (u) => person(u).name.split(' ')[0];
const rectOf = (e) => e.currentTarget.getBoundingClientRect();

// ---------- Menu items for a conversation (js/views/nav.js dmMenu) ----------
export function dmManageItems(id) {
  const dm = S.dms[id];
  if (!dm) return [];
  const group = isGroupDm(id);
  return [
    { sep: true },
    { label: dm.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onSelect: () => pinDm(id, !dm.pinned) },
    { label: 'Add people', icon: 'user-plus', onSelect: () => openModal(AddPeople, { dm: id }) },
    group && { label: 'Rename group', icon: 'edit', onSelect: () => openModal(RenameGroup, { dm: id }) },
    group && { label: 'Change icon', icon: 'smile', onSelect: () => openModal(GroupIcon, { dm: id }) },
    { sep: true },
    { label: 'Close conversation', icon: 'x', onSelect: () => hideDm(id) },
    group && { label: 'Leave group', icon: 'leave', danger: true, onSelect: () => confirmLeave(id) },
  ];
}

function confirmLeave(id) {
  const meta = convMeta(id);
  openModal(Confirm, {
    title: `Leave ${meta?.title || 'this group'}?`, danger: true, action: 'Leave group',
    text: 'You stop getting its messages and lose its history. Someone in it can add you back.',
    onConfirm: () => leaveDm(id).catch(() => {}),
  });
}

// The group's icon wherever a conversation shows one, or null for the default.
export function groupFace(id, size) {
  const dm = S.dms[id];
  if (!dm?.icon?.emoji) return null;
  return html`<${Avatar} user=${{ id, name: dm.name || 'Group', hue: dm.icon.hue ?? 165, emoji: dm.icon.emoji }} size=${size} />`;
}

// ---------- Rename ----------
export function RenameGroup({ dm: id }) {
  const dm = S.dms[id];
  const [name, setName] = useState(dm?.name || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!dm) return null;
  const submit = (e) => {
    e.preventDefault();
    const clean = name.trim();
    if ([...clean].length > 40) return setError('The name can be at most 40 characters.');
    setBusy(true);
    renameDm(id, clean || null).then(closeModal, (err) => { setBusy(false); setError(err.offline ? 'You’re offline. Try again when you’re back.' : err.message); });
    return undefined;
  };
  return html`<form class="form" onSubmit=${submit} novalidate>
    <h2>Rename group</h2>
    <p class="modal-lead">Everyone in it sees the new name. Leave it empty to show people’s names instead.</p>
    <div>
      <label class="label" for="dm-name">Name</label>
      <input id="dm-name" class=${`field${error ? ' bad' : ''}`} data-autofocus maxlength="40" placeholder=${convMeta(id)?.title || 'Kiln crew'} value=${name}
        aria-invalid=${String(!!error)} aria-describedby="dm-name-msg" onInput=${(e) => { setName(e.target.value); setError(''); }} />
      ${error ? html`<div class="err" id="dm-name-msg" role="alert"><${Icon} name="alert" size=${14} />${error}</div>` : html`<div class="hint" id="dm-name-msg">Up to 40 characters.</div>`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" disabled=${busy} aria-busy=${String(busy)}>${busy ? 'Saving…' : 'Save'}</button>
    </div>
  </form>`;
}

// ---------- Icon ----------
const ICONS = ['🔥', '🌿', '🎨', '🎮', '🎵', '📚', '☕', '🍕', '🏔️', '🌊', '🚲', '🧶', '🪴', '⚽', '🎬', '🧪', '🐾', '🌙', '⭐', '🏠'];
export function GroupIcon({ dm: id }) {
  const dm = S.dms[id];
  const [emoji, setEmoji] = useState(dm?.icon?.emoji || null);
  const [hue, setHue] = useState(dm?.icon?.hue ?? HUES[2][0]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!dm) return null;
  const save = () => {
    setBusy(true);
    iconDm(id, emoji, emoji ? hue : null).then(closeModal, (err) => { setBusy(false); setError(err.message); });
  };
  return html`
    <h2>Group icon</h2>
    <p class="modal-lead">An emoji and a colour, so the group is easy to spot.</p>
    <div class="dm-icon-preview">${emoji ? html`<${Avatar} user=${{ id, name: dm.name || 'Group', hue, emoji }} size=${48} />` : html`<span class="avatar" style="--sz:48px;--tile-c:0;--tile-ink-c:0">${dm.members.length}</span>`}</div>
    <div class="label" id="dm-icon-emoji">Emoji</div>
    <div class="dm-icon-grid" role="radiogroup" aria-labelledby="dm-icon-emoji">
      <button class=${`dm-icon-opt${!emoji ? ' on' : ''}`} role="radio" aria-checked=${String(!emoji)} aria-label="No icon" onClick=${() => setEmoji(null)}><${Icon} name="x" size=${16} /></button>
      ${ICONS.map((e) => html`<button key=${e} class=${`dm-icon-opt${emoji === e ? ' on' : ''}`} role="radio" aria-checked=${String(emoji === e)} aria-label=${e} onClick=${() => setEmoji(e)}>${e}</button>`)}
    </div>
    <div class="label" id="dm-icon-hue">Colour</div>
    <div class="dm-hue-row" role="radiogroup" aria-labelledby="dm-icon-hue">
      ${HUES.map(([h, label]) => html`<button key=${h} class=${`dm-hue${hue === h ? ' on' : ''}`} role="radio" aria-checked=${String(hue === h)} aria-label=${label} disabled=${!emoji}
        style=${`--hue:${h}`} onClick=${() => setHue(h)}></button>`)}
    </div>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn primary" data-autofocus disabled=${busy} aria-busy=${String(busy)} onClick=${save}>${busy ? 'Saving…' : 'Save'}</button>
    </div>`;
}

// ---------- Add people ----------
// Friends and people you share a house with, who aren't here yet. Adding to a
// conversation between two people starts a new group (the server says so).
export function AddPeople({ dm: id }) {
  const dm = S.dms[id];
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!dm) return null;
  const max = maxFor(id);
  const room = max - dm.members.length;
  const blocks = new Set(S.safety?.blocks || []);
  const across = acrossPcs(id);
  // Across PCs: friends on other PCs only (the server checks friendship again).
  const fits = (u) => (across ? !!u.remote && S.friends?.[u.id]?.state === 'friends' : !u.remote);
  const people = Object.values(S.users).filter((u) => u.id !== S.me && !dm.members.includes(u.id) && !blocks.has(u.id) && u.handle !== 'gone' && fits(u))
    .map((u) => ({ u, s: Math.max(fuzzy(q, u.name), fuzzy(q, u.handle)) }))
    .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.u.name.localeCompare(b.u.name)).map((x) => x.u).slice(0, 50);
  const toggle = (uid) => {
    setError('');
    if (picked.includes(uid)) setPicked(picked.filter((x) => x !== uid));
    else if (picked.length >= room) setError(`A group can have up to ${max} people.`);
    else setPicked([...picked, uid]);
  };
  const add = () => {
    setBusy(true);
    addToDm(id, picked).then((r) => { closeModal(); if (r?.id && r.id !== id) openConv(r.id); }, (err) => { setBusy(false); setError(err.offline ? 'You’re offline. Try again when you’re back.' : err.message); });
  };
  const group = isGroupDm(id);
  return html`
    <h2>Add people</h2>
    <p class="modal-lead">${across && group ? `Up to ${max} people, friends on other PCs only. They see messages from now on, not what was said before.`
      : group ? `Up to ${max} people in a group. They can read what was said before.` : 'This starts a new group. Your conversation with the two of you stays as it is.'}</p>
    <input class="field" data-autofocus placeholder="Find someone" aria-label="Find someone" value=${q} onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && people[0] && q) { e.preventDefault(); toggle(people[0].id); setQ(''); } }} />
    <div class="picked">
      ${picked.map((uid) => html`<button key=${uid} class="chip on" onClick=${() => toggle(uid)} aria-label=${`Remove ${person(uid).name}`}>${person(uid).name}<${Icon} name="x" size=${14} /></button>`)}
    </div>
    <div class="pick-list" role="listbox" aria-multiselectable="true" aria-label="People">
      ${people.map((u) => html`<button key=${u.id} class="menu-item" role="option" aria-selected=${String(picked.includes(u.id))} onClick=${() => toggle(u.id)}>
        <${Avatar} user=${u} presence /><span class="grow trunc">${u.name}</span>
        ${picked.includes(u.id) && html`<span class="end"><${Icon} name="check" size=${16} /></span>`}
      </button>`)}
      ${!people.length && html`<div class="picker-none">${q ? `Nobody called “${q}”` : 'Everyone you know is already here.'}</div>`}
    </div>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn primary" disabled=${!picked.length || busy} aria-busy=${String(busy)} onClick=${add}>${group ? 'Add' : 'Start group'}</button>
    </div>`;
}

// ---------- Members popover ----------
export function MembersPop({ dm: id }) {
  const dm = S.dms[id];
  if (!dm) return null;
  const owner = dm.owner;
  return html`<div class="dm-members">
    <div class="dm-members-head"><b>${dm.members.length} ${dm.members.length === 1 ? 'person' : 'people'}</b>
      ${dm.members.length < maxFor(id) && html`<button class="btn sm" data-autofocus onClick=${() => { closePop(); openModal(AddPeople, { dm: id }); }}><${Icon} name="user-plus" size=${16} />Add</button>`}
    </div>
    <ul class="dm-members-list" aria-label="People in this conversation">
      ${dm.members.map((uid) => {
        const u = person(uid);
        return html`<li key=${uid} class="dm-member">
          <button class="dm-member-main" onClick=${() => { closePop(); go({ type: 'person', id: uid }); }}>
            <${Avatar} user=${u} size=${32} presence />
            <span class="grow trunc">${u.name}${uid === S.me ? ' (you)' : ''}</span>
            ${uid === owner && html`<span class="tag">Owner</span>`}
          </button>
          ${owner === S.me && uid !== S.me && html`<button class="ib sm" aria-label=${`Remove ${u.name}`} data-tip="Remove" onClick=${() => {
            closePop();
            openModal(Confirm, { title: `Remove ${firstName(uid)}?`, danger: true, action: 'Remove', text: `${u.name} stops getting messages here and loses the history.`, onConfirm: () => kickFromDm(id, uid).catch(() => {}) });
          }}><${Icon} name="x" size=${16} /></button>`}
        </li>`;
      })}
    </ul>
  </div>`;
}

// The header's buttons for a direct conversation: Add people, and the members of a group.
export function DmHeaderButtons({ conv }) {
  const dm = S.dms[conv];
  if (!dm) return null;
  const group = isGroupDm(conv);
  return html`
    <button class="ib" aria-label="Add people" data-tip="Add people" onClick=${() => openModal(AddPeople, { dm: conv })}><${Icon} name="user-plus" /></button>
    ${group && html`<button class="ib" aria-label=${`Manage members, ${dm.members.length}`} data-tip="Manage members"
      onClick=${(e) => openPop({ anchor: rectOf(e), label: 'Members', C: MembersPop, props: { dm: conv } })}><${Icon} name="settings" /></button>`}`;
}

// The same, as menu items for the phone's header menu (js/views/conversation.js).
export function dmHeaderItems(conv, anchor) {
  const dm = S.dms[conv];
  if (!dm) return [];
  return [
    { label: 'Add people', icon: 'user-plus', onSelect: () => openModal(AddPeople, { dm: conv }) },
    isGroupDm(conv) && { label: `Members (${dm.members.length})`, icon: 'people', onSelect: () => setTimeout(() => openPop({ anchor, label: 'Members', C: MembersPop, props: { dm: conv } }), 0) },
  ];
}

// ---------- The line a change writes ----------
export function DmLine({ conv, m }) {
  const l = m.dmLine || {};
  if (l.act === 'e2ee') return html`<${EncLine} m=${m} />`; // the conversation turned end-to-end encrypted (js/views/e2ee-conv.js)
  const by = person(l.by || m.author);
  const name = (u) => html`<b>${person(u).name}</b>`;
  let text;
  if (l.act === 'rename') text = l.name ? html`${name(by.id)} named the group <b>${l.name}</b>` : html`${name(by.id)} removed the group’s name`;
  else if (l.act === 'icon') text = html`${name(by.id)} changed the group’s icon`;
  else if (l.act === 'add') text = html`${name(by.id)} added ${(l.users || []).map((u, i) => html`${i ? ', ' : ''}${name(u)}`)}`;
  else if (l.act === 'leave') text = html`${name(by.id)} left the group`;
  else if (l.act === 'kick') text = html`${name(by.id)} removed ${name(l.user)}`;
  else if (l.act === 'ttl') text = l.ttl ? html`${name(by.id)} set messages to disappear after <b>${ttlLabel(l.ttl)}</b>` : html`${name(by.id)} turned off disappearing messages`; // 0.12
  else text = m.text;
  const icon = l.act === 'add' ? 'user-plus' : l.act === 'leave' || l.act === 'kick' ? 'leave' : l.act === 'ttl' ? 'clock' : 'edit';
  return html`<div class="joinline dmline" role="note" data-mid=${m.id}>
    <span class="dmline-ic" aria-hidden="true"><${Icon} name=${icon} size=${16} /></span>
    <span class="joinline-text">${text}</span>
    <${ServerNoteMark} conv=${conv} />
    <time class="joinline-time num" datetime=${new Date(m.ts).toISOString()}>${new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
  </div>`;
}
