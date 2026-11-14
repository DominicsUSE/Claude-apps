// The page's side of the desktop app's bridge (desktop/preload.js, window.snugApp)
// and of the installed web app's badge:
// - the unread number on the app icon (the same number as the tab title),
// - global mute and deafen keys while in voice (the app presses, we toggle),
// - the computer going idle, locking or sleeping counts as Away,
// - snug:// links (checked again here, then routed; the server still refuses
//   history this person can't read),
// - "a newer Snug is out" strip.
// Every call is optional: in a plain browser tab there is no bridge.
import { S, emit, subscribe, openConv, jumpToMsg, toast } from './store.js';
import { totalNeeds } from './lib/attention.js';
import { parseDeepLink } from './lib/inbox.js';
import { toggleMute, toggleDeaf } from './voice.js';
import { goIdle } from './account.js';

const app = () => (typeof window !== 'undefined' ? window.snugApp : null);
export const isDesktop = () => !!app()?.desktop;

// ---------- The unread number on the icon ----------
let lastBadge = -1;
export function badgeCount() {
  if (S.auth !== 'in' || !S.ready) return 0;
  if (S.prefs.showBadge === false) return 0;
  return Math.max(0, Math.min(999, totalNeeds(S)));
}
function syncBadge() {
  const n = badgeCount();
  if (n === lastBadge) return;
  lastBadge = n;
  try { app()?.setBadge?.(n); } catch { /* no bridge */ }
  // The installed web app (not the desktop app, which has its own).
  if (!isDesktop() && typeof navigator !== 'undefined' && navigator.setAppBadge) {
    const p = n ? navigator.setAppBadge(n) : navigator.clearAppBadge?.();
    p?.catch?.(() => {});
  }
}

// ---------- Global mute and deafen keys ----------
let inVoice = null;
function syncVoice() {
  const now = !!S.call;
  if (now === inVoice) return;
  inVoice = now;
  app()?.voiceActive?.(now)?.then?.((r) => {
    if (!now || !r) return;
    const bad = Object.entries(r).filter(([, v]) => v !== true && v !== null).map(([k, v]) => `${k === 'mute' ? 'Mute' : 'Deafen'}: ${v}`);
    if (bad.length) toast(`Some global shortcuts didn’t work. ${bad.join(' ')}`);
  }, () => {});
}
app()?.onVoiceToggle?.((which) => {
  if (!S.call) return;
  if (which === 'mute') toggleMute();
  else if (which === 'deafen') toggleDeaf();
  emit();
});

// ---------- The computer idle, locked or asleep ----------
app()?.onSystemIdle?.((state) => {
  if (state === 'idle' || state === 'locked' || state === 'suspend') goIdle();
  // Back: the page's own idle tracker hears it as input (js/account.js).
  else if (state === 'active' || state === 'unlocked' || state === 'resume') window.dispatchEvent(new Event('pointerdown'));
});

// ---------- snug:// links ----------
export function routeDeepLink(raw) {
  const link = parseDeepLink(raw);
  if (!link) return false;
  if (link.kind === 'join') { S.ui.joinCode = link.code; emit(); return true; }
  if (S.auth !== 'in' || !S.ready) { pending = raw; return true; }
  if (link.msg) jumpToMsg(link.place, link.msg);
  else if (S.rooms[link.place] || S.dms[link.place]) openConv(link.place);
  else toast('That place isn’t one you can open.');
  return true;
}
let pending = null;
app()?.onDeepLink?.((raw) => routeDeepLink(raw));

// ---------- A newer Snug ----------
export const update = { info: null, dismissed: false };
app()?.onUpdate?.((info) => {
  if (!info || typeof info.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(info.version)) return;
  update.info = { version: info.version };
  emit();
});
export function dismissUpdate() { update.dismissed = true; emit(); }

subscribe(() => {
  syncBadge();
  syncVoice();
  if (pending && S.auth === 'in' && S.ready) { const p = pending; pending = null; routeDeepLink(p); }
});

// For the end-to-end checks (js/app.js puts it on window.snug.desktop).
export const desktopTest = { badgeCount, routeDeepLink, update };
