// Friends on other PCs, as the app shows them (design sections 6 and 8):
// the account notices (moving here, moved away, a move waiting for an answer),
// Settings > Account rows for the Snug username, the security-code banner in
// a conversation, a message's "waiting" line, and the "on this PC only" notes.
// The server side is server/peer.js and server/ghauth.js. Nothing here ever
// shows a GitHub name or id: Snug never has them.
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { S, emit, toast, signOutHooks, openModal, closeModal } from '../store.js';
import { api, call, on } from '../server.js';
import { Icon, addIcons } from '../ui/icons.js';
import { Switch } from '../ui/kit.js';
import { normalize } from '../lib/usernames.js';
import { localNameProblem, NAME_RULES } from '../lib/username-text.js';
import { CodeStep, NameStep } from './auth.js'; // the same code screen and username picker as signing in
import { RecoverySave } from './keyauth.js'; // v0.12: the recovery key screen, also used from Settings

addIcons({
  lock: 'M5.500 9h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z|M7 9V6.500a3 3 0 0 1 6 0V9',
  key: 'M7 13.500a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7Z|M10.500 10H17|M14.500 10v2.500|M16.500 10v2',
});

// ---------- State from the server ----------
// The snapshot carries p2p, peerKeys, peerWaiting and peerHeld (server/peer.js); these keep them current.
const drop = (o, conv, id) => { if (o?.[conv]) { o[conv] = o[conv].filter((x) => x !== id); if (!o[conv].length) delete o[conv]; } };
on('msg.state', ({ conv, id, state, waiting, failed }) => {
  S.peerWaiting ||= {}; S.peerHeld ||= {}; S.peerFailed ||= {};
  for (const o of [S.peerWaiting, S.peerHeld, S.peerFailed]) drop(o, conv, id);
  const into = { waiting: S.peerWaiting, held: S.peerHeld, failed: S.peerFailed }[state];
  if (into) (into[conv] ||= []).push(id);
  // Groups across PCs (0.10): how many people a message still waits for, or didn't reach.
  if (isPeerGroup(conv)) {
    S.peerWaitingN ||= {}; S.peerFailedN ||= {};
    for (const o of [S.peerWaitingN, S.peerFailedN]) { if (o[conv]) { delete o[conv][id]; if (!Object.keys(o[conv]).length) delete o[conv]; } }
    if (state === 'waiting' && waiting > 0) (S.peerWaitingN[conv] ||= {})[id] = waiting;
    if (failed > 0 || (state === 'failed' && failed === undefined)) (S.peerFailedN[conv] ||= {})[id] = failed || 1;
  }
});
on('peer.key', ({ user, fingerprint, at, quiet }) => {
  S.peerKeys ||= {};
  S.peerKeys[user] = { fingerprint, ...(quiet ? {} : { changedAt: at, quiet: false }) };
});
on('p2p', (d) => {
  const was = S.p2p?.state;
  S.p2p = { ...(S.p2p || {}), ...d };
  if (d.state === 'ok' && was === 'moving') toast('Your Snug account is on this PC now.');
});
signOutHooks.push(() => { for (const k of ['p2p', 'peerKeys', 'peerWaiting', 'peerHeld', 'peerFailed', 'peerWaitingN', 'peerFailedN']) delete S[k]; });

// ---------- Small helpers other views use ----------
export const p2pOwner = () => !!(S.p2p?.enabled && S.p2p.owner);
// v0.12: an account with no GitHub (server/keyauth.js) rather than one that signs in with GitHub.
export const keyAccount = () => S.p2p?.kind === 'key';
export const isRemote = (id) => !!S.users[id]?.remote;
// A friend on another PC is named by their Snug username (S27); a local person by their handle.
export const atName = (u) => (u?.remote ? (u.username || u.handle) : u?.handle) || '';
// A group with friends on other PCs (server/peergroups.js): its id says so.
export const isPeerGroup = (conv) => typeof conv === 'string' && /^dg_[a-z2-7]{26}$/.test(conv);
export const remoteOf = (conv) => {
  const others = (S.dms[conv]?.members || []).filter((u) => u !== S.me);
  return others.length === 1 && isRemote(others[0]) ? others[0] : null;
};
const firstName = (id) => (S.users[id]?.name || 'them').split(' ')[0];
const day = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const groups = (fp) => String(fp || '').split(' ').filter(Boolean);

// "On this PC only": houses, and anything else that doesn't reach friends on other PCs.
export const LocalNote = ({ text = 'Houses live on this PC. People join over your network or a link; friends on other PCs can’t join yet.' }) =>
  (p2pOwner() ? html`<p class="p2p-local"><${Icon} name="house" size=${14} /><span>${text}</span></p>` : null);

// ---------- A message of mine that hasn't reached them yet ----------
export function PeerState({ conv, m }) {
  if (m.author !== S.me || m.state) return null;
  if (isPeerGroup(conv)) return html`<${GroupState} conv=${conv} m=${m} />`;
  const st = S.peerHeld?.[conv]?.includes(m.id) ? 'held' : S.peerWaiting?.[conv]?.includes(m.id) ? 'waiting' : S.peerFailed?.[conv]?.includes(m.id) ? 'failed' : null;
  if (!st) return null;
  const who = remoteOf(conv);
  const name = who ? atName(S.users[who]) || firstName(who) : 'them';
  if (st === 'waiting') {
    // Online but the link is still being set up: it goes in a moment.
    const online = who && (S.users[who]?.presence || 'offline') !== 'offline';
    return html`<div class="msg-state msg-wait" data-peer-state="waiting"><${Icon} name="clock" size=${14} />${online ? `Sending to ${name}…` : `Waiting for ${name} to come online`}</div>`;
  }
  if (st === 'held') return html`<div class="msg-state msg-wait held" data-peer-state="held"><${Icon} name="lock" size=${14} />Held until you confirm ${name}’s new security code</div>`;
  return html`<div class="msg-state msg-wait failed" data-peer-state="failed"><${Icon} name="alert" size=${14} />Not delivered</div>`;
}

// In a group across PCs: "Waiting for N people" on any of mine, "Sent to everyone" on my latest only.
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
function GroupState({ conv, m }) {
  const n = S.peerWaitingN?.[conv]?.[m.id] || 0;
  const f = S.peerFailedN?.[conv]?.[m.id] || 0;
  if (n) return html`<div class="msg-state msg-wait" data-peer-state="waiting" data-waiting=${n}><${Icon} name="clock" size=${14} />Waiting for ${people(n)}</div>`;
  if (f) return html`<div class="msg-state msg-wait failed" data-peer-state="failed"><${Icon} name="alert" size=${14} />Not delivered to ${people(f)}</div>`;
  const mine = (S.msgs[conv] || []).filter((x) => x.author === S.me && !x.call && !x.dmLine && !x.sys);
  if (mine[mine.length - 1]?.id !== m.id) return null;
  return html`<div class="msg-state msg-sent-all" data-peer-state="delivered"><${Icon} name="check" size=${14} />Sent to everyone</div>`;
}

// The header line of a group across PCs.
export function GroupLine({ conv }) {
  if (!isPeerGroup(conv)) return null;
  return html`<span class="p2p-direct p2p-group" data-tip="No host: every member’s PC keeps the group. Messages are signed by who wrote them and encrypted between PCs. People in your groups see when you’re online."><${Icon} name="lock" size=${12} />Group between your PCs</span>`;
}

// ---------- In a conversation with a friend on another PC ----------
// The header line: how it travels, and their Snug username.
export function DirectLine({ conv }) {
  const who = remoteOf(conv);
  if (!who) return null;
  return html`<span class="p2p-direct" data-tip="Messages go straight between your PCs, encrypted end to end."><${Icon} name="lock" size=${12} />Direct between your PCs · @${atName(S.users[who])}</span>`;
}

// Their security code changed without their old PC confirming it (section 6.1).
export function KeyBanner({ conv }) {
  const who = remoteOf(conv);
  const k = who && S.peerKeys?.[who];
  const [codes, setCodes] = useState(false);
  if (!k?.changedAt) return null;
  const name = S.users[who]?.name || 'This friend';
  const ok = () => call('peer.keyAck', { user: who }).then(() => {
    if (S.peerKeys?.[who]) S.peerKeys[who] = { fingerprint: S.peerKeys[who].fingerprint };
    for (const id of S.peerHeld?.[conv] || []) (S.peerWaiting ||= {})[conv] = [...(S.peerWaiting[conv] || []), id];
    if (S.peerHeld) delete S.peerHeld[conv];
    emit();
  }, (e) => toast(e.offline ? 'You’re offline. Try again once you’re back.' : e.message));
  return html`<div class="p2p-key" role="alert" id="p2p-key-banner">
    <${Icon} name="shield" size=${18} />
    <div class="p2p-key-text">
      <span>${name}’s security code changed on ${day(k.changedAt)} without confirmation from their old PC. This happens when someone loses their PC, or if someone else took over their account. Check with ${firstName(who)} another way before sharing anything private.</span>
      ${codes && html`<div class="p2p-key-codes">
        <div><span>${firstName(who)}’s new code</span><div class="p2p-fp">${groups(k.fingerprint).map((g, i) => html`<span key=${i}>${g}</span>`)}</div></div>
        ${S.p2p?.fingerprint && html`<div><span>Your code</span><div class="p2p-fp">${groups(S.p2p.fingerprint).map((g, i) => html`<span key=${i}>${g}</span>`)}</div></div>`}
        <span>Read them to each other on a call or in person. They should match what each of you sees.</span>
      </div>`}
      <div class="p2p-key-acts">
        <button class="btn sm" aria-expanded=${String(codes)} onClick=${() => setCodes(!codes)}>${codes ? 'Hide codes' : 'Compare codes'}</button>
        <button class="btn sm primary" id="p2p-key-ok" onClick=${ok}>OK</button>
      </div>
    </div>
  </div>`;
}

// On a friend's profile: where they are, and their security code to compare.
export function PeerCode({ id }) {
  const k = S.peerKeys?.[id];
  return html`<section class="pp-sect" aria-labelledby="pp-peer">
    <h3 id="pp-peer">On another PC</h3>
    <p class="p2p-local"><${Icon} name="lock" size=${14} /><span>Messages and calls go straight between your PCs, encrypted end to end.</span></p>
    ${k?.fingerprint && html`<div class="p2p-peer-code"><span class="p2p-local">Security code${k.changedAt ? `, changed ${day(k.changedAt)}` : ''}</span>
      <div class="p2p-fp">${groups(k.fingerprint).map((g, i) => html`<span key=${i}>${g}</span>`)}</div></div>`}
  </section>`;
}

// ---------- Account notices, over the whole app ----------
export function P2pNotice() {
  const p = S.p2p;
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState('');
  if (!p?.enabled || !p.owner) return null;
  const byKey = p.rebindPending?.via === 'recovery';
  const answer = (approve) => {
    setBusy(true);
    call('id.rebind', { approve }).then(() => {
      S.p2p = { ...S.p2p, rebindPending: null };
      toast(approve ? 'Moving your account to your other PC now.'
        : byKey ? 'Stopped. If that wasn’t you, make a new recovery key now: Settings, Account and security.'
          : 'Stopped. If that wasn’t you, check your GitHub account’s security.');
    }, (e) => toast(e.offline ? 'You’re offline. Try again once you’re back.' : e.message)).finally(() => setBusy(false));
  };
  if (p.rebindPending) {
    return html`<div class="p2p-notice" role="alertdialog" aria-labelledby="p2p-move-t" id="p2p-move-notice" data-via=${p.rebindPending.via || 'github'}>
      <${Icon} name="alert" size=${20} />
      <div class="p2p-notice-text">
        <b id="p2p-move-t">${byKey ? 'Someone used your recovery key to move your account to another PC' : 'Someone signed in to your Snug account on another PC'}</b>
        <span>Their security code is <span class="p2p-code">${p.rebindPending.fingerprint}</span>. If that was you, choose That was me to move now. Otherwise choose Stop it${byKey ? ', then make a new recovery key' : ''}. If you do nothing, your account moves on ${when(p.rebindPending.at)}.</span>
        <div class="p2p-notice-acts">
          <button class="btn sm primary" disabled=${busy} onClick=${() => answer(true)}>That was me</button>
          <button class="btn sm danger" id="p2p-move-stop" disabled=${busy} onClick=${() => answer(false)}>Stop it</button>
        </div>
      </div>
    </div>`;
  }
  const key = `${p.state}:${p.rebindAt || ''}:${p.recovery?.saved ? 1 : 0}`;
  if (hidden === key) return null;
  let icon = 'alert', title, text, cls = '', act = null;
  const kindKey = keyAccount();
  if (p.state === 'ok' && p.recovery?.set && !p.recovery.saved) {
    // v0.12: the recovery key was shown but not confirmed as saved ("Do this later").
    title = 'Save your recovery key';
    text = 'If you lose this PC, it’s the only way to get your account back.';
    act = html`<div class="p2p-notice-acts"><button class="btn sm primary" id="p2p-save-key" onClick=${() => openModal(RecoveryModal)}>Save it now</button></div>`;
  } else if (p.state === 'moving') {
    cls = ' info'; icon = 'clock';
    title = 'Your account is moving to this PC';
    text = `It finishes ${p.rebindAt ? `on ${when(p.rebindAt)}` : 'in 72 hours'}, or sooner if you confirm on your other PC. Houses and everything on this PC work meanwhile.`;
  } else if (p.state === 'revoked') {
    title = 'Your Snug account moved to another PC';
    text = kindKey
      ? 'Everything saved on this PC is still here to read. To move it back, sign out and choose I already have an account.'
      : 'Sign in with GitHub to move it back here. Everything saved on this PC is still here to read.';
  } else if (p.state === 'needs-signin') {
    title = p.stopped ? 'Your other PC stopped the move' : kindKey ? 'Sign in again' : 'Sign in with GitHub again';
    text = p.stopped
      ? (kindKey ? 'Your account stays on your other PC. If you lost that PC, whoever has it can stop the move; the Snug owner can help.' : 'Your account stays on your other PC. If you didn’t expect this, check your GitHub account’s security.')
      : (kindKey ? 'This PC’s keys couldn’t be read. Sign out, then use your recovery key to move your account back here.' : 'This PC’s keys couldn’t be read. Signing in again moves your account back here.');
  } else return null;
  return html`<div class=${`p2p-notice${cls}`} role="status" id="p2p-state-notice" data-state=${p.state}>
    <${Icon} name=${icon} size=${20} />
    <div class="p2p-notice-text"><b>${title}</b><span>${text}</span>${act}</div>
    <button class="ib" aria-label="Hide this note" onClick=${() => setHidden(key)}><${Icon} name="x" size=${16} /></button>
  </div>`;
}

// ---------- Settings > Account and security ----------
// The Snug username (rename through the registry), security code, key protection, hide-IP.
export function UsernameRow({ Row }) {
  const p = S.p2p;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const next = p.renameAt && p.renameAt > Date.now() ? p.renameAt : 0;
  const hint = next ? `You can change it once every 7 days. Next change: ${day(next)}.` : 'How friends find and add you. You can change it once every 7 days; your old name is free for anyone at once.';
  if (!open) {
    return html`<${Row} label="Snug username" hint=${hint}>
      <span class="p2p-name"><b id="p2p-username">@${p.username}</b></span>
      <button class="btn" id="p2p-rename" disabled=${!!next || p.state !== 'ok'} onClick=${() => setOpen(true)}>Change</button>
    <//>`;
  }
  const submit = (e) => {
    e.preventDefault();
    const n = normalize(name);
    const local = localNameProblem(n, { owner: true });
    if (local) { setErr(local); return; }
    if (n === p.username) { setErr('That’s already your username.'); return; }
    setBusy(true);
    call('id.rename', { username: n }).then((r) => {
      S.p2p = { ...S.p2p, username: r.username, renameAt: r.renameAt };
      if (S.users[S.me]) S.users[S.me].handle = r.username;
      toast(`You’re @${r.username} now. Your old username is free for anyone.`);
      setOpen(false); setName(''); setErr(''); setBusy(false);
    }, (x) => { setErr(x.offline ? 'You’re offline. Try again once you’re back.' : x.message); setBusy(false); });
  };
  return html`<${Row} label="Snug username" hint="Your old username is free for anyone at once, and you can’t change again for 7 days." top>
    <form class="handle-form" onSubmit=${submit} novalidate>
      <div class="handle-field">
        <label class="label" for="p2p-rename-input">New username</label>
        <div class=${`auth-at${err ? ' bad' : ''}`}><span aria-hidden="true">@</span>
          <input id="p2p-rename-input" value=${name} maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false" data-autofocus
            aria-invalid=${err ? 'true' : undefined} aria-describedby="p2p-rename-msg" onInput=${(e) => { setName(e.target.value); setErr(''); }} />
        </div>
        ${err ? html`<div class="err" id="p2p-rename-msg" role="alert"><${Icon} name="alert" size=${14} />${err}</div>` : html`<div class="hint" id="p2p-rename-msg">Now @${p.username}. ${NAME_RULES}</div>`}
      </div>
      <div class="handle-acts">
        <button type="button" class="btn" onClick=${() => { setOpen(false); setName(''); setErr(''); }}>Cancel</button>
        <button type="submit" class="btn primary" disabled=${busy || !name.trim()} aria-busy=${String(busy)}>${busy ? 'Saving…' : 'Change username'}</button>
      </div>
    </form>
  <//>`;
}

export function AccountRows({ Row, signOut }) {
  const p = S.p2p;
  const hideIp = (on) => call('peer.setHideIp', { on }).then((r) => { S.p2p = { ...S.p2p, hideIp: r.hideIp }; emit(); }, (e) => toast(e.message));
  const kindKey = keyAccount();
  const rec = p.recovery || {};
  const active = p.state === 'ok';
  return html`
    <div class="set-head">Snug account</div>
    <${UsernameRow} Row=${Row} />
    ${kindKey
      ? html`<${Row} label="Sign-in" hint="Your account lives on this PC. Your recovery key brings it back if you lose this PC. There’s no password, email or phone number.">
          ${rec.saved
            ? html`<span class="p2p-tag ok" id="p2p-key-saved"><${Icon} name="check" size=${14} />Recovery key saved</span>`
            : html`<button class="btn primary" id="p2p-save-key-row" onClick=${() => openModal(RecoveryModal)}>Save your recovery key</button>`}
        <//>`
      : html`<${Row} label="Sign-in" hint="GitHub only proves it’s you. Nobody on Snug sees your GitHub account, and there’s no password to forget.">
          <span class="p2p-tag ok"><${Icon} name="check" size=${14} />Signed in with GitHub</span>
        <//>`}
    ${(kindKey || rec.set)
      ? html`<${Row} label="Recovery key" hint=${rec.pendingAt
          ? `Your new recovery key starts working on ${when(rec.pendingAt)}. Until then your old one works, and it can cancel the new one.`
          : 'Lost it, or think someone else has seen it? Make a new one. Your old key stops working.'}>
          <div class="p2p-row-acts">
            ${rec.pendingAt && html`<button class="btn" id="p2p-recovery-cancel" disabled=${!active} onClick=${() => openModal(CancelRecoveryModal)}>Cancel the new key</button>`}
            <button class="btn" id="p2p-recovery-new" disabled=${!active} onClick=${() => openModal(NewRecoveryModal)}>Make a new one</button>
          </div>
        <//>`
      : html`<${Row} label="Recovery key (optional)" hint="Then you don’t need GitHub to move to a new PC. Snug can’t reset it for you, so keep it safe.">
          <button class="btn" id="p2p-recovery-add" disabled=${!active} onClick=${() => openModal(NewRecoveryModal, { first: true })}>Add a recovery key</button>
        <//>`}
    <${Row} label="Status" hint=${p.state === 'moving' ? `Moving here. It finishes ${p.rebindAt ? `on ${when(p.rebindAt)}` : 'in 72 hours'}, or sooner if you confirm on your other PC.` : p.registry === 'connected' ? 'Connected to Snug’s directory. Friends on other PCs can reach you.' : 'Not connected to Snug’s directory. Messages to friends wait and send when it’s back.'}>
      <span class=${`p2p-tag${p.registry === 'connected' && p.state === 'ok' ? ' ok' : ' warn'}`}><${Icon} name=${p.registry === 'connected' && p.state === 'ok' ? 'check' : 'clock'} size=${14} />${p.state === 'moving' ? 'Moving here' : p.state !== 'ok' ? 'Not active here' : p.registry === 'connected' ? 'Online' : 'Offline'}</span>
    <//>
    <${Row} label="Security code" hint="Friends can compare it with what they see for you. It changes only when your account moves to another PC." top>
      <div class="p2p-fp" id="p2p-fingerprint" aria-label="Your security code">${groups(p.fingerprint).map((g, i) => html`<span key=${i}>${g}</span>`)}</div>
    <//>
    <${Row} label="Key protection" hint=${p.keyProtected ? 'This PC’s private keys are encrypted with your OS account.' : 'Your OS didn’t offer a way to encrypt this PC’s private keys, so they’re stored as they are.'}>
      <span class=${`p2p-tag${p.keyProtected ? ' ok' : ' warn'}`}><${Icon} name=${p.keyProtected ? 'lock' : 'alert'} size=${14} />${p.keyProtected ? 'Protected by your OS account' : 'Not protected by the OS'}</span>
    <//>
    <${Row} label="Hide my IP from friends" hint="Messages go through the Snug relay instead of directly. Calls use a relay server when one is set up; otherwise calls may fail.">
      <${Switch} on=${!!p.hideIp} label="Hide my IP from friends" onChange=${hideIp} />
    <//>
    <${Row} label="On a new PC" hint=${kindKey
      ? 'Open Snug on the new PC and choose I already have an account. It shows a code: type it here. Saved chats are copied over and stay here too. One PC at a time.'
      : 'Open Snug on the new PC: it shows a code to type here, or sign in with GitHub there (it moves after 72 hours unless you confirm here). One PC at a time.'}>
      <button class="btn" id="p2p-move-new" disabled=${!active} onClick=${() => openModal(MoveModal)}>Move to a new PC</button>
    <//>
    ${kindKey && html`<${Row} label="GitHub (optional)" hint=${p.ghLinked
        ? 'Your GitHub account can also move your Snug account to a new PC. Nobody on Snug sees it.'
        : 'Lets you move your account with GitHub too, if you have an account there. Nobody on Snug sees your GitHub account.'}>
      ${p.ghLinked
        ? html`<div class="p2p-row-acts"><span class="p2p-tag ok"><${Icon} name="check" size=${14} />Linked</span>
            <button class="btn" id="p2p-gh-unlink" disabled=${!active} onClick=${unlinkGithub}>Unlink</button></div>`
        : html`<button class="btn" id="p2p-gh-link" disabled=${!active} onClick=${() => openModal(LinkGitHubKey)}>Link GitHub</button>`}
    <//>`}
    <${Row} label="Sign out on this PC" hint=${kindKey ? 'Your messages stay on this PC. Open Snug to come back, or use your recovery key.' : 'Your messages stay on this PC. Sign in with GitHub to come back.'}>
      <button class="btn" id="p2p-signout" onClick=${() => signOut?.(false)}>Sign out</button>
    <//>`;
}

const offlineText = (e) => (e.offline ? 'You’re offline. Try again once you’re back.' : e.message);
function unlinkGithub() {
  call('id.unlinkGithub', {}).then(() => { S.p2p = { ...S.p2p, ghLinked: false }; emit(); toast('GitHub unlinked. Your recovery key still moves your account.'); }, (e) => toast(offlineText(e)));
}

// ---------- v0.12: the recovery key from Settings ----------
// The key shown at sign-up and not yet confirmed as saved.
function RecoveryModal() {
  const [k, setK] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { call('id.recoveryShow', {}).then(setK, (e) => setErr(offlineText(e))); }, []);
  if (err) return html`<div><h2 id="rk-modal-t">Save your recovery key</h2><div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>
    <p class="modal-lead">If you can’t find it, make a new one: Settings, Account and security, Recovery key.</p>
    <div class="modal-foot"><button class="btn" onClick=${closeModal}>Close</button></div></div>`;
  if (!k) return html`<p class="modal-lead">Loading…</p>`;
  return html`<${RecoverySave} code=${k.code} username=${k.username} titleId="rk-modal-t"
    confirm=${(last) => call('id.recoveryConfirm', { last })} onDone=${() => { closeModal(); toast('Recovery key saved. Keep it safe.'); }} />`;
}

// A new key: with the old one typed it replaces it now; without, it starts in 7 days.
function NewRecoveryModal({ first = false }) {
  const [old, setOld] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [made, setMade] = useState(null);
  if (made) {
    return html`<${RecoverySave} code=${made.code} username=${made.username} titleId="rk-modal-t" pendingAt=${made.state === 'pending' ? made.at : null}
      confirm=${(last) => call('id.recoveryConfirm', { last })} onDone=${() => { closeModal(); toast(made.state === 'pending' ? 'Saved. Your new key starts working in 7 days.' : 'New recovery key saved. The old one no longer works.'); }} />`;
  }
  const go = (e) => {
    e.preventDefault();
    setBusy(true);
    call('id.recoveryNew', old.trim() ? { old } : {}).then(setMade, (x) => { setErr(offlineText(x)); setBusy(false); });
  };
  return html`<form onSubmit=${go} novalidate>
    <h2 id="rk-modal-t">${first ? 'Add a recovery key' : 'Make a new recovery key'}</h2>
    <p class="modal-lead">${first
      ? 'A recovery key moves your account to a new PC without GitHub. You’ll see it once, so have paper or a password manager ready.'
      : 'Type your old recovery key and the new one replaces it at once. If you lost the old one, leave it empty: the new key then starts working in 7 days, and your old key can cancel it. That stops someone who only has this PC from locking you out.'}</p>
    ${!first && html`<div class="form">
      <label class="label" for="rk-old">Old recovery key (optional)</label>
      <textarea id="rk-old" class="field rk-input" rows="2" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120" value=${old} data-autofocus
        aria-invalid=${err ? 'true' : undefined} onInput=${(e) => { setOld(e.target.value); setErr(''); }}></textarea>
    </div>`}
    ${err && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" id="rk-make" disabled=${busy} aria-busy=${String(busy)}>${busy ? 'Making…' : 'Make my key'}</button>
    </div>
  </form>`;
}

// The current key stops a new one that is waiting.
function CancelRecoveryModal() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = (e) => {
    e.preventDefault();
    setBusy(true);
    call('id.recoveryCancel', { code }).then(() => { closeModal(); toast('Cancelled. Your current recovery key stays.'); }, (x) => { setErr(offlineText(x)); setBusy(false); });
  };
  return html`<form onSubmit=${go} novalidate>
    <h2>Cancel the new recovery key?</h2>
    <p class="modal-lead">Type your current recovery key. If you didn’t ask for a new one, someone with this PC may have: cancel it, and keep your key safe.</p>
    <div class="form"><label class="label" for="rk-cur">Current recovery key</label>
      <textarea id="rk-cur" class="field rk-input" rows="2" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120" value=${code} data-autofocus onInput=${(e) => { setCode(e.target.value); setErr(''); }}></textarea></div>
    ${err && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Back</button>
      <button type="submit" class="btn primary" disabled=${busy || !code.trim()}>${busy ? 'Cancelling…' : 'Cancel the new key'}</button>
    </div>
  </form>`;
}

// "Move to a new PC": the code shown on the new PC, then a check of where it goes, then the move.
function MoveModal() {
  const p = S.p2p;
  const [code, setCode] = useState('');
  const [peek, setPeek] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const check = (e) => {
    e.preventDefault();
    setBusy(true);
    call('id.movePeek', { code }).then((r) => { setPeek(r); setBusy(false); }, (x) => { setErr(offlineText(x)); setBusy(false); });
  };
  const move = () => {
    setBusy(true);
    call('id.moveAccept', { code }).then(() => { closeModal(); toast(`@${p.username} is moving to your new PC now. Your saved chats are copied over.`); }, (x) => { setErr(offlineText(x)); setBusy(false); });
  };
  if (peek) {
    return html`<div>
      <h2 id="mv-t">Move @${p.username} to the new PC?</h2>
      <p class="modal-lead">This PC stops getting messages. Your saved chats are copied over and stay here too.</p>
      <div class="p2p-peer-code"><span class="p2p-local">The new PC’s security code</span>
        <div class="p2p-fp" id="mv-fingerprint">${groups(peek.fingerprint).map((g, i) => html`<span key=${i}>${g}</span>`)}</div>
        <span class="p2p-local">It should match Settings, Account and security on the new PC, once it’s moved.</span></div>
      ${err && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>`}
      <div class="modal-foot">
        <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
        <button type="button" class="btn primary" id="mv-go" disabled=${busy} aria-busy=${String(busy)} onClick=${move}>${busy ? 'Moving…' : 'Move now'}</button>
      </div>
    </div>`;
  }
  return html`<form onSubmit=${check} novalidate>
    <h2 id="mv-t">Move to a new PC</h2>
    <p class="modal-lead">On the new PC, open Snug and choose <b>I already have an account</b>, then <b>My other PC is here</b>. Type the code it shows.</p>
    <div class="form"><label class="label" for="mv-code">Code from your new PC</label>
      <input id="mv-code" class=${`field mv-code${err ? ' bad' : ''}`} maxlength="16" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7QF2-M9XDA" value=${code} data-autofocus
        aria-invalid=${err ? 'true' : undefined} onInput=${(e) => { setCode(e.target.value); setErr(''); }} /></div>
    ${err && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" id="mv-check" disabled=${busy || !code.trim()}>${busy ? 'Checking…' : 'Continue'}</button>
    </div>
  </form>`;
}

// Link GitHub to an account with no GitHub: the usual code screen, then the link.
function LinkGitHubKey() {
  const [step, setStep] = useState(null);
  const [err, setErr] = useState('');
  const flow = useRef(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = await api('/api/gh/start', { purpose: 'link-account' });
        if (!live) { api('/api/gh/cancel', { flow: s.flow }).catch(() => {}); return; }
        flow.current = s.flow;
        setStep({ kind: 'code', flow: s.flow, userCode: s.userCode, uri: s.verificationUri });
        for (;;) {
          const w = await api('/api/gh/wait', { flow: s.flow });
          if (!live) return;
          if (w.state === 'pending') continue;
          flow.current = null;
          if (w.state === 'confirmed') {
            await call('id.linkGithub', { flow: s.flow });
            S.p2p = { ...S.p2p, ghLinked: true };
            closeModal();
            toast('GitHub linked. It can also move your account now.');
          } else { setErr(w.message || 'GitHub sign-in stopped. Try again.'); setStep(null); }
          return;
        }
      } catch (e) { if (live) { setErr(offlineText(e)); setStep(null); } }
    })();
    return () => { live = false; if (flow.current) api('/api/gh/cancel', { flow: flow.current }).catch(() => {}); };
  }, []);
  return html`<div class="p2p-link">
    ${!step && !err && html`<p class="modal-lead">Asking GitHub…</p>`}
    ${step?.kind === 'code' && html`<${CodeStep} step=${step} onCancel=${closeModal} />`}
    ${err && html`<h2>Link GitHub</h2><div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>
      <div class="modal-foot"><button class="btn" onClick=${closeModal}>Close</button></div>`}
  </div>`;
}

// The PC's first password account, on a PC with no Snug account yet: connect
// GitHub and pick a Snug username, keeping everything (design S18).
export function ConnectRow({ Row }) {
  const [can, setCan] = useState(null);
  useEffect(() => {
    let live = true;
    api('/api/gh/config').then((c) => live && setCan(!!c.canLink), () => live && setCan(false));
    return () => { live = false; };
  }, []);
  if (!can || p2pOwner()) return null;
  return html`<div class="set-head">Friends on other PCs</div>
    <${Row} label="Connect GitHub" hint="Keep this account and everything in it, pick a Snug username, and reach friends on any PC. GitHub only proves it’s you; nobody on Snug sees your GitHub account.">
      <button class="btn primary" id="p2p-link" onClick=${() => openModal(LinkGitHub)}>Connect GitHub</button>
    <//>`;
}
function LinkGitHub() {
  const [step, setStep] = useState(null);
  const [err, setErr] = useState('');
  const flow = useRef(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = await api('/api/gh/start', { link: true });
        if (!live) { api('/api/gh/cancel', { flow: s.flow }).catch(() => {}); return; }
        flow.current = s.flow;
        setStep({ kind: 'code', flow: s.flow, userCode: s.userCode, uri: s.verificationUri });
        for (;;) {
          const w = await api('/api/gh/wait', { flow: s.flow });
          if (!live) return;
          if (w.state === 'pending') continue;
          if (w.state === 'choose-name') setStep({ kind: 'name', flow: s.flow, owner: !!w.owner });
          else { flow.current = null; setErr(w.message || 'GitHub sign-in stopped. Try again.'); setStep(null); }
          return;
        }
      } catch (e) { if (live) setErr(e.message); }
    })();
    return () => { live = false; if (flow.current) api('/api/gh/cancel', { flow: flow.current }).catch(() => {}); };
  }, []);
  const close = () => closeModal();
  return html`<div class="p2p-link">
    ${!step && !err && html`<p class="modal-lead">Asking GitHub…</p>`}
    ${step?.kind === 'code' && html`<${CodeStep} step=${step} onCancel=${close} />`}
    ${step?.kind === 'name' && html`<${NameStep} step=${step} onCancel=${close} onDone=${() => { flow.current = null; location.reload(); }} />`}
    ${err && html`<h2>Connect GitHub</h2><div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>
      <div class="modal-foot"><button class="btn" onClick=${close}>Close</button></div>`}
  </div>`;
}

// Delete for a GitHub account: type the username, and confirm on GitHub so the name is freed.
// v0.12: an account with no GitHub confirms with its recovery key instead.
export function DeleteP2p({ onGone }) {
  if (keyAccount()) return html`<${DeleteKey} onGone=${onGone} />`;
  return html`<${DeleteGh} onGone=${onGone} />`;
}
function DeleteKey({ onGone }) {
  const p = S.p2p;
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [flow, setFlow] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const check = () => {
    setErr('');
    call('id.releaseCheck', { code }).then((r) => setFlow(r.flow), (e) => setErr(offlineText(e)));
  };
  const del = async () => {
    setBusy(true);
    try {
      const r = await api('/api/account/delete', { confirm: typed, flow: flow || undefined });
      if (!r.released) toast('Deleted on this PC. Your username stays reserved, because the recovery key wasn’t used.');
      await onGone();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return html`<div>
    <h2>Delete your account?</h2>
    <p class="modal-lead">This can’t be undone. Friends on other PCs see you leave. Your messages stay where you wrote them, by “Deleted user”.</p>
    <div class="form">
      <div><label class="label" for="cf-handle">Type your username, <b>${p.username}</b>, to confirm</label>
        <input id="cf-handle" class="field" autocapitalize="none" spellcheck="false" data-autofocus value=${typed} onInput=${(e) => { setTyped(e.target.value); setErr(''); }} /></div>
      ${!flow && html`<div><label class="label" for="cf-recovery">Recovery key, to free @${p.username} for anyone (optional)</label>
        <textarea id="cf-recovery" class="field rk-input" rows="2" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120" value=${code} onInput=${(e) => { setCode(e.target.value); setErr(''); }}></textarea>
        <button type="button" class="btn" id="cf-recovery-check" disabled=${!code.trim()} onClick=${check}>Check my key</button></div>`}
      ${flow && html`<div class="ok-line"><${Icon} name="check" size=${16} /><span>Key checked. @${p.username} will be free once you delete.</span></div>`}
      ${err && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="button" class="btn danger" disabled=${busy || normalize(typed).replace(/^@/, '') !== p.username} onClick=${del}>${busy ? 'Working…' : 'Delete my account'}</button>
    </div>
  </div>`;
}
function DeleteGh({ onGone }) {
  const p = S.p2p;
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState(null); // {flow, userCode, uri, state}
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef({ on: true, flow: null });
  useEffect(() => () => { live.current.on = false; if (live.current.flow) api('/api/gh/cancel', { flow: live.current.flow }).catch(() => {}); }, []);
  const confirmGh = async () => {
    setErr('');
    try {
      const s = await api('/api/gh/start', { purpose: 'release' });
      live.current.flow = s.flow;
      setStep({ flow: s.flow, userCode: s.userCode, uri: s.verificationUri, state: 'pending' });
      for (;;) {
        const w = await api('/api/gh/wait', { flow: s.flow });
        if (!live.current.on) return;
        if (w.state === 'pending') continue;
        setStep((x) => x && { ...x, state: w.state });
        if (w.state !== 'confirmed') setErr(w.message || 'GitHub didn’t confirm. You can still delete; your username stays reserved until you sign in again and delete it.');
        return;
      }
    } catch (e) { setErr(e.message); }
  };
  const del = async () => {
    setBusy(true);
    try {
      const r = await api('/api/account/delete', { confirm: typed, flow: step?.state === 'confirmed' ? step.flow : undefined });
      if (!r.released) toast('Deleted on this PC. Your username stays reserved until you sign in with GitHub again and delete it.');
      await onGone();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return html`<div>
    <h2>Delete your account?</h2>
    <p class="modal-lead">This can’t be undone. Friends on other PCs see you leave. Your messages stay where you wrote them, by “Deleted user”.</p>
    <div class="form">
      <div><label class="label" for="cf-handle">Type your username, <b>${p.username}</b>, to confirm</label>
        <input id="cf-handle" class="field" autocapitalize="none" spellcheck="false" data-autofocus value=${typed} onInput=${(e) => { setTyped(e.target.value); setErr(''); }} /></div>
      <div class="hint">To free @${p.username} for anyone, confirm on GitHub first.</div>
      ${!step && html`<div><button type="button" class="btn" onClick=${confirmGh}>Confirm on GitHub</button></div>`}
      ${step && step.state === 'pending' && html`<div class="auth-code-box"><output class="auth-device-code">${step.userCode}</output></div>
        <div class="hint">Type it at <a class="auth-device-url" href=${step.uri} target="_blank" rel="noopener noreferrer">${step.uri.replace(/^https:\/\//, '')}</a></div>
        <a class="btn" href=${step.uri} target="_blank" rel="noopener noreferrer">Open GitHub</a>
        <div class="auth-warn"><${Icon} name="shield" size=${16} /><span>Only type this code on github.com yourself. Snug will never ask you to send it to anyone.</span></div>`}
      ${step?.state === 'confirmed' && html`<div class="ok-line"><${Icon} name="check" size=${16} /><span>Confirmed. @${p.username} will be free once you delete.</span></div>`}
      ${err && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} /><span>${err}</span></div>`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="button" class="btn danger" disabled=${busy || normalize(typed).replace(/^@/, '') !== p.username} onClick=${del}>${busy ? 'Working…' : 'Delete my account'}</button>
    </div>
  </div>`;
}
