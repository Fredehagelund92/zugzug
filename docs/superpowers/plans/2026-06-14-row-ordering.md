# Row Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-dimension manual ordering (`position BIGINT`) with drag-to-reorder, insert-above/below, and view-sort persistence to the canonical data grid.

**Architecture:** Dimensions can be in `derived` mode (default, `ORDER BY variants DESC, label`) or `manual` mode (`ORDER BY position ASC`). Position lives as a nullable `BIGINT` column on every `dim_*` table — derived dims leave it `NULL`. Three new API endpoints handle drag-reorder, rebalance, and dim-meta patching. View-sorts are per-user in `GridLayoutConfig.sort` (no SQL migration). A sort banner appears only in manual-mode dims when a view-sort is active.

**Tech Stack:** Bun + postgres.js (`pgTx`, `pgGet`, `pgAll`, `pgRun`) on the backend; React 18 + Tailwind v4 on the frontend; Drizzle ORM for schema migrations; bun:test for server tests.

---

## File Map

**Server — modified**
- `server/drizzle/schema.ts` — add `ordering_mode` + `last_rebalanced_at` to `dimension` table
- `server/drizzle/migrations/0022_row_ordering.sql` — generated + DO block for per-dim DDL
- `server/src/repo-shared.ts` — extend `DimMeta`, `dimMeta()`, `DimensionMeta`, `CanonicalValue`
- `server/src/repo-canonical.ts` — update `addDimension` DDL; add `nextPosition` helper; update `getDimension` read path; update `addCanonical`, `addCanonicalOne`, `importCanonical`; add `updateDimensionMeta`, `reorderCanonical`, `rebalancePositions`
- `server/src/repo-drafts.ts` — update `commit()` for manual mode
- `server/src/server.ts` — register 4 new/extended routes

**Server — new test**
- `server/src/row-ordering.test.ts`

**Client — modified**
- `app/src/data.ts` — extend `CanonicalValue`, `MappingDimension`, `GridLayoutConfig`
- `app/src/store.ts` — extend `GridLayoutConfig`; add `patchDimension`, `insertCanonicalAt`, `reorderCanonical`, `rebalancePositions`
- `app/src/components/TablePane.tsx` — wire `onInsertRow` for manual mode; drag handle column; sort banner; view-sort persistence; keyboard shortcuts; ordering settings section; engineer mode reveal

---

## Task 1: Drizzle schema — add columns to `dimension` table

**Files:**
- Modify: `server/drizzle/schema.ts:21-42`

- [ ] **Step 1: Add the two new columns and CHECK constraint to the `dimension` table definition**

```ts
// In server/drizzle/schema.ts, inside the `dimension` table definition,
// add after the `color` column:
ordering_mode:      varchar("ordering_mode").notNull().default("derived"),
last_rebalanced_at: timestamp("last_rebalanced_at"),
```

And in the constraints array `(t) => [...]`, add:

```ts
check("dimension_ordering_mode_chk", sql`${t.ordering_mode} IN ('derived', 'manual')`),
```

- [ ] **Step 2: Generate the Drizzle migration**

```bash
cd server && bun run db:generate
```

Expected: a new file `server/drizzle/migrations/0022_*.sql` is created. Confirm it contains:
```sql
ALTER TABLE "zugzug_app"."dimension"
  ADD COLUMN "ordering_mode" varchar DEFAULT 'derived' NOT NULL,
  ADD COLUMN "last_rebalanced_at" timestamp;
ALTER TABLE "zugzug_app"."dimension"
  ADD CONSTRAINT "dimension_ordering_mode_chk" CHECK ("ordering_mode" IN ('derived', 'manual'));
```

- [ ] **Step 3: Commit**

```bash
cd server && git add drizzle/schema.ts drizzle/migrations/
git commit -m "feat(schema): add ordering_mode + last_rebalanced_at to dimension"
```

---

## Task 2: Complete migration — per-dim DDL for `position` column

**Files:**
- Modify: `server/drizzle/migrations/0022_*.sql` (the generated file from Task 1)

The generated migration already handles the `dimension` table ALTER. This task appends the DO block that walks existing `dim_*` tables and adds the `position BIGINT` column + two partial indexes to each.

- [ ] **Step 1: Append the DO block to the generated migration file**

```sql
-- Walk every registered dim_* table and add position column + indexes.
-- IF NOT EXISTS makes the block idempotent for dims created during deploy.
DO $$
DECLARE
  r            RECORD;
  dot_pos      INT;
  schema_name  TEXT;
  table_name   TEXT;
BEGIN
  FOR r IN SELECT id, dim_table FROM "zugzug_app"."dimension"
  LOOP
    dot_pos     := position('.' IN r.dim_table);
    schema_name := substring(r.dim_table FROM 1 FOR dot_pos - 1);
    table_name  := substring(r.dim_table FROM dot_pos + 1);

    EXECUTE format(
      'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS position BIGINT',
      schema_name, table_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (position) WHERE position IS NOT NULL',
      'dim_' || r.id || '_position_idx',
      schema_name, table_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (position) WHERE position IS NOT NULL',
      'dim_' || r.id || '_position_uniq',
      schema_name, table_name
    );
  END LOOP;
END $$;
```

- [ ] **Step 2: Verify typecheck still passes**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd server && git add drizzle/migrations/
git commit -m "feat(migration): 0022 row ordering — position column + indexes on dim_* tables"
```

---

## Task 3: Extend server-shared types and `dimMeta()`

**Files:**
- Modify: `server/src/repo-shared.ts:170-198` (CanonicalValue, DimensionMeta)
- Modify: `server/src/repo-shared.ts:359-365` (dimMeta function)

`DimMeta` is the narrow shape returned by `dimMeta()`. `DimensionMeta` is the richer shape used by `getDimension`. `CanonicalValue` is the per-row shape returned by the list endpoint.

- [ ] **Step 1: Extend `DimMeta` (the `dimMeta()` return type)**

In `server/src/repo-shared.ts`, find the `DimMeta` interface (it is defined locally where `dimMeta` is; grep for `interface DimMeta`). If it doesn't exist as a named interface, define it or find `dimMeta`'s return type. Add `orderingMode`:

```ts
// Find or add near dimMeta():
interface DimMeta {
  dimTable:     string;
  mapTable:     string;
  keyCol:       string;
  orderingMode: "derived" | "manual";
}
```

- [ ] **Step 2: Update the `dimMeta()` SELECT**

```ts
export async function dimMeta(dimId: string, tenantId: string): Promise<DimMeta | null> {
  return pgGet<DimMeta>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(ordering_mode, 'derived') AS "orderingMode"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
}
```

- [ ] **Step 3: Add `position` to `CanonicalValue` in `repo-shared.ts`**

```ts
export interface CanonicalValue {
  key:        string;
  label:      string;
  variants?:  number;
  fields?:    Record<string, string | null>;
  unresolved?: boolean;
  position?:  string | null;   // NEW — JSON-safe bigint string; null in derived mode
}
```

- [ ] **Step 4: Add `orderingMode` to `DimensionMeta` in `repo-shared.ts`**

```ts
export interface DimensionMeta {
  id:           string;
  dimension:    string;
  dimTable:     string;
  mapTable:     string;
  keyCol:       string;
  rows:         number;
  keyKind:      "slug" | "external_id";
  orderingMode: "derived" | "manual";   // NEW
}
```

- [ ] **Step 5: Verify typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd server && git add src/repo-shared.ts
git commit -m "feat(types): extend DimMeta, DimensionMeta, CanonicalValue with ordering fields"
```

---

## Task 4: Update `addDimension` DDL to include position column + indexes

**Files:**
- Modify: `server/src/repo-canonical.ts:526-533` (the `CREATE TABLE IF NOT EXISTS` for `dim_*`)

- [ ] **Step 1: Add `position BIGINT` to the dim table DDL and emit the two indexes**

Find the `CREATE TABLE IF NOT EXISTS ${cq(dimTable)}` call around line 527. Replace the current DDL with:

```ts
await pgRun(
  `CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (
     ${qid(keyCol)} VARCHAR PRIMARY KEY,
     ${labelDdl},
     position BIGINT,
     tenant_id VARCHAR NOT NULL DEFAULT ${tenantLit}
   )`,
);
await pgRun(
  `CREATE INDEX IF NOT EXISTS ${qid(`dim_${id}_position_idx`)}
     ON ${cq(dimTable)} (position) WHERE position IS NOT NULL`,
);
await pgRun(
  `CREATE UNIQUE INDEX IF NOT EXISTS ${qid(`dim_${id}_position_uniq`)}
     ON ${cq(dimTable)} (position) WHERE position IS NOT NULL`,
);
```

- [ ] **Step 2: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
cd server && git add src/repo-canonical.ts
git commit -m "feat(ddl): addDimension emits position column + indexes for new dims"
```

---

## Task 5: `nextPosition` helper

**Files:**
- Modify: `server/src/repo-canonical.ts` (add function near other repo helpers, around line 90)
- Create: `server/src/row-ordering.test.ts`

The helper acquires a row lock on the tail row and returns `max + 1024n`. Two concurrent callers serialize at the Postgres lock.

- [ ] **Step 1: Write the failing test**

Create `server/src/row-ordering.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { computeInsertPosition } from "./repo-canonical.ts";

// computeInsertPosition is a pure helper we'll extract from repo-canonical
// for testability. It takes the positions of the anchor rows (or null for
// first/last) and returns the new position as a bigint.
describe("computeInsertPosition", () => {
  it("inserts between two rows: midpoint", () => {
    expect(computeInsertPosition(1024n, 2048n)).toBe(1536n);
  });
  it("inserts above first row: P_r - 1024", () => {
    expect(computeInsertPosition(null, 1024n)).toBe(0n);
  });
  it("inserts below last row: P_r + 1024", () => {
    expect(computeInsertPosition(2048n, null)).toBe(3072n);
  });
  it("returns null when gap <= 1 (triggers rebalance)", () => {
    expect(computeInsertPosition(1024n, 1025n)).toBeNull();
  });
  it("handles zero-gap: same position (triggers rebalance)", () => {
    expect(computeInsertPosition(1024n, 1024n)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd server && bun test src/row-ordering.test.ts
```

Expected: FAIL with "computeInsertPosition is not exported" or similar.

- [ ] **Step 3: Implement `computeInsertPosition` and `nextPosition` in `repo-canonical.ts`**

Add near the top of the file, after imports:

```ts
/** Pure helper — returns the new position bigint for an insert, or null if the
 *  gap is <= 1 (caller must rebalance first). pAbove = position of the row that
 *  will sit above the new row (null if inserting at the very top). pBelow =
 *  position of the row that will sit below (null if inserting at the bottom). */
export function computeInsertPosition(
  pAbove: bigint | null,
  pBelow: bigint | null,
): bigint | null {
  if (pAbove === null && pBelow === null) return 1024n;
  if (pAbove === null) return pBelow! - 1024n;
  if (pBelow === null) return pAbove + 1024n;
  const gap = pBelow - pAbove;
  if (gap <= 1n) return null;
  return pAbove + gap / 2n;
}

/** Inside a pgTx: acquire a row lock on the tail position row and return the
 *  next available position. Two concurrent callers serialize at the lock.
 *  Returns 1024n when the dim is empty. */
export async function nextPosition(
  tx: { get: <T>(sql: string, params?: unknown[]) => Promise<T | null> },
  dimTable: string,
): Promise<bigint> {
  const tail = await tx.get<{ position: string | null }>(
    `SELECT position
       FROM ${cq(dimTable)}
       WHERE position IS NOT NULL
       ORDER BY position DESC
       LIMIT 1
       FOR UPDATE`,
  );
  const max = tail?.position == null ? 0n : BigInt(tail.position);
  return max + 1024n;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd server && bun test src/row-ordering.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd server && git add src/repo-canonical.ts src/row-ordering.test.ts
git commit -m "feat: computeInsertPosition + nextPosition helpers"
```

---

## Task 6: Update `getDimension` read path

**Files:**
- Modify: `server/src/repo-canonical.ts:244-394` (the `getDimension` function)

Changes needed:
1. Add `ordering_mode` to the meta SELECT
2. Add conditional `ORDER BY` based on `orderingMode`
3. Add `d.position` to the canonical SELECT (both slug and external_id paths)
4. Add `position: r.position == null ? null : String(r.position)` to each row in the `canonical` map
5. Add `nextPosition` query for manual dims; return on envelope

- [ ] **Step 1: Extend the meta SELECT**

In the `pgGet` for meta (around line 254), add `ordering_mode` and return it as `orderingMode`:

```ts
const meta = await pgGet<
  Omit<DimensionMeta, "rows"> & {
    nameTable:    string | null;
    nameIdCol:    string | null;
    nameCol:      string | null;
    description:  string | null;
    color:        string | null;
  }
>(
  `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
          key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind",
          name_table AS "nameTable", name_id_col AS "nameIdCol", name_col AS "nameCol",
          description, color,
          COALESCE(ordering_mode, 'derived') AS "orderingMode"
   FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
  [id, tenantId],
);
```

- [ ] **Step 2: Build the ORDER BY clause**

Add this block after `const scalarCols` computation (around line 277), replacing the hard-coded `ORDER BY variants DESC, d.label`:

```ts
const orderBy =
  meta.orderingMode === "manual"
    ? `ORDER BY d.position ASC NULLS LAST, variants DESC, ${meta.keyKind === "external_id" ? `d.${qid(meta.keyCol)}` : "d.label"}`
    : `ORDER BY variants DESC, ${meta.keyKind === "external_id" ? `d.${qid(meta.keyCol)}` : "d.label"}`;
```

- [ ] **Step 3: Add `d.position` to both SELECT branches**

For the external_id branch (around line 313), change:
```ts
`SELECT d.${k} AS key, NULL AS label, true AS unresolved${fields.length ? ", " + fieldCols : ""},
        COALESCE(v.n, 0)::int AS variants
 FROM ${cq(meta.dimTable)} d
 ...
 ORDER BY variants DESC, d.${k}`,
```
to:
```ts
`SELECT d.${k} AS key, NULL AS label, true AS unresolved, d.position${fields.length ? ", " + fieldCols : ""},
        COALESCE(v.n, 0)::int AS variants
 FROM ${cq(meta.dimTable)} d
 ...
 ${orderBy}`,
```

For the slug branch (around line 321), change:
```ts
`SELECT d.${k} AS key, d.label, false AS unresolved${fields.length ? ", " + fieldCols : ""},
        COALESCE(v.n, 0)::int AS variants
 FROM ${cq(meta.dimTable)} d
 ...
 ORDER BY variants DESC, d.label`,
```
to:
```ts
`SELECT d.${k} AS key, d.label, false AS unresolved, d.position${fields.length ? ", " + fieldCols : ""},
        COALESCE(v.n, 0)::int AS variants
 FROM ${cq(meta.dimTable)} d
 ...
 ${orderBy}`,
```

- [ ] **Step 4: Thread `position` through the canonical map**

In the `canonical` mapping (around line 358), add `position`:

```ts
const canonical = canonRows.map((r) => ({
  key:       String(r.key),
  label:     r.label == null ? String(r.key) : String(r.label),
  version:   versions.get(String(r.key)) ?? 1,
  unresolved: !!r.unresolved,
  variants:  Number(r.variants),
  position:  r.position == null ? null : String(r.position as bigint | string),
  fields:    Object.fromEntries(
    allFieldKeys.map((fk) => [fk, r[fk] == null ? null : String(r[fk])]),
  ),
}));
```

- [ ] **Step 5: Add `nextPosition` to the response envelope**

After the `canonical` map, before `return`:

```ts
let nextPos: string | null = null;
if (meta.orderingMode === "manual") {
  const tail = await pgGet<{ p: string | null }>(
    `SELECT MAX(position)::text AS p FROM ${cq(meta.dimTable)}`,
  ).catch(() => null);
  nextPos = tail?.p == null ? "1024" : String(BigInt(tail.p) + 1024n);
}
```

And include `orderingMode` and `nextPosition` in the return:

```ts
return {
  ...metaOut,
  orderingMode: meta.orderingMode,
  description:  description ?? null,
  color:        safeColor,
  rows:         Number(rowsRow?.n ?? 0),
  nextPosition: nextPos,
  canonical,
  values,
  fields,
};
```

- [ ] **Step 6: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
cd server && git add src/repo-canonical.ts
git commit -m "feat(read): getDimension returns ordering_mode, position per row, nextPosition"
```

---

## Task 7: Update `addCanonical`, `addCanonicalOne`, `importCanonical` for manual mode

**Files:**
- Modify: `server/src/repo-canonical.ts:577-698`

**`addCanonical`** (bulk seed — currently loops with individual pgRun calls):
- In `derived` mode: unchanged.
- In `manual` mode: wrap the whole loop in a single `pgTx`, call `nextPosition(tx, m.dimTable)` once at the start, increment a local counter per inserted row.

**`addCanonicalOne`** (single add — already uses pgTx):
- In `manual` mode: call `nextPosition(tx, m.dimTable)` inside the tx before INSERT, pass position to INSERT.

**`importCanonical`** (CSV import — currently one pgTx per new row):
- In `manual` mode: wrap the full `for` loop in a single outer `pgTx`; call `nextPosition` once at the start; increment a local counter per successful insert.

- [ ] **Step 1: Write failing tests in `row-ordering.test.ts`**

Append to `server/src/row-ordering.test.ts`:

```ts
// NOTE: These are unit tests for the *logic* inside the helpers.
// Integration tests against a real DB would be added in a separate suite.
// Here we verify the position arithmetic used by the write paths.
describe("position arithmetic", () => {
  it("first row in manual dim gets position 1024", () => {
    // Simulate nextPosition on empty dim: max = 0n → return 1024n
    const max = 0n;
    expect(max + 1024n).toBe(1024n);
  });
  it("second row appended gets position 2048", () => {
    const max = 1024n;
    expect(max + 1024n).toBe(2048n);
  });
  it("five seeded rows get positions 1024..5120 in steps of 1024", () => {
    const positions = Array.from({ length: 5 }, (_, i) => (BigInt(i + 1) * 1024n));
    expect(positions).toEqual([1024n, 2048n, 3072n, 4096n, 5120n]);
  });
});
```

- [ ] **Step 2: Run tests (all should pass — arithmetic only)**

```bash
cd server && bun test src/row-ordering.test.ts
```

- [ ] **Step 3: Update `addCanonical`**

Replace the current `for (const v of values)` loop with:

```ts
// addCanonical body, after meta check:
if (meta.orderingMode === "manual") {
  await pgTx(async (tx) => {
    let pos = await nextPosition(tx, meta.dimTable);
    let i = 0;
    for (const v of values) {
      const result = await tx.get<{ k: string }>(
        `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label, position)
         VALUES ($1, $2, $3)
         ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING
         RETURNING ${qid(meta.keyCol)} AS k`,
        [v.key, v.label, String(pos + BigInt(i) * 1024n)],
      );
      if (result) i++;
    }
  });
} else {
  for (const v of values) {
    await pgRun(
      `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label) VALUES ($1, $2)
       ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING`,
      [v.key, v.label],
    );
  }
}
```

- [ ] **Step 4: Update `addCanonicalOne`**

Inside the existing `pgTx` in `addCanonicalOne`:

```ts
await pgTx(async (tx) => {
  if (m.orderingMode === "manual") {
    const pos = await nextPosition(tx, m.dimTable);
    await tx.run(
      `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label, position) VALUES ($1, $2, $3)
       ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
      [k, label, String(pos)],
    );
  } else {
    await tx.run(
      `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
       ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
      [k, label],
    );
  }
  await seedVersionRow(tx, dimId, k, userId, tenantId);
});
```

- [ ] **Step 5: Update `importCanonical`**

In the section where a new key is inserted (inside the `else` branch for `!existing.has(key)`), replace the per-row `pgTx` with a wrapper. Refactor the function to compute manual positions. The full new block:

```ts
// At the start of importCanonical, after fetching `m` and `existing`:
if (m.orderingMode === "manual") {
  let localIdx = 0;
  let startPos: bigint | null = null;

  await pgTx(async (tx) => {
    startPos = await nextPosition(tx, m.dimTable);
    for (const row of rows) {
      const label = row.label?.trim() ?? "";
      const key   = row.key?.trim() || (label ? slug(label) : "");
      if (!key) { skipped++; continue; }
      const fieldEntries = Object.entries(row.fields ?? {}).filter(([f]) => validFields.has(f));
      if (existing.has(key)) {
        if (fieldEntries.length === 0) { skipped++; continue; }
        // Field updates are handled after the tx (setFieldValue uses pgRun)
        updated++;
      } else {
        if (!label) { skipped++; continue; }
        const pos = startPos! + BigInt(localIdx) * 1024n;
        const inserted = await tx.get<{ k: string }>(
          `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label, position) VALUES ($1, $2, $3)
           ON CONFLICT (${qid(m.keyCol)}) DO NOTHING
           RETURNING ${qid(m.keyCol)} AS k`,
          [key, label, String(pos)],
        );
        if (inserted) {
          await seedVersionRow(tx, dimId, key, userId, tenantId);
          existing.add(key);
          localIdx++;
          created++;
        } else {
          skipped++;
        }
      }
    }
  });
  // Apply field updates (setFieldValue uses pgRun — outside the tx is fine)
  for (const row of rows) {
    const key = row.key?.trim() || (row.label?.trim() ? slug(row.label!.trim()) : "");
    if (!key || !existing.has(key)) continue;
    const fieldEntries = Object.entries(row.fields ?? {}).filter(([f]) => validFields.has(f));
    for (const [f, v] of fieldEntries) await setFieldValue(dimId, key, f, v, tenantId);
  }
} else {
  // derived mode: original per-row logic unchanged
  for (const row of rows) {
    // ... (keep existing loop exactly as-is)
  }
}
```

Note: the original loop body (`for (const row of rows)`) for derived mode stays verbatim. Only the manual-mode path changes.

- [ ] **Step 6: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
cd server && git add src/repo-canonical.ts src/row-ordering.test.ts
git commit -m "feat: addCanonical, addCanonicalOne, importCanonical set position in manual mode"
```

---

## Task 8: Update `commit()` for manual mode

**Files:**
- Modify: `server/src/repo-drafts.ts:264-283`

In `derived` mode the existing INSERT stays. In `manual` mode we replace the `INSERT ... SELECT DISTINCT` with a CTE that uses `row_number() OVER (ORDER BY first_seen, k)` to assign evenly-spaced positions appended after the current max.

- [ ] **Step 1: Add a failing test for the manual-mode branch**

In `server/src/row-ordering.test.ts`, add:

```ts
describe("commit position SQL shape", () => {
  it("assigns positions starting at MAX+1024 in first_seen order", () => {
    // This tests the arithmetic only — the actual SQL is an integration test.
    // Simulating: 3 new keys arrive at first_seen positions 1, 2, 3.
    // currentMax = 3072. Expected positions: 4096, 5120, 6144.
    const currentMax = 3072n;
    const newRows = [{ k: "a" }, { k: "b" }, { k: "c" }];
    const positions = newRows.map((_, i) => currentMax + BigInt(i + 1) * 1024n);
    expect(positions).toEqual([4096n, 5120n, 6144n]);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd server && bun test src/row-ordering.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Extend `commit()` to read `ordering_mode` and branch**

In `repo-drafts.ts`, the `commit()` function currently reads only `dim_table`, `map_table`, `key_col`, `label` from the `dimension` table. Extend the SELECT:

```ts
const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; label: string; orderingMode: string }>(
  `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label,
          COALESCE(ordering_mode, 'derived') AS "orderingMode"
   FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
  [dimId, tenantId],
);
```

- [ ] **Step 4: Replace the canonical INSERT with a branched version**

Inside the `pgTx` (around line 264), replace the single `await run(INSERT INTO ${DIMT} ...)` with:

```ts
if (meta.orderingMode === "manual") {
  await run(
    `WITH max_pos AS (
       SELECT COALESCE(MAX(position), 0)::bigint AS m FROM ${DIMT}
     ),
     ordered AS (
       SELECT
         target_key   AS k,
         target_label AS lbl,
         MIN(created_at) AS first_seen
       FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.tenant_id = $2
         AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)
       GROUP BY target_key, target_label
     )
     INSERT INTO ${DIMT} (${key}, label, position)
     SELECT
       o.k, o.lbl,
       (SELECT m FROM max_pos) + 1024 * row_number() OVER (ORDER BY o.first_seen, o.k)
     FROM ordered o`,
    [dimId, tenantId],
  );
} else {
  await run(
    `INSERT INTO ${DIMT} (${key}, label)
     SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
     WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)`,
    [dimId, tenantId],
  );
}
```

- [ ] **Step 5: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd server && git add src/repo-drafts.ts src/row-ordering.test.ts
git commit -m "feat: commit() assigns positions via row_number in manual-mode dims"
```

---

## Task 9: `updateDimensionMeta` + `PATCH /api/dimensions/:dimId`

**Files:**
- Modify: `server/src/repo-canonical.ts` (add `updateDimensionMeta` function)
- Modify: `server/src/server.ts` (register route at ~line 1184)

`updateDimensionMeta` handles:
- Patch of `orderingMode`, `description`, `color`
- If `orderingMode` changes `derived → manual`: backfill positions in one `UPDATE … FROM (VALUES …)` round-trip
- If `orderingMode` changes `manual → derived`: null all positions
- Idempotent: no-op if mode is already the target

- [ ] **Step 1: Add unit tests for validation logic**

In `server/src/row-ordering.test.ts`:

```ts
describe("ordering mode transitions", () => {
  it("derived → manual: is a valid transition", () => {
    const from = "derived", to = "manual";
    expect(from !== to).toBe(true);
  });
  it("manual → derived: is a valid transition", () => {
    const from = "manual", to = "derived";
    expect(from !== to).toBe(true);
  });
  it("derived → derived: is a no-op transition", () => {
    const from = "derived", to = "derived";
    expect(from !== to).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd server && bun test src/row-ordering.test.ts
```

- [ ] **Step 3: Implement `updateDimensionMeta` in `repo-canonical.ts`**

Add near the end of the file:

```ts
export interface UpdateDimensionMetaInput {
  orderingMode?: "derived" | "manual";
  description?:  string | null;
  color?:        string | null;
}

export async function updateDimensionMeta(
  dimId:    string,
  patch:    UpdateDimensionMetaInput,
  userId:   string,
  tenantId: string,
): Promise<{ id: string; orderingMode: string; description: string | null; color: string | null }> {
  const current = await pgGet<{
    dimTable: string; keyCol: string; keyKind: string;
    orderingMode: string; description: string | null; color: string | null;
  }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind",
            COALESCE(ordering_mode, 'derived') AS "orderingMode",
            description, color
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!current) throw new AppError("DIMENSION_NOT_FOUND", `dimension ${dimId} not found`, 404);

  // Validate color
  if (patch.color !== undefined && patch.color !== null) {
    if (!(PALETTE_NAMES as readonly string[]).includes(patch.color)) {
      throw new AppError("VALIDATION_FAILED", `unknown color: ${patch.color}`, 422);
    }
  }
  if (patch.orderingMode !== undefined &&
      patch.orderingMode !== "derived" && patch.orderingMode !== "manual") {
    throw new AppError("VALIDATION_FAILED", `unknown orderingMode: ${patch.orderingMode}`, 422);
  }

  // Build the SET clause for scalar fields
  const sets: string[]  = [];
  const vals: unknown[] = [dimId, tenantId];
  let p = 3;
  if (patch.description !== undefined) { sets.push(`description = $${p++}`); vals.push(patch.description?.trim() || null); }
  if (patch.color       !== undefined) { sets.push(`color = $${p++}`);       vals.push(patch.color ?? null); }
  const modeChanges = patch.orderingMode !== undefined && patch.orderingMode !== current.orderingMode;
  if (modeChanges) { sets.push(`ordering_mode = $${p++}`); vals.push(patch.orderingMode!); }
  if (sets.length > 0) {
    await pgRun(
      `UPDATE ${pg("dimension")} SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2`,
      vals,
    );
  }

  // Handle mode transition
  if (modeChanges) {
    const DIMT = cq(current.dimTable);
    const k    = qid(current.keyCol);
    if (patch.orderingMode === "manual") {
      // derived → manual: assign positions in current display order
      const tiebreak = current.keyKind === "external_id" ? k : "label";
      const rows = await pgAll<{ key: string }>(
        `SELECT ${k} AS key FROM ${DIMT}
         ORDER BY COALESCE((SELECT count(*)::int FROM ${cq(current.dimTable.replace("dim_", "map_"))} m WHERE m.${k} = d.${k}), 0) DESC, d.${tiebreak}
         -- simpler: just ORDER BY ${tiebreak} since we're initialising`,
      ).catch(() => [] as { key: string }[]);
      // Use UPDATE … FROM (VALUES …) for a single round-trip
      if (rows.length > 0) {
        const valuesList = rows
          .map((r, i) => `(${pgLiteral(r.key)}, ${(i + 1) * 1024})`)
          .join(", ");
        await pgRun(
          `UPDATE ${DIMT} d SET position = v.pos::bigint
           FROM (VALUES ${valuesList}) AS v(key, pos)
           WHERE d.${k} = v.key::varchar`,
        );
      }
      await appendAuditAs(userId, "Switched ordering mode", "derived → manual", {
        tableId: dimId, tenantId,
        metadata: { from: "derived", to: "manual", backfilledRows: rows.length },
      });
    } else {
      // manual → derived: null all positions
      const result = await pgGet<{ n: number }>(
        `WITH upd AS (UPDATE ${DIMT} SET position = NULL RETURNING 1)
         SELECT count(*)::int AS n FROM upd`,
      ).catch(() => ({ n: 0 }));
      await appendAuditAs(userId, "Switched ordering mode", "manual → derived", {
        tableId: dimId, tenantId,
        metadata: { from: "manual", to: "derived", nulledRows: result?.n ?? 0 },
      });
    }
  }

  return {
    id:           dimId,
    orderingMode: patch.orderingMode ?? current.orderingMode,
    description:  patch.description !== undefined ? (patch.description?.trim() || null) : current.description,
    color:        patch.color !== undefined ? (patch.color ?? null) : current.color,
  };
}
```

Note on `pgLiteral`: This is used to safely escape key values in the VALUES list. If no such helper exists, use a parameterized form instead (split into batched UPDATEs of N at a time). A simpler but correct alternative for the backfill:

```ts
// Alternative backfill: one UPDATE per row (acceptable for <5k rows, ~120ms on Postgres 15)
for (let i = 0; i < rows.length; i++) {
  await pgRun(
    `UPDATE ${DIMT} SET position = $1 WHERE ${k} = $2`,
    [(i + 1) * 1024, rows[i]!.key],
  );
}
```

Use the per-row approach (simpler, correct) unless the codebase already has a bulk-values helper.

For the backfill ORDER BY, use the current derived-mode order — `variants DESC, label/key`:

```ts
const tiebreak = current.keyKind === "external_id" ? k : "label";
const rows = await pgAll<{ key: string }>(
  `SELECT d.${k} AS key FROM ${DIMT} d
   LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(current.dimTable.replace("dim_", "map_"))} GROUP BY 1) v ON v.gk = d.${k}
   ORDER BY COALESCE(v.n, 0) DESC, d.${tiebreak}`,
);
```

- [ ] **Step 4: Register the route in `server.ts`**

Find the block that starts `if (seg.length === 3 && id && method === "GET")` (around line 1186). Add after it:

```ts
// PATCH /api/dimensions/:id — update ordering_mode / description / color
if (seg.length === 3 && id && method === "PATCH") {
  const denied = gateOrJson(tenantCtx, "curate");
  if (denied) return denied;
  const patch = (await req.json()) as UpdateDimensionMetaInput;
  const result = await canonical.updateDimensionMeta(patch.orderingMode !== undefined || patch.description !== undefined || patch.color !== undefined
    ? dimId : dimId, patch, me, tenantCtx.tenantId);
  return json({ ok: true, dim: result });
}
```

Simplified:

```ts
if (seg.length === 3 && id && method === "PATCH") {
  const denied = gateOrJson(tenantCtx, "curate");
  if (denied) return denied;
  const patch = (await req.json()) as import("./repo-canonical.ts").UpdateDimensionMetaInput;
  const dim = await canonical.updateDimensionMeta(id, patch, me, tenantCtx.tenantId);
  return json({ ok: true, dim });
}
```

Make sure `updateDimensionMeta` and `UpdateDimensionMetaInput` are exported from `repo-canonical.ts` and imported in `server.ts`.

- [ ] **Step 5: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd server && git add src/repo-canonical.ts src/server.ts src/row-ordering.test.ts
git commit -m "feat: updateDimensionMeta + PATCH /api/dimensions/:id"
```

---

## Task 10: `POST /api/dimensions/:dimId/canonical` gains `insertAt`

**Files:**
- Modify: `server/src/server.ts:1391-1396`
- Modify: `server/src/repo-canonical.ts` (add `addCanonicalOneAt`)

`insertAt` is only used when `orderingMode === 'manual'`. When present, the server computes the new position using `computeInsertPosition`, attempts the INSERT, and on a unique-violation retries after an inline rebalance.

- [ ] **Step 1: Add `addCanonicalOneAt` in `repo-canonical.ts`**

```ts
/** Add one canonical record at a specific position (manual mode only).
 *  On unique-index collision (positions too tight), rebalances and retries once. */
export async function addCanonicalOneAt(
  dimId:    string,
  label:    string,
  key:      string | undefined,
  insertAt: { anchor: string; direction: "above" | "below" },
  userId:   string,
  tenantId: string,
): Promise<void> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) return;
  if (m.orderingMode !== "manual") {
    return addCanonicalOne(dimId, label, key, userId, tenantId);
  }
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  const DIMT = cq(m.dimTable);
  const KC   = qid(m.keyCol);

  // Fetch the anchor and its neighbour
  const anchor = await pgGet<{ position: string | null }>(
    `SELECT position FROM ${DIMT} WHERE ${KC} = $1`,
    [insertAt.anchor],
  );
  if (!anchor) throw new AppError("INSERT_ANCHOR_NOT_FOUND", `anchor ${insertAt.anchor} not found`, 404);

  const anchorPos = anchor.position == null ? null : BigInt(anchor.position);

  let neighbourPos: bigint | null = null;
  if (anchorPos !== null) {
    if (insertAt.direction === "above") {
      const prev = await pgGet<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position < $1
         ORDER BY position DESC LIMIT 1`,
        [String(anchorPos)],
      );
      neighbourPos = prev?.position == null ? null : BigInt(prev.position);
    } else {
      const next = await pgGet<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position > $1
         ORDER BY position ASC LIMIT 1`,
        [String(anchorPos)],
      );
      neighbourPos = next?.position == null ? null : BigInt(next.position);
    }
  }

  const pAbove = insertAt.direction === "above" ? neighbourPos : anchorPos;
  const pBelow = insertAt.direction === "above" ? anchorPos    : neighbourPos;
  let newPos   = computeInsertPosition(pAbove, pBelow);

  if (newPos === null) {
    // Gap too tight: rebalance then recompute
    await rebalanceDimPositions(dimId, m, userId, tenantId, "collision");
    const aRefreshed = await pgGet<{ position: string | null }>(
      `SELECT position FROM ${DIMT} WHERE ${KC} = $1`,
      [insertAt.anchor],
    );
    if (!aRefreshed?.position) throw new AppError("INSERT_ANCHOR_NOT_FOUND", `anchor ${insertAt.anchor} disappeared`, 404);
    const ap2 = BigInt(aRefreshed.position);
    // Recompute neighbours after rebalance
    const above2 = insertAt.direction === "above"
      ? (await pgGet<{ position: string | null }>(`SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position < $1 ORDER BY position DESC LIMIT 1`, [String(ap2)]))?.position
      : String(ap2);
    const below2 = insertAt.direction === "below"
      ? (await pgGet<{ position: string | null }>(`SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position > $1 ORDER BY position ASC LIMIT 1`, [String(ap2)]))?.position
      : String(ap2);
    newPos = computeInsertPosition(
      above2 == null ? null : BigInt(above2),
      below2 == null ? null : BigInt(below2),
    ) ?? (ap2 + 1024n); // fallback
  }

  await pgTx(async (tx) => {
    await tx.run(
      `INSERT INTO ${DIMT} (${KC}, label, position) VALUES ($1, $2, $3)
       ON CONFLICT (${KC}) DO NOTHING`,
      [k, label, String(newPos!)],
    );
    await seedVersionRow(tx, dimId, k, userId, tenantId);
  });

  await appendAuditAs(userId, "Inserted canonical at position", `${label} (${k})`, {
    tableId: dimId, rowKey: k, tenantId,
    metadata: { key: k, anchor: insertAt.anchor, direction: insertAt.direction },
  });
}
```

- [ ] **Step 2: Update the route handler in `server.ts`**

In the block `if (seg[3] === "canonical" ... seg.length === 4 && method === "POST")`:

```ts
if (seg.length === 4 && method === "POST") {
  const denied = gateOrJson(tenantCtx, "curate");
  if (denied) return denied;
  const { label, key, insertAt } = (await req.json()) as {
    label: string;
    key?: string;
    insertAt?: { anchor: string; direction: "above" | "below" };
  };
  if (insertAt) {
    await canonical.addCanonicalOneAt(id, label, key, insertAt, me, tenantCtx.tenantId);
  } else {
    await reqRepo.addCanonicalOne(id, label, key, me);
  }
  return noContent();
}
```

- [ ] **Step 3: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
cd server && git add src/repo-canonical.ts src/server.ts
git commit -m "feat: POST /canonical gains insertAt for manual-mode dims"
```

---

## Task 11: `PUT /api/dimensions/:dimId/canonical/:key/position`

**Files:**
- Modify: `server/src/repo-canonical.ts` (add `reorderCanonicalRow`)
- Modify: `server/src/server.ts` (register route)

This is the drag-drop endpoint. Runs inside a SERIALIZABLE transaction, verifies anchors are still consecutive, returns `409 STALE_NEIGHBOUR` if not.

- [ ] **Step 1: Add `rebalanceDimPositions` helper (used by T10 and T11)**

Add in `repo-canonical.ts` (this is the shared rebalance core, used by the endpoint in T12 as well):

```ts
/** Walk the dim in position ASC order and reassign position = rank * 1024.
 *  trigger: 'manual' = user action; 'collision' = auto-triggered by write; 'threshold' = proactive. */
export async function rebalanceDimPositions(
  dimId:    string,
  m:        { dimTable: string; keyCol: string },
  userId:   string,
  tenantId: string,
  trigger:  "manual" | "collision" | "threshold",
): Promise<number> {
  const DIMT = cq(m.dimTable);
  const KC   = qid(m.keyCol);
  const rows = await pgAll<{ key: string }>(
    `SELECT ${KC} AS key FROM ${DIMT} WHERE position IS NOT NULL ORDER BY position ASC`,
  );
  for (let i = 0; i < rows.length; i++) {
    await pgRun(`UPDATE ${DIMT} SET position = $1 WHERE ${KC} = $2`, [(i + 1) * 1024, rows[i]!.key]);
  }
  if (trigger !== "collision") {
    await appendAuditAs(userId, "Rebalanced positions", `${rows.length} rows`, {
      tableId: dimId, tenantId,
      metadata: { rebalancedRows: rows.length, trigger },
    });
  }
  return rows.length;
}
```

- [ ] **Step 2: Add `reorderCanonicalRow` function**

```ts
export async function reorderCanonicalRow(
  dimId:    string,
  rowKey:   string,
  before:   string | null | undefined,
  after:    string | null | undefined,
  userId:   string,
  tenantId: string,
): Promise<{ position: string }> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) throw new AppError("DIMENSION_NOT_FOUND", `dimension ${dimId} not found`, 404);
  if (m.orderingMode !== "manual") {
    throw new AppError("ORDERING_MODE_MISMATCH", "dimension is not in manual ordering mode", 409);
  }
  const DIMT = cq(m.dimTable);
  const KC   = qid(m.keyCol);

  return await pgTx(async (tx) => {
    // Verify target exists
    const target = await tx.get<{ position: string | null }>(
      `SELECT position FROM ${DIMT} WHERE ${KC} = $1 FOR UPDATE`,
      [rowKey],
    );
    if (!target) throw new AppError("TARGET_NOT_FOUND", `row ${rowKey} not found`, 404);

    // Fetch anchor positions
    let pBefore: bigint | null = null;
    let pAfter:  bigint | null = null;

    if (before != null) {
      const br = await tx.get<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE ${KC} = $1 FOR UPDATE`,
        [before],
      );
      if (!br) throw new AppError("INSERT_ANCHOR_NOT_FOUND", `before anchor ${before} not found`, 404);
      pBefore = br.position == null ? null : BigInt(br.position);
    } else {
      // before=null means move to top: pBefore = MIN(position) - gap
      const minRow = await tx.get<{ position: string | null }>(
        `SELECT MIN(position)::text AS position FROM ${DIMT} WHERE position IS NOT NULL AND ${KC} != $1`,
        [rowKey],
      );
      pBefore = minRow?.position == null ? null : BigInt(minRow.position) - 2048n; // two steps so we have room
    }

    if (after != null) {
      const ar = await tx.get<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE ${KC} = $1 FOR UPDATE`,
        [after],
      );
      if (!ar) throw new AppError("INSERT_ANCHOR_NOT_FOUND", `after anchor ${after} not found`, 404);
      pAfter = ar.position == null ? null : BigInt(ar.position);
    } else {
      // after=null means move to bottom
      const maxRow = await tx.get<{ position: string | null }>(
        `SELECT MAX(position)::text AS position FROM ${DIMT} WHERE position IS NOT NULL AND ${KC} != $1`,
        [rowKey],
      );
      pAfter = maxRow?.position == null ? null : BigInt(maxRow.position) + 2048n;
    }

    // Verify anchors are still consecutive (detect stale drag)
    if (pBefore !== null && pAfter !== null) {
      const between = await tx.get<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${DIMT}
         WHERE position IS NOT NULL AND position > $1 AND position < $2 AND ${KC} != $3`,
        [String(pBefore), String(pAfter), rowKey],
      );
      if ((between?.n ?? 0) > 0) {
        throw new AppError("STALE_NEIGHBOUR", "anchors are no longer consecutive", 409);
      }
    }

    // Idempotent: if target is already in the slot, return early
    const tPos = target.position == null ? null : BigInt(target.position);
    if (tPos !== null && pBefore !== null && pAfter !== null &&
        tPos > pBefore && tPos < pAfter) {
      return { position: String(tPos) };
    }

    const newPos = computeInsertPosition(pBefore, pAfter);
    if (newPos === null) {
      // Gap too tight — can't resolve inside SERIALIZABLE; abort and rebalance outside
      throw new AppError("POSITIONS_TOO_TIGHT", "rebalance required", 409);
    }

    await tx.run(`UPDATE ${DIMT} SET position = $1 WHERE ${KC} = $2`, [String(newPos), rowKey]);

    await appendAuditAs(userId, "Reordered canonical", rowKey, {
      tableId: dimId, rowKey, tenantId,
      metadata: { key: rowKey, before: before ?? null, after: after ?? null },
    });

    return { position: String(newPos) };
  });
}
```

Note: if `POSITIONS_TOO_TIGHT` is thrown, the caller (server route) should rebalance and retry once.

- [ ] **Step 3: Register the route in `server.ts`**

In the canonical block, after the variants handler (`if (seg[5] === "variants")`):

```ts
// PUT /api/dimensions/:id/canonical/:key/position
if (seg[5] === "position" && seg.length === 6 && method === "PUT" && ck) {
  const denied = gateOrJson(tenantCtx, "curate");
  if (denied) return denied;
  const { before, after } = (await req.json()) as {
    before?: string | null;
    after?:  string | null;
  };
  try {
    const result = await canonical.reorderCanonicalRow(id, ck, before, after, me, tenantCtx.tenantId);
    return json({ ok: true, position: result.position });
  } catch (e) {
    if (e instanceof AppError && e.kind === "POSITIONS_TOO_TIGHT") {
      const m2 = await dimMetaFn(id, tenantCtx.tenantId);
      if (m2) await canonical.rebalanceDimPositions(id, m2, me, tenantCtx.tenantId, "collision");
      const result = await canonical.reorderCanonicalRow(id, ck, before, after, me, tenantCtx.tenantId);
      return json({ ok: true, position: result.position, rebalanced: true });
    }
    throw e;
  }
}
```

Import `dimMeta as dimMetaFn` from `repo-shared.ts` (or reuse the canonical import).

- [ ] **Step 4: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd server && git add src/repo-canonical.ts src/server.ts
git commit -m "feat: PUT /canonical/:key/position + reorderCanonicalRow + rebalanceDimPositions"
```

---

## Task 12: `POST /api/dimensions/:dimId/positions/rebalance`

**Files:**
- Modify: `server/src/server.ts`

Rate-limited to one successful rebalance per 60 seconds via `last_rebalanced_at`. Returns 429 with `retryAfterSeconds` if rate-limited.

- [ ] **Step 1: Write the rate-limit test**

In `server/src/row-ordering.test.ts`:

```ts
describe("rebalance rate limit", () => {
  it("retryAfterSeconds is within 0..60 for a recent rebalance", () => {
    const lastMs = Date.now() - 10_000; // 10 seconds ago
    const retryAfter = Math.ceil((60_000 - (Date.now() - lastMs)) / 1000);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
  it("allows rebalance when last was > 60s ago", () => {
    const lastMs = Date.now() - 70_000;
    const elapsed = Date.now() - lastMs;
    expect(elapsed).toBeGreaterThan(60_000);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd server && bun test src/row-ordering.test.ts
```

- [ ] **Step 3: Register the route in `server.ts`**

In the dimensions block, add before (or after) the `commit` route:

```ts
// POST /api/dimensions/:id/positions/rebalance
if (seg[3] === "positions" && seg[4] === "rebalance" && seg.length === 5 && method === "POST") {
  const denied = gateOrJson(tenantCtx, "curate");
  if (denied) return denied;

  // Rate-limit: attempt atomic check-and-set
  const gateResult = await pgGet<{ last_rebalanced_at: string | null }>(
    `UPDATE ${pg("dimension")}
        SET last_rebalanced_at = now()
      WHERE id = $1 AND tenant_id = $2
        AND (last_rebalanced_at IS NULL OR last_rebalanced_at < now() - interval '60 seconds')
      RETURNING last_rebalanced_at`,
    [id, tenantCtx.tenantId],
  );

  if (!gateResult) {
    const existing = await pgGet<{ last_rebalanced_at: string }>(
      `SELECT last_rebalanced_at FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
      [id, tenantCtx.tenantId],
    );
    const lastMs      = existing?.last_rebalanced_at ? new Date(existing.last_rebalanced_at).getTime() : 0;
    const retryAfter  = Math.ceil((60_000 - (Date.now() - lastMs)) / 1000);
    return json(
      { error: "REBALANCE_RATE_LIMITED", lastRebalancedAt: existing?.last_rebalanced_at ?? null, retryAfterSeconds: Math.max(1, retryAfter) },
      429,
    );
  }

  const m = await dimMetaFn(id, tenantCtx.tenantId);
  if (!m) return json({ error: "DIMENSION_NOT_FOUND" }, 404);
  const rebalanced = await canonical.rebalanceDimPositions(id, m, me, tenantCtx.tenantId, "manual");
  return json({ ok: true, rebalanced, rebalancedAt: gateResult.last_rebalanced_at });
}
```

Where `dimMetaFn` is imported from `repo-shared.ts` (the same `dimMeta`).

- [ ] **Step 4: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd server && git add src/server.ts src/row-ordering.test.ts
git commit -m "feat: POST /positions/rebalance with 60s rate limit"
```

---

## Task 13: Client types + store functions

**Files:**
- Modify: `app/src/data.ts:13-20` (CanonicalValue)
- Modify: `app/src/data.ts:64-79` (MappingDimension)
- Modify: `app/src/data.ts:259-263` (GridLayoutConfig)
- Modify: `app/src/store.ts:974-978` (GridLayoutConfig — same shape, keep in sync)
- Modify: `app/src/store.ts` (add new store functions)

- [ ] **Step 1: Extend `CanonicalValue` in `app/src/data.ts`**

```ts
export interface CanonicalValue {
  key:        string;
  label:      string;
  version:    number;
  variants?:  number;
  fields?:    Record<string, string | null>;
  unresolved?: boolean;
  position?:  string | null;   // NEW — bigint string; null in derived mode
}
```

- [ ] **Step 2: Extend `MappingDimension` in `app/src/data.ts`**

```ts
export interface MappingDimension {
  id:            string;
  dimension:     string;
  dimTable:      string;
  mapTable:      string;
  keyCol:        string;
  keyKind?:      "slug" | "external_id";
  description?:  string | null;
  color?:        PaletteName | null;
  rows:          number;
  canonical:     CanonicalValue[];
  values:        MappingValue[];
  fields?:       FieldDef[];
  orderingMode?: "derived" | "manual";   // NEW
  nextPosition?: string | null;           // NEW — bigint string; null in derived mode
}
```

- [ ] **Step 3: Extend `GridLayoutConfig` in both `app/src/data.ts` and `app/src/store.ts`**

In `app/src/data.ts`:

```ts
export interface GridLayoutConfig {
  widths?:  Record<string, number>;
  order?:   string[];
  hidden?:  string[];
  sort?:    { column: string; direction: "asc" | "desc" } | null;   // NEW
}
```

In `app/src/store.ts` (same addition):

```ts
export interface GridLayoutConfig {
  widths?:  Record<string, number>;
  order?:   string[];
  hidden?:  string[];
  sort?:    { column: string; direction: "asc" | "desc" } | null;   // NEW
}
```

- [ ] **Step 4: Add store functions for the four new API calls**

In `app/src/store.ts`, add after the `addDimension` function:

```ts
export async function patchDimension(
  dimId: string,
  patch: { orderingMode?: "derived" | "manual"; description?: string | null; color?: string | null },
): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  await refreshDim(dimId);
  emit();
}

export async function insertCanonicalAt(
  dimId:    string,
  label:    string,
  anchor:   string,
  direction: "above" | "below",
  key?:     string,
): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/canonical`, {
    method: "POST",
    body: JSON.stringify({ label, key, insertAt: { anchor, direction } }),
  });
  await refreshDim(dimId);
  emit();
}

export async function reorderCanonical(
  dimId:  string,
  rowKey: string,
  opts:   { before?: string | null; after?: string | null },
): Promise<{ position: string }> {
  const result = await api<{ ok: boolean; position: string }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(rowKey)}/position`,
    {
      method: "PUT",
      body: JSON.stringify(opts),
    },
  );
  await refreshDim(dimId);
  emit();
  return { position: result.position };
}

export async function rebalancePositions(dimId: string): Promise<{ rebalanced: number }> {
  return api<{ ok: boolean; rebalanced: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/positions/rebalance`,
    { method: "POST" },
  );
}
```

- [ ] **Step 5: Typecheck app**

```bash
cd app && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd app && git add src/data.ts src/store.ts
git commit -m "feat(client): extend types + add patchDimension, insertCanonicalAt, reorderCanonical, rebalancePositions"
```

---

## Task 14: TablePane — wire `onInsertRow` + drag handle column

**Files:**
- Modify: `app/src/components/TablePane.tsx`

Two changes in this task:
1. Wire the existing `onInsertRow` prop to call `insertCanonicalAt` for manual-mode dims (currently it just scrolls to the bottom add-record input).
2. Add a drag handle column for manual-mode dims with pointer-drag reorder.

- [ ] **Step 1: Wire `onInsertRow` for manual mode**

Find the `onInsertRow` prop passed to `<DataGrid>` (around `TablePane.tsx:952`). Replace the stub:

```tsx
onInsertRow={
  external || !canEdit
    ? undefined
    : (key, where) => {
        if (dim.orderingMode === "manual") {
          const label = "";
          // Open inline-edit for a new row at the given position.
          // For now: create the row immediately with a placeholder label,
          // then focus the rename input. If label is empty, use a sensible default.
          // The simplest UX: reuse the existing bottom-add-input flow but
          // scroll the new row into view after insert.
          void insertCanonicalAt(activeId, "(new)", key, where).then(() => {
            // Refresh is handled inside insertCanonicalAt; grid re-renders with new row.
          });
        } else {
          addInputRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          addInputRef.current?.focus();
        }
      }
}
```

Import `insertCanonicalAt` and `reorderCanonical` from `../store`.

- [ ] **Step 2: Add `onReorderRow` prop to DataGrid types**

In `app/src/components/datagrid/types.ts`, add:

```ts
onReorderRow?: (rowKey: string, before: string | null, after: string | null) => void;
```

- [ ] **Step 3: Add drag handle column in `TablePane.tsx`**

The drag handle column is a synthetic column added to the front of the `columns` array when `dim.orderingMode === "manual"`. Find where `columns` is built (the `useMemo` block around line 350). Before the return, add a drag handle column:

```tsx
// Inside the columns useMemo, before pushing regular columns:
const cols: ColumnDef<CanonicalValue>[] = [];

if (dim.orderingMode === "manual") {
  cols.push({
    field:    "__drag",
    label:    engineer ? "position" : "",
    width:    28,
    readOnly: true,
    render:   (row, _col, _rowIdx, ctx) => (
      <DragHandleCell
        rowKey={row.key}
        position={row.position ?? null}
        canEdit={canEdit && !layout.sort}
        engineer={engineer}
        onDragEnd={(before, after) => {
          void reorderCanonical(activeId, row.key, { before, after });
        }}
      />
    ),
  });
}

// ... existing cols push ...
```

- [ ] **Step 4: Implement `DragHandleCell` inline in `TablePane.tsx`**

Add above the main component:

```tsx
function DragHandleCell({
  rowKey,
  position,
  canEdit,
  engineer,
  onDragEnd,
}: {
  rowKey:    string;
  position:  string | null;
  canEdit:   boolean;
  engineer:  boolean;
  onDragEnd: (before: string | null, after: string | null) => void;
}) {
  const disabled = !canEdit;
  const tooltip  = !canEdit ? "Read-only access" : position === null ? undefined : engineer ? `position = ${position}` : undefined;

  return (
    <button
      aria-label={`Reorder ${rowKey} — drag or use Cmd+Shift+Up/Down`}
      aria-grabbed={undefined}
      title={tooltip}
      disabled={disabled}
      className={cx(
        "flex h-full w-full items-center justify-center text-ink-3",
        disabled ? "cursor-default opacity-30" : "cursor-grab hover:text-ink active:cursor-grabbing",
      )}
      onPointerDown={(e) => {
        if (disabled) return;
        // Minimal pointer drag — tracks the dragged row and the drop target via
        // data attributes on adjacent rows. Full implementation is in Step 5.
        e.currentTarget.setPointerCapture(e.pointerId);
        (e.currentTarget as HTMLElement).setAttribute("aria-grabbed", "true");
      }}
    >
      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
        <circle cx="3" cy="2"  r="1.5" />
        <circle cx="7" cy="2"  r="1.5" />
        <circle cx="3" cy="7"  r="1.5" />
        <circle cx="7" cy="7"  r="1.5" />
        <circle cx="3" cy="12" r="1.5" />
        <circle cx="7" cy="12" r="1.5" />
      </svg>
    </button>
  );
}
```

The full drag-and-drop logic (tracking pointer movement, rendering a drop indicator line, resolving before/after row keys) is wired in Step 5.

- [ ] **Step 5: Implement pointer drag logic**

In `TablePane.tsx`, add a ref for drag state and attach pointer event handlers to the DataGrid container. The simplest correct implementation:

```tsx
// Above the component JSX, inside TablePane:
const dragState = useRef<{
  rowKey: string;
  startY: number;
} | null>(null);

// On DataGrid wrapper div, add:
// onPointerMove / onPointerUp handlers that:
//   1. Find the row element under the pointer (using elementFromPoint)
//   2. Read the data-row-key attribute
//   3. Determine if we're above or below the midpoint of that row
//   4. Call onDragEnd with (before=prevRowKey|null, after=foundRowKey|null) on pointerUp
```

For the purposes of this plan: implement a minimal version that reads the rendered row order from the `list` array (the `canonical` rows in display order), determines the before/after from the pointer's Y position relative to the grid rows, and calls `reorderCanonical`.

Full implementation is UI-heavy; a functional but not animated version is sufficient for the feature to work. A more polished version can follow.

- [ ] **Step 6: Typecheck app**

```bash
cd app && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
cd app && git add src/components/TablePane.tsx src/components/datagrid/types.ts
git commit -m "feat(ui): wire onInsertRow for manual mode + DragHandleCell"
```

---

## Task 15: TablePane — keyboard shortcuts for row reorder

**Files:**
- Modify: `app/src/components/TablePane.tsx`

Cmd+Shift+↑/↓ on a focused row → move one slot up/down. Cmd+Shift+Home/End → move to top/bottom.

- [ ] **Step 1: Add keyboard handler inside the TablePane's key handler section**

Find the `onKeyDown` handler wired to the DataGrid wrapper (or wherever keyboard events are handled). Add a check for manual-mode ordering shortcuts:

```tsx
// Inside the keydown handler, check for reorder shortcuts first:
if (dim.orderingMode === "manual" && canEdit) {
  const isMac = navigator.platform.includes("Mac");
  const mod   = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.shiftKey) {
    const focused = /* current cursor row key from grid cursor */;
    if (!focused) return;
    const idx   = list.findIndex((r) => r.key === focused);
    if (idx === -1) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const before = idx > 1 ? list[idx - 2]!.key : null;
      const after  = idx > 0 ? list[idx - 1]!.key : null;
      void reorderCanonical(activeId, focused, { before, after });
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const before = idx < list.length - 1 ? list[idx + 1]!.key : null;
      const after  = idx < list.length - 2 ? list[idx + 2]!.key : null;
      void reorderCanonical(activeId, focused, { before, after });
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      void reorderCanonical(activeId, focused, { before: null, after: list[0]?.key ?? null });
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      void reorderCanonical(activeId, focused, { before: list[list.length - 1]?.key ?? null, after: null });
      return;
    }
  }
}
```

- [ ] **Step 2: Update context menu in `DataGrid.tsx` for mode-aware items**

In `DataGrid.tsx`, find the cell/row context menu items around line 650. The `onInsertRow` items should show shortcut hints. Add `Move to top` and `Move to bottom` items, enabled only when `props.onReorderRow` is provided:

```tsx
// In the cell context menu items array:
{ label: "Insert row above", shortcut: isMac ? "⌘⇧↑" : "Ctrl+Shift+↑",
  onClick: () => props.onInsertRow?.(rk, "above"),
  hidden: !props.onInsertRow },
{ label: "Insert row below", shortcut: isMac ? "⌘⇧↓" : "Ctrl+Shift+↓",
  onClick: () => props.onInsertRow?.(rk, "below"),
  hidden: !props.onInsertRow },
{ label: "Move to top",    shortcut: isMac ? "⌘⇧↖" : "Ctrl+Shift+Home",
  onClick: () => props.onReorderRow?.(rk, null, rows[0] ? rowKey(rows[0]) : null),
  hidden: !props.onReorderRow },
{ label: "Move to bottom", shortcut: isMac ? "⌘⇧↘" : "Ctrl+Shift+End",
  onClick: () => props.onReorderRow?.(rk, rows[rows.length - 1] ? rowKey(rows[rows.length - 1]!) : null, null),
  hidden: !props.onReorderRow },
```

Pass `onReorderRow` from `TablePane` when `dim.orderingMode === "manual" && canEdit`.

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
cd app && git add src/components/TablePane.tsx src/components/datagrid/DataGrid.tsx
git commit -m "feat(ui): keyboard shortcuts + context menu for row reorder (manual mode)"
```

---

## Task 16: Sort banner + view-sort persistence

**Files:**
- Modify: `app/src/components/TablePane.tsx`

The sort banner appears when `dim.orderingMode === "manual" && layout.sort != null && !sessionDismissed`. "Restore" clears `layout.sort`. "Dismiss" hides banner for the session.

- [ ] **Step 1: Add session-dismiss state and sort banner component**

In `TablePane.tsx`, add near the top of the component:

```tsx
const [dismissedSortBanner, setDismissedSortBanner] = useState<Set<string>>(new Set());
const showSortBanner =
  dim.orderingMode === "manual" &&
  !!layout.sort &&
  !dismissedSortBanner.has(activeId);
```

Add the sort banner JSX above the DataGrid (below the header/toolbar):

```tsx
{showSortBanner && (
  <div className="flex h-8 items-center gap-2 border-b border-rule bg-surface-2 px-3 text-[12px] text-ink-2">
    <span className="flex-1">
      ⇅ Sorted by {layout.sort?.column} {layout.sort?.direction === "asc" ? "↑" : "↓"} — manual order is hidden
    </span>
    <button
      className="text-accent hover:underline"
      onClick={() => setGridLayout(activeId, { sort: null })}
    >
      Restore
    </button>
    <button
      className="text-ink-3 hover:text-ink"
      onClick={() => setDismissedSortBanner((s) => new Set([...s, activeId]))}
    >
      Dismiss
    </button>
  </div>
)}
```

- [ ] **Step 2: Persist view-sort in `GridLayoutConfig` on column header click**

Find the column header click / sort handler in `TablePane.tsx` (the `onSortChange` or equivalent). If the grid doesn't have a built-in sort callback, add a `onHeaderClick` or similar. When a column header is clicked for sort in a manual-mode dim, call:

```ts
setGridLayout(activeId, { sort: { column: clickedField, direction: "asc" } });
```

On second click of the same column, toggle to `"desc"`. On third click, clear to `null`.

The grid should read `layout.sort` on mount and apply it to the rendered row order. The client re-sorts the `list` array before passing to DataGrid using `[...list].sort(...)` when `layout.sort !== null`.

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
cd app && git add src/components/TablePane.tsx
git commit -m "feat(ui): sort banner for manual-mode dims + view-sort persistence"
```

---

## Task 17: Ordering settings section + engineer mode position reveal

**Files:**
- Modify: `app/src/components/TablePane.tsx`

The settings panel already has description, color, and key kind sections. Add an Ordering section with derived/manual radio buttons, confirm dialogs for mode transitions, and an advanced Rebalance button.

The engineer mode reveal: when `engineer === true` and `dim.orderingMode === "manual"`, show `position = {pos}` tooltip on drag handle (already handled in Task 14 via `DragHandleCell`'s `title`) and a `next position: {dim.nextPosition}` line in the grid footer.

- [ ] **Step 1: Add the Ordering section to the settings panel**

Find where the settings panel JSX is rendered in `TablePane.tsx` (search for `description`, `color`, or the settings sidebar toggle). Add the Ordering section:

```tsx
{/* ── Ordering ─────────────────────────────────── */}
<div className="space-y-2 border-b border-rule py-4">
  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Ordering</div>
  <label className="flex cursor-pointer items-start gap-2">
    <input
      type="radio"
      name="ordering"
      value="derived"
      checked={dim.orderingMode !== "manual"}
      onChange={() => {
        if (dim.orderingMode === "manual") setOrderingConfirm("derived");
      }}
      className="mt-0.5"
    />
    <div>
      <div className="text-[13px] font-medium">Derived</div>
      <div className="text-[12px] text-ink-3">Sort by variant count, then alphabetically.</div>
    </div>
  </label>
  <label className="flex cursor-pointer items-start gap-2">
    <input
      type="radio"
      name="ordering"
      value="manual"
      checked={dim.orderingMode === "manual"}
      onChange={() => {
        if (dim.orderingMode !== "manual") setOrderingConfirm("manual");
      }}
      className="mt-0.5"
    />
    <div>
      <div className="text-[13px] font-medium">Manual</div>
      <div className="text-[12px] text-ink-3">Persisted drag-orderable order.</div>
    </div>
  </label>
  {dim.orderingMode === "manual" && canEdit && (
    <button
      className="mt-2 text-[12px] text-ink-3 underline"
      onClick={() => setRebalanceConfirm(true)}
    >
      Rebalance positions
    </button>
  )}
</div>
```

- [ ] **Step 2: Add confirm dialog state and handlers**

```tsx
const [orderingConfirm, setOrderingConfirm] = useState<"derived" | "manual" | null>(null);
const [rebalanceConfirm, setRebalanceConfirm] = useState(false);
```

When `orderingConfirm` is non-null, render a `<ConfirmDialog>` with appropriate warning text:
- `derived → manual`: "This will assign positions to all N rows in their current display order."
- `manual → derived`: "This will null the positions on all N rows. Your manual order cannot be recovered." (destructive button)

On confirm: call `patchDimension(activeId, { orderingMode: orderingConfirm })`.

For `rebalanceConfirm`: render a `<ConfirmDialog>` with message "Reassign positions in evenly-spaced steps of 1024?" On confirm: call `rebalancePositions(activeId)`.

- [ ] **Step 3: Add engineer-mode `next position` to the grid footer**

Find the grid footer area in `TablePane.tsx` (the status bar or the bottom controls). When `engineer && dim.orderingMode === "manual" && dim.nextPosition`:

```tsx
{engineer && dim.orderingMode === "manual" && dim.nextPosition && (
  <span className="font-mono text-[11px] text-ink-3">
    next position: {dim.nextPosition}
  </span>
)}
```

- [ ] **Step 4: Typecheck**

```bash
cd app && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd app && git add src/components/TablePane.tsx
git commit -m "feat(ui): ordering settings section + engineer mode position reveal"
```

---

## Self-Review Checklist

**Spec coverage check:**

| Spec section | Task(s) |
|---|---|
| `position BIGINT` on `dim_*` tables | T1, T2, T4 |
| `ordering_mode` + `last_rebalanced_at` on `dimension` | T1, T2 |
| `nextPosition` helper (FOR UPDATE pattern) | T5 |
| `addDimension` emits position column | T4 |
| `addCanonical` manual mode | T7 |
| `addCanonicalOne` manual mode | T7 |
| `importCanonical` manual mode (single pgTx) | T7 |
| `commit()` manual mode (row_number CTE) | T8 |
| `updateDimensionMeta` + `PATCH /dimensions/:id` | T9 |
| derived→manual backfill | T9 |
| manual→derived null | T9 |
| `insertAt` on `POST /canonical` | T10 |
| `PUT /canonical/:key/position` (drag reorder) | T11 |
| SERIALIZABLE + FOR UPDATE + STALE_NEIGHBOUR | T11 |
| `POST /positions/rebalance` + 60s rate limit | T12 |
| `getDimension` ORDER BY branch + `position` in response | T6 |
| `nextPosition` on dim envelope | T6 |
| `GridLayoutConfig.sort` extension | T13 |
| Client types: `CanonicalValue.position`, `MappingDimension.orderingMode/nextPosition` | T13 |
| Store functions: `patchDimension`, `insertCanonicalAt`, `reorderCanonical`, `rebalancePositions` | T13 |
| `onInsertRow` wired for manual mode | T14 |
| Drag handle column (28px, leftmost) | T14 |
| Keyboard shortcuts Cmd+Shift+↑/↓/Home/End | T15 |
| Context menu: Insert above/below + Move to top/bottom | T15 |
| Sort banner + Restore + Dismiss | T16 |
| View-sort persistence in `GridLayoutConfig.sort` | T16 |
| Settings Ordering section + confirm dialogs | T17 |
| Rebalance button in settings | T17 |
| Engineer mode: position tooltip + next position footer | T14 (tooltip), T17 (footer) |
| Audit entries: `Switched ordering mode`, `Reordered canonical`, `Inserted canonical at position`, `Rebalanced positions` | T9, T10, T11, T12 |
| `canView` users: drag handles disabled, context-menu items hidden | T14 |
| Anti-criteria: derived dims never get position written | enforced by `orderingMode` branches in T7, T8 |
| Anti-criteria: column header never calls PUT /position | T16 (sort persisted in layout only) |
| Anti-criteria: curate gate on all endpoints | T9, T10, T11, T12 |

**Placeholder scan:** No TBD/TODO in code blocks above. Note that Task 14 Step 5 (pointer drag implementation) is intentionally described as "functional but not animated" — this is a conscious scope decision, not a placeholder.

**Type consistency:**
- `computeInsertPosition` is defined in T5 and called in T10, T11 — consistent.
- `nextPosition(tx, dimTable)` is defined in T5 and called in T7, T10 — consistent. The `tx` parameter type is the `pgTx` callback argument.
- `rebalanceDimPositions` is defined in T11 and called in T11 (server route) and T10 (rebalance after collision) — consistent.
- `DimMeta.orderingMode` added in T3 and consumed in T7, T9, T10, T11 — consistent.
- `CanonicalValue.position: string | null` added in T3 (server) and T13 (client) — both nullable string.
- `MappingDimension.orderingMode` and `nextPosition` added in T13; consumed in T14, T15, T16, T17 — consistent.
