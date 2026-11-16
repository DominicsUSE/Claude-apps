// The recovery key for password accounts on a Snug server (v0.12, server/recovery.js):
// "Forgot your password?" on the sign-in screen, making a key (from Home's reminder or
// Settings), and the Settings rows. The key is the shared format of js/lib/recovery.js;
// this page sends the server only the proof derived from it (deriveAuthKey), never the key.
//
// End-to-end encryption, when it ships, uses the same key for its backup
// (deriveBackupKey). It joins in through `recoveryHooks`: each hook is called
// with { kind: 'made' | 'used', raw } and may return fields to send along with
// the new key (the backup re-encrypted under it). Nothing here builds that backup.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, me, emit, toast, openModal, closeModal } from '../store.js';
import { api } from '../server.js';
import { Icon } from '../ui/icons.js';
import { newRecoveryKey, parseRecoveryKey, deriveAuthKey, deriveAuthKeyV2 } from '../lib/recovery.js';
import { RecoverySave } from './keyauth.js';

export const recoveryHooks = [];
const Err = ({ id, text }) => html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${16} /><span>${text}</span></div>`;
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// v0.12 review (second pass): the proof is bound to this page's host name; proof1 (no host) opens a key
// saved by 0.12.0 only.
const proofOf = async (raw) => b64u(await deriveAuthKeyV2(raw, location.hostname));
const proof1Of = async (raw) => b64u(await deriveAuthKey(raw));
const lastGroup = (text) => text.split('-').pop();
const sameGroup = (typed, text) => typed.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B') === lastGroup(text);
const WEB = {
  lead: 'If you forget your password, this key lets you set a new one. It works once, and Snug can’t reset it for you.',
  warn: 'Keep it somewhere safe: on paper, or in a password manager. Anyone who has it and your username can get into your account. Whoever runs this server can’t read it: Snug keeps only a scrambled check of it.',
  laterWarn: 'Without a recovery key, a forgotten password can only be reset by whoever runs this server. Home will remind you.',
};

async function hookFields(kind, raw) {
  const out = {};
  for (const h of recoveryHooks) { try { Object.assign(out, await h({ kind, raw }) || {}); } catch { /* a hook can't stop the key */ } }
  return out;
}
function adopt(recovery) {
  S.account ||= { prefs: {}, notes: {}, totp: false, backupLeft: 0 };
  S.account.recovery = recovery;
  emit();
}
// Save a new key: its proof, plus a password (and code) when the server asks for one.
async function saveKey(key, extra = {}) {
  const r = await api('/api/recovery/set', { verifier: await proofOf(key.raw), v: 2, ...await hookFields('made', key.raw), ...extra });
  adopt(r.recovery);
  return r;
}

/**
 * Make a recovery key: shown once, typed back, then saved. Right after signing up or
 * recovering, a first key is kept without asking; otherwise (a new sign-in, or replacing a
 * key) the server asks for the password (and a code) first.
 */
export function MakeRecoveryKey({ onDone = closeModal, onLater = null, replace = false }) {
  const [key, setKey] = useState(null);
  const [ask, setAsk] = useState(null); // null, or { message } when the password is needed
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { newRecoveryKey().then(setKey); }, []);
  if (!key) return html`<p class="faint" role="status">Making your key…</p>`;
  const confirm = async (last) => {
    if (!sameGroup(last, key.text)) throw new Error('That isn’t the last group of your key. Check what you saved.');
    try { await saveKey(key); } catch (e) {
      if (e.status === 401) { setAsk({ message: 'To keep this key, type your password.' }); throw new Error('Type your password to finish.'); }
      throw e;
    }
  };
  const finish = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await saveKey(key, { password, code: code.replace(/\s/g, '') });
      toast(replace ? 'Your new recovery key is saved. The old one no longer works.' : 'Your recovery key is saved.');
      onDone();
    } catch (x) { setAsk({ message: x.message, bad: true }); setBusy(false); }
  };
  if (ask) {
    return html`<form class="form" onSubmit=${finish} aria-labelledby="rk-pw-title">
      <h2 id="rk-pw-title">Confirm it’s you</h2>
      <p class="modal-lead">${ask.bad ? '' : ask.message} Your key is ready: it’s kept as soon as you confirm.</p>
      <div><label class="label" for="rk-pw">Password</label><input id="rk-pw" class="field" type="password" data-autofocus autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} /></div>
      ${S.account?.totp && html`<div><label class="label" for="rk-code">Code from your app, or a backup code</label><input id="rk-code" class="field" autocomplete="one-time-code" value=${code} onInput=${(e) => setCode(e.target.value)} /></div>`}
      ${ask.bad && html`<${Err} id="rk-pw-err" text=${ask.message} />`}
      <div class="modal-foot"><button type="button" class="btn" onClick=${closeModal}>Cancel</button><button type="submit" class="btn primary" id="rk-pw-go" disabled=${busy || !password}>${busy ? 'Saving…' : 'Save my key'}</button></div>
    </form>`;
  }
  return html`<${RecoverySave} code=${key.text} username=${me()?.handle || ''} titleId="rk-title" confirm=${confirm} onDone=${() => { toast(replace ? 'Your new recovery key is saved. The old one no longer works.' : 'Your recovery key is saved.'); onDone(); }}
    onLater=${onLater} lead=${replace ? `${WEB.lead} Your old key stops working once this one is saved.` : WEB.lead} warn=${WEB.warn} laterWarn=${WEB.laterWarn} />`;
}
export const openMakeRecoveryKey = (props = {}) => openModal(MakeRecoveryKey, { wide: true, ...props });

// Home's reminder for a password account with no key (it stays until one is made; "Later" hides it until the next visit).
let later = false;
export function RecoveryReminder() {
  const a = S.account;
  const [, redraw] = useState(0);
  if (!a?.passwordAccount || !a.recovery || a.recovery.set || later) return null;
  return html`<div class="rk-remind" role="region" aria-labelledby="rk-remind-title">
    <span class="row-ic"><${Icon} name="shield" /></span>
    <div class="grow">
      <b id="rk-remind-title">Save a recovery key</b>
      <span class="faint">If you ever forget your password, it lets you set a new one. No email needed.</span>
    </div>
    <button class="btn primary" id="rk-remind-go" onClick=${() => openMakeRecoveryKey()}>Make my key</button>
    <button class="btn quiet" id="rk-remind-later" onClick=${() => { later = true; redraw((n) => n + 1); }}>Later</button>
  </div>`;
}

// Settings > Account and security > Recovery key.
export function RecoveryRows({ Row }) {
  const r = S.account?.recovery;
  if (!S.account?.passwordAccount || !r) return null;
  return html`<div class="set-head">Recovery key</div>
    <${Row} label=${r.set ? 'Saved' : 'Not made yet'} hint=${r.set
      ? `Made ${new Date(r.created).toLocaleDateString()}. If you forget your password, it lets you set a new one; it works once. It also gets past two-factor sign-in, so keep it as safe as your password. Whoever runs this server can’t read it.`
      : 'A key you keep on paper or in a password manager. If you forget your password, it lets you set a new one, with no email.'}>
      <button class=${`btn${r.set ? '' : ' primary'}`} id="rk-settings" onClick=${() => openMakeRecoveryKey({ replace: r.set })}>${r.set ? 'Make a new one' : 'Make a recovery key'}</button>
    <//>`;
}

// ---------- "Forgot your password?" ----------
export function ForgotPassword({ onDone, onBack }) {
  // step: 'key' | { kind: 'password', ticket, totp, raw } | { kind: 'newkey', user, notes }
  const [step, setStep] = useState('key');
  const [handle, setHandle] = useState('');
  const [text, setText] = useState('');
  const [password, setPassword] = useState('');
  const [lostApp, setLostApp] = useState(false);
  const [err, setErr] = useState(null); // { field, text }
  const [busy, setBusy] = useState(false);
  const first = useRef();
  useEffect(() => { first.current?.focus(); }, [step]);

  const check = async (e) => {
    e.preventDefault();
    if (!handle.trim()) return setErr({ field: 'handle', text: 'Type your username.' });
    // The check characters catch a typo here, without asking the server.
    const parsed = await parseRecoveryKey(text);
    if (parsed.error) return setErr({ field: 'key', text: text.trim() ? parsed.message : 'Type your recovery key.' });
    setBusy(true); setErr(null);
    try {
      const r = await api('/api/recover', { handle: handle.trim(), proof: await proofOf(parsed.raw), proof1: await proof1Of(parsed.raw) });
      setStep({ kind: 'password', ticket: r.ticket, totp: r.totp, raw: parsed.raw });
    } catch (x) { setErr({ field: null, text: x.message }); }
    setBusy(false);
    return undefined;
  };
  const reset = async (e) => {
    e.preventDefault();
    if (password.length < 8) return setErr({ field: 'password', text: 'Passwords need at least 8 characters.' });
    setBusy(true); setErr(null);
    try {
      const r = await api('/api/recover/finish', { ticket: step.ticket, password, resetTwoFactor: !!(step.totp && lostApp) });
      await hookFields('used', step.raw); // e2ee: open the backup with the key still in memory
      const notes = ['Every other device was signed out.'];
      if (r.passkeysRemoved) notes.push('Your passkeys were removed; add yours again in Settings.');
      if (r.totpReset) notes.push('Two-factor sign-in is off. Turn it on again in Settings.');
      setStep({ kind: 'newkey', user: r.user, notes });
    } catch (x) {
      if (x.status === 401) { setStep('key'); setText(''); }
      setErr({ field: x.status === 400 ? 'password' : null, text: x.message });
    }
    setBusy(false);
    return undefined;
  };

  if (step.kind === 'newkey') {
    // Required: the old key is used up. The new one is kept without a password (a fresh sign-in).
    return html`<div class="rk-after">
      <p class="auth-fine" role="status" id="rk-recovered">Your new password is set. ${step.notes.join(' ')}</p>
      <${NewKeyAfterRecovery} user=${step.user} onDone=${() => onDone(step.user)} />
    </div>`;
  }
  if (step.kind === 'password') {
    return html`
      <div class="auth-head">
        <h1 id="auth-title">Set a new password</h1>
        <p class="auth-sub">This signs out every other device and removes your passkeys, in case someone else got in.</p>
      </div>
      <form class="form auth-form" onSubmit=${reset} novalidate aria-labelledby="auth-title" aria-busy=${busy ? 'true' : undefined}>
        <div class="auth-field">
          <label class="label" for="rk-new-pass">New password</label>
          <input id="rk-new-pass" ref=${first} class=${`field${err?.field === 'password' ? ' bad' : ''}`} type="password" autocomplete="new-password" maxlength="200" value=${password}
            aria-invalid=${err?.field === 'password' ? 'true' : undefined} aria-describedby="rk-new-pass-hint" onInput=${(e) => { setPassword(e.target.value); setErr(null); }} />
          ${err?.field === 'password' && html`<${Err} id="rk-new-pass-err" text=${err.text} />`}
          <div class="hint" id="rk-new-pass-hint">At least 8 characters, not one of the most common passwords.</div>
        </div>
        ${step.totp && html`<label class="acc-check rk-lost-app"><input type="checkbox" id="rk-lost-app" checked=${lostApp} onChange=${(e) => setLostApp(e.target.checked)} /><span>I lost my authenticator app too (turns off two-factor sign-in)</span></label>`}
        ${err && !err.field && html`<${Err} id="rk-form-err" text=${err.text} />`}
        <button class="btn primary auth-submit" type="submit" id="rk-set-pass" disabled=${busy}>${busy ? 'Saving…' : 'Set password and sign in'}</button>
      </form>`;
  }
  return html`
    <div class="auth-head">
      <h1 id="auth-title">Forgot your password?</h1>
      <p class="auth-sub">Use the recovery key you saved. It’s 36 letters and numbers, in 9 groups of 4.</p>
    </div>
    <form class="form auth-form" onSubmit=${check} novalidate aria-labelledby="auth-title" aria-busy=${busy ? 'true' : undefined}>
      <div class="auth-field">
        <label class="label" for="rk-handle">Username</label>
        <input id="rk-handle" ref=${first} class=${`field${err?.field === 'handle' ? ' bad' : ''}`} autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" value=${handle}
          aria-invalid=${err?.field === 'handle' ? 'true' : undefined} onInput=${(e) => { setHandle(e.target.value); setErr(null); }} />
        ${err?.field === 'handle' && html`<${Err} id="rk-handle-err" text=${err.text} />`}
      </div>
      <div class="auth-field">
        <label class="label" for="rk-key-in">Recovery key</label>
        <textarea id="rk-key-in" class=${`field rk-input${err?.field === 'key' ? ' bad' : ''}`} rows="2" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120" value=${text}
          aria-invalid=${err?.field === 'key' ? 'true' : undefined} aria-describedby="rk-key-hint" onInput=${(e) => { setText(e.target.value); setErr(null); }}></textarea>
        ${err?.field === 'key' && html`<${Err} id="rk-key-err" text=${err.text} />`}
        <div class="hint" id="rk-key-hint">Spaces, dashes and capitals don’t matter.</div>
      </div>
      ${err && !err.field && html`<${Err} id="rk-form-err" text=${err.text} />`}
      <button class="btn primary auth-submit" type="submit" id="rk-check" disabled=${busy}>${busy ? 'Checking…' : 'Continue'}</button>
    </form>
    <p class="auth-fine">No recovery key? Whoever runs this server can reset your password after checking it’s you.</p>
    <p class="auth-swap"><button type="button" class="auth-link" id="rk-back" onClick=${onBack}>Back to sign in</button></p>`;
}

function NewKeyAfterRecovery({ user, onDone }) {
  const [key, setKey] = useState(null);
  useEffect(() => { newRecoveryKey().then(setKey); }, []);
  if (!key) return html`<p class="faint" role="status">Making your new key…</p>`;
  return html`<${RecoverySave} code=${key.text} username=${user.handle}
    lead="Your old recovery key is used up. Save this new one: it’s how you get back in next time." warn=${WEB.warn}
    confirm=${async (last) => { if (!sameGroup(last, key.text)) throw new Error('That isn’t the last group of your key. Check what you saved.'); await saveKey(key); }}
    onDone=${onDone} />`;
}
