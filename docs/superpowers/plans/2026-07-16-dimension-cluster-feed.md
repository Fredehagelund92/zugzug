# Dimension Cluster Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a dimension's unmapped values as *complete, worst-impact-first clusters with coverage* over HTTP, so the focused mapper can map a whole family of spellings in one decision.

**Architecture:** Three thin layers on top of the clustering library shipped in Plan 1. (1) `getDimScanValuesAll` fetches a dimension's scan values by **looping the existing, tested `getDimScanValuesPage`** cursor until exhausted or a safety cap is hit — no new SQL. (2) `getDimClusters` runs those rows through `clusterScanRows` (Plan 1) and attaches coverage derived from the existing `getDimScanScalars`. (3) A `GET /api/dimensions/:id/clusters` route + `TenantRepo` wrapper serve it. Whole-set clustering is required because pagination would split a cluster's members across page boundaries; the cap's omitted long tail is the intentionally-optional tail (reported via `truncated`).

**Tech Stack:** TypeScript (strict), Bun test (`bun:test`), PostgreSQL (test DB via `docker compose`). Run from the `server/` workspace.

**Plan series:** Plan **2 of 7**. Depends on Plan 1 (`server/src/cluster-values.ts`, merged to `main`: `clusterScanRows`, `ScanValueCluster`). Downstream: Plan 3 (cluster-mapper UI) consumes `GET /clusters`.

## Global Constraints

- **Complete clusters only.** Cluster over the whole (capped) value set — never per-page. A returned cluster must contain all of its members that are within the cap.
- **No SQL duplication.** `getDimScanValuesAll` reuses `getDimScanValuesPage` (loop its cursor). Do not copy or rewrite its query.
- **Worst-impact ordering already holds** (`repo-dim-scan.ts:260` `ORDER BY v.total_rows DESC, v.raw_lower ASC`) — rely on it; do not add ordering. `clusterScanRows` also emits clusters rows-desc.
- **Coverage from the authoritative source.** Derive coverage from `getDimScanScalars` (whole-dimension `mappedRowsTotal` / `unmappedRowsTotal`), so it stays correct even when `truncated` drops the tail.
- **Safety cap default 5000**, overridable via `opts.cap`. When the cap truncates the set, `truncated` is `true`.
- **Explicit `.ts` import extensions.**
- **DB-backed tests live in `server/test/`** (pure tests are in `server/src/`). Use the house pattern: `import { resetDb } from "./setup.ts"` and call `await resetDb()` in `beforeEach` (drops + re-applies migrations), then seed the tenant — as in `server/test/add-dimension.test.ts`. `materializeDimScanValues(dimId, tenantId, { occurrences, scannedAt })` seeds scan values.
- **Gates:** `tsc --noEmit` and `eslint src` clean for changed files, from `server/`.

### Test DB prerequisite (once, before any task's tests)

From `server/`: `bun run test:db:up` (starts Postgres on `localhost:55432` via `docker compose -f docker-compose.test.yml up -d --wait`; requires Docker running). Tear down later with `bun run test:db:down`.

**Single-file test command** (from `server/`), used verbatim in every task's test steps:

```
DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test ATTACH_WAREHOUSE=false MOTHERDUCK_TOKEN=test-stub GOOGLE_CLIENT_ID=test-stub GOOGLE_CLIENT_SECRET=test-stub ZUGZUG_CURSOR_KEY=lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8= bun test test/dim-clusters.test.ts
```

## File Structure

- `server/src/repo-dim-scan.ts` — **modify.** Add `ClusterFeedOpts`, `getDimScanValuesAll`, `DimClusterFeed`, `getDimClusters`. Existing functions untouched.
- `server/test/dim-clusters.test.ts` — **new.** DB-backed tests for all three of the above, mirroring `repo-dim-scan.test.ts`'s harness.
- `server/src/tenant-repo.ts` — **modify.** Add a `getDimClusters` wrapper mirroring the existing `getDimScanValuesPage` wrapper (`tenant-repo.ts:498-500`).
- `server/src/server.ts` — **modify.** Add the `GET /api/dimensions/:id/clusters` route beside the `scan-values` route (`server.ts:992-1002`).

## Interfaces Produced

```ts
// repo-dim-scan.ts
export interface ClusterFeedOpts { filter: "new" | "mapped" | "all"; cap?: number }
export function getDimScanValuesAll(
  tenantId: string, dimId: string, opts: ClusterFeedOpts,
): Promise<{ rows: ScanValueRow[]; truncated: boolean }>;

export interface DimClusterFeed {
  clusters: ScanValueCluster[];                                   // from cluster-values.ts, worst-first
  coverage: { resolvedRows: number; atRiskRows: number; pct: number };
  truncated: boolean;
}
export function getDimClusters(
  tenantId: string, dimId: string, opts: ClusterFeedOpts,
): Promise<DimClusterFeed>;

// tenant-repo.ts (method on TenantRepo)
getDimClusters(dimId: string, opts: ClusterFeedOpts): Promise<DimClusterFeed>;

// HTTP: GET /api/dimensions/:id/clusters?filter=new|mapped|all → DimClusterFeed (200) | { error: "invalid_filter" } (400)
```

Reused verbatim from existing code: `getDimScanValuesPage(tenantId, dimId, { filter, limit, after })`, `getDimScanScalars(tenantId): Promise<DimScanScalars[]>` (fields `dimId`, `mappedRowsTotal`, `unmappedRowsTotal`), `ScanValueRow`, and from Plan 1 `clusterScanRows(rows): ScanValueCluster[]`.

---

### Task 1: `getDimScanValuesAll` — capped whole-set fetch by looping the pager

**Files:**
- Modify: `server/src/repo-dim-scan.ts`
- Test: `server/test/dim-clusters.test.ts` (create)

**Interfaces:**
- Consumes: existing `getDimScanValuesPage`, `ScanValueRow`.
- Produces: `ClusterFeedOpts`; `getDimScanValuesAll(tenantId, dimId, opts): Promise<{ rows: ScanValueRow[]; truncated: boolean }>`.

- [ ] **Step 1: Write the failing test**

Create `server/test/dim-clusters.test.ts` (harness copied from `server/test/repo-dim-scan.test.ts`):

```ts
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun } from "../src/pg.ts";
import { materializeDimScanValues, getDimScanValuesAll } from "../src/repo-dim-scan.ts";

const TENANT = "t_test_dim_clusters";
const DIM = "d_clusters";

async function seed(occurrences: { raw: string; rows: number }[]): Promise<void> {
  await pgRun(
    `CREATE TABLE IF NOT EXISTS zugzug_app.map_test_clusters
       (tenant_id varchar, raw varchar, cc varchar)`,
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS zugzug_app.dim_test_clusters
       (cc varchar PRIMARY KEY, label varchar)`,
  );
  await pgRun(
    `INSERT INTO zugzug_app.dimension
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Clusters', 'zugzug_app.dim_test_clusters',
             'zugzug_app.map_test_clusters', 'cc', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [DIM, TENANT],
  );
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: occurrences.map((o) => ({ raw: o.raw, table: "raw.a", column: "c", rows: o.rows })),
    scannedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetDb(); // drops app/canonical schemas and re-applies migrations
  await pgRun(
    `INSERT INTO zugzug_app.tenant (id, slug, label, created_at)
       VALUES ($1, $1, 'test dim clusters', now())
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
});

test("getDimScanValuesAll returns every value worst-impact first when under the cap", async () => {
  await seed(Array.from({ length: 30 }, (_, i) => ({ raw: `v${String(i).padStart(2, "0")}`, rows: 1000 - i })));
  const { rows, truncated } = await getDimScanValuesAll(TENANT, DIM, { filter: "new" });
  expect(rows).toHaveLength(30);
  expect(rows[0].raw).toBe("v00"); // highest rows first
  expect(rows[29].raw).toBe("v29");
  expect(truncated).toBe(false);
});

test("getDimScanValuesAll truncates at the cap and flags it", async () => {
  await seed(Array.from({ length: 30 }, (_, i) => ({ raw: `v${String(i).padStart(2, "0")}`, rows: 1000 - i })));
  const { rows, truncated } = await getDimScanValuesAll(TENANT, DIM, { filter: "new", cap: 10 });
  expect(rows).toHaveLength(10);
  expect(rows[0].raw).toBe("v00");
  expect(truncated).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Prerequisite (once): from `server/`, `bun run test:db:up`.
Run (from `server/`): the single-file test command above.
Expected: FAIL — `getDimScanValuesAll` is not exported from `repo-dim-scan.ts`.

- [ ] **Step 3: Write minimal implementation**

Append to `server/src/repo-dim-scan.ts` (below `getDimScanValuesPage`):

```ts
/** Options for the cluster feed. `cap` bounds how many values are pulled into
    memory for clustering (default 5000); the omitted long tail is reported via
    `truncated`. */
export interface ClusterFeedOpts {
  filter: "new" | "mapped" | "all";
  cap?: number;
}

/**
 * Fetch a dimension's scan values worst-impact-first by looping the existing
 * paginated `getDimScanValuesPage` until it is exhausted or `cap` is reached.
 * Reuses the tested query + cursor + occurrence logic — no new SQL. Returns the
 * (possibly capped) rows and whether more existed beyond the cap.
 */
export async function getDimScanValuesAll(
  tenantId: string,
  dimId: string,
  opts: ClusterFeedOpts,
): Promise<{ rows: ScanValueRow[]; truncated: boolean }> {
  const cap = opts.cap ?? 5000;
  const rows: ScanValueRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await getDimScanValuesPage(tenantId, dimId, {
      filter: opts.filter,
      limit: 500,
      after,
    });
    rows.push(...page.items);
    if (rows.length >= cap) {
      return { rows: rows.slice(0, cap), truncated: page.hasMore || rows.length > cap };
    }
    if (!page.hasMore || !page.nextCursor) {
      return { rows, truncated: false };
    }
    after = page.nextCursor;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): the single-file test command.
Expected: PASS — both `getDimScanValuesAll` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-dim-scan.ts server/test/dim-clusters.test.ts
git commit -m "feat(clusters): add capped whole-set getDimScanValuesAll"
```

---

### Task 2: `getDimClusters` — cluster feed with coverage

**Files:**
- Modify: `server/src/repo-dim-scan.ts`
- Test: `server/test/dim-clusters.test.ts`

**Interfaces:**
- Consumes: `getDimScanValuesAll` (Task 1), `getDimScanScalars` (existing), `clusterScanRows` + `ScanValueCluster` (Plan 1, `./cluster-values.ts`).
- Produces: `DimClusterFeed`; `getDimClusters(tenantId, dimId, opts): Promise<DimClusterFeed>`.

- [ ] **Step 1: Write the failing test**

Add to the imports at the top of `server/test/dim-clusters.test.ts` so the repo import reads:
`import { materializeDimScanValues, getDimScanValuesAll, getDimClusters } from "../src/repo-dim-scan.ts";`

Append this test (it seeds two look-alike unmapped values plus one mapped value, then asserts the cluster and the coverage math):

```ts
test("getDimClusters groups look-alikes and reports coverage from whole-dim scalars", async () => {
  await seed([
    { raw: "USA", rows: 1000 },
    { raw: "U.S.A.", rows: 500 },
    { raw: "GB", rows: 300 },
  ]);
  // Map "GB" so it counts as resolved (coverage denominator includes it).
  await pgRun(
    `INSERT INTO zugzug_app.map_test_clusters (tenant_id, raw, cc) VALUES ($1, 'GB', 'uk')`,
    [TENANT],
  );

  const feed = await getDimClusters(TENANT, DIM, { filter: "new" });

  // filter=new returns only unmapped values → USA + U.S.A. fold into one cluster.
  expect(feed.clusters).toHaveLength(1);
  expect(feed.clusters[0].key).toBe("usa");
  expect(feed.clusters[0].members.map((m) => m.raw)).toEqual(["USA", "U.S.A."]);
  expect(feed.clusters[0].rows).toBe(1500);

  // Coverage is whole-dimension: resolved = GB's 300; at risk = 1500; pct = 17.
  expect(feed.coverage.resolvedRows).toBe(300);
  expect(feed.coverage.atRiskRows).toBe(1500);
  expect(feed.coverage.pct).toBe(17); // round(300 / 1800 * 100)
  expect(feed.truncated).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): the single-file test command.
Expected: FAIL — `getDimClusters` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add this import near the top of `server/src/repo-dim-scan.ts` (with the other imports; keep the existing `import type { ... }` style — this needs a runtime import because `clusterScanRows` is a value):

```ts
import { clusterScanRows, type ScanValueCluster } from "./cluster-values.ts";
```

Append to `server/src/repo-dim-scan.ts` (below `getDimScanValuesAll`):

```ts
/** The focused mapper's payload: complete clusters worst-first, plus coverage. */
export interface DimClusterFeed {
  clusters: ScanValueCluster[];
  coverage: { resolvedRows: number; atRiskRows: number; pct: number };
  truncated: boolean;
}

/**
 * Fetch a dimension's values (capped, worst-first), cluster the whole set so
 * every family is complete, and attach coverage. Coverage comes from the
 * authoritative whole-dimension scalars (not the possibly-truncated rows), so it
 * stays correct regardless of the cap.
 */
export async function getDimClusters(
  tenantId: string,
  dimId: string,
  opts: ClusterFeedOpts,
): Promise<DimClusterFeed> {
  const { rows, truncated } = await getDimScanValuesAll(tenantId, dimId, opts);
  const clusters = clusterScanRows(rows);
  const scalars = (await getDimScanScalars(tenantId)).find((s) => s.dimId === dimId);
  const resolvedRows = scalars?.mappedRowsTotal ?? 0;
  const atRiskRows = scalars?.unmappedRowsTotal ?? 0;
  const denom = resolvedRows + atRiskRows;
  const pct = denom > 0 ? Math.round((resolvedRows / denom) * 100) : 100;
  return { clusters, coverage: { resolvedRows, atRiskRows, pct }, truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): the single-file test command.
Expected: PASS — all tests (Task 1 + this) pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-dim-scan.ts server/test/dim-clusters.test.ts
git commit -m "feat(clusters): add getDimClusters feed with coverage"
```

---

### Task 3: HTTP route + TenantRepo wrapper

**Files:**
- Modify: `server/src/tenant-repo.ts`
- Modify: `server/src/server.ts`
- Test: `server/test/dim-clusters.test.ts`

**Interfaces:**
- Consumes: `getDimClusters`, `ClusterFeedOpts`, `DimClusterFeed` (Task 2).
- Produces: `TenantRepo.getDimClusters(dimId, opts)`; `GET /api/dimensions/:id/clusters`.

- [ ] **Step 1: Write the failing test**

Add `provisionTenant`-free — this test exercises the `TenantRepo` wrapper (the route body is one line over it; the wrapper is where the logic lives). Extend the imports in `server/test/dim-clusters.test.ts`:
`import { TenantRepo } from "../src/tenant-repo.ts";`

Append:

```ts
test("TenantRepo.getDimClusters scopes to its tenant and returns the feed", async () => {
  await seed([
    { raw: "USA", rows: 1000 },
    { raw: "U.S.A.", rows: 500 },
  ]);
  const repo = new TenantRepo(TENANT);
  const feed = await repo.getDimClusters(DIM, { filter: "new" });
  expect(feed.clusters).toHaveLength(1);
  expect(feed.clusters[0].key).toBe("usa");
  expect(feed.coverage.pct).toBe(0); // nothing mapped → 0% of 1500 rows resolved
});
```

If `TenantRepo`'s constructor signature differs from `new TenantRepo(tenantId)`, match the real one (see the existing `getDimScanValuesPage` wrapper site, `tenant-repo.ts:498-500`, and how tests construct it) — read it before writing.

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): the single-file test command.
Expected: FAIL — `getDimClusters` is not a method on `TenantRepo`.

- [ ] **Step 3: Add the TenantRepo wrapper**

In `server/src/tenant-repo.ts`, directly after the existing `getDimScanValuesPage` wrapper (around line 498-500), add — matching the surrounding style (the file aliases the repo module; use the same alias, e.g. `repoDimScan`, that the neighbouring method uses):

```ts
getDimClusters(
  dimId: string,
  opts: repoDimScan.ClusterFeedOpts,
): Promise<repoDimScan.DimClusterFeed> {
  return this.withClearCtx(() => repoDimScan.getDimClusters(this.tenantId, dimId, opts));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): the single-file test command.
Expected: PASS — the wrapper test passes.

- [ ] **Step 5: Add the HTTP route**

In `server/src/server.ts`, immediately after the `scan-values` route block (ends ~line 1002), add:

```ts
// GET /api/dimensions/:id/clusters?filter=new|mapped|all
if (seg[3] === "clusters" && seg.length === 4 && id && method === "GET") {
  const filter = url.searchParams.get("filter") ?? "new";
  if (filter !== "new" && filter !== "mapped" && filter !== "all") {
    return json({ error: "invalid_filter" }, 400);
  }
  return json(await reqRepo.getDimClusters(id, { filter }));
}
```

- [ ] **Step 6: Run the gates**

Run (from `server/`): `tsc --noEmit`
Expected: no NEW errors referencing `repo-dim-scan.ts`, `tenant-repo.ts`, or `server.ts` from this change. (Pre-existing errors in unrelated files may exist — ignore those; do not fix them.)

Run (from `server/`): `eslint src/repo-dim-scan.ts src/tenant-repo.ts src/server.ts test/dim-clusters.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/tenant-repo.ts server/src/server.ts server/test/dim-clusters.test.ts
git commit -m "feat(clusters): expose GET /dimensions/:id/clusters"
```

> **Known coverage boundary (not a defect):** the HTTP routing layer itself has no automated test — matching the existing `scan-values` route, which also has none. The endpoint's behaviour is fully covered at the `getDimClusters` (Task 2) and `TenantRepo` (Task 3) layers; the route body is a 4-line filter-validate-and-delegate wrapper verified by `tsc`. An HTTP-level route test is a follow-up for a later plan that establishes a server HTTP test harness.

---

## Self-Review

**Spec coverage:**
- Complete clusters (no per-page split) → Task 1 fetches the whole capped set; Task 2 clusters it.
- No SQL duplication → Task 1 loops `getDimScanValuesPage`.
- Worst-impact ordering relied upon, not rebuilt → Task 1 test asserts `v00` (highest rows) first; no ORDER BY added.
- Coverage from authoritative scalars → Task 2 uses `getDimScanScalars`, asserted with the 300/1500/17% case.
- Cap + truncation reporting → Task 1 `cap: 10` test asserts `truncated: true`.
- HTTP surface → Task 3 route + wrapper; `invalid_filter` guard mirrors `scan-values`.

**Placeholder scan:** No TBD/TODO. Every step has literal code and the exact single-file test command. Two explicit "match the real signature in-file" instructions (TenantRepo constructor, repo module alias) are for *existing* code the implementer edits, not undefined cross-task references.

**Type consistency:** `ClusterFeedOpts` (Task 1) is the opts type used by `getDimClusters` (Task 2) and the wrapper (Task 3). `DimClusterFeed` (Task 2) is the wrapper's return type (Task 3). `getDimScanScalars` fields used (`dimId`, `mappedRowsTotal`, `unmappedRowsTotal`) match its real interface (`repo-dim-scan.ts:101-111`).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-dimension-cluster-feed.md`.

**Execution prerequisite:** the test Postgres must be running — from `server/`: `bun run test:db:up` (needs Docker). It is currently **not running**; tasks will be BLOCKED without it.

Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
