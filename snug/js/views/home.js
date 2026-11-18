// Home: the first thing you see. Who is around and what they are doing, where
// people are talking right now, what is about to happen, your communities,
// and a few places you might like. Everything comes from real state; nothing
// is filler. Rows, not cards: hierarchy comes from type and spacing.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, me, go, back, openConv, openModal, openQuick, convMeta, isOnline, voiceRoomOf, discover, person } from '../store.js';
import { attention, houseAttention } from '../lib/attention.js';
import { friendsOnline, friendsList, friendRequests, activeConversations, liveVoice, upcomingEvents, eventState, greeting, wroteLately, summaryLine } from '../lib/social.js';
import { gather } from './catchup.js';
import { plural } from '../lib/util.js';
import { plain } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack, Tile, RoomIcon, PRESENCE, LoadingState } from '../ui/kit.js';
import { EventRow } from './events.js';
import { joinVoice } from '../voice.js';
import { leavingCall } from '../calls.js';
import { openHouse, onlineIn, OnlineCount } from './nav.js';
import { RecoveryReminder } from './recover.js'; // v0.12: a password account with no recovery key yet
import { Welcome, Steps, guideWanted } from './start.js'; // 0.15: getting started
import { JoinPreview } from './modals.js';
import { t } from '../lib/i18n.js'; // words in the chosen language (js/locales)

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
      <h3 id=${id}>${title}${count != null && html`<span class="home-count num"><span aria-hidden="true"> — </span><span class="sr">, </span>${count}</span>`}</h3>
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
          <${Avatar} user=${u} presence size=${32} speaking=${!!S.speaking[id]} />
          <span class="home-friend-text">
            <span class="home-friend-name trunc">${u.name}</span>
            <span class=${`home-friend-doing trunc${d.live ? ' is-live' : ''}${d.typing ? ' is-typing' : ''}`}>${d.live && html`<${Icon} name="speaker" size=${12} />`}${d.text}</span>
          </span>
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
      if (m.sys || m.author === S.me || !S.users[m.author] || S.users[m.author].hideActive || S.users[m.author].deleted) continue; // privacy: hidden activity
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
          <${Avatar} user=${u} presence size=${32} dim />
          <span class="home-friend-text">
            <span class="home-friend-name trunc">${u.name}</span>
            <span class="home-friend-doing trunc">${where} · ${mins}m ago</span>
          </span>
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
      : html`<button class="btn" onClick=${() => leavingCall(conv, () => { openConv(conv); joinVoice(conv); })} aria-label=${`Join ${room.name}`}><${Icon} name="voice" size=${16} />Join</button>`}
  </div>`;
}

function ConvRow({ conv, talking, typing, inVoice, newCount }) {
  const meta = convMeta(conv);
  const list = (S.msgs[conv] || []).filter((m) => !m.sys);
  const last = list[list.length - 1];
  const authors = [...new Set(list.slice(-12).reverse().map((m) => m.author))].filter((u) => u !== S.me).slice(0, 3).map((u) => person(u));
  const typers = (S.typing[conv] || []).filter((u) => u !== S.me).map((u) => first(person(u).name));
  const bits = [];
  if (talking) bits.push(html`<span class="talking">${wroteLately(talking)}</span>`);
  if (typing) bits.push(html`<span class="is-typing">${typers.length === 1 ? `${typers[0]} is typing` : `${typing} typing`}</span>`);
  // A call in a direct conversation is mint, like every call mark; a voice room keeps its own.
  if (inVoice) bits.push(meta.dm ? html`<span class="call-now">In a call</span>` : html`<span class="is-live">${inVoice} in voice</span>`);
  const a = attention(S, conv);
  const icon = meta.user ? html`<${Avatar} user=${meta.user} presence size=${32} />` : meta.dm ? html`<${Icon} name="people" size=${18} />` : html`<${RoomIcon} kind=${meta.kind} size=${18} />`;
  return html`<button class=${`home-row${newCount ? ' has-new' : ''}`} onClick=${() => openConv(conv)}>
    <span class="home-row-ic">${icon}</span>
    <span class="home-row-text">
      <span class="home-row-title">
        <span class="trunc">${meta.title}</span>
        <span class="home-row-where trunc">${meta.house ? S.houses[meta.house].name : meta.kind === 'group' ? 'Group' : 'Direct'}</span>
        <span class="home-row-sub home-row-bits trunc">${bits.map((b, i) => html`<span class="sep" aria-hidden="true">·</span>${b}`)}</span>
      </span>
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
      ? html`<${LoadingState} kind="list" rows=${3} label="Loading suggestions" />`
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

// Invitations waiting for you: each house, who sent it, and a look before joining.
function Invitations() {
  const list = S.invites.filter((inv) => S.houses[inv.house]);
  if (!list.length) return null;
  return html`<${Sect} id="home-invites" title=${t('home.invites')} count=${list.length}>
    <ul class="home-list" role="list">
      ${list.map((inv) => {
        const h = S.houses[inv.house];
        const from = first(S.users[inv.from]?.name) || t('addHouse.someone');
        return html`<li key=${inv.house}><div class="home-row home-invite">
          <span class="home-row-ic"><${Tile} house=${h} /></span>
          <span class="home-row-text">
            <span class="home-row-title"><span class="trunc">${h.name}</span></span>
            <span class="home-row-sub trunc">${t('home.invitedBy', { name: from })}</span>
          </span>
          <button class="btn primary sm" onClick=${() => openModal(JoinPreview, { house: inv.house })} aria-label=${t('home.lookAt', { house: h.name })}>${t('home.look')}</button>
        </div></li>`;
      })}
    </ul>
  <//>`;
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
  // On a wide screen the sidebar already lists live voice rooms and events,
  // and the rail the communities: Home's column keeps the conversations and
  // the people. A phone has no sidebar beside Home, so it keeps them all.
  const phone = S.ui.phone;

  const summary = [];
  if (online.length) summary.push(`${plural(online.length, 'friend')} around`);
  if (voice.length || active.length) summary.push(`${plural(voice.length + active.length, 'conversation')} going`);
  if (happeningNow) summary.push('something on now');

  return html`<section class="main view home" aria-label=${t('nav.home')}>
    <header class="bar">
      ${S.ui.phone && S.ui.depth > 0 && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`}
      <h1 class="bar-title"><${Icon} name="house" />${t('nav.home')}</h1>
      <div class="bar-end">
        ${S.ui.phone && html`<button class="ib" aria-label="Jump to or search" onClick=${() => openQuick()}><${Icon} name="search" /></button>`}
        <button class="btn quiet" onClick=${() => go({ type: 'friends', tab: 'add' })}><${Icon} name="user-plus" size=${16} />${t('home.addFriend')}</button>
      </div>
    </header>
    <div class="view-body">
      <div class="home-col">
        <${RecoveryReminder} />
        ${!fresh && html`<div class="home-hello">
          <h2 class="home-greet">${greeting(now)}, ${first(u.name) || 'you'}</h2>
          ${(summary.length > 0 || forYou > 0 || requests.length > 0) && html`<p class="home-summary">
            ${summaryLine(summary)}
            ${forYou > 0 && html`<button class="home-foryou" onClick=${() => go({ type: 'catchup' })}><span class="badge">${forYou}</span>for you in Catch up</button>`}
            ${requests.length > 0 && html`<button class="home-foryou" onClick=${() => go({ type: 'friends', tab: 'requests' })}><span class="badge">${requests.length}</span>${requests.length === 1 ? `${first(person(requests[0]).name)} wants to be friends` : 'friend requests'}</button>`}
          </p>`}
        </div>`}

        <${Invitations} />
        ${!fresh && guideWanted() && html`<${Steps} />`}
        ${fresh
          ? html`<${Welcome} />`
          : html`<div class="home-grid">
            <div class="home-main">
              ${phone && voice.length > 0 && html`<${Sect} id="home-voice" title=${t('home.liveVoice')} count=${voice.length}>
                <div class="home-list">${voice.map((x) => html`<${VoiceRow} key=${x.conv} conv=${x.conv} people=${x.people} />`)}</div>
              <//>`}

              ${active.length > 0 && html`<${Sect} id="home-active" title=${t('home.going')}>
                <div class="home-list">${active.map((x) => html`<${ConvRow} key=${x.conv} ...${x} />`)}</div>
              <//>`}

              ${phone && events.length > 0 && html`<${Sect} id="home-events" title=${happeningNow ? t('nav.happeningNow') : t('home.comingUp')}
                action=${{ label: t('nav.allEvents'), run: () => go({ type: 'discover', section: 'events' }) }}>
                <div class="home-list home-events">${events.map((ev) => html`<${EventRow} key=${ev.id} ev=${ev} compact />`)}</div>
              <//>`}

              ${quiet && html`<p class="home-empty home-quiet">${t('home.quiet')}</p>`}
              ${!phone && !quiet && !active.length && html`<p class="home-empty home-quiet">${t('home.quietSide')}</p>`}
            </div>

            <section class="home-side" aria-label=${phone || !S.houseOrder.length ? 'Who’s around, your houses and suggestions' : 'Who’s around and suggestions'}>
              ${online.length > 0 && html`<${Sect} id="home-friends" title=${t('home.onlineNow')} count=${online.length} action=${{ label: t('home.allFriends'), run: () => go({ type: 'friends' }) }}>
                <${FriendsStrip} ids=${online} />
              <//>`}

              ${!online.length && (recent.length
                ? html`<${Sect} id="home-recent" title=${t('home.recentlyHere')} action=${allFriends.length ? { label: t('home.allFriends'), run: () => go({ type: 'friends' }) } : null}>
                  <${RecentStrip} items=${recent} now=${now} />
                <//>`
                : !allFriends.length && html`<p class="home-empty">${t('home.noFriendsBefore')} <button class="home-link" onClick=${() => go({ type: 'friends', tab: 'add' })}>${t('home.noFriendsLink')}</button> ${t('home.noFriendsAfter')}</p>`)}

              ${(phone || !S.houseOrder.length) && html`<${Sect} id="home-houses" title=${t('home.communities')} count=${S.houseOrder.length || null}>
                ${S.houseOrder.length
                  ? html`<ul class="home-list" role="list">${S.houseOrder.map((id) => html`<${CommunityRow} key=${id} id=${id} />`)}</ul>`
                  : html`<p class="home-empty">${t('home.noHousesBefore')} <button class="home-link" onClick=${() => go({ type: 'discover', section: 'communities' })}>${t('home.noHousesLink')}</button>.</p>`}
              <//>`}
              <${Picks} />
            </section>
          </div>`}
        ${fresh && html`<div class="home-fresh-picks"><${Picks} /></div>`}
      </div>
    </div>
  </section>`;
}
