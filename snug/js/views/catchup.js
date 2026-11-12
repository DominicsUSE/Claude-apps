// Catch up: what needs you first, then what happened, in one place instead of
// badges everywhere. Saved: the messages you chose to keep.
import { html, useRef } from '../../vendor/preact-htm.js';
import {
  S, person, back, me, convMeta, findMsg, jumpToMsg, openConv, openModal, openQuick, declineInvite, markAllRead,
  markConvRead, markManyRead, toggleSave, setSavedNote, setPresence, setRead, toast,
} from '../store.js';
import { needsMe, levelOf, threadsOf, roomIds, isThread } from '../lib/attention.js';
import { mentions } from '../lib/format.js';
import { fmtWhen, plural, nameList } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Tile, RoomIcon, Rich, Empty } from '../ui/kit.js';
import { JoinPreview } from './modals.js';

const Back = () => S.ui.phone && S.ui.depth > 0 && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`;

// Everything unread, split by the one question that matters: is it for me?
export function gather() {
  const needs = [];
  const news = [];
  const convs = [...S.dmOrder, ...S.houseOrder.flatMap((h) => roomIds(S, h))];
  for (const conv of convs) {
    const level = levelOf(S, conv);
    if (level === 'muted') continue;
    let count = 0, top = null;
    const people = new Set();
    for (const c of [conv, ...threadsOf(S, conv).filter((t) => S.followed[t])]) {
      const since = S.read[c] || 0;
      for (const m of S.msgs[c] || []) {
        if (m.ts <= since || m.author === S.me || m.sys) continue;
        if (needsMe(S, c, m)) needs.push({ conv: c, m });
        else if (c === conv) {
          count++;
          people.add(m.author);
          const score = Object.values(m.reactions || {}).reduce((n, who) => n + who.length, 0);
          if (!top || score > top.score) top = { m, score };
        }
      }
    }
    if (count && level === 'all') news.push({ conv, count, people: [...people], top: top.m });
  }
  needs.sort((a, b) => b.m.ts - a.m.ts);
  return { needs, news };
}

function why(conv, m) {
  const meta = convMeta(conv);
  if (meta.kind === 'dm') return 'wrote to you';
  if (meta.kind === 'group') return `in ${meta.title}`;
  const where = meta.kind === 'thread' ? meta.where : meta.title;
  if (mentions(m.text, me().handle)) return `mentioned you in ${where}`;
  if (meta.kind === 'thread') return `replied in a thread you follow in ${where}`;
  return `replied to you in ${where}`;
}

function done(conv, m) {
  const before = S.read[conv] || 0;
  setRead(conv, Math.max(before, m.ts));
  toast('Marked as done', { undo: () => setRead(conv, before) });
}

// Triage: move with J and K (or the arrows), E marks done, Enter opens.
// On a phone, swipe an item to the left to mark it done.
function focusItem(i) {
  requestAnimationFrame(() => {
    const list = [...document.querySelectorAll('.item[data-triage]')];
    list[Math.min(i, list.length - 1)]?.focus();
  });
}

function onTriageKey(e) {
  const el = e.target.closest?.('.item[data-triage]');
  if (!el || e.metaKey || e.ctrlKey || e.altKey) return;
  const list = [...document.querySelectorAll('.item[data-triage]')];
  const i = list.indexOf(el);
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'j' || k === 'ArrowDown') list[i + 1]?.focus();
  else if (k === 'k' || k === 'ArrowUp') list[i - 1]?.focus();
  else if (k === 'e' && e.target === el) { el.querySelector('[data-done]').click(); focusItem(i); }
  else if (k === 'Enter' && e.target === el) el.querySelector('.item-main').click();
  else return;
  e.preventDefault();
}

function TriageItem({ conv, m }) {
  const ref = useRef();
  const drag = useRef(null);
  const move = (x) => { ref.current.style.transform = x ? `translateX(${x}px)` : ''; };
  const down = (e) => {
    if (e.pointerType !== 'touch') return;
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, on: false };
  };
  const moving = (e) => {
    const d = drag.current;
    if (!d) return;
    d.dx = Math.min(0, e.clientX - d.x);
    if (!d.on && Math.abs(e.clientY - d.y) > Math.abs(d.dx)) { drag.current = null; return; }
    if (d.dx < -8) { d.on = true; ref.current.classList.add('swiping'); move(d.dx); }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.on) return;
    ref.current.classList.remove('swiping');
    if (-d.dx > Math.min(120, ref.current.offsetWidth * 0.35)) done(conv, m);
    else move(0);
  };
  return html`<div class="swipe" onPointerDown=${down} onPointerMove=${moving} onPointerUp=${up} onPointerCancel=${up}>
    <span class="swipe-under" aria-hidden="true"><${Icon} name="check" size=${18} />Done</span>
    <div class="item" ref=${ref} data-triage tabindex="0">
      <${Avatar} user=${person(m.author)} />
      <button class="item-main" tabindex="-1" onClick=${() => jumpToMsg(conv, m.id)}>
        <span class="item-meta"><b>${person(m.author).name}</b><span class="where">${why(conv, m)}</span><span class="num">${fmtWhen(m.ts)}</span></span>
        <span class="item-text"><${Rich} m=${m} /></span>
      </button>
      <div class="item-acts float">
        <button class="ib" data-done aria-label="Mark as done" data-tip="Done" data-key="E" onClick=${() => done(conv, m)}><${Icon} name="check" size=${18} /></button>
      </div>
    </div>
  </div>`;
}

export function CatchUp() {
  const { needs, news } = gather();
  const focused = me().presence === 'focus';
  const nothing = !needs.length && !news.length && !S.invites.length;
  const byHouse = S.houseOrder.map((h) => ({ h, rows: news.filter((n) => S.rooms[n.conv]?.house === h) })).filter((g) => g.rows.length);
  return html`<section class="main view" aria-label="Catch up">
    <header class="bar">
      <${Back} />
      <h1 class="bar-title"><${Icon} name="tray" />Catch up</h1>
      ${!nothing && html`<span class="bar-sub trunc">${needs.length + S.invites.length} for you, ${plural(news.length, 'room')} with news</span>`}
      <div class="bar-end">${(needs.length > 0 || news.length > 0) && html`<button class="btn quiet" onClick=${markAllRead}><${Icon} name="check" size=${16} />Mark all read</button>`}</div>
    </header>
    <div class="view-body">
      ${focused && html`<div class="banner"><i class="pres inline focus"></i><span><b>You’re focused.</b> Nothing pops up. It collects here until you’re back.</span>
        <button class="btn quiet" style="margin-left:auto" onClick=${() => setPresence('around')}>I’m back</button></div>`}
      ${nothing
        ? html`<${Empty} icon="check" title="You’re all caught up" text="Mentions, replies and direct messages collect here, so the rest of the app can stay quiet.">
            <button class="btn" onClick=${() => openQuick()}>Jump to a room</button>
          <//>`
        : html`<div class="col">
          ${(needs.length > 0 || S.invites.length > 0) && html`<div class="view-sect">For you <span class="count num">${needs.length + S.invites.length}</span></div>`}
          ${S.invites.map((inv) => {
            const h = S.houses[inv.house];
            return html`<div class="invite" key=${inv.house}>
              <${Tile} house=${h} />
              <div>
                <div class="item-meta"><b>${person(inv.from).name}</b><span class="where">invited you to ${h.name}</span><span class="num">${fmtWhen(inv.ts)}</span></div>
                <div class="item-text">${h.about}</div>
                <div class="item-row-acts">
                  <button class="btn primary" onClick=${() => openModal(JoinPreview, { house: inv.house })}>Take a look</button>
                  <button class="btn" onClick=${() => declineInvite(inv.house)}>Not now</button>
                </div>
              </div>
            </div>`;
          })}
          <div onKeyDown=${onTriageKey}>
            ${needs.map(({ conv, m }) => html`<${TriageItem} key=${m.id} conv=${conv} m=${m} />`)}
          </div>
          ${needs.length > 1 && html`<div class="view-note triage-hint">${S.ui.phone ? 'Swipe left on an item when you\u2019re done with it.' : html`<span class="kbd">J</span> <span class="kbd">K</span> to move, <span class="kbd">E</span> when done, <span class="kbd">Enter</span> to open.`}</div>`}
          ${byHouse.map(({ h, rows }) => html`<div key=${h}>
            <div class="view-sect">${S.houses[h].name}
              <button class="btn quiet" onClick=${() => markManyRead(rows.map((r) => r.conv), `${S.houses[h].name} news marked as read`)}>Mark read</button>
            </div>
            ${rows.map(({ conv, count, people, top }) => {
              const room = S.rooms[conv];
              return html`<div class="news" key=${conv}>
                <span class="news-ic"><${RoomIcon} kind=${room.kind} /></span>
                <button class="news-main" onClick=${() => openConv(conv)}>
                  <span class="news-name">${room.name}</span>
                  <span class="news-sum">${plural(count, 'new message')} from ${nameList(people.map((p) => person(p).name.split(' ')[0]))}</span>
                  <span class="news-top"><b>${person(top.author).name.split(' ')[0]}</b> <${Rich} m=${top} /></span>
                </button>
                <span class="news-acts"><button class="ib" aria-label=${`Mark ${room.name} as read`} data-tip="Mark read" onClick=${() => markConvRead(conv)}><${Icon} name="check" size=${18} /></button></span>
              </div>`;
            })}
          </div>`)}
        </div>`}
    </div>
  </section>`;
}

export function Saved() {
  const rows = S.saved.map((s) => ({ s, m: findMsg(s.conv, s.id), meta: convMeta(s.conv) })).filter((r) => r.m && r.meta);
  return html`<section class="main view" aria-label="Saved">
    <header class="bar">
      <${Back} />
      <h1 class="bar-title"><${Icon} name="save" />Saved</h1>
      ${rows.length > 0 && html`<span class="bar-sub">${plural(rows.length, 'message')}, newest first</span>`}
    </header>
    <div class="view-body">
      ${!rows.length
        ? html`<${Empty} icon="save" title="Nothing saved yet" text="Good answers scroll away. Save one and it stays here, with a note if you like. Hover a message and choose Save, or press S." />`
        : html`<div class="col">
          ${rows.map(({ s, m, meta }) => html`<div class="item" key=${s.id}>
            <${Avatar} user=${person(m.author)} />
            <div class="item-main">
              <button class="item-main" onClick=${() => jumpToMsg(s.conv, s.id)}>
                <span class="item-meta"><b>${person(m.author).name}</b><span class="where">${isThread(s.conv) ? `thread in ${meta.where}` : meta.title}</span><span class="num">${fmtWhen(m.ts)}</span></span>
                <span class="item-text"><${Rich} m=${m} /></span>
              </button>
              <label class="item-note">
                <${Icon} name="edit" size=${14} />
                <input placeholder="Add a note so you can find it later" aria-label="Note" value=${s.note} onInput=${(e) => setSavedNote(s.id, e.target.value)} />
              </label>
            </div>
            <div class="item-acts float">
              <button class="ib on" aria-label="Remove from Saved" data-tip="Remove from Saved" onClick=${() => toggleSave(s.conv, s.id)}><${Icon} name="saved" size=${18} /></button>
            </div>
          </div>`)}
        </div>`}
    </div>
  </section>`;
}
