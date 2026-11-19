# MySched

A single-page web app to speak your daily schedule and see it at a glance. The look is a forest theme.

- **Sign in with Google**; your profile picture appears top-right. Click it to sign out.
- **Mic button** (left of your picture): say your day, review it in an "Is this what you want?" panel, edit or re-speak, then **Submit**.
- **Weekly schedules:** set one schedule for all days, for Monday to Friday, for Saturday and Sunday, or for each weekday on its own. Until you save a weekday, it uses the older weekday or weekend schedule.
- **Specific days** (say "tomorrow …", "on Friday …", "coming Tuesday …" or "November 24th …") change only the times you mention. All other days keep their weekly schedule.
- **Firestore** stores everything and syncs live across all your devices.
- **Netlify** hosts the static site.
- **Installable app:** on a phone, use Add to Home Screen (or the install prompt). It opens full screen like a native app. On a phone signed in, the top-right menu holds Profile, Edit schedule, Add to schedule and Sign out.

Stack: Vite, vanilla JavaScript, Firebase Auth (Google), Cloud Firestore, Web Speech API.

## 1. Firebase setup (one time)

1. Go to <https://console.firebase.google.com> and create a project.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
3. **Build → Firestore Database → Create database** (production mode).
4. **Firestore → Rules**: paste the contents of `firestore.rules` and publish. (Or run `npx firebase-tools deploy --only firestore:rules`.)
5. **Project settings → General → Your apps → Web (`</>`)**: register an app and copy the config values.
6. Copy `.env.example` to `.env` and fill in the values.

## 2. Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # parser and schedule unit tests
```

## 3. Deploy to Netlify

1. Push this folder to a Git repository, then **Netlify → Add new site → Import an existing project**. Netlify reads `netlify.toml` (build `npm run build`, publish `dist`, SPA redirect).
   You can also run `npx netlify-cli deploy --build --prod` from this folder.
2. **Site settings → Environment variables**: add each `VITE_FIREBASE_*` value from `.env`. Trigger a new deploy after adding them, because Vite bakes them in at build time.
3. **Firebase → Authentication → Settings → Authorized domains**: add your Netlify domain (for example `your-site.netlify.app`). Without this, Google sign-in is rejected.

## How to speak your schedule

The parser understands these patterns:

| You say | What happens |
| --- | --- |
| `9 to 10 gym, 10 to 11 coding` | Standard schedule (every day) |
| `from 9 am to 10:30 am gym: bring water` | Adds a note after the colon |
| `gym from 9 to 10, coding from 10 to 11` | Task name may come before the time |
| `at 9 am standup` | Single start time (1 hour long by default) |
| `9 to 10 pm party` | Evening times |
| `tomorrow 2 to 3 pm meeting` | Changes only that time on tomorrow |
| `on Friday cancel 4 to 5 pm review` | Removes that one task on Friday |
| `on November 25 …` | Changes on a specific date |
| `this day …`, `coming Tuesday …`, `second Saturday from now …` | Changes on the day you are viewing, the next Tuesday, or the second upcoming Saturday |
| `keep that day as it is, except make these changes: 9 to 10 gym` | Takes that day's current schedule, changes only the times listed, and shows the full day to confirm |

Speak with pauses between tasks. Each time range starts a new task, and the review panel lets you fix anything the parser got wrong.

**Apply as** in the review panel chooses how the result is saved:
- *Every weekday (Monday to Friday)* or *Every weekend day (Saturday and Sunday)*: replaces that weekly schedule.
- *Only change these times on one day*: keeps the standard schedule and changes only the listed times.
- *Replace the whole day*: that day shows only the tasks you list.

Use **Reset this day** to drop a day's changes and return to the standard schedule.

**Browser support:** voice input works in Chrome, Edge and Safari. Firefox has no speech recognition, so use the text box in the review panel instead.

## Data model (Firestore)

```
users/{uid}/schedule/{sun|mon|tue|wed|thu|fri|sat}   { items: [{start, end, title, description}], updatedAt }   (one per weekday)
users/{uid}/schedule/standard        { items: [...] }   (older Mon to Fri; fallback only)
users/{uid}/schedule/weekend         { items: [...] }   (older Sat and Sun; fallback only)
users/{uid}/days/{YYYY-MM-DD}        { mode: "patch", changes: [{op, start, end, title, description}] }
                                  or { mode: "full",  items: [...] }
```

Rules allow each signed-in user to read and write only their own `users/{uid}/…` documents.

## Notes on storage

- Nothing is written to `localStorage`.
- Sign-in state is kept by Firebase Auth in IndexedDB, so you stay signed in across reloads and tabs.
- Firestore's offline cache is also in IndexedDB, so the schedule still displays without a connection.
