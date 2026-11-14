// Catch up > Mentions: the last 30 days of mentions and replies, read or not,
// from the server (mentions.list, server/inbox.js), so a mention older than
// what this device loaded is still here. Filter by house, leave out @role or
// @everyone, jump to the message, or dismiss it. J and K move, E dismisses,
// Enter jumps.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit, person, convMeta, jumpToMsg, toast } from '../store.js';
import { call } from '../server.js';
import { fmtWhen } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Rich, Empty } from '../ui/kit.js';

const WHY = { mention: 'mentioned you', reply: 'replied to you', role: 'mentioned your role', everyone: 'mentioned everyone' };
const state = { key: '', items: [], more: false, next: null, status: 'idle', error: '' };

function filters() {
  const f = S.ui.mentionsFilter ||= { house: null, roles: true, everyone: true };
  return f;
}
const keyOf = (f) => JSON.stringify([S.me, f]);

function load(append = false) {
  const f = filters();
  const key = keyOf(f);
  if (!append) { state.key = key; state.items = []; state.more = false; state.next = null; }
  state.status = 'loading';
  state.error = '';
  emit();
  return call('mentions.list', { house: f.house || undefined, roles: f.roles, everyone: f.everyone, before: append ? state.next ?? undefined : undefined, limit: 25 })
    .then((r) => {
      if (state.key !== key) return;
      Object.assign(S.users, Object.fromEntries(Object.entries(r.users || {}).filter(([id]) => !S.users[id])));
      Object.assign(S.threads, r.threads || {});
      for (const it of r.items) if (!S.cache[it.m.id]) S.cache[it.m.id] = it.m;
      state.items = append ? [...state.items, ...r.items] : r.items;
      state.more = r.more;
      state.next = r.next;
      state.status = 'done';
      emit();
    }, (e) => {
      if (state.key !== key) return;
      state.status = 'error';
      state.error = e.offline ? 'You’re offline. Mentions load once you’re back.' : e.message;
      emit();
    });
}

function dismiss(it, i) {
  const was = state.items;
  state.items = state.items.filter((x) => x !== it);
  emit();
  focusRow(i);
  call('mention.dismiss', { id: it.m.id }).then(() => {
    toast('Mention dismissed', { undo: () => { call('mention.dismiss', { id: it.m.id, undo: true }).then(() => load(), () => {}); state.items = was; emit(); } });
  }, (e) => { state.items = was; emit(); toast(e.offline ? 'You’re offline. Try again once you’re back.' : e.message); });
}

function focusRow(i) {
  requestAnimationFrame(() => {
    const list = [...document.querySelectorAll('.mention-row')];
    list[Math.min(i, list.length - 1)]?.focus();
  });
}
function onKey(e) {
  const el = e.target.closest?.('.mention-row');
  if (!el || e.metaKey || e.ctrlKey || e.altKey) return;
  const list = [...document.querySelectorAll('.mention-row')];
  const i = list.indexOf(el);
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'j' || k === 'ArrowDown') list[i + 1]?.focus();
  else if (k === 'k' || k === 'ArrowUp') list[i - 1]?.focus();
  else if (k === 'e' && e.target === el) el.querySelector('[data-dismiss]')?.click();
  else if (k === 'Enter' && e.target === el) el.querySelector('[data-jump]')?.click();
  else return;
  e.preventDefault();
}

export function Mentions() {
  const f = filters();
  useEffect(() => { if (state.key !== keyOf(f) || state.status === 'idle') load(); }, [keyOf(f)]);
  const set = (patch) => { S.ui.mentionsFilter = { ...f, ...patch }; emit(); };
  const items = state.items.filter((it) => !S.mentionsGone?.[it.m.id] && convMeta(it.conv));
  const houses = S.houseOrder.filter((h) => S.houses[h]?.joined);
  return html`<div class="mentions" onKeyDown=${onKey}>
    <div class="mentions-filters" role="group" aria-label="Filter mentions">
      <label class="sr" for="mentions-house">House</label>
      <select id="mentions-house" class="field mentions-house" value=${f.house || ''} onChange=${(e) => set({ house: e.target.value || null })}>
        <option value="">Everywhere</option>
        ${houses.map((h) => html`<option key=${h} value=${h}>${S.houses[h].name}</option>`)}
      </select>
      <button class="chip" aria-pressed=${String(f.roles)} onClick=${() => set({ roles: !f.roles })}>@role</button>
      <button class="chip" aria-pressed=${String(f.everyone)} onClick=${() => set({ everyone: !f.everyone })}>@everyone</button>
    </div>
    ${state.status === 'error' && html`<div class="banner err" role="alert"><${Icon} name="alert" size=${16} /><span>${state.error}</span><button class="btn quiet" onClick=${() => load()}>Try again</button></div>`}
    ${state.status === 'loading' && !items.length && html`<div class="mentions-loading" role="status" aria-live="polite">Loading mentions…</div>`}
    ${state.status === 'done' && !items.length && html`<${Empty} icon="at" title="No mentions in the last 30 days" text=${f.house || !f.roles || !f.everyone ? 'Nothing matches these filters. Try Everywhere, or turn @role and @everyone back on.' : 'When someone mentions you or replies to you, it stays here for 30 days, read or not.'} />`}
    ${items.length > 0 && html`<ul class="col mentions-list" aria-label="Mentions">
      ${items.map((it, i) => {
        const meta = convMeta(it.conv);
        const where = meta.kind === 'thread' ? `a thread in ${meta.where}` : meta.kind === 'dm' ? 'your conversation' : meta.title;
        const u = person(it.m.author);
        return html`<li key=${it.m.id} class="item mention-row" tabindex="0" data-id=${it.m.id} aria-label=${`${u.name} ${WHY[it.why]} in ${where}`}>
          <${Avatar} user=${u} />
          <button class="item-main" tabindex="-1" data-jump onClick=${() => jumpToMsg(it.conv, it.m.id)}>
            <span class="item-meta"><b>${u.name}</b><span class="where">${WHY[it.why]} in ${where}</span><span class="num">${fmtWhen(it.m.ts)}</span></span>
            <span class="item-text"><${Rich} m=${it.m} /></span>
          </button>
          <div class="item-acts float">
            <button class="ib" tabindex="-1" aria-label="Jump to message" data-tip="Jump" data-key="Enter" onClick=${() => jumpToMsg(it.conv, it.m.id)}><${Icon} name="forward" size=${18} /></button>
            <button class="ib" tabindex="-1" data-dismiss aria-label="Dismiss" data-tip="Dismiss" data-key="E" onClick=${() => dismiss(it, i)}><${Icon} name="x" size=${18} /></button>
          </div>
        </li>`;
      })}
    </ul>`}
    ${items.length > 1 && html`<div class="view-note triage-hint">${S.ui.phone ? 'Tap a mention to jump to it.' : html`<span class="kbd">J</span> <span class="kbd">K</span> to move, <span class="kbd">E</span> to dismiss, <span class="kbd">Enter</span> to jump.`}</div>`}
    ${state.more && html`<div class="mentions-more"><button class="btn" disabled=${state.status === 'loading'} aria-busy=${String(state.status === 'loading')} onClick=${() => load(true)}>${state.status === 'loading' ? 'Loading…' : 'Show older'}</button></div>`}
  </div>`;
}
