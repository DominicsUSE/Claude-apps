// House settings > Emoji: add custom emoji (drop or choose an image, name it),
// rename and remove them. The server checks everything again; these checks
// are here so mistakes show under the field before anything is sent.
import { html, useRef, useState } from '../../vendor/preact-htm.js';
import { S, toast, openModal, person } from '../store.js';
import { call } from '../server.js';
import { can } from '../lib/perms.js';
import { fileSize } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Confirm } from './modals.js';
import { CustomEmoji, EMOJI_NAME, MAX_EMOJI } from './emoji-custom.js';

const TYPES = ['image/png', 'image/gif', 'image/webp'];
const MAX_BYTES = 256 * 1024;
const MAX_SIDE = 256;

export function nameProblem(name, list, selfId) {
  const n = name.trim();
  if (!n) return 'Give it a name.';
  if (n.length < 2) return 'Names need at least 2 characters.';
  if (n.length > 32) return 'Names can be at most 32 characters.';
  if (!EMOJI_NAME.test(n)) return 'Use lowercase letters, numbers and underscores only.';
  if (list.some((e) => e.name === n && e.id !== selfId)) return `There’s already an emoji called :${n}: here.`;
  return '';
}

// "Party Parrot (1).png" -> "party_parrot_1"
const nameFrom = (file) => {
  const n = file.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return n.length >= 2 ? n : '';
};

const sizeOf = (blob) => new Promise((resolve) => {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, src: url });
  img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
  img.src = url;
});

async function upload(house, blob, name) {
  let res;
  try {
    res = await fetch(`/api/files?emoji=${encodeURIComponent(house)}`, {
      method: 'POST', credentials: 'same-origin', body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    });
  } catch { throw new Error('Couldn’t upload it. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Couldn’t upload it.');
  return data;
}

function AddEmoji({ house, list, full }) {
  const [img, setImg] = useState(null);   // { status: 'checking'|'ready'|'error', src, w, h, id, error, file }
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const input = useRef();
  const problem = nameProblem(name, list);

  const choose = async (file) => {
    if (!file) return;
    setErr('');
    if (!touched || !name) { setName(nameFrom(file.name)); setTouched(false); }
    const bad = (error) => setImg({ status: 'error', error, file: file.name });
    if (!TYPES.includes(file.type)) return bad('Emoji need to be PNG, GIF or WebP images.');
    if (file.size > MAX_BYTES) return bad(`That image is ${fileSize(file.size)}. Emoji can be up to 256 KB.`);
    setImg({ status: 'checking', file: file.name });
    const dim = await sizeOf(file);
    if (!dim) return bad('Snug couldn’t read that image.');
    if (dim.w > MAX_SIDE || dim.h > MAX_SIDE) return bad(`That image is ${dim.w} by ${dim.h} pixels. Emoji can be up to ${MAX_SIDE} by ${MAX_SIDE}.`);
    setImg({ status: 'checking', file: file.name, ...dim });
    try {
      const up = await upload(house, file, file.name);
      setImg({ status: 'ready', file: file.name, ...dim, id: up.id });
    } catch (e) { setImg({ status: 'error', error: e.message, file: file.name, ...dim }); }
    return undefined;
  };
  const reset = () => { setImg(null); setName(''); setTouched(false); setErr(''); };
  const add = async (e) => {
    e?.preventDefault();
    setTouched(true);
    if (problem || img?.status !== 'ready' || busy) return;
    setBusy(true);
    try {
      await call('emoji.add', { house, name: name.trim(), file: img.id });
      toast(`:${name.trim()}: is ready to use`);
      reset();
    } catch (x) { setErr(x.offline ? 'You’re offline. Try again once you’re back.' : x.message); }
    setBusy(false);
  };

  if (full) {
    return html`<div class="emo-drop full" aria-disabled="true">
      <${Icon} name="smile" size=${24} />
      <span><b>That’s ${MAX_EMOJI}, the most a house can have.</b> Remove one to add another.</span>
    </div>`;
  }
  // A name taken from the file can already be in use, so this shows before anyone types.
  const showNameErr = name.length > 0 && problem;
  return html`<form class="emo-add" onSubmit=${add} novalidate>
    <div class=${`emo-drop${over ? ' over' : ''}${img?.status === 'error' ? ' bad' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}>
      ${img?.src
        ? html`<span class="emo-prev" aria-hidden="true"><img src=${img.src} alt="" class="lg" /><img src=${img.src} alt="" /></span>`
        : html`<${Icon} name="image" size=${24} />`}
      <span class="emo-drop-text">
        ${img
          ? html`<b class="trunc">${img.file}</b><span>${img.status === 'checking' ? 'Checking…' : img.status === 'ready' ? `${img.w} by ${img.h} pixels` : 'Not added'}</span>`
          : html`<b>Drop an image here</b><span>PNG, GIF or WebP, up to 256 KB and ${MAX_SIDE} by ${MAX_SIDE} pixels. Square works best.</span>`}
      </span>
      <button type="button" class="btn" onClick=${() => input.current.click()}>${img ? 'Choose another' : 'Choose a file'}</button>
      <input type="file" hidden accept=${TYPES.join(',')} ref=${input} aria-label="Choose an emoji image"
        onChange=${(e) => { choose(e.target.files[0]); e.target.value = ''; }} />
    </div>
    ${img?.status === 'error' && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${img.error}</div>`}
    <div class="emo-name">
      <label class="label" for="emo-name">Name</label>
      <div class="emo-name-row">
        <span class="emo-colon" aria-hidden="true">:</span>
        <input id="emo-name" class="field" value=${name} maxlength="40" autocomplete="off" spellcheck="false" placeholder="party_parrot"
          aria-invalid=${showNameErr ? 'true' : undefined} aria-describedby="emo-name-msg"
          onInput=${(e) => { setName(e.target.value.toLowerCase().replace(/\s/g, '_')); setTouched(true); setErr(''); }} />
        <span class="emo-colon" aria-hidden="true">:</span>
        <button class="btn primary" type="submit" disabled=${!!problem || img?.status !== 'ready' || busy} aria-busy=${busy ? 'true' : undefined}>Add emoji</button>
      </div>
      <div id="emo-name-msg" class=${showNameErr || err ? 'err' : 'hint'} role=${showNameErr || err ? 'alert' : undefined}>
        ${err || (showNameErr ? problem : 'People type it between colons, like :party_parrot:')}
      </div>
    </div>
  </form>`;
}

function EmojiRow({ e, list, mayEdit }) {
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const problem = edit != null ? nameProblem(edit, list, e.id) : '';
  const save = async () => {
    if (problem) return setErr(problem);
    if (edit.trim() === e.name) return setEdit(null);
    try { await call('emoji.rename', { id: e.id, name: edit.trim() }); setEdit(null); setErr(''); } catch (x) { setErr(x.offline ? 'You’re offline. Try again once you’re back.' : x.message); }
    return undefined;
  };
  const when = new Date(e.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return html`<li class="emo-row" data-emoji=${e.name}>
    <span class="emo-face"><${CustomEmoji} e=${e} /></span>
    ${edit == null
      ? html`<span class="grow emo-meta"><b>:${e.name}:</b><span class="faint">Added by ${person(e.by).name} · ${when}</span></span>
        ${mayEdit && html`<button class="ib" aria-label=${`Rename :${e.name}:`} data-tip="Rename" onClick=${() => { setEdit(e.name); setErr(''); }}><${Icon} name="edit" size=${18} /></button>
          <button class="ib danger" aria-label=${`Remove :${e.name}:`} data-tip="Remove" onClick=${() => openModal(Confirm, {
            title: `Remove :${e.name}:?`, danger: true, action: 'Remove emoji',
            text: 'Messages that used it will show its name as text instead. This can’t be undone.',
            onConfirm: () => call('emoji.remove', { id: e.id }).catch((x) => toast(x.message)),
          })}><${Icon} name="trash" size=${18} /></button>`}`
      : html`<span class="grow emo-rename">
          <input class="field" value=${edit} maxlength="40" aria-label=${`New name for :${e.name}:`} autocomplete="off" spellcheck="false"
            aria-invalid=${err ? 'true' : undefined} aria-describedby=${`emo-rn-${e.id}`} ref=${(el) => el && !el.dataset.f && (el.dataset.f = '1', el.focus(), el.select())}
            onInput=${(x) => { setEdit(x.target.value.toLowerCase().replace(/\s/g, '_')); setErr(''); }}
            onKeyDown=${(x) => { if (x.key === 'Enter') { x.preventDefault(); save(); } else if (x.key === 'Escape') { x.preventDefault(); x.stopPropagation(); setEdit(null); setErr(''); } }} />
          <span id=${`emo-rn-${e.id}`} class=${err ? 'err' : 'hint'} role=${err ? 'alert' : undefined}>${err || 'Enter to save, Esc to cancel.'}</span>
        </span>
        <button class="btn" onClick=${() => { setEdit(null); setErr(''); }}>Cancel</button>
        <button class="btn primary" disabled=${!!problem} onClick=${save}>Save</button>`}
  </li>`;
}

export function HouseEmoji({ house }) {
  const h = S.houses[house];
  const list = S.emoji?.[house] || [];
  const mayEdit = can(S, house, 'emoji');
  const full = list.length >= MAX_EMOJI;
  return html`
    <h1>Emoji</h1>
    <p class="lead">${h.name}’s own emoji. Everyone here can use them in messages and reactions by typing :name:.</p>
    ${mayEdit
      ? html`<${AddEmoji} house=${house} list=${list} full=${full} />`
      : html`<p class="hint">Your role can use these but not change them. Roles with Manage emoji can.</p>`}
    <div class="set-head">Emoji in ${h.name} <span class="faint num" style="font-weight:400">${list.length} of ${MAX_EMOJI}</span></div>
    ${list.length
      ? html`<ul class="emo-list" aria-label=${`Emoji in ${h.name}`}>${list.map((e) => html`<${EmojiRow} key=${e.id} e=${e} list=${list} mayEdit=${mayEdit} />`)}</ul>`
      : html`<p class="emo-empty">No emoji yet.${mayEdit ? ' The first one you add shows up for everyone straight away.' : ''}</p>`}`;
}
