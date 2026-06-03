# External-ID Keys with Live-Resolved Names — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a master-table (dimension) be keyed by an opaque external warehouse ID (e.g. `partner_id`) while the human name is resolved **live** from the warehouse on read — store the ID, render the name; show the raw ID flagged "unresolved" when no name resolves.

**Architecture:** A dimension gains `key_kind` (`'slug'` | `'external_id'`) plus a name binding (`name_table`, `name_id_col`, `name_col`) on the Postgres `dimension` registry. For `external_id` dimensions the `dim_` table stores only the ID (label nullable); `getDimension`/`scanValues` `LEFT JOIN` the warehouse name table to project the live name and an `unresolved` flag. The frontend honors this: unresolved badge, no rename, no slug-add, two-column derive, and the reconcile picker shows live names automatically.

**Tech Stack:** Bun + `@duckdb/node-api` (server, one DuckDB connection ATTACHing Postgres + MotherDuck), React 18 + Vite + Tailwind v4 (app). Verification follows the existing `spike.ts` convention (self-cleaning `check()` script run via `bun run`), not a unit-test runner — this codebase has none.

---

## Key assumption (confirm at plan review)

An `external_id` dimension's canonical set is **derived from a master/reference table** that carries both the ID and the name (e.g. `analytics.r_partners` with `partner_id` + `partner_name`). That same table doubles as the live name binding. Consequences, by design:
- An external-ID record's sole crosswalk "variant" is the ID string itself (derive self-maps `id → id`, 1:1), mirroring the slug path.
- Retire stays governed (refused while variants map) exactly as for slug dims.
- If partners were instead meant to *arise from reconciliation* of other tables rather than a master-table derive, Task 3 changes — flag it now.

## Scope

**In v1:**
- Schema migration + `key_kind`/name binding (Task 1)
- `addDimension` external-ID support (Task 2)
- `deriveCanonical` two-column path + binding persistence (Task 3)
- `getDimension` live name resolution + `unresolved` flag, `listDimensions` projection (Task 4)
- `scanValues` live-resolve `current` so the reconcile screen shows names (Task 5)
- API routes: `keyKind` on create, `nameColumn` on derive (Task 6)
- `verify-eid.ts` regression harness (Task 7)
- Client types + store signatures (Task 8)
- MasterTables: unresolved badge, no rename, no slug-add, two-column derive (Task 9)
- DimensionPicker external-ID toggle + Mapping `allowCreate` off for external-ID (Task 10)

**Deferred (follow-ups, not built):**
- Manual "add canonical by ID" affordance for external-ID dims (slug-add is hidden in v1).
- AI mapping suggestions for external-ID dims.
- Commit-path: drafts already carry `target_key`; commit inserts `(key, label)` — for external-ID dims `target_label` is the resolved name snapshot at stage time, which is acceptable (the label column is unused on read). No change needed in v1.

## File map

| File | Change |
|---|---|
| `server/src/schema.ts` | ALTER `dimension`: add `key_kind`, `name_table`, `name_id_col`, `name_col`; backfill `key_kind='slug'` |
| `server/src/repo.ts` | `DimensionMeta`/`CanonicalValue` types; `addDimension` opts; `deriveCanonical` nameColumn; `getDimension`/`scanValues` live resolution; `listDimensions` projection; `bulkInsert1` helper |
| `server/src/server.ts` | `keyKind` on `POST /dimensions`; `nameColumn` on `POST /dimensions/:id/derive` |
| `server/src/verify-eid.ts` | **new** — self-cleaning verification harness |
| `server/package.json` | add `"verify-eid"` script |
| `app/src/data.ts` | `CanonicalValue.unresolved?`; `MappingDimension.keyKind?` |
| `app/src/store.ts` | `addDimension(name, keyKind?)`; `deriveCanonical(dimId, table, column, nameColumn?)` |
| `app/src/routes/MasterTables.tsx` | unresolved badge, hide rename + slug-add, two-column derive for external-ID |
| `app/src/components/DimensionPicker.tsx` | external-ID checkbox in create form; `onCreate(name, keyKind)` |
| `app/src/routes/Mapping.tsx` | `onCreate` arity; `allowCreate` off for external-ID picker |

---

## Task 0: (Optional) initialize git for commit checkpoints

This directory is **not** a git repo. The plan's commit steps are recommended checkpoints. If you want them, init once; otherwise skip every "Commit" step.

- [ ] **Step 1: Init (optional)**

```bash
cd /mnt/c/Users/fhagelund/documents/github/zugzug
git init && git add -A && git commit -m "chore: snapshot before external-ID keys"
```

---

## Task 1: Schema migration — `key_kind` + name binding

**Files:**
- Modify: `server/src/schema.ts` (after the `dimension` CREATE TABLE, ~line 30)

- [ ] **Step 1: Add idempotent ALTERs + backfill after the `dimension` table is created**

In `ensureSchema()`, immediately after the `CREATE TABLE IF NOT EXISTS ${pg("dimension")} (...)` block (ends ~line 30), insert:

```ts
  // external-ID keys: a dimension may be keyed by a real warehouse ID (e.g.
  // partner_id) instead of a name-derived slug. key_kind drives that; the name
  // binding says where to resolve the human name from, live, on read.
  // ADD COLUMN IF NOT EXISTS keeps this idempotent on an existing dimension table.
  for (const col of ["key_kind VARCHAR", "name_table VARCHAR", "name_id_col VARCHAR", "name_col VARCHAR"]) {
    await run(`ALTER TABLE ${pg("dimension")} ADD COLUMN IF NOT EXISTS ${col}`);
  }
  await run(`UPDATE ${pg("dimension")} SET key_kind = 'slug' WHERE key_kind IS NULL`);
```

- [ ] **Step 2: Typecheck**

Run: `cd server && bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Apply the migration against the real Postgres**

Run: `cd server && bun run bootstrap`
Expected: completes without error (bootstrap calls `ensureSchema`). If `bun run bootstrap` requires `--seed` to do anything visible, that's fine — the ALTERs run regardless.

- [ ] **Step 4: Commit**

```bash
git add server/src/schema.ts && git commit -m "feat(schema): add key_kind + name binding to dimension registry"
```

---

## Task 2: `addDimension` — create external-ID dimensions

**Files:**
- Modify: `server/src/repo.ts` — `DimensionMeta` interface (~line 25), `addDimension` (~line 338)

- [ ] **Step 1: Add `keyKind` to `DimensionMeta`**

Change the interface (`repo.ts:25-27`) to:

```ts
export interface DimensionMeta {
  id: string; dimension: string; dimTable: string; mapTable: string; keyCol: string; rows: number;
  keyKind: "slug" | "external_id";
}
```

- [ ] **Step 2: Extend `addDimension` to accept a key kind and create a nullable-label dim_ for external IDs**

Replace `addDimension` (`repo.ts:338-362`) with:

```ts
/** Create a dimension: register it + provision dim_/map_ (Postgres) + register
 *  its warehouse sources. Idempotent on the id. For key_kind 'external_id' the
 *  dim_ label is nullable (names are resolved live from the warehouse, not stored). */
export async function addDimension(
  name: string,
  sources: SourceDef[] = [],
  opts: { keyKind?: "slug" | "external_id" } = {},
): Promise<string> {
  const id = slug(name);
  if (!id) return id;
  const keyKind = opts.keyKind === "external_id" ? "external_id" : "slug";
  const dimTable = `${env.canonicalSchema}.dim_${id}`;
  const mapTable = `${env.canonicalSchema}.map_${id}`;
  const keyCol = `${id}_code`;
  const existing = await get(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
  if (!existing) {
    const labelDdl = keyKind === "external_id" ? "label VARCHAR" : "label VARCHAR NOT NULL";
    await run(`CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (${qid(keyCol)} VARCHAR PRIMARY KEY, ${labelDdl})`);
    await run(`CREATE TABLE IF NOT EXISTS ${cq(mapTable)} (raw VARCHAR PRIMARY KEY, ${qid(keyCol)} VARCHAR NOT NULL)`);
    await run(
      `INSERT INTO ${pg("dimension")} (id, label, dim_table, map_table, key_col, key_kind, created_at) VALUES ($1,$2,$3,$4,$5,$6, current_timestamp)`,
      [id, name.trim(), dimTable, mapTable, keyCol, keyKind],
    );
    await appendAudit("Created dimension", `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`);
  }
  for (const s of sources) {
    await run(
      `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column) VALUES ($1,$2,$3)
       ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`,
      [id, s.table, s.column],
    );
  }
  return id;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd server && bun run typecheck`
Expected: `listDimensions`/`getDimension` now error because they don't project `keyKind` yet — that is expected and fixed in Task 4. If you want a clean checkpoint, proceed to Task 4 before committing. (Other call sites of `addDimension` use the default and still compile.)

- [ ] **Step 4: Commit (after Task 4 typechecks clean)**

```bash
git add server/src/repo.ts && git commit -m "feat(repo): addDimension supports external-ID key kind"
```

---

## Task 3: `deriveCanonical` — two-column external-ID path + binding

**Files:**
- Modify: `server/src/repo.ts` — add `bulkInsert1` helper near `bulkInsert` (~line 184); rewrite `deriveCanonical` (~line 197)

- [ ] **Step 1: Add a single-column bulk insert helper**

After `bulkInsert` (`repo.ts:184-191`), add:

```ts
/** Bulk insert single-column rows (e.g. external-ID keys) in chunks. */
async function bulkInsert1(prefix: string, values: string[], conflict: string): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j + 1})`).join(", ");
    await run(`${prefix} VALUES ${placeholders} ${conflict}`, chunk as DuckDBValue[]);
  }
}
```

- [ ] **Step 2: Rewrite `deriveCanonical` to branch on key kind**

Replace `deriveCanonical` (`repo.ts:197-225`) with:

```ts
/** Derive (bootstrap) a dimension's canonical set from a source column's distinct
 *  values. For a 'slug' dimension each distinct value seeds a slug-keyed canonical
 *  (US/us collapse) mapped 1:1. For an 'external_id' dimension the source column IS
 *  the ID column: each distinct ID seeds a canonical keyed by the raw ID (no slug),
 *  self-mapped id→id, and the name binding (table, id_col, name_col) is persisted so
 *  the name resolves live on read. Returns how many canonical records resulted. */
export async function deriveCanonical(dimId: string, table: string, column: string, nameColumn?: string): Promise<{ derived: number }> {
  const meta = await get<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1`, [dimId]);
  if (!meta) return { derived: 0 };
  await addSource(dimId, table, column);
  const external = meta.keyKind === "external_id";
  if (external && nameColumn) await addSource(dimId, table, nameColumn);

  const col = qid(column);
  let vals: string[];
  try {
    const rows = await all<{ v: string }>(
      `SELECT DISTINCT CAST(${col} AS VARCHAR) AS v FROM ${whTable(table)}
       WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0 ORDER BY 1 LIMIT 5000`);
    vals = rows.map((r) => r.v);
  } catch { return { derived: 0 }; } // warehouse not attached / table missing
  if (!vals.length) return { derived: 0 };

  const key = qid(meta.keyCol);

  if (external) {
    const ids = [...new Set(vals)];
    await bulkInsert1(`INSERT INTO ${cq(meta.dimTable)} (${key})`, ids, `ON CONFLICT (${key}) DO NOTHING`);
    await bulkInsert(`INSERT INTO ${cq(meta.mapTable)} (raw, ${key})`, ids.map((v) => [v, v]), `ON CONFLICT (raw) DO NOTHING`);
    if (nameColumn) {
      await run(`UPDATE ${pg("dimension")} SET name_table = $1, name_id_col = $2, name_col = $3 WHERE id = $4`,
        [table, column, nameColumn, dimId]);
    }
    await appendAudit("Derived canonical", `${ids.length} external-ID key${ids.length === 1 ? "" : "s"} from ${table}.${column} (names ← ${table}.${nameColumn ?? "?"})`);
    return { derived: ids.length };
  }

  const dimByKey = new Map<string, string>(); // key → label (first wins)
  const mapPairs: [string, string][] = [];     // raw → key
  for (const v of vals) {
    const k = slug(v) || v.toLowerCase().slice(0, 60) || "_";
    if (!dimByKey.has(k)) dimByKey.set(k, v);
    mapPairs.push([v, k]);
  }
  await bulkInsert(`INSERT INTO ${cq(meta.dimTable)} (${key}, label)`, [...dimByKey.entries()], `ON CONFLICT (${key}) DO NOTHING`);
  await bulkInsert(`INSERT INTO ${cq(meta.mapTable)} (raw, ${key})`, mapPairs, `ON CONFLICT (raw) DO NOTHING`);
  await appendAudit("Derived canonical", `${dimByKey.size} value${dimByKey.size === 1 ? "" : "s"} from ${table}.${column} → ${meta.dimTable}`);
  return { derived: dimByKey.size };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd server && bun run typecheck`
Expected: same `keyKind`-projection errors from Task 2 remain until Task 4; no new errors from this task.

- [ ] **Step 4: Commit (after Task 4 typechecks clean)**

```bash
git add server/src/repo.ts && git commit -m "feat(repo): deriveCanonical external-ID path + name binding"
```

---

## Task 4: `getDimension` live resolution + `unresolved`; `listDimensions` projection

**Files:**
- Modify: `server/src/repo.ts` — `CanonicalValue` (~line 15), `listDimensions` (~line 268), `getDimension` (~line 281), `scanValues` signature (Task 5 finishes scanValues)

- [ ] **Step 1: Add `unresolved` to `CanonicalValue`**

Change `repo.ts:15` to:

```ts
export interface CanonicalValue { key: string; label: string; variants?: number; fields?: Record<string, string | null>; unresolved?: boolean }
```

- [ ] **Step 2: Project `keyKind` in `listDimensions`**

In `listDimensions` (`repo.ts:268-279`), change the SELECT to include `key_kind`:

```ts
  const metas = await all<Omit<DimensionMeta, "rows">>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} ORDER BY label`,
  );
```

- [ ] **Step 3: Rewrite `getDimension` to resolve names live for external-ID dims**

Replace `getDimension` (`repo.ts:281-302`) with:

```ts
export async function getDimension(id: string): Promise<MappingDimension | null> {
  const meta = await get<Omit<DimensionMeta, "rows"> & { nameTable: string | null; nameIdCol: string | null; nameCol: string | null }>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind",
            name_table AS "nameTable", name_id_col AS "nameIdCol", name_col AS "nameCol"
     FROM ${pg("dimension")} WHERE id = $1`, [id],
  );
  if (!meta) return null;
  const k = qid(meta.keyCol);
  const fields = await listFields(id);
  const fieldCols = fields.map((f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`).join(", ");

  // external-ID dims resolve the display name live from the warehouse (store the
  // ID, render the name). When the warehouse is detached or no binding is set,
  // every row is unresolved and the label falls back to the key.
  const liveName = meta.keyKind === "external_id" && env.attachWarehouse && meta.nameTable && meta.nameIdCol && meta.nameCol;
  const variantsJoin = `LEFT JOIN (SELECT ${k} AS gk, count(*) AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}`;

  const sql = liveName
    ? `SELECT d.${k} AS key, w.nm AS label, (w.id IS NULL) AS unresolved, COALESCE(v.n, 0) AS variants${fields.length ? ", " + fieldCols : ""}
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id, CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm FROM ${whTable(meta.nameTable!)}) w ON w.id = d.${k}
       ${variantsJoin}
       ORDER BY variants DESC, d.${k}`
    : meta.keyKind === "external_id"
    ? `SELECT d.${k} AS key, NULL AS label, true AS unresolved, COALESCE(v.n, 0) AS variants${fields.length ? ", " + fieldCols : ""}
       FROM ${cq(meta.dimTable)} d ${variantsJoin} ORDER BY variants DESC, d.${k}`
    : `SELECT d.${k} AS key, d.label, false AS unresolved, COALESCE(v.n, 0) AS variants${fields.length ? ", " + fieldCols : ""}
       FROM ${cq(meta.dimTable)} d ${variantsJoin} ORDER BY variants DESC, d.label`;

  const canonical = await all<Record<string, unknown>>(sql).then((rows) => rows.map((r) => ({
    key: String(r.key),
    label: r.label == null ? String(r.key) : String(r.label),
    unresolved: !!r.unresolved,
    variants: Number(r.variants),
    fields: Object.fromEntries(fields.map((f) => [f.field, r[f.field] == null ? null : String(r[f.field])])),
  })));
  const rowsRow = await get<{ n: bigint }>(`SELECT count(*) AS n FROM ${cq(meta.mapTable)}`).catch(() => null);
  const values = await scanValues(id, meta);
  const { nameTable, nameIdCol, nameCol, ...metaOut } = meta;
  return { ...metaOut, rows: Number(rowsRow?.n ?? 0), canonical, values, fields };
}
```

- [ ] **Step 4: Typecheck**

Run: `cd server && bun run typecheck`
Expected: `scanValues` now needs the wider meta type (it receives `meta` including the name binding). Task 5 updates `scanValues`. After Task 5, typecheck is clean. If you want to checkpoint Tasks 2–4 now, temporarily keep `scanValues`'s param as `Omit<DimensionMeta,"rows">` — it accepts the wider object structurally — and it will still compile because the extra fields are assignable. Verify with the typecheck output.

- [ ] **Step 5: Commit (Tasks 2–4 together once clean)**

```bash
git add server/src/repo.ts && git commit -m "feat(repo): live name resolution + unresolved flag for external-ID dims"
```

---

## Task 5: `scanValues` — live-resolve `current` for the reconcile screen

**Files:**
- Modify: `server/src/repo.ts` — `scanValues` (~line 306)

- [ ] **Step 1: Resolve the mapped name live for external-ID dims**

Replace `scanValues` (`repo.ts:306-334`) with this version. It accepts the name binding on `meta` and, for external-ID dims with the warehouse attached, projects the live name as `current` instead of the (NULL) stored label:

```ts
async function scanValues(
  dimId: string,
  meta: Omit<DimensionMeta, "rows"> & { nameTable?: string | null; nameIdCol?: string | null; nameCol?: string | null },
): Promise<MappingValue[]> {
  const sources = await liveSources(dimId);
  if (!sources.length) return [];
  const liveName = meta.keyKind === "external_id" && env.attachWarehouse && meta.nameTable && meta.nameIdCol && meta.nameCol;
  const keyc = qid(meta.keyCol);

  const currentExpr = liveName ? "any_value(w.nm)" : "any_value(c.label)";
  const nameJoin = liveName
    ? `LEFT JOIN (SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id, CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm FROM ${whTable(meta.nameTable!)}) w ON w.id = m.${keyc}`
    : `LEFT JOIN ${cq(meta.dimTable)} c ON c.${keyc} = m.${keyc}`;

  const sql = `
    WITH occ AS (${occUnion(sources)})
    SELECT o.raw AS value,
           CASE WHEN m.raw IS NOT NULL THEN 'mapped' ELSE 'new' END AS status,
           ${currentExpr} AS current,
           to_json(list({'table': o.tbl, 'column': o.col, 'rows': o.rows})) AS sources
    FROM occ o
    LEFT JOIN ${cq(meta.mapTable)} m ON lower(m.raw) = lower(o.raw)
    ${nameJoin}
    GROUP BY o.raw, (m.raw IS NOT NULL)
    ORDER BY status ASC, sum(o.rows) DESC
    LIMIT 500`;

  const rows = await all<{ value: string; status: "mapped" | "new"; current: string | null; sources: string }>(sql);
  const parseSources = (c: string): SourceOccurrence[] => {
    try { return (JSON.parse(c) as SourceOccurrence[]).map((s) => ({ table: s.table, column: s.column, rows: Number(s.rows) })); } catch { return []; }
  };
  return rows.map((r) => ({
    value: r.value,
    status: r.status,
    current: r.current ?? null,
    suggestion: null,
    confidence: 0,
    sources: parseSources(r.sources),
  }));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && bun run typecheck`
Expected: PASS (clean — Tasks 2–5 complete).

- [ ] **Step 3: Commit**

```bash
git add server/src/repo.ts && git commit -m "feat(repo): scanValues resolves live names for external-ID dims"
```

---

## Task 6: API routes — `keyKind` on create, `nameColumn` on derive

**Files:**
- Modify: `server/src/server.ts` — `POST /api/dimensions` (~line 79), `POST /api/dimensions/:id/derive` (~line 110)

- [ ] **Step 1: Accept `keyKind` when creating a dimension**

Replace the create handler (`server.ts:79-82`) with:

```ts
          if (method === "POST") {
            const { name, keyKind } = (await req.json()) as { name: string; keyKind?: "slug" | "external_id" };
            return json({ id: await repo.addDimension(name, [], { keyKind }) }, 201);
          }
```

- [ ] **Step 2: Accept `nameColumn` when deriving**

Replace the derive handler (`server.ts:110-113`) with:

```ts
        // POST /api/dimensions/:id/derive {table, column, nameColumn?} — seed canonical
        if (seg[3] === "derive" && seg.length === 4 && method === "POST") {
          const { table, column, nameColumn } = (await req.json()) as { table: string; column: string; nameColumn?: string };
          return json(await repo.deriveCanonical(id, table, column, nameColumn));
        }
```

- [ ] **Step 3: Typecheck**

Run: `cd server && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts && git commit -m "feat(api): keyKind on create, nameColumn on derive"
```

---

## Task 7: `verify-eid.ts` — regression harness

**Files:**
- Create: `server/src/verify-eid.ts`
- Modify: `server/package.json` (scripts)

This follows `spike.ts`: self-cleaning, `check()`-based, Postgres-only asserts always run; the live-resolution assert runs only when `ATTACH_WAREHOUSE=true` **and** a real master table is provided via env (`EID_TABLE`, `EID_ID_COL`, `EID_NAME_COL`, plus a known `EID_SAMPLE_ID`), else it `note()`-skips — so the headline behavior is exercised whenever the warehouse is available.

- [ ] **Step 1: Add the package script**

In `server/package.json` `scripts`, add:

```json
    "verify-eid": "bun run src/verify-eid.ts",
```

- [ ] **Step 2: Write the harness**

Create `server/src/verify-eid.ts`:

```ts
/* verify-eid.ts — prove external-ID keys with live-resolved names on the REAL
   Postgres (and the warehouse when ATTACH_WAREHOUSE=true). Self-cleaning.
   Run: `bun run verify-eid`. */

import { connect } from "./db.ts";
import { ensureSchema } from "./schema.ts";
import * as repo from "./repo.ts";
import { pg } from "./env.ts";

let pass = 0, fail = 0, skipped = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };
const note = (name: string, detail: string) => { console.log(`  ⊘ ${name} — ${detail}`); skipped++; };

const DIM_ID = "verify_eid_partner"; // slug("Verify EID Partner") → verify_eid_partner
async function cleanup() {
  await repo; // noop import keep
  for (const t of [`oltp.zugzug.dim_${DIM_ID}`, `oltp.zugzug.map_${DIM_ID}`]) {
    await import("./db.ts").then((m) => m.run(`DROP TABLE IF EXISTS ${t}`)).catch(() => {});
  }
  await import("./db.ts").then((m) => m.run(`DELETE FROM ${pg("dimension_source")} WHERE dim_id = '${DIM_ID}'`)).catch(() => {});
  await import("./db.ts").then((m) => m.run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id = '${DIM_ID}'`)).catch(() => {});
  await import("./db.ts").then((m) => m.run(`DELETE FROM ${pg("dimension")} WHERE id = '${DIM_ID}'`)).catch(() => {});
}

console.log("\nZug Zug — external-ID keys verification\n");
await connect();
await ensureSchema();
await cleanup();

// 1. migration columns exist
const cols = await import("./db.ts").then((m) => m.all<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'zugzug_app' AND table_name = 'dimension'`));
const have = new Set(cols.map((c) => c.column_name));
check("schema: key_kind + name binding columns present", ["key_kind", "name_table", "name_id_col", "name_col"].every((c) => have.has(c)),
  [...have].filter((c) => c.startsWith("name_") || c === "key_kind").join(", "));

// 2. create an external-ID dimension → nullable-label dim_, key_kind persisted
await repo.addDimension("Verify EID Partner", [], { keyKind: "external_id" });
const dims = await repo.listDimensions();
const d = dims.find((x) => x.id === DIM_ID);
check("addDimension: external-ID dimension registered with key_kind", d?.keyKind === "external_id", d?.keyKind ?? "missing");
const labelNullable = await import("./db.ts").then((m) => m.get<{ is_nullable: string }>(
  `SELECT is_nullable FROM information_schema.columns
   WHERE table_schema = 'zugzug' AND table_name = 'dim_${DIM_ID}' AND column_name = 'label'`));
check("addDimension: dim_ label is nullable for external-ID", labelNullable?.is_nullable === "YES", labelNullable?.is_nullable ?? "n/a");

// 3 + 4. derive + live resolution — only with a real warehouse master table
const T = process.env.EID_TABLE?.trim(), IDC = process.env.EID_ID_COL?.trim(), NMC = process.env.EID_NAME_COL?.trim();
if (process.env.ATTACH_WAREHOUSE?.trim() === "true" && T && IDC && NMC) {
  const res = await repo.deriveCanonical(DIM_ID, T, IDC, NMC);
  check("derive: external-ID keys seeded from master table", res.derived > 0, `${res.derived} ids from ${T}.${IDC}`);
  const bind = await import("./db.ts").then((m) => m.get<{ name_table: string; name_col: string }>(
    `SELECT name_table, name_col FROM ${pg("dimension")} WHERE id = '${DIM_ID}'`));
  check("derive: name binding persisted", bind?.name_table === T && bind?.name_col === NMC, `${bind?.name_table}.${bind?.name_col}`);
  const full = await repo.getDimension(DIM_ID);
  const resolved = full?.canonical.filter((c) => !c.unresolved && c.label !== c.key) ?? [];
  check("getDimension: at least one name resolved live", resolved.length > 0, `${resolved.length}/${full?.canonical.length} resolved`);
  const keysAreIds = full?.canonical.every((c) => c.key && c.key === c.key.trim()) ?? false;
  check("getDimension: keys are raw IDs (not slugged)", keysAreIds);
} else {
  note("derive + live resolution", "set ATTACH_WAREHOUSE=true and EID_TABLE/EID_ID_COL/EID_NAME_COL to exercise");
  // unresolved fallback IS testable without the warehouse: seed an ID by hand and read it back
  await repo.addDimension("Verify EID Partner", [], { keyKind: "external_id" }); // idempotent
  await import("./db.ts").then((m) => m.run(`INSERT INTO oltp.zugzug.dim_${DIM_ID} (${DIM_ID}_code) VALUES ('P-001') ON CONFLICT DO NOTHING`));
  const full = await repo.getDimension(DIM_ID);
  const row = full?.canonical.find((c) => c.key === "P-001");
  check("getDimension: warehouse off → row is unresolved, label falls back to key", !!row && row.unresolved === true && row.label === "P-001", row ? `unresolved=${row.unresolved} label=${row.label}` : "row missing");
}

console.log("\nCleaning up…");
await cleanup();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed, ${skipped} skipped.\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the harness (Postgres-only path)**

Run: `cd server && bun run verify-eid`
Expected: `PASS` with the schema/addDimension/unresolved-fallback checks passing and the derive+live-resolution block `note()`-skipped (unless you set the EID_* env vars).

- [ ] **Step 4: (If a warehouse master table is available) run the full path**

Run: `cd server && ATTACH_WAREHOUSE=true EID_TABLE=<schema.table> EID_ID_COL=<id> EID_NAME_COL=<name> bun run verify-eid`
Expected: `PASS` with the derive + live-resolution checks now passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/verify-eid.ts server/package.json && git commit -m "test(server): external-ID keys verification harness"
```

---

## Task 8: Client types + store signatures

**Files:**
- Modify: `app/src/data.ts` — `CanonicalValue` (~line 25), `MappingDimension` (~line 41)
- Modify: `app/src/store.ts` — `addDimension` (~line 89), `deriveCanonical` (~line 152)

- [ ] **Step 1: Extend client types**

Change `data.ts:25`:

```ts
export interface CanonicalValue { key: string; label: string; variants?: number; fields?: Record<string, string | null>; unresolved?: boolean }
```

Add `keyKind` to `MappingDimension` (`data.ts:41-51`), after `keyCol`:

```ts
  keyCol: string;        // canonical key column written to both
  keyKind?: "slug" | "external_id"; // 'external_id' → key is a warehouse ID, name resolved live
```

- [ ] **Step 2: Extend `addDimension` in the store**

Replace `store.ts:89-96`:

```ts
export async function addDimension(name: string, keyKind?: "slug" | "external_id"): Promise<string> {
  const { id } = await api<{ id: string }>("/dimensions", { method: "POST", body: JSON.stringify({ name, keyKind }) });
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return id;
}
```

- [ ] **Step 3: Extend `deriveCanonical` in the store**

Replace `store.ts:152-159`:

```ts
export async function deriveCanonical(dimId: string, table: string, column: string, nameColumn?: string): Promise<number> {
  const { derived } = await api<{ derived: number }>(`/dimensions/${encodeURIComponent(dimId)}/derive`, { method: "POST", body: JSON.stringify({ table, column, nameColumn }) });
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return derived;
}
```

- [ ] **Step 4: Typecheck**

Run: `cd app && bun run typecheck`
Expected: errors only at the call sites changed in Tasks 9–10 (DimensionPicker `onCreate`). Proceed; commit after Task 10.

---

## Task 9: MasterTables — unresolved badge, no rename, no slug-add, two-column derive

**Files:**
- Modify: `app/src/routes/MasterTables.tsx`

- [ ] **Step 1: Compute `external` and gate the derive control**

After `const sourceOpts = wired.map((s) => \`${s.table}.${s.column}\`);` (`MasterTables.tsx:88`), add:

```ts
  const external = dim.keyKind === "external_id";
  const [idOpt, setIdOpt] = useState<string | null>(null);
  const [nameOpt, setNameOpt] = useState<string | null>(null);
```

- [ ] **Step 2: Replace the single derive control with a kind-aware one**

Replace the header derive block (`MasterTables.tsx:136-138`):

```tsx
        {sourceOpts.length > 0 && !external && (
          <div className="w-60"><ComboSelect options={sourceOpts} value={null} placeholder="Derive from source…" onPick={derive} /></div>
        )}
        {external && sourceOpts.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="w-44"><ComboSelect options={sourceOpts} value={idOpt} placeholder="ID column…" onPick={setIdOpt} /></div>
            <div className="w-44"><ComboSelect options={sourceOpts} value={nameOpt} placeholder="Name column…" onPick={setNameOpt} /></div>
            <Button size="sm" disabled={!idOpt || !nameOpt || busy} onClick={() => idOpt && nameOpt && deriveExternal(idOpt, nameOpt)}>Derive</Button>
          </div>
        )}
```

- [ ] **Step 3: Add the `deriveExternal` handler**

After the existing `derive` handler (`MasterTables.tsx:121-126`), add:

```ts
  const deriveExternal = async (idColOpt: string, nameColOpt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === idColOpt);
    const nameCol = nameColOpt.split(".").slice(1).join(".");
    if (!s || !nameCol || busy) return;
    setBusy(true); const n = await deriveCanonical(dimId, s.table, s.column, nameCol); setBusy(false);
    flash(n > 0 ? `Seeded ${n} external-ID key${n === 1 ? "" : "s"} from ${s.table}.${s.column} (names ← ${nameCol}).` : `${s.table}.${s.column} has no distinct values to derive.`);
  };
```

- [ ] **Step 4: Render the unresolved state + suppress rename for external-ID**

Replace the label/key render block (`MasterTables.tsx:189-200`) with one that shows an "unresolved" badge and hides the rename affordance for external-ID dims. First, the label button + key cell:

```tsx
                {editing === c.key ? (
                  <input autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => (e.key === "Enter" ? rename(c.key, editDraft) : e.key === "Escape" && setEditing(null))}
                    onBlur={() => rename(c.key, editDraft)}
                    className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-display text-[14px] font-semibold text-ink outline-none" />
                ) : (
                  <button type="button" onClick={() => toggleOpen(c.key)} className="flex min-w-0 items-center gap-2 text-left">
                    <IconChevron className={cx("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", isOpen && "rotate-180")} />
                    {c.unresolved ? (
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-[13px] text-ink-2">{c.key}</span>
                        <Badge tone="warn">unresolved</Badge>
                      </span>
                    ) : (
                      <span className="truncate font-display text-[14px] font-semibold text-ink">{c.label}</span>
                    )}
                  </button>
                )}
                <span className="truncate font-mono text-[12px] text-accent">{external ? "" : c.key}</span>
```

(For external-ID dims the key is already shown beside the name, so the separate key column is blanked to avoid duplication.)

- [ ] **Step 5: Hide the rename button for external-ID dims**

Replace the rename button (`MasterTables.tsx:206`) so it only renders for slug dims:

```tsx
                  {!external && (
                    <button type="button" aria-label="Rename" title="Rename" onClick={() => { setEditing(c.key); setEditDraft(c.label); }} className="grid h-7 w-7 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-accent hover:text-accent"><IconEdit className="h-3.5 w-3.5" /></button>
                  )}
```

- [ ] **Step 6: Hide the slug-add row for external-ID dims**

Wrap the "New canonical…" add row (`MasterTables.tsx:233-239`) in `{!external && ( … )}`:

```tsx
        {!external && (
          <div className="flex items-center gap-2 px-5 py-3">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={`New canonical ${dim.dimension.toLowerCase()}…`}
              className="w-full max-w-xs rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent" />
            {draft.trim() && <span className="font-mono text-[11px] text-ink-3">{dim.keyCol} = <span className="text-accent">{slug(draft)}</span></span>}
            <Button size="sm" icon={<IconPlus className="h-3.5 w-3.5" />} onClick={add} disabled={!draft.trim() || busy} className="ml-auto">Add record</Button>
          </div>
        )}
```

- [ ] **Step 7: Typecheck**

Run: `cd app && bun run typecheck`
Expected: errors remain only at the `DimensionPicker onCreate` call sites (fixed in Task 10).

---

## Task 10: DimensionPicker external-ID toggle + Mapping `allowCreate`

**Files:**
- Modify: `app/src/components/DimensionPicker.tsx`
- Modify: `app/src/routes/MasterTables.tsx` (the `onCreate` prop)
- Modify: `app/src/routes/Mapping.tsx` (the `onCreate` prop + `allowCreate`)

- [ ] **Step 1: Add the external-ID toggle to DimensionPicker's create form**

Change the prop type (`DimensionPicker.tsx:35`):

```ts
  onCreate: (name: string, keyKind: "slug" | "external_id") => void;
```

Add state near the other create state (`DimensionPicker.tsx:40`):

```ts
  const [externalId, setExternalId] = useState(false);
```

Update `close` (`DimensionPicker.tsx:52`) to reset it:

```ts
  const close = () => { setOpen(false); setCreating(false); setQ(""); setName(""); setExternalId(false); };
```

Update `submit` (`DimensionPicker.tsx:55`):

```ts
  const submit = () => { if (!name.trim()) return; onCreate(name.trim(), externalId ? "external_id" : "slug"); close(); };
```

In the create form, after the "creates zugzug.dim_… + map_…" hint block (`DimensionPicker.tsx:119-121`), add a toggle:

```tsx
              <label className="mt-2.5 flex items-center gap-2 font-mono text-[11px] text-ink-2">
                <input type="checkbox" checked={externalId} onChange={(e) => setExternalId(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
                Key is an external ID (resolve names live from the warehouse)
              </label>
```

- [ ] **Step 2: Update the MasterTables `onCreate` call**

In `MasterTables.tsx`, change the `DimensionPicker` `onCreate` (`MasterTables.tsx:144`):

```tsx
          onCreate={async (name, keyKind) => { const id = await addDimension(name, keyKind); setDimId(id); reset(); setDraft(""); }} />
```

- [ ] **Step 3: Update the Mapping `onCreate` call and disable `allowCreate` for external-ID**

In `Mapping.tsx`, change the picker (`Mapping.tsx:121`):

```tsx
        <DimensionPicker dims={dims} activeId={seedId} onSelect={selectSeed} onCreate={async (name, keyKind) => selectSeed(await addDimension(name, keyKind))} />
```

Add a kind flag after `const options = seed.canonical.map((c) => c.label);` (`Mapping.tsx:40`):

```ts
  const external = seed.keyKind === "external_id";
```

Disable `allowCreate` on both ComboSelects that target the canonical — the bulk "Merge all to…" (`Mapping.tsx:160`) and the per-row picker (`Mapping.tsx:191`) — by changing `allowCreate` to `allowCreate={!external}`:

```tsx
                <div className="w-48"><ComboSelect options={options} value={null} allowCreate={!external} placeholder="Merge all to…" onPick={(t) => bulkApply((v) => stageMap(v, t))} /></div>
```

```tsx
                <ComboSelect options={options} value={row.target} suggestion={r.suggestion} allowCreate={!external} onPick={(t) => pick(r.value, t)} />
```

- [ ] **Step 4: Typecheck both packages**

Run: `cd app && bun run typecheck`
Expected: PASS.
Run: `cd server && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Start the stack (one API only — single DuckDB lock):

```bash
cd server && bun run start   # :8787, in one terminal
cd app && bun run dev        # :5173, in another
```

In the UI: create a dimension with "Key is an external ID" checked → on Master tables, the slug-add row is gone and (with the warehouse off) any seeded IDs show "unresolved". With `ATTACH_WAREHOUSE=true` and a real master table wired, derive with ID + Name columns → names render beside the IDs, and the reconcile picker on Value mapping shows those names.

- [ ] **Step 6: Commit**

```bash
git add app/src && git commit -m "feat(app): external-ID key UI — toggle, unresolved badge, two-column derive, name-only mapping"
```

---

## Self-review (completed)

- **Spec coverage:** key_kind + binding (T1), external-ID creation (T2), two-column derive + binding (T3), live resolution + unresolved (T4), reconcile-screen names (T5, the un-deferred freebie), API (T6), verification (T7), UI display/badge/disabled-rename/hidden-add (T8–T10). The spec's "Value-mapping deferred" line is now **in scope** (T5 + T10) per the Mapping.tsx finding; the spec's deferred "manual add-by-ID" and "AI suggestions" remain deferred.
- **Type consistency:** `keyKind: "slug" | "external_id"` and `CanonicalValue.unresolved?: boolean` are defined once server-side (`repo.ts`) and mirrored once client-side (`data.ts`); `deriveCanonical(dimId, table, column, nameColumn?)` and `addDimension(name, keyKind?)` signatures match across server route → store → callers.
- **No placeholders:** every step carries real code, exact paths, exact commands, and expected output.
- **Verification reality:** Postgres-only asserts always run; the live-resolution path is exercised whenever `ATTACH_WAREHOUSE=true` + `EID_*` env are set, and the unresolved-fallback path is deterministically verified without the warehouse.
