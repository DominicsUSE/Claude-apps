// Passkeys for password accounts on a Snug server (v0.12, server/passkeys.js): the sign-in
// button and the username field's autofill, and Settings > Account and security > Passkeys.
// Where they can't work (plain http, an IP address, the desktop app), Settings says why and
// the sign-in screen shows no button: passwords always keep working.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, toast, openModal, closeModal, subscribe } from '../store.js';
import { api } from '../server.js';
import { Icon } from '../ui/icons.js';
import { fmtWhen } from '../lib/util.js';
import { passkeysHere, conditionalAvailable, createPasskey, getPasskey, passkeyProblem } from '../lib/webauthn.js';

const Err = ({ id, text }) => html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${16} /><span>${text}</span></div>`;

// ---------- Signing in ----------
/**
 * The sign-in screen's passkey: { offered, busy, error, start }. While the screen is open, the
 * username field also offers the browser's passkeys (conditional mediation) when it can.
 */
export function usePasskeySignIn(entered, { autofill = true } = {}) {
  const [offered, setOffered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const quiet = useRef(null); // the autofill request in progress: an AbortController
  const live = useRef(true);
  const finish = async (o, cred) => {
    const r = await api('/api/passkey/login', { ticket: o.ticket, credential: cred });
    if (live.current) entered(r.user);
  };
  // The autofill request waits until a passkey is picked. A challenge lasts 5 minutes, so it is renewed before then.
  const listen = async () => {
    quiet.current?.abort();
    const ctl = new AbortController();
    quiet.current = ctl;
    const renew = setTimeout(() => { if (quiet.current === ctl) listen(); }, 4.5 * 60_000);
    let o, cred;
    try {
      o = await api('/api/passkey/options', {});
      cred = await getPasskey(o.options, { conditional: true, signal: ctl.signal });
    } catch { clearTimeout(renew); return; } // a background offer that can't run stays silent; the button still works
    clearTimeout(renew);
    if (!cred || quiet.current !== ctl || !live.current) return;
    setBusy(true);
    try { await finish(o, cred); } catch (e) { if (live.current) { setError(e.message); setBusy(false); } }
  };
  useEffect(() => {
    live.current = true;
    if (passkeysHere()) {
      api('/api/passkey/config').then(async (c) => {
        if (!live.current || !c.ok) return;
        setOffered(true);
        if (autofill && await conditionalAvailable() && live.current) listen();
      }, () => {});
    }
    return () => { live.current = false; quiet.current?.abort(); quiet.current = null; };
  }, []);
  const start = async () => {
    quiet.current?.abort(); // one request at a time
    quiet.current = null;
    setBusy(true); setError('');
    try {
      const o = await api('/api/passkey/options', {});
      const cred = await getPasskey(o.options);
      await finish(o, cred);
    } catch (e) {
      if (!live.current) return;
      setError(e.status ? e.message : passkeyProblem(e));
      setBusy(false);
    }
  };
  return { offered, busy, error, start };
}

// ---------- v0.13: a passkey instead of the password where Snug asks again ----------
// Offered when this account has passkeys and this browser can use them here. The server checks a fresh
// assertion with user verification (server/passkeys.js /api/passkeys/step), once, for this account only.
export const canStepWithPasskey = () => (S.account?.passkeys || 0) > 0 && passkeysHere();
export async function passkeyStep() {
  const s = await api('/api/passkeys/step', {});
  let credential;
  try { credential = await getPasskey(s.options); } catch (x) { throw new Error(passkeyProblem(x)); }
  if (!credential) throw new Error('The passkey wasn’t used. Try again when you’re ready.');
  return { ticket: s.ticket, credential };
}
/** "Use a passkey instead": runs the check, then onProof({ticket, credential}) sends it with the change. */
export function PasskeyStepButton({ onProof, id = 'pk-step', label = 'Use a passkey instead' }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!canStepWithPasskey()) return null;
  const go = async () => {
    setBusy(true); setErr('');
    try { await onProof(await passkeyStep()); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return html`<div class="pk-step">
    <button type="button" class="btn" id=${id} disabled=${busy} aria-busy=${String(busy)} onClick=${go}><${Icon} name="shield" size=${16} />${busy ? 'Waiting for your device…' : label}</button>
    ${err && html`<${Err} id=${`${id}-err`} text=${err} />`}
  </div>`;
}

// v0.13: after a username or name change (on this device or another), tell the passkey provider, so the
// passkey it lists shows the new name. Best effort, only where the browser has signalCurrentUserDetails.
let named = null; // {me, handle, name} last seen
subscribe(() => {
  const u = S.me ? S.users?.[S.me] : null;
  if (!u) { named = null; return; }
  const now = { me: S.me, handle: u.handle, name: u.name };
  const was = named;
  named = now;
  if (!was || was.me !== now.me || (was.handle === now.handle && was.name === now.name)) return;
  if (!S.account?.passkeys || !passkeysHere() || typeof globalThis.PublicKeyCredential?.signalCurrentUserDetails !== 'function') return;
  api('/api/passkeys').then((d) => {
    if (!d.ok || !d.userId || !d.list?.length) return undefined;
    return PublicKeyCredential.signalCurrentUserDetails({ rpId: d.rpId || location.hostname, userId: d.userId, name: now.handle, displayName: now.name || now.handle });
  }).catch(() => { /* not supported, or offline: the provider keeps the old name */ });
});

// ---------- Settings ----------
export function PasskeyRows({ Row }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/api/passkeys').then(setData, (e) => setErr(e.message));
  useEffect(() => { load(); }, [S.account?.passkeys]);
  if (err) return html`<div class="set-head">Passkeys</div><p class="err" role="alert">${err}</p>`;
  if (!data || !data.passwordAccount) return null;
  const browserOk = passkeysHere();
  const add = () => openModal(AddPasskey, { onAdded: load });
  return html`<div class="set-head">Passkeys</div>
    <${Row} label="Sign in with a passkey" hint=${data.ok
      ? 'Your fingerprint, face or device PIN instead of your password. A passkey sign-in skips the two-factor code, because your device already checks it’s you. Your password keeps working.'
      : data.message}>
      ${data.ok && html`<button class="btn" id="pk-add" disabled=${!browserOk || data.list.length >= data.max} onClick=${add}>Add a passkey</button>`}
    <//>
    ${data.ok && !browserOk && html`<p class="hint" role="note">This browser can’t make passkeys.</p>`}
    ${data.list.length > 0 && html`<ul class="acc-sessions" aria-label="Your passkeys" id="pk-list">
      ${data.list.map((p) => html`<li key=${p.id} class="acc-session">
        <span class="row-ic"><${Icon} name="shield" /></span>
        <span class="grow"><b class="pk-name">${p.name}</b><span class="faint">${p.synced ? 'Synced to your other devices' : 'This device only'} · added ${fmtWhen(p.created)}${p.used ? ` · last used ${fmtWhen(p.used)}` : ' · not used yet'}</span></span>
        <button class="btn quiet" aria-label=${`Rename ${p.name}`} onClick=${() => openModal(RenamePasskey, { p, onDone: load })}>Rename</button>
        <button class="btn" aria-label=${`Remove ${p.name}`} onClick=${() => openModal(RemovePasskey, { p, onDone: load })}>Remove</button>
      </li>`)}
    </ul>`}`;
}

function StepUp({ password, setPassword, code, setCode, onPasskey }) {
  return html`
    ${onPasskey && html`<${PasskeyStepButton} onProof=${onPasskey} id="pk-step" />`}
    <div><label class="label" for="pk-pw">Password</label><input id="pk-pw" class="field" type="password" data-autofocus autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} /></div>
    ${S.account?.totp && html`<div><label class="label" for="pk-code">Code from your app, or a backup code</label><input id="pk-code" class="field" autocomplete="one-time-code" value=${code} onInput=${(e) => setCode(e.target.value)} /></div>`}`;
}

function AddPasskey({ onAdded }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const b = await api('/api/passkeys/begin', { password, code });
      let cred;
      try { cred = await createPasskey(b.options); } catch (x) { throw new Error(passkeyProblem(x)); }
      await api('/api/passkeys/finish', { ticket: b.ticket, credential: cred, name });
      closeModal();
      toast('Passkey added. Next time, choose Sign in with a passkey.');
      onAdded?.();
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return html`<form onSubmit=${submit} aria-labelledby="pk-title">
    <h2 id="pk-title">Add a passkey</h2>
    <p class="modal-lead">Your device or password manager will ask for your fingerprint, face or PIN. Snug keeps only the passkey’s public half; it can’t sign in as you with it.</p>
    <div class="form">
      <${StepUp} password=${password} setPassword=${setPassword} code=${code} setCode=${setCode} />
      <div><label class="label" for="pk-name">Name it (optional)</label><input id="pk-name" class="field" maxlength="40" placeholder="Like “Work laptop”" value=${name} onInput=${(e) => setName(e.target.value)} /></div>
      ${err && html`<${Err} id="pk-err" text=${err} />`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" id="pk-go" disabled=${busy || !password}>${busy ? 'Waiting for your device…' : 'Continue'}</button>
    </div>
  </form>`;
}

function RemovePasskey({ p, onDone }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e, passkey) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await api('/api/passkeys/remove', passkey ? { id: p.id, passkey } : { id: p.id, password, code });
      // Best effort: tell the password manager this passkey is gone, so it stops offering it.
      try { await globalThis.PublicKeyCredential?.signalUnknownCredential?.({ rpId: location.hostname, credentialId: p.id }); } catch { /* not supported */ }
      closeModal(); toast('Passkey removed.'); onDone?.();
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return html`<form onSubmit=${submit}>
    <h2>Remove “${p.name}”?</h2>
    <p class="modal-lead">It stops signing you in here. You may also want to delete it from that device or password manager.</p>
    <div class="form"><${StepUp} password=${password} setPassword=${setPassword} code=${code} setCode=${setCode} onPasskey=${(proof) => submit(null, proof)} />${err && html`<${Err} id="pk-rm-err" text=${err} />`}</div>
    <div class="modal-foot"><button type="button" class="btn" onClick=${closeModal}>Cancel</button><button type="submit" class="btn danger" id="pk-rm-go" disabled=${busy || !password}>${busy ? 'Removing…' : 'Remove'}</button></div>
  </form>`;
}

function RenamePasskey({ p, onDone }) {
  const [name, setName] = useState(p.name);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await api('/api/passkeys/rename', { id: p.id, name }); closeModal(); onDone?.(); } catch (x) { setErr(x.message); }
  };
  return html`<form onSubmit=${submit}>
    <h2>Rename passkey</h2>
    <div class="form"><div><label class="label" for="pk-rename">Name</label><input id="pk-rename" class="field" data-autofocus maxlength="40" value=${name} onInput=${(e) => setName(e.target.value)} /></div>${err && html`<${Err} id="pk-rn-err" text=${err} />`}</div>
    <div class="modal-foot"><button type="button" class="btn" onClick=${closeModal}>Cancel</button><button type="submit" class="btn primary" disabled=${!name.trim()}>Save</button></div>
  </form>`;
}
