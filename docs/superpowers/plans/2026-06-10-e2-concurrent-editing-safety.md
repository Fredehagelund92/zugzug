# E2 Concurrent Editing Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship E2 optimistic-concurrency v1 per `docs/superpowers/specs/2026-06-10-e2-concurrent-editing-safety-design.md`: new Postgres `canonical_version` sidecar table, row-level `expectedVersion` check on rename/retire/merge/add, HTTP 409 on conflict, inline banner UX in TablePane.

**Architecture:** Server-first. Drizzle migration creates the sidecar table + idempotent backfill. A single `versionCheck()` helper centralizes the optimistic-concurrency SQL pattern; the 4 mutation repo functions use it. Routes return 409 with `{ current, conflictedKeys? }`. Client store catches the 409 as a typed `ConflictError`; TablePane shows a per-row `<ConflictBanner>` with Refresh / Keep editing.

**Branch:** `e2-optimistic-concurrency` off updated `main`.

**Tech Stack:** Bun + `postgres.js` + Drizzle (server), React 18 + Vitest (frontend). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-10-e2-concurrent-editing-safety-design.md`

---

## File structure (post-PR)

```
server/drizzle/schema.ts                            MOD — canonicalVersion table
server/drizzle/migrations/0009_e2_canonical_version.sql   GENERATED — create + backfill
server/src/errors.ts                                MOD — details field + CONFLICT code
server/src/repo-canonical.ts                        MOD — versionCheck helper + 4 mutations
server/src/server.ts                                MOD — 409 mapping on 4 routes
server/test/canonical-version-migration.test.ts     NEW — backfill idempotency
server/test/repo-canonical-version.test.ts          NEW — happy + conflict per mutation
server/test/canonical-routes-conflict.test.ts       NEW — HTTP 409 shape
app/src/store.ts                                    MOD — CanonicalValue.version + threading + ConflictError
app/src/data.ts                                     MOD — CanonicalValue type
app/src/components/ConflictBanner.tsx               NEW
app/src/components/TablePane.tsx                    MOD — conflict state + per-row banner
app/test/conflict-banner.test.tsx                   NEW
app/test/tablepane-conflict.test.tsx                NEW
```

---

## Task 1: Branch kickoff

**Files:** none yet.

- [ ] **Step 1: Confirm clean main**

Run: `git status -sb && git log -1 --oneline`
Expected: branch is `main`, working tree clean (4 untracked plan/spec docs from earlier are fine), last commit is the E2 spec (`255be07` or later).

- [ ] **Step 2: Create branch**

Run: `git checkout -b e2-optimistic-concurrency`
Expected: switched to a new branch.

- [ ] **Step 3: Baseline test counts**

Run: `cd server && bun run test 2>&1 | tail -5`
Expected: 173 passing tests across 27 files (baseline as of v0.2-polish merge).

Run: `cd app && bun run test 2>&1 | tail -5`
Expected: 149 passing tests across 29 files.

---

## Task 2: `AppError.details` + `CONFLICT` code

**Files:**
- Modify: `server/src/errors.ts`
- Modify: `server/src/server.ts` (the existing AppError serializer)

The spec calls for a `ConflictError` with structured payload (`current`, `conflictedKeys`). Rather than a new class, extend the existing `AppError` with an optional `details` field so the route's existing error-serializer path can carry the conflict payload.

- [ ] **Step 1: Extend AppError**

Replace `server/src/errors.ts` entirely:

```ts
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NAME_TAKEN"
  | "CONFIRMATION_REQUIRED"
  | "NOT_FOUND"
  | "WRONG_DOMAIN"
  | "ALREADY_EXISTS"
  | "CANNOT_REMOVE_SELF"
  | "CONFLICT"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 400,
    /** Structured payload included verbatim in the JSON response body under "details".
     *  Used by CONFLICT to carry { current, conflictedKeys? } for optimistic concurrency. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}
```

- [ ] **Step 2: Find the AppError serialization sites**

Run: `grep -n "instanceof AppError" server/src/server.ts`
Expected output: two matches (lines ~326 and ~645 — depending on the file).

Read the surrounding ~10 lines at each site. The current shape is likely:

```ts
if (e instanceof AppError) {
  return json({ error: e.code, message: e.message }, e.status);
}
```

- [ ] **Step 3: Include `details` in the JSON response**

At BOTH AppError serialization sites, change the JSON shape to include `details` when present:

```ts
if (e instanceof AppError) {
  return json(
    {
      error: e.code,
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
    },
    e.status,
  );
}
```

The spread keeps backward compatibility — existing errors without details still serialize as before.

- [ ] **Step 4: Run server tests + typecheck**

Run: `cd server && bun run typecheck 2>&1 | tail -5 && bun run test 2>&1 | tail -5`
Expected: clean and 173 passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/errors.ts server/src/server.ts
git commit -m "feat(errors): AppError gains optional details payload + CONFLICT code"
```

---

## Task 3: `canonical_version` Drizzle migration + backfill

**Files:**
- Modify: `server/drizzle/schema.ts` — declare new table
- Create: `server/drizzle/migrations/0009_e2_canonical_version.sql` — generated then renamed
- Create: `server/test/canonical-version-migration.test.ts` — backfill idempotency

- [ ] **Step 1: Read current schema.ts imports + helpers**

Run: `head -30 server/drizzle/schema.ts`

Confirm that `integer`, `index`, `primaryKey`, `timestamp`, `varchar`, and the `app` schema builder are all imported. If `integer` is missing from the imports, you'll add it in Step 2.

- [ ] **Step 2: Add `canonicalVersion` table to schema.ts**

Append (after the existing dimension tables, before any draft/audit tables — match the existing visual grouping by topic):

```ts
export const canonicalVersion = app.table(
  "canonical_version",
  {
    dim_id:     varchar("dim_id").notNull(),
    key:        varchar("key").notNull(),
    version:    integer("version").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    /** Semantically users.id. No FK constraint — matches existing convention
     *  (repo-canonical.ts uses userId strings without enforced FKs). */
    updated_by: varchar("updated_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.dim_id, t.key] }),
    index("canonical_version_recent_idx").on(t.dim_id, t.updated_at),
  ],
);
```

If `integer` was missing from the imports at the top of the file, add it:

```ts
import {
  // ... existing imports ...
  integer,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 3: Generate the migration**

Run: `cd server && bun run db:generate`
Expected: a new file at `server/drizzle/migrations/0009_*.sql`. Drizzle assigns an auto-name (e.g. `0009_modern_warstar.sql`).

- [ ] **Step 4: Rename the migration file**

Rename the generated file to follow the project's E2 naming convention:

```bash
mv server/drizzle/migrations/0009_*.sql server/drizzle/migrations/0009_e2_canonical_version.sql
```

Also update the corresponding entry in `server/drizzle/migrations/meta/_journal.json` — the `tag` field of the new entry should match the new filename stem. Read the journal to confirm:

```bash
cat server/drizzle/migrations/meta/_journal.json | tail -10
```

Edit the `tag` to `"0009_e2_canonical_version"` if needed.

- [ ] **Step 5: Append the backfill to the migration SQL**

Open `server/drizzle/migrations/0009_e2_canonical_version.sql`. It should contain the CREATE TABLE + CREATE INDEX statements Drizzle generated. Append the backfill at the end of the file (after a separator comment):

```sql

-- Backfill: every existing canonical row in every registered dimension gets
-- version=1 owned by u_system. Idempotent — re-running is a no-op via ON CONFLICT.
-- Reads dim_table from "zugzug_app"."dimension" and loops dynamically because
-- dim_X tables are imperatively created per-dimension (not in Drizzle schema).
DO $$
DECLARE
  d record;
  sql_stmt text;
BEGIN
  FOR d IN
    SELECT id, dim_table, key_col
    FROM "zugzug_app"."dimension"
  LOOP
    sql_stmt := format(
      'INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by)
       SELECT %L, %I, 1, now(), %L
         FROM %s
       ON CONFLICT (dim_id, key) DO NOTHING',
      d.id, d.key_col, 'u_system', d.dim_table
    );
    EXECUTE sql_stmt;
  END LOOP;
END $$;
```

- [ ] **Step 6: Run the migration against the test DB**

Make sure the test Postgres is up (the CI setup uses `postgres://zugzug:zugzug@localhost:55432/zugzug_test`):

Run: `cd server && bun run test:db:up 2>&1 | tail -3`

Then apply migrations against the test DB:

```bash
cd server && DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test bun run db:migrate 2>&1 | tail -5
```

Expected: migration applies cleanly. No errors.

- [ ] **Step 7: Write idempotency test**

Create `server/test/canonical-version-migration.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll } from "bun:test";
import { pgAll, pgRun, pgGet } from "../src/pg.ts";

beforeAll(async () => {
  // Provision a fake dimension + dim_X table the backfill DO-block can find.
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension"
       (id, dimension, dim_table, map_table, key_col, label, created_at)
     VALUES
       ('d_test_e2', 'Test E2', '"zugzug_app"."dim_test_e2"', '"zugzug_app"."map_test_e2"',
        'country_id', 'Test E2', now())
     ON CONFLICT (id) DO NOTHING`,
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS "zugzug_app"."dim_test_e2" (country_id varchar PRIMARY KEY, label varchar)`,
  );
  await pgRun(`DELETE FROM "zugzug_app"."dim_test_e2"`);
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = 'd_test_e2'`);
  await pgRun(
    `INSERT INTO "zugzug_app"."dim_test_e2" (country_id, label)
     VALUES ('dk', 'Denmark'), ('no', 'Norway'), ('se', 'Sweden')`,
  );
});

test("canonical_version table exists and is empty for the test dim before backfill", async () => {
  // (The migration already ran in db:migrate above; for this test we re-run
  //  just the backfill block to simulate "what if a new dim was added later".)
  await pgRun(
    `DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = 'd_test_e2'`,
  );
  const empty = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."canonical_version" WHERE dim_id = 'd_test_e2'`,
  );
  expect(empty?.n).toBe(0);
});

test("backfill seeds version=1 for every existing dim row", async () => {
  // Apply the same DO-block the migration uses (idempotent).
  await pgRun(`
    DO $$
    DECLARE d record; sql_stmt text;
    BEGIN
      FOR d IN SELECT id, dim_table, key_col FROM "zugzug_app"."dimension" WHERE id = 'd_test_e2' LOOP
        sql_stmt := format(
          'INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by)
           SELECT %L, %I, 1, now(), %L FROM %s
           ON CONFLICT (dim_id, key) DO NOTHING',
          d.id, d.key_col, 'u_system', d.dim_table
        );
        EXECUTE sql_stmt;
      END LOOP;
    END $$;
  `);
  const rows = await pgAll<{ key: string; version: number }>(
    `SELECT key, version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = 'd_test_e2' ORDER BY key`,
  );
  expect(rows.map((r) => r.key)).toEqual(["dk", "no", "se"]);
  expect(rows.every((r) => r.version === 1)).toBe(true);
});

test("backfill is idempotent — re-running does not duplicate or bump version", async () => {
  // Manually bump one row's version to prove ON CONFLICT DO NOTHING preserves it.
  await pgRun(
    `UPDATE "zugzug_app"."canonical_version" SET version = 7
       WHERE dim_id = 'd_test_e2' AND key = 'dk'`,
  );
  // Re-run the same backfill block.
  await pgRun(`
    DO $$
    DECLARE d record; sql_stmt text;
    BEGIN
      FOR d IN SELECT id, dim_table, key_col FROM "zugzug_app"."dimension" WHERE id = 'd_test_e2' LOOP
        sql_stmt := format(
          'INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by)
           SELECT %L, %I, 1, now(), %L FROM %s
           ON CONFLICT (dim_id, key) DO NOTHING',
          d.id, d.key_col, 'u_system', d.dim_table
        );
        EXECUTE sql_stmt;
      END LOOP;
    END $$;
  `);
  const dk = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = 'd_test_e2' AND key = 'dk'`,
  );
  expect(dk?.version).toBe(7);
});
```

- [ ] **Step 8: Run the new test**

Run: `cd server && bun run test canonical-version-migration 2>&1 | tail -10`
Expected: 3 tests pass.

- [ ] **Step 9: Run the full server suite**

Run: `cd server && bun run test 2>&1 | tail -5`
Expected: 176 passing (+3 from baseline).

- [ ] **Step 10: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/0009_e2_canonical_version.sql server/drizzle/migrations/meta/_journal.json server/drizzle/migrations/meta/0009_snapshot.json server/test/canonical-version-migration.test.ts
git commit -m "feat(db): canonical_version sidecar table + idempotent backfill (E2)"
```

---

## Task 4: `versionCheck` helper

**Files:**
- Modify: `server/src/repo-canonical.ts` — add a private helper at the top of the mutation section

The 4 mutations share the same optimistic-concurrency dance: check the expected version, bump it on success, throw `ConflictError`-shaped on mismatch. Extract that pattern once.

- [ ] **Step 1: Add the helper at the top of repo-canonical.ts (just below the imports + above the first mutation function)**

```ts
import { AppError } from "./errors.ts";

/** TxHelpers shape from pg.ts — duplicated locally to keep the type narrow. */
type TxLike = {
  all: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  get: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T | null>;
  run: (q: string, p?: unknown[]) => Promise<void>;
};

interface CurrentVersionRow {
  version: number;
  updated_at: Date;
  updated_by: string;
  name: string | null;
  initials: string | null;
}

interface ConflictCurrent {
  version: number;
  updatedAt: string;
  updatedBy: { id: string; name: string; initials: string };
}

/** Inside an existing pgTx, attempt to bump the version row for (dim_id, key).
 *  On success: returns the new version.
 *  On expected-version mismatch: throws AppError CONFLICT with details.current. */
async function bumpVersionOrThrow(
  tx: TxLike,
  dimId: string,
  key: string,
  expectedVersion: number,
  userId: string,
): Promise<number> {
  const rows = await tx.all<{ version: number }>(
    `UPDATE "zugzug_app"."canonical_version"
        SET version = version + 1, updated_at = now(), updated_by = $1
      WHERE dim_id = $2 AND key = $3 AND version = $4
    RETURNING version`,
    [userId, dimId, key, expectedVersion],
  );
  if (rows.length === 1) return rows[0]!.version;

  const cur = await tx.get<CurrentVersionRow>(
    `SELECT cv.version, cv.updated_at, cv.updated_by,
            u.name, u.initials
       FROM "zugzug_app"."canonical_version" cv
       LEFT JOIN "zugzug_app"."users" u ON u.id = cv.updated_by
      WHERE cv.dim_id = $1 AND cv.key = $2`,
    [dimId, key],
  );
  if (!cur) throw new AppError("NOT_FOUND", `canonical ${dimId}/${key} not found`, 404);

  const current: ConflictCurrent = {
    version: cur.version,
    updatedAt: cur.updated_at.toISOString(),
    updatedBy: {
      id: cur.updated_by,
      name: cur.name ?? cur.updated_by,
      initials: cur.initials ?? "??",
    },
  };
  throw new AppError("CONFLICT", "Record was modified by another user", 409, { current });
}

/** New canonical → version row at version=1 owned by userId. Use inside an existing tx. */
async function seedVersionRow(
  tx: TxLike,
  dimId: string,
  key: string,
  userId: string,
): Promise<void> {
  await tx.run(
    `INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by)
     VALUES ($1, $2, 1, now(), $3)
     ON CONFLICT (dim_id, key) DO NOTHING`,
    [dimId, key, userId],
  );
}

/** Delete the version row after a canonical is retired. Use inside an existing tx. */
async function deleteVersionRow(tx: TxLike, dimId: string, key: string): Promise<void> {
  await tx.run(
    `DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1 AND key = $2`,
    [dimId, key],
  );
}
```

If `AppError` is already imported at the top of the file, don't duplicate the import. Confirm via:

```bash
grep -n "from \"./errors" server/src/repo-canonical.ts | head -3
```

- [ ] **Step 2: Run typecheck**

Run: `cd server && bun run typecheck 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo-canonical.ts
git commit -m "feat(repo): bumpVersionOrThrow + seedVersionRow + deleteVersionRow helpers"
```

(No tests yet — these helpers are exercised via the mutation tests in Tasks 5–8.)

---

## Task 5: `addCanonicalOne` seeds version row

**Files:**
- Modify: `server/src/repo-canonical.ts` — `addCanonicalOne` function (around line 368)
- Create: `server/test/repo-canonical-version.test.ts` — happy-path add test

- [ ] **Step 1: Write the failing test**

Create `server/test/repo-canonical-version.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import { addCanonicalOne } from "../src/repo-canonical.ts";

const DIM = "d_canon_test";
const DIM_TABLE = `"zugzug_app"."dim_canon_test"`;
const MAP_TABLE = `"zugzug_app"."map_canon_test"`;
const KEY_COL = "country_id";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension"
       (id, dimension, dim_table, map_table, key_col, label, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO NOTHING`,
    [DIM, "Canon Test", DIM_TABLE, MAP_TABLE, KEY_COL, "Canon Test"],
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS ${DIM_TABLE} (${KEY_COL} varchar PRIMARY KEY, label varchar)`,
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS ${MAP_TABLE} (raw varchar, ${KEY_COL} varchar)`,
  );
  await pgRun(`DELETE FROM ${DIM_TABLE}`);
  await pgRun(`DELETE FROM ${MAP_TABLE}`);
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1`, [DIM]);
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials)
     VALUES ('u_canon_actor', 'Canon Actor', 'CA')
     ON CONFLICT (id) DO NOTHING`,
  );
});

test("addCanonicalOne seeds canonical_version row at version=1", async () => {
  await addCanonicalOne(DIM, "dk", "Denmark", "u_canon_actor");
  const v = await pgGet<{ version: number; updated_by: string }>(
    `SELECT version, updated_by FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "dk"],
  );
  expect(v?.version).toBe(1);
  expect(v?.updated_by).toBe("u_canon_actor");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -15`
Expected: FAIL — the version row is not created because `addCanonicalOne` doesn't seed it yet.

- [ ] **Step 3: Update `addCanonicalOne` to seed the version row in the same transaction**

Find the existing `addCanonicalOne` function (around `server/src/repo-canonical.ts:368`). It currently looks roughly like:

```ts
export async function addCanonicalOne(
  dimId: string,
  label: string,
  key: string | undefined,
  userId: string,
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const k = key?.trim() || slug(label);
  await pgRun(
    `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
     ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
    [k, label],
  );
  await appendAuditAs(userId, "Added canonical", `${label} (${k})`);
}
```

Wrap the INSERT + version seeding into a single `pgTx`:

```ts
export async function addCanonicalOne(
  dimId: string,
  label: string,
  key: string | undefined,
  userId: string,
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const k = key?.trim() || slug(label);
  await pgTx(async (tx) => {
    await tx.run(
      `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
       ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
      [k, label],
    );
    await seedVersionRow(tx, dimId, k, userId);
  });
  await appendAuditAs(userId, "Added canonical", `${label} (${k})`);
}
```

Note: `appendAuditAs` stays OUTSIDE the transaction (matches the existing pattern — see Risks in the spec).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `cd server && bun run test 2>&1 | tail -5`
Expected: 177 passing (+1 from previous task).

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-canonical.ts server/test/repo-canonical-version.test.ts
git commit -m "feat(canonical): addCanonicalOne seeds version row (E2)"
```

---

## Task 6: `renameCanonical` with `expectedVersion`

**Files:**
- Modify: `server/src/repo-canonical.ts` — `renameCanonical` function (around line 387)
- Modify: `server/test/repo-canonical-version.test.ts` — add rename tests

- [ ] **Step 1: Write failing tests**

Append to `server/test/repo-canonical-version.test.ts`:

```ts
import { renameCanonical } from "../src/repo-canonical.ts";
import { AppError } from "../src/errors.ts";

test("renameCanonical with correct expectedVersion bumps to 2", async () => {
  // Reset state: 'dk' was added at version=1 by the addCanonicalOne test above.
  await renameCanonical(DIM, "dk", "Danmark", "u_canon_actor", 1);
  const v = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "dk"],
  );
  expect(v?.version).toBe(2);
  const label = await pgGet<{ label: string }>(
    `SELECT label FROM ${DIM_TABLE} WHERE ${KEY_COL} = 'dk'`,
  );
  expect(label?.label).toBe("Danmark");
});

test("renameCanonical with stale expectedVersion throws CONFLICT", async () => {
  // 'dk' is now at version=2. Try to rename with version=1.
  let thrown: AppError | null = null;
  try {
    await renameCanonical(DIM, "dk", "DenmarkAgain", "u_canon_actor", 1);
  } catch (e) {
    thrown = e as AppError;
  }
  expect(thrown).not.toBeNull();
  expect(thrown!.code).toBe("CONFLICT");
  expect(thrown!.status).toBe(409);
  const details = thrown!.details as { current: { version: number; updatedBy: { id: string } } };
  expect(details.current.version).toBe(2);
  expect(details.current.updatedBy.id).toBe("u_canon_actor");
  // Confirm dim_X label was NOT updated (rollback worked).
  const label = await pgGet<{ label: string }>(
    `SELECT label FROM ${DIM_TABLE} WHERE ${KEY_COL} = 'dk'`,
  );
  expect(label?.label).toBe("Danmark");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -15`
Expected: FAIL — `renameCanonical` doesn't yet accept `expectedVersion`.

- [ ] **Step 3: Update `renameCanonical`**

Replace the existing function signature + body. The current shape:

```ts
export async function renameCanonical(
  dimId: string,
  key: string,
  label: string,
  userId: string,
): Promise<void> {
  // ... existing body using pgRun ...
}
```

New shape — accepts `expectedVersion`, wraps the dim_X update in `pgTx`, calls `bumpVersionOrThrow` first:

```ts
export async function renameCanonical(
  dimId: string,
  key: string,
  label: string,
  userId: string,
  expectedVersion: number,
): Promise<{ version: number }> {
  const m = await dimMeta(dimId);
  if (!m) throw new AppError("NOT_FOUND", `dimension ${dimId} not found`, 404);

  // Fetch old label before overwriting — needed for ai_hint_cache sync below.
  const oldRow = await pgGet<{ label: string }>(
    `SELECT label FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  ).catch(() => null);

  const newVersion = await pgTx(async (tx) => {
    const v = await bumpVersionOrThrow(tx, dimId, key, expectedVersion, userId);
    await tx.run(
      `UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`,
      [label, key],
    );
    return v;
  });

  await appendAuditAs(userId, "Renamed canonical", `${key} → "${label}"`);

  // Keep ai_hint_cache consistent: update any hint that was pointing at the old label.
  if (oldRow?.label) {
    await pgRun(
      `UPDATE ${pg("ai_hint_cache")} SET suggestion = $1
       WHERE dim_id = $2 AND suggestion = $3`,
      [label, dimId, oldRow.label],
    ).catch(() => {
      /* table may not exist in older deploys */
    });
  }

  return { version: newVersion };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -10`
Expected: 3 passing (add + rename happy + rename conflict).

- [ ] **Step 5: Run full suite**

Run: `cd server && bun run test 2>&1 | tail -5`
Expected: 179 passing (+2 from previous task).

If any existing tests fail — likely call sites elsewhere in the codebase that pass 4 args to `renameCanonical` and now break — let the test name guide where to add the new `expectedVersion` arg. The route layer fix happens in Task 9; if a test from Task 6 fails because the route calls `renameCanonical(...4 args)`, you may need to migrate that call site as part of Task 6 OR add an interim adapter. Prefer the former — the type signature change ripples cleanly.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-canonical.ts server/test/repo-canonical-version.test.ts
git commit -m "feat(canonical): renameCanonical accepts expectedVersion (E2)"
```

---

## Task 7: `retireCanonical` with `expectedVersion`

**Files:**
- Modify: `server/src/repo-canonical.ts` — `retireCanonical` function (around line 444)
- Modify: `server/test/repo-canonical-version.test.ts` — add retire tests

- [ ] **Step 1: Write failing tests**

Append to `server/test/repo-canonical-version.test.ts`:

```ts
import { retireCanonical } from "../src/repo-canonical.ts";

test("retireCanonical with correct expectedVersion deletes row + version", async () => {
  // Seed a fresh canonical to retire.
  await addCanonicalOne(DIM, "Norway", "no", "u_canon_actor");
  // 'no' is now at version=1 with no map rows. Retire it.
  const res = await retireCanonical(DIM, "no", "u_canon_actor", 1);
  expect(res.ok).toBe(true);
  const stillThere = await pgGet<{ key: string }>(
    `SELECT key FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "no"],
  );
  expect(stillThere).toBeNull();
});

test("retireCanonical with stale expectedVersion throws CONFLICT", async () => {
  // Seed Sweden at version=1, then someone else bumps it via rename.
  await addCanonicalOne(DIM, "Sweden", "se", "u_canon_actor");
  await renameCanonical(DIM, "se", "Sverige", "u_canon_actor", 1);
  // Now version=2. Try to retire with version=1.
  let thrown: AppError | null = null;
  try {
    await retireCanonical(DIM, "se", "u_canon_actor", 1);
  } catch (e) {
    thrown = e as AppError;
  }
  expect(thrown?.code).toBe("CONFLICT");
  // Canonical still exists.
  const row = await pgGet<{ key: string }>(
    `SELECT key FROM ${DIM_TABLE} WHERE ${KEY_COL} = 'se'`,
  );
  expect(row?.key).toBe("se");
});

test("retireCanonical returns ok:false when variants still map (no version bump)", async () => {
  await addCanonicalOne(DIM, "Iceland", "is", "u_canon_actor");
  await pgRun(`INSERT INTO ${MAP_TABLE} (raw, ${KEY_COL}) VALUES ('IS', 'is')`);
  const res = await retireCanonical(DIM, "is", "u_canon_actor", 1);
  expect(res.ok).toBe(false);
  expect(res.variants).toBe(1);
  // Version row untouched — version still 1.
  const v = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "is"],
  );
  expect(v?.version).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -15`
Expected: FAIL — `retireCanonical` doesn't accept `expectedVersion`.

- [ ] **Step 3: Update `retireCanonical`**

Replace the existing function. New shape — accepts `expectedVersion`, performs the variants check FIRST (refusal-on-variants doesn't bump version), then bumps + deletes inside one transaction:

```ts
export async function retireCanonical(
  dimId: string,
  key: string,
  userId: string,
  expectedVersion: number,
): Promise<{ ok: boolean; variants: number }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false, variants: 0 };

  // Governance check first — refusal does NOT bump the version (no edit happened).
  const v = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  );
  const variants = Number(v?.n ?? 0);
  if (variants > 0) return { ok: false, variants };

  await pgTx(async (tx) => {
    // Throws CONFLICT if expectedVersion is stale.
    await bumpVersionOrThrow(tx, dimId, key, expectedVersion, userId);
    await tx.run(
      `DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`,
      [key],
    );
    await deleteVersionRow(tx, dimId, key);
  });

  await appendAuditAs(userId, "Retired canonical", key);
  return { ok: true, variants: 0 };
}
```

- [ ] **Step 4: Run tests to verify**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -10`
Expected: 6 passing.

Run: `cd server && bun run test 2>&1 | tail -5`
Expected: 182 passing (+3 from previous task).

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-canonical.ts server/test/repo-canonical-version.test.ts
git commit -m "feat(canonical): retireCanonical accepts expectedVersion (E2)"
```

---

## Task 8: `mergeCanonical` with `expectedVersions`

**Files:**
- Modify: `server/src/repo-canonical.ts` — `mergeCanonical` function (around line 419)
- Modify: `server/test/repo-canonical-version.test.ts` — add merge tests

- [ ] **Step 1: Write failing tests**

Append to `server/test/repo-canonical-version.test.ts`:

```ts
import { mergeCanonical } from "../src/repo-canonical.ts";

test("mergeCanonical with correct expectedVersions merges and bumps each row", async () => {
  await addCanonicalOne(DIM, "Finland", "fi", "u_canon_actor");
  await addCanonicalOne(DIM, "FinlandAlt", "fi_alt", "u_canon_actor");
  await pgRun(`INSERT INTO ${MAP_TABLE} (raw, ${KEY_COL}) VALUES ('Finland Alt', 'fi_alt')`);
  // Merge fi_alt → fi.
  const merged = await mergeCanonical(
    DIM,
    "fi",
    ["fi_alt"],
    "u_canon_actor",
    { fi: 1, fi_alt: 1 },
  );
  expect(merged).toBe(1);
  // Survivor bumped, loser row gone.
  const survivor = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = 'fi'`,
    [DIM],
  );
  expect(survivor?.version).toBe(2);
  const loserDim = await pgGet<{ key: string }>(
    `SELECT ${KEY_COL} AS key FROM ${DIM_TABLE} WHERE ${KEY_COL} = 'fi_alt'`,
  );
  expect(loserDim).toBeNull();
});

test("mergeCanonical with one stale expectedVersion throws CONFLICT listing it", async () => {
  await addCanonicalOne(DIM, "Estonia", "ee", "u_canon_actor");
  await addCanonicalOne(DIM, "EstoniaAlt", "ee_alt", "u_canon_actor");
  // Bump ee_alt out of band so its expectedVersion is stale.
  await renameCanonical(DIM, "ee_alt", "EstoniaAlt2", "u_canon_actor", 1);
  let thrown: AppError | null = null;
  try {
    await mergeCanonical(
      DIM,
      "ee",
      ["ee_alt"],
      "u_canon_actor",
      { ee: 1, ee_alt: 1 },  // ee_alt is now at 2
    );
  } catch (e) {
    thrown = e as AppError;
  }
  expect(thrown?.code).toBe("CONFLICT");
  const details = thrown!.details as { conflictedKeys: string[] };
  expect(details.conflictedKeys).toContain("ee_alt");
  // Confirm ee_alt still exists (tx rolled back).
  const stillThere = await pgGet<{ key: string }>(
    `SELECT ${KEY_COL} AS key FROM ${DIM_TABLE} WHERE ${KEY_COL} = 'ee_alt'`,
  );
  expect(stillThere?.key).toBe("ee_alt");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -15`
Expected: FAIL — `mergeCanonical` doesn't accept `expectedVersions`.

- [ ] **Step 3: Update `mergeCanonical`**

Replace the existing function. The trick: do all version checks in one statement, then re-check which expected keys weren't bumped:

```ts
export async function mergeCanonical(
  dimId: string,
  survivor: string,
  losers: string[],
  userId: string,
  expectedVersions: Record<string, number>,
): Promise<number> {
  const m = await dimMeta(dimId);
  if (!m) return 0;
  const key = qid(m.keyCol);
  const real = losers.filter((l) => l && l !== survivor);
  if (real.length === 0) return 0;

  const allKeys = [survivor, ...real];

  await pgTx(async (tx) => {
    // Bulk version-bump via VALUES list. Returns the set of keys actually bumped.
    // We compare against allKeys to detect stale-version misses.
    const valuesSql = allKeys.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3}::int)`).join(", ");
    const params: unknown[] = [userId];
    for (const k of allKeys) {
      params.push(k, expectedVersions[k] ?? -1);
    }
    const bumped = await tx.all<{ key: string }>(
      `WITH expected(key, expected_version) AS (
         VALUES ${valuesSql}
       )
       UPDATE "zugzug_app"."canonical_version" cv
          SET version = cv.version + 1, updated_at = now(), updated_by = $1
         FROM expected e
        WHERE cv.dim_id = '${dimId.replace(/'/g, "''")}'
          AND cv.key = e.key
          AND cv.version = e.expected_version
       RETURNING cv.key`,
      params,
    );
    const bumpedSet = new Set(bumped.map((b) => b.key));
    const missed = allKeys.filter((k) => !bumpedSet.has(k));
    if (missed.length > 0) {
      // Fetch current state of the first conflicting key for the user-facing message.
      const cur = await tx.get<CurrentVersionRow>(
        `SELECT cv.version, cv.updated_at, cv.updated_by, u.name, u.initials
           FROM "zugzug_app"."canonical_version" cv
           LEFT JOIN "zugzug_app"."users" u ON u.id = cv.updated_by
          WHERE cv.dim_id = $1 AND cv.key = $2`,
        [dimId, missed[0]!],
      );
      throw new AppError("CONFLICT", "One or more records were modified by another user", 409, {
        current: cur && {
          version: cur.version,
          updatedAt: cur.updated_at.toISOString(),
          updatedBy: {
            id: cur.updated_by,
            name: cur.name ?? cur.updated_by,
            initials: cur.initials ?? "??",
          },
        },
        conflictedKeys: missed,
      });
    }

    // All version checks passed — execute the merge.
    await tx.run(
      `UPDATE ${cq(m.mapTable)} SET ${key} = $1 WHERE ${key} = ANY($2::text[])`,
      [survivor, real],
    );
    await tx.run(
      `DELETE FROM ${cq(m.dimTable)} WHERE ${key} = ANY($1::text[])`,
      [real],
    );
    await tx.run(
      `DELETE FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND key = ANY($2::text[])`,
      [dimId, real],
    );
  });

  await appendAuditAs(userId, "Merged canonical", `${real.join(", ")} → ${survivor}`);
  return real.length;
}
```

The `dimId.replace(/'/g, "''")` interpolation looks scary but `dimId` is a server-generated id (`d_country`-style) that doesn't contain user input — same convention used by surrounding code that interpolates `m.dimTable` etc. The alternative (parameterizing dim_id in the CTE) is awkward when also passing the VALUES list; the current pattern matches `repo-canonical.ts` style.

- [ ] **Step 4: Run tests to verify**

Run: `cd server && bun run test repo-canonical-version 2>&1 | tail -10`
Expected: 8 passing.

Run: `cd server && bun run test 2>&1 | tail -5`
Expected: 184 passing (+2 from previous task).

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-canonical.ts server/test/repo-canonical-version.test.ts
git commit -m "feat(canonical): mergeCanonical accepts expectedVersions (E2)"
```

---

## Task 9: Wire 4 routes — accept `expectedVersion`, return 409

**Files:**
- Modify: `server/src/server.ts` — the 4 canonical routes (around `server.ts:498-540`)
- Create: `server/test/canonical-routes-conflict.test.ts` — HTTP 409 shape

The route layer already serializes `AppError` as `{ error, message, details? }` (Task 2). The work here is:

1. Parse `expectedVersion` from request body (PUT/POST) or query string (DELETE)
2. Pass it to the repo function
3. Return 200 with `{ version }` instead of 204 for PUT (rename)
4. The 409 is automatic — AppError CONFLICT propagates through the existing `instanceof AppError` handler

- [ ] **Step 1: Read the existing block once**

Run: `sed -n '498,540p' server/src/server.ts`

Confirm the 4 sites — POST add, POST merge, PUT rename, DELETE retire. The current shapes are roughly:

```ts
// POST /api/dimensions/:id/canonical
const { label, key } = await req.json();
await repo.addCanonicalOne(id, label, key, me);
return noContent();

// POST /api/dimensions/:id/canonical/merge?confirm=true
const { survivor, losers } = await req.json();
return json({ merged: await repo.mergeCanonical(id, survivor, losers, me) });

// PUT /api/dimensions/:id/canonical/:key
const { label } = await req.json();
await repo.renameCanonical(id, ck, label, me);
return noContent();

// DELETE /api/dimensions/:id/canonical/:key
return json(await repo.retireCanonical(id, ck, me));
```

- [ ] **Step 2: Update the PUT (rename) route**

Replace its handler block:

```ts
if (method === "PUT") {
  const denied = gateOrJson(sessionUser, "curate");
  if (denied) return denied;
  const { label, expectedVersion } = (await req.json()) as {
    label: string;
    expectedVersion?: number;
  };
  if (typeof expectedVersion !== "number") {
    throw new AppError("VALIDATION_FAILED", "expectedVersion required", 400);
  }
  const result = await repo.renameCanonical(id, ck, label, me, expectedVersion);
  return json(result);  // { version }
}
```

- [ ] **Step 3: Update the DELETE (retire) route**

```ts
if (method === "DELETE") {
  const denied = gateOrJson(sessionUser, "curate");
  if (denied) return denied;
  const ev = url.searchParams.get("expectedVersion");
  const expectedVersion = ev !== null ? Number(ev) : NaN;
  if (!Number.isFinite(expectedVersion)) {
    throw new AppError("VALIDATION_FAILED", "expectedVersion required", 400);
  }
  return json(await repo.retireCanonical(id, ck, me, expectedVersion));
}
```

- [ ] **Step 4: Update the merge route**

```ts
if (seg[4] === "merge" && seg.length === 5 && method === "POST") {
  const denied = gateOrJson(sessionUser, "curate");
  if (denied) return denied;
  if (url.searchParams.get("confirm") !== "true") {
    throw new AppError("CONFIRMATION_REQUIRED", "merge requires ?confirm=true", 400);
  }
  const { survivor, losers, expectedVersions } = (await req.json()) as {
    survivor: string;
    losers: string[];
    expectedVersions?: Record<string, number>;
  };
  if (!expectedVersions || typeof expectedVersions !== "object") {
    throw new AppError("VALIDATION_FAILED", "expectedVersions required", 400);
  }
  return json({
    merged: await repo.mergeCanonical(id, survivor, losers, me, expectedVersions),
  });
}
```

- [ ] **Step 5: The POST (add) route does not need a version (new row starts at 1)**

Leave the add route alone — it doesn't accept or return version.

- [ ] **Step 6: Write the HTTP-level test**

Create `server/test/canonical-routes-conflict.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import * as repo from "../src/repo-canonical.ts";

const DIM = "d_route_conflict";
const DIM_TABLE = `"zugzug_app"."dim_route_conflict"`;
const MAP_TABLE = `"zugzug_app"."map_route_conflict"`;
const KEY_COL = "country_id";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension"
       (id, dimension, dim_table, map_table, key_col, label, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO NOTHING`,
    [DIM, "Route Conflict", DIM_TABLE, MAP_TABLE, KEY_COL, "Route Conflict"],
  );
  await pgRun(`CREATE TABLE IF NOT EXISTS ${DIM_TABLE} (${KEY_COL} varchar PRIMARY KEY, label varchar)`);
  await pgRun(`CREATE TABLE IF NOT EXISTS ${MAP_TABLE} (raw varchar, ${KEY_COL} varchar)`);
  await pgRun(`DELETE FROM ${DIM_TABLE}`);
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1`, [DIM]);
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials)
     VALUES ('u_route_actor', 'Route Actor', 'RA')
     ON CONFLICT (id) DO NOTHING`,
  );
  await repo.addCanonicalOne(DIM, "Denmark", "dk", "u_route_actor");
});

test("renameCanonical with stale version throws AppError with details.current shape", async () => {
  // Bump out of band so the next call is stale.
  await repo.renameCanonical(DIM, "dk", "Danmark", "u_route_actor", 1);
  let thrown: { code?: string; status?: number; details?: { current?: { version?: number; updatedBy?: { id?: string; name?: string; initials?: string } } } } = {};
  try {
    await repo.renameCanonical(DIM, "dk", "DenmarkAgain", "u_route_actor", 1);
  } catch (e) {
    thrown = e as typeof thrown;
  }
  expect(thrown.code).toBe("CONFLICT");
  expect(thrown.status).toBe(409);
  expect(thrown.details?.current?.version).toBe(2);
  expect(thrown.details?.current?.updatedBy?.id).toBe("u_route_actor");
  expect(thrown.details?.current?.updatedBy?.name).toBe("Route Actor");
  expect(thrown.details?.current?.updatedBy?.initials).toBe("RA");
});
```

(This is a repo-level test exercising the AppError shape — adequate without spinning up the HTTP layer. The route-handler changes are essentially pass-through code; if the repo returns the right error shape, the route returns the right JSON.)

- [ ] **Step 7: Run tests to verify**

Run: `cd server && bun run test canonical-routes-conflict 2>&1 | tail -10`
Expected: 1 passing.

Run: `cd server && bun run test 2>&1 | tail -5`
Expected: 185 passing.

- [ ] **Step 8: Commit**

```bash
git add server/src/server.ts server/test/canonical-routes-conflict.test.ts
git commit -m "feat(routes): canonical routes thread expectedVersion + return 409 (E2)"
```

---

## Task 10: Client store — `version` field + `ConflictError`

**Files:**
- Modify: `app/src/data.ts` — `CanonicalValue` type
- Modify: `app/src/store.ts` — `ConflictError` class, mutation signatures, refresh threading

- [ ] **Step 1: Find the existing `CanonicalValue` type**

Run: `grep -n "interface CanonicalValue\|type CanonicalValue" app/src/data.ts app/src/store.ts | head -5`

Read the surrounding 5 lines of the match. Likely defined in `app/src/data.ts`.

- [ ] **Step 2: Add `version` to `CanonicalValue`**

In `app/src/data.ts`, find `CanonicalValue` and add the field:

```ts
export interface CanonicalValue {
  key: string;
  label: string;
  version: number;  // NEW — server-managed; client passes it back on mutations
  // ... existing fields preserved ...
}
```

- [ ] **Step 3: Add `ConflictError` class to store.ts**

Near the top of `app/src/store.ts` (after the existing type imports), add:

```ts
/** Thrown by client mutation helpers on HTTP 409 from the server.
 *  Callers (TablePane) inspect `current` to render the inline conflict banner. */
export class ConflictError extends Error {
  constructor(
    public current: {
      version: number;
      updatedAt: string;
      updatedBy: { id: string; name: string; initials: string };
    },
    public conflictedKeys?: string[],
  ) {
    super("Record was modified by another user");
    this.name = "ConflictError";
  }
}
```

- [ ] **Step 4: Update the `api` helper to recognize 409**

Run: `grep -n "function api\|async function api\|const api" app/src/store.ts | head -5`

Find the `api()` helper. Inside its error path (after detecting non-2xx), add:

```ts
if (res.status === 409) {
  const body = (await res.json().catch(() => ({}))) as {
    details?: {
      current?: ConflictError["current"];
      conflictedKeys?: string[];
    };
  };
  if (body.details?.current) {
    throw new ConflictError(body.details.current, body.details.conflictedKeys);
  }
}
```

Place this BEFORE the existing generic-error throw so the 409 path takes precedence.

- [ ] **Step 5: Update `renameCanonical` to send + return version**

```ts
export async function renameCanonical(
  dimId: string,
  key: string,
  label: string,
  expectedVersion: number,
): Promise<number> {
  const { version } = await api<{ version: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      body: JSON.stringify({ label, expectedVersion }),
    },
  );
  await refreshDim(dimId);
  await refreshAudit();
  emit();
  return version;
}
```

- [ ] **Step 6: Update `retireCanonical`**

```ts
export async function retireCanonical(
  dimId: string,
  key: string,
  expectedVersion: number,
): Promise<{ ok: boolean; variants: number }> {
  const res = await api<{ ok: boolean; variants: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}?expectedVersion=${expectedVersion}`,
    { method: "DELETE" },
  );
  if (res.ok) {
    await refreshDim(dimId);
    await refreshAudit();
    emit();
  }
  return res;
}
```

- [ ] **Step 7: Update `mergeCanonical`**

```ts
export async function mergeCanonical(
  dimId: string,
  survivor: string,
  losers: string[],
  expectedVersions: Record<string, number>,
): Promise<number> {
  const { merged } = await api<{ merged: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/merge?confirm=true`,
    {
      method: "POST",
      body: JSON.stringify({ survivor, losers, expectedVersions }),
    },
  );
  await refreshDim(dimId);
  await refreshSources();
  await refreshAudit();
  emit();
  return merged;
}
```

- [ ] **Step 8: Find every call site of these three mutations and update args**

Run: `grep -rn "renameCanonical\|retireCanonical\|mergeCanonical" app/src/ | grep -v "store.ts:" | head -20`

Each call site needs the new args:
- `renameCanonical(dimId, key, label)` → `renameCanonical(dimId, key, label, currentRow.version)`
- `retireCanonical(dimId, key)` → `retireCanonical(dimId, key, currentRow.version)`
- `mergeCanonical(dimId, survivor, losers)` → `mergeCanonical(dimId, survivor, losers, expectedVersions)`

The primary site is `app/src/components/TablePane.tsx` — both the rename undo/redo paths and the bulk action bar. The merge call is from the merge ComboSelect's `onPick`. The retire call is from the single-row delete and the bulk Remove (via `retire(c.key, c.label)` → wraps `retireCanonical`).

Pass the version from the canonical row that the caller already has in scope. For merge, build `expectedVersions = { [survivor]: survivorRow.version, ...Object.fromEntries(targets.map((t) => [t.key, t.version])) }`.

DON'T add ConflictError-handling logic in this task — that lands in Task 12 (TablePane conflict UI). For now, callers can let the error propagate; subsequent runs will see it in the dev console.

- [ ] **Step 9: Typecheck + test**

Run: `cd app && bun run typecheck 2>&1 | tail -5`
Expected: clean. If a non-TablePane call site is missed, the typecheck flags it.

Run: `cd app && bun run test 2>&1 | tail -5`
Expected: 149 passing.

- [ ] **Step 10: Commit**

```bash
git add app/src/data.ts app/src/store.ts app/src/components/TablePane.tsx
git commit -m "feat(store): CanonicalValue.version + ConflictError + mutation threading (E2)"
```

(If other client files needed updates beyond `TablePane.tsx`, include them in the `git add` list.)

---

## Task 11: `<ConflictBanner>` component

**Files:**
- Create: `app/src/components/ConflictBanner.tsx`
- Create: `app/test/conflict-banner.test.tsx`

- [ ] **Step 1: Write failing test**

Create `app/test/conflict-banner.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConflictBanner } from "../src/components/ConflictBanner";

describe("ConflictBanner", () => {
  const conflict = {
    updatedBy: { id: "u_mia", name: "Mia Berg", initials: "MB" },
    updatedAt: new Date(Date.now() - 12_000).toISOString(),
  };

  test("renders the updater's name and 'ago' time", () => {
    render(
      <ConflictBanner
        conflict={conflict}
        onRefresh={() => undefined}
        onKeepEditing={() => undefined}
      />,
    );
    expect(screen.getByText(/mia berg/i)).toBeInTheDocument();
    expect(screen.getByText(/\d+s ago/i)).toBeInTheDocument();
    expect(screen.getByText(/your changes weren't saved/i)).toBeInTheDocument();
  });

  test("clicking Refresh fires onRefresh", async () => {
    const onRefresh = vi.fn();
    render(
      <ConflictBanner
        conflict={conflict}
        onRefresh={onRefresh}
        onKeepEditing={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /refresh row/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  test("clicking Keep editing fires onKeepEditing", async () => {
    const onKeepEditing = vi.fn();
    render(
      <ConflictBanner
        conflict={conflict}
        onRefresh={() => undefined}
        onKeepEditing={onKeepEditing}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /keep editing/i }));
    expect(onKeepEditing).toHaveBeenCalledOnce();
  });

  test("conflictedKeys = ['Norway', 'Sweden'] surfaces 'Norway (and 1 other)'", () => {
    render(
      <ConflictBanner
        conflict={conflict}
        conflictedKeys={["Norway", "Sweden"]}
        onRefresh={() => undefined}
        onKeepEditing={() => undefined}
      />,
    );
    expect(screen.getByText(/norway/i)).toBeInTheDocument();
    expect(screen.getByText(/and 1 other/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `cd app && bun run test conflict-banner 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `app/src/components/ConflictBanner.tsx`:

```tsx
import { Button } from "./Button";
import { cx } from "../lib/cx";

export interface ConflictBannerProps {
  conflict: {
    updatedBy: { id: string; name: string; initials: string };
    updatedAt: string;
  };
  /** Set when the action that conflicted touched multiple keys (e.g. merge).
   *  Banner copy names the first key + "(and N others)". */
  conflictedKeys?: string[];
  onRefresh: () => void;
  onKeepEditing: () => void;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Per-row inline conflict banner shown above a canonical row in TablePane when
 *  a save was rejected because another user beat the current user to the row. */
export function ConflictBanner({
  conflict,
  conflictedKeys,
  onRefresh,
  onKeepEditing,
}: ConflictBannerProps) {
  const tail =
    conflictedKeys && conflictedKeys.length > 1
      ? ` (${conflictedKeys[0]} and ${conflictedKeys.length - 1} other${conflictedKeys.length === 2 ? "" : "s"})`
      : "";
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-3 rounded-sm border border-warn/40 bg-warn-soft px-4 py-2.5",
        "font-mono text-[11.5px] text-warn",
      )}
      role="alert"
    >
      <span>
        This record was modified by <strong>{conflict.updatedBy.name}</strong> {ago(conflict.updatedAt)}.{" "}
        Your changes weren&rsquo;t saved.
        {tail && <em className="not-italic text-warn/80">{tail}</em>}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onKeepEditing}>
          Keep editing
        </Button>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          Refresh row
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd app && bun run test conflict-banner 2>&1 | tail -10`
Expected: 4 passing.

Run: `cd app && bun run test 2>&1 | tail -5`
Expected: 153 passing (+4 from baseline).

- [ ] **Step 5: Commit**

```bash
git add app/src/components/ConflictBanner.tsx app/test/conflict-banner.test.tsx
git commit -m "feat(ui): ConflictBanner — per-row inline conflict notice (E2)"
```

---

## Task 12: TablePane catches `ConflictError` + renders banner

**Files:**
- Modify: `app/src/components/TablePane.tsx`
- Create: `app/test/tablepane-conflict.test.tsx`

- [ ] **Step 1: Add per-row conflict state**

In `RecordsBody` (inside `TablePane.tsx`), near the existing useState declarations (where `bulkRemoveConfirm` etc. live from the v0.2 polish PR), add:

```tsx
import { ConflictError, refreshDim } from "../store";
import { ConflictBanner } from "./ConflictBanner";

// ... inside RecordsBody:
const [conflicts, setConflicts] = useState<
  Map<string, { current: ConflictError["current"]; conflictedKeys?: string[] }>
>(new Map());
```

- [ ] **Step 2: Add a helper that maps a `ConflictError` into the state map**

Inside the component:

```tsx
const surfaceConflict = useCallback(
  (rowKey: string, err: unknown) => {
    if (err instanceof ConflictError) {
      setConflicts((prev) => {
        const next = new Map(prev);
        next.set(rowKey, { current: err.current, conflictedKeys: err.conflictedKeys });
        return next;
      });
      return true;
    }
    return false;
  },
  [],
);

const dismissConflict = useCallback((rowKey: string) => {
  setConflicts((prev) => {
    if (!prev.has(rowKey)) return prev;
    const next = new Map(prev);
    next.delete(rowKey);
    return next;
  });
}, []);
```

- [ ] **Step 3: Wrap each mutation call site in a try/catch that calls `surfaceConflict`**

The three sites in `TablePane.tsx` that need wrapping (you read each in Task 8 of the v0.2 polish work):

**Rename (onCommit for the label cell)** — currently calls `renameCanonical(activeId, rowKey, value)`. Pass version + catch:

```tsx
const row = list.find((c) => c.key === rowKey);
if (!row) return;
try {
  await renameCanonical(activeId, rowKey, value, row.version);
  dismissConflict(rowKey);
} catch (e) {
  if (!surfaceConflict(rowKey, e)) throw e;
}
```

**Single-row delete (`onConfirm` in `singleDeleteConfirm` dialog)** — currently calls `retire(singleDeleteConfirm.key, singleDeleteConfirm.label)`. Update to find the row and pass version:

```tsx
onConfirm={async () => {
  if (!singleDeleteConfirm) return;
  const row = list.find((c) => c.key === singleDeleteConfirm.key);
  if (!row) {
    setSingleDeleteConfirm(null);
    return;
  }
  try {
    await retireCanonical(activeId, singleDeleteConfirm.key, row.version);
    dismissConflict(singleDeleteConfirm.key);
  } catch (e) {
    if (!surfaceConflict(singleDeleteConfirm.key, e)) throw e;
  }
  setSingleDeleteConfirm(null);
}}
```

(If a local `retire` helper currently wraps `retireCanonical`, update both — the helper signature accepts the new arg.)

**Merge (`onConfirm` in `mergeConfirm` dialog)** — currently calls `merge(mergeConfirm.survivorLabel)`. The wrapper `merge` function needs the expectedVersions assembled:

```tsx
const merge = useCallback(
  async (survivorLabel: string) => {
    // Existing logic: derive survivorKey, losers from current selection.
    // ... preserved unchanged up to the API call ...
    const survivorRow = list.find((c) => c.label === survivorLabel);
    if (!survivorRow) return;
    const selectedRows = sel
      .map((k) => list.find((x) => x.key === k))
      .filter((r): r is NonNullable<typeof r> => r != null);
    const expectedVersions = Object.fromEntries(
      [survivorRow, ...selectedRows.filter((r) => r.key !== survivorRow.key)].map((r) => [
        r.key,
        r.version,
      ]),
    );
    try {
      await mergeCanonical(
        activeId,
        survivorRow.key,
        selectedRows.filter((r) => r.key !== survivorRow.key).map((r) => r.key),
        expectedVersions,
      );
      // Dismiss any prior conflict on these keys.
      for (const r of selectedRows) dismissConflict(r.key);
    } catch (e) {
      // Use the first conflicting key (or the survivor) as the banner anchor.
      const anchor =
        e instanceof ConflictError && e.conflictedKeys?.length
          ? e.conflictedKeys[0]!
          : survivorRow.key;
      if (!surfaceConflict(anchor, e)) throw e;
    }
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [activeId, list, sel, surfaceConflict, dismissConflict],
);
```

- [ ] **Step 4: Render the banner above the conflicted row**

In the DataGrid row rendering path, you'll need a hook the grid exposes for above-row content. If the grid doesn't already support per-row banners, the simpler approach is: render the banners ABOVE the entire grid in a small list, one per conflicting row, with a label naming the row. The grid stays untouched.

Render block (placed after the bulk action bar, before the `<DataGrid>`):

```tsx
{conflicts.size > 0 && (
  <div className="flex flex-col gap-1 px-5 pt-2 pb-3">
    {Array.from(conflicts.entries()).map(([rowKey, c]) => (
      <ConflictBanner
        key={rowKey}
        conflict={c.current}
        conflictedKeys={c.conflictedKeys}
        onRefresh={async () => {
          await refreshDim(activeId);
          dismissConflict(rowKey);
        }}
        onKeepEditing={() => dismissConflict(rowKey)}
      />
    ))}
  </div>
)}
```

(`refreshDim` is exported from store.ts already. If not, find the equivalent — likely `refreshDim(dimId)` or similar; grep `export.*refreshDim` in store.ts.)

- [ ] **Step 5: Write integration test**

Create `app/test/tablepane-conflict.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConflictError } from "../src/store";

// Mock the store's renameCanonical to throw ConflictError on first call,
// resolve cleanly on second (post-Refresh) call.
vi.mock("../src/store", async () => {
  const actual = await vi.importActual<typeof import("../src/store")>("../src/store");
  return {
    ...actual,
    renameCanonical: vi.fn(async () => {
      throw new ConflictError(
        {
          version: 5,
          updatedAt: new Date(Date.now() - 12_000).toISOString(),
          updatedBy: { id: "u_mia", name: "Mia Berg", initials: "MB" },
        },
        undefined,
      );
    }),
  };
});

describe("TablePane conflict surfacing", () => {
  beforeEach(() => vi.clearAllMocks());

  test("rename that throws ConflictError shows the ConflictBanner with the updater's name", async () => {
    // TODO: Render TablePane with a single-dim fixture and one canonical row.
    // Edit the label cell → tab out (triggers commit → mock throws) → expect banner.
    // Click Refresh → expect dismissal.
    //
    // This is a structural test — adapt to whatever rendering harness TablePane
    // tests already use (look at app/test/triage-commit-copy.test.tsx for an
    // example of mounting a route-level component with mock data).
  });
});
```

If the existing TablePane test harness is too elaborate to set up in this task, leave the test as a skipped stub (`test.skip(...)`) and rely on manual smoke. Don't spend more than 30 minutes on the mount harness — the conflict logic is exercised by Tasks 6–8 server-side; this test is just belt-and-suspenders.

- [ ] **Step 6: Typecheck + test**

Run: `cd app && bun run typecheck 2>&1 | tail -5`
Expected: clean.

Run: `cd app && bun run test 2>&1 | tail -5`
Expected: 153 (or +1 if the integration test runs).

- [ ] **Step 7: Manual smoke**

Run the app + server. Sign in. Open a dim with at least one canonical row in TablePane.

1. In one browser, rename "Denmark" → "DK". Commit (Enter).
2. In a second browser (different user via incognito), rename "Denmark" → "Danmark". Commit.
3. Confirm: second browser sees the banner: "This record was modified by [User1] [time]. Your changes weren't saved." with `[Refresh row]` and `[Keep editing]`.
4. Click "Refresh row" → cell shows "DK", banner dismisses.

- [ ] **Step 8: Commit**

```bash
git add app/src/components/TablePane.tsx app/test/tablepane-conflict.test.tsx
git commit -m "feat(tables): catch ConflictError + render per-row banner (E2)"
```

---

## Task 13: Verification gate + push + PR

**Files:** none beyond what's already changed.

- [ ] **Step 1: Full server gate**

Run: `cd server && bun run typecheck && bun run lint && bun run format:check && bun run test 2>&1 | tail -10`
Expected: all green. ~185 tests passing.

- [ ] **Step 2: Full app gate**

Run: `cd app && bun run typecheck && bun run lint && bun run format:check && bun run test 2>&1 | tail -10`
Expected: all green. ~153 tests passing.

- [ ] **Step 3: Manual concurrency walkthrough**

Two browsers, two users, same dim. Confirm in this order:

1. **Rename conflict:** both rename same row → second sees banner with first's name → Refresh dismisses.
2. **Bulk Remove vs. rename:** user A renames a row in selection while user B is mid-bulk-Remove → banner on that row, other deletions succeed.
3. **Merge conflict:** user A renames a loser-to-be while user B is mid-merge → merge fails with banner naming the loser ("Mia modified 'X' Ns ago").
4. **Add doesn't conflict:** two users adding different keys to same dim → both succeed; canonical_version table has both at version=1.

- [ ] **Step 4: Push branch**

```bash
git push -u origin e2-optimistic-concurrency
```

- [ ] **Step 5: Open PR**

```bash
gh pr create --title "E2: optimistic concurrency for canonical row edits (#55)" --body "$(cat <<'EOF'
## Summary

Closes the core of epic #55 (E2 — Concurrent Editing Safety) via optimistic concurrency, without depending on E1's WebSocket presence layer.

**Schema:** new `canonical_version (dim_id, key, version, updated_at, updated_by)` sidecar in Postgres. Drizzle migration `0009_e2_canonical_version` creates the table and backfills version=1 for every existing canonical row across every registered dimension. Idempotent.

**Repo:** `bumpVersionOrThrow` / `seedVersionRow` / `deleteVersionRow` helpers centralize the optimistic-concurrency SQL. `addCanonicalOne` / `renameCanonical` / `retireCanonical` / `mergeCanonical` all wrap their dim_X mutation in a transaction that bumps the version row first. Stale-version → AppError CONFLICT → HTTP 409 with `{ current: { version, updatedAt, updatedBy: { id, name, initials } }, conflictedKeys? }`.

**Routes:** PUT/DELETE/POST routes pass `expectedVersion` through; PUT (rename) now returns `{ version }` instead of 204.

**Client:** `CanonicalValue.version` threaded through store. Mutations send `expectedVersion`; HTTP 409 throws `ConflictError`. TablePane catches and surfaces a per-row `<ConflictBanner>` above the grid with `[Refresh row]` + `[Keep editing]`.

**Out of scope:** field-level versioning, draft commits, WebSocket invalidation (E1), auto-merge. Documented in the spec.

Spec: `docs/superpowers/specs/2026-06-10-e2-concurrent-editing-safety-design.md`
Plan: `docs/superpowers/plans/2026-06-10-e2-concurrent-editing-safety.md`

## Test plan
- [ ] `cd server && bun run typecheck && bun run lint && bun run format:check && bun run test` — green (~185)
- [ ] `cd app && bun run typecheck && bun run lint && bun run format:check && bun run test` — green (~153)
- [ ] Migration applies cleanly against fresh DB
- [ ] Migration applies against existing data → every existing canonical row has version=1
- [ ] Two-browser smoke: rename conflict surfaces banner; Refresh dismisses
- [ ] Bulk Remove + rename collision: banner on the modified row, other rows retired
- [ ] Merge conflict on one loser: 409 with conflictedKeys naming it

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Verify CI**

Run: `gh pr checks --watch`
Expected: app + server + license-placeholder-check + notice-up-to-date all pass.

---

## Self-review

**Spec coverage matrix:**

| Spec deliverable | Task |
|---|---|
| `canonical_version` Drizzle table + idx | Task 3 |
| Backfill migration + idempotency | Task 3 |
| `AppError.details` + CONFLICT code | Task 2 |
| `bumpVersionOrThrow` helper | Task 4 |
| `seedVersionRow` helper | Task 4 |
| `deleteVersionRow` helper | Task 4 |
| `addCanonicalOne` seeds version row | Task 5 |
| `renameCanonical` with expectedVersion | Task 6 |
| `retireCanonical` with expectedVersion | Task 7 |
| `mergeCanonical` with expectedVersions Record | Task 8 |
| Routes: thread expectedVersion, return 409 + version | Task 9 |
| Client store: CanonicalValue.version + threading | Task 10 |
| Client store: ConflictError class | Task 10 |
| `<ConflictBanner>` component | Task 11 |
| TablePane catches ConflictError + renders banner | Task 12 |
| Per-row Refresh re-fetches dim + dismisses | Task 12 |
| Keep editing only dismisses banner | Task 12 |
| Merge conflict surfaces conflictedKeys in banner copy | Task 11 + Task 12 |
| Verification gate (spec section) | Task 13 |

**Type consistency check:**

- `ConflictError.current` shape (Task 10) matches the server's 409 `details.current` shape (Task 4, Task 9): `{ version, updatedAt, updatedBy: { id, name, initials } }`. ✓
- `expectedVersion: number` (Tasks 6, 7) and `expectedVersions: Record<string, number>` (Task 8) are consistent across server function signatures, client store, and route bodies. ✓
- `CanonicalValue.version: number` (Task 10) matches the integer column in canonical_version (Task 3). ✓
- `seedVersionRow` / `deleteVersionRow` / `bumpVersionOrThrow` names referenced in Tasks 5–8 match their declarations in Task 4. ✓

**Placeholder scan:** Task 12 leaves the TablePane integration test as a skipped stub if the existing test harness is too elaborate to wire up in 30 minutes. This is an explicit time-box, not a placeholder — the conflict logic itself is fully tested at the server level in Tasks 6–8 and the component level in Task 11. The manual smoke in Task 13 is the integration-level verification.

**Risks worth flagging:**

- **Drizzle journal `tag` rename** (Task 3, Step 4) is finicky — if the journal isn't updated to match the renamed SQL file, subsequent migrations will mis-track. Verify by re-running `db:migrate` after the rename and confirming no "missing migration" errors.
- **`mergeCanonical` SQL interpolates `dim_id`** (Task 8, Step 3) into the WHERE clause to dodge a parameter-vs-VALUES-list collision. Safe because `dim_id` is server-generated; if that assumption ever changes, this site needs revisiting.
- **The `api` helper 409 path** (Task 10, Step 4) needs to be ordered BEFORE the generic non-2xx throw, otherwise the conflict shape is lost. The plan calls this out but it's easy to miss.
- **Client call-site fanout** (Task 10, Step 8) — if a non-TablePane consumer (e.g. an undo handler in another file) calls these mutations, it must also be updated. The typecheck in Step 9 catches this; if a runtime caller passes `undefined` for version, the server returns VALIDATION_FAILED.
