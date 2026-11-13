// Settings > Desktop app: only in the desktop app (window.snugApp.desktop).
// Opening at login, starting minimised, minimising to the tray, hardware
// acceleration (applies after a restart), global mute and deafen keys, the
// unread number on the icon, and checking for a newer Snug. The app keeps
// these in desktop.json and checks every value again (desktop/main.js).
// Also the cyan "a newer Snug is out" strip.
import { html, useEffect, useLayoutEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit, toast } from '../store.js';
import { call } from '../server.js';
import { Icon } from '../ui/icons.js';
import { Switch } from '../ui/kit.js';
import { acceleratorOf } from '../lib/inbox.js';
import { update, dismissUpdate } from '../desktop.js';
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

export function DesktopPage({ Row }) {
  const [cfg, setCfg] = useState(null);
  const [errors, setErrors] = useState({});
  const [restart, setRestart] = useState(false);
  useEffect(() => { app()?.getDesktopSettings?.().then(setCfg, () => setCfg({})); }, []);
  if (!app()?.desktop) return html`<h1>Desktop app</h1><p class="lead">These settings are in the Snug desktop app.</p>`;
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
    <div class="set-head">Advanced</div>
    <${Row} label="Hardware acceleration" hint="Uses the graphics card to draw Snug. Turn it off if the window flickers or video looks wrong. Applies after a restart.">
      <${Switch} on=${cfg.hardwareAcceleration !== false} label="Hardware acceleration" onChange=${(v) => set({ hardwareAcceleration: v })} />
    <//>
    ${restart && html`<div class="banner" role="status"><${Icon} name="info" size=${16} /><span>Snug needs to restart for this to apply.</span>
      <button class="btn primary" style="margin-left:auto" onClick=${() => app().restart?.()}>Restart now</button></div>`}
    <${Row} label="Check for a newer Snug" hint="Looks once a day. Nothing is downloaded; Snug tells you and links to the download page.">
      <${Switch} on=${cfg.updateCheck !== false} label="Check for a newer Snug" onChange=${(v) => set({ updateCheck: v })} />
    <//>`;
}

// The strip at the top when a newer Snug is out.
export function UpdateStrip() {
  if (!update.info || update.dismissed || !app()?.desktop) return null;
  return html`<div class="update-strip" role="status">
    <${Icon} name="info" size=${16} />
    <span class="grow">Snug ${update.info.version} is out.</span>
    <button class="btn sm" onClick=${() => app().openUpdate?.()}>Get it<${Icon} name="external" size=${14} /></button>
    <button class="ib sm" aria-label="Dismiss" data-tip="Dismiss" onClick=${dismissUpdate}><${Icon} name="x" size=${16} /></button>
  </div>`;
}

// Settings (js/views/settings.js): the Desktop app page, shown only in the
// desktop app, and the Username row on the Profile page.
export function registerDesktopPage({ PAGES, VIEWS, Row }) {
  if (typeof window !== 'undefined' && window.snugApp?.desktop) {
    PAGES.push({ id: 'desktop', label: 'Desktop app', icon: 'screen', words: 'desktop app startup login boot minimise tray hardware acceleration gpu global shortcut mute deafen badge update' });
    VIEWS.desktop = () => html`<${DesktopPage} Row=${Row} />`;
  }
  const profile = VIEWS.profile;
  if (profile) VIEWS.profile = (p) => html`<${profile} ...${p} /><${HandleRow} Row=${Row} />`;
}
