// Privacy, as the app shows it: the "Who can see what" summary and the
// online, typing and link-preview choices on Settings > Privacy and safety,
// and the full privacy page (Settings > Privacy guide, and /privacy for anyone,
// signed in or not). The words come from js/lib/privacy.js for the mode the
// app is in, and the numbers from GET /api/privacy (server/privacy.js), so
// they say what this Snug really does.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit } from '../store.js';
import { Icon } from '../ui/icons.js';
import { Lockup } from '../ui/brand.js';
import { Seg, Switch } from '../ui/kit.js';
import { whoSeesWhat, keptFor, PRESENCE_TO } from '../lib/privacy.js';
import { E2 } from '../e2ee/manager.js'; // whether this server offers end-to-end encryption
import { COPY } from '../lib/e2ee/copy.js'; // the encryption words Settings > Encryption uses

// What the server keeps and for how long; asked once per page load.
let aboutCache = null;
function useAbout() {
  const [about, setAbout] = useState(aboutCache);
  useEffect(() => {
    if (aboutCache) return undefined;
    let live = true;
    fetch('/api/privacy', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((a) => {
      if (a) aboutCache = a;
      if (live) setAbout(a);
    }, () => {});
    return () => { live = false; };
  }, []);
  return about;
}

// In the desktop app: its settings, for how it checks for updates (desktop/main.js); null in a browser.
function useDesktop() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    const app = typeof window !== 'undefined' ? window.snugApp : null;
    if (!app?.desktop) return undefined;
    let live = true;
    setCfg({});
    app.getDesktopSettings?.().then((c) => { if (live && c) setCfg(c); }, () => {});
    return () => { live = false; };
  }, []);
  return cfg;
}

// The desktop app's own account talks to friends on other PCs; everyone else
// (a website, or a guest on someone's PC) is on a server. The words say "this
// Snug", never the server's address: an address on screen means nothing to most
// people and can be an internal one (audit E-1).
const modeNow = () => (S.p2p?.enabled && S.p2p.owner ? 'p2p' : 'host');
const factsNow = (about) => ({
  mode: modeNow(), host: '', https: location.protocol === 'https:',
  // End-to-end encrypted direct messages and groups: offered by this server (js/e2ee/manager.js).
  e2ee: E2.on === true,
  presenceTo: S.prefs?.presenceTo || 'everyone', friendPreviews: S.prefs?.friendPreviews === true,
  stun: about?.stun ?? 'google', turn: about?.turn ?? modeNow() === 'p2p', turnStatic: about?.turnStatic === true, linkPreviews: about?.linkPreviews ?? true,
});
// Words for the people using Snug, not for whoever runs the server: server
// setting names (like SNUG_STUN=none) are left out.
const plain = (text) => String(text).replace(/\s*\(SNUG_[A-Z_]+=[^)]*\)/g, '');

function Sections({ sections, level = 3 }) {
  const H = `h${level}`;
  return sections.map((s) => html`<section class="pv-sect" key=${s.id} data-pv=${s.id} aria-labelledby=${`pv-${s.id}`}>
    <${H} id=${`pv-${s.id}`}>${s.title}<//>
    <ul>${s.items.map((t, i) => html`<li key=${i}>${plain(t)}</li>`)}</ul>
  </section>`);
}

// End-to-end encryption in one plain sentence, for the privacy dashboard and
// Settings > Security. `page`: Settings has an Encryption page to go to;
// `act`: the button's words when there is something to do there.
export function encryptionWords() {
  const st = E2.status;
  if (st === 'off' || (st === 'none' && !E2.on)) return { tone: 'off', page: false, text: 'This server doesn’t offer end-to-end encryption, so whoever runs it could read your direct messages.' };
  if (st === 'unsupported') return { tone: 'warn', page: true, text: 'This browser can’t use end-to-end encryption, so it can’t read your encrypted messages. Your other devices still can.' };
  if (st === 'none') return { tone: 'warn', page: true, act: 'Turn on', text: 'Not turned on. Until it is, your direct messages are stored on this server where whoever runs it could read them.' };
  if (st === 'new-device' || st === 'pending') return { tone: 'warn', page: true, act: 'Add this device', text: 'On for your account, but this device isn’t added yet, so it can’t read encrypted messages here.' };
  return { tone: 'ok', page: true, text: 'On. Direct messages and groups marked “End-to-end encrypted” can be read only on your devices and those of the people in them. Room messages in houses aren’t end-to-end encrypted.' };
}
// The devices that can read your encrypted messages (trusted devices).
export const encryptionDevices = () => (E2.status === 'ready' ? (E2.me?.devices || []).filter((d) => d.state === 'trusted').length : 0);

// Settings > Privacy and safety: the summary for this mode, then a way to the full page.
// How calls and the network work is technical, so it waits in the Advanced part below.
export function PrivacyOverview({ openGuide }) {
  const about = useAbout();
  const f = factsNow(about);
  const all = whoSeesWhat(f);
  const sections = all.filter((s) => s.id !== 'never' && s.id !== 'network');
  // A plain-http server is the one network fact everyone needs to see.
  const http = f.mode === 'host' && !f.https ? all.find((s) => s.id === 'network')?.items[0] : null;
  return html`<div class="pv-overview" id="pv-overview" data-mode=${f.mode}>
    <div class="set-head">Who can see what</div>
    ${http && html`<p class="pv-warn" role="note"><${Icon} name="alert" size=${16} /><span>${plain(http)}</span></p>`}
    <${Sections} sections=${sections} />
    <p class="hint pv-more">Snug sends no analytics or diagnostics anywhere, and isn’t anonymous.
      ${openGuide && html` <button type="button" class="linkish" id="pv-open-guide" onClick=${openGuide}>Read the full privacy page</button>`}</p>
  </div>`;
}

// Settings > Privacy and safety, at the end: the technical part, closed until opened.
export function PrivacyAdvanced() {
  const about = useAbout();
  const f = factsNow(about);
  const net = whoSeesWhat(f).find((s) => s.id === 'network');
  const sees = Array.isArray(about?.e2eeServerSees) ? about.e2eeServerSees : [];
  return html`<details class="pv-adv" id="pv-advanced">
    <summary><${Icon} name="chev-r" size=${16} /><span>Advanced security information</span></summary>
    <div class="pv-adv-body">
      ${net && html`<section class="pv-sect" aria-labelledby="pv-adv-net"><h3 id="pv-adv-net">${net.title}</h3>
        <ul>${net.items.map((t, i) => html`<li key=${i}>${plain(t)}</li>`)}</ul></section>`}
      ${E2.status !== 'off' && html`<section class="pv-sect" aria-labelledby="pv-adv-e2"><h3 id="pv-adv-e2">Encrypted conversations</h3>
        <ul>
          <li>${sees.length ? COPY.serverSees : COPY.serverSees.replace(/ It still sees:$/, '')}
            ${sees.length > 0 && html`<ul>${sees.map((x) => html`<li key=${x.id}>${x.text}</li>`)}</ul>`}</li>
          <li>${COPY.roomsNot}</li>
          <li>Safety numbers: in an encrypted conversation, open its details and compare the safety number with the other person, in person or on a call. If the numbers match, nobody has put different keys between you.</li>
          <li>Each of your devices has its own keys. A device you remove gets no new messages, but keeps what it already had.</li>
        </ul></section>`}
      <section class="pv-sect" aria-labelledby="pv-adv-never"><h3 id="pv-adv-never">What Snug never does</h3>
        <ul>${(whoSeesWhat(f).find((s) => s.id === 'never')?.items || []).map((t, i) => html`<li key=${i}>${t}</li>`)}</ul></section>
    </div>
  </details>`;
}
// What "Who sees when you're online" covers, and what stays visible whatever it says (review-media 4 and 6).
export const PRESENCE_HINT = 'Also your status, your “Recently here” and “last wrote” lines, and that you’re in a voice room, for anyone not in it with you. People still see when each message was sent, and people in a voice room with you see you there.';
export const PRESENCE_HINT_P2P = 'With friends only, members of your groups on other PCs who aren’t your friends don’t see you online. Your PC still connects to theirs to swap group messages, so their PC can tell you’re online while it does.';

// Settings > Privacy and safety: when you're online, typing, and (desktop) friends' link previews.
export function PrivacyControls({ Row }) {
  const p = S.prefs;
  const set = (k, v) => { S.prefs[k] = v; emit(); }; // synced to the server and applied there (js/account.js)
  return html`<div class="set-head">Activity</div>
    <${Row} label="Who sees when you’re online" hint=${PRESENCE_HINT + (modeNow() === 'p2p' ? ' ' + PRESENCE_HINT_P2P : '')} top>
      <${Seg} label="Who sees when you’re online" value=${p.presenceTo || 'everyone'} options=${PRESENCE_TO} onChange=${(v) => set('presenceTo', v)} />
    <//>
    <${Row} label="Typing" hint="Show people when you’re typing, and see when they are. Off: neither, on every device. Never shown while you’re invisible.">
      <${Switch} on=${p.typing !== false} label="Typing" onChange=${(v) => set('typing', v)} />
    <//>
    ${modeNow() === 'p2p' && html`<${Row} label="Previews for links friends send" hint="Your PC would fetch the site to make the preview, so the site sees your PC’s internet address. Links you send always get previews.">
      <${Switch} on=${p.friendPreviews === true} label="Previews for links friends send" onChange=${(v) => set('friendPreviews', v)} />
    <//>`}`;
}

// The full privacy page, for ordinary people: in Settings (Privacy guide) and on its own at /privacy (PrivacyDoc).
export function PrivacyGuide({ level = 2 }) {
  const about = useAbout();
  const desk = useDesktop();
  const f = factsNow(about);
  const H = `h${level}`;
  const other = whoSeesWhat({ ...f, mode: f.mode === 'p2p' ? 'host' : 'p2p' }).filter((s) => s.id === 'messages' || s.id === 'directory');
  return html`<div class="pv-guide" id="pv-guide" data-mode=${f.mode}>
    <p class="lead">What Snug stores, who can see it, and what you can do about it, in plain words. This page describes ${f.mode === 'p2p' ? 'the desktop app with friends on other PCs' : 'this Snug'}.</p>
    <${Sections} sections=${whoSeesWhat(f)} level=${level} />
    <section class="pv-sect" data-pv="kept" aria-labelledby="pv-kept">
      <${H} id="pv-kept">What Snug stores and for how long<//>
      <ul>${keptFor(about || {}, { e2ee: f.e2ee, p2p: f.mode === 'p2p', desktopApp: !!desk, updates: desk?.updates }).map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
    </section>
    <section class="pv-sect" data-pv="choices" aria-labelledby="pv-choices">
      <${H} id="pv-choices">Your choices<//>
      <ul>
        <li>Settings > Privacy and safety: who can message you, befriend you or invite you; who sees when you’re online; typing; blocking.</li>
        <li>Settings > Your data: download everything that’s yours as one zip file (your profile, your messages, the direct conversations you’re in, files you uploaded and your settings).</li>
        <li>Deleting your account: choose to keep your messages under “Deleted user”, or to erase them with your files, reactions and sign-in history. Copies other people already have (on their PCs, or forwarded and screenshotted) can’t always be erased: with friends on other PCs, those PCs that are online are asked to delete their copies, and the others keep them.</li>
        <li>Deleting a message: it can be brought back for 10 minutes, then its text is gone from Snug.</li>
        <li id="pv-disappear">Disappearing messages: in a conversation, open the More menu and choose Disappearing messages, and new messages there are removed after the time you pick (in a house, people who manage rooms set it). People can still copy or screenshot a message before it goes, and ${f.mode === 'p2p' ? 'each PC’s encrypted daily backup' : 'the server’s encrypted daily backups'} can keep a copy for up to a week.</li>
      </ul>
    </section>
    <section class="pv-sect" data-pv="law" aria-labelledby="pv-law">
      <${H} id="pv-law">Requests from the police or courts<//>
      <ul>
        <li>Whoever runs a Snug server, and whoever runs the Snug directory, can be required by law to hand over what they store. Snug can’t prevent that. Keeping less, as above, means there is less to hand over.</li>
      </ul>
    </section>
    <section class="pv-sect" data-pv="other" aria-labelledby="pv-other">
      <${H} id="pv-other">${f.mode === 'p2p' ? 'If you join someone’s Snug server instead' : 'If you use the Snug desktop app with friends on other PCs'}<//>
      <ul>${other.flatMap((s) => s.items).map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
    </section>
  </div>`;
}

// /privacy: the same page on its own, with a way back.
export function PrivacyDoc() {
  const back = (e) => {
    e.preventDefault();
    S.ui.guide = false;
    history.replaceState(history.state, '', '/');
    emit();
  };
  return html`<div class="auth pv-doc">
    <main class="auth-main">
      <article class="auth-panel pv-panel">
        <div class="auth-brand"><${Lockup} size=${24} /></div>
        <h1>Privacy at Snug</h1>
        <${PrivacyGuide} level=${2} />
        <p><a href="/" class="btn" id="pv-back" onClick=${back}><${Icon} name="back" size=${16} />Back to Snug</a></p>
      </article>
    </main>
  </div>`;
}

// Back and forward between /privacy and the app.
addEventListener('popstate', () => {
  const g = /^\/privacy\/?$/.test(location.pathname);
  if (!!S.ui.guide !== g) { S.ui.guide = g; emit(); }
});

// On the sign-in screen: where to read this before making an account.
export const PrivacyLink = () => html`<a class="pv-signedout-link" id="pv-link" href="/privacy" onClick=${(e) => { e.preventDefault(); S.ui.guide = true; history.pushState(history.state, '', '/privacy'); emit(); }}>How Snug handles your data</a>`;

// Deleting an account: keep what I wrote under "Deleted user", or erase it.
// `p2p`: the desktop app, where friends' PCs hold their own copies.
// p2p (0.13): friends' PCs that are online are asked to delete their copies; `offline` names those that aren't.
const listOf = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
export function EraseChoice({ value, onChange, p2p = false, offline = [] }) {
  const opt = (v, title, text) => html`<label>
    <input type="radio" name="erase" value=${v} checked=${value === v} onChange=${() => onChange(v)} />
    <span><b>${title}</b><small>${text}</small></span>
  </label>`;
  return html`<fieldset class="erase-choice">
    <legend>What you wrote</legend>
    ${opt('keep', 'Keep my messages', 'They stay where you wrote them, by “Deleted user”, so conversations still make sense.')}
    ${opt('erase', 'Erase what I wrote', `Your messages${p2p ? ' on this PC' : ''} (direct ones too), files you uploaded, reactions, poll votes, sign-in history and security log go. They show as “Message deleted”.${p2p ? ' Friends’ PCs that are online now are asked to delete their copies of your most recent messages too (up to 5,000 with each friend and 2,000 in each group).' : ''}`)}
    ${p2p && value === 'erase' && offline.length > 0 && html`<p class="hint erase-offline">${listOf(offline)}${offline.length === 1 ? '’s PC is' : '’s PCs are'} offline now, so ${offline.length === 1 ? 'it keeps its' : 'they keep their'} copy of your messages.</p>`}
    <p class="hint">${p2p
      ? 'Copies can’t always be erased: a PC that’s offline when you delete, or one running a changed copy of Snug, keeps them, and anyone may have saved or forwarded something.'
      : 'Copies other people already have can’t be erased: anything forwarded, saved or screenshotted, and reports moderators already received. The server’s encrypted backups drop it within a week.'}${' '}Emoji, stickers and sounds you added to a house stay with the house.</p>
  </fieldset>`;
}
