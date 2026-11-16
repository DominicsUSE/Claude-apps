// Adding a device to an account that already uses end-to-end encryption:
// on the new device, with the code another device shows or with the recovery
// key; on a trusted device, approving the request and showing the code.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { closeModal, openModal, toast } from '../store.js';
import { Icon } from '../ui/icons.js';
import { E2, startLink, submitCode, recover, currentDevices, approveAsk, rejectLink, clearApproval, dismissPrompt } from '../e2ee/manager.js';
import { COPY } from '../lib/e2ee/copy.js';
import { RecoveryKeyScreen } from './e2ee-setup.js'; // a new recovery key after leaving devices out (cycle-safe: used only when drawing)

const failText = (e) => (e?.offline ? 'You’re offline. Try again once you’re back.' : e?.message || 'That didn’t work. Try again.');
const Err = ({ text, id }) => text && html`<div class="err" id=${id} role="alert"><${Icon} name="alert" size=${14} />${text}</div>`;

// On a browser that isn't added yet.
export function NewDeviceSheet() {
  return html`<div class="e2-sheet" aria-labelledby="e2-new-title">
    <div class="e2-mark" aria-hidden="true"><${Icon} name="lock" size=${24} /></div>
    <h2 id="e2-new-title">Add this browser to read encrypted messages</h2>
    <p class="modal-lead">Your account uses end-to-end encryption. Everything else works here already; to read encrypted messages, approve this browser from a device you’ve already set up, or use your recovery key.</p>
    <div class="e2-choices">
      <button class="btn e2-choice" data-autofocus onClick=${() => openModal(LinkScreen, {})}><${Icon} name="screen" size=${20} /><span><b>Use my other device</b><span class="hint">It shows a code; you type it here.</span></span></button>
      <button class="btn e2-choice" onClick=${() => openModal(RecoverScreen, {})}><${Icon} name="keys" size=${20} /><span><b>Use my recovery key</b><span class="hint">The key you saved when you turned encryption on.</span></span></button>
    </div>
    <div class="modal-foot"><button class="btn" onClick=${() => { dismissPrompt(); closeModal(); }}>Not now</button></div>
  </div>`;
}

// The new device: type the code from the trusted one.
export function LinkScreen() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const step = E2.link?.step;
  const begin = () => { setErr(''); startLink().catch((e) => setErr(failText(e))); };
  useEffect(() => { if (!E2.link || !['type', 'waiting'].includes(E2.link.step)) begin(); }, []);
  const send = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await submitCode(code); } catch (x) { setErr(failText(x)); }
    setBusy(false);
  };
  if (step === 'done') {
    return html`<div class="e2-sheet"><h2>This browser is added</h2><p class="modal-lead">${COPY.linkDone}</p>
      <div class="modal-foot"><button class="btn primary" data-autofocus onClick=${closeModal}>Done</button></div></div>`;
  }
  if (step === 'cancelled' || step === 'expired' || step === 'restart') {
    return html`<div class="e2-sheet"><h2>That didn’t go through</h2>
      <p class="modal-lead" role="alert">${step === 'expired' ? 'The request ran out after ten minutes.' : E2.link.error || COPY.linkMismatch}</p>
      <div class="modal-foot"><button class="btn" onClick=${closeModal}>Close</button><button class="btn primary" data-autofocus onClick=${begin}>Start again</button></div></div>`;
  }
  return html`<form class="form e2-sheet" onSubmit=${send} aria-labelledby="e2-link-title">
    <h2 id="e2-link-title">Approve from your other device</h2>
    <ol class="e2-steps">
      <li>Open Snug on a phone or computer where encryption is already set up.</li>
      <li>It asks whether to approve <b>${E2.device?.label || 'this browser'}</b>. Choose Approve.</li>
      <li>${COPY.linkTypeCode}</li>
    </ol>
    <div>
      <label class="label" for="e2-code">Code</label>
      <input id="e2-code" class="field e2-code-field" data-autofocus autocomplete="one-time-code" spellcheck="false" placeholder="XXXX-XXXX-XXXX" maxlength="16"
        value=${code} onInput=${(e) => { setCode(e.target.value); setErr(''); }} disabled=${step === 'waiting'} aria-describedby="e2-code-msg" />
      ${err ? html`<${Err} text=${err} id="e2-code-msg" />` : html`<div class="hint" id="e2-code-msg" role="status">${step === 'waiting' ? 'Waiting for your other device to finish…' : 'You get one try per code.'}</div>`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Close</button>
      <button type="submit" class="btn primary" disabled=${busy || step !== 'type' || code.replace(/[\s-]/g, '').length !== 12}>Add this browser</button>
    </div>
  </form>`;
}

// The new device: the recovery key (and, if the sign-in is old, the password).
export function RecoverScreen() {
  const [key, setKey] = useState('');
  const [password, setPassword] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const [devices, setDevices] = useState(null);
  const [keep, setKeep] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { currentDevices().then((d) => { setDevices(d); setKeep(d.map((x) => x.d)); }, () => setDevices([])); }, []);
  const go = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await recover(key, { password: needPw ? password : undefined, keep });
      setDone(true);
    } catch (x) {
      if (x.code === 'reauth') setNeedPw(true);
      setErr(failText(x));
    }
    setBusy(false);
  };
  if (done) {
    // Devices left out were treated as lost: a new recovery key was made, to save now.
    const fresh = E2.rk?.fresh;
    return html`<div class="e2-sheet"><h2>Encryption is back on this device</h2><p class="modal-lead">${COPY.recoverDone}</p>
      ${fresh && html`<p class="hint">You left devices out, so your recovery key was replaced: the old one no longer opens your backup. Save the new one.</p>`}
      <div class="modal-foot">${fresh
        ? html`<button class="btn primary" data-autofocus onClick=${() => openModal(RecoveryKeyScreen, {})}>Save your new recovery key</button>`
        : html`<button class="btn primary" data-autofocus onClick=${closeModal}>Done</button>`}</div></div>`;
  }
  const toggle = (d) => setKeep((k) => (k.includes(d) ? k.filter((x) => x !== d) : [...k, d]));
  return html`<form class="form e2-sheet" onSubmit=${go} aria-labelledby="e2-rec-title">
    <h2 id="e2-rec-title">${COPY.recoverTitle}</h2>
    <p class="modal-lead">${COPY.recoverBody}</p>
    <div>
      <label class="label" for="e2-rk-in">Recovery key</label>
      <textarea id="e2-rk-in" class="field e2-key-field" data-autofocus rows="2" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH-IJKL-…"
        value=${key} onInput=${(e) => { setKey(e.target.value); setErr(''); }}></textarea>
    </div>
    ${needPw && html`<div>
      <label class="label" for="e2-rk-pw">Your password</label>
      <input id="e2-rk-pw" class="field" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} />
      <div class="hint">You signed in a while ago, so Snug checks it’s you before opening your keys.</div>
    </div>`}
    ${devices?.length > 0 && html`<fieldset class="e2-keep">
      <legend class="label">Keep these devices</legend>
      <p class="hint">Untick any device you’ve lost or no longer use. It stops getting new encrypted messages.</p>
      ${devices.map((x) => html`<label class="e2-check" key=${x.d}><input type="checkbox" checked=${keep?.includes(x.d)} onChange=${() => toggle(x.d)} /><span><b>${x.label}</b><span class="hint">${COPY.deviceKind[x.kind]}</span></span></label>`)}
    </fieldset>`}
    <${Err} text=${err} />
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Close</button>
      <button type="submit" class="btn primary" disabled=${busy || !key.trim() || (needPw && !password)}>${busy ? 'Opening your keys…' : 'Use recovery key'}</button>
    </div>
  </form>`;
}

// A trusted device: someone (hopefully you) wants to add a device.
export function ApproveSheet() {
  const a = E2.approvals[0];
  const [err, setErr] = useState('');
  if (!a) return html`<div class="e2-sheet"><h2>Nothing to approve</h2><div class="modal-foot"><button class="btn primary" onClick=${closeModal}>Close</button></div></div>`;
  const finish = () => { clearApproval(a.linkId); closeModal(); };
  if (a.step === 'ask') {
    return html`<div class="e2-sheet" aria-labelledby="e2-ap-title">
      <div class="e2-mark" aria-hidden="true"><${Icon} name="lock" size=${24} /></div>
      <h2 id="e2-ap-title">${COPY.linkApprove(a.label)}</h2>
      <p class="modal-lead">Approve only a device you’re holding now. It will be able to read your encrypted messages${E2.me?.hist ? ', including history' : ''}.</p>
      <p class="hint">${COPY.deviceKind[a.kind]}. Asked at ${new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
      <${Err} text=${err} />
      <div class="modal-foot">
        <button class="btn" onClick=${() => { rejectLink(a.linkId); closeModal(); toast('Request turned down.'); }}>Not me</button>
        <button class="btn primary" data-autofocus onClick=${() => approveAsk(a.linkId).catch((e) => setErr(failText(e)))}>Approve</button>
      </div>
    </div>`;
  }
  if (a.step === 'code' || a.step === 'adding') {
    return html`<div class="e2-sheet" aria-labelledby="e2-ap-code">
      <h2 id="e2-ap-code">Type this code on ${a.label}</h2>
      <p class="e2-code" id="e2-link-code" aria-label=${`Code: ${a.code.split('').join(' ')}`}>${a.code}</p>
      <p class="modal-lead">${COPY.linkShowCode}</p>
      <p class="hint" role="status">${a.step === 'adding' ? 'Adding the device…' : 'Waiting for the code to be typed…'}</p>
      <div class="modal-foot"><button class="btn" onClick=${() => { rejectLink(a.linkId); closeModal(); }}>Cancel</button></div>
    </div>`;
  }
  const text = a.step === 'done' ? `${a.label} can now read your encrypted messages.` : a.step === 'mismatch' ? 'The code typed on the new device didn’t match, so the request was cancelled. If that wasn’t you, nothing was added.' : 'The request was cancelled.';
  return html`<div class="e2-sheet"><h2>${a.step === 'done' ? 'Device added' : 'Not added'}</h2><p class="modal-lead" role=${a.step === 'done' ? 'status' : 'alert'}>${text}</p>
    <div class="modal-foot"><button class="btn primary" data-autofocus onClick=${finish}>Done</button></div></div>`;
}
