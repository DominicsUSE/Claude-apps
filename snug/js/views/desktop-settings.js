// Settings > Desktop app: only in the desktop app (window.snugApp.desktop).
// Opening at login, starting minimised, minimising to the tray, hardware
// acceleration (applies after a restart), global mute and deafen keys, the
// unread number on the icon. The app keeps these in desktop.json and checks
// every value again (desktop/main.js). Updates (0.14): how often the app asks
// GitHub for a new version, since GitHub sees this computer's address each time:
// Automatically, Tell me, or Only when I ask, with Check now and Install now.
import { html, useEffect, useLayoutEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit, toast } from '../store.js';
import { call } from '../server.js';
import { Icon } from '../ui/icons.js';
import { Seg, Switch } from '../ui/kit.js';
import { acceleratorOf } from '../lib/inbox.js';
import { HandleRow } from './handle.js';

const app = () => window.snugApp;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const pretty = (acc) => (acc ? acc.replace('CommandOrControl', isMac ? 'Cmd' : 'Ctrl').replace(/\+/g, ' + ') : 'Not set');

// Records one shortcut with at least one modifier, as the push-to-talk picker does.
function ShortcutPicker({ which, value, onPick, label }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    if (!listening) return undefined;
    const onKey = (e) => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListening(false); return; }
      const acc = acceleratorOf(e, isMac);
      if (!acc) { setError('Use two of Ctrl, Alt and Shift with one key, like Ctrl + Shift + M, or one of them with an F key. Shortcuts other apps rely on, like Ctrl + C, can’t be taken.'); return; }
      setError('');
      setListening(false);
      onPick(acc);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [listening]);
  return html`<div class="ds-key">
    <button class=${`btn vo-key${listening ? ' listening' : ''}`} id=${`ds-key-${which}`} aria-live="polite"
      aria-label=${listening ? `Press the shortcut to ${label.toLowerCase()}, or Escape to keep the current one` : `${label}: ${pretty(value)}. Change it`}
      onClick=${() => { setError(''); setListening(!listening); }}>${listening ? 'Press keys…' : html`<kbd>${pretty(value)}</kbd>Change`}</button>
    ${value && !listening && html`<button class="btn quiet" aria-label=${`Clear the ${label.toLowerCase()} shortcut`} onClick=${() => onPick(null)}>Clear</button>`}
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
  </div>`;
}

// Updates: the choice, when the app last asked GitHub, and a version waiting to be installed (desktop/main.js).
const UPDATE_CHOICES = [['auto', 'Automatically'], ['notify', 'Tell me'], ['manual', 'Only when I ask']];
const UPDATE_HINT = {
  auto: 'Snug asks GitHub for a new version when it starts and about once a day, and installs it when you’re not using Snug (never during a call).',
  notify: 'Snug asks GitHub when it starts and about once a day, and tells you when there is a new version. It installs it only when you say.',
  manual: 'Snug asks GitHub only when you press Check now. You may miss security fixes, and a server can turn away a version that’s too old.',
};
function UpdateRows({ Row }) {
  const [u, setU] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { app()?.getUpdates?.().then(setU, () => setU(null)); }, []);
  // While a download runs (behind Snug, or after Install now), follow it: Install now shows up once it is
  // ready, and the progress is visible instead of a button that seems to do nothing.
  const moving = !!u && ['downloading', 'verifying', 'waiting', 'installing'].includes(u.phase) && !u.waiting;
  useEffect(() => {
    if (!moving) return undefined;
    const t = setInterval(() => app()?.getUpdates?.().then((r) => { if (r) setU(r); }, () => {}), 1000);
    return () => clearInterval(t);
  }, [moving]);
  if (!u) return null;
  const mode = u.mode || 'auto';
  const pick = (m) => app().setUpdateMode(m).then((r) => { if (r?.error) { toast(r.error); return; } if (r?.update) setU(r.update); }, () => {});
  const check = () => { setBusy(true); app().checkForUpdates().then((r) => { if (r) setU(r); }, () => {}).finally(() => setBusy(false)); };
  const install = () => app().installUpdate().then((r) => { if (r) setU(r); }, () => {});
  // A download that failed (after Install now, or behind Snug): say why, and let the person try again.
  const failed = u.phase === 'error' && !!u.version;
  const when = u.lastCheck?.at ? new Date(u.lastCheck.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const status = !u.canCheck ? 'This copy of Snug doesn’t check for updates (it isn’t an installed release).'
    : u.waiting ? `Snug ${u.version} is available.`
      : failed ? `Snug ${u.version} is available. ${u.message || 'Snug couldn’t download it. Try again.'}`
      : u.asked && u.phase === 'downloading' && u.total ? `Downloading Snug ${u.version}… ${Math.floor((100 * u.received) / u.total)}%. Snug restarts to install it when it’s ready.`
        : u.asked && ['downloading', 'verifying', 'waiting', 'installing'].includes(u.phase) ? `Installing Snug ${u.version}. Snug restarts when it’s ready${u.phase === 'waiting' ? ' (after the call or the data file transfer)' : ''}.`
      : ['downloading', 'verifying', 'waiting', 'installing'].includes(u.phase) ? `Snug ${u.version} is being installed. Snug restarts when you’re not using it.`
        : when ? (u.lastCheck.ok ? `You have the newest version (${u.current}). Last checked ${when}.` : `Snug couldn’t reach GitHub at ${when}. Check your connection and try again.`)
          : `You have Snug ${u.current}.`;
  return html`
    <div class="set-head">Updates</div>
    <${Row} label="Check for new versions" hint=${UPDATE_HINT[mode]} top>
      <${Seg} label="Check for new versions" value=${mode} options=${UPDATE_CHOICES} onChange=${pick} />
    <//>
    <${Row} label="Version" hint=${status}>
      ${u.waiting
        ? html`<button class="btn primary" id="ds-update-install" onClick=${install}>Install now</button>`
        : failed ? html`<button class="btn primary" id="ds-update-retry" onClick=${install}>Try again</button>`
        : html`<button class="btn" id="ds-update-check" disabled=${busy || !u.canCheck} onClick=${check}>${busy ? 'Checking…' : 'Check now'}</button>`}
    <//>`;
}

export function DesktopPage({ Row }) {
  const [cfg, setCfg] = useState(null);
  const [errors, setErrors] = useState({});
  const [restart, setRestart] = useState(false);
  useEffect(() => { app()?.getDesktopSettings?.().then(setCfg, () => setCfg({})); }, []);
  if (!app()?.desktop) return html`<${GetTheApp} />`;
  if (!cfg) return html`<h1>Desktop app</h1><p class="lead" role="status">Loading…</p>`;
  const set = (patch) => {
    const before = cfg;
    setCfg({ ...cfg, ...patch });
    return app().setDesktopSettings(patch).then((r) => {
      if (r?.error) { setCfg(before); toast(r.error); return r; }
      if (r?.settings) setCfg(r.settings);
      if (patch.hardwareAcceleration !== undefined) setRestart(true);
      return r;
    }, () => setCfg(before));
  };
  const setKey = (which, acc) => {
    const keys = { ...(cfg.voiceKeys || {}), [which]: acc };
    app().setVoiceKeys(keys).then((r) => {
      setErrors(r?.errors || {});
      if (r?.ok) setCfg({ ...cfg, voiceKeys: r.keys });
    }, () => {});
  };
  const badge = S.prefs.showBadge !== false;
  return html`
    <h1>Desktop app</h1>
    <p class="lead">How Snug runs on this computer.</p>
    <div class="set-head">Starting</div>
    <${Row} label="Open Snug when you sign in to your computer" hint="It starts in the background, ready for messages and calls.">
      <${Switch} on=${!!cfg.openAtLogin} label="Open Snug when you sign in to your computer" onChange=${(v) => set({ openAtLogin: v })} />
    <//>
    <${Row} label="Start minimised" hint="Opening Snug puts it in the tray instead of on screen.">
      <${Switch} on=${!!cfg.startMinimized} label="Start minimised" onChange=${(v) => set({ startMinimized: v })} />
    <//>
    <${Row} label="Minimise to the tray" hint="Minimising hides the window; Snug keeps running in the tray.">
      <${Switch} on=${!!cfg.minimizeToTray} label="Minimise to the tray" onChange=${(v) => set({ minimizeToTray: v })} />
    <//>
    <div class="set-head">Icon</div>
    <${Row} label="Unread number on the icon" hint="How many things need you, on the taskbar or dock icon. The window also flashes when someone mentions you.">
      <${Switch} on=${badge} label="Unread number on the icon" onChange=${(v) => { S.prefs.showBadge = v; emit(); call('prefs.set', { prefs: { showBadge: v } }).catch(() => {}); }} />
    <//>
    <div class="set-head">Voice</div>
    <${Row} label="Mute, from any app" hint="Works while you’re in a voice room or call, even when Snug isn’t in front." top>
      <${ShortcutPicker} which="mute" label="Mute" value=${cfg.voiceKeys?.mute || null} onPick=${(a) => setKey('mute', a)} />
      ${errors.mute && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${errors.mute}</div>`}
    <//>
    <${Row} label="Deafen, from any app" hint="Stops you hearing anyone, and mutes you too." top>
      <${ShortcutPicker} which="deafen" label="Deafen" value=${cfg.voiceKeys?.deafen || null} onPick=${(a) => setKey('deafen', a)} />
      ${errors.deafen && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${errors.deafen}</div>`}
    <//>
    <${UpdateRows} Row=${Row} />
    <div class="set-head">Advanced</div>
    <${Row} label="Hardware acceleration" hint="Uses the graphics card to draw Snug. Turn it off if the window flickers or video looks wrong. Applies after a restart.">
      <${Switch} on=${cfg.hardwareAcceleration !== false} label="Hardware acceleration" onChange=${(v) => set({ hardwareAcceleration: v })} />
    <//>
    ${restart && html`<div class="banner" role="status"><${Icon} name="info" size=${16} /><span>Snug needs to restart for this to apply.</span>
      <button class="btn primary" style="margin-left:auto" onClick=${() => app().restart?.()}>Restart now</button></div>`}
`;
}

// Settings (js/views/settings.js): the Desktop app page, shown only in the
// desktop app, and the Username row on the Profile page.
// In a browser the page says where the app comes from: the install page (docs/install.html, served by every
// Snug server) has the files, the warnings and how to check a download.
function GetTheApp() {
  return html`
    <h1>Desktop app</h1>
    <p class="lead">Snug is also an app for Windows and Mac, with notifications while the window is closed and
      mute keys that work in other apps. Its settings appear here when you use it.</p>
    <p><a href="/docs/install.html" target="_blank" rel="noopener">How to download, check and install the app</a></p>`;
}

export function registerDesktopPage({ PAGES, VIEWS, Row }) {
  if (typeof window !== 'undefined' && window.snugApp?.desktop) {
    PAGES.push({ id: 'desktop', label: 'Desktop app', icon: 'screen', words: 'desktop app startup login boot minimise tray hardware acceleration gpu global shortcut mute deafen badge updates version github' });
    VIEWS.desktop = () => html`<${DesktopPage} Row=${Row} />`;
  } else if (typeof window !== 'undefined') {
    PAGES.push({ id: 'desktop', label: 'Desktop app', icon: 'screen', words: 'desktop app download install windows mac exe dmg' });
    VIEWS.desktop = () => html`<${GetTheApp} />`;
  }
  const profile = VIEWS.profile;
  if (profile) VIEWS.profile = (p) => html`<${profile} ...${p} /><${HandleRow} Row=${Row} />`;
}
