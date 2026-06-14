# Multi-Database Warehouse — Design Spec

**Date:** 2026-06-14
**Scope:** Replace the singleton `WAREHOUSE_DB` env var with a real per-workspace warehouse connection that can register multiple **databases** (catalogs) and qualify every source by `(database, schema, table, column)`. Frames a generic-but-pluggable Warehouse settings UI that today drives MotherDuck and tomorrow drives Snowflake / Postgres-as-warehouse without re-wiring the data model. BigQuery is an explicit *deferred* case — its `project.dataset.table` hierarchy may need a follow-up data-model PR; see §4.8 and §10.

---

## 1. Background

Today the warehouse layer carries a lie. `tenant.warehouse_id` is a `varchar` column on every workspace row, but **nothing reads it** for scan-time qualification. Every existing tenant has the placeholder string `'default'` in that column (see `provisionTenant()` at `server/src/tenant.ts:73`), while every actual scan qualifies against `env.warehouseDb` (`'analytics'` by default — `server/src/env.ts:53`). The adapter cache (`server/src/warehouse/registry.ts:9`) takes a `workspaceId` parameter and then immediately resolves credentials from the global env block (`envCredentials()` → `env.warehouseDb`, `env.motherduckToken`). The TODO at `registry.ts:6` ("Phase 4 keys by workspace id") confirms per-workspace warehouse was always the intended endpoint.

`dimension_source.source_table` stores half-qualified strings like `"sales.orders"` — schema + table, no database. Both `tables.ts:107` and `repo-canonical.ts:501` write this shape. Scans qualify against `env.warehouseDb` (`repo-shared.ts:332`). Cross-database registration is impossible; cross-tenant credential isolation is impossible.

Meanwhile the multi-tenant model is real: every app-state table carries `tenant_id`, every endpoint passes through `tenant-middleware.ts`, super-admins switch workspaces. The warehouse is the only resource that has not yet been tenantized.

This spec finishes the tenantization of the warehouse layer and re-shapes `dimension_source` so that a source is qualified to the database it lives in.

---

## 2. Goals

1. A workspace owns **one warehouse connection** (credentials + adapter type). Today's flavors: `motherduck` (the only writable case; uses the existing DuckDB code path) and `duckdb_local` (file/in-memory; used for tests and dev-without-MotherDuck). Forward path: `bigquery`, `snowflake`, `postgres_warehouse`.
2. Inside that connection, **multiple databases** (catalogs in MotherDuck terms, databases in Snowflake, schemas in Postgres-as-warehouse) are registered for use. Browsing is constrained to the registered set. BigQuery's `project.dataset.table` model is acknowledged as a forward-compat goal but does not ship with this PR (§4.8).
3. Every `dimension_source` row is qualified to a specific registered database. Scans and canonical writes pass `(database, schema, table, column)` through to the adapter.
4. An Admin → Warehouse page where editor+ users (admin-only for credential edits) see the connection, the database list, and add/remove databases with introspection.
5. A migration that turns today's `tenant.warehouse_id` placeholder and `dimension_source.source_table` half-qualified strings into the new shape **without any user re-registering sources**.

## 3. Non-goals

- **Multiple connections per workspace.** Modeled as `warehouse_connection` (the table — see §4) keyed by `(tenant_id, id)`, so the schema allows it, but the UI exposes exactly one. Day-2 work, not now.
- **A new adapter implementation.** The MotherDuck/DuckDB adapter at `server/src/warehouse/duckdb/base.ts` is the only adapter that ships in this PR. The data model is shaped to absorb BigQuery/Snowflake later, not to deliver them.
- **Envelope encryption / KMS integration / automatic key rotation.** The AES-GCM box described in §4.5 is the surface; recovery and rotation are described in §10. A KMS swap-in is a follow-up.
- **A SQL editor / arbitrary query against the warehouse.** Scoped introspection only.

---

## 4. Data model

### 4.1 Three layers, one workspace

```
┌──────────────────────────────────────────────────────────────────┐
│  Workspace (tenant)                                              │
│                                                                  │
│  ┌───── warehouse_connection (1) ─────────────────────────────┐  │
│  │   id, adapter='motherduck', credentials_encrypted, label   │  │
│  │                                                            │  │
│  │   ┌── warehouse_database (N) ────────────────────────────┐ │  │
│  │   │  id, database_name='analytics',  label='Sales DWH'   │ │  │
│  │   │  id, database_name='hr',         label='HR mart'     │ │  │
│  │   │  id, database_name='finance',    label='Finance'     │ │  │
│  │   └──────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  dimension_source.database_id ──FK──▶ warehouse_database         │
│  dimension_source.schema_name, table_name, column_name           │
└──────────────────────────────────────────────────────────────────┘
```

A single connection is the cryptographic boundary — one set of credentials, one adapter instance, one connection pool. The registered databases are the **discovery boundary** — users browse and register sources only inside them, even if the credentials would technically grant broader access. Introspection can still list *unregistered* catalogs (so the "Add database" picker has something to suggest), but no scan, no canonical write, no `dimension_source` row ever references an un-registered database.

### 4.2 ID convention

All new IDs follow the existing codebase convention: `<prefix>_<32-char hex>` from `crypto.randomUUID().replace(/-/g, "")` (see `auth-password.ts:99`, `scheduler.ts:49`). Specifically:

- `warehouse_connection.id` = `wc_<32hex>` (e.g. `wc_a1b2c3d4e5f60718293a4b5c6d7e8f90`).
- `warehouse_database.id` = `wd_<32hex>`.

The 32-hex form is wide enough that collisions across tenants are not a practical concern; the unique-per-tenant constraint on the connection still ensures the singleton property. All sample IDs in the mockup match this length exactly.

### 4.3 `warehouse_connection`

```ts
export const warehouseConnection = app.table(
  "warehouse_connection",
  {
    id:                    varchar("id").notNull(),                  // wc_<32hex>
    tenant_id:             varchar("tenant_id").notNull().references(() => tenant.id),
    adapter:               varchar("adapter").notNull(),             // see check below
    label:                 varchar("label").notNull(),               // human label, e.g. "Production warehouse"
    credentials_encrypted: text("credentials_encrypted").notNull(),  // base64( nonce(12) || ciphertext || tag(16) )
    credentials_hash:      varchar("credentials_hash").notNull(),    // sha-256 of plaintext, hex; used for PATCH change-detection
    credentials_version:   integer("credentials_version").notNull().default(1),
    last_verified_at:      timestamp("last_verified_at"),
    last_verify_error:     text("last_verify_error"),
    created_at:            timestamp("created_at").notNull(),
    created_by:            varchar("created_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    uniqueIndex("warehouse_connection_one_per_tenant").on(t.tenant_id),  // PHASE 1 enforcement
    check("warehouse_connection_adapter_chk",
          sql`${t.adapter} IN ('motherduck', 'duckdb_local')`),          // 'bigquery', 'snowflake', 'postgres_warehouse' added later
  ],
);
```

Notes:
- **Composite primary key `(tenant_id, id)`** — `id` alone is not unique across the table; this is intentional. The composite FK shape from `warehouse_database` (and `dimension_source`) carries `tenant_id` through, making cross-tenant forgery impossible by construction.
- **New pattern alert.** Composite FKs via `foreignKey({ columns, foreignColumns })` are not used elsewhere in `server/drizzle/schema.ts` today — every existing FK is inline `.references(() => tenant.id)`. The first migration generated from this schema must be eyeballed: run `bun run db:generate`, open the produced SQL, and confirm the `CONSTRAINT ... FOREIGN KEY (tenant_id, connection_id) REFERENCES warehouse_connection (tenant_id, id)` form actually emits. If Drizzle's output diverges, fall back to writing the FK as a hand-rolled `sql` statement appended to the migration. The composite-FK shape is load-bearing for the cross-tenant-forgery defense; do not silently drop it for a simple single-column FK.
- **`credentials_encrypted` is `text`** (a base64 string). The spec previously had a `bytea`/`text` inconsistency; we settle on `text` here and everywhere — the acceptance criteria in §8 read "the stored column is not the plaintext JSON," not "the bytea is not the plaintext JSON."
- **`credentials_hash`** is a SHA-256 of the plaintext JSON, stored alongside the blob so PATCH can detect "did the credentials actually change?" without decrypting. See §7 (audit) for how `metadata.changedFields` uses this.
- `credentials_version` is the **optimistic-concurrency token** for PATCH (see §6.1 `If-Match` rule) and the cache eviction trigger for the local pod that PATCHed (other pods rely on the TTL — see §7.4). It also anticipates key rotation: a re-encrypt-and-bump worker is the follow-up.
- `last_verified_at` / `last_verify_error` are set by `adapter.ping()` (from the "Verify connection" button — see §5.2).

### 4.4 `warehouse_database`

```ts
export const warehouseDatabase = app.table(
  "warehouse_database",
  {
    id:                varchar("id").notNull(),                          // wd_<32hex>
    tenant_id:         varchar("tenant_id").notNull().references(() => tenant.id),
    connection_id:     varchar("connection_id").notNull(),
    database_name:     varchar("database_name", { length: 255 }).notNull(),  // see §4.6 on length caps
    label:             varchar("label", { length: 255 }),                    // optional human label
    last_probe_at:     timestamp("last_probe_at"),
    last_probe_error:  text("last_probe_error"),
    added_at:          timestamp("added_at").notNull(),
    added_by:          varchar("added_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    uniqueIndex("warehouse_database_per_conn_unique")
      .on(t.tenant_id, t.connection_id, t.database_name),
    index("warehouse_database_conn_idx").on(t.tenant_id, t.connection_id),
    // Composite FK so a tenant_id can't reference a connection owned by a different tenant.
    foreignKey({
      columns:           [t.tenant_id, t.connection_id],
      foreignColumns:    [warehouseConnection.tenant_id, warehouseConnection.id],
      name:              "warehouse_database_connection_fk",
    }).onDelete("cascade"),
  ],
);
```

`database_name` is the literal engine identifier; we store it exactly as the user enters it. `label` is the optional human-friendly name shown in dropdowns. The composite FK on `(tenant_id, connection_id)` is critical: without it, a forged `dimension_source` insert could reach a connection in another tenant.

This table has **no `deleted_at`** — DELETE is hard. To preserve post-incident forensics ("which database was registered when this scan ran?"), the audit row for `warehouse.database.remove` snapshots `database_name`, `label`, and `connection_id` into its `metadata` payload (see §8). That keeps `wd_<id>` resolvable after the row is gone, without the every-read `WHERE deleted_at IS NULL` filter overhead. The same snapshotting applies to `warehouse.database.remove` triggered via the `?force=true` path and to the bulk database-row drops inside `connection.replace`.

### 4.4a `user_warehouse_state` (per-user MRU)

Stores the per-user "most-recently-used database" used as the default for the source-registration dropdown (§5.3). Separate from `preferences` because `preferences` is one-row-per-tenant (`preferences_tenant_unique` at `server/drizzle/schema.ts:197`); MRU is one-row-per-user-per-tenant.

```ts
export const userWarehouseState = app.table(
  "user_warehouse_state",
  {
    user_id:              varchar("user_id").notNull(),
    tenant_id:            varchar("tenant_id").notNull().references(() => tenant.id),
    recent_database_id:   varchar("recent_database_id"),     // FK → warehouse_database; NULLable
    updated_at:           timestamp("updated_at").notNull(),
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

`ON DELETE SET NULL` on `recent_database_id` so removing a database doesn't strand the user's row in a broken state; the dropdown silently falls back to the legacy default the next time they open the form.

The workspace-wide *legacy-default* (used to disambiguate old API clients — see §6.3) is a separate concern and lives on `preferences.legacy_default_database_id` (a single value per tenant fits the existing one-row-per-tenant shape). The two values answer different questions:

| Field | Table | Scope | Purpose |
|---|---|---|---|
| `recent_database_id` | `user_warehouse_state` | per-user-per-tenant | sticky default for the source-registration dropdown |
| `legacy_default_database_id` | `preferences` | per-tenant | resolves the ambiguity when a legacy-shape API call arrives with no `databaseId` |

### 4.5 `dimension_source` — reshaped

The current shape is `(tenant_id, dim_id, source_table, source_column)`. New shape:

```ts
export const dimensionSource = app.table(
  "dimension_source",
  {
    dim_id:        varchar("dim_id").notNull(),
    tenant_id:     varchar("tenant_id").notNull().references(() => tenant.id),
    database_id:   varchar("database_id").notNull(),                              // FK → warehouse_database
    schema_name:   varchar("schema_name", { length: 255 }).notNull(),             // see §4.6
    table_name:    varchar("table_name",  { length: 255 }).notNull(),
    column_name:   varchar("column_name", { length: 255 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.dim_id, t.database_id, t.schema_name, t.table_name, t.column_name] }),
    index("dimension_source_dim_idx").on(t.tenant_id, t.dim_id),
    index("dimension_source_database_idx").on(t.tenant_id, t.database_id),
    foreignKey({
      columns:        [t.tenant_id, t.database_id],
      foreignColumns: [warehouseDatabase.tenant_id, warehouseDatabase.id],
      name:           "dimension_source_database_fk",
    }).onDelete("restrict"),
  ],
);
```

We keep `schema_name`, `table_name`, `column_name` as separate columns rather than collapsing back into a single qualified string. The existing scan code already splits and re-joins (`split_part(s.source_table, '.', 1)` at `repo-scan.ts:102` is a code smell we now retire); and the `ON DELETE RESTRICT` on the database FK gives us "you can't remove a database while sources depend on it" for free.

### 4.6 Identifier length caps

Postgres `varchar` with no length cap is fine in the abstract, but the dimension_source PK is over `(tenant_id, dim_id, database_id, schema_name, table_name, column_name)` and the btree row-size limit (~2700 bytes) gets real if these are unbounded. Forward-compat to Snowflake (whose identifier limit is 255 chars) is one of the explicit goals.

We cap each of `database_name`, `schema_name`, `table_name`, `column_name` at `varchar(255)` in storage. This covers MotherDuck (no documented hard limit but practical max ~63), Postgres (63), Snowflake (255), and most of BigQuery (1024 — long table names get rejected at registration time rather than corrupting the PK index).

**Enforcement.** The validation rule the API runs at registration time is:

```ts
const limit = Math.min(255, adapter.capabilities.maxIdentifierLength);
if (databaseName.length > limit) reject(`databaseName too long for ${adapter.kind} (max ${limit})`);
// same check for schema_name, table_name, column_name
```

This means the `maxIdentifierLength` capability is **read by the registration code path** (not decorative): when an adapter declares 63 (Postgres-as-warehouse), we reject 64-char identifiers even though the column would technically hold them. When an adapter declares 1024 (BigQuery), the storage cap wins at 255 and the error message names that cap. Either way, the rejection happens in `POST /api/warehouse/databases` and `POST /api/dimensions/:id/sources` before the row touches the table, with a 422 carrying the exact limit. The 255 storage cap is documented as the universal upper bound in the adapter contract (§4.8).

### 4.7 `source_stat` — same shape, same FK

`source_stat` is reshaped identically: drop `source_table` / `source_column`, add `database_id`, `schema_name`, `table_name`, `column_name` (all `varchar(255)`). PK over `(tenant_id, dim_id, database_id, schema_name, table_name, column_name)` mirrors `dimension_source`. Composite FK `(tenant_id, database_id) → warehouse_database(tenant_id, id) ON DELETE CASCADE` so a stray `source_stat` row from a removed database is impossible by construction.

(`dimension_source` uses RESTRICT so the API can surface a confirm dialog; `source_stat` uses CASCADE because it is an internal derived table — once `dimension_source` is gone, `source_stat` should never linger.)

### 4.8 Adapter contract changes

The current adapter (`server/src/warehouse/adapter.ts`) already exposes a `Ref { catalog?, schema, table }` shape — `catalog` is optional today and almost never set. The shape stays; what changes is **how it's filled in**:

- `Ref.catalog` becomes **required** for any method that takes a `Ref`. Callers always pass the explicit `database_name` from `warehouse_database`. The `?? this.creds.database` fallback at `duckdb/base.ts:48` is removed.
- A new method `listDatabases(): Promise<DatabaseDescriptor[]>` lets the "Add database" picker show every catalog the credentials can see (with a "registered" flag the server computes by joining against `warehouse_database`). **Timeout: 10s server-side** (`AbortController`-driven); on timeout the API returns 504 with body `{ kind: "DISCOVERY_TIMED_OUT" }` and the UI shows the manual-entry fallback (§5.2).
- `listTables(opts)` gains a required `opts.database` parameter. **Timeout: 10s.**
- A new method `probeDatabase(databaseName): Promise<{ok: true} | {ok: false, reason: string}>` is the adapter-defined reachability check. **Timeout: 5s.** There is **no** universal probe — each adapter implements its own canonical "this catalog is real and we can read it":
  - **MotherDuck / DuckDB**: `SELECT 1 FROM <dbname>.information_schema.schemata LIMIT 1` — fast, requires only read access.
  - **Snowflake** (planned): `USE DATABASE <dbname>; SHOW SCHEMAS IN DATABASE <dbname> LIMIT 1`.
  - **Postgres** (planned): `SELECT 1 FROM pg_catalog.pg_namespace LIMIT 1` after connecting to the database.
  - **BigQuery** (planned, TBD): BigQuery's hierarchy is `project.dataset.table`; the "catalog-equivalent" layer that a user picks per source is the *dataset*, not the project, and credentials can span multiple projects with multiple datasets each. Mapping that onto a flat `warehouse_database.database_name` likely requires either (a) a two-level identifier (`{project, dataset}` packed into one column) or (b) a follow-up data-model PR that adds a `database_namespace` column. **BigQuery support does not land in this PR.** The contract carries the placeholder shape; the BigQuery adapter ships once the modeling question is settled. Until then, BigQuery is the explicit example of "things this design promises forward-compat for but cannot prove until the adapter is written" — called out so a future BigQuery PR can come back and reshape `warehouse_database` if needed.

- A new method `ping(): Promise<{ok: true} | {ok: false, error: string}>`, distinct from `probeDatabase`, is the connection-level reachability check. **Timeout: 5s.** Each adapter defines its own (e.g., MotherDuck: `SELECT 1`).

`AdapterCapabilities` gains:

```ts
readonly supportsMultipleDatabases: true | false;
readonly databaseTerm: "catalog" | "database" | "dataset" | "schema";
readonly maxIdentifierLength: number;     // for §4.6 validation; read at registration time
```

`supportsMultipleDatabases: false` (e.g., `duckdb_local` against a single file) collapses the UI per §5.1: the "+ Add database" button is hidden, the page shows a single hardcoded database row labeled `(local)`, and the underlying database row is implicit (created at connection time, not editable). The adapter swap rules in §5.5 prevent moving from a multi-db adapter to a single-db adapter while >1 database is registered.

`databaseTerm` is the user-facing word in the picker ("Add catalog…" for MotherDuck, "Add database…" for Snowflake, "Add schema…" for Postgres-as-warehouse). The `'project'` literal is deliberately absent: BigQuery's actual catalog-equivalent is `dataset`, but until the BigQuery adapter lands and decides whether `database_name` holds a dataset or a packed `project.dataset` tuple, we don't pin the copy.

**All four adapter calls run under server-side timeouts.** On timeout the surrounding endpoint returns a structured error: `listDatabases` → 504 `DISCOVERY_TIMED_OUT`, `probeDatabase` → 504 `PROBE_TIMED_OUT`, `ping` → 504 `PING_TIMED_OUT`, `listTables` → 504 `TABLES_TIMED_OUT`. The UI surfaces each as a soft state (no scary-modal): the Add picker shows the manual-entry fallback, the Verify button surfaces the timeout inline. None of the timeouts are user-configurable in this release; they are codified in the adapter wrapper alongside `kind: 'duckdb'` / `kind: 'motherduck'` dispatch.

### 4.9 Credential envelope

`credentials_encrypted` is a base64 string of `nonce(12) || ciphertext || tag(16)` from AES-256-GCM. The 32-byte master key comes from `env.warehouseEncryptionKey`, sourced from `WAREHOUSE_ENCRYPTION_KEY`. Associated data (AAD) is the UTF-8 bytes of the literal `tenant_id + ":" + id` (e.g. `acme:wc_a1b2c3d4...`) — both parts are safe-shape strings: `tenant_id` is regex-constrained to `[a-z][a-z0-9_]{0,20}` (no colon possible) and `id` matches `wc_<32hex>`. Future adapters that may carry colons in tenant identifiers would need to switch to a length-prefixed AAD; this release does not. The AAD is bound at both encrypt and decrypt time so a stolen blob can't be replayed against a different connection record.

Bootstrap behavior:
- **Production / staging**: `WAREHOUSE_ENCRYPTION_KEY` must be set; bootstrap refuses to start if it is unset or shorter than the expected 32 raw bytes (44 base64 chars). No random fallback — that's how throwaway keys end up in commits.
- **Dev / test**: same rule, but `bun run bootstrap` prints the exact command to generate a key (`openssl rand -base64 32`) and points at `server/.env.example`. The example file documents the variable with a warning.

The plaintext shape per adapter mirrors today's `WarehouseCredentials` discriminated union (`server/src/warehouse/credentials.ts:31`):

```jsonc
// adapter='motherduck'
{ "type": "duckdb", "token": "<motherduck_token>", "writable": false }
// adapter='duckdb_local'
{ "type": "duckdb", "path": "/var/zugzug/local.duckdb" }
```

The `database` field is removed from the credentials JSON — it lives in `warehouse_database` rows now.

**Blast radius and the key-loss story.** If the master key is lost (rotated without re-encrypting, deleted from the secret store, host migration with no key handoff), **every existing warehouse_connection row is permanently unrecoverable**. The plaintext credentials cannot be recovered from the ciphertext without the key, full stop. Recovery is one path: an admin re-enters credentials via the UI (`POST /api/warehouse/connection`), which writes a new blob encrypted under the current key. Until that re-entry, scans fail with `WAREHOUSE_KEY_MISSING` and the UI surfaces "credentials cannot be decrypted — re-enter to repair."

This footgun is documented in `server/.env.example` next to the `WAREHOUSE_ENCRYPTION_KEY` line ("Lose this key, lose every warehouse connection — admins must re-enter credentials") and in §10 (out of scope: KMS-backed key versioning, which would let the same blob be decrypted under either an old or new key during rotation).

### 4.10 What does **not** change

- `dimension_field`, `draft`, `audit_log`, `canonical_version`, `ai_hint_cache`, `preferences` — none reference the warehouse identifier; they're inert here.
- `scan_run.source_id` — this column is a denormalized string of the source ref at scan time. It is **not** reshaped: historical scan_run rows pre-migration may not resolve to current sources, and that is accepted. New scan_run rows record `source_id` as `<database_id>:<schema>:<table>:<column>` — opaque to consumers; resolution back to a live source is best-effort (the Activity UI falls back to "(unresolved source)" for orphan strings).
- Dynamic `dim_<id>` / `map_<id>` tables still live in Postgres (the read-only MotherDuck token is unchanged). The warehouse is read-only-for-scans regardless of how many databases are attached.

---

## 5. UI surface

### 5.1 Settings → Warehouse (new top-level entry)

Replaces today's "Warehouse" section in Settings. IA slot is named **Warehouse** (not "Connections") to keep the sidebar word distinct from the outbound-integrations track (`/2026-06-14-outbound-integrations-design.md`), which owns the "Integrations" label. The sidebar item sits between "Members" and "Preferences" in `AdminSidebar.tsx`.

The page is a single column at desktop widths with two stacked cards.

**Warehouse card (top)** — adapter logo + name, the human label, the connection status pill, and three actions: **Verify connection**, **Edit credentials…**, **Replace connection…** (the destructive swap — see §5.5). Below those, a metadata strip shows `Adapter: MotherDuck` and `Connected by: ada@zugzug.app · 2026-03-14`.

The status pill resolves from four states:

| State | Pill |
|---|---|
| No row in `warehouse_connection` | `not configured` (gray); page body shows the empty state "No warehouse connected — admins can add one to start scanning." |
| Row exists, `last_verified_at IS NULL` and `last_verify_error IS NULL` | `unverified` (gray); helper text: "Run Verify connection to test." |
| Row exists, `last_verify_error IS NOT NULL` | `error` (coral) with the error string truncated to 80 chars; full text on hover |
| Row exists, last verify succeeded | `reachable · 2 min ago` (mint) |

Same banner pattern in the rest of the app: today's "Warehouse offline" banner now fires when `warehouse_connection IS NULL` OR `last_verify_error IS NOT NULL`, replacing the `ATTACH_WAREHOUSE=false` gate (the env var is retired post-migration).

**Databases card (below)** — a table of registered databases with columns: name (mono), label (italic if empty), source count, added by, added on, and a row action menu. The header has a single primary action: **+ Add database**, which opens the picker (§5.2). The empty state shows when zero databases are registered and includes "Most warehouses ship with one main catalog — add it to start mapping sources."

When the active adapter has `supportsMultipleDatabases: false`, the Databases card collapses: the "+ Add database" button is hidden, the table shows a single read-only row labeled `(local)` with helper text "This adapter doesn't support multiple databases. Sources bind to the single local database."

### 5.2 The Add database picker (dialog)

A dialog (not a popover — it has enough content to warrant chrome) titled "Add database". Two zones:

1. **Discovered** — chips for each `databaseName` the adapter returned from `listDatabases()`, each chip showing the registered state. Clicking an unregistered chip selects it (pre-fills the manual entry below); clicking a registered chip is a no-op with a "Already registered" tooltip. If `listDatabases()` failed or returned empty, this zone collapses to a one-line "Could not enumerate — enter manually".
2. **Manual** — a text input for `databaseName`, an optional label, and a **Test reachability** button that calls `adapter.probeDatabase(databaseName)` (the adapter-defined check from §4.8). The submit button (**Add database**) is disabled until either a chip is selected OR a manual name has passed the reachability test.

**Chip vs manual entry — resolution rules:**
- Selecting a chip writes its name into the manual entry input and marks the chip as the current selection. The probe state attaches to whichever is current.
- **Typing into the manual entry deselects any chip.** The probe state resets to "untested" and the submit button disables until the user clicks Test reachability and gets a pass. This prevents the "selected chip + edited manual name + stale probe" footgun.
- The mockup demonstrates the post-probe state (chip selected, name matches, probe pill mint).

The picker leans on the existing `ak-modal` + `ak-cmd` patterns from the component kit.

### 5.3 Source-registration form — the new database dropdown

`AddSourceDialog` (Table → "Add source") gains a leading **Database** dropdown above the existing schema/table/column pickers. Its options are the registered `warehouse_database` rows. Default selection cascade:

1. The single registered database, when there's only one (the common case).
2. Otherwise the calling user's most-recently-used database — read from `user_warehouse_state.recent_database_id` (the per-user MRU table — §4.4a) for `(tenant_id, user_id)`. Set on every successful Bind via the same write that creates the `dimension_source` row.
3. Otherwise (no MRU yet) the workspace-wide `preferences.legacy_default_database_id`, falling back to the alphabetically-first reachable database.

When the database changes, the dependent **Schema** / **Table** / **Column** pickers reset and re-fetch via `GET /api/warehouse/tables?database=<id>&...`. A "Browse" link below opens the existing catalog drawer scoped to that database.

**Unreachable databases** (rows with `last_probe_error IS NOT NULL`) are **visible and selectable** in the dropdown, decorated with an `unreachable` pill. The user can still pick one to inspect or repair an existing binding. Picking one disables the Schema/Table/Column pickers below and shows inline copy: "This database is unreachable. Re-verify the connection in Settings → Warehouse, or remove and re-register."

The `unreachable` pill on a database row is **independent of the connection-card pill** on the Warehouse page (§5.1 status pill table). A reachable connection can still contain a database whose catalog name disappeared upstream — the connection ping succeeds (`SELECT 1` works) but `probeDatabase('finance_eu')` returns not-found. So the two pills can disagree: `Reachable` connection + `unreachable` database row is the expected state for the §9 "schema renamed upstream" case. The Warehouse card's pill answers "is the credential valid?", the database row's pill answers "does the catalog still exist?".

The "**Add database…**" item that previously appeared in this dropdown is removed. Rationale: clicking it would route an in-flight source-registration form out to Settings, losing form state. Instead, the empty-state CTA (when zero databases are registered) is a button that opens the Add database dialog **as a modal-over-modal** (the source form stays mounted underneath); the modal closes, the new database appears in the dropdown, the user continues. Adding a database mid-flow is therefore admin-or-editor (matches the §4 perm) and the flow is preserved.

The full source string in the audit log gets the database prefix: `Created table · regions · from sales-dwh.public.regions.country_code`.

### 5.4 Remove-database confirm (when sources depend on it)

When DELETE returns 409, the UI surfaces a confirm modal:

```
┌────────────────────────────────────────────────────────────────┐
│ Remove database analytics_prod?                                │
│                                                                │
│ This database powers 3 sources across 2 dimensions:            │
│                                                                │
│   • country (1 source)                                         │
│       sales.orders.country_code                                │
│                                                                │
│   • product_category (2 sources)                               │
│       sales.products.category                                  │
│       inventory.skus.category                                  │
│                                                                │
│ ⚠ Removing the database also removes these sources from the   │
│   dimensions. Canonical values stay; only the source binding   │
│   goes away. You can re-bind to a different database later.    │
│                                                                │
│  [ ] I understand the sources will be unbound.                 │
│                                                                │
│           [ Cancel ]    [ Remove and unbind sources ]          │
└────────────────────────────────────────────────────────────────┘
```

**Gating:**
- The destructive button (right) is **disabled until the checkbox is ticked**. The mockup shows the at-rest disabled state.
- The action itself (`DELETE ...?force=true`) requires **admin** role, not editor. Rationale: a single click on this modal unbinds every dependent source across every dimension. Compare to the connection-edit gate (admin-only because credentials are sensitive); the force-delete is at least as destructive (it can wipe every source in the workspace if one database backed everything — which is the post-migration default). Editor-permitted "remove without force" (the 409 path) remains; non-admin editors who hit the 409 see the same modal with the destructive button replaced by "Ask an admin to confirm" plus a per-source list they can re-bind by hand.

The button text matches the engineer-mode tooltip on the action ("calls DELETE /api/warehouse/databases/:id?force=true · admin only").

### 5.5 Replace connection (adapter swap or full credential rotation)

The "Replace connection…" button on the Warehouse card opens a multi-step flow rather than the previous "DELETE then POST in sequence" sketch. The composite `ON DELETE RESTRICT` from `dimension_source` to `warehouse_database` means a naive replace-by-DELETE fails for any workspace with sources, which is most of them.

The flow:

1. **Picker** — the user chooses a new adapter and enters credentials. Validation runs `adapter.ping()` before proceeding.
2. **Database mapping** — for each currently-registered `warehouse_database`, the user picks a target database on the new connection (chip from the new adapter's `listDatabases()`, or manual entry with a probe). The user can also choose "drop this database (unbind its N sources)" for any row they don't want to carry forward.
3. **Confirm** — summary screen lists `warehouse_database` rows that will be moved (label, source count, target database_name) and rows that will be dropped (with their dependent dimensions named).
4. **Commit** — single transaction: insert the new connection, insert the new `warehouse_database` rows, update each `dimension_source.database_id` to point at the new target, delete the old `warehouse_database` and `warehouse_connection` rows.

**Multi-db → single-db adapter swaps** (e.g., MotherDuck → duckdb_local with `supportsMultipleDatabases: false`) are refused at step 1 if >1 database is currently registered. The error names the precondition: "duckdb_local supports a single database. Remove all but one database before swapping."

This is admin-only end-to-end.

### 5.6 Engineer-mode reveals

With `useEngineerMode()` on, the Warehouse card shows a "Credentials" section with the *adapter type* (`motherduck`) and the *credential version* (`v1`). The Databases table gains the `wd_<32hex>` value in a muted monospaced label below each database name.

The "View encrypted blob" affordance is **admin-only and behind a confirm dialog** ("Copy the encrypted ciphertext to your clipboard? It is useless without the master key, but treat it as sensitive."). Cipher details (`aes-256-gcm`, nonce length, tag length) are surfaced only on hover of an info icon, not painted into the strip — ops-debugging value is near zero, and a security review will not love the painted version. The accent-pink "Copy encrypted blob →" link from the earlier sketch is recolored to a neutral ghost button **prefixed with a lock icon** so the confirm-dialog implication reads at-a-glance without depending on the helper caption (matching the pattern used elsewhere — e.g. `teardownTenant` and `regenerateInvite`).

---

## 6. API surface

All endpoints scoped to the active tenant by `tenant-middleware.ts`. Permission column: who can call.

### 6.1 Connection management — `/api/warehouse/connection` (singleton)

There is **one warehouse_connection per workspace** (enforced by the unique index). The URL is therefore a singleton; no `:id` path parameter. This removes the cross-tenant URL-confusion footgun (admin A in workspace A can't be tricked into hitting `/api/warehouse/connection/wc_other`) and matches the schema reality.

| Method | Path | Body | Perm | Returns |
|---|---|---|---|---|
| `GET` | `/api/warehouse/connection` | — | viewer+ | `{ id, adapter, label, credentialsVersion, lastVerifiedAt, lastVerifyError } \| null` (the credentials are never returned; `credentialsVersion` is returned so the client can echo it as `If-Match` on PATCH) |
| `POST` | `/api/warehouse/connection` | `{ adapter, label, credentials }` | admin | the new connection's public projection. Rejected if a connection already exists for this tenant. |
| `PATCH` | `/api/warehouse/connection` | `{ label?, credentials? }` + **required header `If-Match: <credentialsVersion>`** | admin | the updated projection. See concurrency note below. |
| `POST` | `/api/warehouse/connection/verify` | — | admin | `{ ok: true, lastVerifiedAt } \| { ok: false, error }` — runs `adapter.ping()`. |
| `DELETE` | `/api/warehouse/connection` | — | admin | 204. Refuses (409 `CONNECTION_IN_USE`) when any `warehouse_database` rows still exist. |
| `POST` | `/api/warehouse/connection/replace` | (multi-step body — see §5.5) + **required header `If-Match: <credentialsVersion>`** | admin | atomic swap |

**PATCH concurrency.** The `If-Match` header carries the `credentials_version` the client read on its preceding GET. The server takes an `UPDATE warehouse_connection SET ... WHERE tenant_id=$1 AND id=$2 AND credentials_version=$3 RETURNING credentials_version` in the same transaction; if zero rows are returned, another admin (or the rotation worker) updated the row first and the server returns **412 `PRECONDITION_FAILED`** with body `{ kind: 'STALE_VERSION', currentVersion }`. The UI re-fetches and shows "Admin B updated credentials moments ago — refresh to see the latest, then re-submit." This is the only path that bumps the version; no other endpoint mutates `credentials_version`. The same `If-Match` rule applies to `POST .../replace` since it deletes the old connection.

**Hash short-circuit on PATCH.** Sending `credentials` re-encrypts and bumps `credentials_version` only if the SHA-256 of the new plaintext differs from `credentials_hash`. If they match, the server treats the field as not-sent (no version bump, no `credentials` entry in `changedFields`). This is the "user re-typed the same token" case and is intentional silence; it does **not** bypass `If-Match` (the version check still runs against the stored value before this short-circuit decides anything).

### 6.2 Database management — `/api/warehouse/databases`

| Method | Path | Body | Perm | Returns |
|---|---|---|---|---|
| `GET` | `/api/warehouse/databases` | — | viewer+ | `Array<{ id, databaseName, label, addedAt, sourceCount, lastProbeAt, lastProbeError }>`. `sourceCount` is computed (`COUNT(*) FROM dimension_source WHERE database_id = wd.id`). |
| `GET` | `/api/warehouse/databases/available` | — | editor+ | `Array<{ databaseName, registered: boolean }>` — calls `adapter.listDatabases()`, joins with the registered set. |
| `POST` | `/api/warehouse/databases` | `{ databaseName, label? }` | editor+ | the new row. Calls `adapter.probeDatabase(databaseName)` and rejects with 422 if the probe fails. |
| `PATCH` | `/api/warehouse/databases/:id` | `{ label }` | editor+ | the updated row. (Renaming the literal `databaseName` is not supported — see §9 edge cases.) |
| `DELETE` | `/api/warehouse/databases/:id` | `?force=true` | editor+ (non-force) / **admin (force=true)** | 204 on success. 409 `DATABASE_IN_USE` with `{ sourceCount, dimensions: [...] }` when sources depend on it. `?force=true` triggers a confirmation flow that deletes the dependent `dimension_source` rows AND the matching `source_stat` rows in a single transaction. **`force=true` is admin-only** (see §5.4 rationale). |

### 6.3 Source-registration endpoints — updated shapes

The existing endpoints (`POST /api/dimensions`, `POST /api/dimensions/:id/sources`, etc.) accept the new qualified shape:

```ts
type SourceRef = {
  databaseId: string;       // FK to warehouse_database
  schemaName: string;
  tableName: string;
  columnName: string;
};
```

`databaseId` MUST belong to a `warehouse_database` row in the active tenant.

**Backward-compat (legacy shape).** Old clients still send `{ table: "sales.orders", column: "country" }`. The server accepts that shape for one release with a `Deprecation: true` response header. To resolve the ambiguity introduced when a workspace registers a second database, we add `preferences.legacy_default_database_id` per workspace — the server reads this when the legacy shape arrives. The migration sets `legacy_default_database_id` to the backfilled database for every workspace; admins can change it.

When a workspace adds a second database, a one-time admin banner ("Old API clients will default to <db_name>; change the default in Preferences if needed") fires; this also lands in audit (`warehouse.legacy_default.set`). If the legacy default is unset (admin cleared it) and the legacy shape arrives, the server returns 422 `BACKEND_LEGACY_SHAPE_AMBIGUOUS` with the list of registered databases. This window closes mid-2026-07 when the legacy shape is removed entirely.

### 6.4 Catalog browsing — already exists, gains a parameter

`GET /api/warehouse/tables?database=<id>&schema=<name>&search=<q>` — current endpoint at `server.ts` adds `database` (the `warehouse_database.id`) as a required query param. Returns the same `CatalogTable[]` shape. The adapter call inside translates `database` to the literal `database_name` before issuing `SHOW ALL TABLES`.

`GET /api/warehouse/tables/:dbId/:schema/:table/columns` — likewise gains the db id in the path.

---

## 7. Migration / rollout

Drizzle migration in two parts:

1. `2026-06-14_warehouse_multi_db.sql` — the DDL only, plus the structural backfill that does not need application crypto.
2. `bun run warehouse:backfill` — a one-shot Bun script that performs the credential-encryption step. The migration file is **plain SQL** (CLAUDE.md is explicit: schema changes → Drizzle migration; we do not extend the migration runner to call Bun code). The migration leaves `warehouse_connection.credentials_encrypted` as a placeholder until the script runs; the application is gated by a feature flag during this window (see rollback below).

This split keeps migration files inspectable SQL (the principle from CLAUDE.md) and keeps the encryption logic in tested app code.

### 7.1 SQL migration (forward-only DDL)

The migration runs in a single transaction. **All preflight checks at step 0 run as plain `DO $$ ... RAISE EXCEPTION` blocks** — they abort the transaction before any DDL touches the schema, so a halt at a precondition leaves the DB unchanged.

0. **Preflight — abort early if data does not match assumptions.**

   ```sql
   DO $$
   DECLARE
     admin_id  varchar;
     bad_rows  int;
     missing   int;
     bad_list  text;
   BEGIN
     -- Preflight A: at least one super-admin must exist to own the backfilled
     -- warehouse_connection rows. If the target environment has none (fresh OSS
     -- install, post-teardownTenant cleanup, dev DB seeded without admin), we
     -- abort cleanly with a clear message instead of crashing on NOT NULL.
     SELECT id INTO admin_id
       FROM users WHERE is_super_admin = true
       ORDER BY created_at LIMIT 1;
     IF admin_id IS NULL THEN
       RAISE EXCEPTION
         '[warehouse_multi_db] preflight A: no super-admin user found. '
         'The migration assigns ownership of backfilled warehouse_connection rows to '
         'the earliest super-admin. Create one (bun run bootstrap -- --seed) and re-run.';
     END IF;

     -- Preflight B: every existing dimension_source.source_table must contain
     -- exactly one dot. split_part(s, '.', 2) silently returns '' on malformed
     -- input, which would write empty string table_name rows that pass the
     -- NOT NULL check but silently break scans. Catch them now.
     SELECT count(*) INTO bad_rows
       FROM dimension_source
      WHERE source_table IS NULL
         OR position('.' IN source_table) = 0
         OR split_part(source_table, '.', 2) = '';
     IF bad_rows > 0 THEN
       SELECT string_agg(quote_ident(tenant_id) || '/' || quote_ident(dim_id)
                         || ': ' || coalesce(source_table, '<NULL>'),
                         E'\n  ' ORDER BY tenant_id, dim_id)
         INTO bad_list
         FROM dimension_source
        WHERE source_table IS NULL
           OR position('.' IN source_table) = 0
           OR split_part(source_table, '.', 2) = '';
       RAISE EXCEPTION
         '[warehouse_multi_db] preflight B: % dimension_source row(s) have '
         'malformed source_table (need <schema>.<table>). Fix or delete these, '
         'then re-run. Offending rows:%s  %s', bad_rows, E'\n', bad_list;
     END IF;

     -- Preflight C: WAREHOUSE_DB must be set in the migration runner env.
     -- The backfill in step 3 binds it as :warehouse_db; an empty string would
     -- produce empty-string database_name rows. The migration runner is
     -- expected to verify env presence before launching psql; this is the
     -- defense-in-depth check.
     IF current_setting('zugzug.warehouse_db', true) IS NULL
        OR current_setting('zugzug.warehouse_db', true) = '' THEN
       RAISE EXCEPTION
         '[warehouse_multi_db] preflight C: zugzug.warehouse_db setting empty. '
         'Run with `psql -v warehouse_db=<env.WAREHOUSE_DB>` and ensure the migration '
         'runner sets SET LOCAL zugzug.warehouse_db = :warehouse_db before applying.';
     END IF;
   END $$;
   ```

   The migration runner (`server/src/migrate.ts` — extended for this migration) reads `env.WAREHOUSE_DB` and emits `SET LOCAL zugzug.warehouse_db = '<value>';` immediately before the migration file's body. Plain SQL still; the runner is the well-known infra layer that bridges env into Postgres session state.

1. **Create `warehouse_connection`, `warehouse_database`, and `user_warehouse_state`** per the DDL in §4.
2. **Backfill one connection per tenant.** The super-admin ID was validated to exist in preflight A; capture it into a session var to avoid repeating the subquery (which would race with concurrent super-admin demotions, though that's astronomically unlikely mid-migration):

   ```sql
   DO $$
   DECLARE
     admin_id varchar;
   BEGIN
     SELECT id INTO admin_id
       FROM users WHERE is_super_admin = true
       ORDER BY created_at LIMIT 1;
     PERFORM set_config('zugzug.bootstrap_admin', admin_id, true);
   END $$;

   INSERT INTO warehouse_connection (id, tenant_id, adapter, label,
                                     credentials_encrypted, credentials_hash, credentials_version,
                                     created_at, created_by)
   SELECT 'wc_' || replace(gen_random_uuid()::text, '-', ''),
          t.id,
          'motherduck',
          'Production warehouse',
          '__PENDING__',          -- replaced by warehouse:backfill
          '__PENDING__',
          1, now(),
          current_setting('zugzug.bootstrap_admin')
     FROM tenant t
    WHERE t.deleted_at IS NULL;
   ```

3. **Backfill `warehouse_database`** — for each tenant, register one database. The `database_name` is taken from `zugzug.warehouse_db` (the value scans actually use today; `tenant.warehouse_id` is a placeholder string that was never the real catalog name — see §1). Preflight C guarantees the session var is non-empty.

   ```sql
   INSERT INTO warehouse_database (id, tenant_id, connection_id, database_name, label,
                                   added_at, added_by)
   SELECT 'wd_' || replace(gen_random_uuid()::text, '-', ''),
          wc.tenant_id,
          wc.id,
          current_setting('zugzug.warehouse_db'),
          'Imported from env',
          now(), wc.created_by
     FROM warehouse_connection wc;
   ```

4. **Rewrite `dimension_source`** — preflight B guarantees every source_table has a valid `<schema>.<table>` shape, so `split_part` is safe.

   ```sql
   ALTER TABLE dimension_source
     ADD COLUMN database_id varchar,
     ADD COLUMN schema_name varchar(255),
     ADD COLUMN table_name  varchar(255),
     ADD COLUMN column_name varchar(255);

   UPDATE dimension_source ds
      SET database_id = wd.id,
          schema_name = split_part(ds.source_table, '.', 1),
          table_name  = split_part(ds.source_table, '.', 2),
          column_name = ds.source_column
     FROM warehouse_database wd
    WHERE wd.tenant_id = ds.tenant_id;     -- one database per tenant after step 3, so no ambiguity

   -- Belt-and-suspenders: defend against an empty-string slipping through
   -- preflight B (shouldn't happen, but a check constraint is cheap).
   ALTER TABLE dimension_source
     ADD CONSTRAINT dimension_source_table_name_nonempty
       CHECK (length(table_name) > 0),
     ADD CONSTRAINT dimension_source_schema_name_nonempty
       CHECK (length(schema_name) > 0),
     ADD CONSTRAINT dimension_source_column_name_nonempty
       CHECK (length(column_name) > 0);

   ALTER TABLE dimension_source
     ALTER COLUMN database_id SET NOT NULL,
     ALTER COLUMN schema_name SET NOT NULL,
     ALTER COLUMN table_name  SET NOT NULL,
     ALTER COLUMN column_name SET NOT NULL;

   ALTER TABLE dimension_source DROP CONSTRAINT dimension_source_pkey;
   ALTER TABLE dimension_source ADD PRIMARY KEY (tenant_id, dim_id, database_id, schema_name, table_name, column_name);
   -- and the composite FK from §4

   -- Source columns are KEPT (nullable) for the rollback window — see §7.4.
   ALTER TABLE dimension_source ALTER COLUMN source_table  DROP NOT NULL;
   ALTER TABLE dimension_source ALTER COLUMN source_column DROP NOT NULL;
   ```

5. **Mirror the same for `source_stat`**, including the composite FK with `ON DELETE CASCADE` per §4.7. The same three `length(...) > 0` check constraints apply.
6. **Set `preferences.legacy_default_database_id`** for every workspace to the backfilled database id (one row exists per tenant by construction). The per-user `user_warehouse_state.recent_database_id` is **not** backfilled — users get the workspace default until they bind a source.
7. **Drop `tenant.warehouse_id`** is **deferred** to a follow-up migration after the rollback window expires (see §7.4). The column stays in place but is no longer read by the application — see the rollback note for the placeholder-write tech-debt window.

### 7.2 `bun run warehouse:backfill`

A one-shot script the migration file documents in a `-- HALT` comment at the top: `-- After applying this migration, run \`bun run warehouse:backfill\` to populate credentials before flipping USE_NEW_WAREHOUSE.` The script:

- Reads the env-derived credentials (`MOTHERDUCK_TOKEN`, etc.).
- For every `warehouse_connection` with `credentials_encrypted = '__PENDING__'`, encrypts `{ type: "duckdb", token: $MOTHERDUCK_TOKEN, writable: false }` under the master key with AAD `tenant_id || ':' || id`, computes the SHA-256 of the plaintext, writes both.
- Refuses to run twice; refuses to run if any row is non-placeholder (won't clobber real credentials).

The script is idempotent in the "if some rows are pending, finish them" sense.

### 7.3 RLS implications

The multi-tenant rollout (per the 2026-06-07 spec) enables Postgres RLS in Deploy 2, with policies that error on missing `SET LOCAL app.tenant_id`. The three new/reshaped tables get matching policies:

```sql
ALTER TABLE warehouse_connection ENABLE ROW LEVEL SECURITY;
CREATE POLICY warehouse_connection_tenant_isolation ON warehouse_connection
  USING (tenant_id = current_setting('app.tenant_id')::varchar);

ALTER TABLE warehouse_database  ENABLE ROW LEVEL SECURITY;
CREATE POLICY warehouse_database_tenant_isolation  ON warehouse_database
  USING (tenant_id = current_setting('app.tenant_id')::varchar);

ALTER TABLE user_warehouse_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_warehouse_state_tenant_isolation ON user_warehouse_state
  USING (tenant_id = current_setting('app.tenant_id')::varchar);

-- dimension_source already has a policy from the multi-tenant rollout; the reshape doesn't change it.
-- source_stat: same.
```

The migration itself runs as a `BYPASSRLS` role (the migration runner uses a connection string with `app_migrator`, not `app_user`). For the backfill specifically:
- The SQL backfill iterates every tenant via plain SELECT — no `SET LOCAL` needed under BYPASSRLS.
- The Bun-side `warehouse:backfill` script connects with the migrator role and likewise bypasses RLS.

If RLS is not yet enabled in the target environment when this migration lands, the `ALTER TABLE ... ENABLE` lines stay in but are no-ops until the multi-tenant rollout flips RLS on; the policy creation is harmless under disabled RLS.

### 7.4 Server-side rollout and rollback

- `registry.ts` rewritten to load credentials from `warehouse_connection`, key its cache by `(tenant_id, connection_id)`.
- `repo-shared.ts:332` (the scan path) takes a `databaseId` parameter; the warehouse-unreachable warnings now reference `database_name` from the row.
- The `tables.ts` and `repo-canonical.ts` insertions into `dimension_source` are updated to the new shape.
- The API layer accepts both the legacy `{ table, column }` and the new shape per §6.3.

**Adapter cache invalidation under horizontal scaling — TTL only.** The cache is a simple TTL map keyed by `(tenant_id, connection_id)`. Each entry stores the live adapter plus an `expiresAt` 60s in the future:

```ts
type CacheEntry = { adapter: WarehouseAdapter; expiresAt: number };
// hit when now() < entry.expiresAt
```

The pod that handled the PATCH evicts its own entry inline (`cache.delete(key)`), so the admin sees the new credentials immediately on their next call from sticky sessions. Other pods rely on the 60s TTL alone — no `credentials_version` re-check on the read path. Skipping the version re-check is deliberate: the version was the only way to make the TTL "fresh enough", but it required either a per-call DB roundtrip (defeats the cache) or trusting a stale comparison (defeats the version). 60s of cross-pod staleness is the explicit, named tradeoff.

When the master key rotates and `credentials_version` bumps on every row from the re-encrypt worker, that worker also issues a `LISTEN/NOTIFY warehouse_cache_invalidate` payload — that's the future-work hook noted in §10 if we ever need sub-60s propagation. Today: TTL only.

**Rollback.** The migration is forward-only in DDL terms, but the legacy `source_table` and `source_column` columns are kept (made nullable, not dropped) for one week post-deploy, and a feature flag `USE_NEW_WAREHOUSE` gates the new code path. If the migration goes wrong, the flag returns reads to the legacy path which reconstructs `source_table = schema_name || '.' || table_name` from the new columns (still populated) and reads `source_column = column_name`. The legacy columns are dropped in a follow-up migration after the rollback window closes; `tenant.warehouse_id` is dropped in the same follow-up.

**`tenant.warehouse_id` placeholder-write tech-debt window.** `tenant.warehouse_id` (schema line 281) stays `NOT NULL` until the follow-up rollback-window-closes migration drops it. During the rollback window, `provisionTenant()` continues to write the placeholder `'default'` to satisfy the constraint — see §7.6 for the updated function. Any future PR that drops the placeholder write before the column is gone will break tenant creation. The follow-up migration tracking issue is filed alongside this PR (`ZZ-XXX: drop tenant.warehouse_id after warehouse-multi-db rollback window`) so the cleanup doesn't get forgotten. Until the issue closes, the column is dead-weight metadata that every new tenant still has to populate.

Pre-deploy DB snapshot is mandatory regardless — the feature flag covers application-layer regressions but not data corruption in the new columns.

### 7.5 Client-side rollout

- The app gains the Warehouse page in the same PR as the migration.
- The source-registration form gains the database dropdown but defaults to "the single database" so existing flows feel unchanged.
- A one-time banner on first post-migration login: "Warehouse settings moved to Settings → Warehouse. Your existing sources are unchanged." Dismissible, persisted to `preferences`.

### 7.6 New-tenant provisioning (post-migration)

The migration backfills one `warehouse_connection` per *existing* tenant. New tenants created after Deploy 2 take an explicit path:

**`provisionTenant()` gains an optional `warehouse` block** (signature change at `server/src/tenant.ts:33`):

```ts
export async function provisionTenant(opts: {
  id: string;
  label: string;
  slug?: string;
  color?: string;
  warehouseId?: string;          // deprecated; placeholder write — see §7.4
  warehouse?: {
    adapter: 'motherduck' | 'duckdb_local';
    label: string;
    credentials: WarehouseCredentials;     // plaintext; encrypted before insert
    databases?: Array<{ databaseName: string; label?: string }>;   // optional; default []
  };
}): Promise<TenantRecord>
```

When `opts.warehouse` is present, `provisionTenant()` inserts the tenant row, then the encrypted `warehouse_connection`, then each `warehouse_database` row — **all in one transaction**. The encryption AAD uses the new tenant's id and the freshly-minted `wc_<32hex>` id (§4.9). If the transaction fails partway, the tenant is not created at all. This is the path that workspace-creation UI and admin-side bootstrap use.

When `opts.warehouse` is omitted, the tenant is created without a connection row. The admin lands on the Warehouse page empty state ("No warehouse connected — admins can add one to start scanning") and creates the connection via the regular `POST /api/warehouse/connection` flow. This is the OSS / dev path: a fresh workspace can be browsed, members can be added, but scans return empty until an admin connects a warehouse.

The dev-bootstrap script (`bun run bootstrap -- --seed`) populates the seed tenant with `opts.warehouse` set from `MOTHERDUCK_TOKEN` + `WAREHOUSE_DB`, so the seeded workspace works end-to-end out of the box. Without the env vars, the seed tenant is created without a warehouse — the empty state surfaces.

The `warehouseId` field on the signature is the §7.4 tech-debt note made concrete: until the follow-up migration drops `tenant.warehouse_id`, every call still passes `'default'` to satisfy the NOT NULL constraint. The field is marked `@deprecated` in the JSDoc with a pointer to the tracking issue.

---

## 8. Permissions, audit, and multi-tenant

- **`warehouse_connection`, `warehouse_database`, `dimension_source`, `source_stat`** — all carry `tenant_id`, all reads/writes go through `pg.ts` helpers under `tenant-middleware.ts`. Composite FKs are the second line of defense if the middleware layer ever slips. RLS policies (§7.3) are the third.
- **Connection writes** (POST/PATCH/DELETE on `/api/warehouse/connection`, POST `/replace`) are **admin-only**. Members and viewers see the connection metadata but can't edit credentials.
- **Database writes** are **editor+** for the non-destructive operations (add, edit label, non-force delete) and **admin** for `?force=true` delete (§5.4 rationale).
- **Audit log entries**:
  - `warehouse.connection.create` / `.update` / `.verify` / `.replace` / `.delete`
  - `warehouse.database.add` / `.remove`
  - `warehouse.legacy_default.set` (when an admin changes the legacy-shape default)
  - All entries store `metadata.adapter`, `metadata.label`. `update` actions store `metadata.changedFields` (e.g. `["label", "credentials"]`).
- **Snapshot fields for forensics.** Since `warehouse_database` has no `deleted_at` (§4.4), the `warehouse.database.remove` audit row's metadata snapshots `databaseName`, `databaseLabel`, `connectionId`, and `forced: true|false` at delete time. The bulk drops in `warehouse.connection.replace` snapshot per-database the same fields under `metadata.removedDatabases`. This is how an investigator answers "what database did `wd_7d8e9f...` actually point at?" after the row is gone — without paying the every-read `WHERE deleted_at IS NULL` overhead. `dimension.source.unbind` entries (emitted per source removed by `?force=true`) similarly snapshot the four-tuple (`databaseId`, `databaseName`, `schemaName`, `tableName`, `columnName`).
- **`changedFields` for credentials** — the server compares the incoming `credentials` plaintext's SHA-256 against `credentials_hash`. If they match, `credentials` is **not** added to `changedFields` (the user re-typed the same token) and `credentials_version` is **not** bumped. If they differ, `credentials` is added, the blob is re-encrypted, the hash is updated, and the version bumps. This avoids the "credentials always appears in changedFields because the field is present in the body" sloppy-audit problem.
- **The adapter cache** (`registry.ts`) is keyed by `(tenantId, connectionId)` with a 60s TTL; the pod that handled the PATCH evicts its own entry. Other pods learn via TTL expiry. See §7.4 for the rationale (no `credentials_version` re-check on the read path).
- **Super-admin impersonation** continues to work via the existing `impersonating_tenant_id` mechanism on `active_sessions` — the adapter resolver reads the effective tenant from the session, not from the URL. No new bypass surface. Engineer-mode views (§5.6) are gated to admin role on the *active* tenant (which includes impersonated super-admins, intentionally).

---

## 9. Edge cases

| Case | Behavior |
|---|---|
| Workspace has zero registered databases | `dimensions` page header shows a banner: "Register a database to start mapping sources." Source-registration form's Database dropdown is disabled with helper text "Add a database in Settings → Warehouse first." |
| Workspace has zero connection rows (newly created workspace, or dev without MotherDuck) | The default path for every newly provisioned tenant unless `provisionTenant({ warehouse })` is supplied at creation time (§7.6). The Warehouse page shows "No warehouse connected — admins can add one to start scanning"; today's `ATTACH_WAREHOUSE=false` banner pattern is reused. Distinct from "connected but empty/unreachable" which shows the `error` pill on the Warehouse card. Bootstrap creates **no connection row** for the seed tenant when `MOTHERDUCK_TOKEN` is unset; the UI's empty state is the source of truth. (Bootstrap does NOT silently fall back to `duckdb_local` against `:memory:` — dev should explicitly add a connection via the UI if they want one.) |
| `listDatabases()` returns empty (read-only token can't enumerate) | Discover zone in the picker shows "Could not enumerate — enter manually". Manual entry path still works. Not an error. |
| `listDatabases()` / `probeDatabase()` / `ping()` exceeds adapter timeout | Server-side `AbortController` fires after the timeout from §4.8 (10s / 5s / 5s respectively). The endpoint returns 504 with `kind: 'DISCOVERY_TIMED_OUT' \| 'PROBE_TIMED_OUT' \| 'PING_TIMED_OUT'`. The Add picker shows the manual-entry fallback with an inline "Adapter did not respond — try entering the database name directly." The Verify button surfaces the same as a coral pill. No retry loop; the user re-clicks if they want another attempt. |
| User enters a `databaseName` that doesn't exist on the engine | `adapter.probeDatabase()` fails; the picker shows the adapter's `reason` (e.g. "Catalog `xyz_db` not found"). Add button stays disabled. |
| Two admins PATCH credentials at the same time | First request wins; second returns **412 `PRECONDITION_FAILED`** because its `If-Match` carries the pre-bump `credentials_version` (see §6.1). The losing admin sees "Admin B updated credentials moments ago — refresh to see the latest, then re-submit." Their tab re-fetches; the second submit succeeds against the new version. |
| User renames the literal `databaseName` on the warehouse side | The connection still works for other databases, but every `dimension_source` referencing the old name returns empty scans. The renamed-database state surfaces only **on the next manual click** of "Verify connection" or the next user-driven `probeDatabase()` from the Add picker — there is no probe cron in this release. The Warehouse page caches `last_probe_at` so admins can see "last successful probe: 4 days ago" and notice the staleness; the database-row pill flips to `unreachable` with reason "Catalog not found." (planned: nightly probe cron — §10). The user must register the new name and re-bind sources. Editing `database_name` on an existing row is **not allowed** — it would silently invalidate every dependent source. |
| User renames a `schema` or `table` upstream | The connection succeeds, `probeDatabase()` succeeds (the catalog still exists), but scans for the affected `dimension_source` rows return zero distinct values. The system **does not detect this** automatically — there is no per-source probe and no scheduled scan-diff. The user notices via the Workbench's "0 unmapped values" state, opens the catalog drawer to see the table is missing, and re-binds the source to the new identifier. Best-effort detection (e.g., a once-a-day `listTables` diff) is a possible follow-up but not in this PR. |
| Connection credentials become invalid (token revoked) | `ping()` fails on next call; `last_verify_error` is set; the Warehouse card shows the error inline. Scans return empty with the "Warehouse offline" banner. No silent data loss — drafts and canonical writes are unaffected. |
| Master key is missing or wrong on process boot | Credential decryption fails with `WAREHOUSE_KEY_MISSING`; scans return empty; Warehouse card shows "Credentials cannot be decrypted — admins must re-enter to repair." `POST /api/warehouse/connection` (re-entry) succeeds and overwrites the unreadable blob. See §4.9. |
| User deletes the connection while databases exist | DELETE returns 409 `CONNECTION_IN_USE` with `{ databaseCount }`. UI prompts "Remove 3 databases first, or use Replace connection." |
| Adapter type change attempt via PATCH | Rejected. `PATCH /api/warehouse/connection` validates `adapter` is unchanged. Adapter swap is the Replace flow (§5.5). |
| Replace from multi-db adapter to single-db adapter while >1 db registered | Refused at picker step with the precondition message ("Remove all but one database before swapping to duckdb_local"). |
| Sources from before the migration | The migration backfills one `warehouse_database` row per tenant whose `database_name = env.WAREHOUSE_DB` (the value scans actually use today; `tenant.warehouse_id` is a placeholder string). `dimension_source` rows are rewritten to point at it. No re-registration. |
| Cross-tenant FK forgery via crafted `database_id` | Prevented by the composite FK `(tenant_id, database_id) → warehouse_database(tenant_id, id)` on both `dimension_source` and `source_stat`. Even if the API layer slipped, Postgres rejects the insert. RLS policies are the third line of defense. |
| Manual entry of `database_name` with quoting characters / SQL injection | `database_name` is regex-validated server-side against `^[A-Za-z_][A-Za-z0-9_]{0,254}$`; rejected otherwise. The adapter never interpolates raw `database_name` into SQL outside of `quoteIdentifier()`. |
| Scan in progress when its source's database is removed | `scan_run.source_id` is denormalized at scan time and kept verbatim (see §4.10). The Activity UI falls back to "(unresolved source)" for orphan ids. New scans for a removed database are impossible (no `dimension_source` row references it). |
| Old API client sends legacy shape after a 2nd database is added | Server resolves `databaseId` via `preferences.legacy_default_database_id`. If unset, returns 422 `BACKEND_LEGACY_SHAPE_AMBIGUOUS`. Admins are warned at 2nd-database-add time (§6.3). |
| Engineer-mode "View encrypted blob" attempted by non-admin | Action is admin-gated server-side; engineer mode flag alone is insufficient. The blob is still useless without the master key, but we don't ship the additional leak vector. |

---

## 10. Out of scope (with known limitations called out)

- **Multiple connections per workspace.** Schema-ready (drop the unique index); UI not in scope.
- **Snowflake / Postgres-as-warehouse adapter implementations.** The adapter contract (`probeDatabase`, `listDatabases`, `databaseTerm`, `maxIdentifierLength`) is shaped to accept them; the implementations are separate work that should land without further schema changes.
- **BigQuery adapter.** Explicitly deferred. BigQuery's three-level hierarchy (`project.dataset.table`) does not map cleanly onto a flat `warehouse_database.database_name`; a follow-up data-model PR will either add a `database_namespace` column or settle on a packed `project.dataset` literal. Until that decision lands, the spec only carries BigQuery as a forward-compat *intent*, not a guarantee. §4.8 calls this out.
- **Probe cron / scheduled staleness detection.** No background job re-runs `probeDatabase()` or diffs `listTables()`. Staleness surfaces only on user-initiated Verify clicks today. A nightly probe job is the obvious follow-up; we deferred it because the operational cost (per-tenant adapter calls every night) wants concrete numbers from production before committing.
- **Encryption key rotation flow.** The `credentials_version` column anticipates it; the actual re-encrypt-and-bump worker is a follow-up. **Key loss before rotation is permanent loss of every connection** — admins must re-enter credentials. Documented in §4.9 and `server/.env.example`.
- **KMS-backed credential storage** (Vault, AWS KMS, etc.). Same `encrypt_credentials` indirection; a different storage backend swaps the implementation. Same hooks as rotation.
- **Per-database permissions** (e.g., "viewers can see `analytics` but not `finance`"). All databases inherit workspace permissions. **Known limitation**: the moment a workspace registers a `finance_eu` database with PII, the admin/editor split at the connection level gives editors full read access to it. We expect this to come up in the first 3 months and will model per-database ACLs when the need is concrete.
- **A SQL editor.** Browsing only.
- **`writable: true` on MotherDuck.** Stays read-only this release; the `writable` flag survives in the credentials JSON but the UI never exposes it.
- **LISTEN/NOTIFY-based cache invalidation across pods.** §7.4 picks the 60s TTL alone; we'll revisit if ops sees tight-window staleness pain.
- **Dropping `tenant.warehouse_id`** — deferred to the follow-up rollback-window-closes migration (§7.4) so the column stays available as historical metadata for one week. The `provisionTenant()` placeholder write stays in place until the column is gone.
- **Soft-delete `deleted_at` on warehouse_database.** We considered it for forensics but chose the audit-metadata snapshot path (§8) instead; soft-delete adds per-read filtering overhead without the same direct-resolution UX the audit row gives.

---

## 11. Acceptance criteria

- A workspace admin can register a warehouse connection via the new Warehouse page; the credentials are stored encrypted (verified by a unit test that asserts the stored `credentials_encrypted` column is not the plaintext JSON).
- A workspace editor can add a database, manually or by clicking a discovered chip, with a successful `adapter.probeDatabase()` being the gate.
- The Warehouse page shows the connection's last-verified status, and clicking "Verify connection" updates it.
- Adding a source picks a `(database, schema, table, column)` 4-tuple; the dropdown defaults to the single registered database when only one exists; with multiple databases registered, the default falls back to `user_warehouse_state.recent_database_id` for the current user (set on the previous Bind); unreachable databases are visible and selectable (no schema/table/column pickers below).
- Removing a database with dependent sources surfaces the confirm modal; the destructive button is disabled until the checkbox is ticked; confirming requires admin and removes the `dimension_source` rows in a single transaction; canonical values remain.
- A scan against a registered database returns the same results as today's env-based path (regression test against the bootstrap seed).
- **Migration preflight**: on a dev DB with **no super-admin user**, the migration aborts at preflight A with the documented message and leaves the schema untouched (no `warehouse_connection` table created). With at least one super-admin, the migration proceeds.
- **Migration preflight**: on a dev DB with a `dimension_source.source_table` value of `'orders'` (no dot), the migration aborts at preflight B with the row listed in the error message; no DDL is applied.
- The migration runs cleanly on a snapshot of the dev DB (`tenant` × 3, `dimension_source` × ~40); every existing source maps to a single backfilled `warehouse_database` row whose `database_name = env.WAREHOUSE_DB`.
- The `warehouse:backfill` script populates `credentials_encrypted` and `credentials_hash` for every connection, refuses to clobber non-placeholder rows, and is idempotent.
- **New-tenant provisioning**: `provisionTenant({ id, label, warehouse: { adapter, label, credentials, databases } })` creates the tenant row, connection, and N database rows in a single transaction; on intentional failure of the database insert, neither the tenant nor the connection is committed. `provisionTenant({ id, label })` (no `warehouse` block) creates just the tenant; the admin sees the empty-state Warehouse page.
- Audit log shows `warehouse.connection.create` and `warehouse.database.add` entries with the right `tenant_id` and never the credential payload. PATCH that re-sends the same credentials does **not** add `credentials` to `changedFields` and does **not** bump `credentials_version`.
- **Audit snapshot for forensics**: `warehouse.database.remove` rows include `metadata.databaseName`, `metadata.databaseLabel`, `metadata.connectionId`, `metadata.forced` — verified by inspecting the row after a DELETE.
- **PATCH concurrency (412)**: two PATCH requests sent in parallel with the same `If-Match: 7` from the same starting state — the first returns 200 with `credentialsVersion: 8`; the second returns 412 with `{ kind: 'STALE_VERSION', currentVersion: 8 }`. The losing client's UI surfaces the refresh prompt.
- **Adapter timeouts**: a `listDatabases()` mocked to hang for 11s returns 504 `DISCOVERY_TIMED_OUT` to the API caller; the Add picker shows the manual-entry fallback. Same for `probeDatabase()` at 6s → 504 `PROBE_TIMED_OUT`.
- The cache TTL test: after PATCHing credentials on pod A, pod B serves a fresh adapter within 60s without explicit restart. (No version check is exercised by this test — only the TTL.)
- Engineer-mode shows `wd_<32hex>` and `wc_<32hex>` identifiers next to the user-facing labels; "View encrypted blob" requires admin role and is preceded by a lock-icon button + confirm dialog; cipher details hidden behind an info-icon hover.
- The legacy API shape is accepted for one release with a `Deprecation: true` response header. After a 2nd database is added, legacy clients resolve via `preferences.legacy_default_database_id`; **with `legacy_default_database_id = NULL` (admin cleared it), a legacy-shape POST returns 422 `BACKEND_LEGACY_SHAPE_AMBIGUOUS` and the body lists the candidate `warehouse_database` rows.**
- No endpoint accepts a `database_id` belonging to a different tenant (verified by an integration test using a forged request body; composite FK and RLS both block it).
- **Composite-FK migration verification**: `bun run db:generate` emits a migration whose `dimension_source_database_fk` and `warehouse_database_connection_fk` constraints reference the composite `(tenant_id, id)` / `(tenant_id, connection_id)` tuples. The generated SQL is reviewed in the PR.
- **Identifier length enforcement**: `POST /api/warehouse/databases { databaseName: 'a'.repeat(256) }` returns 422 with the cap. With an adapter that declares `maxIdentifierLength: 63`, a 64-char name is rejected with `max 63` in the error message.
- **Probe staleness UX**: a database whose upstream catalog has been deleted shows `last_probe_at` from N days ago and the `unreachable` pill only after the user re-runs "Verify connection" — there is no background poll. The source-form dropdown still includes the row.
- **Add picker fallback**: when `listDatabases()` returns `[]`, the Discover zone shows the "Could not enumerate — enter manually" copy and the Manual entry field accepts input that successfully probes and adds a row.
- **Replace connection atomicity**: an admin can swap MotherDuck → MotherDuck (different token) by mapping each old `warehouse_database` to a target; sources move atomically. **A test that intentionally makes one `UPDATE dimension_source.database_id` fail mid-commit rolls back the entire transaction — the old connection and database rows remain intact, no partial state survives.** Single-db adapter swap is refused when >1 db is registered.
- Key-loss recovery: with `WAREHOUSE_ENCRYPTION_KEY` set to a wrong value, scans surface `WAREHOUSE_KEY_MISSING`; an admin can re-POST credentials via the UI and recover.
