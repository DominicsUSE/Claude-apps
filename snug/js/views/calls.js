// Calls in direct conversations and groups, on screen: the phone and camera
// buttons in the conversation header, the incoming-call screen, the strip
// that offers Join while a call is live, the note when a call ends, and the
// call records in the conversation. The in-call stage itself is the voice
// stage (js/views/conversation.js), shared with voice rooms.
import { html, useEffect, useRef } from '../../vendor/preact-htm.js';
import { S, person, convMeta, isOnline } from '../store.js';
import { fmtTime, fmtFull, nameList } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack } from '../ui/kit.js';
import { startCall, acceptCall, joinCall, declineCall, incoming, dismissCallEnd, callTitle, callBody } from '../calls.js';

const firstName = (id) => (id === S.me ? 'You' : person(id).name.split(' ')[0]);

// Why the call buttons can't be used right now, if they can't.
function blocked(conv) {
  if (!isOnline()) return 'You’re offline, so you can’t call right now';
  if (S.call?.room === conv) return 'You’re in this call';
  return null;
}

// Phone and camera, in the header of a direct conversation or group. While a
// call is live there they join it; while it rings for me they pick up.
export function CallButtons({ conv }) {
  const why = blocked(conv);
  const live = !!(S.voice[conv] || []).length;
  // The strip under the header is the live signal; these stay quiet controls.
  const label = (video) => why || (live ? (video ? 'Join the call with your camera on' : 'Join the call')
    : (video ? 'Start a video call' : 'Start a voice call'));
  const go = (video) => () => {
    if (why) return;
    if (S.ringing[conv]) joinCall(conv, { video });
    else startCall(conv, { video });
  };
  return html`
    <button class="ib call-btn" aria-label=${label(false)} data-tip=${label(false)} aria-disabled=${why ? 'true' : null} onClick=${go(false)}><${Icon} name="phone" /></button>
    <button class="ib call-btn" aria-label=${label(true)} data-tip=${label(true)} aria-disabled=${why ? 'true' : null} onClick=${go(true)}><${Icon} name="camera" /></button>`;
}

// A call is live here and I'm not in it: who is there, and Join.
export function CallStrip({ conv }) {
  const users = (S.voice[conv] || []).map((id) => S.users[id]).filter(Boolean);
  const c = S.calls[conv];
  if (!users.length || S.call?.room === conv) return null;
  const ringingMe = !!S.ringing[conv];
  const names = nameList(users.map((u) => firstName(u.id)));
  const offline = !isOnline();
  return html`<div class="call-strip live" role="region" aria-label="Call in progress">
    <span class="call-dot" aria-hidden="true"></span>
    <${Stack} users=${users} max=${4} size=${24} />
    <span class="grow call-strip-text">
      <b>${c?.video ? 'Video call' : 'Call'} in progress</b>
      <span class="faint trunc">${names} ${users.length === 1 && users[0].id !== S.me ? 'is' : 'are'} in it${c?.started ? `, since ${fmtTime(c.started)}` : ''}</span>
    </span>
    <button class="btn live" disabled=${offline} onClick=${() => joinCall(conv)}><${Icon} name="phone" size=${16} />${ringingMe ? 'Accept' : 'Join'}</button>
    <button class="ib" aria-label="Join with your camera on" data-tip="Join with your camera on" disabled=${offline} onClick=${() => joinCall(conv, { video: true })}><${Icon} name="camera" size=${18} /></button>
  </div>`;
}

const END_TEXT = {
  declined: ['Declined', (o) => `${o} declined the call.`],
  'no-answer': ['No answer', (o) => `${o} didn’t pick up.`],
  ended: ['Call ended', () => 'The other side hung up.'],
  cancelled: ['Call ended', () => 'The call ended before anyone joined.'],
};

// How my last call here ended, for a few seconds: "Declined", "No answer".
export function CallEndNote({ conv }) {
  const e = S.callEnd;
  if (!e || e.dm !== conv || S.call || (S.voice[conv] || []).length) return null;
  const meta = convMeta(conv);
  const other = meta?.user ? meta.user.name.split(' ')[0] : 'Nobody';
  const [title, line] = END_TEXT[e.reason] || END_TEXT.ended;
  return html`<div class=${`call-strip ended ${e.reason}`} role="status" aria-live="polite">
    <span class="call-ic"><${Icon} name="phone-off" size=${18} /></span>
    <span class="grow call-strip-text"><b>${title}</b><span class="faint trunc">${line(other)}</span></span>
    <button class="btn" disabled=${!isOnline()} onClick=${() => startCall(conv)}><${Icon} name="phone" size=${16} />Call again</button>
    <button class="ib" aria-label="Dismiss" data-tip="Dismiss" onClick=${dismissCallEnd}><${Icon} name="x" size=${18} /></button>
  </div>`;
}

// ---------- Incoming call ----------

const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const otherLayer = () => { const u = S.ui; return !!(u.menu || u.pop || u.modal || u.quick || u.lightbox || u.layer); };

// What accepting does to the call or voice room I'm in, if I'm in one.
function busyNote(busy) {
  if (!busy) return null;
  if (!busy.dm) return `Accepting leaves ${S.rooms[busy.room]?.name || 'the voice room'}.`;
  const meta = convMeta(busy.room);
  if (meta?.kind === 'group') return `Accepting takes you out of the call in ${meta.title}. It goes on for the others.`;
  return `Accepting ends your call${meta?.user ? ` with ${meta.user.name}` : ''}.`;
}

function IncomingCard({ r }) {
  const ref = useRef();
  const meta = convMeta(r.dm);
  const caller = person(r.from);
  const busy = busyNote(S.call && S.call.room !== r.dm ? S.call : null);
  useEffect(() => {
    const before = document.activeElement;
    // A loud ring takes the focus, so Enter picks up; a quiet one waits to be
    // noticed. Never out of a text field: the next Enter or Space meant for
    // the message would pick up the call.
    if (!r.quiet && !typing(before)) ref.current?.querySelector('.inc-accept')?.focus();
    const inside = (el) => !!ref.current && ref.current.contains(el);
    const onKey = (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const here = inside(e.target);
      // From anywhere else, Enter and Esc work only outside text fields, where
      // they belong to the field (send, close suggestions, cancel an edit).
      if (e.key === 'Escape' && (here || (!r.quiet && !otherLayer() && !typing(e.target)))) {
        e.preventDefault(); e.stopImmediatePropagation(); declineCall(r.dm);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // On one of the card's own buttons, Enter presses that button.
        if (here && e.target.tagName === 'BUTTON') return;
        if (here || (!r.quiet && !otherLayer() && !typing(e.target))) { e.preventDefault(); e.stopImmediatePropagation(); acceptCall(r.dm); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Give the focus back to where it was, if it was on the card.
      const a = document.activeElement;
      if ((!a || a === document.body || inside(a)) && before && before !== document.body && document.contains(before)) before.focus?.();
    };
  }, [r.call]);
  const title = callTitle(r);
  return html`<div class=${`incoming float${r.quiet ? ' quiet' : ''}`} role="alertdialog" aria-modal="false" aria-labelledby="inc-title" aria-describedby="inc-sub" ref=${ref} data-dm=${r.dm}>
    <div class="inc-who">
      <span class=${`inc-face${r.quiet ? '' : ' ringing'}`}><${Avatar} user=${caller} size=${64} /></span>
      <div class="inc-text">
        <h2 id="inc-title" class="inc-name trunc">${caller.name}</h2>
        <p id="inc-sub" class="inc-kind">
          <${Icon} name=${r.video ? 'camera' : 'phone'} size=${16} />${r.video ? 'Video call' : 'Voice call'}${r.group && meta ? html` <span class="faint">in ${meta.title}</span>` : ''}
        </p>
        ${r.quiet && html`<p class="inc-note">No ringtone: ${meta?.kind === 'group' ? 'this group' : 'this conversation'} is muted${S.users[S.me]?.presence === 'focus' ? ', or you’re Focused' : ''}.</p>`}
        ${busy && html`<p class="inc-note">${busy}</p>`}
      </div>
    </div>
    <div class="inc-acts">
      <button class="btn inc-decline" onClick=${() => declineCall(r.dm)} aria-keyshortcuts="Escape"><${Icon} name="phone-off" size=${18} />Decline</button>
      <button class="btn live inc-accept" onClick=${() => acceptCall(r.dm)} aria-keyshortcuts="Enter"><${Icon} name="phone" size=${18} />Accept</button>
      <button class="btn live-soft inc-video" onClick=${() => acceptCall(r.dm, { video: true })}><${Icon} name="camera" size=${18} />Accept with video</button>
    </div>
    <p class="inc-keys faint" aria-hidden="true"><kbd>Enter</kbd> accept <kbd>Esc</kbd> decline</p>
    <span class="sr">${title}</span>
  </div>`;
}

// Mounted once with the other floating layers. The live region is always
// there, so a new ring is announced the moment it arrives.
export function IncomingCall() {
  const r = incoming();
  return html`
    <div class="sr" role="status" aria-live=${r?.quiet ? 'polite' : 'assertive'} aria-atomic="true">${r ? `${callTitle(r)}. ${callBody(r)}.` : ''}</div>
    ${r && html`<${IncomingCard} key=${r.call} r=${r} />`}`;
}

// ---------- Call records in the conversation ----------
// Written by the server; a system line, not a message: no actions, no edits.

function recordText(m) {
  const c = m.call || {};
  const mine = m.author === S.me;
  const by = firstName(m.author);
  const kind = c.video ? 'Video call' : 'Call';
  const took = (c.joined || []).includes(S.me);
  // I declined a group call (which went on, or rang out, for the others):
  // history, not a missed call, so not violet and not for me.
  if (!mine && !took && (c.declined || []).includes(S.me) && c.outcome !== 'declined') {
    return { title: `Declined ${c.video ? 'video call' : 'call'}`, sub: `from ${by}${c.outcome === 'answered' ? ` · ${dur(c.dur)}` : ''}` };
  }
  if (c.outcome === 'answered') {
    if (!took && !mine) return { title: `Missed ${c.video ? 'video call' : 'call'}`, sub: `${by} started it · ${dur(c.dur)}`, missed: true };
    return { title: `${kind} · ${dur(c.dur)}`, sub: mine ? 'You started it' : `${by} started it` };
  }
  if (c.outcome === 'declined') {
    if (mine) return { title: `${kind} declined`, sub: `${nameList((c.declined || []).map(firstName))} declined` };
    return { title: `Declined ${c.video ? 'video call' : 'call'}`, sub: `from ${by}` };
  }
  if (mine) return { title: `${kind} · no answer`, sub: 'You started it' };
  return { title: `Missed ${c.video ? 'video call' : 'call'}`, sub: `from ${by}`, missed: true };
}

// "4m 12s", "38s", "1h 2m": the same as the server's text.
export function dur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${r}s` : `${r}s`;
}

export function CallLine({ conv, m }) {
  const t = recordText(m);
  const live = (S.voice[conv] || []).length > 0;
  const missed = t.missed;
  return html`<div class=${`callline${missed ? ' missed' : ''}`} role="note" data-id=${m.id} data-conv=${conv}>
    <span class="callline-ic" aria-hidden="true"><${Icon} name=${missed ? 'phone-missed' : m.call?.video ? 'camera' : 'phone'} size=${16} /></span>
    <span class="callline-text"><b>${t.title}</b> <span class="callline-sub">${t.sub}</span></span>
    <time class="callline-time" datetime=${new Date(m.ts).toISOString()} data-tip=${fmtFull(m.ts)}>${fmtTime(m.ts)}</time>
    ${missed && !live && S.call?.room !== conv && html`<button class="btn quiet callline-back" disabled=${!isOnline()} onClick=${() => startCall(conv, { video: !!m.call?.video })}>Call back</button>`}
  </div>`;
}
