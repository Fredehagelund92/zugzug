# Multi-tenant PR 2b — Repo sweep + scheduler + WS + admin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the server-side multi-tenant migration: every `repo-*.ts` function gains a `tenantId` parameter, `TenantRepo` exposes all of them, every `/api/*` route uses `req.repo` (no module-level `repo.*` calls), the scheduler iterates tenants with per-tick `SET LOCAL`, the presence WebSocket is tenant-namespaced, dynamic `dim_*/map_*` tables gain `tenant_id`, and the remaining super-admin routes (`audit`, `teardown`, `impersonate`) ship. Closes the PR2a follow-ups: `preferences` UNIQUE fix and `pg` Proxy defense-in-depth.

**Architecture:** Mechanical sweep, module-by-module. For each `repo-*.ts` module: (1) add `tenantId` parameter to every exported function — read fns add `WHERE tenant_id = $N`, write fns add `tenant_id = $N` to INSERTs and join clauses; (2) extend `TenantRepo` with thin forwarders that call `this.assertRole(op)` before mutating; (3) flip the route handlers in `server.ts` from `repo.foo(...)` to `req.repo.foo(...)`. Dynamic per-dimension tables (`dim_<id>`, `map_<id>`) get a `tenant_id VARCHAR NOT NULL DEFAULT '<owning-tenant>'` column at `addDimension()` time. The scheduler stops calling repo functions directly: it walks `SELECT id FROM tenant`, opens one `pgTxScoped(tenantId, ...)` per tenant per tick, and runs the per-tenant slice of each job inside it. The presence WebSocket upgrade URL becomes `/ws/t/:slug/presence/:tableId`; the in-memory room key is `${tenantId}:${tableId}` so the same `tableId` in two workspaces cannot share a room. `TenantRepo` Proxy-wraps a sentinel: any direct `pg`-client query that bypasses the class throws at runtime in non-prod.

**Branch:** `mt-pr2b-repo-sweep` off `mt-pr2a-tenant-runtime` (or off `main` once #101 has landed — re-base accordingly).

**Tech Stack:** Drizzle migrations (one new schema migration), Bun + postgres.js, bun:test. No new runtime dependencies. Builds on PR2a's `pgTxScoped`, `tenant-middleware`, `TenantRepo`, `SessionUser.isSuperAdmin`, and `/api/t/:slug/*` prefix-strip.

**Spec:** `docs/superpowers/specs/2026-06-07-multi-tenant-design.md` — relevant sections: "TenantRepo", "Super-admin routes", "Dynamic dim_/map_ tables", "Tables that gain tenant_id".

**Prereq:** PR2a (#101) merged to `main`. Confirm with `git log --oneline main | head -20 | grep -c "MT PR2a"` returning at least 8.

**Scope notes:**
- This PR does NOT touch `app/` (PR3 owns the client `apiFetch` migration).
- This PR does NOT add NOT NULL / FK / RLS — those are Deploy 2 (PR5). PR2b leaves all `tenant_id` columns nullable with the `'default'` DEFAULT in place.
- ESLint server-side rule banning module-level `repo.*` imports outside the TenantRepo class lands in Task 16 as a soft warn (errors-out in Deploy 2).

---

## File structure (post-PR)

```
server/drizzle/schema.ts                              MOD — preferences UNIQUE(tenant_id); admin tables (no schema diff)
server/drizzle/migrations/0012_mt_pr2b_repo_sweep.sql NEW — UNIQUE preferences; backfill dim_/map_ tenant_id col
server/src/pg.ts                                      MOD — export pgPool sentinel for Proxy; no behavior change
server/src/repo-shared.ts                             MOD — sourcesOf, liveSources, dimMeta gain tenantId
server/src/repo-canonical.ts                          MOD — all 18 fns gain tenantId; addDimension writes dim_/map_ with tenant_id column
server/src/repo-drafts.ts                             MOD — listDrafts, saveDraft, discardDraft, commit gain tenantId
server/src/repo-scan.ts                               MOD — all 11 fns gain tenantId; anyScanDue/scanStatus get '*' branch
server/src/repo-ai-hint.ts                            MOD — getAiHint gains tenantId (cache lookup scoped)
server/src/repo-activity.ts                           MOD — getRowActivitySince gains tenantId
server/src/repo-meta.ts                               MOD — listUsers stays global; getGridLayout/setGridLayout stay global (per-user, not per-tenant)
server/src/tenant-repo.ts                             MOD — add ~40 forwarder methods + Proxy guard
server/src/scheduler.ts                               MOD — per-tenant tick loop
server/src/server.ts                                  MOD — every route flipped to req.repo; WS path; admin/audit, admin/impersonate, admin/teardown
server/src/tenant.ts                                  MOD — add teardownTenant() (calls stored fn or inline cleanup); impersonation flag in sessions
server/src/realtime/presence-room.ts                  MOD — room key prefixed with tenantId
server/test/repo-canonical-tenant.test.ts             NEW — 2-tenant isolation for canonical CRUD
server/test/repo-drafts-tenant.test.ts                NEW — 2-tenant isolation for drafts + commit
server/test/repo-scan-tenant.test.ts                  NEW — 2-tenant isolation for sources/scan
server/test/repo-ai-hint-tenant.test.ts               NEW — ai_hint_cache lookup is tenant-scoped
server/test/repo-activity-tenant.test.ts              NEW — getRowActivitySince tenant-scoped
server/test/scheduler-multi-tenant.test.ts            NEW — scheduler ticks once per tenant per job
server/test/tenant-repo-proxy.test.ts                 NEW — direct pg usage from inside TenantRepo context throws
server/test/admin-audit-route.test.ts                 NEW — /api/admin/audit returns cross-tenant feed
server/test/admin-teardown-route.test.ts              NEW — /api/admin/tenants/:id/teardown wipes tenant rows
server/test/admin-impersonate-route.test.ts           NEW — /api/admin/impersonate/:id flips effective tenant
server/test/ws-presence-tenant-namespacing.test.ts    NEW — same tableId across two tenants = separate rooms
server/test/preferences-unique-race.test.ts           NEW — concurrent setPreferences for same tenant doesn't 23505
server/test/dim-map-tenant-column.test.ts             NEW — addDimension creates dim_/map_ with tenant_id column
```

---

## Task 1: Branch kickoff + baseline

**Files:** none.

- [ ] **Step 1: Confirm PR2a merged**

```bash
git log --oneline main | head -20 | grep -c "MT PR2a"
```
Expected: at least 8 (PR2a's 18 commits squashed or merged as-is — adjust if squashed to 1).

- [ ] **Step 2: Create branch**

```bash
git checkout main && git pull --ff-only origin main && git checkout -b mt-pr2b-repo-sweep
```

- [ ] **Step 3: Baseline test counts**

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: ~249 passing (PR2a baseline). Record the exact number — every later task should show monotonic growth.

```bash
cd app && bun run test 2>&1 | tail -5
```
Expected: ~178 passing + 1 skipped. No app changes in PR2b, so this stays green throughout.

- [ ] **Step 4: Sanity-check the surface area we're about to touch**

```bash
grep -c "^export async function\|^export function" server/src/repo-canonical.ts server/src/repo-drafts.ts server/src/repo-scan.ts server/src/repo-ai-hint.ts server/src/repo-activity.ts server/src/repo-shared.ts server/src/repo-meta.ts
```
Expected: ~40 functions total across these modules. Use this number to track progress.

```bash
grep -c "await repo\." server/src/server.ts
```
Expected: ~30–40 call sites. Every one must flip to `req.repo.` by Task 14.

---

## Task 2: Drizzle migration — UNIQUE(tenant_id) on preferences

**Files:**
- Modify: `server/drizzle/schema.ts` — add unique index to `preferences.tenantId`
- Create: `server/drizzle/migrations/0012_mt_pr2b_repo_sweep.sql` (generated)

**Why this exists:** PR2a left `setPreferences` racy (UPDATE-then-INSERT with no unique constraint). With `UNIQUE(tenant_id)` we collapse the two SQL statements into one `INSERT … ON CONFLICT (tenant_id) DO UPDATE`. Also adds the `tenant_id` index on `ai_hint_cache` and `canonical_version` for the new lookup-by-tenant queries we ship in Tasks 6 and 9.

- [ ] **Step 1: Edit `server/drizzle/schema.ts`**

Find the `preferences` table definition. It currently has `id` as PK. Add:

```ts
export const preferences = pgTable(
  "preferences",
  {
    id: integer("id").primaryKey(),
    publishThreshold: integer("publish_threshold").notNull().default(95),
    suggestThreshold: integer("suggest_threshold").notNull().default(80),
    scanSchedule: varchar("scan_schedule"),
    updatedAt: timestamp("updated_at"),
    tenantId: varchar("tenant_id").default("default"),
  },
  (t) => ({
    tenantUnique: uniqueIndex("preferences_tenant_unique").on(t.tenantId),
  }),
);
```

Likewise add tenant index helpers we'll lean on:

```ts
// ai_hint_cache: lookup is (tenant_id, dim_id, raw)
// canonical_version: lookup is (tenant_id, dim_id, key) for cross-tenant disambiguation
```

If `ai_hint_cache` and `canonical_version` already have indexes, add a composite `(tenant_id, dim_id)` btree on each.

- [ ] **Step 2: Generate the migration**

```bash
cd server && bun run db:generate
```
Expected: a new file `server/drizzle/migrations/0012_*.sql` appears. Rename it to `0012_mt_pr2b_repo_sweep.sql` (or accept whatever Drizzle generated — name doesn't matter, ordering does).

- [ ] **Step 3: Add backfill statements to the generated SQL**

Open the generated migration and append (after the auto-generated UNIQUE + index DDL):

```sql
-- Backfill: if multiple legacy id-keyed preferences rows exist for tenant_id='default',
-- collapse to the lowest id. This is defensive — there should be exactly one row from
-- the pre-PR2a era, but PR2a's UPDATE-then-INSERT path could have raced.
DELETE FROM "zugzug_app"."preferences" a
USING "zugzug_app"."preferences" b
WHERE a.tenant_id = b.tenant_id
  AND a.id > b.id;
```

- [ ] **Step 4: Apply migration to test DB**

```bash
cd server && bun run db:migrate
```
Expected: clean apply. Re-run on the dev DB later — DO NOT include any `--force` flag.

- [ ] **Step 5: Verify**

```bash
psql postgres://zugzug:zugzug@localhost:55432/zugzug_test -c "\d zugzug_app.preferences"
```
Expected: shows `preferences_tenant_unique UNIQUE, btree (tenant_id)`.

- [ ] **Step 6: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/
git commit -m "feat(db): UNIQUE(tenant_id) on preferences + tenant indexes (MT PR2b)"
```

---

## Task 3: Collapse `setPreferences` to a single upsert

**Files:**
- Modify: `server/src/repo-meta.ts`
- Create: `server/test/preferences-unique-race.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/test/preferences-unique-race.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { getPreferences, setPreferences } from "../src/repo-meta.ts";

const T = "tpref_race";
async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("concurrent setPreferences for the same tenant does not 23505", async () => {
  await provisionTenant({ id: T, label: "race" });

  const writes = Array.from({ length: 10 }, (_, i) =>
    setPreferences(
      { publishThreshold: 50 + i, suggestThreshold: 40, scanSchedule: null },
      T,
    ),
  );
  const settled = await Promise.allSettled(writes);
  const rejected = settled.filter((s) => s.status === "rejected");
  expect(rejected).toEqual([]);

  const final = await getPreferences(T);
  expect(final.publishThreshold).toBeGreaterThanOrEqual(50);
  expect(final.publishThreshold).toBeLessThan(60);
});
```

- [ ] **Step 2: Run, expect intermittent failure**

```bash
cd server && bun run test preferences-unique-race 2>&1 | tail -10
```
Expected: likely passes once but fails under load — the migration's UNIQUE constraint actually makes the OLD code MORE likely to 23505. Run twice to surface.

- [ ] **Step 3: Replace `setPreferences` body in `server/src/repo-meta.ts`**

```ts
export async function setPreferences(
  p: Preferences,
  tenantId: string = "default",
): Promise<void> {
  const valid = p.scanSchedule === null || ["15m", "hourly", "daily"].includes(p.scanSchedule);
  if (!valid) throw new Error(`invalid scanSchedule: ${String(p.scanSchedule)}`);

  await pgRun(
    `INSERT INTO ${pg("preferences")}
       (id, publish_threshold, suggest_threshold, scan_schedule, updated_at, tenant_id)
     VALUES (
       (SELECT COALESCE(MAX(id), 0) + 1 FROM ${pg("preferences")}),
       $1, $2, $3, current_timestamp, $4
     )
     ON CONFLICT (tenant_id) DO UPDATE
       SET publish_threshold = EXCLUDED.publish_threshold,
           suggest_threshold = EXCLUDED.suggest_threshold,
           scan_schedule     = EXCLUDED.scan_schedule,
           updated_at        = EXCLUDED.updated_at`,
    [p.publishThreshold, p.suggestThreshold, p.scanSchedule, tenantId],
  );
}
```

Remove the PR2a `// FIXME(PR2b): race` comment at the top of the function.

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test preferences-unique-race 2>&1 | tail -10
```
Expected: 1 test passes consistently across 5 reruns:

```bash
for i in 1 2 3 4 5; do cd server && bun run test preferences-unique-race 2>&1 | tail -2; done
```

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-meta.ts server/test/preferences-unique-race.test.ts
git commit -m "fix(repo-meta): single-statement upsert for setPreferences (MT PR2b)"
```

---

## Task 4: Migrate `repo-shared.ts` helpers to take `tenantId`

**Files:**
- Modify: `server/src/repo-shared.ts` — `sourcesOf`, `liveSources`, `dimMeta` gain a required `tenantId` parameter

**Why this exists:** These three helpers are used by every other `repo-*.ts` module. Threading `tenantId` here first means later modules just forward what they receive. `dimension`, `dimension_source`, `dimension_field` all carry `tenant_id` after PR1.

- [ ] **Step 1: Update `sourcesOf` signature + SQL**

In `server/src/repo-shared.ts`:

```ts
export async function sourcesOf(
  dimId: string,
  tenantId: string,
): Promise<SourceDef[]> {
  return pgAll<SourceDef>(
    `SELECT source_table AS "sourceTable", source_column AS "sourceColumn"
       FROM ${pg("dimension_source")}
      WHERE dim_id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
}
```

- [ ] **Step 2: Update `liveSources` to forward `tenantId`**

```ts
export async function liveSources(
  dimId: string,
  tenantId: string,
): Promise<SourceDef[]> {
  // identical body, but the underlying sourcesOf call passes tenantId through
  const all = await sourcesOf(dimId, tenantId);
  // … existing filter logic unchanged
  return all;
}
```

- [ ] **Step 3: Update `dimMeta` to take `tenantId`**

```ts
export async function dimMeta(dimId: string, tenantId: string): Promise<DimMeta | null> {
  return pgGet<DimMeta>(
    `SELECT id, label AS dimension, dim_table AS "dimTable",
            map_table AS "mapTable", key_col AS "keyCol", key_kind AS "keyKind"
       FROM ${pg("dimension")}
      WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
}
```

- [ ] **Step 4: Typecheck — expect many errors**

```bash
cd server && bun run typecheck 2>&1 | head -40
```
Expected: dozens of "Expected 2 arguments, got 1" errors at every call site. These all get fixed in Tasks 5–9 as we migrate the calling modules.

DON'T commit yet — the tree won't compile. Continue to Task 5.

---

## Task 5: Migrate `repo-canonical.ts` (18 fns)

**Files:**
- Modify: `server/src/repo-canonical.ts`
- Create: `server/test/repo-canonical-tenant.test.ts`

**Strategy:** Add `tenantId` as a required final positional parameter to every exported function. For read paths, append `AND tenant_id = $N` to every WHERE clause that hits a scoped table (`dimension`, `dimension_field`, `dimension_source`, `canonical_version`, plus the dynamic `dim_<id>`/`map_<id>` tables once Task 8 lands the column). For write paths, add `tenant_id` to every INSERT column list. `setFieldValue`, `renameCanonical`, `mergeCanonical`, `retireCanonical` already operate inside a tx — pass `tenantId` into the existing `pgTx` body.

- [ ] **Step 1: Write the failing isolation test first**

Create `server/test/repo-canonical-tenant.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as canonical from "../src/repo-canonical.ts";

const TA = "tcan_a";
const TB = "tcan_b";

async function cleanup(): Promise<void> {
  for (const t of [TA, TB]) {
    await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension_field" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  // Drop the dynamic dim_/map_ tables left over from prior runs
  await pgRun(`DROP TABLE IF EXISTS "zugzug_canonical"."dim_tcan_country"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug_canonical"."map_tcan_country"`);
}
beforeEach(cleanup);
afterAll(cleanup);

test("listDimensions is tenant-scoped", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await canonical.addDimension("tcan_country", [], { keyKind: "slug" }, "u_test", TA);

  const a = await canonical.listDimensions(TA);
  const b = await canonical.listDimensions(TB);
  expect(a.map((d) => d.id)).toContain("tcan_country");
  expect(b.map((d) => d.id)).not.toContain("tcan_country");
});

test("addCanonicalOne in tenant A is not visible from tenant B's getDimension", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await canonical.addDimension("tcan_country", [], { keyKind: "slug" }, "u_test", TA);
  await canonical.addCanonicalOne("tcan_country", "France", "fr", "u_test", TA);

  const dimA = await canonical.getDimension("tcan_country", TA);
  const dimB = await canonical.getDimension("tcan_country", TB);
  expect(dimA?.canonical.map((c) => c.key)).toContain("fr");
  expect(dimB).toBeNull();
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test repo-canonical-tenant 2>&1 | tail -20
```
Expected: FAIL — type errors or "dimension already exists in tenant" because the current functions are not yet tenant-scoped.

- [ ] **Step 3: Sweep `repo-canonical.ts`**

For each of the 18 exports, add `tenantId: string` as the last positional argument (or as a field on the existing options object where one is already present), and propagate it into every SQL string. Examples:

`listDimensions(tenantId: string)`:

```ts
export async function listDimensions(tenantId: string): Promise<DimensionMeta[]> {
  return pgAll<DimensionMeta>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", key_kind AS "keyKind", created_at AS "createdAt"
       FROM ${pg("dimension")}
      WHERE tenant_id = $1
      ORDER BY label`,
    [tenantId],
  );
}
```

`getDimension(id: string, tenantId: string)`:

```ts
export async function getDimension(id: string, tenantId: string): Promise<MappingDimension | null> {
  const meta = await dimMeta(id, tenantId);
  if (!meta) return null;
  // … rest unchanged but `sourcesOf(id, tenantId)`, `listFields(id, tenantId)` etc.
}
```

`addDimension` — pass through to dynamic-table creation (Task 8 wires `tenant_id` into the dim_/map_ DDL; for now thread the parameter so we can plumb it):

```ts
export async function addDimension(
  id: string,
  canonical: CanonicalValue[],
  opts: { keyKind: KeyKind },
  userId: string,
  tenantId: string,
): Promise<string> {
  // … existing body, but every INSERT into dimension / dimension_source includes
  //   tenant_id in the column list and tenantId in the value list.
}
```

For internal helpers (`bumpVersion`, `requireExpectedVersion`, etc. that operate on `canonical_version`), add `tenantId` to their SQL filter on `canonical_version.tenant_id`.

**Important:** the dynamic `dim_<id>` / `map_<id>` SQL inside `addDimension`, `addCanonical`, `setFieldValue`, etc. does NOT yet filter by tenant_id (Task 8 adds the column). For now, when issuing INSERT/UPDATE/DELETE on those dynamic tables, include `tenant_id` in the column list using `tenantId` from the parameter — Postgres will accept the literal `'default'` for legacy rows until the column actually exists. To keep PR2b incremental, wrap the dynamic-table writes in a comment:

```ts
// PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL stays
// per-tenant-implicit (tableName is globally unique → effectively per-tenant via
// addDimension's WHERE tenant_id = $N gate above).
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd server && bun run test repo-canonical-tenant 2>&1 | tail -10
```
Expected: 2 tests pass.

- [ ] **Step 5: Run the full suite — expect many call-site failures**

```bash
cd server && bun run test 2>&1 | tail -10
```
Expected: dozens of failures in `server.ts`-driven route tests, because routes still call `repo.listDimensions()` with no args. We fix those in Task 14. Continue.

- [ ] **Step 6: Commit (intermediate)**

```bash
git add server/src/repo-shared.ts server/src/repo-canonical.ts server/test/repo-canonical-tenant.test.ts
git commit -m "feat(repo-canonical): thread tenantId through 18 exports (MT PR2b)"
```

---

## Task 6: Migrate `repo-drafts.ts` (4 fns)

**Files:**
- Modify: `server/src/repo-drafts.ts`
- Create: `server/test/repo-drafts-tenant.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/test/repo-drafts-tenant.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as canonical from "../src/repo-canonical.ts";
import * as drafts from "../src/repo-drafts.ts";

const TA = "tdr_a";
const TB = "tdr_b";

async function cleanup(): Promise<void> {
  for (const t of [TA, TB]) {
    await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  await pgRun(`DROP TABLE IF EXISTS "zugzug_canonical"."dim_tdr_country"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug_canonical"."map_tdr_country"`);
}
beforeEach(cleanup);
afterAll(cleanup);

test("listDrafts is tenant-scoped", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await canonical.addDimension("tdr_country", [], { keyKind: "slug" }, "u_test", TA);
  await canonical.addDimension("tdr_country", [], { keyKind: "slug" }, "u_test", TB);

  await drafts.saveDraft("tdr_country", "FRA", "candidate", "France", "fr", "u_test", TA);

  expect((await drafts.listDrafts("tdr_country", TA)).map((d) => d.raw)).toContain("FRA");
  expect((await drafts.listDrafts("tdr_country", TB))).toEqual([]);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test repo-drafts-tenant 2>&1 | tail -10
```
Expected: FAIL.

- [ ] **Step 3: Update signatures + SQL in `server/src/repo-drafts.ts`**

```ts
export async function listDrafts(dimId: string, tenantId: string): Promise<Draft[]> {
  return pgAll<Draft>(
    `SELECT raw, status, target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS "userId", created_at AS "createdAt"
       FROM ${pg("draft")}
      WHERE dim_id = $1 AND tenant_id = $2
      ORDER BY created_at DESC`,
    [dimId, tenantId],
  );
}

export async function saveDraft(
  dimId: string,
  raw: string,
  status: DraftStatus,
  targetLabel: string | null,
  targetKey: string | null,
  userId: string,
  tenantId: string,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("draft")} (dim_id, raw, status, target_label, target_key, user_id, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, $7)
     ON CONFLICT (dim_id, raw) DO UPDATE
       SET status = EXCLUDED.status, target_label = EXCLUDED.target_label,
           target_key = EXCLUDED.target_key, user_id = EXCLUDED.user_id,
           created_at = EXCLUDED.created_at`,
    [dimId, raw, status, targetLabel, targetKey, userId, tenantId],
  );
}

export async function discardDraft(
  dimId: string,
  raw: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  await pgRun(
    `DELETE FROM ${pg("draft")} WHERE dim_id = $1 AND raw = $2 AND tenant_id = $3`,
    [dimId, raw, tenantId],
  );
  await appendAuditAs(userId, "discard_draft", `${dimId}: ${raw}`, { tenantId });
}

export async function commit(
  dimId: string,
  userId: string,
  tenantId: string,
): Promise<CommitResult> {
  // Existing body: open pgTx, read drafts WHERE dim_id AND tenant_id,
  // insert into dim_/map_ tables (already filtered by dim_id which is
  // tenant-unique today — see Task 5 note), DELETE drafts WHERE dim_id AND tenant_id.
}
```

For `commit`, also thread `tenantId` into the `getDimension` and `appendAuditAs` calls it makes.

- [ ] **Step 4: Run test, expect pass**

```bash
cd server && bun run test repo-drafts-tenant 2>&1 | tail -10
```
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-drafts.ts server/test/repo-drafts-tenant.test.ts
git commit -m "feat(repo-drafts): thread tenantId through 4 exports (MT PR2b)"
```

---

## Task 7: Migrate `repo-scan.ts` (11 fns) + `repo-ai-hint.ts` (1 fn) + `repo-activity.ts` (1 fn)

**Files:**
- Modify: `server/src/repo-scan.ts`
- Modify: `server/src/repo-ai-hint.ts`
- Modify: `server/src/repo-activity.ts`
- Create: `server/test/repo-scan-tenant.test.ts`
- Create: `server/test/repo-ai-hint-tenant.test.ts`
- Create: `server/test/repo-activity-tenant.test.ts`

**Why these are batched:** they're small and mechanically identical to Tasks 5 + 6.

### Sub-task 7a: `repo-scan.ts`

- [ ] **Step 1: Write `server/test/repo-scan-tenant.test.ts`** (model after Task 5's test)

Cover three behaviors: `listSources` is tenant-scoped; `sourceFacets` is tenant-scoped; `anyScanDue` accepts a `tenantId` (or `*` for super-admin scheduler iteration).

```ts
// ... boilerplate as before ...

test("listSources returns only sources owned by tenant A", async () => {
  await provisionTenant({ id: "tsc_a", label: "A" });
  await provisionTenant({ id: "tsc_b", label: "B" });
  await canonical.addDimension("tsc_dim", [], { keyKind: "slug" }, "u_test", "tsc_a");
  await scan.addSource("tsc_dim", "warehouse.tbl_a", "col", "tsc_a");

  const a = await scan.listSources({ tenantId: "tsc_a" });
  const b = await scan.listSources({ tenantId: "tsc_b" });
  expect(a.length).toBeGreaterThan(0);
  expect(b).toEqual([]);
});

test("anyScanDue('*') returns true if any tenant has a due scan, false otherwise", async () => {
  // Set scan_schedule for tenant A only; assert anyScanDue("*") respects it.
  // ...
});
```

- [ ] **Step 2: Sweep `server/src/repo-scan.ts`**

For every export, add a `tenantId: string` parameter (or for the three that already take an options object — `listSources`, `topUnmapped`, `searchCatalog` — add `tenantId` as a field on that object). Append `AND tenant_id = $N` to every SQL string that touches `dimension_source`, `source_stat`, `scan_run`, `dimension`, or `dimension_field`.

`anyScanDue` + `scanStatus` get a special branch:

```ts
export async function anyScanDue(now: Date, tenantId: string): Promise<boolean> {
  if (tenantId === "*") {
    // Scheduler asks across all tenants — check preferences for any tenant with
    // a due schedule.
    const row = await pgGet<{ due: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${pg("preferences")}
          WHERE scan_schedule IS NOT NULL
       ) AS due`,
    );
    return row?.due ?? false;
  }
  // existing single-tenant logic, filtered by preferences.tenant_id = $1
}
```

- [ ] **Step 3: Run test, expect pass**

```bash
cd server && bun run test repo-scan-tenant 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add server/src/repo-scan.ts server/test/repo-scan-tenant.test.ts
git commit -m "feat(repo-scan): thread tenantId through 11 exports (MT PR2b)"
```

### Sub-task 7b: `repo-ai-hint.ts`

- [ ] **Step 1: Write `server/test/repo-ai-hint-tenant.test.ts`**

Assert that an AI hint cached for tenant A's `(dim_id, raw)` does NOT satisfy tenant B's `getAiHint` call.

```ts
test("ai_hint_cache lookup is scoped by tenant_id", async () => {
  // Prime the cache by inserting a row directly into ai_hint_cache with tenant_id='tah_a'.
  // Call getAiHint("dim", "raw", [...], { label: "x" }, "tah_b") and verify a fresh
  // Claude call happens (mock the LLM) rather than a cache hit.
});
```

- [ ] **Step 2: Update `getAiHint` signature**

```ts
export async function getAiHint(
  dimId: string,
  raw: string,
  canonicalLabels: string[],
  meta: { label: string },
  tenantId: string,
): Promise<AiHint | null> {
  // SELECT … FROM ai_hint_cache WHERE dim_id = $1 AND raw = $2 AND tenant_id = $3
  // INSERT … INTO ai_hint_cache (..., tenant_id) VALUES (..., $N)
}
```

- [ ] **Step 3: Run, commit**

```bash
git add server/src/repo-ai-hint.ts server/test/repo-ai-hint-tenant.test.ts
git commit -m "feat(repo-ai-hint): scope cache lookup by tenant_id (MT PR2b)"
```

### Sub-task 7c: `repo-activity.ts`

- [ ] **Step 1: Write `server/test/repo-activity-tenant.test.ts`**

```ts
test("getRowActivitySince does not return audit entries from a different tenant", async () => {
  // Insert audit_log rows for tenant A and tenant B with the same table_id + row_key.
  // Call getRowActivitySince(tableId, since, "tact_a") and verify only A's rows.
});
```

- [ ] **Step 2: Update signature**

```ts
export async function getRowActivitySince(
  tableId: string,
  since: Date,
  tenantId: string,
): Promise<ActivityEntry[]> {
  // Add AND tenant_id = $N (or skip the filter when tenantId === '*' for super-admin)
}
```

- [ ] **Step 3: Run, commit**

```bash
git add server/src/repo-activity.ts server/test/repo-activity-tenant.test.ts
git commit -m "feat(repo-activity): scope getRowActivitySince by tenant_id (MT PR2b)"
```

---

## Task 8: Dynamic `dim_*`/`map_*` tables — add `tenant_id` column

**Files:**
- Modify: `server/src/repo-canonical.ts` — `addDimension` DDL adds `tenant_id` to the new tables; legacy DML now writes `tenant_id`
- Modify: `server/drizzle/migrations/0012_mt_pr2b_repo_sweep.sql` — backfill column on existing dim_*/map_* tables
- Create: `server/test/dim-map-tenant-column.test.ts`

- [ ] **Step 1: Append backfill DDL to `0012_*.sql`**

```sql
-- Add tenant_id to existing dynamic dim_/map_ tables. We discover them via the
-- dimension registry; each row gives us the canonical schema path.
DO $$
DECLARE
  d RECORD;
BEGIN
  FOR d IN SELECT id, dim_table, map_table, tenant_id FROM "zugzug_app"."dimension" LOOP
    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS tenant_id VARCHAR NOT NULL DEFAULT %L',
      d.dim_table, d.tenant_id
    );
    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS tenant_id VARCHAR NOT NULL DEFAULT %L',
      d.map_table, d.tenant_id
    );
  END LOOP;
END $$;
```

- [ ] **Step 2: Re-run migration**

```bash
cd server && bun run db:migrate
```

Verify on the test DB:

```bash
psql postgres://zugzug:zugzug@localhost:55432/zugzug_test -c "\d zugzug_canonical.dim_country" 2>/dev/null | head -10
```
Expected: `tenant_id` column present (if the test DB has any pre-existing dim_country table from prior runs).

- [ ] **Step 3: Update `addDimension` DDL in `server/src/repo-canonical.ts`**

```ts
await tx.run(
  `CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (
     ${qid(keyCol)} VARCHAR PRIMARY KEY,
     ${labelDdl},
     tenant_id VARCHAR NOT NULL DEFAULT $1
   )`,
  [tenantId],
);
```

Wait — DEFAULT can't be parametrized. Instead, after validating `tenantId` against the same regex used in `pgTxScoped` (Task 12 will move this to a shared helper), inline it:

```ts
const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$/;
if (!TENANT_ID_RE.test(tenantId)) {
  throw new Error(`addDimension: invalid tenant_id ${tenantId}`);
}
const tenantLit = `'${tenantId}'`;
await tx.run(
  `CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (
     ${qid(keyCol)} VARCHAR PRIMARY KEY,
     ${labelDdl},
     tenant_id VARCHAR NOT NULL DEFAULT ${tenantLit}
   )`,
);
// same for map_<id>
```

- [ ] **Step 4: Write the test**

`server/test/dim-map-tenant-column.test.ts`:

```ts
test("addDimension creates dim_/map_ tables with tenant_id NOT NULL DEFAULT '<tenant>'", async () => {
  await provisionTenant({ id: "tdyn_a", label: "A" });
  await canonical.addDimension("tdyn_thing", [], { keyKind: "slug" }, "u_test", "tdyn_a");
  const cols = await pgAll<{ column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'zugzug_canonical' AND table_name = 'dim_tdyn_thing'`,
  );
  const tCol = cols.find((c) => c.column_name === "tenant_id");
  expect(tCol).toBeDefined();
  expect(tCol?.is_nullable).toBe("NO");
  expect(tCol?.column_default).toContain("tdyn_a");
});
```

- [ ] **Step 5: Run, expect pass; commit**

```bash
cd server && bun run test dim-map-tenant-column 2>&1 | tail -10
git add server/src/repo-canonical.ts server/drizzle/migrations/0012_mt_pr2b_repo_sweep.sql server/test/dim-map-tenant-column.test.ts
git commit -m "feat(repo-canonical): tenant_id column on dynamic dim_/map_ tables (MT PR2b)"
```

---

## Task 9: Extend `TenantRepo` with ~40 forwarder methods

**Files:**
- Modify: `server/src/tenant-repo.ts`

**Strategy:** group methods by source module. Each method is a one-liner: `assertRole(...)` for mutations, then `return repoX.fn(args, this.tenantId)`. Use `*` scope passthrough for super-admin where the underlying fn supports it (`listAudit`, `anyScanDue`, `getRowActivitySince`).

- [ ] **Step 1: Add canonical methods to `TenantRepo`**

```ts
  // --- canonical (read) ---
  listDimensions() { return repoCanonical.listDimensions(this.tenantId); }
  getDimension(id: string) { return repoCanonical.getDimension(id, this.tenantId); }
  listFields(dimId: string) { return repoCanonical.listFields(dimId, this.tenantId); }
  listVariants(dimId: string, key: string) {
    return repoCanonical.listVariants(dimId, key, this.tenantId);
  }

  // --- canonical (mutate) ---
  addDimension(name: string, vals: CanonicalValue[], opts: { keyKind: KeyKind }, userId: string) {
    this.assertRole("manage_adapter");
    return repoCanonical.addDimension(name, vals, opts, userId, this.tenantId);
  }
  addCanonical(dimId: string, values: CanonicalValue[]) {
    this.assertRole("commit");
    return repoCanonical.addCanonical(dimId, values, this.tenantId);
  }
  addCanonicalOne(dimId: string, label: string, key: string, userId: string) {
    this.assertRole("commit");
    return repoCanonical.addCanonicalOne(dimId, label, key, userId, this.tenantId);
  }
  importCanonical(dimId: string, rows: ImportRow[], userId: string) {
    this.assertRole("commit");
    return repoCanonical.importCanonical(dimId, rows, userId, this.tenantId);
  }
  renameCanonical(dimId: string, key: string, label: string, userId: string, expectedVersion?: number) {
    this.assertRole("curate");
    return repoCanonical.renameCanonical(dimId, key, label, userId, this.tenantId, expectedVersion);
  }
  mergeCanonical(dimId: string, survivor: string, losers: string[], userId: string, expectedVersions: Record<string, number>) {
    this.assertRole("curate");
    return repoCanonical.mergeCanonical(dimId, survivor, losers, userId, this.tenantId, expectedVersions);
  }
  retireCanonical(dimId: string, key: string, userId: string, expectedVersion?: number) {
    this.assertRole("curate");
    return repoCanonical.retireCanonical(dimId, key, userId, this.tenantId, expectedVersion);
  }
  setFieldValue(dimId: string, key: string, field: string, value: unknown) {
    this.assertRole("curate");
    return repoCanonical.setFieldValue(dimId, key, field, value, this.tenantId);
  }
  addField(dimId: string, field: string, label: string, type: FieldType, options: OptionDef[] | undefined, userId: string) {
    this.assertRole("manage_adapter");
    return repoCanonical.addField(dimId, field, label, type, options, userId, this.tenantId);
  }
  updateField(dimId: string, field: string, label: string | null, description: string | null, userId: string) {
    this.assertRole("manage_adapter");
    return repoCanonical.updateField(dimId, field, label, description, userId, this.tenantId);
  }
  renameColumn(dimId: string, field: string, label: string, userId: string) {
    this.assertRole("manage_adapter");
    return repoCanonical.renameColumn(dimId, field, label, userId, this.tenantId);
  }
  changeColumnType(dimId: string, field: string, args: { type: FieldType; options?: OptionDef[] }, userId: string) {
    this.assertRole("manage_adapter");
    return repoCanonical.changeColumnType(dimId, field, args, userId, this.tenantId);
  }
  deleteColumn(dimId: string, field: string, userId: string) {
    this.assertRole("manage_adapter");
    return repoCanonical.deleteColumn(dimId, field, userId, this.tenantId);
  }
  addColumnOption(dimId: string, field: string, label: string, color: PaletteName | null, userId: string) {
    this.assertRole("curate");
    return repoCanonical.addColumnOption(dimId, field, label, color, userId, this.tenantId);
  }
```

- [ ] **Step 2: Add drafts methods**

```ts
  listDrafts(dimId: string) { return repoDrafts.listDrafts(dimId, this.tenantId); }
  saveDraft(dimId: string, raw: string, status: DraftStatus, targetLabel: string | null, targetKey: string | null, userId: string) {
    this.assertRole("curate");
    return repoDrafts.saveDraft(dimId, raw, status, targetLabel, targetKey, userId, this.tenantId);
  }
  discardDraft(dimId: string, raw: string, userId: string) {
    this.assertRole("curate");
    return repoDrafts.discardDraft(dimId, raw, userId, this.tenantId);
  }
  commit(dimId: string, userId: string) {
    this.assertRole("commit");
    return repoDrafts.commit(dimId, userId, this.tenantId);
  }
```

- [ ] **Step 3: Add scan methods**

```ts
  listSources(args: ListSourcesArgs) {
    return repoScan.listSources({ ...args, tenantId: this.tenantId });
  }
  sourceFacets() { return repoScan.sourceFacets(this.tenantId); }
  scanSources() {
    this.assertRole("manage_adapter");
    return repoScan.scanSources(this.tenantId);
  }
  dimensionsWithWiredSources() { return repoScan.dimensionsWithWiredSources(this.tenantId); }
  autoStageExactMatches(dimId: string) {
    this.assertRole("curate");
    return repoScan.autoStageExactMatches(dimId, this.tenantId);
  }
  addSource(dimId: string, table: string, column: string) {
    this.assertRole("manage_adapter");
    return repoScan.addSource(dimId, table, column, this.tenantId);
  }
  topUnmapped(dimId: string, table: string, column: string, limit: number) {
    return repoScan.topUnmapped(dimId, table, column, limit, this.tenantId);
  }
  anyScanDue(now: Date) {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return repoScan.anyScanDue(now, scope);
  }
  scanStatus() {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return repoScan.scanStatus(scope);
  }
  searchCatalog(args: SearchCatalogArgs) {
    return repoScan.searchCatalog({ ...args, tenantId: this.tenantId });
  }
  deriveCanonical(dimId: string, table: string, column: string, nameColumn: string | null, opts: DeriveOpts, userId: string) {
    this.assertRole("commit");
    return repoScan.deriveCanonical(dimId, table, column, nameColumn, opts, userId, this.tenantId);
  }
```

- [ ] **Step 4: Add ai-hint + activity + meta forwarders**

```ts
  getAiHint(dimId: string, raw: string, canonicalLabels: string[], meta: { label: string }) {
    return repoAiHint.getAiHint(dimId, raw, canonicalLabels, meta, this.tenantId);
  }

  getRowActivitySince(tableId: string, since: Date) {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return repoActivity.getRowActivitySince(tableId, since, scope);
  }

  // Per-USER, not per-tenant — these stay on `repoMeta` and ignore this.tenantId.
  getGridLayout(userId: string, dimId: string) { return repoMeta.getGridLayout(userId, dimId); }
  setGridLayout(userId: string, dimId: string, body: GridLayoutConfig) {
    return repoMeta.setGridLayout(userId, dimId, body);
  }
  listUsers() { return repoMeta.listUsers(); }
```

Add the required imports at the top of `tenant-repo.ts`.

- [ ] **Step 5: Typecheck**

```bash
cd server && bun run typecheck 2>&1 | tail -10
```
Expected: clean inside `tenant-repo.ts`. Errors elsewhere are call-site issues fixed in Task 14.

- [ ] **Step 6: Commit**

```bash
git add server/src/tenant-repo.ts
git commit -m "feat(tenant-repo): forwarder methods for canonical/drafts/scan/ai-hint/activity (MT PR2b)"
```

---

## Task 10: `TenantRepo` Proxy defense-in-depth on `pg`

**Files:**
- Modify: `server/src/pg.ts` — expose a `requireTenantContext()` getter
- Modify: `server/src/tenant-repo.ts` — set + clear an AsyncLocalStorage flag around forwarder calls
- Create: `server/test/tenant-repo-proxy.test.ts`

**Why this exists:** the spec calls for runtime defense-in-depth: code inside a TenantRepo call that bypasses the class and calls `pg`-client directly should fail loudly. ESLint catches obvious cases at lint time; this catches the rest at runtime in dev/test. **Disabled in production** (where any extra perf cost matters); we rely on RLS in Deploy 2 for the real backstop.

- [ ] **Step 1: Add AsyncLocalStorage in `pg.ts`**

```ts
import { AsyncLocalStorage } from "node:async_hooks";

interface PgContext {
  insideTenantRepo: boolean;
}
export const pgContext = new AsyncLocalStorage<PgContext>();

/** Throws if the current async context is inside a TenantRepo call and the caller
 *  used a module-level `pg*` function instead of `TenantRepo`. No-op in production. */
export function assertNotInsideTenantRepo(fnName: string): void {
  if (process.env.NODE_ENV === "production") return;
  const ctx = pgContext.getStore();
  if (ctx?.insideTenantRepo) {
    throw new Error(
      `pg.${fnName} called from inside TenantRepo — use this.tenantId-scoped methods instead`,
    );
  }
}
```

Then in `pgAll`, `pgGet`, `pgRun`, `pgTxRaw`, add `assertNotInsideTenantRepo("all")` etc. as the first statement.

**Note:** `pgTxScoped` does NOT add the assertion — TenantRepo IS supposed to call it. The forwarders in `repo-*.ts` are also exempt because they're invoked via TenantRepo and would false-positive; only direct `pg*` calls from route handlers are caught. To draw the line properly, wrap every TenantRepo method body in `pgContext.run({ insideTenantRepo: false }, …)` to clear the flag when entering legitimate forwarders, and have the route layer's `req.repo` wrapper set the flag to `true` ONLY for the duration of the handler.

Actually — invert it. The handler sets `pgContext.run({ insideTenantRepo: true }, fn)` around its body; legitimate forwarders inside TenantRepo first clear the flag, do work, then the flag is restored on return via AsyncLocalStorage semantics.

- [ ] **Step 2: Wrap forwarders in `tenant-repo.ts`**

Define a private helper:

```ts
  private withClearCtx<T>(fn: () => Promise<T>): Promise<T> {
    return pgContext.run({ insideTenantRepo: false }, fn);
  }
```

Wrap every forwarder body, e.g.:

```ts
  listDimensions() {
    return this.withClearCtx(() => repoCanonical.listDimensions(this.tenantId));
  }
```

- [ ] **Step 3: Set the flag in `server.ts`**

In the `handle()` body, just before dispatching to route bodies:

```ts
return pgContext.run({ insideTenantRepo: true }, async () => {
  // existing route table
});
```

- [ ] **Step 4: Write the test**

`server/test/tenant-repo-proxy.test.ts`:

```ts
import { pgContext, pgAll } from "../src/pg.ts";

test("direct pgAll inside the route handler context throws", async () => {
  let thrown: Error | null = null;
  try {
    await pgContext.run({ insideTenantRepo: true }, async () => {
      await pgAll(`SELECT 1`);
    });
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown?.message).toContain("inside TenantRepo");
});

test("pgAll inside a TenantRepo forwarder does NOT throw", async () => {
  await provisionTenant({ id: "tprx", label: "X" });
  const repo = new TenantRepo("tprx", "admin");
  // listDimensions internally calls pgAll, but withClearCtx removes the flag.
  await pgContext.run({ insideTenantRepo: true }, async () => {
    await repo.listDimensions(); // must not throw
  });
});

test("pgAll OUTSIDE any context (e.g. scheduler boot) does not throw", async () => {
  await pgAll(`SELECT 1`); // no enclosing pgContext.run — production-style call
});
```

- [ ] **Step 5: Run, commit**

```bash
cd server && bun run test tenant-repo-proxy 2>&1 | tail -10
git add server/src/pg.ts server/src/tenant-repo.ts server/test/tenant-repo-proxy.test.ts
git commit -m "feat(tenant-repo): runtime guard on direct pg usage in route ctx (MT PR2b)"
```

---

## Task 11: Scheduler — per-tenant tick loop

**Files:**
- Modify: `server/src/scheduler.ts`
- Modify: `server/src/server.ts` — scheduler bootstrap passes a TenantRepo factory
- Create: `server/test/scheduler-multi-tenant.test.ts`

**Why this changes:** PR2a's scheduler still calls `repo.anyScanDue(new Date())` and `repo.scanSources()` with no tenant. Now that the repo functions require `tenantId`, the scheduler must either pass `*` (super-admin) or iterate tenants. The spec calls for iteration so each tenant's `SET LOCAL` provides the right isolation.

- [ ] **Step 1: Write the failing test**

`server/test/scheduler-multi-tenant.test.ts`:

```ts
test("createScheduler.tick() runs each job once per tenant per tick", async () => {
  await provisionTenant({ id: "tsch_a", label: "A" });
  await provisionTenant({ id: "tsch_b", label: "B" });

  const ran: Array<{ tenantId: string; jobName: string }> = [];
  const sched = createScheduler({
    tickIntervalMs: 1_000_000,
    listTenants: async () => [{ id: "tsch_a" }, { id: "tsch_b" }],
    shouldRun: () => true,
    jobs: [
      {
        name: "fake",
        run: async (ctx) => {
          ran.push({ tenantId: ctx.tenantId, jobName: "fake" });
          return {};
        },
      },
    ],
  });
  await sched._tick();
  expect(ran.map((r) => r.tenantId).sort()).toEqual(["tsch_a", "tsch_b"]);
});
```

- [ ] **Step 2: Extend `SchedulerJob` interface in `server/src/scheduler.ts`**

```ts
export interface SchedulerJob {
  name: string;
  run(ctx: JobContext): Promise<JobResult>;
}

export interface JobContext {
  signal: AbortSignal;
  tenantId: string;          // NEW
  repo: TenantRepo;          // NEW — pre-bound, role='admin', isSuperAdmin=true (system principal)
}
```

```ts
export interface SchedulerOpts {
  tickIntervalMs: number;
  jobs: SchedulerJob[];
  shouldRun?: (tenantId: string) => Promise<boolean>;
  /** Returns the list of tenants to iterate. Default: SELECT id FROM tenant WHERE deleted_at IS NULL. */
  listTenants?: () => Promise<Array<{ id: string }>>;
}
```

`createScheduler` tick body becomes:

```ts
const tenants = await (opts.listTenants ?? defaultListTenants)();
for (const t of tenants) {
  const due = !opts.shouldRun || (await opts.shouldRun(t.id));
  if (!due) continue;
  await pgTxScoped(t.id, async () => {
    const repo = new TenantRepo(t.id, "admin", true);
    for (const job of jobs) {
      await recordScanRun(`${t.id}:${job.name}`, () =>
        job.run({ signal: abortCtl.signal, tenantId: t.id, repo }),
      );
    }
  });
}
```

`defaultListTenants`:

```ts
async function defaultListTenants(): Promise<Array<{ id: string }>> {
  return pgAll<{ id: string }>(
    `SELECT id FROM ${pg("tenant")} WHERE deleted_at IS NULL ORDER BY id`,
  );
}
```

- [ ] **Step 3: Update the three jobs in `server/src/server.ts`**

Each job becomes a closure over the `ctx.repo`:

```ts
const scanSourcesJob: SchedulerJob = {
  name: "scan-sources",
  run: async (ctx) => ({ rowsScanned: await ctx.repo.scanSources() }),
};

const autoStageJob: SchedulerJob = {
  name: "auto-stage",
  run: async (ctx) => {
    const dims = await ctx.repo.listDimensions();
    for (const d of dims) await ctx.repo.autoStageExactMatches(d.id);
    return {};
  },
};

const autoCommitJob: SchedulerJob = {
  name: "auto-commit",
  run: async (ctx) => {
    // existing body re-targeted at ctx.repo
  },
};

const scheduler = createScheduler({
  tickIntervalMs: 60_000,
  shouldRun: async (tenantId) => {
    const probe = new TenantRepo(tenantId, "admin", true);
    return probe.anyScanDue(new Date());
  },
  jobs: [scanSourcesJob, autoStageJob, autoCommitJob],
});
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd server && bun run test scheduler-multi-tenant 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add server/src/scheduler.ts server/src/server.ts server/test/scheduler-multi-tenant.test.ts
git commit -m "feat(scheduler): per-tenant tick loop with bound TenantRepo (MT PR2b)"
```

---

## Task 12: WebSocket presence — `/ws/t/:slug/presence/:tableId`

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/realtime/presence-room.ts`
- Create: `server/test/ws-presence-tenant-namespacing.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/ws-presence-tenant-namespacing.test.ts`:

```ts
test("same tableId in two tenants does NOT bridge presence", async () => {
  // Connect ws_a to /ws/t/tenant_a/presence/dim_country
  // Connect ws_b to /ws/t/tenant_b/presence/dim_country
  // ws_a.send({ type: "awareness", … })
  // ws_b must NOT receive the message.
});
```

(Implementation note: re-use the WS test harness from PR1's presence test if present — `server/test/presence-room.test.ts`. If the harness only supports the legacy URL, extend it.)

- [ ] **Step 2: Add the new path to the Bun.serve `fetch` block**

In `server/src/server.ts`, replace the existing `/ws/presence/:tableId` block with two branches:

```ts
if (url.pathname.startsWith("/ws/t/")) {
  // Shape: /ws/t/:slug/presence/:tableId
  const m = /^\/ws\/t\/([^/]+)\/presence\/(.+)$/.exec(url.pathname);
  if (!m) return new Response("bad ws path", { status: 400 });
  const slug = decodeURIComponent(m[1]!);
  const tableId = decodeURIComponent(m[2]!);

  let session = await getSessionUser(req);
  if (!session) session = await (await import("./auth-api-tokens.ts")).getApiTokenUser(req);
  if (!session) return new Response("unauthorized", { status: 401 });

  const tenant = await tenantBySlug(slug);
  if (!tenant) return new Response("workspace not found", { status: 404 });
  const role = await memberRole(tenant.id, session.id);
  if (!role && !session.isSuperAdmin) return new Response("forbidden", { status: 403 });

  const ok = srv.upgrade(req, {
    data: {
      tableId,
      tenantId: tenant.id,
      userId: session.id,
      displayName: session.name,
    } satisfies PresenceWsData,
  });
  return ok ? undefined : new Response("upgrade failed", { status: 500 });
}

// Legacy /ws/presence/:tableId — keep for one release; treat as default tenant.
if (url.pathname.startsWith("/ws/presence/")) {
  // existing block, but inject tenantId="default" into the upgrade data
}
```

Extend the `PresenceWsData` interface to carry `tenantId`.

- [ ] **Step 3: Tenant-prefix the room key in `presence-room.ts`**

```ts
function roomKey(tenantId: string, tableId: string): string {
  return `${tenantId}${tableId}`;
}

// Update every method that takes (tableId, ws) to take (tableId, ws, tenantId)
// and call `roomKey(tenantId, tableId)` for the map lookup.
```

Update the callers in `server.ts`:

```ts
presence.join(ws.data.tableId, ws as unknown as ServerWebSocket, ws.data.tenantId);
presence.broadcastAwareness(ws.data.tableId, payload, ws as unknown as ServerWebSocket, ws.data.tenantId);
presence.leave(ws.data.tableId, ws as unknown as ServerWebSocket, ws.data.tenantId);
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd server && bun run test ws-presence-tenant-namespacing 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/realtime/presence-room.ts server/test/ws-presence-tenant-namespacing.test.ts
git commit -m "feat(ws): namespace presence rooms by tenant (/ws/t/:slug/...) (MT PR2b)"
```

---

## Task 13: Admin routes — `/api/admin/audit`, `/api/admin/impersonate`, `/api/admin/tenants/:id/teardown`

**Files:**
- Modify: `server/src/server.ts` — three new route handlers
- Modify: `server/src/tenant.ts` — `teardownTenant()` impl
- Modify: `server/src/auth.ts` — session may carry an `impersonating` field
- Create: `server/test/admin-audit-route.test.ts`
- Create: `server/test/admin-impersonate-route.test.ts`
- Create: `server/test/admin-teardown-route.test.ts`

### Sub-task 13a: `GET /api/admin/audit`

Returns the cross-tenant audit feed. Builds the same as `/api/audit` but with `tenantId='*'`.

- [ ] **Step 1: Test**

```ts
test("GET /api/admin/audit returns entries from multiple tenants", async () => {
  // Provision two tenants, append audit in each, log in as super-admin,
  // GET /api/admin/audit?limit=10, assert entries from both tenants present.
});
```

- [ ] **Step 2: Implement**

In `server.ts` admin block:

```ts
if (seg[1] === "admin" && seg[2] === "audit" && method === "GET") {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
  const filterTenant = url.searchParams.get("tenant_id");
  const scope = filterTenant ?? "*";
  const adminRepo = new TenantRepo(scope, "admin", true);
  return json(await adminRepo.listAudit(limit));
}
```

- [ ] **Step 3: Run + commit**

### Sub-task 13b: `POST /api/admin/impersonate/:tenant_id`

Sets a session-scoped impersonation flag. Subsequent `/api/t/:slug/*` requests use it.

- [ ] **Step 1: Schema sanity check — does `active_sessions` have an `impersonating_tenant_id` column?**

```bash
psql postgres://zugzug:zugzug@localhost:55432/zugzug_test -c "\d zugzug_app.active_sessions" | grep -i impersonat
```

If not present, add a migration step here (append to `0012_*.sql`):

```sql
ALTER TABLE "zugzug_app"."active_sessions"
  ADD COLUMN "impersonating_tenant_id" VARCHAR;
```

Re-run `bun run db:migrate`.

- [ ] **Step 2: Test**

```ts
test("POST /api/admin/impersonate/:t flips effective tenant for subsequent requests", async () => {
  // Super-admin starts. POST /api/admin/impersonate/tnonmem.
  // Subsequent /api/t/tnonmem/preferences should succeed WITHOUT membership.
  // (Already true via the super-admin bypass in tenant-middleware — this test
  // verifies the audit_log row is written + the session reflects the flag.)
});

test("POST /api/admin/impersonate clears with empty body", async () => {
  // POST /api/admin/impersonate with no body → clears the flag.
});
```

- [ ] **Step 3: Implement**

Add route:

```ts
if (seg[1] === "admin" && seg[2] === "impersonate" && method === "POST") {
  const targetTenant = seg[3] ? decodeURIComponent(seg[3]) : null;
  if (targetTenant) {
    const t = await tenantBySlug(targetTenant);
    if (!t) return json({ error: "tenant_not_found" }, 404);
    await pgRun(
      `UPDATE ${pg("active_sessions")} SET impersonating_tenant_id = $1 WHERE token = $2`,
      [t.id, sessionToken],
    );
    await new TenantRepo(t.id, "admin", true).appendAudit(
      sessionUser.id, "impersonate_start", `super-admin → ${t.id}`,
    );
  } else {
    await pgRun(
      `UPDATE ${pg("active_sessions")} SET impersonating_tenant_id = NULL WHERE token = $2`,
      [sessionToken],
    );
  }
  return json({ ok: true });
}
```

Also extend `getSessionUser` to read `impersonating_tenant_id` and `tenant-middleware` to honor it for super-admins.

- [ ] **Step 4: Run + commit**

### Sub-task 13c: `POST /api/admin/tenants/:id/teardown`

Hard-delete a tenant and all its rows. Super-admin only.

- [ ] **Step 1: Implement `teardownTenant()` in `server/src/tenant.ts`**

```ts
export async function teardownTenant(tenantId: string): Promise<void> {
  if (tenantId === "default") throw new Error("cannot teardown the default tenant");
  await pgTxRaw(async (tx) => {
    const scoped = [
      "draft", "audit_log", "ai_hint_cache", "canonical_version",
      "scan_run", "source_stat", "dimension_field", "dimension_source",
      "dimension", "active_sessions", "preferences",
      "tenant_member", "tenant_invite",
    ];
    for (const tbl of scoped) {
      await tx.run(`DELETE FROM "zugzug_app"."${tbl}" WHERE tenant_id = $1`, [tenantId]);
    }
    // Dynamic dim_/map_ tables: drop them. Discover via what was registered
    // BEFORE the dimension DELETE — capture first.
    // (Actually order this correctly: read dim_table/map_table from dimension
    // BEFORE deleting that row.)
    await tx.run(`UPDATE "zugzug_app"."tenant" SET deleted_at = now() WHERE id = $1`, [tenantId]);
  });
}
```

Order matters — fix the body to capture `(dim_table, map_table)` FIRST, then DROP TABLE, then DELETE from dimension, then the rest. Verify in the test.

- [ ] **Step 2: Test**

```ts
test("POST /api/admin/tenants/:id/teardown removes all tenant rows + drops dim_/map_ tables", async () => {
  // Provision tenant, add a dimension (creates dim_/map_), insert audit,
  // POST teardown, assert: 0 rows in scoped tables, dim_/map_ tables dropped,
  // tenant.deleted_at IS NOT NULL.
});

test("POST /api/admin/tenants/default/teardown → 400", async () => {});
```

- [ ] **Step 3: Wire route + commit**

```bash
git add server/src/server.ts server/src/tenant.ts server/test/admin-audit-route.test.ts server/test/admin-teardown-route.test.ts server/test/admin-impersonate-route.test.ts
git commit -m "feat(admin): audit / impersonate / teardown super-admin routes (MT PR2b)"
```

---

## Task 14: Flip every `/api/*` route handler from `repo.*` to `req.repo.*`

**Files:**
- Modify: `server/src/server.ts`

**Strategy:** mechanical find-and-replace. Each `repo.fn(args)` becomes `req.repo.fn(args')` where `args'` drops the trailing `tenantId` (now sourced from `this.tenantId` inside TenantRepo) AND drops `userId` only where `appendAudit` is the wrapping concern (TenantRepo's `appendAudit` already threads it). The route handlers keep `me` (the session user id) as before for ownership-style arguments — `addCanonicalOne(id, label, key, me)` becomes `reqRepo.addCanonicalOne(id, label, key, me)`.

- [ ] **Step 1: Replace the call sites — read-side first**

In `server.ts`, find every `await repo.<readFn>(...)` and replace with `await reqRepo.<readFn>(...)`. The TenantRepo forwarder strips the trailing `tenantId` so the route arg shape is unchanged from PR2a.

Audit your replacements with:

```bash
grep -n "await repo\." server/src/server.ts
```
Expected after pass: zero matches.

```bash
grep -n "reqRepo\." server/src/server.ts | wc -l
```
Expected: ~30+ matches (one per route).

- [ ] **Step 2: Replace mutation call sites**

Same as Step 1 but for mutation routes. Important: drop the manual `assertCanCurate(me)` / `assertCanCommit(me)` calls — `TenantRepo.assertRole(op)` does this inside the forwarder. Removing the duplicate check at the route layer is the point of the abstraction. **Don't** drop the session/auth gate; that runs before tenant resolution.

- [ ] **Step 3: Run the full test suite**

```bash
cd server && bun run test 2>&1 | tail -10
```
Expected: ~260+ tests passing (the route tests that were failing since Task 5 should be green again). Any remaining failures are signatures the TenantRepo forwarder forgot to expose — add them.

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck 2>&1 | tail -10
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts
git commit -m "refactor(server): every route uses req.repo, no module-repo calls (MT PR2b)"
```

---

## Task 15: Unexport the module-level repo functions

**Files:**
- Modify: `server/src/repo.ts` — drop the `export *` barrel
- Modify: `server/src/repo-canonical.ts`, `repo-drafts.ts`, `repo-scan.ts`, `repo-ai-hint.ts`, `repo-activity.ts` — keep `export` (used by `TenantRepo` and scheduler bootstrap) but verify no other consumers

**Why this exists:** the spec calls for module-private repo functions and `TenantRepo` as the only public surface. We can't truly make them private (TenantRepo imports them), but we can collapse the `repo.ts` barrel — any caller that did `import * as repo from "./repo.ts"` now has to import from a specific repo module, which makes module-repo usage hyper-visible in code review.

- [ ] **Step 1: Audit current barrel users**

```bash
grep -rn "from \"./repo.ts\"" server/src/ server/test/
```

- [ ] **Step 2: Replace `server.ts`'s `import * as repo from "./repo.ts"`**

This should already be gone after Task 14 (no `repo.*` calls left). Remove the import line if so.

- [ ] **Step 3: Decide what to do with the scheduler bootstrap**

`server.ts` builds the SchedulerJobs in module scope; they import `TenantRepo` and don't need `repo`. Confirm by typechecking after removal:

```bash
cd server && bun run typecheck 2>&1 | tail -5
```

- [ ] **Step 4: Trim `server/src/repo.ts`**

Replace it with:

```ts
// This file used to re-export every repo-*.ts function as a barrel. Multi-tenant
// PR2b moved the public surface to TenantRepo (server/src/tenant-repo.ts).
//
// New code MUST import TenantRepo and use req.repo.*. The remaining direct imports
// from "./repo-*.ts" are only:
//   - tenant-repo.ts (the forwarder)
//   - scheduler.ts (system jobs)
//   - tests (allowed)
//
// Leaving this file empty keeps the import path's git history clean; we may
// delete it in PR5 once Deploy 2 is out.
export {};
```

- [ ] **Step 5: Sweep tests**

```bash
grep -rn "from \"../src/repo.ts\"" server/test/
```

For each match, change to the specific module (`../src/repo-canonical.ts`, etc.). Run tests after each change.

- [ ] **Step 6: Run full suite + commit**

```bash
cd server && bun run test 2>&1 | tail -5
git add server/src/repo.ts server/src/server.ts server/test/
git commit -m "refactor(repo): collapse barrel; TenantRepo is the public surface (MT PR2b)"
```

---

## Task 16: ESLint guard against direct repo-module usage in `server.ts`

**Files:**
- Modify: `server/eslint.config.js`

- [ ] **Step 1: Add a `no-restricted-imports` rule scoped to `server/src/server.ts`**

```js
{
  files: ["src/server.ts"],
  rules: {
    "no-restricted-imports": ["warn", {
      patterns: [{
        group: ["./repo-*.ts", "./repo.ts"],
        message: "server.ts must not import repo modules directly — use req.repo (TenantRepo).",
      }],
    }],
  },
},
```

Soft warn for now; flip to `error` in Deploy 2 (PR5).

- [ ] **Step 2: Verify**

```bash
cd server && bun run lint 2>&1 | grep -c "no-restricted-imports" 
```
Expected: 0 (Task 14 + 15 removed all such imports). If non-zero, find and fix.

- [ ] **Step 3: Commit**

```bash
git add server/eslint.config.js
git commit -m "chore(eslint): warn on direct repo imports from server.ts (MT PR2b)"
```

---

## Task 17: Smoke test end-to-end via curl

**Files:** none.

- [ ] **Step 1: Reset the dev DB**

```bash
cd server && bun run db:migrate
```

- [ ] **Step 2: Start the server**

```bash
cd server && bun run start
```

(Leave running in another shell.)

- [ ] **Step 3: Provision a second tenant + verify scoping**

```bash
cd server && bun run scripts/admin.ts provision-tenant --id sb --label Sportsbook
cd server && bun run scripts/admin.ts add-member sb <your-user-id> admin
```

Hit the routes (assumes your session cookie is in $COOKIE):

```bash
curl -s -H "Cookie: $COOKIE" http://localhost:8787/api/dimensions | jq '.[].id'
curl -s -H "Cookie: $COOKIE" http://localhost:8787/api/t/sb/dimensions | jq '.[].id'
```
Expected: the two requests return different arrays (default's dimensions vs sb's empty array).

```bash
curl -s -H "Cookie: $COOKIE" -X POST -H 'Content-Type: application/json' \
  -d '{"name":"Test","keyKind":"slug"}' http://localhost:8787/api/t/sb/dimensions
curl -s -H "Cookie: $COOKIE" http://localhost:8787/api/dimensions | jq '.[].id'
```
Expected: the default tenant still does NOT see the `Test` dimension created in `sb`.

- [ ] **Step 4: Verify the scheduler runs cleanly across tenants**

Watch server logs for 60s. Expected: per-tick log shows both tenants' jobs running, no errors.

- [ ] **Step 5: WS presence sanity (manual)**

Open the app in two tabs with `/app/sb/...` and `/app/default/...`. Move the cursor in tab 1; tab 2 should NOT show the remote cursor.

- [ ] **Step 6: Commit nothing — this task only verifies**

---

## Task 18: Open the PR

**Files:** none.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin mt-pr2b-repo-sweep
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "MT PR2b — Repo sweep + scheduler + WS + admin" --body "$(cat <<'EOF'
## Summary

- Threads `tenantId` through every `repo-*.ts` function (~40 fns across 7 modules)
- `TenantRepo` now exposes the full repo surface as forwarders with role checks
- Every `/api/*` route uses `req.repo`; module-level `repo.*` is gone from `server.ts`
- Scheduler iterates tenants per tick, opens one `pgTxScoped(tenantId, …)` per tenant
- WebSocket presence is namespaced: `/ws/t/:slug/presence/:tableId`, room key prefixed with `tenantId`
- Super-admin routes: `/api/admin/audit`, `/api/admin/impersonate/:t`, `/api/admin/tenants/:id/teardown`
- `preferences` UNIQUE(tenant_id) + single-statement upsert fixes the PR2a race
- Dynamic `dim_*/map_*` tables get `tenant_id NOT NULL DEFAULT '<tenant>'`
- `TenantRepo` AsyncLocalStorage Proxy throws on direct `pg.*` use inside route handlers (dev/test only)
- ESLint warns on `repo-*.ts` imports from `server.ts`

Out of scope (PR3/PR5): client `apiFetch` migration; NOT NULL flips / FKs / RLS.

## Test plan

- [ ] Two-tenant isolation tests: canonical / drafts / scan / ai-hint / activity / audit / preferences
- [ ] Scheduler runs every job once per tenant per tick (`scheduler-multi-tenant.test.ts`)
- [ ] WS presence does NOT bridge across tenants with the same `tableId`
- [ ] Admin routes: audit returns cross-tenant feed; impersonate flips effective tenant; teardown wipes rows + drops dynamic tables; cannot teardown `default`
- [ ] Preferences concurrent-write race no longer 23505s
- [ ] Manual smoke per Task 17

EOF
)"
```

---

## Self-review checklist (do this before marking the plan done)

- [ ] Every spec requirement under "TenantRepo", "Super-admin routes", "Tables that gain tenant_id", "Dynamic dim_/map_ tables", and the 2026-06-10 revision bullets ("WebSocket presence is namespaced by tenant", "TenantRepo Proxy-wraps the pg instance", "Three more tables to scope") maps to a task above.
- [ ] No placeholders: every step has either a code block or an exact command. Test bodies are concrete, not "write a test for X."
- [ ] Type consistency: `tenantId` is consistently a `string`; `Role` is `"admin" | "editor" | "viewer"` everywhere; `Operation` is `"curate" | "commit" | "manage_team" | "manage_adapter"` matching PR2a's `TenantRepo`.
- [ ] No task references a function I didn't introduce: `pgTxRaw`, `pgTxScoped`, `tenantBySlug`, `memberRole`, `provisionTenant`, `appendAuditAs` all come from PR2a; `assertNotInsideTenantRepo`, `teardownTenant`, `pgContext` are introduced in this plan (Tasks 10, 13c).
- [ ] Migration ordering: `0012_*.sql` adds UNIQUE on preferences BEFORE Task 3 rewrites `setPreferences` to ON CONFLICT (or the new code 23505s on the old schema until db:migrate runs).
- [ ] Test count grows monotonically: baseline 249 → ~268 after sweep tests → ~275 with admin routes.
