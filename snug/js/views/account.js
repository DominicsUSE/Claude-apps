// Account views: appearance, accessibility, notifications, streamer mode,
// security (password, two-factor, devices), your data, the custom status,
// profile extras (banner, accent, pronouns, rich About, private notes), the
// two-factor step at sign-in, the keyboard shortcuts sheet, quick switcher
// actions and the sidebar's resize grip. The rules live in js/lib/account.js
// and every check is repeated by server/account.js.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import {
  S, me, emit, setPref, updateMe, toast, openModal, closeModal, openLayer, closeLayer, signedOut, setNotify, setPresence,
  markConvRead, markAllRead, convMeta,
} from '../store.js';
import { api, call, stopTransport } from '../server.js';
import { leaveVoice } from '../voice.js';
import { pushSignOut } from '../push.js';
import { CLEAR_AFTER, endOfToday } from '../lib/account.js';
import { qrMatrix, qrPath } from '../lib/qr.js';
import { HUES, hueOf, fmtWhen, plural } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Seg, Switch, Tile, Rich } from '../ui/kit.js';
import { speak } from '../account.js';
import { MessagingSettings } from './messaging.js';
import { AppearancePage, ProfileStyle, SoundSettings, setSettingsLayer } from './appearance.js'; // customisation (js/views/appearance.js)
import { bindings, comboKeys, ACTIONS } from '../lib/keys.js'; // the person's shortcuts in the sheet
import { setLook } from '../account.js';
import { Confirm } from './modals.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';
let Row = ({ label, hint, children }) => html`<div class="set-row"><div class="set-label"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div><div class="set-ctl">${children}</div></div>`;
let baseSignOut = null;
let SettingsC = null;
const Err = ({ id, text }) => html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${16} /><span>${text}</span></div>`;
const acc = () => S.account || { prefs: {}, notes: {}, totp: false, backupLeft: 0 };

// ---------- Small pieces shared by profile views ----------

export const StatusEmoji = ({ u }) => (u?.statusEmoji ? html`<span class="status-emoji" aria-hidden="true">${u.statusEmoji}</span>` : null);

export function ProfileBanner({ u, big }) {
  const [broken, setBroken] = useState(false);
  const hue = u.accent != null ? hueOf(u.accent) : hueOf(u.hue);
  return html`<div class=${`acc-banner${big ? ' big' : ''}`} style=${`--hue:${hue}`} aria-hidden="true">
    ${u.banner && !broken && html`<img src=${`/api/banners/${u.banner}`} alt="" onError=${() => setBroken(true)} />`}
  </div>`;
}

export function AboutText({ u, cls = 'pcard-about' }) {
  if (!u.about) return null;
  return html`<div class=${`${cls} acc-about`}><${Rich} text=${u.about} /></div>`;
}

export const Pronouns = ({ u }) => (u.pronouns ? html`<span class="acc-pronouns">${u.pronouns}</span>` : null);

// A note only you can read, saved when you leave the field.
export function PrivateNote({ id }) {
  const saved = acc().notes?.[id] || '';
  const [text, setText] = useState(saved);
  const [state, setState] = useState('');
  useEffect(() => { setText(saved); }, [saved, id]);
  const save = async () => {
    if (text.trim() === saved) return;
    setState('saving');
    try {
      await call('note.set', { user: id, note: text });
      S.account ||= { prefs: {}, notes: {} };
      if (text.trim()) S.account.notes[id] = text.trim(); else delete S.account.notes[id];
      setState('saved');
      emit();
    } catch (e) { setState(''); toast(e.offline ? 'You’re offline, so the note wasn’t saved.' : e.message); }
  };
  return html`<div class="acc-note">
    <label class="pcard-k" for=${`note-${id}`}>Note <span class="faint">· only you see this</span></label>
    <textarea id=${`note-${id}`} class="field" rows="2" maxlength="256" placeholder="Add a note" value=${text}
      onInput=${(e) => { setText(e.target.value); setState(''); }} onBlur=${save}></textarea>
    ${state && html`<span class="hint" role="status">${state === 'saving' ? 'Saving…' : 'Saved'}</span>`}
  </div>`;
}

// ---------- Custom status ----------

const EMOJI_PICKS = ['💬', '🎧', '🏺', '🍵', '📚', '🎮', '🌙', '🤒', '✈️', '🔥'];
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;

export function CustomStatus() {
  const u = me();
  const [emoji, setEmoji] = useState(u.statusEmoji || '');
  const [text, setText] = useState(u.status || '');
  const [clear, setClear] = useState('today');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e, wipe) => {
    e?.preventDefault();
    if (!wipe && emoji && !EMOJI_RE.test(emoji)) return setErr('The picture can be one emoji.');
    setBusy(true);
    try {
      await call('status.set', wipe ? { text: '', emoji: null, clear: 'never' } : { text, emoji: emoji || null, clear, until: clear === 'today' ? endOfToday() : undefined });
      closeModal();
    } catch (x) { setErr(x.offline ? 'You’re offline. Try again once you’re back.' : x.message); setBusy(false); }
    return undefined;
  };
  return html`<form onSubmit=${save} class="acc-status" aria-labelledby="cs-title">
    <h2 id="cs-title">Set a status</h2>
    <p class="modal-lead">A line and an emoji next to your name, for everyone who can see you.</p>
    <div class="acc-status-in">
      <input class="field acc-emoji-in" aria-label="Status emoji" placeholder="🙂" maxlength="8" value=${emoji} onInput=${(e) => { setEmoji(e.target.value.trim()); setErr(''); }} />
      <input class="field grow" data-autofocus aria-label="Status" placeholder="What are you up to?" maxlength="80" value=${text}
        aria-invalid=${err ? 'true' : undefined} aria-describedby="cs-err" onInput=${(e) => { setText(e.target.value); setErr(''); }} />
    </div>
    <div class="acc-emoji-picks" role="group" aria-label="Quick emoji">
      ${EMOJI_PICKS.map((x) => html`<button type="button" key=${x} class="ib" aria-pressed=${String(emoji === x)} aria-label=${`Use ${x}`} onClick=${() => setEmoji(x)}>${x}</button>`)}
    </div>
    <label class="label" id="cs-clear">Clear after</label>
    <${Seg} label="Clear after" value=${clear} options=${CLEAR_AFTER} onChange=${setClear} />
    ${err && html`<${Err} id="cs-err" text=${err} />`}
    <div class="modal-foot">
      ${(u.status || u.statusEmoji) && html`<button type="button" class="btn quiet" disabled=${busy} onClick=${(e) => save(e, true)}>Clear status</button>`}
      <span class="grow"></span>
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" disabled=${busy || (!text.trim() && !emoji)}>${busy ? 'Saving…' : 'Save'}</button>
    </div>
  </form>`;
}
export const openCustomStatus = () => openModal(CustomStatus, { wide: true });

// ---------- Appearance ----------

// The page itself is js/views/appearance.js (themes, accent, chat display, fonts, live preview).
export const AccountLook = AppearancePage;

// ---------- Accessibility ----------

export function A11yPage() {
  const p = S.prefs;
  const tts = typeof speechSynthesis !== 'undefined';
  return html`
    <h1>Accessibility</h1>
    <p class="lead">Ways to make Snug easier to read and use. They follow you to every device.</p>
    <${Row} label="Font" hint="Atkinson Hyperlegible was drawn for low vision: letters that are easy to tell apart (I, l and 1; O and 0). Fonts are on the Appearance page.">
      <button class="btn" onClick=${() => SettingsC && openLayer({ C: SettingsC, props: { page: 'look' } })}>Choose a font</button>
    <//>
    <${Row} label="Underline links" hint="Every link and link-like button gets a clear underline.">
      <${Switch} on=${p.underlineLinks} label="Underline links" onChange=${(v) => setPref('underlineLinks', v)} />
    <//>
    <${Row} label="Contrast" hint="High makes secondary text, times and outlines darker and the focus ring thicker. Match device follows the system’s own setting.">
      <${Seg} label="Contrast" value=${p.contrast || 'system'} options=${[['system', 'Match device'], ['standard', 'Standard'], ['high', 'High']]} onChange=${(v) => setPref('contrast', v)} />
    <//>
    <${Row} label="Always show the focus ring" hint="Show where you are even after a click, not only when moving with the keyboard.">
      <${Switch} on=${p.focusAlways} label="Always show the focus ring" onChange=${(v) => setPref('focusAlways', v)} />
    <//>
    <${Row} label="Motion" hint="Panels slide and fade briefly. Reduced turns that off; Match device follows the system’s own setting.">
      <${Seg} label="Motion" value=${p.motion} options=${[['system', 'Match device'], ['reduced', 'Reduced']]} onChange=${(v) => setPref('motion', v)} />
    <//>
    <${Row} label="Read new messages aloud" hint=${tts ? 'In the conversation you have open, using your device’s voice. Off unless you turn it on.' : 'This browser can’t speak.'}>
      <div class="acc-inline">
        <button class="btn" disabled=${!tts} onClick=${() => speak('This is how messages will sound.')}>Try it</button>
        <${Switch} on=${p.tts && tts} label="Read new messages aloud" onChange=${(v) => setPref('tts', v)} />
      </div>
    <//>
    <${Row} label="Keyboard" hint=${`Everything in Snug works from the keyboard. ${MOD} / lists the shortcuts.`}>
      <button class="btn" onClick=${openShortcuts}>Keyboard shortcuts</button>
    <//>`;
}

// ---------- Notifications: the account's extra options ----------

function minutesToTime(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
function timeToMinutes(s) { const [h, m] = String(s).split(':').map(Number); return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null; }

function KeywordsEditor() {
  const list = S.prefs.keywords || [];
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const full = list.length >= 10;
  const add = () => {
    const v = text.replace(/\s+/g, ' ').trim();
    if (!v) return;
    if (v.length > 40) return setErr('Keep each word to 40 characters.');
    if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return setErr(`“${v}” is already there.`);
    if (full) return setErr('That’s 10, the most you can have.');
    setPref('keywords', [...list, v]);
    setText(''); setErr('');
    return undefined;
  };
  return html`<div class="ed-int">
    ${list.length > 0 && html`<ul class="ed-chips" aria-label="Your highlight words">
      ${list.map((w) => html`<li key=${w} class="ed-chip">${w}<button class="ed-chip-x" aria-label=${`Remove ${w}`} onClick=${() => setPref('keywords', list.filter((x) => x !== w))}><${Icon} name="x" size=${12} /></button></li>`)}
    </ul>`}
    <div class="ed-add">
      <input class="field" maxlength="40" value=${text} disabled=${full} placeholder=${full ? 'That’s the most you can have' : 'A word, then Enter'} aria-label="Add a highlight word"
        aria-invalid=${err ? 'true' : undefined} aria-describedby="kw-msg" onInput=${(e) => { setText(e.target.value); setErr(''); }}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      <button class="btn" disabled=${full || !text.trim()} onClick=${add}>Add</button>
    </div>
    <div id="kw-msg" class=${err ? 'err' : 'hint'} role=${err ? 'alert' : undefined}>${err || `${list.length} of 10`}</div>
  </div>`;
}

export function NotifyMore() {
  const p = S.prefs;
  const q = p.quiet || { on: false, from: 1320, to: 420, tz: 0 };
  // The named zone follows daylight saving; the offset is kept for older Snugs.
  const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
  const setQuiet = (patch) => setPref('quiet', { ...q, ...patch, tz: new Date().getTimezoneOffset(), ...(zone ? { zone } : {}) });
  const houses = S.houseOrder.map((id) => S.houses[id]).filter(Boolean);
  const toggleSet = (key, id, on) => {
    const next = { ...(p[key] || {}) };
    if (on) next[id] = true; else delete next[id];
    setPref(key, next);
  };
  return html`
    <div class="set-head">Sounds and previews</div>
    <${SoundSettings} Row=${Row} />
    <${Row} label="Show message text" hint="In desktop notifications and pop-ups. Off says only who wrote and where.">
      <${Switch} on=${p.preview !== false} label="Show message text in notifications" onChange=${(v) => setPref('preview', v)} />
    <//>
    <div class="set-head">Quiet hours</div>
    <${Row} label="Quiet hours" hint="No sounds, pop-ups or phone notifications between these times, every day. Everything still collects in Catch up.">
      <${Switch} on=${q.on} label="Quiet hours" onChange=${(v) => setQuiet({ on: v })} />
    <//>
    <${Row} label="From and until" hint="In your own time zone.">
      <div class="acc-inline">
        <input class="field acc-time" type="time" aria-label="Quiet from" value=${minutesToTime(q.from)} disabled=${!q.on} onChange=${(e) => { const m = timeToMinutes(e.target.value); if (m != null) setQuiet({ from: m }); }} />
        <span class="faint">to</span>
        <input class="field acc-time" type="time" aria-label="Quiet until" value=${minutesToTime(q.to)} disabled=${!q.on} onChange=${(e) => { const m = timeToMinutes(e.target.value); if (m != null) setQuiet({ to: m }); }} />
      </div>
    <//>
    <${Row} label="Calls from favourites" hint="While you’re Focused, calls from friends you starred still ring out loud.">
      <${Switch} on=${p.favCalls} label="Let calls from favourites ring while Focused" onChange=${(v) => setPref('favCalls', v)} />
    <//>
    <div class="set-head">Highlight words</div>
    <${Row} label="Your words" hint="Messages with one of these (whole words, any case) count as mentions: a badge, Catch up and a notification." top>
      <${KeywordsEditor} />
    <//>
    <div class="set-head">Away</div>
    <${Row} label="Go idle after" hint="With no keyboard or mouse for this long, people see you as Away until you’re back. Focused and Offline don’t change.">
      <${Seg} label="Go idle after" value=${p.autoIdle} options=${[[0, 'Never'], [5, '5 min'], [10, '10 min'], [30, '30 min'], [60, '1 hour']]} onChange=${(v) => setPref('autoIdle', v)} />
    <//>
    ${houses.length > 0 && html`<div class="set-head">Each house</div>
      ${houses.map((h) => html`<div key=${h.id} class="acc-house">
        <span class="acc-house-name"><${Tile} house=${h} />${h.name}</span>
        <label class="acc-check"><${Switch} on=${!p.everyoneOff?.[h.id]} label=${`@everyone and @here in ${h.name} count as mentions`} onChange=${(v) => toggleSet('everyoneOff', h.id, !v)} /><span>@everyone and @here</span></label>
        <label class="acc-check"><${Switch} on=${!p.mutedSounds?.[h.id]} label=${`Sounds for ${h.name}`} onChange=${(v) => toggleSet('mutedSounds', h.id, !v)} /><span>Sounds</span></label>
      </div>`)}`}`;
}

// ---------- Streamer mode ----------

export function StreamerPage() {
  const p = S.prefs;
  return html`
    <h1>Streamer mode</h1>
    <p class="lead">For sharing your screen or streaming: Snug hides what could identify you or let strangers in.</p>
    <${Row} label="Streamer mode" hint=${`Hides usernames, invitation links and codes, two-factor secrets and the text of notifications. ${MOD} Shift S turns it on and off from anywhere.`}>
      <${Switch} on=${p.streamer} label="Streamer mode" onChange=${(v) => setPref('streamer', v)} />
    <//>
    ${p.streamer && html`<p class="acc-banner-note" role="status"><${Icon} name="eye" size=${16} />Streamer mode is on. Names stay; @usernames and codes are blurred.</p>`}`;
}
export function toggleStreamer() {
  setPref('streamer', !S.prefs.streamer);
  toast(S.prefs.streamer ? 'Streamer mode on. Usernames, codes and notification text are hidden.' : 'Streamer mode off.');
}

// ---------- Security ----------

function PasswordForm() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState(null);
  const need = acc().totp;
  const submit = async (e) => {
    e.preventDefault();
    if (next.length < 8) return setMsg({ bad: true, text: 'Passwords need at least 8 characters.' });
    try {
      await api('/api/password', { current: cur, next, code });
      setCur(''); setNext(''); setCode('');
      setMsg({ text: 'Password changed. Every other device has been signed out.' });
    } catch (err) { setMsg({ bad: true, text: err.message }); }
    return undefined;
  };
  return html`<form class="form" style="max-width:320px" onSubmit=${submit} novalidate>
    <div><label class="label" for="pw-cur">Current password</label><input id="pw-cur" class="field" type="password" autocomplete="current-password" value=${cur} onInput=${(e) => setCur(e.target.value)} /></div>
    <div><label class="label" for="pw-next">New password</label><input id="pw-next" class="field" type="password" autocomplete="new-password" value=${next} onInput=${(e) => setNext(e.target.value)} /><div class="hint">At least 8 characters. Every other device will need it.</div></div>
    ${need && html`<div><label class="label" for="pw-code">Code from your app</label><input id="pw-code" class="field" inputmode="numeric" autocomplete="one-time-code" value=${code} onInput=${(e) => setCode(e.target.value)} /></div>`}
    ${msg && html`<div class=${msg.bad ? 'err' : 'hint'} role=${msg.bad ? 'alert' : 'status'}>${msg.text}</div>`}
    <div><button class="btn" type="submit" disabled=${!cur || !next || (need && !code)}>Change password</button></div>
  </form>`;
}

export function QrCode({ text, label }) {
  const q = qrMatrix(text);
  const { d, size } = qrPath(q);
  return html`<svg class="acc-qr" viewBox=${`0 0 ${size} ${size}`} role="img" aria-label=${label} shape-rendering="crispEdges">
    <rect width=${size} height=${size} fill="#fff" /><path d=${d} fill="#000" />
  </svg>`;
}

function BackupCodes({ codes }) {
  const text = `Snug backup codes for @${me().handle}\nEach works once.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `snug-backup-codes-${me().handle}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return html`<div class="acc-codes">
    <ul class="acc-code-list secret" aria-label="Backup codes">${codes.map((c) => html`<li key=${c}><code>${c}</code></li>`)}</ul>
    <div class="acc-inline">
      <button type="button" class="btn" onClick=${download}><${Icon} name="file" size=${16} />Download</button>
      <button type="button" class="btn" onClick=${() => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy. Select them instead.'))}><${Icon} name="copy" size=${16} />Copy</button>
    </div>
  </div>`;
}

function TotpSetup() {
  const [step, setStep] = useState('loading');
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [codes, setCodes] = useState(null);
  useEffect(() => {
    call('totp.begin').then((r) => { setSecret(r); setStep('scan'); }, (e) => { setErr(e.message); setStep('error'); });
  }, []);
  const enable = async (e) => {
    e.preventDefault();
    try {
      const r = await call('totp.enable', { code: code.replace(/\s/g, ''), password });
      S.account.totp = true; S.account.backupLeft = r.codes.length;
      setCodes(r.codes); setStep('codes'); emit();
    } catch (x) { setErr(x.message); }
  };
  if (step === 'loading') return html`<h2>Two-factor sign-in</h2><p class="modal-lead" role="status">Making a secret for you…</p>`;
  if (step === 'error') return html`<h2>Two-factor sign-in</h2><${Err} id="tf-err" text=${err} /><div class="modal-foot"><button class="btn" onClick=${closeModal}>Close</button></div>`;
  if (step === 'codes') {
    return html`<h2>Two-factor sign-in is on</h2>
      <p class="modal-lead">Keep these backup codes somewhere safe. Each one signs you in once if you don’t have your phone. They won’t be shown again.</p>
      <${BackupCodes} codes=${codes} />
      <div class="modal-foot"><button class="btn primary" data-autofocus onClick=${closeModal}>I’ve saved them</button></div>`;
  }
  return html`<form onSubmit=${enable} aria-labelledby="tf-title">
    <h2 id="tf-title">Set up two-factor sign-in</h2>
    <p class="modal-lead">Scan this with an authenticator app (any app that does TOTP codes), then type the 6-digit code it shows.</p>
    <div class="acc-qr-wrap">
      <${QrCode} text=${secret.uri} label="QR code with your two-factor secret" />
      <div class="acc-secret">
        <span class="label">Or type this key</span>
        <code class="secret">${secret.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      </div>
    </div>
    <div class="form">
      <div><label class="label" for="tf-code">Code from your app</label>
      <input id="tf-code" class="field" data-autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="7" value=${code}
        aria-invalid=${err ? 'true' : undefined} aria-describedby="tf-err" onInput=${(e) => { setCode(e.target.value); setErr(''); }} /></div>
      <div><label class="label" for="tf-pw">Your password</label>
      <input id="tf-pw" class="field" type="password" autocomplete="current-password" value=${password}
        aria-invalid=${err ? 'true' : undefined} aria-describedby="tf-err" onInput=${(e) => { setPassword(e.target.value); setErr(''); }} /></div>
      ${err && html`<${Err} id="tf-err" text=${err} />`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" disabled=${code.replace(/\s/g, '').length !== 6 || !password}>Turn on</button>
    </div>
  </form>`;
}

// Password (and a code) before something that matters.
function Confirmed({ title, lead, action, danger, needCode, needHandle, run }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [handle, setHandle] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { const r = await run({ password, code, confirm: handle }); if (r) setResult(r); else closeModal(); } catch (x) { setErr(x.message); setBusy(false); }
  };
  if (result) return result;
  return html`<form onSubmit=${submit}>
    <h2>${title}</h2>
    <p class="modal-lead">${lead}</p>
    <div class="form">
      <div><label class="label" for="cf-pw">Password</label><input id="cf-pw" class="field" type="password" data-autofocus autocomplete="current-password" value=${password} onInput=${(e) => { setPassword(e.target.value); setErr(''); }} /></div>
      ${needHandle && html`<div><label class="label" for="cf-handle">Type your username, <b class="secret">${me().handle}</b>, to confirm</label><input id="cf-handle" class="field" autocapitalize="none" spellcheck="false" value=${handle} onInput=${(e) => { setHandle(e.target.value); setErr(''); }} /></div>`}
      ${needCode && html`<div><label class="label" for="cf-code">Code from your app, or a backup code</label><input id="cf-code" class="field" autocomplete="one-time-code" value=${code} onInput=${(e) => { setCode(e.target.value); setErr(''); }} /></div>`}
      ${err && html`<${Err} id="cf-err" text=${err} />`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class=${`btn ${danger ? 'danger' : 'primary'}`} disabled=${busy || !password || (needCode && !code) || (needHandle && !handle)}>${busy ? 'Working…' : action}</button>
    </div>
  </form>`;
}

function Sessions() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const load = () => call('sessions.list').then((r) => setList(r.sessions), (e) => setErr(e.offline ? 'You’re offline. Your devices show once you’re back.' : e.message));
  useEffect(() => { load(); }, []);
  const revoke = async (id) => { try { await call('sessions.revoke', { id }); toast('That device is signed out.'); load(); } catch (e) { toast(e.message); } };
  const others = async () => { try { const r = await call('sessions.revokeOthers'); toast(r.ended ? `${plural(r.ended, 'other device')} signed out.` : 'No other devices were signed in.'); load(); } catch (e) { toast(e.message); } };
  if (err) return html`<p class="err" role="alert">${err}</p>`;
  if (!list) return html`<p class="faint" role="status">Loading your devices…</p>`;
  return html`<ul class="acc-sessions" aria-label="Signed-in devices">
    ${list.map((s) => html`<li key=${s.id} class="acc-session">
      <span class="row-ic"><${Icon} name=${/Android|iPhone/.test(s.agent) ? 'phone' : 'screen'} /></span>
      <span class="grow"><b>${s.agent}</b><span class="faint">${s.current ? 'This device' : `Last used ${fmtWhen(s.seen)}`} · signed in ${fmtWhen(s.created)}</span></span>
      ${s.current ? html`<span class="acc-tag">This device</span>` : html`<button class="btn" aria-label=${`Sign out ${s.agent}`} onClick=${() => revoke(s.id)}>Sign out</button>`}
    </li>`)}
  </ul>
  ${list.length > 1 && html`<div class="acc-row-end"><button class="btn danger" onClick=${others}>Sign out all other devices</button></div>`}`;
}

export function SecurityPage() {
  const u = me();
  const a = acc();
  return html`
    <h1>Account and security</h1>
    <p class="lead">Signed in as <b style="font-weight:500">${u.name}</b> (<span class="secret">@${u.handle}</span>).</p>
    <${Row} label="Connection" hint=${S.conn.socket === 'open' ? 'Connected. Changes reach everyone at once.' : 'Not connected. Changes wait until Snug is back.'}>
      <span class="sub" style="display:flex;gap:8px;align-items:center"><i class=${`pres inline ${S.conn.socket === 'open' ? 'open' : 'offline'}`}></i>${S.conn.socket === 'open' ? 'Online' : 'Offline'}</span>
    <//>
    <div class="set-head">Password</div>
    <div style="padding:16px 0"><${PasswordForm} /></div>
    <div class="set-head">Two-factor sign-in</div>
    ${a.totp
      ? html`<${Row} label="On" hint=${`Signing in needs a code from your authenticator app. ${plural(a.backupLeft, 'backup code')} left.`}>
          <div class="acc-inline">
            <button class="btn" onClick=${() => openModal(Confirmed, {
              title: 'New backup codes', lead: 'Your old backup codes stop working.', action: 'Make new codes', needCode: true,
              run: async ({ password, code }) => { const r = await call('totp.codes', { password, code }); return html`<h2>New backup codes</h2><p class="modal-lead">Each works once. They won’t be shown again.</p><${BackupCodes} codes=${r.codes} /><div class="modal-foot"><button class="btn primary" onClick=${closeModal}>Done</button></div>`; },
            })}>New backup codes</button>
            <button class="btn danger" onClick=${() => openModal(Confirmed, {
              title: 'Turn off two-factor sign-in?', lead: 'Your password alone will sign you in again.', action: 'Turn off', danger: true, needCode: true,
              run: ({ password, code }) => call('totp.disable', { password, code }).then(() => { S.account.totp = false; emit(); toast('Two-factor sign-in is off.'); }),
            })}>Turn off</button>
          </div>
        <//>`
      : html`<${Row} label="Off" hint="Ask for a code from your phone as well as your password when you sign in.">
          <button class="btn primary" onClick=${() => openModal(TotpSetup)}>Set up</button>
        <//>`}
    <div class="set-head">Devices</div>
    <${Sessions} />
    <div class="set-head">Sign out</div>
    <${Row} label="Sign out on this device" hint="Your houses and messages stay on the server.">
      <button class="btn" onClick=${() => baseSignOut?.(false)}>Sign out</button>
    <//>
    <${Row} label="Sign out everywhere" hint="Ends every session on every device, including this one.">
      <button class="btn danger" onClick=${() => openModal(Confirm, {
        title: 'Sign out everywhere?', text: 'Every device signed in as you will need your password again.', action: 'Sign out everywhere', danger: true,
        onConfirm: () => baseSignOut?.(true),
      })}>Sign out everywhere</button>
    <//>`;
}

// ---------- Your data ----------

async function leaveLocally() {
  leaveVoice();
  await pushSignOut().catch(() => {});
  stopTransport();
  closeModal();
  closeLayer();
  signedOut();
}

export function DataPage() {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/account/export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'That didn’t work. Try again.');
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'snug-export.json';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Your data is downloading.');
    } catch (e) { toast(e.message); }
    setBusy(false);
  };
  const needCode = acc().totp;
  return html`
    <h1>Your data</h1>
    <p class="lead">What Snug keeps about you, and how to take it with you or end it.</p>
    <${Row} label="Download your data" hint="One JSON file: your profile, settings, notes, friends, houses, conversations, devices and every message you wrote. Three times an hour.">
      <button class="btn" disabled=${busy} onClick=${download}><${Icon} name="file" size=${16} />${busy ? 'Preparing…' : 'Download'}</button>
    <//>
    <div class="set-head">End your account</div>
    <${Row} label="Deactivate" hint="Signs you out everywhere and shows you as offline. Sign in again any time to come back as you were.">
      <button class="btn" onClick=${() => openModal(Confirmed, {
        title: 'Deactivate your account?', lead: 'You’ll be signed out on every device. Signing in again brings everything back.', action: 'Deactivate', needCode,
        run: async (d) => { await api('/api/account/deactivate', d); await leaveLocally(); },
      })}>Deactivate</button>
    <//>
    <${Row} label="Delete your account" hint="For good. Your messages stay where you wrote them, by “Deleted user”. If you own a house with other people in it, hand it over first.">
      <button class="btn danger" onClick=${() => openModal(Confirmed, {
        title: 'Delete your account?', lead: 'This can’t be undone. Your profile, settings, friends and houses go; your messages stay, by “Deleted user”.', action: 'Delete my account', danger: true, needCode, needHandle: true,
        run: async (d) => { await api('/api/account/delete', d); await leaveLocally(); },
      })}>Delete account</button>
    <//>`;
}

// ---------- Profile extras ----------

export function ProfileMore() {
  const u = me();
  const [busy, setBusy] = useState(false);
  const file = useRef();
  const upload = async (f) => {
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('Banners can be up to 2 MB.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/files?banner=1', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'That picture didn’t upload.');
      updateMe({ banner: d.id });
    } catch (e) { toast(e.message); }
    setBusy(false);
  };
  return html`
    <${ProfileStyle} Row=${Row} />
    <div class="set-head">More about you</div>
    <${Row} label="Pronouns" hint="Shown next to your name on your profile.">
      <input class="field" style="width:260px" maxlength="40" placeholder="they/them" aria-label="Pronouns" value=${u.pronouns || ''} onChange=${(e) => updateMe({ pronouns: e.target.value.trim() })} />
    <//>
    <${Row} label="Accent" hint="The colour across the top of your profile when there’s no banner and no profile colours (above). Every choice stays readable in every theme." top>
      <div class="swatches" role="radiogroup" aria-label="Profile accent">
        <button class="swatch none" role="radio" aria-checked=${String(u.accent == null)} aria-label="Same as your picture" onClick=${() => updateMe({ accent: null })}></button>
        ${HUES.map(([v, name]) => html`<button key=${v} class="swatch" role="radio" style=${`--hue:${v}`} aria-checked=${String(u.accent != null && hueOf(u.accent) === v)} aria-label=${name} onClick=${() => updateMe({ accent: v })}></button>`)}
      </div>
    <//>
    <${Row} label="Banner" hint="A picture across the top of your profile. PNG, JPEG, GIF or WebP, up to 2 MB. Only people who can see you can load it." top>
      <div class="acc-banner-edit">
        <${ProfileBanner} u=${u} />
        <div class="acc-inline">
          <input ref=${file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange=${(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
          <button class="btn" disabled=${busy} onClick=${() => file.current.click()}>${busy ? 'Uploading…' : u.banner ? 'Change' : 'Upload'}</button>
          ${u.banner && html`<button class="btn quiet" onClick=${() => updateMe({ banner: null })}>Remove</button>`}
        </div>
      </div>
    <//>
    <${Row} label="About, as people see it" hint="Bold, italic, links and the rest of message formatting work here." top>
      <div class="acc-about-preview">${u.about ? html`<${Rich} text=${u.about} />` : html`<span class="faint">Nothing yet.</span>`}</div>
    <//>
    <${Row} label="Status" hint=${u.status || u.statusEmoji ? `${u.statusEmoji || ''} ${u.status}${u.statusUntil ? ` · clears ${fmtWhen(u.statusUntil)}` : ''}` : 'An emoji and a line that can clear by itself.'}>
      <button class="btn" onClick=${openCustomStatus}>${u.status || u.statusEmoji ? 'Change status' : 'Set a status'}</button>
    <//>`;
}

// ---------- Sign-in: the second step ----------

export function TotpStep({ ticket, onDone, onBack }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return setErr(backup ? 'Type one of your backup codes.' : 'Type the 6-digit code from your app.');
    setBusy(true);
    try { const r = await api('/api/login/totp', { ticket, code: code.trim() }); onDone(r.user); } catch (x) { setErr(x.message); setBusy(false); }
    return undefined;
  };
  return html`<form class="form auth-form" onSubmit=${submit} novalidate aria-labelledby="auth-2fa-title" aria-busy=${busy ? 'true' : undefined}>
    <h2 id="auth-2fa-title" class="auth-step-title">Two-factor sign-in</h2>
    <p class="hint">${backup ? 'Type one of the backup codes you saved. Each works once.' : 'Open your authenticator app and type the code it shows for Snug.'}</p>
    <div class="auth-field">
      <label class="label" for="auth-code">${backup ? 'Backup code' : 'Code'}</label>
      <input id="auth-code" class=${`field${err ? ' bad' : ''}`} autofocus inputmode=${backup ? 'text' : 'numeric'} autocomplete="one-time-code" maxlength=${backup ? 12 : 7} value=${code}
        aria-invalid=${err ? 'true' : undefined} aria-describedby=${err ? 'auth-code-err' : undefined} onInput=${(e) => { setCode(e.target.value); setErr(''); }} />
      ${err && html`<${Err} id="auth-code-err" text=${err} />`}
    </div>
    <button class="btn primary auth-submit" type="submit" disabled=${busy}>${busy ? 'Checking…' : 'Sign in'}</button>
    <p class="auth-swap">
      <button type="button" class="auth-link" onClick=${() => { setBackup(!backup); setCode(''); setErr(''); }}>${backup ? 'Use a code from your app' : 'Use a backup code'}</button>
      · <button type="button" class="auth-link" onClick=${onBack}>Start again</button>
    </p>
  </form>`;
}

// ---------- Keyboard shortcuts sheet ----------

const SHEET = [
  ['Getting around', [
    [[MOD, 'K'], 'Jump to a house, room, conversation or person; actions too'],
    [[MOD, '/'], 'This list'],
    [[MOD, 'Shift', 'F'], 'Search messages'],
    [['Alt', '↑'], 'Previous place in the column'], [['Alt', '↓'], 'Next place in the column'],
    [['Alt', 'Shift', '↓'], 'Next conversation with something new'],
    [isMac ? ['⌘', '['] : ['Alt', '←'], 'Back to where you were'],
    [['Esc'], 'Close the top layer; with nothing open, mark this place read'],
    [['Shift', 'Esc'], 'Mark this whole house read'],
    [[MOD, 'Shift', 'S'], 'Streamer mode on or off'],
  ]],
  ['Messages', [
    [['↑'], 'In an empty message box: edit your last message'],
    [['Shift', 'Tab'], 'From the message box: up into the messages'],
    [['↑', '↓'], 'Move between messages'], [['R'], 'Reply'], [['T'], 'Open or start a thread'],
    [['S'], 'Save'], [['E'], 'Edit your message'], [['Enter'], 'All actions on a message'],
  ]],
  ['Writing', [
    [[MOD, 'B'], 'Bold'], [[MOD, 'I'], 'Italic'], [[MOD, 'U'], 'Underline'], [[MOD, 'E'], 'Code'], [[MOD, 'K'], 'Link (with text selected)'],
    [[MOD, 'Shift', 'X'], 'Strikethrough'],
  ]],
];
// The sheet shows the person's own bindings (Settings > Keyboard) first.
function sheet() {
  const b = bindings(S.prefs.keys);
  const mine = [...new Set(ACTIONS.map((a) => a.group))].map((g) => [g, ACTIONS.filter((a) => a.group === g && b[a.id]).map((a) => [comboKeys(b[a.id], isMac), a.label])]);
  return [...mine, ...SHEET.filter(([head]) => head !== 'Getting around'), ['Also', SHEET[0][1].filter(([, what]) => /Back to|Esc|close/i.test(what) || what.startsWith('Close'))]];
}
export function ShortcutsSheet() {
  return html`<h2 id="ks-title">Keyboard shortcuts</h2>
    <div class="acc-keys" aria-labelledby="ks-title">
      ${sheet().filter(([, rows]) => rows.length).map(([head, rows]) => html`<section key=${head}><h3>${head}</h3><dl>
        ${rows.map(([keys, what]) => html`<div class="acc-key-row"><dt>${keys.map((k) => html`<kbd class="kbd">${k}</kbd>`)}</dt><dd>${what}</dd></div>`)}
      </dl></section>`)}
    </div>
    <div class="modal-foot"><button class="btn" data-autofocus onClick=${closeModal}>Close</button></div>`;
}
export const openShortcuts = () => openModal(ShortcutsSheet, { wide: true });

// ---------- Quick switcher actions ----------

const here = () => (S.ui.view.type === 'conv' ? S.ui.view.id : null);
export const ACCOUNT_ACTIONS = [
  { label: 'Mute this place', icon: 'bell-off', words: 'mute silence quiet room conversation nothing', run: () => {
    const c = here(); const m = c && convMeta(c);
    if (!m) return toast('Open a room or conversation first.');
    if (m.kind === 'thread') return toast('Threads follow their room. Mute the room instead.');
    setNotify(S.rooms[c] ? 'room' : 'dm', c, 'muted');
    return toast(`${m.title} muted.`);
  } },
  { label: 'Mark this place read', icon: 'check', words: 'mark read seen clear unread', run: () => (here() ? markConvRead(here()) : toast('Open a room or conversation first.')) },
  { label: 'Mark everything read', icon: 'tray', words: 'mark all read everything clear', run: () => markAllRead() },
  { label: 'Switch to midnight theme', icon: 'eye', words: 'midnight black oled theme dark', run: () => setLook('theme', 'midnight') },
  { label: 'Match the device’s theme', icon: 'eye', words: 'system device auto theme', run: () => setLook('theme', 'system') },
  { label: 'Toggle theme', icon: 'eye', words: 'toggle theme switch dark light', run: () => setLook('theme', (S.prefs.theme === 'light' || (S.prefs.theme === 'system' && !matchMedia('(prefers-color-scheme: dark)').matches)) ? 'dark' : 'light') },
  { label: 'Set presence to Around', icon: 'user', words: 'around available online present', run: () => setPresence('around') },
  { label: 'Set presence to Away', icon: 'clock', words: 'away idle afk', run: () => setPresence('away') },
  { label: 'Go invisible', icon: 'eye', words: 'invisible offline hide appear offline', run: () => setPresence('offline') },
  { label: 'Set a status', icon: 'smile', words: 'status custom emoji mood', run: openCustomStatus },
  { label: 'Clear your status', icon: 'x', words: 'clear status remove', run: () => call('status.set', { text: '', emoji: null, clear: 'never' }).catch((e) => toast(e.message)) },
  { label: 'Streamer mode on or off', icon: 'screen', words: 'streamer stream hide private screen share', run: toggleStreamer },
  { label: 'Keyboard shortcuts', icon: 'keys', words: 'keyboard shortcuts keys hotkeys help', run: openShortcuts },
  { label: 'Appearance settings', icon: 'eye', words: 'appearance theme font size zoom compact density', run: () => SettingsC && openLayer({ C: SettingsC, props: { page: 'look' } }) },
  { label: 'Accessibility settings', icon: 'eye', words: 'accessibility dyslexia font contrast focus speech read aloud', run: () => SettingsC && openLayer({ C: SettingsC, props: { page: 'a11y' } }) },
  { label: 'Security settings', icon: 'shield', words: 'security password two factor 2fa devices sessions', run: () => SettingsC && openLayer({ C: SettingsC, props: { page: 'account' } }) },
];

// ---------- The sidebar's resize grip ----------

export function SidebarGrip() {
  const [drag, setDrag] = useState(null);
  const w = S.prefs.sidebarW || 264;
  const clamp = (v) => Math.max(200, Math.min(420, Math.round(v / 4) * 4));
  const down = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x: e.clientX, w });
  };
  const move = (e) => {
    if (!drag) return;
    document.documentElement.style.setProperty('--ctx-w', `${clamp(drag.w + e.clientX - drag.x)}px`);
  };
  const up = (e) => {
    if (!drag) return;
    const next = clamp(drag.w + e.clientX - drag.x);
    setDrag(null);
    setLook('sidebarW', next);
  };
  const key = (e) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setLook('sidebarW', clamp(w - step)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setLook('sidebarW', clamp(w + step)); }
    if (e.key === 'Home') { e.preventDefault(); setLook('sidebarW', 264); }
  };
  return html`<div class=${`ctx-grip${drag ? ' dragging' : ''}`} role="separator" aria-orientation="vertical" aria-label="Sidebar width"
    aria-valuemin="200" aria-valuemax="420" aria-valuenow=${w} tabindex="0" data-tip="Drag to resize"
    onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onKeyDown=${key} onDblClick=${() => setLook('sidebarW', 264)}></div>`;
}

// ---------- Registration (called once by js/views/settings.js) ----------

export function registerAccountPages({ PAGES, VIEWS, Row: R, signOut, Settings }) {
  if (R) Row = R;
  baseSignOut = signOut;
  SettingsC = Settings;
  const at = (id) => PAGES.findIndex((p) => p.id === id);
  // Appearance gets the full set; Accessibility and Streamer mode follow it.
  VIEWS.look = AppearancePage; // js/views/appearance.js
  setSettingsLayer(Settings);
  const look = PAGES[at('look')];
  if (look) look.words = `${look.words} midnight black oled tone accent zoom font scale line height saturation 24 hour clock role colours sidebar width compact cozy ash slate moss paper sepia custom theme builder import export preview emoji gif reactions spoilers serif mono code font background pattern device`;
  PAGES.splice(at('look') + 1, 0,
    { id: 'a11y', label: 'Accessibility', icon: 'eye', words: 'accessibility dyslexia dyslexic font hyperlegible underline links contrast focus ring motion speech read aloud tts screen reader keyboard' },
    { id: 'streamer', label: 'Streamer mode', icon: 'screen', words: 'streamer stream hide handles invite codes privacy screen share' });
  VIEWS.a11y = A11yPage;
  VIEWS.streamer = StreamerPage;
  // Notifications: the original page, then sounds, previews, quiet hours, words and each house.
  const BaseNotify = VIEWS.notify;
  VIEWS.notify = () => html`<${BaseNotify} /><${NotifyMore} />`;
  const notify = PAGES[at('notify')];
  if (notify) notify.words = `${notify.words} sound sounds pack volume preview quiet hours schedule keywords highlight words everyone here idle away`;
  // Profile: the original page, then pronouns, accent, banner, status.
  const BaseProfile = VIEWS.profile;
  VIEWS.profile = () => html`<${BaseProfile} /><${ProfileMore} />`;
  const prof = PAGES[at('profile')];
  if (prof) prof.words = `${prof.words} pronouns banner accent status picture photo upload avatar decoration name style profile colours`;
  // Account becomes Account and security; Your data after it.
  VIEWS.account = SecurityPage;
  const account = PAGES[at('account')];
  if (account) { account.label = 'Account and security'; account.words = `${account.words} two factor 2fa authenticator totp backup codes devices sessions`; }
  PAGES.splice(at('account') + 1, 0, { id: 'data', label: 'Your data', icon: 'file', words: 'data export download delete deactivate close account gdpr' });
  VIEWS.data = DataPage;
}
