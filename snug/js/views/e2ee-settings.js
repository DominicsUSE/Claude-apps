// Settings > Encryption: whether end-to-end encryption is on for this device,
// the recovery key, history on new devices, the account's devices, and plain
// words about what it protects and what it doesn't. Listed only when this
// server offers encryption or the account already has keys.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, openModal, closeModal, toast, subscribe } from '../store.js';
import { Icon } from '../ui/icons.js';
import { Switch } from '../ui/kit.js';
import { Confirm } from './modals.js';
import { E2, removeDevice, setHistory, newRecoveryKeyFlow, deviceKind, resetEncryption } from '../e2ee/manager.js';
import { COPY } from '../lib/e2ee/copy.js';
import { SetupSheet, RecoveryKeyScreen } from './e2ee-setup.js';
import { LinkScreen, RecoverScreen } from './e2ee-link.js';

const PAGE = { id: 'e2ee', label: 'Encryption', icon: 'lock', section: 'You', words: 'end-to-end encryption e2ee encrypted keys devices recovery key safety number verify history new device approve browser lock' };
const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
const failText = (e) => (e?.offline ? 'You’re offline. Try again once you’re back.' : e?.message || 'That didn’t work. Try again.');

function Status({ Row }) {
  const st = E2.status;
  if (st === 'unsupported') return html`<p class="e2-warn" role="status"><${Icon} name="alert" size=${16} /><span>${COPY.unsupported[E2.support?.reason] || COPY.unsupported.old}</span></p>`;
  if (st === 'none') {
    return html`<${Row} label="End-to-end encryption" hint=${E2.on ? COPY.setupBody : 'This server hasn’t turned on end-to-end encryption.'}>
      ${E2.on && html`<button class="btn primary" onClick=${() => openModal(SetupSheet, {})}>Turn on</button>`}
    <//>`;
  }
  if (st === 'new-device' || st === 'pending') {
    return html`
      ${E2.notice === 'removed' && html`<p class="e2-warn" role="status"><${Icon} name="alert" size=${16} /><span>This browser’s encryption keys were removed from another device, or encryption was reset.</span></p>`}
      <${Row} label="This browser isn’t added yet" hint=${COPY.pendingBody} top>
        <div class="acc-inline">
          <button class="btn primary" onClick=${() => openModal(LinkScreen, {})}>Use my other device</button>
          <button class="btn" onClick=${() => openModal(RecoverScreen, {})}>Use my recovery key</button>
        </div>
      <//>`;
  }
  return html`<p class="e2-ok" role="status"><${Icon} name="lock" size=${16} /><span>End-to-end encryption is on for this device (${E2.device?.label}).</span></p>`;
}

function Devices({ Row }) {
  const [busy, setBusy] = useState('');
  const list = (E2.me?.devices || []).filter((d) => d.state === 'trusted');
  const mine = E2.device?.d;
  const remove = (d) => openModal(Confirm, {
    title: d.d === mine ? 'Remove this device’s keys?' : `Remove ${d.label}?`,
    text: d.d === mine ? 'This browser stops reading encrypted messages, and its keys are deleted here. Your other devices keep working.' : `${COPY.removeDeviceBody} It is also signed out.`,
    action: 'Remove', danger: true,
    onConfirm: () => { setBusy(d.d); removeDevice(d.d).then(() => toast('Device removed.'), (e) => toast(failText(e))).finally(() => setBusy('')); },
  });
  return html`<div class="detail">
    <h2 class="e2-h2">${COPY.devicesTitle}</h2>
    <ul class="e2-devs" aria-label=${COPY.devicesTitle}>
      ${list.map((d) => html`<li key=${d.d} class="e2-dev">
        <${Icon} name=${d.kind === 'app' ? 'screen' : 'compass'} size=${20} />
        <span class="grow"><b>${d.label}${d.d === mine ? ' (this device)' : ''}</b>
          <span class="hint">${COPY.deviceKind[d.kind]}. Added ${when(d.created)}${d.seen ? `, last used ${when(d.seen)}` : ''}.</span></span>
        ${E2.status === 'ready' && list.length > 1 && html`<button class="btn" disabled=${busy === d.d} onClick=${() => remove(d)}>${COPY.removeDevice}</button>`}
      </li>`)}
    </ul>
    <p class="hint">Removed devices keep what they already had, but get nothing new. People you talk to are told when you add or remove a device.</p>
  </div>`;
}

// Reset (spec 11.8): said plainly before it happens; asks for the password when the sign-in is old.
function ResetSheet() {
  const [busy, setBusy] = useState(false);
  const [needPw, setNeedPw] = useState(false);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const go = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr('');
    try {
      await resetEncryption({ password: needPw ? password : undefined });
      toast(COPY.resetDone);
      openModal(RecoveryKeyScreen, {});
    } catch (x) {
      if (x.code === 'reauth') setNeedPw(true);
      setErr(failText(x));
    }
    setBusy(false);
  };
  return html`<form class="form e2-sheet" onSubmit=${go} aria-labelledby="e2-reset-title">
    <h2 id="e2-reset-title">${COPY.resetTitle}</h2>
    <p class="modal-lead">${COPY.resetBody}</p>
    <p class="hint">${COPY.resetStolen}</p>
    ${needPw && html`<div class="field-group"><label class="label" for="e2-reset-pw">Your password</label>
      <input id="e2-reset-pw" class="field" type="password" autocomplete="current-password" data-autofocus value=${password} onInput=${(x) => setPassword(x.target.value)} /></div>`}
    ${err && html`<p class="err" role="alert">${err}</p>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn danger" disabled=${busy || (needPw && !password)} aria-busy=${String(busy)}>${busy ? 'Resetting…' : COPY.resetAction}</button>
    </div>
  </form>`;
}

function EncryptionPage({ Row }) {
  const [busy, setBusy] = useState(false);
  const ready = E2.status === 'ready';
  const hist = !!E2.me?.hist;
  const flip = (v) => { setBusy(true); setHistory(v).then(() => toast(v ? 'History is on for new devices.' : 'History is off for new devices.'), (e) => toast(failText(e))).finally(() => setBusy(false)); };
  const newKey = () => openModal(Confirm, {
    title: 'Make a new recovery key?', text: 'Your old recovery key stops working. Save the new one somewhere safe.', action: 'Make a new key',
    onConfirm: () => newRecoveryKeyFlow().then(() => openModal(RecoveryKeyScreen, {}), (e) => toast(failText(e))),
  });
  return html`<div class="e2-page">
    <h1>Encryption</h1>
    <p class="lead">Direct messages and groups can be end-to-end encrypted: encrypted on your device and readable only on the devices of the people in them. This server stores them encrypted.</p>
    <${Status} Row=${Row} />
    ${ready && html`
      <${Row} label="Recovery key" hint=${E2.rkSaved ? 'Saved. You confirmed you have it.' : COPY.keyReminder} top>
        <div class="acc-inline">
          ${E2.rk && html`<button class="btn primary" onClick=${() => openModal(RecoveryKeyScreen, {})}>Save your recovery key</button>`}
          <button class="btn" onClick=${newKey}>Make a new recovery key</button>
        </div>
      <//>
      <${Row} label=${COPY.history} hint=${hist ? COPY.historyOnHint : COPY.historyOffHint}>
        <${Switch} on=${hist} label=${COPY.history} disabled=${busy} onChange=${flip} />
      <//>`}
    ${(ready || E2.status === 'pending' || E2.status === 'new-device') && html`<${Devices} Row=${Row} />`}
    ${(ready || E2.status === 'pending' || E2.status === 'new-device') && html`<${Row} label=${COPY.resetTitle} hint=${COPY.resetBody} top>
      <button class="btn danger" onClick=${() => openModal(ResetSheet, {})}>${COPY.resetAction}</button>
    <//>`}
    <div class="detail e2-limits">
      <h2 class="e2-h2">What it does and doesn’t do</h2>
      <ul>
        <li>${COPY.serverSees}</li>
        <li>${COPY.roomsNot}</li>
        ${deviceKind() === 'web' && html`<li>${COPY.browserNote}</li>`}
        <li>${COPY.storageNote}</li>
        <li>Compare safety numbers with the people you talk to (in a conversation’s details) to know nobody put different keys between you.</li>
      </ul>
    </div>
  </div>`;
}

export function registerE2eePage({ PAGES, VIEWS, Row }) {
  VIEWS.e2ee = () => html`<${EncryptionPage} Row=${Row} />`;
  const sync = () => {
    const want = E2.status !== 'off';
    const i = PAGES.findIndex((p) => p.id === 'e2ee');
    if (want && i < 0) PAGES.splice(PAGES.findIndex((p) => p.id === 'privacy') + 1, 0, { ...PAGE });
    else if (!want && i >= 0) PAGES.splice(i, 1);
  };
  subscribe(sync);
  sync();
}
export const e2eeReady = () => S.auth === 'in' && E2.status === 'ready';
