// Houses and community: the shared rules (js/lib/community.js) and the new
// permissions (js/lib/perms.js, server/community.js backfillPerms).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMS } from '../js/lib/perms.js';
import { backfillPerms } from '../server/community.js';
import {
  mentionCount, shouting, inviteCodes, flooding, vanityProblem, verifyWaitUntil, PICTURES, SPAM_RULES, FLOOD_SAME_MS,
} from '../js/lib/community.js';
import { fold } from '../js/lib/util.js';

test('the four new house permissions are in the list, once each, with plain words', () => {
  const ids = PERMS.map((p) => p.id);
  for (const id of ['house', 'events', 'hooks', 'react']) {
    assert.equal(ids.filter((x) => x === id).length, 1, id);
    const p = PERMS.find((x) => x.id === id);
    assert.ok(p.label && p.hint && !/[;]/.test(p.label), `${id} has a label and a hint`);
  }
  assert.equal(new Set(ids).size, ids.length, 'no permission listed twice');
});

test('backfill gives each role what its old permissions stood for, and reactions to all', () => {
  assert.deepEqual(new Set(backfillPerms(['post'])), new Set(['post', 'react']));
  assert.deepEqual(new Set(backfillPerms(['post', 'roles'])), new Set(['post', 'roles', 'house', 'hooks', 'react']));
  assert.deepEqual(new Set(backfillPerms(['announce'])), new Set(['announce', 'events', 'react']));
  assert.deepEqual(new Set(backfillPerms(['rooms'])), new Set(['rooms', 'events', 'hooks', 'react']));
  // Running it again changes nothing.
  const once = backfillPerms(['roles', 'rooms', 'announce']);
  assert.deepEqual(backfillPerms(once).sort(), once.sort());
});

test('mentions count distinct people and roles once', () => {
  assert.equal(mentionCount('hi @ava and @bo and @AVA'), 2);
  assert.equal(mentionCount('mail me at ava@example.com'), 0);
  assert.equal(mentionCount('@a1 @b2 @c3 @d4 @e5 @f6'), 6);
  assert.equal(mentionCount(''), 0);
});

test('shouting is over 70% capitals in more than 20 letters', () => {
  assert.equal(shouting('HELLO EVERYONE THIS IS LOUD'), true);
  assert.equal(shouting('OK FINE'), false, 'short messages never count');
  assert.equal(shouting('Hello everyone, this is a normal sentence.'), false);
  assert.equal(shouting('ABCDEFGHIJ abcdefghij KLMNOPQRST'), false, 'two thirds is not over 70%');
});

test('invitation codes are found in links from any host', () => {
  assert.deepEqual(inviteCodes('come to https://snug.example/join/abc123def and http://x:8787/join/potters'), ['abc123def', 'potters']);
  assert.deepEqual(inviteCodes('nothing here /joinme'), []);
});

test('flooding: the same words N times in 30 seconds, or a burst', () => {
  const t = 1_000_000;
  const same = [{ ts: t - 1000, text: fold('buy now') }, { ts: t - 500, text: fold('buy now') }];
  assert.equal(flooding(same, 'Buy now', t, 3), true);
  assert.equal(flooding(same, 'something else', t, 3), false);
  assert.equal(flooding(same.map((r) => ({ ...r, ts: r.ts - FLOOD_SAME_MS })), 'buy now', t, 3), false, 'old ones don’t count');
  const burst = Array.from({ length: 6 }, (_, i) => ({ ts: t - i * 100, text: `m${i}` }));
  assert.equal(flooding(burst, 'new', t, 3), true, 'seven in ten seconds is over twice three');
  assert.equal(flooding(burst, 'new', t, 0), false, 'off');
});

test('custom links: 3 to 32 of a-z, 0-9 and dashes, not reserved', () => {
  assert.equal(vanityProblem('potters'), '');
  assert.equal(vanityProblem('glaze-lab-2'), '');
  assert.match(vanityProblem('ab'), /3 to 32/);
  assert.match(vanityProblem('-bad'), /lowercase/);
  assert.match(vanityProblem('has space'), /lowercase/);
  assert.match(vanityProblem('admin'), /kept for Snug/);
  assert.equal(vanityProblem('Potters'), '', 'checked case-insensitively');
});

test('verification waits', () => {
  const account = 1_000_000, joined = 2_000_000;
  assert.equal(verifyWaitUntil('none', { account, joined }), 0);
  assert.equal(verifyWaitUntil('low', { account, joined }), account + 5 * 60_000);
  assert.equal(verifyWaitUntil('high', { account, joined }), account + 86_400_000);
  assert.equal(verifyWaitUntil('high', { account: 0, joined: 100_000_000 }), 100_000_000 + 10 * 60_000, 'whichever ends later');
});

test('picture limits and rule ranges are what the settings say', () => {
  assert.equal(PICTURES.icon.bytes, 1024 * 1024);
  assert.equal(PICTURES.icon.maxPx, 512);
  assert.equal(PICTURES.banner.bytes, 2 * 1024 * 1024);
  assert.equal(PICTURES.splash.bytes, 2 * 1024 * 1024);
  const m = SPAM_RULES.find((r) => r.id === 'mentions');
  assert.deepEqual([m.min, m.max], [3, 50]);
});

test('moving rooms: within a category, across one, and stepping with the keyboard', async () => {
  const { placeRoom, placeGroup, stepRoom } = await import('../js/lib/community.js');
  const g = [{ id: 'a', rooms: ['r1', 'r2'] }, { id: 'b', rooms: ['r3'] }];
  assert.deepEqual(placeRoom(g, 'r1', 'b', 0).map((x) => x.rooms), [['r2'], ['r1', 'r3']]);
  assert.deepEqual(placeRoom(g, 'r1', 'a', 9).map((x) => x.rooms), [['r2', 'r1'], ['r3']]);
  assert.deepEqual(g[0].rooms, ['r1', 'r2'], 'the original is untouched');
  assert.deepEqual(placeGroup(g, 'b', 0).map((x) => x.id), ['b', 'a']);
  assert.deepEqual(stepRoom(g, 'r1', 1), { group: 'a', to: 1 });
  assert.deepEqual(stepRoom(g, 'r2', 1), { group: 'b', to: 0 }, 'down out of the last place crosses into the next category');
  assert.deepEqual(stepRoom(g, 'r3', -1), { group: 'a', to: 2 });
  assert.equal(stepRoom(g, 'r1', -1), null);
  assert.equal(stepRoom(g, 'r3', 1), null);
});
