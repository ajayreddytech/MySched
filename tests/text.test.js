import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTitleCase } from '../src/lib/text.js';

test('every word starts with a capital letter', () => {
  assert.equal(toTitleCase('wake up at home'), 'Wake Up At Home');
  assert.equal(toTitleCase('  bring   water  '), 'Bring Water');
});

test('apostrophes do not start a new word', () => {
  assert.equal(toTitleCase("don't forget"), "Don't Forget");
});

test('brackets and quotes start a new word', () => {
  assert.equal(toTitleCase('call (zoom) "team sync"'), 'Call (Zoom) "Team Sync"');
});

test('empty input is safe', () => {
  assert.equal(toTitleCase(undefined), '');
  assert.equal(toTitleCase(''), '');
});

import { formatNotes } from '../src/lib/text.js';

test('bullets each go on their own line', () => {
  assert.equal(formatNotes('• bring water • bring towel'), '• Bring Water\n• Bring Towel');
});

test('dash or star lines become bullets, plain lines stay plain', () => {
  assert.equal(formatNotes('Pack bag\n- water\n* towel'), 'Pack Bag\n• Water\n• Towel');
});

test('empty notes stay empty', () => {
  assert.equal(formatNotes(''), '');
  assert.equal(formatNotes(undefined), '');
});
