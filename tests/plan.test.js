import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDays, parseClock, parseStructured, looksStructured, describeWrites, aiInstructions } from '../src/lib/plan.js';

// Friday 20 November 2026 (local time).
const TODAY = new Date(2026, 10, 20);

test('day names: single days, lists, ranges and the named groups', () => {
  assert.deepEqual(parseDays('Wednesday').dows, [3]);
  assert.deepEqual(parseDays('mon, wed & Fri').dows.sort(), [1, 3, 5]);
  assert.deepEqual(parseDays('Monday to Friday').dows.sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('Saturday and Sunday').dows.sort(), [0, 6]);
  assert.deepEqual(parseDays('weekends').dows.sort(), [0, 6]);
  assert.equal(parseDays('all days').dows.length, 7);
  assert.deepEqual(parseDays('Friday to Monday').dows.sort(), [0, 1, 5, 6]); // wraps through the weekend
});

test('a day name that is not a day is reported', () => {
  assert.ok(parseDays('Funday').errors[0].includes('funday'));
  assert.ok(parseDays('').errors.length > 0);
});

test('clock times: 24-hour, am/pm and single hours', () => {
  assert.equal(parseClock('9:30'), '09:30');
  assert.equal(parseClock('09:30'), '09:30');
  assert.equal(parseClock('9 am'), '09:00');
  assert.equal(parseClock('10:30 pm'), '22:30');
  assert.equal(parseClock('12 am'), '00:00');
  assert.equal(parseClock('12 pm'), '12:00');
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('9:75'), null);
  assert.equal(parseClock('13 pm'), null);
  assert.equal(parseClock('lunch'), null);
});

test('a weekly schedule with a start date, times, notes and a deadline', () => {
  const r = parseStructured(`
Days: Monday to Friday
From: 2026-11-23
06:00-07:00 | gym | bring water
09:00-12:00 | project report | finish the summary | deadline 2026-11-27
13:00 | call with sam
`, TODAY);
  assert.deepEqual(r.errors, []);
  assert.equal(r.writes.length, 1);
  const w = r.writes[0];
  assert.equal(w.type, 'weekly');
  assert.deepEqual(w.dows.sort(), [1, 2, 3, 4, 5]);
  assert.equal(w.from, '2026-11-23');
  assert.deepEqual(w.items.map((i) => [i.start, i.end, i.title]), [
    ['06:00', '07:00', 'Gym'],
    ['09:00', '12:00', 'Project Report'],
    ['13:00', '13:00', 'Call With Sam'],
  ]);
  assert.equal(w.items[1].deadline, '2026-11-27');
  assert.equal('deadline' in w.items[0], false);
  assert.equal(w.items[0].description, 'Bring Water'); // notes are formatted the same way as the rest of the app
});

test('specific dates replace each whole day; duplicates are saved once', () => {
  const r = parseStructured(`Dates: 2026-11-24, 2026-11-27 2026-11-24
10:00-11:00 | Dentist`, TODAY);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.writes.map((w) => [w.type, w.date]), [['day', '2026-11-24'], ['day', '2026-11-27']]);
});

test('AI formatting is accepted: bullets, bold labels, table pipes and rules', () => {
  const r = parseStructured(`Here is your schedule:
**Days:** Saturday and Sunday
| Time | Task |
|---|---|
- 9 am - 10:30 am | Gym | Bring water
* 11 pm - 7 am | Sleep
`, TODAY);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.writes[0].dows.sort(), [0, 6]);
  assert.deepEqual(r.writes[0].items.map((i) => [i.start, i.end]), [['09:00', '10:30'], ['23:00', '07:00']]);
  assert.ok(r.warnings.some((w) => w.includes('Here is your schedule')));
});

test('errors are reported with line numbers and nothing is written', () => {
  const r = parseStructured(`Days: Monday
09:00-10:00 | Gym
25:00-26:00 | Bad time
09:00-10:00 | Gym | notes | deadline 2026-13-40
10:00-11:00 | | no name
11:00-12:00 Missing bars
`, TODAY);
  assert.ok(r.writes.length === 0 || r.errors.length > 0);
  assert.ok(r.errors.some((e) => e.startsWith('Line 3:') && e.includes('25:00')));
  assert.ok(r.errors.some((e) => e.startsWith('Line 4:') && e.includes('2026-13-40')));
  assert.ok(r.errors.some((e) => e.startsWith('Line 5:') && e.includes('name')));
  assert.ok(r.errors.some((e) => e.startsWith('Line 6:') && e.includes('|')));
});

test('a missing scope, two scopes, no tasks, and a past date are all errors', () => {
  assert.ok(parseStructured('09:00 | Gym', TODAY).errors.some((e) => e.includes('"Days:"')));
  assert.ok(parseStructured('Days: Monday\nDates: 2026-11-30\n09:00 | Gym', TODAY).errors.some((e) => e.includes('not both')));
  assert.ok(parseStructured('Days: Monday', TODAY).errors.some((e) => e.includes('No tasks')));
  const past = parseStructured('Dates: 2026-11-01\n09:00 | Gym', TODAY);
  assert.ok(past.errors.some((e) => e.includes('2026-11-01 has passed')));
});

test('From: must be a real date, cannot be used with Dates:, and a past start becomes today', () => {
  assert.ok(parseStructured('Days: Monday\nFrom: next week\n09:00 | Gym', TODAY).errors.some((e) => e.includes('From')));
  assert.ok(parseStructured('Dates: 2026-11-30\nFrom: 2026-11-30\n09:00 | Gym', TODAY).errors.some((e) => e.includes('only works with Days')));
  const past = parseStructured('Days: Monday\nFrom: 2026-11-01\n09:00 | Gym', TODAY);
  assert.deepEqual(past.errors, []);
  assert.equal(past.writes[0].from, '2026-11-20');
  assert.ok(past.warnings.some((w) => w.includes('has passed')));
});

test('overlapping tasks are a warning, not an error', () => {
  const r = parseStructured('Days: Monday\n09:00-11:00 | Gym\n10:00-12:00 | Coding', TODAY);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('overlap')));
});

test('detects structured text and describes the writes', () => {
  assert.equal(looksStructured('09:00 | Gym'), true);
  assert.equal(looksStructured('Days: Monday\n09:00 Gym'), true);
  assert.equal(looksStructured('9 to 10 gym, 10 to 11 coding'), false);
  const r = parseStructured('Days: Saturday and Sunday\nFrom: 2026-11-28\n09:00 | Gym', TODAY);
  assert.deepEqual(describeWrites(r.writes), ['Saturday, Sunday, from Saturday, 28th November.']);
});

test('AI instructions include today and the format', () => {
  const text = aiInstructions(TODAY);
  assert.ok(text.includes('2026-11-20'));
  assert.ok(text.includes('Days:') && text.includes('Dates:') && text.includes('|'));
  // The example in the instructions must itself be valid.
  const example = text.split('Example:\n')[1].split('\n\n')[0];
  assert.deepEqual(parseStructured(example, TODAY).errors, []);
});
