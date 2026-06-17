# Postgres-Materialized Scan Values Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize distinct unmapped warehouse values into Postgres at scan time. Triage and Match mode read paginated from Postgres. The legacy in-JS `scanValues`, its silent 500-row cap, and `MappingDimension.values` all disappear in this PR. No compat shims — Zugzug is pre-launch.

**Architecture:** Two new tables — `dim_scan_value` (one row per case-folded raw, per dim) and `dim_scan_occurrence` (per source provenance) — populated transactionally during every scan/derive via `materializeDimScanValues(dimId)`. Reads go through `getDimScanScalars(tenantId)` (per-dim counts + last-scan timestamp, fetched once at boot) and `getDimScanValuesPage(tenantId, dimId, opts)` (cursor-paginated, joins `map_<dim>` live for mapped/new). `MappingDimension.values` is replaced by `MappingDimension.counts` (required). Triage + MatchModeBody migrate to a per-dim lazy `useDimValuesPage` hook.

**Tech Stack:** Postgres + Drizzle migrations, repo functions in `server/src/repo-*.ts`, Hono routes in `server/src/server.ts`, React store hooks in `app/src/store.ts`. Tests run via `bun test`.

---

## Out of Scope

- `pg_trgm` text-search indexes — sequential scan on `raw_lower ILIKE` is fine for now; revisit if a real dim exceeds 200ms search latency.
- Server-Sent Events / live invalidation — staleness is operator-driven (focus-refetch + rescan button).
- Warehouse-side caching — unnecessary; `distinctValuesWithProvenance` only runs at scan time now.

## Invariants

- After this PR, **no code reads `dim.values`** anywhere.
- `MappingDimension.counts` is required, not optional.
- The 500-row cap is gone. There is no per-dim cap on the wire — pagination handles size.
- `scanValues` does not exist.

---

## File Structure

**New:**
- `server/drizzle/migrations/0020_dim_scan_values.sql`
- `server/src/repo-dim-scan.ts`
- `server/test/repo-dim-scan.test.ts`
- `app/src/lib/use-dim-values-page.ts`
- `app/test/use-dim-values-page.test.tsx`

**Modified:**
- `server/drizzle/schema.ts`
- `server/src/repo-scan.ts` — scan path materializes per dim.
- `server/src/repo-canonical.ts` — `scanValues` deleted; `getDimension` returns `counts`, drops `values`.
- `server/src/repo-drafts.ts` — auto-stage reads from materialized tables.
- `server/src/server.ts` — new route, scalars pre-fetched at list time.
- `server/src/tenant-repo.ts` — expose `getDimScanScalars` + `getDimScanValuesPage`.
- `app/src/data.ts` — `MappingDimension.values` removed; `counts` required; fixtures updated.
- `app/src/store.ts` — strip values from boot fetch.
- `app/src/routes/Triage.tsx` — per-dim lazy fetch, search, rescan, focus-refetch.
- `app/src/components/modes/MatchModeBody.tsx` — per-dim lazy fetch.
- `app/src/routes/Dashboard.tsx`, `app/src/components/TablePicker.tsx`, `app/src/components/AppShell.tsx`, `app/src/components/TablePane.tsx`, `app/src/routes/dashboard-helpers.ts` — read `d.counts.*` directly.

---

## Task 1: Migration + Drizzle schema

**Files:**
- Create: `server/drizzle/migrations/0020_dim_scan_values.sql`
- Modify: `server/drizzle/schema.ts` (insert after line 283 — the end of `scanRuns`).

- [ ] **Step 1: Write migration SQL**

`server/drizzle/migrations/0020_dim_scan_values.sql`:

```sql
CREATE TABLE "zugzug_app"."dim_scan_value" (
  "tenant_id"  varchar NOT NULL,
  "dim_id"     varchar NOT NULL,
  "raw"        varchar NOT NULL,
  "raw_lower"  varchar NOT NULL,
  "total_rows" bigint  NOT NULL,
  "scanned_at" timestamp NOT NULL,
  CONSTRAINT "dim_scan_value_pk" PRIMARY KEY ("tenant_id", "dim_id", "raw_lower"),
  CONSTRAINT "dim_scan_value_raw_nonempty"   CHECK (length("raw") > 0),
  CONSTRAINT "dim_scan_value_total_rows_nonneg" CHECK ("total_rows" >= 0),
  CONSTRAINT "dim_scan_value_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "zugzug_app"."tenant"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX "dim_scan_value_dim_rows_idx"
  ON "zugzug_app"."dim_scan_value" ("tenant_id", "dim_id", "total_rows" DESC);
--> statement-breakpoint

CREATE TABLE "zugzug_app"."dim_scan_occurrence" (
  "tenant_id"   varchar NOT NULL,
  "dim_id"      varchar NOT NULL,
  "raw_lower"   varchar NOT NULL,
  "table_name"  varchar NOT NULL,
  "column_name" varchar NOT NULL,
  "rows"        bigint  NOT NULL,
  CONSTRAINT "dim_scan_occurrence_pk"
    PRIMARY KEY ("tenant_id", "dim_id", "raw_lower", "table_name", "column_name"),
  CONSTRAINT "dim_scan_occurrence_rows_nonneg" CHECK ("rows" >= 0),
  CONSTRAINT "dim_scan_occurrence_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "zugzug_app"."tenant"("id") ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE "zugzug_app"."dim_scan_value"      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."dim_scan_occurrence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_iso ON "zugzug_app"."dim_scan_value"
  USING (tenant_id = current_setting('app.tenant_id')
         OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."dim_scan_occurrence"
  USING (tenant_id = current_setting('app.tenant_id')
         OR current_setting('app.is_super_admin', true) = 't');
```

- [ ] **Step 2: Add Drizzle tables**

Insert after `scanRuns` in `server/drizzle/schema.ts`:

```ts
export const dimScanValue = app.table(
  "dim_scan_value",
  {
    tenant_id:  varchar("tenant_id").notNull().references(() => tenant.id),
    dim_id:     varchar("dim_id").notNull(),
    raw:        varchar("raw").notNull(),
    raw_lower:  varchar("raw_lower").notNull(),
    total_rows: bigint("total_rows", { mode: "number" }).notNull(),
    scanned_at: timestamp("scanned_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.dim_id, t.raw_lower] }),
    index("dim_scan_value_dim_rows_idx").on(t.tenant_id, t.dim_id, t.total_rows),
    check("dim_scan_value_raw_nonempty",      sql`length(${t.raw}) > 0`),
    check("dim_scan_value_total_rows_nonneg", sql`${t.total_rows} >= 0`),
  ],
);

export const dimScanOccurrence = app.table(
  "dim_scan_occurrence",
  {
    tenant_id:   varchar("tenant_id").notNull().references(() => tenant.id),
    dim_id:      varchar("dim_id").notNull(),
    raw_lower:   varchar("raw_lower").notNull(),
    table_name:  varchar("table_name").notNull(),
    column_name: varchar("column_name").notNull(),
    rows:        bigint("rows", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.tenant_id, t.dim_id, t.raw_lower, t.table_name, t.column_name],
    }),
    check("dim_scan_occurrence_rows_nonneg", sql`${t.rows} >= 0`),
  ],
);
```

- [ ] **Step 3: Apply**

Run: `cd server && bun run db:migrate`
Expected: prints "Postgres migrations applied", no errors.

- [ ] **Step 4: Verify**

```bash
cd server && bun -e "import postgres from 'postgres'; import {env} from './src/env.ts'; const c=postgres(env.databaseUrl); console.log(await c\`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('dim_scan_value','dim_scan_occurrence')\`); await c.end()"
```
Expected: two rows, `relrowsecurity=true`.

- [ ] **Step 5: Commit**

```bash
git add server/drizzle/migrations/0020_dim_scan_values.sql server/drizzle/schema.ts
git commit -m "feat(db): add dim_scan_value + dim_scan_occurrence"
```

---

## Task 2: `repo-dim-scan.ts` — writer

**Files:**
- Create: `server/src/repo-dim-scan.ts`
- Create: `server/test/repo-dim-scan.test.ts`

- [ ] **Step 1: Failing test**

`server/test/repo-dim-scan.test.ts`:

```ts
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { pgRun, pgAll } from "../src/pg.ts";
import { materializeDimScanValues } from "../src/repo-dim-scan.ts";

const TENANT = "t_test_dim_scan";
const DIM = "d_color";

beforeEach(async () => {
  await pgRun(`DELETE FROM zugzug_app.dim_scan_occurrence WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.dim_scan_value      WHERE tenant_id = $1`, [TENANT]);
});

test("materializeDimScanValues writes one value per distinct raw with summed rows", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "Red",   table: "raw.products", column: "color", rows: 100 },
      { raw: "RED",   table: "raw.orders",   column: "color", rows:  50 },
      { raw: "Blue",  table: "raw.products", column: "color", rows:  30 },
    ],
    scannedAt: new Date("2026-06-17T10:00:00Z"),
  });

  const values = await pgAll<{ raw: string; raw_lower: string; total_rows: number }>(
    `SELECT raw, raw_lower, total_rows FROM zugzug_app.dim_scan_value
       WHERE tenant_id = $1 AND dim_id = $2 ORDER BY raw_lower`,
    [TENANT, DIM],
  );
  expect(values).toHaveLength(2);
  expect(values[0]).toMatchObject({ raw_lower: "blue", total_rows: 30 });
  expect(values[1]).toMatchObject({ raw_lower: "red",  total_rows: 150 });
});

test("materializeDimScanValues writes per-source occurrences", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "Red", table: "raw.products", column: "color", rows: 100 },
      { raw: "RED", table: "raw.orders",   column: "color", rows:  50 },
    ],
    scannedAt: new Date(),
  });
  const occs = await pgAll<{ table_name: string; rows: number }>(
    `SELECT table_name, rows FROM zugzug_app.dim_scan_occurrence
       WHERE tenant_id = $1 AND dim_id = $2 ORDER BY table_name`,
    [TENANT, DIM],
  );
  expect(occs).toHaveLength(2);
  expect(occs[0]).toMatchObject({ table_name: "raw.orders",   rows: 50 });
  expect(occs[1]).toMatchObject({ table_name: "raw.products", rows: 100 });
});

test("materializeDimScanValues replaces prior rows for the same dim", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [{ raw: "Red", table: "raw.a", column: "c", rows: 10 }],
    scannedAt: new Date(),
  });
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [{ raw: "Green", table: "raw.a", column: "c", rows: 20 }],
    scannedAt: new Date(),
  });
  const values = await pgAll<{ raw_lower: string }>(
    `SELECT raw_lower FROM zugzug_app.dim_scan_value
       WHERE tenant_id = $1 AND dim_id = $2`,
    [TENANT, DIM],
  );
  expect(values).toHaveLength(1);
  expect(values[0].raw_lower).toBe("green");
});

test("materializeDimScanValues with empty occurrences clears the dim", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [{ raw: "Red", table: "raw.a", column: "c", rows: 10 }],
    scannedAt: new Date(),
  });
  await materializeDimScanValues(DIM, TENANT, { occurrences: [], scannedAt: new Date() });
  const values = await pgAll<{ raw_lower: string }>(
    `SELECT raw_lower FROM zugzug_app.dim_scan_value WHERE tenant_id = $1 AND dim_id = $2`,
    [TENANT, DIM],
  );
  expect(values).toHaveLength(0);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd server && bun test test/repo-dim-scan.test.ts`
Expected: import error.

- [ ] **Step 3: Implement writer**

`server/src/repo-dim-scan.ts`:

```ts
import { pgRun, pgAll } from "./pg.ts";

export interface ScanOccurrence {
  raw: string;
  table: string;
  column: string;
  rows: number;
}

export interface MaterializeOpts {
  occurrences: readonly ScanOccurrence[];
  scannedAt: Date;
}

/** Replace this dim's materialized scan values atomically. Per-source
 *  occurrences keep provenance; dim_scan_value rolls up by case-folded raw. */
export async function materializeDimScanValues(
  dimId: string,
  tenantId: string,
  opts: MaterializeOpts,
): Promise<void> {
  const byLower = new Map<string, { raw: string; total: number }>();
  for (const o of opts.occurrences) {
    const lower = o.raw.toLowerCase();
    const e = byLower.get(lower);
    if (e) e.total += o.rows;
    else byLower.set(lower, { raw: o.raw, total: o.rows });
  }

  await pgRun("BEGIN");
  try {
    await pgRun(
      `DELETE FROM zugzug_app.dim_scan_occurrence WHERE tenant_id = $1 AND dim_id = $2`,
      [tenantId, dimId],
    );
    await pgRun(
      `DELETE FROM zugzug_app.dim_scan_value      WHERE tenant_id = $1 AND dim_id = $2`,
      [tenantId, dimId],
    );

    if (byLower.size > 0) {
      const params: unknown[] = [];
      const ph: string[] = [];
      let i = 0;
      for (const [lower, v] of byLower) {
        params.push(tenantId, dimId, v.raw, lower, v.total, opts.scannedAt);
        ph.push(`($${++i}, $${++i}, $${++i}, $${++i}, $${++i}, $${++i})`);
      }
      await pgRun(
        `INSERT INTO zugzug_app.dim_scan_value
           (tenant_id, dim_id, raw, raw_lower, total_rows, scanned_at)
         VALUES ${ph.join(", ")}`,
        params,
      );
    }

    if (opts.occurrences.length > 0) {
      const params: unknown[] = [];
      const ph: string[] = [];
      let j = 0;
      for (const o of opts.occurrences) {
        params.push(tenantId, dimId, o.raw.toLowerCase(), o.table, o.column, o.rows);
        ph.push(`($${++j}, $${++j}, $${++j}, $${++j}, $${++j}, $${++j})`);
      }
      await pgRun(
        `INSERT INTO zugzug_app.dim_scan_occurrence
           (tenant_id, dim_id, raw_lower, table_name, column_name, rows)
         VALUES ${ph.join(", ")}
         ON CONFLICT (tenant_id, dim_id, raw_lower, table_name, column_name)
           DO UPDATE SET rows = EXCLUDED.rows`,
        params,
      );
    }

    await pgRun("COMMIT");
  } catch (e) {
    await pgRun("ROLLBACK").catch(() => {});
    throw e;
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `cd server && bun test test/repo-dim-scan.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-dim-scan.ts server/test/repo-dim-scan.test.ts
git commit -m "feat(repo): materializeDimScanValues writer"
```

---

## Task 3: Reader functions — scalars + paged values

**Files:**
- Modify: `server/src/repo-dim-scan.ts`
- Modify: `server/test/repo-dim-scan.test.ts`

- [ ] **Step 1: Failing tests**

Append to `server/test/repo-dim-scan.test.ts`:

```ts
import { getDimScanScalars, getDimScanValuesPage } from "../src/repo-dim-scan.ts";

test("getDimScanScalars returns per-dim totals joined against map_<dim>", async () => {
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.map_test_color
               (tenant_id varchar, raw varchar, color_code varchar)`);
  await pgRun(
    `INSERT INTO zugzug_app.map_test_color (tenant_id, raw, color_code)
     VALUES ($1, 'Red', 'RED') ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await pgRun(
    `INSERT INTO zugzug_app.dimension
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Color', 'zugzug_app.dim_test_color',
             'zugzug_app.map_test_color', 'color_code', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [DIM, TENANT],
  );

  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "Red",   table: "raw.a", column: "c", rows: 100 },
      { raw: "Blue",  table: "raw.a", column: "c", rows:  50 },
      { raw: "Green", table: "raw.a", column: "c", rows:  30 },
    ],
    scannedAt: new Date("2026-06-17T10:00:00Z"),
  });

  const scalars = await getDimScanScalars(TENANT);
  const row = scalars.find((r) => r.dimId === DIM);
  expect(row).toBeDefined();
  expect(row!.totalDistinct).toBe(3);
  expect(row!.mappedCount).toBe(1);
  expect(row!.newCount).toBe(2);
  expect(row!.scannedAt).toBeInstanceOf(Date);
});

test("getDimScanValuesPage paginates unmapped first by total_rows desc", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: Array.from({ length: 30 }, (_, i) => ({
      raw: `v${String(i).padStart(2, "0")}`,
      table: "raw.a",
      column: "c",
      rows: 1000 - i,
    })),
    scannedAt: new Date(),
  });

  const page1 = await getDimScanValuesPage(TENANT, DIM, { filter: "new", limit: 10 });
  expect(page1.items).toHaveLength(10);
  expect(page1.items[0].raw).toBe("v00");
  expect(page1.items[9].raw).toBe("v09");
  expect(page1.hasMore).toBe(true);

  const page2 = await getDimScanValuesPage(TENANT, DIM, {
    filter: "new",
    limit: 10,
    after: page1.nextCursor,
  });
  expect(page2.items[0].raw).toBe("v10");
});

test("getDimScanValuesPage q substring matches case-insensitively", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "ACME Corp",  table: "raw.a", column: "c", rows: 10 },
      { raw: "acme Inc",   table: "raw.a", column: "c", rows: 20 },
      { raw: "Globex",     table: "raw.a", column: "c", rows: 30 },
    ],
    scannedAt: new Date(),
  });

  const page = await getDimScanValuesPage(TENANT, DIM, { filter: "all", limit: 50, q: "acme" });
  expect(page.items.map((i) => i.raw).sort()).toEqual(["ACME Corp", "acme Inc"]);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd server && bun test test/repo-dim-scan.test.ts`
Expected: import error on the new symbols.

- [ ] **Step 3: Implement readers**

Append to `server/src/repo-dim-scan.ts`:

```ts
import { cq, qid } from "./repo-shared.ts";

export interface DimScanScalars {
  dimId: string;
  totalDistinct: number;
  mappedCount: number;
  newCount: number;
  scannedAt: Date | null;
}

/** Per-dim scalar counts and last-scan timestamp. One row per dim that has
 *  been scanned at least once. Loops in JS because map_<dim> is dynamic. */
export async function getDimScanScalars(tenantId: string): Promise<DimScanScalars[]> {
  const dims = await pgAll<{ dimId: string; mapTable: string }>(
    `SELECT id AS "dimId", map_table AS "mapTable"
       FROM zugzug_app.dimension WHERE tenant_id = $1`,
    [tenantId],
  );
  const mapByDim = new Map(dims.map((d) => [d.dimId, d.mapTable]));

  const rows = await pgAll<{ dimId: string; total: number; scannedAt: Date | null }>(
    `SELECT dim_id AS "dimId", COUNT(*)::bigint AS total, MAX(scanned_at) AS "scannedAt"
       FROM zugzug_app.dim_scan_value
       WHERE tenant_id = $1
       GROUP BY dim_id`,
    [tenantId],
  );

  const out: DimScanScalars[] = [];
  for (const r of rows) {
    const mapTable = mapByDim.get(r.dimId);
    let mapped = 0;
    if (mapTable) {
      const m = await pgAll<{ n: number }>(
        `SELECT COUNT(*)::bigint AS n
           FROM zugzug_app.dim_scan_value v
           JOIN ${cq(mapTable)} m
             ON m.tenant_id = v.tenant_id AND LOWER(m.raw) = v.raw_lower
           WHERE v.tenant_id = $1 AND v.dim_id = $2`,
        [tenantId, r.dimId],
      ).catch(() => [{ n: 0 }]);
      mapped = Number(m[0]?.n ?? 0);
    }
    out.push({
      dimId: r.dimId,
      totalDistinct: Number(r.total),
      mappedCount: mapped,
      newCount: Number(r.total) - mapped,
      scannedAt: r.scannedAt,
    });
  }
  return out;
}

export interface ScanValueRow {
  raw: string;
  totalRows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}

export interface PageOpts {
  filter: "new" | "mapped" | "all";
  limit: number;
  after?: string | null;
  q?: string | null;
}

export interface ValuesPage {
  items: ScanValueRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

function encodeCursor(totalRows: number, rawLower: string): string {
  return Buffer.from(JSON.stringify([totalRows, rawLower])).toString("base64url");
}
function decodeCursor(c: string): [number, string] | null {
  try {
    const j = JSON.parse(Buffer.from(c, "base64url").toString());
    return Array.isArray(j) && typeof j[0] === "number" && typeof j[1] === "string"
      ? [j[0], j[1]]
      : null;
  } catch {
    return null;
  }
}

/** One page of dim values, sorted by total_rows desc, raw_lower asc. Cursor
 *  is the (total_rows, raw_lower) lex tuple — stable because raw_lower is
 *  PK-unique within a dim. */
export async function getDimScanValuesPage(
  tenantId: string,
  dimId: string,
  opts: PageOpts,
): Promise<ValuesPage> {
  const limit = Math.min(500, Math.max(1, opts.limit));
  const dim = await pgAll<{ mapTable: string; dimTable: string; keyCol: string }>(
    `SELECT map_table AS "mapTable", dim_table AS "dimTable", key_col AS "keyCol"
       FROM zugzug_app.dimension WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!dim.length) return { items: [], hasMore: false, nextCursor: null };
  const { mapTable, dimTable, keyCol } = dim[0];

  const params: unknown[] = [tenantId, dimId];
  let where = `v.tenant_id = $1 AND v.dim_id = $2`;
  if (opts.q && opts.q.trim()) {
    params.push(`%${opts.q.trim().toLowerCase()}%`);
    where += ` AND v.raw_lower ILIKE $${params.length}`;
  }
  if (opts.filter === "new") {
    where += ` AND m.${qid(keyCol)} IS NULL`;
  } else if (opts.filter === "mapped") {
    where += ` AND m.${qid(keyCol)} IS NOT NULL`;
  }
  if (opts.after) {
    const c = decodeCursor(opts.after);
    if (c) {
      params.push(c[0], c[0], c[1]);
      where += ` AND (v.total_rows < $${params.length - 2}
                  OR (v.total_rows = $${params.length - 1} AND v.raw_lower > $${params.length}))`;
    }
  }
  params.push(limit + 1);

  const rows = await pgAll<{
    raw: string;
    raw_lower: string;
    total_rows: number;
    mapped_key: string | null;
    mapped_label: string | null;
  }>(
    `SELECT v.raw, v.raw_lower, v.total_rows,
            m.${qid(keyCol)} AS mapped_key,
            d.label          AS mapped_label
       FROM zugzug_app.dim_scan_value v
       LEFT JOIN ${cq(mapTable)} m
         ON m.tenant_id = v.tenant_id AND LOWER(m.raw) = v.raw_lower
       LEFT JOIN ${cq(dimTable)} d
         ON d.${qid(keyCol)} = m.${qid(keyCol)}
       WHERE ${where}
       ORDER BY v.total_rows DESC, v.raw_lower ASC
       LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const lowers = items.map((r) => r.raw_lower);

  const occs = lowers.length
    ? await pgAll<{ raw_lower: string; table_name: string; column_name: string; rows: number }>(
        `SELECT raw_lower, table_name, column_name, rows
           FROM zugzug_app.dim_scan_occurrence
           WHERE tenant_id = $1 AND dim_id = $2 AND raw_lower = ANY($3)`,
        [tenantId, dimId, lowers],
      )
    : [];
  const occByLower = new Map<string, { table: string; column: string; rows: number }[]>();
  for (const o of occs) {
    const arr = occByLower.get(o.raw_lower) ?? [];
    arr.push({ table: o.table_name, column: o.column_name, rows: Number(o.rows) });
    occByLower.set(o.raw_lower, arr);
  }

  const out: ScanValueRow[] = items.map((r) => ({
    raw: r.raw,
    totalRows: Number(r.total_rows),
    isMapped: r.mapped_key !== null,
    mappedLabel: r.mapped_label,
    occurrences: occByLower.get(r.raw_lower) ?? [],
  }));

  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(Number(last.total_rows), last.raw_lower) : null;

  return { items: out, hasMore, nextCursor };
}
```

- [ ] **Step 4: Verify pass**

Run: `cd server && bun test test/repo-dim-scan.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-dim-scan.ts server/test/repo-dim-scan.test.ts
git commit -m "feat(repo): getDimScanScalars + getDimScanValuesPage"
```

---

## Task 4: Wire materialization into the scan path + delete legacy `scanValues`

**Files:**
- Modify: `server/src/repo-scan.ts` — add `materializeOneDim`, call from `scanSources` and `deriveCanonical`.
- Modify: `server/src/repo-canonical.ts` — delete `scanValues` (lines ~441–537); change `getDimension` to return `counts` instead of `values`.
- Modify: `server/src/repo-drafts.ts` — auto-stage reads from `dim_scan_value` instead of warehouse.

- [ ] **Step 1: Add `materializeOneDim` helper**

In `server/src/repo-scan.ts` near `scanOneSource` (~line 178):

```ts
import { materializeDimScanValues } from "./repo-dim-scan.ts";

/** Run the warehouse provenance query for one dim and write the result into
 *  dim_scan_value + dim_scan_occurrence. Idempotent — replaces prior rows. */
async function materializeOneDim(
  dimId: string,
  adapter: Awaited<ReturnType<typeof getAdapter>>,
  tenantId: string,
): Promise<void> {
  const t0 = performance.now();
  const sources = await liveSources(dimId, tenantId);
  if (!sources.length) {
    await materializeDimScanValues(dimId, tenantId, { occurrences: [], scannedAt: new Date() });
    log({ level: "info", msg: "materialize-dim", dimId, distinct: 0, ms: Math.round(performance.now() - t0) });
    return;
  }
  const refs = sources.map((s) => ({ table: refOf(s), column: s.column }));
  const occRows = await adapter
    .distinctValuesWithProvenance(refs)
    .catch(() => [] as { value: string; sourceIndex: number; count: number }[]);
  const occurrences = occRows
    .map((r) => {
      const src = sources[r.sourceIndex];
      if (!src) return null;
      return { raw: r.value, table: src.table, column: src.column, rows: r.count };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  await materializeDimScanValues(dimId, tenantId, { occurrences, scannedAt: new Date() });
  log({
    level: "info",
    msg: "materialize-dim",
    dimId,
    distinct: new Set(occurrences.map((o) => o.raw.toLowerCase())).size,
    occurrences: occurrences.length,
    ms: Math.round(performance.now() - t0),
  });
}
```

- [ ] **Step 2: Call from `scanSources`**

In `scanSources` (~line 161), after the per-source loop:

```ts
const dimIds = [...new Set(regs.map((r) => r.dimId))];
for (const dimId of dimIds) {
  await materializeOneDim(dimId, adapter, tenantId).catch((e) => {
    log({ level: "error", msg: "materialize-dim", dimId, err: e instanceof Error ? e.message : String(e) });
  });
}
```

- [ ] **Step 3: Call from `deriveCanonical`**

Read `deriveCanonical` (~line 641). Find the point after the source is registered and auto-stage has run, before the function returns. Insert:

```ts
await materializeOneDim(dimId, adapter, tenantId).catch((e) => {
  log({ level: "error", msg: "materialize-dim-on-derive", dimId, err: e instanceof Error ? e.message : String(e) });
});
```

- [ ] **Step 4: Delete `scanValues` and rewrite `getDimension`**

In `server/src/repo-canonical.ts`:

- Delete the `scanValues` function entirely (~lines 441–537).
- Find every call to `scanValues(...)` inside `getDimension` and delete it.
- Add `import { getDimScanScalars } from "./repo-dim-scan.ts";` at the top.
- In `getDimension`, replace the section that built `values: MappingValue[]` with:

```ts
const scalars = opts?.scalars ?? (await getDimScanScalars(tenantId));
const my = scalars.find((s) => s.dimId === id);
// ...inside the returned object:
counts: {
  newCount:      my?.newCount      ?? 0,
  mappedCount:   my?.mappedCount   ?? 0,
  totalDistinct: my?.totalDistinct ?? 0,
  scannedAt:     my?.scannedAt ? my.scannedAt.toISOString() : null,
},
// REMOVE: values: [...]
```

Change the signature to accept `opts?: { scalars?: DimScanScalars[] }` so the list endpoint can fetch scalars once.

- [ ] **Step 5: Migrate auto-stage in `repo-drafts.ts`**

Find the `distinctValuesWithProvenance` call at ~line 472 of `server/src/repo-drafts.ts`. Replace with:

```ts
const occRows = await pgAll<{ raw: string; table_name: string; column_name: string; rows: number }>(
  `SELECT v.raw, o.table_name, o.column_name, o.rows
     FROM zugzug_app.dim_scan_value v
     JOIN zugzug_app.dim_scan_occurrence o
       ON o.tenant_id = v.tenant_id AND o.dim_id = v.dim_id AND o.raw_lower = v.raw_lower
     WHERE v.tenant_id = $1 AND v.dim_id = $2`,
  [tenantId, dimId],
);
```

Adapt the downstream code that consumed `{ value, count, sourceIndex }` — the new shape exposes `raw`/`rows`/`table_name`/`column_name`. Reshape inline.

- [ ] **Step 6: Type-check + tests**

Run: `cd server && npx tsc --noEmit && bun test`
Expected: clean compile; existing repo tests still pass. (If any test was asserting on `dim.values`, fix it in this task — there should be no compat shim.)

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-scan.ts server/src/repo-canonical.ts server/src/repo-drafts.ts
git commit -m "feat(scan): materialize values during scan/derive; delete scanValues"
```

---

## Task 5: API route + tenant repo

**Files:**
- Modify: `server/src/tenant-repo.ts` — expose `getDimScanScalars` and `getDimScanValuesPage`.
- Modify: `server/src/server.ts` — new `GET /api/dimensions/:id/scan-values`; pre-fetch scalars in list route.

- [ ] **Step 1: Expose on tenant repo**

In `server/src/tenant-repo.ts`, add alongside `searchCatalog`:

```ts
getDimScanScalars(): Promise<import("./repo-dim-scan.ts").DimScanScalars[]> {
  return this.withClearCtx(() =>
    import("./repo-dim-scan.ts").then((m) => m.getDimScanScalars(this.tenantId)),
  );
}

getDimScanValuesPage(
  dimId: string,
  opts: import("./repo-dim-scan.ts").PageOpts,
): Promise<import("./repo-dim-scan.ts").ValuesPage> {
  return this.withClearCtx(() =>
    import("./repo-dim-scan.ts").then((m) => m.getDimScanValuesPage(this.tenantId, dimId, opts)),
  );
}
```

(Match the existing import-then-call pattern.)

- [ ] **Step 2: Pre-fetch scalars in the dim list route**

Find `/api/dimensions` (the list/full route) in `server/src/server.ts`. Before the per-dim fan-out:

```ts
const scalars = await reqRepo.getDimScanScalars();
const dims = await Promise.all(
  dimIds.map((id) => reqRepo.getDimension(id, { scalars })),
);
```

(Adjust to match the existing route's exact shape.)

- [ ] **Step 3: Add the paged values route**

```ts
.get("/api/dimensions/:id/scan-values", async (c) => {
  const reqRepo = c.get("repo");
  const id = c.req.param("id");
  const filter = c.req.query("filter") ?? "new";
  const q = c.req.query("q") ?? null;
  const after = c.req.query("after") ?? null;
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
  if (filter !== "new" && filter !== "mapped" && filter !== "all") {
    return jsonError(400, "invalid_filter");
  }
  const page = await reqRepo.getDimScanValuesPage(id, { filter, q, after, limit });
  return json(page);
})
```

- [ ] **Step 4: Smoke test**

Restart server. Hit the route:

```bash
curl -s -H "Cookie: <auth>" \
  "http://localhost:3000/api/dimensions/<dim-id>/scan-values?filter=new&limit=5" | jq
```
Expected: `{items: [...], hasMore: bool, nextCursor: string|null}`.

Also verify boot:

```bash
curl -s -H "Cookie: <auth>" "http://localhost:3000/api/dimensions" | jq '.[0] | {counts, has_values: has("values")}'
```
Expected: `counts` populated, `has_values: false`.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/tenant-repo.ts
git commit -m "feat(api): GET /api/dimensions/:id/scan-values + boot scalars"
```

---

## Task 6: Client type cutover — `MappingDimension.values` → `MappingDimension.counts`

**Files:**
- Modify: `app/src/data.ts` — drop `values`, add required `counts`, rewrite fixtures.
- Modify: `app/src/store.ts` — strip `values` from boot fetch.

- [ ] **Step 1: Update `MappingDimension`**

In `app/src/data.ts`:

```ts
export interface MappingDimension {
  id: string;
  dimension: string;
  dimTable: string;
  mapTable: string;
  keyCol: string;
  keyKind?: "slug" | "external_id";
  description?: string | null;
  color?: PaletteName | null;
  rows: number;
  canonical: CanonicalValue[];
  // REMOVED: values: MappingValue[];
  counts: {
    newCount: number;
    mappedCount: number;
    totalDistinct: number;
    scannedAt: string | null;
  };
  fields?: FieldDef[];
  orderingMode?: "derived" | "manual";
  nextPosition?: string | null;
}
```

- [ ] **Step 2: Delete `MappingValue`, `SourceOccurrence`, `valueRows` if unused**

After Task 8 lands, grep for the symbols. If they have no remaining consumers, delete them. Keep them here only if a remaining file (e.g. AI-hint payloads) still uses the shape.

- [ ] **Step 3: Rewrite fixtures**

In `mappingSeeds` (~line 87), replace each fixture's `values: [...]` with `counts: { newCount: N, mappedCount: M, totalDistinct: N+M, scannedAt: null }`. Pick representative counts so Storybook/visual fixtures still look populated.

- [ ] **Step 4: Strip values from store**

In `app/src/store.ts`, find every place that reads or assigns `dim.values` from the boot response. Delete those branches — the server no longer sends them.

- [ ] **Step 5: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: ERRORS in every file that still reads `d.values`. That's the work for Task 7. Don't commit yet.

- [ ] **Step 6: Commit only after Task 7 is done** — they are entangled in `tsc --noEmit`.

---

## Task 7: Migrate scalar consumers to `d.counts.*`

**Files (modify):**
- `app/src/components/TablePicker.tsx:17-19`
- `app/src/components/AppShell.tsx:367, 471`
- `app/src/components/TablePane.tsx:119`
- `app/src/routes/Dashboard.tsx:165, 186, 191, 196, 198, 201, 444`
- `app/src/routes/dashboard-helpers.ts:14, 16, 34, 78, 81`

- [ ] **Step 1: Replace each site**

For every site, swap `d.values.filter(...).length` (or `d.values.length`) for `d.counts.newCount` / `.mappedCount` / `.totalDistinct`.

Example (`TablePicker.tsx:17-19`):

```ts
// BEFORE
const total  = d.values.length;
const mapped = d.values.filter((v) => v.current).length;
const fresh  = d.values.filter((v) => v.status === "new").length;

// AFTER
const { newCount: fresh, mappedCount: mapped, totalDistinct: total } = d.counts;
```

Example (`dashboard-helpers.ts:14`):

```ts
// BEFORE
if (dim.values.length === 0) return 100;
return Math.round(
  (dim.values.filter((v) => v.status === "mapped").length / dim.values.length) * 100,
);

// AFTER
const { totalDistinct, mappedCount } = dim.counts;
if (totalDistinct === 0) return 100;
return Math.round((mappedCount / totalDistinct) * 100);
```

For sites that summed `valueRows(v)` (e.g. `Dashboard.tsx:186, 191`): the `total_rows` per value is no longer available at the dim level. Replace with the closest scalar — for "rows recovered" use the `source_stat.rows` aggregate already exposed elsewhere, or expose a new scalar on `counts` (`unmappedRowsTotal`, `mappedRowsTotal`) computed by `getDimScanScalars` as `SUM(total_rows) FILTER (WHERE mapped/new)`. If you take the latter route, add those fields to `DimScanScalars`, `MappingDimension.counts`, and the SQL in Task 3 — keeping the invariant that fixtures must provide them too.

(Pick one. The new-scalar route is cleaner; only adds two SUMs to a query that already runs once per boot.)

- [ ] **Step 2: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: clean except for Triage and MatchModeBody (those are Tasks 8–9).

- [ ] **Step 3: Commit (along with Task 6)**

```bash
git add app/src/data.ts app/src/store.ts app/src/components/TablePicker.tsx app/src/components/AppShell.tsx app/src/components/TablePane.tsx app/src/routes/Dashboard.tsx app/src/routes/dashboard-helpers.ts
git commit -m "refactor(app): MappingDimension.values -> .counts; migrate scalar consumers"
```

---

## Task 8: `useDimValuesPage` hook

**Files:**
- Create: `app/src/lib/use-dim-values-page.ts`
- Create: `app/test/use-dim-values-page.test.tsx`

- [ ] **Step 1: Implement**

```ts
import { useEffect, useRef, useState, useCallback } from "react";
import { apiFetch } from "../api";

export interface ScanValueRow {
  raw: string;
  totalRows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}

export interface UseDimValuesPageOpts {
  dimId: string | null;
  filter: "new" | "mapped" | "all";
  q?: string;
  enabled?: boolean;
}

export interface UseDimValuesPage {
  items: ScanValueRow[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  refetch: () => void;
}

/** Lazy, cursor-paginated fetch over /api/dimensions/:id/scan-values. Resets
 *  when (dimId, filter, q) changes. No caching across opts changes. */
export function useDimValuesPage(opts: UseDimValuesPageOpts): UseDimValuesPage {
  const { dimId, filter, q, enabled = true } = opts;
  const [items, setItems] = useState<ScanValueRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const fetchPage = useCallback(
    async (after: string | null, reset: boolean) => {
      if (!dimId || !enabled) return;
      const ticket = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ filter, limit: "100" });
        if (q) params.set("q", q);
        if (after) params.set("after", after);
        const r = await apiFetch(`/api/dimensions/${encodeURIComponent(dimId)}/scan-values?${params}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as {
          items: ScanValueRow[];
          hasMore: boolean;
          nextCursor: string | null;
        };
        if (ticket !== seq.current) return;
        setItems((prev) => (reset ? body.items : [...prev, ...body.items]));
        setCursor(body.nextCursor);
        setHasMore(body.hasMore);
      } catch (e) {
        if (ticket !== seq.current) return;
        setError(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (ticket === seq.current) setLoading(false);
      }
    },
    [dimId, filter, q, enabled],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(false);
    void fetchPage(null, true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading) return;
    void fetchPage(cursor, false);
  }, [hasMore, loading, cursor, fetchPage]);

  const refetch = useCallback(() => {
    setItems([]);
    setCursor(null);
    setHasMore(false);
    void fetchPage(null, true);
  }, [fetchPage]);

  return { items, hasMore, loading, error, loadMore, refetch };
}
```

- [ ] **Step 2: Smoke test**

```tsx
// app/test/use-dim-values-page.test.tsx
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useDimValuesPage } from "../src/lib/use-dim-values-page";

const fetchMock = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        items: [{ raw: "Red", totalRows: 10, isMapped: false, mappedLabel: null, occurrences: [] }],
        hasMore: false,
        nextCursor: null,
      }),
    ),
  ),
);

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
});

describe("useDimValuesPage", () => {
  test("fetches first page on mount", async () => {
    const { result } = renderHook(() => useDimValuesPage({ dimId: "d1", filter: "new" }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].raw).toBe("Red");
  });
});
```

Run: `cd app && bun test test/use-dim-values-page.test.tsx`
Expected: 1 pass.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/use-dim-values-page.ts app/test/use-dim-values-page.test.tsx
git commit -m "feat(app): useDimValuesPage hook"
```

---

## Task 9: Rewrite Triage

**Files:**
- Modify: `app/src/routes/Triage.tsx`

- [ ] **Step 1: Replace `crossDimRows` build with ranked dim list + per-dim lazy fetch**

Delete the `crossDimRows` / `visibleCross` memos (~lines 154–199). Replace with:

```ts
const rankedDims = useMemo(
  () =>
    [...dims]
      .map((d) => ({
        d,
        score: d.counts.newCount * Math.log10(Math.max(10, d.rows)),
      }))
      .filter((x) => (filter === "new" ? x.score > 0 : true))
      .sort((a, b) => b.score - a.score),
  [dims, filter],
);

const [activeDimIdx, setActiveDimIdx] = useState(0);
const [searchText, setSearchText] = useState("");
const activeDim = rankedDims[activeDimIdx]?.d ?? null;
const valuesPage = useDimValuesPage({
  dimId: activeDim?.id ?? null,
  filter,
  q: searchText || undefined,
});
```

- [ ] **Step 2: Render dim sections**

Replace the single DataGrid (~lines 519–582) with a dim-grouped layout:

```tsx
<div className="flex min-h-0 flex-1 flex-col overflow-auto">
  {rankedDims.map((rd, i) => (
    <DimSection
      key={rd.d.id}
      dim={rd.d}
      isActive={i === activeDimIdx}
      onActivate={() => setActiveDimIdx(i)}
      page={i === activeDimIdx ? valuesPage : null}
      onAccept={(raw) => acceptCross(rd.d.id, raw)}
      onSkip={(raw) => skipCross(rd.d.id, raw)}
      onPick={(raw, label) => pickCross(rd.d.id, raw, label)}
    />
  ))}
</div>
```

`DimSection` renders the dim header + count chip + (when active) the DataGrid bound to `page.items` with an `IntersectionObserver` sentinel triggering `page.loadMore()`.

- [ ] **Step 3: Add search input + rescan banner to toolbar**

Toolbar (~line 458):

```tsx
<input
  type="search"
  placeholder="Search raw values…"
  value={searchText}
  onChange={(e) => setSearchText(e.target.value)}
  className="min-h-[32px] rounded-sm border border-line bg-bg px-2 font-mono text-[11px]"
/>
```

URL-roundtrip via `setSearchParams`, same pattern as `filter`.

Above the active section grid:

```tsx
{activeDim?.counts.scannedAt && (
  <div className="flex items-center justify-between border-b border-line bg-surface-2 px-4 py-2 text-[11px] text-ink-3">
    <span>
      As of {new Date(activeDim.counts.scannedAt).toLocaleString()} ·{" "}
      {activeDim.counts.newCount} unmapped / {activeDim.counts.totalDistinct} distinct
    </span>
    <button onClick={() => triggerRescan(activeDim.id).then(valuesPage.refetch)}>
      Rescan
    </button>
  </div>
)}
```

`triggerRescan` calls the existing rescan endpoint.

- [ ] **Step 4: Focus refetch**

```ts
useEffect(() => {
  const onFocus = () => valuesPage.refetch();
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}, [valuesPage]);
```

- [ ] **Step 5: Smoke test**

`cd app && bun run dev`. Open Triage. Verify:
- Dims rank by `newCount × log10(rows)`.
- Search narrows live.
- Switching dim sections fetches paged values.
- Rescan refreshes timestamp + values.

- [ ] **Step 6: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/routes/Triage.tsx
git commit -m "feat(triage): per-dim lazy fetch with search + rescan"
```

---

## Task 10: Rewrite MatchModeBody

**Files:**
- Modify: `app/src/components/modes/MatchModeBody.tsx`

- [ ] **Step 1: Replace `dim.values` iteration with `useDimValuesPage`**

At the component top, replace lines ~101–127:

```ts
const [searchText, setSearchText] = useState("");
const valuesPage = useDimValuesPage({ dimId: dim.id, filter, q: searchText || undefined });
const visible = valuesPage.items;
const crossCounts = {
  all: dim.counts.totalDistinct,
  new: dim.counts.newCount,
  mapped: dim.counts.mappedCount,
  skipped: 0,
};
const byVal = (v: string) => valuesPage.items.find((r) => r.raw === v) ?? null;
```

- [ ] **Step 2: Update display sites that read `MappingValue.confidence` / `.suggestion`**

`ScanValueRow` does not carry these — AI hint data comes from `useAiHint(dim.id, raw)` on-demand for the focused row. Anywhere the old code rendered `v.confidence` or `v.suggestion` inline from `dim.values`, replace with a hook scoped to the cursor row.

- [ ] **Step 3: Wire infinite scroll**

Bind the existing DataGrid's onScroll/end-of-viewport to `valuesPage.loadMore()`. If DataGrid doesn't expose that hook, add an `IntersectionObserver` sentinel below the grid that calls `loadMore` when visible.

- [ ] **Step 4: Smoke test**

Open Match mode for a dim with >500 distinct values. Confirm all values are reachable by scrolling; search finds raws past the old 500-cap boundary.

- [ ] **Step 5: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/modes/MatchModeBody.tsx
git commit -m "feat(match): per-dim lazy fetch in MatchModeBody"
```

---

## Task 11: Final sweep — confirm no compat cruft

- [ ] **Step 1: Grep for leftover symbols**

Run from repo root:

```bash
rg "MappingValue|\.values\b" app/src --type ts --type tsx \
  | rg -v "Object\.values|map\.values|formValues|setValues|s\.values|Source\.values"
```
Expected: no matches mentioning `MappingValue` or `d.values` / `dim.values` / `dimension.values`.

```bash
rg "scanValues|slice\(0, 500\)" server/src
```
Expected: no matches.

- [ ] **Step 2: Run the full test suite**

Run: `cd server && bun test && cd ../app && bun test`
Expected: all green.

- [ ] **Step 3: Manual e2e**

- Wire a new source → confirm the scan log shows `materialize-dim` with a non-zero `distinct`.
- Open Triage → confirm scalars rank dims correctly.
- Open Match mode for a dim with >500 distinct values → confirm scroll/search reach everything.
- Hit auto-stage → confirm exact-match drafts still land for the right set of raws.

- [ ] **Step 4: Commit cleanup if any**

```bash
git add -A
git commit --allow-empty -m "chore: confirm no legacy scanValues / dim.values remains"
```

---

## Self-review

- **Spec coverage:** scan-time materialization (Task 4) ✓; cap removed (Task 4) ✓; `dim.values` gone (Task 6) ✓; counts required (Task 6) ✓; Triage rewrite (Task 9) ✓; Match mode rewrite (Task 10) ✓; refetch-on-focus (Task 9) ✓; rescan banner (Task 9) ✓; auto-stage uses materialized data (Task 4 step 5) ✓; final grep proves no cruft (Task 11) ✓.
- **Placeholders:** one decision point in Task 7 step 1 ("pick the new-scalar route or the existing source_stat aggregate") — flagged as a real choice with a recommendation rather than left as TBD. No other placeholders.
- **Type consistency:** `ScanValueRow` defined identically in `repo-dim-scan.ts` and `use-dim-values-page.ts`. `DimScanScalars` ↔ `MappingDimension.counts` mapping in Tasks 4 and 6 use matching field names (`newCount`/`mappedCount`/`totalDistinct`/`scannedAt`).
- **Single-PR coherence:** Tasks 6+7 share a commit (the type change cascades); all other tasks commit independently within the PR.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-17-paginated-scan-values-postgres.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
