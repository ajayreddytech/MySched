import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withOrdinal } from '../src/lib/time.js';

test('ordinal suffixes', () => {
  assert.equal(withOrdinal(1), '1st');
  assert.equal(withOrdinal(2), '2nd');
  assert.equal(withOrdinal(3), '3rd');
  assert.equal(withOrdinal(4), '4th');
  assert.equal(withOrdinal(11), '11th');
  assert.equal(withOrdinal(12), '12th');
  assert.equal(withOrdinal(13), '13th');
  assert.equal(withOrdinal(18), '18th');
  assert.equal(withOrdinal(21), '21st');
  assert.equal(withOrdinal(22), '22nd');
  assert.equal(withOrdinal(23), '23rd');
  assert.equal(withOrdinal(27), '27th');
  assert.equal(withOrdinal(31), '31st');
});

test('weekend is Saturday and Sunday only', async () => {
  const { isWeekend } = await import('../src/lib/time.js');
  assert.equal(isWeekend(new Date(2026, 10, 13)), false); // Friday
  assert.equal(isWeekend(new Date(2026, 10, 14)), true); // Saturday
  assert.equal(isWeekend(new Date(2026, 10, 15)), true); // Sunday
  assert.equal(isWeekend(new Date(2026, 10, 16)), false); // Monday
});

test('date keys are checked as YYYY-MM-DD', async () => {
  const { isValidDateKey } = await import('../src/lib/time.js');
  assert.equal(isValidDateKey('2026-11-23'), true);
  assert.equal(isValidDateKey('2026-11-3'), false);
  assert.equal(isValidDateKey(''), false);
  assert.equal(isValidDateKey(undefined), false);
});

test('next weekday on or after a date', async () => {
  const { nextWeekdayOnOrAfter } = await import('../src/lib/time.js');
  // 2026-11-20 is a Friday. Monday is 1, Friday is 5.
  assert.equal(nextWeekdayOnOrAfter('2026-11-20', 5), '2026-11-20'); // same day counts
  assert.equal(nextWeekdayOnOrAfter('2026-11-20', 1), '2026-11-23'); // next Monday
  assert.equal(nextWeekdayOnOrAfter('2026-11-20', 0), '2026-11-22'); // next Sunday
  assert.equal(nextWeekdayOnOrAfter('2026-12-31', 1), '2027-01-04'); // crosses the year end
});
