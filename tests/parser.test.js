import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeech } from '../src/lib/parser.js';

// Wednesday 18 November 2026 (local time).
const TODAY = new Date(2026, 10, 18);

test('time ranges become 24-hour items in spoken order', () => {
  const r = parseSpeech('9 to 10 gym, 10 to 11 coding', { today: TODAY });
  assert.equal(r.scope, 'standard');
  assert.deepEqual(
    r.items.map((i) => [i.start, i.end, i.title]),
    [['09:00', '10:00', 'Gym'], ['10:00', '11:00', 'Coding']],
  );
});

test('am/pm, minutes and a colon note', () => {
  const r = parseSpeech('from 9 am to 10:30 am gym: bring water', { today: TODAY });
  assert.deepEqual(r.items[0], {
    op: 'set', start: '09:00', end: '10:30', title: 'Gym', description: 'Bring Water',
  });
});

test('task name may come before the time', () => {
  const r = parseSpeech('gym from 9 to 10, coding from 10 to 11', { today: TODAY });
  assert.deepEqual(
    r.items.map((i) => [i.title, i.start, i.end]),
    [['Gym', '09:00', '10:00'], ['Coding', '10:00', '11:00']],
  );
});

test('"9 to 10 pm" reads as an evening slot', () => {
  const r = parseSpeech('9 to 10 pm party', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end], ['21:00', '22:00']);
});

test('bare "11 to 1" reads as late morning to early afternoon', () => {
  const r = parseSpeech('lunch from 11 to 1', { today: TODAY });
  assert.deepEqual([r.items[0].title, r.items[0].start, r.items[0].end], ['Lunch', '11:00', '13:00']);
});

test('single "at" time gets a one-hour slot', () => {
  const r = parseSpeech('at 9 am standup', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end, r.items[0].title], ['09:00', '10:00', 'Standup']);
});

test('spoken noon and o\'clock are understood', () => {
  const r = parseSpeech("at 9 o'clock breakfast, at noon lunch", { today: TODAY });
  assert.equal(r.items[0].start, '09:00');
  assert.equal(r.items[1].start, '12:00');
  assert.equal(r.items[1].title, 'Lunch');
});

test('"tomorrow" switches to a day scope; "cancel" becomes a removal', () => {
  const r = parseSpeech('tomorrow 2 to 3 pm meeting, cancel 4 to 5 pm review', { today: TODAY });
  assert.equal(r.scope, 'day');
  assert.equal(r.date, '2026-11-19');
  assert.deepEqual(r.items, [
    { op: 'set', start: '14:00', end: '15:00', title: 'Meeting', description: '' },
    { op: 'remove', start: '16:00', end: '17:00', title: 'Review', description: '' },
  ]);
});

test('weekday names resolve to the next occurrence', () => {
  const r = parseSpeech('on friday 9 to 10 gym', { today: TODAY });
  assert.equal(r.date, '2026-11-20');
});

test('month and day resolve to a date', () => {
  const r = parseSpeech('on November 25 9 to 10 gym', { today: TODAY });
  assert.equal(r.date, '2026-11-25');
});

test('no times produces a warning and no items', () => {
  const r = parseSpeech('hello there', { today: TODAY });
  assert.equal(r.items.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('spoken number words: "nine to ten gym, ten to eleven coding"', () => {
  const r = parseSpeech('nine to ten gym, ten to eleven coding', { today: TODAY });
  assert.deepEqual(
    r.items.map((i) => [i.title, i.start, i.end]),
    [['Gym', '09:00', '10:00'], ['Coding', '10:00', '11:00']],
  );
});

test('spoken minutes: "from nine thirty to ten thirty meeting"', () => {
  const r = parseSpeech('from nine thirty to ten thirty meeting', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end, r.items[0].title], ['09:30', '10:30', 'Meeting']);
});

test('"half past" and "quarter past" phrasing', () => {
  const r = parseSpeech('half past nine to quarter past ten yoga', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end], ['09:30', '10:15']);
});

test('"at nine for one hour yoga" uses the duration', () => {
  const r = parseSpeech('at nine for one hour yoga', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end, r.items[0].title], ['09:00', '10:00', 'Yoga']);
});

test('"in the evening" and "nine o\'clock" phrasing', () => {
  const r = parseSpeech("from 9 in the evening to 10 pm party, at nine o'clock breakfast", { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end], ['21:00', '22:00']);
  assert.equal(r.items[1].start, '09:00');
});

test('speech-recognition "to" heard as "two"', () => {
  const r = parseSpeech('9 two 10 gym', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end, r.items[0].title], ['09:00', '10:00', 'Gym']);
});

test('"start at 6 am wake up" is a start-only task (no end)', () => {
  const r = parseSpeech('start at 6 am wake up, 7 to 8 gym', { today: TODAY });
  assert.deepEqual(
    r.items.map((i) => [i.title, i.start, i.end]),
    [['Wake Up', '06:00', '06:00'], ['Gym', '07:00', '08:00']],
  );
  assert.deepEqual(r.warnings, []);
});

test('"6 am wake up" with no "start" word is also start-only', () => {
  const r = parseSpeech('6 am wake up, 7 to 8 gym', { today: TODAY });
  assert.deepEqual(
    r.items.map((i) => [i.title, i.start, i.end]),
    [['Wake Up', '06:00', '06:00'], ['Gym', '07:00', '08:00']],
  );
});

test('"at 9 to 10 gym" keeps the range', () => {
  const r = parseSpeech('at 9 to 10 gym', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end], ['09:00', '10:00']);
});

test('"sleep 11 pm to 7 am" runs overnight, not flagged as an error', () => {
  const r = parseSpeech('sleep 11 pm to 7 am, 7 to 8 gym', { today: TODAY });
  assert.deepEqual(
    r.items.map((i) => [i.title, i.start, i.end]),
    [['Sleep', '23:00', '07:00'], ['Gym', '07:00', '08:00']],
  );
  assert.deepEqual(r.warnings, []);
});

test('"at 9 pm to 7 am" overnight with the "at" form', () => {
  const r = parseSpeech('at 9 pm to 7 am sleep', { today: TODAY });
  assert.deepEqual([r.items[0].start, r.items[0].end], ['21:00', '07:00']);
});

test('spoken "bullet" words make separate bullet lines in the notes', () => {
  const r = parseSpeech('9 to 10 gym: bullet water bullet towel bullet soap', { today: TODAY });
  assert.equal(r.items[0].description, '• Water\n• Towel\n• Soap');
});
