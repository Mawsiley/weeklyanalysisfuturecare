# Database schema — futurecare-weekly

Firestore project: `mawsiley-db-2893` · path: `apps/futurecare-weekly/<collection>/<docId>`
Accessed only through the Netlify Function `netlify/functions/api.js` (route `/api`); the browser never talks to Firestore directly.

## What is stored
Only app **settings** that used to live in each browser's `localStorage` — no patient data. The uploaded performance
files (patients, PTIDs, notes) are processed in the browser and never sent to the server.

| Collection | Doc ID | Fields | Read | Write |
|---|---|---|---|---|
| settings | localStorage key (`futurecare-…`), e.g. `futurecare-duty-v4`, `futurecare-doctor-directory-v1`, `futurecare-staff-tracker-v1`, `futurecare-cme-plan-v1`, `futurecare-duty-schedule-v3-approved-september` | `value` (JSON string, ≤ 300 000 chars), `rev` (number, +1 per write), `deleted` (bool), `createdAt`, `updatedAt` | team token | team token |

Not synced: `futurecare-theme-v1` (per-device theme), `futurecare-config-meta-v1` (local metadata), `fc-cloud-token`.

## API (`POST /api`, JSON `{ action, data }`)
| Action | Auth | Data | Result |
|---|---|---|---|
| `login` | — | `{ password }` | `{ token }` (HS256, 7 days) |
| `settings.getAll` | Bearer token | — | `{ items: { key: { value, rev, updatedAt } } }` |
| `settings.put` | Bearer token | `{ key, value }` (`value: null` marks the key deleted) | `{ key, rev }` |

Conflicts: last write wins per setting.

## Access
One team password. Only its PBKDF2-SHA512 hash (120 000 iterations) and salt are stored, in Netlify env
(`TEAM_PASSWORD_HASH`, `TEAM_PASSWORD_SALT`). The plain password is kept privately by the owner, outside the repo.

## Environment (Netlify)
`FIRESTORE_PROJECT_ID`, `FIRESTORE_CLIENT_EMAIL`, `FIRESTORE_PRIVATE_KEY`, `APP_NAMESPACE=futurecare-weekly`,
`SETTINGS_SESSION_SECRET`, `TEAM_PASSWORD_HASH`, `TEAM_PASSWORD_SALT`.

## Indexes
None required (`settings.getAll` reads the whole small collection without filters or ordering).

## Checks
- `node scripts/db-check.js futurecare-weekly` — connection test (uses the local service-account key).
- `node scripts/db-backup.js futurecare-weekly` — local JSON backup (keep it out of the repo).
