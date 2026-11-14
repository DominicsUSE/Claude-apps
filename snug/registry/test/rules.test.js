import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, normalize, skeleton, OWNER_NAMES, RESERVED } from '../../js/lib/usernames.js';

test('valid names', () => {
  for (const n of ['ab', 'a_b.c', 'x'.repeat(32), 'bob', 'a1', '99', 'model', 'modern', 'dominics.use']) {
    assert.equal(check(n), null, n);
  }
});

test('uppercase and surrounding space normalize to valid lowercase', () => {
  assert.equal(normalize('  BoB.X '), 'bob.x');
  assert.equal(check('BOB'), null);
  assert.equal(check('Alice_W'), null);
});

test('invalid names', () => {
  for (const n of ['x', 'b', '0', 'x'.repeat(33), '-', 'a-b', 'a b', 'bób', 'ab!', '', 'émile', 'a\nb', '.ab', 'ab_', '_ab', 'ab.',
    'a..b', 'a._b', 'a__b', 'a_.b', '..', '__', '._']) {
    assert.equal(check(n), 'invalid_name', JSON.stringify(n));
  }
});

test('owner names "1" and "a" are owner-only', () => {
  assert.deepEqual(OWNER_NAMES, ['1', 'a']);
  for (const n of ['1', 'a', 'A', ' a ']) {
    assert.equal(check(n), 'owner_only', n);
    assert.equal(check(n, { owner: true }), null, n);
  }
  // owner status does not unlock other one-character names or reserved words
  assert.equal(check('b', { owner: true }), 'invalid_name');
  assert.equal(check('admin', { owner: true }), 'reserved');
});

test('reserved words, including look-alike skeleton forms', () => {
  for (const n of RESERVED) assert.equal(check(n), 'reserved', n);
  for (const n of ['ADMIN', 'Snug', 'mod', 's.n.u.g', 'snug.support', 'snug_team', 'snugfan', '0fficial', 'adm1n', 'adrnin',
    'the.admin', 'staff.member', 'nu11', 'r00t', 'here', 'me', 'you', 'everyone', 'nobody', 'moderator2', 'supp0rt', 'real_official']) {
    assert.equal(check(n), 'reserved', n);
  }
  for (const n of ['model', 'modern', 'mode', 'meow', 'bobby']) assert.equal(check(n), null, n);
});

test('skeleton collapses look-alikes', () => {
  assert.equal(skeleton('dominics.use'), skeleton('dominics_use'));
  assert.equal(skeleton('dominics.use'), skeleton('dominicsuse'));
  assert.equal(skeleton('rnary'), skeleton('mary'));
  assert.equal(skeleton('b0b'), skeleton('bob'));
  assert.equal(skeleton('1ily'), skeleton('lily'));
  assert.equal(skeleton('vvill'), skeleton('will'));
  assert.equal(skeleton('Bob.X'), skeleton('bob_x'));
  assert.notEqual(skeleton('bob'), skeleton('rob'));
});

test('check never reports taken (that is the registry)', () => {
  assert.equal(check('bob'), null);
});
