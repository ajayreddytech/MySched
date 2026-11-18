import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDay, mergeDayDoc, findOverlaps } from '../src/lib/schedule.js';

const standard = [
  { start: '09:00', end: '10:00', title: 'Gym', description: '' },
  { start: '10:00', end: '11:00', title: 'Coding', description: '' },
];

test('no day document means the standard schedule, unchanged', () => {
  const r = resolveDay(standard, null);
  assert.equal(r.custom, false);
  assert.deepEqual(r.items.map((i) => i.status), ['standard', 'standard']);
});

test('a patch changes only the touched times and keeps the rest of standard', () => {
  const dayDoc = {
    mode: 'patch',
    changes: [
      { op: 'set', start: '10:00', end: '11:30', title: 'Coding', description: 'deep work' },
      { op: 'set', start: '12:00', end: '13:00', title: 'Lunch', description: '' },
    ],
  };
  const r = resolveDay(standard, dayDoc);
  assert.deepEqual(
    r.items.map((i) => [i.start, i.end, i.status]),
    [['09:00', '10:00', 'standard'], ['10:00', '11:30', 'changed'], ['12:00', '13:00', 'new']],
  );
});

test('a remove patch drops that standard slot only', () => {
  const dayDoc = { mode: 'patch', changes: [{ op: 'remove', start: '09:00', end: '09:00', title: '', description: '' }] };
  const r = resolveDay(standard, dayDoc);
  assert.deepEqual(r.items.map((i) => i.title), ['Coding']);
});

test('a full day document replaces the whole day', () => {
  const dayDoc = { mode: 'full', items: [{ start: '13:00', end: '14:00', title: 'Hike', description: '' }] };
  const r = resolveDay(standard, dayDoc);
  assert.equal(r.custom, true);
  assert.deepEqual(r.items.map((i) => i.title), ['Hike']);
});

test('merging a new patch keeps earlier changes and replaces the same start time', () => {
  const existing = { mode: 'patch', changes: [{ op: 'set', start: '10:00', end: '11:00', title: 'A', description: '' }] };
  const merged = mergeDayDoc(existing, 'day-patch', [
    { op: 'set', start: '10:00', end: '12:00', title: 'B', description: '' },
    { op: 'remove', start: '09:00', end: '09:00', title: '', description: '' },
  ]);
  assert.equal(merged.mode, 'patch');
  assert.deepEqual(
    merged.changes.map((c) => [c.start, c.title, c.op]),
    [['10:00', 'B', 'set'], ['09:00', 'Untitled', 'remove']],
  );
});

test('merging a patch into a full day edits that day\'s items', () => {
  const existing = { mode: 'full', items: [{ start: '09:00', end: '10:00', title: 'Old', description: '' }] };
  const merged = mergeDayDoc(existing, 'day-patch', [{ op: 'set', start: '09:00', end: '10:30', title: 'New', description: '' }]);
  assert.equal(merged.mode, 'full');
  assert.deepEqual(merged.items.map((i) => [i.title, i.end]), [['New', '10:30']]);
});

test('"day-full" stores only the tasks submitted', () => {
  const merged = mergeDayDoc(null, 'day-full', [
    { op: 'set', start: '08:00', end: '09:00', title: 'Walk', description: '' },
    { op: 'remove', start: '10:00', end: '10:00', title: 'X', description: '' },
  ]);
  assert.deepEqual(merged, { mode: 'full', items: [{ start: '08:00', end: '09:00', title: 'Walk', description: '' }] });
});

test('overlapping tasks are reported', () => {
  const pairs = findOverlaps([
    { start: '09:00', end: '10:00', title: 'A' },
    { start: '09:30', end: '10:30', title: 'B' },
    { start: '11:00', end: '12:00', title: 'C' },
  ]);
  assert.deepEqual(pairs.map(([a, b]) => [a.title, b.title]), [['A', 'B']]);
});
