// End-to-end encryption in a conversation, on screen: the label in a direct
// conversation's header and details, what an encrypted message shows while
// it is opened or if it can't be, the line where a conversation turned
// encrypted, and the honest labels for rooms and P2P conversations
// (the v0.12 e2ee spec, section 16.4). Wording lives in js/lib/e2ee/copy.js.
import { html } from '../../vendor/preact-htm.js';
import { S, openModal } from '../store.js';
import { Icon } from '../ui/icons.js';
import { COPY } from '../lib/e2ee/copy.js';
import { E2 } from '../e2ee/manager.js';
import { isEncrypted, rootDm, changed } from '../e2ee/conv.js';
import { SafetyNumber, canVerify } from './e2ee-verify.js';

const firstName = (id) => S.users[id]?.name.split(' ')[0] || 'Someone';
const remoteDm = (dm) => dm.members.some((id) => S.users[id]?.remote);

/** The state of a direct conversation: 'on' | 'off' | 'p2p' | null (server without encryption). */
export function encState(conv) {
  const dm = S.dms[rootDm(conv)];
  if (!dm) return null;
  if (remoteDm(dm)) return 'p2p';
  if (dm.e2ee) return 'on';
  return E2.status === 'off' && !E2.on ? null : 'off';
}

/** A small label beside a direct conversation's title; opens Details. */
export function EncLabel({ conv, onOpen }) {
  const st = encState(conv);
  if (!st || st === 'p2p') return null;
  const on = st === 'on';
  return html`<button class=${`e2-label${on ? ' on' : ''}`} onClick=${onOpen} data-tip=${on ? COPY.convPanel : notOnText(S.dms[rootDm(conv)])}
    aria-label=${on ? `${COPY.convOn}. Details` : `${COPY.convNotOn}. Details`}>
    <${Icon} name=${on ? 'lock' : 'unlock'} size=${14} /><span>${on ? COPY.convOn : COPY.convNotOn}</span>
  </button>`;
}
function notOnText(dm) {
  if (!dm) return COPY.convOff;
  if (E2.status !== 'ready') return COPY.convNotYou;
  const waiting = dm.members.filter((id) => id !== S.me);
  return COPY.convNot(waiting.map(firstName).join(', '), waiting.length > 1);
}

/** Encryption in a direct conversation's details (replaces the step-4 note). */
export function EncDetail({ dm }) {
  const st = encState(dm.id);
  if (!st) return null;
  const others = dm.members.filter((id) => id !== S.me);
  if (st === 'p2p') {
    return html`<div class="detail e2-detail"><h3>Encryption</h3><p class="hint" style="margin:0">${COPY.p2p(firstName(others[0]))}</p></div>`;
  }
  const inBrowser = !(window.snugApp && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname));
  return html`<div class="detail e2-detail">
    <h3><${Icon} name=${st === 'on' ? 'lock' : 'unlock'} size=${16} />${st === 'on' ? COPY.convOn : COPY.convNotOn}</h3>
    <p class="hint" style="margin:0">${st === 'on' ? COPY.convPanel : notOnText(dm)}</p>
    ${st === 'on' && inBrowser && html`<p class="hint" style="margin:0">${COPY.browserNote}</p>`}
    ${st === 'on' && dm.group && html`<p class="hint" style="margin:0">${COPY.joinedNote}</p>`}
    ${others.filter((id) => changed.has(id)).map((id) => html`<p class="e2-warn" role="alert" key=${id}><${Icon} name="alert" size=${16} /><span>${COPY.changedLine(S.users[id]?.name || 'Someone')}</span></p>`)}
    ${canVerify(dm) && html`<div class="e2-detail-people">${others.map((id) => html`<button class="btn" key=${id} onClick=${() => openModal(SafetyNumber, { user: id })}>
      <${Icon} name="lock" size=${16} />Safety number${others.length > 1 ? ` with ${firstName(id)}` : ''}</button>`)}</div>`}
  </div>`;
}

/** A room's details: rooms are never end-to-end encrypted, and the page says so. */
export const RoomEncNote = () => html`<p class="hint e2-room-note" style="margin:0">${COPY.roomsNot}</p>`;

/** What an encrypted message shows until it is open, or if it can't be. Null once it is. */
export function EncBody({ m }) {
  if (!m.e2ee || m.enc === true) return null;
  const text = m.enc === 'failed' ? COPY.cantDecrypt : m.enc === 'locked' ? COPY.locked : COPY.decrypting;
  return html`<div class=${`msg-text e2-msg ${m.enc || 'pending'}`} role=${m.enc === 'failed' ? 'note' : 'status'}>
    <${Icon} name=${m.enc === 'failed' ? 'alert' : 'lock'} size=${14} /><span>${text}</span>
  </div>`;
}
/** The text a quote, notification or list shows for a message that may be encrypted. */
export const quoteText = (m, plain) => (m?.e2ee && m.enc !== true ? COPY.encryptedQuote : plain);

/** Message menu lines: a legacy message says it isn't encrypted; a failed one says why. */
export function encMenuItems(conv, m) {
  if (m.legacy) return [{ label: COPY.legacyItem, icon: 'unlock', disabled: true, onSelect: () => {} }];
  if (m.e2ee && m.enc === 'failed') return [{ label: `Couldn’t decrypt: ${COPY.why[m.encWhy] || m.encWhy}`, icon: 'alert', disabled: true, onSelect: () => {} }];
  if (m.e2ee && m.enc === true && m.encFlags?.includes('mentions')) return [{ label: 'Its mentions don’t match what the server was told', icon: 'alert', disabled: true, onSelect: () => {} }];
  return [];
}

/** Under the composer of an encrypted conversation: what isn't made here. */
export function EncComposerNote({ conv }) {
  if (!isEncrypted(conv)) return null;
  return html`<p class="e2-compose-note hint"><${Icon} name="lock" size=${12} />${COPY.convOn}. ${COPY.previewsOff}</p>`;
}

/** The server line written when a conversation turned encrypted (server/e2ee-conv.js). */
export function EncLine({ m }) {
  return html`<div class="joinline dmline e2-line" role="note" data-mid=${m.id}>
    <span class="dmline-ic" aria-hidden="true"><${Icon} name="lock" size=${16} /></span>
    <span class="joinline-text">${m.dmLine?.legacy ? html`${COPY.legacyLine} ${COPY.onLine}` : COPY.onLine}</span>
  </div>`;
}
