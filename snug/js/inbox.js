// Inbox and notifications in the browser: server unread counts, conversations
// leaving (a group you left or were removed from), timed mutes, presence for
// a while, and the actions behind the direct-conversation menu. The server
// checks every one of these again (server/inbox.js, server/dms.js).
import { S, emit, toast, openMenu, checkView, resync, go } from './store.js';
import { call, on } from './server.js';
import { MUTE_FOR, MUTE_LABEL, PRESENCE_FOR, PRESENCE_FOR_LABEL, untilFor, untilText } from './lib/inbox.js';

const oops = (e) => toast(e?.offline ? 'You’re offline. Try again when you’re back.' : e?.message || 'That didn’t work.');
const h12 = () => S.prefs.clock === '12';

// ---------- Live events ----------
// Counts for some conversations (a house just joined), or all of them.
on('unread', ({ unread, convs }) => {
  S.unread ||= {};
  if (Array.isArray(convs)) for (const c of convs) delete S.unread[c];
  Object.assign(S.unread, unread || {});
});
// A group I left or was removed from: it goes, with its history.
on('dm.gone', ({ id }) => {
  delete S.dms[id];
  delete S.msgs[id];
  delete S.unread?.[id];
  S.dmOrder = S.dmOrder.filter((d) => d !== id);
  for (const t of Object.keys(S.threads)) if (S.threads[t].conv === id) { delete S.threads[t]; delete S.msgs[t]; }
  const v = S.ui.view;
  if (v.type === 'conv' && v.id === id) { S.ui.view = { type: 'messages' }; S.ui.pane = null; }
  checkView();
});
on('mention.dismiss', ({ id, undo }) => {
  S.mentionsGone ||= {};
  if (undo) delete S.mentionsGone[id]; else S.mentionsGone[id] = true;
});

// ---------- Timed mutes ----------
// The level a place has right now: a mute whose time is over counts as unset.
export const liveLevel = (level, until, now = Date.now()) => (level && until && until <= now ? null : level);

function placeOf(kind, id) {
  if (kind === 'house') return S.houses[id];
  if (kind === 'room') return S.rooms[id];
  return S.dms[id];
}
export function untilOf(kind, id) {
  const p = placeOf(kind, id);
  return p?.notifyUntil && p.notifyUntil > Date.now() ? p.notifyUntil : null;
}
export function mutedNote(kind, id) {
  const u = untilOf(kind, id);
  return u ? `Muted until ${untilText(u, Date.now(), h12())}` : '';
}

export function setNotifyFor(kind, id, level, until = null) {
  const p = placeOf(kind, id);
  if (!p) return Promise.resolve();
  const before = { notify: p.notify, notifyUntil: p.notifyUntil };
  if (kind === 'room') p.notify = level === (S.houses[p.house]?.notify || 'all') ? null : level;
  else if (kind === 'dm') p.notify = level === 'all' ? null : level;
  else p.notify = level;
  const at = until ? untilFor(until) : null;
  if (at) p.notifyUntil = at; else delete p.notifyUntil;
  emit();
  return call('notify.set', { kind, id, level, until: until || undefined }).catch((e) => {
    Object.assign(p, before);
    emit();
    oops(e);
  });
}

// Menu items: "Muted until 14:30" with Unmute, or "Mute for…" opening the times.
export function muteItems(kind, id, pos) {
  const u = untilOf(kind, id);
  const level = placeOf(kind, id)?.notify;
  const items = [];
  if (u) {
    items.push({ label: `Muted until ${untilText(u, Date.now(), h12())}`, icon: 'bell-off', disabled: true });
    items.push({ label: 'Unmute', icon: 'bell', onSelect: () => setNotifyFor(kind, id, 'all') });
  } else if (level !== 'muted') {
    items.push({ label: 'Mute for…', icon: 'bell-off', onSelect: () => openMuteMenu(kind, id, pos) });
  }
  return items;
}
export function openMuteMenu(kind, id, pos) {
  openMenu({
    ...(pos || {}),
    items: [
      { heading: 'Mute' },
      ...MUTE_FOR.map((m) => ({ label: MUTE_LABEL[m], onSelect: () => setNotifyFor(kind, id, 'muted', m === 'never' ? null : m) })),
    ],
  });
}

// ---------- Suppress @role mentions (a set of house ids, like everyoneOff) ----------
export const rolesOff = (house) => !!S.prefs.rolesOff?.[house];
export function setRolesOff(house, on) {
  const next = { ...(S.prefs.rolesOff || {}) };
  if (on) next[house] = true; else delete next[house];
  S.prefs.rolesOff = next;
  emit();
  return call('prefs.set', { prefs: { rolesOff: next } }).catch(oops);
}

// ---------- Presence for a while ----------
const endOfToday = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); };
export function setPresenceFor(presence, choice = null) {
  const u = S.users[S.me];
  const before = u && { presence: u.presence, presenceUntil: u.presenceUntil };
  if (u) { u.presence = presence; u.presenceUntil = choice && choice !== 'never' ? untilFor(choice, Date.now(), endOfToday()) : null; }
  emit();
  const d = { presence };
  if (choice && choice !== 'never') { d.presenceUntil = choice; if (choice === 'today') d.endOfDay = endOfToday(); }
  return call('me.update', d).catch((e) => { if (u) Object.assign(u, before); emit(); oops(e); });
}
export const PRESENCE_TIMES = PRESENCE_FOR.filter((c) => c !== 'never').map((c) => [c, PRESENCE_FOR_LABEL[c]]);
export function presenceUntilNote(u = S.users[S.me]) {
  if (!u?.presenceUntil || u.presenceUntil <= Date.now()) return '';
  return `until ${untilText(u.presenceUntil, Date.now(), h12())}`;
}

// ---------- Direct conversations and groups ----------
// The list order: pinned first (in the order pinned), closed ones left out
// unless open now, then the rest as the server sent them.
export function orderDms(ids = S.dmOrder) {
  const v = S.ui.view;
  const open = v.type === 'conv' ? v.id : null;
  const shown = ids.filter((id) => S.dms[id] && (!S.dms[id].hidden || id === open));
  const pinned = shown.filter((id) => S.dms[id].pinned).sort((a, b) => S.dms[a].pinned - S.dms[b].pinned);
  return [...pinned, ...shown.filter((id) => !S.dms[id].pinned)];
}
export const isGroupDm = (id) => !!S.dms[id] && (S.dms[id].group || S.dms[id].members.length > 2);

const act = (op, d, then) => call(op, d).then((r) => { then?.(r); return r; }, (e) => { oops(e); throw e; });
export function hideDm(id) {
  if (!S.dms[id]) return;
  S.dms[id].hidden = true;
  const v = S.ui.view;
  if (v.type === 'conv' && v.id === id) go({ type: 'messages' });
  emit();
  toast(`${S.dms[id].name || 'Conversation'} closed. A new message brings it back.`, { undo: () => showDm(id) });
  return act('dm.hide', { dm: id }).catch(() => resync());
}
export function showDm(id) {
  if (S.dms[id]) { delete S.dms[id].hidden; emit(); }
  return act('dm.show', { dm: id }).catch(() => resync());
}
export function pinDm(id, on) {
  if (S.dms[id]) { if (on) S.dms[id].pinned = Date.now(); else delete S.dms[id].pinned; emit(); }
  return act('dm.pin', { dm: id, on }).catch(() => resync());
}
export const renameDm = (id, name) => act('dm.rename', { dm: id, name });
export const iconDm = (id, emoji, hue) => act('dm.icon', { dm: id, emoji, hue });
export const addToDm = (id, users) => act('dm.add', { dm: id, users });
export const leaveDm = (id) => act('dm.leave', { dm: id });
export const kickFromDm = (id, user) => act('dm.kick', { dm: id, user });

// The quick switcher's actions (js/views/search.js): Focused for a while, and the Mentions inbox.
export const INBOX_ACTIONS = [
  ...[['30m', '30 minutes'], ['1h', 'an hour'], ['2h', '2 hours'], ['4h', '4 hours'], ['today', 'the rest of today']].map(([c, label]) => ({
    label: `Focused for ${label}`, icon: 'bell-off', words: `focus focused do not disturb quiet for ${label} timer`, run: () => setPresenceFor('focus', c),
  })),
  { label: 'Mentions', icon: 'at', words: 'mentions inbox replies at catch up', run: () => { S.ui.catchTab = 'mentions'; go({ type: 'catchup' }); } },
];
