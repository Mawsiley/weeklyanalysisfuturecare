# Database schema — futurecare-weekly

Firestore project: `mawsiley-db-2893` · path: `apps/futurecare-weekly/<collection>/<docId>`

| Collection | Doc ID | Fields | Read roles | Write roles |
|---|---|---|---|---|
| users | normalized phone | phone, name, role, active, salt, passwordHash, lastLoginAt | (server only) | (server only) |

Common fields on every doc: `createdAt`, `updatedAt`, `deleted`, `createdBy`, `updatedBy`.

## Indexes
| Collection group | Fields | State |
|---|---|---|
