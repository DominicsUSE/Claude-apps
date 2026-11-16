// House settings for houses and community: the Overview page (name, colour,
// pictures, the house's own link, how newcomers are greeted, and the Danger
// zone: hand the house over, delete it), and the pieces Filter and screening
// gains (verification, two-factor for moderators, pausing invitations, spam
// rules). Every change is checked by the server (server/community.js).
import { html, useState, useRef } from '../../vendor/preact-htm.js';
import { S, openModal, closeModal, updateHouse, leaveHouse, toast, closeLayer, go } from '../store.js';
import { call } from '../server.js';
import { can, roleOf } from '../lib/perms.js';
import { HUES, hueOf, fuzzy } from '../lib/util.js';
import {
  PICTURES, PICTURE_TYPES, VERIFY_LEVELS, PAUSE_HOURS, pauseLabel, vanityProblem, SPAM_RULES, SPAM_ACTIONS,
} from '../lib/community.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Tile, Seg, Switch } from '../ui/kit.js';
import { Confirm } from './modals.js';
import { errText } from './community.js';
import { LocalNote } from './p2p.js'; // houses live on this PC

function Row({ label, hint, children, top, id }) {
  return html`<div class=${`set-row${top ? ' top' : ''}`} id=${id}>
    <div class="set-label"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div>
    <div class="set-ctl">${children}</div>
  </div>`;
}
const isOwner = (house) => { const h = S.houses[house]; return !!h && roleOf(S, house)?.id === h.roles[0].id; };
const picUrl = (id) => `/api/housepics/${id}`;

// ---------- Pictures ----------
async function uploadPicture(house, kind, file) {
  const spec = PICTURES[kind];
  if (file.size > spec.bytes) throw new Error(`${spec.label}s can be up to ${spec.bytes / 1024 / 1024} MB.`);
  let res;
  try {
    res = await fetch(`/api/files?housePic=${kind}&house=${encodeURIComponent(house)}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    });
  } catch { throw new Error('Can’t reach Snug. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'That picture didn’t upload. Try again.');
  return data;
}

function Picture({ house, kind }) {
  const h = S.houses[house];
  const spec = PICTURES[kind];
  const input = useRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = h[kind];
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try { const r = await uploadPicture(house, kind, file); h[kind] = r.id; toast(`${spec.label} updated.`); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const remove = () => updateHouse(house, { [kind]: null });
  const hint = kind === 'icon'
    ? `Square, up to ${spec.maxPx} pixels and 1 MB. Shown in the circle wherever ${h.name} appears.`
    : kind === 'banner' ? 'Wide, up to 2 MB. Across the top of the sidebar, and on Discover for a public house.'
      : 'Wide, up to 2 MB. Behind the invitation people see when they follow a link.';
  return html`<${Row} label=${spec.label} hint=${hint} top>
    <div class=${`cm-pic cm-pic-${kind}`}>
      ${kind === 'icon' || id ? html`<div class="cm-pic-preview" aria-hidden="true">
        ${kind === 'icon' ? html`<${Tile} house=${h} lg />` : html`<img src=${picUrl(id)} alt="" />`}
      </div>` : null}
      <div class="cm-pic-acts">
        ${kind !== 'icon' && !id && html`<span class="cm-pic-empty">None</span>`}
        <input ref=${input} type="file" accept=${PICTURE_TYPES.join(',')} hidden onChange=${pick} aria-label=${`Upload the ${spec.label.toLowerCase()}`} />
        <button class="btn" disabled=${busy} aria-busy=${busy ? 'true' : undefined} onClick=${() => input.current?.click()}>
          <${Icon} name="image" size=${16} />${busy ? 'Uploading…' : id ? 'Change' : 'Upload'}
        </button>
        ${id && html`<button class="btn quiet" disabled=${busy} onClick=${remove}>Remove</button>`}
      </div>
      ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    </div>
  <//>`;
}

// ---------- The house's own link ----------
function VanityLink({ house }) {
  const h = S.houses[house];
  const [word, setWord] = useState(h.vanity || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = isOwner(house);
  const save = (next) => {
    const w = next.trim().toLowerCase();
    if (w) { const p = vanityProblem(w); if (p) { setError(p); return; } }
    setBusy(true);
    call('house.vanity', { house, word: w || null }).then((r) => { setBusy(false); setError(''); setWord(r.word || ''); toast(r.word ? `${location.host}/join/${r.word} is yours.` : 'The link is cleared.'); },
      (e) => { setBusy(false); setError(errText(e)); });
  };
  return html`<${Row} label="The house’s own link" hint=${owner ? 'A short word anyone can use to join, like an invitation that never runs out. Bans and a pause still apply.' : 'Only an owner can set this.'} top>
    <div class="cm-vanity">
      <div class="cm-vanity-row">
        <span class="cm-vanity-pre faint">${location.host}/join/</span>
        <input class=${`field${error ? ' bad' : ''}`} value=${word} maxlength="32" placeholder="potters" disabled=${!owner}
          aria-label="Word for the house’s link" aria-invalid=${error ? 'true' : undefined} aria-describedby="cm-vanity-msg"
          onInput=${(e) => { setWord(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setError(''); }}
          onKeyDown=${(e) => { if (e.key === 'Enter') save(word); }} />
        ${owner && html`<button class="btn" disabled=${busy || word === (h.vanity || '')} onClick=${() => save(word)}>Save</button>`}
        ${owner && h.vanity && html`<button class="btn quiet" disabled=${busy} onClick=${() => save('')}>Clear</button>`}
      </div>
      <div id="cm-vanity-msg" class=${error ? 'err' : 'hint'} role=${error ? 'alert' : undefined}>${error || '3 to 32 lowercase letters, numbers and dashes. You can change it a few times an hour.'}</div>
    </div>
  <//>`;
}

// ---------- Danger zone ----------
function TransferHouse({ house }) {
  const h = S.houses[house];
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');
  const [stepDown, setStepDown] = useState(true);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const people = Object.keys(h.members).filter((id) => id !== S.me && S.users[id] && h.members[id] !== h.roles[0].id)
    .filter((id) => !q || fuzzy(q, `${S.users[id].name} ${S.users[id].handle}`) >= 0)
    .sort((a, b) => S.users[a].name.localeCompare(S.users[b].name)).slice(0, 8);
  const submit = () => {
    if (!who) { setError('Pick who gets the house.'); return; }
    setBusy(true);
    call('house.transfer', { house, user: who, stepDown, ...(code.trim() ? { code: code.trim() } : {}) }).then(() => { closeModal(); toast(`${S.users[who].name} owns ${h.name} now.`); },
      (e) => { setBusy(false); setError(errText(e)); });
  };
  return html`<h2>Give ${h.name} to someone</h2>
    <p class="modal-lead">They get the owner role: every permission, and the Danger zone. Owners can’t be removed or banned by anyone else.</p>
    <div>
      <label class="label" for="cm-transfer-q">Who</label>
      <input id="cm-transfer-q" class="field" type="search" data-autofocus placeholder="Find a member" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <ul class="cm-pick" role="listbox" aria-label="Members">
        ${people.map((id) => html`<li key=${id} role="option" aria-selected=${String(who === id)}>
          <button class=${`row${who === id ? ' sel' : ''}`} onClick=${() => { setWho(id); setError(''); }}>
            <span class="row-ic"><${Avatar} user=${S.users[id]} /></span><span class="grow trunc">${S.users[id].name} <span class="faint">@${S.users[id].handle}</span></span>
            ${who === id && html`<${Icon} name="check" size=${16} />`}
          </button>
        </li>`)}
        ${!people.length && html`<li class="faint cm-pick-none">Nobody matches.</li>`}
      </ul>
    </div>
    <label class="safe-check"><input type="checkbox" checked=${stepDown} onChange=${(e) => setStepDown(e.target.checked)} />Step down to ${h.roles[1]?.name || 'the next role'} myself</label>
    <div>
      <label class="label" for="cm-transfer-code">Two-factor code <span class="faint">(if you use two-factor sign-in)</span></label>
      <input id="cm-transfer-code" class="field" inputmode="numeric" autocomplete="one-time-code" maxlength="20" placeholder="Only with two-factor sign-in on" value=${code} onInput=${(e) => { setCode(e.target.value); setError(''); }} />
    </div>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn danger" disabled=${busy || !who} onClick=${submit}>${who ? `Give it to ${S.users[who].name.split(' ')[0]}` : 'Give the house'}</button>
    </div>`;
}

function DeleteHouse({ house }) {
  const h = S.houses[house];
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = name.trim() === h.name;
  const submit = (e) => {
    e.preventDefault();
    if (!ok) { setError(`Type ${h.name} exactly as it is.`); return; }
    setBusy(true);
    call('house.delete', { house, confirmName: name.trim(), ...(code.trim() ? { code: code.trim() } : {}) }).then(() => {
      closeModal(); closeLayer(); go({ type: 'home' }); toast(`${h.name} is deleted.`);
    }, (err) => { setBusy(false); setError(errText(err)); });
  };
  return html`<form class="form" onSubmit=${submit} novalidate>
    <h2>Delete ${h.name}?</h2>
    <p class="modal-lead">Every room, message, thread, file, event and webhook goes, for everyone, at once. Nobody can bring it back.</p>
    <div>
      <label class="label" for="cm-delete-name">Type the house’s name to confirm</label>
      <input id="cm-delete-name" class="field" data-autofocus autocomplete="off" placeholder=${h.name} value=${name}
        aria-invalid=${error ? 'true' : undefined} aria-describedby="cm-delete-msg" onInput=${(e) => { setName(e.target.value); setError(''); }} />
    </div>
    <div>
      <label class="label" for="cm-delete-code">Two-factor code <span class="faint">(if you use two-factor sign-in)</span></label>
      <input id="cm-delete-code" class="field" inputmode="numeric" autocomplete="one-time-code" maxlength="20" placeholder="Only with two-factor sign-in on" value=${code} onInput=${(e) => { setCode(e.target.value); setError(''); }} />
    </div>
    <div id="cm-delete-msg">${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}</div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn danger" disabled=${busy || !ok}>Delete ${h.name}</button>
    </div>
  </form>`;
}

// ---------- Overview ----------
export function CommunityOverview({ house }) {
  const h = S.houses[house];
  const manage = can(S, house, 'house');
  const owner = isOwner(house);
  const rooms = h.groups.flatMap((g) => g.rooms).map((id) => S.rooms[id]).filter((r) => r && (r.kind === 'text' || r.kind === 'news'));
  return html`
    <h1>${h.name}</h1>
    <p class="lead">What people see before and after they join.</p>
    <${LocalNote} />
    <${Row} label="Name"><input class="field set-field" value=${h.name} maxlength="40" aria-label="House name" disabled=${!manage}
      onChange=${(e) => e.target.value.trim() && updateHouse(house, { name: e.target.value.trim(), mark: e.target.value.trim()[0].toUpperCase() })} /><//>
    <${Row} label="About" hint="Shown on invitations and to newcomers." top>
      <textarea class="field set-field" rows="3" maxlength="160" aria-label="About this house" disabled=${!manage} onChange=${(e) => updateHouse(house, { about: e.target.value.trim() })}>${h.about}</textarea>
    <//>
    <${Row} label="Colour" hint="Behind the house’s letter, and around its icon." top>
      <div class="swatches" role="group" aria-label="House colour">
        ${HUES.map(([v, name]) => html`<button key=${v} class="swatch strong" style=${`--hue:${v}`} disabled=${!manage} aria-pressed=${String(hueOf(h.hue) === v)} aria-label=${name} onClick=${() => updateHouse(house, { hue: v })}></button>`)}
      </div>
    <//>
    ${manage && html`<div class="set-head">Pictures</div>
      <${Picture} house=${house} kind="icon" />
      <${Picture} house=${house} kind="banner" />
      <${Picture} house=${house} kind="splash" />`}
    <div class="set-head">Joining</div>
    <${VanityLink} house=${house} />
    ${manage && html`
      <${Row} label="Announce newcomers in" hint="A line when someone joins, with a button to say hi. During a rush of joins only the first few are announced." top>
        <select class="field" aria-label="Room to announce newcomers in" value=${h.announceRoom || ''} onChange=${(e) => updateHouse(house, { announceRoom: e.target.value || null })}>
          <option value="">Don’t announce</option>
          ${rooms.map((r) => html`<option key=${r.id} value=${r.id}>${r.name}</option>`)}
        </select>
      <//>
      <${Row} label="Notifications for new members" hint="Where they start. Each person can change it from the house menu.">
        <${Seg} label="Default notifications for new members" value=${h.defaultNotify || 'all'} options=${[['all', 'Everything'], ['mentions', 'Only mentions']]} onChange=${(v) => updateHouse(house, { defaultNotify: v })} />
      <//>`}
    <div class="set-head cm-danger-head">Danger zone</div>
    <div class="cm-danger">
      ${owner && html`<${Row} label="Give the house to someone" hint="Another member becomes an owner. You can step down a role at the same time.">
        <button class="btn" onClick=${() => openModal(TransferHouse, { house })}>Transfer ownership</button>
      <//>`}
      ${owner && html`<${Row} label=${`Delete ${h.name}`} hint="Everything in it goes, for everyone. It can’t be undone.">
        <button class="btn danger" onClick=${() => openModal(DeleteHouse, { house })}>Delete house</button>
      <//>`}
      <${Row} label=${`Leave ${h.name}`} hint="Its rooms leave your sidebar. You’ll need a new invitation to come back.">
        <button class="btn danger" onClick=${() => openModal(Confirm, { title: `Leave ${h.name}?`, danger: true, action: 'Leave house', text: 'You’ll need a new invitation to come back.', onConfirm: () => leaveHouse(house).catch((e) => toast(e.message)) })}>Leave house</button>
      <//>
    </div>`;
}

// ---------- Filter and screening: who may take part ----------
export function JoinSafety({ house }) {
  const h = S.houses[house];
  const may = can(S, house, 'house') || can(S, house, 'ban');
  const owner = isOwner(house);
  const [error, setError] = useState('');
  const set = (patch) => call('house.safety', { house, ...patch }).then(() => setError(''), (e) => setError(errText(e)));
  const paused = h.pausedUntil && (h.pausedUntil === -1 || h.pausedUntil > Date.now());
  if (!may) return null;
  return html`
    <div class="set-head">Who may take part</div>
    <${Row} label="Verification" hint="Newcomers who don’t meet it can read, but wait to write, react or join voice. Moderators and owners never wait." top>
      <div class="cm-radios" role="radiogroup" aria-label="Verification level">
        ${VERIFY_LEVELS.map(([v, l, hint]) => html`<label key=${v} class=${`cm-radio${(h.verify || 'none') === v ? ' on' : ''}`}>
          <input type="radio" name=${`verify-${house}`} value=${v} checked=${(h.verify || 'none') === v} onChange=${() => set({ verify: v })} />
          <span><b>${l}</b><span class="hint">${hint}</span></span>
        </label>`)}
      </div>
    <//>
    <${Row} label="Pause invitations" hint=${paused ? (h.pausedUntil === -1 ? 'Paused until someone lifts it. Links and joining from Discover are refused with a note.' : `Paused until ${new Date(h.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`) : 'For a raid: nobody new can join for a while. People already here aren’t affected.'} top>
      <div class="safe-stack">
        ${paused ? html`<button class="btn primary" onClick=${() => set({ pause: null })}>Lift the pause</button>`
          : html`<div class="cm-chips" role="group" aria-label="Pause invitations for">${PAUSE_HOURS.map((n) => html`<button key=${n} class="chip" onClick=${() => set({ pause: n })}>${pauseLabel(n)}</button>`)}</div>`}
      </div>
    <//>
    <${Row} label="Moderators need two-factor sign-in" hint=${owner ? 'Removing, banning, timing out and deleting other people’s messages need two-factor sign-in on the moderator’s account.' : 'Only an owner can change this.'}>
      <${Switch} on=${!!h.mod2fa} disabled=${!owner} label="Moderators need two-factor sign-in" onChange=${(v) => set({ mod2fa: v })} />
    <//>
    ${error && html`<p class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</p>`}`;
}

// ---------- Filter and screening: spam rules ----------
export function SpamRules({ house, cfg, save }) {
  const h = S.houses[house];
  if (!cfg) return null;
  const rooms = h.groups.flatMap((g) => g.rooms).map((id) => S.rooms[id]).filter((r) => r && r.kind !== 'voice' && r.kind !== 'stage');
  const exempt = cfg.exemptRooms || [];
  return html`
    <div class="set-head">Spam rules</div>
    ${SPAM_RULES.map((r) => {
      const numeric = r.min != null;
      const on = numeric ? cfg[r.id] > 0 : !!cfg[r.id];
      const action = cfg[`${r.id}Action`] || 'block';
      return html`<${Row} key=${r.id} label=${r.label} hint=${r.hint} top>
        <div class="cm-rule">
          <${Switch} on=${on} label=${r.label} onChange=${(v) => save({ [r.id]: numeric ? (v ? r.def : 0) : v })} />
          ${numeric && on && html`<label class="cm-num"><span class="sr">${r.label}: limit</span>
            <input class="field num" type="number" min=${r.min} max=${r.max} value=${cfg[r.id]} aria-label=${`${r.label} limit, ${r.min} to ${r.max}`}
              onChange=${(e) => { const n = Math.round(Number(e.target.value)); if (n >= r.min && n <= r.max) save({ [r.id]: n }); else toast(`${r.label}: pick ${r.min} to ${r.max}.`); }} />
            <span class="faint">${r.unit}</span></label>`}
          ${on && html`<select class="field" aria-label=${`When ${r.label.toLowerCase()} happens`} value=${action} onChange=${(e) => save({ [`${r.id}Action`]: e.target.value })}>
            ${SPAM_ACTIONS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
          </select>`}
        </div>
      <//>`;
    })}
    <${Row} label="Rooms these rules skip" hint="The word filter skips them too. Roles the filter skips, above, skip these rules as well." top>
      <div class="safe-roles">${rooms.map((r) => html`<label key=${r.id} class="safe-check">
        <input type="checkbox" checked=${exempt.includes(r.id)} onChange=${(e) => save({ exemptRooms: e.target.checked ? [...exempt, r.id] : exempt.filter((x) => x !== r.id) })} />${r.name}
      </label>`)}</div>
    <//>`;
}

// What the house log says about the changes made here.
export function describeCommunity(e, t) {
  const d = e.detail || {};
  switch (e.action) {
    case 'group.create': return `made the category ${d.name}`;
    case 'group.update': return `renamed the category ${d.was ? `${d.was} to ` : ''}${d.name}`;
    case 'group.delete': return `deleted the category ${d.name}${d.rooms ? `, moving its rooms to ${d.moveTo}` : ''}`;
    case 'group.move': return `moved the category ${d.name}`;
    case 'room.move': return d.hidden ? 'moved a private room' : `moved ${d.name}${d.group ? ` to ${d.group}` : ''}`;
    case 'house.picture': return `changed the house’s ${PICTURES[d.kind]?.label.toLowerCase() || 'picture'}`;
    case 'house.transfer': return `gave the house to ${t}${d.stepDown ? ' and stepped down' : ''}`;
    case 'house.verify': return `set verification to “${VERIFY_LEVELS.find(([v]) => v === d.level)?.[1] || d.level}”`;
    case 'house.pause': return `paused invitations ${d.hours ? `for ${pauseLabel(d.hours)}` : 'until lifted'}`;
    case 'house.unpause': return 'lifted the invitation pause';
    case 'house.mod2fa': return d.on ? 'asked moderators for two-factor sign-in' : 'stopped asking moderators for two-factor sign-in';
    case 'house.vanity': return d.word ? `set the house’s link to /join/${d.word}` : 'cleared the house’s link';
    case 'automod.hit': return `stopped a message by ${t} (${SPAM_RULES.find((r) => r.id === d.rule)?.label.toLowerCase() || d.rule})`;
    case 'automod.spam': return 'changed the spam rules';
    case 'event.update': return `changed the event ${d.title}`;
    case 'event.delete': return `cancelled the event ${d.title}`;
    default: return null;
  }
}
