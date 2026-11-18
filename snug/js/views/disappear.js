// Disappearing messages (0.12): the timer button in a conversation's header,
// and the dialog that sets it. The copy says plainly what it can't do.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, convMeta, openModal, closeModal, toast } from '../store.js';
import { call } from '../server.js';
import { can } from '../lib/perms.js';
import { TTL_CHOICES, ttlLabel } from '../lib/expiry.js';
import { Icon } from '../ui/icons.js';
import { remoteOf, isPeerGroup } from './p2p.js';

const ttlOf = (conv) => S.rooms[conv]?.ttl || S.dms[conv]?.ttl || 0;
const isP2p = (conv) => !!remoteOf(conv) || isPeerGroup(conv);

// Who may change it: anyone in a direct conversation or group; in a house,
// people who may manage rooms. Threads follow their conversation.
export function canSetTtl(conv) {
  const meta = convMeta(conv);
  if (!meta || conv.startsWith('t:')) return false;
  if (meta.room) return meta.kind !== 'voice' && can(S, meta.house, 'rooms');
  return !!meta.dm;
}

// The header button: shown while a timer is on, and the way to change it.
export function TtlButton({ conv }) {
  const ttl = ttlOf(conv);
  if (!ttl) return null;
  const label = `Disappearing messages: ${ttlLabel(ttl)}`;
  return html`<button class="ib ttl-btn" aria-label=${label} data-tip=${canSetTtl(conv) ? `${label}. Change` : label}
    aria-haspopup="dialog" onClick=${() => openTtl(conv)}><${Icon} name="clock" size=${18} /><span class="ttl-btn-text num">${ttlLabel(ttl)}</span></button>`;
}

// For the header's More menu.
export const ttlMenuItem = (conv) => (canSetTtl(conv) || ttlOf(conv)) && {
  label: ttlOf(conv) ? `Disappearing messages (${ttlLabel(ttlOf(conv))})` : 'Disappearing messages', icon: 'clock', onSelect: () => openTtl(conv),
};

export const openTtl = (conv) => openModal(TtlDialog, { conv });

function TtlDialog({ conv }) {
  const meta = convMeta(conv);
  const now = ttlOf(conv);
  const [pick, setPick] = useState(now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allowed = canSetTtl(conv);
  // In P2P, every friend's PC must know how to remove messages first (the server says which can't).
  const blocked = S.dms[conv]?.ttlBlocked;
  const save = (e) => {
    e.preventDefault();
    if (pick === now) return closeModal();
    setBusy(true);
    call('conv.ttl', { conv, ttl: pick }).then(() => {
      closeModal();
      toast(pick ? `New messages disappear after ${ttlLabel(pick).replace(/^1 /, 'one ')}.` : 'Disappearing messages are off. New messages stay.');
    }, (x) => { setBusy(false); setError(x.offline ? 'You’re offline. Try again once you’re back.' : x.message); });
    return undefined;
  };
  return html`<form class="form ttl-form" onSubmit=${save} novalidate>
    <h2>Disappearing messages</h2>
    <p class="modal-lead">New messages ${meta?.room ? 'in this room' : 'in this conversation'} are removed after the time you pick, for everyone in it.
      Messages already sent keep the timer they were sent with.</p>
    <fieldset class="ttl-choices" disabled=${!allowed || !!blocked}>
      <legend class="label">Remove new messages after</legend>
      ${TTL_CHOICES.map(([v, label]) => html`<label key=${v} class=${`ttl-choice${pick === v ? ' sel' : ''}`}>
        <input type="radio" name="ttl" value=${v} checked=${pick === v} onChange=${() => { setPick(v); setError(''); }} />${label}
      </label>`)}
    </fieldset>
    <ul class="ttl-limits">
      <li>People can still copy or screenshot a message before it goes.</li>
      ${isP2p(conv)
        ? html`<li>Copies on your friends’ PCs are removed when those PCs get the message and its timer. A PC that is off removes it once it’s back on and has caught up.</li>
          <li>Each PC’s encrypted daily backup of its data can keep a copy for up to a week.</li>`
        : html`<li>The server’s encrypted daily backups can keep a copy for up to a week. Whoever runs this server could read messages before they go.</li>`}
    </ul>
    ${!allowed && html`<p class="hint" role="note">${meta?.room ? 'Only people who can manage rooms change this here.' : 'You can’t change this here.'}</p>`}
    ${blocked && html`<p class="hint" role="note">${blocked}</p>`}
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>${allowed && !blocked ? 'Cancel' : 'Close'}</button>
      ${allowed && !blocked && html`<button type="submit" class="btn primary" aria-busy=${busy ? 'true' : undefined} disabled=${busy}>Save</button>`}
    </div>
  </form>`;
}
