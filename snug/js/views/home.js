// Home: the first thing you see. Who is around and what they are doing, where
// people are talking right now, what is about to happen, your communities,
// and a few places you might like. Everything comes from real state; nothing
// is filler. Rows, not cards: hierarchy comes from type and spacing.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, me, go, back, openConv, convMeta, isOnline, voiceRoomOf, discover, person } from '../store.js';
import { attention, houseAttention } from '../lib/attention.js';
import { friendsOnline, friendsList, friendRequests, activeConversations, liveVoice, upcomingEvents, eventState, greeting } from '../lib/social.js';
import { gather } from './catchup.js';
import { plural } from '../lib/util.js';
import { plain } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Nook } from '../ui/brand.js';
import { Avatar, Stack, Tile, RoomIcon, PRESENCE } from '../ui/kit.js';
import { EventRow } from './events.js';
import { joinVoice } from '../voice.js';
import { openHouse, onlineIn, OnlineCount } from './nav.js';

const first = (name) => (name || '').split(' ')[0];

// What a friend is doing, most telling first: in a voice room, writing
// somewhere, their own status line, how open they are to talk.
function doing(u) {
  const r = u.presence !== 'offline' && voiceRoomOf(u.id);
  if (r) return { text: `In ${S.rooms[r].name}`, live: true };
  const typingIn = Object.keys(S.typing || {}).find((c) => (S.typing[c] || []).includes(u.id) && convMeta(c));
  if (typingIn) {
    const meta = convMeta(typingIn);
    return { text: meta.kind === 'dm' ? 'Writing to you' : `Typing in ${meta.title}`, typing: true };
  }
  if (u.status) return { text: u.status };
  return { text: PRESENCE[u.presence]?.label || '' };
}

// Re-render once a minute so "now" and "in 20 minutes" stay true.
function useMinute() {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
}

// Suggestions are asked for once a few minutes, not on every visit.
let picks = { at: 0, data: null, busy: false };
function usePicks() {
  const [, set] = useState(0);
  // Suggestions belong to one account: someone else signing in starts over.
  if (picks.me !== S.me) picks = { at: 0, data: null, busy: false, me: S.me };
  useEffect(() => {
    if (picks.busy || !isOnline() || (picks.data && Date.now() - picks.at < 5 * 60_000)) return undefined;
    let live = true;
    picks.busy = true;
    const who = S.me;
    discover({}).then((r) => {
      if (who !== S.me) return;
      picks = { at: Date.now(), data: r || picks.data || { houses: [], people: [] }, busy: false, failed: !r, me: who };
      if (live) set((n) => n + 1);
    });
    return () => { live = false; };
  }, [S.conn.socket]);
  return picks;
}

function Sect({ id, title, count, action, children }) {
  return html`<section class="home-sect" aria-labelledby=${id}>
    <div class="home-h">
      <h3 id=${id}>${title}</h3>
      ${count != null && html`<span class="home-count num">${count}</span>`}
      ${action && html`<button class="home-more" onClick=${action.run}>${action.label}<${Icon} name="chev-r" size=${14} /></button>`}
    </div>
    ${children}
  </section>`;
}

function FriendsStrip({ ids }) {
  return html`<ul class="home-friends" role="list">
    ${ids.map((id) => {
      const u = S.users[id];
      const d = doing(u);
      return html`<li key=${id}>
        <button class="home-friend" onClick=${() => go({ type: 'person', id })} aria-label=${`${u.name}, ${d.text}. Open profile`}>
          <${Avatar} user=${u} presence size=${48} speaking=${!!S.speaking[id]} />
          <span class="home-friend-name trunc">${first(u.name)}</span>
          <span class=${`home-friend-doing${d.live ? ' is-live' : ''}${d.typing ? ' is-typing' : ''}`}>${d.text}</span>
        </button>
      </li>`;
    })}
  </ul>`;
}

// Nobody is online, but people wrote in the last hour: show who, so the place
// still reads as lived in, and where to find them.
function recentlyHere(now) {
  const seen = new Map();
  for (const [conv, list] of Object.entries(S.msgs)) {
    if (!convMeta(conv)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.ts < now - 3_600_000) break;
      if (m.sys || m.author === S.me || !S.users[m.author]) continue;
      if (!seen.has(m.author) || seen.get(m.author).ts < m.ts) seen.set(m.author, { id: m.author, ts: m.ts, conv });
    }
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, 8);
}

function RecentStrip({ items, now }) {
  return html`<ul class="home-friends" role="list">
    ${items.map(({ id, ts, conv }) => {
      const u = S.users[id];
      const mins = Math.max(1, Math.round((now - ts) / 60_000));
      const meta = convMeta(conv);
      const where = meta?.kind === 'dm' ? 'Wrote to you' : meta?.title || '';
      return html`<li key=${id}>
        <button class="home-friend" onClick=${() => go({ type: 'person', id })} aria-label=${`${u.name}, wrote in ${where} ${mins} minutes ago. Open profile`}>
          <${Avatar} user=${u} presence size=${48} />
          <span class="home-friend-name trunc">${first(u.name)}</span>
          <span class="home-friend-doing">${where} · ${mins}m</span>
        </button>
      </li>`;
    })}
  </ul>`;
}

function VoiceRow({ conv, people }) {
  const room = S.rooms[conv];
  const users = people.map((id) => S.users[id]).filter(Boolean);
  const here = S.call?.room === conv;
  const speaking = users.filter((u) => S.speaking[u.id]).map((u) => first(u.name));
  return html`<div class="home-row home-voice">
    <button class="home-row-main" onClick=${() => openConv(conv)}>
      <span class="home-row-ic is-live"><${Icon} name="voice" size=${18} /></span>
      <span class="home-row-text">
        <span class="home-row-title"><span class="trunc">${room.name}</span><span class="home-row-where trunc">${S.houses[room.house].name}</span></span>
        <span class="home-row-sub trunc">${speaking.length ? `${speaking.join(', ')} talking` : plural(users.length, 'person', 'people')} in voice</span>
      </span>
      <${Stack} users=${users} max=${5} size=${24} />
    </button>
    ${here
      ? html`<button class="btn quiet" onClick=${() => openConv(conv)}>You’re in</button>`
      : html`<button class="btn" onClick=${() => { openConv(conv); joinVoice(conv); }} aria-label=${`Join ${room.name}`}><${Icon} name="voice" size=${16} />Join</button>`}
  </div>`;
}

function ConvRow({ conv, talking, typing, inVoice, newCount }) {
  const meta = convMeta(conv);
  const list = (S.msgs[conv] || []).filter((m) => !m.sys);
  const last = list[list.length - 1];
  const authors = [...new Set(list.slice(-12).reverse().map((m) => m.author))].filter((u) => u !== S.me).slice(0, 3).map((u) => person(u));
  const typers = (S.typing[conv] || []).filter((u) => u !== S.me).map((u) => first(person(u).name));
  const bits = [];
  if (talking) bits.push(html`<span>${plural(talking, 'person', 'people')} talking</span>`);
  if (typing) bits.push(html`<span class="is-typing">${typers.length === 1 ? `${typers[0]} is typing` : `${typing} typing`}</span>`);
  if (inVoice) bits.push(html`<span class="is-live">${inVoice} in voice</span>`);
  const a = attention(S, conv);
  const icon = meta.user ? html`<${Avatar} user=${meta.user} presence size=${32} />` : meta.dm ? html`<${Icon} name="people" size=${18} />` : html`<${RoomIcon} kind=${meta.kind} size=${18} />`;
  return html`<button class=${`home-row${newCount ? ' has-new' : ''}`} onClick=${() => openConv(conv)}>
    <span class="home-row-ic">${icon}</span>
    <span class="home-row-text">
      <span class="home-row-title">
        <span class="trunc">${meta.title}</span>
        <span class="home-row-where trunc">${meta.house ? S.houses[meta.house].name : meta.kind === 'group' ? 'Group' : 'Direct'}</span>
      </span>
      <span class="home-row-sub trunc">${bits.map((b, i) => html`${i > 0 && html`<span class="sep" aria-hidden="true">·</span>`}${b}`)}</span>
      ${last && html`<span class="home-row-quote trunc"><b>${first(person(last.author).name)}</b> ${plain(last.text).slice(0, 140) || (last.files?.length ? 'shared a file' : '')}</span>`}
    </span>
    <span class="home-row-end">
      ${a.needs > 0 ? html`<span class="badge" aria-label=${`${a.needs} for you`}>${a.needs}</span>`
        : newCount > 0 ? html`<span class="home-new num">${newCount} new</span>` : null}
      <${Stack} users=${authors} max=${3} size=${24} />
    </span>
  </button>`;
}

function CommunityRow({ id }) {
  const h = S.houses[id];
  const online = onlineIn(h);
  const voice = Object.entries(S.voice || {}).filter(([r, ppl]) => ppl.length && S.rooms[r]?.house === id).reduce((n, [, ppl]) => n + ppl.length, 0);
  const a = houseAttention(S, id);
  return html`<li>
    <button class="home-row home-house" onClick=${() => openHouse(id)}>
      <span class="home-row-ic"><${Tile} house=${h} /></span>
      <span class="home-row-text">
        <span class="home-row-title"><span class="trunc">${h.name}</span></span>
        <span class="home-row-sub trunc">
          <${OnlineCount} n=${online} cls="home-online" />
          ${voice > 0 && html`<span class="sep" aria-hidden="true">·</span><span class="is-live">${voice} in voice</span>`}
        </span>
      </span>
      <span class="home-row-end">${a.needs > 0 ? html`<span class="badge" aria-label=${`${a.needs} for you`}>${a.needs}</span>` : a.soft ? html`<span class="dot" role="img" aria-label="New activity"></span>` : null}</span>
    </button>
  </li>`;
}

function Picks() {
  const p = usePicks();
  if (!p.data && !p.busy) return null;
  const houses = (p.data?.houses || []).slice(0, 3);
  const people = (p.data?.people || []).slice(0, 1);
  const rows = [...houses.slice(0, people.length ? 2 : 3).map((h) => ({ h })), ...people.map((x) => ({ x }))];
  if (p.data && !rows.length) return null;
  return html`<${Sect} id="home-picks" title="Recommended for you" action=${{ label: 'Discover', run: () => go({ type: 'discover' }) }}>
    ${!p.data
      ? html`<div class="home-list" aria-busy="true">${[70, 54, 62].map((w) => html`<div class="home-row home-skel"><span class="skel home-skel-ic"></span><span class="home-row-text"><span class="skel" style=${`width:${w}%;height:12px`}></span><span class="skel" style="width:40%;height:10px"></span></span></div>`)}</div>`
      : html`<ul class="home-list" role="list">
        ${rows.map(({ h, x }) => (h
          ? html`<li key=${h.id}><button class="home-row home-pick" onClick=${() => go({ type: 'house', id: h.id })}>
              <span class="home-row-ic"><${Tile} house=${h} /></span>
              <span class="home-row-text">
                <span class="home-row-title"><span class="trunc">${h.name}</span>${h.topic && html`<span class="home-row-where">${h.topic}</span>`}</span>
                ${h.about && html`<span class="home-row-quote home-pick-about">${h.about}</span>`}
                <span class="home-row-sub trunc">${plural(h.members, 'member')}<span class="sep" aria-hidden="true">·</span>${h.online} online${h.inVoice > 0 ? html`<span class="sep" aria-hidden="true">·</span><span class="is-live">${h.inVoice} in voice</span>` : null}</span>
              </span>
            </button></li>`
          : html`<li key=${x.user.id}><button class="home-row home-pick" onClick=${() => go({ type: 'person', id: x.user.id })}>
              <span class="home-row-ic"><${Avatar} user=${S.users[x.user.id] || x.user} presence size=${32} /></span>
              <span class="home-row-text">
                <span class="home-row-title"><span class="trunc">${x.user.name}</span><span class="home-row-where">@${x.user.handle}</span></span>
                <span class="home-row-sub trunc">${x.reason || (x.mutualFriends ? `${plural(x.mutualFriends, 'friend')} in common` : 'Someone you might know')}</span>
              </span>
            </button></li>`))}
      </ul>`}
  <//>`;
}

function Welcome() {
  return html`<div class="home-start">
    <${Nook} size=${48} />
    <h3>Snug is better with people in it</h3>
    <p>Find a community that’s into what you’re into, or add a friend you already know. When they’re around, you’ll see it here first.</p>
    <div class="home-start-acts">
      <button class="btn primary" onClick=${() => go({ type: 'discover' })}><${Icon} name="compass" size=${16} />Find a community</button>
      <button class="btn" onClick=${() => go({ type: 'friends', tab: 'add' })}><${Icon} name="people" size=${16} />Add a friend</button>
    </div>
  </div>`;
}

export function Home() {
  useMinute();
  const now = Date.now();
  const u = me();
  const allFriends = friendsList(S);
  const online = friendsOnline(S);
  const voice = liveVoice(S);
  const inVoice = new Set(voice.map((x) => x.conv));
  const active = activeConversations(S, now).filter((x) => !inVoice.has(x.conv) && S.rooms[x.conv]?.kind !== 'voice' && convMeta(x.conv)).slice(0, 6);
  const events = upcomingEvents(S, now).filter((e) => eventState(e, now) !== 'past').slice(0, 3);
  const happeningNow = events.some((e) => eventState(e, now) === 'now');
  const requests = friendRequests(S, 'incoming');
  const recent = online.length ? [] : recentlyHere(now);
  const forYou = (() => { const { needs } = gather(); return needs.reduce((n, it) => n + it.count, 0) + S.invites.length; })();
  const fresh = !allFriends.length && !S.houseOrder.length;
  const quiet = !voice.length && !active.length && !events.length;

  const summary = [];
  if (online.length) summary.push(`${plural(online.length, 'friend')} around`);
  if (voice.length || active.length) summary.push(`${plural(voice.length + active.length, 'conversation')} going`);
  if (happeningNow) summary.push('something on now');

  return html`<section class="main view home" aria-label="Home">
    <header class="bar">
      ${S.ui.phone && S.ui.depth > 0 && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`}
      <h1 class="sr">Home</h1>
      <div class="bar-end">
        <button class="btn quiet" onClick=${() => go({ type: 'friends', tab: 'add' })}><${Icon} name="people" size=${16} />Add a friend</button>
      </div>
    </header>
    <div class="view-body">
      <div class="home-col">
        <div class="home-hello">
          <h2 class="home-greet">${greeting(now)}, ${first(u.name) || 'you'}</h2>
          ${(summary.length > 0 || forYou > 0 || requests.length > 0) && html`<p class="home-summary">
            ${summary.join(', ')}${summary.length ? '.' : ''}
            ${forYou > 0 && html`<button class="home-foryou" onClick=${() => go({ type: 'catchup' })}><span class="badge">${forYou}</span>for you in Catch up</button>`}
            ${requests.length > 0 && html`<button class="home-foryou" onClick=${() => go({ type: 'friends', tab: 'requests' })}><span class="badge">${requests.length}</span>${requests.length === 1 ? `${first(person(requests[0]).name)} wants to be friends` : 'friend requests'}</button>`}
          </p>`}
        </div>

        ${fresh
          ? html`<${Welcome} />`
          : html`<div class="home-grid">
            <div class="home-main">
              ${online.length > 0 && html`<${Sect} id="home-friends" title="Friends online" count=${online.length} action=${{ label: 'All friends', run: () => go({ type: 'friends' }) }}>
                <${FriendsStrip} ids=${online} />
              <//>`}

              ${voice.length > 0 && html`<${Sect} id="home-voice" title="Live in voice" count=${voice.length}>
                <div class="home-list">${voice.map((x) => html`<${VoiceRow} key=${x.conv} conv=${x.conv} people=${x.people} />`)}</div>
              <//>`}

              ${active.length > 0 && html`<${Sect} id="home-active" title="Conversations going">
                <div class="home-list">${active.map((x) => html`<${ConvRow} key=${x.conv} ...${x} />`)}</div>
              <//>`}

              ${!online.length && (recent.length
                ? html`<${Sect} id="home-recent" title="Recently here" action=${allFriends.length ? { label: 'All friends', run: () => go({ type: 'friends' }) } : null}>
                  <${RecentStrip} items=${recent} now=${now} />
                <//>`
                : !allFriends.length && html`<p class="home-empty">No friends on Snug yet. <button class="home-link" onClick=${() => go({ type: 'friends', tab: 'add' })}>Add someone by their handle</button> and you’ll see when they’re around.</p>`)}

              ${events.length > 0 && html`<${Sect} id="home-events" title=${happeningNow ? 'Happening now' : 'Coming up'}
                action=${{ label: 'All events', run: () => go({ type: 'discover', section: 'events' }) }}>
                <div class="home-list home-events">${events.map((ev) => html`<${EventRow} key=${ev.id} ev=${ev} compact />`)}</div>
              <//>`}

              ${quiet && html`<p class="home-empty home-quiet">It’s quiet right now. When people start talking or someone opens a voice room, it shows up here.</p>`}
            </div>

            <aside class="home-side" aria-label="Your communities and suggestions">
              <${Sect} id="home-houses" title="Your communities" count=${S.houseOrder.length || null}>
                ${S.houseOrder.length
                  ? html`<ul class="home-list" role="list">${S.houseOrder.map((id) => html`<${CommunityRow} key=${id} id=${id} />`)}</ul>`
                  : html`<p class="home-empty">You’re not in a community yet. <button class="home-link" onClick=${() => go({ type: 'discover', section: 'communities' })}>Find one in Discover</button>.</p>`}
              <//>
              <${Picks} />
            </aside>
          </div>`}
        ${fresh && html`<div class="home-fresh-picks"><${Picks} /></div>`}
      </div>
    </div>
  </section>`;
}
