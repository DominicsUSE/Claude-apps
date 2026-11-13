// Text and messages in the browser: the composer's suggestions (people,
// roles, @everyone, rooms, emoji, slash commands with their arguments),
// slash commands and quick edits, the reply mention toggle, attachment
// spoilers and descriptions, the length counter and "Send as a file",
// message links and their quote cards, and dice rolls.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import {
  S, emit, person, convMeta, findMsg, membersOf, openModal, openPop, closePop, toast, react, editMsg, setPresence, setStatus, jumpToMsg, openConv,
} from '../store.js';
import { call } from '../server.js';
import { can } from '../lib/perms.js';
import { fuzzy, hueOf, fmtFull, fileSize } from '../lib/util.js';
import { plain, formatHooks } from '../lib/format.js';
import { rankEmoji, withTone, shortName, emojiByName, TONES, TONE_NAMES } from '../lib/emojis.js';
import {
  parseCommand, suggestCommands, textCommand, parseRoll, parsePoll, parseSubst, parseReact, quoteText, argIndex, MAX_LEN, WARN_LEN,
} from '../lib/commands.js';
import { Icon } from '../ui/icons.js';
import { Avatar, PRESENCE, copyText, Switch } from '../ui/kit.js';
import { customSuggest } from './emoji-custom.js';
import { countUse } from './emoji.js';
import { GifPicker } from './media.js';
import { PollModal } from './messaging.js';

// ---------------------------------------------------------------- Parser hooks
// Roles by name after an @ (people win), message links on this Snug, room names for plain().
const roleList = () => Object.values(S.houses || {}).filter((h) => h.joined).flatMap((h) => (h.roles || []).filter((r, i) => i > 0 && r.mentionable !== false));
formatHooks.role = (after) => {
  const low = after.toLowerCase();
  const handle = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?/i.exec(after)?.[0]?.toLowerCase();
  let best = null;
  for (const r of roleList()) {
    const n = r.name.toLowerCase();
    if (low.startsWith(n) && !/[\w]/.test(after[n.length] || '') && (!best || n.length > best.len)) best = { id: r.id, name: r.name, hue: r.hue, len: n.length };
  }
  if (best && handle && best.len <= handle.length && Object.values(S.users).some((u) => u.handle === handle)) return null;
  return best;
};
formatHooks.origin = typeof location !== 'undefined' ? location.origin : '';
formatHooks.roomName = (id) => S.rooms[id]?.name || null;

// ---------------------------------------------------------------- Message links
export const messageLink = (conv, id) => `${location.origin}/m/${conv}/${id}`;

// The menu items this track adds to every message.
export function chatMenuItems(conv, m) {
  if (m.state) return [];
  return [
    !m.call && { label: 'Quote', icon: 'quote', onSelect: () => quoteMsg(conv, m) },
    { label: 'Copy message link', icon: 'link', onSelect: () => copyText(messageLink(conv, m.id)) },
    S.prefs.showIds && { label: 'Copy ID', icon: 'copy', onSelect: () => copyText(m.id) },
  ];
}

// Put text into a conversation's composer (Quote): the composer listens.
export function composeInto(conv, text) {
  window.dispatchEvent(new CustomEvent('snug:compose', { detail: { conv, text } }));
}
export function quoteMsg(conv, m) {
  const who = person(m.author);
  composeInto(conv, quoteText(plain(m.text) || (m.files?.length ? 'Attachment' : ''), who.handle));
}

// Arrived at /m/<conversation>/<message>: open it once signed in, or say it can't be seen.
const NO_SEE = 'You can’t see that message.';
export async function openMessageLink(conv, id) {
  if (!convMeta(conv) && !conv.startsWith('t:')) { toast(NO_SEE); return; }
  try {
    if (conv.startsWith('t:') && !S.threads[conv]) {
      const r = await call('msg.peek', { conv, id });
      if (r.thread) S.threads[conv] = { conv: r.thread.conv, root: r.thread.root };
    } else if (!findMsg(conv, id)) await call('msg.peek', { conv, id });
  } catch { toast(NO_SEE); return; }
  jumpToMsg(conv, id);
}

// Quote cards: a message link in text shows who wrote what, where.
const peeked = new Map(); // `${conv}/${id}` -> { state, m, user, conv }
function usePeek(conv, id) {
  const key = `${conv}/${id}`;
  const local = findMsg(conv, id);
  const [, tick] = useState(0);
  useEffect(() => {
    if (local || peeked.has(key)) return;
    peeked.set(key, { state: 'loading' });
    call('msg.peek', { conv, id }).then(
      (r) => { if (r.user && !S.users[r.user.id]) S.users[r.user.id] = r.user; peeked.set(key, { state: 'ok', ...r }); tick((n) => n + 1); },
      (e) => { peeked.set(key, { state: e.offline ? 'offline' : 'no' }); tick((n) => n + 1); },
    );
  }, [key, !!local]);
  if (local) return { state: 'ok', m: local };
  return peeked.get(key) || { state: 'loading' };
}
function placeName(conv) {
  const meta = convMeta(conv);
  if (!meta) return '';
  if (meta.kind === 'thread') return `Thread in ${meta.where}`;
  if (meta.house) return `#${meta.title} · ${S.houses[meta.house]?.name || ''}`;
  return meta.title;
}
export function MessageCard({ conv, id, url }) {
  const p = usePeek(conv, id);
  if (p.state === 'loading') return html`<span class="mcard loading" aria-busy="true"><span class="skel"></span><span class="skel" style="width:60%"></span></span>`;
  if (p.state !== 'ok') {
    return html`<span class="mcard gone" role="note"><${Icon} name="eye" size=${16} />${p.state === 'offline' ? 'This message will show when you’re back online.' : NO_SEE}</span>`;
  }
  const u = person(p.m.author);
  const text = plain(p.m.text) || (p.m.files?.length ? `${p.m.files.length === 1 ? 'An attachment' : `${p.m.files.length} attachments`}` : '');
  return html`<span class="mcard" role="group" aria-label=${`Message from ${u.name}`}>
    <span class="mcard-head"><${Avatar} user=${u} size=${24} deco=${false} /><b>${u.name}</b><span class="faint trunc">${placeName(conv)}</span>
      <time class="faint" datetime=${new Date(p.m.ts).toISOString()}>${fmtFull(p.m.ts)}</time></span>
    <span class="mcard-text">${text.length > 200 ? `${text.slice(0, 199)}…` : text}</span>
    <button class="btn sm quiet mcard-jump" aria-label=${`Jump to ${u.name}’s message`} onClick=${() => jumpToMsg(conv, id)}>Jump</button>
    <a class="sr-only" href=${url}>${url}</a>
  </span>`;
}

// Pills for @everyone, @Role and #room, drawn by js/views/rich.js.
export function EveryonePill({ v }) {
  return html`<span class="pill-ev" data-tip=${v === 'here' ? 'Everyone online here' : 'Everyone here'}>@${v}</span>`;
}
export function RolePill({ v, hue }) {
  const h = hue == null ? null : hueOf(hue);
  return html`<span class=${`pill-role${h == null ? '' : ' hued'}`} style=${h == null ? '' : `--hue:${h}`}>@${v}</span>`;
}
export function RoomPill({ id }) {
  const room = S.rooms[id];
  if (!room || !convMeta(id)) return html`<span class="pill-room gone" data-tip="You can’t see this room">#unknown room</span>`;
  return html`<button type="button" class="pill-room" aria-label=${`Open #${room.name}`} onClick=${() => openConv(id)}><${Icon} name=${room.kind === 'voice' ? 'voice' : 'room'} size=${14} />${room.name}</button>`;
}

// ---------------------------------------------------------------- Suggestions
// What the composer offers as you type: @ people, roles and everyone; # rooms;
// :emoji; / commands, then the command's arguments.
export function suggest(value, caret, conv) {
  const before = value.slice(0, caret);
  let m;
  const meta = convMeta(conv);
  const house = meta?.house;
  if ((m = /(?:^|\s)@([\w.-]*)$/.exec(before))) {
    const q = m[1];
    const people = membersOf(conv).filter((id) => id !== S.me).map((id) => S.users[id])
      .map((u) => ({ type: 'user', u, s: Math.max(fuzzy(q, u.name), fuzzy(q, u.handle)) }))
      .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 6);
    const items = [...people];
    if (house) {
      const h = S.houses[house];
      const roles = (h?.roles || []).filter((r, i) => i > 0 && r.mentionable !== false)
        .map((r) => ({ type: 'role', r, s: fuzzy(q, r.name), n: Object.values(h.members || {}).filter((x) => x === r.id).length }))
        .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 3);
      items.push(...roles);
      if (can(S, house, 'announce')) {
        const all = membersOf(conv).filter((id) => id !== S.me);
        for (const v of ['everyone', 'here']) {
          if (!v.startsWith(q.toLowerCase())) continue;
          const n = v === 'here' ? all.filter((id) => S.users[id]?.presence && S.users[id].presence !== 'offline').length : all.length;
          items.push({ type: 'everyone', v, n });
        }
      }
    }
    if (items.length) return { kind: 'at', from: caret - q.length - 1, items: items.slice(0, 9), i: 0 };
  }
  // "#" alone at the start of a line is a heading being typed, not a room.
  if ((m = /(?:^|\s)#([\w-]*)$/.exec(before)) && (m[1] || !/(?:^|\n)#$/.test(before))) {
    const q = m[1];
    const rooms = Object.values(S.rooms).filter((r) => convMeta(r.id))
      .map((r) => ({ r, s: q ? fuzzy(q, r.name) : 0, here: r.house === house ? 1 : 0 }))
      .filter((x) => x.s >= 0).sort((a, b) => b.here - a.here || b.s - a.s).slice(0, 6).map((x) => x.r);
    if (rooms.length) return { kind: 'room', from: caret - q.length - 1, items: rooms, i: 0 };
  }
  if ((m = /(?:^|\s):([a-z0-9_+-]{2,})$/i.exec(before))) {
    const q = m[1].toLowerCase();
    const tone = S.prefs.skinTone || 0;
    const items = [...customSuggest(q, conv), ...rankEmoji(q, undefined, 6).map((e) => [withTone(e.c, tone), shortName(e)])].slice(0, 6);
    if (items.length) return { kind: 'emoji', from: caret - q.length - 1, items, i: 0 };
  }
  if ((m = /^\/(\w*)$/.exec(before))) {
    const items = suggestCommands(m[1]);
    if (items.length) return { kind: 'cmd', from: 0, items, i: 0 };
  }
  if ((m = /^\/(\w+)\s([\s\S]*)$/.exec(before))) {
    const p = parseCommand(before);
    if (p?.cmd?.args.length) return { kind: 'args', from: 0, items: [p.cmd], i: 0, arg: argIndex(p.cmd, m[2]) };
  }
  return null;
}

// One row of the suggestion list.
export function SuggestRow({ ac, it }) {
  if (ac.kind === 'at') {
    if (it.type === 'user') return html`<${Avatar} user=${it.u} presence /><span class="grow trunc">${it.u.name}</span><span class="end">@${it.u.handle}</span>`;
    if (it.type === 'role') {
      const h = it.r.hue == null ? null : hueOf(it.r.hue);
      return html`<span class=${`role-dot${h == null ? '' : ' hued'}`} style=${h == null ? '' : `--hue:${h}`} aria-hidden="true"></span><span class="grow trunc">@${it.r.name}</span><span class="end">Role · ${it.n === 1 ? '1 person' : `${it.n} people`}</span>`;
    }
    return html`<span class="ev-dot" aria-hidden="true">@</span><span class="grow trunc">@${it.v}</span><span class="end">Notifies ${it.n === 1 ? '1 person' : `${it.n} people`}${it.v === 'here' ? ' online' : ''}</span>`;
  }
  if (ac.kind === 'room') return html`<${Icon} name=${it.kind === 'voice' ? 'voice' : 'room'} size=${16} /><span class="grow trunc">${it.name}</span><span class="end">${S.houses[it.house]?.name || ''}</span>`;
  if (ac.kind === 'cmd') {
    return html`<span class="trunc cmd-name">/${it.name}</span>${it.args.map((a) => html`<span key=${a.name} class=${`arg-chip${a.optional ? ' opt' : ''}`}>${a.name}</span>`)}<span class="grow"></span><span class="end">${it.hint}</span>`;
  }
  return null;
}
// The argument row once a command is chosen: which argument comes next.
export function ArgsRow({ ac }) {
  const cmd = ac.items[0];
  return html`<div class="args-row" role="status" aria-live="polite">
    <span class="cmd-name">/${cmd.name}</span>
    ${cmd.args.map((a, i) => html`<span key=${a.name} class=${`arg-chip${a.optional ? ' opt' : ''}${i === ac.arg ? ' on' : ''}`} aria-current=${i === ac.arg ? 'true' : undefined}>${a.name}${a.optional ? '?' : ''}</span>`)}
    <span class="grow trunc faint">${cmd.args[ac.arg]?.hint || cmd.hint}</span>
  </div>`;
}

// ---------------------------------------------------------------- Running what was typed
const newId = () => `m_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;

// Quick edits: s/old/new edits your last message, +:emoji: reacts to the last one.
// Returns true when it was one (and it ran).
export function quickEdit(conv, body) {
  const sub = parseSubst(body);
  if (sub) {
    const mine = (S.msgs[conv] || []).filter((x) => x.author === S.me && !x.state && !x.cmd && !x.call).pop();
    if (!mine) { toast('There’s no message of yours here to change.'); return true; }
    if (!mine.text.includes(sub.from)) { toast(`Your last message doesn’t have “${sub.from}” in it.`); return true; }
    editMsg(conv, mine.id, mine.text.replace(sub.from, sub.to));
    return true;
  }
  const name = parseReact(body);
  if (name) {
    const e = emojiByName(name);
    const last = (S.msgs[conv] || []).filter((x) => !x.state && !x.call).pop();
    if (!e) { toast(`No emoji called :${name}:`); return true; }
    if (!last) { toast('There’s no message here to react to.'); return true; }
    const c = withTone(e.c, S.prefs.skinTone || 0);
    if (!(last.reactions?.[c] || []).includes(S.me)) react(conv, last.id, c);
    countUse(c);
    return true;
  }
  return false;
}

// A slash command. Returns { send, silent } to send text, { keep: true } to
// leave the text in the box (unknown command, missing argument), or { done: true }.
export function runSlash(conv, body, { anchor } = {}) {
  const p = parseCommand(body);
  if (!p) return null;
  if (!p.cmd) { toast(`No command called /${p.name}. Type / to see them all.`); return { keep: true }; }
  const { name, rest, cmd } = p;
  if (cmd.kind === 'text') {
    const out = textCommand(name, rest);
    if (out == null) { toast(`/${name} needs ${cmd.args[0]?.hint || `a ${cmd.args[0]?.name || 'message'}`}.`); return { keep: true }; }
    if (name === 'silent') return { send: rest, silent: true };
    return { send: out };
  }
  if (name === 'roll') {
    if (!parseRoll(rest)) { toast('Roll like /roll 2d6: up to 20 dice, each with 2 to 1000 sides.'); return { keep: true }; }
    call('cmd.roll', { conv, id: newId(), spec: rest || undefined }).catch((e) => toast(e.offline ? 'You’re offline. Roll again when you’re back.' : e.message));
    return { done: true };
  }
  if (name === 'poll') { openModal(PollModal, { conv, ...parsePoll(rest) }); return { done: true }; }
  if (name === 'giphy') {
    const box = document.querySelector(`[data-composer="${CSS.escape(conv)}"] .gif-btn`);
    openPop({ anchor: anchor || box?.getBoundingClientRect(), align: 'end', label: 'GIFs', C: GifPicker, props: { conv, query: rest } });
    return { done: true };
  }
  if (name === 'nick') {
    const house = convMeta(conv)?.house;
    if (!house) { toast('Nicknames belong to a house. Use /nick in one of its rooms.'); return { keep: true }; }
    call('member.profile', { house, nick: rest || null }).then(
      () => toast(rest ? `Your nickname here is now “${rest}”` : 'Nickname cleared'),
      (e) => toast(e.offline ? 'You’re offline. Try again when you’re back.' : e.message),
    );
    return { done: true };
  }
  if (name === 'status') { setStatus(rest); toast(rest ? `Status set to “${rest}”` : 'Status cleared'); return { done: true }; }
  if (PRESENCE[name] && name !== 'offline') { setPresence(name); toast(`You’re shown as ${PRESENCE[name].label.toLowerCase()}`); return { done: true }; }
  return { keep: true };
}

// ---------------------------------------------------------------- Reply mention toggle
const PING_KEY = 'snug.replyPing';
export const replyPingOn = () => { try { return localStorage.getItem(PING_KEY) !== 'off'; } catch { return true; } };
export function ReplyPing({ who }) {
  const [on, setOn] = useState(replyPingOn());
  const flip = () => { const v = !on; setOn(v); try { localStorage.setItem(PING_KEY, v ? 'on' : 'off'); } catch { /* blocked */ } emit(); };
  return html`<button type="button" class=${`reply-ping${on ? ' on' : ''}`} aria-pressed=${String(on)}
    aria-label=${on ? `Mention ${who}: on. ${who} is notified` : `Mention ${who}: off. ${who} isn’t notified`}
    data-tip=${on ? `${who} will be notified. Select to turn off` : `${who} won’t be notified. Select to turn on`} onClick=${flip}>@ ${on ? 'On' : 'Off'}</button>`;
}

// ---------------------------------------------------------------- Attachments being written
// Mark as spoiler, and a description for people who can't see it.
export const MAX_ALT = 1024;
export function AttachmentEdit({ f, onChange, onClose }) {
  const [alt, setAlt] = useState(f.alt || '');
  const [spoiler, setSpoiler] = useState(!!f.spoiler);
  const save = (e) => { e?.preventDefault(); onChange({ alt: alt.trim().slice(0, MAX_ALT), spoiler }); onClose(); };
  return html`<form class="att-edit float" role="group" aria-label=${`Edit ${f.name}`} onSubmit=${save}
    onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
    <label class="check"><input type="checkbox" checked=${spoiler} onChange=${(e) => setSpoiler(e.target.checked)} /> Mark as spoiler</label>
    <label class="label" for=${`alt-${f.key}`}>Description (alt text)</label>
    <textarea id=${`alt-${f.key}`} class="field" rows="3" maxlength=${MAX_ALT} data-autofocus placeholder="What’s in it, for people who can’t see it"
      value=${alt} onInput=${(e) => setAlt(e.target.value)}></textarea>
    <div class="att-edit-foot"><span class="faint num">${alt.length} / ${MAX_ALT}</span>
      <button type="button" class="btn sm" onClick=${onClose}>Cancel</button><button class="btn sm primary">Save</button></div>
  </form>`;
}

// ---------------------------------------------------------------- Length
export function LengthNote({ n }) {
  if (n < WARN_LEN) return null;
  const over = n > MAX_LEN;
  return html`<div class=${`len-note${over ? ' over' : ''}`} role=${over ? 'alert' : undefined} aria-live="polite">
    <span class="num">${n.toLocaleString()} / ${MAX_LEN.toLocaleString()}</span>
    ${over && html`<span>Too long to send. Shorten it, or send it as a file.</span>`}
  </div>`;
}
export const tooLong = (text) => text.length > MAX_LEN;
// Long text as message.txt, through the normal upload.
export const textFile = (text) => new File([text], 'message.txt', { type: 'text/plain' });

// ---------------------------------------------------------------- Dice rolls
export function RollLine({ m }) {
  const r = m.cmd?.roll;
  if (!r) return null;
  return html`<div class="roll" aria-label=${`${person(m.author).name} rolled ${r.n}d${r.sides}: ${r.total}`}>
    <span class="roll-die" aria-hidden="true">🎲</span>
    <span>rolled <b>${r.n}d${r.sides}</b>${r.n > 1 ? html`: <span class="num">${r.rolls.join(' + ')}</span> =` : ':'} <b class="roll-total num">${r.total}</b></span>
  </div>`;
}

// ---------------------------------------------------------------- Text and code attachments
// A small text file shows its first lines, with Expand, Copy and Download.
const TEXT_EXT = /\.(txt|md|log|csv|json|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|css|html|xml|yml|yaml|toml|ini|sh|sql)$/i;
export const isTextFile = (f) => f.kind === 'file' && f.id && (f.size || 0) <= 100 * 1024 && TEXT_EXT.test(f.name || '');
const texts = new Map();
export function TextPreview({ f, url, CodeBlock }) {
  const [, tick] = useState(0);
  const [open, setOpen] = useState(false);
  const got = texts.get(f.id);
  useEffect(() => {
    if (got) return;
    texts.set(f.id, { state: 'loading' });
    fetch(url, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject())).then(
      (t) => { texts.set(f.id, { state: 'ok', t }); tick((n) => n + 1); },
      () => { texts.set(f.id, { state: 'error' }); tick((n) => n + 1); },
    );
  }, [f.id]);
  const lines = got?.t ? got.t.split('\n') : [];
  const more = lines.length > 10;
  const shown = open ? got.t : lines.slice(0, 10).join('\n');
  const lang = (f.name.split('.').pop() || '').toLowerCase();
  return html`<div class="tfile">
    <div class="tfile-head"><${Icon} name="file" size=${16} /><span class="trunc grow">${f.name}</span><span class="faint">${fileSize(f.size || 0)}</span>
      ${got?.state === 'ok' && html`<button class="btn sm quiet" onClick=${() => copyText(got.t)}><${Icon} name="copy" size=${14} />Copy</button>`}
      <a class="btn sm quiet" href=${url} download=${f.name} aria-label=${`Download ${f.name}`}>Download</a></div>
    ${!got || got.state === 'loading' ? html`<div class="tfile-body"><span class="skel"></span><span class="skel" style="width:70%"></span></div>`
      : got.state === 'error' ? html`<div class="tfile-body faint">The preview didn’t load. Download the file instead.</div>`
      : html`<${CodeBlock} lang=${lang === 'txt' || lang === 'log' ? '' : lang} v=${shown} />
        ${more && html`<button class="btn sm quiet tfile-more" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>${open ? 'Show less' : `Expand (${lines.length} lines)`}</button>`}`}
  </div>`;
}

// ---------------------------------------------------------------- Settings > Text and messages
export function ChatSettings({ Row }) {
  const p = S.prefs;
  const tone = p.skinTone || 0;
  const used = Object.keys(p.emojiUse || {}).length;
  const set = (k, v) => { S.prefs[k] = v; emit(); };
  return html`<div class="set-head">Emoji</div>
    <${Row} label="Skin tone" hint="Used for every emoji that has skin tones, in the picker, suggestions and :shortcodes:.">
      <div class="tone-row" role="radiogroup" aria-label="Skin tone">
        ${TONES.map((_, t) => html`<button key=${t} role="radio" aria-checked=${String(t === tone)} class=${`tone${t === tone ? ' on' : ''}`}
          aria-label=${TONE_NAMES[t]} data-tip=${TONE_NAMES[t]} onClick=${() => set('skinTone', t)}><span class="emo">${withTone('✋', t)}</span></button>`)}
      </div>
    <//>
    <${Row} label="Frequently used" hint=${used ? `The picker remembers ${used === 1 ? 'one emoji' : `${used} emoji`} you use most, on every device.` : 'The emoji you use most show first in the picker.'}>
      <button class="btn" disabled=${!used} onClick=${() => { set('emojiUse', {}); S.prefs.recent = []; toast('Frequently used cleared'); }}>Clear</button>
    <//>
    <${Row} label="Turn emoticons into emoji" hint="When you send :) it becomes 🙂, and <3 becomes ❤️. Never inside code.">
      <${Switch} on=${!!p.textEmoticons} label="Turn emoticons into emoji" onChange=${(v) => set('textEmoticons', v)} />
    <//>
    <div class="set-head">Messages</div>
    <${Row} label="Show message IDs" hint="Adds Copy ID to every message’s menu, for bots and bug reports.">
      <${Switch} on=${!!p.showIds} label="Show message IDs" onChange=${(v) => set('showIds', v)} />
    <//>
    <${Row} label="Mention people you reply to" hint="The reply bar’s @ On/Off starts from this on this device.">
      <${Switch} on=${replyPingOn()} label="Mention people you reply to" onChange=${(v) => { try { localStorage.setItem(PING_KEY, v ? 'on' : 'off'); } catch { /* blocked */ } emit(); }} />
    <//>`;
}
