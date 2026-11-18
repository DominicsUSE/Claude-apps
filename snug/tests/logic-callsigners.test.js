// calls C2: the record, on this device only, of which of a person's devices signed calls with it
// (js/lib/callsigners.js, kept sealed in the encryption store). Losing it reopens the first-call gap, so:
// an entry that can't be read is never written over, two tabs don't erase each other's entries,
// and two writes at once both land.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from '../js/e2ee/store.js';
import { signerBook } from '../js/lib/callsigners.js';

const fresh = async (st) => {
  const b = signerBook({ open: async () => st });
  await b.load();
  return b;
};

test('remembered devices persist, most recent last; pruning keeps only those still listed', async () => {
  const st = memStore();
  const a = await fresh(st);
  assert.deepEqual(await a.get('u_r'), []);
  assert.deepEqual(a.now('u_r'), []);
  await a.remember('u_r', 'dv_1');
  await a.remember('u_r', 'dv_2');
  await a.remember('u_r', 'dv_1');
  assert.deepEqual((await fresh(st)).now('u_r'), ['dv_1', 'dv_2']);
  await a.prune('u_r', ['dv_2', 'dv_9']);
  assert.deepEqual((await fresh(st)).now('u_r'), ['dv_2']);
  await a.prune('u_r', []);
  assert.deepEqual((await fresh(st)).now('u_r'), []);
});

test('an entry that can\'t be read (not locked: damaged, or a key that won\'t open it) is never written over', async () => {
  const st = memStore();
  await (await fresh(st)).remember('u_r', 'dv_1');
  let broken = true;
  const flaky = { ...st, getSecret: async (k) => { if (broken) throw new Error('unseal'); return st.getSecret(k); } };
  const b = signerBook({ open: async () => flaky });
  await b.load();
  await b.remember('u_i', 'dv_7');
  assert.deepEqual(b.now('u_i'), ['dv_7'], 'remembered in this tab');
  broken = false;
  const c = await fresh(st);
  assert.deepEqual(c.now('u_r'), ['dv_1'], 'the saved record is untouched');
  assert.deepEqual(c.now('u_i'), [], 'nothing written from a partial map');
});

test('two tabs: each one\'s new entries survive the other\'s writes', async () => {
  const st = memStore();
  const a = await fresh(st);
  const b = await fresh(st);
  await a.remember('u_r', 'dv_1');
  await b.remember('u_i', 'dv_2');
  await a.remember('u_k', 'dv_3');
  const c = await fresh(st);
  assert.deepEqual([c.now('u_r'), c.now('u_i'), c.now('u_k')], [['dv_1'], ['dv_2'], ['dv_3']]);
  assert.deepEqual(await a.get('u_i'), ['dv_2'], 'and the other tab\'s entry is seen at the next write');
});

test('two writes at once for the same person both land', async () => {
  const st = memStore();
  const a = await fresh(st);
  await Promise.all([a.remember('u_r', 'dv_1'), a.remember('u_r', 'dv_2'), a.remember('u_i', 'dv_3')]);
  const c = await fresh(st);
  assert.deepEqual([[...c.now('u_r')].sort(), c.now('u_i')], [['dv_1', 'dv_2'], ['dv_3']]);
});

test('no store on this device: nothing remembered, nothing waited on, nothing thrown', async () => {
  const b = signerBook({ open: async () => null });
  assert.deepEqual(await b.get('u_r'), []);
  assert.deepEqual(b.now('u_r'), []);
  await b.remember('u_r', 'dv_1');
  await b.prune('u_r', []);
  const late = memStore();
  let have = null;
  const c = signerBook({ open: async () => have });
  assert.deepEqual(await c.get('u_r'), []);
  have = late; // the store opened later (encryption set up): read then
  await (await fresh(late)).remember('u_r', 'dv_1');
  assert.deepEqual(await c.get('u_r'), ['dv_1']);
});

test('before it is read, now() says so (null) instead of "nobody"', async () => {
  const st = memStore();
  await (await fresh(st)).remember('u_r', 'dv_1');
  const b = signerBook({ open: async () => st });
  assert.equal(b.now('u_r'), null);
  await b.load();
  assert.deepEqual(b.now('u_r'), ['dv_1']);
});
