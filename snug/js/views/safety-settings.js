// Settings pages for safety and moderation: Privacy and safety (yours), and a
// house's Reports, Bans, House log, Filter and screening, and Invitations.
// Every list is read from the server when the page opens; nothing is cached.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit, toast, openModal, person, jumpToMsg, closeLayer, updateHouse } from '../store.js';
import { call } from '../server.js';
import { can } from '../lib/perms.js';
import { fmtWhen, fmtFull } from '../lib/util.js';
import {
  PRIVACY_DM, PRIVACY_FRIENDS, REPORT_REASONS, FILTER_ACTIONS, TIMEOUTS, INVITE_AGES, INVITE_USES, spell, left, cleanWord, MAX_WORDS,
} from '../lib/safety.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Seg, Switch, Empty } from '../ui/kit.js';
import { Confirm } from './modals.js';
import { safety, unblockUser, liftTimeout, moderate, mayAct } from './safety.js';
import { copyText } from '../ui/kit.js';
import { JoinSafety, SpamRules, describeCommunity } from './community-settings.js'; // verification, pausing, spam rules, their log lines

const err = (e) => (e.offline ? 'You’re offline. Try again once you’re back.' : e.message);
function Row({ label, hint, children, top }) {
  return html`<div class=${`set-row${top ? ' top' : ''}`}>
    <div class="set-label"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div>
    <div class="set-ctl">${children}</div>
  </div>`;
}
// Load something from the server when the page opens; again on demand.
function useLoad(op, d, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: '' }));
    call(op, d).then((data) => {
      if (!live) return;
      if (data?.users) for (const [id, u] of Object.entries(data.users)) if (!S.users[id]) S.users[id] = u;
      setState({ loading: false, data, error: '' });
    }, (e) => live && setState({ loading: false, data: null, error: err(e) }));
    return () => { live = false; };
  }, [n, ...deps]);
  return [state, () => setN((x) => x + 1)];
}
const Loading = () => html`<div class="safe-loading" role="status"><span class="skel"></span><span class="skel" style="width:70%"></span><span class="skel" style="width:85%"></span><span class="sr">Loading</span></div>`;
const LoadError = ({ text, retry }) => html`<div class="err safe-error" role="alert"><${Icon} name="alert" size=${14} />${text}<button class="btn quiet sm" onClick=${retry}>Try again</button></div>`;
const Who = ({ id, sub }) => {
  const u = person(id);
  return html`<span class="safe-who"><${Avatar} user=${u} /><span class="trunc"><b>${u.name}</b>${sub ? html` <span class="faint">${sub}</span>` : html` <span class="faint">@${u.handle}</span>`}</span></span>`;
};

// ---------- Privacy and safety (personal settings) ----------
export function PrivacyPage() {
  const st = safety();
  const p = st.privacy;
  const set = (patch) => {
    S.safety = { ...st, privacy: { ...p, ...patch } };
    emit();
    call('privacy.set', patch).catch((e) => toast(err(e)));
  };
  return html`
    <h1>Privacy and safety</h1>
    <p class="lead">Who can reach you, and who you’ve blocked. Snug applies these on the server, for every device.</p>
    <${Row} label="Who can message you" hint="Starting a new conversation with you. Conversations you already have carry on." top>
      <${Seg} label="Who can message you" value=${p.dm} options=${PRIVACY_DM} onChange=${(v) => set({ dm: v })} />
    <//>
    <${Row} label="Message requests" hint=${p.dm === 'everyone'
      ? 'Conversations from people who aren’t your friends wait in a request until you accept. People with no house in common always do.'
      : 'Conversations from people who aren’t your friends wait in a request until you accept.'}>
      <${Switch} on=${p.requests} label="Message requests for people who aren’t friends" onChange=${(v) => set({ requests: v })} />
    <//>
    <${Row} label="Who can send you friend requests" top>
      <${Seg} label="Who can send you friend requests" value=${p.friends} options=${PRIVACY_FRIENDS} onChange=${(v) => set({ friends: v })} />
    <//>
    <div class="set-head">Blocked <span class="faint" style="font-weight:400">${st.blocks.length || ''}</span></div>
    ${st.blocks.length
      ? html`<ul class="safe-list" aria-label="Blocked people">${st.blocks.map((id) => html`<li key=${id} class="safe-item">
          <${Who} id=${id} />
          <button class="btn" onClick=${() => unblockUser(id)} aria-label=${`Unblock ${person(id).name}`}>Unblock</button>
        </li>`)}</ul>`
      : html`<p class="hint safe-empty">Nobody. Block someone from their profile or a message’s menu: they can’t message, call or befriend you, and their messages fold away.</p>`}`;
}

// ---------- House: reports ----------
const reasonLabel = (r) => (r === 'filter' ? 'Word filter' : REPORT_REASONS.find(([v]) => v === r)?.[1] || r);
export function HouseReports({ house }) {
  const [tab, setTab] = useState('open');
  const [state, reload] = useLoad('report.list', { house, status: tab }, [tab, S.houses[house]?.reportsOpen]);
  const h = S.houses[house];
  const timeouts = Object.entries(h.timeouts || {}).filter(([, until]) => until > Date.now());
  const resolve = (id, status) => call('report.resolve', { id, status }).then(reload, (e) => toast(err(e)));
  const list = state.data?.reports || [];
  return html`
    <h1>Reports</h1>
    <p class="lead">What people in ${h.name} reported, and what the word filter flagged. Only roles that can remove messages see this.</p>
    <${Seg} label="Which reports" value=${tab} options=${[['open', `Open${h.reportsOpen ? ` (${h.reportsOpen})` : ''}`], ['closed', 'Handled']]} onChange=${setTab} />
    <div class="safe-queue">
      ${state.loading && !state.data ? html`<${Loading} />` : state.error ? html`<${LoadError} text=${state.error} retry=${reload} />`
        : !list.length ? html`<${Empty} icon="shield" title=${tab === 'open' ? 'Nothing to look at' : 'Nothing handled yet'} text=${tab === 'open' ? 'New reports appear here as they come in.' : 'Reports you resolve or dismiss move here.'} />`
          : html`<ul class="safe-list" aria-label=${tab === 'open' ? 'Open reports' : 'Handled reports'}>${list.map((r) => html`<li key=${r.id} class="safe-report">
            <div class="safe-report-head">
              <span class=${`safe-tag${r.reason === 'filter' ? ' info' : ''}`}>${reasonLabel(r.reason)}</span>
              <${Who} id=${r.user} sub=${r.msg ? 'wrote' : 'was reported'} />
              <time class="faint num" datetime=${new Date(r.ts).toISOString()} title=${fmtFull(r.ts)}>${fmtWhen(r.ts)}</time>
            </div>
            ${r.msg && html`<blockquote class="report-quote">${r.text || html`<span class="faint">No text</span>`}${!r.live ? html` <span class="faint">(since deleted)</span>` : ''}</blockquote>`}
            ${r.note && html`<p class="safe-note">${r.reason === 'filter' ? r.note : `“${r.note}”`}</p>`}
            <div class="safe-report-foot">
              <span class="faint">${r.by ? `Reported by ${person(r.by).name}` : 'Flagged automatically'}${r.status !== 'open' && r.handledBy ? `. ${r.status === 'resolved' ? 'Resolved' : 'Dismissed'} by ${person(r.handledBy).name}` : ''}</span>
              <span class="grow"></span>
              ${r.msg && r.live && html`<button class="btn quiet sm" onClick=${() => { closeLayer(); jumpToMsg(r.conv, r.msg); }}>Go to message</button>`}
              ${r.status === 'open' && mayAct(house, r.user, 'timeout') && html`<button class="btn sm" onClick=${() => moderate(house, r.user, 'timeout')}>Time out</button>`}
              ${r.status === 'open' && mayAct(house, r.user, 'ban') && html`<button class="btn sm danger" onClick=${() => moderate(house, r.user, 'ban')}>Ban</button>`}
              ${r.status === 'open'
                ? html`<button class="btn sm" onClick=${() => resolve(r.id, 'dismissed')}>Dismiss</button><button class="btn sm primary" onClick=${() => resolve(r.id, 'resolved')}>Resolve</button>`
                : html`<button class="btn quiet sm" onClick=${() => resolve(r.id, 'open')}>Reopen</button>`}
            </div>
          </li>`)}</ul>`}
    </div>
    ${can(S, house, 'timeout') && html`
      <div class="set-head">Timed out now</div>
      ${timeouts.length ? html`<ul class="safe-list" aria-label="Timed out">${timeouts.map(([id, until]) => html`<li key=${id} class="safe-item">
        <${Who} id=${id} sub=${`${left(until - Date.now())} left`} />
        ${mayAct(house, id, 'timeout') && html`<button class="btn" onClick=${() => liftTimeout(house, id)}>Remove timeout</button>`}
      </li>`)}</ul>` : html`<p class="hint safe-empty">Nobody is timed out.</p>`}`}`;
}

// ---------- House: bans ----------
export function HouseBans({ house }) {
  const [state, reload] = useLoad('mod.bans', { house });
  const unban = (id) => openModal(Confirm, {
    title: `Unban ${person(id).name}?`, action: 'Unban',
    text: 'They can join again with an invitation, or by themselves if the house is public.',
    onConfirm: () => call('mod.unban', { house, user: id }).then(() => { toast(`${person(id).name} is unbanned.`); reload(); }, (e) => toast(err(e))),
  });
  const bans = state.data?.bans || [];
  return html`
    <h1>Bans</h1>
    <p class="lead">People who can’t come back to ${S.houses[house].name}, by link, invitation or Discover.</p>
    ${state.loading && !state.data ? html`<${Loading} />` : state.error ? html`<${LoadError} text=${state.error} retry=${reload} />`
      : !bans.length ? html`<${Empty} icon="shield" title="Nobody is banned" text="Ban someone from their profile or a message’s menu." />`
        : html`<ul class="safe-list" aria-label="Banned people">${bans.map((b) => html`<li key=${b.user} class="safe-item">
          <${Who} id=${b.user} sub=${`${b.reason ? `“${b.reason}”. ` : ''}By ${person(b.by).name}, ${fmtWhen(b.ts)}`} />
          <button class="btn" onClick=${() => unban(b.user)}>Unban</button>
        </li>`)}</ul>`}`;
}

// ---------- House: log ----------
const ACTIONS = [
  ['', 'Everything'], ['member', 'Members'], ['role', 'Roles'], ['room', 'Rooms'], ['house', 'House settings'],
  ['msg', 'Deleted messages'], ['voice', 'Voice'], ['invite', 'Invitations'], ['report', 'Reports'], ['emoji', 'Emoji'], ['sticker', 'Stickers'], ['sound', 'Soundboard'], ['hook', 'Webhooks'], ['automod', 'Word filter'],
  ['group', 'Categories'], ['event', 'Events'], // server/community.js
];
function describe(e, house) {
  const t = e.target && S.users[e.target] ? person(e.target).name : null;
  const d = e.detail || {};
  const roleName = (id) => S.houses[house]?.roles.find((r) => r.id === id)?.name || 'a role';
  const why = d.reason ? ` (“${d.reason}”)` : '';
  switch (e.action) {
    case 'member.join': return `joined${d.invite ? ' with an invitation link' : ''}`;
    case 'member.kick': return `removed ${t}${why}`;
    case 'member.ban': return `banned ${t}${why}${d.deleted ? `, deleting ${d.deleted} messages` : ''}`;
    case 'member.unban': return `unbanned ${t}`;
    case 'member.timeout': return `timed out ${t} for ${left(d.ms)}${why}`;
    case 'member.untimeout': return `removed ${t}’s timeout`;
    case 'member.role': return `gave ${t} the ${roleName(d.role)} role`;
    case 'role.create': return 'made a new role';
    case 'role.update': return `changed the ${d.name || roleName(e.target)} role${d.perms ? '’s permissions' : ''}`;
    case 'role.delete': return 'removed a role';
    case 'room.create': return `made the room ${d.name}`;
    case 'room.update': return `edited the room ${d.name}`;
    case 'room.delete': return `deleted the room ${d.name}`;
    case 'room.slowmode': return d.seconds ? `set slowmode in ${d.name} to ${spell(d.seconds)}` : `turned off slowmode in ${d.name}`;
    case 'house.update': return `changed the house’s ${(d.fields || []).join(', ') || 'settings'}`;
    case 'house.screening': return d.on ? 'turned on member screening' : 'turned off member screening';
    case 'msg.delete': return `deleted a message by ${t}${d.text ? `: “${d.text.slice(0, 80)}”` : ''}`;
    case 'voice.mute': return `muted ${t} in voice`;
    case 'voice.unmute': return `unmuted ${t} in voice`;
    case 'voice.deafen': return `deafened ${t} in voice`;
    case 'voice.undeafen': return `undeafened ${t} in voice`;
    case 'voice.move': return `moved ${t} from ${d.from} to ${d.to}`;
    case 'voice.disconnect': return `disconnected ${t} from ${d.room}`;
    case 'invite.create': return `made an invitation link${d.maxUses ? ` for ${d.maxUses} ${d.maxUses === 1 ? 'use' : 'uses'}` : ''}${d.maxAge === 0 ? ' that never expires' : ''}`;
    case 'invite.revoke': return 'revoked an invitation link';
    case 'invite.user': return `invited ${t}`;
    case 'report.resolved': return `resolved a report about ${t}`;
    case 'report.dismissed': return `dismissed a report about ${t}`;
    case 'report.open': return `reopened a report about ${t}`;
    case 'automod.update': return `changed the word filter (${d.words} words${d.links ? ', links blocked' : ''})`;
    case 'emoji.add': return `added the emoji :${d.name}:`;
    case 'emoji.rename': return `renamed an emoji to :${d.name}:`;
    case 'emoji.remove': return 'removed an emoji';
    case 'member.roles': return `changed ${t}’s extra roles`;
    case 'member.profile': {
      // Older entries only had the nickname.
      const f = d.fields || ['nick'];
      const parts = [];
      if (f.includes('nick')) parts.push(d.nick ? `nickname to ${d.nick}` : 'nickname back to their name');
      if (f.includes('emoji')) parts.push('picture');
      if (f.includes('hue')) parts.push('colour');
      return `changed ${t}’s ${parts.join(' and ') || 'house profile'}`;
    }
    case 'role.move': return `moved the ${roleName(e.target)} role`;
    case 'room.private': return d.on ? `made ${d.name} private` : `opened ${d.name} to everyone`;
    case 'room.override': return `changed who can do what in ${d.name}`;
    case 'room.voice': return `changed the user limit or quality of ${d.name}`;
    case 'room.tags': return `changed the tags in ${d.name}`;
    case 'house.welcome': return 'changed the welcome and interests';
    case 'hook.create': return `made the webhook ${d.hook} in ${d.name}`;
    case 'hook.delete': return `deleted a webhook in ${d.name}`;
    case 'hook.regen': return `gave a webhook in ${d.name} a new address`;
    case 'house.soundboard': return d.open ? 'opened the soundboard to everyone' : 'kept the soundboard to some roles';
    case 'sound.add': return `added the sound ${d.name}`;
    case 'sound.edit': return `edited the sound ${d.name}`;
    case 'sound.remove': return `removed the sound ${d.name}`;
    case 'sticker.add': return `added the sticker ${d.name}`;
    case 'sticker.remove': return `removed the sticker ${d.name}`;
    default: return describeCommunity(e, t) || e.action; // categories, pictures, verification, spam rules (js/views/community-settings.js)
  }
}
export function HouseLog({ house }) {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [pages, setPages] = useState([]);
  const d = { house, ...(action ? { action } : {}), ...(actor ? { actor } : {}) };
  const [state, reload] = useLoad('audit.list', d, [action, actor]);
  useEffect(() => setPages([]), [action, actor]);
  const entries = [...(state.data?.entries || []), ...pages.flatMap((p) => p.entries)];
  const more = pages.length ? pages[pages.length - 1].more : state.data?.more;
  const loadMore = () => call('audit.list', { ...d, before: entries[entries.length - 1].id }).then((p) => {
    for (const [id, u] of Object.entries(p.users || {})) if (!S.users[id]) S.users[id] = u;
    setPages([...pages, p]);
  }, (e) => toast(err(e)));
  const h = S.houses[house];
  const people = Object.keys(h.members).filter((id) => S.users[id]).sort((a, b) => person(a).name.localeCompare(person(b).name));
  return html`
    <h1>House log</h1>
    <p class="lead">Who changed what in ${h.name}, newest first.</p>
    <div class="safe-filters">
      <label class="sr" for="log-kind">Kind of change</label>
      <select id="log-kind" class="field" value=${action} onChange=${(e) => setAction(e.target.value)}>
        ${ACTIONS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
      </select>
      <label class="sr" for="log-who">Who</label>
      <select id="log-who" class="field" value=${actor} onChange=${(e) => setActor(e.target.value)}>
        <option value="">Anyone</option>
        ${people.map((id) => html`<option key=${id} value=${id}>${person(id).name}</option>`)}
      </select>
    </div>
    ${state.loading && !state.data ? html`<${Loading} />` : state.error ? html`<${LoadError} text=${state.error} retry=${reload} />`
      : !entries.length ? html`<${Empty} icon="eye" title="Nothing here yet" text=${action || actor ? 'Nothing matches. Try another kind of change, or anyone.' : 'Changes to roles, rooms, members and settings show up here.'} />`
        : html`<ol class="safe-log" aria-label="House log">${entries.map((e) => html`<li key=${e.id} class="safe-log-row">
          ${e.actor ? html`<${Avatar} user=${person(e.actor)} />` : html`<span class="safe-auto" aria-hidden="true"><${Icon} name="shield" size=${16} /></span>`}
          <span class="grow"><b>${e.actor ? person(e.actor).name : 'Automatic moderation'}</b> ${describe(e, house)}</span>
          <time class="faint num" datetime=${new Date(e.ts).toISOString()} title=${fmtFull(e.ts)}>${fmtWhen(e.ts)}</time>
        </li>`)}</ol>
        ${more && html`<button class="btn safe-more" onClick=${loadMore}>Show older</button>`}`}`;
}

// ---------- House: filter and screening (slowmode is per room, on Rooms and access) ----------
export function HouseFilter({ house }) {
  const h = S.houses[house];
  const [state, reload] = useLoad('automod.get', { house });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const cfg = state.data;
  const save = (patch) => call('automod.set', { house, ...patch }).then(() => reload(), (e) => { setError(err(e)); });
  const addWords = () => {
    const words = draft.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
    if (!words.length) return;
    const bad = words.find((w) => !cleanWord(w));
    if (bad) { setError(`“${bad}” can’t be filtered. Use letters and numbers, up to 40 characters, with * at the end for “starts with”.`); return; }
    if (cfg.words.length + words.length > MAX_WORDS) { setError(`The filter holds up to ${MAX_WORDS} words.`); return; }
    setError('');
    setDraft('');
    save({ words: [...cfg.words, ...words.map(cleanWord)] });
  };
  const rulesSet = !!(h.rules || '').trim();
  const screening = (on) => call('house.screening', { house, on }).catch((e) => toast(err(e)));
  return html`
    <h1>Filter and screening</h1>
    <p class="lead">Keep words and links out, and ask newcomers to accept the rules first. Owners and roles that manage the house skip the filter. Slowmode is set per room, on Rooms and access.</p>
    <div class="set-head">Rules and screening</div>
    <${Row} label="House rules" hint="One rule per line. Shown on the house page, in Discover, and to newcomers when screening is on." top>
      <textarea class="field safe-rules" rows="5" maxlength="2000" aria-label="House rules" placeholder="Be kind.\nNo spam or selling."
        onChange=${(e) => updateHouse(house, { rules: e.target.value.trim() })}>${h.rules || ''}</textarea>
    <//>
    <${Row} label="Newcomers accept the rules first" hint=${rulesSet ? 'Until they do, they can read but not write, react or join voice. People already here aren’t asked.' : 'Write the house rules above first, then turn this on.'}>
      <${Switch} on=${!!h.screening} label="Member screening" onChange=${(v) => (rulesSet || !v ? screening(v) : toast('Write the house rules first.'))} />
    <//>
    <div class="set-head">Word and link filter</div>
    ${state.loading && !cfg ? html`<${Loading} />` : state.error ? html`<${LoadError} text=${state.error} retry=${reload} />` : html`
      <${Row} label="Blocked words" hint="Whole words, any case or accent. End one with * to catch everything that starts with it." top>
        <div class="ed-int">
          ${cfg.words.length > 0 && html`<ul class="ed-chips" aria-label="Blocked words">${cfg.words.map((w) => html`<li key=${w} class="ed-chip">${w}
            <button class="ed-chip-x" aria-label=${`Remove ${w}`} onClick=${() => save({ words: cfg.words.filter((x) => x !== w) })}><${Icon} name="x" size=${12} /></button></li>`)}</ul>`}
          <div class="ed-add">
            <input class="field" placeholder="Add words, separated by commas" aria-label="Add blocked words" value=${draft} aria-invalid=${error ? 'true' : undefined} aria-describedby="filter-msg"
              onInput=${(e) => { setDraft(e.target.value); setError(''); }} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addWords(); } }} />
            <button class="btn" disabled=${!draft.trim()} onClick=${addWords}>Add</button>
          </div>
          <div id="filter-msg" class=${error ? 'err' : 'hint'} role=${error ? 'alert' : undefined}>${error || `${cfg.words.length} of ${MAX_WORDS}`}</div>
        </div>
      <//>
      <${Row} label="Block links" hint="Web addresses in messages, from anyone the filter applies to.">
        <${Switch} on=${cfg.links} label="Block links" onChange=${(v) => save({ links: v })} />
      <//>
      <${Row} label="When a message breaks the filter" top>
        <div class="safe-stack">
          <select class="field" aria-label="What happens" value=${cfg.action} onChange=${(e) => save({ action: e.target.value })}>
            ${FILTER_ACTIONS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
          </select>
          ${cfg.action === 'timeout' && html`<select class="field" aria-label="Timeout length" value=${cfg.timeoutMs} onChange=${(e) => save({ timeoutMs: Number(e.target.value) })}>
            ${TIMEOUTS.map(([v, l]) => html`<option key=${v} value=${v}>Time out for ${l}</option>`)}
          </select>`}
          <span class="hint">${cfg.action === 'flag' ? 'Flagged messages go to Reports.' : 'The person is told why it wasn’t sent.'}</span>
        </div>
      <//>
      <${Row} label="Roles the filter skips" top>
        <div class="safe-roles">${h.roles.slice(1).map((r) => html`<label key=${r.id} class="safe-check">
          <input type="checkbox" checked=${cfg.exempt.includes(r.id)} onChange=${(e) => save({ exempt: e.target.checked ? [...cfg.exempt, r.id] : cfg.exempt.filter((x) => x !== r.id) })} />${r.name}
        </label>`)}</div>
      <//>
      <${SpamRules} house=${house} cfg=${cfg} save=${save} />`}
    <${JoinSafety} house=${house} />
`;
}

// ---------- House: invitations ----------
export function HouseInvites({ house }) {
  const [state, reload] = useLoad('invite.list', { house });
  const [age, setAge] = useState(7 * 86_400_000);
  const [uses, setUses] = useState(0);
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const make = () => {
    setBusy(true);
    call('invite.create', { house, maxAge: age, maxUses: uses }).then((r) => { setBusy(false); setMade(`${location.origin}/join/${r.code}`); reload(); }, (e) => { setBusy(false); toast(err(e)); });
  };
  const revoke = (code) => openModal(Confirm, {
    title: 'Revoke this link?', danger: true, action: 'Revoke',
    text: 'Nobody can join with it any more. People who already joined stay.',
    onConfirm: () => call('invite.revoke', { house, code }).then(reload, (e) => toast(err(e))),
  });
  const list = state.data?.invites || [];
  return html`
    <h1>Invitations</h1>
    <p class="lead">${state.data?.all ? 'Every open link to this house, with who made it and how often it’s been used.' : 'The links you made to this house.'}</p>
    ${can(S, house, 'invite') && html`<div class="safe-make">
      <div><label class="label" for="inv-age">Expires after</label>
        <select id="inv-age" class="field" value=${age} onChange=${(e) => setAge(Number(e.target.value))}>${INVITE_AGES.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></div>
      <div><label class="label" for="inv-uses">Uses</label>
        <select id="inv-uses" class="field" value=${uses} onChange=${(e) => setUses(Number(e.target.value))}>${INVITE_USES.map((v) => html`<option key=${v} value=${v}>${v ? `${v} ${v === 1 ? 'use' : 'uses'}` : 'No limit'}</option>`)}</select></div>
      <button class="btn primary" aria-busy=${busy ? 'true' : undefined} disabled=${busy} onClick=${make}>Make a link</button>
    </div>`}
    ${made && html`<div class="copy-row safe-made">
      <input class="field" readonly value=${made} aria-label="New invitation link" onFocus=${(e) => e.target.select()} />
      <button class="btn" onClick=${() => copyText(made)}><${Icon} name="copy" size=${16} />Copy</button>
    </div>`}
    ${state.loading && !state.data ? html`<${Loading} />` : state.error ? html`<${LoadError} text=${state.error} retry=${reload} />`
      : !list.length ? html`<${Empty} icon="link" title="No open links" text="Links you make here, or from Invite people, show up until they expire, run out or are revoked." />`
        : html`<ul class="safe-list" aria-label="Open invitation links">${list.map((i) => html`<li key=${i.code} class="safe-item safe-invite">
          <code class="safe-code">${i.code}</code>
          <${Who} id=${i.by} sub=${`${i.uses}${i.maxUses ? ` of ${i.maxUses}` : ''} ${i.uses === 1 && !i.maxUses ? 'use' : 'uses'}. ${i.expires ? `Expires ${fmtWhen(i.expires)}` : 'Never expires'}`} />
          <button class="ib" aria-label=${`Copy link ${i.code}`} data-tip="Copy" onClick=${() => copyText(`${location.origin}/join/${i.code}`)}><${Icon} name="copy" size=${18} /></button>
          ${(i.by === S.me || can(S, house, 'roles')) && html`<button class="btn danger" aria-label=${`Revoke link ${i.code}`} onClick=${() => revoke(i.code)}>Revoke</button>`}
        </li>`)}</ul>`}`;
}

// Which of these pages a person may open in a house.
export const SAFETY_PAGES = [
  { id: 'reports', label: 'Reports', icon: 'alert', words: 'reports moderation queue flagged timeouts', need: (h) => can(S, h, 'moderate') || can(S, h, 'timeout') },
  { id: 'bans', label: 'Bans', icon: 'shield', words: 'bans banned unban', need: (h) => can(S, h, 'ban') },
  { id: 'log', label: 'House log', icon: 'eye', words: 'audit log history changes who did what', need: (h) => can(S, h, 'audit') },
  { id: 'filter', label: 'Filter and screening', icon: 'sliders', words: 'automod word filter links slowmode screening rules spam mentions flood caps raid verification pause lockdown two-factor', need: (h) => can(S, h, 'roles') },
  { id: 'invites', label: 'Invitations', icon: 'link', words: 'invites links expiry uses revoke', need: (h) => can(S, h, 'roles') },
];
export const SAFETY_VIEWS = { reports: HouseReports, bans: HouseBans, log: HouseLog, filter: HouseFilter, invites: HouseInvites };
