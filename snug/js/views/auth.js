// Signing in and creating an account. Same frame as the app: the darker
// column on the left says where you are, the bright surface holds the work.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit, loadCache } from '../store.js';
import { api, startTransport } from '../server.js';
import { Icon, Mark } from '../ui/icons.js';
import { Seg } from '../ui/kit.js';

function entered(user) {
  S.me = user.id;
  S.auth = 'in';
  loadCache(user.id);
  emit();
  startTransport();
}

export function Auth() {
  const [mode, setMode] = useState(S.ui.joinCode ? 'new' : 'in');
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(null);

  useEffect(() => {
    if (S.ui.joinCode) api(`/api/invite/${encodeURIComponent(S.ui.joinCode)}`).then(setInvite, () => { S.ui.joinCode = null; });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!handle.trim()) return setError('Type your username.');
    if (mode === 'new' && !name.trim()) return setError('Tell people what to call you.');
    if (password.length < 8) return setError(mode === 'new' ? 'Passwords need at least 8 characters.' : 'Type your password.');
    setBusy(true);
    setError('');
    try {
      const r = await api(mode === 'new' ? '/api/register' : '/api/login', { handle: handle.trim(), name: name.trim(), password });
      entered(r.user);
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
    return undefined;
  };
  const swap = (m) => { setMode(m); setError(''); };

  return html`<div class="auth">
    <aside class="auth-side">
      <div class="logo"><${Mark} size=${24} /><span>Snug</span></div>
      <p>A calm place for your people. Houses hold rooms, rooms hold conversations, and nothing shouts at you.</p>
    </aside>
    <main class="auth-main">
      <form class="form auth-form" onSubmit=${submit} novalidate>
        ${invite && html`<div class="auth-invite">
          <span class="tile lg" style=${`--hue:${invite.house.hue}`}>${invite.house.mark}</span>
          <div><b>${invite.by ? `${invite.by} invited you to ${invite.house.name}` : `You’re invited to ${invite.house.name}`}</b>
          <span>${mode === 'new' ? 'Create an account to join.' : 'Sign in to join.'}</span></div>
        </div>`}
        <h1>${mode === 'new' ? 'Create your account' : 'Sign in to Snug'}</h1>
        <${Seg} label="Sign in or create an account" value=${mode} options=${[['in', 'Sign in'], ['new', 'Create account']]} onChange=${swap} />
        <div>
          <label class="label" for="auth-handle">Username</label>
          <input id="auth-handle" class="field" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" value=${handle}
            onInput=${(e) => setHandle(e.target.value)} autofocus />
          ${mode === 'new' && html`<div class="hint">Letters, numbers, dots, dashes or underscores. People use it to mention and invite you.</div>`}
        </div>
        ${mode === 'new' && html`<div>
          <label class="label" for="auth-name">Name</label>
          <input id="auth-name" class="field" autocomplete="name" maxlength="40" value=${name} onInput=${(e) => setName(e.target.value)} />
          <div class="hint">What people see next to your messages. You can change it later.</div>
        </div>`}
        <div>
          <label class="label" for="auth-pass">Password</label>
          <input id="auth-pass" class="field" type="password" autocomplete=${mode === 'new' ? 'new-password' : 'current-password'} maxlength="200" value=${password}
            onInput=${(e) => setPassword(e.target.value)} />
          ${mode === 'new' && html`<div class="hint">At least 8 characters.</div>`}
        </div>
        ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
        <button class="btn primary" type="submit" disabled=${busy}>${mode === 'new' ? 'Create account' : 'Sign in'}</button>
      </form>
    </main>
  </div>`;
}

// Shown while Snug checks who you are, and when the server can't be reached.
export function Splash({ unreachable, onRetry }) {
  return html`<div class="splash" role="status">
    <div class="logo"><${Mark} size=${28} /><span>Snug</span></div>
    ${unreachable
      ? html`<p>Can’t reach Snug. Check your connection.</p><button class="btn" onClick=${onRetry}>Try again</button>`
      : html`<p class="faint">Opening…</p>`}
  </div>`;
}
