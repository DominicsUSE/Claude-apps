// Settings > Profile > Username: change your @handle (me.handle, server/inbox.js).
// The server checks the pattern, that nobody else has it (or gave it up in the
// last 7 days), your password and your second factor, and allows two changes
// an hour. Errors sit under the field they are about.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, me, toast } from '../store.js';
import { call } from '../server.js';
import { Icon } from '../ui/icons.js';

const HANDLE = /^[a-z0-9](?:[a-z0-9_.-]{0,22}[a-z0-9])?$/;

export function HandleRow({ Row }) {
  const u = me();
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const totp = !!S.account?.totp;
  const close = () => { setOpen(false); setHandle(''); setPassword(''); setCode(''); setErr({}); };
  const submit = (e) => {
    e.preventDefault();
    const h = handle.trim().toLowerCase().replace(/^@/, '');
    if (!HANDLE.test(h)) return setErr({ handle: 'Usernames are 2 to 24 letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.' });
    if (h === u.handle) return setErr({ handle: 'That’s already your username.' });
    if (!password) return setErr({ password: 'Type your password to confirm.' });
    setBusy(true);
    call('me.handle', { handle: h, password, code: totp ? code : undefined }).then((r) => {
      setBusy(false);
      if (S.users[S.me]) S.users[S.me].handle = r.handle;
      toast(`You’re @${r.handle} now. Your old username is held for you for 7 days.`);
      close();
    }, (ex) => {
      setBusy(false);
      const m = ex.offline ? 'You’re offline. Try again once you’re back.' : ex.message;
      if (/password/i.test(m)) setErr({ password: m });
      else if (/code/i.test(m)) setErr({ code: m });
      else setErr({ handle: m });
    });
    return undefined;
  };
  if (!open) {
    return html`<${Row} label="Username" hint="How people find and mention you.">
      <span class="handle-now">@${u.handle}</span>
      <button class="btn" id="handle-change" onClick=${() => setOpen(true)}>Change</button>
    <//>`;
  }
  const field = (id, label, value, set, extra = {}) => html`<div class="handle-field">
    <label class="label" for=${id}>${label}</label>
    <input id=${id} class=${`field${err[extra.k] ? ' bad' : ''}`} value=${value} aria-invalid=${String(!!err[extra.k])} aria-describedby=${`${id}-msg`}
      onInput=${(e) => { set(e.target.value); setErr({}); }} ...${extra.attrs || {}} />
    ${err[extra.k] ? html`<div class="err" id=${`${id}-msg`} role="alert"><${Icon} name="alert" size=${14} />${err[extra.k]}</div>` : extra.hint ? html`<div class="hint" id=${`${id}-msg`}>${extra.hint}</div>` : null}
  </div>`;
  return html`<${Row} label="Username" hint="Your old username stays yours for 7 days, then anyone can take it. Two changes an hour." top>
    <form class="handle-form" onSubmit=${submit} novalidate>
      ${field('handle-new', 'New username', handle, setHandle, { k: 'handle', hint: `Now @${u.handle}`, attrs: { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 25, 'data-autofocus': true } })}
      ${field('handle-pass', 'Password', password, setPassword, { k: 'password', attrs: { type: 'password', autocomplete: 'current-password' } })}
      ${totp && field('handle-code', 'Code from your app', code, setCode, { k: 'code', attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 20 } })}
      <div class="handle-acts">
        <button type="button" class="btn" onClick=${close}>Cancel</button>
        <button type="submit" class="btn primary" disabled=${busy} aria-busy=${String(busy)}>${busy ? 'Saving…' : 'Change username'}</button>
      </div>
    </form>
  <//>`;
}
