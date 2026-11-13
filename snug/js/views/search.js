// Finding things: the quick jump (go somewhere) and search (find a message).
// One field leads to both.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import {
  S, back, go, emit, convMeta, jumpToMsg, openConv, openMenu, startDm, closeQuick, openLayer, setPresence, setPref, openPop,
} from '../store.js';
import { parseQuery, runSearch, setOp, isEmptyQuery } from '../lib/search.js';
import { attention, isThread, roomIds } from '../lib/attention.js';
import { fmtWhen, plural, fuzzy } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Tile, RoomIcon, Rich, Empty } from '../ui/kit.js';
import { Settings } from './settings.js';
import { searchMessages } from '../server.js';
import { openHouse } from './nav.js';
import { THEME_ACTIONS } from './appearance.js'; // themes by name
import { ACCOUNT_ACTIONS } from './account.js'; // mute, mark read, themes, presence, status, streamer mode, shortcuts
import { withRecent } from '../account.js'; // recent places come first
import { SearchDateFilter, SearchSuggest, dateChipLabel } from './messaging.js'; // date filter, mentions, pinned, suggestions while typing
import { INBOX_ACTIONS } from '../inbox.js'; // presence for a while and the Mentions inbox

const rectOf = (e) => e.currentTarget.getBoundingClientRect();

// Examples use a real person and room of yours, so they work when clicked.
function examples() {
  const someone = Object.values(S.users).find((u) => u.id !== S.me)?.handle || 'name';
  const room = S.houseOrder.flatMap((h) => roomIds(S, h)).map((id) => S.rooms[id]).find((r) => r?.kind === 'text')?.name.toLowerCase() || 'room name';
  return [
    [`from:${someone}`, 'Only what one person wrote'],
    [`in:"${room}" has:image`, 'Pictures shared in one room'],
    ['has:file', 'Messages with a file attached'],
    ['has:link', 'Messages with a link'],
    ['is:saved', 'Only messages you saved'],
    [`mentions:${someone}`, 'Messages that mention someone'],
    [`during:${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`, 'Messages from this month (before: and after: work too)'],
    ['pinned:true has:poll', 'Pinned messages, polls'],
  ];
}

export function Search() {
  const q = S.ui.view.q || '';
  const input = useRef();
  const p = parseQuery(q);
  // Results come from the server, which searches every stored message you can
  // read. Offline, search covers the messages already on this device.
  const [res, setRes] = useState({ q: null, hits: [], local: false });
  const empty = isEmptyQuery(p);
  useEffect(() => {
    if (empty) { setRes({ q, hits: [], local: false }); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      searchMessages(q).then(
        (hits) => live && setRes({ q, hits, local: false }),
        (e) => live && (e.offline ? setRes({ q, hits: runSearch(S, p), local: true }) : setRes({ q, hits: [], error: e.message })),
      );
    }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [q, S.conn.socket === 'open']);
  const loading = !empty && res.q !== q;
  const hits = res.hits;
  const set = (next) => { S.ui.view = { type: 'search', q: next }; emit(); };
  // Before the first paint, so keys typed right after Ctrl+Shift+F land here
  // instead of being lost while a busy page paints.
  useLayoutEffect(() => {
    const el = input.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const people = Object.values(S.users).sort((a, b) => a.name.localeCompare(b.name));
  const places = [...S.houseOrder.flatMap((h) => roomIds(S, h).map((id) => S.rooms[id].name)), ...S.dmOrder.map((d) => convMeta(d).title)];
  const pick = (e, key, options, current) => openMenu({
    anchor: rectOf(e),
    items: [
      current && { label: 'Anything', icon: 'x', onSelect: () => set(setOp(q, key, null)) },
      current && { sep: true },
      ...options.map(([value, label]) => ({ label, checked: current === value.toLowerCase(), onSelect: () => set(setOp(q, key, value.toLowerCase())) })),
    ],
  });
  const filtered = p.from.length || p.in.length || p.has.length || p.saved || p.mentions?.length || p.before || p.after || p.during || p.pinned;

  return html`<section class="main view" aria-label="Search">
    <div class="search-bar">
      <div class="search-input">
        ${S.ui.phone ? html`<button class="ib" style="position:static;margin-left:-8px" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>` : html`<${Icon} name="search" />`}
        <input class="field" ref=${input} type="search" placeholder="Search messages" aria-label="Search messages" value=${q}
          style=${S.ui.phone ? 'padding-left:12px' : ''} onInput=${(e) => set(e.target.value)} />
        ${q && html`<button class="ib" aria-label="Clear search" data-tip="Clear" onClick=${() => { set(''); input.current.focus(); }}><${Icon} name="x" /></button>`}
        <${SearchSuggest} q=${q} set=${set} places=${places} input=${input} />
      </div>
      <div class="filters" role="group" aria-label="Filters">
        <button class=${`chip${p.from.length ? ' on' : ''}`} onClick=${(e) => pick(e, 'from', people.map((u) => [u.handle, u.name]), p.from[0])}>
          ${p.from.length ? `From ${people.find((u) => u.handle === p.from[0])?.name.split(' ')[0] || p.from[0]}` : 'From anyone'}<${Icon} name="chev-d" size=${14} /></button>
        <button class=${`chip${p.in.length ? ' on' : ''}`} onClick=${(e) => pick(e, 'in', places.map((n) => [n, n]), p.in[0])}>
          ${p.in.length ? `In ${places.find((n) => n.toLowerCase() === p.in[0]) || p.in[0]}` : 'In any place'}<${Icon} name="chev-d" size=${14} /></button>
        <button class=${`chip${p.has.length ? ' on' : ''}`} onClick=${(e) => pick(e, 'has', [['image', 'A picture'], ['file', 'A file'], ['link', 'A link'], ['poll', 'A poll'], ['sticker', 'A sticker'], ['video', 'A video']], p.has[0])}>
          ${p.has.length ? `With a ${p.has[0] === 'image' ? 'picture' : p.has[0]}` : 'With anything'}<${Icon} name="chev-d" size=${14} /></button>
        <button class=${`chip${p.mentions?.length ? ' on' : ''}`} onClick=${(e) => pick(e, 'mentions', people.map((u) => [u.handle, u.name]), p.mentions?.[0])}>
          ${p.mentions?.length ? `Mentions ${people.find((u) => u.handle === p.mentions[0])?.name.split(' ')[0] || p.mentions[0]}` : 'Mentioning anyone'}<${Icon} name="chev-d" size=${14} /></button>
        <button class=${`chip${p.before || p.after || p.during ? ' on' : ''}`} onClick=${(e) => openPop({ anchor: rectOf(e), align: 'start', label: 'Filter by date', C: SearchDateFilter, props: { q, set, setOp, p } })}>
          <${Icon} name="calendar" size=${14} />${dateChipLabel(p)}<${Icon} name="chev-d" size=${14} /></button>
        <button class=${`chip${p.pinned ? ' on' : ''}`} aria-pressed=${String(!!p.pinned)} onClick=${() => set(setOp(setOp(q, 'is', p.saved ? 'saved' : null), 'pinned', p.pinned ? null : 'true'))}>
          <${Icon} name="pin" size=${14} />Pinned only</button>
        <button class=${`chip${p.saved ? ' on' : ''}`} aria-pressed=${String(p.saved)} onClick=${() => set(setOp(q, 'is', p.saved ? null : 'saved'))}>
          <${Icon} name=${p.saved ? 'saved' : 'save'} size=${14} />Saved only</button>
      </div>
    </div>
    <div class="view-body">
      ${empty
        ? html`<div class="ops">
            <p class="sub">Type a word, or narrow it down. The filters above write these for you.</p>
            <h3>Examples</h3>
            ${examples().map(([ex, what]) => html`<button class="op" key=${ex} onClick=${() => { set(ex); input.current.focus(); }}><code>${ex}</code><span>${what}</span></button>`)}
          </div>`
        : loading && !hits.length
          ? html`<div class="col" aria-busy="true"><div class="older">${[64, 48, 72].map((w) => html`<div class="older-row"><div class="skel"></div><div class="skel" style=${`width:${w}%`}></div></div>`)}</div></div>`
        : res.error
          ? html`<${Empty} icon="alert" title="Search didn\u2019t work" text=${res.error} />`
        : !hits.length
          ? html`<${Empty} icon="search" title="No messages match" text=${filtered ? 'A filter may be hiding it. Try with fewer filters, or a shorter word.' : 'Try a shorter word, or part of one. Search looks inside every room and conversation you can open.'}>
              ${filtered && html`<button class="btn" onClick=${() => set(p.terms.join(' '))}>Clear filters</button>`}
            <//>`
          : html`<div class="col search-results">
              <div class="view-note">${hits.length === 80 ? 'First 80 messages' : plural(hits.length, 'message')}, newest first${res.local ? '. You\u2019re offline, so this only covers messages already on this device.' : ''}</div>
              ${hits.map(({ conv, m }) => {
                const meta = convMeta(conv);
                const who = S.users[m.author];
                if (!meta || !who) return null;
                return html`<div class="item" key=${m.id}>
                  <${Avatar} user=${who} />
                  <button class="item-main" onClick=${() => jumpToMsg(conv, m.id)}>
                    <span class="item-meta"><b>${who.name}</b><span class="where">${isThread(conv) ? `thread in ${meta.where}` : meta.title}</span><span class="num">${fmtWhen(m.ts)}</span></span>
                    <span class="item-text"><${Rich} m=${m} hl=${p.terms} /></span>
                    ${m.files?.length > 0 && html`<span class="item-meta"><${Icon} name="clip" size=${14} />${m.files.map((f) => f.name).join(', ')}</span>`}
                  </button>
                </div>`;
              })}
            </div>`}
    </div>
  </section>`;
}

const ACTIONS = [
  { label: 'Home', icon: 'house', words: 'home start overview happening', run: () => go({ type: 'home' }) },
  { label: 'Friends', icon: 'people', words: 'friends requests add people', run: () => go({ type: 'friends' }) },
  { label: 'Discover communities', icon: 'compass', words: 'discover explore find communities houses public', run: () => go({ type: 'discover' }) },
  { label: 'Catch up', icon: 'tray', words: 'catch up inbox unread', run: () => go({ type: 'catchup' }) },
  { label: 'Saved messages', icon: 'save', words: 'saved bookmarks kept', run: () => go({ type: 'saved' }) },
  { label: 'Settings', icon: 'sliders', words: 'settings preferences options', run: () => openLayer({ C: Settings, props: {} }) },
  { label: 'Notification settings', icon: 'bell', words: 'notifications mute alerts', run: () => openLayer({ C: Settings, props: { page: 'notify' } }) },
  { label: 'Switch to dark theme', icon: 'eye', words: 'dark theme night appearance', run: () => setPref('theme', 'dark') },
  { label: 'Switch to light theme', icon: 'eye', words: 'light theme day appearance', run: () => setPref('theme', 'light') },
  { label: 'Set presence to Focused', icon: 'bell-off', words: 'focus focused do not disturb quiet', run: () => setPresence('focus') },
  { label: 'Set presence to Open to talk', icon: 'voice', words: 'open to talk available', run: () => setPresence('open') },
];
ACTIONS.push(...ACCOUNT_ACTIONS);
ACTIONS.push(...INBOX_ACTIONS); // Focused for a while, Mentions (js/inbox.js)
ACTIONS.push(...THEME_ACTIONS); // every built-in theme by name (js/views/appearance.js)

function candidates(q) {
  const out = [];
  const add = (score, item) => { if (score >= 0) out.push({ score, ...item }); };
  for (const h of S.houseOrder) {
    for (const id of roomIds(S, h)) {
      const r = S.rooms[id];
      const a = attention(S, id);
      add(withRecent(fuzzy(q, r.name), id, q) + (a.needs ? 5 : 0), { key: id, label: r.name, hint: S.houses[h].name, icon: html`<${RoomIcon} kind=${r.kind} />`, run: () => openConv(id) });
    }
  }
  for (const d of S.dmOrder) {
    const meta = convMeta(d);
    const a = attention(S, d);
    add(withRecent(fuzzy(q, meta.title), d, q) + (a.needs ? 5 : 0) + 1, {
      key: d, label: meta.title, hint: meta.user ? 'Direct' : 'Group',
      icon: meta.user ? html`<${Avatar} user=${meta.user} presence />` : html`<${Icon} name="people" />`, run: () => openConv(d),
    });
  }
  if (q) {
    const direct = new Set(S.dmOrder.map((d) => convMeta(d).user?.id).filter(Boolean));
    for (const u of Object.values(S.users)) {
      if (u.id === S.me || direct.has(u.id)) continue;
      add(Math.max(fuzzy(q, u.name), fuzzy(q, u.handle)) - 1, { key: `u${u.id}`, label: u.name, hint: 'Start a conversation', icon: html`<${Avatar} user=${u} presence />`, run: () => startDm([u.id]) });
    }
    for (const h of S.houseOrder) add(withRecent(fuzzy(q, S.houses[h].name), `h:${h}`, q) - 2, { key: `h${h}`, label: S.houses[h].name, hint: 'Community', icon: html`<${Tile} house=${S.houses[h]} />`, run: () => openHouse(h) });
    for (const a of ACTIONS) add(Math.max(fuzzy(q, a.label), ...a.words.split(' ').map((w) => (w.startsWith(q.toLowerCase()) ? 50 : -1))) - 3, { key: a.label, label: a.label, hint: 'Action', icon: html`<${Icon} name=${a.icon} />`, run: a.run });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, q ? 7 : 8);
}

export function QuickJump() {
  const [q, setQ] = useState(S.ui.quick.q || '');
  const [i, setI] = useState(0);
  const list = useRef();
  const field = useRef();
  useLayoutEffect(() => field.current.focus(), []);
  const term = q.trim();
  const rows = candidates(term);
  if (term) rows.push({ key: 'search', label: `Search messages for “${term}”`, hint: '', icon: html`<${Icon} name="search" />`, run: () => go({ type: 'search', q: term }) });
  else rows.push({ key: 'search', label: 'Search messages', hint: '', icon: html`<${Icon} name="search" />`, run: () => go({ type: 'search', q: '' }) });
  const at = Math.min(i, rows.length - 1);
  const run = (row) => { closeQuick(); row.run(); };

  useEffect(() => { list.current?.querySelector('.act')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((at + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((at - 1 + rows.length) % rows.length); }
    else if (e.key === 'Enter') { e.preventDefault(); run(rows[at]); }
  };

  return html`<div class="quick-scrim" onPointerDown=${(e) => e.target === e.currentTarget && closeQuick()}>
    <div class="quick float" role="dialog" aria-label="Jump to or search">
      <div class="quick-in">
        <${Icon} name="search" />
        <input placeholder="Jump to a room or person, or search messages" aria-label="Jump to or search" value=${q} ref=${field}
          onInput=${(e) => { setQ(e.target.value); setI(0); }} onKeyDown=${onKey} role="combobox" aria-expanded="true" aria-controls="quick-list" />
      </div>
      <div class="quick-list" id="quick-list" role="listbox" ref=${list}>
        ${!term && html`<div class="menu-label">Go to</div>`}
        ${rows.map((row, n) => html`<button key=${row.key} role="option" aria-selected=${String(n === at)} class=${`menu-item${n === at ? ' act' : ''}`}
          onMouseMove=${() => n !== at && setI(n)} onClick=${() => run(row)}>
          ${row.icon}<span class="grow trunc">${row.label}</span><span class="end">${row.hint}</span>
        </button>`)}
      </div>
      <div class="quick-foot">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> to move</span>
        <span><span class="kbd">Enter</span> to open</span>
        <span><span class="kbd">Esc</span> to close</span>
      </div>
    </div>
  </div>`;
}
