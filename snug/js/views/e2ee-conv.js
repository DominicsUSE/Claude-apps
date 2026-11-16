// End-to-end encryption in a conversation, on screen: the label in a direct
// conversation's header and details, what an encrypted message shows while
// it is opened or if it can't be, the line where a conversation turned
// encrypted, and the honest labels for rooms and P2P conversations
// (the v0.12 e2ee spec, section 16.4). Wording lives in js/lib/e2ee/copy.js.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, openModal } from '../store.js';
import { Icon } from '../ui/icons.js';
import { COPY } from '../lib/e2ee/copy.js';
import { E2, builtInCode } from '../e2ee/manager.js';
import { isEncrypted, rootDm, changed, sendGate, downgraded, unsealed, beforeEncryption, encryptedSince } from '../e2ee/conv.js';
import { acceptChange } from '../e2ee/manager.js';
import { SafetyNumber, canVerify } from './e2ee-verify.js';
import { SetupSheet } from './e2ee-setup.js';

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
  const inBrowser = !builtInCode();
  return html`<div class="detail e2-detail">
    <h3><${Icon} name=${st === 'on' ? 'lock' : 'unlock'} size=${16} />${st === 'on' ? COPY.convOn : COPY.convNotOn}</h3>
    <p class="hint" style="margin:0">${st === 'on' ? COPY.convPanel : notOnText(dm)}</p>
    ${st === 'off' && E2.status === 'none' && E2.on && html`<div><button class="btn sm primary" onClick=${() => openModal(SetupSheet, {})}><${Icon} name="lock" size=${14} />${COPY.setupOn}</button></div>`}
    ${st === 'on' && inBrowser && html`<p class="hint" style="margin:0">${COPY.browserNote}</p>`}
    ${st === 'on' && dm.group && html`<p class="hint" style="margin:0">${COPY.joinedNote}</p>`}
    ${others.filter((id) => changed.has(id)).map((id) => html`<p class="e2-warn" role="alert" key=${id}><${Icon} name="alert" size=${16} /><span>${COPY.changedLine(S.users[id]?.name || 'Someone')}</span></p>`)}
    ${canVerify(dm) && html`<div class="e2-detail-people">${others.map((id) => html`<button class="btn" key=${id} onClick=${() => openModal(SafetyNumber, { user: id })}>
      <${Icon} name="lock" size=${16} />Safety number${others.length > 1 ? ` with ${firstName(id)}` : ''}</button>`)}</div>`}
  </div>`;
}

/** Rooms are never end-to-end encrypted: on a server that offers encryption, a room's details and a house's About say so. */
export const RoomEncNote = () => (E2.status === 'off' && !E2.on ? null : html`<p class="hint e2-room-note" style="margin:0">${COPY.roomsNot}</p>`);

// Above a room's composer, once per device, where encryption is offered: rooms aren't end-to-end encrypted.
const ROOM_HINT = 'snug-e2ee-room-hint';
const hintGone = () => { try { return localStorage.getItem(ROOM_HINT) === '1'; } catch { return false; } };
export function RoomComposerHint({ conv }) {
  const [gone, setGone] = useState(hintGone);
  if (gone || !S.rooms[conv] || (E2.status === 'off' && !E2.on)) return null;
  const done = () => { try { localStorage.setItem(ROOM_HINT, '1'); } catch { /* storage off: gone for now */ } setGone(true); };
  return html`<p class="e2-room-hint hint" role="note"><${Icon} name="unlock" size=${12} /><span class="grow">${COPY.roomsNot}</span>
    <button type="button" class="btn sm ghost" onClick=${done}>Got it</button></p>`;
}

/** On a line the server writes (calls, people added or leaving, renames) in an encrypted conversation: it isn't encrypted. */
export function ServerNoteMark({ conv }) {
  if (!conv || !isEncrypted(conv)) return null;
  return html`<span class="e2-note-mark" role="img" aria-label=${COPY.serverNote} data-tip=${COPY.serverNote}><${Icon} name="unlock" size=${12} /></span>`;
}

/** What an encrypted message shows until it is open, or if it can't be. Null once it is. */
export function EncBody({ m }) {
  if (!m.e2ee || m.enc === true) return null;
  const text = m.enc === 'failed' ? COPY.cantDecrypt : m.enc === 'locked' ? COPY.locked : COPY.decrypting;
  return html`<div class=${`msg-text e2-msg ${m.enc || 'pending'}`} role=${m.enc === 'failed' ? 'note' : 'status'}>
    <${Icon} name=${m.enc === 'failed' ? 'alert' : 'lock'} size=${14} /><span>${text}</span>
  </div>`;
}
/** The text a quote, notification or list shows for a message that may be encrypted. */
export const quoteText = (m, plain, conv) => (m?.e2ee && m.enc !== true ? COPY.encryptedQuote : conv && unsealed(conv, m) ? COPY.unsealed : plain);

/**
 * A message in an encrypted conversation that came without an envelope (review H2): shown, but
 * marked as not encrypted and delivered by the server, so nobody takes it for the other person's.
 */
export function UnsealedMark({ conv, m }) {
  if (!unsealed(conv, m)) return null;
  return html`<div class="e2-warn e2-unsealed" role="note" data-tip=${COPY.unsealedHint}><${Icon} name="unlock" size=${14} /><span>${COPY.unsealed}</span></div>`;
}
export { unsealed };

/** A message sealed by a device its author has since removed (review L4): said on the message itself. */
export function RemovedDeviceMark({ m }) {
  if (!m?.e2ee || m.enc !== true || !m.encFlags?.includes('removed-device')) return null;
  return html`<div class="e2-warn e2-removed-dev" role="note"><${Icon} name="alert" size=${14} /><span>${COPY.removedDeviceItem(firstName(m.author))}</span></div>`;
}

/**
 * Lines this device writes into an encrypted conversation (spec 12.3, review M4): a member's safety
 * number changed, or they added or removed a device. Kept on this device (sealed), placed by time.
 */
// In the conversation and its threads; a change from before the first loaded message is pinned at the
// top of what is loaded (review M4, second pass), so scrolling never hides that it happened.
export function withKeyLines(conv, items) {
  const dm = S.dms[rootDm(conv)];
  if (!dm || encryptedSince(conv) == null || !E2.events?.length) return items;
  const lines = E2.events.filter((e) => e.u !== S.me && dm.members.includes(e.u)).sort((a, b) => a.ts - b.ts);
  if (!lines.length) return items;
  const msgs = items.filter((it) => it.type === 'msg');
  const first = msgs[0]?.m.ts ?? 0;
  const out = [...items];
  const top = out.findIndex((it) => it.type === 'msg');
  const early = new Set(lines.filter((e) => e.ts < first).slice(-5)); // the latest few, not a wall of lines
  let pinned = 0;
  for (const e of lines) {
    const line = { type: 'e2', key: `e2-${e.id}`, e };
    if (e.ts < first) { if (early.has(e) && top >= 0) { out.splice(top + pinned, 0, line); pinned++; } continue; }
    let i = out.findIndex((it) => it.type === 'msg' && (it.m.state || it.m.ts > e.ts));
    if (i < 0) out.push(line);
    else {
      out.splice(i, 0, line);
      if (out[i + 1]?.type === 'msg' && out[i + 1].grouped) out[i + 1] = { ...out[i + 1], grouped: false };
    }
  }
  return out;
}
export function KeyLine({ e }) {
  const name = S.users[e.u]?.name || 'Someone';
  const text = e.kind === 'aik' ? COPY.changedLine(name) : e.kind === 'added' ? COPY.addedLine(name, e.label) : COPY.removedLine(name, e.label);
  return html`<div class=${`joinline dmline e2-keyline${e.kind === 'removed' ? '' : ' warn'}`} role="note" data-kind=${e.kind}>
    <span class="dmline-ic" aria-hidden="true"><${Icon} name=${e.kind === 'removed' ? 'lock' : 'alert'} size=${16} /></span>
    <span class="joinline-text">${text}</span>
  </div>`;
}

/** Message menu lines: a legacy message says it isn't encrypted; a failed one says why. */
export function encMenuItems(conv, m) {
  if (unsealed(conv, m)) return [{ label: COPY.unsealed, icon: 'unlock', disabled: true, onSelect: () => {} }];
  if (m.legacy || beforeEncryption(conv, m)) return [{ label: COPY.legacyItem, icon: 'unlock', disabled: true, onSelect: () => {} }];
  if (m.e2ee && m.enc === 'failed') return [{ label: `Couldn’t decrypt: ${COPY.why[m.encWhy] || m.encWhy}`, icon: 'alert', disabled: true, onSelect: () => {} }];
  const out = [];
  if (m.e2ee && m.enc === true && m.encFlags?.includes('removed-device')) out.push({ label: COPY.removedDeviceItem(firstName(m.author)), icon: 'alert', disabled: true, onSelect: () => {} });
  if (m.e2ee && m.enc === true && m.encFlags?.includes('mentions')) out.push({ label: 'Its mentions don’t match what the server was told', icon: 'alert', disabled: true, onSelect: () => {} });
  return out;
}

/** Under the composer of an encrypted conversation: what isn't made here. */
// A verified contact whose safety number changed: sending waits until the person chooses (spec 12.3).
export function EncComposerNote({ conv }) {
  if (downgraded(conv)) return html`<div class="e2-warn" role="alert"><${Icon} name="alert" size=${16} /><span>${COPY.downgraded}</span></div>`;
  if (!isEncrypted(conv)) return null;
  const dm = S.dms[rootDm(conv)];
  const gate = sendGate(dm.members);
  const seen = dm.members.filter((u) => u !== S.me && changed.has(u) && !gate.includes(u));
  // Sending to a device someone added this week (review L4): said where you type, not only in the history.
  const weekAgo = Date.now() - 7 * 86_400_000;
  const gone = new Set((E2.events || []).filter((e) => e.kind === 'removed').map((e) => `${e.u}:${e.d}`));
  const fresh = (E2.events || []).filter((e) => e.kind === 'added' && e.u !== S.me && dm.members.includes(e.u) && e.ts > weekAgo && !gone.has(`${e.u}:${e.d}`)).slice(-3);
  return html`
    ${fresh.map((e) => html`<p class="e2-warn e2-newdev" role="status" key=${e.id}><${Icon} name="alert" size=${16} /><span>${COPY.newDeviceNote(S.users[e.u]?.name || 'Someone', e.label)}</span></p>`)}
    ${gate.map((u) => html`<div class="e2-warn e2-gate" role="alert" key=${u}><${Icon} name="alert" size=${16} />
      <span class="grow">${COPY.gate(S.users[u]?.name || 'Someone')}</span>
      <button class="btn sm" onClick=${() => openModal(SafetyNumber, { user: u })}>${COPY.verifyAgain}</button>
      <button class="btn sm" onClick=${() => acceptChange(u, changed.get(u))}>${COPY.sendAnyway}</button>
    </div>`)}
    ${seen.map((u) => html`<p class="e2-warn" role="status" key=${u}><${Icon} name="alert" size=${16} /><span>${COPY.changedLine(S.users[u]?.name || 'Someone')}</span></p>`)}
    <p class="e2-compose-note hint"><${Icon} name="lock" size=${12} />${COPY.convOn}. ${COPY.previewsOff}</p>`;
}

/** The server line written when a conversation turned encrypted (server/e2ee-conv.js). */
export function EncLine({ m }) {
  return html`<div class="joinline dmline e2-line" role="note" data-mid=${m.id}>
    <span class="dmline-ic" aria-hidden="true"><${Icon} name="lock" size=${16} /></span>
    <span class="joinline-text">${m.dmLine?.legacy ? html`${COPY.legacyLine} ${COPY.onLine}` : COPY.onLine}</span>
  </div>`;
}
