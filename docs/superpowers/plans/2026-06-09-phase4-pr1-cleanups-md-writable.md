# Phase 4 PR 1 — Cleanups + MotherDuck-writable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the cosmetic BC-isms (seed data, UI copy, engineer-mode default) and make MotherDuck users with writable tokens get warehouse-mode commits (drop the hard-coded read-only constraint on `DuckDbAdapter`).

**Architecture:** Five orthogonal changes. The biggest is splitting `DuckDbAdapter` into `DuckDbReadOnlyAdapter` (current shape, implements `ReadOnlyWarehouseAdapter`) + `DuckDbWritableAdapter` (new, implements `WritableWarehouseAdapter` via DuckDB `MERGE INTO` — same chunked pattern as Phase 2's `SnowflakeAdapter`). Shared connection/serialization/query helpers move into a base class; the factory returns the right variant based on `creds.writable`. The frontend's `useEngineerMode` is extended to read the server-provided default when no user preference is stored, surfaced via the existing `/api/workspace/info` endpoint (also gains `allowedDomain` for the Settings copy scrub — `/api/auth/config` doesn't exist yet, lands in PR 2).

**Tech Stack:** Bun + TypeScript strict, `@duckdb/node-api` (incl. DuckDB 0.10+ MERGE INTO support), Zod, React + Vite + vitest + @testing-library/react.

**Spec reference:** `docs/superpowers/specs/2026-06-09-phase4-strip-bc-isms-design.md` (PR 1 section).

**Verification gate (must all pass at end of phase):**

1. `cd server && bun run typecheck` — clean.
2. `cd server && bun run lint` — clean.
3. `cd server && bun run format:check` — clean.
4. `cd server && bun run test` — all existing tests pass + new DuckDB-writable + extended commit-branch tests.
5. `cd app && bun run typecheck` — clean.
6. `cd app && bun run format:check` — clean.
7. `cd app && bun run test` — all existing tests pass + new copy-scrub + engineer-mode-default tests.
8. `cd server && timeout 5 bun run start 2>&1 | head -10 || true` — boots cleanly.
9. `grep -rn "Better Collective\|bettercollective" server/src/ app/src/ 2>&1 | grep -v "test/" | grep -v "node_modules"` — zero matches (except possibly inline comments calling out the historical context, which are fine).
10. `grep -rn "DuckDbAdapter" server/src/ 2>&1 | grep -v "test/"` — zero matches; replaced by `DuckDbReadOnlyAdapter` and `DuckDbWritableAdapter`.

---

## File structure (post-phase)

```
server/
  .env.example                                  # MODIFIED — adds MOTHERDUCK_WRITABLE, DEFAULT_ENGINEER_MODE
server/src/
  env.ts                                        # MODIFIED — adds motherduckWritable, defaultEngineerMode
  seed.ts                                       # REWRITTEN — generic e-commerce
  warehouse/credentials.ts                      # MODIFIED — adds writable?: boolean to DuckDbCredentials
  warehouse/registry.ts                         # MODIFIED — reads env.motherduckWritable
  warehouse/duckdb/
    index.ts                                    # MODIFIED — now barrel-exports the two new classes + retains base
    base.ts                                     # NEW — shared connection/serialization/query helpers
    read-only.ts                                # NEW — DuckDbReadOnlyAdapter (current shape, refactored to use base)
    writable.ts                                 # NEW — DuckDbWritableAdapter (extends base + write methods)
  server.ts                                     # MODIFIED — workspace/info adds defaultEngineerMode + allowedDomain; factory uses creds.writable
  bootstrap.ts                                  # MODIFIED — same factory split
server/test/
  warehouse-duckdb.test.ts                      # MODIFIED — split into RO + Writable describe blocks; writable tests
  commit-warehouse-branch.test.ts               # MODIFIED — adds DuckDB-writable case alongside Snowflake mock
app/src/
  store.ts                                      # MODIFIED — WorkspaceInfo gains defaultEngineerMode + allowedDomain; validator updated
  lib/engineer-mode.tsx                         # MODIFIED — reads server default when no localStorage; null-safe initial state
  routes/Login.tsx                              # MODIFIED — copy scrub (remove "Better Collective"); allowedDomain derived
  routes/Settings.tsx                           # MODIFIED — ALLOWED_DOMAIN derived from useWorkspaceInfo; placeholder text generic
app/test/
  engineer-mode-default.test.tsx                # NEW — server default applied when no localStorage
  login-copy.test.tsx                           # NEW — copy scrub assertions
```

---

## Task 1: Add `MOTHERDUCK_WRITABLE` and `DEFAULT_ENGINEER_MODE` env vars

**Files:**
- Modify: `server/src/env.ts`
- Modify: `server/.env.example`

- [ ] **Step 1: Read the current env.ts**

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/src/env.ts` to see the existing structure (the `env` object with all fields and their `process.env.X?.trim() === "true"` pattern).

- [ ] **Step 2: Add two new fields**

In `server/src/env.ts`, inside the `export const env = {...}` block, add (alongside `attachWarehouse`):

```ts
/** When true, the DuckDB adapter is writable (canonical → MotherDuck via MERGE).
 *  Off by default; flip to `true` only when MotherDuck token has write access. */
motherduckWritable: process.env.MOTHERDUCK_WRITABLE?.trim() === "true",

/** Default value of the engineer-mode toggle for users who haven't set a
 *  preference yet. OSS default: true. BC override: DEFAULT_ENGINEER_MODE=false. */
defaultEngineerMode: process.env.DEFAULT_ENGINEER_MODE?.trim() !== "false",
```

Note the subtle inversion on `defaultEngineerMode`: we want it to default to `true` when unset, and only flip to `false` when the env var is literally `"false"`. Hence `!== "false"` instead of `=== "true"`.

- [ ] **Step 3: Update `.env.example`**

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/.env.example` and append (at the end, or grouped with related vars):

```bash
# MotherDuck-writable mode — flip to "true" only if your MotherDuck token has
# write access. When true, commits write dim_*/map_* records to your MotherDuck
# database (canonical destination = warehouse). When false (default), canonical
# lives in Postgres and snapshots are downloadable on demand.
MOTHERDUCK_WRITABLE=false

# Engineer-mode default — when "false", hides warehouse internals (table names,
# SQL, MERGE/JOIN copy) for non-technical analysts. Each user can override this
# in Settings. Default: true (engineer details shown).
DEFAULT_ENGINEER_MODE=true
```

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/env.ts server/.env.example
git commit -m "feat(env): add MOTHERDUCK_WRITABLE and DEFAULT_ENGINEER_MODE flags"
```

---

## Task 2: Add `writable` to `DuckDbCredentials` Zod schema

**Files:**
- Modify: `server/src/warehouse/credentials.ts`

- [ ] **Step 1: Read current credentials.ts**

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/src/warehouse/credentials.ts` to find `DuckDbCredentials`.

- [ ] **Step 2: Add `writable` field**

Modify the schema:

```ts
export const DuckDbCredentials = z.object({
  type: z.literal("duckdb"),
  // Either a MotherDuck token (cloud) OR a local file path / :memory:
  token: z.string().optional(),
  path: z.string().optional(),
  // The catalog name on MotherDuck side ("analytics", etc.). Used when qualifying refs.
  database: z.string().optional(),
  // When true, the adapter scans the warehouse; when false, scan methods return [].
  // Mirrors today's ATTACH_WAREHOUSE flag.
  attached: z.boolean().default(false),
  // When true, the adapter implements WritableWarehouseAdapter — commit() writes
  // canonical dim_*/map_* into the MotherDuck database via MERGE INTO. Off by
  // default; safe to flip on only when the MotherDuck token has write access.
  writable: z.boolean().default(false),
});
```

`DuckDbCreds = z.infer<typeof DuckDbCredentials>` automatically picks up the new field.

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean — nothing consumes the new field yet, so no downstream errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/warehouse/credentials.ts
git commit -m "feat(warehouse): add writable field to DuckDbCredentials schema"
```

---

## Task 3: Update `registry.ts` to wire `MOTHERDUCK_WRITABLE` env into credentials

**Files:**
- Modify: `server/src/warehouse/registry.ts`

- [ ] **Step 1: Read current registry.ts**

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/src/warehouse/registry.ts` to find `envCredentials()`.

- [ ] **Step 2: Add `writable` to the returned creds**

Find the `envCredentials()` function and add the new field:

```ts
function envCredentials(): WarehouseCredentials {
  return {
    type: "duckdb",
    token: env.motherduckToken,
    path: env.duckPath,
    database: env.warehouseDb,
    attached: env.attachWarehouse,
    writable: env.motherduckWritable,
  };
}
```

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/warehouse/registry.ts
git commit -m "feat(warehouse): wire MOTHERDUCK_WRITABLE env into DuckDb credentials"
```

---

## Task 4: Extract `DuckDbAdapter` shared logic into a base class

**Files:**
- Create: `server/src/warehouse/duckdb/base.ts`
- Modify: `server/src/warehouse/duckdb/index.ts` (to be refactored further in Task 5)

This task extracts the shared connection/serialization/query/helper code from the current `DuckDbAdapter` into a base class. The current `DuckDbAdapter` class stays in `index.ts` for now (Task 5 splits it).

- [ ] **Step 1: Read current adapter**

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/src/warehouse/duckdb/index.ts` end-to-end.

- [ ] **Step 2: Create `base.ts`**

Create `server/src/warehouse/duckdb/base.ts` with EXACT content:

```ts
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import type {
  AdapterCapabilities,
  CatalogTable,
  ColumnMeta,
  Ref,
  ValueCount,
  ValueProvenance,
} from "../adapter.ts";
import type { DuckDbCreds } from "../credentials.ts";

// The DuckDB Node API decodes LIST columns into `DuckDBListValue` wrappers
// rather than plain arrays. Normalize to a string[] regardless of shape.
export function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object" && "items" in v) {
    const items = (v as { items?: unknown }).items;
    if (Array.isArray(items)) return items.map(String);
  }
  return [];
}

/** Shared connection + helpers for both DuckDb adapter variants (read-only
 *  and writable). Owns the in-process DuckDB connection lifecycle and the
 *  serialized query queue. Subclasses implement the read methods (and, for
 *  the writable variant, the write methods). */
export abstract class DuckDbBase {
  abstract readonly capabilities: AdapterCapabilities;

  protected readonly creds: DuckDbCreds;
  protected conn: DuckDBConnection | null = null;
  protected connecting: Promise<DuckDBConnection> | null = null;
  protected queue: Promise<unknown> = Promise.resolve();

  constructor(creds: DuckDbCreds) {
    this.creds = creds;
  }

  // ---- helpers (used by both subclasses) ----

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  qualifyRef(table: Ref): string {
    const parts: string[] = [];
    const catalog = table.catalog ?? this.creds.database;
    if (catalog) parts.push(this.quoteIdentifier(catalog));
    parts.push(this.quoteIdentifier(table.schema));
    parts.push(this.quoteIdentifier(table.table));
    return parts.join(".");
  }

  castToString(expr: string): string {
    return `CAST(${expr} AS VARCHAR)`;
  }

  async ping(): Promise<boolean> {
    try {
      const row = await this.get<{ ok: number }>("SELECT 1 AS ok");
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  // ---- connection lifecycle ----

  protected async connect(): Promise<DuckDBConnection> {
    if (this.conn) return this.conn;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const inst = await DuckDBInstance.create(this.creds.path ?? ":memory:");
      const c = await inst.connect();
      if (this.creds.attached && this.creds.token) {
        await c.run(`INSTALL motherduck`);
        await c.run(`LOAD motherduck`);
        process.env.motherduck_token = this.creds.token;
        await c.run(`ATTACH IF NOT EXISTS 'md:'`);
      }
      this.conn = c;
      return c;
    })();
    return this.connecting;
  }

  protected serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  protected async all<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T[]> {
    return this.serialized(async () => {
      const c = await this.connect();
      const r = await c.runAndReadAll(sql, params);
      return r.getRowObjects() as T[];
    });
  }

  protected async get<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  protected async run(sql: string, params: DuckDBValue[] = []): Promise<void> {
    return this.serialized(async () => {
      const c = await this.connect();
      await c.run(sql, params);
    });
  }

  // ---- read methods (shared between both subclasses) ----

  async tableExists(table: Ref): Promise<boolean> {
    try {
      await this.all(`SELECT 1 FROM ${this.qualifyRef(table)} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  async listTables(opts: { schema?: string; search?: string } = {}): Promise<CatalogTable[]> {
    if (this.creds.attached && !this.creds.database) {
      return [];
    }
    const targetDb = this.creds.attached ? this.creds.database! : null;
    const params: DuckDBValue[] = [];
    let where = `name NOT LIKE '\\_dlt%' ESCAPE '\\'`;
    if (targetDb) {
      params.push(targetDb);
      where += ` AND database = $${params.length}`;
    }
    if (opts.schema) {
      params.push(opts.schema);
      where += ` AND schema = $${params.length}`;
    }
    if (opts.search) {
      params.push(`%${opts.search}%`);
      const p = `$${params.length}`;
      where += ` AND (schema ILIKE ${p} OR name ILIKE ${p} OR len(list_filter(column_names, c -> c ILIKE ${p})) > 0)`;
    }
    const rows = await this.all<{ schema: string; name: string; column_names: unknown }>(
      `SELECT schema, name, column_names FROM (SHOW ALL TABLES) WHERE ${where} ORDER BY schema, name LIMIT 5000`,
      params,
    );
    return rows.map((r) => ({
      schema: r.schema,
      table: r.name,
      columns: toStringList(r.column_names),
    }));
  }

  async listColumns(table: Ref): Promise<ColumnMeta[]> {
    const sql = `DESCRIBE ${this.qualifyRef(table)}`;
    const rows = await this.all<{ column_name: string; column_type: string }>(sql);
    return rows.map((r) => ({ name: r.column_name, type: r.column_type }));
  }

  async distinctValues(table: Ref, column: string, limit: number): Promise<string[]> {
    const col = this.quoteIdentifier(column);
    const n = Math.max(1, Math.min(100000, Math.round(limit)));
    const rows = await this.all<{ v: string }>(
      `SELECT DISTINCT ${this.castToString(col)} AS v
         FROM ${this.qualifyRef(table)}
         WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0
         ORDER BY 1
         LIMIT ${n}`,
    );
    return rows.map((r) => r.v);
  }

  async topValuesByFrequency(table: Ref, column: string, limit: number): Promise<ValueCount[]> {
    const col = this.quoteIdentifier(column);
    const n = Math.max(1, Math.min(10000, Math.round(limit)));
    const rows = await this.all<{ v: string; n: bigint }>(
      `SELECT ${this.castToString(col)} AS v, count(*) AS n
         FROM ${this.qualifyRef(table)}
         WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0
         GROUP BY 1
         ORDER BY n DESC, v
         LIMIT ${n}`,
    );
    return rows.map((r) => ({ value: r.v, count: Number(r.n) }));
  }

  async columnStats(
    table: Ref,
    column: string,
    _opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }> {
    const col = this.quoteIdentifier(column);
    const row = await this.get<{ rows: bigint; d: bigint }>(
      `SELECT count(${col}) AS rows, count(DISTINCT ${col}) AS d
         FROM ${this.qualifyRef(table)}
         WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0`,
    );
    return { rows: Number(row?.rows ?? 0), distinct: Number(row?.d ?? 0) };
  }

  async nameResolution(table: Ref, idCol: string, nameCol: string): Promise<Map<string, string>> {
    const id = this.quoteIdentifier(idCol);
    const nm = this.quoteIdentifier(nameCol);
    // Last-write-wins on duplicate ids (denormalized name tables are common — caller must accept any matching row).
    const rows = await this.all<{ id: string; nm: string }>(
      `SELECT ${this.castToString(id)} AS id, ${this.castToString(nm)} AS nm
         FROM ${this.qualifyRef(table)}
         WHERE ${id} IS NOT NULL`,
    );
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.id, r.nm);
    return out;
  }

  async distinctValuesWithProvenance(
    sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    if (sources.length === 0) return [];
    const branches = sources.map((s, i) => {
      const col = this.quoteIdentifier(s.column);
      return `SELECT ${this.castToString(col)} AS v, ${i} AS src_idx, count(*) AS n
                FROM ${this.qualifyRef(s.table)}
                WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0
                GROUP BY 1`;
    });
    const sql = branches.join("\nUNION ALL\n");
    const rows = await this.all<{ v: string; src_idx: number; n: bigint }>(sql);
    return rows.map((r) => ({
      value: r.v,
      sourceIndex: Number(r.src_idx),
      count: Number(r.n),
    }));
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean (the existing `DuckDbAdapter` in `index.ts` still has its own copies; no consumer touches `DuckDbBase` yet).

- [ ] **Step 4: Commit**

```bash
git add server/src/warehouse/duckdb/base.ts
git commit -m "feat(duckdb): extract shared DuckDbBase class with connection + read methods"
```

---

## Task 5: Split `DuckDbAdapter` into `DuckDbReadOnlyAdapter` + `DuckDbWritableAdapter`

**Files:**
- Create: `server/src/warehouse/duckdb/read-only.ts`
- Create: `server/src/warehouse/duckdb/writable.ts`
- Modify: `server/src/warehouse/duckdb/index.ts`
- Modify: `server/src/server.ts`
- Modify: `server/src/bootstrap.ts`
- Modify: `server/test/warehouse-duckdb.test.ts`

This task is structural: the old `DuckDbAdapter` class disappears, replaced by two specialized classes inheriting `DuckDbBase`. Tests adapt to the new imports. The writable variant has stub `ensureCanonicalTables`/`commitCanonical` methods (throw "Task 6/7" markers); they get real implementations in Tasks 6 and 7.

- [ ] **Step 1: Create `read-only.ts`**

Create `server/src/warehouse/duckdb/read-only.ts` with EXACT content:

```ts
import type { AdapterCapabilities, ReadOnlyWarehouseAdapter } from "../adapter.ts";
import { DuckDbBase } from "./base.ts";

/** DuckDB adapter that only reads from the warehouse. Canonical writes go
 *  to Postgres; users download Parquet snapshots when they want a file copy.
 *  This is the default when MOTHERDUCK_WRITABLE=false (or local DuckDB). */
export class DuckDbReadOnlyAdapter extends DuckDbBase implements ReadOnlyWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false } = {
    id: "duckdb",
    writable: false,
    supportsMerge: false,
    identifierCase: "preserve",
    supportsApproximateDistinct: false,
  };
}
```

- [ ] **Step 2: Create `writable.ts`** (stub implementations; real ones in Tasks 6+7)

Create `server/src/warehouse/duckdb/writable.ts` with EXACT content:

```ts
import type {
  AdapterCapabilities,
  ApprovedDraft,
  CommitResult,
  DimensionSpec,
  WritableWarehouseAdapter,
} from "../adapter.ts";
import { DuckDbBase } from "./base.ts";

/** DuckDB adapter that writes canonical dim_*/map_* records back to the
 *  warehouse (MotherDuck or local). Enabled when MOTHERDUCK_WRITABLE=true
 *  (or for a local DuckDB file with `writable: true`). */
export class DuckDbWritableAdapter extends DuckDbBase implements WritableWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true } = {
    id: "duckdb",
    writable: true,
    supportsMerge: true,
    identifierCase: "preserve",
    supportsApproximateDistinct: false,
  };

  async ensureCanonicalTables(_dim: DimensionSpec): Promise<void> {
    throw new Error("DuckDbWritableAdapter — Task 6");
  }

  async commitCanonical(_dim: DimensionSpec, _drafts: ApprovedDraft[]): Promise<CommitResult> {
    throw new Error("DuckDbWritableAdapter — Task 7");
  }
}
```

- [ ] **Step 3: Replace `index.ts` with a barrel + factory**

REPLACE the ENTIRE contents of `server/src/warehouse/duckdb/index.ts` with:

```ts
import type { WarehouseAdapter } from "../adapter.ts";
import type { DuckDbCreds } from "../credentials.ts";
import { DuckDbReadOnlyAdapter } from "./read-only.ts";
import { DuckDbWritableAdapter } from "./writable.ts";

export { DuckDbReadOnlyAdapter } from "./read-only.ts";
export { DuckDbWritableAdapter } from "./writable.ts";
export { DuckDbBase, toStringList } from "./base.ts";

/** Factory: returns the right adapter variant based on credentials.writable.
 *  Used by server.ts and bootstrap.ts's registerFactories() calls. */
export function createDuckDbAdapter(creds: DuckDbCreds): WarehouseAdapter {
  return creds.writable
    ? new DuckDbWritableAdapter(creds)
    : new DuckDbReadOnlyAdapter(creds);
}
```

- [ ] **Step 4: Update `server.ts` factory wiring**

Open `server/src/server.ts`. Find:

```ts
import { DuckDbAdapter } from "./warehouse/duckdb/index.ts";
```

Replace with:

```ts
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
```

Then in the `registerFactories({...})` call, replace:

```ts
duckdb: async (creds) => new DuckDbAdapter(creds),
```

with:

```ts
duckdb: async (creds) => createDuckDbAdapter(creds),
```

- [ ] **Step 5: Same wiring update in `bootstrap.ts`**

Open `server/src/bootstrap.ts`. Repeat the import + factory edits from Step 4.

- [ ] **Step 6: Update existing tests**

Open `server/test/warehouse-duckdb.test.ts`. The current tests import `DuckDbAdapter`. Replace with:

```ts
import { DuckDbReadOnlyAdapter } from "../src/warehouse/duckdb/index.ts";
```

Then find every `new DuckDbAdapter(...)` in the file and replace with `new DuckDbReadOnlyAdapter(...)`. Use sed or careful manual edits — there are ~14 callsites.

Note the test fixture `withFixture` reaches into the private `connect()` method via a string-indexed bracket access (`a["connect"]()`). This still works on `DuckDbReadOnlyAdapter` because the inherited `connect` is `protected` in `DuckDbBase` — bracket access bypasses TypeScript's privacy.

- [ ] **Step 7: Run tests, verify they pass**

```bash
cd server && bun run test test/warehouse-duckdb.test.ts
```
Expected: all existing tests pass (17 tests).

- [ ] **Step 8: Run full server test suite**

```bash
cd server && bun run test
```
Expected: all tests pass (no behavioral regressions; the read-only path is structurally identical).

- [ ] **Step 9: Typecheck + lint + format**

```bash
cd server && bun run typecheck && bun run lint && bun run format:check
```
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add server/src/warehouse/duckdb/ server/src/server.ts server/src/bootstrap.ts server/test/warehouse-duckdb.test.ts
git commit -m "refactor(duckdb): split adapter into read-only and writable variants"
```

---

## Task 6: Implement `DuckDbWritableAdapter.ensureCanonicalTables`

**Files:**
- Modify: `server/src/warehouse/duckdb/writable.ts`
- Modify: `server/test/warehouse-duckdb.test.ts`

Mirrors `SnowflakeAdapter.ensureCanonicalTables` shape but with DuckDB-native types and identifier quoting. Creates the `dim_*` table (key + label) and `map_*` table (raw + key) idempotently.

- [ ] **Step 1: Add failing tests**

Append to `server/test/warehouse-duckdb.test.ts`:

```ts
import { DuckDbWritableAdapter } from "../src/warehouse/duckdb/index.ts";

test("DuckDbWritableAdapter: ensureCanonicalTables creates dim_ and map_ idempotently", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // Need a schema to host the tables (default catalog is "memory" for :memory: db)
  // @ts-expect-error — private connect()
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);

  await a.ensureCanonicalTables({
    dimId: "country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_code",
  });

  // Tables exist; calling again is a no-op (no error).
  await a.ensureCanonicalTables({
    dimId: "country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_code",
  });

  // Insert sample row to confirm the schema accepted the CREATEs
  await c.run(`INSERT INTO zugzug.dim_country ("country_code", label) VALUES ('US', 'United States')`);
  await c.run(`INSERT INTO zugzug.map_country (raw, "country_code") VALUES ('USA', 'US')`);

  const dimRows = await c.runAndReadAll(`SELECT * FROM zugzug.dim_country`);
  expect(dimRows.getRowObjects()).toEqual([{ country_code: "US", label: "United States" }]);
  const mapRows = await c.runAndReadAll(`SELECT * FROM zugzug.map_country`);
  expect(mapRows.getRowObjects()).toEqual([{ raw: "USA", country_code: "US" }]);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd server && bun run test test/warehouse-duckdb.test.ts
```
Expected: 1 new test FAILS with `DuckDbWritableAdapter — Task 6`.

- [ ] **Step 3: Implement `ensureCanonicalTables`**

In `server/src/warehouse/duckdb/writable.ts`, replace the stub:

```ts
async ensureCanonicalTables(dim: DimensionSpec): Promise<void> {
  const dimRef = this.parseTwoPartRef(dim.dimTable);
  const mapRef = this.parseTwoPartRef(dim.mapTable);
  const key = this.quoteIdentifier(dim.keyCol);

  // CREATE TABLE IF NOT EXISTS is idempotent; safe to call on every commit.
  await this.run(
    `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(dimRef)} (
       ${key} VARCHAR PRIMARY KEY,
       label VARCHAR
     )`,
  );
  await this.run(
    `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(mapRef)} (
       raw VARCHAR PRIMARY KEY,
       ${key} VARCHAR NOT NULL
     )`,
  );
}

/** Parse a stored "schema.table" string into a Ref. Single-token strings get
 *  the creds default schema. Matches SnowflakeAdapter's parseTwoPartRef. */
private parseTwoPartRef(stored: string): Ref {
  const parts = stored.split(".");
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] };
  return { schema: this.creds.database ?? "main", table: stored };
}
```

Add the necessary imports at the top of `writable.ts`:

```ts
import type {
  AdapterCapabilities,
  ApprovedDraft,
  CommitResult,
  DimensionSpec,
  Ref,
  WritableWarehouseAdapter,
} from "../adapter.ts";
```

(Replace the existing import block.)

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && bun run test test/warehouse-duckdb.test.ts
```
Expected: all tests pass including the new one.

- [ ] **Step 5: Typecheck + lint**

```bash
cd server && bun run typecheck && bun run lint
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/warehouse/duckdb/writable.ts server/test/warehouse-duckdb.test.ts
git commit -m "feat(duckdb): writable adapter ensureCanonicalTables via CREATE TABLE IF NOT EXISTS"
```

---

## Task 7: Implement `DuckDbWritableAdapter.commitCanonical` via chunked MERGE INTO

**Files:**
- Modify: `server/src/warehouse/duckdb/writable.ts`
- Modify: `server/test/warehouse-duckdb.test.ts`

Same pattern as `SnowflakeAdapter.commitCanonical` from Phase 2: deduplicate canonical rows by key (last-write-wins on label), then issue chunked `MERGE INTO ... USING (VALUES ...)` statements. DuckDB supports MERGE INTO since v0.10; the syntax is essentially identical to Snowflake's.

- [ ] **Step 1: Add failing tests**

Append to `server/test/warehouse-duckdb.test.ts`:

```ts
test("DuckDbWritableAdapter: commitCanonical empty drafts returns rowsWritten=0 with no SQL", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // @ts-expect-error
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await a.ensureCanonicalTables({
    dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code",
  });

  const result = await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    [],
  );
  expect(result.rowsWritten).toBe(0);

  const rows = await c.runAndReadAll(`SELECT count(*) AS n FROM zugzug.dim_country`);
  expect(rows.getRowObjects()).toEqual([{ n: 0n }]);
});

test("DuckDbWritableAdapter: commitCanonical writes dim + map rows via MERGE", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // @ts-expect-error
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await a.ensureCanonicalTables({
    dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code",
  });

  await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    [
      { raw: "USA", key: "US", label: "United States" },
      { raw: "U.S.", key: "US", label: "United States" },
      { raw: "United Kingdom", key: "GB", label: "United Kingdom" },
    ],
  );

  // dim_country: deduped by key (2 unique keys: US, GB)
  const dimRows = await c.runAndReadAll(`SELECT * FROM zugzug.dim_country ORDER BY "country_code"`);
  expect(dimRows.getRowObjects()).toEqual([
    { country_code: "GB", label: "United Kingdom" },
    { country_code: "US", label: "United States" },
  ]);

  // map_country: one row per draft (3 rows)
  const mapRows = await c.runAndReadAll(`SELECT * FROM zugzug.map_country ORDER BY raw`);
  expect(mapRows.getRowObjects()).toEqual([
    { raw: "U.S.", country_code: "US" },
    { raw: "USA", country_code: "US" },
    { raw: "United Kingdom", country_code: "GB" },
  ]);
});

test("DuckDbWritableAdapter: commitCanonical is idempotent on repeat", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // @ts-expect-error
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await a.ensureCanonicalTables({
    dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code",
  });

  const drafts = [{ raw: "USA", key: "US", label: "United States" }];
  await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    drafts,
  );
  // Calling again with the same drafts is a no-op (MERGE only inserts on no match).
  await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    drafts,
  );

  const dimRows = await c.runAndReadAll(`SELECT count(*) AS n FROM zugzug.dim_country`);
  expect(dimRows.getRowObjects()).toEqual([{ n: 1n }]);
  const mapRows = await c.runAndReadAll(`SELECT count(*) AS n FROM zugzug.map_country`);
  expect(mapRows.getRowObjects()).toEqual([{ n: 1n }]);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd server && bun run test test/warehouse-duckdb.test.ts
```
Expected: 3 new tests FAIL with `DuckDbWritableAdapter — Task 7`.

- [ ] **Step 3: Implement `commitCanonical` + `mergeChunked` helper**

In `server/src/warehouse/duckdb/writable.ts`, add the `chunk` helper at the top of the file (above the class), and replace the `commitCanonical` stub with the full implementation:

```ts
// At module scope, above the class:
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
```

Replace the `commitCanonical` stub with:

```ts
async commitCanonical(dim: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult> {
  if (drafts.length === 0) return { rowsWritten: 0 };
  const dimRef = this.parseTwoPartRef(dim.dimTable);
  const mapRef = this.parseTwoPartRef(dim.mapTable);
  const key = this.quoteIdentifier(dim.keyCol);

  // Deduplicate canonical rows by key (last-write-wins on label, matches
  // SnowflakeAdapter behavior).
  const canonByKey = new Map<string, string | null>();
  for (const d of drafts) canonByKey.set(d.key, d.label);
  const canonRows = [...canonByKey.entries()].map(([k, l]) => ({ key: k, label: l }));
  const mapRows = drafts.map((d) => ({ raw: d.raw, key: d.key }));

  let rowsWritten = 0;
  rowsWritten += await this.mergeChunked({
    targetRef: dimRef,
    chunks: chunk(canonRows, 1000),
    sourceCols: [key, "label"],
    onCol: key,
    pickBinds: (row) => [row.key, row.label],
  });
  rowsWritten += await this.mergeChunked({
    targetRef: mapRef,
    chunks: chunk(mapRows, 1000),
    sourceCols: [`"raw"`, key],
    onCol: `"raw"`,
    pickBinds: (row) => [row.raw, row.key],
  });
  return { rowsWritten };
}

/** Issue chunked MERGE INTO ... USING (VALUES (?, ?), ...) statements.
 *  Each chunk becomes one MERGE; returns sum of inserted-row counts.
 *  DuckDB has supported MERGE INTO since v0.10; syntax is essentially
 *  identical to Snowflake's USING (VALUES …) AS S(a, b) form. */
private async mergeChunked<T>(opts: {
  targetRef: Ref;
  chunks: T[][];
  sourceCols: [string, string];
  onCol: string;
  pickBinds: (row: T) => [unknown, unknown];
}): Promise<number> {
  let total = 0;
  for (const c of opts.chunks) {
    if (c.length === 0) continue;
    const placeholders = c.map(() => "(?, ?)").join(", ");
    const [colA, colB] = opts.sourceCols;
    const sqlText = `MERGE INTO ${this.qualifyRef(opts.targetRef)} T
                     USING (VALUES ${placeholders}) AS S(${colA}, ${colB})
                     ON T.${opts.onCol} = S.${colA}
                     WHEN NOT MATCHED THEN INSERT (${colA}, ${colB}) VALUES (S.${colA}, S.${colB})`;
    const binds = c.flatMap((row) => opts.pickBinds(row));
    await this.run(sqlText, binds as never);
    total += c.length; // For MERGE INTO INSERT-only, all input rows are "potentially affected";
                       // DuckDB doesn't expose getNumUpdatedRows() cleanly via @duckdb/node-api,
                       // so we count input-chunk size. Idempotent re-runs report the same total
                       // even though zero rows were inserted — acceptable for the audit log
                       // ("Warehouse synced N values" — N is intent, not realized inserts).
  }
  return total;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && bun run test test/warehouse-duckdb.test.ts
```
Expected: all tests pass.

If the MERGE syntax fails (e.g. `Parser Error: syntax error at or near "MERGE"`), the installed `@duckdb/node-api` is older than 0.10. Confirm: `cat /Users/fhagelund/Documents/GitHub/zugzug/server/package.json | grep duckdb` should show a version compatible with MERGE.

If MERGE truly doesn't work, fall back to `INSERT INTO ... ON CONFLICT DO NOTHING` (DuckDB's native idempotent insert):

```ts
// Fallback if MERGE INTO isn't available
const sqlText = `INSERT INTO ${this.qualifyRef(opts.targetRef)} (${colA}, ${colB})
                 VALUES ${placeholders}
                 ON CONFLICT (${opts.onCol}) DO NOTHING`;
```

The semantics are equivalent for INSERT-only MERGE (which is what we do).

- [ ] **Step 5: Typecheck + lint + format**

```bash
cd server && bun run typecheck && bun run lint && bun run format:check
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/warehouse/duckdb/writable.ts server/test/warehouse-duckdb.test.ts
git commit -m "feat(duckdb): writable adapter commitCanonical via chunked MERGE INTO"
```

---

## Task 8: Extend `/api/workspace/info` with `defaultEngineerMode` + `allowedDomain`

**Files:**
- Modify: `server/src/server.ts`
- Modify: `app/src/store.ts`
- Modify: `server/test/workspace-info.test.ts` (extend)

The frontend needs the engineer-mode default from the server (for first-time users), and `allowedDomain` for Settings/Login copy. Both come from existing `env.ts` fields. We extend the existing endpoint rather than adding new ones (PR 2 moves the domain field to `/api/auth/config`).

- [ ] **Step 1: Add fields to the server response**

Open `server/src/server.ts`. Find the `/api/workspace/info` route handler. Update the JSON body:

```ts
if (seg[1] === "workspace" && seg[2] === "info" && seg.length === 3 && method === "GET") {
  const { getAdapter } = await import("./warehouse/registry.ts");
  const adapter = await getAdapter();
  return json({
    adapter: adapter.capabilities.id,
    writable: adapter.capabilities.writable,
    canonicalMode: adapter.capabilities.writable ? "warehouse" : "postgres-export",
    warehouseDb: env.warehouseDb || null,
    defaultEngineerMode: env.defaultEngineerMode,
    allowedDomain: env.allowedDomain || null,
  });
}
```

- [ ] **Step 2: Update frontend `WorkspaceInfo` type + validator**

Open `app/src/store.ts`. Find the `WorkspaceInfo` interface and `isWorkspaceInfo` type guard. Extend them:

```ts
export interface WorkspaceInfo {
  adapter: "duckdb" | "snowflake";
  writable: boolean;
  canonicalMode: "warehouse" | "postgres-export";
  warehouseDb: string | null;
  defaultEngineerMode: boolean;
  allowedDomain: string | null;
}

function isWorkspaceInfo(x: unknown): x is WorkspaceInfo {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    (o.adapter === "duckdb" || o.adapter === "snowflake") &&
    typeof o.writable === "boolean" &&
    (o.canonicalMode === "warehouse" || o.canonicalMode === "postgres-export") &&
    (o.warehouseDb === null || typeof o.warehouseDb === "string") &&
    typeof o.defaultEngineerMode === "boolean" &&
    (o.allowedDomain === null || typeof o.allowedDomain === "string")
  );
}
```

- [ ] **Step 3: Update server test**

Open `server/test/workspace-info.test.ts`. Find the test that asserts the response body shape. Add assertions for the two new fields:

```ts
expect(body.defaultEngineerMode).toBe(true); // env default when DEFAULT_ENGINEER_MODE not set
expect(body.allowedDomain).toBeNull(); // env default when ALLOWED_DOMAIN not set
```

Also update the type assertion at the top of the test to include the new fields:

```ts
const body = (await res.json()) as {
  adapter: string;
  writable: boolean;
  canonicalMode: "warehouse" | "postgres-export";
  warehouseDb: string | null;
  defaultEngineerMode: boolean;
  allowedDomain: string | null;
};
```

- [ ] **Step 4: Run server tests**

```bash
cd server && bun run test
```
Expected: all pass.

- [ ] **Step 5: Run app tests**

```bash
cd app && bun run test
```
Expected: all pass (existing useWorkspaceInfo tests still work; they mock the response).

- [ ] **Step 6: Typecheck + lint + format**

```bash
cd server && bun run typecheck && bun run lint && bun run format:check
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck && bun run format:check
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/server.ts server/test/workspace-info.test.ts app/src/store.ts
git commit -m "feat(api): workspace/info adds defaultEngineerMode + allowedDomain"
```

---

## Task 9: Engineer-mode default flip — use server default when no localStorage

**Files:**
- Modify: `app/src/lib/engineer-mode.tsx`
- Create: `app/test/engineer-mode-default.test.tsx`

Refactor `EngineerModeProvider` to honor the server default when the user has no stored preference. Existing stored values still win.

- [ ] **Step 1: Add failing tests**

Create `app/test/engineer-mode-default.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

function ChildShowingMode() {
  // Imported lazily inside each test to honor vi.doMock
  return null;
}

describe("EngineerModeProvider — server default", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  test("uses server default when no localStorage preference", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          canonicalMode: "postgres-export",
          warehouseDb: "analytics",
          defaultEngineerMode: true, // server says engineer mode ON by default
          allowedDomain: null,
        }),
      };
    });
    const { EngineerModeProvider, useEngineerMode } = await import("../src/lib/engineer-mode");

    function Probe() {
      const { engineer } = useEngineerMode();
      return <span data-testid="probe">{engineer ? "on" : "off"}</span>;
    }
    render(
      <EngineerModeProvider>
        <Probe />
      </EngineerModeProvider>,
    );
    // After the workspace-info effect fires, value should flip to ON
    await vi.waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("on"));
  });

  test("stored localStorage preference wins over server default", async () => {
    localStorage.setItem("zugzug:engineer-mode", "0");
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          canonicalMode: "postgres-export",
          warehouseDb: "analytics",
          defaultEngineerMode: true, // server default is ON
          allowedDomain: null,
        }),
      };
    });
    const { EngineerModeProvider, useEngineerMode } = await import("../src/lib/engineer-mode");

    function Probe() {
      const { engineer } = useEngineerMode();
      return <span data-testid="probe">{engineer ? "on" : "off"}</span>;
    }
    render(
      <EngineerModeProvider>
        <Probe />
      </EngineerModeProvider>,
    );
    // Stored "0" wins; engineer stays off even though server says default ON
    expect(screen.getByTestId("probe").textContent).toBe("off");
  });

  test("setEngineer persists user choice to localStorage", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => null, // simulate loading state
      };
    });
    const { EngineerModeProvider, useEngineerMode } = await import("../src/lib/engineer-mode");

    function Probe() {
      const { engineer, setEngineer } = useEngineerMode();
      return (
        <>
          <span data-testid="probe">{engineer ? "on" : "off"}</span>
          <button data-testid="toggle" onClick={() => setEngineer(true)}>toggle</button>
        </>
      );
    }
    render(
      <EngineerModeProvider>
        <Probe />
      </EngineerModeProvider>,
    );
    // Initial: false (no localStorage + no server default yet)
    expect(screen.getByTestId("probe").textContent).toBe("off");
    // User clicks to enable
    act(() => {
      screen.getByTestId("toggle").click();
    });
    expect(screen.getByTestId("probe").textContent).toBe("on");
    expect(localStorage.getItem("zugzug:engineer-mode")).toBe("1");
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd app && bun run test test/engineer-mode-default.test.tsx
```
Expected: tests FAIL (current implementation defaults to false; doesn't read from server).

- [ ] **Step 3: Replace `EngineerModeProvider`**

Open `app/src/lib/engineer-mode.tsx`. REPLACE its contents with:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useWorkspaceInfo } from "../store";

/* useEngineerMode — a workspace-wide toggle that exposes warehouse internals
   (table names, SQL, MERGE/JOIN copy, ATTACH prose). Persisted to localStorage;
   when no preference is stored, falls back to the server-provided default
   (env.defaultEngineerMode). Also reflected on <html data-engineer> so CSS
   can react. */

const KEY = "zugzug:engineer-mode";

interface Ctx {
  engineer: boolean;
  setEngineer: (on: boolean) => void;
}

const EngineerModeCtx = createContext<Ctx>({ engineer: false, setEngineer: () => {} });

/** Read the current localStorage preference. Returns null if no preference is set
 *  (caller falls back to server default or false). */
function readStoredPreference(): boolean | null {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem(KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return null;
}

export function EngineerModeProvider({ children }: { children: ReactNode }) {
  const wsInfo = useWorkspaceInfo();
  // Tri-state: true / false (user preference set) or null (no preference; fall back to server default)
  const [engineer, setEngineerState] = useState<boolean | null>(readStoredPreference);

  // When workspace info arrives AND user has no explicit preference, adopt the server default.
  useEffect(() => {
    if (engineer === null && wsInfo) {
      setEngineerState(wsInfo.defaultEngineerMode);
    }
  }, [wsInfo, engineer]);

  // Persist + reflect to <html data-engineer> when value changes (skip the null state).
  useEffect(() => {
    if (engineer === null) return;
    localStorage.setItem(KEY, engineer ? "1" : "0");
    document.documentElement.dataset.engineer = engineer ? "1" : "0";
  }, [engineer]);

  // setEngineer always writes an explicit preference (true/false), never null.
  const setEngineer = (on: boolean) => setEngineerState(on);

  // During initial render before workspace info loads AND no localStorage preference,
  // treat as false (safe — don't accidentally expose engineer details).
  const effective = engineer ?? false;

  return (
    <EngineerModeCtx.Provider value={{ engineer: effective, setEngineer }}>
      {children}
    </EngineerModeCtx.Provider>
  );
}

export function useEngineerMode(): Ctx {
  return useContext(EngineerModeCtx);
}
```

- [ ] **Step 4: Run new tests, verify they pass**

```bash
cd app && bun run test test/engineer-mode-default.test.tsx
```
Expected: 3 new tests pass.

- [ ] **Step 5: Run full app test suite**

```bash
cd app && bun run test
```
Expected: all existing tests still pass. The Settings.tsx test that toggles engineer mode (if any) should still work because `setEngineer` semantics are unchanged.

- [ ] **Step 6: Typecheck + format**

```bash
cd app && bun run typecheck && bun run format:check
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/engineer-mode.tsx app/test/engineer-mode-default.test.tsx
git commit -m "feat(engineer-mode): adopt server default when no localStorage preference"
```

---

## Task 10: Seed-data scrub — generic e-commerce dimensions

**Files:**
- Modify: `server/src/seed.ts`

Replace BC-specific source tables and the Channel dimension with generic e-commerce examples.

- [ ] **Step 1: Read current seed.ts to confirm shape**

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/src/seed.ts`.

- [ ] **Step 2: Rewrite the file**

REPLACE the ENTIRE contents of `server/src/seed.ts` with:

```ts
/* seed.ts — provision demo dimensions so the app runs end-to-end on a fresh
   install. Generic e-commerce examples: replace with your own dimensions
   after exploring the demo. Idempotent (safe to re-run). */

import { addDimension, addCanonical } from "./repo.ts";

const COUNTRY_SOURCES = [
  { table: "raw.orders", column: "shipping_country" },
  { table: "raw.shipments", column: "destination_country" },
  { table: "raw.customers", column: "billing_country" },
];

const COUNTRY_CANONICAL = [
  { key: "US", label: "United States" },
  { key: "GB", label: "United Kingdom" },
  { key: "DE", label: "Germany" },
  { key: "FR", label: "France" },
  { key: "ES", label: "Spain" },
  { key: "IT", label: "Italy" },
  { key: "NL", label: "Netherlands" },
  { key: "SE", label: "Sweden" },
  { key: "NO", label: "Norway" },
  { key: "DK", label: "Denmark" },
  { key: "FI", label: "Finland" },
  { key: "PL", label: "Poland" },
  { key: "BR", label: "Brazil" },
  { key: "IN", label: "India" },
  { key: "JP", label: "Japan" },
  { key: "AU", label: "Australia" },
  { key: "CA", label: "Canada" },
];

const PRODUCT_CATEGORY_SOURCES = [
  { table: "raw.orders", column: "product_category" },
  { table: "raw.products", column: "category" },
];

const PRODUCT_CATEGORY_CANONICAL = [
  { key: "electronics", label: "Electronics" },
  { key: "clothing", label: "Clothing" },
  { key: "home", label: "Home & Garden" },
  { key: "books", label: "Books" },
  { key: "groceries", label: "Groceries" },
  { key: "toys", label: "Toys & Games" },
  { key: "beauty", label: "Beauty" },
  { key: "sports", label: "Sports & Outdoors" },
];

const CUSTOMER_SEGMENT_SOURCES = [
  { table: "raw.customers", column: "segment" },
  { table: "raw.opportunities", column: "account_segment" },
];

const CUSTOMER_SEGMENT_CANONICAL = [
  { key: "b2c", label: "B2C" },
  { key: "smb", label: "SMB" },
  { key: "enterprise", label: "Enterprise" },
];

export async function seedDemo(): Promise<void> {
  await addDimension("Country", COUNTRY_SOURCES, {}, "u_verify");
  await addCanonical("country", COUNTRY_CANONICAL);

  await addDimension("Product Category", PRODUCT_CATEGORY_SOURCES, {}, "u_verify");
  await addCanonical("product_category", PRODUCT_CATEGORY_CANONICAL);

  await addDimension("Customer Segment", CUSTOMER_SEGMENT_SOURCES, {}, "u_verify");
  await addCanonical("customer_segment", CUSTOMER_SEGMENT_CANONICAL);
}
```

- [ ] **Step 3: Typecheck + lint + format**

```bash
cd server && bun run typecheck && bun run lint && bun run format:check
```
Expected: clean.

- [ ] **Step 4: Run tests** (no specific seed test exists; just confirm nothing broke)

```bash
cd server && bun run test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/seed.ts
git commit -m "chore(seed): replace BC-specific dimensions with generic e-commerce"
```

---

## Task 11: UI copy scrub — Login.tsx and Settings.tsx

**Files:**
- Modify: `app/src/routes/Login.tsx`
- Modify: `app/src/routes/Settings.tsx`
- Modify: `server/src/env.ts`
- Create: `app/test/login-copy.test.tsx`

Replace hard-coded "Better Collective" / "bettercollective.com" strings. The server's `env.allowedDomain` default changes from `"bettercollective.com"` to `""`; the frontend reads it live via `useWorkspaceInfo().allowedDomain` (added in Task 8).

- [ ] **Step 1: Flip the env default**

Open `server/src/env.ts`. Find:

```ts
allowedDomain: process.env.ALLOWED_DOMAIN?.trim() || "bettercollective.com",
```

Replace with:

```ts
/** Email domain restriction for signups. Empty string = unrestricted.
 *  Set ALLOWED_DOMAIN=example.com (or, in PR 2, OIDC_ALLOWED_DOMAIN=example.com)
 *  to require all users' emails to belong to that domain. */
allowedDomain: process.env.ALLOWED_DOMAIN?.trim() || "",
```

- [ ] **Step 2: Write failing test for Login.tsx copy**

Create `app/test/login-copy.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

describe("Login page copy", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("does not mention Better Collective", async () => {
    const { Login } = await import("../src/routes/Login");
    render(<Login />);
    expect(screen.queryByText(/better collective/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/bettercollective\.com/i)).not.toBeInTheDocument();
  });

  test("uses generic lead copy", async () => {
    const { Login } = await import("../src/routes/Login");
    render(<Login />);
    expect(screen.getByText(/master data reconciliation/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run, verify failure**

```bash
cd app && bun run test test/login-copy.test.tsx
```
Expected: "does not mention Better Collective" FAILS (current Login.tsx says "Master data reconciliation · Better Collective." and has a `bettercollective.com` error message).

- [ ] **Step 4: Update Login.tsx**

Open `app/src/routes/Login.tsx`. Make these edits:

a) Replace the `ERROR_MESSAGES.domain` entry:
```ts
// Before:
domain: "Only @bettercollective.com accounts can access this app.",
// After (generic, no domain mention — the domain comes from server config and we show it dynamically below if needed):
domain: "Your email domain is not allowed on this instance. Contact your admin.",
```

b) Replace the lead copy under "Sign in":
```tsx
// Before:
<p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
  Master data reconciliation · Better Collective.
</p>
// After:
<p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
  Master data reconciliation.
</p>
```

- [ ] **Step 5: Update Settings.tsx — ALLOWED_DOMAIN constant**

Open `app/src/routes/Settings.tsx`. Find:

```ts
const ALLOWED_DOMAIN = "@bettercollective.com";
```

Replace with a hook usage. First, add an import at the top:

```ts
import { useWorkspaceInfo } from "../store";
```

(If already imported, skip.)

Then remove the module-level `ALLOWED_DOMAIN` constant entirely. The functions that use it (`validateChip`, the team-section render) need to derive it at call-time. Find every `ALLOWED_DOMAIN` reference:

```bash
grep -n "ALLOWED_DOMAIN" /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
```

For each callsite:

- Inside `validateChip(email, membersByEmail, prevChips, allowedDomain)`: add `allowedDomain` as the 4th parameter and use it (with leading "@") instead of the constant.
- Inside `TeamSection()` component: call `useWorkspaceInfo()` near the top, derive `const allowedDomain = wsInfo?.allowedDomain ? "@" + wsInfo.allowedDomain : null;`. Pass `allowedDomain` to `validateChip` calls. When `allowedDomain === null` (workspace allows any domain), skip the domain check in `validateChip`.

The exact callsites and re-plumbing depend on the file's current structure. Patch:

```ts
function validateChip(
  email: string,
  membersByEmail: Set<string>,
  prevChips: Chip[],
  allowedDomain: string | null,  // NEW — null means any domain is allowed
): { ok: true } | { ok: false; reason: string } {
  if (!EMAIL_RX.test(email)) return { ok: false, reason: "Doesn't look like an email" };
  if (allowedDomain !== null && !email.endsWith(allowedDomain))
    return { ok: false, reason: `Must be a ${allowedDomain} email` };
  if (membersByEmail.has(email)) return { ok: false, reason: "Already on the team" };
  if (prevChips.some((c) => c.email === email && (c.status === "valid" || c.status === "inviting")))
    return { ok: false, reason: "Already in the list" };
  return { ok: true };
}
```

Replace the placeholder text at line ~462 (search for "colleague@bettercollective.com"):

```tsx
// Before:
"colleague@bettercollective.com, another@bettercollective.com…"
// After (uses the derived allowedDomain; falls back to example.com if no domain set):
allowedDomain
  ? `colleague@${allowedDomain.slice(1)}, another@${allowedDomain.slice(1)}…`
  : "colleague@example.com, another@example.com…"
```

(`slice(1)` strips the leading `@` from the allowedDomain string.)

- [ ] **Step 6: Run tests, verify pass**

```bash
cd app && bun run test
```
Expected: all pass including the 2 new login-copy tests.

If the existing Settings test for the invite chip flow fails because of the new `allowedDomain` parameter to `validateChip`, fix the test by passing the expected domain. Read the test file and adjust.

- [ ] **Step 7: Typecheck + format**

```bash
cd app && bun run typecheck && bun run format:check
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck && bun run format:check
```
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/env.ts app/src/routes/Login.tsx app/src/routes/Settings.tsx app/test/login-copy.test.tsx
git commit -m "chore(ui): remove Better Collective copy; allowedDomain now env-driven"
```

---

## Task 12: Extend `commit-warehouse-branch.test.ts` with DuckDB-writable case

**Files:**
- Modify: `server/test/commit-warehouse-branch.test.ts`

The existing tests use a mocked `WritableWarehouseAdapter` (no real DB). Add ONE integration-style test that uses the real `DuckDbWritableAdapter` against an in-memory DuckDB, to verify the full `repo.commit()` → `adapter.commitCanonical` path works end-to-end with real SQL.

- [ ] **Step 1: Add the failing test**

Append to `server/test/commit-warehouse-branch.test.ts`:

```ts
import { DuckDbWritableAdapter } from "../src/warehouse/duckdb/index.ts";

test("commit in writable DuckDB mode: rows land in MERGE-target tables end-to-end", async () => {
  // A real DuckDbWritableAdapter against :memory:. The Postgres canonical mirror
  // also exists (via the normal pgTx path) — we're verifying both sides happen.
  const writableDuckDb = new DuckDbWritableAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "memory",
    attached: false,
    writable: true,
  });

  // Pre-create the schema so ensureCanonicalTables can target it
  // @ts-expect-error — private connect()
  const c = await writableDuckDb["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);

  // Swap factories to return our writable DuckDB adapter for the "duckdb" type
  registerFactories({
    duckdb: async () => writableDuckDb,
    snowflake: async () => writableDuckDb, // doesn't matter; test only triggers duckdb
  });
  _resetAdapterCache();

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");

  const result = await repo.commit(dimId, "u_test");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("synced");

  // Verify the writable DuckDB actually has the rows in its dim_/map_ tables
  const dimRows = await c.runAndReadAll(`SELECT * FROM zugzug.dim_country ORDER BY 1`);
  expect(dimRows.getRowObjects()).toEqual([{ country_code: "us", label: "United States" }]);
  const mapRows = await c.runAndReadAll(`SELECT * FROM zugzug.map_country ORDER BY raw`);
  expect(mapRows.getRowObjects()).toEqual([{ raw: "USA", country_code: "us" }]);

  // Audit log captures the sync
  const audits = await repo.listAudit(10);
  expect(audits.some((a) => a.action === "Warehouse synced")).toBe(true);
});
```

The test relies on existing imports of `registerFactories`, `_resetAdapterCache`, and `repo` already in the file from prior tests.

- [ ] **Step 2: Run, verify it passes**

```bash
cd server && bun run test test/commit-warehouse-branch.test.ts
```
Expected: existing tests still pass + 1 new test passes.

If it fails because the dimension's canonical table name is `zugzug.dim_country` (the actual default from `addDimension`) but the test created the schema under a different name, adjust. Confirm via `cat server/src/repo-canonical.ts | grep dim_table` to see the naming convention.

- [ ] **Step 3: Run full server test suite**

```bash
cd server && bun run test
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add server/test/commit-warehouse-branch.test.ts
git commit -m "test(commit): exercise DuckDB-writable adapter end-to-end via repo.commit()"
```

---

## Task 13: Verification gates

**Files:** none modified.

- [ ] **Step 1: Grep gate — no "Better Collective" / "bettercollective" in production code**

```bash
grep -rn "Better Collective\|bettercollective" /Users/fhagelund/Documents/GitHub/zugzug/server/src/ /Users/fhagelund/Documents/GitHub/zugzug/app/src/ 2>&1 | grep -v "test/" | head -20
```
Expected: zero matches OR matches only in a comment explaining historical context (acceptable).

If a non-comment match appears, fix it (probably a hard-coded string I missed in Task 11).

- [ ] **Step 2: Grep gate — `DuckDbAdapter` no longer exists in src**

```bash
grep -rn "\\bDuckDbAdapter\\b" /Users/fhagelund/Documents/GitHub/zugzug/server/src/ 2>&1 | grep -v "test/"
```
Expected: zero matches. The factory uses `createDuckDbAdapter`; tests use `DuckDbReadOnlyAdapter` and `DuckDbWritableAdapter`.

- [ ] **Step 3: Server typecheck + lint + format**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck && bun run lint && bun run format:check
```
Expected: all clean.

- [ ] **Step 4: Server tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test
```
Expected: all previous tests pass + ~7 net-new tests (3 DuckDB-writable ensure/commit + 1 commit-branch DuckDB-writable + 2 workspace-info field assertions, etc.).

- [ ] **Step 5: App typecheck + format**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck && bun run format:check
```
Expected: clean.

- [ ] **Step 6: App tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test
```
Expected: all previous tests pass + ~5 net-new (3 engineer-mode-default + 2 login-copy).

- [ ] **Step 7: Server boot smoke**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && timeout 5 bun run start 2>&1 | head -10 || true
```
Expected: `· connected (duckdb, read-only)` (since `MOTHERDUCK_WRITABLE` is unset, defaulting to false).

- [ ] **Step 8: Writable-mode smoke**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && MOTHERDUCK_WRITABLE=true timeout 5 bun run start 2>&1 | head -10 || true
```
Expected: `· connected (duckdb, writable)` — confirms the env flag flips the adapter type.

- [ ] **Step 9: Manual UI smoke** (no commit — record findings)

In one terminal: `cd server && bun run start`. In another: `cd app && bun run dev`. Open <http://localhost:5173/app>.

Verify:
1. Login page shows "Master data reconciliation." (no "Better Collective" text).
2. Settings → Connections section: cards render; "Warehouse" badge shows `duckdb`; "Master records" shows "Kept in this workspace" (default read-only mode).
3. With `MOTHERDUCK_WRITABLE=true` (restart server first): Settings → Connections → Master records shows "Saved to Duckdb"; commit affordance in Triage reads "Approve & commit to warehouse"; Dashboard topbar (if you re-added it from a previous iteration — chip was removed in PR #84) — N/A; we removed the topbar chip already.
4. With `DEFAULT_ENGINEER_MODE=false`: clear localStorage; reload; engineer details should be hidden by default.

If anything looks visually off, fix in a focused commit.

- [ ] **Step 10: Commit history sanity**

```bash
git log --oneline main..HEAD
```
Expected commits in order:
- `feat(env)`: add MOTHERDUCK_WRITABLE and DEFAULT_ENGINEER_MODE flags
- `feat(warehouse)`: add writable field to DuckDbCredentials schema
- `feat(warehouse)`: wire MOTHERDUCK_WRITABLE env into DuckDb credentials
- `feat(duckdb)`: extract shared DuckDbBase class with connection + read methods
- `refactor(duckdb)`: split adapter into read-only and writable variants
- `feat(duckdb)`: writable adapter ensureCanonicalTables via CREATE TABLE IF NOT EXISTS
- `feat(duckdb)`: writable adapter commitCanonical via chunked MERGE INTO
- `feat(api)`: workspace/info adds defaultEngineerMode + allowedDomain
- `feat(engineer-mode)`: adopt server default when no localStorage preference
- `chore(seed)`: replace BC-specific dimensions with generic e-commerce
- `chore(ui)`: remove Better Collective copy; allowedDomain now env-driven
- `test(commit)`: exercise DuckDB-writable adapter end-to-end via repo.commit()

12 commits expected (possibly + 1 style commit if prettier flagged anything).

---

## Self-review summary

**Spec coverage (PR 1 scope only):**
- Engineer-mode default flip (server + frontend) — Tasks 1, 8, 9 ✓
- Seed-data scrub — Task 10 ✓
- UI copy scrub (Login + Settings + env default) — Task 11 ✓
- MotherDuck-writable: env flag + creds schema + registry wiring — Tasks 1, 2, 3 ✓
- MotherDuck-writable: adapter split into RO + Writable + base — Tasks 4, 5 ✓
- MotherDuck-writable: ensureCanonicalTables + commitCanonical — Tasks 6, 7 ✓
- Tests for writable variant + integration via commit() — Tasks 6, 7, 12 ✓
- Verification gates — Task 13 ✓

**Spec deviations:** none. The `parseTwoPartRef` helper used by Task 6 was added inline to `DuckDbWritableAdapter` (not duplicated; could be extracted to base later, but YAGNI for one consumer).

**Test count delta:**
- Server: ~7 net-new (3 writable adapter ensure/commit + 1 commit-branch DuckDB + 2 workspace-info + 1 grace for env defaults)
- App: ~5 net-new (3 engineer-mode-default + 2 login-copy)

**Out of scope for PR 1 (lands in PR 2 per the spec):**
- Auth refactor (Drizzle migration, OIDC, password, API tokens)
- `/api/auth/config` endpoint (we used `/api/workspace/info` as a temporary host for `allowedDomain`; PR 2 moves it)
- Settings → API tokens section
- Login.tsx mode-aware rewrite

**One pre-existing note:** the `DuckDbWritableAdapter`'s `mergeChunked` returns `c.length` as the "rows written" count (not the actual inserted row count) because `@duckdb/node-api` doesn't expose `getNumUpdatedRows` cleanly. This is documented inline. Idempotent re-runs report intent (drafts processed) not realized inserts — acceptable for the audit log's purpose.
