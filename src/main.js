import './styles.css';
import {
  configured,
  watchAuth,
  signInWithGoogle,
  signOutUser,
  watchStandard,
  watchDay,
  saveStandard,
  saveDayChanges,
  saveDayFull,
  deleteDayOverride,
} from './firebase.js';
import { parseSpeech } from './lib/parser.js';
import { resolveDay, applyChanges, sortItems, findOverlaps, pickItem, mergeDayDoc } from './lib/schedule.js';
import {
  dateKey,
  parseDateKey,
  addDays,
  startOfDay,
  formatTime,
  formatDayLong,
  isValidHHMM,
  isToday,
  toMinutes,
} from './lib/time.js';

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const app = $('#app');
const dialog = $('#review');
const addBtn = $('#add-btn');
const captureDialog = $('#capture');
const authSlot = $('#auth-slot');
const toastEl = $('#toast');
const listeningBar = $('#listening');
const listeningText = $('#listening-text');
const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

const MIC_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>`;

// Must be declared before the boot code below, which calls render().
const EDIT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>`;
const SAVE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z"/></svg>`;

const state = {
  user: undefined, // undefined = checking, null = signed out, object = signed in
  standard: null, // null = loading; array of standard items
  dayDoc: undefined, // undefined = loading; null = no override; object = override
  viewDate: startOfDay(),
  unsubStandard: null,
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
  addBtn.disabled = true;
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
  state.unsubDay?.();
  state.standard = null;
  state.dayDoc = undefined;
  state.unsubStandard = null;
  state.unsubDay = null;
  if (!state.user) return;
  state.unsubStandard = watchStandard(
    state.user.uid,
    (items) => { state.standard = items; render(); },
    fail,
  );
  subscribeDay();
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
  renderEditButton();
}

function renderAuth() {
  const u = state.user;
  if (u === undefined) {
    authSlot.innerHTML = '';
  } else if (u === null) {
    authSlot.innerHTML = `<button class="link-btn" data-action="signin"><span class="long">Sign in with Google</span><span class="short">Sign in</span></button>`;
  } else {
    const name = u.displayName || u.email || 'Account';
    const initial = esc(name.charAt(0).toUpperCase());
    const avatar = u.photoURL
      ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
      : `<span>${initial}</span>`;
    authSlot.innerHTML = `<button class="avatar-btn" data-action="signout" title="Sign out" aria-label="Signed in as ${esc(name)}. Click to sign out">${avatar}</button>`;
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
  if (state.standard === null || state.dayDoc === undefined) {
    app.innerHTML = navHTML(null) + `<p class="panel center">Loading your schedule…</p>`;
    return;
  }
  if (state.edit) {
    app.innerHTML = navHTML(null) + editorHTML(state.edit);
    return;
  }
  const day = resolveDay(state.standard, state.dayDoc);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  app.innerHTML = navHTML(day) + timelineHTML(day.items, isToday(state.viewDate), nowMin);
}

/* ---------- In-place editor ---------- */

function renderEditButton() {
  const btn = $('#edit-btn');
  if (!btn) return;
  const editing = Boolean(state.edit);
  btn.classList.toggle('editing', editing);
  btn.innerHTML = editing ? SAVE_ICON : EDIT_ICON;
  btn.setAttribute('aria-label', editing ? 'Save schedule' : 'Edit schedule');
  btn.title = editing ? 'Save schedule' : 'Edit schedule';
  btn.disabled = !configured || state.user === undefined;
}

/** Starts editing the day on screen (or stops and saves if already editing). */
function toggleEdit() {
  if (!state.user) return toast('Sign in with Google first.');
  if (state.edit) return saveEdit();
  if (state.standard === null || state.dayDoc === undefined) return toast('Still loading your schedule…');
  const day = resolveDay(state.standard, state.dayDoc);
  state.edit = {
    items: day.items.map(pickItem),
    // Editing a day with its own changes defaults to that day; a standard day defaults to every day.
    applyTo: day.custom ? 'day' : 'standard',
  };
  render();
}

function discardEdit() {
  state.edit = null;
  render();
  toast('Edits discarded.');
}

function editorHTML(e) {
  const dayText = formatDayLong(state.viewDate);
  const rows = e.items.map((it, i) => `
    <li class="slot editing">
      <div class="time-edit">
        <input type="time" data-idx="${i}" data-f="start" value="${esc(it.start)}" aria-label="Start time" />
        <span class="to">to</span>
        <input type="time" data-idx="${i}" data-f="end" value="${it.end && it.end !== it.start ? esc(it.end) : ''}" aria-label="End time (leave blank for start only)" title="Leave blank for a start-only task" />
      </div>
      <div class="spine" aria-hidden="true"><span class="dot"></span></div>
      <article class="task edit-card">
        <input type="text" data-idx="${i}" data-f="title" value="${esc(it.title)}" placeholder="Task name" aria-label="Task name" />
        <textarea rows="2" data-idx="${i}" data-f="description" placeholder="Notes (optional)" aria-label="Notes">${esc(it.description)}</textarea>
        <button class="ghost small danger" data-action="edit-del" data-idx="${i}">Remove task</button>
      </article>
    </li>`).join('');
  return `
    <section class="editor-bar panel">
      <div>
        <p class="eyebrow">Editing</p>
        <h1>${esc(dayText)}</h1>
      </div>
      <label class="field scope">
        <span>Apply changes to</span>
        <select data-action="edit-scope" aria-label="Apply changes to">
          <option value="day" ${e.applyTo === 'day' ? 'selected' : ''}>This day only</option>
          <option value="standard" ${e.applyTo === 'standard' ? 'selected' : ''}>Every day (standard schedule)</option>
        </select>
      </label>
    </section>
    <ol class="timeline editing-list" aria-label="Edit schedule">
      ${rows || '<li class="panel center empty">No tasks. Add one below.</li>'}
    </ol>
    <div class="editor-actions">
      <button class="ghost" data-action="edit-add">+ Add task</button>
      <span class="spacer"></span>
      <button class="ghost" data-action="edit-discard">Discard</button>
      <button class="primary" data-action="edit-save">Save schedule</button>
    </div>`;
}

function editErrors(items) {
  const errors = [];
  items.forEach((it, i) => {
    const n = i + 1;
    if (!isValidHHMM(it.start)) errors.push(`Task ${n}: set a start time.`);
    // An end earlier than the start is an overnight task (e.g. 11 pm to 7 am), which is allowed.
    const end = it.end || it.start;
    if (!isValidHHMM(end)) errors.push(`Task ${n}: set a valid end time.`);
    if (!(it.title || '').trim()) errors.push(`Task ${n}: give it a name.`);
  });
  return errors;
}

async function saveEdit() {
  const e = state.edit;
  if (!e || state.busy) return;
  const errors = editErrors(e.items);
  if (errors.length) return toast(errors[0]);
  if (!state.user) return toast('Sign in first.');

  const items = sortItems(e.items.map(pickItem));
  state.busy = true;
  try {
    if (e.applyTo === 'standard') {
      await saveStandard(state.user.uid, items);
      toast('Standard schedule saved. Days with their own changes keep those.');
    } else {
      await saveDayFull(state.user.uid, dateKey(state.viewDate), items);
      toast('Saved for this day.');
    }
    state.edit = null;
    render();
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
  }
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
        <h1>${esc(formatDayLong(state.viewDate))}</h1>
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

function openCapture() {
  if (!state.user) return toast('Sign in with Google first.');
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
        <h2>Add to your schedule</h2>
        <p class="muted">Speak it or type it, then tap <strong>Build schedule</strong>. For example: <em>“start at 6 am wake up, 7 to 8 gym, sleep 11 pm to 7 am”</em>.</p>
      </header>
      <textarea id="cap-text" rows="5" spellcheck="false" placeholder="Type your schedule, or tap Speak and say it.">${esc(c.text)}</textarea>
      <div class="capture-row">
        <button class="ghost${listening ? ' recording' : ''}" data-action="capture-mic" aria-pressed="${listening}">
          ${MIC_ICON}<span>${listening ? 'Stop listening' : 'Speak'}</span>
        </button>
        <span class="spacer"></span>
        <button class="ghost" data-action="capture-cancel">Cancel</button>
        <button class="primary" data-action="capture-build">Build schedule</button>
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
      const ta = captureDialog.querySelector('#cap-text');
      if (ta) ta.value = text;
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
  if (!text) return toast('Type or speak your schedule first.');
  captureDialog.close();
  openReview(text);
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

function draftFromText(transcript) {
  const parsed = parseSpeech(transcript, { today: new Date() });
  return {
    mode: parsed.scope === 'day' ? 'day-patch' : 'standard',
    date: parsed.date || dateKey(state.viewDate),
    rows: parsed.items.map(({ op, start, end, title, description }) => ({ op, start, end, title, description })),
    warnings: parsed.warnings,
  };
}

function openReview(transcript) {
  state.draft = { transcript, listening: false, showErrors: false, ...draftFromText(transcript) };
  renderReview();
  if (!dialog.open) dialog.showModal();
}

function reparseDraft() {
  if (!state.draft) return;
  Object.assign(state.draft, draftFromText(state.draft.transcript), { showErrors: false });
  renderReview();
}

/** Rows that will actually be saved, plus any problems that block saving. */
function validate(d) {
  const errors = [];
  const items = [];
  if (d.mode !== 'standard' && !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) {
    errors.push('Pick a valid day.');
  }
  d.rows.forEach((r, i) => {
    const n = i + 1;
    if (!isValidHHMM(r.start)) {
      errors.push(`Task ${n}: set a start time.`);
      return;
    }
    if (r.op === 'remove') {
      if (d.mode === 'standard') {
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
    items.push({ op: 'set', start: r.start, end, title: r.title, description: r.description });
  });
  return { errors, items };
}

/** What the day (or the standard schedule) will look like after saving, for overlap warnings. */
function previewItems(d) {
  const { items } = validate({ ...d, showErrors: false });
  const setRows = items.filter((r) => r.op === 'set');
  if (d.mode === 'standard') return setRows.map(pickItem);
  const sameDay = state.dayDoc && d.date === dateKey(state.viewDate);
  const merged = mergeDayDoc(sameDay ? state.dayDoc : null, d.mode, items);
  return merged.mode === 'full' ? merged.items : applyChanges(state.standard || [], merged.changes);
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
  const isDay = d.mode !== 'standard';
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
        ${radio('standard', 'Standard schedule (every day)', d.mode)}
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
    if (d.mode === 'standard') {
      await saveStandard(uid, sortItems(items.map(pickItem)));
    } else {
      await saveDayChanges(uid, d.date, d.mode, items);
    }
    dialog.close();
    state.draft = null;
    if (d.mode === 'standard') {
      toast('Standard schedule saved. It applies to every day without a custom change.');
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

const handlers = {
  signin: () => signIn(),
  signout: () => signOutUser().then(() => toast('Signed out.')).catch(fail),
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
  'edit-add': () => {
    state.edit.items.push({ start: '09:00', end: '10:00', title: '', description: '' });
    render();
  },
  'edit-del': (el) => {
    state.edit.items.splice(Number(el.dataset.idx), 1);
    render();
  },
  'rv-speak': () => respeak(),
  'capture-mic': () => toggleCaptureMic(),
  'capture-build': () => buildFromCapture(),
  'capture-cancel': () => captureDialog.close(),
  'rv-cancel': () => dialog.close(),
  'rv-submit': () => submitDraft(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  handlers[el.dataset.action]?.(el, e);
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

addBtn.addEventListener('click', () => openCapture());

captureDialog.addEventListener('input', (e) => {
  if (e.target.id === 'cap-text' && state.capture) state.capture.text = e.target.value;
});
captureDialog.addEventListener('close', () => {
  if (state.recognizer) state.recognizer.stop();
  state.capture = null;
});
$('#edit-btn').addEventListener('click', () => toggleEdit());

// Editor fields live inside #app, which is re-rendered; one listener on it survives re-renders.
app.addEventListener('input', (e) => {
  const t = e.target;
  if (!state.edit || !t.dataset.f) return;
  setItemField(state.edit.items[Number(t.dataset.idx)], t.dataset.f, t.value);
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
  if (state.edit && t.dataset.action === 'edit-scope') state.edit.applyTo = t.value;
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
