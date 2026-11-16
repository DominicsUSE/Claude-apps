// The inbox and shell rules that run in the browser (and on the server):
// timed mute and presence times, attention honouring an expired mute and
// merging the server's unread counts, snug:// link parsing, global shortcut
// accelerators, the pinned/closed conversation order, and @role suppression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MUTE_FOR, PRESENCE_FOR, untilFor, untilText, mergeUnread, parseDeepLink, validAccelerator, acceleratorOf, live } from '../js/lib/inbox.js';
import { levelOf, attention, unreadOf, totalNeeds } from '../js/lib/attention.js';
import { mentionsRole } from '../js/lib/places.js';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

test('times: each choice becomes an end time; never is null; anything else is undefined', () => {
  assert.deepEqual(MUTE_FOR, ['15m', '1h', '8h', '24h', 'never']);
  assert.equal(untilFor('15m', NOW), NOW + 15 * 60_000);
  assert.equal(untilFor('1h', NOW), NOW + 3_600_000);
  assert.equal(untilFor('8h', NOW), NOW + 8 * 3_600_000);
  assert.equal(untilFor('24h', NOW), NOW + 86_400_000);
  assert.equal(untilFor('never', NOW), null);
  assert.equal(untilFor('3d', NOW), undefined);
  assert.equal(untilFor('__proto__', NOW), undefined);
  assert.ok(PRESENCE_FOR.includes('today'));
  // Today: the client's own midnight, if it is within a day; else a day from now.
  assert.equal(untilFor('today', NOW, NOW + 5 * 3_600_000), NOW + 5 * 3_600_000);
  assert.equal(untilFor('today', NOW, NOW + 3 * 86_400_000), NOW + 86_400_000, 'a midnight days away is not accepted');
  assert.equal(untilFor('today', NOW, NOW - 1), NOW + 86_400_000);
  assert.equal(live(null, NOW), true);
  assert.equal(live(NOW - 1, NOW), false);
  assert.equal(live(NOW + 1, NOW), true);
});

test('untilText: a time today, or the weekday and time', () => {
  const at = new Date(2026, 10, 13, 9, 0).getTime();
  assert.equal(untilText(new Date(2026, 10, 13, 14, 30).getTime(), at), '14:30');
  assert.equal(untilText(new Date(2026, 10, 13, 14, 30).getTime(), at, true), '2:30 pm');
  assert.match(untilText(new Date(2026, 10, 14, 8, 5).getTime(), at), /^[A-Z][a-z]{2} 08:05$/);
  assert.equal(untilText(null, at), '');
});

function state(extra = {}) {
  const S = {
    me: 'me', users: { me: { id: 'me', handle: 'me' }, ann: { id: 'ann', handle: 'ann' } },
    houses: { h1: { id: 'h1', notify: 'all', groups: [{ rooms: ['r1'] }], roles: [{ id: 'own' }, { id: 'crew', name: 'Crew' }], members: { me: 'crew', ann: 'own' } } },
    rooms: { r1: { id: 'r1', house: 'h1', notify: null } },
    houseOrder: ['h1'], dms: {}, dmOrder: [], threads: {}, followed: {}, invites: [], read: { r1: 1000 },
    msgs: { r1: [{ id: 'a', author: 'ann', ts: 2000, text: '@me hello' }] },
    prefs: {},
    ...extra,
  };
  return S;
}

test('attention honours an expired timed mute, and a live one', () => {
  const t = Date.now();
  const S = state();
  S.rooms.r1.notify = 'muted';
  S.rooms.r1.notifyUntil = t + 60_000;
  assert.equal(levelOf(S, 'r1'), 'muted');
  assert.deepEqual(attention(S, 'r1'), { soft: false, needs: 0 });
  S.rooms.r1.notifyUntil = t - 1;
  assert.equal(levelOf(S, 'r1'), 'all', 'an expired mute counts as unset: the house level applies');
  assert.equal(attention(S, 'r1').needs, 1);
  // A house muted until a time that passed.
  S.rooms.r1.notify = null;
  S.houses.h1.notify = 'muted';
  S.houses.h1.notifyUntil = t - 1;
  assert.equal(levelOf(S, 'r1'), 'all');
  S.houses.h1.notifyUntil = null;
  assert.equal(levelOf(S, 'r1'), 'muted', 'muted with no end stays muted');
  // A direct conversation.
  S.dms.d1 = { id: 'd1', members: ['me', 'ann'], notify: 'muted', notifyUntil: t - 5 };
  assert.equal(levelOf(S, 'd1'), 'all');
});

test('unread counts: the larger of the device and the server, plus what arrived after the server counted', () => {
  assert.deepEqual(mergeUnread({ count: 2, needs: 0 }, { count: 100, needs: 1, upTo: 5000 }, 1000), { count: 100, needs: 1 });
  assert.deepEqual(mergeUnread({ count: 2, needs: 0 }, { count: 100, needs: 1, upTo: 5000 }, 1000, { count: 1, needs: 1 }), { count: 101, needs: 2 });
  assert.deepEqual(mergeUnread({ count: 3, needs: 2 }, { count: 1, needs: 1, upTo: 5000 }, 1000), { count: 3, needs: 2 }, 'the device knows more');
  assert.deepEqual(mergeUnread({ count: 0, needs: 0 }, { count: 9, needs: 9, upTo: 5000 }, 5000), { count: 0, needs: 0 }, 'read past the server count: old news');
  assert.deepEqual(mergeUnread({ count: 1, needs: 0 }, undefined, 0), { count: 1, needs: 0 });
  // Through attention: an old mention the device never loaded still needs me.
  const S = state({ msgs: { r1: [{ id: 'z', author: 'ann', ts: 9000, text: 'latest' }] }, unread: { r1: { count: 100, needs: 1, firstSeq: 10, upTo: 8000 } } });
  const u = unreadOf(S, 'r1');
  assert.deepEqual({ count: u.count, needs: u.needs }, { count: 101, needs: 1 });
  assert.equal(totalNeeds(S), 1);
  S.read.r1 = 9000; // read it all
  assert.equal(totalNeeds(S), 0);
});

test('@role mentions: suppressed for a house in rolesOff', () => {
  const S = state();
  const m = { id: 'x', author: 'ann', ts: 3000, text: 'hey @Crew' };
  assert.equal(mentionsRole(S, 'r1', m), true);
  S.prefs.rolesOff = { h1: true };
  assert.equal(mentionsRole(S, 'r1', m), false);
});

test('snug:// links: join and open only, strictly', () => {
  assert.deepEqual(parseDeepLink('snug://join/abc123'), { kind: 'join', code: 'abc123' });
  assert.deepEqual(parseDeepLink('snug://join/abc123/'), { kind: 'join', code: 'abc123' });
  assert.deepEqual(parseDeepLink('SNUG://Join/abc-12_3'), { kind: 'join', code: 'abc-12_3' });
  assert.deepEqual(parseDeepLink('snug://open/r_kiln'), { kind: 'open', place: 'r_kiln' });
  assert.deepEqual(parseDeepLink('snug://open/t:m_root/m_reply'), { kind: 'open', place: 't:m_root', msg: 'm_reply' });
  for (const bad of ['snug://join/abc', 'snug://join/../../etc', 'snug://join/a b c d e f', 'snug://open/a/b/c', 'snug://open/', 'snug://open//x',
    'snug://delete/everything', 'https://example.com/join/abc123', 'snug://join/abc123?x=1', 'snug://join/abc123#frag', `snug://join/${'a'.repeat(41)}`, null, 42, 'snug:join/abc123']) {
    assert.equal(parseDeepLink(bad), null, String(bad));
  }
});

test('global shortcuts: one or two modifiers and one key', () => {
  for (const ok of ['CommandOrControl+Shift+M', 'Alt+F9', 'Control+Alt+Space', 'Super+num5', 'Shift+F12', 'Ctrl+Shift+/']) assert.equal(validAccelerator(ok), true, ok);
  for (const bad of ['M', 'Shift', 'Ctrl+Alt+Shift+M', 'Shift+Shift+M', 'Hyper+M', 'Ctrl+Escape', 'Ctrl+MM', '', null, 'Ctrl+M+N']) assert.equal(validAccelerator(bad), false, String(bad));
  // Shortcuts other apps depend on are never taken.
  for (const bad of ['CommandOrControl+C', 'CommandOrControl+V', 'Ctrl+Z', 'Shift+/', 'Shift+A', 'Alt+Tab', 'Alt+F4', 'Ctrl+Alt+F4', 'Alt+Space']) assert.equal(validAccelerator(bad), false, bad);
  assert.equal(acceleratorOf({ ctrlKey: true, shiftKey: true, code: 'KeyM' }), 'CommandOrControl+Shift+M');
  assert.equal(acceleratorOf({ altKey: true, code: 'F9' }), 'Alt+F9');
  assert.equal(acceleratorOf({ metaKey: true, shiftKey: true, code: 'KeyD' }, true), 'CommandOrControl+Shift+D');
  assert.equal(acceleratorOf({ metaKey: true, code: 'KeyD' }, true), null, 'Cmd+D alone would take it from every app');
  assert.equal(acceleratorOf({ code: 'KeyM' }), null, 'no modifier');
  assert.equal(acceleratorOf({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyM' }), 'CommandOrControl+Alt+M', 'at most two modifiers kept');
});
