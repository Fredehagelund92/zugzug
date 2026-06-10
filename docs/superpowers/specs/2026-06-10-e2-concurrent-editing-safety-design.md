# E2 — Concurrent Editing Safety (optimistic concurrency v1)

**Date:** 2026-06-10
**Status:** Approved design, pending implementation plan
**Repo:** zugzug
**Branch (planned):** `e2-optimistic-concurrency`
**Epic:** [#55](https://github.com/Fredehagelund92/zugzug/issues/55)
**Relationship to E1 (#54):** Independent. E1 (live presence + cursors) requires a WebSocket layer this design does not. If E1 ships later, its `row_touched` invalidation can supplement this work (push-time conflict warning) but is not load-bearing.

## Problem

Today `renameCanonical` / `mergeCanonical` / `retireCanonical` / `addCanonical` (in `server/src/repo-canonical.ts`) are last-write-wins: two stewards saving the same canonical row concurrently lose data silently. With RBAC (PR #90) now opening the app to teams, this race becomes real. E2 v1 closes the gap without committing to the WebSocket presence infrastructure E1 needs.

## Decisions (locked during brainstorming)

1. **Scope = canonical row edits only.** Rename, retire, merge, add. Field-level edits, draft commits, and dimension schema (DDL) changes are out of scope.
2. **Optimistic concurrency via Postgres sidecar table.** New `canonical_version (dim_id, key, version, updated_at, updated_by)`. Single source of truth, even when `dim_X` lives in the warehouse. No `dim_X` DDL changes.
3. **Row-level granularity.** One version per canonical row. Any change bumps it. Conflict on any concurrent edit.
4. **Inline banner UX.** Conflict surface is a per-row banner above the row in TablePane: "This record was modified by [user] [time]. Your changes weren't saved." with `[Refresh]` + `[Keep editing]`. Non-blocking.
5. **No auto-merge.** Refresh always discards the user's pending edit. Manual control over recovery.

## Server: schema + repo changes

### New table

```ts
// server/drizzle/schema.ts
export const canonicalVersion = app.table(
  "canonical_version",
  {
    dim_id:     varchar("dim_id").notNull(),
    key:        varchar("key").notNull(),
    version:    integer("version").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    updated_by: varchar("updated_by").notNull(),  // semantically a users.id (no FK; matches existing convention in repo-canonical.ts)
  },
  (t) => [
    primaryKey({ columns: [t.dim_id, t.key] }),
    index("canonical_version_recent_idx").on(t.dim_id, t.updated_at),
  ],
);
```

The `(dim_id, updated_at)` index supports a future "recent activity for this dim" query without scanning the table.

### Backfill migration

Same Drizzle migration that creates the table also seeds version=1 for every existing canonical row. Loops every registered dimension via `dimension` table, reads its `dim_table` ref, then:

```sql
INSERT INTO canonical_version (dim_id, key, version, updated_at, updated_by)
SELECT $1, <key_col>, 1, now(), 'u_system'
FROM <dim_table>
ON CONFLICT (dim_id, key) DO NOTHING;
```

Idempotent — safe to re-run.

### Repo wrappers

All four mutation functions in `repo-canonical.ts` gain an `expectedVersion` parameter and wrap their existing logic in a transaction that does the version check FIRST. The version check is itself the row lock — if it returns 0 affected, the transaction aborts before touching `dim_X`.

**`renameCanonical(dimId, key, label, userId, expectedVersion)` — modified flow:**

The project's `pgTx` exposes `tx.all<T>(q, p)` returning row arrays and `tx.run(q, p)` returning `Promise<void>`. To detect "no rows updated" we use `tx.all(... RETURNING ...)` and check the array length — not `rowCount` (not exposed by the project's wrapper).

```ts
return pgTx(async (tx) => {
  const rows = await tx.all<{ version: number }>(
    `UPDATE canonical_version
        SET version = version + 1, updated_at = now(), updated_by = $1
      WHERE dim_id = $2 AND key = $3 AND version = $4
    RETURNING version`,
    [userId, dimId, key, expectedVersion],
  );
  if (rows.length === 0) {
    // Conflict — fetch the current version + updater for the 409 response.
    const cur = await tx.get<{ version: number; updated_at: string; updated_by: string }>(
      `SELECT cv.version, cv.updated_at, cv.updated_by, u.name, u.initials
         FROM canonical_version cv
         LEFT JOIN ${pg("users")} u ON u.id = cv.updated_by
        WHERE cv.dim_id = $1 AND cv.key = $2`,
      [dimId, key],
    );
    if (!cur) throw new NotFoundError(`canonical ${dimId}/${key}`);
    throw new ConflictError({
      version: cur.version,
      updatedAt: cur.updated_at,
      updatedBy: { id: cur.updated_by, name: cur.name, initials: cur.initials },
    });
  }
  await tx.run(`UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`, [label, key]);
  await appendAuditAs(userId, "Renamed canonical", `${key} → "${label}"`);
  return rows[0].version;
});
```

**`mergeCanonical(dimId, survivor, losers, userId, expectedVersions)`** — `expectedVersions: Record<string, number>` keyed by canonical key. Every key (survivor + each loser) must match. The version check is a single SQL statement:

```sql
WITH expected(key, expected_version) AS (
  VALUES ($1::text, $2::int), ($3::text, $4::int), ...
)
UPDATE canonical_version cv
   SET version = cv.version + 1, updated_at = now(), updated_by = $userId
  FROM expected e
 WHERE cv.dim_id = $dimId
   AND cv.key = e.key
   AND cv.version = e.expected_version
RETURNING cv.key;
```

If the returned key set is a strict subset of the expected key set → throw `ConflictError(conflictedKeys: missing[])`. The `throw` rolls back the surrounding `pgTx` transaction; the failed `UPDATE` itself does not roll back partial matches on its own.

**`retireCanonical(dimId, key, userId, expectedVersion)`** — same pattern. After successful version check + dim_X delete, also delete the `canonical_version` row (DELETE FROM canonical_version WHERE dim_id=$1 AND key=$2). Audit entry first, then deletion.

**`addCanonicalOne(dimId, key, label, userId)`** — no `expectedVersion`; new row. Insert into `dim_X` first (catches duplicate-key via existing UNIQUE), then insert into `canonical_version` with version=1. Same transaction.

### Conflict error

```ts
// server/src/errors.ts (extended)
export class ConflictError extends Error {
  constructor(public current: {
    version: number;
    updatedAt: string;
    updatedBy: { id: string; name: string; initials: string };
  }, public conflictedKeys?: string[]) {
    super("Conflict: record modified by another user");
  }
}
```

The route layer maps `ConflictError` to HTTP 409 with body:

```ts
{
  error: "conflict",
  current: { version, updatedAt, updatedBy: { id, name, initials } },
  conflictedKeys?: string[]  // populated for merge
}
```

## Server: API surface

Existing routes (verified against `server/src/server.ts:498-540`): `POST /api/dimensions/:id/canonical` (add), `POST /api/dimensions/:id/canonical/merge?confirm=true` (merge), `PUT /api/dimensions/:id/canonical/:key` (rename), `DELETE /api/dimensions/:id/canonical/:key` (retire). Keep the verbs; extend the bodies / responses.

| Verb | Path | Body | Success | Conflict |
|---|---|---|---|---|
| POST | `/api/dimensions/:id/canonical` | `{ key, label }` | 204 (existing — no body change) | n/a (UNIQUE on key handles duplicates, existing behavior) |
| PUT | `/api/dimensions/:id/canonical/:key` | `{ label, expectedVersion }` | 200 `{ version }` (new — was 204) | 409 `{ error, current }` |
| DELETE | `/api/dimensions/:id/canonical/:key?expectedVersion=N` | — | 200 `{ ok: true, variants: 0 }` (existing shape) | 409 `{ error, current }` |
| POST | `/api/dimensions/:id/canonical/merge?confirm=true` | `{ survivor, losers, expectedVersions }` | 200 `{ merged: N }` (existing shape) | 409 `{ error, conflictedKeys, current }` |

GET endpoints that return canonical values (`/api/dimensions/:dimId`) now include each row's `version` in the JSON. Existing consumers ignoring the new field continue to work.

## Client: store + UI

### Store (`app/src/store.ts`)

- `CanonicalValue` type gains `version: number`.
- Mutation functions thread `expectedVersion` into the request body / query string.
- The mutation API returns `{ version }` on success; the store updates the cached canonical row with the new version.
- On a 409 response: mutation function throws a typed `ConflictError` carrying the `current` payload.

### Conflict banner

A new `<ConflictBanner>` component:

```tsx
interface ConflictBannerProps {
  conflict: {
    updatedBy: { name: string; initials: string };
    updatedAt: string;
  };
  onRefresh: () => void;
  onKeepEditing: () => void;
}
```

Renders above the conflicted row inside TablePane. Copy:

> This record was modified by **Mia Berg** 12s ago. Your changes weren't saved.
> [Refresh row] [Keep editing]

`[Refresh row]` re-fetches the dimension (drops the user's pending edit) and dismisses the banner. `[Keep editing]` only dismisses the banner; the user's input stays in the cell and the next save will conflict again until refresh.

TablePane tracks conflicts in state: `Map<rowKey, ConflictMeta>`. The cell editor's `onCommit` calls `renameCanonical(...).catch(ConflictError → setConflict(rowKey, current))`. The bulk Remove + Merge dialogs catch the same way; for merge, the banner names the first conflicting key + "(and N others)" when multiple.

### Toolbar feedback

`useFlash` (from the v0.2 polish PR) surfaces a short "Conflict — see banner above" error toast on top of the inline banner, so users with the conflicting row scrolled off-screen still notice.

## Out of scope (explicit)

- **Field-level versioning.** Editing description while another user edits label is a row-level conflict in v1.
- **Draft commit conflicts.** Drafts are per-user; commits on overlapping raw values are still last-write-wins. Tracked separately.
- **Dimension field DDL changes** (color, description, type config). Same row-level version covers field VALUES on the canonical row; SCHEMA changes (adding a field) are deferred.
- **Auto-merge** on conflict. Always manual refresh.
- **WebSocket push invalidation.** E1's `row_touched` channel would cut conflict latency from "next save" to "as soon as the other user commits." This design works without it; E1 layered on top later is additive.
- **Merge conflicts on every loser** — server reports the FIRST conflicting key in the banner copy ("Mia modified 'Norway' 12s ago (and 2 others)"). Detailed per-key UI is over-scope for v1.

## File-level changes

```
server/drizzle/schema.ts                        MODIFIED — canonicalVersion table
server/drizzle/migrations/000N_e2_canonical_version.sql  GENERATED — create + backfill
server/src/errors.ts                            MODIFIED — ConflictError class
server/src/repo-canonical.ts                    MODIFIED — version checks in 4 mutation fns
server/src/server.ts                            MODIFIED — 409 mapping in 4 routes
server/test/canonical-version.test.ts           NEW — backfill idempotency, version bump
server/test/repo-canonical-conflict.test.ts     NEW — happy + conflict for 4 mutations
server/test/canonical-routes-conflict.test.ts   NEW — HTTP 409 shape
app/src/store.ts                                MODIFIED — version on CanonicalValue + threading
app/src/components/ConflictBanner.tsx           NEW
app/src/components/TablePane.tsx                MODIFIED — conflict state + banner rendering
app/test/conflict-banner.test.tsx               NEW
app/test/tablepane-conflict.test.tsx            NEW
```

## Verification gate

1. `cd server && bun run typecheck && bun run lint && bun run format:check && bun run test` — green. ~10-15 new tests.
2. `cd app && bun run typecheck && bun run lint && bun run format:check && bun run test` — green. ~5-8 new tests.
3. `bun run db:migrate` against a fresh DB → `canonical_version` table exists, empty.
4. `bun run db:migrate` against a DB with existing dim_X data → every row has version=1 in `canonical_version`. Re-run the migration → idempotent, no duplicates.
5. Manual: two browsers signed in as different users, both open the same dim. User A renames "Denmark" → "DK". User B (with stale version) tries to rename "Denmark" → "Danmark" → sees the conflict banner with A's name. Click Refresh → label shows "DK" and banner dismisses.
6. Manual: bulk Remove on a row another user just deleted → conflict banner on the row.
7. Manual: merge 5 records into one survivor while another user renames one of the losers → conflict banner names the loser ("Mia modified 'Norway' 3s ago").

## Risks worth flagging

- **Backfill on large dimensions.** The migration's `INSERT … SELECT … FROM dim_X` runs once per registered dimension. For a workspace with 50 dims each holding 100k rows, that's 5M inserts in one migration — slow but acceptable. If this trips production deploys, the migration can be re-split into a separate one-shot script.
- **Audit log timing.** Current `appendAuditAs` runs OUTSIDE the transaction. Keep that — if the audit insert fails the user's edit still committed. The conflict-error path explicitly does NOT audit (no edit happened).
- **Race in `addCanonicalOne` between dim_X UNIQUE check and `canonical_version` insert.** Since both happen in one transaction, the UNIQUE violation rolls back the whole tx. Safe.
- **Future field-level migration path.** Promoting to field-level later means evolving `version` from a single int to a per-field map. The sidecar's row-level shape doesn't lock us in — the column can be replaced or the table extended. Documented here for the next iteration.
- **No version on warehouse-resident dim_X.** Even in MotherDuck-writable mode, the dim_X table never gains a version column. The sidecar in Postgres remains authoritative. Users reading warehouse rows directly (dbt downstream) won't see the version — that's fine; warehouse-direct reads aren't a write surface.
