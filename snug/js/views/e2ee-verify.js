// Safety numbers (spec 12): compare the 60 digits with the other person, in
// person or on a call. They come from both account keys only, so they stay the
// same when either of you adds or removes a device, and change after a reset.
// There's no camera scanner: the QR code is the same digits, for comparing
// side by side.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { S, closeModal } from '../store.js';
import { Icon } from '../ui/icons.js';
import { E2, safetyFor, setVerified, acceptChange } from '../e2ee/manager.js';
import { groupsOf5 } from '../lib/e2ee/fingerprint.js';
import { COPY } from '../lib/e2ee/copy.js';
import { QrCode } from './account.js';

export function SafetyNumber({ user }) {
  const u = S.users[user] || { name: 'This person' };
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const load = () => safetyFor(user).then(setS, (e) => setErr(e.message || 'Couldn’t load the keys. Try again.'));
  useEffect(() => { load(); }, [user]);
  const toggle = async () => { await setVerified(user, s.aik, !s.verified); load(); };
  const body = () => {
    if (err) return html`<p class="err" role="alert">${err}</p>`;
    if (!s) return html`<p class="hint" role="status">Loading keys…</p>`;
    if (s.state === 'unknown') return html`<p class="modal-lead">Turn on end-to-end encryption on this device first (Settings, Encryption).</p>`;
    if (s.state === 'not-ready') return html`<p class="modal-lead">${COPY.notReady(u.name)}</p>`;
    return html`
      ${s.state === 'changed' && html`<div class="e2-warn" role="alert"><${Icon} name="alert" size=${16} /><span>${COPY.identityChanged(u.name)}</span></div>`}
      ${s.state === 'rollback' && html`<div class="e2-warn" role="alert"><${Icon} name="alert" size=${16} /><span>The server sent an older list of ${u.name}’s devices than one you’ve seen. Snug ignores it.</span></div>`}
      <p class="modal-lead">${COPY.verifyHow}</p>
      <div class="e2-number" id="e2-safety-number" aria-label=${`Safety number: ${groupsOf5(s.number).join(' ')}`}>
        ${groupsOf5(s.number).map((g, i) => html`<code key=${i}>${g}</code>`)}
      </div>
      <div class="e2-qr-row"><${QrCode} text=${s.number} label="The same safety number as a QR code" /><p class="hint">Or hold your screens side by side: the codes match when the numbers do.</p></div>
      <p class="e2-state" role="status">${s.verified ? html`<${Icon} name="check" size=${16} />${COPY.verified}` : html`<${Icon} name="lock" size=${16} />${COPY.notVerified}`}</p>
      <h3 class="e2-h3">${u.name}’s devices</h3>
      <ul class="e2-devs">${s.devices.map((d, i) => html`<li key=${i}><b>${d.label}</b><span class="hint">${COPY.deviceKind[d.kind]}</span></li>`)}</ul>
      <p class="hint">Messages in this conversation aren’t end-to-end encrypted yet in this version of Snug; these are the keys they will be encrypted to.</p>`;
  };
  const ready = s && (s.state === 'ready' || s.state === 'changed');
  return html`<div class="e2-sheet" aria-labelledby="e2-sn-title">
    <h2 id="e2-sn-title">${COPY.verifyTitle} with ${u.name}</h2>
    ${body()}
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Close</button>
      ${ready && s.state === 'changed' && html`<button class="btn" onClick=${async () => { await acceptChange(user, s.aik, s.ver); load(); }}>I understand</button>`}
      ${ready && html`<button class="btn primary" data-autofocus onClick=${toggle}>${s.verified ? COPY.verifyUnmark : COPY.verifyMark}</button>`}
    </div>
  </div>`;
}

/** Whether the safety number can be shown for a DM: encryption ready here and the conversation isn't P2P. */
export const canVerify = (dm) => E2.status === 'ready' && !!dm && dm.members.every((id) => !S.users[id]?.remote);
