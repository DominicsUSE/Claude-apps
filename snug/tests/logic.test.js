// The rules that decide what people see: message parsing, grouping, what
// counts as unread or "needs you", search, and permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, isJumbo, plain, mentions } from '../js/lib/format.js';
import { buildItems } from '../js/lib/group.js';
import { needsMe, forMe, attention, levelOf, levelsFor, unreadOf, totalNeeds } from '../js/lib/attention.js';
import { parseQuery, runSearch, setOp } from '../js/lib/search.js';
import { can, canPost } from '../js/lib/perms.js';
import { seed } from '../js/seed.js';
import { MIN, DAY, HUES, hueOf } from '../js/lib/util.js';
import {
  TOPICS, friendsOnline, friendsList, friendRequests, activeConversations, liveVoice, upcomingEvents, eventState,
  mutualHouses, greeting, cleanInterests, safeLink,
} from '../js/lib/social.js';

const NOW = new Date(2026, 10, 12, 15, 0).getTime();
const fresh = () => seed(NOW);

test('parse: markup becomes tokens, never HTML', () => {
  assert.deepEqual(parse('<b>hi</b>'), [{ t: 'text', v: '<b>hi</b>' }]);
  assert.deepEqual(parse('**bold** and `code`'), [
    { t: 'b', c: [{ t: 'text', v: 'bold' }] }, { t: 'text', v: ' and ' }, { t: 'code', v: 'code' },
  ]);
  assert.deepEqual(parse('ask @Ines.'), [{ t: 'text', v: 'ask ' }, { t: 'at', v: 'ines' }, { t: 'text', v: '.' }]);
  assert.equal(parse('see https://example.org/a.')[1].v, 'https://example.org/a');
  assert.equal(parse('mail me@example.org').some((t) => t.t === 'at'), false);
  assert.equal(parse('```js\nlet a = 1;\n```')[0].t, 'pre');
  assert.equal(parse('2 * 3 * 4').some((t) => t.t === 'i'), false);
});

test('jumbo emoji and plain previews', () => {
  assert.equal(isJumbo('🎉'), true);
  assert.equal(isJumbo('👍🏽 🔥'), true);
  assert.equal(isJumbo('ok 🎉'), false);
  assert.equal(isJumbo('🎉🎉🎉🎉'), false);
  assert.equal(plain('**Holiday** hours\nnext `week`'), 'Holiday hours next week');
  assert.equal(mentions('hey @robin!', 'robin'), true);
  assert.equal(mentions('hey @robinson', 'robin'), false);
});

test('grouping: same author within five minutes groups; days, replies and the new line break it', () => {
  const t0 = new Date(2026, 10, 11, 23, 58).getTime();
  const list = [
    { id: 'a', author: 'x', ts: t0, text: '1' },
    { id: 'b', author: 'x', ts: t0 + MIN, text: '2' },
    { id: 'c', author: 'x', ts: t0 + 3 * MIN, text: '3' },
    { id: 'd', author: 'x', ts: t0 + 4 * MIN, text: '4', replyTo: 'a' },
    { id: 'e', author: 'x', ts: t0 + 15 * MIN, text: '5' },
    { id: 'f', author: 'y', ts: t0 + 16 * MIN, text: '6' },
  ];
  const items = buildItems(list, { marker: t0 + 16 * MIN, me: 'x' });
  const shape = items.map((i) => (i.type === 'msg' ? `${i.m.id}${i.grouped ? '+' : ''}` : i.type));
  assert.deepEqual(shape, ['day', 'a', 'b+', 'day', 'c', 'd', 'e', 'new', 'f']);
});

test('the new line never sits above your own message', () => {
  const t0 = NOW - 10 * MIN;
  const items = buildItems([{ id: 'a', author: 'me', ts: t0 }, { id: 'b', author: 'y', ts: t0 + MIN }], { marker: t0, me: 'me' });
  assert.deepEqual(items.map((i) => i.type), ['day', 'msg', 'new', 'msg']);
});

test('needs me: direct messages, mentions, replies to me, followed threads', () => {
  const S = fresh();
  const m = (text, extra = {}) => ({ id: 'z', author: 'malik', ts: NOW, text, ...extra });
  assert.equal(needsMe(S, 'd_ines', m('hi')), true);
  assert.equal(needsMe(S, 'k_floor', m('hi all')), false);
  assert.equal(needsMe(S, 'k_floor', m('@robin look')), true);
  const mine = S.msgs.k_glaze.find((x) => x.author === 'robin');
  assert.equal(needsMe(S, 'k_glaze', m('agreed', { replyTo: mine.id })), true);
  assert.equal(needsMe(S, 't:m_layer', m('more')), true);
  assert.equal(needsMe(S, 't:m_buff', m('more')), false);
  assert.equal(needsMe(S, 'd_ines', { ...m('x'), author: 'robin' }), false);
});

test('what is highlighted as for me is what counts as for me', () => {
  const S = fresh();
  const m = (text, extra = {}) => ({ id: 'z', author: 'malik', ts: NOW, text, ...extra });
  const mine = S.msgs.k_glaze.find((x) => x.author === 'robin');
  const reply = m('agreed', { replyTo: mine.id });
  assert.equal(forMe(S, 'k_glaze', reply), true);
  assert.equal(needsMe(S, 'k_glaze', reply), forMe(S, 'k_glaze', reply));
  assert.equal(forMe(S, 'k_floor', m('@robin look')), true);
  assert.equal(forMe(S, 'k_floor', m('hi all')), false);
  assert.equal(forMe(S, 'k_floor', { ...m('@robin me'), author: 'robin' }), false);
});

test('a group can narrow to what needs me; a one-to-one conversation cannot', () => {
  const S = fresh();
  const m = (text) => ({ id: 'z', author: 'malik', ts: NOW, text });
  assert.deepEqual(levelsFor(S, 'dm', 'd_ines'), ['all', 'muted']);
  assert.deepEqual(levelsFor(S, 'dm', 'g_sat'), ['all', 'mentions', 'muted']);
  assert.equal(needsMe(S, 'g_sat', m('who is in?')), true);
  S.dms.g_sat.notify = 'mentions';
  assert.equal(needsMe(S, 'g_sat', m('who is in?')), false);
  assert.equal(needsMe(S, 'g_sat', m('@robin are you in?')), true);
  S.dms.d_ines.notify = 'mentions';
  assert.equal(needsMe(S, 'd_ines', m('hi')), true);
});

test('chosen colours stay clear of the colours that carry meaning', () => {
  // OKLCH hues of the semantic colours, dark and light themes: error #E05A5A 23 /
  // #C93838 25, brand coral #F05A47 30, amber #A86F0D 73 / #E8B65A 81,
  // mint #1F8F6E 168 / #58C7A5 170.
  const reserved = [23, 25, 30, 73, 81, 168, 170];
  const gap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (const [h, name] of HUES) {
    assert.ok(name && !/^Hue/.test(name));
    for (const r of reserved) assert.ok(gap(h, r) >= 25, `${name} (${h}) is too close to ${r}`);
  }
  for (let h = 0; h < 360; h += 5) assert.ok(HUES.some(([v]) => v === hueOf(h)));
  assert.equal(hueOf(165), 142);
  assert.equal(hueOf(30), 350, 'an old coral choice shows as pink, never as the brand');
  assert.equal(hueOf(null), null);
});

test('notification levels: everything, only what needs me, nothing', () => {
  const S = fresh();
  assert.deepEqual(attention(S, 'k_floor'), { soft: true, needs: 1 });
  S.rooms.k_floor.notify = 'mentions';
  assert.deepEqual(attention(S, 'k_floor'), { soft: false, needs: 1 });
  S.rooms.k_floor.notify = 'muted';
  assert.deepEqual(attention(S, 'k_floor'), { soft: false, needs: 0 });
  S.rooms.k_floor.notify = null;
  S.houses.kiln.notify = 'muted';
  assert.equal(levelOf(S, 'k_floor'), 'muted');
  assert.equal(levelOf(S, 't:m_layer'), 'muted');
});

test('followed threads count towards their room; reading clears them', () => {
  const S = fresh();
  assert.equal(attention(S, 'k_glaze').needs, unreadOf(S, 'k_glaze').needs + 1);
  S.read['t:m_layer'] = NOW;
  assert.equal(attention(S, 'k_glaze').needs, unreadOf(S, 'k_glaze').needs);
  const before = totalNeeds(S);
  S.read.d_ines = NOW;
  assert.equal(totalNeeds(S), before - 1);
});

test('search: operators, accents and filters', () => {
  const S = fresh();
  const p = parseQuery('from:sunniva in:"glaze lab" Kaolin has:image is:saved');
  assert.deepEqual(p, { terms: ['kaolin'], from: ['sunniva'], in: ['glaze lab'], has: ['image'], saved: true });
  assert.ok(runSearch(S, parseQuery('kaolin')).length >= 3);
  assert.ok(runSearch(S, parseQuery('from:sunniva kaolin')).every((h) => h.m.author === 'sunniva'));
  assert.equal(runSearch(S, parseQuery('has:image in:"glaze lab"')).length, 1);
  assert.equal(runSearch(S, parseQuery('wojcik')).length, 0);
  assert.ok(runSearch(S, parseQuery('cafe')).length > 0, 'café matches cafe');
  assert.equal(runSearch(S, parseQuery('debounce')).length, 0, 'houses you have not joined stay out of search');
  assert.equal(setOp('kaolin from:ines', 'from', 'sunniva'), 'kaolin from:sunniva');
  assert.equal(setOp('in:"glaze lab" x', 'in', null), 'x');
  assert.equal(setOp('', 'in', 'ride plans'), 'in:"ride plans"');
});

test('permissions: notice rooms are read-only without the right role', () => {
  const S = fresh();
  assert.equal(canPost(S, 'k_desk').ok, true, 'Robin is a studio lead');
  S.houses.kiln.members.robin = 'member';
  const gate = canPost(S, 'k_desk');
  assert.equal(gate.ok, false);
  assert.match(gate.why, /Studio lead and Technician/);
  assert.equal(canPost(S, 'k_floor').ok, true);
  assert.equal(can(S, 'kiln', 'invite'), true);
  assert.equal(can(S, 'kiln', 'moderate'), false);
  assert.equal(can(S, 'kiln', 'moderate', 'ines'), true, 'the owner role can do everything');
  assert.equal(canPost(S, 'd_ines').ok, true);
});

test('sample data is internally consistent', () => {
  const S = fresh();
  for (const [id, h] of Object.entries(S.houses)) {
    for (const g of h.groups) for (const r of g.rooms) assert.equal(S.rooms[r].house, id, r);
    for (const r of h.starter) assert.ok(h.groups.some((g) => g.rooms.includes(r)), r);
    for (const [u, role] of Object.entries(h.members)) { assert.ok(S.users[u], u); assert.ok(h.roles.some((x) => x.id === role), role); }
  }
  for (const [conv, list] of Object.entries(S.msgs)) {
    for (const m of list) {
      assert.ok(S.users[m.author], `${conv}: ${m.author}`);
      if (m.replyTo) assert.ok(list.some((x) => x.id === m.replyTo), m.replyTo);
      assert.ok(m.ts <= NOW && m.ts > NOW - 40 * DAY, `${conv}: ${m.id}`);
    }
  }
  for (const s of S.saved) assert.ok(S.msgs[s.conv].some((m) => m.id === s.id), s.id);
  for (const h of Object.values(S.houses)) assert.ok(h.topic === null || TOPICS.includes(h.topic), h.id);
  for (const f of S.friendships) { assert.ok(S.users[f.a] && S.users[f.b] && f.a !== f.b, `${f.a}-${f.b}`); assert.ok(['friends', 'pending'].includes(f.state)); }
  for (const id of Object.keys(S.friends)) assert.ok(S.users[id], id);
  for (const e of Object.values(S.events)) {
    assert.ok(S.houses[e.house], e.id);
    if (e.room) assert.equal(S.rooms[e.room].house, e.house, e.id);
    for (const u of e.going) assert.ok(S.houses[e.house].members[u], `${e.id}: ${u}`);
  }
  for (const u of Object.values(S.users)) {
    assert.ok(u.interests.length <= 8 && u.links.length <= 3, u.id);
    for (const l of u.links) assert.equal(safeLink(l.url), l.url, l.url);
  }
});

test('sample data looks alive: friends both ways, public houses, events now, tonight and next week', () => {
  const S = fresh();
  assert.ok(Object.values(S.friends).some((f) => f.state === 'incoming'));
  assert.ok(Object.values(S.friends).some((f) => f.state === 'outgoing'));
  const discoverable = Object.values(S.houses).filter((h) => h.public && !h.members[S.me]);
  assert.equal(discoverable.length, 2);
  assert.ok(discoverable.some((h) => Object.values(S.rooms).some((r) => r.house === h.id && (S.voice[r.id] || []).length)));
  assert.ok(Object.values(S.houses).every((h) => h.topic));
  const mine = Object.values(S.events).filter((e) => S.houses[e.house].joined);
  assert.equal(mine.length, 3);
  assert.deepEqual(mine.map((e) => eventState(e, NOW)).sort(), ['later', 'later', 'now']);
  assert.ok(mine.some((e) => e.starts > NOW && e.starts - NOW < DAY), 'one tonight');
  assert.ok(mine.some((e) => e.starts - NOW > 6 * DAY), 'one next week');
});

test('friends: online favourites first, requests by direction', () => {
  const S = fresh();
  // ines (favourite, open), jonas (favourite, open), malik (open), mira (open), priya (around)
  assert.deepEqual(friendsOnline(S), ['ines', 'jonas', 'malik', 'mira', 'priya']);
  S.users.jonas.presence = 'offline';
  assert.equal(friendsOnline(S).includes('jonas'), false);
  assert.equal(friendsList(S).at(-1), 'jonas', 'offline friends come last, even favourites');
  S.friends.priya.favorite = true;
  assert.equal(friendsOnline(S)[1], 'priya', 'favourites come before people who are more available');
  assert.deepEqual(friendRequests(S, 'incoming'), ['bex']);
  assert.deepEqual(friendRequests(S, 'outgoing'), ['yuki']);
  assert.equal(friendsOnline({ friends: {}, users: {} }).length, 0);
});

test('happening now: who is talking, typing and in voice, liveliest first', () => {
  const S = fresh();
  const live = activeConversations(S, NOW);
  // Dara and Tomasz wrote in the firing schedule 12 and 10 minutes ago; Robin last read it four hours ago.
  const firing = live.find((x) => x.conv === 'k_firing');
  assert.deepEqual(firing, { conv: 'k_firing', talking: 2, typing: 0, inVoice: 0, newCount: 4, last: NOW - 10 * MIN });
  assert.equal(live.some((x) => x.conv === 'k_floor'), false, 'the floor went quiet 19 minutes ago');
  assert.equal(live[0].conv, 'k_wheel', 'three people in voice beats two writing');
  assert.equal(live.some((x) => x.conv === 'l_live' || x.conv === 's_pair'), false, 'houses you have not joined stay out');
  S.typing = { d_ines: ['ines'] };
  assert.equal(activeConversations(S, NOW).find((x) => x.conv === 'd_ines').typing, 1);
  S.typing.d_ines = ['robin'];
  assert.equal(activeConversations(S, NOW).some((x) => x.conv === 'd_ines'), false, 'your own typing is not activity');
  assert.deepEqual(liveVoice(S).map((v) => v.conv), ['k_wheel', 'r_coffee']);
  assert.deepEqual(liveVoice(S)[0].people, ['malik', 'priya', 'dara']);
});

test('events: state and what is coming up', () => {
  const e = { starts: NOW, ends: null };
  assert.equal(eventState(e, NOW - 2 * 60 * MIN), 'later');
  assert.equal(eventState(e, NOW - 59 * MIN), 'soon');
  assert.equal(eventState(e, NOW), 'now');
  assert.equal(eventState(e, NOW + 119 * MIN), 'now', 'no end time means two hours');
  assert.equal(eventState(e, NOW + 120 * MIN), 'past');
  assert.equal(eventState({ starts: NOW, ends: NOW + 10 * MIN }, NOW + 11 * MIN), 'past');
  const S = fresh();
  assert.deepEqual(upcomingEvents(S, NOW).map((x) => x.id), ['e_open', 'e_swap', 'e_ride']);
  assert.deepEqual(upcomingEvents(S, NOW, { house: 'riders' }).map((x) => x.id), ['e_swap', 'e_ride']);
  assert.deepEqual(upcomingEvents(S, NOW + 15 * DAY).map((x) => x.id), [], 'past events drop off');
  assert.deepEqual(upcomingEvents(S, NOW - 10 * DAY).map((x) => x.id), ['e_open', 'e_swap'], 'more than 14 days away is not upcoming yet');
});

test('mutual houses, greetings, interests and links', () => {
  const S = fresh();
  assert.deepEqual(mutualHouses(S, 'malik'), ['kiln']);
  assert.deepEqual(mutualHouses(S, 'bex'), ['riders'], 'a house you are only invited to does not count');
  assert.deepEqual(mutualHouses(S, 'mira'), []);
  assert.equal(greeting(new Date(2026, 0, 1, 7).getTime()), 'Good morning');
  assert.equal(greeting(new Date(2026, 0, 1, 12).getTime()), 'Good afternoon');
  assert.equal(greeting(new Date(2026, 0, 1, 19).getTime()), 'Good evening');
  assert.equal(greeting(new Date(2026, 0, 1, 2).getTime()), 'Good evening');
  assert.deepEqual(cleanInterests([' Jazz ', 'jazz', 'Film  & TV', '', 3]), ['Jazz', 'Film & TV']);
  assert.equal(safeLink('https://example.org/a'), 'https://example.org/a');
  assert.equal(safeLink('http://example.org'), null);
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('https://user:pw@example.org'), null);
  assert.equal(safeLink('https://localhost'), null);
  assert.equal(TOPICS.length, 10);
});
