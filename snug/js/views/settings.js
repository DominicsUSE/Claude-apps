// Settings: a full layer with its own sidebar. Personal settings in one, a
// house's settings in another. Every change applies at once; nothing to save.
import { html, useState } from '../../vendor/preact-htm.js';
import {
  S, me, closeLayer, setPref, updateMe, setNotify, openModal, updateHouse,
  setMemberRole, leaveHouse, removeMember, signedOut, toast, openMenu,
} from '../store.js';
import { api, stopTransport } from '../server.js';
import { leaveVoice } from '../voice.js';
import { LEVEL_LABEL, levelOf, roomIds } from '../lib/attention.js';
import { can } from '../lib/perms.js';
import { fuzzy, HUES, hueOf } from '../lib/util.js';
import { LIMITS, cleanInterests, safeLink } from '../lib/social.js';
import { Icon } from '../ui/icons.js';
import { Nook } from '../ui/brand.js';
import { Avatar, Tile, Seg, Switch, PRESENCE } from '../ui/kit.js';
import { Message } from './stream.js';
import { Confirm } from './modals.js';
import { PushSetting } from './push-setting.js'; // notifications when Snug is closed
import { pushSignOut } from '../push.js';
import { HouseEmoji } from './emoji-settings.js'; // House settings > Emoji
import { withStickers } from './messaging.js'; // stickers on the Emoji page
import { PrivacyPage, SAFETY_PAGES, SAFETY_VIEWS } from './safety-settings.js'; // privacy, blocks, moderation pages
import { personItems, mayAct } from './safety.js'; // Remove lives in the Moderate menu when you may kick
import { PLACES_PAGES, PLACES_VIEWS, WelcomePage } from './places-settings.js'; // roles with order and icons, rooms and access, welcome, insights
import { VoiceSettings, HouseVoice } from './voiceopts-settings.js'; // Voice and video; House settings > Voice
import { setVoiceSettingsOpener, setHouseVoiceOpener } from './voiceopts.js';
import { openLayer as openVoiceLayer } from '../store.js';
import { registerAccountPages } from './account.js'; // appearance, accessibility, streamer mode, security, your data, profile extras

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';

function Row({ label, hint, children, top }) {
  return html`<div class=${`set-row${top ? ' top' : ''}`}>
    <div class="set-label"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div>
    <div class="set-ctl">${children}</div>
  </div>`;
}

// Pages in runs that share a section name, in order.
function groups(pages) {
  const out = [];
  for (const p of pages) {
    const last = out[out.length - 1];
    if (last && last.section === (p.section || null)) last.pages.push(p);
    else out.push({ section: p.section || null, key: `${out.length}-${String(p.section || '').replace(/\W+/g, '-')}`, pages: [p] });
  }
  return out;
}

function Layer({ title, icon, pages, page, setPage, children, foot }) {
  const [q, setQ] = useState('');
  const shown = q ? pages.filter((p) => fuzzy(q, `${p.label} ${p.words || ''}`) >= 0) : pages;
  return html`<div class="layer" role="dialog" aria-modal="true" aria-label=${title}>
    <nav class="layer-nav" aria-label=${`${title} sections`}>
      <h2>${icon}${title}</h2>
      <input class="field" type="search" placeholder="Find a setting" aria-label="Find a setting" value=${q} onInput=${(e) => setQ(e.target.value)} />
      ${groups(shown).map((g) => {
        const rows = g.pages.map((p) => html`<button key=${p.id} class=${`row${page === p.id ? ' sel' : ''}`} aria-current=${page === p.id ? 'page' : undefined} onClick=${() => setPage(p.id)}>
          <span class="row-ic"><${Icon} name=${p.icon} size=${18} /></span><span class="grow trunc">${p.label}</span>
        </button>`);
        if (!g.section) return rows;
        // Screen readers hear each section's name with its pages (You, App, Moderation...).
        const hid = `layer-sec-${g.key}`;
        return html`<div class="layer-group" role="group" aria-labelledby=${hid} key=${`g-${g.key}`}>
          <div class="layer-sec" id=${hid}>${g.section}</div>
          ${rows}
        </div>`;
      })}
      ${!shown.length && html`<p class="faint" style="padding:4px 8px">No setting called “${q}”</p>`}
      <div class="layer-foot">${foot}</div>
    </nav>
    <div class="layer-body"><div class="layer-col">${children}</div></div>
    <button class="ib layer-close" aria-label="Close settings" data-tip="Close" data-key="Esc" onClick=${closeLayer}><${Icon} name="x" /></button>
  </div>`;
}

const PAGES = [
  { id: 'profile', label: 'Profile', icon: 'user', words: 'name avatar about emoji colour' },
  { id: 'notify', label: 'Notifications', icon: 'bell', words: 'mute quiet alerts pop-ups focus' },
  { id: 'look', label: 'Appearance', icon: 'eye', words: 'theme dark light density compact text size motion animation contrast accessibility' },
  { id: 'keys', label: 'Keyboard', icon: 'keys', words: 'shortcuts keys hotkeys' },
  { id: 'account', label: 'Account', icon: 'shield', words: 'account password sign out log out devices sessions connection' },
];

function Profile() {
  const u = me();
  return html`
    <h1>Profile</h1>
    <p class="lead">How you appear to people in every house and conversation.</p>
    <${Row} label="Name"><input class="field" style="width:260px" value=${u.name} maxlength="40" aria-label="Name" onChange=${(e) => e.target.value.trim() && updateMe({ name: e.target.value.trim() })} /><//>
    <${Row} label="About you" hint="A few lines on your profile. Message formatting works here." top>
      <textarea class="field" style="width:260px" rows="4" maxlength="400" aria-label="About you" onChange=${(e) => updateMe({ about: e.target.value.trim() })}>${u.about}</textarea>
    <//>
    <${Row} label="Picture" hint="Your initials on a colour, or an emoji.">
      <${Avatar} user=${u} size=${40} />
      <input class="field" style="width:72px;text-align:center" maxlength="4" placeholder="Emoji" aria-label="Emoji picture" value=${u.emoji || ''}
        onInput=${(e) => updateMe({ emoji: e.target.value.trim() || undefined })} />
    <//>
    <${Row} label="Colour" hint="Behind your initials, wherever you appear. Every colour stays readable in both themes." top>
      <div class="swatches" role="group" aria-label="Avatar colour">
        ${HUES.map(([v, name]) => html`<button key=${v} class="swatch" style=${`--hue:${v}`} aria-pressed=${String(hueOf(u.hue) === v)} aria-label=${name} onClick=${() => updateMe({ hue: v })}></button>`)}
      </div>
    <//>
    <${Row} label="Interests" hint=${`Up to ${LIMITS.interests}. They show on your profile and help people who like the same things find you.`} top>
      <${InterestsEditor} list=${u.interests || []} />
    <//>
    <${Row} label="Links" hint=${`Up to ${LIMITS.links}. Full https:// addresses; they open in a new tab.`} top>
      <${LinksEditor} list=${u.links || []} />
    <//>`;
}

// Interests: chips you can remove, one field to add more.
function InterestsEditor({ list }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const full = list.length >= LIMITS.interests;
  const add = () => {
    const v = text.replace(/\s+/g, ' ').trim().replace(/,$/, '');
    if (!v) return;
    if (v.length > LIMITS.interest) return setErr(`Keep each one to ${LIMITS.interest} characters.`);
    if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return setErr(`“${v}” is already there.`);
    if (full) return setErr(`That’s ${LIMITS.interests}, the most you can list.`);
    updateMe({ interests: cleanInterests([...list, v]) });
    setText('');
    setErr('');
    return undefined;
  };
  return html`<div class="ed-int">
    ${list.length > 0 && html`<ul class="ed-chips" aria-label="Your interests">
      ${list.map((i) => html`<li key=${i} class="ed-chip">${i}
        <button class="ed-chip-x" aria-label=${`Remove ${i}`} onClick=${() => updateMe({ interests: list.filter((x) => x !== i) })}><${Icon} name="x" size=${12} /></button>
      </li>`)}
    </ul>`}
    <div class="ed-add">
      <input class="field" placeholder=${full ? 'That’s the most you can list' : 'Add an interest, then Enter'} maxlength=${LIMITS.interest} value=${text} disabled=${full}
        aria-label="Add an interest" aria-invalid=${err ? 'true' : undefined} aria-describedby="ed-int-msg"
        onInput=${(e) => { setText(e.target.value); if (err) setErr(''); }}
        onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} />
      <button class="btn" disabled=${full || !text.trim()} onClick=${add}>Add</button>
    </div>
    <div id="ed-int-msg" class=${err ? 'err' : 'hint'} role=${err ? 'alert' : undefined}>${err || `${list.length} of ${LIMITS.interests}`}</div>
  </div>`;
}

// Links: a label and an https address each. Saved when every filled row is valid.
function LinksEditor({ list }) {
  const [rows, setRows] = useState(() => (list.length ? list.map((l) => ({ ...l })) : []));
  const [bad, setBad] = useState({});
  const check = (r) => (!r.url.trim() ? '' : safeLink(r.url) ? '' : 'Use a full address that starts with https://');
  const commit = (next) => {
    const errs = {};
    next.forEach((r, i) => { const m = check(r); if (m) errs[i] = m; });
    setBad(errs);
    if (Object.keys(errs).length) return;
    const clean = next.filter((r) => r.url.trim()).map((r) => ({ label: r.label.trim().slice(0, LIMITS.linkLabel), url: safeLink(r.url) }));
    if (JSON.stringify(clean) !== JSON.stringify(list)) updateMe({ links: clean });
  };
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => { const next = rows.filter((_, j) => j !== i); setRows(next); commit(next); };
  return html`<div class="ed-links">
    ${rows.map((r, i) => html`<div class="ed-link" key=${i}>
      <input class="field ed-link-label" placeholder="Label" maxlength=${LIMITS.linkLabel} aria-label=${`Link ${i + 1} label`} value=${r.label}
        onInput=${(e) => set(i, { label: e.target.value })} onBlur=${() => commit(rows)} />
      <input class="field ed-link-url" type="url" inputmode="url" placeholder="https://" maxlength=${LIMITS.linkUrl} aria-label=${`Link ${i + 1} address`} value=${r.url}
        aria-invalid=${bad[i] ? 'true' : undefined} aria-describedby=${bad[i] ? `ed-link-err-${i}` : undefined}
        onInput=${(e) => { set(i, { url: e.target.value }); if (bad[i]) setBad({ ...bad, [i]: '' }); }} onBlur=${() => commit(rows)} />
      <button class="ib" aria-label=${`Remove link ${i + 1}`} data-tip="Remove" onClick=${() => remove(i)}><${Icon} name="trash" size=${18} /></button>
      ${bad[i] && html`<div class="err ed-link-err" id=${`ed-link-err-${i}`} role="alert">${bad[i]}</div>`}
    </div>`)}
    ${rows.length < LIMITS.links && html`<button class="btn quiet ed-link-add" onClick=${() => setRows([...rows, { label: '', url: '' }])}><${Icon} name="plus" size=${16} />Add a link</button>`}
    ${rows.length >= LIMITS.links && html`<div class="hint">${LIMITS.links} of ${LIMITS.links}. Remove one to add another.</div>`}
  </div>`;
}

function Notify() {
  const houses = S.houseOrder.map((id) => S.houses[id]);
  return html`
    <h1>Notifications</h1>
    <p class="lead">One setting per place, three choices. Rooms follow their house unless you change one from its menu.</p>
    <${Row} label="Pop-ups" hint="A small note at the top when something needs you and you’re looking elsewhere.">
      <${Switch} on=${S.prefs.toasts} label="Pop-ups" onChange=${(v) => setPref('toasts', v)} />
    <//>
    <${Row} label="Desktop notifications" hint=${desktopHint()}>
      <${Switch} on=${S.prefs.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted'} label="Desktop notifications" onChange=${setDesktop} />
    <//>
    <${PushSetting} />
    <${Row} label="While you’re Focused" hint=${`Nothing pops up. Everything collects in Catch up. ${me().presence === 'focus' ? 'You’re focused now.' : 'Set it from your name at the top of the sidebar.'}`}>
      <span class="sub" style="display:flex;gap:8px;align-items:center"><i class="pres inline focus"></i>${PRESENCE.focus.label}</span>
    <//>
    <div class="set-head">Houses</div>
    ${houses.map((h) => {
      const overrides = roomIds(S, h.id).filter((r) => S.rooms[r].notify);
      return html`<div key=${h.id}>
        <${Row} label=${html`<span style="display:flex;gap:8px;align-items:center"><${Tile} house=${h} />${h.name}</span>`}
          hint=${overrides.length ? `${overrides.map((r) => `${S.rooms[r].name}: ${LEVEL_LABEL[S.rooms[r].notify].toLowerCase()}`).join('. ')}.` : ''}>
          <${Seg} label=${`${h.name} notifications`} value=${h.notify} options=${['all', 'mentions', 'muted'].map((l) => [l, LEVEL_LABEL[l]])} onChange=${(l) => setNotify('house', h.id, l)} />
        <//>
        ${overrides.map((r) => html`<div class="set-sub" key=${r}>
          <span>${S.rooms[r].name}</span>
          <${Seg} label=${`${S.rooms[r].name} notifications`} value=${levelOf(S, r)} options=${['all', 'mentions', 'muted'].map((l) => [l, LEVEL_LABEL[l]])} onChange=${(l) => setNotify('room', r, l)} />
        </div>`)}
      </div>`;
    })}
    <div class="set-head">Direct</div>
    <${Row} label="Direct messages and groups" hint="Always count as needing you. Mute a single conversation from its menu.">
      <span class="sub">Everything</span>
    <//>`;
}

const KEYS = [
  [[MOD, 'K'], 'Jump to a room or person, or search'],
  [[MOD, 'Shift', 'F'], 'Search messages'],
  [['Alt', '↑'], 'Previous place in the column'],
  [['Alt', '↓'], 'Next place in the column'],
  [['Alt', 'Shift', '↓'], 'Next conversation with something new, anywhere'],
  [MOD === '⌘' ? ['⌘', '['] : ['Alt', '←'], 'Back to where you were'],
  [['Esc'], 'Close the top layer, then the side pane. With nothing open, mark this place read'],
  [['Shift', 'Esc'], 'Mark this whole house read'],
  [['↑'], 'In an empty message box: edit your last message'],
  [['Shift', 'Tab'], 'From the message box: go up into the messages'],
  [['↑', '↓'], 'On a message: move between messages'],
  [['R'], 'On a message: reply'],
  [['T'], 'On a message: open or start its thread'],
  [['S'], 'On a message: save it'],
  [['E'], 'On your message: edit it'],
  [['Enter'], 'On a message: all actions'],
  [['J', 'K'], 'In Catch up: move between items'],
  [['E'], 'In Catch up: mark the item done'],
  [['?'], 'Show this list'],
];
// Formatting in the message box (js/views/messaging.js).
KEYS.push(
  [[MOD, 'B'], 'In the message box: bold the selection'], [[MOD, 'I'], 'Italic'], [[MOD, 'U'], 'Underline'],
  [[MOD, 'Shift', 'X'], 'Strikethrough'], [[MOD, 'E'], 'Code'], [[MOD, 'K'], 'Make the selection a link'],
);

function Keys() {
  return html`
    <h1>Keyboard</h1>
    <p class="lead">Everything works without a mouse. These make the common things faster.</p>
    <div class="keys">
      ${KEYS.map(([keys, what]) => html`<div>${what}</div><div>${keys.map((k) => html`<span class="kbd">${k}</span>`)}</div>`)}
    </div>`;
}

// Desktop notifications appear while Snug is open in a background tab.
const desktopHint = () => {
  if (typeof Notification === 'undefined') return 'This browser doesn\u2019t support them.';
  if (Notification.permission === 'denied') return 'Your browser is blocking them for Snug. Allow notifications in its site settings.';
  return 'When Snug is open in another tab and something needs you. Only on this device.';
};
async function setDesktop(on) {
  if (!on) return setPref('desktop', false);
  if (typeof Notification === 'undefined') return undefined;
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  setPref('desktop', p === 'granted');
  if (p !== 'granted') toast('Notifications are blocked. Allow them in your browser\u2019s site settings.');
  return undefined;
}

async function signOut(everywhere) {
  leaveVoice();
  await pushSignOut(); // this device stops getting this person's notifications
  try { await api(everywhere ? '/api/logout-all' : '/api/logout', {}); } catch { /* signing out locally anyway */ }
  stopTransport();
  closeLayer();
  signedOut();
}

// Appearance and Account and security are drawn by js/views/account.js (registerAccountPages below).
const VIEWS = { profile: Profile, notify: Notify, keys: Keys };
// Privacy and safety (js/views/safety-settings.js), before Account.
PAGES.splice(PAGES.findIndex((p) => p.id === 'account'), 0, { id: 'privacy', label: 'Privacy and safety', icon: 'eye', words: 'privacy block blocked unblock messages requests friend requests dm safety' });
VIEWS.privacy = PrivacyPage;
// Voice and video (js/views/voiceopts-settings.js), after Notifications.
PAGES.splice(PAGES.findIndex((p) => p.id === 'notify') + 1, 0, { id: 'voice', label: 'Voice and video', icon: 'voice', words: 'voice video microphone mic speaker headphones camera webcam push to talk ptt sensitivity noise suppression echo gain volume screen share quality sounds afk deafen' });
VIEWS.voice = VoiceSettings;
// Account (js/views/account.js): Appearance in full, Accessibility, Streamer mode, more Notifications and Profile, Account and security, Your data.
registerAccountPages({ PAGES, VIEWS, Row, signOut, Settings, KEYS });

// One structure for every settings layer: pages in sections, in this order.
// Pages other modules add land in the section named here; anything unnamed
// goes last, so a new page is never lost.
function arrange(pages, plan) {
  const at = new Map(plan.flatMap(([section, ids], si) => ids.map((id, i) => [id, { section, n: si * 100 + i }])));
  for (const p of pages) Object.assign(p, at.has(p.id) ? { section: at.get(p.id).section } : {});
  pages.sort((a, b) => (at.get(a.id)?.n ?? 1e4) - (at.get(b.id)?.n ?? 1e4));
}
arrange(PAGES, [
  ['You', ['profile', 'account', 'privacy', 'data']],
  ['App', ['notify', 'voice', 'look', 'a11y', 'streamer', 'keys']],
]);

export function Settings({ page: start = 'profile' }) {
  const [page, setPage] = useState(start);
  const V = VIEWS[page];
  return html`<${Layer} title="Settings" icon=${html`<${Icon} name="sliders" />`} pages=${PAGES} page=${page} setPage=${setPage}
    foot=${html`<${Nook} size=${16} /><span>Snug 0.6</span>`}>
    <${V} />
  <//>`;
}

// House settings
const HOUSE_PAGES = [
  { id: 'about', label: 'Overview', icon: 'house', words: 'name colour about description' },
  { id: 'roles', label: 'Roles', icon: 'shield', words: 'roles permissions access' },
  { id: 'members', label: 'Members', icon: 'people', words: 'members people role assign' },
  { id: 'welcome', label: 'Newcomers', icon: 'user', words: 'onboarding welcome starter rooms first step' },
];
// Custom emoji (js/views/emoji-settings.js). Roles with only Manage emoji see just this page.
HOUSE_PAGES.push({ id: 'emoji', label: 'Emoji', icon: 'smile', words: 'emoji custom upload images reactions stickers' });

function HouseAbout({ house }) {
  const h = S.houses[house];
  return html`
    <h1>${h.name}</h1>
    <p class="lead">What people see before and after they join.</p>
    <${Row} label="Name"><input class="field" style="width:260px" value=${h.name} maxlength="40" aria-label="House name"
      onChange=${(e) => e.target.value.trim() && updateHouse(house, { name: e.target.value.trim(), mark: e.target.value.trim()[0].toUpperCase() })} /><//>
    <${Row} label="About" hint="Shown on invitations and to newcomers." top>
      <textarea class="field" style="width:260px" rows="3" maxlength="160" aria-label="About this house" onChange=${(e) => updateHouse(house, { about: e.target.value.trim() })}>${h.about}</textarea>
    <//>
    <${Row} label="Colour" top>
      <div class="swatches" role="group" aria-label="House colour">
        ${HUES.map(([v, name]) => html`<button key=${v} class="swatch strong" style=${`--hue:${v}`} aria-pressed=${String(hueOf(h.hue) === v)} aria-label=${name} onClick=${() => updateHouse(house, { hue: v })}></button>`)}
      </div>
    <//>
    <div class="set-head">Leave</div>
    <${Row} label=${`Leave ${h.name}`} hint="Its rooms leave your sidebar. You’ll need a new invitation to come back.">
      <button class="btn danger" onClick=${() => openModal(Confirm, { title: `Leave ${h.name}?`, danger: true, action: 'Leave house', text: 'You’ll need a new invitation to come back.', onConfirm: () => leaveHouse(house).catch((e) => toast(e.message)) })}>Leave house</button>
    <//>`;
}

function HouseMembers({ house }) {
  const h = S.houses[house];
  const [q, setQ] = useState('');
  const ids = Object.keys(h.members).filter((id) => S.users[id] && fuzzy(q, S.users[id].name) >= 0).sort((a, b) => S.users[a].name.localeCompare(S.users[b].name));
  return html`
    <h1>Members</h1>
    <p class="lead">${Object.keys(h.members).length} people. Change someone’s role here.</p>
    <input class="field" type="search" style="max-width:320px;margin-bottom:8px" placeholder="Find a member" aria-label="Find a member" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${ids.map((id) => html`<div class="member-row" key=${id}>
      <${Avatar} user=${S.users[id]} presence />
      <span class="grow"><b style="font-weight:500">${S.users[id].name}</b>${id === S.me ? html` <span class="faint">(you)</span>` : null}<br /><span class="faint">@${S.users[id].handle}</span></span>
      <select class="field" aria-label=${`Role for ${S.users[id].name}`} value=${h.members[id]} disabled=${id === S.me} onChange=${(e) => setMemberRole(house, id, e.target.value)}>
        ${h.roles.map((r) => html`<option value=${r.id}>${r.name}</option>`)}
      </select>
      ${id !== S.me && personItems(id, house).some((x) => x.label && x.label !== 'Block' && x.label !== 'Unblock' && x.label !== 'Report') && html`<button class="ib" aria-label=${`Moderate ${S.users[id].name}`} aria-haspopup="menu" data-tip="Moderate"
        onClick=${(e) => openMenu({ anchor: e.currentTarget.getBoundingClientRect(), align: 'end', items: personItems(id, house).filter((x) => x.sep || !['Block', 'Unblock', 'Report'].includes(x.label)) })}><${Icon} name="shield" size=${18} /></button>`}
      ${id !== S.me && !mayAct(house, id, 'kick') && html`<button class="ib danger" aria-label=${`Remove ${S.users[id].name} from ${h.name}`} data-tip="Remove from house" onClick=${() => openModal(Confirm, {
        title: `Remove ${S.users[id].name}?`, danger: true, action: 'Remove',
        text: `${S.users[id].name} leaves ${h.name} and its rooms. They can come back with a new invitation.`,
        onConfirm: () => removeMember(house, id),
      })}><${Icon} name="leave" size=${18} /></button>`}
    </div>`)}`;
}

function HouseWelcome({ house }) {
  const h = S.houses[house];
  const all = roomIds(S, house);
  const toggle = (id) => updateHouse(house, { starter: h.starter.includes(id) ? h.starter.filter((x) => x !== id) : [...h.starter, id].sort((a, b) => all.indexOf(a) - all.indexOf(b)) });
  return html`
    <h1>Newcomers</h1>
    <p class="lead">New people see only these rooms, plus a welcome with one first step. The rest of the house opens after their first message. The welcome text and the interests that give roles are further down.</p>
    <${Row} label="Newcomers join as">
      <select class="field" aria-label="Role for newcomers" value=${h.joinRole} onChange=${(e) => updateHouse(house, { joinRole: e.target.value })}>
        ${h.roles.map((r) => html`<option value=${r.id}>${r.name}</option>`)}
      </select>
    <//>
    <div class="set-head">Starter rooms <span class="faint" style="font-weight:400">${h.starter.length} of ${all.length}. Three works well.</span></div>
    ${all.map((id) => html`<${Row} key=${id} label=${S.rooms[id].name} hint=${S.rooms[id].topic}>
      <${Switch} on=${h.starter.includes(id)} label=${`Show ${S.rooms[id].name} to newcomers`} onChange=${() => toggle(id)} />
    <//>`)}`;
}

// Roles is drawn by js/views/places-settings.js (PLACES_VIEWS below).
const HOUSE_VIEWS = { about: HouseAbout, members: HouseMembers, welcome: HouseWelcome };
HOUSE_VIEWS.emoji = withStickers(HouseEmoji); // custom emoji, and the house's stickers below them
// Moderation pages, each opened by its own permission (js/views/safety-settings.js).
HOUSE_PAGES.push(...SAFETY_PAGES);
Object.assign(HOUSE_VIEWS, SAFETY_VIEWS);
// Places (js/views/places-settings.js): its Roles page replaces the one above.
HOUSE_PAGES.push(...PLACES_PAGES);
Object.assign(HOUSE_VIEWS, PLACES_VIEWS);
// The soundboard (Manage sounds). Voice room limits and bitrate are per room, on Rooms and access.
HOUSE_PAGES.push({ id: 'voice', label: 'Soundboard', icon: 'voice', words: 'voice soundboard sounds audio clips', need: (h) => can(S, h, 'sounds') });
HOUSE_VIEWS.voice = HouseVoice;

// Newcomers: who they join as and their starter rooms, then the welcome and
// the interests that give roles (js/views/places-settings.js). One page.
HOUSE_VIEWS.welcome = ({ house }) => html`<${HouseWelcome} house=${house} /><${WelcomePage} house=${house} embedded />`;
HOUSE_PAGES.find((p) => p.id === 'welcome').words += ' welcome interests roles greeting';
arrange(HOUSE_PAGES, [
  ['House', ['about', 'roles', 'members', 'invites', 'emoji', 'voice']],
  ['Rooms and newcomers', ['rooms', 'welcome']],
  ['Moderation', ['reports', 'bans', 'filter', 'log']],
  ['Owners', ['insights']],
]);

export function HouseSettings({ house, page: start = 'about' }) {
  const [page, setPage] = useState(start);
  const h = S.houses[house];
  // Custom emoji: a role with Manage emoji but not Manage roles gets the Emoji page alone.
  const emojiOnly = !!h && !can(S, house, 'roles') && can(S, house, 'emoji');
  // Pages with their own permission (moderation) show to whoever has it; the rest need Manage roles.
  const pages = !h ? [] : HOUSE_PAGES.filter((p) => (p.need ? p.need(house) : can(S, house, 'roles') || (emojiOnly && p.id === 'emoji')));
  if (!h || !pages.length) return null;
  const cur = pages.some((p) => p.id === page) ? page : pages[0].id;
  const V = HOUSE_VIEWS[cur];
  return html`<${Layer} title=${h.name} icon=${html`<${Tile} house=${h} />`} pages=${pages} page=${cur} setPage=${setPage}>
    <${V} house=${house} />
  <//>`;
}

// The voice options open these pages from a call (js/views/voiceopts.js).
setVoiceSettingsOpener(() => openVoiceLayer({ C: Settings, props: { page: 'voice' } }));
setHouseVoiceOpener((house) => openVoiceLayer({ C: HouseSettings, props: { house, page: 'voice' } }));
