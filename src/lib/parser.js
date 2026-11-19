// Turns a spoken (or typed) sentence into schedule rows.
//
// Examples it understands:
//   "9 to 10 gym, 10 to 11 coding"            and the spoken form "nine to ten gym"
//   "from nine thirty to ten thirty meeting"  "half past nine to quarter past ten yoga"
//   "from 9 am to 10:30 am gym: bring water"
//   "gym from 9 to 10, coding from 10 to 11"  (task name may come before the time)
//   "at 9 am standup"                         (single start time)
//   "at nine for one hour yoga"               (start time plus duration)
//   "9 in the evening to 10 pm party"         "noon", "midnight", "nine o'clock"
//   "tomorrow 2 to 3 pm meeting, cancel 4 to 5 pm review"
//   "on Friday ...", "on November 20 ...", "today ...", "this day ...", "coming Tuesday ...",
//   "second Saturday from now ..."
//   "keep that day as it is, except make these changes: 9 to 10 gym"  (modify: true)
//
// Output: { transcript, scope: 'standard' | 'day', date: 'YYYY-MM-DD' | null, modify: boolean,
//           items: [{ op: 'set' | 'remove', start, end, title, description }], warnings: [] }

import { addDays, dateKey, fromMinutes, startOfDay } from './time.js';
import { formatNotes, toTitleCase } from './text.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const HOUR_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
// Minute words only; bare "five"/"ten" are too ambiguous ("nine ten" could be 9:10 or 9 to 10).
const MINUTE_WORD = 'fifteen|twenty[ -]five|twenty|thirty[ -]five|thirty|forty[ -]five|forty|fifty[ -]five|fifty';

const KEYWORDS = 'cancel|remove|skip|delete|drop';
const SEPARATOR = String.raw`(?:[-–—]|\b(?:to|till|until|through)\b)`;
// Separates the end of one task from the start of the next when both sit in the gap.
const DELIMITER = /[,;.]|\b(?:and then|then|after that)\b/i;
const INTRO = /^.*\b(?:schedule|plan|agenda|tasks|routine|is|are|looks like|includes?)\b\s*:?/i;

function timePattern(n) {
  return `(?<!\\d)(?<h${n}>\\d{1,2})(?:[:.](?<m${n}>\\d{2}))?` +
    `(?:\\s*(?<ap${n}>[ap])\\.?\\s?m\\b\\.?)?(?!\\d)`;
}

const RANGE = `(?:\\b(?<kw1>${KEYWORDS})\\s+)?(?:from\\s+|at\\s+)?${timePattern(1)}` +
  `\\s*${SEPARATOR}\\s*${timePattern(2)}`;
const SINGLE = `(?:\\b(?<kw3>${KEYWORDS})\\s+)?\\bat\\s+${timePattern(3)}` +
  `(?:\\s+for\\s+(?<dn>\\d{1,3})\\s*(?<du>hours?|hrs?|minutes?|mins?)\\b)?`;
// A start-only task: "start at 6 am wake up", "begin at 7", "6 am wake up".
const START = `\\b(?:start|begin)(?:s|ing|ning)?\\s+(?:at\\s+)?${timePattern(4)}`;
const BARE_AMPM = `(?<!\\d)(?<h5>\\d{1,2})(?:[:.](?<m5>\\d{2}))?\\s*(?<ap5>[ap])\\.?\\s?m\\b\\.?`;
const TIME_RE = new RegExp(`(?:${RANGE})|(?:${SINGLE})|(?:${START})|(?:${BARE_AMPM})`, 'gi');

const pad2 = (n) => String(n).padStart(2, '0');
const hourValue = (w) => NUMBER_WORDS[w.toLowerCase()] ?? Number(w);
const minuteValue = (w) => w.split(/[ -]/).reduce((sum, x) => sum + (NUMBER_WORDS[x.toLowerCase()] ?? 0), 0);

/**
 * Makes speech-recognition output look like typed times:
 * "nine thirty" -> "9:30", "half past nine" -> "9:30", "for one hour" -> "for 1 hour",
 * "in the evening" -> "pm", "nine o'clock" -> "9:00", "nine to ten" -> "9 to 10".
 */
function normalize(raw) {
  // Bullets: a line starting with "-", "*" or "•" becomes "•", and the spoken word "bullet" too.
  let t = String(raw || '')
    .replace(/\r/g, '')
    .replace(/\n\s*[-*•]\s*/g, ' • ')
    .replace(/\n+/g, ' ')
    .replace(/\bbullet(?:\s+points?)?\b/gi, ' • ')
    .replace(/\s+/g, ' ')
    .trim();

  t = t
    .replace(/\bnoon\b/gi, '12 pm')
    .replace(/\bmidnight\b/gi, '12 am')
    // "a.m.", "p m", "a m" -> "am" / "pm"
    .replace(/\b(\d{1,2}(?::\d{2})?)\s*([ap])\s*\.?\s*m\b\.?/gi, '$1 $2m')
    .replace(/\b(\d{1,2}(?::\d{2})?)\s*(?:in the\s+)?morning\b/gi, '$1 am')
    .replace(/\b(\d{1,2}(?::\d{2})?)\s*(?:in the\s+)?(?:afternoon|evening|night)\b/gi, '$1 pm');

  // "half past nine", "quarter past nine", "quarter to nine"
  t = t
    .replace(new RegExp(`\\bhalf\\s+past\\s+(${HOUR_WORD}|\\d{1,2})\\b`, 'gi'),
      (_, h) => `${hourValue(h)}:30`)
    .replace(new RegExp(`\\bquarter\\s+past\\s+(${HOUR_WORD}|\\d{1,2})\\b`, 'gi'),
      (_, h) => `${hourValue(h)}:15`)
    .replace(new RegExp(`\\bquarter\\s+to\\s+(${HOUR_WORD}|\\d{1,2})\\b`, 'gi'),
      (_, h) => `${((hourValue(h) + 11) % 12) || 12}:45`);

  // "nine thirty", "9 forty five" -> "9:30", "9:45"
  t = t.replace(new RegExp(`\\b(${HOUR_WORD}|\\d{1,2})\\s+(${MINUTE_WORD})\\b`, 'gi'),
    (_, h, m) => `${hourValue(h)}:${pad2(minuteValue(m))}`);

  // Durations: "for one hour" -> "for 1 hour"
  t = t.replace(/\bfor\s+(an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,3})\s+(hours?|hrs?|minutes?|mins?)\b/gi,
    (_, n, unit) => `for ${/^an?$/i.test(n) ? 1 : hourValue(n)} ${unit}`);

  // Hour words in a time context: "from nine", "at nine", "to ten"
  t = t.replace(new RegExp(`\\b(from|at|between|until|till|to|by)\\s+(${HOUR_WORD})\\b`, 'gi'),
    (_, k, h) => `${k} ${hourValue(h)}`);
  // Hour words followed by a time marker: "nine to", "nine am", "nine o'clock"
  t = t.replace(new RegExp(
    `\\b(${HOUR_WORD})(?=\\s+(?:to|till|until|through|am|pm|a\\.?m\\.?|p\\.?m\\.?|o'?\\s?clock|past)\\b|\\s*[-–—])`,
    'gi',
  ), (_, h) => String(hourValue(h)));

  // Speech often hears "to" as "two" or "too" between two times: "9 two 10" -> "9 to 10"
  t = t.replace(/\b(\d{1,2})\s+(?:two|too)\s+(\d{1,2})\b/gi, '$1 to $2');

  t = t.replace(/\b(\d{1,2})\s*o'?\s?clock\b/gi, '$1:00');
  return t;
}

const monthIndex = (name) => MONTHS.indexOf(name.toLowerCase());

function withYear(monthIdx, day, today, match) {
  if (monthIdx < 0) return null;
  let d = new Date(today.getFullYear(), monthIdx, day);
  if (d.getMonth() !== monthIdx) return { date: null, match };
  if (d < today) d = new Date(today.getFullYear() + 1, monthIdx, day);
  return { date: d, match };
}

const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

/** Finds a day reference such as "tomorrow", "on Friday", "coming Tuesday", "November 20". */
function detectDay(text, today, viewDate = today) {
  const t = startOfDay(today);
  let m;
  if ((m = /\bday after tomorrow\b/i.exec(text))) return { date: addDays(t, 2), match: m[0] };
  if ((m = /\btomorrow\b/i.exec(text))) return { date: addDays(t, 1), match: m[0] };
  if ((m = /\b(?:today|tonight)\b/i.exec(text))) return { date: t, match: m[0] };
  // "this day" / "that day" mean the day the user is looking at.
  if ((m = /\b(?:this|that)\s+day\b/i.exec(text))) return { date: startOfDay(viewDate), match: m[0] };

  // "second Saturday from now": the Nth upcoming Saturday, counting from the next one after today.
  m = new RegExp(`\\b(first|second|third|fourth|fifth|\\d{1,2}(?:st|nd|rd|th))\\s+(?:(?:next|coming)\\s+)?(${WEEKDAYS.join('|')})\\b(?:\\s+from\\s+(?:now|today))?`, 'i').exec(text);
  if (m) {
    const n = ORDINAL_WORDS[m[1].toLowerCase()] ?? parseInt(m[1], 10);
    const target = WEEKDAYS.indexOf(m[2].toLowerCase());
    let diff = (target - t.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return { date: addDays(t, diff + 7 * (n - 1)), match: m[0] };
  }

  // "next Tuesday" when today is Tuesday means a week on; "coming Tuesday" means today.
  m = new RegExp(`\\b((?:next|coming|this)\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i').exec(text);
  if (m) {
    const target = WEEKDAYS.indexOf(m[2].toLowerCase());
    let diff = (target - t.getDay() + 7) % 7;
    if (m[1] && /^next/i.test(m[1]) && diff === 0) diff = 7;
    return { date: addDays(t, diff), match: m[0] };
  }

  m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i').exec(text);
  if (m) return withYear(monthIndex(m[1]), Number(m[2]), t, m[0]);

  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join('|')})\\b`, 'i').exec(text);
  if (m) return withYear(monthIndex(m[2]), Number(m[1]), t, m[0]);

  return null;
}

/** Hour/minute/am-pm -> minutes since midnight. Bare hours are guessed (7-11 am, 1-6 pm). */
function toClock(hStr, mStr, ap) {
  const h = Number(hStr);
  const min = mStr ? Number(mStr) : 0;
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    return ((h % 12) + (ap.toLowerCase() === 'p' ? 12 : 0)) * 60 + min;
  }
  if (h > 23) return null;
  if (h === 0 || h >= 13) return h * 60 + min; // 24-hour clock
  if (h === 12) return 720 + min;
  if (h <= 6) return (h + 12) * 60 + min; // "1 to 3" means afternoon
  return h * 60 + min; // 7-11 means morning
}

function rangeTimes(g) {
  const endAp = g.ap2;
  const end = toClock(g.h2, g.m2, endAp);
  let start;
  if (!g.ap1 && endAp) {
    // "9 to 10 pm": the start shares the end's half of the day when that makes sense.
    const sameHalf = toClock(g.h1, g.m1, endAp);
    start = sameHalf !== null && end !== null && sameHalf < end
      ? sameHalf
      : toClock(g.h1, g.m1, null);
  } else {
    start = toClock(g.h1, g.m1, g.ap1);
  }
  if (start === null || end === null) return null;
  let finalEnd = end;
  // A bare end hour that is not later than the start is most likely the afternoon ("11 to 1"),
  // unless that would not be later than the start either; then it is the next morning.
  if (!endAp && finalEnd <= start) {
    const shifted = finalEnd + 720;
    if (shifted > start && shifted < 1440) finalEnd = shifted;
  }
  // An end earlier on the clock than the start means the task runs past midnight ("11 pm to 7 am").
  return { start, end: finalEnd };
}

/** A start-only task: start and end are the same time. */
function pointTimes(g) {
  const start = g.h4 !== undefined
    ? toClock(g.h4, g.m4, g.ap4)
    : toClock(g.h5, g.m5, g.ap5);
  return start === null ? null : { start, end: start };
}

function singleTimes(g) {
  const start = toClock(g.h3, g.m3, g.ap3);
  if (start === null) return null;
  let duration = 60;
  if (g.dn) duration = Number(g.dn) * (/^h/i.test(g.du) ? 60 : 1);
  return { start, end: Math.min(start + duration, 1439) };
}

function cleanPhrase(s) {
  let t = s.replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = t;
    t = t
      .replace(/^(?:[,;:\-–—.]+|\b(?:and then|then|and|after that|also|is|are|for|on|i have|i've got|i got|will be)\b)\s*/i, '')
      .replace(/\s*(?:[,;:\-–—.]+|\b(?:and then|then|and|after that|also)\b)$/i, '')
      .trim();
  } while (t !== prev);
  return t;
}

/** "Gym: bring water" -> { title: "Gym", description: "bring water" } */
function splitTitle(phrase) {
  let p = phrase.trim();
  let description = '';
  let m;
  if ((m = /^(.*?)\s*\((.+)\)\s*$/.exec(p))) {
    p = m[1];
    description = m[2];
  } else if (
    (m = /^(.*?)[\s,]*\b(?:notes?|details?|description)\s*[:,-]\s*(.+)$/i.exec(p)) ||
    (m = /^(.*?)\s*:\s*(.+)$/.exec(p)) ||
    (m = /^(.*?)\s+[-–—]\s+(.+)$/.exec(p))
  ) {
    p = m[1];
    description = m[2];
  }
  return { title: toTitleCase(p), description: formatNotes(description) };
}

function splitGap(gap) {
  const d = DELIMITER.exec(gap);
  if (!d) return { head: gap, tail: '' };
  return { head: gap.slice(0, d.index), tail: gap.slice(d.index + d[0].length) };
}

// "keep the schedule for that day as it is, except make these changes: ..." -> the times after "except" change that day.
const KEEP = /\b(?:keep|retain)\b/i;
const EXCEPT = /\bexcept\b/i;
const CHANGE_LEAD = /^\s*[,:;.-]?\s*(?:and\s+)?(?:please\s+)?(?:make|do|apply)\s+(?:these|the|this|following|the following)?\s*(?:specific\s+|following\s+)?(?:changes?|edits?)\s*[,:;.-]?/i;

/**
 * options.today: the current date. options.viewDate: the day on screen (for "this day").
 * Output also has modify: true when the user asked to keep that day's schedule and change only some times.
 */
export function parseSpeech(transcript, { today = new Date(), viewDate = today } = {}) {
  const warnings = [];
  let text = normalize(transcript);
  let scope = 'standard';
  let date = null;

  const day = detectDay(text, today, viewDate);
  if (day) {
    if (day.date) {
      scope = 'day';
      date = dateKey(day.date);
      text = text.replace(day.match, ' ');
    } else {
      warnings.push('I could not understand that date, so these tasks went into the standard schedule.');
    }
  }

  let modify = false;
  if (KEEP.test(text)) {
    modify = true;
    const except = EXCEPT.exec(text);
    text = except
      ? text.slice(except.index + except[0].length)
      : text.replace(/\b(?:keep|retain)\b[^,.;:]*/i, ' ');
    text = text.replace(CHANGE_LEAD, ' ');
  }

  const matches = [...text.matchAll(TIME_RE)];
  if (matches.length === 0) {
    warnings.push(modify
      ? 'No changes found. Say which times to change after "except", for example: "except 9 to 10 gym".'
      : 'No times found. Try something like: "9 to 10 gym, 10 to 11 coding".');
    return { transcript, scope, date, modify, items: [], warnings };
  }

  const items = [];
  let prefix = cleanPhrase(text.slice(0, matches[0].index).replace(INTRO, ''));

  matches.forEach((m, i) => {
    const g = m.groups;
    const currentPrefix = prefix;
    const keyword = g.kw1 || g.kw3;
    const endOfMatch = m.index + m[0].length;
    const next = matches[i + 1];

    let bodyRaw;
    let nextPrefix = '';
    if (next) {
      const parts = splitGap(text.slice(endOfMatch, next.index));
      bodyRaw = parts.head;
      nextPrefix = parts.tail;
    } else {
      bodyRaw = text.slice(endOfMatch);
    }
    prefix = cleanPhrase(nextPrefix);

    const isRange = g.h1 !== undefined;
    let times;
    if (isRange) times = rangeTimes(g);
    else if (g.h3 !== undefined) times = singleTimes(g);
    else times = pointTimes(g);
    if (!times) {
      warnings.push(`I could not read the time "${m[0].trim()}".`);
      return;
    }

    const phrase = cleanPhrase(bodyRaw) || currentPrefix;
    const { title, description } = splitTitle(phrase);
    const op = keyword ? 'remove' : 'set';
    if (!title && op === 'set') warnings.push(`Task at ${fromMinutes(times.start)} has no name.`);

    items.push({
      op,
      start: fromMinutes(times.start),
      end: fromMinutes(times.end),
      title: title || (op === 'remove' ? 'Removed' : 'Untitled'),
      description,
    });
    if (op === 'set' && isRange && times.end === times.start) {
      warnings.push(`"${title || 'Task'}" starts and ends at the same time. Please check the times.`);
    }
  });

  return { transcript, scope, date, modify, items, warnings };
}
