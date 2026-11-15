// Settings > Connection (0.12): how this device is talking to Snug, in plain
// words, for working out what's wrong and for telling whoever runs the server.
// Nothing here is secret: no addresses, keys or passwords, so "Copy details"
// is safe to paste into a message.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, toast, queuedChanges } from '../store.js';
import { pingNow } from '../server.js';
import { Icon } from '../ui/icons.js';

const SOCKET = {
  open: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Connecting again…',
  closed: 'Not connected. Trying again…',
  idle: 'Not connected',
};
const ago = (t) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return s <= 5 ? 'just now' : `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? 'an hour ago' : `${h} hours ago`;
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const speed = (ms) => (ms == null ? '' : ms < 150 ? 'quick' : ms < 500 ? 'a little slow' : 'slow');
const relay = () => (S.ice || []).some((s) => [].concat(s.urls || []).some((u) => /^turns?:/.test(u)));

// Every line of the page, as label and value: drawn here and copied as text.
function facts() {
  const c = S.conn;
  const sw = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
  const list = [
    ['Connection to the server', SOCKET[c.socket] || c.socket],
    c.socket === 'open' && c.since && ['Connected since', `${clock(c.since)} (${ago(c.since)})`],
    c.socket !== 'open' && c.retryAt && ['Next try', c.retryAt > Date.now() ? `in ${Math.ceil((c.retryAt - Date.now()) / 1000)} seconds` : 'now'],
    ['Round trip', c.rtt != null ? `${c.rtt} ms, ${speed(c.rtt)}${c.pingAt ? ` (checked ${ago(c.pingAt)})` : ''}` : 'Not measured yet'],
    ['Reconnects since this page opened', String(c.attempts || 0)],
    ['Last problem', c.lastError ? `${c.lastError.text} At ${clock(c.lastError.at)}.` : 'None since this page opened'],
    ['Changes waiting to send', queuedChanges() ? `${queuedChanges()} (made while offline; they go when the connection is back)` : 'None'],
    ['Calls through a relay (TURN)', relay()
      ? 'Set up. When a direct path between devices fails, calls and voice go through the relay.'
      : 'Not set up on this server. Calls and voice need a direct path between devices, which some networks block.'],
    S.p2p?.enabled && ['Friends on other PCs (registry)', S.p2p.registry === 'online' ? 'Reachable' : S.p2p.registry ? 'Not reachable right now' : 'Not signed in'],
    ['Opens without a connection', sw ? 'Yes, this browser keeps a copy of the app' : window.snugApp ? 'Not needed: the desktop app has its own server' : 'No (needs HTTPS, and one visit online first)'],
    ['Server version', c.version || S.version || 'Unknown'],
    ['This app', navigator.userAgent.includes('Electron') ? 'Snug desktop app' : 'Snug in a browser'],
  ];
  return list.filter(Boolean);
}

export function ConnectionPage({ Row }) {
  const [, tick] = useState(0);
  // Times like "12 seconds ago" stay current while the page is open.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const copy = async () => {
    const text = `Snug connection details\n${facts().map(([k, v]) => `${k}: ${v}`).join('\n')}\nTime: ${new Date().toISOString()}`;
    try { await navigator.clipboard.writeText(text); toast('Copied. Nothing private is in it.'); } catch { toast('Couldn’t copy here. Select the text on the page instead.'); }
  };
  const ok = S.conn.socket === 'open';
  return html`
    <h1>Connection</h1>
    <p class="lead">How this device is talking to Snug right now.</p>
    <div class=${`banner conn-state ${ok ? 'ok' : 'bad'}`} role="status">
      <${Icon} name=${ok ? 'check' : 'offline'} size=${16} />
      <span>${ok ? 'Everything is connected.' : 'Snug can’t reach the server at the moment. What you write waits and sends when it’s back.'}</span>
    </div>
    <dl class="conn-facts">
      ${facts().map(([k, v]) => html`<div class="conn-fact" key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}
    </dl>
    <div class="acts conn-acts">
      <button class="btn" disabled=${!ok} onClick=${() => pingNow()}><${Icon} name="history" size=${16} />Test again</button>
      <button class="btn" onClick=${copy}><${Icon} name="copy" size=${16} />Copy details</button>
    </div>
    <p class="hint">The copy has no addresses, keys or passwords, so it’s safe to send to whoever runs your Snug server.</p>
  `;
}

export function registerConnectionPage({ PAGES, VIEWS, Row }) {
  PAGES.push({ id: 'connection', label: 'Connection', icon: 'link', words: 'connection network offline online reconnect latency ping round trip relay turn version server diagnostics troubleshooting slow' });
  VIEWS.connection = () => html`<${ConnectionPage} Row=${Row} />`;
}
