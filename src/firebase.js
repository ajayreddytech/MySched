import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  indexedDBLocalPersistence,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { mergeDayDoc } from './lib/schedule.js';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const configured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);

let auth = null;
let db = null;

if (configured) {
  const app = initializeApp(config);
  auth = getAuth(app);
  // Keep the sign-in session in IndexedDB rather than localStorage.
  setPersistence(auth, indexedDBLocalPersistence).catch((err) => console.error(err));
  // Firestore keeps an offline cache in IndexedDB and syncs it across devices.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
}

/* ---------- Auth ---------- */

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}

export function signOutUser() {
  return signOut(auth);
}

/* ---------- Schedules: users/{uid}/schedule/{name} ----------
 * Each weekday has its own document (sun, mon, … sat). Saving "All days", "Monday to Friday",
 * "Saturday and Sunday" or one weekday writes the matching documents.
 * Older documents are still read as fallbacks until a weekday has its own:
 * standard = Monday to Friday, saturday, sunday, and weekend (an older combined Saturday and Sunday). */

/** Document name for each weekday, indexed by JavaScript's getDay() (0 = Sunday). */
export const WEEKDAY_DOC = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function scheduleRef(uid, name) {
  return doc(db, 'users', uid, 'schedule', name);
}

/** Calls back with the items, or null when that schedule has not been saved yet. */
export function watchSchedule(uid, name, onData, onError) {
  return onSnapshot(
    scheduleRef(uid, name),
    (snap) => onData(snap.exists() ? snap.data().items || [] : null),
    onError,
  );
}

/** Watches the older schedule for one weekday (0 = Sunday … 6 = Saturday), used as a fallback. */
export function watchWeekday(uid, dow, onData, onError) {
  return watchSchedule(uid, WEEKDAY_DOC[dow], onData, onError);
}

/* ---------- Dated weekday versions: users/{uid}/weekly/{dow}_{from} ----------
 * A save writes a version that starts on a date. A day uses the latest version that starts on or
 * before it, so a save changes today and later days and leaves earlier days as they were. */

export function watchWeeklyVersions(uid, onData, onError) {
  return onSnapshot(
    collection(db, 'users', uid, 'weekly'),
    (snap) => onData(snap.docs.map((d) => d.data())),
    onError,
  );
}

/** Saves one weekday's schedule from the given date key ('YYYY-MM-DD') onwards. */
export function saveWeekdayVersion(uid, dow, from, items) {
  return setDoc(doc(db, 'users', uid, 'weekly', `${dow}_${from}`), {
    dow, from, items, updatedAt: serverTimestamp(),
  });
}

/* ---------- Start date: users/{uid}/settings/schedule { startDate } ----------
 * The first day the schedule was used. Days before it have no data. */

function startRef(uid) {
  return doc(db, 'users', uid, 'settings', 'schedule');
}

/** Calls back with the start date key, or null when it has not been recorded yet. */
export function watchStartDate(uid, onData, onError) {
  return onSnapshot(
    startRef(uid),
    (snap) => onData(snap.exists() ? snap.data().startDate ?? null : null),
    onError,
  );
}

/** Records the start date, but only if none is recorded yet. */
export function ensureStartDate(uid, startDate) {
  const ref = startRef(uid);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists() || !snap.data().startDate) {
      tx.set(ref, { startDate, updatedAt: serverTimestamp() }, { merge: true });
    }
  });
}

export function watchStandard(uid, onData, onError) {
  return onSnapshot(
    scheduleRef(uid, 'standard'),
    (snap) => onData(snap.exists() ? snap.data().items || [] : []),
    onError,
  );
}

export function watchWeekend(uid, onData, onError) {
  return watchSchedule(uid, 'weekend', onData, onError);
}

export function watchSaturday(uid, onData, onError) {
  return watchSchedule(uid, 'saturday', onData, onError);
}

export function watchSunday(uid, onData, onError) {
  return watchSchedule(uid, 'sunday', onData, onError);
}

/* ---------- Day overrides: users/{uid}/days/{YYYY-MM-DD} ---------- */

function dayRef(uid, key) {
  return doc(db, 'users', uid, 'days', key);
}

export function watchDay(uid, key, onData, onError) {
  return onSnapshot(
    dayRef(uid, key),
    (snap) => onData(snap.exists() ? snap.data() : null),
    onError,
  );
}

/** Reads the current day document and merges the new rows into it, atomically. */
export function saveDayChanges(uid, key, mode, rows) {
  const ref = dayRef(uid, key);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists() ? snap.data() : null;
    const next = mergeDayDoc(existing, mode, rows);
    tx.set(ref, { ...next, updatedAt: serverTimestamp() });
  });
}

/** Reads one day's override once (used by the editor's special-day picker). */
export async function loadDay(uid, key) {
  const snap = await getDoc(dayRef(uid, key));
  return snap.exists() ? snap.data() : null;
}

/** Replaces one whole day with the given list (used by the in-place editor). */
export function saveDayFull(uid, key, items) {
  return setDoc(dayRef(uid, key), { mode: 'full', items, updatedAt: serverTimestamp() });
}

export function deleteDayOverride(uid, key) {
  return deleteDoc(dayRef(uid, key));
}
