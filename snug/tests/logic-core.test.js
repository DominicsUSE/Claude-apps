// Snug 0.12 core track: pure logic (quiet hours by weekday, disappearing
// message timers, the offline op queue, drafts, the persist throttle and the
// long-conversation window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrefs, inQuiet } from '../js/lib/account.js';

// 2026-11-13 is a Friday, 2026-11-14 a Saturday, 2026-11-16 a Monday (UTC).
const at = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m);

test('quiet hours: a weekday can follow the daily window, have none, be quiet all day, or have its own times', () => {
  const base = { on: true, from: 22 * 60, to: 7 * 60, tz: 0, zone: 'UTC' };
  // No days: every day the same, as before.
  assert.equal(inQuiet(base, at(14, 12)), false);
  assert.equal(inQuiet(base, at(14, 23)), true);
  // Saturday (6) and Sunday (0) quiet all day; Friday (5) has no quiet hours.
  const q = { ...base, days: [ 'all', null, null, null, null, 'off', 'all' ] };
  assert.equal(inQuiet(q, at(14, 12)), true, 'Saturday noon: quiet all day');
  assert.equal(inQuiet(q, at(13, 23)), false, 'Friday 23:00: no quiet hours that day');
  assert.equal(inQuiet(q, at(14, 3)), true, 'Saturday 03:00: Saturday is quiet all day');
  assert.equal(inQuiet(q, at(16, 12)), false, 'Monday noon: the daily window');
  assert.equal(inQuiet(q, at(16, 23)), true, 'Monday 23:00: the daily window');
  // A window that crosses midnight belongs to the day it starts: Sunday's
  // all-day quiet ends at Monday 00:00, and Monday's own window starts at 22:00.
  assert.equal(inQuiet(q, at(16, 3)), false, 'Monday 03:00: Sunday ended at midnight, Monday not yet quiet');
  // Thursday 22:00 to Friday 07:00 still holds although Friday itself is off.
  assert.equal(inQuiet(q, at(13, 6)), true, 'Friday 06:00: the tail of Thursday night');
  // Own times on Wednesday (3): 13:00 to 14:00.
  const w = { ...base, days: [null, null, null, { from: 13 * 60, to: 14 * 60 }, null, null, null] };
  assert.equal(inQuiet(w, Date.UTC(2026, 10, 11, 13, 30)), true);
  assert.equal(inQuiet(w, Date.UTC(2026, 10, 11, 23, 0)), false, 'Wednesday night uses its own window, not the daily one');
  // Weekdays follow the named zone: 23:30 UTC on Friday is already Saturday in Vilnius (UTC+2).
  const vil = { ...base, zone: 'Europe/Vilnius', days: [null, null, null, null, null, 'off', 'all'] };
  assert.equal(inQuiet(vil, at(13, 22, 30)), true, 'Saturday 00:30 in Vilnius');
  // Off switch still wins.
  assert.equal(inQuiet({ ...q, on: false }, at(14, 12)), false);
});

test('quiet hours: days are checked when saved', () => {
  const ok = cleanPrefs({ quiet: { on: true, from: 1, to: 2, tz: 0, days: ['all', null, { from: 60, to: 120 }, null, null, 'off', null] } }).quiet;
  assert.deepEqual(ok.days, ['all', null, { from: 60, to: 120 }, null, null, 'off', null]);
  assert.equal(cleanPrefs({ quiet: { on: true, from: 1, to: 2, tz: 0 } }).quiet.days, undefined, 'no days: same shape as before');
  assert.throws(() => cleanPrefs({ quiet: { on: true, from: 1, to: 2, tz: 0, days: ['all'] } }), /seven days/);
  assert.throws(() => cleanPrefs({ quiet: { on: true, from: 1, to: 2, tz: 0, days: Array(7).fill('sometimes') } }), /each day/i);
  assert.throws(() => cleanPrefs({ quiet: { on: true, from: 1, to: 2, tz: 0, days: [{ from: 1, to: 9999 }, null, null, null, null, null, null] } }), /each day/i);
});

import { dropExpired, ttlLabel, TTL_CHOICES } from '../js/lib/expiry.js';
test('disappearing: this device drops expired messages from its lists and cache, and knows when the next one is due', () => {
  const S = {
    msgs: { a: [{ id: '1', expires: 100 }, { id: '2' }, { id: '3', expires: 300 }], b: [{ id: '4' }] },
    cache: { 5: { id: '5', expires: 50 }, 6: { id: '6', expires: 400 } },
  };
  const r = dropExpired(S, 200);
  assert.equal(r.removed, 2);
  assert.equal(r.next, 300);
  assert.deepEqual(S.msgs.a.map((m) => m.id), ['2', '3']);
  assert.deepEqual(Object.keys(S.cache), ['6']);
  assert.equal(dropExpired({ msgs: { b: [{ id: '4' }] }, cache: {} }, 1).next, null);
  assert.deepEqual(TTL_CHOICES.map(([, l]) => l), ['Off', '1 hour', '1 day', '7 days', '30 days']);
  assert.equal(ttlLabel(86_400_000), '1 day');
});

import { trimForCache, queueOp, replayOp, QUEUED_OPS } from '../js/lib/offline.js';
test('device copy: at most 40 messages per conversation, never dropping ones still waiting to send, and older ones marked to load', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, ts: i }));
  msgs[10].state = 'queued'; // an old unsent one: kept
  const out = trimForCache({ msgs: { a: msgs, b: msgs.slice(0, 5) }, more: {}, cache: { x: { id: 'x' } } });
  assert.equal(out.msgs.a.length, 41);
  assert.equal(out.msgs.a[0].id, 'm10');
  assert.equal(out.msgs.a.at(-1).id, 'm99');
  assert.equal(out.more.a, true, 'the rest loads from the server when scrolled to');
  assert.equal(out.msgs.b.length, 5);
  assert.equal(out.more.b, undefined);
  assert.deepEqual(out.cache, {}, 'search hits are not kept');
  assert.equal(msgs.length, 100, 'the live state is untouched');
});

test('offline changes: queued once each (the last one wins), and replayed onto a fresh snapshot', () => {
  assert.ok(['react', 'msg.edit', 'msg.delete', 'msg.restore', 'saved.set', 'saved.note'].every((op) => QUEUED_OPS.has(op)));
  assert.equal(QUEUED_OPS.has('msg.send'), false, 'messages have their own queue');
  let q = [];
  q = queueOp(q, 'react', { conv: 'r', id: 'm1', emoji: '👍', on: true });
  q = queueOp(q, 'msg.edit', { conv: 'r', id: 'm2', text: 'one' });
  q = queueOp(q, 'msg.edit', { conv: 'r', id: 'm2', text: 'two' });
  q = queueOp(q, 'react', { conv: 'r', id: 'm1', emoji: '👍', on: false });
  q = queueOp(q, 'react', { conv: 'r', id: 'm1', emoji: '🎉', on: true });
  assert.deepEqual(q.map((x) => [x.op, x.d.text ?? x.d.emoji, x.d.on]), [['msg.edit', 'two', undefined], ['react', '👍', false], ['react', '🎉', true]]);
  // Replayed onto what the server sent on reconnect, so nothing flickers back.
  const S = { me: 'u1', msgs: { r: [{ id: 'm1', reactions: { '👍': ['u1', 'u2'] } }, { id: 'm2', text: 'zero' }, { id: 'm3', text: 'bye' }] }, saved: [], cache: {} };
  for (const x of q) replayOp(S, x.op, x.d);
  replayOp(S, 'msg.delete', { conv: 'r', id: 'm3' });
  replayOp(S, 'saved.set', { conv: 'r', id: 'm2', on: true });
  assert.deepEqual(S.msgs.r[0].reactions, { '👍': ['u2'], '🎉': ['u1'] });
  assert.equal(S.msgs.r[1].text, 'two');
  assert.equal(S.msgs.r.length, 2);
  assert.equal(S.saved[0].id, 'm2');
});

// review-media 8: the service worker keeps only the app page under '/', never another page such as a help page.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
test('service worker: a help page opened while online is never kept as the offline app page', async () => {
  const handlers = {};
  const puts = [];
  const cache = { put: async (k) => { puts.push(k); }, match: async () => undefined };
  const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const ctx = {
    self: { addEventListener: (t, f) => { handlers[t] = f; }, location: { origin: 'https://chat.example' }, registration: {}, clients: {} },
    caches: { open: async () => cache, match: async () => undefined, keys: async () => [] },
    fetch: async () => Object.defineProperty(html('<p>page</p>'), 'type', { value: 'basic' }),
    URL, Response, Promise, console,
  };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);
  const go = async (path) => {
    const waits = [];
    let answered = null;
    handlers.fetch({ request: { method: 'GET', url: `https://chat.example${path}`, mode: 'navigate' }, respondWith: (p) => { answered = p; }, waitUntil: (p) => waits.push(p) });
    if (answered) await answered;
    await Promise.all(waits);
    return !!answered;
  };
  await go('/docs/guide.html');
  assert.deepEqual(puts, [], 'a help page is not stored');
  await go('/join/abc');
  assert.deepEqual(puts, ['/'], 'an app route is stored as the app page');
});

// review-media 8: read markers kept while offline belong to the person who made them, not whoever signs in next.
test('sign-out forgets read markers waiting to be sent from offline', async () => {
  const store = await import('../js/store.js');
  store.setRead('k_offline_read', 12345); // the default transport is offline: the marker waits
  await new Promise((r) => setTimeout(r, 0));
  store.signedOut();
  const sent = [];
  store.useTransport({ call: async (op, d) => { sent.push([op, d]); return {}; }, resync() {}, history: async () => ({}) });
  store.applySnapshot({ me: 'u_next', users: {}, read: {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.filter(([op]) => op.startsWith('read.')), [], 'nothing from the last person is sent for the next one');
});
