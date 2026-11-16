// Signing in and creating an account, and the splash while Snug opens.
// The brand speaks once here: the lockup and one line, then a small form
// that gets out of the way. Errors sit under the field they are about.
//
// In the desktop app with a registry configured (server/ghauth.js), signing in
// is "Continue with GitHub": a code to type on github.com, then picking a Snug
// username. GitHub only proves who someone is; no GitHub name or picture is
// ever shown. Password accounts stay available for this PC only.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, emit, loadCache } from '../store.js';
import { api, startTransport } from '../server.js';
import { Icon } from '../ui/icons.js';
import { Lockup, Loading } from '../ui/brand.js';
import { copyText } from '../ui/kit.js';
import { normalize } from '../lib/usernames.js';
import { localNameProblem, NAME_RULES } from '../lib/username-text.js';

import { TotpStep } from './account.js'; // two-factor sign-in, the second step
import { KeyAuth } from './keyauth.js'; // v0.12: accounts that need no GitHub account
import { Tile } from '../ui/kit.js'; // the house's icon in its arch (server/community.js)
import { ForgotPassword } from './recover.js'; // v0.12: "Forgot your password?" with a recovery key
import { usePasskeySignIn } from './passkeys.js'; // v0.12: passkey sign-in where the server allows it
import { signupProblems, signupField, inviteWhy } from '../lib/onboarding.js'; // every sign-up problem at once; why an invitation fails
import { t } from '../lib/i18n.js'; // words in the chosen language (js/locales)

async function entered(user) {
  S.me = user.id;
  S.auth = 'in';
  await loadCache(user.id).catch(() => false); // 0.14: the sealed device copy opens asynchronously
  emit();
  startTransport();
}

const Err = ({ id, text }) => html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${16} /><span>${text}</span></div>`;

export function Auth() {
  // null while asking the server what it offers; then {enabled, owner, resume} for GitHub sign-in and
  // (v0.12) {enabled, github, owner, resume} for keypair accounts (server/keyauth.js).
  const [gh, setGh] = useState(null);
  const [id, setId] = useState(null);
  // 'key' (the default when offered) | 'github' | 'password'
  const [mode, setMode] = useState(null);
  useEffect(() => {
    let live = true;
    api('/api/gh/config').then((c) => live && setGh(c), () => live && setGh({ enabled: false }));
    api('/api/id/config').then((c) => live && setId(c), () => live && setId({ enabled: false }));
    return () => { live = false; };
  }, []);
  if (!gh || !id) return html`<div class="auth"><main class="auth-main"><div class="auth-panel"><div class="auth-brand"><${Lockup} size=${24} /></div></div></main></div>`;
  const m = mode || (id.enabled ? 'key' : gh.enabled ? 'github' : 'password');
  const first = id.enabled ? 'key' : gh.enabled ? 'github' : null;
  if (m === 'key') return html`<${KeyAuth} cfg=${id} entered=${entered} onPassword=${() => setMode('password')} onGitHub=${() => setMode('github')} />`;
  if (m === 'github' && gh.enabled) return html`<${GitHubAuth} gh=${gh} onPassword=${() => setMode('password')} onBack=${id.enabled ? () => setMode('key') : null} />`;
  return html`<${PasswordAuth} onGitHub=${first ? () => setMode(first) : null} />`;
}

// ---------- Sign in with GitHub ----------

function GitHubAuth({ gh, onPassword, onBack }) {
  // step: null (start) | {kind:'code', flow, userCode, uri} | {kind:'name', flow, owner} | {kind:'rebind', flow, username} | {kind:'stop', text}
  const [step, setStep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const live = useRef(true);
  const flowRef = useRef(null);
  useEffect(() => () => {
    live.current = false;
    if (flowRef.current) api('/api/gh/cancel', { flow: flowRef.current }).catch(() => {});
  }, []);

  // GitHub answers through the local server: each wait is held there up to 25 s.
  const waitFor = async (flow) => {
    for (;;) {
      let r;
      try { r = await api('/api/gh/wait', { flow }); } catch (e) {
        if (!live.current || flowRef.current !== flow) return;
        setStep({ kind: 'stop', text: e.message });
        return;
      }
      if (!live.current || flowRef.current !== flow) return;
      if (r.state === 'pending') continue;
      if (r.state === 'signed-in' || r.state === 'moving') { flowRef.current = null; entered(r.user); return; }
      if (r.state === 'choose-name') { setStep({ kind: 'name', flow, owner: !!r.owner }); return; }
      if (r.state === 'rebind') { setStep({ kind: 'rebind', flow, username: r.username }); return; }
      flowRef.current = null;
      setStep({ kind: 'stop', text: STOPPED[r.state] || r.message || STOPPED.error });
      return;
    }
  };
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api('/api/gh/start', {});
      if (!live.current) return;
      flowRef.current = r.flow;
      setStep({ kind: 'code', flow: r.flow, userCode: r.userCode, uri: r.verificationUri });
      waitFor(r.flow);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const cancel = () => {
    if (flowRef.current) api('/api/gh/cancel', { flow: flowRef.current }).catch(() => {});
    flowRef.current = null;
    setStep(null);
  };
  const resume = async () => {
    setBusy(true);
    try { entered((await api('/api/gh/resume', {})).user); } catch (e) { setError(e.message); setBusy(false); }
  };

  let body;
  if (step?.kind === 'code') body = html`<${CodeStep} step=${step} onCancel=${cancel} />`;
  else if (step?.kind === 'name') body = html`<${NameStep} step=${step} onCancel=${cancel} onDone=${(u) => { flowRef.current = null; entered(u); }} />`;
  else if (step?.kind === 'rebind') body = html`<${RebindStep} step=${step} onCancel=${cancel} onDone=${(u) => { flowRef.current = null; entered(u); }} />`;
  else if (step?.kind === 'stop') {
    body = html`
      <div class="auth-head"><h1 id="auth-title">Sign-in stopped</h1></div>
      <${Err} id="auth-form-err" text=${step.text} />
      <button class="btn primary auth-submit" onClick=${() => { setStep(null); start(); }}>Start again</button>`;
  } else {
    body = html`
      <div class="auth-head">
        <h1 id="auth-title">${gh.resume ? 'Welcome back' : 'Welcome to Snug'}</h1>
        <p class="auth-sub">Talk with your friends on any PC. Messages go straight from your PC to theirs.</p>
      </div>
      <div class="auth-gh">
        ${gh.resume && html`<button class="btn primary auth-submit" id="auth-resume" disabled=${busy} onClick=${resume}>Continue as @${gh.resume}</button>`}
        <button class=${`btn ${gh.resume ? '' : 'primary '}auth-submit`} id="auth-github" disabled=${busy} aria-busy=${busy ? 'true' : undefined} onClick=${start}>
          ${busy && !gh.resume ? 'Asking GitHub…' : 'Continue with GitHub'}
        </button>
        ${error && html`<${Err} id="auth-form-err" text=${error} />`}
        <p class="auth-fine">GitHub only proves it’s you. Nobody on Snug sees your GitHub account, and Snug never posts anything there.</p>
        ${onBack && html`<p class="auth-fine">No GitHub account? <button type="button" class="auth-link" id="auth-no-github" onClick=${onBack}>Create a Snug account without one</button></p>`}
      </div>
      <p class="auth-swap">
        ${gh.owner ? 'Someone else here?' : 'Only on this PC?'}
        <button type="button" class="auth-link" id="auth-use-password" onClick=${onPassword}>Use a password account</button>
      </p>
      ${onBack && html`<p class="auth-swap"><button type="button" class="auth-link" id="auth-github-back" onClick=${onBack}>Back</button></p>`}`;
  }
  return html`<div class="auth">
    <main class="auth-main">
      <div class="auth-panel" aria-labelledby="auth-title">
        <div class="auth-brand"><${Lockup} size=${24} /></div>
        ${body}
      </div>
    </main>
  </div>`;
}

const STOPPED = {
  expired: 'That code ran out. Start again for a new one.',
  denied: 'GitHub sign-in was cancelled.',
  busy: 'GitHub is busy. Try again in a few minutes.',
  error: 'Something went wrong. Start again.',
};

// The code to type on github.com, and the warning about anyone asking for it.
export function CodeStep({ step, onCancel }) {
  const open = () => copyText(step.userCode);
  return html`
    <div class="auth-head">
      <h1 id="auth-title">Type this code on GitHub</h1>
      <ol class="auth-steps">
        <li>Choose <b>Copy code and open GitHub</b>. Your code is copied for you.</li>
        <li>Paste it on GitHub and choose <b>Authorize</b>. Sign in there first if it asks.</li>
        <li>Come back here.</li>
      </ol>
    </div>
    <div class="auth-code-box">
      <output class="auth-device-code" id="auth-device-code" aria-label=${`Your code: ${step.userCode.split('').join(' ')}`}>${step.userCode}</output>
      <button class="ib" type="button" aria-label="Copy the code" data-tip="Copy" onClick=${open}><${Icon} name="copy" size=${18} /></button>
    </div>
    <div class="auth-paste-at">
      <span>Paste it here:</span>
      <a class="auth-device-url" id="auth-device-url" href=${step.uri} target="_blank" rel="noopener noreferrer">${step.uri}</a>
    </div>
    <a class="btn primary auth-submit" id="auth-open-github" href=${step.uri} target="_blank" rel="noopener noreferrer" onClick=${open}>
      <${Icon} name="external" size=${16} />Copy code and open GitHub
    </a>
    <div class="auth-warn" role="note"><${Icon} name="shield" size=${16} /><span>Only type this code on github.com yourself. Snug will never ask you to send it to anyone.</span></div>
    <p class="auth-wait" role="status"><span class="spinner" aria-hidden="true"></span>Waiting for GitHub… The code works for 15 minutes.</p>
    <p class="auth-swap"><button type="button" class="auth-link" onClick=${onCancel}>Cancel</button></p>`;
}

// Pick the Snug username: the rules locally as they type, then the registry.
// v0.12: a keypair sign-up (js/views/keyauth.js) passes its own `check` and `submit` (which resolves with the
// whole answer for onDone), the rules it adds (`nameProblem`), and while it works `busy` text with a Cancel.
export function NameStep({ step, onCancel, onDone, check: checkName, submit: submitName, nameProblem, busyText, onBusyCancel }) {
  const [name, setName] = useState('');
  // {state: 'idle'|'checking'|'ok'|'bad'|'unknown', text}
  const [st, setSt] = useState({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const input = useRef();
  const seq = useRef(0);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const n = normalize(name);
    if (!n) { setSt({ state: 'idle' }); return undefined; }
    const local = localNameProblem(n, { owner: step.owner }) || nameProblem?.(n);
    if (local) { setSt({ state: 'bad', text: local }); return undefined; }
    setSt({ state: 'checking' });
    const my = ++seq.current;
    // A short pause after typing, then one question to the registry.
    const t = setTimeout(() => {
      (checkName ? checkName(n) : api(`/api/gh/check?name=${encodeURIComponent(n)}&flow=${encodeURIComponent(step.flow)}`)).then((r) => {
        if (my !== seq.current) return;
        if (r.ok) setSt({ state: 'ok', text: `@${n} is available.` });
        else if (r.ok === false) setSt({ state: 'bad', text: r.message });
        else setSt({ state: 'unknown', text: r.message });
      }, (e) => my === seq.current && setSt({ state: 'unknown', text: e.message }));
    }, 300);
    return () => clearTimeout(t);
  }, [name]);
  const submit = async (e) => {
    e.preventDefault();
    const n = normalize(name);
    const local = localNameProblem(n, { owner: step.owner }) || nameProblem?.(n);
    if (local) { setSt({ state: 'bad', text: local }); input.current?.focus(); return; }
    setBusy(true);
    try {
      if (submitName) onDone(await submitName(n));
      else onDone((await api('/api/gh/claim', { flow: step.flow, username: n })).user);
    } catch (x) {
      setBusy(false);
      seq.current++;
      if (x.code === 'cancelled') { setSt({ state: 'idle' }); return; }
      if (/took too long|start again/i.test(x.message)) setSt({ state: 'bad', text: x.message, restart: true });
      else setSt({ state: 'bad', text: x.message });
      input.current?.focus();
    }
  };
  const bad = st.state === 'bad';
  return html`
    <div class="auth-head">
      <h1 id="auth-title">Pick your username</h1>
      <p class="auth-sub">It’s how friends find and add you. Nobody else can have it.</p>
    </div>
    <form class="form auth-form" onSubmit=${submit} novalidate aria-labelledby="auth-title" aria-busy=${busy ? 'true' : undefined}>
      <div class="auth-field">
        <label class="label" for="auth-username">Username</label>
        <div class=${`auth-at${bad ? ' bad' : ''}${st.state === 'ok' ? ' ok' : ''}`}>
          <span aria-hidden="true">@</span>
          <input id="auth-username" ref=${input} autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" value=${name}
            aria-invalid=${bad ? 'true' : undefined} aria-describedby="auth-username-msg auth-username-hint"
            onInput=${(e) => setName(e.target.value)} />
        </div>
        <div id="auth-username-msg" class="auth-name-msg" aria-live="polite">
          ${bad && html`<${Err} id="auth-username-err" text=${st.text} />`}
          ${st.state === 'ok' && html`<div class="ok-line" id="auth-username-ok"><${Icon} name="check" size=${16} /><span>${st.text}</span></div>`}
          ${st.state === 'checking' && html`<div class="hint">Checking…</div>`}
          ${st.state === 'unknown' && html`<div class="hint">${st.text}</div>`}
        </div>
        <div class="hint" id="auth-username-hint">${NAME_RULES} Capitals become lowercase. You can change it once a week.</div>
      </div>
      <button class="btn primary auth-submit" type="submit" disabled=${busy || bad || !name.trim()} aria-busy=${busy ? 'true' : undefined}>${busy ? (busyText ? 'Setting up…' : 'Saving…') : 'Continue'}</button>
      ${busy && busyText && html`<p class="auth-wait" role="status" id="auth-setting-up"><span class="spinner" aria-hidden="true"></span>${busyText}</p>`}
      ${busy && onBusyCancel && html`<button type="button" class="btn auth-submit" id="auth-setup-cancel" onClick=${onBusyCancel}>Cancel</button>`}
    </form>
    <p class="auth-fine">Your display name is separate and can be anything. Set it any time in Settings.</p>
    <p class="auth-swap"><button type="button" class="auth-link" onClick=${onCancel}>${st.restart ? 'Start again' : 'Cancel'}</button></p>`;
}

// This GitHub account's Snug account is on another PC: offer to move it here.
function RebindStep({ step, onCancel, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const move = async () => {
    setBusy(true);
    try { onDone((await api('/api/gh/rebind', { flow: step.flow })).user); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return html`
    <div class="auth-head">
      <h1 id="auth-title">@${step.username} is on another PC</h1>
      <p class="auth-sub">Moving your Snug account here takes 72 hours, or happens right away if you confirm on your other PC.</p>
    </div>
    <ul class="auth-facts">
      <li>That PC stops getting messages. Its saved chats stay there.</li>
      <li>If you lost that PC, you’ll need to wait the 72 hours. Your friends will see that your security code changed.</li>
      <li>Houses and everything on this PC work while you wait.</li>
    </ul>
    ${err && html`<${Err} id="auth-form-err" text=${err} />`}
    <button class="btn primary auth-submit" id="auth-move" disabled=${busy} aria-busy=${busy ? 'true' : undefined} onClick=${move}>${busy ? 'Asking…' : 'Move my account here'}</button>
    <p class="auth-swap"><button type="button" class="auth-link" onClick=${onCancel}>Cancel</button></p>`;
}

// ---------- Password accounts (this PC only when GitHub is offered) ----------

function PasswordAuth({ onGitHub }) {
  const [mode, setMode] = useState(S.ui.joinCode ? 'new' : 'in');
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false); // the password in plain text, while they check it
  // One problem per field, all shown at once: { handle, name, password, form }.
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(null);
  const [badInvite, setBadInvite] = useState(null); // why the link they followed doesn't work
  const [ticket, setTicket] = useState(null); // two-factor sign-in: the password was right, a code is next
  const [forgot, setForgot] = useState(false);
  const pk = usePasskeySignIn(entered);
  const refs = { handle: useRef(null), name: useRef(null), password: useRef(null) };

  useEffect(() => {
    if (!S.ui.joinCode) return;
    // A dead link says so before anyone fills in a form for nothing.
    api(`/api/invite/${encodeURIComponent(S.ui.joinCode)}`).then(setInvite, (e) => {
      S.ui.joinCode = null;
      setBadInvite(e.status === 404 ? inviteWhy(e.data?.reason) : e.message);
    });
  }, []);

  const isNew = mode === 'new';
  const show = (found) => {
    setErrors(found);
    const firstBad = ['handle', 'name', 'password'].find((f) => found[f]);
    if (firstBad) refs[firstBad].current?.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return undefined;
    const found = isNew ? signupProblems({ handle, name, password }) : {
      ...(handle.trim() ? {} : { handle: t('auth.typeUsername') }),
      ...(password ? {} : { password: t('auth.typePassword') }),
    };
    if (Object.keys(found).length) return show(found);
    setBusy(true);
    setErrors({});
    try {
      const r = await api(isNew ? '/api/register' : '/api/login', { handle: handle.trim(), name: name.trim(), password });
      if (r.totp) { setBusy(false); setTicket(r.ticket); return undefined; }
      entered(r.user);
    } catch (err) {
      setBusy(false);
      const field = isNew ? signupField(err.message, err.status) : null;
      show(field ? { [field]: err.message } : { form: err.message });
    }
    return undefined;
  };
  const swap = (m) => {
    setMode(m);
    setErrors({});
    refs.handle.current?.focus();
  };
  // Typing in a field clears the problem that was about it.
  const edit = (field, set) => (e) => {
    set(e.target.value);
    if (errors[field] || errors.form) setErrors({ ...errors, [field]: undefined, form: undefined });
  };
  const bad = (field) => !!errors[field];
  const described = (field, hint) => [bad(field) && `auth-${field}-err`, hint && `auth-${field}-hint`].filter(Boolean).join(' ') || undefined;

  if (forgot) {
    return html`<div class="auth"><main class="auth-main"><div class="auth-panel" aria-labelledby="auth-title">
      <div class="auth-brand"><${Lockup} size=${24} /></div>
      <${ForgotPassword} onDone=${entered} onBack=${() => setForgot(false)} />
    </div></main></div>`;
  }
  return html`<div class="auth">
    <main class="auth-main">
      <div class="auth-panel">
        <div class="auth-brand"><${Lockup} size=${24} /></div>
        ${invite && html`<div class="auth-invite">
          <${Tile} house=${invite.house} lg invite=${S.ui.joinCode} />
          <div><b>${invite.by ? t('auth.invitedBy', { name: invite.by, house: invite.house.name }) : t('auth.invitedTo', { house: invite.house.name })}</b>
          <span>${isNew ? t('auth.createToJoin') : t('auth.signInToJoin')}</span></div>
        </div>`}
        ${badInvite && html`<div class="auth-invite bad" role="alert">
          <${Icon} name="alert" size=${20} />
          <div><b>${t('invite.bad')}</b><span>${t('auth.badInviteMore', { why: badInvite })}</span></div>
        </div>`}
        <div class="auth-head">
          <h1 id="auth-title">${isNew ? t('auth.newTitle') : t('auth.signInTitle')}</h1>
          <p class="auth-sub">${onGitHub ? t('auth.pcOnly') : isNew ? t('auth.newSub') : t('auth.signInSub')}</p>
        </div>
        ${ticket && html`<${TotpStep} ticket=${ticket} onDone=${entered} onBack=${() => { setTicket(null); setPassword(''); }} />`}
        <form class="form auth-form" hidden=${!!ticket} onSubmit=${submit} novalidate aria-labelledby="auth-title" aria-busy=${busy ? 'true' : undefined}>
          <div class="auth-field">
            <label class="label" for="auth-handle">${t('auth.username')}</label>
            <input id="auth-handle" ref=${refs.handle} class=${`field${bad('handle') ? ' bad' : ''}`} autocomplete=${isNew ? 'username' : 'username webauthn'} autocapitalize="none" spellcheck="false" maxlength="24" value=${handle}
              aria-invalid=${bad('handle') ? 'true' : undefined} aria-describedby=${described('handle', isNew)}
              onInput=${edit('handle', setHandle)} autofocus />
            ${bad('handle') && html`<${Err} id="auth-handle-err" text=${errors.handle} />`}
            ${isNew && html`<div class="hint" id="auth-handle-hint">${t('auth.handleHint')}</div>`}
          </div>
          ${isNew && html`<div class="auth-field">
            <label class="label" for="auth-name">${t('auth.name')}</label>
            <input id="auth-name" ref=${refs.name} class=${`field${bad('name') ? ' bad' : ''}`} autocomplete="name" maxlength="40" value=${name}
              aria-invalid=${bad('name') ? 'true' : undefined} aria-describedby=${described('name', true)}
              onInput=${edit('name', setName)} />
            ${bad('name') && html`<${Err} id="auth-name-err" text=${errors.name} />`}
            <div class="hint" id="auth-name-hint">${t('auth.nameHint')}</div>
          </div>`}
          <div class="auth-field">
            <label class="label" for="auth-pass">${t('auth.password')}</label>
            <div class="pass-wrap">
              <input id="auth-pass" ref=${refs.password} class=${`field${bad('password') ? ' bad' : ''}`} type=${shown ? 'text' : 'password'} autocomplete=${isNew ? 'new-password' : 'current-password'} maxlength="200" value=${password}
                autocapitalize="none" spellcheck="false" aria-invalid=${bad('password') ? 'true' : undefined} aria-describedby=${described('password', isNew)}
                onInput=${edit('password', setPassword)} />
              <button type="button" class="ib sm pass-show" aria-pressed=${String(shown)} aria-controls="auth-pass" aria-label=${shown ? t('auth.hidePassword') : t('auth.showPassword')}
                data-tip=${shown ? t('auth.hidePassword') : t('auth.showPassword')} onClick=${() => setShown(!shown)}><${Icon} name="eye" size=${16} /></button>
            </div>
            ${bad('password') && html`<${Err} id="auth-password-err" text=${errors.password} />`}
            ${isNew && html`<div class="hint" id="auth-password-hint">${t('auth.passwordHint')}
              <b class="auth-keep">${t('auth.writeItDown')}</b></div>`}
            ${!isNew && html`<button type="button" class="auth-link auth-forgot" id="auth-forgot" onClick=${() => setForgot(true)}>${t('auth.forgot')}</button>`}
          </div>
          ${errors.form && html`<${Err} id="auth-form-err" text=${errors.form} />`}
          <button class="btn primary auth-submit" type="submit" disabled=${busy} aria-busy=${busy ? 'true' : undefined}>
            ${busy ? (isNew ? t('auth.creating') : t('auth.signingIn')) : (isNew ? t('auth.create') : t('auth.signIn'))}
          </button>
        </form>
        ${!isNew && !ticket && pk.offered && html`<div class="auth-passkey">
          <button type="button" class="btn auth-submit" id="auth-passkey" disabled=${pk.busy} aria-busy=${pk.busy ? 'true' : undefined} onClick=${pk.start}>
            <${Icon} name="shield" size=${16} />${pk.busy ? t('auth.passkeyWait') : t('auth.passkey')}
          </button>
          ${pk.error && html`<${Err} id="auth-passkey-err" text=${pk.error} />`}
        </div>`}
        <p class="auth-swap" hidden=${!!ticket}>
          ${isNew ? t('auth.haveAccount') : t('auth.newToSnug')}
          <button type="button" class="auth-link" onClick=${() => swap(isNew ? 'in' : 'new')}>${isNew ? t('auth.signIn') : t('auth.createAccount')}</button>
        </p>
        ${onGitHub && html`<p class="auth-swap" hidden=${!!ticket}><button type="button" class="auth-link" id="auth-back-github" onClick=${onGitHub}>${t('common.back')}</button></p>`}
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
          <p>${t('auth.unreachable')}</p>
          <button class="btn" onClick=${onRetry}>${t('common.tryAgain')}</button>
        </div>`
      : html`<${Loading} label=${t('auth.opening')} size=${48} />`}
  </div>`;
}
