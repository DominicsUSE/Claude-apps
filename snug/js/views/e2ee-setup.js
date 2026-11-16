// Turning on end-to-end encryption (the first-run sheet) and the recovery-key
// screen, plus E2eeHost: the one place that opens encryption sheets when the
// manager asks (setup on first sign-in, adding this browser, approving a new
// device), so they never stack over another dialog.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { S, closeModal, openModal, openLayer, toast, me } from '../store.js';
import { Icon } from '../ui/icons.js';
import { copyText } from '../ui/kit.js';
import { E2, setup, confirmRecoveryKey, dismissPrompt, deviceKind, invitePending, ownAlerts, ackOwnAlert } from '../e2ee/manager.js';
import { settingsLayerOf } from './appearance.js';
import { COPY } from '../lib/e2ee/copy.js';
import { recoveryFileText } from '../lib/recovery.js';
import { NewDeviceSheet, ApproveSheet } from './e2ee-link.js';

const failText = (e) => (e?.offline ? 'You’re offline. Try again once you’re back.' : e?.message || 'That didn’t work. Try again.');

export function E2eeHost() {
  const want = E2.prompt;
  useEffect(() => {
    if (!want || S.ui.modal) return;
    const C = { setup: SetupSheet, 'new-device': NewDeviceSheet, 'recovery-key': RecoveryKeyScreen, approve: ApproveSheet }[want];
    E2.prompt = null;
    if (C) openModal(C, {});
  });
  return null;
}

// A device added to this account by something other than this device (review H3, second pass):
// over everything, on every other device, until the person says it's theirs or goes to remove it.
export function OwnAddedAlert() {
  const list = E2.status === 'ready' ? ownAlerts() : [];
  if (!list.length) return null;
  const e = list[0];
  const review = () => { const C = settingsLayerOf(); if (C) openLayer({ C, props: { page: 'e2ee' } }); };
  return html`<div class="e2-warn e2-own-added" role="alert">
    <${Icon} name="alert" size=${16} /><span class="grow">${COPY.ownAdded(e.label || 'a new device')}</span>
    <button class="btn sm" onClick=${() => ackOwnAlert(e.id)}>${COPY.ownAddedMine}</button>
    <button class="btn sm danger" onClick=${review}>${COPY.ownAddedReview}</button>
  </div>`;
}

// Above the direct messages while the account hasn't turned encryption on: the offer, without interrupting.
// "Not now" puts it away on this device; a conversation's details and Settings > Encryption still offer it.
export function EncInvite() {
  if (!invitePending()) return null;
  return html`<section class="e2-invite" aria-labelledby="e2-invite-title">
    <span class="e2-invite-ic" aria-hidden="true"><${Icon} name="lock" size=${16} /></span>
    <div class="e2-invite-body">
      <h3 id="e2-invite-title">${COPY.inviteTitle}</h3>
      <p class="hint">${COPY.inviteBody}</p>
      <div class="e2-invite-acts">
        <button class="btn sm primary" onClick=${() => openModal(SetupSheet, {})}>${COPY.setupOn}</button>
        <button class="btn sm ghost" onClick=${() => dismissPrompt()}>Not now</button>
      </div>
    </div>
  </section>`;
}

// Turning encryption on: from the invitation, a conversation's details or Settings > Encryption.
export function SetupSheet() {
  const [history, setHistory] = useState(true);
  const [have, setHave] = useState(false);
  const [existing, setExisting] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const web = deviceKind() === 'web';
  const turnOn = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await setup({ history, existing: have ? existing : null });
      dismissPrompt();
      if (r.recoveryKey) openModal(RecoveryKeyScreen, {});
      else { closeModal(); toast('End-to-end encryption is on.'); }
    } catch (x) { setErr(failText(x)); setBusy(false); }
  };
  const notHere = () => { dismissPrompt(true); closeModal(); toast(COPY.setupLater); };
  return html`<form class="form e2-sheet" onSubmit=${turnOn} aria-labelledby="e2-setup-title">
    <div class="e2-mark" aria-hidden="true"><${Icon} name="lock" size=${24} /></div>
    <h2 id="e2-setup-title">${COPY.setupTitle}</h2>
    <p class="modal-lead">${COPY.setupBody}</p>
    <p class="hint">${COPY.setupStill}</p>
    ${web && html`<p class="hint">${COPY.browserNote}</p>`}
    <label class="e2-check">
      <input type="checkbox" checked=${history} onChange=${(e) => setHistory(e.target.checked)} />
      <span><b>${COPY.history}</b><span class="hint">${history ? COPY.historyOnHint : COPY.historyOffHint}</span></span>
    </label>
    <label class="e2-check">
      <input type="checkbox" checked=${have} onChange=${(e) => setHave(e.target.checked)} />
      <span><b>I already have a Snug recovery key</b><span class="hint">Use it here too, instead of saving a second one.</span></span>
    </label>
    ${have && html`<div>
      <label class="label" for="e2-existing">Your recovery key</label>
      <input id="e2-existing" class="field e2-key-field" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH-…" value=${existing} onInput=${(e) => setExisting(e.target.value)} />
    </div>`}
    ${err && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${err}</div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${notHere} disabled=${busy}>${COPY.setupNotHere}</button>
      <button type="submit" class="btn primary" data-autofocus disabled=${busy}>${busy ? COPY.setupBusy : COPY.setupOn}</button>
    </div>
  </form>`;
}

// The recovery key, shown once; typed back to confirm. "Later" keeps it (on this device only) for Settings.
export function RecoveryKeyScreen() {
  const [last, setLast] = useState('');
  const [err, setErr] = useState('');
  const rk = E2.rk;
  if (!rk) return html`<h2>${COPY.keyTitle}</h2><p class="modal-lead">You’ve already confirmed your recovery key.</p><div class="modal-foot"><button class="btn primary" onClick=${closeModal}>Done</button></div>`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([recoveryFileText({ text: rk.text, username: me().handle })], { type: 'text/plain' }));
    a.download = 'snug-recovery-key.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const done = async (e) => {
    e.preventDefault();
    if (await confirmRecoveryKey(last)) { closeModal(); toast('Recovery key saved. End-to-end encryption is on.'); } else setErr(COPY.keyConfirmWrong);
  };
  return html`<form class="form e2-sheet" onSubmit=${done} aria-labelledby="e2-key-title">
    <h2 id="e2-key-title">${COPY.keyTitle}</h2>
    <p class="modal-lead">${COPY.keyWhy}</p>
    <div class="e2-rk secret" aria-label="Your recovery key" id="e2-recovery-key">${rk.text.split('-').map((g, i) => html`<code key=${i}>${g}</code>`)}</div>
    <div class="acc-inline">
      <button type="button" class="btn" onClick=${() => copyText(rk.text)}><${Icon} name="copy" size=${16} />Copy</button>
      <button type="button" class="btn" onClick=${download}><${Icon} name="file" size=${16} />Download</button>
    </div>
    <p class="hint">${COPY.keyKeep}</p>
    <div>
      <label class="label" for="e2-last">${COPY.keyConfirm}</label>
      <input id="e2-last" class=${`field e2-last${err ? ' bad' : ''}`} maxlength="4" autocomplete="off" spellcheck="false" aria-invalid=${String(!!err)} aria-describedby="e2-last-msg"
        value=${last} onInput=${(e) => { setLast(e.target.value); setErr(''); }} />
      ${err ? html`<div class="err" id="e2-last-msg" role="alert"><${Icon} name="alert" size=${14} />${err}</div>` : html`<div class="hint" id="e2-last-msg">Four letters or numbers.</div>`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${() => { closeModal(); toast(COPY.keyReminder); }}>${COPY.keyLater}</button>
      <button type="submit" class="btn primary" disabled=${last.trim().length !== 4}>${COPY.keyDone}</button>
    </div>
  </form>`;
}
