# Phase 3 — Canonical-store modes (design spec)

**Date:** 2026-06-08
**Status:** approved (brainstorming complete; ready for implementation planning)
**Supersedes:** the Phase 3 section in `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (this is the implementation-grade refinement; the parent spec stands)

---

## Goal

Cash in the canonical-store-mode decision from the parent OSS-pivot spec: route `commit()` through the warehouse adapter when the configured adapter is writable, fall back to Postgres-only + on-demand Parquet snapshots when read-only. Surface the canonical destination + commit semantics in the UI so users see what's happening.

## What Phase 3 is NOT

- Real Snowflake validation. The `SnowflakeAdapter` write path (`commitCanonical`) still carries `// LIVE-VALIDATION:` markers from Phase 2. Phase 3 exercises the branching logic against the mocked adapter; live testing against a real warehouse remains deferred until credentials exist.
- Per-workspace credential storage in Postgres. That's Phase 4. Until then, `getAdapter()` reads from env via `envCredentials()` and returns a DuckDB adapter — meaning the writable branch's runtime behavior is essentially unreachable in production until someone hand-edits `registry.ts` to return a Snowflake credential blob.
- Workspace-upgrade backfill. If a workspace flips read-only → writable, the warehouse starts empty; manual sync is documented but not built (deferred — see "Out of scope" below).
- API-token auth on the snapshot endpoint. Phase 4 adds API tokens; the endpoint uses session-cookie auth only in v1.

---

## Strategic decisions (locked during 2026-06-08 brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| **`exportCanonicalSnapshot` location** | **Standalone server utility**, not a method on `ReadOnlyWarehouseAdapter` | The method reads from Postgres canonical (not the warehouse) and uses DuckDB as a Parquet utility. Putting it on the adapter was a leak. Standalone means Snowflake-configured users can also download Parquet backups. |
| **Atomicity** | **Warehouse MERGE after Postgres pgTx commit; log failures** | Postgres stays the source of truth; warehouse is a mirror. Warehouse failures get an audit event + dashboard surface; manual resync. No 2PC contortion. |
| **Workspace-upgrade backfill** | **Deferred — manual, not v1** | Document the gap. Phase 4 admin UI can add a "Rebuild warehouse from Postgres" button when credential management lands. |
| **Snapshot endpoint auth** | **Session-cookie only** | API tokens are Phase 4; cookie auth is what exists today. |
| **Sync status tracking** | **Audit log, no new schema** | New audit event types (`"Warehouse synced"`, `"Warehouse sync failed"`) feed both the dashboard activity feed AND a per-dimension "needs resync" badge derived from the latest event per dimension. |

---

## Architecture

### Module structure (post-phase)

```
server/src/warehouse/
  parquet-exporter.ts          # NEW — standalone Parquet writer (uses an always-in-process DuckDB)
  registry.ts                  # unchanged
  adapter.ts                   # unchanged (the spec-leak comment about exportCanonicalSnapshot stays, since we're moving it OUT of the adapter; might update the comment text)
  duckdb/index.ts              # unchanged
  snowflake/index.ts           # unchanged
server/src/
  repo-drafts.ts               # commit() branches on isWritable(adapter)
  server.ts                    # adds GET /api/dimensions/:id/snapshot.parquet + GET /api/workspace/info routes
app/src/
  routes/Dashboard.tsx         # adds canonical-destination badge + "needs resync" hint per dimension
  routes/Triage.tsx            # commit-affordance copy per mode
  store.ts                     # adds workspace.info fetch + sync-status derived state
```

### Interface change: `ReadOnlyWarehouseAdapter`

Remove `exportCanonicalSnapshot` from the interface. The method moves to the standalone utility.

```ts
// Before (in adapter.ts):
export interface ReadOnlyWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false };
  exportCanonicalSnapshot(dim: DimensionSpec, format: 'parquet' | 'csv'): Promise<Buffer>;  // ← delete
}

// After:
export interface ReadOnlyWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false };
}
```

(Note: `ReadOnlyWarehouseAdapter` currently has no `exportCanonicalSnapshot` method — it was sketched in the spec but never implemented since Phase 1 already made the simplification. So this "change" is actually a no-op against current code; documenting for completeness.)

### `parquet-exporter.ts` — the standalone utility

```ts
// server/src/warehouse/parquet-exporter.ts
import { DuckDBInstance } from "@duckdb/node-api";
import type { DimensionSpec } from "./adapter.ts";
import { pgAll } from "../pg.ts";
import { cq, qid } from "../repo-shared.ts";

let _exporterDb: Awaited<ReturnType<typeof DuckDBInstance.create>> | null = null;

/** Lazy-init an in-memory DuckDB instance used purely as a Parquet writer. */
async function exporterConn() {
  if (!_exporterDb) _exporterDb = await DuckDBInstance.create(":memory:");
  return _exporterDb.connect();
}

/** Export a dimension's canonical (dim_ + map_) tables from Postgres to a Parquet
 *  buffer. Works regardless of warehouse adapter mode. */
export async function exportCanonicalToParquet(dim: DimensionSpec): Promise<Buffer> {
  const conn = await exporterConn();
  const dimRows = await pgAll(`SELECT * FROM ${cq(dim.dimTable)}`);
  const mapRows = await pgAll(`SELECT * FROM ${cq(dim.mapTable)}`);

  // Use DuckDB's COPY (... TO) FORMAT PARQUET against an in-memory table.
  // Snapshot includes both dim_ and map_ rows, joined into a single result set
  // tagged by source ('dim' / 'map'); consumer (dbt seed, external table) can filter.
  await conn.run(`CREATE TEMP TABLE _dim AS SELECT 'dim' AS source, * FROM (VALUES ...) v(...)`);
  await conn.run(`CREATE TEMP TABLE _map AS SELECT 'map' AS source, * FROM (VALUES ...) v(...)`);
  // (Pseudocode — actual implementation inserts the rows row-by-row or uses DuckDB's appender API)

  const tmpPath = `/tmp/zugzug-snapshot-${dim.dimId}-${Date.now()}.parquet`;
  await conn.run(`COPY (SELECT * FROM _dim UNION ALL SELECT * FROM _map) TO '${tmpPath}' (FORMAT PARQUET)`);
  const buf = await Bun.file(tmpPath).arrayBuffer();
  await Bun.write(tmpPath, ""); // cleanup
  return Buffer.from(buf);
}
```

**Notes:** The exact DuckDB-row-loading strategy (VALUES, appender API, or temp Postgres scan extension) gets nailed in the implementation plan; the contract is `(DimensionSpec) → Buffer`. The exporter is stateless from the caller's perspective and reuses a single in-process DuckDB.

### `commit()` branching in `repo-drafts.ts`

```ts
// In repo-drafts.ts (sketch):
export async function commit(dimId: string, userId: string): Promise<CommitOutcome> {
  // ... existing pgTx for the Postgres canonical write (unchanged) ...

  // After Postgres commit succeeds:
  const adapter = await getAdapter();
  if (isWritable(adapter)) {
    try {
      await adapter.ensureCanonicalTables(meta);
      await adapter.commitCanonical(meta, approvedDrafts);
      await appendAuditAs(userId, "Warehouse synced", `${committed} → ${meta.mapTable}`);
    } catch (e) {
      await appendAuditAs(
        userId,
        "Warehouse sync failed",
        `${committed} → ${meta.mapTable}: ${e instanceof Error ? e.message : String(e)}`,
      );
      // Do NOT throw — Postgres commit already succeeded; return committed count
      // and let the dashboard surface the sync failure for manual resync.
    }
  }
  return { committed, rowsRecovered, warehouseSynced: <derived from audit> };
}
```

The function's return type extends to include a `warehouseSynced: 'n/a' | 'synced' | 'failed'` field for the UI.

### Audit events

Two new audit event types (no schema change — `action` is already a free-text column):

| Action | Detail format | Surfaced where |
|---|---|---|
| `"Warehouse synced"` | `"${committed} → ${dim.mapTable}"` | Dashboard activity feed |
| `"Warehouse sync failed"` | `"${committed} → ${dim.mapTable}: ${error.message}"` | Activity feed AND per-dimension "needs resync" badge |

The per-dimension "needs resync" badge is derived: query the latest `"Warehouse synced"` or `"Warehouse sync failed"` event per dimension; if the latest is "failed," show the badge.

### Snapshot endpoint

```
GET /api/dimensions/:id/snapshot.parquet
  Auth: session cookie (same as other /api/* routes)
  Response: 200 application/octet-stream, Parquet bytes
           404 if dimension not found
           401 if not authenticated
```

No `Cache-Control` for v1 (always fresh — DuckDB-driven export is fast against small canonical tables; we don't optimize prematurely).

### `/api/workspace/info` endpoint

```
GET /api/workspace/info
  Auth: session cookie
  Response: 200 application/json
  Body: {
    adapter: 'duckdb' | 'snowflake',
    writable: boolean,
    canonicalMode: 'warehouse' | 'postgres-export',  // derived from writable
    warehouseDb: string | null
  }
```

Frontend fetches once on app mount; powers the dashboard badge.

---

## UI changes

### Dashboard

**New: Canonical destination badge** in the top KPI strip (between the existing KPI cards or as a sibling card):

```
┌────────────────────────────────────────┐
│ Canonical destination                  │
│ 🟢 Snowflake — writable                │  ← when adapter.capabilities.writable === true
│    ANALYTICS.ZUGZUG.*                  │
└────────────────────────────────────────┘

OR

┌────────────────────────────────────────┐
│ Canonical destination                  │
│ 📦 Local + export                      │  ← when adapter.capabilities.writable === false
│    Postgres canonical; Parquet on demand│
└────────────────────────────────────────┘
```

Plain text, no marketing copy. Click to expand a brief explainer of what each mode means.

**New: "Needs resync" badge per dimension** in the existing dimensions table (the one that currently shows scan status). Adds a column or icon showing `🔄 needs resync` for dimensions whose latest warehouse-sync audit event is `"failed"`. Only renders when the workspace is in writable-warehouse mode.

### Triage (commit affordance)

The "Approve & commit" button's label adapts to mode:

| Mode | Button copy |
|---|---|
| `writable` | `Approve & commit to warehouse` |
| `postgres-export` | `Approve & save` (with a small text link below: `Download snapshot →` linking to the endpoint) |

### Dimension detail (Tables.tsx)

**New: "Download snapshot" link** in the dimension header, regardless of mode. (Available in both modes because the snapshot endpoint always works — even Snowflake-writable users may want a Parquet backup.)

### Engineer-mode gating

Per the existing engineer-mode pattern, internal table names in the canonical destination badge expansion are gated behind `useEngineerMode()`. Non-engineer users see "Snowflake — writable" without the schema path; engineers see the full `ANALYTICS.ZUGZUG.*` qualifier.

---

## Data flow

### Writable-warehouse commit
```
User clicks "Approve & commit to warehouse" in Triage
  → POST /api/dimensions/:id/commit
  → repo.commit(dimId, userId)
    → pgTx: insert dim_/map_ rows in Postgres, delete drafts (atomic)
    → if isWritable(adapter):
        → adapter.ensureCanonicalTables(meta)
        → adapter.commitCanonical(meta, approvedDrafts)
        → audit: "Warehouse synced" OR "Warehouse sync failed"
  → returns { committed, rowsRecovered, warehouseSynced }
  → UI shows toast + (if failed) "needs resync" badge appears on dashboard
```

### Read-only-warehouse commit (current default)
```
User clicks "Approve & save" in Triage
  → POST /api/dimensions/:id/commit
  → repo.commit(dimId, userId)
    → pgTx: insert dim_/map_ rows in Postgres, delete drafts (atomic)
    → isWritable(adapter) === false → skip warehouse call
  → returns { committed, rowsRecovered, warehouseSynced: 'n/a' }
  → UI shows toast + persistent "Download snapshot" link
```

### Snapshot download
```
User clicks "Download snapshot →" anywhere
  → GET /api/dimensions/:id/snapshot.parquet (session cookie)
  → server: resolve dim meta, call exportCanonicalToParquet(meta)
  → exporter: pgAll(dim_*) + pgAll(map_*), DuckDB COPY ... TO ... PARQUET
  → returns Parquet bytes
  → browser triggers download
```

---

## Error handling

| Failure | Effect | User-facing surface |
|---|---|---|
| Postgres pgTx fails | Commit fully rolls back; no drafts cleared; no audit event written | Toast "Commit failed: ..."; user retries |
| Warehouse `commitCanonical` fails (writable mode) | Postgres already committed; `"Warehouse sync failed"` audit event logged | Dashboard shows "needs resync" badge; toast "Saved to Postgres; warehouse sync failed — see dashboard" |
| Warehouse `ensureCanonicalTables` fails | Same as above | Same |
| `exportCanonicalToParquet` fails | 500 from snapshot endpoint | Browser shows error; no state change |
| Adapter creds invalid at startup | `getAdapter()` throws at first call; current behavior unchanged | Server logs error; subsequent commits/scans fail with "factories not registered" / "auth failed" |

**Explicit non-handling:** Phase 3 does not implement auto-retry for warehouse-sync failures. The user manually retries via a future "Resync warehouse" button (Phase 4).

---

## Testing strategy

**Unit tests** (all using mocked SnowflakeConnection from Phase 2's pattern):

| Test | Asserts |
|---|---|
| `commit() in postgres-export mode` | Existing behavior preserved; `warehouseSynced: 'n/a'`; no adapter calls |
| `commit() in writable mode, success` | Postgres tx + adapter call sequence; audit "Warehouse synced" event |
| `commit() in writable mode, warehouse fails` | Postgres tx still succeeds; audit "Warehouse sync failed" event; commit returns `warehouseSynced: 'failed'` |
| `commit() in writable mode, Postgres tx fails` | Adapter never called; nothing committed |
| `exportCanonicalToParquet` against fixture data | Returns valid Parquet bytes; round-trip with `duckdb-cli` reads expected rows |
| `GET /api/dimensions/:id/snapshot.parquet` | 200 with Parquet bytes when authenticated; 404 unknown dim; 401 unauthenticated |
| `GET /api/workspace/info` | Returns correct shape; matches `getAdapter().capabilities` |
| Dashboard badge — writable mode | Renders "Snowflake — writable" |
| Dashboard badge — postgres-export mode | Renders "Local + export" |
| Triage commit copy — writable | Button reads "Approve & commit to warehouse" |
| Triage commit copy — postgres-export | Button reads "Approve & save" + "Download snapshot" link |

Frontend tests use the existing `vitest` + `@testing-library/react` setup.

---

## Out of scope (deferred to Phase 4 or v1.1+)

- Workspace-upgrade backfill (manual "Rebuild from Postgres" button)
- API-token auth on snapshot endpoint
- S3/GCS push of snapshots
- Scheduled snapshot exports / webhooks on commit
- Per-workspace credential admin UI (still env-driven in Phase 3)
- Auto-retry for warehouse sync failures
- Snapshot caching / ETag / Last-Modified

---

## Migration / rollout

- Zero schema changes. Audit events use the existing `app.audit_log` table.
- Zero env changes. `getAdapter()` reads existing creds.
- Default behavior unchanged: every existing deployment is in `postgres-export` mode (since DuckDB/MotherDuck adapters are read-only). The new commit branching is a no-op for them.
- Snowflake-writable mode is unreachable from the existing UI in Phase 3 (no credential UI). Reachable only via hand-editing `registry.ts` for development testing.

---

## References

- Parent spec: `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (Phase 3 section)
- Phase 2 adapter implementation: `server/src/warehouse/snowflake/index.ts`
- Phase 1 commit() implementation: `server/src/repo-drafts.ts` (commit at line 91; rowsForUnmappedDrafts at line 161)
- DuckDB Parquet docs: https://duckdb.org/docs/data/parquet/overview
