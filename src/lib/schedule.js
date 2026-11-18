// Pure schedule logic: how a day's custom changes sit on top of the standard schedule.
//
// Standard schedule: an array of { start, end, title, description } (every day).
// Day document (users/{uid}/days/{YYYY-MM-DD}) is one of:
//   { mode: 'patch', changes: [{ op: 'set' | 'remove', start, end, title, description }] }
//       -> the standard schedule with only these times changed.
//   { mode: 'full',  items: [{ start, end, title, description }] }
//       -> this whole day is replaced.

import { toMinutes } from './time.js';
import { formatNotes, toTitleCase } from './text.js';

export function pickItem(i) {
  return {
    start: i.start,
    end: i.end || i.start,
    title: toTitleCase(i.title) || 'Untitled',
    description: formatNotes(i.description),
  };
}

export function pickChange(c) {
  return { op: c.op === 'remove' ? 'remove' : 'set', ...pickItem(c) };
}

export function sortItems(items) {
  return [...items].sort(
    (a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(a.end) - toMinutes(b.end),
  );
}

/** Applies changes to a list. A change is matched to an existing item by its start time. */
export function applyChanges(base, changes) {
  const items = base.map(pickItem);
  for (const c of changes) {
    const idx = items.findIndex((i) => i.start === c.start);
    if (c.op === 'remove') {
      if (idx >= 0) items.splice(idx, 1);
      continue;
    }
    const item = pickItem(c);
    if (idx >= 0) items[idx] = item;
    else items.push(item);
  }
  return sortItems(items);
}

/** The schedule to show for one day, with a status on each item for display. */
export function resolveDay(standard, dayDoc) {
  const base = sortItems(standard.map(pickItem));
  if (!dayDoc) {
    return { custom: false, items: base.map((i) => ({ ...i, status: 'standard' })) };
  }
  if (dayDoc.mode === 'full') {
    return {
      custom: true,
      items: sortItems((dayDoc.items || []).map(pickItem)).map((i) => ({ ...i, status: 'custom' })),
    };
  }
  const standardStarts = new Set(base.map((i) => i.start));
  const touched = new Set((dayDoc.changes || []).filter((c) => c.op !== 'remove').map((c) => c.start));
  const items = applyChanges(base, dayDoc.changes || []).map((i) => ({
    ...i,
    status: !touched.has(i.start) ? 'standard' : standardStarts.has(i.start) ? 'changed' : 'new',
  }));
  return { custom: true, items };
}

/**
 * Builds the new day document from what the user just submitted.
 * mode: 'day-patch' (change only these times) or 'day-full' (replace the whole day).
 */
export function mergeDayDoc(existing, mode, rows) {
  if (mode === 'day-full') {
    return {
      mode: 'full',
      items: sortItems(rows.filter((r) => r.op !== 'remove').map(pickItem)),
    };
  }
  const changes = rows.map(pickChange);
  if (existing?.mode === 'full') {
    return { mode: 'full', items: applyChanges(existing.items || [], changes) };
  }
  // Keep earlier changes for this day; a new change at the same start time replaces the old one.
  const byStart = new Map((existing?.changes || []).map((c) => [c.start, c]));
  for (const c of changes) byStart.set(c.start, c);
  return { mode: 'patch', changes: [...byStart.values()] };
}

/**
 * End of an item within its start day, in minutes. An overnight item (end earlier on the clock
 * than its start, such as 11 pm to 7 am) runs to midnight on the day it starts.
 */
export function endWithinDay(item) {
  const start = toMinutes(item.start);
  const end = toMinutes(item.end || item.start);
  return end < start ? 1440 : end;
}

/** Pairs of items whose times overlap on the same day. */
export function findOverlaps(items) {
  const s = sortItems(items);
  const pairs = [];
  for (let i = 1; i < s.length; i++) {
    if (toMinutes(s[i].start) < endWithinDay(s[i - 1])) pairs.push([s[i - 1], s[i]]);
  }
  return pairs;
}
