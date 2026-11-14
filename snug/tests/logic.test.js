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
import { MIN, DAY, HUES, RETIRED_HUES, hueOf } from '../js/lib/util.js';
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

test('grouping: same author within seven minutes groups; days, replies and the new line break it', () => {
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
  // The window: six minutes apart still groups, seven does not.
  const t1 = new Date(2026, 10, 12, 10, 0).getTime();
  const gap = buildItems([
    { id: 'p', author: 'x', ts: t1, text: '1' },
    { id: 'q', author: 'x', ts: t1 + 6 * MIN, text: '2' },
    { id: 'r', author: 'x', ts: t1 + 13 * MIN, text: '3' },
  ]).map((i) => (i.type === 'msg' ? `${i.m.id}${i.grouped ? '+' : ''}` : i.type));
  assert.deepEqual(gap, ['day', 'p', 'q+', 'r']);
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

test('calls: a missed call needs me, even in a quiet group; a call I took part in or declined is history', () => {
  const S = fresh();
  const rec = (author, call) => ({ id: `m_call${Math.random().toString(36).slice(2, 10)}`, author, ts: NOW + 1, text: 'Missed call', call });
  const missed = rec('ines', { id: 'call_a', by: 'ines', outcome: 'missed', joined: ['ines'], declined: [] });
  const took = rec('ines', { id: 'call_b', by: 'ines', outcome: 'answered', dur: 4000, joined: ['ines', 'robin'], declined: [] });
  const declined = rec('ines', { id: 'call_c', by: 'ines', outcome: 'declined', joined: ['ines'], declined: ['robin'] });
  const mine = rec('robin', { id: 'call_d', by: 'robin', outcome: 'missed', joined: ['robin'], declined: [] });
  assert.equal(needsMe(S, 'd_ines', missed), true);
  assert.equal(forMe(S, 'd_ines', missed), true, 'shown as for me too');
  for (const m of [took, declined, mine]) assert.equal(needsMe(S, 'd_ines', m), false);
  // In a group set to "Only what needs me", a group call I missed still does.
  S.dms.g_sat.notify = 'mentions';
  const groupMissed = rec('malik', { id: 'call_e', by: 'malik', outcome: 'answered', dur: 9000, joined: ['malik', 'ines'], declined: [] });
  assert.equal(needsMe(S, 'g_sat', groupMissed), true);
  // Unread counts only the ones I missed.
  S.read.d_ines = NOW;
  S.msgs.d_ines = [...S.msgs.d_ines, took, declined];
  assert.equal(unreadOf(S, 'd_ines').count, 0);
  S.msgs.d_ines.push(missed);
  assert.deepEqual([unreadOf(S, 'd_ines').count, unreadOf(S, 'd_ines').needs], [1, 1]);
  // A call record never groups with the messages around it.
  const items = buildItems([{ id: 'a', author: 'ines', ts: NOW, text: 'hi' }, missed, { id: 'b', author: 'ines', ts: NOW + 2, text: 'call me' }]);
  assert.deepEqual(items.filter((i) => i.type === 'msg').map((i) => i.grouped), [false, false, false]);
});

test('chosen colours stay clear of the colours that carry meaning', () => {
  // OKLCH hues of the semantic colours, dark and light themes: error #E05A5A 23 /
  // #C93838 25, amber #A86F0D 73 / #E8B65A 81, mint #1F8F6E 168 / #58C7A5 170,
  // brand violet #763FF4 289 / mark #8B5CF6 293 / #996FF7 295 / ink #B191F9 297.
  const reserved = [23, 25, 73, 81, 168, 170, 289, 293, 295, 297];
  const gap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (const [h, name] of HUES) {
    assert.ok(name && !/^Hue/.test(name));
    for (const r of reserved) assert.ok(gap(h, r) >= 25, `${name} (${h}) is too close to ${r}`);
  }
  for (let h = 0; h < 360; h += 5) assert.ok(HUES.some(([v]) => v === hueOf(h)));
  assert.equal(hueOf(165), 142);
  assert.equal(hueOf(30), 350, 'a coral hue shows as pink');
  assert.equal(hueOf(318), 335, 'a stored Plum (retired: too near the violet brand) shows as clay rose');
  assert.ok(!HUES.some(([v]) => v === 318) && RETIRED_HUES.includes(318));
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

// --- safety rules (js/lib/safety.js) -------------------------------------------
test('safety: the word filter matches whole words, any case or accent, with * for prefixes; links when blocked', async () => {
  const { filterHit, cleanWord } = await import('../js/lib/safety.js');
  const cfg = { words: ['badword', 'scam*', 'two words'], links: false };
  assert.deepEqual(filterHit('what a BÁDWORD!', cfg), { word: 'badword' });
  assert.equal(filterHit('badwords and abadword', cfg), null, 'only whole words');
  assert.deepEqual(filterHit('such scammers', cfg), { word: 'scam*' });
  assert.deepEqual(filterHit('it has two   words in it', cfg), { word: 'two words' });
  assert.equal(filterHit('see https://example.org', cfg), null);
  assert.deepEqual(filterHit('see https://example.org', { ...cfg, links: true }), { link: true });
  assert.deepEqual(filterHit('go to shop.example.com now', { words: [], links: true }), { link: true });
  assert.equal(filterHit('a sentence. Another one', { words: [], links: true }), null);
  assert.equal(cleanWord('  Hello  World '), 'hello world');
  assert.equal(cleanWord('<script>'), '');
  assert.equal(cleanWord('x'.repeat(41)), '');
  assert.equal(cleanWord('free*'), 'free*');
});

test('safety: role hierarchy, slowmode waits and durations', async () => {
  const { outranks, slowWait, left, spell } = await import('../js/lib/safety.js');
  const roles = [{ id: 'own' }, { id: 'mod' }, { id: 'mem' }];
  const members = { o: 'own', o2: 'own', m: 'mod', m2: 'mod', p: 'mem' };
  assert.equal(outranks(roles, members, 'm', 'p'), true);
  assert.equal(outranks(roles, members, 'm', 'm2'), false, 'equal roles');
  assert.equal(outranks(roles, members, 'p', 'm'), false, 'lower roles');
  assert.equal(outranks(roles, members, 'm', 'o'), false, 'never the owner');
  assert.equal(outranks(roles, members, 'o', 'o2'), false, 'not even another owner');
  assert.equal(outranks(roles, members, 'o', 'm'), true);
  assert.equal(outranks(roles, members, 'm', 'm'), false, 'not yourself');
  assert.equal(outranks(roles, members, 'm', 'gone'), true, 'someone no longer in the house');
  // Extra roles (places): a person acts with their best role.
  assert.equal(outranks(roles, members, 'p', 'm2', { p: ['mod'] }), false, 'an extra role equal to theirs');
  assert.equal(outranks(roles, { ...members, p2: 'mem' }, 'p', 'p2', { p: ['mod'] }), true, 'an extra role above theirs');
  assert.equal(outranks(roles, members, 'm', 'p', { p: ['mod'] }), false, 'the target’s extra role counts too');
  assert.equal(outranks(roles, members, 'm', 'p', { p: ['gone-role'] }), true, 'unknown extra roles are ignored');
  const { roleBelow } = await import('../js/lib/safety.js');
  assert.equal(roleBelow(roles, members, 'm', 'mem'), true);
  assert.equal(roleBelow(roles, members, 'm', 'mod'), false, 'not their own role');
  assert.equal(roleBelow(roles, members, 'm', 'own'), false);
  assert.equal(roleBelow(roles, members, 'p', 'mem', { p: ['mod'] }), true, 'with an extra role above it');
  assert.equal(roleBelow(roles, members, 'o', 'mod'), true, 'owners');
  assert.equal(roleBelow(roles, members, 'gone', 'mem'), false, 'not a member');
  assert.equal(slowWait(10, 1000, 5000), 6000);
  assert.equal(slowWait(10, 1000, 20000), 0);
  assert.equal(slowWait(0, 1000, 1000), 0);
  assert.equal(left(4200), '5s');
  assert.equal(left(125_000), '2m 5s');
  assert.equal(left(3_700_000), '1h 1m');
  assert.equal(spell(21600), '6 hours');
  assert.equal(spell(5), '5 seconds');
});
// --- end safety rules ------------------------------------------------------------

// --- messaging (js/lib/format.js, js/lib/highlight.js, js/lib/search.js) -------
test('messaging: rich markup becomes tokens: blocks, underline, spoilers, masked links, timestamps, escapes', async () => {
  const { highlight } = await import('../js/lib/highlight.js');
  const { fmtStamp } = await import('../js/lib/format.js');
  const t = parse('# Title\nplain line\n> quoted\n- one\n- two\n3. three\n-# small');
  assert.deepEqual(t.map((x) => x.t), ['h', 'text', 'quote', 'list', 'list', 'sub']);
  assert.equal(t[0].level, 1);
  assert.deepEqual([t[3].ordered, t[3].items.length, t[4].ordered, t[4].start], [false, 2, true, 3]);
  assert.deepEqual(parse('__u__ ||s||').map((x) => x.t), ['u', 'text', 'spoiler']);
  assert.deepEqual(parse('[docs](https://example.org/a)')[0], { t: 'mlink', v: 'https://example.org/a', c: [{ t: 'text', v: 'docs' }] });
  assert.equal(parse('[x](javascript:alert(1))').some((x) => x.t === 'mlink'), false, 'only http(s) can hide behind text');
  assert.deepEqual(parse('<t:1893456000:R>')[0], { t: 'ts', v: 1893456000, style: 'R' });
  assert.deepEqual(parse('<https://example.org/x>')[0], { t: 'link', v: 'https://example.org/x' });
  assert.deepEqual(parse('\\*not italic\\*'), [{ t: 'text', v: '*not italic*' }]);
  assert.deepEqual(parse('***both***')[0], { t: 'b', c: [{ t: 'i', c: [{ t: 'text', v: 'both' }] }] });
  assert.equal(parse('>not a quote')[0].t, 'text');
  assert.equal(plain('the ending is ||he was a ghost||'), 'the ending is [spoiler]');
  assert.equal(plain('# Hi\n> there [docs](https://e.org)'), 'Hi there docs');
  assert.equal(fmtStamp(0, 'R', 3_600_000, 'en'), '1 hour ago');
  assert.equal(fmtStamp(86_400, 'd', 0, 'en-GB').includes('1970'), true);
  // Highlighting is tokens too, and unknown languages stay plain.
  assert.deepEqual(highlight('const a = "x"; // c', 'js').map((x) => x.t), ['kw', 'text', 'str', 'text', 'com']);
  assert.deepEqual(highlight('<b class="x">', 'html').map((x) => x.t), ['kw', 'text', 'attr', 'text', 'str', 'kw']);
  assert.deepEqual(highlight('anything <b>', 'klingon'), [{ t: 'text', v: 'anything <b>' }]);
});

test('messaging: search filters for mentions, dates and pins', async () => {
  const { dateRange, inDates, isEmptyQuery } = await import('../js/lib/search.js');
  const p = parseQuery('mentions:@Ines during:2026-11 pinned:true has:poll kiln');
  assert.deepEqual({ m: p.mentions, d: p.during, pin: p.pinned, has: p.has, terms: p.terms }, { m: ['ines'], d: '2026-11', pin: true, has: ['poll'], terms: ['kiln'] });
  assert.equal(isEmptyQuery(parseQuery('before:2026-01-01')), false);
  assert.equal(parseQuery('before:yesterday').before, undefined, 'a date that does not parse is ignored');
  assert.deepEqual(dateRange('2026-11-12', 0), [Date.UTC(2026, 10, 12), Date.UTC(2026, 10, 13)]);
  assert.deepEqual(dateRange('2026-11-12', -60), [Date.UTC(2026, 10, 12) - 3_600_000, Date.UTC(2026, 10, 13) - 3_600_000], 'a day in the searcher’s time zone');
  assert.equal(dateRange('2026-02-30', 0), null);
  assert.equal(inDates({ before: '2026-11-12' }, Date.UTC(2026, 10, 11, 23), 0), true);
  assert.equal(inDates({ after: '2026-11-12' }, Date.UTC(2026, 10, 12, 23), 0), false);
  // Local search (offline) knows the same filters.
  const S = fresh();
  const hits = runSearch(S, parseQuery('mentions:robin'));
  assert.ok(hits.length > 0 && hits.every((h) => /@robin/i.test(h.m.text)));
});
// --- end messaging -----------------------------------------------------------------

// --- places, structure and community (js/lib/places.js) -----------------------------
test('places: the room resolver: defaults, overrides in order, managers and owners, voice kinds', async () => {
  const { resolveRoom } = await import('../js/lib/places.js');
  const P = (...p) => new Set(p);
  const all = { view: true, send: true, connect: true, speak: true, manage: true, video: true };
  const none = { view: false, send: false, connect: false, speak: false, manage: false, video: false };
  // Defaults come from the house-wide permissions.
  assert.deepEqual(resolveRoom({ housePerms: P('post'), kind: 'text', userId: 'u' }), { view: true, send: true, connect: false, speak: false, manage: false, video: false });
  assert.equal(resolveRoom({ housePerms: P(), kind: 'text', userId: 'u' }).send, false, 'no "post", no sending');
  assert.equal(resolveRoom({ housePerms: P('post'), kind: 'news', userId: 'u' }).send, false, 'notice rooms need "announce"');
  assert.equal(resolveRoom({ housePerms: P('announce'), kind: 'news', userId: 'u' }).send, true);
  assert.deepEqual(resolveRoom({ housePerms: P('post'), kind: 'voice', userId: 'u' }), { view: true, send: true, connect: true, speak: true, manage: false, video: true });
  const stage = resolveRoom({ housePerms: P('post'), kind: 'stage', userId: 'u' });
  assert.equal(stage.connect, true); assert.equal(stage.speak, false, 'on a stage the audience does not speak by default');
  assert.equal(resolveRoom({ housePerms: P('rooms'), kind: 'stage', userId: 'u' }).speak, true, 'people who run rooms speak on stages');
  // Private rooms: nobody sees them without an override, and seeing nothing means doing nothing.
  assert.deepEqual(resolveRoom({ housePerms: P('post'), isPrivate: true, userId: 'u' }), none);
  const priv = [{ type: 'role', target: 'r1', allow: ['view'], deny: [] }];
  assert.equal(resolveRoom({ housePerms: P('post'), isPrivate: true, overrides: priv, roleIds: ['r1'], userId: 'u' }).view, true);
  assert.equal(resolveRoom({ housePerms: P('post'), isPrivate: true, overrides: priv, roleIds: ['r2'], userId: 'u' }).view, false);
  // Everyone, then roles (across roles "on" beats "off"), then the person.
  const ov = [
    { type: 'everyone', target: '*', allow: [], deny: ['send'] },
    { type: 'role', target: 'a', allow: ['send'], deny: [] },
    { type: 'role', target: 'b', allow: [], deny: ['send', 'view'] },
    { type: 'member', target: 'x', allow: [], deny: ['send'] },
  ];
  assert.equal(resolveRoom({ housePerms: P('post'), overrides: ov, roleIds: ['z'], userId: 'y' }).send, false, 'everyone: off');
  assert.equal(resolveRoom({ housePerms: P('post'), overrides: ov, roleIds: ['a'], userId: 'y' }).send, true, 'a role turns it back on');
  assert.deepEqual(resolveRoom({ housePerms: P('post'), overrides: ov, roleIds: ['b'], userId: 'y' }), none, 'a role that cannot see the room does nothing in it');
  assert.deepEqual(resolveRoom({ housePerms: P('post'), overrides: ov, roleIds: ['a', 'b'], userId: 'y' }), none, 'nobody turns view back on, so a and b together still see nothing');
  const ov2 = [{ type: 'role', target: 'a', allow: ['send'], deny: [] }, { type: 'role', target: 'b', allow: [], deny: ['send'] }];
  assert.equal(resolveRoom({ housePerms: P('post'), overrides: ov2, roleIds: ['a', 'b'], userId: 'y' }).send, true, 'across roles, on beats off');
  assert.equal(resolveRoom({ housePerms: P('post'), overrides: ov, roleIds: ['a'], userId: 'x' }).send, false, 'the person’s own setting beats their roles');
  // Nobody can lock the house out: owners, and people who manage rooms, always see and manage.
  const lockout = [{ type: 'everyone', target: '*', allow: [], deny: ['view', 'manage', 'send'] }];
  assert.deepEqual(resolveRoom({ housePerms: P(), owner: true, isPrivate: true, overrides: lockout, userId: 'o' }), all);
  const mgr = resolveRoom({ housePerms: P('rooms'), isPrivate: true, overrides: lockout, userId: 'm' });
  assert.equal(mgr.view, true); assert.equal(mgr.manage, true); assert.equal(mgr.send, false, 'but they can still be kept quiet');
  // Voice permissions never apply to text rooms, and no join means no speaking.
  assert.equal(resolveRoom({ housePerms: P('post'), overrides: [{ type: 'everyone', target: '*', allow: ['connect', 'speak'], deny: [] }], userId: 'u' }).connect, false);
  assert.equal(resolveRoom({ housePerms: P('post'), kind: 'voice', overrides: [{ type: 'everyone', target: '*', allow: [], deny: ['connect'] }], userId: 'u' }).speak, false);
  // Unknown permission names in stored overrides are ignored.
  assert.equal('fly' in resolveRoom({ housePerms: P('post'), overrides: [{ type: 'everyone', target: '*', allow: ['fly'], deny: [] }], userId: 'u' }), false);
});

test('places: role colours, icons and member-list groups; forum sort; the rail keeps folders and drops houses you left', async () => {
  const { nameRole, hoistRole, iconRole, memberGroups, sortPosts, moveTo, railItems, railOrder, HUE_IDS, TEMPLATES, mentionsRole } = await import('../js/lib/places.js');
  const roles = [
    { id: 'own', name: 'Owner', hue: 20, hoist: true }, { id: 'mod', name: 'Mod', hue: null, hoist: true, icon: '🛡️' },
    { id: 'art', name: 'Artists', hue: 142, hoist: false, icon: '🎨' }, { id: 'mem', name: 'Member', hue: null, hoist: false },
  ];
  assert.equal(nameRole(roles, ['mem', 'art', 'mod'])?.id, 'art', 'the name takes the highest role with a colour');
  assert.equal(nameRole(roles, ['mem']), null);
  assert.equal(hoistRole(roles, ['mem', 'art']), null, 'roles not shown separately do not group');
  assert.equal(hoistRole(roles, ['art', 'mod'])?.id, 'mod');
  assert.equal(iconRole(roles, ['art', 'mem'])?.icon, '🎨');
  const people = [{ id: 'a', presence: 'online' }, { id: 'b', presence: 'idle' }, { id: 'c', presence: 'offline' }, { id: 'd', presence: 'online' }];
  const of = { a: ['own'], b: ['mod', 'art'], c: ['mod'], d: ['mem'] };
  const g = memberGroups(roles, people, (u) => of[u]);
  assert.deepEqual(g.map((x) => [x.name, x.list.map((u) => u.id)]), [['Owner', ['a']], ['Mod', ['b']], ['Online', ['d']], ['Offline', ['c']]], 'offline people are never under a role');
  const posts = [{ id: 1, ts: 100, last: 900 }, { id: 2, ts: 500 }, { id: 3, ts: 300, last: 400 }];
  assert.deepEqual(sortPosts(posts).map((p) => p.id), [1, 2, 3], 'latest activity');
  assert.deepEqual(sortPosts(posts, 'newest').map((p) => p.id), [2, 3, 1]);
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 'd', 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b'], 'a', 99), ['b', 'a']);
  const layout = { items: ['h3', { id: 'fd_1', name: 'Games', houses: ['h1', 'gone', 'h3'] }, 'gone2', { id: 'fd_2', houses: ['gone3'] }] };
  const items = railItems(layout, ['h1', 'h2', 'h3']);
  assert.deepEqual(items, ['h3', { id: 'fd_1', name: 'Games', houses: ['h1'] }, 'h2'], 'left houses drop out, a house appears once, empty folders go, new houses go last');
  assert.deepEqual(railOrder(items), ['h3', 'h1', 'h2']);
  // Templates only use theme-safe colours and real kinds; private rooms name real roles.
  for (const t of TEMPLATES) {
    for (const r of t.roles) assert.ok(r.hue === null || HUE_IDS.includes(r.hue), `${t.id}: ${r.name} uses a listed hue`);
    for (const room of t.groups.flatMap((x) => x.rooms)) {
      assert.ok(['text', 'voice', 'news', 'forum', 'stage'].includes(room[1]));
      for (const k of room[3]?.only || []) assert.ok(t.roles.some((r) => r.key === k));
    }
  }
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['friends', 'study', 'gaming', 'club']);
  // @Role mentions count only for mentionable roles you have.
  const S = { me: 'u1', rooms: { r: { house: 'h' } }, threads: {}, houses: { h: { members: { u1: 'mem' }, extra: { u1: ['art'] }, roles: [...roles.slice(0, 2), { ...roles[2], mentionable: true }, roles[3]] } } };
  assert.equal(mentionsRole(S, 'r', { text: 'hey @artists, look' }), true);
  assert.equal(mentionsRole(S, 'r', { text: 'hey @artistsx' }), false);
  assert.equal(mentionsRole(S, 'r', { text: 'hey @mod' }), false, 'not a role I have');
  S.houses.h.roles[2].mentionable = false;
  assert.equal(mentionsRole(S, 'r', { text: 'hey @artists' }), false, 'not mentionable');
});
// --- end places ----------------------------------------------------------------------

// --- account: QR codes and settings rules (js/lib/qr.js, js/lib/account.js) ------------
import { qrMatrix, qrPath } from '../js/lib/qr.js';
import { cleanPrefs, mergePrefs, clearAt, deviceLabel, PREF_DEFAULTS, inQuiet, validZone } from '../js/lib/account.js';

// Reference matrices from the Python qrcode library (level M, byte mode, the
// given mask), one row per base-36 number.
const QR_REF = [
  ["Snug ünïcödé ✓", 2, 2, [
    'jujjz',
    'a5irl',
    'ek319',
    'ek7rx',
    'ek6l9',
    'a6tz5',
    'jvfy7',
    '1zi8',
    'eue0s',
    '2953m',
    'hyab7',
    '6asg0',
    '80o9a',
    'jfo6o',
    'excnr',
    'b1o6y',
    'e96nx',
    '2h3v',
    'juw63',
    'a6tjp',
    'el6uz',
    'el5zv',
    'ek09x',
    'a61xp',
    'jv3qv',
  ]],
  ["otpauth://totp/Snug%3Aac-2fa?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Snug&algorithm=SHA1&digits=6&period=30", 3, 7, [
    'cej1pjzwf',
    '6dc5kz681',
    '92lj7y5b1',
    '93fz8oxgd',
    '92nqalen1',
    '6c6jlu2bl',
    'cenaj8hhb',
    '1he10pvk',
    '8xf96b5mz',
    '5bjc4gghz',
    '5e3ug9zmv',
    '8sgk5ow21',
    '1a0rfrmvf',
    't86uue2x',
    '2a0hqsd68',
    '9091ht9ak',
    '1a3hqn9t4',
    'cajo2abrk',
    '149s8hd4e',
    '78me65ant',
    '9cgbqq70f',
    '3jvolrifx',
    'c7vrrpo4b',
    '90gllspi0',
    '689it8vsq',
    '2731yzhs8',
    '9objah1xw',
    '9zc93vakt',
    '6xcq6x2wt',
    'b60jmsat2',
    '38kgf5wui',
    '5j42gegi2',
    'c1c77kxce',
    'z9vzrrk4',
    'imsmd1oz',
    '5v78gqhf4',
    '7lj2pgliq',
    '1fkjfjfc',
    'cf6wenbrk',
    '6cxnq0l5r',
    '92yw2oo3h',
    '93gy0pbcp',
    '93w7m29la',
    '6c5r1ho4x',
    'cegftsd7g',
  ]],
];

test('account: QR codes match a reference encoder module for module, and pick a version that fits', () => {
  for (const [text, mask, version, rows] of QR_REF) {
    const q = qrMatrix(text, { mask });
    assert.equal(q.version, version);
    const want = rows.map((r) => BigInt(`0x0`) + [...r].reduce((a, ch) => a * 36n + BigInt(parseInt(ch, 36)), 0n)).map((n) => n.toString(2).padStart(q.size, '0'));
    assert.deepEqual(q.modules.map((r) => r.map((v) => (v ? '1' : '0')).join('')), want, `${text.slice(0, 16)}…`);
  }
  // Without a fixed mask it scores all eight and keeps one.
  const auto = qrMatrix('otpauth://totp/Snug%3Arobin?secret=JBSWY3DPEHPK3PXP&issuer=Snug');
  assert.ok(auto.mask >= 0 && auto.mask < 8);
  assert.equal(qrPath(auto).size, auto.size + 8);
  assert.throws(() => qrMatrix('x'.repeat(400)), /Too long/);
});

test('account: settings rules: defaults, merging, clearing a status, device names', () => {
  assert.equal(PREF_DEFAULTS.theme, 'system');
  assert.equal(PREF_DEFAULTS.tone, 'violet', 'violet (the brand) is the default tone');
  const c = cleanPrefs({ theme: 'midnight', sidebarW: 300, quiet: { on: true, from: 1320, to: 420, tz: -60, extra: 1 } });
  assert.deepEqual(c.quiet, { on: true, from: 1320, to: 420, tz: -60 }, 'unknown fields are dropped');
  assert.throws(() => cleanPrefs({ sidebarW: 999 }), /200 to 420/);
  assert.throws(() => cleanPrefs({ tts: 'yes' }), /on or off/);
  assert.deepEqual(mergePrefs({ theme: 'dark', zoom: 110 }, { theme: null, zoom: 125 }), { zoom: 125 });
  const t = Date.UTC(2026, 0, 1, 12);
  assert.equal(clearAt('30m', t), t + 30 * 60000);
  assert.equal(clearAt('4h', t), t + 4 * 3600000);
  assert.equal(clearAt('today', t, t + 5), t + 5);
  assert.equal(clearAt('never', t), null);
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), 'Safari on Mac');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'), 'Firefox on Windows');
});
test('account: quiet hours follow a named time zone through daylight saving; only real zones are kept', () => {
  const q = { on: true, from: 22 * 60, to: 7 * 60, tz: 0, zone: 'Europe/Paris' };
  // 21:30 UTC is 22:30 in Paris in winter (UTC+1) and 23:30 in summer (UTC+2): quiet either way.
  assert.equal(inQuiet(q, Date.UTC(2026, 0, 15, 21, 30)), true);
  assert.equal(inQuiet(q, Date.UTC(2026, 6, 15, 21, 30)), true);
  // 20:30 UTC is 21:30 in winter (not yet) and 22:30 in summer (quiet): a fixed offset would get one wrong.
  assert.equal(inQuiet(q, Date.UTC(2026, 0, 15, 20, 30)), false);
  assert.equal(inQuiet(q, Date.UTC(2026, 6, 15, 20, 30)), true);
  // No zone: the saved offset, as before.
  assert.equal(inQuiet({ ...q, zone: undefined }, Date.UTC(2026, 6, 15, 20, 30)), false);
  assert.equal(validZone('America/New_York'), true);
  assert.equal(validZone('Mars/Olympus'), false);
  assert.equal(validZone('../etc'), false);
  assert.deepEqual(cleanPrefs({ quiet: { on: true, from: 1, to: 2, tz: 0, zone: 'UTC' } }).quiet, { on: true, from: 1, to: 2, tz: 0, zone: 'UTC' });
  assert.throws(() => cleanPrefs({ quiet: { on: true, from: 1, to: 2, tz: 0, zone: 'Nowhere/Land' } }), /time zone/);
});
// --- end account -----------------------------------------------------------------------
