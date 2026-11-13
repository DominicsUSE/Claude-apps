// Calls in direct conversations and groups. The media side is voice.js (a
// call is a voice place keyed by the conversation id); this module adds what
// only calls have: starting one, ringing, accepting or declining it, the
// ringtone, and the notice when a call ends.
//
// The server decides everything that matters: who may call, who rings, when a
// ring times out, and what the conversation's record says. Here we only show
// it, and play a ringtone made with WebAudio (no sound files).
import { S, emit, subscribe, convMeta, openConv, toast, person, openModal } from './store.js';
import { call, on } from './server.js';
import { joinVoice } from './voice.js';
import { vp } from './voiceopts.js'; // ringtone, its volume and output device (voice and calls track)
import { Confirm } from './views/modals.js';

const END_NOTE_MS = 8000;

// The call I am being rung for that is most worth showing: the newest one I
// am not already in.
export function incoming() {
  const list = Object.values(S.ringing).filter((r) => S.call?.room !== r.dm && S.dms[r.dm]);
  return list.sort((a, b) => b.until - a.until)[0] || null;
}

// Going somewhere else (another call, a voice room) while I'm in a call
// takes me out of it. Ask first, saying what happens to the call: a
// one-to-one call ends, a group call goes on without me. Anything else (not
// in a call, or already in this one) goes straight on.
export function leavingCall(target, go) {
  const c = S.call;
  if (!c || !c.dm || c.room === target) return go();
  const meta = convMeta(c.room);
  const group = meta?.kind === 'group';
  const who = meta?.user ? meta.user.name : meta?.title || 'this conversation';
  const there = S.dms[target] ? (S.ringing[target] ? 'Picking up' : 'Calling') : `Joining ${S.rooms[target]?.name || 'voice'}`;
  openModal(Confirm, {
    title: group ? `Leave the call in ${meta?.title || 'your group'}?` : `End your call with ${who}?`,
    text: group ? `${there} takes you out of it. It goes on for the others, and you can join again from the conversation.`
      : `${there} hangs up your call with ${who}.`,
    action: group ? 'Leave and continue' : 'End call and continue',
    danger: !group,
    onConfirm: go,
  });
  return undefined;
}

export function startCall(dm, { video = false } = {}) {
  if (S.conn.socket !== 'open') { toast('You’re offline, so you can’t call right now.'); return; }
  leavingCall(dm, () => {
    openConv(dm);
    joinVoice(dm, { start: true, video });
  });
}

// Picking up: wherever I was (another call, a voice room) I leave; the
// conversation opens on the call. The server hears nothing until the
// microphone is on; if it never comes on (refused, or none), the call still
// rings, so the incoming screen comes back to be declined or tried again.
let answering = null; // { call, stopped }: the ring being picked up here
const ringOver = ({ call: id }) => { if (answering?.call === id) answering.stopped = true; };
on('call.ring.stop', ringOver);
on('call.ended', ringOver);
export function acceptCall(dm, { video = false } = {}) {
  const r = S.ringing[dm];
  delete S.ringing[dm];
  stopRingtone();
  emit();
  openConv(dm);
  const a = r ? { call: r.call, stopped: false } : null;
  answering = a;
  joinVoice(dm, { video: video || false }).then((how) => {
    if (answering === a) answering = null;
    if (how === 'mic' && a && !a.stopped && !S.ringing[dm] && S.calls[dm]?.id === r.call) { S.ringing[dm] = r; emit(); }
  });
}
// From the strip or a header button (not the incoming screen, which says so
// itself): ask before leaving a call I'm in.
export const joinCall = (dm, opts) => leavingCall(dm, () => acceptCall(dm, opts));

export function declineCall(dm) {
  const r = S.ringing[dm];
  if (!r) return;
  delete S.ringing[dm];
  emit();
  call('call.decline', { dm, call: r.call }).catch(() => {});
}

// ---------- The end of a call ----------
// "Declined", "No answer" or "Call ended", for a few seconds where the call was.
let endTimer = null;
on('call.ended', ({ dm }) => {
  if (S.callEnd?.dm !== dm) return;
  clearTimeout(endTimer);
  endTimer = setTimeout(() => { if (S.callEnd?.dm === dm) { S.callEnd = null; emit(); } }, END_NOTE_MS);
});
export function dismissCallEnd() { clearTimeout(endTimer); S.callEnd = null; emit(); }

// Picked up on another device: this one stops ringing, and says why.
on('call.ring.stop', ({ dm, reason }) => {
  if (reason === 'answered' && S.call?.room !== dm && S.prefs.toasts) toast('You answered on another device.');
});

// ---------- Ringtone ----------
// A few notes, a pause, again: built from oscillators each time it rings.
// Four patterns to pick from (Settings > Voice and video > Calls), at the
// chosen volume, on the chosen output where the browser allows it.
// A conversation set to Nothing (muted), or being Focused, rings quietly: the
// call shows, but makes no sound.
// Each pattern: [frequency Hz, start s, length s] notes, the wave, and how often it repeats (ms).
export const RINGTONES = {
  chime: { label: 'Chime', wave: 'sine', every: 2600, notes: [[659.25, 0, 0.38], [554.37, 0.42, 0.38], [659.25, 0.84, 0.38]] },
  bells: { label: 'Bells', wave: 'triangle', every: 2800, notes: [[880, 0, 0.5], [698.46, 0.25, 0.5], [523.25, 0.5, 0.7]] },
  pulse: { label: 'Pulse', wave: 'sine', every: 2000, notes: [[440, 0, 0.18], [440, 0.26, 0.18], [440, 0.52, 0.18]] },
  rise: { label: 'Rise', wave: 'sine', every: 3000, notes: [[392, 0, 0.25], [493.88, 0.25, 0.25], [587.33, 0.5, 0.25], [783.99, 0.75, 0.45]] },
};
const PEAK = 0.22; // the loudest a ring gets, at 100%
let ctx = null;
let ringLoop = null;
let ringing = false;
export let lastRing = null; // for the end-to-end checks: { pattern, peak, at }
const patternOf = (name = vp().ringtone) => (RINGTONES[name] ? name : 'chime');
function ringCtx() {
  ctx ||= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  // The ring's own output device, where the browser can choose one.
  const out = vp().ringOutput || '';
  if (typeof ctx.setSinkId === 'function' && (ctx.sinkId || '') !== out) ctx.setSinkId(out).catch(() => {});
  return ctx;
}
function tone(at, freq, len, wave, peak) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = wave;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.03);
  g.gain.setValueAtTime(peak, at + Math.max(0.04, len - 0.08));
  g.gain.linearRampToValueAtTime(0, at + len);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + len + 0.02);
}
function burst(name = patternOf()) {
  if (!ctx) return;
  const p = RINGTONES[name];
  const v = vp().ringVolume;
  const peak = PEAK * Math.max(0, Math.min(1, typeof v === 'number' ? v : 0.8));
  const t = ctx.currentTime + 0.02;
  for (const [f, at, len] of p.notes) tone(t + at, f, len, p.wave, peak);
  lastRing = { pattern: name, peak, at: Date.now() };
}
// Hear a ringtone once, in settings.
export function previewRingtone(name) {
  try { ringCtx(); burst(patternOf(name)); } catch { /* no audio here */ }
}
function startRingtone() {
  if (ringing) return;
  ringing = true;
  try {
    ringCtx();
    const name = patternOf();
    burst(name);
    ringLoop = setInterval(() => burst(name), RINGTONES[name].every);
  } catch { /* no audio here: the call still shows */ }
}
function stopRingtone() {
  if (!ringing) return;
  ringing = false;
  clearInterval(ringLoop);
  ringLoop = null;
  // Suspending silences anything already scheduled at once.
  ctx?.suspend().catch(() => {});
}
export const ringtonePlaying = () => ringing;

// The ringtone follows the state: on while a loud ring is waiting, off on any
// outcome (accepted here or elsewhere, declined, timed out, the caller gave up).
subscribe(() => {
  const r = incoming();
  if (r && !r.quiet && r.until > Date.now() - 2000) startRingtone(); else stopRingtone();
});
// The server says when a ring times out; this is only a backstop if that is lost.
setInterval(() => {
  let changed = false;
  for (const [dm, r] of Object.entries(S.ringing)) if (r.until < Date.now() - 5000) { delete S.ringing[dm]; changed = true; }
  if (changed) emit();
}, 2000);

// ---------- Notifications for a ring ----------
// The desktop app brings its window up from the tray and shows a system
// notification. A browser tab in the background shows one too, if allowed.
const shown = () => document.visibilityState === 'visible' && !window.snugApp?.hidden?.();
export function callTitle(r) {
  const who = person(r.from).name;
  return `${who} is calling`;
}
export function callBody(r) {
  const meta = convMeta(r.dm);
  return `${r.video ? 'Video call' : 'Voice call'}${r.group && meta ? ` in ${meta.title}` : ''}`;
}
const notes = new Map(); // dm -> the browser notification for its ring
const closeNote = ({ dm }) => { notes.get(dm)?.close(); notes.delete(dm); window.snugApp?.callOver?.({ dm }); };
on('call.ring.stop', closeNote);
on('call.ended', closeNote);
on('call.ring', (d) => {
  const r = S.ringing[d.dm];
  if (!r || r.quiet) return;
  if (window.snugApp?.incomingCall) {
    window.snugApp.incomingCall({ dm: r.dm, title: callTitle(r), body: callBody(r) });
    return;
  }
  if (shown() || !S.prefs.desktop || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(callTitle(r), { body: callBody(r), tag: `snug-call:${r.dm}`, requireInteraction: true });
    n.onclick = () => { window.focus(); openConv(r.dm); n.close(); };
    notes.set(r.dm, n);
  } catch { /* notifications not available here */ }
});
