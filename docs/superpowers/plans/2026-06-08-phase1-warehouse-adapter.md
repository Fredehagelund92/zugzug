# Phase 1 — Extract `WarehouseAdapter` against DuckDB only

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor all warehouse access in `server/src/` behind a `WarehouseAdapter` interface, with `DuckDbAdapter` as the only concrete implementation. Snowflake support comes in Phase 2.

**Architecture:** Adapter interface (`server/src/warehouse/adapter.ts`) with discriminated-union types for writable vs read-only. `DuckDbAdapter` covers both local DuckDB and MotherDuck via the existing `@duckdb/node-api` SDK. A registry (`getAdapter(workspaceId)`) returns a cached adapter per workspace, env-driven for now (workspace credentials table comes in Phase 4 with auth refactor). Every warehouse query in `repo-scan.ts`, `repo-canonical.ts`, `repo-drafts.ts`, and `repo-shared.ts` routes through the adapter. The `whTable()` helper and `occUnion()` builder in `repo-shared.ts` are deleted; their callers use `adapter.qualifyRef()` and the new `distinctValuesWithProvenance()` adapter method instead.

**Tech Stack:** Bun, TypeScript strict, `@duckdb/node-api`, Zod (new dep), `postgres.js`, `bun:test`.

**Spec reference:** `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (Phase 1).

**Verification gate (must all pass at end of phase):**
1. `bun run typecheck` clean in `server/`.
2. `bun test` passes in `server/` against the local Postgres test DB.
3. `bun run lint` clean in `server/`.
4. `grep -rn "whTable\\|occUnion" server/src/` returns zero results (definitions and callsites both gone).
5. `grep -rn 'from "\\./db\\.ts"\\|from "\\./db"' server/src/` returns matches ONLY in `server/src/warehouse/duckdb/index.ts` (it consumes `db.ts` internally), `server/src/verify-*.ts` (dev scripts — out of scope for Phase 1), and `server/src/spike.ts` (dev script). Production paths — `server.ts`, `bootstrap.ts`, `repo-*.ts` — must not import `db.ts`.
6. Manual smoke: `bun run start` + `bun run dev` in `app/`, walk through Sources, Triage, Tables, Dashboard. Feature-equivalent to today.

**Architectural invariant introduced by this phase:** the production runtime opens exactly one DuckDB connection per workspace, owned by the `DuckDbAdapter`. The current `server.ts` and `bootstrap.ts` `await connect()` calls (which opened a second separate connection from `db.ts`'s module-level cache) get replaced with `await (await getAdapter()).ping()` in Task 12b. `db.ts` itself stays in the tree purely for dev scripts (`verify-*.ts`, `spike.ts`); no production code references it. `DuckDbAdapter` owns its own connection lifecycle and does **not** import from `db.ts`.

**One small spec amendment** discovered during planning: the interface needs `distinctValuesWithProvenance(sources, opts)` to replace the current `occUnion()` UNION-ALL builder, which scans N sources in a single query. Per-source loops would be a perf regression for the common 5-20-source scan. This is added in Task 4.

**Worktree:** Phase 1 work happens on a feature branch. Before Task 1, ensure you're either in an isolated worktree (see `superpowers:using-git-worktrees`) or have a clean working tree on a fresh branch like `phase1-warehouse-adapter`.

---

## File structure (post-phase)

```
server/src/
  warehouse/
    adapter.ts          # interface, types, Ref, AdapterCapabilities, isWritable
    credentials.ts      # Zod discriminated union + factory registry
    registry.ts         # getAdapter() with per-key cache
    duckdb/
      index.ts          # DuckDbAdapter — owns the @duckdb/node-api connection
    snowflake/
      index.ts          # SnowflakeAdapter stub (throws — implemented in Phase 2)
  db.ts                 # SHRUNK: only the connection lifecycle for DuckDbAdapter to use internally
  repo-scan.ts          # uses adapter; no raw DuckDB
  repo-canonical.ts     # uses adapter; no raw DuckDB
  repo-drafts.ts        # uses adapter; no raw DuckDB
  repo-shared.ts        # whTable/occUnion deleted; all/get/run re-exports removed
  ...
server/test/
  warehouse-adapter.test.ts   # NEW — adapter contract tests against in-memory DuckDB
  ... (existing tests unchanged; they keep ATTACH_WAREHOUSE=false)
```

---

## Task 1: Add Zod dependency

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add zod to dependencies**

Run from `server/`:
```bash
bun add zod
```

- [ ] **Step 2: Verify install**

Run:
```bash
bun pm ls | grep zod
```
Expected: a line like `zod@3.x.x` or `zod@4.x.x`.

- [ ] **Step 3: Typecheck still passes**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/bun.lock
git commit -m "chore(server): add zod for warehouse credentials validation"
```

---

## Task 2: Scaffold `warehouse/adapter.ts` — interface + types

**Files:**
- Create: `server/src/warehouse/adapter.ts`

- [ ] **Step 1: Write the file**

Create `server/src/warehouse/adapter.ts` with the full interface:

```ts
// Adapter contract for warehouse access. DuckDB and Snowflake both implement this.
// No SQL escape hatch on purpose — every query shape the app needs is a first-class method.

export interface Ref {
  readonly catalog?: string; // Snowflake/BigQuery 3-part; omit for DuckDB/PG
  readonly schema: string;
  readonly table: string;
}

export interface AdapterIds {
  duckdb: true;
  snowflake: true;
}
export type AdapterId = keyof AdapterIds;

export interface AdapterCapabilities {
  readonly id: AdapterId;
  readonly writable: boolean;
  readonly supportsMerge: boolean;
  readonly identifierCase: "preserve" | "upper" | "lower";
  readonly supportsApproximateDistinct: boolean;
}

export interface CatalogTable {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface ColumnMeta {
  readonly name: string;
  readonly type: string;
}

export interface ValueCount {
  readonly value: string;
  readonly count: number;
}

export interface ValueProvenance {
  readonly value: string;
  // Opaque index back into the `sources` array the caller passed in.
  // Avoids leaking SQL-qualified ref strings into application code.
  readonly sourceIndex: number;
  readonly count: number;
}

export interface DimensionSpec {
  readonly dimId: string;
  readonly dimTable: string;
  readonly mapTable: string;
  readonly keyCol: string;
}

export interface ApprovedDraft {
  readonly raw: string;
  readonly key: string;
  readonly label: string | null;
}

export interface CommitResult {
  readonly rowsWritten: number;
}

interface BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities;

  ping(): Promise<boolean>;

  // Catalog
  listTables(opts?: { schema?: string; search?: string }): Promise<CatalogTable[]>;
  listColumns(table: Ref): Promise<ColumnMeta[]>;
  tableExists(table: Ref): Promise<boolean>;

  // Value scans
  distinctValues(table: Ref, column: string, limit: number): Promise<string[]>;
  topValuesByFrequency(table: Ref, column: string, limit: number): Promise<ValueCount[]>;
  columnStats(
    table: Ref,
    column: string,
    opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }>;
  nameResolution(table: Ref, idCol: string, nameCol: string): Promise<Map<string, string>>;

  // Multi-source scan — replaces the old occUnion() builder
  distinctValuesWithProvenance(
    sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]>;

  // SQL fragment builders (per-adapter; no shared qid())
  quoteIdentifier(name: string): string;
  qualifyRef(table: Ref): string;
  castToString(expr: string): string;
}

export interface WritableWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true };
  ensureCanonicalTables(dim: DimensionSpec): Promise<void>;
  commitCanonical(dim: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult>;
}

export interface ReadOnlyWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false };
}

export type WarehouseAdapter = WritableWarehouseAdapter | ReadOnlyWarehouseAdapter;

export const isWritable = (a: WarehouseAdapter): a is WritableWarehouseAdapter =>
  a.capabilities.writable === true;
```

- [ ] **Step 2: Verify it typechecks**

Run from `server/`:
```bash
bun run typecheck
```
Expected: no errors. Nothing imports the file yet, but the file must compile.

- [ ] **Step 3: Commit**

```bash
git add server/src/warehouse/adapter.ts
git commit -m "feat(warehouse): scaffold WarehouseAdapter interface"
```

---

## Task 3: Scaffold `warehouse/credentials.ts` — Zod schemas + factory registry

**Files:**
- Create: `server/src/warehouse/credentials.ts`

- [ ] **Step 1: Write the file**

Create `server/src/warehouse/credentials.ts`:

```ts
import { z } from "zod";
import type { WarehouseAdapter } from "./adapter.ts";

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
});

export const SnowflakeCredentials = z.object({
  type: z.literal("snowflake"),
  account: z.string(),
  user: z.string(),
  privateKey: z.string(),
  privateKeyPassphrase: z.string().optional(),
  warehouse: z.string(),
  database: z.string(),
  schema: z.string(),
});

export const WarehouseCredentialsSchema = z.discriminatedUnion("type", [
  DuckDbCredentials,
  SnowflakeCredentials,
]);

export type WarehouseCredentials = z.infer<typeof WarehouseCredentialsSchema>;
export type DuckDbCreds = z.infer<typeof DuckDbCredentials>;
export type SnowflakeCreds = z.infer<typeof SnowflakeCredentials>;

// Factory registry — mapped type forces every credential `type` to have a factory.
// Adding a new credential type without a factory entry is a compile error.
type AdapterFactory<C extends WarehouseCredentials> = (creds: C) => Promise<WarehouseAdapter>;

export interface AdapterFactoryRegistry {
  duckdb: AdapterFactory<DuckDbCreds>;
  snowflake: AdapterFactory<SnowflakeCreds>;
}

let _factories: AdapterFactoryRegistry | null = null;

export function registerFactories(reg: AdapterFactoryRegistry): void {
  _factories = reg;
}

export async function resolveAdapter(raw: unknown): Promise<WarehouseAdapter> {
  if (!_factories) {
    throw new Error("warehouse factories not registered — call registerFactories() at startup");
  }
  const creds = WarehouseCredentialsSchema.parse(raw);
  // Per-type narrowing: TS infers `creds` to the exact factory's input type.
  switch (creds.type) {
    case "duckdb":
      return _factories.duckdb(creds);
    case "snowflake":
      return _factories.snowflake(creds);
  }
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/warehouse/credentials.ts
git commit -m "feat(warehouse): credentials Zod schemas + factory registry"
```

---

## Task 4: Scaffold `warehouse/registry.ts` — `getAdapter(workspaceId)` with cache

**Files:**
- Create: `server/src/warehouse/registry.ts`

- [ ] **Step 1: Write the file**

Create `server/src/warehouse/registry.ts`:

```ts
import type { WarehouseAdapter } from "./adapter.ts";
import { resolveAdapter, type WarehouseCredentials } from "./credentials.ts";
import { env } from "../env.ts";

// One adapter instance per cache key. Phase 1 has a single global workspace
// keyed by "default". Phase 4 (multi-tenant gating) keys by workspace id.
const cache = new Map<string, Promise<WarehouseAdapter>>();

export async function getAdapter(workspaceId: string = "default"): Promise<WarehouseAdapter> {
  const existing = cache.get(workspaceId);
  if (existing) return existing;
  const promise = resolveAdapter(envCredentials());
  cache.set(workspaceId, promise);
  // If the promise rejects, drop the cached failure so the next call retries.
  promise.catch(() => cache.delete(workspaceId));
  return promise;
}

/** Read warehouse credentials from env. Phase 4 replaces this with a per-workspace
 *  jsonb column in Postgres. */
function envCredentials(): WarehouseCredentials {
  return {
    type: "duckdb",
    token: env.motherduckToken,
    path: env.duckPath,
    database: env.warehouseDb,
    attached: env.attachWarehouse,
  };
}

/** Test/debug helper — clears the adapter cache. */
export function _resetAdapterCache(): void {
  cache.clear();
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/warehouse/registry.ts
git commit -m "feat(warehouse): adapter registry with per-workspace cache"
```

---

## Task 5: Implement `DuckDbAdapter` — helpers + capabilities + `ping()`

**Files:**
- Create: `server/src/warehouse/duckdb/index.ts`
- Modify: `server/src/server.ts` (to register the DuckDb factory at startup)
- Test: `server/test/warehouse-duckdb.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/warehouse-duckdb.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { DuckDbAdapter } from "../src/warehouse/duckdb/index.ts";

test("quoteIdentifier escapes embedded double quotes", () => {
  const a = new DuckDbAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "analytics",
    attached: false,
  });
  expect(a.quoteIdentifier("foo")).toBe('"foo"');
  expect(a.quoteIdentifier('weird"name')).toBe('"weird""name"');
});

test("qualifyRef builds catalog.schema.table when database set", () => {
  const a = new DuckDbAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "analytics",
    attached: false,
  });
  expect(a.qualifyRef({ schema: "raw", table: "partners" })).toBe(
    '"analytics"."raw"."partners"',
  );
});

test("qualifyRef builds schema.table when no database", () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.qualifyRef({ schema: "main", table: "t" })).toBe('"main"."t"');
});

test("castToString wraps in CAST(... AS VARCHAR)", () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.castToString('"col"')).toBe('CAST("col" AS VARCHAR)');
});

test("capabilities are read-only DuckDB defaults when not attached", () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.capabilities.id).toBe("duckdb");
  expect(a.capabilities.writable).toBe(false);
  expect(a.capabilities.identifierCase).toBe("preserve");
});

test("ping returns true with in-memory connection", async () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  await expect(a.ping()).resolves.toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd server && bun test test/warehouse-duckdb.test.ts
```
Expected: FAIL — module `../src/warehouse/duckdb/index.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

Create `server/src/warehouse/duckdb/index.ts`:

```ts
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import type {
  AdapterCapabilities,
  CatalogTable,
  ColumnMeta,
  DimensionSpec,
  Ref,
  ReadOnlyWarehouseAdapter,
  ValueCount,
  ValueProvenance,
} from "../adapter.ts";
import type { DuckDbCreds } from "../credentials.ts";

// Phase 1 ships DuckDB as read-only. Writable mode (commit-to-warehouse) lands
// in Phase 3. Until then the adapter exposes the read-only surface only.
export class DuckDbAdapter implements ReadOnlyWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false };

  private readonly creds: DuckDbCreds;
  private conn: DuckDBConnection | null = null;
  private connecting: Promise<DuckDBConnection> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(creds: DuckDbCreds) {
    this.creds = creds;
    this.capabilities = {
      id: "duckdb",
      writable: false,
      supportsMerge: false,
      identifierCase: "preserve",
      supportsApproximateDistinct: false,
    };
  }

  // ---- helpers ----

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

  // ---- connection lifecycle (internal) ----

  private async connect(): Promise<DuckDBConnection> {
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

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  private async all<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T[]> {
    return this.serialized(async () => {
      const c = await this.connect();
      const r = await c.runAndReadAll(sql, params);
      return r.getRowObjects() as T[];
    });
  }

  private async get<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  // ---- the rest of the interface is implemented in Task 6 ----

  listTables(): Promise<CatalogTable[]> {
    throw new Error("Task 6 — not implemented");
  }
  listColumns(_table: Ref): Promise<ColumnMeta[]> {
    throw new Error("Task 6 — not implemented");
  }
  tableExists(_table: Ref): Promise<boolean> {
    throw new Error("Task 6 — not implemented");
  }
  distinctValues(_table: Ref, _column: string, _limit: number): Promise<string[]> {
    throw new Error("Task 6 — not implemented");
  }
  topValuesByFrequency(_table: Ref, _column: string, _limit: number): Promise<ValueCount[]> {
    throw new Error("Task 6 — not implemented");
  }
  columnStats(
    _table: Ref,
    _column: string,
    _opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }> {
    throw new Error("Task 6 — not implemented");
  }
  nameResolution(_table: Ref, _idCol: string, _nameCol: string): Promise<Map<string, string>> {
    throw new Error("Task 6 — not implemented");
  }
  distinctValuesWithProvenance(
    _sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    throw new Error("Task 6 — not implemented");
  }
  ensureCanonicalTables(_dim: DimensionSpec): Promise<void> {
    throw new Error("Task 6 — not implemented");
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run:
```bash
cd server && bun test test/warehouse-duckdb.test.ts
```
Expected: PASS on all 6 tests in this task. (Later tasks will add more tests to this file.)

- [ ] **Step 5: Register the factory at startup**

Modify `server/src/server.ts`. Find the imports near the top (line 1-10 area) and add:

```ts
import { registerFactories } from "./warehouse/credentials.ts";
import { DuckDbAdapter } from "./warehouse/duckdb/index.ts";
```

Then at the very top of the file (before any `connect()` or route registration), add:

```ts
registerFactories({
  duckdb: async (creds) => new DuckDbAdapter(creds),
  snowflake: async () => {
    throw new Error("Snowflake adapter ships in Phase 2");
  },
});
```

- [ ] **Step 6: Typecheck + test**

Run:
```bash
cd server && bun run typecheck && bun test test/warehouse-duckdb.test.ts
```
Expected: typecheck clean; all 6 tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/warehouse/duckdb/ server/src/server.ts server/test/warehouse-duckdb.test.ts
git commit -m "feat(warehouse): DuckDbAdapter helpers + ping + factory registration"
```

---

## Task 6: Implement `DuckDbAdapter` — all read methods

**Files:**
- Modify: `server/src/warehouse/duckdb/index.ts`
- Modify: `server/test/warehouse-duckdb.test.ts` (add tests for each method)

- [ ] **Step 1: Add tests for `tableExists`, `listTables`, `listColumns`**

Append to `server/test/warehouse-duckdb.test.ts`:

```ts
import { beforeAll } from "bun:test";

// Set up a small in-memory dataset shared across query tests.
async function withFixture(): Promise<DuckDbAdapter> {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  // @ts-expect-error — test reaches into private connect() via a trampoline
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA raw`);
  await c.run(`CREATE TABLE raw.partners (id INTEGER, name VARCHAR, region VARCHAR)`);
  await c.run(
    `INSERT INTO raw.partners VALUES (1, 'Acme', 'US'), (2, 'Acme Inc', 'us'), (3, 'Foo', 'EU'), (4, '', NULL), (5, 'Bar', 'EU')`,
  );
  await c.run(`CREATE TABLE raw.countries (code VARCHAR, label VARCHAR)`);
  await c.run(`INSERT INTO raw.countries VALUES ('US', 'United States'), ('EU', 'European Union')`);
  return a;
}

test("tableExists returns true for existing, false for missing", async () => {
  const a = await withFixture();
  await expect(a.tableExists({ schema: "raw", table: "partners" })).resolves.toBe(true);
  await expect(a.tableExists({ schema: "raw", table: "nope" })).resolves.toBe(false);
});

test("listTables returns schema+table with columns inline", async () => {
  const a = await withFixture();
  const tables = await a.listTables({ schema: "raw" });
  const partners = tables.find((t) => t.table === "partners");
  expect(partners).toBeDefined();
  expect(partners?.schema).toBe("raw");
  expect(partners?.columns).toEqual(expect.arrayContaining(["id", "name", "region"]));
});

test("listColumns returns name + type", async () => {
  const a = await withFixture();
  const cols = await a.listColumns({ schema: "raw", table: "partners" });
  expect(cols.map((c) => c.name).sort()).toEqual(["id", "name", "region"]);
  expect(cols.find((c) => c.name === "id")?.type).toMatch(/INT/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && bun test test/warehouse-duckdb.test.ts
```
Expected: FAIL — `Task 6 — not implemented` thrown.

- [ ] **Step 3: Implement `tableExists`, `listTables`, `listColumns`**

Replace those three stub methods in `server/src/warehouse/duckdb/index.ts` with:

```ts
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
    // MotherDuck attached but no database picked — caller mistake.
    return [];
  }
  // SHOW ALL TABLES is DuckDB-specific. When MotherDuck is attached, scope to
  // the configured catalog; when local, scope to anything except the system db.
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
  const rows = await this.all<{ schema: string; name: string; column_names: string[] }>(
    `SELECT schema, name, column_names FROM (SHOW ALL TABLES) WHERE ${where} ORDER BY schema, name LIMIT 5000`,
    params,
  );
  return rows.map((r) => ({
    schema: r.schema,
    table: r.name,
    columns: Array.isArray(r.column_names) ? r.column_names.map(String) : [],
  }));
}

async listColumns(table: Ref): Promise<ColumnMeta[]> {
  const sql = `DESCRIBE ${this.qualifyRef(table)}`;
  const rows = await this.all<{ column_name: string; column_type: string }>(sql);
  return rows.map((r) => ({ name: r.column_name, type: r.column_type }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && bun test test/warehouse-duckdb.test.ts
```
Expected: all tests pass (including the new three).

- [ ] **Step 5: Add tests for `distinctValues`, `topValuesByFrequency`, `columnStats`, `nameResolution`, `distinctValuesWithProvenance`**

Append to the same test file:

```ts
test("distinctValues returns trimmed-non-empty distinct strings", async () => {
  const a = await withFixture();
  const vals = await a.distinctValues({ schema: "raw", table: "partners" }, "region", 100);
  // Empty/null filtered out. Case is preserved.
  expect(vals.sort()).toEqual(["EU", "US", "us"]);
});

test("topValuesByFrequency returns counts, sorted desc", async () => {
  const a = await withFixture();
  const top = await a.topValuesByFrequency({ schema: "raw", table: "partners" }, "region", 10);
  // EU appears 2× (rows 3, 5), US and us appear 1× each. Row 4 is empty → filtered.
  expect(top[0].value).toBe("EU");
  expect(top[0].count).toBe(2);
  expect(top.reduce((s, x) => s + x.count, 0)).toBe(4);
});

test("columnStats returns rows + distinct", async () => {
  const a = await withFixture();
  const s = await a.columnStats({ schema: "raw", table: "partners" }, "region");
  expect(s.rows).toBe(4); // row 4 (empty) filtered
  expect(s.distinct).toBe(3); // US, us, EU
});

test("nameResolution returns id→name Map", async () => {
  const a = await withFixture();
  const m = await a.nameResolution({ schema: "raw", table: "countries" }, "code", "label");
  expect(m.get("US")).toBe("United States");
  expect(m.get("EU")).toBe("European Union");
  expect(m.size).toBe(2);
});

test("distinctValuesWithProvenance merges multiple sources and tags sourceIndex", async () => {
  const a = await withFixture();
  const rows = await a.distinctValuesWithProvenance([
    { table: { schema: "raw", table: "partners" }, column: "region" }, // index 0
    { table: { schema: "raw", table: "countries" }, column: "code" }, // index 1
  ]);
  // Each source contributes raw value + count. EU appears 2× in partners, 1× in countries.
  const fromPartners = rows.filter((r) => r.sourceIndex === 0);
  const fromCountries = rows.filter((r) => r.sourceIndex === 1);
  expect(fromPartners.length).toBe(3); // US, us, EU
  expect(fromCountries.length).toBe(2); // US, EU
  expect(fromPartners.find((r) => r.value === "EU")?.count).toBe(2);
});
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
cd server && bun test test/warehouse-duckdb.test.ts
```
Expected: FAIL on the five new tests with `Task 6 — not implemented`.

- [ ] **Step 7: Implement the five remaining read methods**

Replace those five stubs in `server/src/warehouse/duckdb/index.ts` with:

```ts
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

async nameResolution(
  table: Ref,
  idCol: string,
  nameCol: string,
): Promise<Map<string, string>> {
  const id = this.quoteIdentifier(idCol);
  const nm = this.quoteIdentifier(nameCol);
  const rows = await this.all<{ id: string; nm: string }>(
    `SELECT ${this.castToString(id)} AS id, ${this.castToString(nm)} AS nm
       FROM ${this.qualifyRef(table)}`,
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

async ensureCanonicalTables(_dim: DimensionSpec): Promise<void> {
  // Phase 1 ships read-only. Writable mode lives on WritableWarehouseAdapter,
  // which DuckDbAdapter does not implement here. Phase 3 (canonical-store modes)
  // promotes DuckDbAdapter to a writable variant when configured so.
  throw new Error("DuckDbAdapter is read-only in Phase 1");
}
```

(Note: `ensureCanonicalTables` and `commitCanonical` belong to `WritableWarehouseAdapter`. Since `DuckDbAdapter` declares `implements ReadOnlyWarehouseAdapter` it must not have them. **Remove** the `ensureCanonicalTables` stub entirely from `DuckDbAdapter`. The interface tree guarantees this won't compile if you leave it.)

- [ ] **Step 8: Run typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean. If `ensureCanonicalTables` remains on the class, TS will complain.

- [ ] **Step 9: Run tests**

```bash
cd server && bun test test/warehouse-duckdb.test.ts
```
Expected: all 14 tests pass.

- [ ] **Step 10: Commit**

```bash
git add server/src/warehouse/duckdb/index.ts server/test/warehouse-duckdb.test.ts
git commit -m "feat(warehouse): DuckDbAdapter read methods + provenance scan"
```

---

## Task 7: Refactor `liveSources` in `repo-shared.ts` to use the adapter

**Files:**
- Modify: `server/src/repo-shared.ts`
- Test: existing tests must still pass.

- [ ] **Step 1: Baseline — confirm existing tests pass**

Run:
```bash
cd server && bun test
```
Expected: existing 6 test files pass.

- [ ] **Step 2: Refactor `liveSources`**

Open `server/src/repo-shared.ts:314-325`. Replace the function with:

```ts
export async function liveSources(dimId: string): Promise<SourceDef[]> {
  const { getAdapter } = await import("./warehouse/registry.ts");
  const adapter = await getAdapter();
  const out: SourceDef[] = [];
  for (const s of await sourcesOf(dimId)) {
    const ref = parseSourceTable(s.table);
    if (await adapter.tableExists(ref)) {
      out.push(s);
    } else {
      console.warn(`scan: skipping missing source ${env.warehouseDb}.${s.table}`);
    }
  }
  return out;
}
```

Also add the `parseSourceTable` helper right above `liveSources`:

```ts
import type { Ref } from "./warehouse/adapter.ts";

/** Parse a stored 'schema.table' (or 'table') string into the adapter's Ref. */
export function parseSourceTable(stored: string): Ref {
  const parts = stored.split(".");
  if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { schema: "main", table: stored };
}
```

- [ ] **Step 3: Remove the now-unused `run` import in `repo-shared.ts`**

Edit `server/src/repo-shared.ts:6`. Change:

```ts
import { run } from "./db.ts";
```
to (delete the line entirely if `run` is no longer used in the file — verify with grep).

Verify:
```bash
grep -n "\\brun(" /Users/fhagelund/Documents/GitHub/zugzug/server/src/repo-shared.ts
```
Expected: no matches. If matches exist, leave the import.

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 5: Run tests**

```bash
cd server && bun test
```
Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-shared.ts
git commit -m "refactor(scan): route liveSources existence probe through WarehouseAdapter"
```

---

## Task 8: Refactor `repo-scan.ts:scanSources` to use the adapter

**Files:**
- Modify: `server/src/repo-scan.ts`
- Test: existing tests must still pass.

- [ ] **Step 1: Baseline — tests pass**

```bash
cd server && bun test
```
Expected: pass.

- [ ] **Step 2: Refactor `scanSources` (lines ~120–219)**

In `server/src/repo-scan.ts`, change the imports at the top of the file. Remove `whTable` and add adapter imports:

```ts
import { getAdapter } from "./warehouse/registry.ts";
import { parseSourceTable } from "./repo-shared.ts";
import {
  type SourceInfo,
  type SchemaFacet,
  type CatalogTable,
  slug,
  qid,
  cq,
  liveSources,
  occUnion, // still imported for now — Task 9 removes it
  all,
  get,
  pgAll,
  pgGet,
  pgRun,
  env,
  pg,
  log,
} from "./repo-shared.ts";
```

Then replace the body of `scanSources` (the per-source loop, currently lines ~126–201) with adapter-driven calls. Locate the block:

```ts
for (const r of regs) {
  const col = qid(r.column);
  let present: boolean,
    rows = 0,
    distinct = 0,
    unmapped = 0;
  ...
```

Replace with:

```ts
const adapter = await getAdapter();
for (const r of regs) {
  const ref = parseSourceTable(r.table);
  let present: boolean,
    rows = 0,
    distinct = 0,
    unmapped = 0;
  const t0 = performance.now();
  try {
    const stats = await Promise.race([
      adapter.columnStats(ref, r.column),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("scan timeout")), SCAN_TIMEOUT_MS),
      ),
    ]);
    present = true;
    rows = stats.rows;
    distinct = stats.distinct;
    if (distinct > 0) {
      try {
        const whRaws = await adapter.distinctValues(ref, r.column, 100000);
        const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(r.mapTable)}`);
        const mappedSet = new Set(mappedRows.map((m) => m.raw.toLowerCase()));
        unmapped = whRaws.filter((w) => !mappedSet.has(w.toLowerCase())).length;
      } catch {
        /* either side missing — leave at 0 */
      }
    }
    const ms = Math.round(performance.now() - t0);
    log({
      level: ms > 5000 ? "warn" : "info",
      msg: "scan-source",
      table: r.table,
      column: r.column,
      ms,
      rows,
      distinct,
      unmapped,
    });
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const timedOut = e instanceof Error && e.message === "scan timeout";
    log({
      level: "error",
      msg: "scan-source",
      table: r.table,
      column: r.column,
      ms,
      err: e instanceof Error ? e.message : String(e),
      timedOut,
    });
    present = false;
  }
  // ... existing INSERT INTO source_stat block stays unchanged
}
```

(Keep the `INSERT INTO ${pg("source_stat")}` block intact at the end of the loop.)

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 4: Tests still pass**

```bash
cd server && bun test
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-scan.ts
git commit -m "refactor(scan): scanSources uses adapter.columnStats + distinctValues"
```

---

## Task 9: Refactor `repo-scan.ts:topUnmapped` + `autoStageExactMatches` + `searchCatalog`

**Files:**
- Modify: `server/src/repo-scan.ts`

- [ ] **Step 1: Refactor `topUnmapped` (lines ~297–331)**

Replace its body to use `adapter.topValuesByFrequency`:

```ts
export async function topUnmapped(
  dimId: string,
  table: string,
  column: string,
  limit = 5,
): Promise<UnmappedSample[]> {
  const meta = await pgGet<{ mapTable: string }>(
    `SELECT map_table AS "mapTable" FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return [];
  if (!env.attachWarehouse) return [];
  const adapter = await getAdapter();
  const ref = parseSourceTable(table);
  const n = Math.max(1, Math.min(50, Math.round(limit)));

  const occ = await adapter.topValuesByFrequency(ref, column, 10000).catch(() => [] as { value: string; count: number }[]);
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(meta.mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  return occ
    .filter((r) => !mappedSet.has(r.value.toLowerCase()))
    .slice(0, n)
    .map((r) => ({ raw: r.value, rows: r.count }));
}
```

- [ ] **Step 2: Refactor `autoStageExactMatches` (lines ~225–277)**

Find the block that calls `all<>(occUnion(sources))` (around line 239). Replace with `adapter.distinctValuesWithProvenance`:

```ts
const adapter = await getAdapter();
const refs = sources.map((s) => ({ table: parseSourceTable(s.table), column: s.column }));
const occRows = await adapter.distinctValuesWithProvenance(refs).catch(() => [] as { value: string }[]);
if (!occRows.length) return 0;
const warehouseRaws = [...new Set(occRows.map((r) => r.value))];
```

The rest of the function stays the same — `warehouseRaws` was the only output needed from the old block.

- [ ] **Step 3: Refactor `searchCatalog` (lines ~392–444)**

Replace the entire function body (everything inside the curly braces) with adapter-driven catalog browsing:

```ts
export async function searchCatalog(
  opts: { q?: string; schema?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: CatalogTable[]; total: number; schemas: { schema: string; tables: number }[] }> {
  if (!env.attachWarehouse) return { rows: [], total: 0, schemas: [] };
  const adapter = await getAdapter();
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  const all = await adapter.listTables({
    schema: opts.schema,
    search: opts.q,
  });
  const schemas = Object.values(
    all.reduce<Record<string, { schema: string; tables: number }>>((acc, t) => {
      acc[t.schema] ??= { schema: t.schema, tables: 0 };
      acc[t.schema].tables += 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b.tables - a.tables || a.schema.localeCompare(b.schema))
    .slice(0, 100);

  const rows = all.slice(offset, offset + limit).map((t) => ({
    schema: t.schema,
    table: `${t.schema}.${t.table}`,
    columns: [...t.columns],
  }));

  return { rows, total: all.length, schemas };
}
```

- [ ] **Step 4: Remove unused imports in `repo-scan.ts`**

Now that `whTable`, `occUnion`, `all`, `get` are no longer called inside `repo-scan.ts`, remove them from the top-of-file import. The final import block should be:

```ts
import { getAdapter } from "./warehouse/registry.ts";
import {
  type SourceInfo,
  type SchemaFacet,
  type CatalogTable,
  parseSourceTable,
  slug,
  qid,
  cq,
  liveSources,
  pgAll,
  pgGet,
  pgRun,
  env,
  pg,
  log,
} from "./repo-shared.ts";
import { appendAuditAs, getPreferences } from "./repo-meta.ts";
import { saveDraft, commit } from "./repo-drafts.ts";
```

- [ ] **Step 5: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 6: Tests pass**

```bash
cd server && bun test
```
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-scan.ts
git commit -m "refactor(scan): topUnmapped/autoStage/searchCatalog use adapter"
```

---

## Task 10: Refactor `repo-canonical.ts` — name resolution + multi-source scans

**Files:**
- Modify: `server/src/repo-canonical.ts`

- [ ] **Step 1: Update imports at the top of `repo-canonical.ts`**

Remove `whTable`, `occUnion`, `all` from the import. Add `parseSourceTable` and `getAdapter`:

```ts
import { getAdapter } from "./warehouse/registry.ts";
import {
  type DimensionMeta,
  type MappingDimension,
  type CanonicalValue,
  type MappingValue,
  type FieldDef,
  type OptionDef,
  type PaletteName,
  type SourceOccurrence,
  type NumberFormat,
  PALETTE_NAMES,
  parseSourceTable,
  slug,
  qid,
  cq,
  liveSources,
  dimMeta,
  parseFieldConfig,
  pgAll,
  pgGet,
  pgRun,
  pgTx,
  env,
  pg,
} from "./repo-shared.ts";
import { appendAuditAs } from "./repo-meta.ts";
```

- [ ] **Step 2: Refactor the name-resolution block in `getDimension` (around lines 152–164)**

Find the block that starts with `if (liveName) {` and contains `await all<{ id: string; nm: string }>(`. Replace with:

```ts
if (liveName) {
  const adapter = await getAdapter();
  const nameMap = await adapter
    .nameResolution(parseSourceTable(meta.nameTable!), meta.nameIdCol!, meta.nameCol!)
    .catch(() => new Map<string, string>());
  for (const r of canonRows) {
    const key = String(r.key);
    r.label = nameMap.get(key) ?? null;
    r.unresolved = !nameMap.has(key);
  }
}
```

- [ ] **Step 3: Refactor `scanValues` (around lines 205–296)**

Replace the `occRows` fetch (around line 220) with `adapter.distinctValuesWithProvenance`:

```ts
import type { ValueProvenance } from "./warehouse/adapter.ts";

// ... inside scanValues:
const adapter = await getAdapter();
const refs = sources.map((s) => ({ table: parseSourceTable(s.table), column: s.column }));
const occRows = await adapter
  .distinctValuesWithProvenance(refs)
  .catch(() => [] as ValueProvenance[]);
if (!occRows.length) return [];

// sourceIndex maps back to the original SourceDef so the UI shows schema.table.
const occMap = new Map<string, { tbl: string; col: string; rows: number }[]>();
for (const r of occRows) {
  const src = sources[r.sourceIndex];
  if (!src) continue;
  const key = r.value.toLowerCase();
  const entry = occMap.get(key) ?? [];
  entry.push({ tbl: src.table, col: src.column, rows: r.count });
  occMap.set(key, entry);
}
const raws = new Map<string, string>();
for (const r of occRows) {
  if (!raws.has(r.value.toLowerCase())) raws.set(r.value.toLowerCase(), r.value);
}
```

Then find the second name-resolution block, **inside the `scanValues` function** (around lines 247–261, starting with `const liveName =` and ending with the `for (const r of nameRows) nameMap.set(r.id, r.nm);` loop). Replace with:

```ts
const liveName =
  meta.keyKind === "external_id" &&
  env.attachWarehouse &&
  !!meta.nameTable &&
  !!meta.nameIdCol &&
  !!meta.nameCol;
const nameMap = new Map<string, string>();
if (liveName) {
  const adapter2 = await getAdapter();
  const resolved = await adapter2
    .nameResolution(parseSourceTable(meta.nameTable!), meta.nameIdCol!, meta.nameCol!)
    .catch(() => new Map<string, string>());
  for (const [k, v] of resolved) nameMap.set(k, v);
}
```

- [ ] **Step 4: Refactor `deriveCanonical` (around lines 478–562)**

Find the block:

```ts
const col = qid(column);
let vals: string[];
try {
  const rows = await all<{ v: string }>(
    `SELECT DISTINCT CAST(${col} AS VARCHAR) AS v FROM ${whTable(table)} ...`,
  );
  vals = rows.map((r) => r.v);
} catch {
  return { derived: 0 };
}
```

Replace with:

```ts
const adapter = await getAdapter();
const vals = await adapter
  .distinctValues(parseSourceTable(table), column, 5000)
  .catch(() => [] as string[]);
if (!vals.length) return { derived: 0 };
```

(Also remove the now-unused `const col = qid(column);` and `let vals: string[];` lines.)

- [ ] **Step 5: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 6: Tests pass**

```bash
cd server && bun test
```
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-canonical.ts
git commit -m "refactor(canonical): name resolution + scanValues + deriveCanonical use adapter"
```

---

## Task 11: Refactor `repo-drafts.ts:rowsRecovered` query (the last `occUnion` user)

**Files:**
- Modify: `server/src/repo-drafts.ts`

- [ ] **Step 1: Find the callsite**

```bash
grep -n "occUnion" /Users/fhagelund/Documents/GitHub/zugzug/server/src/repo-drafts.ts
```
Expected: hits at lines ~15 (import) and ~166 (use).

- [ ] **Step 2: Add adapter imports at the top of `repo-drafts.ts`**

Add to the existing imports (and remove `all` and `occUnion`):

```ts
import { getAdapter } from "./warehouse/registry.ts";
import { parseSourceTable } from "./repo-shared.ts";
import type { ValueProvenance } from "./warehouse/adapter.ts";
```

The remaining imports from `repo-shared.ts` should drop `all` and `occUnion` entirely.

- [ ] **Step 3: Rewrite `rowsForUnmappedDrafts` (lines 160–191)**

Replace the entire function body with:

```ts
async function rowsForUnmappedDrafts(dimId: string, mapTable: string): Promise<number> {
  const sources = await liveSources(dimId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values with per-source row counts.
  // Multiple sources may emit the same raw — we sum counts when summing total rows below
  // (matches the original UNION-ALL pattern's semantics: count each source-occurrence once).
  const adapter = await getAdapter();
  const refs = sources.map((s) => ({ table: parseSourceTable(s.table), column: s.column }));
  const provenance = await adapter
    .distinctValuesWithProvenance(refs)
    .catch(() => [] as ValueProvenance[]);
  if (!provenance.length) return 0;

  // Postgres: draft raws for this dimension with status=mapped
  const draftRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${pg("draft")} WHERE dim_id = $1 AND status = 'mapped'`,
    [dimId],
  );
  const draftSet = new Set(draftRows.map((r) => r.raw.toLowerCase()));

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // Sum rows for warehouse values that are in a draft but not yet mapped.
  // Iterate per-occurrence (not per-distinct-raw) to preserve the original UNION-ALL sum.
  let total = 0;
  for (const p of provenance) {
    const lower = p.value.toLowerCase();
    if (draftSet.has(lower) && !mappedSet.has(lower)) total += p.count;
  }
  return total;
}
```

- [ ] **Step 4: Typecheck + tests**

```bash
cd server && bun run typecheck && bun test
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-drafts.ts
git commit -m "refactor(drafts): rowsRecovered uses adapter.distinctValuesWithProvenance"
```

---

## Task 12: Delete `whTable`, `occUnion`, and DuckDB re-exports from `repo-shared.ts`

**Files:**
- Modify: `server/src/repo-shared.ts`

- [ ] **Step 1: Verify no remaining users**

```bash
grep -rn "whTable\\|occUnion" /Users/fhagelund/Documents/GitHub/zugzug/server/src/
```
Expected: matches only on the definitions in `repo-shared.ts` itself (around lines 277, 330).

If any file outside `warehouse/` still uses them, go back to the appropriate task — do not delete the helpers.

- [ ] **Step 2: Delete `whTable` definition**

In `server/src/repo-shared.ts`, delete lines defining `whTable` (lines 276-278). The comment above it also goes.

- [ ] **Step 3: Delete `occUnion` and the `esc` helper it uses**

In `server/src/repo-shared.ts`, delete the `esc` helper (line ~327) and the `occUnion` function (lines ~329-340).

- [ ] **Step 4: Delete the `all/get/run` re-exports**

Find this line near the bottom of `repo-shared.ts`:

```ts
export { all, get, run } from "./db.ts";
```

Delete it. App code must not reach `db.ts` directly any longer.

- [ ] **Step 5: Verify no callers were left dangling**

```bash
cd server && bun run typecheck
```
Expected: clean. If something fails with "all is not exported," that's a missed callsite — fix it.

- [ ] **Step 6: Tests pass**

```bash
cd server && bun test
```
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-shared.ts
git commit -m "refactor(shared): delete whTable, occUnion, and db.ts re-exports"
```

---

## Task 12b: Replace `connect()` in `server.ts` and `bootstrap.ts` with adapter ping

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/bootstrap.ts`

**Why this task exists:** the current `await connect()` calls open a DuckDB connection in the `db.ts` module-level cache, while `DuckDbAdapter` opens its own. Two connections per process is wasteful and confusing. Phase 1's invariant is one connection per workspace, owned by the adapter.

- [ ] **Step 1: Update `server.ts`**

Open `server/src/server.ts`. Find:

```ts
import { connect } from "./db.ts";
```
Delete it.

Find the call site (around line 40):

```ts
await connect();
console.log("· connected (MotherDuck + Postgres attached)");
```

Replace with:

```ts
const adapter = await getAdapter();
const ok = await adapter.ping();
if (!ok) {
  console.error("✗ warehouse adapter ping failed");
  process.exit(1);
}
console.log(`· connected (${adapter.capabilities.id}${adapter.capabilities.writable ? ", writable" : ", read-only"})`);
```

Add the import at the top of `server.ts` if it's not already there from Task 5:

```ts
import { getAdapter } from "./warehouse/registry.ts";
```

(The `registerFactories({...})` call from Task 5 stays — it must execute before `getAdapter()` runs.)

- [ ] **Step 2: Update `bootstrap.ts`**

Open `server/src/bootstrap.ts`. Find:

```ts
import { connect } from "./db.ts";
```
Delete it.

Add the imports it needs:

```ts
import { registerFactories } from "./warehouse/credentials.ts";
import { DuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { getAdapter } from "./warehouse/registry.ts";
```

At the top of the bootstrap script, before any `await` calls, register the factories (mirror of `server.ts`'s Task 5 Step 5 — placeholder lambda for snowflake; Task 13 swaps it for the real stub class):

```ts
registerFactories({
  duckdb: async (creds) => new DuckDbAdapter(creds),
  snowflake: async () => {
    throw new Error("Snowflake adapter ships in Phase 2");
  },
});
```

Find the call site (around line 50):

```ts
if (seed) {
  await connect();
  await seedDemo();
  console.log("· demo dimensions seeded (Country, Channel)");
}
```

Replace `await connect()` with:

```ts
if (seed) {
  await getAdapter(); // warm the connection
  await seedDemo();
  console.log("· demo dimensions seeded (Country, Channel)");
}
```

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean.

- [ ] **Step 4: Tests pass**

```bash
cd server && bun test
```
Expected: pass.

- [ ] **Step 5: Smoke `bun run start`**

```bash
cd server && bun run start
```
Expected: server boots and logs `· connected (duckdb, read-only)` (or similar). Ctrl-C to stop.

- [ ] **Step 6: Smoke `bun run bootstrap`**

```bash
cd server && bun run bootstrap
```
Expected: bootstrap runs without errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/server.ts server/src/bootstrap.ts
git commit -m "refactor(runtime): server.ts + bootstrap.ts use adapter, not db.ts directly"
```

---

## Task 13: Stub `SnowflakeAdapter`

**Files:**
- Create: `server/src/warehouse/snowflake/index.ts`

- [ ] **Step 1: Write the stub**

Create `server/src/warehouse/snowflake/index.ts`:

```ts
import type {
  AdapterCapabilities,
  CatalogTable,
  ColumnMeta,
  DimensionSpec,
  Ref,
  ValueCount,
  ValueProvenance,
  WritableWarehouseAdapter,
  ApprovedDraft,
  CommitResult,
} from "../adapter.ts";
import type { SnowflakeCreds } from "../credentials.ts";

/**
 * Phase 2 — full implementation. This stub exists so the factory registry
 * compiles and so contributors can see the interface obligations for a
 * second-adapter PR.
 */
export class SnowflakeAdapter implements WritableWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true };
  private readonly creds: SnowflakeCreds;

  constructor(creds: SnowflakeCreds) {
    this.creds = creds;
    this.capabilities = {
      id: "snowflake",
      writable: true,
      supportsMerge: true,
      identifierCase: "upper",
      supportsApproximateDistinct: true,
    };
  }

  quoteIdentifier(_name: string): string {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  qualifyRef(_t: Ref): string {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  castToString(_e: string): string {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  ping(): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  listTables(): Promise<CatalogTable[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  listColumns(_t: Ref): Promise<ColumnMeta[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  tableExists(_t: Ref): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  distinctValues(_t: Ref, _c: string, _n: number): Promise<string[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  topValuesByFrequency(_t: Ref, _c: string, _n: number): Promise<ValueCount[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  columnStats(_t: Ref, _c: string): Promise<{ rows: number; distinct: number }> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  nameResolution(_t: Ref, _i: string, _n: string): Promise<Map<string, string>> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  distinctValuesWithProvenance(
    _s: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  ensureCanonicalTables(_d: DimensionSpec): Promise<void> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  commitCanonical(_d: DimensionSpec, _x: ApprovedDraft[]): Promise<CommitResult> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
}
```

- [ ] **Step 2: Wire the factory in `server.ts` AND `bootstrap.ts`**

Both files registered a `snowflake: async () => { throw ... }` placeholder lambda (Task 5 Step 5 and Task 12b Step 2). Replace each with a real `SnowflakeAdapter` instantiation.

In `server/src/server.ts`, add the import near the top:

```ts
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
```

Replace the `registerFactories({...})` block with:

```ts
registerFactories({
  duckdb: async (creds) => new DuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});
```

Repeat the same two edits in `server/src/bootstrap.ts` — import `SnowflakeAdapter`, swap the placeholder lambda for the real class.

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean. The stub methods throw at runtime, but the class shape satisfies `WritableWarehouseAdapter`.

- [ ] **Step 4: Tests still pass**

```bash
cd server && bun test
```
Expected: pass. (No test currently calls the Snowflake factory, so the runtime throw never fires.)

- [ ] **Step 5: Commit**

```bash
git add server/src/warehouse/snowflake/ server/src/server.ts server/src/bootstrap.ts
git commit -m "feat(warehouse): SnowflakeAdapter stub (Phase 2 placeholder)"
```

---

## Task 14: Verification gates

**Files:** none modified — this task only runs checks.

- [ ] **Step 1: Grep gate — `whTable` and `occUnion` are gone**

```bash
grep -rn "whTable\\|occUnion" /Users/fhagelund/Documents/GitHub/zugzug/server/src/ 2>/dev/null
```
Expected: zero matches.

If any matches exist, return to Task 12 and finish removing them.

- [ ] **Step 2: Grep gate — only dev scripts import `db.ts`**

```bash
grep -rn 'from "\\./db\\.ts"\\|from "\\./db"' /Users/fhagelund/Documents/GitHub/zugzug/server/src/ 2>/dev/null
```
Expected matches ONLY in: `server/src/verify-*.ts` and `server/src/spike.ts` (dev scripts, out of scope for Phase 1).

If `warehouse/duckdb/index.ts`, `server.ts`, `bootstrap.ts`, `repo-scan.ts`, `repo-canonical.ts`, `repo-drafts.ts`, or `repo-shared.ts` appears in the output, that's a leak:
- For `warehouse/duckdb/index.ts`: the adapter owns its own connection (Task 5) — must not re-import `db.ts`.
- For app code: return to the appropriate refactor task.

- [ ] **Step 3: Full typecheck + lint + test sweep**

```bash
cd server && bun run typecheck && bun run lint && bun test
```
Expected: all three pass.

- [ ] **Step 4: Manual UI smoke**

In one terminal:
```bash
cd server && bun run start
```

In another:
```bash
cd app && bun run dev
```

Open <http://localhost:5173/app>. Walk through:
1. Dashboard — KPI cards, activity feed render.
2. Sources — list loads, search works, filter chips work, a "what's broken" reveal shows top-N unmapped on a row.
3. Triage — value workbench loads for a dimension; accept/skip/merge an unmapped value, stage it.
4. Tables — at least one dimension loads with canonical rows; rename a row, change a column type.
5. Settings — Scans section shows status; preferences save.

The flow should be feature-equivalent to before the refactor. Any regression is a phase-1 failure — back-track to the offending refactor task.

- [ ] **Step 5: Final commit (if no changes needed)**

Nothing to commit unless the smoke surfaced a regression. If clean, write a phase-completion note:

```bash
git log --oneline -20
```

Confirm the commits trace the full sequence:
- chore: add zod
- feat: scaffold WarehouseAdapter interface
- feat: credentials schemas + factory registry
- feat: adapter registry
- feat: DuckDbAdapter helpers + ping
- feat: DuckDbAdapter read methods
- refactor: liveSources via adapter
- refactor: scanSources via adapter
- refactor: topUnmapped/autoStage/searchCatalog via adapter
- refactor: canonical (name resolution + scanValues + deriveCanonical) via adapter
- refactor: drafts (rowsRecovered) via adapter
- refactor: delete whTable/occUnion/db.ts re-exports
- feat: SnowflakeAdapter stub

If any commit is missing or labeled incorrectly, the history needs cleanup before opening a PR.

---

## Self-review summary

**Spec coverage (Phase 1 only):**
- `WarehouseAdapter` interface with discriminated union — Task 2 ✓
- Zod credentials + typed factory registry — Task 3 ✓
- Registry with per-workspace cache (env-driven for now) — Task 4 ✓
- `DuckDbAdapter` covering DuckDB + MotherDuck — Tasks 5-6 ✓
- All warehouse callsites routed through adapter — Tasks 7-11 ✓
- `whTable`/`occUnion` deleted from `repo-shared.ts` — Task 12 ✓
- Snowflake stub so factory registry compiles — Task 13 ✓
- Grep gates + typecheck + tests + UI smoke — Task 14 ✓

**Out of scope for Phase 1 (per spec):**
- Actual Snowflake adapter — Phase 2.
- `WritableWarehouseAdapter.commitCanonical` and `ensureCanonicalTables` against a real warehouse — Phase 3.
- `exportCanonicalSnapshot` / Parquet writer — Phase 3.
- Workspace credentials table in Postgres — Phase 4 (multi-tenant + auth refactor).

**Known small spec amendment, captured in plan:** `distinctValuesWithProvenance(sources)` added to the interface to preserve the current single-query multi-source scan pattern (avoids N round-trips). This will need a mirroring entry in the spec under the next revision pass.
