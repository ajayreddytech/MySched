import './styles.css';
import {
  configured,
  watchAuth,
  signInWithGoogle,
  signOutUser,
  watchStandard,
  watchWeekend,
  watchSaturday,
  watchSunday,
  watchWeekday,
  watchWeeklyVersions,
  watchStartDate,
  ensureStartDate,
  watchDay,
  saveWeekdayVersion,
  saveDayChanges,
  saveDayFull,
  loadDay,
  deleteDayOverride,
} from './firebase.js';
import { parseSpeech } from './lib/parser.js';
import { parseStructured, looksStructured, describeWrites, aiInstructions } from './lib/plan.js';
import {
  resolveDay,
  applyChanges,
  sortItems,
  findOverlaps,
  pickItem,
  mergeDayDoc,
  pickChange,
  scheduleVersionFor,
  WEEKDAY_GROUPS,
  WEEKDAY_NAMES,
} from './lib/schedule.js';
import {
  dateKey,
  parseDateKey,
  addDays,
  startOfDay,
  formatTime,
  formatDayLong,
  formatDayShort,
  formatDayMonth,
  formatWeekday,
  isValidHHMM,
  isValidDateKey,
  isToday,
  toMinutes,
  nextWeekdayOnOrAfter,
} from './lib/time.js';

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const app = $('#app');
const dialog = $('#review');
const captureDialog = $('#capture');
const authSlot = $('#auth-slot');
const menuEl = $('#menu');
const menuPanel = $('#menu-panel');
const menuBtn = $('#menu-btn');
const toastEl = $('#toast');
const listeningBar = $('#listening');
const listeningText = $('#listening-text');
const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

const MIC_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>`;

// Must be declared before the boot code below, which calls render().

const state = {
  user: undefined, // undefined = checking, null = signed out, object = signed in
  standard: null, // null = loading; older Monday to Friday schedule (fallback) as an array of items
  weekend: undefined, // older combined Saturday and Sunday schedule: undefined = loading; null = none; array = items
  saturday: undefined, // older Saturday schedule: undefined = loading; null = not saved yet; array = items
  sunday: undefined, // older Sunday schedule, same as saturday
  // Older per-weekday schedules, keyed by getDay() (0 = Sunday): undefined = loading; null = not saved; array = items
  weekly: {},
  versions: undefined, // dated weekday schedules: undefined = loading; array of { dow, from, items }
  startDate: undefined, // first day the schedule was used ('YYYY-MM-DD'): undefined = loading
  dayDoc: undefined, // undefined = loading; null = no override; object = override
  viewDate: startOfDay(),
  unsubStandard: null,
  unsubWeekend: null,
  unsubSaturday: null,
  unsubSunday: null,
  unsubWeekly: [],
  unsubVersions: null,
  unsubStart: null,
  unsubDay: null,
  recognizer: null,
  draft: null, // review dialog state
  edit: null, // in-place editor state while editing a day
  capture: null, // add dialog state: { text }
  busy: false,
};

/* ---------- Boot ---------- */

if (!configured) {
  app.innerHTML = setupHTML();
} else {
  watchAuth((user) => {
    state.user = user;
    subscribe();
    render();
  });
  render();
  // Refresh the "now" highlight once a minute.
  setInterval(() => {
    if (state.user && isToday(state.viewDate)) render();
  }, 60_000);
}

/* ---------- Subscriptions (live sync across devices) ---------- */

function subscribe() {
  state.unsubStandard?.();
  state.unsubWeekend?.();
  state.unsubSaturday?.();
  state.unsubSunday?.();
  state.unsubWeekly.forEach((unsub) => unsub());
  state.unsubVersions?.();
  state.unsubStart?.();
  state.unsubDay?.();
  state.standard = null;
  state.weekend = undefined;
  state.saturday = undefined;
  state.sunday = undefined;
  state.weekly = {};
  state.versions = undefined;
  state.startDate = undefined;
  state.dayDoc = undefined;
  state.unsubStandard = null;
  state.unsubWeekend = null;
  state.unsubSaturday = null;
  state.unsubSunday = null;
  state.unsubWeekly = [];
  state.unsubVersions = null;
  state.unsubStart = null;
  state.unsubDay = null;
  if (!state.user) return;
  state.unsubStandard = watchStandard(
    state.user.uid,
    (items) => { state.standard = items; render(); },
    fail,
  );
  state.unsubWeekend = watchWeekend(
    state.user.uid,
    (items) => { state.weekend = items; render(); },
    fail,
  );
  state.unsubSaturday = watchSaturday(
    state.user.uid,
    (items) => { state.saturday = items; render(); },
    fail,
  );
  state.unsubSunday = watchSunday(
    state.user.uid,
    (items) => { state.sunday = items; render(); },
    fail,
  );
  for (let dow = 0; dow < 7; dow++) {
    state.unsubWeekly.push(watchWeekday(
      state.user.uid,
      dow,
      (items) => { state.weekly[dow] = items; render(); },
      fail,
    ));
  }
  state.unsubVersions = watchWeeklyVersions(
    state.user.uid,
    (versions) => { state.versions = versions; render(); },
    fail,
  );
  state.unsubStart = watchStartDate(
    state.user.uid,
    (startDate) => {
      if (startDate) {
        state.startDate = startDate;
      } else {
        // First use: today is the start date. It is recorded once and never changed.
        ensureStartDate(state.user.uid, todayKey()).catch(fail);
      }
      render();
    },
    fail,
  );
  subscribeDay();
}

const todayKey = () => dateKey(startOfDay());
const PAST_DAY_MESSAGE = 'Past days cannot be changed. Pick today or a later day.';

/** True for a day before the start date: those days have no data. */
const isBeforeStart = (date) => Boolean(state.startDate) && dateKey(date) < state.startDate;

/**
 * The standard schedule for one weekday (0 = Sunday) on a date. A dated version wins; otherwise the
 * older schedules are used: Saturday and Sunday fall back to the older weekend one, then Monday to Friday.
 */
function weekdaySchedule(dow, date = startOfDay()) {
  const version = scheduleVersionFor(state.versions || [], dow, dateKey(date));
  if (version) return version;
  if (state.weekly[dow]) return state.weekly[dow];
  if (dow === 6) return state.saturday ?? state.weekend ?? state.standard;
  if (dow === 0) return state.sunday ?? state.weekend ?? state.standard;
  return state.standard;
}

/** The standard schedule for a date. */
function baseFor(date) {
  return weekdaySchedule(date.getDay(), date);
}

function scheduleLoading() {
  return state.standard === null || state.weekend === undefined
    || state.saturday === undefined || state.sunday === undefined || state.dayDoc === undefined
    || state.versions === undefined || state.startDate === undefined
    || WEEKDAY_GROUPS.all.days.some((dow) => state.weekly[dow] === undefined);
}

function subscribeDay() {
  state.unsubDay?.();
  state.dayDoc = undefined;
  state.unsubDay = null;
  if (!state.user) return;
  state.unsubDay = watchDay(
    state.user.uid,
    dateKey(state.viewDate),
    (doc) => { state.dayDoc = doc; render(); },
    fail,
  );
}

/* ---------- Rendering ---------- */

function render() {
  renderAuth();
  renderMain();
  renderMenuEditLabel();
}

function avatarHTML(u) {
  if (u.photoURL) return `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`;
  const name = u.displayName || u.email || 'Account';
  return `<span>${esc(name.charAt(0).toUpperCase())}</span>`;
}

function renderAuth() {
  const u = state.user;
  document.body.classList.toggle('signed-in', Boolean(u));
  if (u === undefined) {
    authSlot.innerHTML = '';
  } else if (u === null) {
    authSlot.innerHTML = `<button class="link-btn" data-action="signin"><span class="long">Sign in with Google</span><span class="short">Sign in</span></button>`;
  } else {
    const name = u.displayName || u.email || 'Account';
    authSlot.innerHTML = `<button class="avatar-btn" data-action="signout" title="Sign out" aria-label="Signed in as ${esc(name)}. Click to sign out">${avatarHTML(u)}</button>`;
  }
  // Phone menu (the top bar shows it only on small screens): profile details at the top.
  const profile = $('#menu-profile');
  if (u) {
    const name = u.displayName || u.email || 'Account';
    const email = u.email && u.email !== name ? `<small>${esc(u.email)}</small>` : '';
    profile.innerHTML = `<span class="avatar">${avatarHTML(u)}</span><span class="menu-name"><strong>${esc(name)}</strong>${email}</span>`;
  } else {
    profile.innerHTML = '';
  }
}

function renderMain() {
  if (!configured) return;
  if (state.user === undefined) {
    app.innerHTML = `<p class="panel center">Loading…</p>`;
    return;
  }
  if (state.user === null) {
    app.innerHTML = heroHTML();
    return;
  }
  if (scheduleLoading()) {
    app.innerHTML = navHTML(null) + `<p class="panel center">Loading your schedule…</p>`;
    return;
  }
  if (state.edit) {
    app.innerHTML = navHTML(null) + editorHTML(state.edit);
    return;
  }
  if (isBeforeStart(state.viewDate)) {
    app.innerHTML = navHTML(null) + `<div class="panel center empty">No data is available.</div>`;
    return;
  }
  const day = resolveDay(baseFor(state.viewDate), state.dayDoc);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  app.innerHTML = navHTML(day) + timelineHTML(day.items, isToday(state.viewDate), nowMin);
}

/* ---------- In-place editor: all days, a group of days, one weekday, or one specific day ---------- */

// state.edit = { kind, date: 'YYYY-MM-DD', drafts, loading }
// kind: 'all' | 'weekdays' | 'weekends' (groups in WEEKDAY_GROUPS), 'dow:N' (one weekday, N = 0 Sunday … 6 Saturday),
// or 'day' (the specific date in e.date).
// A draft = { items, original, when, pickDate, pickMonth }: original is the normalised starting list, used to tell
// what changed; when is the chosen start option (see whenOptions) and pickDate / pickMonth hold its date or month.

const DOW_KINDS = WEEKDAY_NAMES.map((_, dow) => `dow:${dow}`);
// Monday first, as people usually read a week.
const WEEKDAY_KIND_ORDER = [1, 2, 3, 4, 5, 6, 0].map((dow) => `dow:${dow}`);
const KIND_LABEL = {
  all: WEEKDAY_GROUPS.all.label,
  weekdays: WEEKDAY_GROUPS.weekdays.label,
  weekends: WEEKDAY_GROUPS.weekends.label,
  ...Object.fromEntries(DOW_KINDS.map((k, dow) => [k, WEEKDAY_NAMES[dow]])),
};

/** The weekdays (getDay numbers) a weekly kind covers; null for a specific day. */
function kindDays(kind) {
  if (kind === 'day') return null;
  if (kind.startsWith('dow:')) return [Number(kind.slice(4))];
  return WEEKDAY_GROUPS[kind].days;
}

const draftKey = (e) => (e.kind === 'day' ? `day:${e.date}` : e.kind);
const currentDraft = () => (state.edit ? state.edit.drafts[draftKey(state.edit)] : null);
const normItems = (items) => JSON.stringify(sortItems(items.map(pickItem)));
const makeDraft = (items, isDay = false) => ({
  items,
  original: normItems(items),
  when: isDay ? 'once' : 'today',
  pickDate: todayKey(),
  pickMonth: todayKey().slice(0, 7),
});

/** Changes the chosen start option, or the date or month picked for it, of the open draft. */
function setDraftOption(patch) {
  const d = currentDraft();
  if (!d) return;
  Object.assign(d, patch);
  render();
}

/** The schedule a weekly kind starts from: its first weekday's schedule. */
function startingItems(kind) {
  return weekdaySchedule(kindDays(kind)[0]);
}

function renderMenuEditLabel() {
  const label = $('#menu-edit-label');
  if (label) label.textContent = state.edit ? 'Save schedules' : 'Edit schedules';
}

/** Opens the editor (or saves if it is already open). */
function toggleEdit() {
  if (!state.user) return toast('Sign in with Google first.');
  if (state.edit) return saveEdit();
  if (scheduleLoading()) return toast('Still loading your schedule…');
  state.edit = { kind: 'all', date: dateKey(state.viewDate), drafts: {}, loading: null };
  ensureDraft();
  render();
}

function discardEdit() {
  state.edit = null;
  render();
  toast('Edits discarded.');
}

/** Makes sure the chosen schedule has a draft; a specific day is read from Firestore first. */
function ensureDraft() {
  const e = state.edit;
  if (!e) return;
  const key = draftKey(e);
  if (e.drafts[key]) return;
  if (e.kind === 'day') {
    loadDayDraft(e, key);
  } else {
    e.drafts[key] = makeDraft(startingItems(e.kind).map(pickItem));
  }
}

/**
 * The date key a changed draft starts from, or null when the choice has no date yet.
 * Weekly schedules start on a date; a picked date or month is never in the past, and for one
 * weekday it moves to the first matching weekday on or after that date.
 */
function startKeyFor(key, d) {
  const today = todayKey();
  const notPast = (k) => (k > today ? k : today);
  if (key.startsWith('day:')) {
    const date = key.slice(4);
    const dow = parseDateKey(date).getDay();
    if (d.when === 'onward') return date;
    if (d.when === 'date') return d.pickDate ? nextWeekdayOnOrAfter(notPast(d.pickDate), dow) : null;
    if (d.when === 'month') return d.pickMonth ? nextWeekdayOnOrAfter(notPast(`${d.pickMonth}-01`), dow) : null;
    return null; // 'once' saves that one day instead
  }
  if (d.when === 'today') return today;
  if (d.when === 'date') return d.pickDate ? notPast(d.pickDate) : null;
  if (d.when === 'month') return d.pickMonth ? notPast(`${d.pickMonth}-01`) : null;
  return null;
}

const isOnceDay = (key, d) => key.startsWith('day:') && d.when === 'once';

/** The start options offered for the open editor, with their pickers. Specific days and weekly schedules differ. */
function whenOptions(e, d) {
  if (e.kind !== 'day') {
    return [
      { value: 'today', title: 'From today on', hint: 'Changes this schedule from today. Earlier days keep what they had.' },
      {
        value: 'date',
        title: 'From a date I pick',
        hint: 'Changes this schedule from the date you pick.',
        input: { type: 'date', field: 'pickDate', value: d.pickDate, min: todayKey(), label: 'Start date' },
      },
      {
        value: 'month',
        title: 'From a month I pick',
        hint: 'Changes this schedule from the start of the month you pick (from today, if that month has begun).',
        input: { type: 'month', field: 'pickMonth', value: d.pickMonth, min: todayKey().slice(0, 7), label: 'Start month' },
      },
    ];
  }
  const day = parseDateKey(e.date);
  const name = WEEKDAY_NAMES[day.getDay()];
  const when = formatDayMonth(day);
  return [
    { value: 'once', title: `Only ${name}, ${when}`, hint: 'Changes only this one day. Other days keep their schedule.' },
    {
      value: 'onward',
      title: `Every ${name} from ${when} on`,
      hint: `Every ${name} from this date on uses this schedule. Earlier ${name}s keep what they had.`,
    },
    {
      value: 'date',
      title: `Every ${name} from a date I pick`,
      hint: `Starts on the first ${name} on or after the date you pick.`,
      input: { type: 'date', field: 'pickDate', value: d.pickDate, min: todayKey(), label: 'Start date' },
    },
    {
      value: 'month',
      title: `Every ${name} from a month I pick`,
      hint: `Starts on the first ${name} of the month you pick (from today, if that month has begun).`,
      input: { type: 'month', field: 'pickMonth', value: d.pickMonth, min: todayKey().slice(0, 7), label: 'Start month' },
    },
  ];
}

async function loadDayDraft(e, key) {
  if (!state.user || e.loading === key) return;
  e.loading = key;
  render();
  try {
    const dayDoc = await loadDay(state.user.uid, e.date);
    if (state.edit !== e) return; // editor was closed meanwhile
    const day = resolveDay(baseFor(parseDateKey(e.date)), dayDoc);
    e.drafts[key] = makeDraft(day.items.map(pickItem), true);
  } catch (err) {
    fail(err);
  } finally {
    if (e.loading === key) e.loading = null;
    render();
  }
}

function scheduleEditorHTML(title, items) {
  const rows = items.map((it, i) => `
    <li class="slot editing">
      <div class="time-edit">
        <input type="time" data-idx="${i}" data-f="start" value="${esc(it.start)}" aria-label="Task ${i + 1} start time" />
        <span class="to">to</span>
        <input type="time" data-idx="${i}" data-f="end" value="${it.end && it.end !== it.start ? esc(it.end) : ''}" aria-label="Task ${i + 1} end time (leave blank for start only)" title="Leave blank for a start-only task" />
      </div>
      <div class="spine" aria-hidden="true"><span class="dot"></span></div>
      <article class="task edit-card">
        <input type="text" data-idx="${i}" data-f="title" value="${esc(it.title)}" placeholder="Task name" aria-label="Task ${i + 1} name" />
        <textarea rows="2" data-idx="${i}" data-f="description" placeholder="Notes (optional)" aria-label="Task ${i + 1} notes">${esc(it.description)}</textarea>
        <div class="deadline-row">
          <label class="deadline-field">
            <span>Deadline (optional)</span>
            <input type="date" data-idx="${i}" data-f="deadline" value="${esc(it.deadline || '')}" aria-label="Task ${i + 1} deadline" />
          </label>
          ${it.deadline ? `<button class="ghost small" data-action="edit-clear-deadline" data-idx="${i}">Clear deadline</button>` : ''}
        </div>
        <button class="ghost small danger" data-action="edit-del" data-idx="${i}">Remove task</button>
      </article>
    </li>`).join('');
  return `
    <section class="schedule-edit panel" aria-label="${esc(title)}">
      <header class="schedule-edit-head">
        <h2>${esc(title)}</h2>
      </header>
      <ol class="timeline editing-list">
        ${rows || '<li class="empty center">No tasks yet. Add one below.</li>'}
      </ol>
      <button class="ghost" data-action="edit-add">+ Add task</button>
    </section>`;
}

/** The start-option cards for the open draft: a radio for each option, with its date or month picker when chosen. */
function whenHTML(e, d) {
  const start = startKeyFor(draftKey(e), d);
  const startText = start ? `Starts ${formatDayLong(parseDateKey(start))}.` : 'Pick a date first.';
  const cards = whenOptions(e, d).map((o) => {
    const on = d.when === o.value;
    const picker = on && o.input
      ? `<input type="${o.input.type}" data-action="edit-pick" data-field="${o.input.field}" value="${esc(o.input.value)}" min="${o.input.min}" aria-label="${o.input.label}" />`
      : '';
    return `
      <div class="when-card${on ? ' on' : ''}">
        <label class="when-pick">
          <input type="radio" name="when" value="${o.value}" data-action="edit-when" ${on ? 'checked' : ''} />
          <span><strong>${esc(o.title)}</strong><small>${esc(on && o.input ? startText : o.hint)}</small></span>
        </label>
        ${picker}
      </div>`;
  }).join('');
  return `
    <p class="eyebrow">2 · When should it apply?</p>
    <div class="when-list" role="radiogroup" aria-label="When this applies">${cards}</div>`;
}

function editorHTML(e) {
  const isDay = e.kind === 'day';
  // Which schedule: chips, not a dropdown. Monday to Friday and the like come first, then each weekday.
  const kinds = ['all', 'weekdays', 'weekends', ...WEEKDAY_KIND_ORDER, 'day'];
  const chips = kinds.map((v) => {
    const label = v === 'day' ? 'Specific day' : KIND_LABEL[v];
    const on = e.kind === v;
    return `<button type="button" class="chip" data-action="edit-kind" data-value="${v}" aria-pressed="${on}">${label}</button>`;
  }).join('');
  const draft = currentDraft();
  let body;
  if (!draft) {
    body = `<p class="panel center empty">Loading…</p>`;
  } else {
    const title = isDay ? `Specific day: ${formatDayLong(parseDateKey(e.date))}` : KIND_LABEL[e.kind];
    body = scheduleEditorHTML(title, draft.items);
  }
  return `
    <section class="editor-bar panel">
      <div class="editor-speak">
        <button type="button" class="ghost" data-action="edit-speak" ${draft ? '' : 'disabled'}>${MIC_ICON}<span>Speak or type changes</span></button>
      </div>
      <div>
        <p class="eyebrow">1 · What to edit</p>
        <div class="scope-grid" role="group" aria-label="Schedule to edit">${chips}</div>
        ${isDay ? `
        <label class="field deadline-field day-pick">
          <span>Specific day</span>
          <input type="date" data-action="edit-date" value="${esc(e.date)}" aria-label="Specific day" />
        </label>` : ''}
      </div>
      ${draft ? whenHTML(e, draft) : ''}
    </section>
    ${body}
    <div class="editor-actions">
      <span class="spacer"></span>
      <button class="ghost" data-action="edit-discard">Discard</button>
      <button class="primary" data-action="edit-save">Save schedules</button>
    </div>`;
}

function editErrors(items, label) {
  const errors = [];
  items.forEach((it, i) => {
    const n = i + 1;
    if (!isValidHHMM(it.start)) errors.push(`${label}, task ${n}: set a start time.`);
    // An end earlier than the start is an overnight task (e.g. 11 pm to 7 am), which is allowed.
    const end = it.end || it.start;
    if (!isValidHHMM(end)) errors.push(`${label}, task ${n}: set a valid end time.`);
    if (!(it.title || '').trim()) errors.push(`${label}, task ${n}: give it a name.`);
  });
  return errors;
}

function draftLabel(key) {
  if (key.startsWith('day:')) return formatDayLong(parseDateKey(key.slice(4)));
  return KIND_LABEL[key];
}

async function saveEdit() {
  const e = state.edit;
  if (!e || state.busy) return;
  if (e.loading) return toast('Still loading that day…');
  // Only schedules that were actually changed are saved.
  const changed = Object.entries(e.drafts).filter(([, d]) => normItems(d.items) !== d.original);
  if (!changed.length) {
    state.edit = null;
    render();
    return toast('No changes to save.');
  }
  if (changed.some(([key]) => key.startsWith('day:') && key.slice(4) < todayKey())) {
    return toast(PAST_DAY_MESSAGE);
  }
  const missing = changed
    .filter(([key, d]) => !isOnceDay(key, d) && !startKeyFor(key, d))
    .map(([key]) => `${draftLabel(key)}: pick a date or month first.`);
  const errors = [...missing, ...changed.flatMap(([key, d]) => editErrors(d.items, draftLabel(key)))];
  if (errors.length) return toast(errors[0]);
  if (!state.user) return toast('Sign in first.');

  state.busy = true;
  try {
    const uid = state.user.uid;
    for (const [key, d] of changed) {
      const items = sortItems(d.items.map(pickItem));
      if (isOnceDay(key, d)) {
        await saveDayFull(uid, key.slice(4), items);
        continue;
      }
      // Weekly versions: a whole group or one weekday, or (for a specific day) that day's weekday.
      const days = key.startsWith('day:') ? [parseDateKey(key.slice(4)).getDay()] : kindDays(key);
      for (const dow of days) await saveWeekdayVersion(uid, dow, startKeyFor(key, d), items);
    }
    state.edit = null;
    render();
    toast(`Saved ${changed.map(([k]) => draftLabel(k)).join(', ')}.`);
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
  }
}

/** Dropdown or date changed in the editor. */
function editorPicked(field, value) {
  const e = state.edit;
  if (!e) return;
  if (field === 'kind') e.kind = value === 'day' ? 'day' : value;
  if (field === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    if (value < todayKey()) {
      toast(PAST_DAY_MESSAGE);
      return render();
    }
    e.date = value;
  }
  ensureDraft();
  render();
}

function heroHTML() {
  return `
    <section class="hero panel">
      <p class="eyebrow">MySched</p>
      <h1>Speak your schedule. See it at a glance.</h1>
      <p class="lead">Sign in with Google, tap + and speak or type your day, for example:
        <em>“9 to 10 gym, 10 to 11 coding, 1 to 2 pm lunch.”</em></p>
      <button class="primary" data-action="signin">Sign in with Google</button>
    </section>`;
}

function setupHTML() {
  return `
    <section class="hero panel">
      <h1>One setup step left</h1>
      <p class="lead">Add your Firebase web app keys to a <code>.env</code> file (see <code>.env.example</code>) and restart the dev server. On Netlify, add the same <code>VITE_FIREBASE_*</code> values under Site settings → Environment variables.</p>
    </section>`;
}

function navHTML(day) {
  const goToday = isToday(state.viewDate)
    ? ''
    : `<button class="ghost small" data-action="today">Go to Today</button>`;
  const reset = day?.custom
    ? `<button class="ghost small" data-action="reset-day">Reset this day</button>`
    : '';
  const actions = goToday || reset ? `<div class="nav-actions">${goToday}${reset}</div>` : '';
  return `
    <section class="day-nav panel">
      <button class="icon-btn" data-action="prev" aria-label="Previous day">‹</button>
      <div class="day-title">
        <p class="weekday">${esc(formatWeekday(state.viewDate))}</p>
        <h1>${esc(formatDayMonth(state.viewDate))}</h1>
      </div>
      <button class="icon-btn" data-action="next" aria-label="Next day">›</button>
      ${actions}
    </section>`;
}

/** Notes: one line per bullet point; plain notes keep their line breaks. */
function notesHTML(text) {
  if (!text) return '';
  const lines = text.split('\n');
  if (!lines.some((l) => l.startsWith('• '))) {
    return `<p class="notes-text">${lines.map(esc).join('<br>')}</p>`;
  }
  return `<ul class="notes-list">${lines
    .map((l) => (l.startsWith('• ')
      ? `<li>${esc(l.slice(2))}</li>`
      : `<li class="plain">${esc(l)}</li>`))
    .join('')}</ul>`;
}

const STATUS_TAG = {
  changed: '<span class="tag changed">Changed</span>',
  new: '<span class="tag new">Added</span>',
  custom: '<span class="tag custom">Custom day</span>',
};

function timelineHTML(items, today, nowMin) {
  if (!items.length) {
    return `<div class="panel center empty">Nothing planned for this day. Tap + to add your day by voice or text.</div>`;
  }
  return `
    <ol class="timeline" aria-label="Schedule">
      ${items
        .map((i) => {
          const s = toMinutes(i.start);
          const e = toMinutes(i.end || i.start);
          const overnight = e < s;
          const isNow = today && (overnight ? nowMin >= s || nowMin < e : nowMin >= s && nowMin < e);
          const endText = i.end && i.end !== i.start
            ? `<span class="to">to ${formatTime(i.end)}${overnight ? ' <em>next day</em>' : ''}</span>`
            : '';
          return `
            <li class="slot${isNow ? ' now' : ''}">
              <div class="time">
                <span class="from">${formatTime(i.start)}</span>
                ${endText}
              </div>
              <div class="spine" aria-hidden="true"><span class="dot"></span></div>
              <article class="task">
                <h2>${esc(i.title)}</h2>
                ${notesHTML(i.description)}
                ${i.deadline ? `<p class="deadline-tag">Deadline: ${esc(formatDayShort(parseDateKey(i.deadline)))}</p>` : ''}
                ${STATUS_TAG[i.status] || ''}
              </article>
            </li>`;
        })
        .join('')}
    </ol>`;
}

/* ---------- Auth & day actions ---------- */

async function signIn() {
  try {
    await signInWithGoogle();
  } catch (err) {
    if (!['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(err.code)) fail(err);
  }
}

function setViewDate(d) {
  if (state.edit && !confirm('Discard your unsaved edits to this day?')) return;
  state.edit = null;
  state.viewDate = startOfDay(d);
  subscribeDay();
  render();
}

async function resetDay() {
  if (!state.user) return;
  if (!confirm('Remove the custom changes for this day and go back to the standard schedule?')) return;
  try {
    await deleteDayOverride(state.user.uid, dateKey(state.viewDate));
    toast('Back to the standard schedule for this day.');
  } catch (err) {
    fail(err);
  }
}

/* ---------- Voice ---------- */

/**
 * Listens until the user taps stop. Browsers end recognition on their own after a pause,
 * so this restarts it and keeps everything said so far.
 * Returns { stop() }. onDone receives the full transcript once listening has ended.
 */
function startListening({ onLive, onDone }) {
  let committed = ''; // text from finished recognition sessions
  let interim = ''; // text still being recognised in the current session
  let stopRequested = false;
  let rec = null;

  const current = () => `${committed} ${interim}`.replace(/\s+/g, ' ').trim();

  const finish = () => {
    // Report the result first, so the UI reads the cleared recogniser when it re-renders.
    onDone(current());
    setListening(false);
  };

  const launch = () => {
    rec = new SpeechAPI();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) committed += ` ${r[0].transcript}`;
        else interim += r[0].transcript;
      }
      onLive?.(current());
    };

    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        stopRequested = true;
        toast('Microphone is blocked. Allow microphone access for this site and try again.');
      } else if (!['no-speech', 'aborted'].includes(e.error)) {
        toast(`Voice input stopped: ${e.error}`);
      }
    };

    rec.onend = () => {
      committed = current();
      interim = '';
      if (stopRequested) return finish();
      try {
        launch();
        rec.start();
      } catch {
        finish();
      }
    };
  };

  launch();
  rec.start();
  setListening(true);

  return {
    stop() {
      stopRequested = true;
      try {
        rec.stop();
      } catch {
        finish();
      }
    },
  };
}

function setListening(on) {
  listeningBar.hidden = !on;
  if (state.draft) {
    state.draft.listening = on;
    renderReview();
  }
  if (captureDialog.open) renderCapture();
}

/* ---------- Add dialog: speak or type, then build the schedule ---------- */

/** Speak or type changes for the schedule being edited. Only available inside the editor. */
function openCapture() {
  if (!state.user) return toast('Sign in with Google first.');
  if (!state.edit || !currentDraft()) return toast('Open Edit schedule first.');
  state.capture = { text: '' };
  renderCapture();
  if (!captureDialog.open) captureDialog.showModal();
}

function renderCapture() {
  const c = state.capture;
  if (!c) return;
  const listening = Boolean(state.recognizer);
  captureDialog.innerHTML = `
    <div class="review capture">
      <header>
        <h2>Speak or type your changes</h2>
        <p class="muted">Say or type the tasks to change, then tap <strong>Apply to schedule</strong>. A task at the same start time is replaced; others are added. Save when you are happy. For example: <em>“7 to 8 gym, 4 to 5 pm review”</em>.</p>
      </header>
      <textarea id="cap-text" rows="6" spellcheck="false" placeholder="Speak or type your changes, or paste the schedule from an AI.">${esc(c.text)}</textarea>
      <div id="cap-preview">${previewHTML()}</div>
      <details class="ai-help">
        <summary>Ask an AI for this format</summary>
        <p class="muted">Copy these instructions, give them to an AI with your request, then paste its answer above.</p>
        <pre>${esc(aiInstructions(new Date()))}</pre>
        <button type="button" class="ghost small" data-action="capture-copy-ai">Copy instructions</button>
      </details>
      <div class="capture-row">
        <button class="ghost${listening ? ' recording' : ''}" data-action="capture-mic" aria-pressed="${listening}">
          ${MIC_ICON}<span>${listening ? 'Stop listening' : 'Speak'}</span>
        </button>
        <span class="spacer"></span>
        <button class="ghost" data-action="capture-cancel">Cancel</button>
        <button class="primary" data-action="capture-build">Apply to schedule</button>
      </div>
    </div>`;
}

function toggleCaptureMic() {
  if (state.recognizer) {
    state.recognizer.stop();
    return;
  }
  if (!SpeechAPI) return toast('Voice input needs Chrome, Edge or Safari. Type your schedule instead.');
  state.recognizer = startListening({
    onLive: (text) => {
      state.capture.text = text;
      state.capture.plan = null; // spoken text changed, so any earlier check no longer applies
      const ta = captureDialog.querySelector('#cap-text');
      if (ta) ta.value = text;
      renderPreview();
    },
    onDone: (text) => {
      state.recognizer = null;
      if (text) state.capture.text = text;
      if (captureDialog.open) renderCapture();
    },
  });
}

function buildFromCapture() {
  const typed = captureDialog.querySelector('#cap-text')?.value ?? state.capture?.text ?? '';
  const text = typed.trim();
  if (state.recognizer) state.recognizer.stop();
  if (!text) return toast('Type or speak your changes first.');
  if (looksStructured(text)) {
    // Pasted or typed schedule: check it and show what would be saved. Nothing is saved yet.
    state.capture.text = text;
    state.capture.plan = parseStructured(text, new Date());
    renderPreview();
    return;
  }
  captureDialog.close();
  applyToEditor(text);
}

/** What the checked schedule will do, or the lines that stop it from saving. */
function previewHTML() {
  const p = state.capture?.plan;
  if (!p) return '';
  const notes = [
    ...p.errors.map((m) => ['error', m]),
    ...p.warnings.map((m) => ['warn', m]),
  ];
  const list = notes.length
    ? `<ul class="notes">${notes.map(([type, msg]) => `<li class="${type}">${esc(msg)}</li>`).join('')}</ul>`
    : '';
  if (p.errors.length) {
    return `${list}<p class="muted plan-note">Nothing was saved. Fix the lines above, then tap Apply to schedule again.</p>`;
  }
  const lines = describeWrites(p.writes).map((l) => `<li>${esc(l)}</li>`).join('');
  return `
    ${list}
    <div class="plan">
      <p class="eyebrow">This will save</p>
      <ul class="plan-list">${lines}</ul>
      <p class="muted plan-note">${p.taskCount} ${p.taskCount === 1 ? 'task' : 'tasks'} for each. Nothing is saved until you tap Save to schedule.</p>
      <button class="primary" data-action="capture-save">Save to schedule</button>
    </div>`;
}

function renderPreview() {
  const box = captureDialog.querySelector('#cap-preview');
  if (box) box.innerHTML = previewHTML();
}

/** Saves the checked schedule. Only possible when the check found no errors. */
async function saveCheckedSchedule() {
  const p = state.capture?.plan;
  if (!p || p.errors.length || state.busy) return;
  if (!state.user) return toast('Sign in first.');
  state.busy = true;
  try {
    const uid = state.user.uid;
    for (const w of p.writes) {
      if (w.type === 'day') {
        await saveDayFull(uid, w.date, w.items);
      } else {
        for (const dow of w.dows) await saveWeekdayVersion(uid, dow, w.from, w.items);
      }
    }
    captureDialog.close();
    state.edit = null;
    render();
    toast(`Saved ${p.taskCount} ${p.taskCount === 1 ? 'task' : 'tasks'} to your schedule.`);
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
  }
}

async function copyAiInstructions() {
  try {
    await navigator.clipboard.writeText(aiInstructions(new Date()));
    toast('Copied. Give it to your AI, then paste its answer here.');
  } catch {
    toast('Could not copy. Open "Ask an AI for this format" and copy the text.');
  }
}

/** Puts the spoken or typed tasks into the schedule open in the editor. Nothing is saved until Save schedules. */
function applyToEditor(text) {
  const d = currentDraft();
  if (!d) return toast('Open Edit schedule first.');
  const { items, warnings } = parseSpeech(text, { today: new Date(), viewDate: state.viewDate });
  const changes = items.map(pickChange);
  if (!changes.length) return toast(warnings[0] || "I didn't catch any tasks. Try again.");
  d.items = applyChanges(d.items, changes);
  render();
  toast(`Applied ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}. Check them, then tap Save schedules.`);
}

function respeak() {
  if (!SpeechAPI) return toast('Voice input is not supported here. Type in the box instead.');
  if (state.recognizer) {
    state.recognizer.stop();
    return;
  }
  state.recognizer = startListening({
    onLive: (text) => {
      state.draft.transcript = text;
      const ta = dialog.querySelector('#rv-text');
      if (ta) ta.value = text;
    },
    onDone: (text) => {
      state.recognizer = null;
      if (!state.draft) return;
      if (!text) return toast("I didn't catch anything. Try again.");
      state.draft.transcript = text;
      reparseDraft();
    },
  });
}

/* ---------- Review dialog ("Is this what you want?") ---------- */

/** Modes that change a standard schedule (every weekday or every weekend day), not one date. */
const isStandardMode = (mode) => ['standard', 'saturday', 'sunday'].includes(mode);

/** The schedule a date has now: its specific-day changes on top of its weekday schedule. */
async function currentDaySchedule(date) {
  const dayDoc = date === dateKey(state.viewDate) && state.dayDoc !== undefined
    ? state.dayDoc
    : await loadDay(state.user.uid, date);
  return resolveDay(baseFor(parseDateKey(date)), dayDoc).items;
}

const toRow = ({ op, start, end, title, description, deadline }) => ({ op, start, end, title, description, deadline });

/** Works out the review table from the text. "Keep that day, except ..." starts from the day's current schedule. */
async function draftFromText(transcript) {
  const parsed = parseSpeech(transcript, { today: new Date(), viewDate: state.viewDate });
  if (parsed.modify) {
    const date = parsed.date || dateKey(state.viewDate);
    const merged = applyChanges(await currentDaySchedule(date), parsed.items);
    return {
      mode: 'day-full',
      date,
      rows: merged.map((i) => ({ op: 'set', ...i })),
      warnings: parsed.warnings,
    };
  }
  return {
    mode: parsed.scope === 'day' ? 'day-patch' : 'standard',
    date: parsed.date || dateKey(state.viewDate),
    rows: parsed.items.map(toRow),
    warnings: parsed.warnings,
  };
}

async function openReview(transcript) {
  try {
    const built = await draftFromText(transcript);
    state.draft = { transcript, listening: false, showErrors: false, ...built };
  } catch (err) {
    return fail(err);
  }
  renderReview();
  if (!dialog.open) dialog.showModal();
}

async function reparseDraft() {
  if (!state.draft) return;
  try {
    Object.assign(state.draft, await draftFromText(state.draft.transcript), { showErrors: false });
  } catch (err) {
    return fail(err);
  }
  renderReview();
}

/** Rows that will actually be saved, plus any problems that block saving. */
function validate(d) {
  const errors = [];
  const items = [];
  if (!isStandardMode(d.mode) && !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) {
    errors.push('Pick a valid day.');
  } else if (!isStandardMode(d.mode) && d.date < todayKey()) {
    errors.push(PAST_DAY_MESSAGE);
  }
  d.rows.forEach((r, i) => {
    const n = i + 1;
    if (!isValidHHMM(r.start)) {
      errors.push(`Task ${n}: set a start time.`);
      return;
    }
    if (r.op === 'remove') {
      if (isStandardMode(d.mode)) {
        errors.push(`Task ${n}: removing a task only works for one day. Choose "Only change these times" or "Replace the whole day".`);
      } else if (d.mode === 'day-patch') {
        items.push({ op: 'remove', start: r.start, end: r.end || r.start, title: r.title, description: '' });
      }
      return;
    }
    if (!(r.title || '').trim()) errors.push(`Task ${n}: give it a name.`);
    // A blank end time means a start-only task (the end equals the start).
    // An end earlier than the start is an overnight task (e.g. 11 pm to 7 am), which is allowed.
    const end = r.end || r.start;
    if (!isValidHHMM(end)) errors.push(`Task ${n}: set a valid end time.`);
    items.push({ op: 'set', start: r.start, end, title: r.title, description: r.description, deadline: r.deadline });
  });
  return { errors, items };
}

/** What the day (or the standard schedule) will look like after saving, for overlap warnings. */
function previewItems(d) {
  const { items } = validate({ ...d, showErrors: false });
  const setRows = items.filter((r) => r.op === 'set');
  if (isStandardMode(d.mode)) return setRows.map(pickItem);
  const sameDay = state.dayDoc && d.date === dateKey(state.viewDate);
  const merged = mergeDayDoc(sameDay ? state.dayDoc : null, d.mode, items);
  return merged.mode === 'full' ? merged.items : applyChanges(baseFor(parseDateKey(d.date)), merged.changes);
}

function warningsHTML(d) {
  const notes = [];
  d.warnings.forEach((w) => notes.push(['info', w]));
  findOverlaps(previewItems(d)).forEach(([a, b]) => {
    notes.push(['warn', `"${a.title}" and "${b.title}" overlap around ${formatTime(b.start)}.`]);
  });
  if (d.showErrors) validate(d).errors.forEach((e) => notes.push(['error', e]));
  if (!notes.length) return '';
  return `<ul class="notes">${notes.map(([type, msg]) => `<li class="${type}">${esc(msg)}</li>`).join('')}</ul>`;
}

function radio(value, label, current) {
  return `<label class="radio"><input type="radio" name="mode" value="${value}" ${current === value ? 'checked' : ''} /> ${label}</label>`;
}

function rowHTML(r, i) {
  return `
    <div class="row${r.op === 'remove' ? ' is-remove' : ''}">
      <span class="row-num" aria-hidden="true">${i + 1}</span>
      <select data-idx="${i}" data-field="op" aria-label="Task ${i + 1} type">
        <option value="set" ${r.op !== 'remove' ? 'selected' : ''}>Set</option>
        <option value="remove" ${r.op === 'remove' ? 'selected' : ''}>Remove</option>
      </select>
      <input type="time" data-idx="${i}" data-field="start" value="${esc(r.start)}" aria-label="Task ${i + 1} start" />
      <input type="time" data-idx="${i}" data-field="end" value="${r.end && r.end !== r.start ? esc(r.end) : ''}" aria-label="Task ${i + 1} end (leave blank for start only)" title="Leave blank for a start-only task" />
      <input type="text" data-idx="${i}" data-field="title" value="${esc(r.title)}" placeholder="Task" aria-label="Task ${i + 1} name" />
      <textarea rows="2" data-idx="${i}" data-field="description" placeholder="Notes (optional). Put each bullet on its own line." aria-label="Task ${i + 1} notes">${esc(r.description)}</textarea>
      <button class="icon-btn small" data-action="rv-del" data-idx="${i}" aria-label="Delete task ${i + 1}">✕</button>
    </div>`;
}

function renderReview() {
  const d = state.draft;
  if (!d) return;
  const isDay = !isStandardMode(d.mode);
  const dayLabel = isDay ? formatDayLong(parseDateKey(d.date)) : '';
  dialog.innerHTML = `
    <div class="review">
      <header>
        <h2>Is this what you want?</h2>
        <p class="muted">Check the tasks, edit anything, re-speak, or submit.</p>
      </header>
      ${d.listening ? `<div class="live-banner"><span class="pulse" aria-hidden="true"></span> Listening… tap 🎙 Re-speak again to stop.</div>` : ''}
      <label class="field">
        <span>What I heard</span>
        <textarea id="rv-text" rows="2" spellcheck="false">${esc(d.transcript)}</textarea>
      </label>
      <div class="toolbar">
        <button class="ghost small" data-action="rv-reparse">Rebuild the table from the text</button>
      </div>
      <fieldset class="apply">
        <legend>Apply as</legend>
        ${radio('standard', 'Monday to Friday', d.mode)}
        ${radio('saturday', 'Saturday', d.mode)}
        ${radio('sunday', 'Sunday', d.mode)}
        ${radio('day-patch', 'Only change these times on one day', d.mode)}
        ${radio('day-full', 'Replace the whole day', d.mode)}
      </fieldset>
      ${isDay ? `
        <label class="field inline">
          <span>Day</span>
          <input type="date" id="rv-date" value="${esc(d.date)}" aria-label="Day" />
          <small class="muted">${esc(dayLabel)}</small>
        </label>` : ''}
      <div class="rows">
        <div class="row head" aria-hidden="true"><span>#</span><span>Type</span><span>Start</span><span>End</span><span>Task</span><span>Notes</span><span></span></div>
        ${d.rows.map((r, i) => rowHTML(r, i)).join('') || '<p class="muted">No tasks yet. Add one below.</p>'}
      </div>
      <button class="ghost small" data-action="rv-add">+ Add a task</button>
      <div id="rv-warnings">${warningsHTML(d)}</div>
      <footer>
        <button class="ghost" data-action="rv-speak">🎙 Re-speak</button>
        <span class="spacer"></span>
        <button class="ghost" data-action="rv-cancel">Cancel</button>
        <button class="primary" data-action="rv-submit">Submit</button>
      </footer>
    </div>`;
}

function refreshWarnings() {
  const box = dialog.querySelector('#rv-warnings');
  if (box && state.draft) box.innerHTML = warningsHTML(state.draft);
}

/** Saves one schedule for each of the given weekdays, from today on. */
const saveWeekdays = (uid, days, items) => Promise.all(days.map((dow) => saveWeekdayVersion(uid, dow, todayKey(), items)));

async function submitDraft() {
  const d = state.draft;
  if (!d || state.busy) return;
  d.showErrors = true;
  const { errors, items } = validate(d);
  if (errors.length) {
    renderReview();
    return;
  }
  if (!state.user) return toast('Sign in first.');

  state.busy = true;
  try {
    const uid = state.user.uid;
    const standardItems = sortItems(items.map(pickItem));
    if (d.mode === 'standard') {
      await saveWeekdays(uid, WEEKDAY_GROUPS.weekdays.days, standardItems);
    } else if (d.mode === 'saturday') {
      await saveWeekdays(uid, [6], standardItems);
    } else if (d.mode === 'sunday') {
      await saveWeekdays(uid, [0], standardItems);
    } else {
      await saveDayChanges(uid, d.date, d.mode, items);
    }
    dialog.close();
    state.draft = null;
    if (d.mode === 'standard') {
      toast('Monday to Friday schedule saved. It applies to every weekday without a custom change.');
    } else if (isStandardMode(d.mode)) {
      toast(`${d.mode === 'saturday' ? 'Saturday' : 'Sunday'} schedule saved. It applies to every ${d.mode} without a custom change.`);
    } else {
      const target = parseDateKey(d.date);
      if (dateKey(target) !== dateKey(state.viewDate)) setViewDate(target);
      toast(`Saved for ${formatDayLong(target)}.`);
    }
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
  }
}

/* ---------- Event wiring ---------- */

/* Phone menu: the top bar's edit, add and account buttons move into it on small screens. */
function setMenu(open) {
  menuPanel.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
}

const handlers = {
  signin: () => signIn(),
  signout: () => {
    setMenu(false);
    return signOutUser().then(() => toast('Signed out.')).catch(fail);
  },
  'menu-toggle': () => setMenu(menuPanel.hidden),
  'menu-edit': () => {
    setMenu(false);
    toggleEdit();
  },
  prev: () => setViewDate(addDays(state.viewDate, -1)),
  next: () => setViewDate(addDays(state.viewDate, 1)),
  today: () => setViewDate(new Date()),
  'reset-day': () => resetDay(),
  'rv-reparse': () => reparseDraft(),
  'rv-add': () => {
    state.draft.rows.push({ op: 'set', start: '09:00', end: '10:00', title: '', description: '' });
    renderReview();
  },
  'rv-del': (el) => {
    state.draft.rows.splice(Number(el.dataset.idx), 1);
    renderReview();
  },
  'edit-save': () => toggleEdit(),
  'edit-discard': () => discardEdit(),
  'edit-add': (el) => {
    currentDraft()?.items.push({ start: '09:00', end: '10:00', title: '', description: '' });
    render();
  },
  'edit-del': (el) => {
    currentDraft()?.items.splice(Number(el.dataset.idx), 1);
    render();
  },
  'edit-clear-deadline': (el) => {
    const item = currentDraft()?.items[Number(el.dataset.idx)];
    if (item) delete item.deadline;
    render();
  },
  'edit-kind': (el) => editorPicked('kind', el.dataset.value),
  'edit-speak': () => openCapture(),
  'rv-speak': () => respeak(),
  'capture-mic': () => toggleCaptureMic(),
  'capture-build': () => buildFromCapture(),
  'capture-cancel': () => captureDialog.close(),
  'capture-save': () => saveCheckedSchedule(),
  'capture-copy-ai': () => copyAiInstructions(),
  'rv-cancel': () => dialog.close(),
  'rv-submit': () => submitDraft(),
};

document.addEventListener('click', (e) => {
  if (!menuEl.contains(e.target)) setMenu(false);
  const el = e.target.closest('[data-action]');
  if (!el) return;
  handlers[el.dataset.action]?.(el, e);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuPanel.hidden) {
    setMenu(false);
    menuBtn.focus();
  }
});

dialog.addEventListener('input', (e) => {
  const t = e.target;
  if (!state.draft) return;
  if (t.id === 'rv-text') {
    state.draft.transcript = t.value;
    return;
  }
  if (t.dataset.field) {
    setItemField(state.draft.rows[Number(t.dataset.idx)], t.dataset.field, t.value);
    refreshWarnings();
  }
});

dialog.addEventListener('change', (e) => {
  const t = e.target;
  if (!state.draft) return;
  if (t.name === 'mode') {
    state.draft.mode = t.value;
    renderReview();
  } else if (t.id === 'rv-date') {
    state.draft.date = t.value;
    renderReview();
  } else if (t.dataset.field === 'op') {
    state.draft.rows[Number(t.dataset.idx)].op = t.value;
    renderReview();
  }
});

dialog.addEventListener('close', () => {
  if (state.recognizer) state.recognizer.stop();
  state.draft = null;
});

captureDialog.addEventListener('input', (e) => {
  if (e.target.id !== 'cap-text' || !state.capture) return;
  state.capture.text = e.target.value;
  // Text changed after the check: the preview no longer matches it, so drop it.
  if (state.capture.plan) {
    state.capture.plan = null;
    renderPreview();
  }
});
captureDialog.addEventListener('close', () => {
  if (state.recognizer) state.recognizer.stop();
  state.capture = null;
});

// Editor fields live inside #app, which is re-rendered; one listener on it survives re-renders.
app.addEventListener('input', (e) => {
  const t = e.target;
  if (!state.edit || !t.dataset.f) return;
  const d = currentDraft();
  if (d) setItemField(d.items[Number(t.dataset.idx)], t.dataset.f, t.value);
});

/** Sets a field; for a start-only task (end equal to start) the end follows the start. */
function setItemField(item, field, value) {
  if (field === 'start') {
    const startOnly = !item.end || item.end === item.start;
    item.start = value;
    if (startOnly) item.end = value;
    return;
  }
  item[field] = value;
}

app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.action === 'edit-date') editorPicked('date', t.value);
  if (t.dataset.action === 'edit-when') setDraftOption({ when: t.value });
  if (t.dataset.action === 'edit-pick') setDraftOption({ [t.dataset.field]: t.value });
  if (t.dataset.f === 'deadline') render(); // shows or hides the "Clear deadline" button
});

/* ---------- Helpers ---------- */

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

function fail(err) {
  console.error(err);
  const code = err?.code || '';
  let msg = err?.message || 'Something went wrong.';
  if (code === 'auth/unauthorized-domain') {
    msg = 'This domain is not allowed for sign-in. Add it in Firebase → Authentication → Settings → Authorized domains.';
  } else if (code === 'auth/popup-blocked') {
    msg = 'Your browser blocked the sign-in popup. Allow popups for this site and try again.';
  } else if (code === 'permission-denied' || code.endsWith('permission-denied')) {
    msg = 'Firestore blocked that request. Check your security rules and that you are signed in.';
  } else if (code === 'unavailable') {
    msg = "You're offline. Changes will sync when you reconnect.";
  }
  toast(msg);
}
