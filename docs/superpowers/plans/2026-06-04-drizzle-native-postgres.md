***REMOVED*** Drizzle + Native Postgres Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DuckDB-as-Postgres-bridge pattern with a native `postgres.js` client for all OLTP queries, use DuckDB exclusively for MotherDuck warehouse access, and adopt Drizzle ORM for schema management with versioned SQL migrations.

**Architecture:** `server/src/pg.ts` exposes `pgAll/pgGet/pgRun/pgTx` helpers backed by a `postgres.js` connection pool. `server/src/db.ts` drops `attachPostgres()` and becomes warehouse-only. `repo.ts`, `auth.ts`, and `team.ts` route pure-Postgres queries through `pg.ts`; three cross-store join functions are decomposed into two fetches + TypeScript set arithmetic. Drizzle manages all 12 static Postgres tables via numbered SQL migration files.

**Tech Stack:** `postgres` (postgres.js v3), `drizzle-orm`, `drizzle-kit`, Bun, TypeScript

---

***REMOVED******REMOVED*** File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `server/src/pg.ts` | postgres.js pool + `pgAll/pgGet/pgRun/pgTx` helpers |
| Create | `server/drizzle/schema.ts` | Drizzle table definitions for 12 static tables |
| Create | `server/drizzle.config.ts` | Drizzle Kit config |
| Create | `server/drizzle/migrate.ts` | Programmatic migration runner |
| Create | `server/drizzle/migrations/0000_baseline.sql` | Baseline DDL with IF NOT EXISTS |
| Create | `server/drizzle/migrations/meta/_journal.json` | Drizzle migration journal |
| Modify | `server/src/bootstrap.ts` | Call `runMigrations()` instead of `ensureSchema()` |
| Modify | `server/src/db.ts` | Remove `attachPostgres()`; DuckDB = warehouse only |
| Modify | `server/src/env.ts` | Update `pg()` helper to return 2-part schema.table names |
| Modify | `server/src/auth.ts` | Use `pgAll/pgGet/pgRun` from `pg.ts` |
| Modify | `server/src/team.ts` | Use `pgAll/pgGet/pgRun` from `pg.ts` |
| Modify | `server/src/repo.ts` | Route OLTP to pg.ts, DuckDB stays for warehouse; decompose 3 cross-store joins |
| Modify | `server/package.json` | Add dependencies + `db:generate`, `db:migrate`, `db:studio` scripts |
| Delete | `server/src/schema.ts` | Replaced by Drizzle schema + baseline migration |

---

***REMOVED******REMOVED*** Task 1: Install Dependencies

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add runtime and dev dependencies**

Run from `server/`:
```bash
bun add postgres drizzle-orm
bun add -d drizzle-kit
```

- [ ] **Step 2: Add npm scripts**

Edit `server/package.json` — add these to the `"scripts"` block:
```json
"db:generate": "drizzle-kit generate",
"db:migrate":  "drizzle-kit migrate",
"db:studio":   "drizzle-kit studio"
```

Full scripts block after edit:
```json
"scripts": {
  "dev":             "bun --watch run src/server.ts",
  "start":           "bun run src/server.ts",
  "spike":           "bun run src/spike.ts",
  "verify-eid":      "bun run src/verify-eid.ts",
  "verify-polish":   "bun run src/verify-polish.ts",
  "verify-datagrid": "bun run src/verify-datagrid.ts",
  "bootstrap":       "bun run src/bootstrap.ts",
  "typecheck":       "tsc --noEmit",
  "db:generate":     "drizzle-kit generate",
  "db:migrate":      "drizzle-kit migrate",
  "db:studio":       "drizzle-kit studio"
}
```

- [ ] **Step 3: Verify install**

```bash
bun run typecheck
```
Expected: no new errors (postgres and drizzle-orm types should resolve).

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/bun.lockb
git commit -m "chore(server): add postgres.js + drizzle-orm + drizzle-kit"
```

---

***REMOVED******REMOVED*** Task 2: Create `server/src/pg.ts`

**Files:**
- Create: `server/src/pg.ts`

This is the native Postgres client. It exposes the same `all/get/run` ergonomics as `db.ts` but uses `postgres.js` directly (no DuckDB bridge). The `pgTx` helper handles transactions safely through the connection pool.

- [ ] **Step 1: Create the file**

`server/src/pg.ts`:
```typescript
import postgres from "postgres";
import { env } from "./env.ts";

const pool = postgres(env.databaseUrl);

export async function pgAll<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await pool.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
  return rows as unknown as T[];
}

export async function pgGet<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await pgAll<T>(query, params);
  return rows[0] ?? null;
}

export async function pgRun(query: string, params: unknown[] = []): Promise<void> {
  await pool.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
}

type TxHelpers = {
  all: <T>(q: string, p?: unknown[]) => Promise<T[]>;
  get: <T>(q: string, p?: unknown[]) => Promise<T | null>;
  run: (q: string, p?: unknown[]) => Promise<void>;
};

export async function pgTx<T>(fn: (tx: TxHelpers) => Promise<T>): Promise<T> {
  return pool.begin(async (txSql) => {
    const all = <T>(q: string, p: unknown[] = []) =>
      txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]) as unknown as Promise<T[]>;
    const get = <T>(q: string, p: unknown[] = []) =>
      all<T>(q, p).then((rows) => rows[0] ?? null);
    const run = (q: string, p: unknown[] = []) =>
      txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]).then(() => {});
    return fn({ all, get, run });
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```
Expected: passes (or only pre-existing errors).

- [ ] **Step 3: Commit**

```bash
git add server/src/pg.ts
git commit -m "feat(server): native postgres.js client (pgAll/pgGet/pgRun/pgTx)"
```

---

***REMOVED******REMOVED*** Task 3: Create `server/drizzle/schema.ts`

**Files:**
- Create: `server/drizzle/schema.ts`

Drizzle TypeScript schema for all 12 static `zugzug_app` tables. This is the source of truth for future `bun run db:generate` calls — every schema change starts here.

- [ ] **Step 1: Create the file**

`server/drizzle/schema.ts`:
```typescript
import {
  pgSchema,
  varchar,
  boolean,
  bigint,
  integer,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const app = pgSchema("zugzug_app");

export const dimension = app.table("dimension", {
  id:          varchar("id").primaryKey(),
  label:       varchar("label").notNull(),
  dim_table:   varchar("dim_table").notNull(),
  map_table:   varchar("map_table").notNull(),
  key_col:     varchar("key_col").notNull(),
  created_at:  timestamp("created_at").notNull(),
  key_kind:    varchar("key_kind"),
  name_table:  varchar("name_table"),
  name_id_col: varchar("name_id_col"),
  name_col:    varchar("name_col"),
});

export const dimensionSource = app.table(
  "dimension_source",
  {
    dim_id:        varchar("dim_id").notNull(),
    source_table:  varchar("source_table").notNull(),
    source_column: varchar("source_column").notNull(),
    schedule:      varchar("schedule"),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.source_table, t.source_column] })],
);

export const dimensionField = app.table(
  "dimension_field",
  {
    dim_id:     varchar("dim_id").notNull(),
    field:      varchar("field").notNull(),
    label:      varchar("label").notNull(),
    type:       varchar("type").notNull(),
    created_at: timestamp("created_at").notNull(),
    options:    varchar("options"),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.field] })],
);

export const sourceStat = app.table(
  "source_stat",
  {
    dim_id:          varchar("dim_id").notNull(),
    source_table:    varchar("source_table").notNull(),
    source_column:   varchar("source_column").notNull(),
    present:         boolean("present").notNull(),
    rows:            bigint("rows", { mode: "number" }).notNull(),
    distinct_values: bigint("distinct_values", { mode: "number" }).notNull(),
    unmapped:        bigint("unmapped", { mode: "number" }).notNull(),
    scanned_at:      timestamp("scanned_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.source_table, t.source_column] })],
);

export const draft = app.table(
  "draft",
  {
    dim_id:       varchar("dim_id").notNull(),
    raw:          varchar("raw").notNull(),
    status:       varchar("status").notNull(),
    target_label: varchar("target_label"),
    target_key:   varchar("target_key"),
    user_id:      varchar("user_id").notNull(),
    created_at:   timestamp("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.raw, t.user_id] })],
);

export const auditLog = app.table("audit_log", {
  id:         varchar("id").primaryKey(),
  created_at: timestamp("created_at").notNull(),
  user_id:    varchar("user_id").notNull(),
  action:     varchar("action").notNull(),
  detail:     varchar("detail").notNull(),
});

export const users = app.table(
  "users",
  {
    id:         varchar("id").primaryKey(),
    name:       varchar("name").notNull(),
    initials:   varchar("initials").notNull(),
    email:      varchar("email"),
    google_sub: varchar("google_sub"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email).where(`email IS NOT NULL`),
    uniqueIndex("users_google_sub_unique").on(t.google_sub).where(`google_sub IS NOT NULL`),
  ],
);

export const activeSessions = app.table("active_sessions", {
  user_id:   varchar("user_id").primaryKey(),
  last_seen: timestamp("last_seen").notNull(),
});

export const allowedEmails = app.table("allowed_emails", {
  email:    varchar("email").primaryKey(),
  added_by: varchar("added_by").notNull(),
  added_at: timestamp("added_at").notNull(),
});

export const sessions = app.table(
  "sessions",
  {
    id:         varchar("id").primaryKey(),
    user_id:    varchar("user_id").notNull(),
    expires_at: timestamp("expires_at").notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.user_id)],
);

export const preferences = app.table("preferences", {
  id:                integer("id").primaryKey(),
  publish_threshold: integer("publish_threshold").notNull(),
  suggest_threshold: integer("suggest_threshold").notNull(),
  updated_at:        timestamp("updated_at").notNull(),
});

export const userGridLayout = app.table(
  "user_grid_layout",
  {
    user_id:    varchar("user_id").notNull(),
    dim_id:     varchar("dim_id").notNull(),
    config:     varchar("config").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.dim_id] })],
);
```

- [ ] **Step 2: Commit**

```bash
git add server/drizzle/schema.ts
git commit -m "feat(server): Drizzle schema for 12 static Postgres tables"
```

---

***REMOVED******REMOVED*** Task 4: Create `server/drizzle.config.ts` and `server/drizzle/migrate.ts`

**Files:**
- Create: `server/drizzle.config.ts`
- Create: `server/drizzle/migrate.ts`

- [ ] **Step 1: Create `server/drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect:  "postgresql",
  schema:   "./drizzle/schema.ts",
  out:      "./drizzle/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 2: Create `server/drizzle/migrate.ts`**

`import.meta.dir` is Bun's way to get the directory of the current file — this makes the migrations path absolute regardless of the working directory when bootstrap is called.

```typescript
import { drizzle }  from "drizzle-orm/postgres-js";
import { migrate }  from "drizzle-orm/postgres-js/migrator";
import postgres      from "postgres";
import { resolve }   from "node:path";
import { env }       from "../src/env.ts";

export async function runMigrations(): Promise<void> {
  const client = postgres(env.databaseUrl, { max: 1 });
  const db     = drizzle(client);
  await migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "migrations"),
  });
  await client.end();
  console.log("· Postgres migrations applied");
}
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add server/drizzle.config.ts server/drizzle/migrate.ts
git commit -m "feat(server): Drizzle Kit config + programmatic migration runner"
```

---

***REMOVED******REMOVED*** Task 5: Generate and Edit the Baseline Migration

**Files:**
- Create: `server/drizzle/migrations/` (Drizzle-kit generates the files)

The baseline migration must be safe to run against an existing database (tables already created by the old `ensureSchema()`). After generating, every `CREATE TABLE` and `CREATE INDEX` line gets `IF NOT EXISTS`.

- [ ] **Step 1: Generate the migration**

From `server/`:
```bash
bun run db:generate --name baseline
```

This creates two files:
- `server/drizzle/migrations/0000_baseline.sql` (DDL)
- `server/drizzle/migrations/meta/_journal.json` (migration index)

- [ ] **Step 2: Add IF NOT EXISTS to every CREATE TABLE and CREATE INDEX**

Open the generated `0000_baseline.sql`. Edit every line:

```sql
-- Before:
CREATE TABLE "zugzug_app"."dimension" (...)

-- After:
CREATE TABLE IF NOT EXISTS "zugzug_app"."dimension" (...)
```

Do the same for every `CREATE INDEX` and `CREATE UNIQUE INDEX` line. Also prepend:

```sql
CREATE SCHEMA IF NOT EXISTS "zugzug_app";
CREATE SCHEMA IF NOT EXISTS "zugzug";
```

at the very top of the file (before any table DDL).

- [ ] **Step 3: Verify the migration file**

Check that:
- Every `CREATE TABLE` has `IF NOT EXISTS`
- Every `CREATE INDEX` / `CREATE UNIQUE INDEX` has `IF NOT EXISTS`
- Both schema creation lines are at the top
- The `_journal.json` references the correct filename

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/migrations/
git commit -m "feat(server): baseline Drizzle migration (IF NOT EXISTS, safe for existing DBs)"
```

---

***REMOVED******REMOVED*** Task 6: Update `server/src/bootstrap.ts`

**Files:**
- Modify: `server/src/bootstrap.ts`

Replace `ensureSchema()` with `runMigrations()`. Move the two data-seeding steps (default preferences row + `u_system` user) here — they were previously inside `ensureSchema()`. Keep the demo-team seed only when `--seed` is passed.

- [ ] **Step 1: Replace bootstrap.ts entirely**

```typescript
import { connect }        from "./db.ts";
import { runMigrations }  from "../drizzle/migrate.ts";
import { seedDemo }       from "./seed.ts";
import { pgRun, pgGet }   from "./pg.ts";

const seed = process.argv.includes("--seed");

console.log("\nZug Zug — bootstrap\n");

await runMigrations();

// Seed system data (idempotent — safe to re-run)
await pgRun(
  `INSERT INTO "zugzug_app"."preferences" (id, publish_threshold, suggest_threshold, updated_at)
   VALUES (1, 95, 80, current_timestamp)
   ON CONFLICT (id) DO NOTHING`,
);
await pgRun(
  `INSERT INTO "zugzug_app"."users" (id, name, initials)
   VALUES ('u_system', 'Auto-match', 'AM')
   ON CONFLICT (id) DO NOTHING`,
);

// Seed demo team if users table is empty (first bootstrap only)
const { n } = (await pgGet<{ n: number }>(
  `SELECT count(*)::int AS n FROM "zugzug_app"."users"`,
)) ?? { n: 0 };
if (n <= 1) {
  const DEFAULT_USERS = [
    { id: "u_ada",  name: "Ada Berg",   initials: "AB" },
    { id: "u_li",   name: "Li Bauer",   initials: "LB" },
    { id: "u_cory", name: "Cory Mills", initials: "CM" },
  ];
  for (const u of DEFAULT_USERS) {
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.initials],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."active_sessions" (user_id, last_seen) VALUES ($1, current_timestamp) ON CONFLICT (user_id) DO NOTHING`,
      [u.id],
    );
  }
  console.log("· demo team seeded (Ada, Li, Cory)");
}

if (seed) {
  await connect();
  await seedDemo();
  console.log("· demo dimensions seeded (Country, Channel)");
}

console.log("\nDone.\n");
process.exit(0);
```

Note: `connect()` (DuckDB) is only called when `--seed` is passed because `seedDemo` calls `addDimension` which creates Postgres tables — that now goes through `pgRun`, not DuckDB. The `connect()` call in `--seed` is kept in case future seed steps need the DuckDB warehouse connection.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add server/src/bootstrap.ts
git commit -m "feat(server): bootstrap uses Drizzle migrations instead of ensureSchema()"
```

---

***REMOVED******REMOVED*** Task 7: Update `server/src/db.ts` — Remove Postgres ATTACH

**Files:**
- Modify: `server/src/db.ts`

DuckDB becomes warehouse-only. Remove `attachPostgres` entirely. The `pg`, `pg_catalog` catalog alias and the three-part `oltp.*.*` table refs disappear from DuckDB's view.

- [ ] **Step 1: Remove `attachPostgres` and its call**

Replace the entire `db.ts` with:

```typescript
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { env } from "./env.ts";

let _conn: DuckDBConnection | null = null;
let _connecting: Promise<DuckDBConnection> | null = null;

async function attachMotherDuck(conn: DuckDBConnection): Promise<void> {
  await conn.run(`INSTALL motherduck`);
  await conn.run(`LOAD motherduck`);
  process.env.motherduck_token = env.motherduckToken;
  await conn.run(`SET motherduck_token='${env.motherduckToken}'`).catch(() => {});
  await conn.run(`ATTACH IF NOT EXISTS 'md:'`);
}

/** Returns the one live DuckDB connection (warehouse-only — no Postgres ATTACH).
 *  Call only when a warehouse query is about to run. */
export async function connect(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  if (_connecting) return _connecting;
  _connecting = (async () => {
    const inst = await DuckDBInstance.create(env.duckPath);
    const conn = await inst.connect();
    if (env.attachWarehouse) {
      await attachMotherDuck(conn);
    } else {
      console.warn("⚠ warehouse (MotherDuck) attach deferred — set ATTACH_WAREHOUSE=true to enable the scan");
    }
    _conn = conn;
    return conn;
  })();
  return _connecting;
}

export async function all<T = Record<string, unknown>>(sql: string, params: DuckDBValue[] = []): Promise<T[]> {
  const conn   = await connect();
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjects() as T[];
}

export async function get<T = Record<string, unknown>>(sql: string, params: DuckDBValue[] = []): Promise<T | null> {
  const rows = await all<T>(sql, params);
  return rows[0] ?? null;
}

export async function run(sql: string, params: DuckDBValue[] = []): Promise<void> {
  const conn = await connect();
  await conn.run(sql, params);
}

export async function tx<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const conn = await connect();
  await conn.run("BEGIN");
  try {
    const out = await fn(conn);
    await conn.run("COMMIT");
    return out;
  } catch (e) {
    await conn.run("ROLLBACK").catch(() => {});
    throw e;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add server/src/db.ts
git commit -m "feat(server): DuckDB becomes warehouse-only (remove Postgres ATTACH)"
```

---

***REMOVED******REMOVED*** Task 8: Update `server/src/env.ts` — Fix `pg()` Helper

**Files:**
- Modify: `server/src/env.ts`

`pg()` currently returns a three-part DuckDB name (`oltp.zugzug_app.table`). It now returns a two-part Postgres name (`"zugzug_app"."table"`). All callers in `auth.ts`, `team.ts`, and `repo.ts` use it with `pgAll/pgGet/pgRun` after this change.

- [ ] **Step 1: Update the `pg` export at the bottom of `env.ts`**

Change:
```typescript
/** Fully-qualified Postgres app-state table name, e.g. oltp.zugzug_app.draft */
export const pg = (table: string) => `${env.oltpCatalog}.${env.appSchema}.${table}`;
```

To:
```typescript
/** Qualified Postgres app-state table name: "zugzug_app"."table" */
export const pg = (table: string) => `"${env.appSchema}"."${table}"`;
```

Also remove `oltpCatalog` from the `env` object since it's no longer needed at runtime (the `oltp` catalog alias was only meaningful to DuckDB's Postgres extension):

Change this line in the `env` object:
```typescript
oltpCatalog: "oltp",
```
To (delete the line entirely — or keep if any code still references it via `env.oltpCatalog`).

Check for `env.oltpCatalog` usage first:
```bash
grep -r "oltpCatalog" server/src/
```

If only `schema.ts` and `env.ts` reference it (schema.ts is being deleted), remove it. If `repo.ts` uses it in `cq()`, that will be fixed in Task 10.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```
Expected: errors in `repo.ts` and `auth.ts` referencing the old `oltp.*.*` pattern — those are fixed in upcoming tasks.

- [ ] **Step 3: Commit**

```bash
git add server/src/env.ts
git commit -m "feat(server): pg() helper returns 2-part Postgres schema.table name"
```

---

***REMOVED******REMOVED*** Task 9: Migrate `auth.ts` and `team.ts`

**Files:**
- Modify: `server/src/auth.ts`
- Modify: `server/src/team.ts`

Both files are pure OLTP — every query only touches `zugzug_app` tables. Swap the imports and fix `bigint` → `number` type annotations.

- [ ] **Step 1: Rewrite `server/src/auth.ts`**

Change the import at the top from:
```typescript
import { run, all, get } from "./db.ts";
```
To:
```typescript
import { pgRun as run, pgAll as all, pgGet as get } from "./pg.ts";
```

Then find the one place that uses `bigint` and fix it (line ~140):

Change:
```typescript
const [{ n }] = await all<{ n: bigint }>(`SELECT count(*) AS n FROM ${pg("allowed_emails")}`);
if (Number(n) === 0) {
```
To:
```typescript
const [{ n }] = await all<{ n: number }>(`SELECT count(*)::int AS n FROM ${pg("allowed_emails")}`);
if (n === 0) {
```

No other changes needed — all other queries use `$1`-style params which postgres.js `unsafe()` handles identically to DuckDB.

- [ ] **Step 2: Rewrite `server/src/team.ts`**

Change the import from:
```typescript
import { run, all, get } from "./db.ts";
```
To:
```typescript
import { pgRun as run, pgAll as all, pgGet as get } from "./pg.ts";
```

No other changes needed.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add server/src/auth.ts server/src/team.ts
git commit -m "feat(server): auth + team use native postgres.js client"
```

---

***REMOVED******REMOVED*** Task 10: Update `repo.ts` — Imports and `cq()` Helper

**Files:**
- Modify: `server/src/repo.ts` (imports + `cq` definition only)

Update the import block and fix `cq()` so that canonical table references become 2-part Postgres names instead of 3-part DuckDB names.

- [ ] **Step 1: Update imports**

Find the current import block at the top of `repo.ts`:
```typescript
import type { DuckDBValue } from "@duckdb/node-api";
import { all, get, run } from "./db.ts";
import { env, pg } from "./env.ts";
```

Replace with:
```typescript
import type { DuckDBValue } from "@duckdb/node-api";
import { all, get, run } from "./db.ts";
import { pgAll, pgGet, pgRun, pgTx } from "./pg.ts";
import { env, pg } from "./env.ts";
```

- [ ] **Step 2: Update `cq()` helper**

Find (around line 61):
```typescript
const cq = (display: string) => `${env.oltpCatalog}.` + display.split(".").map(qid).join(".");
```

Replace with:
```typescript
const cq = (display: string) => display.split(".").map(qid).join(".");
```

`cq("zugzug.dim_country")` now returns `"zugzug"."dim_country"` (2-part, valid in postgres.js).

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add server/src/repo.ts
git commit -m "refactor(repo): add pg.ts imports + fix cq() to 2-part Postgres names"
```

---

***REMOVED******REMOVED*** Task 11: Migrate Pure OLTP Functions in `repo.ts`

**Files:**
- Modify: `server/src/repo.ts`

Migrate every function that only touches `zugzug_app` tables. Pattern: replace `all` → `pgAll`, `get` → `pgGet`, `run` → `pgRun`. Also fix `epoch()` → `EXTRACT(EPOCH FROM ...)` (DuckDB-specific syntax not valid in Postgres).

Functions covered in this task:
`listUsers`, `listSources`, `sourceFacets`, `addSource`, `setSourceSchedule`, `anyScanDue`,
`listDrafts`, `saveDraft`, `discardDraft`, `appendAuditAs`, `appendAudit`, `listAudit`,
`getPreferences`, `setPreferences`, `getGridLayout`, `setGridLayout`.

- [ ] **Step 1: Update `listUsers`**

```typescript
export async function listUsers(): Promise<User[]> {
  return pgAll<User>(`SELECT id, name, initials FROM ${pg("users")} ORDER BY id`);
}
```

- [ ] **Step 2: Update `listSources`**

```typescript
export async function listSources(opts: { q?: string; schema?: string; status?: string } = {}): Promise<SourceInfo[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.q) {
    params.push(`%${opts.q}%`);
    const p = `$${params.length}`;
    where.push(`(s.source_table ILIKE ${p} OR s.source_column ILIKE ${p})`);
  }
  if (opts.schema) {
    params.push(opts.schema);
    where.push(`split_part(s.source_table, '.', 1) = $${params.length}`);
  }
  if (opts.status === "needs")   where.push(`COALESCE(st.unmapped, 0) > 0`);
  else if (opts.status === "clean")   where.push(`COALESCE(st.present, false) AND COALESCE(st.unmapped, 0) = 0`);
  else if (opts.status === "missing") where.push(`st.scanned_at IS NOT NULL AND NOT st.present`);

  const rows = await pgAll<{
    dimId: string; dimension: string; table: string; column: string;
    present: boolean; rows: number; values: number; unmapped: number;
    scanned: boolean; schedule: string | null; scannedAt: string | null;
  }>(
    `SELECT s.dim_id AS "dimId", d.label AS dimension, s.source_table AS "table", s.source_column AS column,
            COALESCE(st.present, false) AS present,
            COALESCE(st.rows, 0)::int AS rows,
            COALESCE(st.distinct_values, 0)::int AS values,
            COALESCE(st.unmapped, 0)::int AS unmapped,
            (st.scanned_at IS NOT NULL) AS scanned,
            s.schedule AS schedule,
            st.scanned_at::text AS "scannedAt"
     FROM ${pg("dimension_source")} s
     JOIN ${pg("dimension")} d ON d.id = s.dim_id
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY COALESCE(st.unmapped, 0) DESC, s.source_table, s.source_column
     LIMIT 1000`,
    params,
  );
  return rows.map((r) => ({
    table: r.table, column: r.column, dimension: r.dimension, dimId: r.dimId,
    present: !!r.present, rows: Number(r.rows), values: Number(r.values),
    unmapped: Number(r.unmapped), scanned: !!r.scanned,
    schedule: r.schedule ?? null,
    scannedAt: r.scannedAt ?? null,
  }));
}
```

- [ ] **Step 3: Update `sourceFacets`**

```typescript
export async function sourceFacets(): Promise<SchemaFacet[]> {
  const rows = await pgAll<{ schema: string; columns: number; unmapped: number; missing: number }>(
    `SELECT split_part(s.source_table, '.', 1) AS schema,
            count(*)::int AS columns,
            COALESCE(sum(st.unmapped), 0)::int AS unmapped,
            count(*) FILTER (WHERE st.scanned_at IS NOT NULL AND NOT st.present)::int AS missing
     FROM ${pg("dimension_source")} s
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
     GROUP BY 1 ORDER BY unmapped DESC, schema`,
  );
  return rows.map((r) => ({
    schema: r.schema, columns: Number(r.columns), unmapped: Number(r.unmapped), missing: Number(r.missing),
  }));
}
```

- [ ] **Step 4: Update `addSource`**

```typescript
export async function addSource(dimId: string, table: string, column: string): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column)
     VALUES ($1, $2, $3) ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`,
    [dimId, table, column],
  );
}
```

- [ ] **Step 5: Update `setSourceSchedule`**

```typescript
export async function setSourceSchedule(dimId: string, table: string, column: string, schedule: string | null): Promise<void> {
  const valid = schedule === null || ["15m", "hourly", "daily"].includes(schedule);
  if (!valid) throw new Error(`invalid schedule: ${schedule}`);
  await pgRun(
    `UPDATE ${pg("dimension_source")} SET schedule = $1
     WHERE dim_id = $2 AND source_table = $3 AND source_column = $4`,
    [schedule, dimId, table, column],
  );
}
```

- [ ] **Step 6: Update `anyScanDue`**

The DuckDB error message patterns change to Postgres equivalents:

```typescript
export async function anyScanDue(now: Date = new Date()): Promise<boolean> {
  let rows: { schedule: string; scanned_at: string | null }[];
  try {
    rows = await pgAll<{ schedule: string; scanned_at: string | null }>(
      `SELECT s.schedule, st.scanned_at::text AS scanned_at
       FROM ${pg("dimension_source")} s
       LEFT JOIN ${pg("source_stat")} st
         ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
       WHERE s.schedule IS NOT NULL`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation.*zugzug_app.*does not exist/i.test(msg)) return false;
    throw e;
  }
  const dueMs = (s: string) =>
    s === "15m" ? 15 * 60_000 : s === "hourly" ? 60 * 60_000 : s === "daily" ? 24 * 60 * 60_000 : Infinity;
  return rows.some(
    (r) => !r.scanned_at || now.getTime() - new Date(r.scanned_at).getTime() >= dueMs(r.schedule),
  );
}
```

- [ ] **Step 7: Update `listDrafts`**

The `epoch()` DuckDB function becomes `EXTRACT(EPOCH FROM ...)` in Postgres:

```typescript
export async function listDrafts(dimId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    dimId: string; raw: string; status: "mapped" | "skipped";
    targetLabel: string | null; targetKey: string | null; uid: string; secs: number;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("draft")} WHERE dim_id = $1 ORDER BY created_at DESC`,
    [dimId],
  );
  const out: Draft[] = [];
  for (const r of rows) {
    out.push({
      dimId: r.dimId, raw: r.raw, status: r.status,
      targetLabel: r.targetLabel, targetKey: r.targetKey,
      user: await userById(r.uid), at: rel(Number(r.secs)),
    });
  }
  return out;
}
```

- [ ] **Step 8: Update `saveDraft`**

```typescript
export async function saveDraft(
  dimId: string, raw: string, status: "mapped" | "skipped",
  targetLabel: string | null, targetKey: string | null, userId: string,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("draft")} (dim_id, raw, status, target_label, target_key, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp)
     ON CONFLICT (dim_id, raw, user_id) DO UPDATE
       SET status = EXCLUDED.status, target_label = EXCLUDED.target_label,
           target_key = EXCLUDED.target_key, created_at = EXCLUDED.created_at`,
    [dimId, raw, status, targetLabel, targetKey, userId],
  );
}
```

- [ ] **Step 9: Update `discardDraft`**

```typescript
export async function discardDraft(dimId: string, raw: string, userId: string): Promise<void> {
  await pgRun(
    `DELETE FROM ${pg("draft")} WHERE dim_id = $1 AND raw = $2 AND user_id = $3`,
    [dimId, raw, userId],
  );
}
```

- [ ] **Step 10: Update `appendAuditAs` and `appendAudit`**

```typescript
export async function appendAuditAs(userId: string, action: string, detail: string): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("audit_log")} (id, created_at, user_id, action, detail)
     VALUES ($1, current_timestamp, $2, $3, $4)`,
    [randomUUID(), userId, action, detail],
  );
}

export async function appendAudit(action: string, detail: string): Promise<void> {
  await appendAuditAs("u_ada", action, detail);
}
```

- [ ] **Step 11: Update `listAudit`**

```typescript
export async function listAudit(limit = 30): Promise<AuditEntry[]> {
  const rows = await pgAll<{ id: string; uid: string; action: string; detail: string; secs: number }>(
    `SELECT id, user_id AS uid, action, detail,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("audit_log")} ORDER BY created_at DESC
     LIMIT ${Math.max(1, Math.min(200, limit))}`,
  );
  const out: AuditEntry[] = [];
  for (const r of rows) {
    out.push({ id: r.id, user: await userById(r.uid), action: r.action, detail: r.detail, at: rel(Number(r.secs)) });
  }
  return out;
}
```

- [ ] **Step 12: Update `getPreferences` and `setPreferences`**

```typescript
export async function getPreferences(): Promise<Preferences> {
  const row = (await pgAll<{ publish_threshold: number; suggest_threshold: number }>(
    `SELECT publish_threshold, suggest_threshold FROM ${pg("preferences")} WHERE id = 1`,
  ))[0];
  return row
    ? { publishThreshold: Number(row.publish_threshold), suggestThreshold: Number(row.suggest_threshold) }
    : { publishThreshold: 95, suggestThreshold: 80 };
}

export async function setPreferences(p: Preferences): Promise<void> {
  const publish = Math.max(0, Math.min(100, Math.round(p.publishThreshold)));
  const suggest = Math.max(0, Math.min(publish, Math.round(p.suggestThreshold)));
  await pgRun(
    `UPDATE ${pg("preferences")} SET publish_threshold = $1, suggest_threshold = $2, updated_at = current_timestamp WHERE id = 1`,
    [publish, suggest],
  );
}
```

- [ ] **Step 13: Update `getGridLayout` and `setGridLayout`**

```typescript
export async function getGridLayout(userId: string, dimId: string): Promise<GridLayoutConfig> {
  const row = await pgGet<{ config: string | null }>(
    `SELECT config FROM ${pg("user_grid_layout")} WHERE user_id = $1 AND dim_id = $2`,
    [userId, dimId],
  );
  if (!row?.config) return {};
  try { return JSON.parse(row.config) as GridLayoutConfig; } catch { return {}; }
}

export async function setGridLayout(userId: string, dimId: string, config: GridLayoutConfig): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("user_grid_layout")} (user_id, dim_id, config, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, dim_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [userId, dimId, JSON.stringify(config)],
  );
}
```

- [ ] **Step 14: Update `userById` (internal helper)**

```typescript
async function userById(id: string): Promise<User> {
  return (
    (await pgGet<User>(`SELECT id, name, initials FROM ${pg("users")} WHERE id = $1`, [id])) ??
    { id, name: id, initials: id.slice(0, 2).toUpperCase() }
  );
}
```

- [ ] **Step 15: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 16: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(repo): migrate pure OLTP functions to postgres.js"
```

---

***REMOVED******REMOVED*** Task 12: Migrate Dimension Registry + Canonical + `commit` in `repo.ts`

**Files:**
- Modify: `server/src/repo.ts`

Functions covered: `listDimensions`, `addDimension`, `addCanonical`, `addCanonicalOne`,
`renameCanonical`, `mergeCanonical`, `retireCanonical`, `listFields`, `addField`,
`renameColumn`, `changeColumnType`, `deleteColumn`, `listVariants`,
`addColumnOption`, `setFieldValue`, `commit`, `bulkInsert`, `bulkInsert1`.

Key improvement: `commit` and `changeColumnType` and `deleteColumn` now use `pgTx` for real atomic transactions (previously impossible through DuckDB's Postgres extension).

- [ ] **Step 1: Update `bulkInsert` and `bulkInsert1`**

```typescript
async function bulkInsert(prefix: string, rows: [string, string][], conflict: string): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(", ");
    await pgRun(`${prefix} VALUES ${placeholders} ${conflict}`, chunk.flat());
  }
}

async function bulkInsert1(prefix: string, values: string[], conflict: string): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j + 1})`).join(", ");
    await pgRun(`${prefix} VALUES ${placeholders} ${conflict}`, chunk);
  }
}
```

- [ ] **Step 2: Update `listDimensions`**

```typescript
export async function listDimensions(): Promise<DimensionMeta[]> {
  const metas = await pgAll<Omit<DimensionMeta, "rows">>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} ORDER BY label`,
  );
  const out: DimensionMeta[] = [];
  for (const m of metas) {
    const r = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${cq(m.mapTable)}`,
    ).catch(() => null);
    out.push({ ...m, rows: Number(r?.n ?? 0) });
  }
  return out;
}
```

- [ ] **Step 3: Update `addDimension`**

```typescript
export async function addDimension(
  name: string,
  sources: SourceDef[] = [],
  opts: { keyKind?: "slug" | "external_id" } = {},
): Promise<string> {
  const id = slug(name);
  if (!id) return id;
  const keyKind    = opts.keyKind === "external_id" ? "external_id" : "slug";
  const dimTable   = `${env.canonicalSchema}.dim_${id}`;
  const mapTable   = `${env.canonicalSchema}.map_${id}`;
  const keyCol     = `${id}_code`;
  const existing   = await pgGet(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
  if (!existing) {
    const labelDdl = keyKind === "external_id" ? "label VARCHAR" : "label VARCHAR NOT NULL";
    await pgRun(`CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (${qid(keyCol)} VARCHAR PRIMARY KEY, ${labelDdl})`);
    await pgRun(`CREATE TABLE IF NOT EXISTS ${cq(mapTable)} (raw VARCHAR PRIMARY KEY, ${qid(keyCol)} VARCHAR NOT NULL)`);
    await pgRun(
      `INSERT INTO ${pg("dimension")} (id, label, dim_table, map_table, key_col, key_kind, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, current_timestamp)`,
      [id, name.trim(), dimTable, mapTable, keyCol, keyKind],
    );
    await appendAudit(
      "Created dimension",
      `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`,
    );
  }
  for (const s of sources) {
    await pgRun(
      `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column)
       VALUES ($1, $2, $3) ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`,
      [id, s.table, s.column],
    );
  }
  return id;
}
```

- [ ] **Step 4: Update `addCanonical`, `addCanonicalOne`, `renameCanonical`, `mergeCanonical`, `retireCanonical`**

```typescript
export async function addCanonical(dimId: string, values: CanonicalValue[]): Promise<void> {
  const meta = await pgGet<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM ${pg("dimension")} WHERE id = $1`, [dimId],
  );
  if (!meta) return;
  for (const v of values) {
    await pgRun(
      `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label) VALUES ($1, $2)
       ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING`,
      [v.key, v.label],
    );
  }
}

export async function addCanonicalOne(dimId: string, label: string, key?: string): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  await pgRun(
    `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
     ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
    [k, label],
  );
  await appendAudit("Added canonical", `${label} (${k})`);
}

export async function renameCanonical(dimId: string, key: string, label: string): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  await pgRun(`UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`, [label, key]);
  await appendAudit("Renamed canonical", `${key} → "${label}"`);
}

export async function mergeCanonical(dimId: string, survivor: string, losers: string[]): Promise<number> {
  const m = await dimMeta(dimId);
  if (!m) return 0;
  const key  = qid(m.keyCol);
  const real = losers.filter((l) => l && l !== survivor);
  for (const loser of real) {
    await pgRun(`UPDATE ${cq(m.mapTable)} SET ${key} = $1 WHERE ${key} = $2`, [survivor, loser]);
    await pgRun(`DELETE FROM ${cq(m.dimTable)} WHERE ${key} = $1`, [loser]);
  }
  if (real.length) await appendAudit("Merged canonical", `${real.join(", ")} → ${survivor}`);
  return real.length;
}

export async function retireCanonical(dimId: string, key: string): Promise<{ ok: boolean; variants: number }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false, variants: 0 };
  const v = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1`, [key],
  );
  const variants = Number(v?.n ?? 0);
  if (variants > 0) return { ok: false, variants };
  await pgRun(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
  await appendAudit("Retired canonical", key);
  return { ok: true, variants: 0 };
}
```

- [ ] **Step 5: Update `listFields`, `addField`, `renameColumn`**

```typescript
export async function listFields(dimId: string): Promise<FieldDef[]> {
  const rows = await pgAll<{ field: string; label: string; type: string; options: string | null }>(
    `SELECT field, label, type, options FROM ${pg("dimension_field")} WHERE dim_id = $1 ORDER BY created_at`,
    [dimId],
  );
  return rows.map((r) => {
    let opts: string[] | undefined;
    if (typeof r.options === "string" && r.options.length > 0) {
      try { const p = JSON.parse(r.options); if (Array.isArray(p)) opts = p as string[]; } catch {}
    }
    return { field: r.field, label: r.label, type: r.type, options: opts };
  });
}

export async function addField(dimId: string, label: string, type = "text", options?: string[]): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId);
  if (!m) return null;
  const t       = SQL_TYPE[type] ? type : (type === "select" ? "select" : "text");
  const field   = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null;
  const sqlType = t === "select" ? "VARCHAR" : SQL_TYPE[t];
  await pgRun(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
  const opts = t === "select" ? JSON.stringify(options ?? []) : null;
  await pgRun(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, options, created_at)
     VALUES ($1, $2, $3, $4, $5, current_timestamp) ON CONFLICT (dim_id, field) DO NOTHING`,
    [dimId, field, label.trim(), t, opts],
  );
  await appendAudit("Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`);
  return { field };
}

export async function renameColumn(dimId: string, field: string, newLabel: string): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  await pgRun(
    `UPDATE ${pg("dimension_field")} SET label = $1 WHERE dim_id = $2 AND field = $3`,
    [label, dimId, field],
  );
  await appendAudit("Renamed column", `${field} → "${label}"`);
}
```

- [ ] **Step 6: Update `changeColumnType` — use `pgTx` for real atomic transaction**

```typescript
export async function changeColumnType(
  dimId: string, field: string, newType: string,
  options?: string[], coerceInvalidToNull = false,
): Promise<{ ok: boolean; invalidCount?: number; options?: string[] }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f) return { ok: false };
  const col  = qid(field);
  const keyc = qid(m.keyCol);

  const rows = await pgAll<{ k: string; v: string | null }>(
    `SELECT ${keyc} AS k, CAST(${col} AS VARCHAR) AS v FROM ${cq(m.dimTable)}`,
  );

  const parsed: { k: string; v: string | number | boolean | null; bad: boolean }[] = [];
  for (const r of rows) {
    if (r.v == null || r.v === "") { parsed.push({ k: r.k, v: null, bad: false }); continue; }
    if (newType === "text")   { parsed.push({ k: r.k, v: r.v, bad: false }); continue; }
    if (newType === "select") {
      const collected = options ?? [...new Set(rows.filter((x) => x.v).map((x) => x.v!))];
      parsed.push({ k: r.k, v: r.v, bad: !collected.includes(r.v) });
      continue;
    }
    if (newType === "number") {
      const n = Number(r.v);
      parsed.push({ k: r.k, v: Number.isFinite(n) ? n : null, bad: !Number.isFinite(n) });
      continue;
    }
    if (newType === "boolean") {
      const b = r.v === "true" ? true : r.v === "false" ? false : null;
      parsed.push({ k: r.k, v: b, bad: b == null });
      continue;
    }
    if (newType === "date") {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(r.v);
      parsed.push({ k: r.k, v: ok ? r.v : null, bad: !ok });
      continue;
    }
    parsed.push({ k: r.k, v: r.v, bad: true });
  }

  const invalidCount = parsed.filter((p) => p.bad).length;
  if (invalidCount > 0 && !coerceInvalidToNull) return { ok: false, invalidCount };

  const newSql = newType === "select" ? "VARCHAR"
    : newType === "number"  ? "NUMERIC"
    : newType === "boolean" ? "BOOLEAN"
    : newType === "date"    ? "DATE"
    : "VARCHAR";
  const tmp          = `${field}__tmp_${Date.now().toString(36)}`;
  const finalOptions = newType === "select"
    ? (options ?? [...new Set(parsed.filter((p) => p.v != null).map((p) => String(p.v)))])
    : undefined;

  await pgTx(async ({ run }) => {
    await run(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN ${qid(tmp)} ${newSql}`);
    for (const p of parsed) {
      if (p.bad && !coerceInvalidToNull) continue;
      await run(`UPDATE ${cq(m.dimTable)} SET ${qid(tmp)} = $1 WHERE ${keyc} = $2`, [p.v, p.k]);
    }
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN ${col}`);
    await run(`ALTER TABLE ${cq(m.dimTable)} RENAME COLUMN ${qid(tmp)} TO ${col}`);
    await run(
      `UPDATE ${pg("dimension_field")} SET type = $1, options = $2 WHERE dim_id = $3 AND field = $4`,
      [newType, newType === "select" ? JSON.stringify(finalOptions ?? []) : null, dimId, field],
    );
  });

  await appendAudit("Changed column type", `${field} → ${newType}${finalOptions ? ` (${finalOptions.length} options)` : ""}`);
  return { ok: true, options: finalOptions };
}
```

- [ ] **Step 7: Update `deleteColumn` — use `pgTx`**

```typescript
export async function deleteColumn(dimId: string, field: string): Promise<{ ok: boolean }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const col = qid(field);
  await pgTx(async ({ run }) => {
    await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2`, [dimId, field]);
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN IF EXISTS ${col}`);
  });
  await appendAudit("Deleted column", field);
  return { ok: true };
}
```

- [ ] **Step 8: Update `listVariants`, `addColumnOption`, `setFieldValue`**

```typescript
export async function listVariants(dimId: string, key: string): Promise<string[]> {
  const m = await dimMeta(dimId);
  if (!m) return [];
  const rows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1 ORDER BY raw LIMIT 300`, [key],
  );
  return rows.map((r) => r.raw);
}

export async function addColumnOption(dimId: string, field: string, label: string): Promise<{ options: string[] } | null> {
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f || f.type !== "select") return null;
  const existing = f.options ?? [];
  if (existing.includes(label)) return { options: existing };
  const next = [...existing, label];
  await pgRun(
    `UPDATE ${pg("dimension_field")} SET options = $1 WHERE dim_id = $2 AND field = $3`,
    [JSON.stringify(next), dimId, field],
  );
  await appendAudit("Added option", `${label} → ${field}`);
  return { options: next };
}

export async function setFieldValue(dimId: string, key: string, field: string, value: string | null): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f) return;
  const col  = qid(field);
  const keyc = qid(m.keyCol);
  const empty = value == null || value.trim() === "";
  if (f.type === "number") {
    const n = empty ? null : Number(value);
    await pgRun(
      `UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`,
      [Number.isFinite(n as number) ? n : null, key],
    );
  } else if (f.type === "boolean") {
    const b = value === "true" ? true : value === "false" ? false : null;
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [b, key]);
  } else if (f.type === "date") {
    await pgRun(
      `UPDATE ${cq(m.dimTable)} SET ${col} = $1::date WHERE ${keyc} = $2`,
      [empty ? null : value!.trim(), key],
    );
  } else {
    await pgRun(
      `UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`,
      [empty ? null : value, key],
    );
  }
}
```

Note: `CAST($1 AS DATE)` changed to `$1::date` (postgres.js handles the cast inline; DuckDB's extension had trouble with the `CAST` form).

- [ ] **Step 9: Update `commit` — now a real atomic transaction**

```typescript
export async function commit(dimId: string, userId: string): Promise<{ committed: number; rowsRecovered: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; label: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label
     FROM ${pg("dimension")} WHERE id = $1`, [dimId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0 };
  const key   = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT  = cq(meta.dimTable);
  const MAPT  = cq(meta.mapTable);

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`, [dimId],
  );
  const committed = Number(approved?.n ?? 0);
  if (!committed) return { committed: 0, rowsRecovered: 0 };

  const rowsRecovered = await rowsForUnmappedDrafts(dimId, meta.mapTable);

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
    await run(
      `DELETE FROM ${DRAFT} WHERE dim_id = $1 AND status = 'mapped'`, [dimId],
    );
  });

  await appendAuditAs(
    userId, "Committed",
    `${committed} value${committed === 1 ? "" : "s"} → ${meta.mapTable} · ${rowsRecovered.toLocaleString()} rows recovered`,
  );
  return { committed, rowsRecovered };
}
```

- [ ] **Step 10: Update `dimMeta` helper**

```typescript
async function dimMeta(dimId: string): Promise<DimMeta | null> {
  return pgGet<DimMeta>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol"
     FROM ${pg("dimension")} WHERE id = $1`, [dimId],
  );
}
```

- [ ] **Step 11: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 12: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(repo): dimension registry + canonical + commit use postgres.js (commit now atomic)"
```

---

***REMOVED******REMOVED*** Task 13: Decompose Cross-Store Join Functions

**Files:**
- Modify: `server/src/repo.ts`

Three functions currently do a DuckDB cross-store JOIN (warehouse ⋈ Postgres). In the new architecture, decompose each into two fetches + TypeScript set arithmetic. DuckDB continues to fetch warehouse data; postgres.js fetches the Postgres side.

- [ ] **Step 1: Decompose `scanValues`**

Replace the entire `scanValues` function. The warehouse query uses DuckDB `all()`; the mapped lookup uses `pgAll()`:

```typescript
async function scanValues(
  dimId: string,
  meta: Omit<DimensionMeta, "rows"> & { nameTable?: string | null; nameIdCol?: string | null; nameCol?: string | null },
): Promise<MappingValue[]> {
  let sources = await liveSources(dimId);
  if (meta.keyKind === "external_id" && meta.nameTable && meta.nameCol) {
    sources = sources.filter((s) => !(s.table === meta.nameTable && s.column === meta.nameCol));
  }
  if (!sources.length) return [];

  // 1. Warehouse: distinct raw values with provenance + row counts
  const occRows = await all<{ raw: string; tbl: string; col: string; rows: bigint }>(
    occUnion(sources),
  ).catch(() => [] as { raw: string; tbl: string; col: string; rows: bigint }[]);
  if (!occRows.length) return [];

  // Collapse to one row per raw value (UNION ALL → aggregate in JS)
  const occMap = new Map<string, { tbl: string; col: string; rows: number }[]>();
  for (const r of occRows) {
    const key = r.raw.toLowerCase();
    const entry = occMap.get(key) ?? [];
    entry.push({ tbl: r.tbl, col: r.col, rows: Number(r.rows) });
    occMap.set(key, entry);
  }
  // Keep insertion order (first raw string wins as the display value)
  const raws = new Map<string, string>(); // lowercase → original case
  for (const r of occRows) {
    if (!raws.has(r.raw.toLowerCase())) raws.set(r.raw.toLowerCase(), r.raw);
  }

  // 2. Postgres: all mapped raws for this dimension
  const mappedRows = await pgAll<{ raw: string; key: string }>(
    `SELECT raw, ${qid(meta.keyCol)} AS key FROM ${cq(meta.mapTable)}`,
  ).catch(() => [] as { raw: string; key: string }[]);
  const mappedSet = new Map<string, string>(); // lowercase raw → canonical key
  for (const r of mappedRows) mappedSet.set(r.raw.toLowerCase(), r.key);

  // 3. Optionally fetch live canonical names (external_id + warehouse attached)
  const liveName =
    meta.keyKind === "external_id" && env.attachWarehouse &&
    !!meta.nameTable && !!meta.nameIdCol && !!meta.nameCol;
  const nameMap = new Map<string, string>(); // canonical key → display name
  if (liveName) {
    const nameRows = await all<{ id: string; nm: string }>(
      `SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id,
              CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm
       FROM ${whTable(meta.nameTable!)}`,
    ).catch(() => [] as { id: string; nm: string }[]);
    for (const r of nameRows) nameMap.set(r.id, r.nm);
  }

  // 4. Postgres: all canonical labels (slug dims)
  const labelMap = new Map<string, string>(); // canonical key → label
  if (!liveName && meta.keyKind !== "external_id") {
    const dimRows = await pgAll<{ key: string; label: string }>(
      `SELECT ${qid(meta.keyCol)} AS key, label FROM ${cq(meta.dimTable)}`,
    ).catch(() => [] as { key: string; label: string }[]);
    for (const r of dimRows) labelMap.set(r.key, r.label);
  }

  // 5. Build result (unmapped first, then mapped; sorted by row count desc within each group)
  const results: MappingValue[] = [];
  for (const [lowerRaw, raw] of raws) {
    const sources: SourceOccurrence[] = (occMap.get(lowerRaw) ?? []).map((o) => ({
      table: o.tbl, column: o.col, rows: o.rows,
    }));
    const canonKey = mappedSet.get(lowerRaw) ?? null;
    const status: "mapped" | "new" = canonKey ? "mapped" : "new";
    const current = canonKey
      ? (liveName ? (nameMap.get(canonKey) ?? null) : (labelMap.get(canonKey) ?? null))
      : null;
    results.push({ value: raw, status, current, suggestion: null, confidence: 0, sources });
  }
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === "new" ? -1 : 1;
    const aRows = a.sources.reduce((s, x) => s + x.rows, 0);
    const bRows = b.sources.reduce((s, x) => s + x.rows, 0);
    return bRows - aRows;
  });
  return results.slice(0, 500);
}
```

Note: `occUnion(sources)` now returns the UNION ALL SQL directly (no outer SELECT). Update it to be a valid standalone query by wrapping:

The `occUnion` helper builds per-source fragments that are joined by UNION ALL. To use with DuckDB `all()`, just pass `occUnion(sources)` as the SQL — it's already a valid SELECT. No change needed to `occUnion` itself.

- [ ] **Step 2: Decompose `rowsForUnmappedDrafts`**

```typescript
async function rowsForUnmappedDrafts(dimId: string, mapTable: string): Promise<number> {
  const sources = await liveSources(dimId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values with total row counts
  const occRows = await all<{ raw: string; rows: bigint }>(
    occUnion(sources),
  ).catch(() => [] as { raw: string; rows: bigint }[]);
  if (!occRows.length) return 0;

  // Postgres: draft raws for this dimension with status=mapped
  const draftRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${pg("draft")} WHERE dim_id = $1 AND status = 'mapped'`, [dimId],
  );
  const draftSet = new Set(draftRows.map((r) => r.raw.toLowerCase()));

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${cq(mapTable)}`,
  ).catch(() => [] as { raw: string }[]);
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // Sum rows for warehouse values that are in a draft but not yet mapped
  let total = 0;
  for (const r of occRows) {
    const lower = r.raw.toLowerCase();
    if (draftSet.has(lower) && !mappedSet.has(lower)) total += Number(r.rows);
  }
  return total;
}
```

- [ ] **Step 3: Decompose `autoStageExactMatches`**

```typescript
export async function autoStageExactMatches(dimId: string): Promise<number> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1`, [dimId],
  );
  if (!meta) return 0;
  if (meta.keyKind === "external_id") return 0;

  const sources = await liveSources(dimId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values
  const occRows = await all<{ raw: string }>(
    occUnion(sources),
  ).catch(() => [] as { raw: string }[]);
  if (!occRows.length) return 0;
  const warehouseRaws = [...new Set(occRows.map((r) => r.raw))];

  // Postgres: canonical labels
  const canonRows = await pgAll<{ key: string; label: string }>(
    `SELECT ${qid(meta.keyCol)} AS key, label FROM ${cq(meta.dimTable)} WHERE label IS NOT NULL`,
  ).catch(() => [] as { key: string; label: string }[]);
  const labelToCanon = new Map<string, { key: string; label: string }>();
  for (const r of canonRows) labelToCanon.set(r.label.toLowerCase(), r);

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${cq(meta.mapTable)}`,
  ).catch(() => [] as { raw: string }[]);
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // JS: find exact case-insensitive matches not yet mapped
  const matches: { raw: string; key: string; label: string }[] = [];
  for (const raw of warehouseRaws) {
    const lower = raw.toLowerCase();
    if (mappedSet.has(lower)) continue;
    const canon = labelToCanon.get(lower);
    if (canon) matches.push({ raw, key: canon.key, label: canon.label });
  }

  if (!matches.length) return 0;
  for (const m of matches) {
    await saveDraft(dimId, m.raw, "mapped", m.label, m.key, "u_system");
  }
  await appendAuditAs(
    "u_system", "Auto-matched",
    `${matches.length} value${matches.length === 1 ? "" : "s"} staged in ${dimId} (exact label match)`,
  );
  return matches.length;
}
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(repo): decompose cross-store joins into two-fetch + JS pattern"
```

---

***REMOVED******REMOVED*** Task 14: Migrate `getDimension` and `scanSources`

**Files:**
- Modify: `server/src/repo.ts`

`getDimension` has one cross-store path (external_id liveName: join dim_ table with warehouse name table). Decompose it. `scanSources` writes Postgres via `run()` — move those writes to `pgRun`.

- [ ] **Step 1: Update `getDimension`**

```typescript
export async function getDimension(id: string): Promise<MappingDimension | null> {
  const meta = await pgGet<
    Omit<DimensionMeta, "rows"> & { nameTable: string | null; nameIdCol: string | null; nameCol: string | null }
  >(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind",
            name_table AS "nameTable", name_id_col AS "nameIdCol", name_col AS "nameCol"
     FROM ${pg("dimension")} WHERE id = $1`, [id],
  );
  if (!meta) return null;

  const k      = qid(meta.keyCol);
  const fields = await listFields(id);
  const fieldCols = fields.map((f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`).join(", ");

  const liveName =
    meta.keyKind === "external_id" && env.attachWarehouse &&
    !!meta.nameTable && !!meta.nameIdCol && !!meta.nameCol;

  // Fetch canonical rows from Postgres
  let canonRows: Record<string, unknown>[];
  if (meta.keyKind === "external_id") {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, NULL AS label, true AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.${k}`,
    );
  } else {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, d.label, false AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.label`,
    );
  }

  // For external_id dims with warehouse attached: resolve names from MotherDuck
  if (liveName) {
    const nameRows = await all<{ id: string; nm: string }>(
      `SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id,
              CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm
       FROM ${whTable(meta.nameTable!)}`,
    ).catch(() => [] as { id: string; nm: string }[]);
    const nameMap = new Map(nameRows.map((r) => [r.id, r.nm]));
    for (const r of canonRows) {
      const key = String(r.key);
      r.label      = nameMap.get(key) ?? null;
      r.unresolved = !nameMap.has(key);
    }
  }

  const canonical = canonRows.map((r) => ({
    key:        String(r.key),
    label:      r.label == null ? String(r.key) : String(r.label),
    unresolved: !!r.unresolved,
    variants:   Number(r.variants),
    fields:     Object.fromEntries(
      fields.map((f) => [f.field, r[f.field] == null ? null : String(r[f.field])]),
    ),
  }));

  const rowsRow = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(meta.mapTable)}`,
  ).catch(() => null);
  const values = await scanValues(id, meta);
  const { nameTable, nameIdCol, nameCol, ...metaOut } = meta;
  return { ...metaOut, rows: Number(rowsRow?.n ?? 0), canonical, values, fields };
}
```

- [ ] **Step 2: Update `scanSources` — Postgres writes move to `pgRun`**

The warehouse-read part stays on DuckDB `all/get`. The `INSERT INTO source_stat` and the `autoStageExactMatches` call (which uses postgres.js internally) are already using the right clients after Task 13. The only explicit `run()` calls to fix are the `INSERT INTO source_stat`:

Find the `INSERT INTO ${pg("source_stat")}` block inside `scanSources` (around line 174) and change `run(...)` to `pgRun(...)`:

```typescript
await pgRun(
  `INSERT INTO ${pg("source_stat")}
     (dim_id, source_table, source_column, present, rows, distinct_values, unmapped, scanned_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, current_timestamp)
   ON CONFLICT (dim_id, source_table, source_column) DO UPDATE SET
     present = EXCLUDED.present, rows = EXCLUDED.rows,
     distinct_values = EXCLUDED.distinct_values, unmapped = EXCLUDED.unmapped,
     scanned_at = EXCLUDED.scanned_at`,
  [r.dimId, r.table, r.column, present, rows, distinct, unmapped],
);
```

The warehouse `get<>()` calls in `scanSources` (agg, u) stay as-is (DuckDB `get`).

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(repo): getDimension + scanSources use postgres.js for Postgres writes"
```

---

***REMOVED******REMOVED*** Task 15: Delete `schema.ts` and Final Cleanup

**Files:**
- Delete: `server/src/schema.ts`
- Verify: `server/src/` has no remaining imports of `schema.ts`

- [ ] **Step 1: Confirm no remaining importers**

```bash
grep -r "from.*schema" server/src/ --include="*.ts"
```

Expected: no results referencing `./schema` or `../schema`.

- [ ] **Step 2: Delete the file**

```bash
rm server/src/schema.ts
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: clean (no errors from the deleted file).

- [ ] **Step 4: Commit**

```bash
git add -A server/src/schema.ts
git commit -m "chore(server): delete schema.ts — replaced by Drizzle schema + migrations"
```

---

***REMOVED******REMOVED*** Task 16: Smoke Test

This task verifies the full flow: migrations apply, server starts, auth works, a dimension load returns data.

- [ ] **Step 1: Run bootstrap (migrations only, no seed)**

From `server/`:
```bash
bun run bootstrap
```

Expected output:
```
Zug Zug — bootstrap

· Postgres migrations applied
Done.
```

No errors. Check Postgres: `drizzle.__drizzle_migrations` should have one row (the baseline).

- [ ] **Step 2: Run bootstrap with seed**

```bash
bun run bootstrap -- --seed
```

Expected: same output + `· demo dimensions seeded (Country, Channel)`.

- [ ] **Step 3: Start the server**

```bash
bun run start
```

Expected: server starts on `:8787` without errors.

- [ ] **Step 4: Hit a Postgres-backed endpoint**

```bash
curl http://localhost:8787/api/dimensions
```

Expected: JSON array with at least `country` and `channel`.

- [ ] **Step 5: Verify typecheck is clean**

```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(server): Drizzle + native postgres.js architecture complete

- postgres.js replaces DuckDB Postgres ATTACH for all OLTP queries
- DuckDB is now warehouse-only (MotherDuck)
- Drizzle manages 12 static tables with versioned migrations
- commit(), changeColumnType(), deleteColumn() are now truly atomic
- Cross-store joins decomposed to two-fetch + JS pattern
- schema.ts deleted"
```

---

***REMOVED******REMOVED*** Self-Review Checklist

**Spec coverage:**
- ✅ `server/src/pg.ts` — `pgAll/pgGet/pgRun/pgTx`
- ✅ `server/drizzle/schema.ts` — 12 tables
- ✅ `server/drizzle.config.ts` — Drizzle Kit config
- ✅ `server/drizzle/migrate.ts` — programmatic runner
- ✅ Baseline migration with IF NOT EXISTS
- ✅ `db.ts` — Postgres ATTACH removed
- ✅ `bootstrap.ts` — calls `runMigrations()`
- ✅ `env.ts` — `pg()` returns 2-part names
- ✅ `auth.ts` + `team.ts` — use postgres.js
- ✅ `repo.ts` — OLTP functions, canonical, commit, cross-store decomposition
- ✅ `schema.ts` deleted
- ✅ `npm scripts` — `db:generate`, `db:migrate`, `db:studio`
- ✅ `epoch()` → `EXTRACT(EPOCH FROM ...)` in listDrafts and listAudit
- ✅ `changeColumnType` + `deleteColumn` + `commit` use `pgTx` (real transactions)
- ✅ `anyScanDue` error pattern updated for Postgres error messages
- ✅ `bulkInsert`/`bulkInsert1` use `pgRun`
- ✅ `dimMeta` helper uses `pgGet`
- ✅ `userById` helper uses `pgGet`

**No placeholders found.**

**Type consistency:**
- `pgAll/pgGet/pgRun/pgTx` defined in Task 2, used consistently throughout Tasks 9–14.
- `cq()` updated in Task 10, used in all subsequent tasks.
- `pg()` updated in Task 8, all callers in Tasks 9–14 rely on the 2-part output.
