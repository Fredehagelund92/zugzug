# Phase 3 — Canonical-Store Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Branch `commit()` to call `adapter.commitCanonical` when configured for a writable warehouse (Postgres stays source of truth; warehouse-sync failures get audit events + dashboard surface). Add a standalone Parquet-export utility for read-only-warehouse deployments, exposed via a session-cookie-authed endpoint. Surface workspace mode + sync status in the Dashboard and Triage UIs.

**Architecture:** Server adds (a) a `warehouse/parquet-exporter.ts` utility using a lazy-init in-process DuckDB + the appender API to write Postgres map rows to Parquet; (b) two new routes (`/api/dimensions/:id/snapshot.parquet`, `/api/workspace/info`); (c) a writable-vs-read-only branch inside `commit()` that runs `adapter.commitCanonical` *after* the Postgres pgTx commits and emits audit events. Frontend adds a Dashboard "Canonical destination" KPI, a "needs resync" badge derived from `Warehouse sync failed` audit events, a mode-aware Triage commit-affordance copy, and "Download snapshot" links in Triage + Tables.

**Tech Stack:** Bun + TypeScript, `@duckdb/node-api` (DuckDBAppender API), `snowflake-sdk` (via the existing SnowflakeAdapter, mocked in tests), `postgres.js`, `bun:test`, React + Vite + vitest + @testing-library/react.

**Spec reference:** `docs/superpowers/specs/2026-06-08-phase3-canonical-store-modes-design.md`.

**One spec deviation locked during planning:** the spec said `exportCanonicalToParquet` would emit both `dim_*` and `map_*` rows tagged by source. Their column shapes diverge (dim has enrichment fields, map has raw+key only), making the union schema lossy. **v1 plan exports map rows only** (the dbt-useful one for LEFT-JOIN cleanup of warehouse columns). Dim export becomes v1.1 if requested. Endpoint stays `/api/dimensions/:id/snapshot.parquet` (singular, as in spec); response is the map table.

**Verification gate (must all pass at end of phase):**

1. `cd server && bun run typecheck` — clean.
2. `cd server && bun run lint` — clean.
3. `cd server && bun run format:check` — clean.
4. `cd server && bun test` — all existing tests pass + new server-side tests pass.
5. `cd app && bun run typecheck` — clean.
6. `cd app && bun run test` — all existing tests pass + new frontend tests pass.
7. `cd server && timeout 5 bun run start 2>&1 | head -10 || true` — boots, prints `· connected (duckdb, read-only)`.
8. `grep -n "warehouseSynced" server/src/repo-drafts.ts` — confirms the new return field is wired.
9. Manual smoke: with default DuckDB adapter (read-only), open Dashboard → see `📦 Local + export` badge. Open Triage → click "Approve & save" → drafts commit; no "needs resync" badge appears. Click "Download snapshot →" in Triage → Parquet file downloads, opens in DuckDB CLI / Tad as a 2-column (raw, key) table.

---

## File structure (post-phase)

```
server/src/warehouse/
  parquet-exporter.ts          # NEW — lazy DuckDB + map-to-parquet via Appender
server/src/
  repo-drafts.ts               # MODIFIED — commit() branches on isWritable(adapter)
  server.ts                    # MODIFIED — adds /api/dimensions/:id/snapshot.parquet + /api/workspace/info
server/test/
  parquet-exporter.test.ts     # NEW
  workspace-info.test.ts       # NEW (or merge into an existing endpoint-level test if one fits)
  commit-warehouse-branch.test.ts  # NEW — exercises commit() in writable mode with mocked adapter
app/src/
  store.ts                     # MODIFIED — adds useWorkspaceInfo + warehouse sync status derivation
  routes/Dashboard.tsx         # MODIFIED — adds canonical-destination KPI + needs-resync per-dim badge
  routes/Triage.tsx            # MODIFIED — commit-affordance copy adapts to mode
  routes/MasterTables.tsx      # MODIFIED — adds "Download snapshot" link in dim header
app/test/
  workspace-info.test.ts       # NEW — tests for useWorkspaceInfo
  dashboard-canonical-badge.test.tsx  # NEW
  triage-commit-copy.test.tsx        # NEW
```

---

## Task 1: Scaffold `parquet-exporter.ts` (lazy DuckDB instance + tests)

**Files:**
- Create: `server/src/warehouse/parquet-exporter.ts`
- Create: `server/test/parquet-exporter.test.ts`

This task lays the foundation: a module-scope lazy DuckDB instance + a `withExporterConn` helper. The actual `exportCanonicalToParquet` implementation lands in Task 2.

- [ ] **Step 1: Write the failing test**

Create `server/test/parquet-exporter.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { withExporterConn } from "../src/warehouse/parquet-exporter.ts";

test("withExporterConn provides a working DuckDB connection", async () => {
  const result = await withExporterConn(async (conn) => {
    const r = await conn.runAndReadAll("SELECT 42 AS answer");
    return r.getRowObjects();
  });
  expect(result).toEqual([{ answer: 42 }]);
});

test("withExporterConn reuses the same in-process instance across calls", async () => {
  // Create a temp table in one call, read it in the next.
  await withExporterConn(async (conn) => {
    await conn.run(`CREATE OR REPLACE TABLE _shared_test (n INTEGER)`);
    await conn.run(`INSERT INTO _shared_test VALUES (1), (2), (3)`);
  });
  const rows = await withExporterConn(async (conn) => {
    const r = await conn.runAndReadAll(`SELECT count(*) AS n FROM _shared_test`);
    return r.getRowObjects();
  });
  expect(rows).toEqual([{ n: 3n }]); // DuckDB count returns bigint
  await withExporterConn(async (conn) => {
    await conn.run(`DROP TABLE _shared_test`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && bun test test/parquet-exporter.test.ts
```
Expected: FAIL — module `../src/warehouse/parquet-exporter.ts` does not exist.

- [ ] **Step 3: Implement the scaffold**

Create `server/src/warehouse/parquet-exporter.ts`:

```ts
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// Lazy-init in-process DuckDB instance used purely as a Parquet writer.
// Reused across calls so we don't pay the instance-startup cost per export.
// Completely independent of the workspace's configured WarehouseAdapter —
// DuckDB here is a serialization utility, not a warehouse.
let _instance: Promise<DuckDBInstance> | null = null;

async function getInstance(): Promise<DuckDBInstance> {
  if (!_instance) _instance = DuckDBInstance.create(":memory:");
  return _instance;
}

/** Acquire a DuckDB connection scoped to a single export operation.
 *  Connections are cheap; the underlying instance is shared. */
export async function withExporterConn<T>(
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const inst = await getInstance();
  const conn = await inst.connect();
  return fn(conn);
}

/** Test helper — drops the cached instance so the next call re-inits.
 *  Tests should NOT call this in beforeEach (instance reuse IS the point);
 *  reserved for explicit test isolation needs. */
export function _resetExporterInstance(): void {
  _instance = null;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && bun test test/parquet-exporter.test.ts
```
Expected: both tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/warehouse/parquet-exporter.ts server/test/parquet-exporter.test.ts
git commit -m "feat(parquet): lazy in-process DuckDB exporter foundation"
```

---

## Task 2: Implement `exportCanonicalToParquet` via DuckDB Appender API

**Files:**
- Modify: `server/src/warehouse/parquet-exporter.ts`
- Modify: `server/test/parquet-exporter.test.ts`

Exports a dimension's MAP table as Parquet. The DIM table is not exported in v1 (deviation noted in the plan header).

The data flow:
1. Read all rows from Postgres `map_<dim>` (columns: `raw`, `<keyCol>`).
2. Create a temp DuckDB table with matching columns.
3. Bulk-load via DuckDB's `createAppender` API.
4. `COPY` the temp table to a temporary `.parquet` file.
5. Read the file into a Buffer.
6. Clean up the temp table + file.

- [ ] **Step 1: Add failing tests**

Append to `server/test/parquet-exporter.test.ts`:

```ts
import { exportCanonicalToParquet } from "../src/warehouse/parquet-exporter.ts";
import { resetDb } from "./setup.ts";
import { beforeEach } from "bun:test";

beforeEach(async () => {
  await resetDb();
});

test("exportCanonicalToParquet: empty map table emits valid empty Parquet", async () => {
  // resetDb runs migrations but doesn't seed any dim/map tables.
  // Create one by hand.
  const { Client } = await import("../src/pg.ts").then((m) => ({ Client: m }));
  await Client.pgRun(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await Client.pgRun(
    `CREATE TABLE zugzug.map_empty_test (raw VARCHAR PRIMARY KEY, country_code VARCHAR NOT NULL)`,
  );

  const buf = await exportCanonicalToParquet({
    dimId: "empty_test",
    dimTable: "zugzug.dim_empty_test",
    mapTable: "zugzug.map_empty_test",
    keyCol: "country_code",
  });

  // Parquet magic header is "PAR1" at the start AND end of the file.
  expect(buf.length).toBeGreaterThan(8);
  expect(buf.subarray(0, 4).toString()).toBe("PAR1");
  expect(buf.subarray(buf.length - 4).toString()).toBe("PAR1");

  // Round-trip via DuckDB to confirm schema.
  const rows = await withExporterConn(async (conn) => {
    await conn.run(`CREATE OR REPLACE TABLE _verify AS SELECT * FROM read_parquet('/tmp/zugzug-verify.parquet')`);
    return [];
  }).catch(() => null);
  // (Skip the cleanup-style verify here — second test does the round-trip.)
});

test("exportCanonicalToParquet: populated map table round-trips through DuckDB", async () => {
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await pgRun(
    `CREATE TABLE zugzug.map_country (raw VARCHAR PRIMARY KEY, country_code VARCHAR NOT NULL)`,
  );
  await pgRun(`INSERT INTO zugzug.map_country (raw, country_code) VALUES
                ($1, $2), ($3, $4), ($5, $6)`,
    ["USA", "US", "U.S.", "US", "United Kingdom", "GB"]);

  const buf = await exportCanonicalToParquet({
    dimId: "country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_code",
  });

  // Write the buffer to a tmp file and read it back via DuckDB.
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const tmpPath = "/tmp/zugzug-parquet-test.parquet";
  writeFileSync(tmpPath, buf);

  try {
    const rows = await withExporterConn(async (conn) => {
      const r = await conn.runAndReadAll(`SELECT * FROM read_parquet('${tmpPath}') ORDER BY raw`);
      return r.getRowObjects();
    });
    expect(rows).toEqual([
      { raw: "U.S.", country_code: "US" },
      { raw: "USA", country_code: "US" },
      { raw: "United Kingdom", country_code: "GB" },
    ]);
  } finally {
    unlinkSync(tmpPath);
  }
});

test("exportCanonicalToParquet: respects keyCol naming (column name reflects dim key)", async () => {
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await pgRun(
    `CREATE TABLE zugzug.map_partner (raw VARCHAR PRIMARY KEY, partner_id VARCHAR NOT NULL)`,
  );
  await pgRun(`INSERT INTO zugzug.map_partner (raw, partner_id) VALUES ($1, $2)`, ["acme", "P-001"]);

  const buf = await exportCanonicalToParquet({
    dimId: "partner",
    dimTable: "zugzug.dim_partner",
    mapTable: "zugzug.map_partner",
    keyCol: "partner_id",
  });
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const tmpPath = "/tmp/zugzug-parquet-keycol-test.parquet";
  writeFileSync(tmpPath, buf);
  try {
    const rows = await withExporterConn(async (conn) => {
      const r = await conn.runAndReadAll(`SELECT * FROM read_parquet('${tmpPath}')`);
      return r.getRowObjects();
    });
    expect(rows).toEqual([{ raw: "acme", partner_id: "P-001" }]);
  } finally {
    unlinkSync(tmpPath);
  }
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd server && bun test test/parquet-exporter.test.ts
```
Expected: 3 new tests FAIL — `exportCanonicalToParquet` not exported.

- [ ] **Step 3: Implement `exportCanonicalToParquet`**

In `server/src/warehouse/parquet-exporter.ts`, add the imports + helpers + main function:

```ts
import { readFileSync, unlinkSync } from "node:fs";
import { pgAll } from "../pg.ts";
import { cq } from "../repo-shared.ts";
import type { DimensionSpec } from "./adapter.ts";

// Already at top:
//   import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/** Export the dimension's MAP table as Parquet bytes.
 *
 *  v1 scope: map rows only (raw + keyCol). The DIM table (canonical records +
 *  enrichment fields) is not included; it has a divergent column shape that
 *  doesn't union cleanly with map rows. dbt's primary use case is a LEFT JOIN
 *  on the map for warehouse cleanup, which this serves directly.
 */
export async function exportCanonicalToParquet(dim: DimensionSpec): Promise<Buffer> {
  // 1. Read all map rows from Postgres.
  const rows = await pgAll<{ raw: string; key: string }>(
    `SELECT raw, "${dim.keyCol}" AS key FROM ${cq(dim.mapTable)} ORDER BY raw`,
  );

  // 2. Use the lazy in-process DuckDB; create a temp table; bulk-load via Appender.
  // 3. COPY to a tmp Parquet file; read into Buffer; clean up.
  const tableName = `_export_${dim.dimId}_${Date.now()}`;
  const tmpPath = `/tmp/zugzug-snapshot-${dim.dimId}-${Date.now()}.parquet`;

  return withExporterConn(async (conn) => {
    try {
      await conn.run(
        `CREATE OR REPLACE TABLE ${tableName} (raw VARCHAR, "${dim.keyCol}" VARCHAR)`,
      );
      const appender = await conn.createAppender(tableName);
      for (const r of rows) {
        appender.appendVarchar(r.raw);
        appender.appendVarchar(r.key);
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();

      await conn.run(`COPY ${tableName} TO '${tmpPath}' (FORMAT PARQUET)`);
      const buf = readFileSync(tmpPath);
      return buf;
    } finally {
      // Best-effort cleanup; failures here shouldn't mask an export error.
      try {
        unlinkSync(tmpPath);
      } catch {
        /* file may not exist if COPY failed */
      }
      try {
        await conn.run(`DROP TABLE IF EXISTS ${tableName}`);
      } catch {
        /* connection may be in a bad state if the export threw */
      }
    }
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && bun test test/parquet-exporter.test.ts
```
Expected: all tests pass.

If a test fails with `appender_*` errors, the DuckDB Appender API for Bun/Node may have a slightly different shape than expected. Check `/Users/fhagelund/Documents/GitHub/zugzug/server/node_modules/@duckdb/node-api/lib/DuckDBAppender.d.ts` for the canonical method names (e.g., `appendVarchar`, `endRow`, `flushSync`, `closeSync`) and adjust.

- [ ] **Step 5: Typecheck + lint**

```bash
cd server && bun run typecheck && bun run lint
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/warehouse/parquet-exporter.ts server/test/parquet-exporter.test.ts
git commit -m "feat(parquet): exportCanonicalToParquet via DuckDB Appender API"
```

---

## Task 3: Add `GET /api/dimensions/:id/snapshot.parquet` endpoint

**Files:**
- Modify: `server/src/server.ts`
- Create: `server/test/snapshot-endpoint.test.ts`

Adds a session-cookie-authed route that streams the dimension's map table as Parquet. Filename hint: `<dim_id>-map.parquet`.

- [ ] **Step 1: Write the failing test**

Create `server/test/snapshot-endpoint.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.DEV_BYPASS_AUTH = "true"; // lets us simulate a logged-in session

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  await resetDb();
});

async function loginCookie(): Promise<string> {
  // Dev login returns Set-Cookie with the session id; reuse for subsequent requests.
  const res = await fetch("http://localhost:8787/api/auth/dev");
  const setCookie = res.headers.get("set-cookie") ?? "";
  // Extract just the cookie value (everything before the first ;)
  return setCookie.split(";")[0] ?? "";
}

test("GET /api/dimensions/:id/snapshot.parquet returns 401 without auth", async () => {
  const res = await fetch("http://localhost:8787/api/dimensions/country/snapshot.parquet");
  expect(res.status).toBe(401);
});

test("GET /api/dimensions/:id/snapshot.parquet returns 404 for unknown dim", async () => {
  const cookie = await loginCookie();
  const res = await fetch(
    "http://localhost:8787/api/dimensions/no_such_dim/snapshot.parquet",
    { headers: { cookie } },
  );
  expect(res.status).toBe(404);
});

test("GET /api/dimensions/:id/snapshot.parquet returns Parquet bytes for valid dim", async () => {
  const cookie = await loginCookie();
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");
  await repo.commit(dimId, "u_test");

  const res = await fetch(
    `http://localhost:8787/api/dimensions/${dimId}/snapshot.parquet`,
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/octet-stream");
  expect(res.headers.get("content-disposition")).toContain(`${dimId}-map.parquet`);

  const buf = Buffer.from(await res.arrayBuffer());
  expect(buf.subarray(0, 4).toString()).toBe("PAR1");
  expect(buf.subarray(buf.length - 4).toString()).toBe("PAR1");
});
```

**Note:** these are end-to-end HTTP tests requiring the server to be running. If the test framework can't easily spin up the server in-test (Bun's HTTP server is process-global), convert to a unit test that calls the route handler directly. The pattern below uses a running server because existing tests already follow that pattern (verify-eid.ts, etc.).

If running fetch against a live server is impractical, simplify: extract the route handler into a function and call it directly. The endpoint validation logic is what matters; HTTP framing is incidental.

- [ ] **Step 2: Run, verify failure**

```bash
cd server && bun test test/snapshot-endpoint.test.ts
```
Expected: tests FAIL — endpoint doesn't exist; fetch returns 404 for the route itself.

- [ ] **Step 3: Add the route in server.ts**

Open `server/src/server.ts`. Find the routing block (around line 184 where `/api/sources` is handled). Add a new dimensions-routing block. After the existing dimensions-related routes (search for where `/api/dimensions/:id` is currently handled), add:

```ts
// GET /api/dimensions/:id/snapshot.parquet — Parquet export of the dim's map table
if (
  seg[1] === "dimensions" &&
  seg.length === 4 &&
  seg[3] === "snapshot.parquet" &&
  method === "GET"
) {
  const dimId = seg[2];
  const dim = await repo.getDimension(dimId);
  if (!dim) return json({ error: "not found" }, 404);
  const { exportCanonicalToParquet } = await import("./warehouse/parquet-exporter.ts");
  const buf = await exportCanonicalToParquet({
    dimId: dim.id,
    dimTable: dim.dimTable,
    mapTable: dim.mapTable,
    keyCol: dim.keyCol,
  });
  return new Response(buf, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${dimId}-map.parquet"`,
      "cache-control": "no-store",
    },
  });
}
```

(Replace `CORS_HEADERS` with whatever the existing routes use for their response headers — search server.ts for an existing `headers:` block in another route to copy the shape.)

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && bun test test/snapshot-endpoint.test.ts
```
Expected: tests pass.

If the tests fail because no server is running, follow the unit-style fallback noted in Step 1.

- [ ] **Step 5: Typecheck + lint**

```bash
cd server && bun run typecheck && bun run lint
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/test/snapshot-endpoint.test.ts
git commit -m "feat(api): GET /api/dimensions/:id/snapshot.parquet endpoint"
```

---

## Task 4: Add `GET /api/workspace/info` endpoint

**Files:**
- Modify: `server/src/server.ts`
- Create: `server/test/workspace-info.test.ts`

Returns workspace adapter capability metadata. Powers the frontend dashboard badge.

- [ ] **Step 1: Write the failing test**

Create `server/test/workspace-info.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.DEV_BYPASS_AUTH = "true";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";

beforeEach(async () => {
  await resetDb();
});

async function loginCookie(): Promise<string> {
  const res = await fetch("http://localhost:8787/api/auth/dev");
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

test("GET /api/workspace/info returns 401 without auth", async () => {
  const res = await fetch("http://localhost:8787/api/workspace/info");
  expect(res.status).toBe(401);
});

test("GET /api/workspace/info returns adapter capability shape", async () => {
  const cookie = await loginCookie();
  const res = await fetch("http://localhost:8787/api/workspace/info", {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    adapter: string;
    writable: boolean;
    canonicalMode: "warehouse" | "postgres-export";
    warehouseDb: string | null;
  };
  expect(body.adapter).toBe("duckdb"); // default in tests (ATTACH_WAREHOUSE=false)
  expect(body.writable).toBe(false);
  expect(body.canonicalMode).toBe("postgres-export");
  // warehouseDb may be null or "analytics" depending on env defaults — both valid.
  expect(["analytics", null]).toContain(body.warehouseDb);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd server && bun test test/workspace-info.test.ts
```
Expected: tests FAIL — endpoint missing.

- [ ] **Step 3: Add the route**

In `server/src/server.ts`, add (near the other endpoint blocks; placement order is flexible since all routes are flat checks):

```ts
// GET /api/workspace/info — adapter capability metadata for the frontend badge
if (seg[1] === "workspace" && seg[2] === "info" && seg.length === 3 && method === "GET") {
  const { getAdapter } = await import("./warehouse/registry.ts");
  const adapter = await getAdapter();
  return json({
    adapter: adapter.capabilities.id,
    writable: adapter.capabilities.writable,
    canonicalMode: adapter.capabilities.writable ? "warehouse" : "postgres-export",
    warehouseDb: env.warehouseDb || null,
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && bun test test/workspace-info.test.ts
```
Expected: tests pass.

- [ ] **Step 5: Typecheck + lint**

```bash
cd server && bun run typecheck && bun run lint
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/test/workspace-info.test.ts
git commit -m "feat(api): GET /api/workspace/info endpoint"
```

---

## Task 5: Branch `commit()` in `repo-drafts.ts` for writable mode

**Files:**
- Modify: `server/src/repo-drafts.ts`
- Create: `server/test/commit-warehouse-branch.test.ts`

The heart of Phase 3. After the Postgres pgTx commits successfully, call `adapter.commitCanonical` if the configured adapter is writable. On failure, emit a `"Warehouse sync failed"` audit event — do NOT throw, do NOT roll back the Postgres commit.

Extends `commit()`'s return type with `warehouseSynced: "n/a" | "synced" | "failed"`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/commit-warehouse-branch.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import {
  registerFactories,
  type AdapterFactoryRegistry,
} from "../src/warehouse/credentials.ts";
import { _resetAdapterCache } from "../src/warehouse/registry.ts";
import { DuckDbAdapter } from "../src/warehouse/duckdb/index.ts";
import type {
  WritableWarehouseAdapter,
  AdapterCapabilities,
  ApprovedDraft,
  DimensionSpec,
  CommitResult,
} from "../src/warehouse/adapter.ts";

beforeEach(async () => {
  await resetDb();
  _resetAdapterCache();
});

// A minimal in-test WritableWarehouseAdapter that captures commit calls.
function makeWritableMock(opts: { failCommit?: boolean } = {}) {
  const ensured: DimensionSpec[] = [];
  const committed: { dim: DimensionSpec; drafts: ApprovedDraft[] }[] = [];
  const adapter: Partial<WritableWarehouseAdapter> = {
    capabilities: {
      id: "snowflake",
      writable: true,
      supportsMerge: true,
      identifierCase: "upper",
      supportsApproximateDistinct: true,
    } as AdapterCapabilities & { readonly writable: true },
    async ping() {
      return true;
    },
    async ensureCanonicalTables(d: DimensionSpec) {
      ensured.push(d);
    },
    async commitCanonical(d: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult> {
      if (opts.failCommit) throw new Error("simulated warehouse failure");
      committed.push({ dim: d, drafts });
      return { rowsWritten: drafts.length };
    },
  };
  return { adapter: adapter as WritableWarehouseAdapter, ensured, committed };
}

test("commit in postgres-export mode (DuckDB read-only): warehouseSynced=n/a; no adapter writes", async () => {
  // Default factory — DuckDbAdapter is read-only.
  // (test/setup.ts already registered factories before this file imported.)
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");
  const result = await repo.commit(dimId, "u_test");
  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("n/a");
});

test("commit in writable mode (success): warehouseSynced=synced; audit event emitted", async () => {
  // Swap factories to return our writable mock.
  const { adapter, ensured, committed } = makeWritableMock();
  registerFactories({
    duckdb: async () => adapter,
    snowflake: async () => adapter,
  });
  _resetAdapterCache();

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");
  const result = await repo.commit(dimId, "u_test");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("synced");
  expect(ensured).toHaveLength(1);
  expect(committed).toHaveLength(1);
  expect(committed[0].drafts).toContainEqual({
    raw: "USA",
    key: "us",
    label: "United States",
  });

  const audits = await repo.listAudit(10);
  expect(audits.some((a) => a.action === "Warehouse synced")).toBe(true);
});

test("commit in writable mode (warehouse fails): Postgres committed; warehouseSynced=failed; failure audit event", async () => {
  const { adapter } = makeWritableMock({ failCommit: true });
  registerFactories({
    duckdb: async () => adapter,
    snowflake: async () => adapter,
  });
  _resetAdapterCache();

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");
  const result = await repo.commit(dimId, "u_test");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("failed");

  // Postgres canonical SHOULD reflect the commit (drafts cleared, dim/map rows present).
  const drafts = await repo.listDrafts(dimId);
  expect(drafts).toHaveLength(0);

  const dim = await repo.getDimension(dimId);
  expect(dim?.canonical.some((c) => c.key === "us")).toBe(true);

  const audits = await repo.listAudit(10);
  const failAudit = audits.find((a) => a.action === "Warehouse sync failed");
  expect(failAudit).toBeDefined();
  expect(failAudit?.detail).toContain("simulated warehouse failure");
});

test("commit with no approved drafts: returns early; no warehouse call attempted", async () => {
  const { adapter, ensured, committed } = makeWritableMock();
  registerFactories({
    duckdb: async () => adapter,
    snowflake: async () => adapter,
  });
  _resetAdapterCache();

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  // No drafts saved.
  const result = await repo.commit(dimId, "u_test");
  expect(result.committed).toBe(0);
  expect(result.warehouseSynced).toBe("n/a"); // nothing to sync
  expect(ensured).toHaveLength(0);
  expect(committed).toHaveLength(0);
});

// Cleanup: restore real factories at end of file so subsequent test files see DuckDB
afterAll(async () => {
  registerFactories({
    duckdb: async (creds) => new DuckDbAdapter(creds),
    snowflake: async () => {
      throw new Error("Snowflake adapter ships in Phase 2");
    },
  });
  _resetAdapterCache();
});
```

Add this import line at the top of the test file (alongside others):

```ts
import { afterAll } from "bun:test";
```

- [ ] **Step 2: Run, verify failures**

```bash
cd server && bun test test/commit-warehouse-branch.test.ts
```
Expected: all 4 tests FAIL — `warehouseSynced` field not on result; adapter methods not called.

- [ ] **Step 3: Update `commit()` and its return type**

In `server/src/repo-drafts.ts`, modify the `commit` function. The existing signature:

```ts
export async function commit(
  dimId: string,
  userId: string,
): Promise<{ committed: number; rowsRecovered: number }> {
  // ...
}
```

Change to:

```ts
export async function commit(
  dimId: string,
  userId: string,
): Promise<{ committed: number; rowsRecovered: number; warehouseSynced: "n/a" | "synced" | "failed" }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; label: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label
     FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };
  const key = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT = cq(meta.dimTable);
  const MAPT = cq(meta.mapTable);

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId],
  );
  const committed = Number(approved?.n ?? 0);
  if (!committed) return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };

  const rowsRecovered = await rowsForUnmappedDrafts(dimId, meta.mapTable);

  // Snapshot approved drafts BEFORE the tx so we can pass them to the
  // warehouse adapter after the Postgres commit succeeds.
  const approvedDrafts = await pgAll<{ raw: string; key: string; label: string | null }>(
    `SELECT raw, target_key AS key, target_label AS label FROM ${DRAFT}
     WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId],
  );

  await pgTx(async ({ run }) => {
    await run(
      `INSERT INTO ${DIMT} (${key}, label)
       SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)`,
      [dimId],
    );
    await run(
      `INSERT INTO ${MAPT} (raw, ${key})
       SELECT d.raw, d.target_key FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))`,
      [dimId],
    );
    await run(`DELETE FROM ${DRAFT} WHERE dim_id = $1 AND status = 'mapped'`, [dimId]);
  });

  await appendAuditAs(
    userId,
    "Committed",
    `${committed} value${committed === 1 ? "" : "s"} → ${meta.mapTable} · ${rowsRecovered.toLocaleString()} rows recovered`,
  );

  // After Postgres commit: if the warehouse adapter is writable, attempt the
  // warehouse MERGE. Failures log + surface but don't roll back Postgres.
  let warehouseSynced: "n/a" | "synced" | "failed" = "n/a";
  const adapter = await getAdapter();
  if (isWritable(adapter)) {
    const dimSpec = {
      dimId,
      dimTable: meta.dimTable,
      mapTable: meta.mapTable,
      keyCol: meta.keyCol,
    };
    try {
      await adapter.ensureCanonicalTables(dimSpec);
      await adapter.commitCanonical(dimSpec, approvedDrafts);
      await appendAuditAs(
        userId,
        "Warehouse synced",
        `${committed} → ${meta.mapTable}`,
      );
      warehouseSynced = "synced";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendAuditAs(
        userId,
        "Warehouse sync failed",
        `${committed} → ${meta.mapTable}: ${msg}`,
      );
      warehouseSynced = "failed";
    }
  }

  // Prune ai_hint_cache entries whose suggestion no longer matches a valid
  // canonical label (unchanged from prior code).
  const currentLabels = await pgAll<{ label: string }>(
    `SELECT label FROM ${cq(meta.dimTable)} WHERE label IS NOT NULL`,
  ).catch(() => [] as { label: string }[]);
  if (currentLabels.length > 0) {
    const labelArr = currentLabels.map((r) => r.label);
    await pgRun(
      `DELETE FROM ${pg("ai_hint_cache")}
       WHERE dim_id = $1 AND suggestion IS NOT NULL AND NOT (suggestion = ANY($2::text[]))`,
      [dimId, labelArr],
    ).catch(() => {
      /* table may not exist in older deploys */
    });
  }

  return { committed, rowsRecovered, warehouseSynced };
}
```

Add the new import at the top of `repo-drafts.ts` (alongside `getAdapter`):

```ts
import { isWritable } from "./warehouse/adapter.ts";
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && bun test test/commit-warehouse-branch.test.ts
```
Expected: 4 tests pass.

Also run the full server test suite — `commit()`'s shape changed, so other tests (notably `commit.test.ts` from earlier phases) may need their assertions updated:

```bash
cd server && bun test
```

If any prior tests fail because they assert on the OLD return shape (`{committed, rowsRecovered}` without `warehouseSynced`), they'll either:
- Pass anyway (if they only check the existing fields) — preferred outcome
- Fail because they exhaustively destructure — fix by adding `warehouseSynced: "n/a"` to assertion

Read each failure and adjust.

- [ ] **Step 5: Typecheck + lint**

```bash
cd server && bun run typecheck && bun run lint
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-drafts.ts server/test/commit-warehouse-branch.test.ts
git commit -m "feat(commit): branch on writable adapter; surface warehouseSynced + audit events"
```

---

## Task 6: Frontend `useWorkspaceInfo` store hook

**Files:**
- Modify: `app/src/store.ts`
- Create: `app/test/workspace-info.test.ts`

Adds a one-shot fetch of `/api/workspace/info`, cached for the app lifetime. Powers the dashboard badge + commit-affordance copy.

- [ ] **Step 1: Inspect the existing store pattern**

Read `app/src/store.ts` to confirm where hooks like `useDimensions`, `useDrafts` are defined. Follow the same pattern (presumably a React hook that fetches on mount and caches via module-level state or a context provider).

- [ ] **Step 2: Write the failing test**

Create `app/test/workspace-info.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

describe("useWorkspaceInfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("returns workspace info after fetch", async () => {
    const mockInfo = {
      adapter: "duckdb",
      writable: false,
      canonicalMode: "postgres-export" as const,
      warehouseDb: "analytics",
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => mockInfo,
    })) as unknown as typeof fetch;

    const { useWorkspaceInfo } = await import("../src/store");
    const { result } = renderHook(() => useWorkspaceInfo());

    await waitFor(() => {
      expect(result.current).toEqual(mockInfo);
    });
  });

  test("returns null while loading", async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    const { useWorkspaceInfo } = await import("../src/store");
    const { result } = renderHook(() => useWorkspaceInfo());
    expect(result.current).toBeNull();
  });
});
```

- [ ] **Step 3: Run, verify failure**

```bash
cd app && bun run test test/workspace-info.test.ts
```
Expected: FAIL — `useWorkspaceInfo` doesn't exist.

- [ ] **Step 4: Add the hook to `store.ts`**

Open `app/src/store.ts`. Add (placement: alongside other API-fetch hooks like `useAudit` or `useDimensions`):

```ts
import { useState, useEffect } from "react"; // (likely already imported)

export interface WorkspaceInfo {
  adapter: "duckdb" | "snowflake";
  writable: boolean;
  canonicalMode: "warehouse" | "postgres-export";
  warehouseDb: string | null;
}

let _workspaceInfoCache: WorkspaceInfo | null = null;
let _workspaceInfoPromise: Promise<WorkspaceInfo> | null = null;

export function useWorkspaceInfo(): WorkspaceInfo | null {
  const [info, setInfo] = useState<WorkspaceInfo | null>(_workspaceInfoCache);
  useEffect(() => {
    if (_workspaceInfoCache) return;
    if (!_workspaceInfoPromise) {
      _workspaceInfoPromise = fetch("/api/workspace/info")
        .then((r) => r.json() as Promise<WorkspaceInfo>)
        .then((data) => {
          _workspaceInfoCache = data;
          return data;
        });
    }
    _workspaceInfoPromise.then((data) => setInfo(data));
  }, []);
  return info;
}
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd app && bun run test test/workspace-info.test.ts
```
Expected: tests pass.

- [ ] **Step 6: Typecheck**

```bash
cd app && bun run typecheck
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/store.ts app/test/workspace-info.test.ts
git commit -m "feat(store): useWorkspaceInfo hook"
```

---

## Task 7: Dashboard canonical-destination KPI

**Files:**
- Modify: `app/src/routes/Dashboard.tsx`
- Create: `app/test/dashboard-canonical-badge.test.tsx`

Adds the "Canonical destination" KPI card to the Dashboard's KPI strip.

- [ ] **Step 1: Inspect existing KPI structure**

Read `app/src/routes/Dashboard.tsx:100-140` (the `kpis` array definition) to confirm the KPI shape (label, value, etc.).

- [ ] **Step 2: Write the failing test**

Create `app/test/dashboard-canonical-badge.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

describe("Dashboard canonical-destination badge", () => {
  test("renders 'Local + export' when workspace is read-only", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          canonicalMode: "postgres-export",
          warehouseDb: "analytics",
        }),
        useDimensions: () => [],
        useAudit: () => [],
        useDrafts: () => ({}),
      };
    });
    const { Dashboard } = await import("../src/routes/Dashboard");
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Local \+ export/i)).toBeInTheDocument();
    });
  });

  test("renders 'Snowflake — writable' when workspace is writable", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "snowflake",
          writable: true,
          canonicalMode: "warehouse",
          warehouseDb: "ANALYTICS",
        }),
        useDimensions: () => [],
        useAudit: () => [],
        useDrafts: () => ({}),
      };
    });
    const { Dashboard } = await import("../src/routes/Dashboard");
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Snowflake.*writable/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run, verify failure**

```bash
cd app && bun run test test/dashboard-canonical-badge.test.tsx
```
Expected: FAIL — no element matches "Local + export" / "Snowflake — writable".

- [ ] **Step 4: Add the KPI to Dashboard.tsx**

In `app/src/routes/Dashboard.tsx`:

1. Add the import at the top:
   ```ts
   import { useWorkspaceInfo } from "../store";
   ```

2. Inside the `Dashboard()` component, add the hook call near the other state lines (after `const dims = useDimensions();`):
   ```ts
   const wsInfo = useWorkspaceInfo();
   ```

3. Add a new KPI item to the `kpis` array. The Dashboard already builds a `kpis: Array<{label, value, ...}>` — add an entry near the end of the array (or wherever fits the layout):
   ```ts
   {
     label: "Canonical destination",
     value: wsInfo
       ? wsInfo.writable
         ? `🟢 ${wsInfo.adapter[0].toUpperCase() + wsInfo.adapter.slice(1)} — writable`
         : "📦 Local + export"
       : "…",
     hint: wsInfo
       ? wsInfo.writable
         ? `Commits MERGE into ${wsInfo.warehouseDb ?? "warehouse"}`
         : "Postgres canonical; download Parquet on demand"
       : undefined,
   },
   ```

   (The `Kpi` component's actual prop names — `label`, `value`, `hint`, etc. — come from `app/src/components/Kpi.tsx`. Read that file briefly to match the existing shape exactly; adjust the example above if `hint` should be `subtitle` or similar.)

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd app && bun run test test/dashboard-canonical-badge.test.tsx
```
Expected: tests pass.

- [ ] **Step 6: Typecheck**

```bash
cd app && bun run typecheck
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/routes/Dashboard.tsx app/test/dashboard-canonical-badge.test.tsx
git commit -m "feat(dashboard): canonical-destination KPI badge"
```

---

## Task 8: Triage commit-affordance copy adapts to mode

**Files:**
- Modify: `app/src/routes/Triage.tsx`
- Create: `app/test/triage-commit-copy.test.tsx`

The "Approve & commit" button copy changes based on workspace mode.

- [ ] **Step 1: Locate the commit-button in Triage**

Read `app/src/routes/Triage.tsx:670-740` (the commit footer block) to find the exact button + label. Look for "Approve" or "commit" in the rendered text.

- [ ] **Step 2: Write the failing test**

Create `app/test/triage-commit-copy.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

function renderTriage() {
  return import("../src/routes/Triage").then(({ Triage }) =>
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    ),
  );
}

describe("Triage commit affordance copy", () => {
  test("writable mode: button says 'Approve & commit to warehouse'", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "snowflake",
          writable: true,
          canonicalMode: "warehouse",
          warehouseDb: "ANALYTICS",
        }),
        useDimensions: () => [{ id: "country", dimension: "Country", values: [], canonical: [], fields: [], rows: 0, color: null, description: null, dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code", keyKind: "slug" }],
        useDrafts: () => ({ "country|USA": { dimId: "country", raw: "USA", status: "mapped", targetLabel: "United States", targetKey: "us", user: { id: "u_test", name: "Test", initials: "T" }, at: "1m ago" } }),
        saveDraft: vi.fn(),
        discardDraft: vi.fn(),
        commit: vi.fn(),
        dkey: (dimId: string, raw: string) => `${dimId}|${raw}`,
      };
    });
    await renderTriage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /commit to warehouse/i })).toBeInTheDocument();
    });
  });

  test("postgres-export mode: button says 'Approve & save' + 'Download snapshot' link", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          canonicalMode: "postgres-export",
          warehouseDb: "analytics",
        }),
        useDimensions: () => [{ id: "country", dimension: "Country", values: [], canonical: [], fields: [], rows: 0, color: null, description: null, dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code", keyKind: "slug" }],
        useDrafts: () => ({ "country|USA": { dimId: "country", raw: "USA", status: "mapped", targetLabel: "United States", targetKey: "us", user: { id: "u_test", name: "Test", initials: "T" }, at: "1m ago" } }),
        saveDraft: vi.fn(),
        discardDraft: vi.fn(),
        commit: vi.fn(),
        dkey: (dimId: string, raw: string) => `${dimId}|${raw}`,
      };
    });
    await renderTriage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /approve & save/i })).toBeInTheDocument();
      expect(screen.getByText(/Download snapshot/i)).toBeInTheDocument();
    });
  });
});
```

(The fixture shape for `useDimensions` and `useDrafts` should match the actual types in `data.ts` / `store.ts`. Adjust as needed after reading those files.)

- [ ] **Step 3: Run, verify failure**

```bash
cd app && bun run test test/triage-commit-copy.test.tsx
```
Expected: FAIL — buttons match the existing (mode-agnostic) copy.

- [ ] **Step 4: Adapt the copy in Triage.tsx**

In `app/src/routes/Triage.tsx`:

1. Add the import:
   ```ts
   import { useWorkspaceInfo } from "../store";
   ```

2. Inside the `Triage()` component, add the hook call near the other top-level state lines:
   ```ts
   const wsInfo = useWorkspaceInfo();
   ```

3. Pass it down to the commit footer component (likely `CrossDimInbox` or similar). Look for the existing prop list (around line 357-360) and add:
   ```ts
   wsInfo: WorkspaceInfo | null;
   ```

4. In the footer rendering code (around line 670-740), find the "Approve" button. Change the button label to be mode-aware:
   ```tsx
   {p.wsInfo?.writable
     ? "Approve & commit to warehouse"
     : "Approve & save"}
   ```

5. In postgres-export mode, render a sibling "Download snapshot →" link. Place it near the button (small text below):
   ```tsx
   {p.wsInfo && !p.wsInfo.writable && stagedAllDrafts[0] && (
     <a
       href={`/api/dimensions/${stagedAllDrafts[0].dimId}/snapshot.parquet`}
       download
       className="text-xs text-ink-3 hover:underline"
     >
       Download snapshot →
     </a>
   )}
   ```

   (The link points to the FIRST staged draft's dimension. For a true multi-dim affordance, this should be a per-dim link in the per-dim section of the footer — adjust placement to wherever per-dim affordances live in the existing layout.)

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd app && bun run test test/triage-commit-copy.test.tsx
```
Expected: tests pass.

- [ ] **Step 6: Typecheck**

```bash
cd app && bun run typecheck
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/routes/Triage.tsx app/test/triage-commit-copy.test.tsx
git commit -m "feat(triage): commit affordance copy adapts to canonical mode"
```

---

## Task 9: "Needs resync" badge per dimension in Dashboard

**Files:**
- Modify: `app/src/routes/Dashboard.tsx`

When in writable-warehouse mode, derive a "needs resync" flag from the latest `"Warehouse sync failed"` audit event per dimension. Render an icon/badge in the dimensions table.

- [ ] **Step 1: Add the derivation helper**

In `app/src/routes/dashboard-helpers.ts` (or inline in `Dashboard.tsx` if helpers file doesn't exist), add:

```ts
import type { AuditEntry } from "../store"; // (use whatever type the audit log returns)

/** Per-dimension warehouse-sync status derived from the audit log.
 *  - "synced": latest event for the dim is "Warehouse synced"
 *  - "failed": latest event for the dim is "Warehouse sync failed"
 *  - "unknown": no warehouse sync events yet for the dim (or read-only mode)
 *  The dim is identified by the dim's mapTable name appearing in the audit detail.
 */
export function warehouseSyncStatusByDim(
  audits: AuditEntry[],
  dims: Array<{ id: string; mapTable: string }>,
): Record<string, "synced" | "failed" | "unknown"> {
  const status: Record<string, "synced" | "failed" | "unknown"> = {};
  for (const d of dims) status[d.id] = "unknown";

  // Audits are returned newest-first by listAudit; iterate and first match per dim wins.
  for (const a of audits) {
    if (a.action !== "Warehouse synced" && a.action !== "Warehouse sync failed") continue;
    for (const d of dims) {
      if (status[d.id] !== "unknown") continue;
      if (a.detail.includes(d.mapTable)) {
        status[d.id] = a.action === "Warehouse synced" ? "synced" : "failed";
      }
    }
  }
  return status;
}
```

- [ ] **Step 2: Surface the badge in the dimensions table**

In `app/src/routes/Dashboard.tsx`, where the dimensions table is rendered (the existing table of `visibleDims`), add a column or inline indicator. For each dim row, if `wsInfo?.writable === true` AND `syncStatus[dim.id] === "failed"`, show `🔄 needs resync` next to the dim name.

```tsx
// At the top of the component:
const syncStatus = useMemo(
  () => warehouseSyncStatusByDim(auditLog, dims),
  [auditLog, dims],
);

// In the dimension row render (find the cell that renders dim.dimension):
{wsInfo?.writable && syncStatus[dim.id] === "failed" && (
  <span
    title="Last warehouse sync failed — manual resync required"
    className="ml-2 inline-flex items-center text-xs text-amber-600"
  >
    🔄 needs resync
  </span>
)}
```

- [ ] **Step 3: Add a quick test (if test infra exists for the dimensions table)**

If the dashboard already has a test that renders the dimensions table, extend it to assert the badge appears when conditions are met. If not, skip — the badge is a visual derivation; the helper function above is the testable part.

Test for the helper:

```ts
// In app/test/dashboard-canonical-badge.test.tsx (append, or new file)
import { warehouseSyncStatusByDim } from "../src/routes/dashboard-helpers";

test("warehouseSyncStatusByDim: latest event per dim wins", () => {
  const audits = [
    // newest first
    { id: "1", at: "now", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse sync failed", detail: "1 → zugzug.map_country: timeout" },
    { id: "2", at: "1m", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse synced", detail: "5 → zugzug.map_partner" },
    { id: "3", at: "2m", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse synced", detail: "3 → zugzug.map_country" },
  ];
  const dims = [
    { id: "country", mapTable: "zugzug.map_country" },
    { id: "partner", mapTable: "zugzug.map_partner" },
    { id: "channel", mapTable: "zugzug.map_channel" }, // no events
  ];
  expect(warehouseSyncStatusByDim(audits, dims)).toEqual({
    country: "failed",
    partner: "synced",
    channel: "unknown",
  });
});
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd app && bun run test
```
Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/Dashboard.tsx app/src/routes/dashboard-helpers.ts app/test/dashboard-canonical-badge.test.tsx
git commit -m "feat(dashboard): per-dim needs-resync badge derived from audit log"
```

---

## Task 10: "Download snapshot" link in MasterTables.tsx dimension header

**Files:**
- Modify: `app/src/routes/MasterTables.tsx`

Adds a small "Download snapshot" link in the dimension detail header. Available in BOTH modes (writable users may want a Parquet backup too).

- [ ] **Step 1: Locate the dimension header in MasterTables.tsx**

Read `app/src/routes/MasterTables.tsx` to find where the active dimension's name/metadata is rendered (search for the dim title or breadcrumb).

- [ ] **Step 2: Add the link**

Near the dimension title/header, add:

```tsx
{activeDim && (
  <a
    href={`/api/dimensions/${activeDim.id}/snapshot.parquet`}
    download={`${activeDim.id}-map.parquet`}
    className="text-xs text-ink-3 hover:text-ink-1 hover:underline"
    title="Download the map table as Parquet"
  >
    ↓ Download snapshot
  </a>
)}
```

(Replace `activeDim` with whatever the local variable name is. Place it in the dimension header strip alongside any existing actions like rename/settings.)

- [ ] **Step 3: Typecheck + format**

```bash
cd app && bun run typecheck
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/MasterTables.tsx
git commit -m "feat(tables): Download snapshot link in dimension header"
```

---

## Task 11: Verification gates

**Files:** none modified — checks only.

- [ ] **Step 1: Server typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck
```
Expected: clean.

- [ ] **Step 2: Server lint**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run lint
```
Expected: clean.

- [ ] **Step 3: Server prettier**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run format:check
```
Expected: clean. Run `bun run format` if needed and commit `style(server): prettier pass on phase 3 files`.

- [ ] **Step 4: Server tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test
```
Expected: all prior tests + Phase 3 additions pass.

- [ ] **Step 5: App typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```
Expected: clean.

- [ ] **Step 6: App tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test
```
Expected: all prior tests + Phase 3 additions pass.

- [ ] **Step 7: Server boot smoke**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && timeout 5 bun run start 2>&1 | head -10 || true
```
Expected: `· connected (duckdb, read-only)`. No errors.

- [ ] **Step 8: Grep gate — warehouseSynced wired**

```bash
grep -n "warehouseSynced" /Users/fhagelund/Documents/GitHub/zugzug/server/src/repo-drafts.ts
```
Expected: at least 4 matches (return-type declaration, three return paths, possibly more).

- [ ] **Step 9: Commit history**

```bash
git log --oneline main..HEAD
```
Expected: ~11-12 commits in dependency order:
- feat(parquet): lazy in-process DuckDB exporter foundation
- feat(parquet): exportCanonicalToParquet via DuckDB Appender API
- feat(api): GET /api/dimensions/:id/snapshot.parquet endpoint
- feat(api): GET /api/workspace/info endpoint
- feat(commit): branch on writable adapter; surface warehouseSynced + audit events
- feat(store): useWorkspaceInfo hook
- feat(dashboard): canonical-destination KPI badge
- feat(triage): commit affordance copy adapts to canonical mode
- feat(dashboard): per-dim needs-resync badge derived from audit log
- feat(tables): Download snapshot link in dimension header
- (optional) style(server): prettier pass on phase 3 files

- [ ] **Step 10: Manual UI smoke (no commit)**

In one terminal: `cd server && bun run start`. In another: `cd app && bun run dev`. Open <http://localhost:5173/app>. Verify:

1. Dashboard shows `📦 Local + export` KPI (since default adapter is read-only DuckDB).
2. No "needs resync" badge appears on any dim (since the dashboard only shows the badge in writable mode AND we're in postgres-export).
3. Triage commit button reads "Approve & save" (not "Approve & commit to warehouse").
4. With a staged draft, the "Download snapshot →" link appears in Triage.
5. Master Tables dimension header has a "↓ Download snapshot" link; clicking it downloads `<dim_id>-map.parquet`.
6. Open the downloaded Parquet in DuckDB CLI or Tad — confirms 2 columns (`raw`, `<keyCol>`) and the mapped rows.

If anything is missing or visually broken, fix in a targeted task.

---

## Self-review summary

**Spec coverage** (against `docs/superpowers/specs/2026-06-08-phase3-canonical-store-modes-design.md`):
- Standalone Parquet exporter (Tasks 1-2) ✓
- Snapshot endpoint (Task 3) ✓
- Workspace info endpoint (Task 4) ✓
- commit() branching + audit events + return-type extension (Task 5) ✓
- Frontend store hook (Task 6) ✓
- Dashboard canonical-destination badge (Task 7) ✓
- Triage commit-affordance copy per mode (Task 8) ✓
- Per-dim needs-resync badge (Task 9) ✓
- Download snapshot link in Tables (Task 10) ✓
- Verification gates (Task 11) ✓

**Spec deviation captured at top of plan:** snapshot exports MAP only (not DIM); endpoint stays singular. dim export is v1.1.

**Out of scope per spec, also out of scope here:**
- Workspace-upgrade backfill — deferred to Phase 4.
- API-token auth on snapshot endpoint — Phase 4 adds tokens; v1 is cookie-only.
- S3/GCS push, scheduled exports — v1.1+.
- Per-workspace credential admin UI — Phase 4.
- Auto-retry for warehouse sync failures — user-manual via future "Resync" button.

**Tests structure:**
- Server: 3 new test files (`parquet-exporter.test.ts`, `snapshot-endpoint.test.ts`, `workspace-info.test.ts`, `commit-warehouse-branch.test.ts`).
- App: 3 new test files (`workspace-info.test.ts`, `dashboard-canonical-badge.test.tsx`, `triage-commit-copy.test.tsx`).
- All tests use mocked SnowflakeConnection (server) or mocked store hooks (app). No live Snowflake required.
