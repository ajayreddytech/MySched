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
