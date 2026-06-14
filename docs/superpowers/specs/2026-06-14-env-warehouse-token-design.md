# Env-Sourced Warehouse Token — Design Spec

**Date:** 2026-06-14
**Scope:** Replace Track C's per-tenant encrypted warehouse credentials with a single deployment-wide warehouse adapter configured via environment variables. Collapse `warehouse_database` to deployment-global. Restrict warehouse-database management to super-admins.

---

## Background

Track C (merged 2026-06-14, migration `0021`) added per-tenant `warehouse_connection` rows with encrypted MotherDuck credentials, an `AES-256` encryption key in env (`WAREHOUSE_ENCRYPTION_KEY`), and per-tenant `warehouse_database` rows scoped via composite FKs. The design assumed multi-tenant SaaS semantics: each tenant has its own MotherDuck account, its own credentials, and its own private set of databases.

Zugzug isn't that. It's a self-hosted team tool: one deployment, one organization. Workspaces are switchable views (think Linear teams), not isolated SaaS tenants — that's already captured in `project-multi-tenant-model.md`. The encryption layer, per-tenant credential storage, credential rotation tooling, and backfill script are all building infrastructure that no actual deployment uses.

This spec strips the per-tenant credential layer back out. It keeps the parts of Track C that *are* valuable — the multi-database UI, the probe/registration flow, the dimension-source qualification (`databaseId, schemaName, tableName, columnName`) — and removes the parts that aren't.

The change is small in concept (drop a table, drop a column) but touches many code paths because Track C threaded `tenantId` through the adapter factory and credential lookup. Surfacing as a single migration `0023` + a coordinated code refactor is the right shape.

---

## Goals / Non-goals

**Goals**
- Warehouse credentials live in `.env`, not Postgres. One token per deployment.
- `warehouse_database` is deployment-global. Same set of databases visible in every workspace.
- Only super-admins can add/remove warehouse databases (a deployment-level resource → deployment-level role).
- The `warehouse_database` UI (list / add / rename / remove / probe) keeps working — only the connection layer goes away.
- Migration `0023` is one transaction, idempotent-where-safe, with explicit preflight and a clean rollback story.
- The adapter abstraction (DuckDB/MotherDuck, Snowflake stub) stays — so a real Snowflake adapter could land later without re-architecting.

**Non-goals**
- A real Snowflake adapter. The stub stays a stub; `WAREHOUSE_ADAPTER=snowflake` fails to boot.
- Per-workspace warehouse credentials. Intentionally removed; not coming back.
- Multi-warehouse-account support (one MotherDuck + one BigQuery in one deployment). A user who wants two warehouses runs two deployments.
- Credential rotation tooling. There's nothing to rotate at runtime; edit `.env` and restart.
- Background health monitoring. Health is on-demand only, surfaced via `GET /api/warehouse/health` when the UI asks.
- Warehouse credential audit log. Nothing runtime-editable. Boot-time validation failures still log via the existing startup-error path.

---

## The Design

### Env config & adapter selection

**Env vars (after change):**

```bash
WAREHOUSE_ADAPTER=motherduck      # NEW — required when ATTACH_WAREHOUSE=true
MOTHERDUCK_TOKEN=<token>          # required when WAREHOUSE_ADAPTER=motherduck
ATTACH_WAREHOUSE=true             # unchanged — gates whether warehouse calls run
# WAREHOUSE_ENCRYPTION_KEY=…      # REMOVED
```

Future adapters (out of scope): `WAREHOUSE_ADAPTER=snowflake` would require `SNOWFLAKE_USER` / `SNOWFLAKE_PASSWORD` / `SNOWFLAKE_ACCOUNT`, validated only when that adapter is selected. Today, only `motherduck` is accepted.

**Boot-time validation in `server/src/env.ts`:**

| ATTACH_WAREHOUSE | WAREHOUSE_ADAPTER | Credential vars | Result |
|---|---|---|---|
| false | (anything) | (anything) | OK — warehouse calls return a no-op stub at runtime |
| true | unset | (anything) | Fail to boot: "WAREHOUSE_ADAPTER required when ATTACH_WAREHOUSE=true" |
| true | "motherduck" | MOTHERDUCK_TOKEN unset | Fail to boot: "MOTHERDUCK_TOKEN required for motherduck adapter" |
| true | "motherduck" | MOTHERDUCK_TOKEN set | OK — adapter constructed lazily on first use |
| true | "snowflake" | (anything) | Fail to boot: "Snowflake adapter is a stub; not yet supported" |
| true | (anything else) | (anything) | Fail to boot: "Unknown WAREHOUSE_ADAPTER: ..." |

Adapter *health* is not checked at boot. Connection errors surface lazily at first warehouse call, with the existing UI surfaces for "warehouse unreachable." This matches today's `ATTACH_WAREHOUSE` lazy mode and avoids a boot-time external dependency.

### Adapter factory

`server/src/warehouse/registry.ts:getAdapter(tenantId)` currently:
1. Loads the tenant's `warehouse_connection` row.
2. Decrypts credentials with `WAREHOUSE_ENCRYPTION_KEY`.
3. Instantiates the adapter (DuckDB or Snowflake).
4. Caches it per-tenant.

After the change, `getAdapter()` (no parameter):
1. Reads `env.warehouseAdapter` + the relevant env credentials.
2. Instantiates the adapter once.
3. Returns the cached singleton.

Every call site that passes `tenantId` to `getAdapter` gets a quick refactor: drop the parameter. Grep returns a finite list (see `server/src/server.ts:810, 842, 979, 1052` for the existing inline `await import("./warehouse/registry.ts")` calls; all become `getAdapter()`).

### Permissions model

Adding or removing a warehouse database is a deployment-level decision (it changes what every workspace sees). Gated by **super-admin** (the role that already gates `/api/admin/*` routes). Workspace-level `curate` permission continues to gate everything *within* a workspace — sources, dimensions, mappings — but cannot add new MotherDuck databases.

Reading the database list and browsing tables is allowed for any authenticated user. The data is shared across workspaces, so workspace membership doesn't gate visibility.

### View preferences stay per-workspace

Per the multi-tenant model: `user_warehouse_state.recent_database_id` (per-user-per-workspace "last DB I looked at") and `preferences.legacy_default_database_id` (per-workspace default DB for new dims) stay per-workspace. Only their FK target changes (no longer composite on `tenant_id`).

The rationale: even when databases are deployment-global, *which* database a user defaults to is a workspace-level preference. A workspace named "Marketing" probably defaults to `analytics_prod`; a workspace named "Finance" defaults to `billing_prod`. Reverting these to a per-user-deployment-global default would lose useful per-workspace context.

---

## Data model

### `warehouse_connection` — DROPPED

Entire table removed. Migration drops the table, which auto-drops its RLS policy. No replacement.

### `warehouse_database` — collapsed

Before:
```sql
warehouse_database (
  id, tenant_id, connection_id, database_name, label,
  last_probe_at, last_probe_error, added_at, added_by,
  PRIMARY KEY (tenant_id, id),
  FK (tenant_id, connection_id) -> warehouse_connection
)
```

After:
```sql
warehouse_database (
  id            varchar PRIMARY KEY,
  database_name varchar(255) UNIQUE NOT NULL,
  label         varchar(255),
  last_probe_at timestamp,
  last_probe_error text,
  added_at      timestamp NOT NULL,
  added_by      varchar NOT NULL
)
```

- `tenant_id` and `connection_id` columns dropped.
- New `UNIQUE (database_name)` constraint replaces the old `(tenant_id, connection_id, database_name)` composite uniqueness.
- `added_by` keeps the user id of whoever registered the DB (now necessarily a super-admin).
- RLS policy `warehouse_database_tenant_isolation` dropped; `ROW LEVEL SECURITY` disabled on the table.

### `dimension_source` and `source_stat`

Their `database_id` columns stay. The composite FK `(tenant_id, database_id) → warehouse_database(tenant_id, id)` is replaced with a single-column FK `database_id → warehouse_database(id)`. `ON DELETE` semantics stay the same as today (`RESTRICT` for `dimension_source`, `CASCADE` for `source_stat`).

### `user_warehouse_state`

Stays per-workspace. Its `recent_database_id` FK changes from composite to single-column: `(tenant_id, recent_database_id) → warehouse_database(tenant_id, id)` becomes `recent_database_id → warehouse_database(id)`. `ON DELETE SET NULL` semantics unchanged.

### `preferences.legacy_default_database_id`

Stays per-workspace. No FK was declared in 0021 (per the migration), so no FK change. The application-layer reads continue to work.

### `dimension` (Track B's `ordering_mode`, `last_rebalanced_at`)

Unchanged. Row ordering is orthogonal to warehouse config.

---

## API surface

### Endpoints DELETED

- `GET /api/t/:slug/warehouse/connection`
- `POST /api/t/:slug/warehouse/connection`
- `PATCH /api/t/:slug/warehouse/connection`
- `DELETE /api/t/:slug/warehouse/connection`
- `POST /api/t/:slug/warehouse/connection/verify`

### Endpoints MOVED out of per-tenant scope

| Old | New | Auth |
|---|---|---|
| `GET /api/t/:slug/warehouse/databases` | `GET /api/warehouse/databases` | any authenticated user |
| `GET /api/t/:slug/warehouse/databases/available` | `GET /api/warehouse/databases/available` | super-admin |
| `POST /api/t/:slug/warehouse/databases` | `POST /api/warehouse/databases` | super-admin |
| `PATCH /api/t/:slug/warehouse/databases/:id` | `PATCH /api/warehouse/databases/:id` | super-admin |
| `DELETE /api/t/:slug/warehouse/databases/:id` | `DELETE /api/warehouse/databases/:id` | super-admin |

`DELETE` keeps the existing rule: refuses while any `dimension_source` row references the database.

### Endpoints STAYING per-tenant (data queries within a workspace context)

- `GET /api/t/:slug/warehouse/tables?database_id=…` — list tables in a registered database. Gated by tenant membership.

### New endpoint

- `GET /api/warehouse/health` — calls `adapter.ping()` (Track C already exposes `ping`). Returns `{ ok: true }` or `{ ok: false, reason: string }`. Any authenticated user; used by Settings and the Dashboard tile.

### `/api/admin/warehouses` → `/api/admin/warehouse`

Renamed singular. The handler today (around `server.ts:334`) lists per-tenant warehouses with credential health. After the change, it returns one read-only object:

```ts
{
  adapter:        "motherduck",
  configuredFrom: "env",
  envVarName:     "MOTHERDUCK_TOKEN",     // for engineer-mode reveal
  bootValidation: { ok: true } | { ok: false, reason: string },
  databases:      Array<{ id, database_name, label, last_probe_at, last_probe_error, sourceCount }>,
}
```

No credential-state fields. Used by the admin shortcut tile only — the Settings page already has the same data via `/api/warehouse/databases`.

---

## UI surface

### Settings → Warehouse (`app/src/routes/settings/Warehouse.tsx`)

Restructured as a single section: **"Warehouse databases"**.

```
─── Warehouse databases ──────────────────────
MotherDuck · 3 databases registered            [+ Add database]   <- super-admin only
                                               from env: MOTHERDUCK_TOKEN  <- engineer mode only

  prod_analytics    "Analytics prod"   16 sources    probed 3m ago   [Rename] [Remove]
  staging           "Staging"           2 sources    probed 1h ago   [Rename] [Remove]
  sandbox            (no label)         0 sources    probed —        [Rename] [Remove]
```

- Non-super-admin users see the table read-only — no Add button, no Rename/Remove affordances.
- Engineer mode reveal: small mono line under the header showing the env var the token came from.
- The existing `DatabaseTable.tsx`, `AddDatabaseDialog.tsx`, `RemoveDatabaseConfirm.tsx` components keep working; only their callers change to hit the new endpoints.

### Components DELETED

- `app/src/components/warehouse/WarehouseCard.tsx` — the connection/credentials card has nothing left to show beyond the page header line.
- The "Edit credentials" modal scaffold (T19 in Track C was a stub, per the `TODO T19` comment at `Warehouse.tsx:90`).

### Dashboard "Warehouse" tile (`app/src/routes/Dashboard.tsx:157+`)

- Health pill stays. `HealthBadge` reads `GET /api/warehouse/health` instead of `/warehouse/connection`.
- The "current default database" line stays (per-workspace, from preferences).
- Admin link (`to="/app/admin/warehouses"`) repointed to `/app/admin/warehouse` (renamed singular per `/api/admin/warehouse` rename above).

### Catalog explorer

Today the explorer fetches `/api/t/:slug/warehouse/tables`. Continues to use the per-tenant path (data queries stay tenant-membership-gated). Request body / query string unchanged; `database_id` already required.

### Admin route `/app/admin/warehouse`

Today: lists per-tenant warehouses with health badges. After: a single read-only view of the deployment adapter with boot-validation result, env var name, and the same database list as Settings (with `sourceCount`). Useful as a super-admin shortcut from the admin index; conceptually a sibling of the Settings page, not a separate domain.

---

## Migration `0023`

Single migration file, idempotent-where-safe DDL, runs in one transaction. Drizzle generates the bulk; the collapse/repoint section is hand-written in a DO block.

```sql
-- 0023_warehouse_env_token.sql
-- Strip per-tenant warehouse credentials; collapse warehouse_database to
-- deployment-global. After this migration, MOTHERDUCK_TOKEN comes from env.

BEGIN;

-- 1. Preflight: every warehouse_database row must point at a non-empty database_name.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM zugzug_app.warehouse_database
   WHERE database_name IS NULL OR length(database_name) = 0;
  IF bad > 0 THEN
    RAISE EXCEPTION '[warehouse_env_token] preflight: % warehouse_database rows have empty database_name', bad;
  END IF;
END $$;

-- 2. Pick a survivor per database_name (lexicographically smallest id).
CREATE TEMP TABLE _db_survivor AS
SELECT database_name, MIN(id) AS survivor_id
  FROM zugzug_app.warehouse_database
 GROUP BY database_name;

-- 3. Repoint FKs to survivors.
UPDATE zugzug_app.dimension_source ds
   SET database_id = s.survivor_id
  FROM zugzug_app.warehouse_database wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE ds.database_id = wd.id AND wd.id <> s.survivor_id;

UPDATE zugzug_app.source_stat ss
   SET database_id = s.survivor_id
  FROM zugzug_app.warehouse_database wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE ss.database_id = wd.id AND wd.id <> s.survivor_id;

UPDATE zugzug_app.user_warehouse_state uws
   SET recent_database_id = s.survivor_id
  FROM zugzug_app.warehouse_database wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE uws.recent_database_id = wd.id AND wd.id <> s.survivor_id;

UPDATE zugzug_app.preferences p
   SET legacy_default_database_id = s.survivor_id
  FROM zugzug_app.warehouse_database wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE p.legacy_default_database_id = wd.id AND wd.id <> s.survivor_id;

-- 4. Delete loser rows.
DELETE FROM zugzug_app.warehouse_database
 WHERE id NOT IN (SELECT survivor_id FROM _db_survivor);

-- 5. Drop FKs that target the composite (tenant_id, id) key on warehouse_database.
ALTER TABLE zugzug_app.dimension_source     DROP CONSTRAINT dimension_source_database_fk;
ALTER TABLE zugzug_app.source_stat          DROP CONSTRAINT source_stat_database_fk;
ALTER TABLE zugzug_app.user_warehouse_state DROP CONSTRAINT user_warehouse_state_recent_db_fk;

-- 6. Drop warehouse_database's composite PK, tenant_id, connection_id; add single-col PK + unique.
ALTER TABLE zugzug_app.warehouse_database
  DROP CONSTRAINT warehouse_database_tenant_id_id_pk;
ALTER TABLE zugzug_app.warehouse_database
  DROP COLUMN tenant_id,
  DROP COLUMN connection_id;
ALTER TABLE zugzug_app.warehouse_database
  ADD CONSTRAINT warehouse_database_pk PRIMARY KEY (id),
  ADD CONSTRAINT warehouse_database_database_name_uniq UNIQUE (database_name);

-- 7. Recreate single-column FKs.
ALTER TABLE zugzug_app.dimension_source
  ADD CONSTRAINT dimension_source_database_fk
    FOREIGN KEY (database_id) REFERENCES zugzug_app.warehouse_database(id)
    ON DELETE RESTRICT;
ALTER TABLE zugzug_app.source_stat
  ADD CONSTRAINT source_stat_database_fk
    FOREIGN KEY (database_id) REFERENCES zugzug_app.warehouse_database(id)
    ON DELETE CASCADE;
ALTER TABLE zugzug_app.user_warehouse_state
  ADD CONSTRAINT user_warehouse_state_recent_db_fk
    FOREIGN KEY (recent_database_id) REFERENCES zugzug_app.warehouse_database(id)
    ON DELETE SET NULL;

-- 8. Drop RLS on warehouse_database (deployment-global now).
DROP POLICY IF EXISTS warehouse_database_tenant_isolation ON zugzug_app.warehouse_database;
ALTER TABLE zugzug_app.warehouse_database DISABLE ROW LEVEL SECURITY;

-- 9. Drop warehouse_connection entirely.
DROP TABLE zugzug_app.warehouse_connection;

COMMIT;
```

**Drizzle schema (`server/drizzle/schema.ts`):**
- `warehouseConnection` table definition deleted.
- `warehouseDatabase`: drop `tenant_id`, `connection_id`, the composite PK. Add `primaryKey(t.id)` and `uniqueIndex` on `t.database_name`.
- `dimensionSource`: the composite FK on `(tenant_id, database_id)` simplifies to a single-column FK on `database_id`.
- `sourceStat`: same.
- `userWarehouseState`: same.

After schema edits, `bun run db:generate` produces the matching migration scaffold; the DO block above is appended by hand.

**Code changes that pair with the migration (must merge in the same PR):**

- `server/src/warehouse/credentials.ts` — DELETED.
- `server/src/warehouse/crypto.ts` — DELETED. Verify no other callers with `grep -rn "from.*warehouse/crypto"`.
- `server/src/warehouse/registry.ts` — `getAdapter(tenantId)` becomes `getAdapter()`; reads `env.warehouseAdapter` + env credentials; returns a cached singleton.
- `server/src/env.ts` — `WAREHOUSE_ENCRYPTION_KEY` removed from the required-vars check; `WAREHOUSE_ADAPTER` added with the validation matrix above.
- `server/src/server.ts` — `/warehouse/connection*` route handlers deleted; `/warehouse/databases*` handlers move from the `/api/t/:slug/warehouse/...` block to a new `/api/warehouse/...` block with a super-admin gate on writes; `/api/warehouse/health` route added; `/api/admin/warehouses` renamed `/api/admin/warehouse` with the new response shape.
- `server/scripts/warehouse-backfill.ts` — DELETED. It backfilled encrypted credentials.
- `app/src/routes/settings/Warehouse.tsx` — restructured (see UI section).
- `app/src/components/warehouse/WarehouseCard.tsx` — DELETED.
- `app/src/routes/Dashboard.tsx` — `HealthBadge` source repointed to `/api/warehouse/health`; admin link updated.
- `.env.example` — `WAREHOUSE_ENCRYPTION_KEY` line removed; `WAREHOUSE_ADAPTER=motherduck` line added.

**Rollback:** The migration runs in one transaction; partial failure rolls back atomically. Re-running after a fix is safe — survivor-by-`database_name` is deterministic, all `UPDATE`s are idempotent given the same input data. There is no automatic downgrade path back to per-tenant credentials; if a deployment needs to revert, it restores from backup and re-pulls a pre-`0023` build.

---

## Edge cases

| Case | Behaviour |
|---|---|
| One tenant has two `warehouse_database` rows pointing at the same `database_name` (shouldn't happen but possible via API misuse) | Migration step 2 picks the lexicographically smallest `id` as survivor. Step 3 repoints any FK references on the losers. Step 4 deletes losers. |
| A tenant's preferences default database becomes the survivor of *another* tenant's row | Acceptable. The `database_name` is the same; only the `id` changes. Subsequent reads see the survivor, label may differ if the tenants used different labels. The first-merged label wins (smallest id). |
| `MOTHERDUCK_TOKEN` is wrong at runtime | First `getAdapter()` call instantiates the adapter; the first warehouse query raises. UI already has the "warehouse unreachable" surface (today's `ATTACH_WAREHOUSE=true` + bad token case). |
| `MOTHERDUCK_TOKEN` env var rotated, server not restarted | Adapter singleton is cached. The deployment owner restarts the server; this is acceptable for an env-config tool. No hot reload. |
| Super-admin removes a database that has source references | Existing behaviour (`ON DELETE RESTRICT` on `dimension_source.database_id`) blocks the delete. UI surfaces "X dimensions still reference this database." |
| Non-super-admin tries `POST /api/warehouse/databases` via direct API call | 403 from the middleware before the handler runs. |
| Non-super-admin sees a database row in the Settings page | They see the row read-only; Rename/Remove affordances are hidden. |
| `GET /api/warehouse/health` while `ATTACH_WAREHOUSE=false` | Returns `{ ok: true, reason: "warehouse_disabled" }`. UI renders a muted state, not an alarm. |
| Boot with `WAREHOUSE_ADAPTER=motherduck` but `MOTHERDUCK_TOKEN=""` (empty string, not unset) | Treated as unset. Boot fails with the same error. |
| Two different `database_name` values that happen to point at the same physical MotherDuck DB | Allowed; the unique constraint is on the *registered name string*, not the physical database. Each registered name gets its own row. This is the same behaviour as Track C. |

---

## Permissions and multi-tenant

- `GET /api/warehouse/databases` — any authenticated user.
- `GET /api/warehouse/databases/available` — super-admin only.
- `POST /api/warehouse/databases` — super-admin only.
- `PATCH /api/warehouse/databases/:id` — super-admin only.
- `DELETE /api/warehouse/databases/:id` — super-admin only.
- `GET /api/warehouse/health` — any authenticated user.
- `GET /api/admin/warehouse` — super-admin only.
- `GET /api/t/:slug/warehouse/tables` — tenant membership in `:slug`.

Workspace `curate` permission continues to gate all *within-workspace* operations: dimensions, mappings, drafts, sources, ordering. No changes to those gates.

The deletion of `warehouse_connection` removes one place where per-tenant data lived but the workspace itself stays scoped — `tenant_id` continues on `dimension_source`, `source_stat`, `user_warehouse_state`, `preferences`, and every `dim_*` / `map_*` row.

---

## Rollout

**Day 0 — order of operations:**

1. **Code merge first.** The migration file, schema edit, env-validation update, deleted credential files, route refactor, and UI changes all ship in one PR. Splitting them would leave the server unable to boot in the gap.
2. **Pre-deploy: update `.env`.** Add `WAREHOUSE_ADAPTER=motherduck`. Remove `WAREHOUSE_ENCRYPTION_KEY`. The boot-time check rejects deployment if `WAREHOUSE_ADAPTER` is unset, so this must happen before restart.
3. **Deploy code.** Server boots only if step 2 completed.
4. **Run migration.** `bun run db:migrate` applies `0023`. The single-transaction shape means either it lands fully or nothing changes.

**Day 1+ — observability:**

- Boot-time env validation logs the adapter selection on success and the specific missing-var on failure.
- `GET /api/warehouse/health` is the single point for runtime monitoring. External monitoring can poll it; failure surfaces in the UI via the existing health badges.

**Rollback story:**

If `0023` fails partway: Postgres rolls back the transaction; the server keeps running on the pre-`0023` schema. The deploy operator fixes the underlying cause (most likely an unexpected FK constraint) and re-runs.

If the rollout itself needs to be reverted (e.g. a critical bug in the env-token path): restore the Postgres database from backup, deploy the pre-`0023` code build, restore `WAREHOUSE_ENCRYPTION_KEY` in `.env`. There is no in-place downgrade migration; this is a one-way change.

---

## Out of scope (recorded for future)

- **Real Snowflake adapter.** The stub in `server/src/warehouse/snowflake/` stays a stub. `WAREHOUSE_ADAPTER=snowflake` boot-rejects until the adapter is implemented.
- **Credential rotation tooling.** Edit `.env` and restart. No runtime rotation.
- **Per-workspace MotherDuck token override.** Intentionally rejected. Would re-introduce per-tenant credential storage.
- **Multi-warehouse-account support** (one MotherDuck + one BigQuery in one deployment). Out of scope; multiple deployments cover this.
- **Background warehouse health monitoring.** No poller. `/api/warehouse/health` is on-demand.
- **Warehouse credential audit log.** Nothing runtime-editable to audit.
- **Hot reload of `MOTHERDUCK_TOKEN`.** Adapter singleton is cached. Rotate by restart.

---

## Acceptance criteria

**Positive criteria (the feature works):**

- `WAREHOUSE_ADAPTER=motherduck` + valid `MOTHERDUCK_TOKEN` + `ATTACH_WAREHOUSE=true` → server boots, warehouse calls succeed, `GET /api/warehouse/health` returns `{ ok: true }`.
- `ATTACH_WAREHOUSE=false` → server boots with no warehouse env vars set; warehouse calls return a no-op stub; `/api/warehouse/health` returns `{ ok: true, reason: "warehouse_disabled" }`.
- After migration `0023`: `warehouse_connection` is gone (`SELECT to_regclass('zugzug_app.warehouse_connection') IS NULL`); `warehouse_database` has no `tenant_id` or `connection_id` columns; `UNIQUE (database_name)` is enforced.
- Every `dimension_source.database_id` and `source_stat.database_id` after migration points at a row that exists in the post-migration `warehouse_database`.
- `GET /api/warehouse/databases` returns the same JSON regardless of which workspace the caller is in (verifiable by a test that switches `tenant_id` between calls).
- A super-admin can `POST /api/warehouse/databases` and the new row is visible in every workspace's Settings page.
- A non-super-admin curator gets 403 on `POST /api/warehouse/databases`, and the Add Database button doesn't render in their Settings page.
- The Catalog Explorer in any workspace can browse tables in any registered database.
- Engineer-mode reveal on Settings → Warehouse shows `from env: MOTHERDUCK_TOKEN`.
- The migration runs in one transaction; rolling back partway leaves the schema at pre-`0023` state.

**Anti-criteria (what the test suite must enforce should never happen):**

- No code path under `server/src/` references `WAREHOUSE_ENCRYPTION_KEY` after the change. Grep confirms zero matches.
- No code path under `server/src/` references `warehouse_connection`. Grep confirms zero matches except the migration file itself.
- `getAdapter` is never called with a `tenantId` argument. Type system enforces this once the signature changes.
- A non-super-admin user cannot mutate `warehouse_database` via direct API call — every mutation route checks super-admin before reading the body.
- The migration never deletes a `warehouse_database` row whose `id` is referenced by `dimension_source.database_id` or `source_stat.database_id`. Step 3 repoints first; step 4 only deletes losers, which by definition have nothing pointing at them after step 3.
- `MOTHERDUCK_TOKEN` is never written to any database row (no replacement for the encrypted-credentials table).
- A non-super-admin user GETing `/api/warehouse/databases` succeeds (read is unrestricted); a non-super-admin GETing `/api/warehouse/databases/available` returns 403 (write-adjacent discovery is admin-only).
