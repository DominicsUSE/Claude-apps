// Signing out another session (Settings > Account > Devices): when that
// session belongs to a device with end-to-end encryption keys, also remove its
// keys, ticked by default (spec 11.7). Signed out but still trusted, a lost
// device would keep receiving messages for whoever finds it signed in again.
import { html, useState } from '../../vendor/preact-htm.js';
import { closeModal, toast } from '../store.js';
import { call } from '../server.js';
import { E2, removeDevice } from '../e2ee/manager.js';

/** Whether a session (from sessions.list) has encryption keys this device could remove. */
export const hasKeys = (s) => !!s.e2eeDevice && E2.status === 'ready' && s.e2eeDevice !== E2.device?.d
  && (E2.me?.devices || []).some((d) => d.d === s.e2eeDevice && d.state === 'trusted');

export function RevokeSheet({ session, done }) {
  const [keys, setKeys] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await call('sessions.revoke', { id: session.id });
      if (keys) await removeDevice(session.e2eeDevice);
      toast(keys ? 'That device is signed out and its encryption keys are removed.' : 'That device is signed out.');
      closeModal();
      done?.();
    } catch (e) { toast(e.message); setBusy(false); }
  };
  return html`<div class="e2-sheet">
    <h2>Sign out ${session.agent}?</h2>
    <label class="e2-check"><input type="checkbox" checked=${keys} onChange=${(e) => setKeys(e.target.checked)} />
      <span><b>Also remove its encryption keys</b><span class="hint">Recommended if the device is lost. It keeps what it already had, but gets no new encrypted messages.</span></span></label>
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn danger solid" disabled=${busy} aria-busy=${String(busy)} onClick=${go}>Sign out</button>
    </div>
  </div>`;
}
