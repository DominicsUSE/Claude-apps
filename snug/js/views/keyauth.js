// The desktop app's first screens (v0.12): "Create my account" or "I already have an account", with no
// GitHub account needed (server/keyauth.js). Creating an account ends on "Save your recovery key", the one
// thing that brings the account back on a new PC. GitHub stays one choice away, for people who used it.
//
// Words for someone who isn't technical: no "keys", "registry" or "device" on these screens except the
// recovery key itself, and every step says what happens next.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { toast } from '../store.js';
import { api } from '../server.js';
import { Icon, addIcons } from '../ui/icons.js';
import { copyText } from '../ui/kit.js';
import { Lockup } from '../ui/brand.js';
import { recoveryFileText } from '../lib/recovery.js';
import { NameStep } from './auth.js'; // the same username picker as GitHub sign-up (a circular import, used at render only)
import { t, intlLocale } from '../lib/i18n.js'; // words and dates in the chosen language (js/locales)

addIcons({
  key: 'M7 13.500a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7Z|M10.500 10H17|M14.500 10v2.500|M16.500 10v2', // as js/views/p2p.js
  download: 'M10 3.5v9|M6 9l4 4 4-4|M4 16.5h12', // as js/views/viewer.js
});

const Err = ({ id, text }) => html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${16} /><span>${text}</span></div>`;
const when = (ts) => new Date(ts).toLocaleString(intlLocale(), { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const SHORT_NAME_TEXT = 'Usernames of 2 or 3 characters are open to new accounts after 30 days. Pick a longer one for now.';

/**
 * The recovery key, shown once, and the ways to keep it. `confirm(last)` checks the last group typed back;
 * `onDone` follows it. `onLater` (optional) skips with a warning; a reminder stays in the app.
 * `lead`, `warn` and `laterWarn` replace the desktop wording (a Snug server's password accounts use other words).
 */
export function RecoverySave({ code, username, confirm, onDone, onLater, titleId = 'auth-title', pendingAt = null, pendingNote = null, lead = null, warn = null, laterWarn = null }) {
  const [last, setLast] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState(false);
  const input = useRef();
  const groups = code.split('-');
  const text = recoveryFileText({ text: code, username });
  const file = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  const print = () => {
    // Only the key's sheet prints (css/p2p.css .rk-print), not the app around it.
    document.body.classList.add('print-rk');
    try { window.print(); } finally { setTimeout(() => document.body.classList.remove('print-rk'), 500); }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (last.replace(/[\s-]/g, '').length !== 4) { setErr('Type the last 4 characters of your key.'); input.current?.focus(); return; }
    setBusy(true);
    try { await confirm(last); onDone(); } catch (x) { setErr(x.message); setBusy(false); input.current?.focus(); }
  };
  return html`<div class="rk">
    <div class="auth-head">
      <h1 id=${titleId}>Save your recovery key</h1>
      <p class="auth-sub">${lead || 'If you lose this PC, this key is the only way to get your account back. Snug can’t reset it for you.'}</p>
    </div>
    ${pendingAt && html`<p class="auth-fine" id="rk-pending">This key starts working on ${when(pendingAt)}. ${pendingNote || 'Until then your old key still works, and it can cancel this one.'}</p>`}
    <div class="rk-key" id="rk-key" role="group" aria-label="Your recovery key, 9 groups of 4">
      ${groups.map((g, i) => html`<span key=${i} aria-label=${`Group ${i + 1}: ${g.split('').join(' ')}`}>${g}</span>`)}
    </div>
    <div class="rk-acts">
      <a class="btn" id="rk-download" href=${file} download=${`Snug recovery key - @${username}.txt`}><${Icon} name="download" size=${16} />Save as a file</a>
      <button type="button" class="btn" id="rk-print" onClick=${print}>Print</button>
      <button type="button" class="btn" id="rk-copy" onClick=${() => copyText(code)}><${Icon} name="copy" size=${16} />Copy</button>
    </div>
    <div class="auth-warn" role="note"><${Icon} name="shield" size=${16} /><span>${warn || 'Keep it somewhere other than this PC: on paper, or in a password manager. Anyone who has it can move your account to their PC.'}</span></div>
    <form class="form auth-form" onSubmit=${submit} novalidate aria-busy=${busy ? 'true' : undefined}>
      <div class="auth-field">
        <label class="label" for="rk-last">Type the last 4 characters to show you saved it</label>
        <input id="rk-last" ref=${input} class=${`field rk-last${err ? ' bad' : ''}`} maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" value=${last}
          aria-invalid=${err ? 'true' : undefined} aria-describedby=${err ? 'rk-last-err' : undefined} onInput=${(e) => { setLast(e.target.value); setErr(''); }} />
        ${err && html`<${Err} id="rk-last-err" text=${err} />`}
      </div>
      <button class="btn primary auth-submit" type="submit" id="rk-saved" disabled=${busy}>${busy ? 'Checking…' : 'I saved it'}</button>
    </form>
    ${onLater && !later && html`<p class="auth-swap"><button type="button" class="auth-link" id="rk-later" onClick=${() => setLater(true)}>Do this later</button></p>`}
    ${onLater && later && html`<div class="auth-warn rk-later-warn" role="alert">
      <${Icon} name="alert" size=${16} />
      <span>${laterWarn || 'Without your recovery key, losing this PC means losing your account. Settings will remind you until it’s saved.'}
        <button type="button" class="auth-link" id="rk-later-ok" onClick=${onLater}>Continue without saving</button></span>
    </div>`}
    <pre class="rk-print" aria-hidden="true">${text}</pre>
  </div>`;
}

// ---------- the first screens ----------

export function KeyAuth({ cfg, onPassword, onGitHub, entered }) {
  // step: null | 'create' | {kind:'save', code, user, username} | 'have' | {kind:'code', flow, code} | 'recover' | {kind:'moving', at, user} | {kind:'stop', text}
  const [step, setStep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  const flowRef = useRef(null);
  useEffect(() => () => {
    live.current = false;
    if (flowRef.current) api('/api/id/cancel', { flow: flowRef.current }).catch(() => {});
  }, []);
  const back = (to = null) => { if (flowRef.current) api('/api/id/cancel', { flow: flowRef.current }).catch(() => {}); flowRef.current = null; setError(''); setStep(to); };
  const resume = async () => {
    setBusy(true);
    try { entered((await api('/api/id/resume', {})).user); } catch (e) { setError(e.message); setBusy(false); }
  };

  // "My other PC is here": a code to type there; each wait is held by the local server up to 25 s.
  const startCode = async () => {
    setError('');
    setStep({ kind: 'code', code: null });
    let s;
    try { s = await api('/api/id/move/start', {}); } catch (e) { if (live.current) setStep({ kind: 'stop', text: e.message, retry: startCode }); return; }
    if (!live.current) { api('/api/id/cancel', { flow: s.flow }).catch(() => {}); return; }
    flowRef.current = s.flow;
    setStep({ kind: 'code', code: s.code, flow: s.flow });
    for (;;) {
      let w;
      try { w = await api('/api/id/move/wait', { flow: s.flow }); } catch (e) {
        if (live.current && flowRef.current === s.flow) setStep({ kind: 'stop', text: e.message, retry: startCode });
        return;
      }
      if (!live.current || flowRef.current !== s.flow) return;
      if (w.state === 'waiting') continue;
      flowRef.current = null;
      if (w.state === 'signed-in') {
        toast(`You’re @${w.user.handle} on this PC. Your chats are being copied from your other PC.`);
        entered(w.user);
      } else setStep({ kind: 'stop', text: 'That code ran out before your other PC used it. Make a new one.', retry: startCode });
      return;
    }
  };

  let body;
  if (step === 'create') {
    body = html`<${NameForKey} onCancel=${() => back()} onDone=${(r) => setStep({ kind: 'save', code: r.recovery.code, user: r.user, username: r.user.handle })} />`;
  } else if (step?.kind === 'save') {
    body = html`<${RecoverySave} code=${step.code} username=${step.username}
      confirm=${(last) => api('/api/id/recovery/confirm', { last })} onDone=${() => entered(step.user)} onLater=${() => entered(step.user)} />`;
  } else if (step === 'have') {
    body = html`
      <div class="auth-head">
        <h1 id="auth-title">${t('key.welcomeBack')}</h1>
        <p class="auth-sub">${t('key.haveSub')}</p>
      </div>
      <div class="auth-choices" role="list">
        <button type="button" class="auth-choice" id="auth-other-pc" role="listitem" onClick=${startCode}>
          <${Icon} name="screen" size=${20} /><span><b>${t('key.otherPc')}</b><span>${t('key.otherPcSub')}</span></span>
        </button>
        <button type="button" class="auth-choice" id="auth-lost-pc" role="listitem" onClick=${() => setStep('recover')}>
          <${Icon} name="key" size=${20} /><span><b>${t('key.lostPc')}</b><span>${t('key.lostPcSub')}</span></span>
        </button>
        ${cfg.github && html`<button type="button" class="auth-choice" id="auth-github-path" role="listitem" onClick=${onGitHub}>
          <${Icon} name="external" size=${20} /><span><b>${t('key.usedGithub')}</b><span>${t('key.usedGithubSub')}</span></span>
        </button>`}
      </div>
      <p class="auth-swap"><button type="button" class="auth-link" onClick=${() => back()}>${t('common.back')}</button></p>`;
  } else if (step?.kind === 'code') {
    body = html`
      <div class="auth-head">
        <h1 id="auth-title">Type this code on your other PC</h1>
        <p class="auth-sub">On your other PC, open Snug, go to Settings, then Account and security, choose <b>Move to a new PC</b>, and type this code.</p>
      </div>
      <div class="auth-code-box">
        ${step.code
          ? html`<output class="auth-device-code" id="auth-move-code" aria-label=${`Your code: ${step.code.split('').join(' ')}`}>${step.code}</output>
            <button class="ib" type="button" aria-label="Copy the code" data-tip="Copy" onClick=${() => copyText(step.code)}><${Icon} name="copy" size=${18} /></button>`
          : html`<span class="auth-wait"><span class="spinner" aria-hidden="true"></span>Making a code…</span>`}
      </div>
      <div class="auth-warn" role="note"><${Icon} name="shield" size=${16} /><span>Only type this code into Snug on your own PC. Snug will never ask you to send it to anyone.</span></div>
      <p class="auth-wait" role="status"><span class="spinner" aria-hidden="true"></span>Waiting for your other PC… The code works for 10 minutes.</p>
      <p class="auth-swap"><button type="button" class="auth-link" onClick=${() => back('have')}>Cancel</button></p>`;
  } else if (step === 'recover') {
    body = html`<${RecoverStep} onCancel=${() => back('have')} onDone=${(r) => (r.state === 'moving' ? setStep({ kind: 'moving', at: r.at, user: r.user }) : entered(r.user))} />`;
  } else if (step?.kind === 'moving') {
    body = html`
      <div class="auth-head">
        <h1 id="auth-title">Your account is on its way</h1>
        <p class="auth-sub" id="auth-moving-at">Your account will move to this PC on ${when(step.at)}.</p>
      </div>
      <ul class="auth-facts">
        <li>If your old PC is still switched on, it can stop this. If that happens and it wasn’t you, ask the Snug owner for help.</li>
        <li>You can use Snug on this PC meanwhile. Messages from friends wait until the move is done.</li>
        <li>Your friends will see that your security code changed.</li>
      </ul>
      <button class="btn primary auth-submit" id="auth-moving-continue" onClick=${() => entered(step.user)}>Continue</button>`;
  } else if (step?.kind === 'stop') {
    body = html`
      <div class="auth-head"><h1 id="auth-title">${t('key.stopped')}</h1></div>
      <${Err} id="auth-form-err" text=${step.text} />
      <button class="btn primary auth-submit" onClick=${step.retry || (() => back())}>${t('common.tryAgain')}</button>
      <p class="auth-swap"><button type="button" class="auth-link" onClick=${() => back()}>${t('common.back')}</button></p>`;
  } else {
    body = html`
      <div class="auth-head">
        <h1 id="auth-title">${cfg.resume ? t('key.welcomeBack') : t('key.welcome')}</h1>
        <p class="auth-sub">${t('key.sub')}</p>
      </div>
      <div class="auth-gh">
        ${cfg.resume && html`<button class="btn primary auth-submit" id="auth-resume" disabled=${busy} onClick=${resume}>${t('key.continueAs', { name: cfg.resume })}</button>`}
        ${!cfg.resume && html`<button class="btn primary auth-submit" id="auth-create" onClick=${() => setStep('create')}>${t('key.create')}</button>
          <button class="btn auth-submit" id="auth-have" onClick=${() => setStep('have')}>${t('key.have')}</button>`}
        ${error && html`<${Err} id="auth-form-err" text=${error} />`}
        <p class="auth-fine">${t('key.fine')}</p>
      </div>
      <p class="auth-swap">
        ${cfg.owner ? t('key.someoneElse') : t('key.onlyThisPc')}
        <button type="button" class="auth-link" id="auth-use-password" onClick=${onPassword}>${t('key.usePassword')}</button>
      </p>`;
  }
  return html`<div class="auth">
    <main id="main" class="auth-main">
      <div class="auth-panel" aria-labelledby="auth-title">
        <div class="auth-brand"><${Lockup} size=${24} /></div>
        ${body}
      </div>
    </main>
  </div>`;
}

// Pick a username, then the proof of work and the account (one request; it can be cancelled).
function NameForKey({ onCancel, onDone }) {
  return html`<${NameStep} step=${{ owner: false }} onCancel=${onCancel} onDone=${onDone}
    nameProblem=${(n) => (n.length <= 3 ? SHORT_NAME_TEXT : null)}
    check=${(n) => api(`/api/id/check?name=${encodeURIComponent(n)}`)}
    submit=${(n) => api('/api/id/create', { username: n })}
    busyText="Setting up your account… This takes a few seconds."
    onBusyCancel=${() => api('/api/id/cancel', {}).catch(() => {})} />`;
}

// "I lost my other PC": the recovery key, checked as they type it (the check characters catch a typo).
function RecoverStep({ onCancel, onDone }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef();
  useEffect(() => { input.current?.focus(); }, []);
  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim()) { setErr('Type your recovery key.'); return; }
    setBusy(true);
    try { onDone(await api('/api/id/recover', { code })); } catch (x) { setErr(x.message); setBusy(false); input.current?.focus(); }
  };
  return html`
    <div class="auth-head">
      <h1 id="auth-title">Type your recovery key</h1>
      <p class="auth-sub">It’s 36 letters and numbers, in 9 groups of 4. Spaces, dashes and capitals don’t matter.</p>
    </div>
    <form class="form auth-form" onSubmit=${submit} novalidate aria-labelledby="auth-title" aria-busy=${busy ? 'true' : undefined}>
      <div class="auth-field">
        <label class="label" for="auth-recovery">Recovery key</label>
        <textarea id="auth-recovery" ref=${input} class=${`field rk-input${err ? ' bad' : ''}`} rows="2" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120" value=${code}
          aria-invalid=${err ? 'true' : undefined} aria-describedby=${err ? 'auth-recovery-err' : undefined} onInput=${(e) => { setCode(e.target.value); setErr(''); }}></textarea>
        ${err && html`<${Err} id="auth-recovery-err" text=${err} />`}
      </div>
      <button class="btn primary auth-submit" type="submit" id="auth-recover-go" disabled=${busy} aria-busy=${busy ? 'true' : undefined}>${busy ? 'Checking…' : 'Move my account here'}</button>
    </form>
    <p class="auth-fine">Your account moves here after 72 hours, unless your old PC is still on and says yes sooner. Your old PC can also stop it.</p>
    <p class="auth-swap"><button type="button" class="auth-link" onClick=${onCancel}>Back</button></p>`;
}
