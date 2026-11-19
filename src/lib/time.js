const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as "YYYY-MM-DD" (used as the Firestore day id). */
export function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function isValidHHMM(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** "09:30" -> 570 */
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 570 -> "09:30" (wraps at 24h) */
export function fromMinutes(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** "09:30" -> "9:30 AM" */
export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${pad(m)} ${suffix}`;
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th", 18 -> "18th", 27 -> "27th" */
export function withOrdinal(n) {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

/** "18th November" (no year). */
export function formatDayMonth(d) {
  const month = d.toLocaleDateString(undefined, { month: 'long' });
  return `${withOrdinal(d.getDate())} ${month}`;
}

/** "Wednesday" */
export function formatWeekday(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long' });
}

/** "Wednesday, 18th November" (no year). */
export function formatDayLong(d) {
  return `${formatWeekday(d)}, ${formatDayMonth(d)}`;
}

export function isToday(d) {
  return dateKey(d) === dateKey(new Date());
}
