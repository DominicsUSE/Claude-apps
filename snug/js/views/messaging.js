// Messaging, in the browser: polls, link previews, forwarding, edit history,
// scheduled messages, stickers, dynamic timestamps, the formatting bar, jumping
// to the first unread or to a date. The server checks every rule again
// (server/messaging.js); what's here only decides what to offer.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import {
  S, emit, persist, toast, openModal, closeModal, openPop, closePop, openMenu, convMeta, findMsg, jumpToMsg, person,
  openLightbox, markRead, setPref,
} from '../store.js';
import { call, on } from '../server.js';
import { can, canPost } from '../lib/perms.js';
import { roomIds, isThread } from '../lib/attention.js';
import { fmtWhen, fmtFull, fmtTime, plural, fuzzy } from '../lib/util.js';
import { fmtStamp, STAMP_STYLES } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Rich, Switch } from '../ui/kit.js';
import { EmojiPicker } from './emoji.js';

const rectOf = (e) => e.currentTarget.getBoundingClientRect();
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newMsgId = () => `m_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALPHA[b % 36]).join('')}`;
const offlineSay = (e) => toast(e?.offline ? 'You’re offline. Try again once you’re back.' : e?.message || 'That didn’t work. Try again.');
const modOf = (conv) => { const meta = convMeta(conv); return !!meta?.house && can(S, meta.house, 'moderate'); };
export const POLL_HOURS = [[1, '1 hour'], [4, '4 hours'], [8, '8 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']];

// ---------- Live changes ----------
on('poll', ({ conv, id, poll }) => { const m = findMsg(conv, id); if (m) m.poll = poll; });
on('poll.mine', ({ id, votes }) => { if (votes.length) S.pollVotes[id] = votes; else delete S.pollVotes[id]; });
on('sched', ({ list }) => { S.scheduled = list; });
on('sched.failed', ({ conv, reason }) => {
  const where = convMeta(conv)?.title;
  toast(`A scheduled message${where ? ` to ${where}` : ''} wasn’t sent. ${reason}`);
});
on('stickers', ({ house, list }) => { S.stickers = { ...S.stickers, [house]: list }; });

// ---------- Polls ----------
function relEnd(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'Ended';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m left`;
  if (h < 48) return `${Math.round(h)}h left`;
  return `${Math.round(h / 24)}d left`;
}

export function vote(conv, m, answers) {
  const before = S.pollVotes[m.id];
  if (answers.length) S.pollVotes[m.id] = answers; else delete S.pollVotes[m.id];
  emit();
  return call('poll.vote', { conv, id: m.id, answers }).then((r) => {
    if (r.votes.length) S.pollVotes[m.id] = r.votes; else delete S.pollVotes[m.id];
    emit();
  }, (e) => {
    if (before) S.pollVotes[m.id] = before; else delete S.pollVotes[m.id];
    emit();
    offlineSay(e);
  });
}
const endPoll = (conv, m) => call('poll.end', { conv, id: m.id }).catch(offlineSay);

export function Poll({ conv, m }) {
  const p = m.poll;
  const mine = S.pollVotes[m.id] || [];
  const voted = mine.length > 0;
  const ended = p.ended || p.ends <= Date.now();
  const [sel, setSel] = useState(mine);
  const [changing, setChanging] = useState(false);
  const [peek, setPeek] = useState(false); // results before voting, where the poll shows them
  // A poll that hides results: once you've voted (or wrote it), ask for yours.
  useEffect(() => {
    if (p.counts || !(voted || p.by === S.me) || m.state) return;
    call('poll.view', { conv, id: m.id }).then((r) => { m.poll = r.poll; emit(); }, () => {});
  }, [m.id, voted, !!p.counts]);
  const picking = !ended && (!voted || changing) && !peek;
  const results = !!p.counts && !picking;
  const top = results ? Math.max(...p.counts) : 0;
  const submit = (answers) => { setChanging(false); vote(conv, m, answers); };
  const pick = (i) => {
    if (!picking) return;
    if (!p.multi) { setSel([i]); submit([i]); return; }
    setSel(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i].sort((a, b) => a - b));
  };
  const role = p.multi ? 'checkbox' : 'radio';
  return html`<div class=${`poll${ended ? ' ended' : ''}`} role="group" aria-label=${`Poll: ${p.question}`}>
    <div class="poll-q">${p.question}</div>
    <div class="poll-how">${ended ? 'Final results' : p.multi ? 'Choose any' : 'Choose one'}${p.hidden && !ended ? ' · Results show after you vote' : ''}</div>
    <div class="poll-answers" role=${picking ? (p.multi ? 'group' : 'radiogroup') : 'list'} aria-label="Answers">
      ${p.answers.map((a, i) => {
        const n = p.counts?.[i] || 0;
        const pct = p.total ? Math.round((n / p.total) * 100) : 0;
        const chosen = picking ? sel.includes(i) : mine.includes(i);
        const lead = results && n === top && top > 0;
        if (!picking) {
          return html`<div key=${i} role="listitem" class=${`poll-a done${chosen ? ' mine' : ''}${lead ? ' lead' : ''}`}>
            ${results && html`<span class="poll-bar" style=${`width:${pct}%`} aria-hidden="true"></span>`}
            ${a.emoji && html`<span class="poll-emo" aria-hidden="true">${a.emoji}</span>`}
            <span class="poll-t">${a.text}</span>
            ${chosen && html`<span class="poll-check" role="img" aria-label="Your vote"><${Icon} name="check" size=${14} /></span>`}
            ${results && html`<span class="poll-n" aria-label=${`${plural(n, 'vote')}, ${pct}%`}>${pct}%</span>`}
          </div>`;
        }
        return html`<button key=${i} type="button" role=${role} aria-checked=${String(chosen)} class=${`poll-a${chosen ? ' mine' : ''}`} onClick=${() => pick(i)}>
          <span class=${`poll-box ${role}`} aria-hidden="true">${chosen && html`<${Icon} name="check" size=${12} />`}</span>
          ${a.emoji && html`<span class="poll-emo" aria-hidden="true">${a.emoji}</span>`}
          <span class="poll-t">${a.text}</span>
        </button>`;
      })}
    </div>
    <div class="poll-foot">
      <span class="poll-meta">${plural(p.total, 'vote')} · <span data-tip=${fmtFull(p.ends)}>${ended ? `Ended ${fmtWhen(p.ends)}` : relEnd(p.ends)}</span></span>
      <span class="grow"></span>
      ${picking && p.multi && html`<button class="btn sm primary" disabled=${!sel.length} onClick=${() => submit(sel)}>Vote</button>`}
      ${picking && !voted && p.counts && html`<button class="btn sm quiet" onClick=${() => setPeek(true)}>Show results</button>`}
      ${peek && !ended && html`<button class="btn sm quiet" onClick=${() => setPeek(false)}>${voted ? 'Back' : 'Back to voting'}</button>`}
      ${picking && changing && html`<button class="btn sm quiet" onClick=${() => { setChanging(false); setSel(mine); }}>Cancel</button>`}
      ${!picking && !peek && voted && !ended && html`<button class="btn sm quiet" onClick=${() => { setSel(mine); setChanging(true); }}>Change vote</button>`}
      ${!picking && !peek && voted && !ended && html`<button class="btn sm quiet" onClick=${() => submit([])}>Remove vote</button>`}
      ${!ended && (p.by === S.me || modOf(conv)) && html`<button class="btn sm quiet" onClick=${() => endPoll(conv, m)}>End now</button>`}
    </div>
  </div>`;
}

function PollModal({ conv }) {
  const [q, setQ] = useState('');
  const [answers, setAnswers] = useState([{ text: '' }, { text: '' }]);
  const [hours, setHours] = useState(24);
  const [multi, setMulti] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [emojiAt, setEmojiAt] = useState(-1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (i, patch) => setAnswers(answers.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const filled = answers.filter((a) => a.text.trim());
  const submit = (e) => {
    e.preventDefault();
    if (!q.trim()) return setError('Write the question.');
    if (filled.length < 2) return setError('Give at least two answers.');
    setBusy(true);
    call('poll.create', { conv, id: newMsgId(), question: q.trim(), answers: filled.map((a) => ({ text: a.text.trim(), ...(a.emoji ? { emoji: a.emoji } : {}) })), hours, multi, hidden })
      .then(() => closeModal(), (err) => { setBusy(false); setError(err.offline ? 'You’re offline. Try again when you’re back.' : err.message); });
    return undefined;
  };
  return html`<form class="form poll-form" onSubmit=${submit} novalidate>
    <h2>New poll</h2>
    <div>
      <label class="label" for="poll-q">Question</label>
      <input id="poll-q" class="field" data-autofocus maxlength="300" placeholder="What should we fire next?" value=${q} onInput=${(e) => { setQ(e.target.value); setError(''); }} />
    </div>
    <fieldset class="poll-edit">
      <legend class="label">Answers <span class="faint">${answers.length} of 10</span></legend>
      ${answers.map((a, i) => html`<div class="poll-edit-row" key=${i}>
        <button type="button" class="ib sm poll-emo-btn" aria-label=${a.emoji ? `Answer ${i + 1} emoji ${a.emoji}, change` : `Add an emoji to answer ${i + 1}`} aria-expanded=${String(emojiAt === i)}
          onClick=${() => setEmojiAt(emojiAt === i ? -1 : i)}>${a.emoji ? html`<span class="emo">${a.emoji}</span>` : html`<${Icon} name="smile" size=${16} />`}</button>
        <input class="field" maxlength="55" placeholder=${`Answer ${i + 1}`} aria-label=${`Answer ${i + 1}`} value=${a.text} onInput=${(e) => { set(i, { text: e.target.value }); setError(''); }} />
        ${answers.length > 2 && html`<button type="button" class="ib sm" aria-label=${`Remove answer ${i + 1}`} onClick=${() => setAnswers(answers.filter((_, j) => j !== i))}><${Icon} name="x" size=${16} /></button>`}
      </div>
      ${emojiAt === i && html`<div class="poll-emo-pick">
        <${EmojiPicker} onPick=${(c) => { if (!c.startsWith('<:')) set(i, { emoji: c }); setEmojiAt(-1); }} />
        ${a.emoji && html`<button type="button" class="btn sm quiet" onClick=${() => { set(i, { emoji: undefined }); setEmojiAt(-1); }}>No emoji</button>`}
      </div>`}`)}
      ${answers.length < 10 && html`<button type="button" class="btn sm quiet" onClick=${() => setAnswers([...answers, { text: '' }])}><${Icon} name="plus" size=${16} />Add an answer</button>`}
    </fieldset>
    <div>
      <label class="label" for="poll-len">Open for</label>
      <select id="poll-len" class="field" value=${hours} onChange=${(e) => setHours(Number(e.target.value))}>
        ${POLL_HOURS.map(([h, label]) => html`<option key=${h} value=${h}>${label}</option>`)}
      </select>
    </div>
    <label class="switch-row"><span><b>Allow more than one answer</b></span><${Switch} on=${multi} label="Allow more than one answer" onChange=${setMulti} /></label>
    <label class="switch-row"><span><b>Hide results until people vote</b><span class="hint">Nobody sees counts before voting, until the poll ends.</span></span><${Switch} on=${hidden} label="Hide results until people vote" onChange=${setHidden} /></label>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn primary" disabled=${busy} aria-busy=${String(busy)}>${busy ? 'Posting…' : 'Post poll'}</button>
    </div>
  </form>`;
}

// ---------- Link previews ----------
function Embed({ conv, e, m, removable }) {
  const src = (ref) => `/api/files/${ref.id}`;
  const remove = () => {
    call('msg.embeds', { conv, id: m.id, on: false }).then(() => toast('Previews removed', { undo: () => call('msg.embeds', { conv, id: m.id, on: true }).catch(offlineSay) }), offlineSay);
  };
  const x = removable && html`<button class="ib sm embed-x" aria-label="Remove previews from this message" data-tip="Remove previews" onClick=${remove}><${Icon} name="x" size=${14} /></button>`;
  if (e.kind === 'image' && e.image) {
    const w = Math.min(400, e.image.w || 400);
    return html`<div class="embed-media">
      <button class="img" style=${e.image.w && e.image.h ? `aspect-ratio:${e.image.w}/${e.image.h};width:${w}px` : `width:${w}px`} aria-label=${`Open picture from ${e.host}`} onClick=${() => openLightbox(src(e.image), `Picture from ${e.host}`)}>
        <img src=${src(e.image)} alt=${`Picture from ${e.host}`} loading="lazy" />
      </button>${x}
    </div>`;
  }
  if (e.kind === 'video' && e.video) {
    return html`<div class="embed-media"><video class="embed-video" src=${src(e.video)} controls preload="metadata" playsinline aria-label=${`Video from ${e.host}`}></video>${x}</div>`;
  }
  return html`<div class="embed">
    ${x}
    <span class="embed-site">${e.site || e.host}</span>
    ${e.title && html`<a class="embed-title" href=${e.url} target="_blank" rel="noopener noreferrer" data-tip=${e.host}>${e.title}</a>`}
    ${e.description && html`<p class="embed-desc">${e.description}</p>`}
    ${e.image && html`<button class="embed-img" style=${e.image.w && e.image.h ? `aspect-ratio:${e.image.w}/${e.image.h}` : ''} aria-label=${`Open picture for ${e.title || e.host}`} onClick=${() => openLightbox(src(e.image), e.title || e.host)}>
      <img src=${src(e.image)} alt="" loading="lazy" />
    </button>`}
  </div>`;
}

export function Embeds({ conv, m }) {
  if (S.prefs.embeds === false || !m.embeds?.length || m.state) return null;
  const removable = m.author === S.me || modOf(conv);
  return html`<div class="embeds">${m.embeds.map((e, i) => html`<${Embed} key=${i} conv=${conv} e=${e} m=${m} removable=${removable && i === 0} />`)}</div>`;
}

// ---------- Forwarding ----------
function Forwarded({ m, Files }) {
  const f = m.fwd;
  const u = person(f.author);
  // The way back only for people who can read the original.
  const from = convMeta(f.conv);
  return html`<div class="fwd">
    <div class="fwd-label"><${Icon} name="forward" size=${14} />Forwarded</div>
    <div class="fwd-card">
      <div class="fwd-head"><${Avatar} user=${u} size=${20} /><b>${u.name}</b><time class="faint" datetime=${new Date(f.ts).toISOString()} data-tip=${fmtFull(f.ts)}>${fmtWhen(f.ts)}</time></div>
      ${f.text && html`<div class="msg-text"><${Rich} text=${f.text} /></div>`}
      ${m.sticker && m.files?.[0] && html`<img class="sticker" src=${`/api/files/${m.files[0].id}`} alt=${`Sticker: ${m.sticker.name}`} />`}
      ${!m.sticker && m.files?.length > 0 && Files && html`<${Files} files=${m.files} />`}
      ${from && html`<button class="fwd-src" onClick=${() => jumpToMsg(f.conv, f.id)}>From ${from.kind === 'thread' ? `a thread in ${from.where}` : from.title} · Go to message</button>`}
    </div>
  </div>`;
}

function places() {
  const out = [];
  for (const h of S.houseOrder) {
    if (!S.houses[h]?.joined) continue;
    for (const id of roomIds(S, h)) if (S.rooms[id].kind !== 'voice' && canPost(S, id).ok) out.push({ id, title: S.rooms[id].name, hint: S.houses[h].name });
  }
  for (const d of S.dmOrder) { const meta = convMeta(d); if (meta) out.push({ id: d, title: meta.title, hint: meta.user ? 'Direct' : 'Group', user: meta.user }); }
  return out;
}

function ForwardModal({ conv, m }) {
  const [q, setQ] = useState('');
  const [to, setTo] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const all = places();
  const list = (q.trim() ? all.map((p) => ({ p, s: Math.max(fuzzy(q, p.title), fuzzy(q, p.hint) - 5) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.p) : all).slice(0, 40);
  const send = () => {
    if (!to) return setError('Pick where to forward it.');
    setBusy(true);
    const dest = all.find((p) => p.id === to);
    call('msg.forward', { conv, id: m.id, to, comment: note.trim() || undefined, newId: newMsgId() }).then(() => {
      closeModal();
      toast(`Forwarded to ${dest?.title || 'the conversation'}`);
    }, (e) => { setBusy(false); setError(e.offline ? 'You’re offline. Try again when you’re back.' : e.message); });
    return undefined;
  };
  return html`<div class="form fwd-form">
    <h2>Forward message</h2>
    <div class="fwd-preview"><b>${person(m.author).name}</b><span class="trunc">${m.text ? m.text.slice(0, 140) : m.files?.length ? plural(m.files.length, 'attachment') : ''}</span></div>
    <input class="field" type="search" data-autofocus placeholder="Find a room or person" aria-label="Find a room or person" value=${q} onInput=${(e) => setQ(e.target.value)} />
    <div class="fwd-list" role="radiogroup" aria-label="Forward to">
      ${list.length ? list.map((p) => html`<button key=${p.id} type="button" role="radio" aria-checked=${String(to === p.id)} class=${`fwd-dest${to === p.id ? ' on' : ''}`} onClick=${() => { setTo(p.id); setError(''); }}>
        ${p.user ? html`<${Avatar} user=${p.user} size=${24} />` : html`<${Icon} name=${S.rooms[p.id] ? 'room' : 'people'} />`}
        <span class="grow trunc">${p.title}</span><span class="faint trunc">${p.hint}</span>
        <span class="poll-box radio" aria-hidden="true">${to === p.id && html`<${Icon} name="check" size=${12} />`}</span>
      </button>`) : html`<p class="sub">Nowhere matches “${q}”.</p>`}
    </div>
    <textarea class="field" rows="2" maxlength="2000" placeholder="Add a note (optional)" aria-label="Add a note" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn primary" disabled=${busy || !to} aria-busy=${String(busy)} onClick=${send}>${busy ? 'Forwarding…' : 'Forward'}</button>
    </div>
  </div>`;
}

// ---------- Edit history ----------
function EditHistory({ conv, m }) {
  const [state, setState] = useState(null);
  useEffect(() => { call('msg.edits', { conv, id: m.id }).then((r) => setState(r), (e) => setState({ error: e.offline ? 'You’re offline. Try again once you’re back.' : e.message })); }, []);
  return html`
    <h2>Edit history</h2>
    <p class="modal-lead">The last ten versions of this message, newest first. Everyone who can read it can see these.</p>
    <div class="edits" aria-busy=${String(!state)}>
      ${!state ? html`<div class="older"><div class="older-row"><div class="skel"></div><div class="skel" style="width:64%"></div></div></div>`
        : state.error ? html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${state.error}</div>`
          : html`
            <div class="edit-v now"><span class="edit-when">Now · ${fmtFull(state.current.ts)}</span><div class="msg-text"><${Rich} text=${state.current.text} /></div></div>
            ${state.edits.length ? state.edits.map((e, i) => html`<div class="edit-v" key=${i}><span class="edit-when">${fmtFull(e.ts)}</span><div class="msg-text"><${Rich} text=${e.text || ' '} /></div></div>`)
              : html`<p class="sub">No earlier versions are kept for this message.</p>`}`}
    </div>
    <div class="modal-foot"><button class="btn" data-autofocus onClick=${closeModal}>Close</button></div>`;
}

// ---------- Stickers ----------
export function StickerView({ m }) {
  const f = m.files?.[0];
  if (!f) return null;
  return html`<img class="sticker" src=${`/api/files/${f.id}`} alt=${`Sticker: ${m.sticker.name}`} data-tip=${m.sticker.name} width="160" height="160" />`;
}

function StickerPicker({ conv, replyTo }) {
  const houses = S.houseOrder.filter((h) => S.houses[h]?.joined && (S.stickers[h] || []).length);
  const send = (s) => {
    closePop();
    call('sticker.send', { conv, id: newMsgId(), sticker: s.id, ...(replyTo ? { replyTo } : {}) }).then(() => { delete S.ui.reply[conv]; emit(); }, offlineSay);
  };
  return html`<div class="sticker-pick" role="dialog" aria-label="Stickers">
    ${houses.length ? houses.map((h) => html`<section key=${h}>
      <h3 class="menu-label">${S.houses[h].name}</h3>
      <div class="sticker-grid">${S.stickers[h].map((s) => html`<button key=${s.id} class="sticker-btn" aria-label=${`Send sticker ${s.name}`} data-tip=${s.name} onClick=${() => send(s)}>
        <img src=${`/api/stickers/${s.file}`} alt="" loading="lazy" />
      </button>`)}</div>
    </section>`)
      : html`<div class="empty sm"><${Icon} name="sticker" size=${24} /><h2>No stickers yet</h2><p>People who manage emoji can add stickers in House settings, under Emoji.</p></div>`}
  </div>`;
}

export function HouseStickers({ house }) {
  const h = S.houses[house];
  const list = S.stickers?.[house] || [];
  const mayEdit = can(S, house, 'emoji');
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef();
  const add = async (e) => {
    e.preventDefault();
    if (!file) return setError('Choose a PNG, APNG or WebP image.');
    if (name.trim().length < 2) return setError('Give the sticker a name of at least 2 characters.');
    setBusy(true);
    try {
      const res = await fetch(`/api/files?sticker=${encodeURIComponent(house)}`, { method: 'POST', credentials: 'same-origin', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) } });
      const up = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(up.error || 'That image didn’t upload.');
      await call('sticker.add', { house, file: up.id, name: name.trim() });
      setName(''); setFile(null); setError(''); if (input.current) input.current.value = '';
      toast(`Sticker ${name.trim()} added`);
    } catch (err) { setError(err.offline ? 'You’re offline. Try again when you’re back.' : err.message); }
    setBusy(false);
    return undefined;
  };
  return html`
    <div class="set-head">Stickers <span class="faint num" style="font-weight:400">${list.length} of 30</span></div>
    ${mayEdit && html`<form class="sticker-add" onSubmit=${add} novalidate>
      <input type="file" ref=${input} accept="image/png,image/webp,image/apng" aria-label="Sticker image" onChange=${(e) => { setFile(e.target.files[0] || null); setError(''); }} />
      <input class="field" maxlength="30" placeholder="Name" aria-label="Sticker name" value=${name} onInput=${(e) => { setName(e.target.value); setError(''); }} />
      <button class="btn" disabled=${busy || list.length >= 30} aria-busy=${String(busy)}>${busy ? 'Adding…' : 'Add sticker'}</button>
      <p class="hint">PNG, APNG or WebP, up to 512 KB and 320 by 320 pixels.</p>
      ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    </form>`}
    ${list.length ? html`<ul class="sticker-list" aria-label=${`Stickers in ${h.name}`}>${list.map((s) => html`<li key=${s.id}>
      <img src=${`/api/stickers/${s.file}`} alt="" width="48" height="48" />
      <span class="grow trunc">${s.name}</span>
      ${mayEdit && html`<button class="ib sm" aria-label=${`Remove sticker ${s.name}`} data-tip="Remove" onClick=${() => call('sticker.remove', { id: s.id }).catch(offlineSay)}><${Icon} name="trash" size=${16} /></button>`}
    </li>`)}</ul>` : html`<p class="emo-empty">No stickers yet.${mayEdit ? ' Members can send them from the + button by the message box.' : ''}</p>`}`;
}
// House settings > Emoji shows stickers too.
export const withStickers = (Page) => (props) => html`<${Page} ...${props} /><${HouseStickers} ...${props} />`;

// ---------- Scheduled messages ----------
const pad = (n) => String(n).padStart(2, '0');
const localInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function quickTimes(now = new Date()) {
  const at = (days, h) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const out = [['In 1 hour', now.getTime() + 3_600_000]];
  if (now.getHours() < 19) out.push(['This evening', at(0, 20)]);
  out.push(['Tomorrow morning', at(1, 9)]);
  const monday = (8 - now.getDay()) % 7 || 7;
  out.push(['Monday morning', at(monday, 9)]);
  return out;
}

function ScheduleModal({ conv, text, replyTo, done }) {
  const [body, setBody] = useState(text || '');
  const [when, setWhen] = useState(() => localInput(Date.now() + 3_600_000));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const here = S.scheduled.filter((s) => s.conv === conv);
  const submit = (e) => {
    e.preventDefault();
    const at = new Date(when).getTime();
    if (!body.trim()) return setError('Write the message first.');
    if (!Number.isFinite(at) || at < Date.now() + 60_000) return setError('Pick a time at least a minute from now.');
    setBusy(true);
    call('sched.create', { conv, text: body.trim(), at, ...(replyTo ? { replyTo } : {}) }).then(() => {
      closeModal();
      done?.();
      toast(`Scheduled for ${fmtFull(at)}`);
    }, (err) => { setBusy(false); setError(err.offline ? 'You’re offline. Try again when you’re back.' : err.message); });
    return undefined;
  };
  const cancel = (s) => call('sched.cancel', { id: s.id }).then((r) => {
    if (r.gone) return;
    toast('Scheduled message cancelled', { undo: () => call('sched.create', { conv: s.conv, text: s.text, at: Math.max(s.at, Date.now() + 61_000) }).catch(offlineSay) });
  }, offlineSay);
  return html`<form class="form sched-form" onSubmit=${submit} novalidate>
    <h2>Schedule a message</h2>
    <p class="modal-lead">Snug sends it for you at the time you pick, even if you’re away. Up to 30 days ahead.</p>
    <textarea class="field" rows="3" maxlength="4000" data-autofocus aria-label="Message" placeholder="What should it say?" value=${body} onInput=${(e) => { setBody(e.target.value); setError(''); }}></textarea>
    <div class="chips" role="group" aria-label="Quick times">
      ${quickTimes().map(([label, ts]) => html`<button type="button" key=${label} class=${`chip${localInput(ts) === when ? ' on' : ''}`} aria-pressed=${String(localInput(ts) === when)} onClick=${() => setWhen(localInput(ts))}>${label}</button>`)}
    </div>
    <div>
      <label class="label" for="sched-at">Send at</label>
      <input id="sched-at" class="field" type="datetime-local" value=${when} min=${localInput(Date.now() + 60_000)} max=${localInput(Date.now() + 30 * 86_400_000)} onInput=${(e) => { setWhen(e.target.value); setError(''); }} />
    </div>
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    ${here.length > 0 && html`<div class="sched-list">
      <h3 class="label">Waiting here</h3>
      ${here.map((s) => html`<div class="sched-item" key=${s.id}>
        <${Icon} name="clock" size=${16} />
        <span class="grow"><span class="sched-when">${fmtFull(s.at)}</span><span class="trunc sched-text">${s.text}</span></span>
        <button type="button" class="btn sm quiet" aria-label=${`Cancel the message scheduled for ${fmtFull(s.at)}`} onClick=${() => cancel(s)}>Cancel</button>
      </div>`)}
    </div>`}
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Close</button>
      <button class="btn primary" disabled=${busy} aria-busy=${String(busy)}>${busy ? 'Scheduling…' : 'Schedule'}</button>
    </div>
  </form>`;
}

export function ScheduledNote({ conv }) {
  const here = (S.scheduled || []).filter((s) => s.conv === conv);
  if (!here.length) return null;
  const next = here[0];
  return html`<button class="sched-note" onClick=${() => openModal(ScheduleModal, { conv, text: '' })}>
    <${Icon} name="clock" size=${14} /><span class="trunc">${plural(here.length, 'message')} scheduled · next ${fmtWhen(next.at)}</span><span class="link">View</span>
  </button>`;
}

// ---------- Timestamps ----------
const STYLE_NAMES = { t: 'Time', T: 'Time with seconds', d: 'Short date', D: 'Long date', f: 'Date and time', F: 'Day, date and time', R: 'Relative' };
function StampModal({ onInsert }) {
  const [when, setWhen] = useState(() => localInput(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000));
  const [style, setStyle] = useState('f');
  const unix = Math.floor(new Date(when).getTime() / 1000);
  const ok = Number.isFinite(unix);
  return html`
    <h2>Insert a time</h2>
    <p class="modal-lead">Everyone sees it in their own time zone and language.</p>
    <div>
      <label class="label" for="stamp-at">Date and time</label>
      <input id="stamp-at" class="field" type="datetime-local" data-autofocus value=${when} onInput=${(e) => setWhen(e.target.value)} />
    </div>
    <div class="stamp-styles" role="radiogroup" aria-label="How it reads">
      ${STAMP_STYLES.map((s) => html`<button key=${s} type="button" role="radio" aria-checked=${String(style === s)} class=${`stamp-opt${style === s ? ' on' : ''}`} onClick=${() => setStyle(s)}>
        <span class="faint">${STYLE_NAMES[s]}</span><b>${ok ? fmtStamp(unix, s) : '—'}</b>
      </button>`)}
    </div>
    <div class="modal-foot">
      <button class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn primary" disabled=${!ok} onClick=${() => { closeModal(); onInsert(`<t:${unix}:${style}>`); }}>Insert</button>
    </div>`;
}

// ---------- The composer: + menu, formatting bar and shortcuts ----------
export function PlusMenu({ conv, text, update, insert, replyTo }) {
  const open = (e) => {
    const anchor = rectOf(e);
    openMenu({
      anchor, align: 'start',
      items: [
        { label: 'Create a poll', icon: 'poll', onSelect: () => openModal(PollModal, { conv }) },
        { label: 'Send a sticker', icon: 'sticker', onSelect: () => openPop({ anchor, align: 'start', label: 'Stickers', C: StickerPicker, props: { conv, replyTo } }) },
        { label: 'Insert a time', icon: 'calendar', onSelect: () => openModal(StampModal, { onInsert: (tok) => insert(`${tok} `) }) },
        { label: 'Schedule a message', icon: 'clock', onSelect: () => openModal(ScheduleModal, { conv, text, replyTo, done: () => update('') }) },
      ],
    });
  };
  return html`<button class="ib plus-btn" aria-label="More: poll, sticker, time, schedule" data-tip="Poll, sticker, time, schedule" aria-haspopup="menu" onClick=${open}><${Icon} name="plus" /></button>`;
}

const WRAPS = {
  bold: ['**', '**'], italic: ['*', '*'], underline: ['__', '__'], strike: ['~~', '~~'], code: ['`', '`'], spoiler: ['||', '||'],
};
// Wrap the selection in markup, or take it off again if it is already there.
export function applyFormat(el, text, update, kind) {
  const a = el.selectionStart, b = el.selectionEnd;
  const sel = text.slice(a, b);
  let next, s0, s1;
  if (kind === 'quote') {
    const start = text.lastIndexOf('\n', a - 1) + 1;
    const lines = text.slice(start, b).split('\n');
    const quoted = lines.every((l) => l.startsWith('> '));
    const body = lines.map((l) => (quoted ? l.slice(2) : `> ${l}`)).join('\n');
    next = text.slice(0, start) + body + text.slice(b);
    s0 = start; s1 = start + body.length;
  } else if (kind === 'link') {
    const label = sel || 'text';
    next = `${text.slice(0, a)}[${label}](https://)${text.slice(b)}`;
    s0 = a + label.length + 3; s1 = s0 + 8;
  } else {
    const [pre, post] = WRAPS[kind];
    if (text.slice(a - pre.length, a) === pre && text.slice(b, b + post.length) === post) {
      next = text.slice(0, a - pre.length) + sel + text.slice(b + post.length);
      s0 = a - pre.length; s1 = b - pre.length;
    } else {
      next = text.slice(0, a) + pre + sel + post + text.slice(b);
      s0 = a + pre.length; s1 = b + pre.length;
    }
  }
  // Changed in place first, so the selection lands on the text at once (the
  // re-render then finds the same value and leaves the caret alone).
  el.value = next;
  el.setSelectionRange(s0, s1);
  update(next);
  requestAnimationFrame(() => el.focus());
}

// Ctrl (or Cmd) + B, I, U, E (code), K (link), Shift+X (strikethrough). True if handled.
export function formatKey(e, el, text, update) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !el) return false;
  const k = e.key.toLowerCase();
  const kind = e.shiftKey ? (k === 'x' ? 'strike' : null) : { b: 'bold', i: 'italic', u: 'underline', e: 'code', k: 'link' }[k];
  if (!kind) return false;
  e.preventDefault();
  applyFormat(el, text, update, kind);
  return true;
}

const BAR = [['bold', 'Bold', 'Ctrl+B'], ['italic', 'Italic', 'Ctrl+I'], ['underline', 'Underline', 'Ctrl+U'], ['strike', 'Strikethrough', 'Ctrl+Shift+X'], ['code', 'Code', 'Ctrl+E'], ['spoiler', 'Spoiler', ''], ['link', 'Link', 'Ctrl+K'], ['quote', 'Quote', '']];
// Appears above the box while text in it is selected.
export function FormatBar({ ta, text, update }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const check = () => { const el = ta.current; setShown(!!el && document.activeElement === el && el.selectionEnd > el.selectionStart); };
    document.addEventListener('selectionchange', check);
    const el = ta.current;
    el?.addEventListener('select', check);
    el?.addEventListener('blur', check);
    return () => { document.removeEventListener('selectionchange', check); el?.removeEventListener('select', check); el?.removeEventListener('blur', check); };
  }, []);
  const el = ta.current;
  // Checked again on every render too: sending empties the box without a selection event.
  if (!shown || !el || !text || el.selectionEnd <= el.selectionStart) return null;
  return html`<div class="fmt-bar float" role="toolbar" aria-label="Format the selected text" onMouseDown=${(e) => e.preventDefault()}>
    ${BAR.map(([kind, label, keys]) => html`<button key=${kind} type="button" class="ib sm" aria-label=${label} data-tip=${keys ? `${label} (${keys})` : label} onClick=${() => applyFormat(ta.current, text, update, kind)}><${Icon} name=${kind} size=${16} /></button>`)}
  </div>`;
}

// ---------- On a message ----------
export function MessageExtras({ conv, m, Files }) {
  return html`
    ${m.poll && html`<${Poll} conv=${conv} m=${m} />`}
    ${m.fwd && html`<${Forwarded} m=${m} Files=${Files} />`}
    ${m.sticker && !m.fwd && html`<${StickerView} m=${m} />`}
    <${Embeds} conv=${conv} m=${m} />`;
}
// Files are drawn by the stream except where a sticker or a forward draws them.
export const ownsFiles = (m) => !!(m.sticker || m.fwd);

export function messagingMenuItems(conv, m) {
  if (m.state || m.call) return [];
  const mine = m.author === S.me;
  const pollOpen = m.poll && !(m.poll.ended || m.poll.ends <= Date.now());
  return [
    !m.poll && { label: 'Forward', icon: 'forward', onSelect: () => openModal(ForwardModal, { conv, m }) },
    m.edited && { label: 'Edit history', icon: 'history', onSelect: () => openModal(EditHistory, { conv, m }) },
    m.embeds?.length && (mine || modOf(conv)) && { label: 'Remove previews', icon: 'link', onSelect: () => call('msg.embeds', { conv, id: m.id, on: false }).catch(offlineSay) },
    m.noEmbeds && mine && { label: 'Show previews again', icon: 'link', onSelect: () => call('msg.embeds', { conv, id: m.id, on: true }).catch(offlineSay) },
    pollOpen && (m.poll.by === S.me || modOf(conv)) && { label: 'End poll now', icon: 'poll', onSelect: () => endPoll(conv, m) },
  ].filter(Boolean);
}

// ---------- In a conversation: first unread, and a date ----------
export function UnreadBar({ conv, scroller }) {
  const [above, setAbove] = useState(false);
  const marker = S.ui.marker[conv];
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const check = () => {
      const line = el.querySelector('.newline');
      setAbove(!!line && line.offsetTop < el.scrollTop + 8);
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    return () => el.removeEventListener('scroll', check);
  }, [marker, (S.msgs[conv] || []).length]);
  if (!marker || !above) return null;
  const n = (S.msgs[conv] || []).filter((m) => m.ts >= marker && m.author !== S.me && !m.call).length;
  if (!n) return null;
  const jump = () => scroller.current?.querySelector('.newline')?.scrollIntoView({ block: 'start' });
  const done = () => { delete S.ui.marker[conv]; delete S.ui.hold[conv]; markRead(conv); emit(); };
  return html`<div class="unread-bar" role="status">
    <button class="unread-jump" onClick=${jump}><span class="flip"><${Icon} name="down" size=${14} /></span><span>${plural(n, 'new message')} since ${fmtTime(marker)}</span><span class="link">Jump</span></button>
    <button class="unread-done" onClick=${done}>Mark as read</button>
  </div>`;
}

function DatePop({ conv }) {
  const [day, setDay] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; });
  const [busy, setBusy] = useState(false);
  const goTo = (e) => {
    e.preventDefault();
    const [y, mo, d] = day.split('-').map(Number);
    const ts = new Date(y, mo - 1, d).getTime();
    if (!Number.isFinite(ts)) return;
    setBusy(true);
    call('msg.at', { conv, ts }).then((r) => {
      closePop();
      if (!r.id) toast('Nothing has been said here yet.');
      else jumpToMsg(conv, r.id);
    }, (err) => { setBusy(false); offlineSay(err); });
  };
  return html`<form class="date-pop" onSubmit=${goTo}>
    <label class="label" for="jump-date">Go to a date</label>
    <input id="jump-date" class="field" type="date" data-autofocus value=${day} max=${new Date().toISOString().slice(0, 10)} onInput=${(e) => setDay(e.target.value)} />
    <button class="btn primary" disabled=${busy || !day} aria-busy=${String(busy)}>${busy ? 'Finding…' : 'Go'}</button>
  </form>`;
}

export function JumpToDate({ conv }) {
  if (isThread(conv)) return null;
  return html`<button class="ib" aria-label="Go to a date" data-tip="Go to a date" onClick=${(e) => openPop({ anchor: rectOf(e), align: 'end', label: 'Go to a date', C: DatePop, props: { conv } })}><${Icon} name="calendar" /></button>`;
}

// ---------- Settings > Appearance ----------
export function MessagingSettings({ Row }) {
  return html`<div class="set-head">Messages</div>
    <${Row} label="Link previews" hint="Show a card with the title and picture of links people send, and pictures and videos linked directly. Snug fetches them, so the sites never see you.">
      <${Switch} on=${S.prefs.embeds !== false} label="Link previews" onChange=${(v) => setPref('embeds', v)} />
    <//>
    ${(S.prefs.trustedHosts || []).length > 0 && html`<${Row} label="Sites that open without asking" hint=${S.prefs.trustedHosts.join(', ')}>
      <button class="btn" onClick=${() => { S.prefs.trustedHosts = []; persist(); emit(); toast('Snug will ask again before opening those sites'); }}>Ask again</button>
    <//>`}`;
}

// ---------- Search: dates, and suggestions while typing an operator ----------
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function SearchDateFilter({ q, set, setOp, p }) {
  const kind0 = p.during ? 'during' : p.after ? 'after' : 'before';
  const [kind, setKind] = useState(kind0);
  const [day, setDay] = useState(p[kind0] && /^\d{4}-\d{2}-\d{2}$/.test(p[kind0]) ? p[kind0] : todayStr());
  const apply = (e) => {
    e.preventDefault();
    let next = q;
    for (const k of ['before', 'after', 'during']) next = setOp(next, k, null);
    set(setOp(next, kind, day));
    closePop();
  };
  const clear = () => { let next = q; for (const k of ['before', 'after', 'during']) next = setOp(next, k, null); set(next); closePop(); };
  return html`<form class="date-pop" onSubmit=${apply}>
    <div class="seg" role="group" aria-label="When">
      ${[['before', 'Before'], ['during', 'On'], ['after', 'After']].map(([v, t]) => html`<button key=${v} type="button" aria-pressed=${String(kind === v)} onClick=${() => setKind(v)}>${t}</button>`)}
    </div>
    <input class="field" type="date" aria-label="Date" data-autofocus value=${day} onInput=${(e) => setDay(e.target.value)} />
    <div class="date-pop-acts">
      ${(p.before || p.after || p.during) && html`<button type="button" class="btn quiet" onClick=${clear}>Any time</button>`}
      <button class="btn primary" disabled=${!day}>Apply</button>
    </div>
  </form>`;
}
export const dateChipLabel = (p) => (p.during ? `On ${p.during}` : p.before && p.after ? `${p.after} to ${p.before}` : p.before ? `Before ${p.before}` : p.after ? `After ${p.after}` : 'Any time');

// While the last word is an operator (from:, in:, mentions:, has:, before:...), offer its values.
export function searchSuggestions(q, places) {
  const m = /(?:^|\s)([a-z]*)(?::("?)([^"\s]*))?$/i.exec(q || '');
  if (!m) return [];
  const [whole, key, , part] = m;
  const head = q.slice(0, q.length - whole.length + (whole.startsWith(' ') ? 1 : 0));
  const out = [];
  const people = Object.values(S.users);
  if (whole.includes(':')) {
    const k = key.toLowerCase();
    const term = part.toLowerCase();
    const add = (value, label, hint) => out.push({ label, hint, q: `${head}${k}:${/\s/.test(value) ? `"${value}"` : value} ` });
    if (k === 'from' || k === 'mentions') {
      for (const u of people.map((u) => ({ u, s: Math.max(fuzzy(term, u.name), fuzzy(term, u.handle)) })).filter((x) => !term || x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 6)) add(u.u.handle, u.u.name, `@${u.u.handle}`);
    } else if (k === 'in') {
      for (const n of places.filter((n) => !term || fuzzy(term, n) >= 0).slice(0, 6)) add(n.toLowerCase(), n, 'Place');
    } else if (k === 'has') {
      for (const [v, label] of [['image', 'A picture'], ['file', 'A file'], ['link', 'A link'], ['poll', 'A poll'], ['sticker', 'A sticker'], ['video', 'A video'], ['embed', 'A link preview']]) if (v.startsWith(term)) add(v, label, `has:${v}`);
    } else if (k === 'before' || k === 'after' || k === 'during') {
      const d = new Date();
      const y = new Date(Date.now() - 86_400_000);
      add(todayStr(d), 'Today', todayStr(d));
      add(todayStr(y), 'Yesterday', todayStr(y));
      add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`, 'This month', `${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    } else if (k === 'pinned') add('true', 'Pinned messages only', 'pinned:true');
    return out;
  }
  if (key.length >= 2) {
    for (const [op, hint] of [['from', 'Sent by someone'], ['mentions', 'Mentions someone'], ['in', 'In a room or conversation'], ['has', 'Has a picture, file, link, poll…'], ['before', 'Before a date'], ['after', 'After a date'], ['during', 'On a day or in a month'], ['pinned', 'Pinned messages']]) {
      if (op.startsWith(key.toLowerCase()) && op !== key.toLowerCase()) out.push({ label: `${op}:`, hint, q: `${head}${op}:`, keep: true });
    }
  }
  return out;
}

export function SearchSuggest({ q, set, places, input }) {
  const [focused, setFocused] = useState(false);
  const box = useRef();
  useEffect(() => {
    const el = input.current;
    if (!el) return undefined;
    const inside = () => box.current?.contains(document.activeElement) || document.activeElement === el;
    const f = () => setFocused(true);
    const b = () => setTimeout(() => setFocused(inside()), 0);
    // Down arrow from the field steps into the suggestions.
    const k = (e) => { if (e.key === 'ArrowDown' && box.current?.firstElementChild) { e.preventDefault(); box.current.firstElementChild.focus(); } };
    el.addEventListener('focus', f); el.addEventListener('blur', b); el.addEventListener('keydown', k);
    if (document.activeElement === el) setFocused(true);
    return () => { el.removeEventListener('focus', f); el.removeEventListener('blur', b); el.removeEventListener('keydown', k); };
  }, []);
  const list = searchSuggestions(q, places);
  if (!list.length || !focused) return null;
  const pickIt = (s) => { set(s.q); requestAnimationFrame(() => input.current?.focus()); };
  return html`<div class="search-suggest float" role="listbox" aria-label="Suggestions" ref=${box} onFocusOut=${() => setTimeout(() => setFocused(box.current?.contains(document.activeElement) || document.activeElement === input.current), 0)}>
    ${list.map((s, i) => html`<button key=${i} role="option" aria-selected="false" class="menu-item" onMouseDown=${(e) => { e.preventDefault(); pickIt(s); }}
      onKeyDown=${(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.nextElementSibling?.focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling || input.current)?.focus(); } else if (e.key === 'Enter') { e.preventDefault(); pickIt(s); } }}>
      <span class="grow trunc">${s.label}</span><span class="end">${s.hint}</span>
    </button>`)}
  </div>`;
}
