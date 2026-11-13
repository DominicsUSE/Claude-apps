// Signing in and creating an account, and the splash while Snug opens.
// The brand speaks once here: the lockup and one line, then a small form
// that gets out of the way. Errors sit under the field they are about.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, emit, loadCache } from '../store.js';
import { api, startTransport } from '../server.js';
import { Icon } from '../ui/icons.js';
import { Lockup, Loading } from '../ui/brand.js';

import { TotpStep } from './account.js'; // two-factor sign-in, the second step
import { Tile } from '../ui/kit.js'; // the house's icon in its arch (server/community.js)

function entered(user) {
  S.me = user.id;
  S.auth = 'in';
  loadCache(user.id);
  emit();
  startTransport();
}

const Err = ({ id, text }) => html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${16} /><span>${text}</span></div>`;

export function Auth() {
  const [mode, setMode] = useState(S.ui.joinCode ? 'new' : 'in');
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  // { field: 'handle' | 'name' | 'password' | null, text }. null field = about the whole form.
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(null);
  const [ticket, setTicket] = useState(null); // two-factor sign-in: the password was right, a code is next
  const refs = { handle: useRef(null), name: useRef(null), password: useRef(null) };

  useEffect(() => {
    if (S.ui.joinCode) api(`/api/invite/${encodeURIComponent(S.ui.joinCode)}`).then(setInvite, () => { S.ui.joinCode = null; });
  }, []);

  const fieldError = (field, text) => {
    setError({ field, text });
    refs[field].current?.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return undefined;
    if (!handle.trim()) return fieldError('handle', 'Type your username.');
    if (mode === 'new' && !name.trim()) return fieldError('name', 'Tell people what to call you.');
    if (password.length < 8) return fieldError('password', mode === 'new' ? 'Passwords need at least 8 characters.' : 'Type your password.');
    setBusy(true);
    setError(null);
    try {
      const r = await api(mode === 'new' ? '/api/register' : '/api/login', { handle: handle.trim(), name: name.trim(), password });
      if (r.totp) { setBusy(false); setTicket(r.ticket); return undefined; }
      entered(r.user);
    } catch (err) {
      setBusy(false);
      setError({ field: null, text: err.message });
    }
    return undefined;
  };
  const swap = (m) => {
    setMode(m);
    setError(null);
    refs.handle.current?.focus();
  };
  // Typing in a field clears the error that was about it.
  const edit = (field, set) => (e) => {
    set(e.target.value);
    if (error?.field === field) setError(null);
  };
  const bad = (field) => error?.field === field;
  const described = (field, hint) => [bad(field) && `auth-${field}-err`, hint && `auth-${field}-hint`].filter(Boolean).join(' ') || undefined;
  const isNew = mode === 'new';

  return html`<div class="auth">
    <main class="auth-main">
      <div class="auth-panel">
        <div class="auth-brand"><${Lockup} size=${24} /></div>
        ${invite && html`<div class="auth-invite">
          <${Tile} house=${invite.house} lg invite=${S.ui.joinCode} />
          <div><b>${invite.by ? `${invite.by} invited you to ${invite.house.name}` : `You’re invited to ${invite.house.name}`}</b>
          <span>${isNew ? 'Create an account to join.' : 'Sign in to join.'}</span></div>
        </div>`}
        <div class="auth-head">
          <h1 id="auth-title">${isNew ? 'Make yourself at home' : 'Welcome back'}</h1>
          <p class="auth-sub">${isNew ? 'One account for every house you’re part of.' : 'Your people are here.'}</p>
        </div>
        ${ticket && html`<${TotpStep} ticket=${ticket} onDone=${entered} onBack=${() => { setTicket(null); setPassword(''); }} />`}
        <form class="form auth-form" hidden=${!!ticket} onSubmit=${submit} novalidate aria-labelledby="auth-title" aria-busy=${busy ? 'true' : undefined}>
          <div class="auth-field">
            <label class="label" for="auth-handle">Username</label>
            <input id="auth-handle" ref=${refs.handle} class=${`field${bad('handle') ? ' bad' : ''}`} autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" value=${handle}
              aria-invalid=${bad('handle') ? 'true' : undefined} aria-describedby=${described('handle', isNew)}
              onInput=${edit('handle', setHandle)} autofocus />
            ${bad('handle') && html`<${Err} id="auth-handle-err" text=${error.text} />`}
            ${isNew && html`<div class="hint" id="auth-handle-hint">Letters, numbers, dots, dashes or underscores. People use it to mention and invite you.</div>`}
          </div>
          ${isNew && html`<div class="auth-field">
            <label class="label" for="auth-name">Name</label>
            <input id="auth-name" ref=${refs.name} class=${`field${bad('name') ? ' bad' : ''}`} autocomplete="name" maxlength="40" value=${name}
              aria-invalid=${bad('name') ? 'true' : undefined} aria-describedby=${described('name', true)}
              onInput=${edit('name', setName)} />
            ${bad('name') && html`<${Err} id="auth-name-err" text=${error.text} />`}
            <div class="hint" id="auth-name-hint">What people see next to your messages. You can change it later.</div>
          </div>`}
          <div class="auth-field">
            <label class="label" for="auth-pass">Password</label>
            <input id="auth-pass" ref=${refs.password} class=${`field${bad('password') ? ' bad' : ''}`} type="password" autocomplete=${isNew ? 'new-password' : 'current-password'} maxlength="200" value=${password}
              aria-invalid=${bad('password') ? 'true' : undefined} aria-describedby=${described('password', isNew)}
              onInput=${edit('password', setPassword)} />
            ${bad('password') && html`<${Err} id="auth-password-err" text=${error.text} />`}
            ${isNew && html`<div class="hint" id="auth-password-hint">At least 8 characters.</div>`}
          </div>
          ${error && !error.field && html`<${Err} id="auth-form-err" text=${error.text} />`}
          <button class="btn primary auth-submit" type="submit" disabled=${busy} aria-busy=${busy ? 'true' : undefined}>
            ${busy ? (isNew ? 'Creating your account…' : 'Signing in…') : (isNew ? 'Create account' : 'Sign in')}
          </button>
        </form>
        <p class="auth-swap" hidden=${!!ticket}>
          ${isNew ? 'Already have an account?' : 'New to Snug?'}
          <button type="button" class="auth-link" onClick=${() => swap(isNew ? 'in' : 'new')}>${isNew ? 'Sign in' : 'Create an account'}</button>
        </p>
      </div>
    </main>
  </div>`;
}

// Shown while Snug checks who you are, and when the server can't be reached.
export function Splash({ unreachable, onRetry }) {
  // One mark at a time: the Nook itself is the loader while Snug opens; the
  // full lockup only when there is something to read.
  return html`<div class="splash">
    ${unreachable
      ? html`<${Lockup} size=${32} />
        <div class="splash-down" role="alert">
          <p>Can’t reach Snug. Check your connection and try again.</p>
          <button class="btn" onClick=${onRetry}>Try again</button>
        </div>`
      : html`<${Loading} label="Opening Snug…" size=${48} />`}
  </div>`;
}
