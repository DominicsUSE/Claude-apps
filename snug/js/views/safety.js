// Safety, privacy and moderation in the browser: blocking, reporting, the
// moderator's actions on a person, message requests, and what the composer
// says when someone can't write (timed out, rules not accepted, slowmode,
// blocked). The server enforces all of it (server/safety.js); this only
// explains and offers the actions a person may take.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit, toast, openModal, closeModal, convMeta, person, voiceRoomOf, openMenu } from '../store.js';
import { call, on } from '../server.js';
import { can, roleOf } from '../lib/perms.js';
import {
  TIMEOUTS, BAN_DELETE, REPORT_REASONS, outranks, slowWait, left,
} from '../lib/safety.js';
import { plain } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar } from '../ui/kit.js';
import { joinVoice, applyHearing, toggleMute, toggleDeaf } from '../voice.js';

const blank = () => ({ blocks: [], privacy: { dm: 'houses', friends: 'everyone', requests: false }, requests: [], sent: [] });
export const safety = () => S.safety || (S.safety = blank());
const first = (id) => person(id).name.split(' ')[0];
const err = (e) => (e.offline ? 'You’re offline. Try again once you’re back.' : e.message);

// ---------- Live state from the server ----------
on('safety', (d) => {
  if (d.users) for (const [id, u] of Object.entries(d.users)) if (!S.users[id]) S.users[id] = u;
  S.safety = { blocks: d.blocks || [], privacy: d.privacy || blank().privacy, requests: d.requests || [], sent: d.sent || [] };
  // Conversations left by declining a request or blocking its sender.
  for (const dm of d.left || []) {
    delete S.dms[dm];
    delete S.msgs[dm];
    S.dmOrder = S.dmOrder.filter((x) => x !== dm);
    if (S.ui.view.type === 'conv' && S.ui.view.id === dm) S.ui.view = { type: 'catchup' };
  }
});
// A moderator acted on me.
on('mod.notice', ({ name, action, reason, ms }) => {
  const why = reason ? ` Reason: ${reason}` : '';
  if (action === 'kick') toast(`You were removed from ${name}.${why}`);
  else if (action === 'ban') toast(`You were banned from ${name}.${why}`);
  else if (action === 'timeout') toast(`You’re timed out in ${name} for ${left(ms)}.${why}`);
});
on('voice.moved', ({ room, to, name }) => {
  if (S.call?.room !== room) return;
  joinVoice(to).then((r) => { if (r === 'ok') toast(`A moderator moved you to ${name}.`); });
});
// Server mute and deafen: my microphone follows, and nobody's browser plays a muted person.
on('voice', ({ room, state }) => {
  if (!S.call || S.call.room !== room || S.call.status !== 'live') return;
  const mine = state?.[S.me];
  if (mine?.sdeaf && !S.call.deaf) toggleDeaf();
  else if (mine?.smute && !S.call.muted) toggleMute();
  applyHearing();
});

// ---------- Blocking ----------
export const isBlocked = (id) => safety().blocks.includes(id);
// Revealed blocked messages, for this tab only.
const revealed = new Set();
export const hiddenBlocked = (m) => !!m && m.author !== S.me && isBlocked(m.author) && !revealed.has(m.id);

export function BlockedLine({ m }) {
  return html`<div class="msg blocked-msg" data-id=${m.id}>
    <div class="msg-gutter"><span class="blocked-dot" aria-hidden="true"><${Icon} name="eye" size=${16} /></span></div>
    <div class="msg-body blocked-body">
      <span>Blocked message</span>
      <button class="btn quiet sm" aria-label=${`Show the message from ${person(m.author).name}`} onClick=${() => { revealed.add(m.id); emit(); }}>Show</button>
    </div>
  </div>`;
}

function BlockConfirm({ id }) {
  const name = person(id).name;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = () => {
    setBusy(true);
    call('block.set', { user: id, on: true }).then(() => { closeModal(); toast(`${name} is blocked.`); }, (e) => { setBusy(false); setError(err(e)); });
  };
  return html`
    <h2>Block ${name}?</h2>
    <p class="modal-lead">They won’t be able to message you, call you, send you friend requests or reach you with mentions. In houses you share, their messages fold away. You’ll stop being friends. They aren’t told.</p>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button class="btn" data-autofocus onClick=${closeModal}>Cancel</button>
      <button class="btn danger" aria-busy=${busy ? 'true' : undefined} disabled=${busy} onClick=${go}>Block</button>
    </div>`;
}
export const blockUser = (id) => openModal(BlockConfirm, { id });
export function unblockUser(id) {
  return call('block.set', { user: id, on: false }).then(() => toast(`${person(id).name} is unblocked.`), (e) => toast(err(e)));
}

// ---------- Reports ----------
function ReportForm({ conv, m, user, house }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const who = person(m ? m.author : user).name;
  const submit = (e) => {
    e.preventDefault();
    if (!reason) return setError('Pick what’s wrong.');
    setBusy(true);
    const d = m ? { conv, msg: m.id, reason, note } : { house, user, reason, note };
    call('report.create', d).then(() => { closeModal(); toast('Reported. The house’s moderators will take a look.'); }, (x) => { setBusy(false); setError(err(x)); });
    return undefined;
  };
  return html`<form class="form report-form" onSubmit=${submit} novalidate>
    <h2>${m ? 'Report this message' : `Report ${who}`}</h2>
    <p class="modal-lead">Only the moderators of ${S.houses[house]?.name || 'this house'} see reports. ${who} isn’t told who reported them.</p>
    ${m && html`<blockquote class="report-quote"><${Avatar} user=${person(m.author)} /><span><b>${who}</b> ${plain(m.text).slice(0, 200) || 'Attachment'}</span></blockquote>`}
    <fieldset class="report-reasons">
      <legend class="label">What’s wrong?</legend>
      ${REPORT_REASONS.map(([v, label]) => html`<label key=${v} class=${`report-reason${reason === v ? ' sel' : ''}`}>
        <input type="radio" name="reason" value=${v} checked=${reason === v} onChange=${() => { setReason(v); setError(''); }} />${label}
      </label>`)}
    </fieldset>
    <div>
      <label class="label" for="report-note">Anything the moderators should know <span class="faint">(optional)</span></label>
      <textarea id="report-note" class="field" rows="3" maxlength="500" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
    </div>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" aria-busy=${busy ? 'true' : undefined} disabled=${busy}>Send report</button>
    </div>
  </form>`;
}
export const reportMessage = (conv, m) => openModal(ReportForm, { conv, m, house: convMeta(conv)?.house });
export const reportPerson = (user, house) => openModal(ReportForm, { user, house });

// ---------- A moderator acting on a person ----------
const outranksIn = (house, target) => {
  const h = S.houses[house];
  return !!h && outranks(h.roles, h.members, S.me, target);
};
export const mayAct = (house, target, perm) => !!house && target !== S.me && !!S.houses[house]?.members[target] && can(S, house, perm) && outranksIn(house, target);

function ModForm({ house, user, action }) {
  const name = person(user).name;
  const hname = S.houses[house]?.name;
  const [reason, setReason] = useState('');
  const [ms, setMs] = useState(action === 'timeout' ? TIMEOUTS[1][0] : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const text = {
    kick: { title: `Remove ${name}?`, lead: `${name} leaves ${hname}. They can come back with a new invitation.`, go: 'Remove' },
    ban: { title: `Ban ${name}?`, lead: `${name} leaves ${hname} and can’t come back, by link or invitation, until someone unbans them.`, go: 'Ban' },
    timeout: { title: `Time out ${name}`, lead: `While timed out, ${first(user)} can read but can’t write, react, start threads or join voice in ${hname}.`, go: 'Time out' },
  }[action];
  const submit = (e) => {
    e.preventDefault();
    setBusy(true);
    const op = { kick: 'mod.kick', ban: 'mod.ban', timeout: 'mod.timeout' }[action];
    const d = { house, user, reason };
    if (action === 'ban') d.deleteMs = ms;
    if (action === 'timeout') d.ms = ms;
    call(op, d).then((r) => {
      closeModal();
      toast(action === 'kick' ? `${name} was removed.` : action === 'ban' ? `${name} is banned${r?.deleted ? ` and ${r.deleted} of their messages were deleted` : ''}.` : `${name} is timed out.`);
    }, (x) => { setBusy(false); setError(err(x)); });
  };
  const choices = action === 'timeout' ? TIMEOUTS : action === 'ban' ? BAN_DELETE : null;
  return html`<form class="form mod-form" onSubmit=${submit} novalidate>
    <h2>${text.title}</h2>
    <p class="modal-lead">${text.lead}</p>
    ${choices && html`<div>
      <label class="label" for="mod-choice">${action === 'timeout' ? 'For how long' : 'Delete their messages from'}</label>
      <select id="mod-choice" class="field" value=${ms} onChange=${(e) => setMs(Number(e.target.value))}>
        ${choices.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
      </select>
    </div>`}
    <div>
      <label class="label" for="mod-reason">Reason <span class="faint">(optional; ${first(user)} sees it, and it’s kept in the house log)</span></label>
      <input id="mod-reason" class="field" maxlength="300" value=${reason} onInput=${(e) => setReason(e.target.value)} />
    </div>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button type="button" class="btn" data-autofocus onClick=${closeModal}>Cancel</button>
      <button type="submit" class=${`btn ${action === 'timeout' ? 'primary' : 'danger'}`} aria-busy=${busy ? 'true' : undefined} disabled=${busy}>${text.go}</button>
    </div>
  </form>`;
}
export const moderate = (house, user, action) => openModal(ModForm, { house, user, action });
export function liftTimeout(house, user) {
  return call('mod.timeout', { house, user, ms: 0 }).then(() => toast(`${person(user).name} can take part again.`), (e) => toast(err(e)));
}

// Menu items for a person: block, report, and what a moderator may do here.
export function personItems(id, house) {
  if (!id || id === S.me) return [];
  const blocked = isBlocked(id);
  const h = house && S.houses[house];
  const until = h?.timeouts?.[id];
  const timedOut = until && until > Date.now();
  const mod = [
    mayAct(house, id, 'timeout') && (timedOut
      ? { label: 'Remove timeout', icon: 'undo', onSelect: () => liftTimeout(house, id) }
      : { label: 'Time out', icon: 'alert', onSelect: () => moderate(house, id, 'timeout') }),
    mayAct(house, id, 'kick') && { label: `Remove from ${h.name}`, icon: 'leave', danger: true, onSelect: () => moderate(house, id, 'kick') },
    mayAct(house, id, 'ban') && { label: `Ban from ${h.name}`, icon: 'shield', danger: true, onSelect: () => moderate(house, id, 'ban') },
    ...voiceItems(id, house),
  ].filter(Boolean);
  return [
    { sep: true },
    h && h.members[id] && { label: 'Report', icon: 'alert', onSelect: () => reportPerson(id, house) },
    blocked ? { label: 'Unblock', icon: 'eye', onSelect: () => unblockUser(id) } : { label: 'Block', icon: 'x', danger: true, onSelect: () => blockUser(id) },
    ...(mod.length ? [{ sep: true }, ...mod] : []),
  ].filter(Boolean);
}

// In a voice room of this house: mute, deafen, move and disconnect.
function voiceItems(id, house) {
  const place = voiceRoomOf(id);
  if (!place || S.rooms[place]?.house !== house || !mayAct(house, id, 'voicemod')) return [];
  const st = S.voiceState[place]?.[id] || {};
  const name = first(id);
  const run = (op, d, done) => call(op, d).then(() => done && toast(done), (e) => toast(err(e)));
  const others = Object.values(S.rooms).filter((r) => r.house === house && r.kind === 'voice' && r.id !== place).slice(0, 4);
  return [
    { label: st.smute ? 'Unmute in voice' : 'Mute in voice', icon: 'mic', onSelect: () => run('mod.voice', { house, user: id, mute: !st.smute }, `${name} is ${st.smute ? 'unmuted' : 'muted'} in voice.`) },
    { label: st.sdeaf ? 'Undeafen in voice' : 'Deafen in voice', icon: 'ear', onSelect: () => run('mod.voice', { house, user: id, deaf: !st.sdeaf }, `${name} is ${st.sdeaf ? 'undeafened' : 'deafened'} in voice.`) },
    ...others.map((r) => ({ label: `Move to ${r.name}`, icon: 'voice', onSelect: () => run('mod.move', { user: id, room: r.id }, `${name} was moved to ${r.name}.`) })),
    { label: 'Disconnect from voice', icon: 'leave', danger: true, onSelect: () => run('mod.disconnect', { user: id }, `${name} was disconnected.`) },
  ];
}

// On a voice room's stage: a moderator's button on each person they may act on.
export function StageMod({ id, room }) {
  const house = S.rooms[room]?.house;
  if (!house || id === S.me || !mayAct(house, id, 'voicemod')) return null;
  const st = S.voiceState[room]?.[id] || {};
  return html`<button class=${`ib sm stage-mod${st.smute || st.sdeaf ? ' on' : ''}`} aria-label=${`Moderate ${person(id).name} in voice`} aria-haspopup="menu" data-tip="Moderate"
    onClick=${(e) => openMenu({ anchor: e.currentTarget.getBoundingClientRect(), align: 'start', items: voiceItems(id, house) })}><${Icon} name="shield" size=${14} /></button>`;
}

// Extra items for the message menu: report it, and act on its author.
export function messageItems(conv, m) {
  if (!m || m.state || m.call || m.author === S.me) return [];
  const house = convMeta(conv)?.house;
  return [
    { sep: true },
    house && { label: 'Report message', icon: 'alert', onSelect: () => reportMessage(conv, m) },
    ...personItems(m.author, house).filter((x) => !x.sep && x.label !== 'Report'),
  ].filter(Boolean);
}

// ---------- Message requests ----------
export const requestOf = (dm) => safety().requests.find((r) => r.dm === dm) || null;
export const sentRequestOf = (dm) => safety().sent.find((r) => r.dm === dm) || null;
export function RequestBanner({ conv }) {
  const r = requestOf(conv);
  const sent = !r && sentRequestOf(conv);
  const [busy, setBusy] = useState(false);
  if (!r && !sent) return null;
  if (sent) {
    return html`<div class="safety-banner" role="status"><${Icon} name="info" size=${18} />
      <span class="grow">${first(sent.user)} hasn’t accepted your message request yet. They’ll see your messages when they do.</span></div>`;
  }
  const act = (op) => { setBusy(true); call(op, { dm: conv }).catch((e) => { setBusy(false); toast(err(e)); }); };
  return html`<div class="safety-banner request" role="region" aria-label="Message request">
    <${Avatar} user=${person(r.by)} size=${32} />
    <span class="grow"><b>${person(r.by).name}</b> wants to talk. Nothing here notifies you until you accept.</span>
    <div class="safety-banner-acts">
      <button class="btn primary" disabled=${busy} onClick=${() => act('dm.request.accept')}>Accept</button>
      <button class="btn" disabled=${busy} onClick=${() => act('dm.request.decline')}>Decline</button>
      <button class="btn quiet danger" disabled=${busy} onClick=${() => blockUser(r.by)}>Block</button>
    </div>
  </div>`;
}

// ---------- The composer: who may write, and when ----------
function Tick({ until }) {
  const [, set] = useState(0);
  // When the wait is over the whole composer comes back, not just this number.
  useEffect(() => { const t = setInterval(() => { if (until <= Date.now()) emit(); else set((n) => n + 1); }, 1000); return () => clearInterval(t); }, [until]);
  return html`<span class="num">${left(until - Date.now())}</span>`;
}

// Why this person can't write here at all, or null.
export function composerGate(conv) {
  const meta = convMeta(conv);
  if (!meta) return null;
  if (meta.house) {
    const h = S.houses[meta.house];
    if (h?.timedOut && h.timedOut > Date.now()) return { kind: 'timeout', house: meta.house, until: h.timedOut };
    if (h?.screening && h.accepted === false) return { kind: 'rules', house: meta.house };
    return null;
  }
  if (meta.kind === 'dm' && meta.others.length === 1) {
    const other = meta.others[0];
    if (isBlocked(other)) return { kind: 'blocked', user: other };
  }
  return null;
}

function RulesModal({ house }) {
  const h = S.houses[house];
  const [busy, setBusy] = useState(false);
  const accept = () => { setBusy(true); call('rules.accept', { house }).then(() => { closeModal(); toast(`Welcome to ${h.name}.`); }, (e) => { setBusy(false); toast(err(e)); }); };
  return html`
    <h2>${h.name}’s rules</h2>
    <p class="modal-lead">Read these before you take part. Accepting lets you write, react and join voice here.</p>
    <div class="rules-text">${(h.rules || '').split(/\n+/).filter(Boolean).map((p, i) => html`<p key=${i}>${p}</p>`)}</div>
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Not now</button>
      <button class="btn primary" data-autofocus aria-busy=${busy ? 'true' : undefined} disabled=${busy} onClick=${accept}>I accept the rules</button>
    </div>`;
}
export const showRules = (house) => openModal(RulesModal, { house });

export function GateNote({ gate }) {
  if (gate.kind === 'timeout') {
    return html`<div class="composer"><div class="composer-locked safety-locked" role="status"><${Icon} name="alert" />
      <span>You’re timed out in ${S.houses[gate.house].name} for <${Tick} until=${gate.until} />. You can still read.</span></div></div>`;
  }
  if (gate.kind === 'rules') {
    return html`<div class="composer"><div class="composer-locked safety-locked"><${Icon} name="shield" />
      <span class="grow">Accept ${S.houses[gate.house].name}’s rules to start writing here.</span>
      <button class="btn primary" onClick=${() => showRules(gate.house)}>Read the rules</button></div></div>`;
  }
  return html`<div class="composer"><div class="composer-locked safety-locked"><${Icon} name="x" />
    <span class="grow">You blocked ${person(gate.user).name}. Unblock them to write here.</span>
    <button class="btn" onClick=${() => unblockUser(gate.user)}>Unblock</button></div></div>`;
}

// Slowmode: how long until I may write in this room again (0 now).
export function slowLeft(conv) {
  const room = S.rooms[conv];
  if (!room?.slowmode || can(S, room.house, 'moderate')) return 0;
  const last = (S.msgs[conv] || []).filter((m) => m.author === S.me && !m.call && m.state !== 'failed').reduce((t, m) => Math.max(t, m.ts), 0);
  return slowWait(room.slowmode, last);
}
export function SlowNote({ conv }) {
  const room = S.rooms[conv];
  const [, set] = useState(0);
  const wait = slowLeft(conv);
  useEffect(() => {
    if (!wait) return undefined;
    const t = setInterval(() => set((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wait > 0]);
  if (!room?.slowmode) return null;
  const mod = can(S, room.house, 'moderate');
  return html`<div class=${`slow-note${wait ? ' waiting' : ''}`} role="status" aria-live="polite">
    <${Icon} name="undo" size=${14} />
    ${wait ? html`<span>Slowmode. You can send again in <b class="num">${left(wait)}</b>.</span>`
      : html`<span>Slowmode is on: one message every ${room.slowmode < 60 ? `${room.slowmode} seconds` : left(room.slowmode * 1000)}${mod ? '. Your role skips it.' : '.'}</span>`}
  </div>`;
}

// For people with moderation pages but not the house's own settings.
export const modPages = (house) => ['moderate', 'ban', 'audit', 'kick', 'timeout'].some((p) => can(S, house, p));
export const roleName = (house, id) => roleOf(S, house, id)?.name || '';
