// v0.10 Settings > Your data > Data file, and the small notice while a data file travels between PCs
// (design 0.10 section 2.7). The server side is server/vault.js: ops vault.*, events `vault` and
// `vault.xfer`, GET /api/vault/file, POST /api/vault/import. Only this PC's Snug (GitHub) account sees it.
import { html, useState, useRef } from '../../vendor/preact-htm.js';
import { S, toast, signOutHooks } from '../store.js';
import { call, on } from '../server.js';
import { Icon } from '../ui/icons.js';
import { Seg } from '../ui/kit.js';
import { p2pOwner } from './p2p.js';

on('vault', (d) => { S.vault = d; });
signOutHooks.push(() => { delete S.vault; delete S.vaultXfer; });
let manualSend = false; // "Send to my other device" says it itself (no second toast from the event)
on('vault.xfer', (d) => {
  if (!d) return;
  S.vaultXfer = d.state === 'done' || d.state === 'failed' || d.state === 'imported' ? null : d;
  if (d.state === 'imported') toast('Your data from your other PC is here.');
  else if (d.state === 'done' && d.role === 'sender' && !manualSend) toast('Your data file reached your other PC.');
  else if (d.state === 'failed' && d.role === 'receiver' && d.error && d.error !== 'stopped') toast('Your data from your other PC didn’t come through. Snug tries again when both PCs are on.');
});

const BACKUPS = [[0, 'Off'], [1, 'Every day'], [3, 'Every 3 days'], [7, 'Every 7 days']];
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pct = (x) => (x?.size ? Math.min(100, Math.round((100 * (x.got || 0)) / x.size)) : 0);
const failMsg = (e) => (e?.offline ? 'You’re offline. Try again once you’re back.' : e?.message || 'That didn’t work. Try again.');

function countsText(c) {
  if (!c) return 'Your data file is in.';
  const parts = [];
  if (c.friends) parts.push(`${c.friends} ${c.friends === 1 ? 'friend' : 'friends'}`);
  if (c.conversations) parts.push(`${c.conversations} ${c.conversations === 1 ? 'conversation' : 'conversations'}`);
  if (c.messages) parts.push(`${c.messages} ${c.messages === 1 ? 'message' : 'messages'}`);
  return parts.length ? `Brought in ${parts.join(', ')}.` : 'Your data file is in. Everything in it was already here.';
}

export function VaultBlock({ Row }) {
  const [busy, setBusy] = useState('');
  const input = useRef(null);
  const v = S.vault;
  if (!p2pOwner() || !v?.enabled) return null;
  const x = S.vaultXfer;
  const run = (what, fn) => { setBusy(what); return Promise.resolve().then(fn).catch((e) => toast(failMsg(e))).finally(() => setBusy('')); };
  const save = () => run('save', async () => {
    const res = await fetch('/api/vault/file', { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'That didn’t work. Try again.');
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'Snug data.snugvault';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Your data file is saving.');
  });
  const pick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) { toast('That file is too large to be a Snug data file.'); return; }
    run('import', async () => {
      const res = await fetch('/api/vault/import', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'That didn’t work. Try again.');
      toast(countsText(d.counts));
    });
  };
  const send = () => run('send', async () => {
    manualSend = true;
    try { await call('vault.send'); } finally { manualSend = false; }
    toast('Your data file reached your other PC.');
  });
  const setBackup = (days) => run('backup', async () => { S.vault = await call('vault.setBackup', { days }); });
  const stopWaiting = () => run('wait', async () => { S.vault = await call('vault.stopWaiting'); });
  return html`
    <div class="set-head" id="vault-head">Data file</div>
    <p class="vault-lead">Your friends, conversations with friends on other PCs, profile and settings, sealed in one file that only your Snug account can open. Snug keeps it up to date by itself. If it’s changed outside Snug, Snug won’t use it.</p>
    <div class="vault-status" id="vault-status">
      <${Icon} name="file" size=${16} />
      <span>${v.file ? html`Saved ${when(v.file.at)} · ${size(v.file.size)}` : v.error ? v.error.text : 'Not saved yet.'}</span>
      ${v.protected != null && html`<span class=${`p2p-tag${v.protected ? ' ok' : ' warn'}`}><${Icon} name=${v.protected ? 'shield' : 'alert'} size=${14} />${v.protected ? 'Protected by your OS account' : 'Not protected by the OS'}</span>`}
    </div>
    ${v.waiting && html`<div class="vault-wait" id="vault-waiting">
      <${Icon} name="clock" size=${16} />
      <span>Waiting for your other PC… Open Snug there and your data comes over by itself.</span>
      <button class="btn sm" disabled=${!!busy} onClick=${stopWaiting}>Stop waiting</button>
    </div>`}
    ${x && html`<div class="vault-xfer" id="vault-xfer" role="status">
      <span>${x.role === 'sender' ? 'Sending to your other PC' : 'Bringing your data from your other PC'}… ${pct(x)}%</span>
      <div class="vault-bar"><i style=${`width:${pct(x)}%`}></i></div>
    </div>`}
    <${Row} label="Save data file" hint="A copy of the file, to keep wherever you like. It only opens in Snug, signed in with this GitHub account.">
      <button class="btn" id="vault-save" disabled=${!!busy || !v.file} onClick=${save}><${Icon} name="down" size=${16} />${busy === 'save' ? 'Preparing…' : 'Save data file…'}</button>
    <//>
    <${Row} label="Send to my other device" hint=${v.other?.connected ? 'Your other PC is connected.' : 'Your other PC isn’t connected. Open Snug there and sign in with GitHub; it waits for your data.'}>
      <button class="btn" id="vault-send" disabled=${!!busy || !v.file} onClick=${send}><${Icon} name="send" size=${16} />${busy === 'send' ? 'Looking for it…' : 'Send'}</button>
    <//>
    <${Row} label="Import data file" hint="Adds what’s in the file to this PC. Nothing here is removed.">
      <button class="btn" id="vault-import" disabled=${!!busy} onClick=${() => input.current?.click()}><${Icon} name="file" size=${16} />${busy === 'import' ? 'Importing…' : 'Import data file…'}</button>
      <input type="file" accept=".snugvault,application/octet-stream" hidden ref=${input} id="vault-file" onChange=${pick} />
    <//>
    <${Row} label="Back up automatically" hint="Backups go to Snug’s folder on this PC (newest 5 kept) and to your other device if it’s connected." top>
      <${Seg} label="Back up automatically" value=${v.backupDays || 0} options=${BACKUPS} onChange=${setBackup} />
      ${v.lastBackup ? html`<div class="vault-small">Last backup ${when(v.lastBackup)}</div>` : null}
    <//>
  `;
}

export function registerVaultPage({ PAGES, VIEWS, Row }) {
  const base = VIEWS.data;
  if (!base) return;
  VIEWS.data = (p) => html`<${base} ...${p} /><${VaultBlock} Row=${Row} />`;
  const page = PAGES.find((x) => x.id === 'data');
  if (page) page.words = `${page.words} data file vault backup import transfer move new pc device`;
}

// A data file on its way between PCs: a slim bar, shown anywhere in the app.
export function VaultNotice() {
  const x = S.vaultXfer;
  if (!p2pOwner() || !x || !x.size || (x.state !== 'receiving' && x.state !== 'sending')) return null;
  return html`<div class="vault-notice" id="vault-notice" role="status">
    <${Icon} name="file" size=${16} />
    <span>${x.role === 'sender' ? 'Sending your data to your other PC' : 'Bringing your data from your other PC'}… ${pct(x)}%</span>
    <div class="vault-bar"><i style=${`width:${pct(x)}%`}></i></div>
  </div>`;
}
