// The rules that decide what people see: message parsing, grouping, what
// counts as unread or "needs you", search, and permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, isJumbo, plain, mentions } from '../js/lib/format.js';
import { buildItems } from '../js/lib/group.js';
import { needsMe, attention, levelOf, unreadOf, totalNeeds } from '../js/lib/attention.js';
import { parseQuery, runSearch, setOp } from '../js/lib/search.js';
import { can, canPost } from '../js/lib/perms.js';
import { seed } from '../js/seed.js';
import { MIN, DAY } from '../js/lib/util.js';

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
});
