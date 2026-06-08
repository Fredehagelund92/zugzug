# Phase 2 — Implement `SnowflakeAdapter` (no live instance)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `SnowflakeAdapter` stub at `server/src/warehouse/snowflake/index.ts` with a real implementation backed by `snowflake-sdk` for Node — all 8 read methods, plus `ensureCanonicalTables` and `commitCanonical` for the writable path. No live Snowflake instance is available; tests use a constructor-injected mock connection. Methods needing real-account verification are marked with `// LIVE-VALIDATION:` comments so a future smoke pass can run them by hand.

**Architecture:** SnowflakeAdapter accepts a `SnowflakeConnection` (promise-shaped abstraction) via the constructor. In production, the factory creates a real connection wrapping `snowflake-sdk`'s callback API with `util.promisify`. In tests, a fake connection object captures executed SQL and returns canned result rows. Identifier quoting follows Snowflake's case-folding rules: unquoted identifiers become UPPERCASE; quoted identifiers preserve case verbatim. The `commitCanonical` write path uses Snowflake's `MERGE INTO ... USING (VALUES ...)` syntax with chunked batches.

**Tech Stack:** `snowflake-sdk` (Node driver, callback API), `@types/snowflake-sdk` (devDep), Zod (already in `credentials.ts`), `bun:test`.

**Spec reference:** `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (Phase 2 section).

**Spec deviation:** the spec's Phase 2 verification gate ("full Sources → Triage → commit-to-warehouse flow works end-to-end against real Snowflake") is unsatisfiable without credentials. This plan replaces it with a tighter unit-test gate. The live-validation step becomes a follow-up task once credentials exist.

---

## Verification gate (must all pass at end of phase)

1. `cd server && bun run typecheck` — clean.
2. `cd server && bun run lint` — clean.
3. `cd server && bun run format:check` — clean.
4. `cd server && bun test` — all existing tests (36+) pass AND new SnowflakeAdapter tests pass.
5. `grep -n "Task 6 — not implemented\|SnowflakeAdapter — Phase 2" server/src/warehouse/snowflake/index.ts` — zero matches.
6. `cd server && bun run start` — server boots without errors (Snowflake factory wired but not invoked since DuckDB is the configured default).
7. The SnowflakeAdapter class structurally implements `WritableWarehouseAdapter` (verified by typecheck; the discriminated-union type forces this).

---

## File structure (post-phase)

```
server/
  package.json                              # snowflake-sdk + @types/snowflake-sdk added
server/src/warehouse/snowflake/
  index.ts                                  # SnowflakeAdapter — bulk of the implementation
  sdk-wrapper.ts                            # NEW — SnowflakeConnection promise wrapper + factory
server/test/
  warehouse-snowflake.test.ts               # NEW — unit tests with mocked connection
  warehouse-snowflake-sql.fixture.md        # NEW — documented expected SQL strings for live validation
```

---

## Task 1: Add `snowflake-sdk` and `@types/snowflake-sdk` deps

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add dependencies**

Run from `server/`:
```bash
bun add snowflake-sdk
bun add -d @types/snowflake-sdk
```

- [ ] **Step 2: Verify install**

```bash
bun pm ls | grep -E "(snowflake-sdk|@types/snowflake-sdk)"
```
Expected: both packages listed.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/bun.lock
git commit -m "chore(server): add snowflake-sdk + @types/snowflake-sdk for Phase 2"
```

---

## Task 2: Build `SnowflakeConnection` promise wrapper

**Files:**
- Create: `server/src/warehouse/snowflake/sdk-wrapper.ts`

The `snowflake-sdk` package uses a callback-style API (`connection.execute({ sqlText, binds, complete: (err, stmt, rows) => ... })`). The adapter needs promises. This wrapper isolates the callback-to-promise translation in one file so the adapter logic stays linear.

- [ ] **Step 1: Write the file**

Create `server/src/warehouse/snowflake/sdk-wrapper.ts` with EXACT content:

```ts
import snowflake from "snowflake-sdk";
import type { SnowflakeCreds } from "../credentials.ts";

// Minimal promise-shaped surface the adapter uses. Implementations:
//   - createRealConnection (production)
//   - mock connection (tests)
export interface SnowflakeConnection {
  /** Execute a SQL statement with optional positional binds.
   *  Returns the result rows as plain objects (column names lowercase by default
   *  — see Snowflake's case-folding notes in the adapter). */
  execute(opts: { sqlText: string; binds?: unknown[] }): Promise<Record<string, unknown>[]>;

  /** Execute a SQL statement and return the number of rows affected.
   *  Used by writable operations (MERGE INTO, INSERT). */
  executeAffected(opts: { sqlText: string; binds?: unknown[] }): Promise<number>;

  /** Close the underlying connection (called once at process exit; tests don't need to call). */
  close(): Promise<void>;
}

/** Production factory: wraps the real snowflake-sdk callback API in promises.
 *  LIVE-VALIDATION: this function is unverified against a real Snowflake account
 *  until credentials exist. The error path (auth failure, network) needs a
 *  smoke pass before claiming production-ready. */
export function createRealConnection(creds: SnowflakeCreds): SnowflakeConnection {
  // LIVE-VALIDATION: key-pair auth format. snowflake-sdk expects either:
  //   - authenticator: 'SNOWFLAKE_JWT' + privateKey: <PEM string>
  //   - authenticator: 'SNOWFLAKE' + password
  // The PEM must include the BEGIN/END markers. If the user passes a path,
  // they must load it themselves before constructing creds.
  const connection = snowflake.createConnection({
    account: creds.account,
    username: creds.user,
    authenticator: "SNOWFLAKE_JWT",
    privateKey: creds.privateKey,
    privateKeyPass: creds.privateKeyPassphrase,
    warehouse: creds.warehouse,
    database: creds.database,
    schema: creds.schema,
  });

  // Single-flight connect; subsequent execute() calls reuse it.
  let connected: Promise<void> | null = null;
  function ensureConnected(): Promise<void> {
    if (connected) return connected;
    connected = new Promise<void>((resolve, reject) => {
      connection.connect((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return connected;
  }

  return {
    async execute(opts) {
      await ensureConnected();
      return new Promise<Record<string, unknown>[]>((resolve, reject) => {
        connection.execute({
          sqlText: opts.sqlText,
          binds: opts.binds as snowflake.Binds | undefined,
          complete: (err, _stmt, rows) => {
            if (err) reject(err);
            else resolve((rows ?? []) as Record<string, unknown>[]);
          },
        });
      });
    },

    async executeAffected(opts) {
      await ensureConnected();
      return new Promise<number>((resolve, reject) => {
        connection.execute({
          sqlText: opts.sqlText,
          binds: opts.binds as snowflake.Binds | undefined,
          complete: (err, stmt) => {
            if (err) return reject(err);
            // LIVE-VALIDATION: confirm getNumUpdatedRows() returns the MERGE row count.
            // Per docs, MERGE statements set "number of rows affected" reflecting
            // INSERTed + UPDATEd + DELETEd. With INSERT-only MERGE the count = inserts.
            resolve(stmt?.getNumUpdatedRows?.() ?? 0);
          },
        });
      });
    },

    async close() {
      return new Promise<void>((resolve, reject) => {
        connection.destroy((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: clean. If `snowflake.Binds` doesn't exist on the imported namespace, fall back to `unknown[]` for the cast.

- [ ] **Step 3: Commit**

```bash
git add server/src/warehouse/snowflake/sdk-wrapper.ts
git commit -m "feat(snowflake): promise wrapper around snowflake-sdk callback API"
```

---

## Task 3: Replace `SnowflakeAdapter` stub with constructor-injectable shell

**Files:**
- Modify: `server/src/warehouse/snowflake/index.ts`
- Create: `server/test/warehouse-snowflake.test.ts`

This task replaces the stub class with a working shell that:
- Accepts a `SnowflakeConnection` via the constructor (default: real connection from `sdk-wrapper.ts`).
- Implements the 3 SQL-fragment helpers (`quoteIdentifier`, `qualifyRef`, `castToString`).
- Stubs the 11 query methods (still throw `"SnowflakeAdapter — Phase 2"` — they're replaced in Tasks 4–9).

### Step 1 — Write the failing tests

Create `server/test/warehouse-snowflake.test.ts` with EXACT content:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { SnowflakeAdapter } from "../src/warehouse/snowflake/index.ts";
import type { SnowflakeConnection } from "../src/warehouse/snowflake/sdk-wrapper.ts";
import type { SnowflakeCreds } from "../src/warehouse/credentials.ts";

const CREDS: SnowflakeCreds = {
  type: "snowflake",
  account: "abc123.eu-west-1",
  user: "BOT",
  privateKey: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----",
  warehouse: "WH",
  database: "ANALYTICS",
  schema: "PUBLIC",
};

// MockConnection captures every execute() call and returns canned rows.
interface ExecuteCall {
  sqlText: string;
  binds?: unknown[];
}

function mockConn(responder: (call: ExecuteCall) => Record<string, unknown>[]): {
  conn: SnowflakeConnection;
  calls: ExecuteCall[];
} {
  const calls: ExecuteCall[] = [];
  const conn: SnowflakeConnection = {
    async execute(opts) {
      calls.push({ sqlText: opts.sqlText, binds: opts.binds });
      return responder({ sqlText: opts.sqlText, binds: opts.binds });
    },
    async executeAffected(opts) {
      calls.push({ sqlText: opts.sqlText, binds: opts.binds });
      const rows = responder({ sqlText: opts.sqlText, binds: opts.binds });
      // Tests fake "rows affected" via a special _affected column.
      const first = rows[0] as { _affected?: number } | undefined;
      return first?._affected ?? 0;
    },
    async close() {},
  };
  return { conn, calls };
}

test("quoteIdentifier wraps in double quotes and escapes embedded quotes", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.quoteIdentifier("FOO")).toBe('"FOO"');
  expect(a.quoteIdentifier('weird"name')).toBe('"weird""name"');
});

test("qualifyRef builds database.schema.table 3-part, defaulting database from creds", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.qualifyRef({ schema: "RAW", table: "PARTNERS" })).toBe('"ANALYTICS"."RAW"."PARTNERS"');
});

test("qualifyRef respects explicit catalog override on the Ref", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.qualifyRef({ catalog: "OTHER_DB", schema: "RAW", table: "T" })).toBe(
    '"OTHER_DB"."RAW"."T"',
  );
});

test("castToString wraps in CAST(... AS VARCHAR) — Snowflake accepts this", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.castToString('"COL"')).toBe('CAST("COL" AS VARCHAR)');
});

test("capabilities are writable Snowflake defaults", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.capabilities.id).toBe("snowflake");
  expect(a.capabilities.writable).toBe(true);
  expect(a.capabilities.supportsMerge).toBe(true);
  expect(a.capabilities.identifierCase).toBe("upper");
  expect(a.capabilities.supportsApproximateDistinct).toBe(true);
});
```

### Step 2 — Verify tests fail

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: tests FAIL — `SnowflakeAdapter` doesn't accept the connection factory parameter and methods throw.

### Step 3 — Rewrite the stub

Replace ENTIRE contents of `server/src/warehouse/snowflake/index.ts` with:

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
import { createRealConnection, type SnowflakeConnection } from "./sdk-wrapper.ts";

/**
 * SnowflakeAdapter — writable warehouse adapter using snowflake-sdk.
 *
 * Connection is constructor-injected so tests can pass a mock. Production
 * code calls `new SnowflakeAdapter(creds)` and gets the real connection
 * via `createRealConnection` (the default factory).
 *
 * Identifier case-folding (the #1 footgun): Snowflake stores UNQUOTED
 * identifiers as UPPERCASE. Quoting (`"foo"`) preserves case verbatim. The
 * adapter always quotes, which means a column the user named `foo` lower-case
 * via `CREATE TABLE t ("foo" VARCHAR)` is referred to as `"foo"`, while a
 * column named `foo` unquoted (becomes `FOO`) is `"FOO"`. The Ref/column
 * inputs to this adapter must already be in the correct case — the Sources
 * registration UI (Phase 4) is responsible for that.
 */
export class SnowflakeAdapter implements WritableWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true };

  private readonly creds: SnowflakeCreds;
  private conn: SnowflakeConnection | null = null;
  private readonly connectionFactory: (creds: SnowflakeCreds) => SnowflakeConnection;

  constructor(
    creds: SnowflakeCreds,
    connectionFactory: (creds: SnowflakeCreds) => SnowflakeConnection = createRealConnection,
  ) {
    this.creds = creds;
    this.connectionFactory = connectionFactory;
    this.capabilities = {
      id: "snowflake",
      writable: true,
      supportsMerge: true,
      identifierCase: "upper",
      supportsApproximateDistinct: true,
    };
  }

  // ---- helpers ----

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  qualifyRef(table: Ref): string {
    const catalog = table.catalog ?? this.creds.database;
    return `${this.quoteIdentifier(catalog)}.${this.quoteIdentifier(table.schema)}.${this.quoteIdentifier(table.table)}`;
  }

  castToString(expr: string): string {
    return `CAST(${expr} AS VARCHAR)`;
  }

  // ---- connection lifecycle (internal) ----

  private getConnection(): SnowflakeConnection {
    if (!this.conn) this.conn = this.connectionFactory(this.creds);
    return this.conn;
  }

  // ---- the rest of the interface — implemented in Tasks 4–9 ----

  ping(): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 4");
  }
  listTables(_opts?: { schema?: string; search?: string }): Promise<CatalogTable[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 5");
  }
  listColumns(_table: Ref): Promise<ColumnMeta[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 5");
  }
  tableExists(_table: Ref): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 5");
  }
  distinctValues(_table: Ref, _column: string, _limit: number): Promise<string[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  topValuesByFrequency(_table: Ref, _column: string, _limit: number): Promise<ValueCount[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  columnStats(
    _table: Ref,
    _column: string,
    _opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  nameResolution(_table: Ref, _idCol: string, _nameCol: string): Promise<Map<string, string>> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  distinctValuesWithProvenance(
    _sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 7");
  }
  ensureCanonicalTables(_dim: DimensionSpec): Promise<void> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 8");
  }
  commitCanonical(_dim: DimensionSpec, _drafts: ApprovedDraft[]): Promise<CommitResult> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 9");
  }
}
```

### Step 4 — Run tests, verify they pass

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: all 5 tests pass.

### Step 5 — Typecheck

```bash
cd server && bun run typecheck
```
Expected: clean.

### Step 6 — Commit

```bash
git add server/src/warehouse/snowflake/index.ts server/test/warehouse-snowflake.test.ts
git commit -m "feat(snowflake): adapter shell with injected connection + helpers"
```

---

## Task 4: Implement `ping()`

**Files:**
- Modify: `server/src/warehouse/snowflake/index.ts`
- Modify: `server/test/warehouse-snowflake.test.ts`

### Step 1 — Add failing test

Append to `server/test/warehouse-snowflake.test.ts`:

```ts
test("ping returns true when SELECT 1 succeeds", async () => {
  const { conn, calls } = mockConn((call) => {
    if (call.sqlText.trim().toUpperCase() === "SELECT 1 AS OK") {
      return [{ OK: 1 }]; // Snowflake returns column names UPPERCASE by default
    }
    return [];
  });
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.ping()).resolves.toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].sqlText.trim()).toBe("SELECT 1 AS OK");
});

test("ping returns false when connection throws", async () => {
  const conn: SnowflakeConnection = {
    async execute() {
      throw new Error("connection refused");
    },
    async executeAffected() {
      return 0;
    },
    async close() {},
  };
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.ping()).resolves.toBe(false);
});
```

### Step 2 — Run, verify failure

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 2 new tests FAIL with `SnowflakeAdapter — Phase 2 Task 4`.

### Step 3 — Implement `ping()`

In `server/src/warehouse/snowflake/index.ts`, replace the `ping()` stub with:

```ts
async ping(): Promise<boolean> {
  try {
    const rows = await this.getConnection().execute({ sqlText: "SELECT 1 AS OK" });
    // LIVE-VALIDATION: Snowflake column names default to UPPERCASE on read.
    // Confirm `OK` (uppercase) is the actual key in returned row objects.
    const first = rows[0] as { OK?: number } | undefined;
    return first?.OK === 1;
  } catch {
    return false;
  }
}
```

### Step 4 — Run tests, verify they pass

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 7 tests pass (5 from Task 3 + 2 new).

### Step 5 — Commit

```bash
git add server/src/warehouse/snowflake/index.ts server/test/warehouse-snowflake.test.ts
git commit -m "feat(snowflake): ping() via SELECT 1"
```

---

## Task 5: Implement catalog methods (`tableExists`, `listTables`, `listColumns`)

**Files:**
- Modify: `server/src/warehouse/snowflake/index.ts`
- Modify: `server/test/warehouse-snowflake.test.ts`

Snowflake uses `INFORMATION_SCHEMA` views for catalog browsing. Each view is per-database (`<DB>.INFORMATION_SCHEMA.TABLES`).

### Step 1 — Add failing tests

Append to `server/test/warehouse-snowflake.test.ts`:

```ts
test("tableExists: returns true when SELECT 1 ... LIMIT 0 succeeds", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const ok = await a.tableExists({ schema: "RAW", table: "PARTNERS" });
  expect(ok).toBe(true);
  expect(calls[0].sqlText).toContain('SELECT 1 FROM "ANALYTICS"."RAW"."PARTNERS" LIMIT 0');
});

test("tableExists: returns false when execute throws", async () => {
  const conn: SnowflakeConnection = {
    async execute() {
      throw new Error("Table 'ANALYTICS.RAW.NOPE' does not exist");
    },
    async executeAffected() {
      return 0;
    },
    async close() {},
  };
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.tableExists({ schema: "RAW", table: "NOPE" })).resolves.toBe(false);
});

test("listTables: queries INFORMATION_SCHEMA.TABLES + COLUMNS, merges by (schema, table)", async () => {
  const { conn, calls } = mockConn((call) => {
    if (call.sqlText.includes("INFORMATION_SCHEMA.TABLES")) {
      return [
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "COUNTRIES" },
      ];
    }
    if (call.sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
      return [
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS", COLUMN_NAME: "ID" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS", COLUMN_NAME: "NAME" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS", COLUMN_NAME: "REGION" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "COUNTRIES", COLUMN_NAME: "CODE" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "COUNTRIES", COLUMN_NAME: "LABEL" },
      ];
    }
    return [];
  });
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const tables = await a.listTables({});
  expect(tables).toHaveLength(2);
  const partners = tables.find((t) => t.table === "PARTNERS");
  expect(partners?.schema).toBe("RAW");
  expect(partners?.columns).toEqual(["ID", "NAME", "REGION"]);
  // Confirms two-query strategy (TABLES + COLUMNS), not a single join (which is fine but slower at scale)
  expect(calls.length).toBe(2);
});

test("listTables: schema filter narrows the WHERE clause", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.listTables({ schema: "MARKETING" });
  // Both queries (TABLES and COLUMNS) should bind the schema filter
  for (const c of calls) {
    expect(c.binds).toContain("MARKETING");
  }
});

test("listTables: search filter applies to schema, table, or column name", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.listTables({ search: "partner" });
  // search becomes %partner% bound to the ILIKE pattern (case-insensitive)
  const allBinds = calls.flatMap((c) => c.binds ?? []);
  expect(allBinds).toContain("%partner%");
});

test("listColumns: returns name + type from INFORMATION_SCHEMA.COLUMNS", async () => {
  const { conn, calls } = mockConn((call) => {
    if (call.sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
      return [
        { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER" },
        { COLUMN_NAME: "NAME", DATA_TYPE: "VARCHAR" },
      ];
    }
    return [];
  });
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const cols = await a.listColumns({ schema: "RAW", table: "PARTNERS" });
  expect(cols).toEqual([
    { name: "ID", type: "NUMBER" },
    { name: "NAME", type: "VARCHAR" },
  ]);
  // Confirms the query binds schema and table separately
  expect(calls[0].binds).toEqual(["RAW", "PARTNERS"]);
});
```

### Step 2 — Run, verify failure

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 6 new tests FAIL.

### Step 3 — Implement the three catalog methods

In `server/src/warehouse/snowflake/index.ts`, replace the three stubs (`tableExists`, `listTables`, `listColumns`) with:

```ts
async tableExists(table: Ref): Promise<boolean> {
  try {
    // LIVE-VALIDATION: Snowflake supports `SELECT ... LIMIT 0` for an existence
    // probe; confirm this doesn't trigger a warehouse-resume on a suspended
    // warehouse (it shouldn't — LIMIT 0 is a metadata-only query).
    await this.getConnection().execute({
      sqlText: `SELECT 1 FROM ${this.qualifyRef(table)} LIMIT 0`,
    });
    return true;
  } catch {
    return false;
  }
}

async listTables(opts: { schema?: string; search?: string } = {}): Promise<CatalogTable[]> {
  const db = this.quoteIdentifier(this.creds.database);
  // LIVE-VALIDATION: INFORMATION_SCHEMA.TABLES view shape. Confirm TABLE_SCHEMA
  // and TABLE_NAME column names. Also confirm TABLE_TYPE values — we want
  // 'BASE TABLE' and 'VIEW' (Snowflake also has 'EXTERNAL TABLE', 'TEMPORARY').
  const tableBinds: unknown[] = [];
  let tableWhere = `TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA') AND TABLE_TYPE IN ('BASE TABLE','VIEW')`;
  if (opts.schema) {
    tableBinds.push(opts.schema);
    tableWhere += ` AND TABLE_SCHEMA = ?`;
  }
  if (opts.search) {
    tableBinds.push(`%${opts.search}%`);
    tableWhere += ` AND (TABLE_SCHEMA ILIKE ? OR TABLE_NAME ILIKE ?)`;
    // Bind the same pattern twice (Snowflake ILIKE doesn't deduplicate binds).
    tableBinds.push(`%${opts.search}%`);
  }
  const tableRows = await this.getConnection().execute({
    sqlText: `SELECT TABLE_SCHEMA, TABLE_NAME
              FROM ${db}.INFORMATION_SCHEMA.TABLES
              WHERE ${tableWhere}
              ORDER BY TABLE_SCHEMA, TABLE_NAME
              LIMIT 5000`,
    binds: tableBinds,
  });

  // LIVE-VALIDATION: Snowflake INFORMATION_SCHEMA.COLUMNS is per-database. The
  // join below uses TABLE_SCHEMA + TABLE_NAME, identical to TABLES.
  const colBinds: unknown[] = [];
  let colWhere = `TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA')`;
  if (opts.schema) {
    colBinds.push(opts.schema);
    colWhere += ` AND TABLE_SCHEMA = ?`;
  }
  // Apply the same search filter to columns so a search by column name surfaces
  // the parent table (matches Phase 1 DuckDB behavior).
  if (opts.search) {
    colBinds.push(`%${opts.search}%`);
    colWhere += ` AND (TABLE_SCHEMA ILIKE ? OR TABLE_NAME ILIKE ? OR COLUMN_NAME ILIKE ?)`;
    colBinds.push(`%${opts.search}%`);
    colBinds.push(`%${opts.search}%`);
  }
  const colRows = await this.getConnection().execute({
    sqlText: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
              FROM ${db}.INFORMATION_SCHEMA.COLUMNS
              WHERE ${colWhere}
              ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
              LIMIT 100000`,
    binds: colBinds,
  });

  // Build the (schema, table) → [column...] map.
  const colsByTable = new Map<string, string[]>();
  for (const r of colRows as Array<{ TABLE_SCHEMA: string; TABLE_NAME: string; COLUMN_NAME: string }>) {
    const key = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`;
    const arr = colsByTable.get(key) ?? [];
    arr.push(r.COLUMN_NAME);
    colsByTable.set(key, arr);
  }

  // Search-by-column surfaces tables that aren't in `tableRows` (columns were
  // matched but the parent table didn't match TABLE_SCHEMA/TABLE_NAME). Union
  // them in so the result mirrors DuckDB's behavior.
  const seen = new Set<string>();
  const result: CatalogTable[] = [];
  for (const t of tableRows as Array<{ TABLE_SCHEMA: string; TABLE_NAME: string }>) {
    const key = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`;
    seen.add(key);
    result.push({
      schema: t.TABLE_SCHEMA,
      table: t.TABLE_NAME,
      columns: colsByTable.get(key) ?? [],
    });
  }
  if (opts.search) {
    for (const [key, cols] of colsByTable) {
      if (seen.has(key)) continue;
      const [schema, table] = key.split(".");
      result.push({ schema, table, columns: cols });
    }
  }
  return result;
}

async listColumns(table: Ref): Promise<ColumnMeta[]> {
  const db = this.quoteIdentifier(table.catalog ?? this.creds.database);
  // LIVE-VALIDATION: Snowflake exposes DATA_TYPE on INFORMATION_SCHEMA.COLUMNS;
  // confirm casing (NUMBER vs INT, VARCHAR vs TEXT) doesn't surprise consumers.
  const rows = await this.getConnection().execute({
    sqlText: `SELECT COLUMN_NAME, DATA_TYPE
              FROM ${db}.INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
              ORDER BY ORDINAL_POSITION`,
    binds: [table.schema, table.table],
  });
  return (rows as Array<{ COLUMN_NAME: string; DATA_TYPE: string }>).map((r) => ({
    name: r.COLUMN_NAME,
    type: r.DATA_TYPE,
  }));
}
```

### Step 4 — Run tests, verify they pass

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 13 tests pass (7 + 6 new).

### Step 5 — Commit

```bash
git add server/src/warehouse/snowflake/index.ts server/test/warehouse-snowflake.test.ts
git commit -m "feat(snowflake): catalog methods (tableExists, listTables, listColumns)"
```

---

## Task 6: Implement value-scan methods (`distinctValues`, `topValuesByFrequency`, `columnStats`, `nameResolution`)

**Files:**
- Modify: `server/src/warehouse/snowflake/index.ts`
- Modify: `server/test/warehouse-snowflake.test.ts`

### Step 1 — Add failing tests

Append to `server/test/warehouse-snowflake.test.ts`:

```ts
test("distinctValues: SELECT DISTINCT CAST(... AS VARCHAR) ORDER BY 1 LIMIT n", async () => {
  const { conn, calls } = mockConn(() => [
    { V: "EU" },
    { V: "US" },
    { V: "us" },
  ]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const vals = await a.distinctValues({ schema: "RAW", table: "PARTNERS" }, "REGION", 100);
  expect(vals).toEqual(["EU", "US", "us"]);
  expect(calls[0].sqlText).toContain('SELECT DISTINCT CAST("REGION" AS VARCHAR) AS V');
  expect(calls[0].sqlText).toContain('FROM "ANALYTICS"."RAW"."PARTNERS"');
  expect(calls[0].sqlText).toContain('"REGION" IS NOT NULL');
  expect(calls[0].sqlText).toContain("LIMIT 100");
});

test("distinctValues: limit is clamped to [1, 100000]", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.distinctValues({ schema: "RAW", table: "T" }, "C", 999999999);
  expect(calls[0].sqlText).toContain("LIMIT 100000");
  await a.distinctValues({ schema: "RAW", table: "T" }, "C", 0);
  expect(calls[1].sqlText).toContain("LIMIT 1");
});

test("topValuesByFrequency: GROUP BY 1 + COUNT(*) + ORDER BY n DESC", async () => {
  const { conn, calls } = mockConn(() => [
    { V: "EU", N: 2 },
    { V: "US", N: 1 },
  ]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const top = await a.topValuesByFrequency({ schema: "RAW", table: "PARTNERS" }, "REGION", 10);
  expect(top).toEqual([
    { value: "EU", count: 2 },
    { value: "US", count: 1 },
  ]);
  expect(calls[0].sqlText).toContain("GROUP BY 1");
  expect(calls[0].sqlText).toContain("ORDER BY N DESC, V");
  expect(calls[0].sqlText).toContain("LIMIT 10");
});

test("columnStats: exact mode uses COUNT + COUNT DISTINCT", async () => {
  const { conn, calls } = mockConn(() => [{ ROWS: 4, D: 3 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const s = await a.columnStats({ schema: "RAW", table: "T" }, "REGION");
  expect(s).toEqual({ rows: 4, distinct: 3 });
  expect(calls[0].sqlText).toContain('COUNT("REGION") AS ROWS');
  expect(calls[0].sqlText).toContain('COUNT(DISTINCT "REGION") AS D');
});

test("columnStats: approximate mode uses APPROX_COUNT_DISTINCT (Snowflake-native)", async () => {
  const { conn, calls } = mockConn(() => [{ ROWS: 4, D: 3 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.columnStats({ schema: "RAW", table: "T" }, "REGION", { approximate: true });
  expect(calls[0].sqlText).toContain('APPROX_COUNT_DISTINCT("REGION") AS D');
});

test("nameResolution: returns id→name Map, filters NULL ids", async () => {
  const { conn } = mockConn(() => [
    { ID: "US", NM: "United States" },
    { ID: "EU", NM: "European Union" },
  ]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const m = await a.nameResolution({ schema: "RAW", table: "COUNTRIES" }, "CODE", "LABEL");
  expect(m.size).toBe(2);
  expect(m.get("US")).toBe("United States");
  expect(m.get("EU")).toBe("European Union");
});

test("nameResolution: query includes WHERE idCol IS NOT NULL", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.nameResolution({ schema: "RAW", table: "COUNTRIES" }, "CODE", "LABEL");
  expect(calls[0].sqlText).toContain('"CODE" IS NOT NULL');
});
```

### Step 2 — Run, verify failure

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 7 new tests FAIL.

### Step 3 — Implement the four methods

In `server/src/warehouse/snowflake/index.ts`, replace the four stubs (`distinctValues`, `topValuesByFrequency`, `columnStats`, `nameResolution`) with:

```ts
async distinctValues(table: Ref, column: string, limit: number): Promise<string[]> {
  const col = this.quoteIdentifier(column);
  const n = Math.max(1, Math.min(100000, Math.round(limit)));
  // LIVE-VALIDATION: confirm Snowflake LENGTH(TRIM(CAST(...AS VARCHAR))) > 0 works.
  // Snowflake's LENGTH on a NULL returns NULL, so the IS NOT NULL guard is essential.
  const rows = await this.getConnection().execute({
    sqlText: `SELECT DISTINCT ${this.castToString(col)} AS V
              FROM ${this.qualifyRef(table)}
              WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0
              ORDER BY 1
              LIMIT ${n}`,
  });
  return (rows as Array<{ V: string }>).map((r) => r.V);
}

async topValuesByFrequency(table: Ref, column: string, limit: number): Promise<ValueCount[]> {
  const col = this.quoteIdentifier(column);
  const n = Math.max(1, Math.min(10000, Math.round(limit)));
  const rows = await this.getConnection().execute({
    sqlText: `SELECT ${this.castToString(col)} AS V, COUNT(*) AS N
              FROM ${this.qualifyRef(table)}
              WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0
              GROUP BY 1
              ORDER BY N DESC, V
              LIMIT ${n}`,
  });
  return (rows as Array<{ V: string; N: number }>).map((r) => ({
    value: r.V,
    count: Number(r.N),
  }));
}

async columnStats(
  table: Ref,
  column: string,
  opts: { approximate?: boolean } = {},
): Promise<{ rows: number; distinct: number }> {
  const col = this.quoteIdentifier(column);
  const distinctExpr = opts.approximate
    ? `APPROX_COUNT_DISTINCT(${col})`
    : `COUNT(DISTINCT ${col})`;
  const row = await this.getConnection().execute({
    sqlText: `SELECT COUNT(${col}) AS ROWS, ${distinctExpr} AS D
              FROM ${this.qualifyRef(table)}
              WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0`,
  });
  const first = (row as Array<{ ROWS: number; D: number }>)[0];
  return { rows: Number(first?.ROWS ?? 0), distinct: Number(first?.D ?? 0) };
}

async nameResolution(
  table: Ref,
  idCol: string,
  nameCol: string,
): Promise<Map<string, string>> {
  const id = this.quoteIdentifier(idCol);
  const nm = this.quoteIdentifier(nameCol);
  // Last-write-wins on duplicate ids (denormalized name tables are common — caller must accept any matching row).
  const rows = await this.getConnection().execute({
    sqlText: `SELECT ${this.castToString(id)} AS ID, ${this.castToString(nm)} AS NM
              FROM ${this.qualifyRef(table)}
              WHERE ${id} IS NOT NULL`,
  });
  const out = new Map<string, string>();
  for (const r of rows as Array<{ ID: string; NM: string }>) out.set(r.ID, r.NM);
  return out;
}
```

### Step 4 — Run tests, verify they pass

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 20 tests pass (13 + 7).

### Step 5 — Commit

```bash
git add server/src/warehouse/snowflake/index.ts server/test/warehouse-snowflake.test.ts
git commit -m "feat(snowflake): value-scan methods (distinct, top-by-freq, stats, name-resolution)"
```

---

## Task 7: Implement `distinctValuesWithProvenance`

**Files:**
- Modify: `server/src/warehouse/snowflake/index.ts`
- Modify: `server/test/warehouse-snowflake.test.ts`

### Step 1 — Add failing tests

Append to `server/test/warehouse-snowflake.test.ts`:

```ts
test("distinctValuesWithProvenance: empty sources returns []", async () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.distinctValuesWithProvenance([])).resolves.toEqual([]);
});

test("distinctValuesWithProvenance: UNION ALL across sources, tags sourceIndex literal", async () => {
  const { conn, calls } = mockConn(() => [
    { V: "EU", SRC_IDX: 0, N: 2 },
    { V: "US", SRC_IDX: 0, N: 1 },
    { V: "us", SRC_IDX: 0, N: 1 },
    { V: "US", SRC_IDX: 1, N: 1 },
    { V: "EU", SRC_IDX: 1, N: 1 },
  ]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const rows = await a.distinctValuesWithProvenance([
    { table: { schema: "RAW", table: "PARTNERS" }, column: "REGION" },
    { table: { schema: "RAW", table: "COUNTRIES" }, column: "CODE" },
  ]);
  expect(rows).toHaveLength(5);
  expect(rows.filter((r) => r.sourceIndex === 0)).toHaveLength(3);
  expect(rows.filter((r) => r.sourceIndex === 1)).toHaveLength(2);
  expect(rows.find((r) => r.value === "EU" && r.sourceIndex === 0)?.count).toBe(2);

  // SQL should have UNION ALL between the two source branches with the literal
  // src_idx values 0 and 1 (no parameter binding for the index).
  const sql = calls[0].sqlText;
  expect(sql).toContain("UNION ALL");
  expect(sql).toContain("0 AS SRC_IDX");
  expect(sql).toContain("1 AS SRC_IDX");
  expect(sql).toContain('"REGION"');
  expect(sql).toContain('"CODE"');
});
```

### Step 2 — Run, verify failure

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 2 new tests FAIL.

### Step 3 — Implement the method

In `server/src/warehouse/snowflake/index.ts`, replace the `distinctValuesWithProvenance` stub with:

```ts
async distinctValuesWithProvenance(
  sources: ReadonlyArray<{ table: Ref; column: string }>,
): Promise<ValueProvenance[]> {
  if (sources.length === 0) return [];
  // LIVE-VALIDATION: confirm Snowflake supports UNION ALL across as many
  // branches as the typical workspace has sources (~5-20). Snowflake handles
  // hundreds of branches fine in practice; document if it ever becomes a perf concern.
  const branches = sources.map((s, i) => {
    const col = this.quoteIdentifier(s.column);
    return `SELECT ${this.castToString(col)} AS V, ${i} AS SRC_IDX, COUNT(*) AS N
            FROM ${this.qualifyRef(s.table)}
            WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0
            GROUP BY 1`;
  });
  const rows = await this.getConnection().execute({
    sqlText: branches.join("\nUNION ALL\n"),
  });
  return (rows as Array<{ V: string; SRC_IDX: number; N: number }>).map((r) => ({
    value: r.V,
    sourceIndex: Number(r.SRC_IDX),
    count: Number(r.N),
  }));
}
```

### Step 4 — Run tests, verify they pass

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 22 tests pass (20 + 2).

### Step 5 — Commit

```bash
git add server/src/warehouse/snowflake/index.ts server/test/warehouse-snowflake.test.ts
git commit -m "feat(snowflake): distinctValuesWithProvenance (multi-source UNION ALL)"
```

---

## Task 8: Implement `ensureCanonicalTables`

**Files:**
- Modify: `server/src/warehouse/snowflake/index.ts`
- Modify: `server/test/warehouse-snowflake.test.ts`

The `DimensionSpec` has `dimTable` and `mapTable` as fully-qualified strings (e.g. `ZUGZUG.DIM_COUNTRY`). The adapter needs to parse these into 2-part references (the database is implicit — same as creds.database). For Phase 2, assume the format is `schema.table` and the database is the creds default.

### Step 1 — Add failing tests

Append to `server/test/warehouse-snowflake.test.ts`:

```ts
test("ensureCanonicalTables: issues CREATE TABLE IF NOT EXISTS for dim_ and map_", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.ensureCanonicalTables({
    dimId: "country",
    dimTable: "ZUGZUG.DIM_COUNTRY",
    mapTable: "ZUGZUG.MAP_COUNTRY",
    keyCol: "COUNTRY_CODE",
  });
  expect(calls).toHaveLength(2);
  const sqls = calls.map((c) => c.sqlText).join("\n---\n");
  expect(sqls).toContain('CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."DIM_COUNTRY"');
  expect(sqls).toContain('"COUNTRY_CODE" VARCHAR PRIMARY KEY');
  expect(sqls).toContain('LABEL VARCHAR');
  expect(sqls).toContain('CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."MAP_COUNTRY"');
  expect(sqls).toContain('"RAW" VARCHAR PRIMARY KEY');
  expect(sqls).toContain('"COUNTRY_CODE" VARCHAR NOT NULL');
});
```

### Step 2 — Run, verify failure

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 1 new test FAILS.

### Step 3 — Implement the method

In `server/src/warehouse/snowflake/index.ts`, replace the `ensureCanonicalTables` stub with:

```ts
async ensureCanonicalTables(dim: DimensionSpec): Promise<void> {
  // dim.dimTable / dim.mapTable are stored as "SCHEMA.TABLE" (2-part). The database
  // is the adapter's configured default. LIVE-VALIDATION: confirm Snowflake's
  // CREATE TABLE IF NOT EXISTS is idempotent and doesn't error if the table
  // already has a different shape (it silently no-ops; that's the Snowflake contract).
  const dimRef = this.parseTwoPartRef(dim.dimTable);
  const mapRef = this.parseTwoPartRef(dim.mapTable);
  const key = this.quoteIdentifier(dim.keyCol);

  await this.getConnection().execute({
    sqlText: `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(dimRef)} (
                ${key} VARCHAR PRIMARY KEY,
                LABEL VARCHAR
              )`,
  });

  await this.getConnection().execute({
    sqlText: `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(mapRef)} (
                "RAW" VARCHAR PRIMARY KEY,
                ${key} VARCHAR NOT NULL
              )`,
  });
}

/** Parse a stored "SCHEMA.TABLE" string into a Ref. Single-token strings get
 *  the creds default schema. */
private parseTwoPartRef(stored: string): Ref {
  const parts = stored.split(".");
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] };
  return { schema: this.creds.schema, table: stored };
}
```

### Step 4 — Run tests, verify they pass

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 23 tests pass (22 + 1).

### Step 5 — Commit

```bash
git add server/src/warehouse/snowflake/index.ts server/test/warehouse-snowflake.test.ts
git commit -m "feat(snowflake): ensureCanonicalTables via CREATE TABLE IF NOT EXISTS"
```

---

## Task 9: Implement `commitCanonical` (the writable MERGE path)

**Files:**
- Modify: `server/src/warehouse/snowflake/index.ts`
- Modify: `server/test/warehouse-snowflake.test.ts`

This is the gnarliest piece. The approach:

1. Compute the unique (key, label) pairs from drafts (one canonical row per key).
2. Compute the (raw, key) pairs from drafts (one map row per draft).
3. Issue two `MERGE INTO ... USING (VALUES ...)` statements, one per table.
4. Chunk to 1000 rows per MERGE to bound SQL string size.
5. Return total `rowsWritten` as the sum of `executeAffected` results.

### Step 1 — Add failing tests

Append to `server/test/warehouse-snowflake.test.ts`:

```ts
test("commitCanonical: empty drafts returns {rowsWritten: 0} without any SQL", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const result = await a.commitCanonical(
    { dimId: "country", dimTable: "ZUGZUG.DIM_COUNTRY", mapTable: "ZUGZUG.MAP_COUNTRY", keyCol: "COUNTRY_CODE" },
    [],
  );
  expect(result.rowsWritten).toBe(0);
  expect(calls).toHaveLength(0);
});

test("commitCanonical: issues two MERGE statements (dim + map)", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 3 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const result = await a.commitCanonical(
    { dimId: "country", dimTable: "ZUGZUG.DIM_COUNTRY", mapTable: "ZUGZUG.MAP_COUNTRY", keyCol: "COUNTRY_CODE" },
    [
      { raw: "USA", key: "US", label: "United States" },
      { raw: "U.S.", key: "US", label: "United States" },
      { raw: "United Kingdom", key: "GB", label: "United Kingdom" },
    ],
  );
  expect(calls).toHaveLength(2);
  const mergeSqls = calls.map((c) => c.sqlText);

  // First MERGE: dim_country (unique by key)
  expect(mergeSqls[0]).toContain('MERGE INTO "ANALYTICS"."ZUGZUG"."DIM_COUNTRY"');
  expect(mergeSqls[0]).toContain('"COUNTRY_CODE"');
  expect(mergeSqls[0]).toContain("USING (VALUES");
  expect(mergeSqls[0]).toContain("WHEN NOT MATCHED");

  // Second MERGE: map_country (one row per draft)
  expect(mergeSqls[1]).toContain('MERGE INTO "ANALYTICS"."ZUGZUG"."MAP_COUNTRY"');
  expect(mergeSqls[1]).toContain('"RAW"');

  // Binds carry the actual values (Snowflake VALUES with placeholders)
  const allBinds = calls.flatMap((c) => c.binds ?? []);
  expect(allBinds).toContain("US");
  expect(allBinds).toContain("United States");
  expect(allBinds).toContain("USA");
  expect(allBinds).toContain("U.S.");
  expect(allBinds).toContain("GB");

  // rowsWritten sums both MERGEs' affected counts (mock returns 3 per call)
  expect(result.rowsWritten).toBe(6);
});

test("commitCanonical: dim MERGE deduplicates by key (one row per unique key, last label wins)", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 1 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.commitCanonical(
    { dimId: "country", dimTable: "ZUGZUG.DIM_COUNTRY", mapTable: "ZUGZUG.MAP_COUNTRY", keyCol: "COUNTRY_CODE" },
    [
      { raw: "USA", key: "US", label: "United States" },
      { raw: "U.S.", key: "US", label: "United States of America" }, // same key, different label
    ],
  );
  // The dim MERGE should have ONE pair of placeholders, not two
  const dimBinds = calls[0].binds ?? [];
  expect(dimBinds).toHaveLength(2); // [key, label]
  expect(dimBinds[0]).toBe("US");
  // Last-write-wins on label (deterministic by input order)
  expect(dimBinds[1]).toBe("United States of America");
});

test("commitCanonical: chunks at 1000 rows", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 1 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  // 1500 unique drafts → dim has 1500 unique keys, map has 1500 rows
  const drafts = Array.from({ length: 1500 }, (_, i) => ({
    raw: `raw-${i}`,
    key: `key-${i}`,
    label: `Label ${i}`,
  }));
  await a.commitCanonical(
    { dimId: "x", dimTable: "S.D", mapTable: "S.M", keyCol: "K" },
    drafts,
  );
  // 2 MERGEs per chunk × 2 chunks (1000 + 500) = 4 statements
  expect(calls).toHaveLength(4);
});

test("commitCanonical: handles drafts with null label (uses NULL bind)", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 1 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.commitCanonical(
    { dimId: "x", dimTable: "S.D", mapTable: "S.M", keyCol: "K" },
    [{ raw: "raw1", key: "k1", label: null }],
  );
  const dimBinds = calls[0].binds ?? [];
  expect(dimBinds[0]).toBe("k1");
  expect(dimBinds[1]).toBeNull();
});
```

### Step 2 — Run, verify failure

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 5 new tests FAIL.

### Step 3 — Implement `commitCanonical`

In `server/src/warehouse/snowflake/index.ts`, replace the `commitCanonical` stub with:

```ts
async commitCanonical(dim: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult> {
  if (drafts.length === 0) return { rowsWritten: 0 };
  const dimRef = this.parseTwoPartRef(dim.dimTable);
  const mapRef = this.parseTwoPartRef(dim.mapTable);
  const key = this.quoteIdentifier(dim.keyCol);

  // Deduplicate canonical rows by key (last write wins on label).
  const canonByKey = new Map<string, string | null>();
  for (const d of drafts) canonByKey.set(d.key, d.label);
  const canonRows = [...canonByKey.entries()].map(([k, l]) => ({ key: k, label: l }));

  // Map rows: one per draft (one (raw, key) pair).
  const mapRows = drafts.map((d) => ({ raw: d.raw, key: d.key }));

  let rowsWritten = 0;
  rowsWritten += await this.mergeChunked({
    targetRef: dimRef,
    chunks: chunk(canonRows, 1000),
    sourceCols: [key, "LABEL"],
    onCol: key,
    pickBinds: (row) => [row.key, row.label],
  });
  rowsWritten += await this.mergeChunked({
    targetRef: mapRef,
    chunks: chunk(mapRows, 1000),
    sourceCols: [`"RAW"`, key],
    onCol: `"RAW"`,
    pickBinds: (row) => [row.raw, row.key],
  });
  return { rowsWritten };
}

/** Issue chunked MERGE INTO ... USING (VALUES (?, ?), ...) statements.
 *  Each chunk becomes one MERGE; returns sum of rowsAffected. */
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
    // LIVE-VALIDATION: confirm Snowflake's MERGE INTO + USING (VALUES ...) AS S(a, b)
    // syntax accepts positional placeholders this way. Snowflake docs example:
    // MERGE INTO t USING (SELECT 1 AS a UNION ALL SELECT 2) s ON t.a = s.a ...
    // The VALUES form is supported but the column aliasing on source needs verification.
    const sqlText = `MERGE INTO ${this.qualifyRef(opts.targetRef)} T
                     USING (
                       SELECT $1 AS ${colA}, $2 AS ${colB} FROM (VALUES ${placeholders}) AS V($1, $2)
                     ) S
                     ON T.${opts.onCol} = S.${colA}
                     WHEN NOT MATCHED THEN INSERT (${colA}, ${colB}) VALUES (S.${colA}, S.${colB})`;
    // ^^ LIVE-VALIDATION: the SELECT-from-VALUES with alias is one possible shape; the
    // alternative is `USING (VALUES (?,?), ...) S(a, b)` directly. Confirm which one
    // Snowflake actually accepts. If neither works, fall back to a temp-table approach:
    // CREATE TEMPORARY TABLE + INSERT batch + MERGE FROM temp + DROP temp.
    const binds = c.flatMap((row) => opts.pickBinds(row));
    total += await this.getConnection().executeAffected({ sqlText, binds });
  }
  return total;
}
```

Add a helper function at the top of the file (above the class), or inline if you prefer:

```ts
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
```

### Step 4 — Run tests, verify they pass

```bash
cd server && bun test test/warehouse-snowflake.test.ts
```
Expected: 28 tests pass (23 + 5).

### Step 5 — Commit

```bash
git add server/src/warehouse/snowflake/index.ts server/test/warehouse-snowflake.test.ts
git commit -m "feat(snowflake): commitCanonical via chunked MERGE INTO"
```

---

## Task 10: Wire factory in `server.ts` + `bootstrap.ts` (verify, no change needed)

**Files:**
- Verify: `server/src/server.ts`
- Verify: `server/src/bootstrap.ts`

The factory was already updated in Phase 1's Task 13 to call `new SnowflakeAdapter(creds)` — but the SnowflakeAdapter was a throwing stub at that point. Now that it's real, no code change is needed; just verify.

- [ ] **Step 1: Confirm `server.ts` is still wired**

```bash
grep -n "SnowflakeAdapter" /Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts
```
Expected: a line `snowflake: async (creds) => new SnowflakeAdapter(creds),` exists.

- [ ] **Step 2: Confirm `bootstrap.ts` is still wired**

```bash
grep -n "SnowflakeAdapter" /Users/fhagelund/Documents/GitHub/zugzug/server/src/bootstrap.ts
```
Expected: same.

- [ ] **Step 3: Server boot smoke**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && timeout 5 bun run start 2>&1 | head -10 || true
```
Expected output: `· connected (duckdb, read-only)` (or whatever the configured default is). The Snowflake factory is registered but not invoked, since the env-driven `getAdapter()` only returns DuckDB for now. No errors about Snowflake.

- [ ] **Step 4: No commit needed** unless `grep` exposed missing wiring.

If wiring is missing, add it (mirror Phase 1 pattern):
```ts
snowflake: async (creds) => new SnowflakeAdapter(creds),
```
and commit:
```bash
git add server/src/server.ts server/src/bootstrap.ts
git commit -m "fix(snowflake): wire factory to new SnowflakeAdapter (no longer stub)"
```

---

## Task 11: Write live-validation SQL fixture doc

**Files:**
- Create: `server/test/warehouse-snowflake-sql.fixture.md`

A reference document listing the exact SQL strings each SnowflakeAdapter method produces. When live credentials become available, an engineer can paste each block into the Snowflake Worksheet and confirm the SQL executes against a real account. This bridges the gap between unit-test confidence and live-validation confidence.

- [ ] **Step 1: Write the fixture file**

Create `server/test/warehouse-snowflake-sql.fixture.md` with the following content (this is reference documentation, not executable):

```markdown
# SnowflakeAdapter — expected SQL strings (live-validation reference)

This file documents the SQL each SnowflakeAdapter method produces. Use it to
hand-validate against a real Snowflake account before declaring Phase 2
production-ready. Each block can be pasted into a Snowflake Worksheet.

**Test fixture creds used below:**
- account: abc123.eu-west-1
- database: ANALYTICS
- schema: PUBLIC
- warehouse: WH

**Test fixture data:** create these once before live-validating:

\`\`\`sql
CREATE OR REPLACE SCHEMA ANALYTICS.RAW;

CREATE OR REPLACE TABLE ANALYTICS.RAW.PARTNERS (
  ID NUMBER,
  NAME VARCHAR,
  REGION VARCHAR
);
INSERT INTO ANALYTICS.RAW.PARTNERS VALUES
  (1, 'Acme', 'US'),
  (2, 'Acme Inc', 'us'),
  (3, 'Foo', 'EU'),
  (4, '', NULL),
  (5, 'Bar', 'EU');

CREATE OR REPLACE TABLE ANALYTICS.RAW.COUNTRIES (
  CODE VARCHAR,
  LABEL VARCHAR
);
INSERT INTO ANALYTICS.RAW.COUNTRIES VALUES
  ('US', 'United States'),
  ('EU', 'European Union');
\`\`\`

---

## ping()

\`\`\`sql
SELECT 1 AS OK
\`\`\`

Expected: 1 row, column `OK` = 1.

---

## tableExists({schema: 'RAW', table: 'PARTNERS'})

\`\`\`sql
SELECT 1 FROM "ANALYTICS"."RAW"."PARTNERS" LIMIT 0
\`\`\`

Expected: 0 rows, no error. Returns true.

---

## listTables({})

Two queries, joined in JS:

\`\`\`sql
-- Query 1: TABLES
SELECT TABLE_SCHEMA, TABLE_NAME
FROM "ANALYTICS".INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA') AND TABLE_TYPE IN ('BASE TABLE','VIEW')
ORDER BY TABLE_SCHEMA, TABLE_NAME
LIMIT 5000;

-- Query 2: COLUMNS
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA')
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
LIMIT 100000;
\`\`\`

Expected: PARTNERS and COUNTRIES in TABLES; their 5 columns in COLUMNS.

---

## listColumns({schema: 'RAW', table: 'PARTNERS'})

\`\`\`sql
SELECT COLUMN_NAME, DATA_TYPE
FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'RAW' AND TABLE_NAME = 'PARTNERS'
ORDER BY ORDINAL_POSITION
\`\`\`

Expected: 3 rows — (ID, NUMBER), (NAME, VARCHAR), (REGION, VARCHAR).

---

## distinctValues({schema: 'RAW', table: 'PARTNERS'}, 'REGION', 100)

\`\`\`sql
SELECT DISTINCT CAST("REGION" AS VARCHAR) AS V
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
ORDER BY 1
LIMIT 100
\`\`\`

Expected: 3 rows — EU, US, us.

---

## topValuesByFrequency({schema: 'RAW', table: 'PARTNERS'}, 'REGION', 10)

\`\`\`sql
SELECT CAST("REGION" AS VARCHAR) AS V, COUNT(*) AS N
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
GROUP BY 1
ORDER BY N DESC, V
LIMIT 10
\`\`\`

Expected: EU=2, US=1, us=1.

---

## columnStats({schema: 'RAW', table: 'PARTNERS'}, 'REGION', {approximate: false})

\`\`\`sql
SELECT COUNT("REGION") AS ROWS, COUNT(DISTINCT "REGION") AS D
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
\`\`\`

Expected: ROWS=4, D=3.

---

## columnStats({schema: 'RAW', table: 'PARTNERS'}, 'REGION', {approximate: true})

\`\`\`sql
SELECT COUNT("REGION") AS ROWS, APPROX_COUNT_DISTINCT("REGION") AS D
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
\`\`\`

Expected: ROWS=4, D≈3 (small dataset → exact match).

---

## nameResolution({schema: 'RAW', table: 'COUNTRIES'}, 'CODE', 'LABEL')

\`\`\`sql
SELECT CAST("CODE" AS VARCHAR) AS ID, CAST("LABEL" AS VARCHAR) AS NM
FROM "ANALYTICS"."RAW"."COUNTRIES"
WHERE "CODE" IS NOT NULL
\`\`\`

Expected: 2 rows — (US, United States), (EU, European Union).

---

## distinctValuesWithProvenance — 2 sources

\`\`\`sql
SELECT CAST("REGION" AS VARCHAR) AS V, 0 AS SRC_IDX, COUNT(*) AS N
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
GROUP BY 1
UNION ALL
SELECT CAST("CODE" AS VARCHAR) AS V, 1 AS SRC_IDX, COUNT(*) AS N
FROM "ANALYTICS"."RAW"."COUNTRIES"
WHERE "CODE" IS NOT NULL AND LENGTH(TRIM(CAST("CODE" AS VARCHAR))) > 0
GROUP BY 1
\`\`\`

Expected: 5 rows — 3 from PARTNERS (EU=2, US=1, us=1), 2 from COUNTRIES (US=1, EU=1).

---

## ensureCanonicalTables

\`\`\`sql
CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."DIM_COUNTRY" (
  "COUNTRY_CODE" VARCHAR PRIMARY KEY,
  LABEL VARCHAR
);

CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."MAP_COUNTRY" (
  "RAW" VARCHAR PRIMARY KEY,
  "COUNTRY_CODE" VARCHAR NOT NULL
);
\`\`\`

(Pre-req: \`CREATE SCHEMA IF NOT EXISTS ANALYTICS.ZUGZUG;\`)

Expected: both tables exist after running.

---

## commitCanonical — small batch (3 drafts)

dim_country MERGE:

\`\`\`sql
MERGE INTO "ANALYTICS"."ZUGZUG"."DIM_COUNTRY" T
USING (
  SELECT $1 AS "COUNTRY_CODE", $2 AS LABEL FROM (VALUES (?, ?), (?, ?)) AS V($1, $2)
) S
ON T."COUNTRY_CODE" = S."COUNTRY_CODE"
WHEN NOT MATCHED THEN INSERT ("COUNTRY_CODE", LABEL) VALUES (S."COUNTRY_CODE", S.LABEL);
\`\`\`
Binds: \`['US', 'United States', 'GB', 'United Kingdom']\`

map_country MERGE:

\`\`\`sql
MERGE INTO "ANALYTICS"."ZUGZUG"."MAP_COUNTRY" T
USING (
  SELECT $1 AS "RAW", $2 AS "COUNTRY_CODE" FROM (VALUES (?, ?), (?, ?), (?, ?)) AS V($1, $2)
) S
ON T."RAW" = S."RAW"
WHEN NOT MATCHED THEN INSERT ("RAW", "COUNTRY_CODE") VALUES (S."RAW", S."COUNTRY_CODE");
\`\`\`
Binds: \`['USA', 'US', 'U.S.', 'US', 'United Kingdom', 'GB']\`

Expected: dim_country gets 2 rows (US, GB); map_country gets 3 rows.

---

## Live-validation checklist

When credentials become available, run each block above in a Snowflake Worksheet
against the fixture dataset. Confirm:

- [ ] All `LIVE-VALIDATION:` comments in `index.ts` and `sdk-wrapper.ts` are resolved.
- [ ] Column case in returned rows matches expectations (UPPERCASE by default).
- [ ] Key-pair auth works end-to-end with a real PEM.
- [ ] `getNumUpdatedRows()` returns the expected count after each MERGE.
- [ ] MERGE INTO + USING (VALUES ...) syntax is accepted as-is, OR the fallback
      (temp-table approach noted in Task 9 Step 3) needs implementation.
- [ ] If anything diverges from this fixture, update both the fixture AND the
      adapter implementation in the same commit so the doc stays the source of
      truth for "what the adapter actually produces."
```

- [ ] **Step 2: Commit**

```bash
git add server/test/warehouse-snowflake-sql.fixture.md
git commit -m "docs(snowflake): live-validation SQL fixture for Phase 2"
```

---

## Task 12: Final verification gates

**Files:** none modified — checks only.

- [ ] **Step 1: No Phase 2 stubs remain**

```bash
grep -n "SnowflakeAdapter — Phase 2" /Users/fhagelund/Documents/GitHub/zugzug/server/src/warehouse/snowflake/index.ts
```
Expected: zero matches.

- [ ] **Step 2: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck
```
Expected: clean.

- [ ] **Step 3: Lint**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run lint
```
Expected: clean.

- [ ] **Step 4: Prettier**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run format:check
```
Expected: clean. If any new files need reformatting, run `bun run format` first then re-check.

- [ ] **Step 5: Full test suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test
```
Expected: previous tests (36+) PLUS new SnowflakeAdapter tests (28) all pass. Total ~64+.

- [ ] **Step 6: Server boot smoke**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && timeout 5 bun run start 2>&1 | head -10 || true
```
Expected: `· connected (duckdb, read-only)` — no errors about Snowflake (the factory is registered but not invoked).

- [ ] **Step 7: LIVE-VALIDATION inventory**

Confirm every method that needs real-account verification has a `// LIVE-VALIDATION:` comment so the live-test step has a checklist:

```bash
grep -n "LIVE-VALIDATION:" /Users/fhagelund/Documents/GitHub/zugzug/server/src/warehouse/snowflake/index.ts /Users/fhagelund/Documents/GitHub/zugzug/server/src/warehouse/snowflake/sdk-wrapper.ts
```
Expected: at least one comment per implementation method that does a Snowflake-specific operation (auth, INFORMATION_SCHEMA shape, MERGE syntax, getNumUpdatedRows return semantics).

- [ ] **Step 8: Commit history sanity**

```bash
git log --oneline main..HEAD
```
Expected commits in order:
- chore(server): add snowflake-sdk + @types/snowflake-sdk for Phase 2
- feat(snowflake): promise wrapper around snowflake-sdk callback API
- feat(snowflake): adapter shell with injected connection + helpers
- feat(snowflake): ping() via SELECT 1
- feat(snowflake): catalog methods (tableExists, listTables, listColumns)
- feat(snowflake): value-scan methods (distinct, top-by-freq, stats, name-resolution)
- feat(snowflake): distinctValuesWithProvenance (multi-source UNION ALL)
- feat(snowflake): ensureCanonicalTables via CREATE TABLE IF NOT EXISTS
- feat(snowflake): commitCanonical via chunked MERGE INTO
- (optional) fix(snowflake): wire factory to new SnowflakeAdapter (no longer stub)
- docs(snowflake): live-validation SQL fixture for Phase 2

- [ ] **Step 9: No commit unless fixes needed.** If any gate failed, address the specific issue. If all pass, this phase is COMPLETE_PENDING_LIVE_VALIDATION.

---

## Self-review summary

**Spec coverage (Phase 2 only, per the deviation):**
- Real `SnowflakeAdapter` implementation replacing stub — Tasks 3–9 ✓
- All 8 read methods + 2 write methods — Tasks 4–9 ✓
- snowflake-sdk integration via promise wrapper — Task 2 ✓
- Identifier case handling (UPPERCASE default, quoting preserves) — Task 3 + per-method comments ✓
- INFORMATION_SCHEMA catalog browsing — Task 5 ✓
- MERGE INTO commit path — Task 9 ✓
- LIVE-VALIDATION comments documenting unverified assumptions — Tasks 2–9 ✓
- Test fixture doc for future live-validation pass — Task 11 ✓
- Factory wiring (already done in Phase 1 Task 13) — Task 10 verification ✓

**Deferred to live-validation pass (once credentials exist):**
- End-to-end run against real Snowflake account.
- Confirmation of `INFORMATION_SCHEMA` column shape, `getNumUpdatedRows()` semantics, key-pair auth wire format, MERGE INTO + VALUES dialect acceptance.
- Performance smoke (LISTING the catalog of a 1000-table warehouse, scanning a 10M-row column).

**Out of scope for Phase 2:**
- Branching `commit()` in `repo-drafts.ts` to call `adapter.commitCanonical` when `isWritable(adapter)` is true — that's Phase 3 (canonical-store modes + the writable/Postgres-export branch).
- Writing a Parquet exporter for the read-only-warehouse fallback — Phase 3.
- Adding workspace-level credentials storage to Postgres — Phase 4 (auth refactor).
