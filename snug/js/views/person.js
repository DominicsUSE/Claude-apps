// A person's corner: the full profile page ({ type: 'person', id }).
// A 64px face and a bold "now" line (no banner), who they are, what they
// are doing, what they care about, and what you have in common.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { call } from '../server.js';
import { S, back, go, startDm, openConv, convMeta } from '../store.js';
import { mutualHouses, friendState, upcomingEvents, eventState } from '../lib/social.js';
import { hueOf, plural, DAY } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Pres, Empty, Tile } from '../ui/kit.js';
import { nameAttrs, profileColours } from '../ui/kit.js'; // name styles and profile colours (css/appearance.css)
import { EventRow } from './events.js';
import {
  doingOf, FavButton, FriendButton, canMessage, Interests, Links, memberSince, editProfile, friendMenu, lastWrote, ago,
} from './people.js';
import { mutualFriendsOf } from './discover.js';
import { ProfileBanner, Pronouns, PrivateNote, StatusEmoji } from './account.js'; // banner, pronouns, private notes, status emoji
import { Rich } from '../ui/kit.js'; // the About with formatting
import { atName, PeerCode } from './p2p.js'; // a friend on another PC: their Snug username and security code

const Back = () => S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`;

const STATE_NOTE = {
  incoming: 'wants to be friends with you',
  outgoing: 'Request sent. It shows here when they accept.',
};

// The bold line under the name: where they are, or where they last wrote.
function nowLine(u, d) {
  if (d.live) return html`${d.text}${d.where ? html`<span class="faint"> · ${d.where}</span>` : ''}`;
  const w = u.id === S.me ? null : lastWrote(u.id);
  const meta = w && convMeta(w.conv);
  if (d.status) return html`<${StatusEmoji} u=${u} />${d.text}`;
  if (meta && Date.now() - w.ts < 3 * DAY) {
    return html`${u.presence === 'offline' ? 'Offline · ' : ''}${meta.kind === 'dm' ? 'Wrote to you' : `Wrote in ${meta.title}`} ${ago(w.ts)}`;
  }
  return d.text;
}

// Shared places as arches, big enough to read as doorways.
function PlaceTiles({ ids }) {
  return html`<ul class="pp-places">
    ${ids.slice(0, 8).map((h) => html`<li key=${h}><button class="pp-place" onClick=${() => go({ type: 'house', id: h })}>
      <${Tile} house=${S.houses[h]} lg /><span class="trunc">${S.houses[h].name}</span>
    </button></li>`)}
  </ul>`;
}

// Friends you have in common (friends.mutual, server/inbox.js): a count that
// opens into their circles. The server answers only for people you may see.
function MutualFriends({ id, fallback }) {
  const [ids, setIds] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setIds(null); setOpen(false);
    call('friends.mutual', { user: id }).then((r) => live && setIds(r.users), () => live && setIds(undefined));
    return () => { live = false; };
  }, [id]);
  if (ids === undefined) return fallback > 0 ? html`<p class="pp-fact"><${Icon} name="people" size=${16} />${plural(fallback, 'mutual friend')}</p>` : null;
  if (!ids || !ids.length) return null;
  const people = ids.map((x) => S.users[x]).filter(Boolean);
  return html`<div class="pp-mutual">
    <button class="pp-fact pp-mutual-toggle" aria-expanded=${String(open)} aria-controls="pp-mutual-list" onClick=${() => setOpen(!open)}>
      <${Icon} name="people" size=${16} />${plural(ids.length, 'mutual friend')}<span class=${`pp-mutual-chev${open ? ' open' : ''}`} aria-hidden="true"><${Icon} name="chev-d" size=${14} /></span>
    </button>
    ${open && html`<ul class="pp-mutual-list" id="pp-mutual-list" aria-label="Mutual friends">
      ${people.map((p) => html`<li key=${p.id}><button class="pp-mutual-person" onClick=${() => go({ type: 'person', id: p.id })}>
        <${Avatar} user=${p} size=${32} presence /><span class="trunc">${p.name}</span></button></li>`)}
    </ul>`}
  </div>`;
}

export function PersonPage({ id }) {
  const u = S.users[id];
  if (!u) {
    return html`<section class="main view" aria-label="Profile">
      <header class="bar"><${Back} /><h1 class="bar-title">Profile</h1></header>
      <div class="view-body"><${Empty} icon="user" title="This profile isn’t open to you" text="You can see people you share a house with, your friends, and people who sent you a request." /></div>
    </section>`;
  }
  const mine = id === S.me;
  const d = doingOf(u);
  const common = mutualHouses(S, id);
  const state = friendState(S, id);
  const mutual = mine ? null : mutualFriendsOf(id);
  const since = memberSince(u);
  const first = u.name.split(' ')[0];
  const now = Date.now();
  const going = upcomingEvents(S, now).filter((e) => (e.going || []).includes(id) && eventState(e, now) !== 'past').slice(0, 3);
  const acts = html`<div class="pp-acts">
    ${mine
      ? html`<button class="btn" onClick=${editProfile}><${Icon} name="edit" size=${16} />Edit profile</button>`
      : html`
        ${canMessage(id) && html`<button class="btn primary" onClick=${() => startDm([id])}><${Icon} name="room" size=${16} />Message</button>`}
        <${FriendButton} id=${id} primary=${!canMessage(id)} />
        <${FavButton} id=${id} />`}
  </div>`;
  return html`<section class="main view person-view" aria-label=${`${u.name}, profile`}>
    <header class="bar">
      <${Back} />
      <h1 class="bar-title trunc">${mine ? 'Your profile' : u.name}</h1>
      <div class="bar-end">
        ${!mine && html`<button class="ib" aria-label=${`More for ${u.name}`} aria-haspopup="menu" data-tip="More"
          onClick=${(e) => friendMenu(id, e.currentTarget.getBoundingClientRect(), { profile: false })}><${Icon} name="more" /></button>`}
      </div>
    </header>
    <div class="view-body">
      <article class=${`pp${profileColours(u).cls}`} style=${`--hue:${hueOf(u.hue)}${profileColours(u).style}`}>
        <${ProfileBanner} u=${u} big />
        <div class="pp-head">
          <div class="pp-av"><${Avatar} user=${u} presence size=${64} speaking=${!!S.speaking[id]} /></div>
          <div class="pp-id">
            <h2 class="pp-name" ...${nameAttrs(u)}>${u.name}</h2>
            <div class="pp-handle"><span class="secret">@${atName(u)}</span><${Pronouns} u=${u} />${since ? html`<span class="pp-since"> · here since ${since}</span>` : ''}</div>
          </div>
          ${!S.ui.phone && acts}
        </div>
        <div class="pp-now">
          <${Pres} user=${u} inline />
          <span class=${`pp-now-text${d.live ? ' is-live' : ''}`}>${nowLine(u, d)}</span>
          ${d.live && !mine && html`<button class="btn quiet pp-join" onClick=${() => openConv(d.live)}><${Icon} name="voice" size=${16} />Join them</button>`}
        </div>
        ${state === 'incoming' && html`<p class="pp-note" role="status"><b>${first}</b> ${STATE_NOTE.incoming}.</p>`}
        ${state === 'outgoing' && html`<p class="pp-note" role="status">${STATE_NOTE.outgoing}</p>`}
        ${S.ui.phone && acts}

        <div class="pp-grid">
          <div class="pp-main">
            <section class="pp-sect" aria-labelledby="pp-about">
              <h3 id="pp-about">About</h3>
              ${u.about
                ? html`<div class="pp-about acc-about"><${Rich} text=${u.about} /></div>`
                : html`<p class="pp-empty">${mine ? 'Nothing here yet. A line or two helps people know who they’re talking to.' : `${first} hasn’t written anything yet.`}</p>`}
            </section>
            ${!mine && !u.deleted && html`<section class="pp-sect"><${PrivateNote} id=${id} /></section>`}
            ${u.remote && html`<${PeerCode} id=${id} />`}
            ${(u.interests?.length > 0 || mine) && html`<section class="pp-sect" aria-labelledby="pp-int">
              <h3 id="pp-int">Into</h3>
              ${u.interests?.length ? html`<${Interests} list=${u.interests} />` : html`<p class="pp-empty">Add a few interests so people with the same ones can find you.</p>`}
            </section>`}
            ${u.links?.length > 0 && html`<section class="pp-sect" aria-labelledby="pp-links">
              <h3 id="pp-links">Elsewhere</h3>
              <${Links} list=${u.links} />
            </section>`}
            ${going.length > 0 && html`<section class="pp-sect" aria-labelledby="pp-going">
              <h3 id="pp-going">${mine ? 'You’re going' : `${first} is going`}</h3>
              <div class="ev-rows">${going.map((e) => html`<${EventRow} key=${e.id} ev=${e} compact />`)}</div>
            </section>`}
          </div>
          <aside class="pp-side">
            <section class="pp-sect" aria-labelledby="pp-common">
              <h3 id="pp-common">${mine ? 'Your places' : 'Places you share'} <span class="count num">${common.length || ''}</span></h3>
              ${common.length
                ? html`<${PlaceTiles} ids=${common} who=${id} />`
                : html`<p class="pp-empty">${mine ? 'You’re not in a community yet.' : 'No places in common yet.'}</p>`}
              ${!mine && !u.deleted && html`<${MutualFriends} id=${id} fallback=${mutual} />`}
            </section>

          </aside>
        </div>
      </article>
    </div>
  </section>`;
}
