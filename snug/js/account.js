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
import { S, emit, subscribe, toast, convMeta, signOutHooks, applyPrefs } from './store.js';
import { call, on, notifyFilters } from './server.js';
import { PREF_RULES, PREF_DEFAULTS, cleanPrefs, upgradePrefs, inQuiet, hasKeyword, everyonePing, soundKind, soundFor } from './lib/account.js';
import { THEME_PRESETS, customId, deriveTheme, accentTokens } from './lib/theme.js';
import { parseHex } from './lib/colour.js';
import { forMeHooks, needsMe, levelOf, forMe } from './lib/attention.js';
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
  server = upgradePrefs(server);
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
  // This device's own look and the saved first paint were the last person's too.
  local.del(DEVICE);
  try { localStorage.removeItem('snug.paint'); } catch { /* storage blocked */ }
  applied = '';
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
    // A base saved before violet still says 'coral': upgrade it as S.prefs was,
    // or the rename would look like an offline change and wipe the server's.
    const base = upgradePrefs(sent || (owner === S.me ? local.get(SENT) : null));
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
// Appearance settings this device can keep for itself ("Use these settings on
// this device only"): read from and written to localStorage, over the synced ones.
export const DEVICE_KEYS = ['theme', 'zoom', 'fontScale', 'density', 'display', 'sidebarW'];
const DEVICE = 'snug.deviceLook';
export function deviceLook() { const v = local.get(DEVICE); return v && v.on ? v : null; }
// The settings in force on this device.
export function effectivePrefs(p = S.prefs) {
  const d = deviceLook();
  if (!d) return p;
  const out = { ...p };
  for (const k of DEVICE_KEYS) if (d.values && k in d.values) out[k] = d.values[k];
  return out;
}
export function setDeviceOnly(on) {
  if (on) local.set(DEVICE, { on: true, values: Object.fromEntries(DEVICE_KEYS.map((k) => [k, S.prefs[k]])) });
  else local.del(DEVICE);
  applied = '';
  applyAppearance();
  emit();
}
// Change a look setting: on this device only when that's on, else for every device.
export function setLook(key, val) {
  const d = deviceLook();
  if (d && DEVICE_KEYS.includes(key)) { d.values = { ...d.values, [key]: val }; local.set(DEVICE, d); applied = ''; applyAppearance(); emit(); return; }
  S.prefs[key] = val;
  applyPrefs();
  emit();
}

const darkDevice = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
// The theme in force: a built-in, or a saved custom one (else the default).
export function resolveTheme(p = effectivePrefs()) {
  const id = customId(p.theme);
  const custom = id ? (p.customThemes || []).find((t) => t.id === id) : null;
  if (custom) return { id: p.theme, custom, base: custom.base, bg1: custom.bg, attr: custom.base };
  const name = THEME_PRESETS[p.theme] ? p.theme : 'system';
  const preset = THEME_PRESETS[name === 'system' ? (darkDevice() ? 'dark' : 'light') : name];
  return { id: name, base: preset.base, bg1: preset.bg1, bg0: preset.bg0, attr: name === 'system' ? null : name };
}

// Tiny patterns for the chat background, drawn in the theme's faintest line colour.
const PATTERNS = {
  dots: [16, (c) => `<circle cx="8" cy="8" r="1" fill="${c}"/>`],
  grid: [24, (c) => `<path d="M24 .5H.5V24" fill="none" stroke="${c}"/>`],
  arches: [32, (c) => `<path d="M11 24v-7a5 5 0 0 1 10 0v7" fill="none" stroke="${c}" stroke-width="1.25"/>`],
  grain: [48, (c) => [[5, 7], [19, 3], [33, 11], [44, 6], [9, 22], [27, 19], [40, 27], [14, 36], [31, 33], [46, 42], [3, 44], [22, 45]].map(([x, y]) => `<rect x="${x}" y="${y}" width="1.2" height="1.2" fill="${c}"/>`).join('')],
};
function patternUrl(kind, colour) {
  const p = PATTERNS[kind];
  if (!p || !/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,/%]+\)|color\([\w\s.%-]+\))$/i.test(colour)) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${p[0]}" height="${p[0]}">${p[1](colour)}</svg>`;
  return [`url("data:image/svg+xml,${encodeURIComponent(svg)}")`, `${p[0]}px ${p[0]}px`];
}

let applied = '';
// Custom properties this function set on <html> (js/boot.js may have set some
// from last time's look before this module ran; they count as ours too).
let inline = new Set(typeof document === 'undefined' ? [] : [...document.documentElement.style].filter((k) => k.startsWith('--') && !k.startsWith('--chat-pattern') && k !== '--ctx-w'));
const looks = new Set();  // the data-* attributes this function owns
export function applyAppearance() {
  const p = effectivePrefs();
  const root = document.documentElement;
  const attr = (name, val) => { looks.add(name); return val == null || val === false ? root.removeAttribute(name) : root.setAttribute(name, val === true ? '' : val); };
  const th = resolveTheme(p);
  // Always (cheap): store.js applyPrefs may have just written the raw setting.
  attr('data-theme', th.attr);
  attr('data-density', p.density !== 'regular' ? p.density : null);
  const key = JSON.stringify([pick(p), th.attr, th.bg1]);
  if (key === applied) return;
  applied = key;
  attr('data-tone', p.tone && p.tone !== 'violet' && (!p.accent || p.accent === 'violet') ? p.tone : null);
  attr('data-display', p.display === 'compact' ? 'compact' : null);
  attr('data-compact-avatars', p.display === 'compact' && p.compactAvatars);
  attr('data-lh', p.lineHeight !== 'normal' ? p.lineHeight : null);
  attr('data-font', p.font !== 'inter' ? p.font : null);
  attr('data-code-font', p.codeFont === 'system-mono' ? 'system-mono' : null);
  attr('data-underline', !!p.underlineLinks);
  attr('data-focus', p.focusAlways ? 'always' : null);
  attr('data-role-colors', p.roleColors === false ? 'off' : null);
  attr('data-streamer', !!p.streamer);
  attr('data-motion', p.motion === 'reduced' ? 'off' : null);
  attr('data-contrast', p.contrast !== 'system' ? p.contrast : null);
  // Chat display (css/appearance.css).
  attr('data-times', p.showTimes === 'hover' ? 'hover' : null);
  attr('data-jumbo', p.jumboEmoji === false ? 'off' : null);
  attr('data-emoji-size', p.emojiSize && p.emojiSize !== 'm' ? p.emojiSize : null);
  attr('data-reactions', p.showReactions === false ? 'off' : null);
  attr('data-spoilers', p.spoilers === 'always' ? 'always' : null);
  attr('data-name-styles', p.showNameStyles === false ? 'off' : null);
  attr('data-gif', p.gifAutoplay && p.gifAutoplay !== 'auto' ? p.gifAutoplay : null);
  root.removeAttribute('data-text');
  root.style.fontSize = p.fontScale && p.fontScale !== 16 ? `${p.fontScale}px` : '';
  root.style.zoom = p.zoom && p.zoom !== 100 ? `${p.zoom}%` : '';
  root.style.filter = p.saturation < 100 ? `saturate(${p.saturation}%)` : '';
  root.style.setProperty('--ctx-w', `${p.sidebarW || 240}px`);
  // Colours: a custom theme's tokens, or the accent ramp for this theme's surface.
  // Values come from js/lib/theme.js (hex and rgb() only), set one property at a time.
  const props = {};
  if (th.custom) Object.assign(props, deriveTheme(th.custom).tokens);
  else {
    const ramp = accentTokens(p.accent, th.bg1, th.base);
    if (ramp) { Object.assign(props, ramp); const [r, g, b] = parseHex(ramp['--accent']); props['--selection'] = `rgb(${r} ${g} ${b} / 0.32)`; }
  }
  attr('data-accent', th.custom || (p.accent && p.accent !== 'violet') ? '' : null);
  for (const k of inline) if (!(k in props)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(props)) root.style.setProperty(k, v);
  inline = new Set(Object.keys(props));
  // Chat background, from the theme's faintest line once the colours above are in.
  const bgKind = p.chatBg && p.chatBg !== 'plain' ? p.chatBg : null;
  attr('data-chat-bg', bgKind);
  const pat = bgKind ? patternUrl(bgKind, props['--line-subtle'] || getComputedStyle(root).getPropertyValue('--line-subtle').trim()) : null;
  if (pat) { root.style.setProperty('--chat-pattern', pat[0]); root.style.setProperty('--chat-pattern-size', pat[1]); }
  else { root.style.removeProperty('--chat-pattern'); root.style.removeProperty('--chat-pattern-size'); }
  setClock(p.clock);
  // What js/boot.js puts on <html> before the next first paint, so a custom
  // theme, accent or this device's own look never flashes the default colours.
  try {
    const attrs = {};
    for (const name of looks) if (root.hasAttribute(name)) attrs[name] = root.getAttribute(name);
    localStorage.setItem('snug.paint', JSON.stringify({ attrs, props, fontSize: root.style.fontSize, zoom: root.style.zoom }));
  } catch { /* storage full or blocked: the first paint uses the raw setting */ }
  // The desktop app colours its title bar to match (optional bridge).
  try { window.snugApp?.setThemeColor?.(props['--bg-0'] || th.bg0 || getComputedStyle(root).getPropertyValue('--bg-0').trim()); } catch { /* no bridge */ }
}
// The device switching between light and dark changes a "Match device" theme.
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applied = ''; applyAppearance(); }); } catch { /* no matchMedia */ }
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
  if (!ping || m.noPing) return false; // noPing: sent by someone who may not post notices (server/chat.js)
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
// A sound per kind (mention, direct message, other message), at the chosen
// volume. Quiet hours, Focused (js/server.js) and each house's sound switch still win.
notifyFilters.push((conv, m) => {
  if (inQuiet(S.prefs.quiet)) return false;
  if (!soundMuted(conv)) playSound(soundFor(S.prefs, soundKind({ dm: !!S.dms[conv], forMe: !!m && forMe(S, conv, m) })), { volume: S.prefs.soundVolume ?? 80 });
  return true;
});

let ctx = null;
// Each sound is a few notes made here: [frequency Hz, start s, length s, gain, wave?].
const SOUNDS = {
  soft: [[660, 0, 0.14, 0.18], [880, 0.09, 0.2, 0.14]],
  bell: [[988, 0, 0.6, 0.16], [1976, 0, 0.35, 0.05]],
  pop: [[420, 0, 0.07, 0.22], [640, 0.05, 0.08, 0.16]],
  drop: [[1200, 0, 0.12, 0.14], [600, 0.08, 0.22, 0.14]],
  wood: [[320, 0, 0.06, 0.26, 'triangle'], [480, 0.07, 0.06, 0.18, 'triangle']],
  glass: [[1568, 0, 0.4, 0.09], [2352, 0.02, 0.3, 0.04], [1175, 0.12, 0.35, 0.07]],
  chime: [[784, 0, 0.18, 0.14], [1047, 0.1, 0.18, 0.13], [1319, 0.2, 0.32, 0.11]],
  tick: [[1800, 0, 0.03, 0.12, 'triangle']],
};
export const SOUND_LIST = Object.keys(SOUNDS);
export let soundsPlayed = 0;
// The names of the sounds played, newest last (the end-to-end checks read it).
export const soundLog = [];
export function playSound(name, { volume = 100 } = {}) {
  const notes = SOUNDS[name];
  if (!notes) return;
  const scale = Math.max(0, Math.min(100, volume)) / 100;
  soundsPlayed++;
  soundLog.push(name);
  if (soundLog.length > 50) soundLog.shift();
  if (scale <= 0) return;
  try {
    ctx ||= new AudioContext();
    const t0 = ctx.currentTime + 0.01;
    for (const [f, at, len, g, wave] of notes) {
      const o = ctx.createOscillator();
      const v = ctx.createGain();
      o.type = wave || 'sine';
      o.frequency.setValueAtTime(f, t0 + at);
      if (name === 'drop') o.frequency.exponentialRampToValueAtTime(f / 2, t0 + at + len);
      v.gain.setValueAtTime(0.0001, t0 + at);
      v.gain.exponentialRampToValueAtTime(Math.max(0.0002, g * scale), t0 + at + 0.01);
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
