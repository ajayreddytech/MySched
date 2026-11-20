// Reads a schedule written in the structured format (from the app's own instructions, or pasted from an AI)
// and turns it into the writes to save. Pure: nothing here touches Firebase or the page.
//
// Format:
//   Days: Monday, Tuesday | Monday to Friday | Saturday and Sunday | all days   (a weekly schedule)
//   From: 2026-11-24                                                              (optional, Days only; default today)
//   Dates: 2026-11-24, 2026-11-27                                                 (instead of Days: for specific dates)
//   09:00-10:30 | Task name | notes | deadline 2026-11-25                         (one line per task)
//
// Any problem is reported with its line number. The caller saves nothing while there are errors.

import { dateKey, parseDateKey, isValidDateKey, formatDayLong, formatTime } from './time.js';
import { pickItem, sortItems, findOverlaps, WEEKDAY_NAMES } from './schedule.js';

const pad = (n) => String(n).padStart(2, '0');

/** Day names as people write them, mapped to getDay() numbers (0 = Sunday). */
const DAY_WORDS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const isRealDate = (key) => isValidDateKey(key) && dateKey(parseDateKey(key)) === key;

/** "Monday, Tuesday", "Monday to Friday", "Saturday and Sunday", "all days" -> { dows } or { errors }. */
export function parseDays(raw) {
  const s = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(all days?|every ?day|everyday|all|every day of the week)$/.test(s)) return { dows: [0, 1, 2, 3, 4, 5, 6] };
  if (/^(weekdays?|monday to friday|mon to fri|mon-fri|monday-friday)$/.test(s)) return { dows: [1, 2, 3, 4, 5] };
  if (/^(weekends?|saturday and sunday|sat and sun|saturday & sunday|sat & sun)$/.test(s)) return { dows: [6, 0] };
  if (!s) return { errors: ['Days: is empty. Write a day name such as Monday.'] };

  const dows = new Set();
  const errors = [];
  for (const part of s.split(/\s*(?:,|&|\band\b)\s*/).filter(Boolean)) {
    const range = /^(\S+)\s*(?:to|-|–)\s*(\S+)$/.exec(part);
    if (range && DAY_WORDS[range[1]] !== undefined && DAY_WORDS[range[2]] !== undefined) {
      const last = DAY_WORDS[range[2]];
      for (let d = DAY_WORDS[range[1]]; ; d = (d + 1) % 7) {
        dows.add(d);
        if (d === last) break;
      }
    } else if (DAY_WORDS[part] !== undefined) {
      dows.add(DAY_WORDS[part]);
    } else {
      errors.push(`"${part}" is not a day. Use names like Monday, or Monday to Friday.`);
    }
  }
  if (errors.length) return { errors };
  return { dows: [...dows] };
}

/** "9", "9:30", "09:30", "9 am", "10:30 pm", "12 am" -> "HH:MM", or null. */
export function parseClock(raw) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i.exec(String(raw).trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  const suffix = m[3] ? m[3].toLowerCase().replace(/\./g, '')[0] : '';
  if (suffix) {
    if (h < 1 || h > 12) return null;
    if (suffix === 'p' && h !== 12) h += 12;
    if (suffix === 'a' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(min)}`;
}

/** "9:00-10:30", "9 am - 10:30 am", "9 to 10", or a start only, "9:00" -> { start, end } or null. */
function parseTimeCell(cell) {
  const bits = cell.split(/\s*(?:–|—|-|\bto\b)\s*/i).map((b) => b.trim()).filter(Boolean);
  if (bits.length === 1) {
    const start = parseClock(bits[0]);
    return start ? { start, end: start } : null;
  }
  if (bits.length === 2) {
    const start = parseClock(bits[0]);
    const end = parseClock(bits[1]);
    return start && end ? { start, end } : null;
  }
  return null;
}

/** One task line: "time | task | notes | deadline DATE" (notes and deadline optional). */
function parseTaskLine(line) {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length < 2 || cells.length > 4) {
    return { error: 'Use: time | task | notes | deadline YYYY-MM-DD (notes and deadline are optional).' };
  }
  const time = parseTimeCell(cells[0]);
  if (!time && /^(time|times|when|start|start time)$/i.test(cells[0])) return { skip: true }; // a table header row
  if (!time) {
    return { error: `The time "${cells[0]}" is not understood. Use 09:00-10:30, or 9 am - 10:30 am, or one start time.` };
  }
  const title = cells[1];
  if (!title) return { error: 'Give the task a name.' };

  let notes = '';
  let deadline = '';
  for (const cell of cells.slice(2)) {
    const m = /^deadline\s*:?\s*(.*)$/i.exec(cell);
    if (m) {
      if (!isRealDate(m[1])) return { error: `The deadline "${m[1]}" must be a date like 2026-11-25.` };
      deadline = m[1];
    } else {
      notes = cell;
    }
  }
  return {
    item: pickItem({ start: time.start, end: time.end, title, description: notes, deadline }),
  };
}

/** Lines that are only decoration (table rules, bullets, markdown bold) are cleaned up before reading. */
function cleanLine(raw) {
  let line = String(raw).replace(/\*\*/g, '').trim();
  line = line.replace(/^[-*•]\s+/, '');
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|')) line = line.slice(0, -1);
  return line.trim();
}

/**
 * Reads a whole pasted schedule. Returns:
 *   { errors, warnings, writes, taskCount }
 * writes: [{ type: 'weekly', dows, from, items }] or [{ type: 'day', date, items }].
 * Save only when errors is empty.
 */
export function parseStructured(text, today = new Date()) {
  const errors = [];
  const warnings = [];
  const todayKey = dateKey(today);
  const headers = {};
  const tasks = [];

  String(text).split(/\r?\n/).forEach((raw, idx) => {
    const n = idx + 1;
    const line = cleanLine(raw);
    if (!line || /^[\s|:-]+$/.test(line)) return; // blank or a table rule
    const h = /^(days|dates|from)\s*:\s*(.*)$/i.exec(line);
    if (h) {
      const key = h[1].toLowerCase();
      if (headers[key]) errors.push(`Line ${n}: "${h[1]}:" is written twice.`);
      else headers[key] = { value: h[2].trim(), line: n };
      return;
    }
    if (/^tasks?\s*:?$/i.test(line)) return;
    if (line.includes('|')) {
      const r = parseTaskLine(line);
      if (r.error) errors.push(`Line ${n}: ${r.error}`);
      else if (r.item) tasks.push(r.item);
      return;
    }
    if (/^\d/.test(line)) {
      errors.push(`Line ${n}: "${line}" needs | between the parts. Use: time | task | notes | deadline YYYY-MM-DD`);
      return;
    }
    warnings.push(`Line ${n} was not used: "${line}"`);
  });

  if (!tasks.length && !errors.length) {
    errors.push('No tasks found. Add lines like: 09:00-10:30 | Gym | Bring water | deadline 2026-11-25');
  }
  if (headers.days && headers.dates) errors.push(`Line ${headers.dates.line}: use either Days: or Dates:, not both.`);
  if (!headers.days && !headers.dates) errors.push('Add a "Days:" line for a weekly schedule, or a "Dates:" line for specific dates.');

  const items = sortItems(tasks);
  findOverlaps(items).forEach(([a, b]) => {
    warnings.push(`"${a.title}" and "${b.title}" overlap around ${formatTime(b.start)}.`);
  });

  const writes = [];
  if (headers.days && !headers.dates) {
    const days = parseDays(headers.days.value);
    if (days.errors) days.errors.forEach((e) => errors.push(`Line ${headers.days.line}: ${e}`));
    let from = todayKey;
    if (headers.from) {
      const f = headers.from.value;
      if (!isRealDate(f)) errors.push(`Line ${headers.from.line}: "From" must be a date like 2026-11-24.`);
      else if (f < todayKey) warnings.push(`The start date ${f} has passed, so the schedule starts today.`);
      else from = f;
    }
    if (days.dows) writes.push({ type: 'weekly', dows: days.dows, from, items });
  } else if (headers.dates) {
    if (headers.from) errors.push(`Line ${headers.from.line}: "From" only works with Days:.`);
    const list = [...new Set(headers.dates.value.split(/[\s,]+/).filter(Boolean))];
    if (!list.length) errors.push(`Line ${headers.dates.line}: Dates: is empty.`);
    for (const date of list) {
      if (!isRealDate(date)) errors.push(`Line ${headers.dates.line}: "${date}" is not a date. Use 2026-11-24.`);
      else if (date < todayKey) errors.push(`${date} has passed. Past days cannot be changed.`);
      else writes.push({ type: 'day', date, items });
    }
  }

  return { errors, warnings, writes, taskCount: items.length };
}

/** A plain list of what a set of writes will save, for the preview. */
export function describeWrites(writes) {
  return writes.map((w) => {
    if (w.type === 'day') return `${formatDayLong(parseDateKey(w.date))}: the whole day is replaced.`;
    const ordered = [1, 2, 3, 4, 5, 6, 0].filter((d) => w.dows.includes(d)).map((d) => WEEKDAY_NAMES[d]);
    return `${ordered.join(', ')}, from ${formatDayLong(parseDateKey(w.from))}.`;
  });
}

/** True when pasted text is in the structured format (rather than a spoken or typed sentence). */
export function looksStructured(text) {
  return text.includes('|') || /(^|\n)\s*[*]*\s*(days|dates|from)\s*:/i.test(text);
}

/** Instructions to give an AI so that its answer can be pasted straight in. */
export function aiInstructions(today = new Date()) {
  return [
    `I want my schedule as plain text in exactly this format. Today is ${formatDayLong(today)} (${dateKey(today)}). Write every date as YYYY-MM-DD.`,
    '',
    'First, one of these two lines:',
    'Days: Monday, Tuesday        (a weekly schedule. Also: Monday to Friday, Saturday and Sunday, all days)',
    'Dates: 2026-11-24, 2026-11-27   (only these specific dates. Each whole day is replaced by the tasks below)',
    '',
    'Optional, only with Days: ',
    'From: 2026-11-24            (the schedule starts on this date. Leave it out to start today)',
    '',
    'Then one line per task, with | between the parts:',
    'start-end | task name | notes | deadline YYYY-MM-DD',
    'Notes and the deadline are optional. A start-only task is just: 13:00 | Call with Sam',
    'Times can be 09:00-10:30 or 9 am - 10:30 am. An end time before the start time means the task runs past midnight.',
    '',
    'Example:',
    'Days: Monday to Friday',
    'From: 2026-11-24',
    '06:00-07:00 | Gym | Bring water; wear shoes',
    '09:00-12:00 | Project report | Finish the summary | deadline 2026-11-27',
    '13:00 | Call with Sam',
    '',
    'Reply with only these lines, and no other text.',
  ].join('\n');
}
