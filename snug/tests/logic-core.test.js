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
