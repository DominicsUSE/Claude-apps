// Getting started (0.15): what a brand-new account sees on Home. A welcome
// that says what Snug is in a sentence, the two ways in (start a house, or join
// one with an invite), and five plain steps, each ticked off by what you have
// actually done: 1 your account, 2 your username, 3 a house, 4 friends invited,
// 5 a first message. The steps can be put away; that is kept on this device.
import { html } from '../../vendor/preact-htm.js';
import { S, me, emit, openModal, openLayer, openConv, go } from '../store.js';
import { roomIds } from '../lib/attention.js';
import { can } from '../lib/perms.js';
import { friendsList } from '../lib/social.js';
import { newcomerSees } from '../lib/onboarding.js';
import { Icon } from '../ui/icons.js';
import { Nook } from '../ui/brand.js';
import { Button, cx } from '../ui/kit.js';
import { AddHouse, Invite } from './modals.js';
import { Settings } from './settings.js';
import { t } from '../lib/i18n.js';

const first = (name) => (name || '').split(' ')[0];

// Where a first message would go: the first room you can write in, in the
// first house in your rail.
function firstRoom() {
  for (const h of S.houseOrder) {
    const house = S.houses[h];
    const id = roomIds(S, h).find((r) => S.rooms[r] && S.rooms[r].kind === 'text' && newcomerSees(house, r, S.rooms[r].kind));
    if (id) return id;
  }
  return null;
}
const wroteSomething = () => Object.values(S.msgs).some((list) => list.some((m) => m.author === S.me && !m.sys));
const invitable = () => S.houseOrder.find((h) => can(S, h, 'invite')) || null;

// The five steps and whether each is done. Some facts (inviting, writing)
// are remembered once seen, since the messages that prove them may not be loaded.
export function steps() {
  const p = S.prefs;
  if (!p.onbWrote && wroteSomething()) p.onbWrote = true;
  const house = S.houseOrder.length > 0;
  return [
    { id: 'account', done: true },
    { id: 'username', done: !!me()?.handle },
    { id: 'house', done: house },
    { id: 'invite', done: !!p.onbInvited || friendsList(S).length > 0 },
    { id: 'chat', done: !!p.onbWrote },
  ];
}
export const guideWanted = () => !S.prefs.onbHidden && steps().some((s) => !s.done);
export function hideGuide() { S.prefs.onbHidden = true; emit(); }

const startHouse = () => openModal(AddHouse, { mode: 'start' });
const joinHouse = () => openModal(AddHouse, { mode: 'join' });
function invite() {
  const h = invitable();
  S.prefs.onbInvited = true;
  if (h) openModal(Invite, { house: h }); else go({ type: 'friends', tab: 'add' });
}

// What each step says, and the way forward while it is the next one.
function stepCopy(id) {
  const u = me();
  switch (id) {
    case 'account': return { title: t('start.account'), text: t('start.accountText') };
    case 'username': return {
      title: t('start.username'), text: t('start.usernameText', { handle: u?.handle || '' }),
      act: html`<${Button} size="sm" variant="ghost" onClick=${() => openLayer({ C: Settings, props: { page: 'profile' } })}>${t('start.change')}<//>`,
    };
    case 'house': return {
      title: t('start.house'), text: t('start.houseText'),
      act: html`<${Button} size="sm" variant="primary" icon="plus" onClick=${startHouse}>${t('start.startHouse')}<//><${Button} size="sm" icon="link" onClick=${joinHouse}>${t('start.joinHouse')}<//>`,
    };
    case 'invite': return {
      title: t('start.invite'), text: invitable() ? t('start.inviteText') : t('start.inviteFriendText'),
      act: html`<${Button} size="sm" variant="primary" icon="user-plus" onClick=${invite}>${invitable() ? t('start.inviteGo') : t('start.addFriend')}<//>`,
    };
    default: {
      const room = firstRoom();
      return {
        title: t('start.chat'), text: room ? t('start.chatText', { room: S.rooms[room].name }) : t('start.chatNoRoom'),
        act: room ? html`<${Button} size="sm" variant="primary" icon="room" onClick=${() => openConv(room)}>${t('start.chatGo', { room: S.rooms[room].name })}<//>` : null,
      };
    }
  }
}

// The steps, as a numbered list. The next step to do shows its buttons;
// `hold` names steps whose buttons are already on screen (the welcome's).
export function Steps({ hold = [] }) {
  const list = steps();
  const done = list.filter((s) => s.done).length;
  const next = list.find((s) => !s.done)?.id;
  return html`<section class="onb-steps" aria-labelledby="onb-steps-title">
    <div class="onb-steps-head">
      <h3 id="onb-steps-title">${t('start.stepsTitle')}</h3>
      <span class="onb-count num">${t('start.count', { done, total: list.length })}</span>
      <button class="btn ghost sm onb-hide" onClick=${hideGuide}>${t('start.hide')}</button>
    </div>
    <div class="onb-bar" role="progressbar" aria-label=${t('start.stepsTitle')} aria-valuemin="0" aria-valuemax=${list.length} aria-valuenow=${done}>
      <span style=${`transform:scaleX(${done / list.length})`}></span>
    </div>
    <ol class="onb-list">
      ${list.map((s, i) => {
        const c = stepCopy(s.id);
        const isNext = s.id === next;
        return html`<li key=${s.id} class=${cx('onb-step', s.done && 'is-done', isNext && 'is-next')} aria-current=${isNext ? 'step' : undefined}>
          <span class="onb-mark" aria-hidden="true">${s.done ? html`<${Icon} name="check" size=${14} />` : i + 1}</span>
          <span class="onb-body">
            <span class="onb-title">${c.title}<span class="sr">${s.done ? `, ${t('start.doneWord')}` : ''}</span></span>
            ${(isNext || s.id === 'username') && html`<span class="onb-text">${c.text}</span>`}
            ${isNext && c.act && !hold.includes(s.id) && html`<span class="onb-acts">${c.act}</span>`}
          </span>
        </li>`;
      })}
    </ol>
    <p class="onb-privacy"><a class="linkish" href="/privacy" onClick=${(e) => { e.preventDefault(); openLayer({ C: Settings, props: { page: 'guide' } }); }}>${t('start.privacy')}</a></p>
  </section>`;
}

// Home for someone with no house and no friends yet.
export function Welcome() {
  const u = me();
  return html`<div class="onb">
    <div class="onb-hero">
      <${Nook} size=${48} />
      <h2 class="onb-title-main">${t('start.welcome', { name: first(u?.name) })}</h2>
      <p class="onb-lead">${t('start.lead')}</p>
      <div class="onb-hero-acts">
        <${Button} variant="primary" size="lg" icon="plus" onClick=${startHouse}>${t('start.startHouse')}<//>
        <${Button} size="lg" icon="link" onClick=${joinHouse}>${t('start.joinHouse')}<//>
      </div>
      <ul class="onb-explain" role="list">
        <li><span class="onb-explain-ic" aria-hidden="true"><${Icon} name="house" size=${16} /></span><span><b>${t('start.whatHouse')}</b> ${t('start.whatHouseText')}</span></li>
        <li><span class="onb-explain-ic" aria-hidden="true"><${Icon} name="hash" size=${16} /></span><span><b>${t('start.whatRooms')}</b> ${t('start.whatRoomsText')}</span></li>
        <li><span class="onb-explain-ic" aria-hidden="true"><${Icon} name="dm" size=${16} /></span><span><b>${t('start.whatDms')}</b> ${t('start.whatDmsText')}</span></li>
      </ul>
      <p class="onb-or">${t('start.orBefore')} <button class="linkish" onClick=${() => go({ type: 'discover', section: 'communities' })}>${t('start.orLink')}</button>.</p>
    </div>
    ${!S.prefs.onbHidden && html`<${Steps} hold=${['house']} />`}
  </div>`;
}
