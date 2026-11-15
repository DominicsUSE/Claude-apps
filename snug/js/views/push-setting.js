// Settings > Notifications: "Notify me when Snug is closed" (Web Push), or,
// in the desktop app, "Keep Snug running when the window is closed".
// Every state has its own words: off, asking, on, blocked (with the fix),
// failed, not supported, and not on a secure address.
import { html, useEffect } from '../../vendor/preact-htm.js';
import { Switch } from '../ui/kit.js';
import { push, refreshPush, enablePush, disablePush, setKeepRunning } from '../push.js';
import { S } from '../store.js';

const LABEL = 'Notify me when Snug is closed';
const HINT = {
  checking: 'Checking this browser…',
  off: 'Direct messages, mentions and replies reach this device even with every Snug tab closed. Muted places and Focused stay quiet.',
  asking: 'Choose Allow in your browser’s prompt to finish.',
  working: 'Setting up this device with the browser’s push service…',
  on: 'On for this device. Muted places and Focused stay quiet, and nothing arrives twice while Snug is open.',
  blocked: 'Your browser is blocking notifications for Snug. Open the site settings (the icon beside the address), set Notifications to Allow, then choose Check again.',
  unsupported: 'This browser can’t notify you while Snug is closed. Notifications while Snug is open, above, still work.',
  insecure: 'This needs a secure (https) address. Whoever runs this Snug can set one up; until then, notifications work while a tab is open.',
};

// Phones keep site settings in the browser's menu, not beside the address,
// and iPhones and iPads only allow it for a site added to the Home Screen.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PHONE_HINT = {
  blocked: 'Your browser is blocking notifications for Snug. In the browser’s menu, open the settings for this site, set Notifications to Allow, then choose Check again.',
  unsupported: IOS
    ? 'On iPhone and iPad, Snug can only notify you after you add it to your Home Screen (Share, then Add to Home Screen) and open it from there. That needs iOS 16.4 or later.'
    : 'This browser can’t notify you while Snug is closed. Notifications while Snug is open, above, still work.',
};
const hintFor = (st) => (S.ui.phone && PHONE_HINT[st]) || HINT[st] || HINT.off;

function Row({ label, hint, err, children, id, cls = '', state }) {
  return html`<div class=${`set-row ${cls}`} id=${id} data-state=${state}>
    <div class="set-label"><b>${label}</b>${hint && html`<span aria-live="polite">${hint}</span>`}${err && html`<span class="err" role="alert" style="color:var(--error)">${err}</span>`}</div>
    <div class="set-ctl">${children}</div>
  </div>`;
}

export function PushSetting() {
  useEffect(() => { refreshPush(); }, []);
  const st = push.status;

  if (st === 'desktop') {
    return html`<${Row} id="set-keep-running" label="Keep Snug running when the window is closed"
      hint=${push.keepRunning ? 'Snug stays in the system tray, so notifications keep arriving. Quit from the tray icon.' : 'Closing the window quits Snug, and notifications stop until you open it again.'}>
      <${Switch} on=${push.keepRunning} label="Keep Snug running when the window is closed" onChange=${setKeepRunning} />
    <//>`;
  }

  let ctl;
  if (st === 'asking' || st === 'working' || st === 'checking') {
    ctl = html`<button type="button" class="switch" role="switch" aria-checked=${String(st !== 'checking')} aria-label=${LABEL} aria-busy="true" disabled></button>`;
  } else if (st === 'blocked') {
    ctl = html`<span class="sub">Blocked</span><button class="btn" onClick=${() => refreshPush()}>Check again</button>`;
  } else if (st === 'unsupported' || st === 'insecure') {
    ctl = html`<span class="sub">Not available</span>`;
  } else {
    ctl = html`<${Switch} on=${st === 'on'} label=${LABEL} onChange=${(v) => (v ? enablePush() : disablePush())} />`;
  }
  return html`<${Row} id="set-push" cls="push-set" state=${st} label=${LABEL} hint=${st === 'error' ? '' : hintFor(st)} err=${push.error}>${ctl}<//>`;
}
