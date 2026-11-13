// Account settings in the browser (the server side is server/account.js):
// - settings that follow you: every appearance, accessibility and
//   notification setting in PREF_RULES (js/lib/account.js) is sent to the
//   server when it changes here, and taken from the server on every connect
//   and whenever another device changes one;
// - applying them to the page at once (theme, tone, compact display, text
//   scale, zoom, line height, saturation, font, links, focus ring, sidebar);
// - auto-idle, notification sounds (made with WebAudio, no files), quiet
//   hours, highlight words and @everyone, streamer mode, reading messages
//   aloud, and the recent places the quick switcher offers first.
import { S, emit, subscribe, toast, convMeta, signOutHooks } from './store.js';
import { call, on, notifyFilters } from './server.js';
import { PREF_RULES, PREF_DEFAULTS, cleanPrefs, inQuiet, hasKeyword, everyonePing } from './lib/account.js';
import { forMeHooks, needsMe, levelOf } from './lib/attention.js';
import { can } from './lib/perms.js';
import { plain } from './lib/format.js';
import { setClock } from './lib/util.js';

export const SYNCED = Object.keys(PREF_RULES);
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
};
// Whose synced settings this device holds, and what the server last knew of them.
const OWNER = 'snug.prefsOwner';
const SENT = 'snug.prefsSent';
// Settings this device has never had start from the defaults.
for (const k of SYNCED) if (!(k in S.prefs)) S.prefs[k] = structuredClone(PREF_DEFAULTS[k]);
// The old three-step text size becomes the 12-20px scale.
if (S.prefs.text && S.prefs.text !== 'm') { if (S.prefs.fontScale === 16) S.prefs.fontScale = S.prefs.text === 's' ? 14 : 18; S.prefs.text = 'm'; }

// ---------- Sync ----------
let sent = null;       // the synced settings as the server last knew them
let timer = null;
const pick = (p) => Object.fromEntries(SYNCED.map((k) => [k, p[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setSent = (v) => { sent = v; if (v) local.set(SENT, v); else local.del(SENT); };

function adopt(server) {
  for (const k of SYNCED) S.prefs[k] = k in server ? structuredClone(server[k]) : structuredClone(PREF_DEFAULTS[k]);
  setSent(pick(S.prefs));
  applyAppearance();
}
// Back to the defaults: the settings here belong to nobody now.
function forget() {
  clearTimeout(timer);
  for (const k of SYNCED) S.prefs[k] = structuredClone(PREF_DEFAULTS[k]);
  setSent(null);
  local.del(OWNER);
  applyAppearance();
}
// Whose settings are on this device: the person recorded, or for settings
// from before that was recorded, nobody's unless only this person has synced here.
function ownerHere(me) {
  const owner = local.get(OWNER);
  if (owner) return owner;
  const others = local.keys().filter((k) => k.startsWith('snug.prefsSynced.') && k !== `snug.prefsSynced.${me}`);
  return others.length ? 'someone else' : null;
}
function push() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!sent || S.conn.socket !== 'open') return;
    const now = pick(S.prefs);
    const patch = {};
    for (const k of SYNCED) if (!same(now[k], sent[k])) patch[k] = same(now[k], PREF_DEFAULTS[k]) ? null : now[k];
    if (!Object.keys(patch).length) return;
    try { cleanPrefs(patch); } catch (e) { toast(e.message); return; }
    const before = sent;
    setSent(now);
    call('prefs.set', { prefs: patch }).catch((e) => {
      setSent(before);
      if (!e.offline) toast(e.message);
    });
  }, 300);
}

on('open', () => {
  const acc = S.account || {};
  const server = acc.prefs || {};
  const flag = `snug.prefsSynced.${S.me}`;
  const owner = ownerHere(S.me);
  // Someone else's settings (a shared device): never this person's, never uploaded.
  if (owner && owner !== S.me) forget();
  if (!Object.keys(server).length && !local.get(flag)) {
    // First time on any device: what this device already had becomes the account's.
    setSent(Object.fromEntries(SYNCED.map((k) => [k, PREF_DEFAULTS[k]])));
    push();
  } else {
    // Changes made here while offline (against what the server last knew)
    // win over the server's copy; everything else comes from the server.
    const base = sent || (owner === S.me ? local.get(SENT) : null);
    const now = pick(S.prefs);
    const mine = base ? SYNCED.filter((k) => k in base && !same(now[k], base[k])) : [];
    adopt(server);
    for (const k of mine) S.prefs[k] = now[k];
    if (mine.length) { applyAppearance(); push(); }
  }
  local.set(OWNER, S.me);
  local.set(flag, true);
  reportIdle(true);
  emit();
});
signOutHooks.push(forget);
on('account', (d) => {
  S.account ||= { prefs: {}, notes: {}, totp: false, backupLeft: 0 };
  if (d.prefs) { S.account.prefs = d.prefs; adopt(d.prefs); }
  if (d.note) { if (d.note.note) S.account.notes[d.note.user] = d.note.note; else delete S.account.notes[d.note.user]; }
  if ('totp' in d) S.account.totp = d.totp;
  if ('backupLeft' in d) S.account.backupLeft = d.backupLeft;
});

// ---------- Applying them ----------
let applied = '';
export function applyAppearance() {
  const p = S.prefs;
  const key = JSON.stringify(pick(p));
  if (key === applied) return;
  applied = key;
  const root = document.documentElement;
  const attr = (name, val) => (val == null || val === false ? root.removeAttribute(name) : root.setAttribute(name, val === true ? '' : val));
  if (p.theme && p.theme !== 'system') root.setAttribute('data-theme', p.theme); else root.removeAttribute('data-theme');
  attr('data-tone', p.tone !== 'coral' ? p.tone : null);
  attr('data-display', p.display === 'compact' ? 'compact' : null);
  attr('data-compact-avatars', p.display === 'compact' && p.compactAvatars);
  attr('data-lh', p.lineHeight !== 'normal' ? p.lineHeight : null);
  attr('data-font', p.font !== 'inter' ? p.font : null);
  attr('data-underline', !!p.underlineLinks);
  attr('data-focus', p.focusAlways ? 'always' : null);
  attr('data-role-colors', p.roleColors === false ? 'off' : null);
  attr('data-streamer', !!p.streamer);
  attr('data-motion', p.motion === 'reduced' ? 'off' : null);
  attr('data-contrast', p.contrast !== 'system' ? p.contrast : null);
  attr('data-density', p.density !== 'regular' ? p.density : null);
  root.removeAttribute('data-text');
  root.style.fontSize = p.fontScale && p.fontScale !== 16 ? `${p.fontScale}px` : '';
  root.style.zoom = p.zoom && p.zoom !== 100 ? `${p.zoom}%` : '';
  root.style.filter = p.saturation < 100 ? `saturate(${p.saturation}%)` : '';
  root.style.setProperty('--ctx-w', `${p.sidebarW || 264}px`);
  setClock(p.clock);
}
subscribe(() => { applyAppearance(); if (sent) push(); trackRecent(); speakNew(); favouriteRings(); });

// While Focused, a call from a favourite friend may still ring out loud
// (Settings > Notifications). A muted conversation, and quiet hours, stay quiet.
function favouriteRings() {
  if (!S.prefs.favCalls || S.users[S.me]?.presence !== 'focus' || inQuiet(S.prefs.quiet)) return;
  let loud = false;
  for (const r of Object.values(S.ringing)) {
    if (r.quiet && !r.loudened && S.friends[r.from]?.favorite && levelOf(S, r.dm) !== 'muted') { r.quiet = false; r.loudened = true; loud = true; }
  }
  if (loud) emit();
}

// ---------- Auto-idle ----------
let lastInput = Date.now();
let idleSent = null;
function reportIdle(force) {
  const mins = S.prefs.autoIdle || 0;
  const idle = mins > 0 && (Date.now() - lastInput > mins * 60_000);
  if (!force && idle === idleSent) return;
  if (S.conn.socket !== 'open') { idleSent = null; return; }
  idleSent = idle;
  call('presence.idle', { idle }).catch(() => { idleSent = null; });
}
const active = () => { lastInput = Date.now(); if (idleSent) reportIdle(); };
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, active, { passive: true, capture: true });
let moveAt = 0;
addEventListener('pointermove', () => { if (Date.now() - moveAt > 5000) { moveAt = Date.now(); active(); } }, { passive: true });
setInterval(() => reportIdle(), 20_000);
// Tests (and the console) can make this tab idle now.
export function goIdle() { lastInput = 0; reportIdle(); }

// ---------- What counts as a mention: highlight words, @everyone and @here ----------
forMeHooks.push((St, conv, m) => {
  if (!m.text || m.author === St.me) return false;
  if (hasKeyword(m.text, St.prefs?.keywords)) return true;
  const ping = everyonePing(m.text);
  if (!ping) return false;
  const roomId = conv.startsWith('t:') ? St.threads?.[conv]?.conv : conv;
  const house = St.rooms?.[roomId]?.house;
  return !!house && !St.prefs?.everyoneOff?.[house] && can(St, house, 'announce', m.author);
});

// ---------- Notifications: quiet hours, sounds, previews ----------
const placeOf = (conv) => {
  if (conv.startsWith('t:')) return S.threads[conv]?.conv || conv;
  return conv;
};
export const soundMuted = (conv) => {
  const p = placeOf(conv);
  const house = S.rooms[p]?.house;
  return !!(S.prefs.mutedSounds?.[p] || (house && S.prefs.mutedSounds?.[house]));
};
notifyFilters.push((conv) => {
  if (inQuiet(S.prefs.quiet)) return false;
  if (!soundMuted(conv)) playSound(S.prefs.sound);
  return true;
});

let ctx = null;
// Each sound is a few notes made here: [frequency Hz, start s, length s, gain].
const SOUNDS = {
  soft: [[660, 0, 0.14, 0.18], [880, 0.09, 0.2, 0.14]],
  bell: [[988, 0, 0.6, 0.16], [1976, 0, 0.35, 0.05]],
  pop: [[420, 0, 0.07, 0.22], [640, 0.05, 0.08, 0.16]],
  drop: [[1200, 0, 0.12, 0.14], [600, 0.08, 0.22, 0.14]],
};
export let soundsPlayed = 0;
export function playSound(name) {
  const notes = SOUNDS[name];
  if (!notes) return;
  soundsPlayed++;
  try {
    ctx ||= new AudioContext();
    const t0 = ctx.currentTime + 0.01;
    for (const [f, at, len, g] of notes) {
      const o = ctx.createOscillator();
      const v = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t0 + at);
      if (name === 'drop') o.frequency.exponentialRampToValueAtTime(f / 2, t0 + at + len);
      v.gain.setValueAtTime(0.0001, t0 + at);
      v.gain.exponentialRampToValueAtTime(g, t0 + at + 0.01);
      v.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(v).connect(ctx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + len + 0.05);
    }
  } catch { /* no audio here */ }
}

// ---------- Recent places, for the quick switcher ----------
const RECENT_KEY = 'snug.recentPlaces';
let recent = local.get(RECENT_KEY) || [];
let lastView = '';
function trackRecent() {
  const v = S.ui.view;
  const id = v.type === 'conv' ? v.id : v.type === 'house' ? `h:${v.id}` : null;
  if (!id || id === lastView) return;
  lastView = id;
  recent = [id, ...recent.filter((x) => x !== id)].slice(0, 12);
  local.set(RECENT_KEY, recent);
}
// The place you are in now is left out: the switcher offers where you were before it.
export const recentPlaces = () => recent.filter((id) => id !== lastView && (id.startsWith('h:') ? S.houses[id.slice(2)]?.joined : convMeta(id)));
// Points the quick switcher adds for a recent place: a lot with nothing typed, a little while searching.
export function recentScore(id, q) {
  const i = recentPlaces().indexOf(id);
  if (i < 0) return 0;
  return q ? 3 - Math.min(i, 3) * 0.5 : 60 - i * 6;
}

// A match keeps its score plus the recent bonus; a miss stays a miss.
export const withRecent = (score, id, q) => (score < 0 ? score : score + recentScore(id, q));

// ---------- Reading messages aloud ----------
let lastSpoken = null;
function speakNew() {
  const v = S.ui.view;
  if (v.type !== 'conv') { lastSpoken = null; return; }
  const list = S.msgs[v.id] || [];
  const last = list[list.length - 1];
  const key = last ? `${v.id}|${last.id}` : null;
  if (lastSpoken === null || !lastSpoken.startsWith(`${v.id}|`)) { lastSpoken = key || `${v.id}|`; return; }
  if (!key || key === lastSpoken) return;
  const prevId = lastSpoken.split('|')[1];
  lastSpoken = key;
  if (!S.prefs.tts || typeof speechSynthesis === 'undefined' || document.visibilityState !== 'visible') return;
  const at = list.findIndex((m) => m.id === prevId);
  for (const m of list.slice(at + 1)) {
    if (m.author === S.me || m.state || m.sys) continue;
    speak(`${S.users[m.author]?.name || 'Someone'}: ${plain(m.text) || 'sent an attachment'}`);
  }
}
export function speak(text) {
  if (typeof speechSynthesis === 'undefined') return false;
  const u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
  u.rate = 1;
  speechSynthesis.speak(u);
  return true;
}
export { needsMe, levelOf };
