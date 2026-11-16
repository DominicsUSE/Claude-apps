// Getting in (js/lib/onboarding.js): pasted invitations, why an invitation
// fails, sign-up problems all at once, where a newcomer lands and what they
// see, who "New message" may list, and the Messages order (js/lib/inbox.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInvite, quickInvite, inviteProblem, inviteWhy, signupProblems, signupField, newcomerSees, landingRoom,
  messageable, whyNotMessageable, localOnly, looksLikeEmail,
} from '../js/lib/onboarding.js';
import { byActivity } from '../js/lib/inbox.js';
import { wroteLately, summaryLine } from '../js/lib/social.js';

test('parseInvite: a full link, an app link, a path or a bare code; nothing else', () => {
  assert.equal(parseInvite('https://snug.example.org/join/AbC_12-x'), 'AbC_12-x');
  assert.equal(parseInvite('  http://127.0.0.1:9121/join/k9q3x0aa?ref=1 '), 'k9q3x0aa');
  assert.equal(parseInvite('snug://join/k9q3x0aa'), 'k9q3x0aa');
  assert.equal(parseInvite('/join/potters/'), 'potters');
  assert.equal(parseInvite('k9q3x0aa'), 'k9q3x0aa');
  assert.equal(parseInvite('Come join us! https://snug.example.org/join/k9q3x0aa see you'), 'k9q3x0aa');
  assert.equal(parseInvite(''), null);
  assert.equal(parseInvite('ab'), null, 'too short');
  assert.equal(parseInvite('not a code at all'), null);
  assert.equal(parseInvite('https://snug.example.org/'), null);
});

test('inviteProblem: unknown, revoked, used up and expired, each with a sentence that says what to do', () => {
  const now = 1_000_000;
  assert.equal(inviteProblem(null, now), 'unknown');
  assert.equal(inviteProblem({ expires: now + 1, revoked: now - 5 }, now), 'revoked');
  assert.equal(inviteProblem({ expires: now + 1, max_uses: 3, uses: 3 }, now), 'used');
  assert.equal(inviteProblem({ expires: now - 1 }, now), 'expired');
  assert.equal(inviteProblem({ expires: now + 1, max_uses: 3, uses: 2 }, now), null);
  for (const r of ['unknown', 'revoked', 'used', 'expired']) assert.match(inviteWhy(r), /new (link|one)/);
  assert.equal(inviteWhy('nonsense'), inviteWhy('unknown'));
});

test('signupProblems: every field at once, with the server’s rules in words', () => {
  assert.deepEqual(Object.keys(signupProblems({})).sort(), ['handle', 'name', 'password']);
  const p = signupProblems({ handle: 'mantas k', name: '', password: 'short' });
  assert.match(p.handle, /spaces/);
  assert.match(p.name, /call you/);
  assert.match(p.password, /8 characters.*5/);
  assert.match(signupProblems({ handle: '-dash', name: 'A', password: 'long enough pass' }).handle, /starting and ending/);
  assert.match(signupProblems({ handle: 'mantas', name: 'Mantas', password: 'mantas-rocks-2024' }).password, /username or name/);
  assert.deepEqual(signupProblems({ handle: 'Mantas.K', name: 'Mantas', password: 'quiet green kettle' }), {});
  assert.deepEqual(signupProblems({ handle: '@mantas', name: 'M', password: 'quiet green kettle' }), {}, 'a leading @ is fine');
});

test('signupField: a server refusal lands on the field it is about', () => {
  assert.equal(signupField('@mantas is taken. Try another username.', 409), 'handle');
  assert.equal(signupField('Usernames are 2 to 24 letters…', 400), 'handle');
  assert.equal(signupField('Your name can be 1 to 40 characters.', 400), 'name');
  assert.equal(signupField('That password is one of the most common ones.', 400), 'password');
  assert.equal(signupField('Too many attempts. Wait a few minutes and try again.', 429), null);
});

// A house like the seeded Kiln & Co.: a notice room first among the starters.
function world({ perms = ['post'] } = {}) {
  const room = (id, kind, extra = {}) => ({ id, house: 'h', kind, name: id, ...extra });
  return {
    me: 'u1',
    users: {},
    friends: { u7: { state: 'friends' }, u8: { state: 'outgoing' }, u9: { state: 'incoming' } },
    dms: { d1: { id: 'd1', members: ['u1', 'u5'] } },
    rooms: { desk: room('desk', 'news'), floor: room('floor', 'text'), show: room('show', 'text'), wheel: room('wheel', 'voice'), watch: room('watch', 'stage'), glaze: room('glaze', 'text') },
    houses: {
      h: {
        id: 'h', joined: true, newcomer: true, members: { u1: 'new', u2: 'lead' }, starter: ['desk', 'floor', 'show'],
        roles: [{ id: 'lead', name: 'Lead', perms: [] }, { id: 'new', name: 'Newcomer', perms }],
        groups: [{ id: 'g1', rooms: ['desk', 'floor', 'glaze', 'show'] }, { id: 'g2', rooms: ['wheel', 'watch'] }],
      },
      other: { id: 'other', joined: false, members: { u3: 'x' }, starter: [], roles: [], groups: [] },
    },
  };
}

test('landingRoom: the first starter room a newcomer can write in, never a notice room', () => {
  const S = world();
  assert.equal(landingRoom(S, 'h'), 'floor');
  // A room override that takes posting away is respected too.
  S.rooms.floor.perms = { send: false };
  assert.equal(landingRoom(S, 'h'), 'show');
  // Nothing writable: the first starter room, so they can still read.
  const R = world({ perms: [] });
  assert.equal(landingRoom(R, 'h'), 'desk');
  assert.equal(landingRoom(S, 'nope'), null);
});

test('newcomerSees: starter rooms and every voice and stage room; everything once settled', () => {
  const S = world();
  const h = S.houses.h;
  const seen = (house) => Object.values(S.rooms).filter((r) => newcomerSees(house, r.id, r.kind)).map((r) => r.id);
  assert.deepEqual(seen(h), ['desk', 'floor', 'show', 'wheel', 'watch']);
  assert.deepEqual(seen({ ...h, newcomer: false }), ['desk', 'floor', 'show', 'wheel', 'watch', 'glaze']);
  // The owner's "Show every room to newcomers": everything from the start.
  assert.deepEqual(seen({ ...h, showAllRooms: true }), ['desk', 'floor', 'show', 'wheel', 'watch', 'glaze']);
});

test('messageable: shared houses, existing conversations and accepted friends, as the server allows', () => {
  const S = world();
  assert.deepEqual([...messageable(S)].sort(), ['u2', 'u5', 'u7']);
  assert.match(whyNotMessageable(S, 'u8'), /accept your friend request/);
  assert.match(whyNotMessageable(S, 'u9'), /Accept/);
  assert.match(whyNotMessageable(S, 'u3'), /friend request first/);
});

test('localOnly: loopback and private addresses are flagged; public names are not', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'snug.localhost']) assert.equal(localOnly(h), 'computer', h);
  for (const h of ['192.168.1.20', '10.0.0.5', '172.20.1.1', 'nas.local', 'fd12:3456::1']) assert.equal(localOnly(h), 'network', h);
  for (const h of ['snug.example.org', '172.32.0.1', '8.8.8.8']) assert.equal(localOnly(h), null, h);
});

test('looksLikeEmail: an address, not a username', () => {
  assert.equal(looksLikeEmail('jurga@gmail.com'), true);
  assert.equal(looksLikeEmail('@jurga@gmail.com'), true);
  assert.equal(looksLikeEmail('jurga'), false);
  assert.equal(looksLikeEmail('@jurga'), false);
});

test('byActivity: Messages are ordered by the last message, a new empty one by when it started', () => {
  const S = {
    dms: { a: { created: 100 }, b: { created: 200 }, c: { created: 300 }, d: { created: 50 } },
    msgs: { a: [{ ts: 900 }], b: [{ ts: 400 }, { ts: 500 }], c: [] },
  };
  // The server sends them newest-created first: c, b, a, d.
  assert.deepEqual(byActivity(S, ['c', 'b', 'a', 'd']), ['a', 'b', 'c', 'd']);
  S.msgs.d = [{ ts: 1000 }];
  assert.deepEqual(byActivity(S, ['c', 'b', 'a', 'd']), ['d', 'a', 'b', 'c']);
});

test('wroteLately: says what is counted', () => {
  assert.equal(wroteLately(1), '1 person wrote in the last 15 minutes');
  assert.equal(wroteLately(3), '3 people wrote in the last 15 minutes');
});

test('summaryLine: Home’s summary is one sentence with a capital, whichever part comes first', () => {
  assert.equal(summaryLine(['something on now']), 'Something on now.');
  assert.equal(summaryLine(['2 friends around', 'something on now']), '2 friends around, something on now.');
  assert.equal(summaryLine([]), '');
});

test('quickInvite: the quick switcher offers to join only for text that looks like an invitation', () => {
  assert.equal(quickInvite('https://snug.example.org/join/k3x9q2m7a1bz'), 'k3x9q2m7a1bz');
  assert.equal(quickInvite('snug://join/k3x9q2m7a1bz'), 'k3x9q2m7a1bz');
  assert.equal(quickInvite('/join/kiln'), 'kiln', 'a link names a house’s own word too');
  assert.equal(quickInvite('  k3x9q2m7a1bz  '), 'k3x9q2m7a1bz', 'a bare code: letters and numbers, 6 or more');
  // Words people type to find a room or a person are not invitations.
  for (const s of ['general', 'glaze lab', 'robin', 'ab12', 'room-2', '', '   ', 'https://example.org/about']) assert.equal(quickInvite(s), null, s);
});
