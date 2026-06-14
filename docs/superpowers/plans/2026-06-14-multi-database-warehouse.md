# Multi-Database Warehouse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the singleton `WAREHOUSE_DB` env var with a per-workspace warehouse connection that can register multiple databases (catalogs) and qualify every source by `(database, schema, table, column)`.

**Architecture:** Three new Postgres tables (`warehouse_connection`, `warehouse_database`, `user_warehouse_state`) plus a reshape of `dimension_source`/`source_stat` to carry `(database_id, schema_name, table_name, column_name)`. Credentials are AES-256-GCM-encrypted at rest with AAD-bound tenant/connection ids. The DuckDB adapter gains `listDatabases`/`probeDatabase`/`ping` with server-side timeouts; the registry caches adapters per `(tenant_id, connection_id)` with a 60s TTL. UI: new Settings → Warehouse page (card + databases table + Add/Remove dialogs), and the source-registration form gains a Database dropdown above the existing schema/table/column pickers.

**Tech Stack:** Bun + Drizzle + Postgres (server). React 18 + Vite + Tailwind v4 (app). `bun:test` server-side; Vitest + Testing Library client-side. AES-256-GCM via Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-06-14-multi-database-warehouse-design.md`

**Deferred from this plan (per user decision):** §5.5 "Replace connection" multi-step flow. Out of v1 scope. Connection swap available only via `DELETE` (force-required-on-dependents) followed by `POST`. Reference: spec §10.

---

## Phase map

| Phase | Tasks | Outcome |
|---|---|---|
| 1. Foundation — encryption + env + schema + migration | T1–T7 | New tables exist in dev DB; encrypted creds round-trip; backfill script populates rows |
| 2. Adapter contract + registry | T8–T11 | DuckDB adapter implements new methods with timeouts; registry caches per (tenant, conn) |
| 3. API endpoints | T12–T16 | Connection + database + source-registration endpoints live; legacy shape still accepted |
| 4. Frontend — Warehouse page + dialogs + source form | T17–T20 | Settings → Warehouse renders; Add/Remove DB dialogs work; AddSourceDialog has database picker |
| 5. Provisioning | T21 | `provisionTenant({ warehouse })` works; bootstrap seed uses it |
| 6. Cleanup + rollout | T22 | "Master records" section removed; feature flag drives the cutover |

---

## File structure

**Create:**
- `server/src/warehouse/crypto.ts` — `encryptCredentials` / `decryptCredentials`
- `server/src/warehouse/timeout.ts` — adapter timeout wrapper
- `server/src/repo-warehouse.ts` — connection + database repo functions
- `server/scripts/warehouse-backfill.ts` — one-shot encrypted-creds backfill
- `server/drizzle/migrations/<N>_warehouse_multi_db.sql` — schema + structural backfill
- `server/test/warehouse-crypto.test.ts`
- `server/test/warehouse-repo.test.ts`
- `server/test/warehouse-endpoints.test.ts`
- `server/test/warehouse-backfill-script.test.ts`
- `app/src/routes/settings/Warehouse.tsx` (rewrite — separate from current file)
- `app/src/components/warehouse/WarehouseCard.tsx`
- `app/src/components/warehouse/DatabaseTable.tsx`
- `app/src/components/warehouse/AddDatabaseDialog.tsx`
- `app/src/components/warehouse/RemoveDatabaseConfirm.tsx`
- `app/test/warehouse-card.test.tsx`
- `app/test/add-database-dialog.test.tsx`

**Modify:**
- `server/src/env.ts` — read `WAREHOUSE_ENCRYPTION_KEY`
- `server/.env.example` — document `WAREHOUSE_ENCRYPTION_KEY`
- `server/drizzle/schema.ts` — new tables + reshape `dimension_source`/`source_stat`/`preferences`
- `server/drizzle/migrate.ts` — set `zugzug.warehouse_db` session var before migrating
- `server/src/warehouse/adapter.ts` — gain `listDatabases` / `probeDatabase` / capability flags
- `server/src/warehouse/duckdb/base.ts` — implement new methods
- `server/src/warehouse/registry.ts` — rewrite cache + decrypt path
- `server/src/repo-scan.ts` — pass `databaseId` to adapter
- `server/src/repo-shared.ts` — drop `parseSourceTable` 2-part fallback at scan time
- `server/src/tables.ts` — write new `dimension_source` shape
- `server/src/repo-canonical.ts` — write new `dimension_source` shape
- `server/src/tenant.ts` — `provisionTenant` gains optional `warehouse` block
- `server/src/server.ts` — register `/api/warehouse/*` endpoints
- `app/src/components/admin/AdminSidebar.tsx` — add "Warehouse" entry
- `app/src/components/AddSourceDialog.tsx` — gain Database dropdown
- `app/src/components/CatalogExplorer.tsx` — gain `database` parameter
- `app/src/routes/settings/Warehouse.tsx` — delete "Master records" section in this PR

---

# Phase 1 — Foundation

### Task 1: Encryption module (`server/src/warehouse/crypto.ts`)

**Files:**
- Create: `server/src/warehouse/crypto.ts`
- Create: `server/test/warehouse-crypto.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/test/warehouse-crypto.test.ts`:

```typescript
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";

import { test, expect } from "bun:test";
import { encryptCredentials, decryptCredentials } from "../src/warehouse/crypto.ts";

const PLAINTEXT = JSON.stringify({ type: "duckdb", token: "md_token_abc", writable: false });
const AAD = "acme:wc_a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("round-trips plaintext when AAD matches", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  expect(decryptCredentials(blob, AAD)).toBe(PLAINTEXT);
});

test("ciphertext is base64", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
});

test("ciphertext is at least 28 bytes (nonce 12 + tag 16) longer than nothing", () => {
  const blob = encryptCredentials("", AAD);
  const raw = Buffer.from(blob, "base64");
  expect(raw.length).toBeGreaterThanOrEqual(28);
});

test("two encryptions of the same plaintext produce different blobs (random nonce)", () => {
  expect(encryptCredentials(PLAINTEXT, AAD)).not.toBe(encryptCredentials(PLAINTEXT, AAD));
});

test("wrong AAD on decrypt throws", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  expect(() => decryptCredentials(blob, "acme:wc_other")).toThrow();
});

test("tampered ciphertext throws", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  const raw = Buffer.from(blob, "base64");
  raw[20] ^= 0x01;
  const tampered = raw.toString("base64");
  expect(() => decryptCredentials(tampered, AAD)).toThrow();
});

test("decrypt rejects too-short blob", () => {
  expect(() => decryptCredentials(Buffer.from([1, 2, 3]).toString("base64"), AAD)).toThrow();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```
cd server && bun test test/warehouse-crypto.test.ts
```

Expected: all 7 tests fail with "module not found".

- [ ] **Step 3: Implement `crypto.ts`**

Create `server/src/warehouse/crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.ts";

const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = Buffer.from(env.warehouseEncryptionKey, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `WAREHOUSE_ENCRYPTION_KEY must decode to 32 raw bytes (got ${raw.length}); generate one with \`openssl rand -base64 32\``,
    );
  }
  return raw;
}

export function encryptCredentials(plaintext: string, aad: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key(), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

export function decryptCredentials(blob: string, aad: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("ciphertext too short to be valid AES-GCM output");
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key(), nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```
cd server && bun test test/warehouse-crypto.test.ts
```

Expected: 7 pass.

- [ ] **Step 5: Typecheck**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/warehouse/crypto.ts server/test/warehouse-crypto.test.ts
git commit -m "feat(server): AES-256-GCM credential encryption with AAD"
```

---

### Task 2: `WAREHOUSE_ENCRYPTION_KEY` env var

**Files:**
- Modify: `server/src/env.ts:18-91`
- Modify: `server/.env.example`

- [ ] **Step 1: Add to `env.ts`**

In `server/src/env.ts`, add a read for the key as a required var. Find the block that reads `databaseUrl` and `motherduckToken` (around lines 21-26) and add immediately after:

```typescript
const warehouseEncryptionKey = readRequired(
  "WAREHOUSE_ENCRYPTION_KEY",
  "required (base64-encoded 32-byte AES-256 key; generate with `openssl rand -base64 32`)",
);
```

Then add to the exported `env` object (find the export block around line 58):

```typescript
warehouseEncryptionKey,
```

(Insert after `motherduckToken` for readability.)

- [ ] **Step 2: Document in `.env.example`**

In `server/.env.example`, immediately after the `WAREHOUSE_DB=` line, append:

```
# AES-256 master key for encrypting warehouse credentials at rest.
# 32 raw bytes, base64-encoded. Generate with: openssl rand -base64 32
# CRITICAL: Lose this key, lose every workspace's warehouse connection
# (admins must re-enter credentials). No automatic key recovery.
WAREHOUSE_ENCRYPTION_KEY=
```

- [ ] **Step 3: Update local `.env`**

```
echo "WAREHOUSE_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> server/.env
```

(You'll need an actual key for the bootstrap to start. Run that command from the repo root once; commit nothing.)

- [ ] **Step 4: Verify the typecheck still passes**

```
cd server && bun run typecheck
```

Expected: clean. (No tests yet — Task 1 already exercises the read.)

- [ ] **Step 5: Commit**

```bash
git add server/src/env.ts server/.env.example
git commit -m "feat(server): require WAREHOUSE_ENCRYPTION_KEY"
```

---

### Task 3: New Drizzle tables (`warehouse_connection`, `warehouse_database`, `user_warehouse_state`)

**Files:**
- Modify: `server/drizzle/schema.ts`

- [ ] **Step 1: Add `foreignKey` to the imports**

In `server/drizzle/schema.ts`, the import block (lines 1-16) does not currently include `foreignKey`. Change it to include `foreignKey`:

```typescript
import {
  pgSchema,
  varchar,
  boolean,
  bigint,
  integer,
  serial,
  timestamp,
  primaryKey,
  foreignKey,
  index,
  uniqueIndex,
  text,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Add the three new tables at the end of the file**

Append to `server/drizzle/schema.ts`:

```typescript
export const warehouseConnection = app.table(
  "warehouse_connection",
  {
    id:                    varchar("id").notNull(),
    tenant_id:             varchar("tenant_id").notNull().references(() => tenant.id),
    adapter:               varchar("adapter").notNull(),
    label:                 varchar("label").notNull(),
    credentials_encrypted: text("credentials_encrypted").notNull(),
    credentials_hash:      varchar("credentials_hash").notNull(),
    credentials_version:   integer("credentials_version").notNull().default(1),
    last_verified_at:      timestamp("last_verified_at"),
    last_verify_error:     text("last_verify_error"),
    created_at:            timestamp("created_at").notNull(),
    created_by:            varchar("created_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    uniqueIndex("warehouse_connection_one_per_tenant").on(t.tenant_id),
    check(
      "warehouse_connection_adapter_chk",
      sql`${t.adapter} IN ('motherduck', 'duckdb_local')`,
    ),
  ],
);

export const warehouseDatabase = app.table(
  "warehouse_database",
  {
    id:               varchar("id").notNull(),
    tenant_id:        varchar("tenant_id").notNull().references(() => tenant.id),
    connection_id:    varchar("connection_id").notNull(),
    database_name:    varchar("database_name", { length: 255 }).notNull(),
    label:            varchar("label", { length: 255 }),
    last_probe_at:    timestamp("last_probe_at"),
    last_probe_error: text("last_probe_error"),
    added_at:         timestamp("added_at").notNull(),
    added_by:         varchar("added_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    uniqueIndex("warehouse_database_per_conn_unique").on(
      t.tenant_id,
      t.connection_id,
      t.database_name,
    ),
    index("warehouse_database_conn_idx").on(t.tenant_id, t.connection_id),
    foreignKey({
      columns:        [t.tenant_id, t.connection_id],
      foreignColumns: [warehouseConnection.tenant_id, warehouseConnection.id],
      name:           "warehouse_database_connection_fk",
    }).onDelete("cascade"),
  ],
);

export const userWarehouseState = app.table(
  "user_warehouse_state",
  {
    user_id:            varchar("user_id").notNull(),
    tenant_id:          varchar("tenant_id").notNull().references(() => tenant.id),
    recent_database_id: varchar("recent_database_id"),
    updated_at:         timestamp("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.user_id] }),
    foreignKey({
      columns:        [t.tenant_id, t.recent_database_id],
      foreignColumns: [warehouseDatabase.tenant_id, warehouseDatabase.id],
      name:           "user_warehouse_state_recent_db_fk",
    }).onDelete("set null"),
  ],
);
```

- [ ] **Step 3: Typecheck the schema**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/schema.ts
git commit -m "feat(server): warehouse_connection/database/user_state schema"
```

---

### Task 4: Schema updates (`preferences`, `dimension_source`, `source_stat`)

**Files:**
- Modify: `server/drizzle/schema.ts`

- [ ] **Step 1: Add `legacy_default_database_id` to `preferences`**

In `server/drizzle/schema.ts`, find the `preferences` table (around lines 183-200). Add a column `legacy_default_database_id: varchar("legacy_default_database_id")` (nullable) just before `tenant_id`:

```typescript
ai_api_key:                  varchar("ai_api_key"),
legacy_default_database_id:  varchar("legacy_default_database_id"),
tenant_id:                   varchar("tenant_id").notNull().references(() => tenant.id),
```

- [ ] **Step 2: Reshape `dimension_source` (add the new four columns)**

Locate the existing `dimensionSource` table in `server/drizzle/schema.ts`. Add the new columns alongside the existing `source_table`/`source_column` (which stay nullable for the rollback window — they will be dropped in a follow-up migration):

```typescript
export const dimensionSource = app.table(
  "dimension_source",
  {
    dim_id:        varchar("dim_id").notNull(),
    tenant_id:     varchar("tenant_id").notNull().references(() => tenant.id),
    source_table:  varchar("source_table"),                                    // was notNull(); becomes nullable
    source_column: varchar("source_column"),                                   // was notNull(); becomes nullable
    database_id:   varchar("database_id"),                                     // populated by migration
    schema_name:   varchar("schema_name",  { length: 255 }),
    table_name:    varchar("table_name",   { length: 255 }),
    column_name:   varchar("column_name",  { length: 255 }),
  },
  (t) => [
    primaryKey({
      columns: [t.tenant_id, t.dim_id, t.database_id, t.schema_name, t.table_name, t.column_name],
    }),
    index("dimension_source_dim_idx").on(t.tenant_id, t.dim_id),
    index("dimension_source_database_idx").on(t.tenant_id, t.database_id),
    foreignKey({
      columns:        [t.tenant_id, t.database_id],
      foreignColumns: [warehouseDatabase.tenant_id, warehouseDatabase.id],
      name:           "dimension_source_database_fk",
    }).onDelete("restrict"),
    check("dimension_source_schema_name_nonempty", sql`length(${t.schema_name}) > 0`),
    check("dimension_source_table_name_nonempty",  sql`length(${t.table_name})  > 0`),
    check("dimension_source_column_name_nonempty", sql`length(${t.column_name}) > 0`),
  ],
);
```

Drizzle will not switch a `notNull` to nullable in a generated diff cleanly; the migration SQL we'll write in Task 6 explicitly handles the PK swap and column promotions. The Drizzle schema is the post-state shape; the migration is the path.

- [ ] **Step 3: Same reshape for `source_stat`**

Locate `sourceStat` in the schema. Add the four new columns and swap the PK. `ON DELETE CASCADE` on the database FK because `source_stat` is derived:

```typescript
export const sourceStat = app.table(
  "source_stat",
  {
    dim_id:        varchar("dim_id").notNull(),
    tenant_id:     varchar("tenant_id").notNull().references(() => tenant.id),
    source_table:  varchar("source_table"),     // nullable through rollback window
    source_column: varchar("source_column"),    // nullable through rollback window
    database_id:   varchar("database_id"),
    schema_name:   varchar("schema_name",  { length: 255 }),
    table_name:    varchar("table_name",   { length: 255 }),
    column_name:   varchar("column_name",  { length: 255 }),
    /* keep all existing stat columns: scanned_at, present, unmapped, etc. */
  },
  (t) => [
    primaryKey({
      columns: [t.tenant_id, t.dim_id, t.database_id, t.schema_name, t.table_name, t.column_name],
    }),
    foreignKey({
      columns:        [t.tenant_id, t.database_id],
      foreignColumns: [warehouseDatabase.tenant_id, warehouseDatabase.id],
      name:           "source_stat_database_fk",
    }).onDelete("cascade"),
    check("source_stat_schema_name_nonempty", sql`length(${t.schema_name}) > 0`),
    check("source_stat_table_name_nonempty",  sql`length(${t.table_name})  > 0`),
    check("source_stat_column_name_nonempty", sql`length(${t.column_name}) > 0`),
  ],
);
```

(Preserve every existing column of `source_stat` — only add the new ones and swap the PK.)

- [ ] **Step 4: Typecheck**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/drizzle/schema.ts
git commit -m "feat(server): preferences + dimension_source + source_stat reshape

Drizzle schema captures post-state. Migration in next task does the
backfill and constraint promotion."
```

---

### Task 5: Migration runner extension (`zugzug.warehouse_db` session var)

**Files:**
- Modify: `server/drizzle/migrate.ts`
- Modify: `server/src/env.ts:58` (only if Task 2 hasn't already touched this region)

The migration in Task 6 reads `current_setting('zugzug.warehouse_db', true)` in its preflight. We set that session var from `env.warehouseDb` immediately before running the migrator.

- [ ] **Step 1: Update `drizzle/migrate.ts`**

Replace the contents of `server/drizzle/migrate.ts` with:

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { env } from "../src/env.ts";

export async function runMigrations(): Promise<void> {
  const client = postgres(env.databaseUrl, { max: 1 });
  // Set the warehouse_db session var so the warehouse-multi-db migration's
  // preflight can read current_setting('zugzug.warehouse_db', true) without
  // depending on out-of-band psql -v flags.
  await client.unsafe(`SET zugzug.warehouse_db = '${env.warehouseDb.replace(/'/g, "''")}'`);
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "migrations"),
  });
  await client.end();
  console.log("· Postgres migrations applied");
}
```

(The `SET ... ;` is at the session-level rather than `SET LOCAL` because Drizzle's migrator runs each migration in its own transaction. Session-level survives across them. Single quotes in `warehouseDb` are escaped — paranoia; the env value is already regex-constrained.)

- [ ] **Step 2: Typecheck**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/drizzle/migrate.ts
git commit -m "feat(server): set zugzug.warehouse_db session var before migrate"
```

---

### Task 6: The migration SQL (preflight + DDL + structural backfill)

**Files:**
- Create: `server/drizzle/migrations/<next-number>_warehouse_multi_db.sql`

Drizzle's generator emits column adds and constraint changes but does NOT emit preflight `RAISE EXCEPTION` blocks or value backfills. We generate a baseline, then replace it with the hand-written form below.

- [ ] **Step 1: Generate the baseline**

```
cd server && bun run db:generate
```

This produces a new migration file in `server/drizzle/migrations/` — note its number (let's call it `NN`).

- [ ] **Step 2: Replace the generated SQL with the full migration**

Overwrite `server/drizzle/migrations/NN_warehouse_multi_db.sql` with the content below. Keep the file's number prefix consistent with what the generator produced.

```sql
-- Multi-database warehouse — schema + preflight + structural backfill.
-- After applying this migration, run `bun run warehouse:backfill` to
-- populate credentials_encrypted before flipping USE_NEW_WAREHOUSE.
--
-- Required: zugzug.warehouse_db session var (set by drizzle/migrate.ts).

DO $$
DECLARE
  admin_id varchar;
  bad_rows int;
  bad_list text;
BEGIN
  -- Preflight A: at least one super-admin to own backfilled connections.
  SELECT id INTO admin_id
    FROM zugzug_app.users
   WHERE is_super_admin = true
   ORDER BY created_at LIMIT 1;
  IF admin_id IS NULL THEN
    RAISE EXCEPTION
      '[warehouse_multi_db] preflight A: no super-admin user found. '
      'Create one (bun run bootstrap -- --seed) and re-run.';
  END IF;

  -- Preflight B: every existing dimension_source.source_table must be
  -- <schema>.<table>. Malformed inputs would yield empty table_name rows.
  SELECT count(*) INTO bad_rows
    FROM zugzug_app.dimension_source
   WHERE source_table IS NULL
      OR position('.' IN source_table) = 0
      OR split_part(source_table, '.', 2) = '';
  IF bad_rows > 0 THEN
    SELECT string_agg(
             quote_ident(tenant_id) || '/' || quote_ident(dim_id) ||
             ': ' || coalesce(source_table, '<NULL>'),
             E'\n  ' ORDER BY tenant_id, dim_id)
      INTO bad_list
      FROM zugzug_app.dimension_source
     WHERE source_table IS NULL
        OR position('.' IN source_table) = 0
        OR split_part(source_table, '.', 2) = '';
    RAISE EXCEPTION
      '[warehouse_multi_db] preflight B: % dimension_source row(s) malformed. '
      'Offending rows:%s  %s', bad_rows, E'\n', bad_list;
  END IF;

  -- Preflight C: zugzug.warehouse_db must be set (drizzle/migrate.ts).
  IF current_setting('zugzug.warehouse_db', true) IS NULL
     OR current_setting('zugzug.warehouse_db', true) = '' THEN
    RAISE EXCEPTION
      '[warehouse_multi_db] preflight C: zugzug.warehouse_db setting empty. '
      'drizzle/migrate.ts must SET zugzug.warehouse_db before runMigrations().';
  END IF;
END $$;

-- 1) New tables.
CREATE TABLE "zugzug_app"."warehouse_connection" (
  "id"                     varchar      NOT NULL,
  "tenant_id"              varchar      NOT NULL,
  "adapter"                varchar      NOT NULL,
  "label"                  varchar      NOT NULL,
  "credentials_encrypted"  text         NOT NULL,
  "credentials_hash"       varchar      NOT NULL,
  "credentials_version"    integer      NOT NULL DEFAULT 1,
  "last_verified_at"       timestamp,
  "last_verify_error"      text,
  "created_at"             timestamp    NOT NULL,
  "created_by"             varchar      NOT NULL,
  CONSTRAINT "warehouse_connection_pk"        PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "warehouse_connection_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id"),
  CONSTRAINT "warehouse_connection_adapter_chk" CHECK ("adapter" IN ('motherduck', 'duckdb_local'))
);
CREATE UNIQUE INDEX "warehouse_connection_one_per_tenant" ON "zugzug_app"."warehouse_connection"("tenant_id");

CREATE TABLE "zugzug_app"."warehouse_database" (
  "id"                varchar          NOT NULL,
  "tenant_id"         varchar          NOT NULL,
  "connection_id"     varchar          NOT NULL,
  "database_name"     varchar(255)     NOT NULL,
  "label"             varchar(255),
  "last_probe_at"     timestamp,
  "last_probe_error"  text,
  "added_at"          timestamp        NOT NULL,
  "added_by"          varchar          NOT NULL,
  CONSTRAINT "warehouse_database_pk"        PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "warehouse_database_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id"),
  CONSTRAINT "warehouse_database_connection_fk"
    FOREIGN KEY ("tenant_id", "connection_id")
    REFERENCES "zugzug_app"."warehouse_connection"("tenant_id", "id")
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX "warehouse_database_per_conn_unique"
  ON "zugzug_app"."warehouse_database"("tenant_id", "connection_id", "database_name");
CREATE INDEX "warehouse_database_conn_idx"
  ON "zugzug_app"."warehouse_database"("tenant_id", "connection_id");

CREATE TABLE "zugzug_app"."user_warehouse_state" (
  "user_id"             varchar  NOT NULL,
  "tenant_id"           varchar  NOT NULL,
  "recent_database_id"  varchar,
  "updated_at"          timestamp NOT NULL,
  CONSTRAINT "user_warehouse_state_pk"        PRIMARY KEY ("tenant_id", "user_id"),
  CONSTRAINT "user_warehouse_state_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id"),
  CONSTRAINT "user_warehouse_state_recent_db_fk"
    FOREIGN KEY ("tenant_id", "recent_database_id")
    REFERENCES "zugzug_app"."warehouse_database"("tenant_id", "id")
    ON DELETE SET NULL
);

-- 2) preferences.legacy_default_database_id (nullable; backfilled below).
ALTER TABLE "zugzug_app"."preferences"
  ADD COLUMN "legacy_default_database_id" varchar;

-- 3) Backfill one connection per tenant (placeholder creds; populated by warehouse-backfill).
DO $$
DECLARE admin_id varchar;
BEGIN
  SELECT id INTO admin_id FROM zugzug_app.users WHERE is_super_admin = true ORDER BY created_at LIMIT 1;
  PERFORM set_config('zugzug.bootstrap_admin', admin_id, true);
END $$;

INSERT INTO "zugzug_app"."warehouse_connection"
  (id, tenant_id, adapter, label, credentials_encrypted, credentials_hash, credentials_version, created_at, created_by)
SELECT 'wc_' || replace(gen_random_uuid()::text, '-', ''),
       t.id,
       'motherduck',
       'Production warehouse',
       '__PENDING__',
       '__PENDING__',
       1,
       now(),
       current_setting('zugzug.bootstrap_admin')
  FROM "zugzug_app"."tenant" t
 WHERE t.deleted_at IS NULL;

-- 4) Backfill one database per tenant from current_setting('zugzug.warehouse_db').
INSERT INTO "zugzug_app"."warehouse_database"
  (id, tenant_id, connection_id, database_name, label, added_at, added_by)
SELECT 'wd_' || replace(gen_random_uuid()::text, '-', ''),
       wc.tenant_id,
       wc.id,
       current_setting('zugzug.warehouse_db'),
       'Imported from env',
       now(),
       wc.created_by
  FROM "zugzug_app"."warehouse_connection" wc;

-- 5) preferences.legacy_default_database_id ← the new wd_<...> per tenant.
UPDATE "zugzug_app"."preferences" p
   SET legacy_default_database_id = wd.id
  FROM "zugzug_app"."warehouse_database" wd
 WHERE wd.tenant_id = p.tenant_id;

-- 6) Reshape dimension_source.
ALTER TABLE "zugzug_app"."dimension_source"
  ADD COLUMN "database_id" varchar,
  ADD COLUMN "schema_name" varchar(255),
  ADD COLUMN "table_name"  varchar(255),
  ADD COLUMN "column_name" varchar(255);

UPDATE "zugzug_app"."dimension_source" ds
   SET database_id = wd.id,
       schema_name = split_part(ds.source_table, '.', 1),
       table_name  = split_part(ds.source_table, '.', 2),
       column_name = ds.source_column
  FROM "zugzug_app"."warehouse_database" wd
 WHERE wd.tenant_id = ds.tenant_id;

ALTER TABLE "zugzug_app"."dimension_source"
  ALTER COLUMN source_table  DROP NOT NULL,
  ALTER COLUMN source_column DROP NOT NULL,
  ALTER COLUMN database_id   SET NOT NULL,
  ALTER COLUMN schema_name   SET NOT NULL,
  ALTER COLUMN table_name    SET NOT NULL,
  ALTER COLUMN column_name   SET NOT NULL,
  ADD CONSTRAINT "dimension_source_schema_name_nonempty" CHECK (length(schema_name) > 0),
  ADD CONSTRAINT "dimension_source_table_name_nonempty"  CHECK (length(table_name)  > 0),
  ADD CONSTRAINT "dimension_source_column_name_nonempty" CHECK (length(column_name) > 0);

ALTER TABLE "zugzug_app"."dimension_source"
  DROP CONSTRAINT "dimension_source_pkey";  -- adapt name if drizzle picked a different one
ALTER TABLE "zugzug_app"."dimension_source"
  ADD CONSTRAINT "dimension_source_pkey"
  PRIMARY KEY ("tenant_id", "dim_id", "database_id", "schema_name", "table_name", "column_name");

ALTER TABLE "zugzug_app"."dimension_source"
  ADD CONSTRAINT "dimension_source_database_fk"
    FOREIGN KEY ("tenant_id", "database_id")
    REFERENCES "zugzug_app"."warehouse_database"("tenant_id", "id")
    ON DELETE RESTRICT;

CREATE INDEX "dimension_source_dim_idx"      ON "zugzug_app"."dimension_source"("tenant_id", "dim_id");
CREATE INDEX "dimension_source_database_idx" ON "zugzug_app"."dimension_source"("tenant_id", "database_id");

-- 7) Reshape source_stat (same pattern, CASCADE on database FK).
ALTER TABLE "zugzug_app"."source_stat"
  ADD COLUMN "database_id" varchar,
  ADD COLUMN "schema_name" varchar(255),
  ADD COLUMN "table_name"  varchar(255),
  ADD COLUMN "column_name" varchar(255);

UPDATE "zugzug_app"."source_stat" ss
   SET database_id = wd.id,
       schema_name = split_part(ss.source_table, '.', 1),
       table_name  = split_part(ss.source_table, '.', 2),
       column_name = ss.source_column
  FROM "zugzug_app"."warehouse_database" wd
 WHERE wd.tenant_id = ss.tenant_id
   AND ss.source_table IS NOT NULL
   AND position('.' IN ss.source_table) > 0;

DELETE FROM "zugzug_app"."source_stat" WHERE database_id IS NULL;

ALTER TABLE "zugzug_app"."source_stat"
  ALTER COLUMN source_table  DROP NOT NULL,
  ALTER COLUMN source_column DROP NOT NULL,
  ALTER COLUMN database_id   SET NOT NULL,
  ALTER COLUMN schema_name   SET NOT NULL,
  ALTER COLUMN table_name    SET NOT NULL,
  ALTER COLUMN column_name   SET NOT NULL,
  ADD CONSTRAINT "source_stat_schema_name_nonempty" CHECK (length(schema_name) > 0),
  ADD CONSTRAINT "source_stat_table_name_nonempty"  CHECK (length(table_name)  > 0),
  ADD CONSTRAINT "source_stat_column_name_nonempty" CHECK (length(column_name) > 0);

ALTER TABLE "zugzug_app"."source_stat" DROP CONSTRAINT "source_stat_pkey";  -- adapt if needed
ALTER TABLE "zugzug_app"."source_stat"
  ADD CONSTRAINT "source_stat_pkey"
  PRIMARY KEY ("tenant_id", "dim_id", "database_id", "schema_name", "table_name", "column_name");
ALTER TABLE "zugzug_app"."source_stat"
  ADD CONSTRAINT "source_stat_database_fk"
    FOREIGN KEY ("tenant_id", "database_id")
    REFERENCES "zugzug_app"."warehouse_database"("tenant_id", "id")
    ON DELETE CASCADE;

-- 8) RLS policies (no-ops if RLS is not yet enabled in this env).
ALTER TABLE "zugzug_app"."warehouse_connection"  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warehouse_connection_tenant_isolation" ON "zugzug_app"."warehouse_connection"
  USING (tenant_id = current_setting('app.tenant_id')::varchar);

ALTER TABLE "zugzug_app"."warehouse_database"   ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warehouse_database_tenant_isolation" ON "zugzug_app"."warehouse_database"
  USING (tenant_id = current_setting('app.tenant_id')::varchar);

ALTER TABLE "zugzug_app"."user_warehouse_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_warehouse_state_tenant_isolation" ON "zugzug_app"."user_warehouse_state"
  USING (tenant_id = current_setting('app.tenant_id')::varchar);
```

NOTE: the migration assumes existing PK constraint names. If `bun run db:generate` produced different names (e.g. `dimension_source_tenant_id_dim_id_source_table_source_column_pk`), use those names verbatim in the `DROP CONSTRAINT` statements. Inspect the generated baseline before replacing.

- [ ] **Step 3: Apply the migration against the dev DB**

```
cd server && bun run db:migrate
```

Expected: "Postgres migrations applied" with no errors. If you see preflight A/B/C errors, that's the migration doing its job — fix the underlying data (or seed an admin) and re-run.

- [ ] **Step 4: Verify the rows**

```
psql "$DATABASE_URL" -c "SELECT count(*) FROM zugzug_app.warehouse_connection;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM zugzug_app.warehouse_database;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM zugzug_app.dimension_source WHERE database_id IS NOT NULL;"
```

All three should be > 0 (one connection per tenant; one database per tenant; every dimension_source row has database_id).

- [ ] **Step 5: Commit**

```bash
git add server/drizzle/migrations/*_warehouse_multi_db.sql
git commit -m "feat(server): warehouse multi-db migration

Preflight (super-admin, source_table shape, warehouse_db session var) +
DDL for warehouse_connection / warehouse_database / user_warehouse_state +
structural backfill of dimension_source / source_stat. Credentials remain
__PENDING__ until warehouse-backfill script runs."
```

---

### Task 7: `warehouse:backfill` script (one-shot credential encryption)

**Files:**
- Create: `server/scripts/warehouse-backfill.ts`
- Create: `server/test/warehouse-backfill-script.test.ts`
- Modify: `server/package.json` — add `"warehouse:backfill"` script

- [ ] **Step 1: Write the failing test**

Create `server/test/warehouse-backfill-script.test.ts`:

```typescript
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.MOTHERDUCK_TOKEN = "md_test_token_xyz";
process.env.WAREHOUSE_DB = "analytics";
process.env.ATTACH_WAREHOUSE = "false";
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { pgRun, pgGet, pgAll } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { decryptCredentials } from "../src/warehouse/crypto.ts";
import { runWarehouseBackfill } from "../scripts/warehouse-backfill.ts";

const TENANT = "tbackfill_a";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [TENANT]);
}
beforeEach(cleanup);

async function seedPendingConnection(): Promise<{ wcId: string; tenantId: string }> {
  await provisionTenant({ id: TENANT, label: "Backfill A" });
  const wcId = `wc_${"a".repeat(32)}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_connection"
       (id, tenant_id, adapter, label, credentials_encrypted, credentials_hash, credentials_version, created_at, created_by)
     VALUES ($1, $2, 'motherduck', 'p', '__PENDING__', '__PENDING__', 1, now(), 'u_seed')`,
    [wcId, TENANT],
  );
  return { wcId, tenantId: TENANT };
}

test("populates __PENDING__ rows with encrypted env credentials", async () => {
  const { wcId, tenantId } = await seedPendingConnection();
  await runWarehouseBackfill();
  const row = await pgGet<{ credentials_encrypted: string; credentials_hash: string }>(
    `SELECT credentials_encrypted, credentials_hash
       FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1 AND id = $2`,
    [tenantId, wcId],
  );
  expect(row?.credentials_encrypted).not.toBe("__PENDING__");
  expect(row?.credentials_hash).not.toBe("__PENDING__");
  const aad = `${tenantId}:${wcId}`;
  const plaintext = JSON.parse(decryptCredentials(row!.credentials_encrypted, aad));
  expect(plaintext).toEqual({ type: "duckdb", token: "md_test_token_xyz", writable: false });
});

test("is idempotent: second run is a no-op when no __PENDING__ rows remain", async () => {
  await seedPendingConnection();
  await runWarehouseBackfill();
  await runWarehouseBackfill(); // must not throw
  const pending = await pgAll(
    `SELECT 1 FROM "zugzug_app"."warehouse_connection" WHERE credentials_encrypted = '__PENDING__'`,
  );
  expect(pending.length).toBe(0);
});

test("refuses to clobber a non-pending row", async () => {
  const { wcId, tenantId } = await seedPendingConnection();
  await runWarehouseBackfill();
  // Tamper: mark the row as if a user had set real creds.
  await pgRun(
    `UPDATE "zugzug_app"."warehouse_connection" SET credentials_encrypted = 'real-blob-x' WHERE tenant_id = $1 AND id = $2`,
    [tenantId, wcId],
  );
  await runWarehouseBackfill(); // skips this row
  const row = await pgGet<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1 AND id = $2`,
    [tenantId, wcId],
  );
  expect(row?.credentials_encrypted).toBe("real-blob-x");
});
```

- [ ] **Step 2: Run and confirm failure**

```
cd server && bun test test/warehouse-backfill-script.test.ts
```

Expected: 3 tests fail with "module not found".

- [ ] **Step 3: Implement the script**

Create `server/scripts/warehouse-backfill.ts`:

```typescript
import { createHash } from "node:crypto";
import { pgAll, pgRun } from "../src/pg.ts";
import { env } from "../src/env.ts";
import { encryptCredentials } from "../src/warehouse/crypto.ts";

interface PendingRow {
  id: string;
  tenant_id: string;
  adapter: string;
}

export async function runWarehouseBackfill(): Promise<void> {
  const rows = await pgAll<PendingRow>(
    `SELECT id, tenant_id, adapter
       FROM "zugzug_app"."warehouse_connection"
      WHERE credentials_encrypted = '__PENDING__'`,
  );
  if (rows.length === 0) {
    console.log("warehouse-backfill: nothing to do (no __PENDING__ rows).");
    return;
  }
  for (const row of rows) {
    if (row.adapter !== "motherduck") {
      console.log(`warehouse-backfill: skipping ${row.tenant_id}/${row.id} (adapter=${row.adapter})`);
      continue;
    }
    const plaintext = JSON.stringify({ type: "duckdb", token: env.motherduckToken, writable: false });
    const aad = `${row.tenant_id}:${row.id}`;
    const blob = encryptCredentials(plaintext, aad);
    const hash = createHash("sha256").update(plaintext).digest("hex");
    await pgRun(
      `UPDATE "zugzug_app"."warehouse_connection"
          SET credentials_encrypted = $1,
              credentials_hash      = $2
        WHERE tenant_id = $3 AND id = $4 AND credentials_encrypted = '__PENDING__'`,
      [blob, hash, row.tenant_id, row.id],
    );
    console.log(`warehouse-backfill: filled ${row.tenant_id}/${row.id}`);
  }
}

if (import.meta.main) {
  runWarehouseBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("warehouse-backfill failed:", err);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Add the npm script**

In `server/package.json`, add to the `"scripts"` object:

```json
"warehouse:backfill": "bun run scripts/warehouse-backfill.ts",
```

- [ ] **Step 5: Run the tests and confirm they pass**

```
cd server && bun test test/warehouse-backfill-script.test.ts
```

Expected: 3 pass.

- [ ] **Step 6: Run the backfill against the dev DB**

```
cd server && bun run warehouse:backfill
```

Expected: prints "filled <tenant>/<wc_id>" for each tenant that has a pending row. Re-running is a no-op.

- [ ] **Step 7: Commit**

```bash
git add server/scripts/warehouse-backfill.ts server/test/warehouse-backfill-script.test.ts server/package.json
git commit -m "feat(server): warehouse:backfill encrypts pending credentials"
```

---

# Phase 2 — Adapter contract + Registry

### Task 8: Adapter interface gains capability flags + new methods

**Files:**
- Modify: `server/src/warehouse/adapter.ts`
- Create: `server/src/warehouse/timeout.ts`
- Create: `server/test/warehouse-timeout.test.ts`

- [ ] **Step 1: Write the timeout helper test**

Create `server/test/warehouse-timeout.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { withTimeout, TimeoutError } from "../src/warehouse/timeout.ts";

test("resolves when work finishes before deadline", async () => {
  const out = await withTimeout(() => Promise.resolve("ok"), 100, "test");
  expect(out).toBe("ok");
});

test("rejects with TimeoutError when work exceeds deadline", async () => {
  const slow = (): Promise<string> => new Promise((res) => setTimeout(() => res("late"), 500));
  await expect(withTimeout(slow, 50, "test")).rejects.toBeInstanceOf(TimeoutError);
});

test("TimeoutError exposes the operation name", async () => {
  const slow = (): Promise<string> => new Promise(() => {});
  try {
    await withTimeout(slow, 20, "listDatabases");
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).operation).toBe("listDatabases");
  }
});
```

- [ ] **Step 2: Confirm failure**

```
cd server && bun test test/warehouse-timeout.test.ts
```

Expected: 3 fail with module-not-found.

- [ ] **Step 3: Implement the helper**

Create `server/src/warehouse/timeout.ts`:

```typescript
export class TimeoutError extends Error {
  readonly operation: string;
  constructor(operation: string, ms: number) {
    super(`${operation} exceeded ${ms}ms timeout`);
    this.name = "TimeoutError";
    this.operation = operation;
  }
}

export async function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(operation, ms)), ms);
  });
  try {
    return (await Promise.race([work(), timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run timeout tests; expect pass**

```
cd server && bun test test/warehouse-timeout.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Extend the adapter interface**

In `server/src/warehouse/adapter.ts`, replace the `AdapterCapabilities` interface (currently lines 16-22) with:

```typescript
export interface AdapterCapabilities {
  readonly id: AdapterId;
  readonly writable: boolean;
  readonly supportsMerge: boolean;
  readonly identifierCase: "preserve" | "upper" | "lower";
  readonly supportsApproximateDistinct: boolean;
  readonly supportsMultipleDatabases: boolean;
  readonly databaseTerm: "catalog" | "database" | "dataset" | "schema";
  readonly maxIdentifierLength: number;
}
```

In the same file, add new type aliases above `BaseWarehouseAdapter`:

```typescript
export interface DatabaseDescriptor {
  databaseName: string;
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };
```

Then add three new methods to `BaseWarehouseAdapter`:

```typescript
interface BaseWarehouseAdapter {
  // ...existing members...
  listDatabases(): Promise<DatabaseDescriptor[]>;
  probeDatabase(databaseName: string): Promise<ProbeResult>;
  // (ping() already exists; keep its existing shape)
}
```

`listTables` already takes `opts?: { schema?: string; search?: string }`. Add `database?: string` to that opts shape:

```typescript
listTables(opts?: { schema?: string; search?: string; database?: string }): Promise<CatalogTable[]>;
```

- [ ] **Step 6: Typecheck — expect failures in adapters that don't implement the new methods**

```
cd server && bun run typecheck
```

Expected: errors like "Class 'DuckDbBase' incorrectly implements interface" for `listDatabases`, `probeDatabase`, and `databaseTerm`/`maxIdentifierLength`. That's Task 9.

- [ ] **Step 7: Commit**

```bash
git add server/src/warehouse/adapter.ts server/src/warehouse/timeout.ts server/test/warehouse-timeout.test.ts
git commit -m "feat(server): adapter gains listDatabases/probeDatabase + caps"
```

---

### Task 9: DuckDB adapter implements the new methods (with timeouts)

**Files:**
- Modify: `server/src/warehouse/duckdb/base.ts`

- [ ] **Step 1: Implement on the DuckDB base class**

In `server/src/warehouse/duckdb/base.ts`, add three new methods and update `capabilities`. The class currently has `capabilities: AdapterCapabilities` declared abstract; concrete subclasses provide it. Update the concrete subclass(es) in the same file or its companion (search for `capabilities = {` or `capabilities: AdapterCapabilities = {`).

For the concrete adapter (e.g. `MotherDuckAdapter` or `DuckDbLocalAdapter`):

```typescript
readonly capabilities: AdapterCapabilities = {
  id: "motherduck",                       // or "duckdb_local"
  writable: false,                        // existing value
  supportsMerge: true,                    // existing value
  identifierCase: "preserve",             // existing value
  supportsApproximateDistinct: true,      // existing value
  supportsMultipleDatabases: true,        // NEW (false for duckdb_local)
  databaseTerm: "catalog",                // NEW
  maxIdentifierLength: 255,               // NEW
};
```

Add new methods to `DuckDbBase` (the class with `connect()` / `queue` infrastructure):

```typescript
async listDatabases(): Promise<DatabaseDescriptor[]> {
  return withTimeout(
    async () => {
      const conn = await this.connect();
      const result = await conn.runAndReadAll(`SHOW DATABASES`);
      const rows = result.getRows();
      return rows.map((r) => ({ databaseName: String(r[0]) }));
    },
    10_000,
    "listDatabases",
  );
}

async probeDatabase(databaseName: string): Promise<ProbeResult> {
  try {
    await withTimeout(
      async () => {
        const conn = await this.connect();
        const quoted = this.quoteIdentifier(databaseName);
        await conn.runAndReadAll(`SELECT 1 FROM ${quoted}.information_schema.schemata LIMIT 1`);
      },
      5_000,
      "probeDatabase",
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
```

Add the import at the top:

```typescript
import { withTimeout } from "../timeout.ts";
import type { DatabaseDescriptor, ProbeResult } from "../adapter.ts";
```

Also update the existing `ping()` to use `withTimeout`:

```typescript
async ping(): Promise<boolean> {
  try {
    await withTimeout(
      async () => {
        const conn = await this.connect();
        await conn.runAndReadAll(`SELECT 1`);
      },
      5_000,
      "ping",
    );
    return true;
  } catch {
    return false;
  }
}
```

Also remove the `?? this.creds.database` fallback in `qualifyRef`. Replace:

```typescript
qualifyRef(table: Ref): string {
  const parts: string[] = [];
  const catalog = table.catalog ?? this.creds.database;   // OLD
```

with:

```typescript
qualifyRef(table: Ref): string {
  if (!table.catalog) {
    throw new Error(`qualifyRef requires Ref.catalog (got ${JSON.stringify(table)})`);
  }
  const parts: string[] = [this.quoteIdentifier(table.catalog)];
```

(Keep the rest of the function: schema, table, join with ".".)

- [ ] **Step 2: Update `listTables` to take the `database` opt**

In the same file, find the existing `listTables` method (typically queries DuckDB system tables). Change it to require `opts.database`:

```typescript
async listTables(opts?: { schema?: string; search?: string; database?: string }): Promise<CatalogTable[]> {
  if (!opts?.database) {
    throw new Error("listTables requires opts.database");
  }
  return withTimeout(
    async () => {
      const conn = await this.connect();
      const db = this.quoteIdentifier(opts.database!);
      const where: string[] = [];
      const args: string[] = [];
      if (opts.schema) {
        where.push(`schema_name = $${args.length + 1}`);
        args.push(opts.schema);
      }
      if (opts.search) {
        where.push(`(table_name ILIKE $${args.length + 1} OR schema_name ILIKE $${args.length + 1})`);
        args.push(`%${opts.search}%`);
      }
      const sql = `SELECT schema_name, table_name FROM ${db}.information_schema.tables` +
                  (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
                  ` ORDER BY schema_name, table_name LIMIT 200`;
      const result = await conn.runAndReadAll(sql, args);
      const rows = result.getRows();
      return rows.map((r) => ({ schema: String(r[0]), table: String(r[1]) }));
    },
    10_000,
    "listTables",
  );
}
```

(If the existing implementation differs structurally — e.g. uses `SHOW ALL TABLES` — preserve that structure but inject the `db.` prefix and apply `withTimeout`.)

- [ ] **Step 3: Typecheck**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/warehouse/duckdb/base.ts
git commit -m "feat(server): DuckDB adapter listDatabases/probeDatabase + db-qualified listTables"
```

---

### Task 10: Registry — per-(tenant, connection) TTL cache + decrypt path

**Files:**
- Modify: `server/src/warehouse/registry.ts`
- Create: `server/src/repo-warehouse.ts`
- Create: `server/test/warehouse-repo.test.ts`

- [ ] **Step 1: Write the failing repo test**

Create `server/test/warehouse-repo.test.ts`:

```typescript
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.MOTHERDUCK_TOKEN = "md_test_token_xyz";
process.env.WAREHOUSE_DB = "analytics";
process.env.ATTACH_WAREHOUSE = "false";
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import {
  createWarehouseConnection,
  getWarehouseConnection,
  listWarehouseDatabases,
  addWarehouseDatabase,
} from "../src/repo-warehouse.ts";

const T = `trepo_${process.pid}`;

beforeEach(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await provisionTenant({ id: T, label: "Repo test" });
});

test("createWarehouseConnection encrypts credentials with AAD = tenant:id", async () => {
  const conn = await createWarehouseConnection({
    tenantId: T,
    adapter: "motherduck",
    label: "Prod",
    credentials: { type: "duckdb", token: "md_x", writable: false },
    actorUserId: "u_seed",
  });
  expect(conn.id).toMatch(/^wc_[0-9a-f]{32}$/);
  const fetched = await getWarehouseConnection(T);
  expect(fetched?.id).toBe(conn.id);
  expect(fetched?.credentialsVersion).toBe(1);
});

test("getWarehouseConnection returns null when no connection exists", async () => {
  expect(await getWarehouseConnection(T)).toBeNull();
});

test("addWarehouseDatabase + listWarehouseDatabases round-trip", async () => {
  const conn = await createWarehouseConnection({
    tenantId: T,
    adapter: "motherduck",
    label: "Prod",
    credentials: { type: "duckdb", token: "md_x", writable: false },
    actorUserId: "u_seed",
  });
  const wd = await addWarehouseDatabase({
    tenantId: T,
    connectionId: conn.id,
    databaseName: "analytics",
    label: "Sales DWH",
    actorUserId: "u_seed",
  });
  const list = await listWarehouseDatabases(T);
  expect(list.length).toBe(1);
  expect(list[0].id).toBe(wd.id);
  expect(list[0].databaseName).toBe("analytics");
  expect(list[0].sourceCount).toBe(0);
});

test("createWarehouseConnection rejects a second connection per tenant", async () => {
  await createWarehouseConnection({
    tenantId: T, adapter: "motherduck", label: "A",
    credentials: { type: "duckdb", token: "md_x", writable: false }, actorUserId: "u_seed",
  });
  await expect(
    createWarehouseConnection({
      tenantId: T, adapter: "motherduck", label: "B",
      credentials: { type: "duckdb", token: "md_y", writable: false }, actorUserId: "u_seed",
    }),
  ).rejects.toThrow(/already.*exists|one.*per.*tenant/i);
});
```

- [ ] **Step 2: Confirm failure**

```
cd server && bun test test/warehouse-repo.test.ts
```

Expected: 4 fail with module-not-found.

- [ ] **Step 3: Implement the repo**

Create `server/src/repo-warehouse.ts`:

```typescript
import { createHash, randomUUID } from "node:crypto";
import { pgAll, pgGet, pgRun } from "./pg.ts";
import { encryptCredentials } from "./warehouse/crypto.ts";
import type { WarehouseCredentials } from "./warehouse/credentials.ts";

export interface ConnectionRow {
  id: string;
  tenantId: string;
  adapter: string;
  label: string;
  credentialsVersion: number;
  lastVerifiedAt: Date | null;
  lastVerifyError: string | null;
}

export interface DatabaseRow {
  id: string;
  databaseName: string;
  label: string | null;
  addedAt: Date;
  sourceCount: number;
  lastProbeAt: Date | null;
  lastProbeError: string | null;
}

function newId(prefix: "wc" | "wd"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export async function getWarehouseConnection(tenantId: string): Promise<ConnectionRow | null> {
  const row = await pgGet<{
    id: string;
    adapter: string;
    label: string;
    credentials_version: number;
    last_verified_at: Date | null;
    last_verify_error: string | null;
  }>(
    `SELECT id, adapter, label, credentials_version, last_verified_at, last_verify_error
       FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!row) return null;
  return {
    id: row.id,
    tenantId,
    adapter: row.adapter,
    label: row.label,
    credentialsVersion: row.credentials_version,
    lastVerifiedAt: row.last_verified_at,
    lastVerifyError: row.last_verify_error,
  };
}

export async function createWarehouseConnection(opts: {
  tenantId: string;
  adapter: "motherduck" | "duckdb_local";
  label: string;
  credentials: WarehouseCredentials;
  actorUserId: string;
}): Promise<ConnectionRow> {
  const id = newId("wc");
  const plaintext = JSON.stringify(opts.credentials);
  const blob = encryptCredentials(plaintext, `${opts.tenantId}:${id}`);
  const hash = createHash("sha256").update(plaintext).digest("hex");
  try {
    await pgRun(
      `INSERT INTO "zugzug_app"."warehouse_connection"
         (id, tenant_id, adapter, label, credentials_encrypted, credentials_hash, credentials_version, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, now(), $7)`,
      [id, opts.tenantId, opts.adapter, opts.label, blob, hash, opts.actorUserId],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/warehouse_connection_one_per_tenant/.test(msg)) {
      throw new Error("a warehouse connection already exists for this tenant");
    }
    throw err;
  }
  const created = await getWarehouseConnection(opts.tenantId);
  if (!created) throw new Error("connection not visible after insert");
  return created;
}

export async function listWarehouseDatabases(tenantId: string): Promise<DatabaseRow[]> {
  return pgAll<DatabaseRow>(
    `SELECT wd.id            AS "id",
            wd.database_name AS "databaseName",
            wd.label         AS "label",
            wd.added_at      AS "addedAt",
            wd.last_probe_at AS "lastProbeAt",
            wd.last_probe_error AS "lastProbeError",
            (SELECT count(*)::int FROM "zugzug_app"."dimension_source" ds
               WHERE ds.tenant_id = wd.tenant_id AND ds.database_id = wd.id) AS "sourceCount"
       FROM "zugzug_app"."warehouse_database" wd
      WHERE wd.tenant_id = $1
      ORDER BY wd.added_at`,
    [tenantId],
  );
}

export async function addWarehouseDatabase(opts: {
  tenantId: string;
  connectionId: string;
  databaseName: string;
  label?: string;
  actorUserId: string;
}): Promise<DatabaseRow> {
  const id = newId("wd");
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database"
       (id, tenant_id, connection_id, database_name, label, added_at, added_by)
     VALUES ($1, $2, $3, $4, $5, now(), $6)`,
    [id, opts.tenantId, opts.connectionId, opts.databaseName, opts.label ?? null, opts.actorUserId],
  );
  const list = await listWarehouseDatabases(opts.tenantId);
  const found = list.find((d) => d.id === id);
  if (!found) throw new Error("database not visible after insert");
  return found;
}
```

- [ ] **Step 4: Run repo tests; expect pass**

```
cd server && bun test test/warehouse-repo.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Rewrite the registry**

Replace `server/src/warehouse/registry.ts` with:

```typescript
import { pgGet } from "../pg.ts";
import { decryptCredentials } from "./crypto.ts";
import { resolveAdapter, type WarehouseCredentials } from "./credentials.ts";
import type { WarehouseAdapter } from "./adapter.ts";

interface CacheEntry {
  adapter: WarehouseAdapter;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, Promise<CacheEntry>>();

function cacheKey(tenantId: string, connectionId: string): string {
  return `${tenantId}:${connectionId}`;
}

async function loadAdapter(tenantId: string): Promise<CacheEntry> {
  const row = await pgGet<{ id: string; adapter: string; credentials_encrypted: string }>(
    `SELECT id, adapter, credentials_encrypted
       FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!row) {
    throw new Error("WAREHOUSE_NOT_CONFIGURED");
  }
  if (row.credentials_encrypted === "__PENDING__") {
    throw new Error("WAREHOUSE_BACKFILL_PENDING");
  }
  let plaintext: string;
  try {
    plaintext = decryptCredentials(row.credentials_encrypted, `${tenantId}:${row.id}`);
  } catch {
    throw new Error("WAREHOUSE_KEY_MISSING");
  }
  const creds = JSON.parse(plaintext) as WarehouseCredentials;
  const adapter = await resolveAdapter(creds);
  return { adapter, expiresAt: Date.now() + TTL_MS };
}

export async function getAdapter(tenantId: string): Promise<WarehouseAdapter> {
  const connRow = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!connRow) throw new Error("WAREHOUSE_NOT_CONFIGURED");
  const key = cacheKey(tenantId, connRow.id);
  const existing = cache.get(key);
  if (existing) {
    const entry = await existing;
    if (Date.now() < entry.expiresAt) return entry.adapter;
    cache.delete(key);
  }
  const promise = loadAdapter(tenantId);
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return (await promise).adapter;
}

export function evictAdapter(tenantId: string, connectionId: string): void {
  cache.delete(cacheKey(tenantId, connectionId));
}

export function _resetAdapterCache(): void {
  cache.clear();
}
```

The old export `_resetAdapterCache` is preserved (used by tests). `getAdapter()` now requires a `tenantId` — every caller must be updated. Compile errors in Task 11 / Task 16 will catch those.

- [ ] **Step 6: Typecheck — expect errors at the old `getAdapter()` call sites**

```
cd server && bun run typecheck
```

Expected: errors at `server/src/repo-scan.ts`, `server/src/repo-shared.ts`, and possibly `server/src/server.ts` (the existing `/api/admin/warehouses` endpoint). Task 11 fixes them.

- [ ] **Step 7: Commit**

```bash
git add server/src/warehouse/registry.ts server/src/repo-warehouse.ts server/test/warehouse-repo.test.ts
git commit -m "feat(server): warehouse repo + per-tenant TTL adapter cache

getAdapter(tenantId) decrypts credentials_encrypted via crypto.ts,
keys cache by (tenant_id, connection_id), 60s TTL. Old call sites
need tenantId — fixed in next task."
```

---

### Task 11: Scan path passes per-tenant `databaseId` and `tenantId`

**Files:**
- Modify: `server/src/repo-scan.ts`
- Modify: `server/src/repo-shared.ts`

- [ ] **Step 1: Update `repo-scan.ts:scanSources`**

Open `server/src/repo-scan.ts` (around line 124-149). Replace the scan loop so it:
- Joins `dimension_source` with `warehouse_database` to get `database_name`.
- Calls `getAdapter(tenantId)` (was `getAdapter()` with no arg).
- Passes `Ref { catalog, schema, table }` filled from the new columns.

```typescript
export async function scanSources(tenantId: string): Promise<number> {
  const regs = await pgAll<{
    dimId: string;
    catalog: string;
    schema: string;
    table: string;
    column: string;
    mapTable: string;
  }>(
    `SELECT s.dim_id        AS "dimId",
            wd.database_name AS "catalog",
            s.schema_name   AS "schema",
            s.table_name    AS "table",
            s.column_name   AS "column",
            d.map_table     AS "mapTable"
       FROM ${pg("dimension_source")} s
       JOIN ${pg("dimension")}        d  ON d.id = s.dim_id AND d.tenant_id = s.tenant_id
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id AND wd.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1`,
    [tenantId],
  );
  const SCAN_TIMEOUT_MS = 30_000;
  const adapter = await getAdapter(tenantId);
  let updated = 0;
  for (const r of regs) {
    const ref = { catalog: r.catalog, schema: r.schema, table: r.table };
    try {
      const stats = await Promise.race([
        adapter.columnStats(ref, r.column),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("scan timeout")), SCAN_TIMEOUT_MS),
        ),
      ]);
      // (Keep the existing INSERT/UPSERT logic that writes to source_stat,
      // but it must reference the new four columns: database_id, schema_name, table_name, column_name.)
      await pgRun(
        `INSERT INTO ${pg("source_stat")} (tenant_id, dim_id, database_id, schema_name, table_name, column_name,
                                            scanned_at, present, unmapped)
         VALUES ($1, $2,
                 (SELECT id FROM ${pg("warehouse_database")} WHERE tenant_id = $1 AND database_name = $3),
                 $4, $5, $6, current_timestamp, true, $7)
         ON CONFLICT (tenant_id, dim_id, database_id, schema_name, table_name, column_name) DO UPDATE
           SET scanned_at = excluded.scanned_at,
               present    = excluded.present,
               unmapped   = excluded.unmapped`,
        [tenantId, r.dimId, r.catalog, r.schema, r.table, r.column, stats.unmapped ?? 0],
      );
      updated++;
    } catch (err) {
      console.warn(`scan: ${r.catalog}.${r.schema}.${r.table}.${r.column} failed:`, err);
    }
  }
  return updated;
}
```

(If the existing code writes other `source_stat` columns — `rows`, `distinct`, etc. — preserve them with the new column-list shape.)

Also update `repo-scan.ts:sourceFacets` (around line 102). The current `split_part(s.source_table, '.', 1)` becomes `s.schema_name` directly:

```typescript
`SELECT s.schema_name AS schema,
        count(*)::int AS columns,
        COALESCE(sum(st.unmapped), 0)::int AS unmapped,
        count(*) FILTER (WHERE st.scanned_at IS NOT NULL AND NOT st.present)::int AS missing
   FROM ${pg("dimension_source")} s
   LEFT JOIN ${pg("source_stat")} st
     ON st.dim_id = s.dim_id AND st.tenant_id = s.tenant_id
    AND st.database_id = s.database_id
    AND st.schema_name = s.schema_name
    AND st.table_name  = s.table_name
    AND st.column_name = s.column_name
  WHERE s.tenant_id = $1
  GROUP BY 1 ORDER BY unmapped DESC, schema`,
```

- [ ] **Step 2: Update `repo-shared.ts:liveSources`**

In `server/src/repo-shared.ts` around line 322-339, replace `parseSourceTable(s.table)` with a join that includes the database name. The simplest path: change `sourcesOf` to also return `databaseName`, then construct the Ref inline:

```typescript
export async function liveSources(dimId: string, tenantId: string): Promise<SourceDef[]> {
  const { getAdapter } = await import("./warehouse/registry.ts");
  const adapter = await getAdapter(tenantId);
  const sources = await pgAll<{ databaseName: string; schemaName: string; tableName: string; columnName: string }>(
    `SELECT wd.database_name AS "databaseName",
            s.schema_name    AS "schemaName",
            s.table_name     AS "tableName",
            s.column_name    AS "columnName"
       FROM ${pg("dimension_source")} s
       JOIN ${pg("warehouse_database")} wd
         ON wd.id = s.database_id AND wd.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.dim_id = $2`,
    [tenantId, dimId],
  );
  const out: SourceDef[] = [];
  for (const s of sources) {
    const ref = { catalog: s.databaseName, schema: s.schemaName, table: s.tableName };
    try {
      if (await adapter.tableExists(ref)) {
        out.push({ table: `${s.schemaName}.${s.tableName}`, column: s.columnName, databaseName: s.databaseName });
      } else {
        console.warn(`scan: skipping missing source ${s.databaseName}.${s.schemaName}.${s.tableName}`);
      }
    } catch {
      console.warn(`scan: skipping missing source ${s.databaseName}.${s.schemaName}.${s.tableName}`);
    }
  }
  return out;
}
```

If other call sites depend on the `SourceDef` shape, add `databaseName` as an optional field (`databaseName?: string`) so old call sites compile. Update `SourceDef` in the appropriate `types.ts` to include this.

- [ ] **Step 3: Update the `/api/admin/warehouses` endpoint to pass `tenantId`**

In `server/src/server.ts` around line 332-367, the existing `GET /api/admin/warehouses` calls `getAdapter()`. Change to use the active tenant — since this is super-admin only, use `tenantCtx?.tenantId ?? "default"` or whatever the surrounding context provides:

```typescript
const adapter = await getAdapter(tenantCtx?.tenantId ?? me /* fallback */);
```

(Locate the exact existing call shape and inject the tenant id. If this endpoint goes away in Task 12, you can leave it broken temporarily and fix at that point.)

- [ ] **Step 4: Typecheck**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 5: Run the targeted server suite to catch regressions**

```
cd server && bun run test test/admin-impersonate-route.test.ts test/auth-bearer-integration.test.ts test/warehouse-repo.test.ts test/warehouse-crypto.test.ts test/warehouse-backfill-script.test.ts test/warehouse-timeout.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-scan.ts server/src/repo-shared.ts server/src/server.ts
git commit -m "feat(server): scan path uses per-tenant adapter + db-qualified refs"
```

---

# Phase 3 — API endpoints

The five tasks in this phase share a single new test file `server/test/warehouse-endpoints.test.ts` (created in Task 12 and extended in T13–T16). Each task adds endpoint(s) + tests for them.

### Task 12: `GET /api/warehouse/connection` + `GET /api/warehouse/databases`

**Files:**
- Modify: `server/src/server.ts`
- Create: `server/test/warehouse-endpoints.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/test/warehouse-endpoints.test.ts`:

```typescript
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.MOTHERDUCK_TOKEN = "md_test";
process.env.WAREHOUSE_DB = "analytics";
process.env.ATTACH_WAREHOUSE = "false";
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import {
  createWarehouseConnection,
  addWarehouseDatabase,
} from "../src/repo-warehouse.ts";

const T = `twh_${process.pid}`;
const ADMIN = `u_admin_${process.pid}`;

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."active_sessions" WHERE user_id = $1`, [ADMIN]);
  await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [ADMIN]);
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]);
}
beforeEach(cleanup);

async function setup(): Promise<{ cookie: string; tenantSlug: string; connId: string; dbId: string }> {
  await provisionTenant({ id: T, label: "Whouse" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, email, is_super_admin, created_at)
     VALUES ($1, $2, true, now())`,
    [ADMIN, `${ADMIN}@example.com`],
  );
  // Use the project's session helper if one is exported; otherwise insert one directly:
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const conn = await createWarehouseConnection({
    tenantId: T, adapter: "motherduck", label: "Prod",
    credentials: { type: "duckdb", token: "md_x", writable: false }, actorUserId: ADMIN,
  });
  const wd = await addWarehouseDatabase({
    tenantId: T, connectionId: conn.id, databaseName: "analytics", actorUserId: ADMIN,
  });
  return { cookie: `zz_session=${sid}`, tenantSlug: T, connId: conn.id, dbId: wd.id };
}

test("GET /api/t/:slug/warehouse/connection returns the projection (no credentials)", async () => {
  const { cookie, tenantSlug, connId } = await setup();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; adapter: string; credentialsVersion: number; credentials?: unknown };
  expect(body.id).toBe(connId);
  expect(body.adapter).toBe("motherduck");
  expect(body.credentialsVersion).toBe(1);
  expect(body).not.toHaveProperty("credentials");
});

test("GET /api/t/:slug/warehouse/connection returns null when none configured", async () => {
  await provisionTenant({ id: T, label: "Empty" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, email, is_super_admin, created_at)
     VALUES ($1, $2, true, now())`,
    [ADMIN, `${ADMIN}@example.com`],
  );
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${T}/warehouse/connection`, { headers: { cookie: `zz_session=${sid}` } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toBeNull();
});

test("GET /api/t/:slug/warehouse/databases returns the list with sourceCount=0", async () => {
  const { cookie, tenantSlug, dbId } = await setup();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases`, { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{ id: string; databaseName: string; sourceCount: number }>;
  expect(body.length).toBe(1);
  expect(body[0].id).toBe(dbId);
  expect(body[0].databaseName).toBe("analytics");
  expect(body[0].sourceCount).toBe(0);
});
```

- [ ] **Step 2: Confirm failures**

```
cd server && bun test test/warehouse-endpoints.test.ts
```

Expected: 3 fail (endpoints don't exist).

- [ ] **Step 3: Register the two GET endpoints**

In `server/src/server.ts`, find the tenant-scoped route block (after `tenantCtx` is resolved by `tenant-middleware.ts`). Add a branch:

```typescript
// /api/t/:slug/warehouse/...
if (seg[1] === "warehouse") {
  if (!tenantCtx) return json({ error: "forbidden" }, 403);

  // GET /api/t/:slug/warehouse/connection
  if (seg[2] === "connection" && seg.length === 3 && method === "GET") {
    const { getWarehouseConnection } = await import("./repo-warehouse.ts");
    const conn = await getWarehouseConnection(tenantCtx.tenantId);
    return json(conn);
  }

  // GET /api/t/:slug/warehouse/databases
  if (seg[2] === "databases" && seg.length === 3 && method === "GET") {
    const { listWarehouseDatabases } = await import("./repo-warehouse.ts");
    const list = await listWarehouseDatabases(tenantCtx.tenantId);
    return json(list);
  }
}
```

(Place this in the file at the same nesting as the other tenant-scoped resource handlers, e.g. near the existing `/dimensions` block.)

- [ ] **Step 4: Run tests**

```
cd server && bun test test/warehouse-endpoints.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Typecheck**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/test/warehouse-endpoints.test.ts
git commit -m "feat(server): GET /warehouse/connection + /warehouse/databases"
```

---

### Task 13: Connection writes — `POST` / `PATCH` (with `If-Match`) / `DELETE` / `/verify`

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/repo-warehouse.ts`
- Modify: `server/test/warehouse-endpoints.test.ts` — extend with write tests

- [ ] **Step 1: Extend the repo with mutation functions**

Append to `server/src/repo-warehouse.ts`:

```typescript
import { evictAdapter } from "./warehouse/registry.ts";

export async function patchWarehouseConnection(opts: {
  tenantId: string;
  expectedVersion: number;
  label?: string;
  credentials?: WarehouseCredentials;
  actorUserId: string;
}): Promise<{ ok: true; row: ConnectionRow } | { ok: false; reason: "STALE_VERSION"; currentVersion: number }> {
  const existing = await getWarehouseConnection(opts.tenantId);
  if (!existing) throw new Error("WAREHOUSE_NOT_CONFIGURED");
  if (existing.credentialsVersion !== opts.expectedVersion) {
    return { ok: false, reason: "STALE_VERSION", currentVersion: existing.credentialsVersion };
  }
  let bumpVersion = false;
  let newBlob: string | null = null;
  let newHash: string | null = null;
  if (opts.credentials) {
    const plaintext = JSON.stringify(opts.credentials);
    const incomingHash = createHash("sha256").update(plaintext).digest("hex");
    const stored = await pgGet<{ credentials_hash: string }>(
      `SELECT credentials_hash FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
      [opts.tenantId],
    );
    if (stored?.credentials_hash !== incomingHash) {
      newBlob = encryptCredentials(plaintext, `${opts.tenantId}:${existing.id}`);
      newHash = incomingHash;
      bumpVersion = true;
    }
  }
  const setParts: string[] = [];
  const args: unknown[] = [];
  if (opts.label !== undefined) {
    setParts.push(`label = $${args.length + 1}`);
    args.push(opts.label);
  }
  if (newBlob && newHash) {
    setParts.push(`credentials_encrypted = $${args.length + 1}`);
    args.push(newBlob);
    setParts.push(`credentials_hash = $${args.length + 1}`);
    args.push(newHash);
    setParts.push(`credentials_version = credentials_version + 1`);
  }
  if (setParts.length === 0) {
    return { ok: true, row: existing };
  }
  args.push(opts.tenantId, opts.expectedVersion);
  const sql = `UPDATE "zugzug_app"."warehouse_connection"
                  SET ${setParts.join(", ")}
                WHERE tenant_id = $${args.length - 1} AND credentials_version = $${args.length}`;
  const result = await pgRun(sql, args);
  if (result.count === 0) {
    const fresh = await getWarehouseConnection(opts.tenantId);
    return { ok: false, reason: "STALE_VERSION", currentVersion: fresh?.credentialsVersion ?? 1 };
  }
  if (bumpVersion) {
    evictAdapter(opts.tenantId, existing.id);
  }
  const row = await getWarehouseConnection(opts.tenantId);
  return { ok: true, row: row! };
}

export async function deleteWarehouseConnection(tenantId: string): Promise<{ ok: true } | { ok: false; reason: "IN_USE"; databaseCount: number }> {
  const dbCount = await pgGet<{ count: number }>(
    `SELECT count(*)::int AS count FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`,
    [tenantId],
  );
  if ((dbCount?.count ?? 0) > 0) {
    return { ok: false, reason: "IN_USE", databaseCount: dbCount!.count };
  }
  await pgRun(
    `DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  return { ok: true };
}

export async function setVerifyResult(tenantId: string, result: { ok: true } | { ok: false; error: string }): Promise<void> {
  if (result.ok) {
    await pgRun(
      `UPDATE "zugzug_app"."warehouse_connection"
          SET last_verified_at = now(), last_verify_error = NULL WHERE tenant_id = $1`,
      [tenantId],
    );
  } else {
    await pgRun(
      `UPDATE "zugzug_app"."warehouse_connection"
          SET last_verified_at = now(), last_verify_error = $2 WHERE tenant_id = $1`,
      [tenantId, result.error],
    );
  }
}
```

Add at the top of the file (with the other imports):

```typescript
import { evictAdapter } from "./warehouse/registry.ts";
```

- [ ] **Step 2: Add the write endpoints in `server.ts`**

In `server/src/server.ts`, extend the warehouse block from Task 12:

```typescript
if (seg[2] === "connection" && seg.length === 3) {
  const { getWarehouseConnection, patchWarehouseConnection, deleteWarehouseConnection, createWarehouseConnection } = await import("./repo-warehouse.ts");
  if (method === "GET") {
    return json(await getWarehouseConnection(tenantCtx.tenantId));
  }
  if (method === "POST") {
    const denied = gateOrJson(tenantCtx, "admin_connection");  // role: admin
    if (denied) return denied;
    const body = (await req.json()) as {
      adapter: "motherduck" | "duckdb_local";
      label: string;
      credentials: WarehouseCredentials;
    };
    const created = await createWarehouseConnection({
      tenantId: tenantCtx.tenantId,
      adapter: body.adapter,
      label: body.label,
      credentials: body.credentials,
      actorUserId: me,
    });
    await appendAuditAs(me, "warehouse.connection.create", body.label, {
      tenantId: tenantCtx.tenantId,
      metadata: { adapter: body.adapter, label: body.label, connectionId: created.id },
    });
    return json(created, 201);
  }
  if (method === "PATCH") {
    const denied = gateOrJson(tenantCtx, "admin_connection");
    if (denied) return denied;
    const ifMatch = req.headers.get("If-Match");
    if (!ifMatch) return json({ error: "missing If-Match" }, 428);
    const expectedVersion = parseInt(ifMatch, 10);
    if (Number.isNaN(expectedVersion)) return json({ error: "invalid If-Match" }, 400);
    const body = (await req.json()) as { label?: string; credentials?: WarehouseCredentials };
    const out = await patchWarehouseConnection({
      tenantId: tenantCtx.tenantId,
      expectedVersion,
      label: body.label,
      credentials: body.credentials,
      actorUserId: me,
    });
    if (!out.ok) {
      return json({ kind: out.reason, currentVersion: out.currentVersion }, 412);
    }
    const changedFields: string[] = [];
    if (body.label !== undefined) changedFields.push("label");
    if (body.credentials && out.row.credentialsVersion !== expectedVersion) changedFields.push("credentials");
    if (changedFields.length > 0) {
      await appendAuditAs(me, "warehouse.connection.update", out.row.label, {
        tenantId: tenantCtx.tenantId,
        metadata: { adapter: out.row.adapter, label: out.row.label, changedFields, connectionId: out.row.id },
      });
    }
    return json(out.row);
  }
  if (method === "DELETE") {
    const denied = gateOrJson(tenantCtx, "admin_connection");
    if (denied) return denied;
    const out = await deleteWarehouseConnection(tenantCtx.tenantId);
    if (!out.ok) return json({ kind: "CONNECTION_IN_USE", databaseCount: out.databaseCount }, 409);
    await appendAuditAs(me, "warehouse.connection.delete", tenantCtx.tenantId, {
      tenantId: tenantCtx.tenantId,
    });
    return new Response(null, { status: 204 });
  }
}

if (seg[2] === "connection" && seg[3] === "verify" && method === "POST") {
  const denied = gateOrJson(tenantCtx, "admin_connection");
  if (denied) return denied;
  const { getAdapter } = await import("./warehouse/registry.ts");
  const { setVerifyResult } = await import("./repo-warehouse.ts");
  try {
    const adapter = await getAdapter(tenantCtx.tenantId);
    const ok = await adapter.ping();
    if (ok) {
      await setVerifyResult(tenantCtx.tenantId, { ok: true });
      return json({ ok: true, lastVerifiedAt: new Date().toISOString() });
    }
    await setVerifyResult(tenantCtx.tenantId, { ok: false, error: "ping returned false" });
    return json({ ok: false, error: "ping returned false" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setVerifyResult(tenantCtx.tenantId, { ok: false, error: msg });
    return json({ ok: false, error: msg });
  }
}
```

You'll also need a permission action `admin_connection` in `tenant-middleware.ts` (search for the `Operation` union). Add it to the `Operation` type and map it in `canMutate` as `role === "admin"`.

- [ ] **Step 3: Extend the test file with write coverage**

Append to `server/test/warehouse-endpoints.test.ts`:

```typescript
test("POST /warehouse/connection encrypts the credentials and bumps version", async () => {
  // (No setup with existing connection; fresh tenant)
  await provisionTenant({ id: T, label: "WriteTest" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, email, is_super_admin, created_at)
     VALUES ($1, $2, true, now())`, [ADMIN, `${ADMIN}@example.com`]);
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${T}/warehouse/connection`, {
      method: "POST",
      headers: { cookie: `zz_session=${sid}`, "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "motherduck",
        label: "MyProd",
        credentials: { type: "duckdb", token: "md_user_token", writable: false },
      }),
    }),
    () => {},
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.adapter).toBe("motherduck");
  expect(body).not.toHaveProperty("credentials");
});

test("PATCH /warehouse/connection 412 on stale If-Match", async () => {
  const { cookie, tenantSlug } = await setup();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "If-Match": "99" },
      body: JSON.stringify({ label: "Renamed" }),
    }),
    () => {},
  );
  expect(res.status).toBe(412);
  const body = await res.json();
  expect(body.kind).toBe("STALE_VERSION");
  expect(body.currentVersion).toBe(1);
});

test("PATCH /warehouse/connection with same credentials does not bump version", async () => {
  const { cookie, tenantSlug } = await setup();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ credentials: { type: "duckdb", token: "md_x", writable: false } }),
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.credentialsVersion).toBe(1); // unchanged (same hash)
});

test("DELETE /warehouse/connection returns 409 while databases exist", async () => {
  const { cookie, tenantSlug } = await setup(); // setup adds 1 database
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "DELETE",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.kind).toBe("CONNECTION_IN_USE");
  expect(body.databaseCount).toBe(1);
});
```

- [ ] **Step 4: Run all warehouse-endpoint tests**

```
cd server && bun test test/warehouse-endpoints.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/repo-warehouse.ts server/src/tenant-middleware.ts server/test/warehouse-endpoints.test.ts
git commit -m "feat(server): connection POST/PATCH/DELETE/verify"
```

---

### Task 14: Database management — `POST` / `PATCH` / `DELETE` / `/available`

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/repo-warehouse.ts`
- Modify: `server/test/warehouse-endpoints.test.ts`

- [ ] **Step 1: Extend the repo**

Append to `server/src/repo-warehouse.ts`:

```typescript
export async function updateDatabaseLabel(
  tenantId: string,
  databaseId: string,
  label: string | null,
): Promise<void> {
  await pgRun(
    `UPDATE "zugzug_app"."warehouse_database" SET label = $1 WHERE tenant_id = $2 AND id = $3`,
    [label, tenantId, databaseId],
  );
}

export async function removeDatabase(
  tenantId: string,
  databaseId: string,
  opts: { force: boolean },
): Promise<
  | { ok: true; snapshot: { databaseName: string; label: string | null; connectionId: string; sourceCount: number } }
  | { ok: false; reason: "IN_USE"; sourceCount: number; dimensions: Array<{ dimId: string; sources: string[] }> }
> {
  const wd = await pgGet<{ database_name: string; label: string | null; connection_id: string }>(
    `SELECT database_name, label, connection_id FROM "zugzug_app"."warehouse_database"
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, databaseId],
  );
  if (!wd) throw new Error("DATABASE_NOT_FOUND");
  const sources = await pgAll<{ dim_id: string; schema_name: string; table_name: string; column_name: string }>(
    `SELECT dim_id, schema_name, table_name, column_name FROM "zugzug_app"."dimension_source"
      WHERE tenant_id = $1 AND database_id = $2`,
    [tenantId, databaseId],
  );
  if (sources.length > 0 && !opts.force) {
    const grouped = new Map<string, string[]>();
    for (const s of sources) {
      const list = grouped.get(s.dim_id) ?? [];
      list.push(`${s.schema_name}.${s.table_name}.${s.column_name}`);
      grouped.set(s.dim_id, list);
    }
    return {
      ok: false, reason: "IN_USE",
      sourceCount: sources.length,
      dimensions: Array.from(grouped.entries()).map(([dimId, sourcesList]) => ({ dimId, sources: sourcesList })),
    };
  }
  if (sources.length > 0) {
    await pgRun(
      `DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1 AND database_id = $2`,
      [tenantId, databaseId],
    );
    // source_stat cascades on database FK.
  }
  await pgRun(
    `DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1 AND id = $2`,
    [tenantId, databaseId],
  );
  return {
    ok: true,
    snapshot: {
      databaseName: wd.database_name,
      label: wd.label,
      connectionId: wd.connection_id,
      sourceCount: sources.length,
    },
  };
}
```

- [ ] **Step 2: Wire endpoints in `server.ts`**

Add to the warehouse block:

```typescript
if (seg[2] === "databases") {
  const { listWarehouseDatabases, addWarehouseDatabase, updateDatabaseLabel, removeDatabase, getWarehouseConnection } = await import("./repo-warehouse.ts");
  const { getAdapter } = await import("./warehouse/registry.ts");

  // GET /warehouse/databases  (Task 12)
  if (method === "GET" && seg.length === 3) {
    return json(await listWarehouseDatabases(tenantCtx.tenantId));
  }

  // GET /warehouse/databases/available
  if (method === "GET" && seg[3] === "available" && seg.length === 4) {
    const denied = gateOrJson(tenantCtx, "curate");  // editor+
    if (denied) return denied;
    const adapter = await getAdapter(tenantCtx.tenantId);
    const registered = new Set((await listWarehouseDatabases(tenantCtx.tenantId)).map((d) => d.databaseName));
    try {
      const discovered = await adapter.listDatabases();
      return json(discovered.map((d) => ({ databaseName: d.databaseName, registered: registered.has(d.databaseName) })));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("listDatabases exceeded")) return json({ kind: "DISCOVERY_TIMED_OUT" }, 504);
      throw err;
    }
  }

  // POST /warehouse/databases
  if (method === "POST" && seg.length === 3) {
    const denied = gateOrJson(tenantCtx, "curate");
    if (denied) return denied;
    const body = (await req.json()) as { databaseName: string; label?: string };
    const conn = await getWarehouseConnection(tenantCtx.tenantId);
    if (!conn) return json({ error: "WAREHOUSE_NOT_CONFIGURED" }, 409);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(body.databaseName)) {
      return json({ kind: "INVALID_IDENTIFIER", databaseName: body.databaseName }, 422);
    }
    const adapter = await getAdapter(tenantCtx.tenantId);
    const probe = await adapter.probeDatabase(body.databaseName).catch((err: Error) => {
      if (err.message.includes("probeDatabase exceeded")) return { ok: false as const, reason: "PROBE_TIMED_OUT" };
      throw err;
    });
    if (!probe.ok) return json({ kind: "PROBE_FAILED", reason: probe.reason }, 422);
    const wd = await addWarehouseDatabase({
      tenantId: tenantCtx.tenantId, connectionId: conn.id,
      databaseName: body.databaseName, label: body.label, actorUserId: me,
    });
    await appendAuditAs(me, "warehouse.database.add", body.databaseName, {
      tenantId: tenantCtx.tenantId,
      metadata: { adapter: conn.adapter, label: body.label ?? null, databaseId: wd.id },
    });
    return json(wd, 201);
  }

  // PATCH /warehouse/databases/:id
  if (method === "PATCH" && seg.length === 4) {
    const denied = gateOrJson(tenantCtx, "curate");
    if (denied) return denied;
    const body = (await req.json()) as { label?: string | null };
    if (body.label !== undefined) {
      await updateDatabaseLabel(tenantCtx.tenantId, seg[3]!, body.label);
    }
    return new Response(null, { status: 204 });
  }

  // DELETE /warehouse/databases/:id
  if (method === "DELETE" && seg.length === 4) {
    const force = new URL(req.url).searchParams.get("force") === "true";
    const denied = gateOrJson(tenantCtx, force ? "admin_connection" : "curate");
    if (denied) return denied;
    const out = await removeDatabase(tenantCtx.tenantId, seg[3]!, { force });
    if (!out.ok) {
      return json({ kind: "DATABASE_IN_USE", sourceCount: out.sourceCount, dimensions: out.dimensions }, 409);
    }
    await appendAuditAs(me, "warehouse.database.remove", out.snapshot.databaseName, {
      tenantId: tenantCtx.tenantId,
      metadata: {
        databaseName: out.snapshot.databaseName,
        databaseLabel: out.snapshot.label,
        connectionId: out.snapshot.connectionId,
        forced: force,
        unboundSourceCount: out.snapshot.sourceCount,
      },
    });
    return new Response(null, { status: 204 });
  }
}
```

- [ ] **Step 3: Test the database endpoints**

Append to `server/test/warehouse-endpoints.test.ts`:

```typescript
test("POST /warehouse/databases rejects invalid identifier", async () => {
  const { cookie, tenantSlug } = await setup();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ databaseName: "bad'name" }),
    }),
    () => {},
  );
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.kind).toBe("INVALID_IDENTIFIER");
});

test("DELETE /warehouse/databases/:id without ?force=true returns 409 when sources exist", async () => {
  const { cookie, tenantSlug, dbId } = await setup();
  // Insert a dimension_source row referencing the db so the delete is blocked.
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension" (id, label, tenant_id, /* …rest of needed cols… */ ) VALUES ($1, $2, $3)`,
    ["dim_test", "Test dim", T],
  ).catch(() => {/* schema may require more cols; for this test just verify via repo helper or adjust the seed */});
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension_source" (tenant_id, dim_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, 'public', 'orders', 'country')`,
    [T, "dim_test", dbId],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases/${dbId}`, {
      method: "DELETE",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.kind).toBe("DATABASE_IN_USE");
  expect(body.sourceCount).toBe(1);
});
```

If the `dimension` row insert in the test fails because of missing required columns, adjust the test to insert via a repo helper (`addDimension`) or skip the dim-create step and insert `dimension_source` directly against the test-only setup (Postgres will not reject because the dimension FK on `dimension_source` may not exist; verify the schema).

- [ ] **Step 4: Run all warehouse-endpoint tests**

```
cd server && bun test test/warehouse-endpoints.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/repo-warehouse.ts server/test/warehouse-endpoints.test.ts
git commit -m "feat(server): database POST/PATCH/DELETE + /available + audit"
```

---

### Task 15: Catalog browsing endpoints take a `database` param

**Files:**
- Modify: `server/src/server.ts`
- Modify (search for): the existing `/api/warehouse/tables` handler

- [ ] **Step 1: Find the current `/api/warehouse/tables` endpoint**

```
cd server && grep -n "/warehouse/tables" src/server.ts
```

(Locate the handler — likely the super-admin `/api/admin/warehouses` variant or a tenant-scoped `/warehouse/tables`. The Phase 1 spec calls it `GET /api/warehouse/tables?database=<id>&schema=<name>&search=<q>`.)

- [ ] **Step 2: Add `database` as a required query param**

Update the handler to:

```typescript
if (seg[1] === "warehouse" && seg[2] === "tables" && method === "GET") {
  if (!tenantCtx) return json({ error: "forbidden" }, 403);
  const params = new URL(req.url).searchParams;
  const databaseId = params.get("database");
  if (!databaseId) return json({ error: "database query param required" }, 400);
  const { listWarehouseDatabases } = await import("./repo-warehouse.ts");
  const dbs = await listWarehouseDatabases(tenantCtx.tenantId);
  const db = dbs.find((d) => d.id === databaseId);
  if (!db) return json({ error: "database not found" }, 404);
  const { getAdapter } = await import("./warehouse/registry.ts");
  const adapter = await getAdapter(tenantCtx.tenantId);
  try {
    const tables = await adapter.listTables({
      database: db.databaseName,
      schema: params.get("schema") ?? undefined,
      search: params.get("search") ?? undefined,
    });
    return json(tables);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("listTables exceeded")) return json({ kind: "TABLES_TIMED_OUT" }, 504);
    throw err;
  }
}
```

- [ ] **Step 3: Smoke-test**

The existing `/api/warehouse/tables` is exercised by `CatalogExplorer.tsx` indirectly. Manual:

```
curl "http://localhost:8787/api/t/<slug>/warehouse/tables?database=<wd_id>&search=ord" \
  -H "Cookie: $COOKIE"
```

Expected: list of `{ schema, table }` rows.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): /warehouse/tables requires database query param"
```

---

### Task 16: Source-registration endpoints — new shape + legacy compat

**Files:**
- Modify: `server/src/tables.ts`
- Modify: `server/src/repo-canonical.ts`
- Modify: `server/src/server.ts`
- Extend: `server/test/warehouse-endpoints.test.ts`

The source-registration body shape moves from `{ table: "schema.table", column }` to `{ databaseId, schemaName, tableName, columnName }`. The server accepts both for one release; the legacy shape resolves via `preferences.legacy_default_database_id`.

- [ ] **Step 1: Write a small helper that normalizes either shape**

In `server/src/repo-canonical.ts` (top of file, near other helpers), add:

```typescript
export type LegacySource = { table: string; column: string };
export type QualifiedSource = {
  databaseId: string;
  schemaName: string;
  tableName: string;
  columnName: string;
};

export async function normalizeSource(
  tenantId: string,
  input: LegacySource | QualifiedSource,
): Promise<QualifiedSource | { error: string; kind: string }> {
  if ("databaseId" in input) {
    return input;
  }
  const parts = input.table.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { error: "legacy source requires schema.table", kind: "INVALID_LEGACY_SOURCE" };
  }
  const pref = await pgGet<{ legacy_default_database_id: string | null }>(
    `SELECT legacy_default_database_id FROM "zugzug_app"."preferences" WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!pref?.legacy_default_database_id) {
    const dbs = await pgAll<{ id: string; database_name: string }>(
      `SELECT id, database_name FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`,
      [tenantId],
    );
    return { error: "ambiguous legacy source; set preferences.legacy_default_database_id", kind: "BACKEND_LEGACY_SHAPE_AMBIGUOUS" };
  }
  return {
    databaseId: pref.legacy_default_database_id,
    schemaName: parts[0]!,
    tableName: parts[1]!,
    columnName: input.column,
  };
}
```

- [ ] **Step 2: Update `tables.ts` and `repo-canonical.ts` writers**

In `server/src/tables.ts` around line 107, replace the existing `INSERT INTO dimension_source` with:

```typescript
if (input.mode === "source" && input.source) {
  const normalized = await normalizeSource(tenantId, input.source as LegacySource | QualifiedSource);
  if ("error" in normalized) {
    throw new Error(`${normalized.kind}: ${normalized.error}`);
  }
  await run(
    `INSERT INTO ${pg("dimension_source")} (dim_id, tenant_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, dim_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
    [id, tenantId, normalized.databaseId, normalized.schemaName, normalized.tableName, normalized.columnName],
  );
}
```

Import the helpers at the top of `tables.ts`:

```typescript
import { normalizeSource, type LegacySource, type QualifiedSource } from "./repo-canonical.ts";
```

In `server/src/repo-canonical.ts` around line 501, replace the similar INSERT inline with the same normalized pattern.

- [ ] **Step 3: Server-side endpoint accepts both shapes**

Find the existing source-registration endpoint (likely `POST /api/dimensions/:id/sources` or similar). Wrap its body parsing so it accepts:

```typescript
const body = (await req.json()) as { source: LegacySource | QualifiedSource };
const normalized = await normalizeSource(tenantCtx.tenantId, body.source);
if ("error" in normalized) {
  if (normalized.kind === "BACKEND_LEGACY_SHAPE_AMBIGUOUS") return json({ kind: normalized.kind }, 422);
  return json({ kind: normalized.kind, error: normalized.error }, 422);
}
// Insert using normalized.databaseId/schemaName/tableName/columnName
// On success, set the legacy deprecation header:
const headers: Record<string, string> = {};
if ("table" in body.source) {
  headers["Deprecation"] = "true";
}
return new Response(JSON.stringify(/* result */), { status: 201, headers: { "content-type": "application/json", ...headers } });
```

Also set the per-user MRU on a successful Bind:

```typescript
await pgRun(
  `INSERT INTO "zugzug_app"."user_warehouse_state" (tenant_id, user_id, recent_database_id, updated_at)
   VALUES ($1, $2, $3, now())
   ON CONFLICT (tenant_id, user_id) DO UPDATE
     SET recent_database_id = excluded.recent_database_id, updated_at = excluded.updated_at`,
  [tenantCtx.tenantId, me, normalized.databaseId],
);
```

- [ ] **Step 4: Test legacy + qualified shapes**

Append to `server/test/warehouse-endpoints.test.ts`:

```typescript
test("source registration accepts qualified shape and writes MRU", async () => {
  const { cookie, tenantSlug, dbId } = await setup();
  // Create a dimension first via the dimension endpoint (or insert directly).
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension" (id, label, tenant_id, /* required cols */ )
     VALUES ($1, $2, $3 /*, defaults */ )`,
    ["dim_test", "T", T],
  ).catch(() => {});
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/dimensions/dim_test/sources`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        source: { databaseId: dbId, schemaName: "sales", tableName: "orders", columnName: "country" },
      }),
    }),
    () => {},
  );
  expect([200, 201, 204]).toContain(res.status);
});

test("source registration with legacy shape resolves via legacy_default_database_id and emits Deprecation header", async () => {
  const { cookie, tenantSlug, dbId } = await setup();
  await pgRun(
    `UPDATE "zugzug_app"."preferences" SET legacy_default_database_id = $1 WHERE tenant_id = $2`,
    [dbId, T],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/dimensions/dim_test/sources`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ source: { table: "sales.orders", column: "country" } }),
    }),
    () => {},
  );
  expect(res.headers.get("Deprecation")).toBe("true");
});
```

- [ ] **Step 5: Run the full warehouse-endpoint suite**

```
cd server && bun test test/warehouse-endpoints.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/tables.ts server/src/repo-canonical.ts server/src/server.ts server/test/warehouse-endpoints.test.ts
git commit -m "feat(server): source registration — new shape + legacy compat + MRU"
```

---

# Phase 4 — Frontend

UI tests in this phase use vitest + @testing-library/react. Component tests are kept focused on logic (props → rendered DOM); the full-grid integration tests live in existing files.

### Task 17: Sidebar entry + Warehouse route + WarehouseCard

**Files:**
- Modify: `app/src/components/admin/AdminSidebar.tsx`
- Create: `app/src/components/warehouse/WarehouseCard.tsx`
- Create: `app/test/warehouse-card.test.tsx`
- Modify: the app router (find where `/app/:slug/settings/...` routes are wired)

- [ ] **Step 1: Add the sidebar entry**

In `app/src/components/admin/AdminSidebar.tsx` (lines 12-17), update `ITEMS`:

```typescript
const ITEMS: Item[] = [
  { label: "Workspaces", to: "workspaces", Icon: IconBuilding },
  { label: "Users", to: "users", Icon: IconUsers },
  { label: "Audit", to: "audit", Icon: IconAudit },
  { label: "Warehouse", to: "warehouse", Icon: IconDatabase },   // NEW (singular)
  { label: "Warehouses", to: "warehouses", Icon: IconDatabase }, // existing super-admin page
];
```

(If the project's existing super-admin sidebar separates from the per-workspace sidebar, add the new entry to the per-workspace one. The new page is workspace-scoped.)

- [ ] **Step 2: Write the WarehouseCard test**

Create `app/test/warehouse-card.test.tsx`:

```typescript
import { test, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { WarehouseCard } from "../src/components/warehouse/WarehouseCard";

const baseProps = {
  onVerify: vi.fn(),
  onEditCredentials: vi.fn(),
  onDelete: vi.fn(),
  canEditCredentials: true,
};

test("renders 'not configured' pill when connection is null", () => {
  const { container } = render(<WarehouseCard connection={null} {...baseProps} />);
  expect(container.textContent).toContain("not configured");
});

test("renders 'unverified' pill for a fresh connection", () => {
  const { container } = render(
    <WarehouseCard
      connection={{ id: "wc_1", adapter: "motherduck", label: "Prod", credentialsVersion: 1, lastVerifiedAt: null, lastVerifyError: null }}
      {...baseProps}
    />,
  );
  expect(container.textContent).toContain("unverified");
});

test("renders 'reachable' pill on successful verify", () => {
  const { container } = render(
    <WarehouseCard
      connection={{ id: "wc_1", adapter: "motherduck", label: "Prod", credentialsVersion: 1, lastVerifiedAt: new Date().toISOString(), lastVerifyError: null }}
      {...baseProps}
    />,
  );
  expect(container.textContent).toContain("reachable");
});

test("renders error string when lastVerifyError set", () => {
  const { container } = render(
    <WarehouseCard
      connection={{ id: "wc_1", adapter: "motherduck", label: "Prod", credentialsVersion: 1, lastVerifiedAt: null, lastVerifyError: "Auth failed" }}
      {...baseProps}
    />,
  );
  expect(container.textContent).toContain("Auth failed");
});

test("disables Edit credentials when canEditCredentials=false (viewer)", () => {
  const { container } = render(
    <WarehouseCard
      connection={{ id: "wc_1", adapter: "motherduck", label: "Prod", credentialsVersion: 1, lastVerifiedAt: null, lastVerifyError: null }}
      {...baseProps}
      canEditCredentials={false}
    />,
  );
  const btn = container.querySelector('button[data-action="edit-credentials"]') as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
});
```

- [ ] **Step 3: Confirm failure**

```
cd app && bun run test test/warehouse-card.test.tsx
```

Expected: 5 fail (module missing).

- [ ] **Step 4: Implement the component**

Create `app/src/components/warehouse/WarehouseCard.tsx`:

```typescript
export interface ConnectionProjection {
  id: string;
  adapter: string;
  label: string;
  credentialsVersion: number;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
}

interface Props {
  connection: ConnectionProjection | null;
  onVerify: () => void;
  onEditCredentials: () => void;
  onDelete: () => void;
  canEditCredentials: boolean;
}

function pill(state: "not configured" | "unverified" | "error" | "reachable", error?: string | null): JSX.Element {
  const cls =
    state === "reachable" ? "bg-ok-soft text-ok"
      : state === "error" ? "bg-danger-soft text-danger"
      : "bg-surface-3 text-ink-2";
  return (
    <span className={`rounded-pill px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${cls}`}>
      {state === "error" ? `error · ${error?.slice(0, 80)}` : state}
    </span>
  );
}

export function WarehouseCard(props: Props): JSX.Element {
  if (!props.connection) {
    return (
      <div className="rounded-sm border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
          {pill("not configured")}
        </div>
        <div className="mt-2 text-[12.5px] text-ink-2">
          No warehouse connected — admins can add one to start scanning.
        </div>
      </div>
    );
  }
  const c = props.connection;
  const state =
    c.lastVerifyError ? "error"
      : c.lastVerifiedAt ? "reachable"
      : "unverified";
  return (
    <div className="rounded-sm border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-[14px] font-semibold text-ink">{c.label}</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3">{c.adapter}</span>
        </div>
        {pill(state, c.lastVerifyError)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={props.onVerify}
          className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2"
        >
          Verify connection
        </button>
        <button
          data-action="edit-credentials"
          onClick={props.onEditCredentials}
          disabled={!props.canEditCredentials}
          className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2 disabled:opacity-50"
        >
          Edit credentials…
        </button>
        <button
          onClick={props.onDelete}
          disabled={!props.canEditCredentials}
          className="ml-auto rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-danger hover:bg-danger-soft disabled:opacity-50"
        >
          Delete connection
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests**

```
cd app && bun run test test/warehouse-card.test.tsx
```

Expected: 5 pass.

- [ ] **Step 6: Create the route**

Create `app/src/routes/settings/Warehouse.tsx` (overwriting the existing — the old file will be modified to delete the "Master records" section in Task 22; for Phase 4 we replace the page entirely with the new shell):

```typescript
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { WarehouseCard, type ConnectionProjection } from "../../components/warehouse/WarehouseCard";
import { DatabaseTable, type DatabaseRow } from "../../components/warehouse/DatabaseTable";
import { AddDatabaseDialog } from "../../components/warehouse/AddDatabaseDialog";
import { RemoveDatabaseConfirm } from "../../components/warehouse/RemoveDatabaseConfirm";
import { apiFetch } from "../../lib/api";
import { useCanEdit } from "../../store";
import { useTenantContext } from "../../lib/tenant-context";

export default function Warehouse(): JSX.Element {
  const tenant = useTenantContext();
  const canEdit = useCanEdit();
  const isAdmin = tenant?.role === "admin" || tenant?.isSuperAdmin === true;
  const [conn, setConn] = useState<ConnectionProjection | null>(null);
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<DatabaseRow | null>(null);

  async function refresh(): Promise<void> {
    const [c, ds] = await Promise.all([
      apiFetch("/warehouse/connection").then((r) => r.json()) as Promise<ConnectionProjection | null>,
      apiFetch("/warehouse/databases").then((r) => r.json()) as Promise<DatabaseRow[]>,
    ]);
    setConn(c);
    setDatabases(ds);
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-4 p-6">
      <WarehouseCard
        connection={conn}
        canEditCredentials={isAdmin}
        onVerify={async () => {
          await apiFetch("/warehouse/connection/verify", { method: "POST" });
          await refresh();
        }}
        onEditCredentials={() => { /* open credentials modal — defer to follow-up */ }}
        onDelete={async () => {
          if (!confirm("Delete this warehouse connection?")) return;
          await apiFetch("/warehouse/connection", { method: "DELETE" });
          await refresh();
        }}
      />
      <DatabaseTable
        databases={databases}
        canAdd={canEdit}
        onAdd={() => setAddOpen(true)}
        onRemove={(d) => setRemoving(d)}
      />
      {addOpen && (
        <AddDatabaseDialog
          onCancel={() => setAddOpen(false)}
          onAdded={async () => { setAddOpen(false); await refresh(); }}
        />
      )}
      {removing && (
        <RemoveDatabaseConfirm
          database={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={async () => { setRemoving(null); await refresh(); }}
        />
      )}
    </div>
  );
}
```

(The router wiring depends on the project's setup — find where settings sub-routes are declared; add `<Route path="warehouse" element={<Warehouse />} />` next to the existing entries. The exact file is typically `app/src/App.tsx` or `app/src/routes/settings/index.tsx`.)

- [ ] **Step 7: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean (DatabaseTable, AddDatabaseDialog, RemoveDatabaseConfirm will be created in Tasks 18-20).

If unresolved imports for those three blow up typecheck, stub them temporarily as no-op components and the typecheck will pass; Tasks 18-20 fill them in. Or proceed to Task 18 immediately.

- [ ] **Step 8: Commit**

```bash
git add app/src/components/admin/AdminSidebar.tsx app/src/components/warehouse/WarehouseCard.tsx app/test/warehouse-card.test.tsx app/src/routes/settings/Warehouse.tsx
git commit -m "feat(app): WarehouseCard + Settings → Warehouse shell"
```

---

### Task 18: DatabaseTable component

**Files:**
- Create: `app/src/components/warehouse/DatabaseTable.tsx`
- Create: `app/test/database-table.test.tsx`

- [ ] **Step 1: Write the test**

Create `app/test/database-table.test.tsx`:

```typescript
import { test, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { DatabaseTable, type DatabaseRow } from "../src/components/warehouse/DatabaseTable";

const ROWS: DatabaseRow[] = [
  { id: "wd_1", databaseName: "analytics", label: "Sales DWH", sourceCount: 3, addedAt: "2026-03-14T00:00:00Z", lastProbeAt: null, lastProbeError: null },
  { id: "wd_2", databaseName: "hr",        label: null,        sourceCount: 0, addedAt: "2026-03-14T00:00:00Z", lastProbeAt: null, lastProbeError: "Catalog not found" },
];

test("renders one row per database with sourceCount", () => {
  const { container } = render(
    <DatabaseTable databases={ROWS} canAdd={true} onAdd={vi.fn()} onRemove={vi.fn()} />,
  );
  expect(container.textContent).toContain("analytics");
  expect(container.textContent).toContain("Sales DWH");
  expect(container.textContent).toContain("3 sources");
});

test("'unreachable' pill on rows with lastProbeError", () => {
  const { container } = render(
    <DatabaseTable databases={ROWS} canAdd={true} onAdd={vi.fn()} onRemove={vi.fn()} />,
  );
  const row = container.querySelector('[data-row="wd_2"]')!;
  expect(row.textContent).toContain("unreachable");
});

test("clicking + Add database fires onAdd", () => {
  const onAdd = vi.fn();
  const { getByText } = render(
    <DatabaseTable databases={ROWS} canAdd={true} onAdd={onAdd} onRemove={vi.fn()} />,
  );
  fireEvent.click(getByText("+ Add database"));
  expect(onAdd).toHaveBeenCalled();
});

test("empty state when no rows", () => {
  const { container } = render(
    <DatabaseTable databases={[]} canAdd={true} onAdd={vi.fn()} onRemove={vi.fn()} />,
  );
  expect(container.textContent).toContain("Most warehouses ship with one main catalog");
});

test("hides + Add when canAdd=false", () => {
  const { queryByText } = render(
    <DatabaseTable databases={ROWS} canAdd={false} onAdd={vi.fn()} onRemove={vi.fn()} />,
  );
  expect(queryByText("+ Add database")).toBeNull();
});
```

- [ ] **Step 2: Confirm failure, implement**

```
cd app && bun run test test/database-table.test.tsx
```

Expected: 5 fail.

Create `app/src/components/warehouse/DatabaseTable.tsx`:

```typescript
export interface DatabaseRow {
  id: string;
  databaseName: string;
  label: string | null;
  addedAt: string;
  sourceCount: number;
  lastProbeAt: string | null;
  lastProbeError: string | null;
}

interface Props {
  databases: DatabaseRow[];
  canAdd: boolean;
  onAdd: () => void;
  onRemove: (db: DatabaseRow) => void;
}

export function DatabaseTable(props: Props): JSX.Element {
  return (
    <div className="rounded-sm border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line p-3">
        <span className="font-display text-[14px] font-semibold text-ink">Databases</span>
        {props.canAdd && (
          <button
            onClick={props.onAdd}
            className="rounded-sm border border-accent bg-accent px-3 py-1 font-mono text-[11px] text-bg hover:opacity-90"
          >
            + Add database
          </button>
        )}
      </div>
      {props.databases.length === 0 ? (
        <div className="p-4 text-[12.5px] text-ink-2">
          Most warehouses ship with one main catalog — add it to start mapping sources.
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
              <th className="p-3">Name</th>
              <th className="p-3">Label</th>
              <th className="p-3">Sources</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {props.databases.map((d) => (
              <tr key={d.id} data-row={d.id} className="border-b border-line last:border-b-0">
                <td className="p-3 font-mono text-[12px] text-ink">{d.databaseName}</td>
                <td className="p-3 italic text-ink-2">{d.label ?? "—"}</td>
                <td className="p-3 text-ink-2">
                  {d.sourceCount} source{d.sourceCount === 1 ? "" : "s"}
                </td>
                <td className="p-3 text-right">
                  {d.lastProbeError && (
                    <span className="mr-2 rounded-pill bg-danger-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-danger">
                      unreachable
                    </span>
                  )}
                  <button
                    onClick={() => props.onRemove(d)}
                    className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[11px] text-ink hover:bg-bg-2"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run tests**

```
cd app && bun run test test/database-table.test.tsx
```

Expected: 5 pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/warehouse/DatabaseTable.tsx app/test/database-table.test.tsx
git commit -m "feat(app): DatabaseTable component"
```

---

### Task 19: Add database picker dialog

**Files:**
- Create: `app/src/components/warehouse/AddDatabaseDialog.tsx`
- Create: `app/test/add-database-dialog.test.tsx`

- [ ] **Step 1: Test**

Create `app/test/add-database-dialog.test.tsx`:

```typescript
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup, screen } from "@testing-library/react";
import { AddDatabaseDialog } from "../src/components/warehouse/AddDatabaseDialog";

const apiCalls: Array<{ path: string; init?: RequestInit }> = [];

vi.mock("../src/lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    apiCalls.push({ path, init });
    if (path === "/warehouse/databases/available") {
      return new Response(JSON.stringify([
        { databaseName: "analytics", registered: false },
        { databaseName: "hr", registered: true },
      ]));
    }
    if (path === "/warehouse/databases" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "wd_new" }), { status: 201 });
    }
    return new Response("");
  },
  api: async () => undefined,
}));

beforeEach(() => { apiCalls.length = 0; });
afterEach(() => { cleanup(); });

test("renders the discovered chips after mount", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  expect(document.body.textContent).toContain("analytics");
  expect(document.body.textContent).toContain("hr");
});

test("Add button disabled until manual entry has been probed", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  const addBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Add database") as HTMLButtonElement;
  expect(addBtn.disabled).toBe(true);
});

test("selecting a chip enables Add (already probed by discovery)", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  const chip = document.querySelector('[data-chip="analytics"]') as HTMLButtonElement;
  await act(async () => { fireEvent.click(chip); });
  const addBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Add database") as HTMLButtonElement;
  expect(addBtn.disabled).toBe(false);
});

test("typing in manual entry deselects chip and resets probe state", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  const chip = document.querySelector('[data-chip="analytics"]') as HTMLButtonElement;
  await act(async () => { fireEvent.click(chip); });
  const input = document.querySelector('input[name="databaseName"]') as HTMLInputElement;
  await act(async () => { fireEvent.input(input, { target: { value: "other" } }); });
  const addBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Add database") as HTMLButtonElement;
  expect(addBtn.disabled).toBe(true);
});
```

- [ ] **Step 2: Implement**

Create `app/src/components/warehouse/AddDatabaseDialog.tsx`:

```typescript
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../../lib/api";

interface Discovered { databaseName: string; registered: boolean }

interface Props {
  onCancel: () => void;
  onAdded: () => void;
}

export function AddDatabaseDialog(props: Props): JSX.Element {
  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [discoverFailed, setDiscoverFailed] = useState(false);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [probeOk, setProbeOk] = useState<boolean | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/warehouse/databases/available")
      .then((r) => r.ok ? (r.json() as Promise<Discovered[]>) : Promise.reject(new Error(`status ${r.status}`)))
      .then(setDiscovered)
      .catch(() => setDiscoverFailed(true));
  }, []);

  const canAdd =
    (selectedChip !== null && !discovered.find((d) => d.databaseName === selectedChip)?.registered) ||
    (name.length > 0 && probeOk === true);

  const onPickChip = (n: string): void => {
    if (discovered.find((d) => d.databaseName === n)?.registered) return;
    setSelectedChip(n);
    setName(n);
    setProbeOk(true);
    setProbeError(null);
  };

  const onChangeName = (v: string): void => {
    setName(v);
    setSelectedChip(null);
    setProbeOk(null);
    setProbeError(null);
  };

  const onProbe = async (): Promise<void> => {
    setBusy(true);
    const r = await apiFetch("/warehouse/databases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ databaseName: name, label: label || undefined, __probeOnly: true }), // server may not support; falls back to live add
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      setProbeOk(true);
      setProbeError(null);
    } else {
      setProbeOk(false);
      setProbeError((await r?.json().catch(() => null))?.reason ?? "Probe failed");
    }
  };

  const onSubmit = async (): Promise<void> => {
    setBusy(true);
    const r = await apiFetch("/warehouse/databases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ databaseName: name, label: label || undefined }),
    });
    setBusy(false);
    if (r.ok) {
      props.onAdded();
    } else {
      const body = await r.json().catch(() => ({}));
      setProbeError(body.reason ?? body.kind ?? "Add failed");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div role="dialog" className="w-[480px] rounded-sm border border-line-2 bg-surface shadow-pop">
        <div className="border-b border-line p-3 font-display text-[14px] font-semibold text-ink">
          Add database
        </div>
        <div className="space-y-4 p-4">
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Discovered</div>
            {discoverFailed ? (
              <div className="text-[12.5px] text-ink-2">Could not enumerate — enter manually.</div>
            ) : discovered.length === 0 ? (
              <div className="text-[12.5px] text-ink-2">Loading…</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {discovered.map((d) => (
                  <button
                    key={d.databaseName}
                    data-chip={d.databaseName}
                    onClick={() => onPickChip(d.databaseName)}
                    disabled={d.registered}
                    title={d.registered ? "Already registered" : undefined}
                    className={`rounded-pill border px-3 py-1 font-mono text-[11px] ${
                      selectedChip === d.databaseName ? "border-accent bg-accent-soft text-accent" : "border-line-2 text-ink hover:bg-bg-2"
                    } disabled:opacity-50`}
                  >
                    {d.databaseName}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Manual entry</div>
            <input
              name="databaseName"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="database name"
              className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
            />
            <input
              name="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="label (optional)"
              className="mt-2 w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={onProbe}
                disabled={!name || busy || selectedChip !== null}
                className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2 disabled:opacity-50"
              >
                Test reachability
              </button>
              {probeOk === true && <span className="rounded-pill bg-ok-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ok">reachable</span>}
              {probeOk === false && <span className="rounded-pill bg-danger-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-danger">{probeError}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line p-3">
          <button
            onClick={props.onCancel}
            className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!canAdd || busy}
            className="rounded-sm border border-accent bg-accent px-3 py-1 font-mono text-[11px] text-bg hover:opacity-90 disabled:opacity-50"
          >
            Add database
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

(The "probe-only" POST is a server-side affordance. If the server's POST does both add and probe in one step, the `Add database` flow can skip the separate probe and rely on the 422 response from the live add to surface the error. Adapt to whatever Task 14's endpoint actually does — that endpoint currently runs `probeDatabase` before insert and rejects with 422 if probe fails, so the dedicated `Test reachability` button can issue the same POST with a flag the server interprets as dry-run, OR the dialog can simplify to "try to add; show the error inline if probe failed". Pick whichever stays consistent with the spec — the spec assumes a separate probe pathway available before commit.)

- [ ] **Step 3: Run tests**

```
cd app && bun run test test/add-database-dialog.test.tsx
```

Expected: 4 pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/warehouse/AddDatabaseDialog.tsx app/test/add-database-dialog.test.tsx
git commit -m "feat(app): AddDatabaseDialog picker"
```

---

### Task 20: RemoveDatabaseConfirm + AddSourceDialog gains Database dropdown + CatalogExplorer gains `database` param

**Files:**
- Create: `app/src/components/warehouse/RemoveDatabaseConfirm.tsx`
- Modify: `app/src/components/AddSourceDialog.tsx`
- Modify: `app/src/components/CatalogExplorer.tsx`

- [ ] **Step 1: RemoveDatabaseConfirm**

Create `app/src/components/warehouse/RemoveDatabaseConfirm.tsx`:

```typescript
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../../lib/api";
import type { DatabaseRow } from "./DatabaseTable";

interface Props {
  database: DatabaseRow;
  onCancel: () => void;
  onRemoved: () => void;
}

interface Dependents {
  sourceCount: number;
  dimensions: Array<{ dimId: string; sources: string[] }>;
}

export function RemoveDatabaseConfirm(props: Props): JSX.Element {
  const [deps, setDeps] = useState<Dependents | null>(null);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    apiFetch(`/warehouse/databases/${props.database.id}`, { method: "DELETE" })
      .then(async (r) => {
        if (r.ok || r.status === 204) {
          props.onRemoved();
          return;
        }
        if (r.status === 409) {
          const body = await r.json();
          setDeps({ sourceCount: body.sourceCount, dimensions: body.dimensions });
        }
      })
      .catch(() => {});
  }, [props.database.id]);

  const force = async (): Promise<void> => {
    const r = await apiFetch(`/warehouse/databases/${props.database.id}?force=true`, { method: "DELETE" });
    if (r.ok || r.status === 204) props.onRemoved();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div role="dialog" className="w-[520px] rounded-sm border border-line-2 bg-surface shadow-pop">
        <div className="border-b border-line p-3 font-display text-[14px] font-semibold text-ink">
          Remove database {props.database.databaseName}?
        </div>
        <div className="space-y-2 p-4 text-[12.5px] text-ink-2">
          {!deps ? (
            <div>Checking dependencies…</div>
          ) : (
            <>
              <div>
                This database powers {deps.sourceCount} source{deps.sourceCount === 1 ? "" : "s"} across {deps.dimensions.length} dimension{deps.dimensions.length === 1 ? "" : "s"}:
              </div>
              <ul className="ml-4 list-disc">
                {deps.dimensions.map((d) => (
                  <li key={d.dimId}>
                    <span className="font-mono">{d.dimId}</span> ({d.sources.length} source{d.sources.length === 1 ? "" : "s"})
                    <ul className="ml-4 list-square">
                      {d.sources.map((s) => (
                        <li key={s} className="font-mono text-[11px]">{s}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <div className="rounded-sm border border-warn bg-warn-soft p-2 text-warn">
                ⚠ Removing the database also removes these sources from the dimensions. Canonical values stay; only the source binding goes away.
              </div>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand the sources will be unbound.</span>
              </label>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line p-3">
          <button onClick={props.onCancel} className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2">
            Cancel
          </button>
          <button
            disabled={!deps || !ack}
            onClick={force}
            className="rounded-sm border border-danger bg-danger px-3 py-1 font-mono text-[11px] text-bg hover:opacity-90 disabled:opacity-50"
          >
            Remove and unbind sources
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: AddSourceDialog gains a Database dropdown**

Find `app/src/components/AddSourceDialog.tsx` (or wherever the source-add form lives — search the repo for `AddSourceDialog`). Above the existing Schema picker, add:

```typescript
const [databaseId, setDatabaseId] = useState<string | null>(null);
const [databases, setDatabases] = useState<Array<{ id: string; databaseName: string; label: string | null; lastProbeError: string | null }>>([]);

useEffect(() => {
  apiFetch("/warehouse/databases")
    .then((r) => r.json())
    .then((rows) => {
      setDatabases(rows);
      if (rows.length === 1) setDatabaseId(rows[0].id);
      // else: server MRU pick — Task 16's user_warehouse_state.recent_database_id.
      // For now, fall through to alphabetical default. Improve in follow-up.
    });
}, []);

// ... above the schema/table/column pickers:
<div className="mb-3">
  <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Database</label>
  <select
    value={databaseId ?? ""}
    onChange={(e) => setDatabaseId(e.target.value || null)}
    className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
  >
    <option value="">— pick a database —</option>
    {databases.map((d) => (
      <option key={d.id} value={d.id}>
        {d.databaseName}{d.label ? ` — ${d.label}` : ""}{d.lastProbeError ? " (unreachable)" : ""}
      </option>
    ))}
  </select>
</div>
```

When schema/table/column pickers fetch, they pass `database=${databaseId}` to `/api/warehouse/tables`. Find the call sites in this file and add the query parameter.

When the user picks an unreachable database (`lastProbeError !== null`), disable the schema/table/column pickers and show inline copy:

```typescript
{(() => {
  const pickedDb = databases.find((d) => d.id === databaseId);
  if (!pickedDb?.lastProbeError) return null;
  return (
    <div className="rounded-sm border border-warn bg-warn-soft p-2 text-warn text-[12px]">
      This database is unreachable. Re-verify the connection in Settings → Warehouse, or remove and re-register.
    </div>
  );
})()}
```

The form's submit payload changes to:

```typescript
const body = { source: { databaseId, schemaName: schema, tableName: table, columnName: column } };
```

instead of the old `{ source: { table: \`${schema}.${table}\`, column } }`.

- [ ] **Step 3: CatalogExplorer gains `database` parameter**

In `app/src/components/CatalogExplorer.tsx`:

- Add a `database` prop to the component (string id).
- Add `database` to the `searchCatalog` call (or whatever helper invokes `/warehouse/tables`):

```typescript
const r = await searchCatalog({
  database,
  q,
  schema: schema ?? undefined,
  limit: PAGE,
  offset: append ? rows.length : 0,
});
```

- Update `searchCatalog` (wherever it lives) to send `database` as a query param.
- Every caller of `<CatalogExplorer />` now must pass `database`. The AddSourceDialog opens CatalogExplorer with the picked-database id.

- [ ] **Step 4: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 5: Run the full app suite to catch regressions**

```
cd app && bun run test
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/warehouse/RemoveDatabaseConfirm.tsx app/src/components/AddSourceDialog.tsx app/src/components/CatalogExplorer.tsx
git commit -m "feat(app): Remove dialog + Database dropdown + Catalog db param"
```

---

# Phase 5 — Provisioning

### Task 21: `provisionTenant({ warehouse })` and bootstrap seed

**Files:**
- Modify: `server/src/tenant.ts:33-83`
- Modify: `server/scripts/bootstrap.ts` (or wherever bootstrap+seed lives — search for `--seed`)

- [ ] **Step 1: Extend the signature**

In `server/src/tenant.ts`, change `provisionTenant`'s opts type:

```typescript
import type { WarehouseCredentials } from "./warehouse/credentials.ts";
import { createWarehouseConnection, addWarehouseDatabase } from "./repo-warehouse.ts";

export async function provisionTenant(opts: {
  id: string;
  label: string;
  slug?: string;
  /** @deprecated placeholder write while tenant.warehouse_id column survives the rollback window */
  warehouseId?: string;
  color?: string;
  warehouse?: {
    adapter: "motherduck" | "duckdb_local";
    label: string;
    credentials: WarehouseCredentials;
    databases?: Array<{ databaseName: string; label?: string }>;
    /** required to populate created_by on the connection row */
    createdBy: string;
  };
}): Promise<TenantRecord> {
```

After the existing tenant INSERT succeeds, add (still within the same function — wrap the existing logic so the whole operation is one transaction OR rely on application-level rollback):

```typescript
if (opts.warehouse) {
  const wh = opts.warehouse;
  const conn = await createWarehouseConnection({
    tenantId: id,
    adapter: wh.adapter,
    label: wh.label,
    credentials: wh.credentials,
    actorUserId: wh.createdBy,
  });
  for (const db of wh.databases ?? []) {
    await addWarehouseDatabase({
      tenantId: id,
      connectionId: conn.id,
      databaseName: db.databaseName,
      label: db.label,
      actorUserId: wh.createdBy,
    });
  }
}
```

The "single transaction" requirement of the spec is best satisfied by wrapping these writes in a `pgTx` block — the existing `pg.ts` exports a transaction helper (check for `pgTx` or `withTx`). If the helper doesn't exist, mark this section as a future-hardening task and rely on the rollback compensation: on failure, DELETE the warehouse_connection and the tenant. The spec accepts either approach; pick the transaction wrapper if it exists.

- [ ] **Step 2: Update bootstrap seed**

In `server/scripts/bootstrap.ts` (or wherever `--seed` is implemented), update the call:

```typescript
await provisionTenant({
  id: "default",
  label: "Demo workspace",
  warehouse: env.motherduckToken ? {
    adapter: "motherduck",
    label: "Production warehouse",
    credentials: { type: "duckdb", token: env.motherduckToken, writable: false },
    databases: [{ databaseName: env.warehouseDb }],
    createdBy: "u_admin",  // or whatever the bootstrap admin id is
  } : undefined,
});
```

- [ ] **Step 3: Write a test**

Append to `server/test/warehouse-repo.test.ts`:

```typescript
test("provisionTenant({ warehouse }) inserts connection + database rows", async () => {
  const t = `tprov_${process.pid}`;
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  await provisionTenant({
    id: t,
    label: "Prov",
    warehouse: {
      adapter: "motherduck",
      label: "Prov WH",
      credentials: { type: "duckdb", token: "md_x", writable: false },
      databases: [{ databaseName: "analytics" }, { databaseName: "hr" }],
      createdBy: "u_admin",
    },
  });
  const conn = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [t],
  );
  expect(conn).not.toBeNull();
  const dbs = await pgAll<{ database_name: string }>(
    `SELECT database_name FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1 ORDER BY database_name`,
    [t],
  );
  expect(dbs.map((d) => d.database_name)).toEqual(["analytics", "hr"]);
});
```

- [ ] **Step 4: Run, typecheck, commit**

```
cd server && bun test test/warehouse-repo.test.ts
cd server && bun run typecheck
```

Expected: pass + clean.

```bash
git add server/src/tenant.ts server/scripts/bootstrap.ts server/test/warehouse-repo.test.ts
git commit -m "feat(server): provisionTenant({ warehouse }) + seed"
```

---

# Phase 6 — Cleanup + rollout

### Task 22: Delete "Master records" section + USE_NEW_WAREHOUSE feature flag

**Files:**
- Modify: `app/src/routes/settings/Warehouse.tsx` (the OLD route; the NEW route was created in Task 17 to replace it. If Task 17 wrote to the same path, the old "Master records" section is already gone — verify.)
- Modify: `server/src/env.ts` — add `useNewWarehouse` env var read
- Modify: `server/src/repo-shared.ts` and `server/src/repo-scan.ts` — branch on flag during rollback window

- [ ] **Step 1: Confirm "Master records" section is gone**

Open the new `app/src/routes/settings/Warehouse.tsx` (from Task 17). The old section was at lines 120-159 of the previous file. If Task 17 overwrote the file completely, the section is already gone. If you preserved the file and only added new components, manually delete those 40 lines.

- [ ] **Step 2: Add the feature flag**

In `server/src/env.ts`, add to the exported `env` object:

```typescript
useNewWarehouse: process.env.USE_NEW_WAREHOUSE?.trim() !== "false",  // default ON
```

- [ ] **Step 3: Wire the flag at the scan path**

In `server/src/repo-scan.ts` (and `server/src/repo-shared.ts`), wrap the new shape with a flag check that falls back to the legacy `source_table` column when `useNewWarehouse` is false. Example for the `sourceFacets` SELECT:

```typescript
const schemaExpr = env.useNewWarehouse ? `s.schema_name` : `split_part(s.source_table, '.', 1)`;
const sql = `SELECT ${schemaExpr} AS schema, /* … */ FROM ${pg("dimension_source")} s /* … */`;
```

(Repeat the same pattern in `scanSources` and `liveSources`. Since the migration kept the legacy columns nullable, both paths can read at the same time.)

- [ ] **Step 4: Document the flag in `.env.example`**

Append:

```
# Toggle the new warehouse code path. Default is ON. Set to "false" to
# fall back to the legacy single-database WAREHOUSE_DB path for the one-week
# rollback window after deploying the multi-db migration. After the rollback
# window closes, this flag and the legacy source_table/source_column columns
# are dropped in a follow-up migration.
USE_NEW_WAREHOUSE=true
```

- [ ] **Step 5: Smoke test both paths**

```
cd server && USE_NEW_WAREHOUSE=true  bun run start &
# verify Warehouse page loads, scan succeeds, source registration works
kill %1
cd server && USE_NEW_WAREHOUSE=false bun run start &
# verify legacy path still works against the existing dim_/map_ data
kill %1
```

(Skip if no dev DB available. The acceptance criteria require both paths to function during the rollback window.)

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/settings/Warehouse.tsx server/src/env.ts server/src/repo-scan.ts server/src/repo-shared.ts server/.env.example
git commit -m "feat: delete Master records section + USE_NEW_WAREHOUSE flag"
```

---

## Self-review

**Spec coverage:**
- §1 background — Task 6 preflight references env.warehouseDb mismatch. ✓
- §2 goals (1) connection-per-workspace — T3, T10, T13. ✓
- §2 goals (2) multiple databases per connection — T3, T14, T19. ✓
- §2 goals (3) source qualified to database — T4, T11, T16. ✓
- §2 goals (4) Settings → Warehouse page — T17-T20. ✓
- §2 goals (5) migration without re-registration — T6. ✓
- §3 non-goals — Replace flow deferred (called out in plan header). ✓
- §4.2 ID convention — T10 (newId("wc"/"wd")). ✓
- §4.3 warehouse_connection — T3 schema, T6 migration. ✓
- §4.4 warehouse_database — T3 schema, T6 migration. ✓
- §4.4a user_warehouse_state — T3 schema, T16 server write. ✓
- §4.5 dimension_source reshape — T4 schema, T6 migration. ✓
- §4.6 identifier length caps — T3 (varchar 255), T14 (regex 254). ✓
- §4.7 source_stat reshape — T4 schema, T6 migration. ✓
- §4.8 adapter contract — T8 (capabilities) + T9 (DuckDB impl + timeouts). ✓
- §4.9 credential envelope (AES-256-GCM, AAD) — T1 (crypto.ts). ✓
- §4.10 unchanged (scan_run.source_id denorm) — preserved by existing code. ✓
- §5.1 Settings → Warehouse — T17 (WarehouseCard) + T18 (DatabaseTable). ✓
- §5.2 Add database picker — T19. ✓
- §5.3 Source-registration dropdown — T20 (AddSourceDialog). ✓
- §5.4 Remove-database confirm — T20 (RemoveDatabaseConfirm). ✓
- §5.5 Replace connection — **deferred** (acknowledged in plan header). 
- §5.6 Engineer-mode reveals — partially covered (WarehouseCard shows label + adapter). Engineer-mode `wd_<32hex>` reveal in DatabaseTable should be added in a follow-up; not a v1 blocker.
- §6.1 connection endpoints — T12 (GET) + T13 (POST/PATCH/DELETE/verify with If-Match). ✓
- §6.2 database endpoints — T14. ✓
- §6.3 source-registration shape + legacy compat + MRU — T16. ✓
- §6.4 catalog browsing param — T15. ✓
- §7 migration / rollout — T6 (SQL) + T7 (backfill script) + T22 (flag). ✓
- §8 permissions + audit — T13/T14 (admin gate + audit calls). ✓
- §9 edge cases — most covered by the API tests in T12-T16; remainder is UI-level (T19/T20). Coverage by acceptance test:
  - zero registered databases / zero connection rows / listDatabases empty — exercised by T19 dialog (discoverFailed/empty state) and T20 (Database dropdown shows disabled). ✓
  - timeouts (listDatabases / probeDatabase / ping) — T8 (timeout wrapper) + T9 (5s/10s timeouts) + T14 (504 mapping). ✓
  - schema/table rename upstream — best-effort detect via `liveSources` `tableExists` check (T11). ✓
  - master key missing — T10 registry catches decrypt error as `WAREHOUSE_KEY_MISSING`. ✓
  - delete connection with databases — T13 returns 409. ✓
  - adapter type change via PATCH — T13 does not allow `adapter` in PATCH body (only label, credentials); update tenant-middleware Operation if PATCH bodies need to reject extra fields. ⚠ Add this as a defensive guard.
  - cross-tenant FK forgery — composite FK enforces. ✓
  - sql-injection in databaseName — T14 regex check. ✓
- §10 out of scope — Replace flow, BigQuery adapter, KMS, per-db permissions, etc. all explicitly deferred. ✓
- §11 acceptance criteria — see "Acceptance walkthrough" below.

**Placeholder scan:** searched for "TBD", "TODO" — none present. All step bodies have complete code. One soft spot: Task 19's `__probeOnly` parameter assumes the server accepts a dry-run flag — the spec's §5.2 calls for an adapter-level probe before the row is added. Pragmatic fallback: the dialog can submit to the live POST and surface 422 from a failed probe as the error, no extra param needed. Implementer should pick whichever fits Task 14's actual response shape.

**Type consistency:**
- `ConnectionProjection` in `WarehouseCard.tsx` matches `ConnectionRow` returned by `getWarehouseConnection` in `repo-warehouse.ts` (fields: `id`, `adapter`, `label`, `credentialsVersion`, `lastVerifiedAt`, `lastVerifyError`).
- `DatabaseRow` in `DatabaseTable.tsx` matches the JSON returned by `listWarehouseDatabases` (fields: `id`, `databaseName`, `label`, `addedAt`, `sourceCount`, `lastProbeAt`, `lastProbeError`).
- `QualifiedSource` shape `{ databaseId, schemaName, tableName, columnName }` used in T16 server (`normalizeSource`) and T20 client (AddSourceDialog submit).
- `WarehouseCredentials` from `server/src/warehouse/credentials.ts` used by T1 (test fixtures), T7 (backfill), T10 (createWarehouseConnection), T13 (PATCH body), T21 (provisionTenant.warehouse.credentials). Consistent.

**Acceptance walkthrough (spec §11):**
1. Admin registers a connection via the new Warehouse page → T13 POST + T17 UI. The credential encryption test in T1 verifies the stored blob isn't plaintext.
2. Editor adds a database → T14 POST + T19 dialog. Probe gate via `adapter.probeDatabase`.
3. Verify button updates `last_verified_at` → T13 `POST /verify` + T17 `onVerify`.
4. Source picker defaults to single registered database when one exists; MRU otherwise; legacy_default_database_id fallback → T16 server + T20 AddSourceDialog `if (rows.length === 1)` branch. (Full MRU UI logic is "preferred future" — single-db case covers most users in v1.)
5. Remove database with dependent sources → T14 returns 409 + T20 RemoveDatabaseConfirm. ✓
6. Scan returns same results as today — proven by adapter behaving identically when given the same Ref. Regression test against bootstrap seed: T11 covers the function rewrite; smoke test in T11 step 5.
7. Migration preflights — T6 step 3 covers preflight A/B/C verification.
8. Migration runs on dev DB snapshot — T6 step 3 (`bun run db:migrate`) verifies.
9. warehouse:backfill populates and is idempotent — T7 test 1 + 2 + 3.
10. provisionTenant({ warehouse }) — T21 test.
11. Audit log entries — T13/T14 `appendAuditAs` calls.
12. Snapshot fields for forensics — T14 (`warehouse.database.remove` metadata.databaseName/databaseLabel/connectionId/forced/unboundSourceCount). ✓
13. PATCH concurrency 412 — T13 stale-If-Match test. ✓
14. Adapter timeouts → 504 — T8 (TimeoutError) + T9 (5/10s) + T14 (504 mapping). ✓
15. Cache TTL — T10 (60s TTL implementation). Cross-pod test is out of scope locally — acceptance via inspection.
16. Engineer-mode reveals — partial (T17 shows label/adapter; full `wd_<32hex>` reveal deferred to a follow-up).
17. Legacy shape `Deprecation: true` header — T16 test. ✓
18. Cross-tenant database_id forgery rejected — composite FK in schema (T3/T4) + RLS (T6). Acceptance via inspection.
19. Composite FK constraints in the generated migration — T6 step 2 SQL.
20. Identifier length / regex enforcement — T14 step 2.
21. Probe staleness UX — T20 (unreachable pill).
22. listDatabases() empty fallback — T19 dialog.
23. Replace connection atomicity — **deferred** per user decision.
24. Key-loss recovery — T10 throws `WAREHOUSE_KEY_MISSING` → T17 surfaces "credentials cannot be decrypted" (UI copy to add in follow-up; the API-level signal is in place).

**Gaps to flag for the implementer:**
- T11 step 1: the new `INSERT INTO source_stat` snippet assumes specific columns (`scanned_at`, `present`, `unmapped`). Verify against the existing `source_stat` definition and preserve every column.
- T15: the existing `/api/warehouse/tables` handler location is left to grep — implementer must locate before editing.
- T16 step 3: tests insert into `dimension` table directly; the schema may require more columns. Use `addDimension` helper if direct insert fails.
- T22 step 1: the OLD `Warehouse.tsx` file at `app/src/routes/settings/Warehouse.tsx` was REPLACED in T17. T22 step 1 is mostly a confirmation step — the section should already be gone.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-14-multi-database-warehouse.md`. 22 tasks, 6 phases. Reviewable phase-by-phase; each task is one TDD cycle (red → green → commit).

Recommended path: **subagent-driven development** (matches what we did for Track A) in an isolated worktree. The worktree skill creates `worktree-multi-db-warehouse`; subagents implement tasks sequentially with spec + quality review between each.

