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

/* ---------- Weekday schedule: users/{uid}/schedule/standard (Monday to Friday) ---------- */

function standardRef(uid) {
  return doc(db, 'users', uid, 'schedule', 'standard');
}

export function watchStandard(uid, onData, onError) {
  return onSnapshot(
    standardRef(uid),
    (snap) => onData(snap.exists() ? snap.data().items || [] : []),
    onError,
  );
}

export function saveStandard(uid, items) {
  return setDoc(standardRef(uid), { items, updatedAt: serverTimestamp() });
}

/* ---------- Named schedules: users/{uid}/schedule/{name} ----------
 * standard = Monday to Friday, saturday, sunday, and weekend (an older combined Saturday and Sunday,
 * used only as a fallback until Saturday and Sunday have their own). */

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

export function saveSchedule(uid, name, items) {
  return setDoc(scheduleRef(uid, name), { items, updatedAt: serverTimestamp() });
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

export function saveSaturday(uid, items) {
  return saveSchedule(uid, 'saturday', items);
}

export function saveSunday(uid, items) {
  return saveSchedule(uid, 'sunday', items);
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
