// A stream is one conversation: its messages and its composer. Rooms, direct
// messages and threads are all the same component.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import {
  S, person, emit, persist, PAGE, scrollPos, convMeta, findMsg, isSaved, isOnline, membersOf, markRead, markUnreadFrom,
  openThread, openMenu, openPop, closePop, react, toggleSave, toggleHighlight, deleteMsg, editMsg, setReply,
  setEditing, openLightbox, toast, setPresence, setStatus,
} from '../store.js';
import { sendMessage, retry, sendTyping, uploadFile, loadHistory } from '../server.js';
import { buildItems } from '../lib/group.js';
import { unreadOf, isThread, forMe } from '../lib/attention.js';
import { can, canPost, roleOf } from '../lib/perms.js';
import { fmtTime, fmtDay, fmtFull, fmtWhen, plural, fileSize, fuzzy, nameList, hueOf } from '../lib/util.js';
import { plain, isJumbo } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Rich, Stack, PRESENCE, copyText } from '../ui/kit.js';
import { showProfile } from './people.js';
import { EmojiPicker, EMOJI, QUICK } from './emoji.js';
import { CustomEmoji, asTyped, customSuggest, parseKey, reactionFace, reactionLabel, resolveEmoji } from './emoji-custom.js'; // custom emoji per house
import { mediaFile, pinMenuItem, PinnedMark, withPinLines, PinLine, VoiceButton, GifButton } from './media.js'; // voice messages, pins, GIFs
import { CallLine } from './calls.js'; // call records, written by the server
import { msgFace, colourRole, BotBadge, PostTitle, RoleIconMark } from './places.js'; // nicknames, bots, role colours and icons, forum post titles
import { messageItems, hiddenBlocked, BlockedLine, composerGate, GateNote, SlowNote, slowLeft } from './safety.js'; // blocks, reports, moderation, slowmode
import { MessageExtras, ownsFiles, messagingMenuItems, PlusMenu, FormatBar, formatKey, ScheduledNote, UnreadBar } from './messaging.js'; // polls, previews, forwarding, stickers, formatting, scheduling

const rectOf = (e) => e.currentTarget.getBoundingClientRect();
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;
const coarse = () => matchMedia('(pointer: coarse)').matches;

// Focus now if the box exists, and again after the next render in case it
// is about to appear (for example right after opening a room).
export function focusComposer(conv) {
  const f = () => document.querySelector(`[data-composer="${CSS.escape(conv)}"] textarea`)?.focus();
  f();
  requestAnimationFrame(f);
}

function pickReaction(conv, m, anchor) {
  openPop({ anchor, align: 'end', label: 'Add a reaction', C: EmojiPicker, props: { onPick: (e) => { closePop(); react(conv, m.id, e); } } });
}

// The same actions, in the same order, wherever a message appears.
export function messageMenu(conv, m, pos) {
  const meta = convMeta(conv);
  const mine = m.author === S.me;
  const room = S.rooms[conv];
  const mod = meta.house && can(S, meta.house, 'moderate');
  const saved = isSaved(m.id);
  const replies = (S.msgs[`t:${m.id}`] || []).length;
  openMenu({
    ...pos, align: 'end', owner: m.id,
    quick: { emoji: QUICK, onPick: (e) => react(conv, m.id, e) },
    items: [
      !m.state && { label: 'Reply', icon: 'reply', hint: 'R', onSelect: () => { setReply(conv, m.id); focusComposer(conv); } },
      !isThread(conv) && !m.state && { label: replies ? 'Open thread' : 'Start a thread', icon: 'thread', hint: 'T', onSelect: () => openThread(conv, m.id) },
      { label: saved ? 'Remove from Saved' : 'Save', icon: saved ? 'saved' : 'save', hint: 'S', onSelect: () => toggleSave(conv, m.id) },
      { sep: true },
      { label: 'Copy text', icon: 'copy', onSelect: () => copyText(asTyped(m.text)) },
      !mine && { label: 'Mark unread from here', icon: 'eye', onSelect: () => markUnreadFrom(conv, m) },
      room && can(S, meta.house, 'highlight') && {
        label: room.highlights.includes(m.id) ? 'Remove from highlights' : 'Add to room highlights', icon: 'pin',
        onSelect: () => toggleHighlight(conv, m.id),
      },
      pinMenuItem(conv, m),
      ...messagingMenuItems(conv, m), // forward, edit history, previews, end a poll
      (mine || mod) && { sep: true },
      mine && { label: 'Edit', icon: 'edit', hint: 'E', onSelect: () => setEditing(m.id) },
      (mine || mod) && { label: 'Delete', icon: 'trash', danger: true, onSelect: () => deleteMsg(conv, m.id) },
      ...messageItems(conv, m), // report, block, and a moderator's actions on the author
    ],
  });
}

function grow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function EditBox({ conv, m }) {
  const [text, setText] = useState(() => asTyped(m.text)); // custom emoji edit as :name:
  const ref = useRef();
  useEffect(() => {
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => grow(ref.current), [text]);
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); editMsg(conv, m.id, resolveEmoji(conv, text, m.text)); focusComposer(conv); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); focusComposer(conv); }
  };
  return html`<div class="msg-edit">
    <textarea class="field" rows="1" ref=${ref} value=${text} aria-label="Edit message" onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey}></textarea>
    <div class="hint">Enter to save, Esc to cancel. Saving it empty keeps the original.</div>
  </div>`;
}

function Files({ files }) {
  return html`<div class="files">
    ${files.map((f, i) => {
      const url = f.id ? `/api/files/${f.id}` : null;
      const src = f.src || url;
      const media = mediaFile(f, src, i);
      if (media) return media;
      if (f.kind === 'image' && src) {
        return html`<button key=${i} class="img" style=${`aspect-ratio:${f.w}/${f.h};width:${Math.min(420, f.w)}px`}
          aria-label=${`Open image ${f.name}`} onClick=${() => openLightbox(src, f.name)}>
          <img src=${src} alt=${f.name} />
        </button>`;
      }
      const body = html`<${Icon} name=${f.kind === 'image' ? 'image' : 'file'} />
        <span class="trunc"><span class="file-name trunc" style="display:block">${f.name}</span><span class="file-size">${fileSize(f.size || 0)}${url ? ', download' : ''}</span></span>`;
      return url
        ? html`<a key=${i} class="file" href=${url} download=${f.name}>${body}</a>`
        : html`<div key=${i} class="file">${body}</div>`;
    })}
  </div>`;
}

export function Message({ conv, m, grouped, inThread, tab, lit }) {
  const u = msgFace(m, convMeta(conv)?.house); // nickname and picture in this house, or a bot's name (js/views/places.js)
  const meta = convMeta(conv);
  const role = meta?.house && !m.bot ? colourRole(meta.house, m.author) : null; // highest coloured role (js/views/places.js)
  const pending = m.state === 'sending' || m.state === 'queued';
  const toMe = forMe(S, conv, m);
  const replies = isThread(conv) ? [] : S.msgs[`t:${m.id}`] || [];
  const quoted = m.replyTo ? findMsg(conv, m.replyTo) : null;
  const saved = isSaved(m.id);
  const press = useRef();
  if (hiddenBlocked(m)) return html`<${BlockedLine} m=${m} />`; // from someone I blocked: folded away until shown
  const profile = (who) => (e) => showProfile(who, rectOf(e), meta?.house);

  const menu = (pos) => messageMenu(conv, m, pos);
  const onContext = (e) => {
    if (getSelection()?.toString() || e.target.closest('a, textarea')) return;
    e.preventDefault();
    menu({ x: e.clientX, y: e.clientY });
  };
  const onDown = (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('button, a, textarea')) return;
    const x = e.clientX, y = e.clientY;
    press.current = setTimeout(() => menu({ x, y }), 450);
  };
  const cancel = () => clearTimeout(press.current);

  const cls = `msg${grouped ? ' grouped' : ''}${toMe ? ' mention' : lit ? ' mention lit' : ''}${pending ? ' pending' : ''}${quoted ? ' has-ref' : ''}${S.ui.menu?.owner === m.id ? ' menu-open' : ''}`;
  const reactions = Object.entries(m.reactions || {});
  const threadUnread = replies.length ? unreadOf(S, `t:${m.id}`).count : 0;
  const authors = [...new Set(replies.map((r) => r.author))].map((id) => person(id));

  return html`<div class=${cls} data-id=${m.id} data-conv=${conv} tabindex=${tab ? 0 : -1}
    onContextMenu=${onContext} onPointerDown=${onDown} onPointerUp=${cancel} onPointerMove=${cancel} onPointerCancel=${cancel}>
    ${quoted && html`<button class="reply-ref" onClick=${() => { S.ui.jump = { conv, id: quoted.id, n: (S.ui.jump?.n || 0) + 1 }; emit(); }}>
      <${Avatar} user=${person(quoted.author)} />
      <b>${person(quoted.author).name}</b>
      <span class="trunc">${plain(quoted.text) || 'Attachment'}</span>
    </button>`}
    <div class="msg-gutter">
      ${grouped
        ? html`<time class="time" datetime=${new Date(m.ts).toISOString()}>${fmtTime(m.ts)}</time>`
        : html`<${Avatar} user=${u} onClick=${profile(u)} />`}
    </div>
    <div class="msg-body">
      ${!grouped && html`<div class="msg-head">
        <button class=${`msg-name${role?.hue != null ? ' hued' : ''}`} style=${role?.hue != null ? `--hue:${hueOf(role.hue)}` : ''} onClick=${profile(u)}>${u.name}</button>
        ${meta?.house && !m.bot && html`<${RoleIconMark} house=${meta.house} uid=${m.author} />`}<${BotBadge} m=${m} />
        <time class="msg-time" datetime=${new Date(m.ts).toISOString()} data-tip=${fmtFull(m.ts)}>${fmtTime(m.ts)}</time>
      </div>`}
      <${PinnedMark} conv=${conv} id=${m.id} />
      <${PostTitle} m=${m} />
      ${S.ui.editing === m.id
        ? html`<${EditBox} conv=${conv} m=${m} />`
        : m.text && !m.poll && html`<div class=${`msg-text${isJumbo(m.text) ? ' jumbo' : ''}`}>
            <${Rich} m=${m} onMention=${(who, e) => showProfile(who, e.target.getBoundingClientRect(), meta?.house)} />
            ${m.edited && html`<span class="edited" data-tip=${`Edited ${fmtFull(m.edited)}`}>(edited)</span>`}
          </div>`}
      ${m.files?.length > 0 && !ownsFiles(m) && html`<${Files} files=${m.files} />`}
      <${MessageExtras} conv=${conv} m=${m} Files=${Files} />
      ${reactions.length > 0 && html`<div class="reactions">
        ${reactions.map(([e, who]) => {
          const names = nameList(who.map((id) => (id === S.me ? 'You' : person(id).name.split(' ')[0])));
          return html`<button key=${e} class=${`rx${who.includes(S.me) ? ' mine' : ''}`} aria-pressed=${String(who.includes(S.me))}
            aria-label=${`${reactionLabel(e, m)}, ${plural(who.length, 'reaction')}: ${names}`} data-tip=${names} onClick=${() => react(conv, m.id, e)}>
            <span>${reactionFace(e, m)}</span><span>${who.length}</span>
          </button>`;
        })}
        <button class="rx add" aria-label="Add a reaction" data-tip="Add a reaction" onClick=${(e) => pickReaction(conv, m, rectOf(e))}><${Icon} name="react" size=${16} /></button>
      </div>`}
      ${replies.length > 0 && !inThread && html`<div><button class=${`stub${threadUnread ? ' unread' : ''}`} onClick=${() => openThread(conv, m.id)}>
        <${Stack} users=${authors} />
        <b>${plural(replies.length, 'reply', 'replies')}</b>
        <span class="faint trunc">Last ${fmtWhen(replies[replies.length - 1].ts)}</span>
      </button></div>`}
      ${m.state === 'queued' && html`<div class="msg-state"><${Icon} name="offline" size=${14} />Waiting for a connection. It will send by itself.</div>`}
      ${m.state === 'failed' && html`<div class="msg-state failed" role="alert">
        <${Icon} name="alert" size=${14} />Not sent. ${m.error || ''}
        <button onClick=${() => retry(conv, m)}>Try again</button>
        <button onClick=${() => deleteMsg(conv, m.id)}>Delete</button>
      </div>`}
    </div>
    ${S.ui.editing !== m.id && html`<div class="msg-actions float" role="toolbar" aria-label="Message actions">
      <button class="ib" aria-label="Add a reaction" data-tip="Add a reaction" onClick=${(e) => pickReaction(conv, m, rectOf(e))}><${Icon} name="react" size=${18} /></button>
      ${!m.state && html`<button class="ib" aria-label="Reply" data-tip="Reply" data-key="R" onClick=${() => { setReply(conv, m.id); focusComposer(conv); }}><${Icon} name="reply" size=${18} /></button>`}
      ${!isThread(conv) && !inThread && !m.state && html`<button class="ib" aria-label=${replies.length ? 'Open thread' : 'Start a thread'} data-tip=${replies.length ? 'Open thread' : 'Start a thread'} data-key="T" onClick=${() => openThread(conv, m.id)}><${Icon} name="thread" size=${18} /></button>`}
      <button class=${`ib${saved ? ' on' : ''}`} aria-pressed=${String(saved)} aria-label=${saved ? 'Remove from Saved' : 'Save'} data-tip=${saved ? 'Remove from Saved' : 'Save'} data-key="S" onClick=${() => toggleSave(conv, m.id)}><${Icon} name=${saved ? 'saved' : 'save'} size=${18} /></button>
      <button class="ib" aria-label="More actions" data-tip="More" onClick=${(e) => menu({ anchor: rectOf(e) })}><${Icon} name="more" size=${18} /></button>
    </div>`}
  </div>`;
}

// Composer
const COMMANDS = [
  { name: 'status', hint: 'Set your status line, or clear it' },
  { name: 'open', hint: 'Show that you are open to talk' },
  { name: 'around', hint: 'Show that you are around' },
  { name: 'focus', hint: 'Hold notifications while you work' },
  { name: 'away', hint: 'Show that you are away' },
  { name: 'shrug', hint: 'Add ¯\\_(ツ)_/¯ to your message' },
];

function runCommand(conv, body) {
  const [, name, rest = ''] = /^\/(\w+)\s*([\s\S]*)$/.exec(body) || [];
  if (name === 'status') { setStatus(rest); toast(rest.trim() ? `Status set to “${rest.trim()}”` : 'Status cleared'); return true; }
  if (PRESENCE[name] && name !== 'offline') { setPresence(name); toast(`You’re shown as ${PRESENCE[name].label.toLowerCase()}`); return true; }
  if (name === 'shrug') { sendMessage(conv, `${rest} ¯\\_(ツ)_/¯`.trim()); return true; }
  return false;
}

function suggest(value, caret, conv) {
  const before = value.slice(0, caret);
  let m;
  if ((m = /(?:^|\s)@([\w.-]*)$/.exec(before))) {
    const q = m[1];
    const items = membersOf(conv).filter((id) => id !== S.me).map((id) => S.users[id])
      .map((u) => ({ u, s: Math.max(fuzzy(q, u.name), fuzzy(q, u.handle)) }))
      .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.u);
    if (items.length) return { kind: 'at', from: caret - q.length - 1, items, i: 0 };
  }
  if ((m = /(?:^|\s):([a-z0-9_+-]{2,})$/i.exec(before))) {
    const q = m[1].toLowerCase();
    const items = [...customSuggest(q, conv), ...EMOJI.filter(([, names]) => names.includes(q))].slice(0, 6);
    if (items.length) return { kind: 'emoji', from: caret - q.length - 1, items, i: 0 };
  }
  if ((m = /^\/(\w*)$/.exec(before))) {
    const items = COMMANDS.filter((c) => c.name.startsWith(m[1].toLowerCase()));
    if (items.length) return { kind: 'cmd', from: 0, items, i: 0 };
  }
  return null;
}

const MAX_FILE = 10 * 1024 * 1024;

// Photos are scaled down to 1600px and re-encoded before upload: smaller to
// send, and it strips location and camera data. GIFs keep their animation.
function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (file.type === 'image/gif') { resolve({ blob: file, w: img.naturalWidth, h: img.naturalHeight, src: url }); return; }
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      c.toBlob((blob) => (blob ? resolve({ blob, w: c.width, h: c.height, src: url }) : reject(new Error('unreadable'))), type, 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    img.src = url;
  });
}

export function Composer({ conv, placeholder }) {
  const [text, setText] = useState(S.drafts[conv] || '');
  const [files, setFiles] = useState([]);
  const [ac, setAc] = useState(null);
  const ta = useRef();
  const fileIn = useRef();
  // Custom emoji chosen in the picker, by name: when two houses both have
  // :party:, the one picked is the one sent.
  const picked = useRef(new Map());
  const gate = canPost(S, conv);
  const replyId = S.ui.reply[conv];
  const replyTo = replyId ? findMsg(conv, replyId) : null;

  useEffect(() => { if (!coarse()) ta.current?.focus(); }, []);
  useLayoutEffect(() => grow(ta.current), [text]);

  const update = (v) => {
    setText(v);
    if (v) S.drafts[conv] = v; else delete S.drafts[conv];
    persist();
  };
  const onInput = (e) => {
    update(e.target.value);
    if (e.target.value.trim() && !e.target.value.startsWith('/')) sendTyping(conv);
    setAc(suggest(e.target.value, e.target.selectionStart, conv));
  };
  const insert = (str, from, to) => {
    const el = ta.current;
    const a = from ?? el.selectionStart, b = to ?? el.selectionEnd;
    const next = text.slice(0, a) + str + text.slice(b);
    update(next);
    setAc(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + str.length, a + str.length); });
  };
  const accept = (item) => {
    const to = ta.current.selectionStart;
    if (ac.kind === 'at') insert(`@${item.handle} `, ac.from, to);
    else if (ac.kind === 'emoji') {
      if (item[2]?.id) picked.current.set(item[1], `<:${item[1]}:${item[2].id}>`); // a custom emoji suggestion
      insert(`${item[0]} `, ac.from, to);
    }
    else insert(`/${item.name} `, 0, to);
  };
  const uploading = files.some((f) => f.status === 'uploading');
  const submit = () => {
    if (slowLeft(conv)) { toast('Slowmode is on here. Wait for the countdown, then send.'); return; }
    const body = text.trim();
    const ready = files.filter((f) => f.status === 'ready');
    if (uploading || (!body && !ready.length)) return;
    if (files.some((f) => f.status === 'error')) { toast('Remove the attachment that didn\u2019t upload, or attach it again.'); return; }
    const out = ready.map(({ id, kind, name, size, w, h, src }) => ({ id, kind, name, size, w, h, src }));
    if (!(body.startsWith('/') && runCommand(conv, body))) sendMessage(conv, resolveEmoji(conv, body, [...picked.current.values()].join(' ')), { replyTo: replyTo?.id, files: out });
    picked.current.clear();
    update('');
    setFiles([]);
    setAc(null);
  };
  const onKey = (e) => {
    if (formatKey(e, ta.current, text, update)) return; // Ctrl+B, I, U, E, K, Shift+X (js/views/messaging.js)
    if (ac) {
      const n = ac.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); return setAc({ ...ac, i: (ac.i + 1) % n }); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return setAc({ ...ac, i: (ac.i - 1 + n) % n }); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return accept(ac.items[ac.i]); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return setAc(null); }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'ArrowUp' && !text) {
      const mine = (S.msgs[conv] || []).filter((m) => m.author === S.me && !m.state).pop();
      if (mine) { e.preventDefault(); setEditing(mine.id); }
    } else if (e.key === 'Escape' && replyTo) { e.preventDefault(); e.stopPropagation(); setReply(conv, null); }
  };
  // Each file uploads as soon as it is attached, so Send is instant.
  const patch = (key, d) => setFiles((cur) => cur.map((x) => (x.key === key ? { ...x, ...d } : x)));
  const addFiles = async (list) => {
    for (const f of list.slice(0, 6 - files.length)) {
      if (f.size > MAX_FILE) { toast(`${f.name} is ${fileSize(f.size)}. Files can be up to 10 MB.`); continue; }
      const key = Math.random().toString(36).slice(2);
      const image = /^image\/(png|jpeg|gif|webp)$/.test(f.type);
      setFiles((cur) => [...cur, { key, kind: image ? 'image' : 'file', name: f.name, size: f.size, status: 'uploading' }]);
      try {
        let blob = f, extra = {};
        if (image) { const r = await readImage(f); blob = r.blob; extra = { w: r.w, h: r.h, src: r.src }; patch(key, { src: r.src }); }
        const up = await uploadFile(conv, blob, f.name);
        patch(key, { ...extra, id: up.id, size: up.size, status: 'ready' });
      } catch (err) {
        patch(key, { status: 'error', error: err.message === 'unreadable' ? `Couldn\u2019t read ${f.name}.` : err.message });
      }
    }
  };
  const onPaste = (e) => {
    const list = [...(e.clipboardData?.files || [])];
    if (list.length) { e.preventDefault(); addFiles(list); }
  };

  if (!gate.ok) {
    return html`<div class="composer"><div class="composer-locked"><${Icon} name="news" /><span>${gate.why}</span></div></div>`;
  }
  // Timed out, house rules not yet accepted, or a blocked person (js/views/safety.js).
  const safetyGate = composerGate(conv);
  if (safetyGate) return html`<${GateNote} gate=${safetyGate} />`;
  const canSend = !uploading && (text.trim() || files.some((f) => f.status === 'ready'));
  return html`<div class="composer" data-composer=${conv}
    onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); }}>
    ${ac && html`<div class="ac float" role="listbox" aria-label="Suggestions">
      ${ac.items.map((it, i) => html`<button key=${i} role="option" aria-selected=${String(i === ac.i)} class=${`menu-item${i === ac.i ? ' act' : ''}`}
        onMouseDown=${(e) => { e.preventDefault(); accept(it); }}>
        ${ac.kind === 'at' && html`<${Avatar} user=${it} presence /><span class="grow trunc">${it.name}</span><span class="end">@${it.handle}</span>`}
        ${ac.kind === 'emoji' && html`${it[2] ? html`<span class="emo"><${CustomEmoji} e=${it[2]} /></span>` : html`<span class="emo">${it[0]}</span>`}<span class="grow trunc">${it[1].split(' ')[0]}</span>${it[2] && html`<span class="end">${S.houses[it[2].house]?.name}</span>`}`}
        ${ac.kind === 'cmd' && html`<span class="grow trunc">/${it.name}</span><span class="end">${it.hint}</span>`}
      </button>`)}
    </div>`}
    <div class="composer-box">
      ${replyTo && html`<div class="composer-banner">
        <${Icon} name="reply" size=${16} />
        <span class="trunc grow">Replying to <b>${person(replyTo.author).name}</b> ${plain(replyTo.text)}</span>
        <button class="ib sm" aria-label="Cancel reply" data-tip="Cancel reply" data-key="Esc" onClick=${() => setReply(conv, null)}><${Icon} name="x" size=${16} /></button>
      </div>`}
      ${files.length > 0 && html`<div class="composer-files">
        ${files.map((f, i) => html`<div class="pending-file" key=${i}>
          ${f.kind === 'image' && f.src ? html`<img src=${f.src} alt="" />` : html`<${Icon} name=${f.status === 'error' ? 'alert' : 'file'} />`}
          <span class="pending-name"><span class="trunc">${f.name}</span>
            <span class=${`pending-state${f.status === 'error' ? ' bad' : ''}`}>${f.status === 'uploading' ? 'Uploading\u2026' : f.status === 'error' ? f.error : fileSize(f.size)}</span></span>
          <button class="ib sm" aria-label=${`Remove ${f.name}`} onClick=${() => setFiles(files.filter((x) => x.key !== f.key))}><${Icon} name="x" size=${16} /></button>
        </div>`)}
      </div>`}
      <${SlowNote} conv=${conv} />
      <${ScheduledNote} conv=${conv} />
      <${FormatBar} ta=${ta} text=${text} update=${update} />
      <div class="composer-row">
        <button class="ib" aria-label="Attach a file" data-tip="Attach a file" onClick=${() => fileIn.current.click()}><${Icon} name="clip" /></button>
        <${PlusMenu} conv=${conv} text=${text} update=${update} insert=${insert} replyTo=${replyTo?.id} />
        <textarea ref=${ta} rows="1" placeholder=${placeholder} aria-label=${placeholder} value=${text}
          onInput=${onInput} onKeyDown=${onKey} onPaste=${onPaste} onBlur=${() => setAc(null)}></textarea>
        <${GifButton} conv=${conv} />
        <button class="ib" aria-label="Insert an emoji" data-tip="Emoji"
          onClick=${(e) => openPop({ anchor: rectOf(e), align: 'end', label: 'Insert an emoji', C: EmojiPicker, props: { onPick: (c) => { closePop(); const k = parseKey(c); if (k) picked.current.set(k.name, c); insert(asTyped(c)); } } })}><${Icon} name="smile" /></button>
        <${VoiceButton} conv=${conv} />
        <button class="ib send" aria-label="Send message" data-tip="Send" data-key="Enter" disabled=${!canSend} onClick=${submit}><${Icon} name="send" /></button>
      </div>
    </div>
    <input type="file" hidden multiple ref=${fileIn} onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
  </div>`;
}

function Foot({ conv }) {
  const who = (S.typing[conv] || []).filter((id) => id !== S.me).map((id) => person(id).name.split(' ')[0]);
  return html`<div class="foot" aria-live="polite">
    ${who.length > 0 && html`<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span><b>${nameList(who)}</b> ${who.length > 1 ? 'are' : 'is'} typing</span>`}
  </div>`;
}

const Skeleton = ({ rows }) => html`<div class="older" aria-hidden="true">
  ${rows.map((w, i) => html`<div class="older-row" key=${i}><div class="skel"></div><div class="skel" style=${`width:${w}%`}></div></div>`)}
</div>`;

export function Stream({ conv, intro, placeholder }) {
  const all = S.msgs[conv] || [];
  const win = S.ui.win[conv] || PAGE;
  const start = Math.max(0, all.length - win);
  const items = withPinLines(conv, buildItems(all.slice(start), { marker: S.ui.marker[conv], me: S.me }));
  const scroller = useRef();
  const inner = useRef();
  const stick = useRef(true);
  const prevLen = useRef(all.length);
  const prepend = useRef(null);
  const [below, setBelow] = useState(0);
  const [far, setFar] = useState(false);
  const [older, setOlder] = useState(null);
  const ready = true;


  // Arriving: where you left off if you were here this session, else the
  // first unread with some context above it, else the latest.
  useLayoutEffect(() => {
    if (!ready) return;
    const el = scroller.current;
    const marker = el.querySelector('.newline');
    const saved = scrollPos.get(conv);
    if (saved != null) el.scrollTop = saved;
    else if (marker) el.scrollTop = Math.max(0, marker.offsetTop - el.clientHeight * 0.35);
    else el.scrollTop = el.scrollHeight;
    stick.current = atBottom(el);
    if (stick.current && document.hasFocus()) markRead(conv);
  }, [ready]);

  const jumpN = S.ui.jump?.conv === conv ? S.ui.jump.n : 0;
  useLayoutEffect(() => {
    if (!ready || !jumpN) return;
    const el = scroller.current.querySelector(`[data-id="${S.ui.jump.id}"]`);
    S.ui.jump = null;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    stick.current = atBottom(scroller.current);
  }, [ready, jumpN]);

  // After every render: keep position when history is added above, follow new
  // messages only if the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !ready) return;
    if (prepend.current != null) { el.scrollTop += el.scrollHeight - prepend.current; prepend.current = null; }
    const added = all.length - prevLen.current;
    prevLen.current = all.length;
    if (added <= 0) return;
    const last = all[all.length - 1];
    if (stick.current || last.author === S.me) {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
      if (document.hasFocus()) markRead(conv);
    } else setBelow((n) => n + added);
  });

  useEffect(() => {
    if (!ready) return undefined;
    const ro = new ResizeObserver(() => {
      const el = scroller.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner.current);
    ro.observe(scroller.current);
    return () => ro.disconnect();
  }, [ready]);

  // Coming back to the window counts as reading what is on screen.
  useEffect(() => {
    const f = () => { if (stick.current) markRead(conv); };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, []);

  // Older messages: first from what is already on the device, then from the server.
  const loadOlder = () => {
    if (scroller.current) prepend.current = scroller.current.scrollHeight;
    S.ui.win[conv] = (S.ui.win[conv] || PAGE) + PAGE;
    if (start > 0) { emit(); return; }
    if (!S.more[conv] || older === 'loading') return;
    setOlder('loading');
    const first = all.find((m) => m.seq != null);
    loadHistory(conv, { before: first?.seq }).then(() => setOlder(null), (e) => { prepend.current = null; setOlder(e.offline ? 'error' : 'fail'); });
  };

  const onScroll = () => {
    const el = scroller.current;
    stick.current = atBottom(el);
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 600;
    if (away !== far) setFar(away);
    if (stick.current) {
      scrollPos.delete(conv);
      if (below) setBelow(0);
      markRead(conv);
    } else scrollPos.set(conv, el.scrollTop);
    if (el.scrollTop < 120 && (start > 0 || S.more[conv]) && !older) loadOlder();
  };
  const toBottom = () => {
    const el = scroller.current;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  // Keyboard path through messages: arrows move, letters act.
  const onKey = (e) => {
    const el = e.target.closest('.msg');
    if (!el || e.target !== el || e.metaKey || e.ctrlKey || e.altKey) return;
    const c = el.dataset.conv;
    const m = findMsg(c, el.dataset.id);
    if (!m) return;
    const move = (dir) => {
      let n = el;
      do { n = dir < 0 ? n.previousElementSibling : n.nextElementSibling; } while (n && !n.classList.contains('msg'));
      if (n) n.focus(); else if (dir > 0) focusComposer(conv);
    };
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'ArrowUp') move(-1);
    else if (k === 'ArrowDown') move(1);
    else if (k === 'r' && !m.state) { setReply(c, m.id); focusComposer(c); }
    else if (k === 't' && !isThread(c) && !m.state) openThread(c, m.id);
    else if (k === 's') toggleSave(c, m.id);
    else if (k === 'e' && m.author === S.me) setEditing(m.id);
    else if (k === 'Enter') messageMenu(c, m, { anchor: el.getBoundingClientRect() });
    else if (k === 'Escape') focusComposer(conv);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const lastId = all.filter((m) => !m.call).at(-1)?.id || null;
  return html`<div class="stream">
    ${!isOnline() && html`<div class="banner" role="status">
      <${Icon} name="offline" size=${16} /><span><b>You’re offline.</b> What you write will wait here and send when you’re back.</span>
    </div>`}
    <${UnreadBar} conv=${conv} scroller=${scroller} />
    <div class="scroller" ref=${scroller} onScroll=${onScroll} onKeyDown=${onKey}>
      ${!ready
        ? html`<div class="msgs"><${Skeleton} rows=${[72, 48, 64, 40, 56]} /></div>`
        : html`<div class="msgs" ref=${inner} role="log" aria-label="Messages">
          ${start > 0 || S.more[conv]
            ? (older === 'error' || older === 'fail'
              ? html`<div class="older-msg">${older === 'error' ? 'Earlier messages can\u2019t load while you\u2019re offline.' : 'Earlier messages didn\u2019t load.'} <button class="btn quiet" onClick=${() => { setOlder(null); loadOlder(); }}>Try again</button></div>`
              : html`<${Skeleton} rows=${[56, 40]} />`)
            : intro}
          ${(() => {
            // A mention of you lights up the whole run of that person's
            // messages, not only the line that named you.
            let lit = false;
            return items.map((it) => {
              if (it.type === 'day') { lit = false; return html`<div class="day" key=${it.key}>${fmtDay(it.ts)}</div>`; }
              if (it.type === 'new') { lit = false; return html`<div class="newline" key="new" role="separator" aria-label="New messages"><span>New</span></div>`; }
              if (it.type === 'pin') return html`<${PinLine} key=${it.key} conv=${conv} pin=${it.pin} />`;
              if (it.m.call) { lit = false; return html`<${CallLine} key=${it.key} conv=${conv} m=${it.m} />`; }
              const toMe = forMe(S, conv, it.m);
              const cont = !toMe && it.grouped && lit;
              lit = toMe || cont;
              return html`<${Message} key=${it.key} conv=${conv} m=${it.m} grouped=${it.grouped} lit=${cont} tab=${it.m.id === lastId} />`;
            });
          })()}
        </div>`}
    </div>
    <div class="jump-wrap">
      ${(below > 0 || far) && html`<button class="jump" onClick=${toBottom}>
        <${Icon} name="down" size=${16} />${below > 0 ? plural(below, 'new message') : 'Latest'}
      </button>`}
    </div>
    <${Composer} conv=${conv} placeholder=${placeholder} />
    <${Foot} conv=${conv} />
  </div>`;
}
