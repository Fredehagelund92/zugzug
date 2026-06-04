***REMOVED*** Drizzle + Native Postgres Architecture

**Date:** 2026-06-04
**Status:** approved

***REMOVED******REMOVED*** Problem

All Postgres queries currently go through DuckDB's Postgres extension (`ATTACH ... TYPE postgres`).
This was introduced to enable cross-store JOINs (warehouse ⋈ Postgres in one SQL statement), but it
means every OLTP query — drafts, audit, users, sessions, preferences — runs through DuckDB, which:

- Blocks partial indexes (`CREATE UNIQUE INDEX ... WHERE ...` silently no-ops through the extension)
- Requires `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` workarounds scattered in `schema.ts`
- Prevents using Drizzle or any ORM that needs a native Postgres driver
- Makes schema evolution ad-hoc and untraceable

***REMOVED******REMOVED*** Decision

Split data access into two strict lanes:

| Lane | Client | Used for |
|---|---|---|
| **OLTP** | `postgres.js` (`server/src/pg.ts`) | drafts, audit, users, sessions, preferences, dimension registry, canonical dim_/map_ tables |
| **Warehouse** | DuckDB (`server/src/db.ts`) | MotherDuck ATTACH — DISTINCT scans, catalog browsing, anything reading warehouse tables |

DuckDB no longer ATTACHes Postgres. Cross-store queries (warehouse values ⋈ Postgres map/canonical)
are decomposed into two fetches + TypeScript set arithmetic. All scale concerns examined and accepted:
MDM dimensions are low-cardinality (< 10k distinct values), scan operations are background/scheduled,
and a materialised scan cache in Postgres (future spec) resolves the high-cardinality edge case.

Schema management moves to **Drizzle ORM** (schema-as-code + numbered SQL migration files).

***REMOVED******REMOVED*** Architecture

```
                        ┌─────────────────────────────┐
                        │  server/src/repo.ts          │
                        │  (data access layer)         │
                        └──────┬──────────────┬────────┘
                               │              │
              OLTP (Postgres)  │              │  Warehouse (MotherDuck)
                               ▼              ▼
                     ┌──────────────┐  ┌────────────────┐
                     │  pg.ts       │  │  db.ts         │
                     │  postgres.js │  │  DuckDB        │
                     └──────┬───────┘  └──────┬─────────┘
                            │                 │
                     ┌──────▼───────┐  ┌──────▼─────────┐
                     │  Postgres    │  │  MotherDuck     │
                     │  (zugzug_app │  │  (md:analytics) │
                     │   + zugzug   │  │  read-only      │
                     │   schemas)   │  └────────────────┘
                     └─────────────┘
```

Cross-store join (e.g. "which warehouse values are unmapped?"):
```
DuckDB → all distinct warehouse values (array)
postgres.js → all mapped raws for this dimension (Set)
TypeScript → filter, sort, slice(500)
```

***REMOVED******REMOVED*** Files changed

***REMOVED******REMOVED******REMOVED*** New files
- `server/src/pg.ts` — postgres.js client, exports `sql` tagged template + `pgPool`
- `server/drizzle.config.ts` — Drizzle Kit config (`DATABASE_URL`, dialect: postgres, out: `drizzle/migrations/`)
- `server/drizzle/schema.ts` — TypeScript schema definitions for all 12 static tables
- `server/drizzle/migrate.ts` — programmatic migration runner (used by bootstrap)
- `server/drizzle/migrations/0000_baseline.sql` — baseline DDL (CREATE TABLE IF NOT EXISTS, safe for existing DBs)

***REMOVED******REMOVED******REMOVED*** Modified files
- `server/src/db.ts` — remove `attachPostgres()`; DuckDB becomes warehouse-only
- `server/src/repo.ts` — OLTP functions use `sql` from `pg.ts`; warehouse functions stay on DuckDB helpers
- `server/src/bootstrap.ts` — call `migrate()` instead of `ensureSchema()`
- `server/src/env.ts` — remove `pg()` helper (no longer needed for runtime; `cq()` stays for DuckDB warehouse refs)
- `server/package.json` — add `postgres`, `drizzle-orm`, `drizzle-kit`; add `db:generate`, `db:migrate`, `db:studio` scripts

***REMOVED******REMOVED******REMOVED*** Deleted files
- `server/src/schema.ts` — replaced entirely by Drizzle schema + migrations

***REMOVED******REMOVED*** Drizzle schema scope

**Managed by Drizzle (static tables):**
`dimension`, `dimension_source`, `dimension_field`, `source_stat`, `draft`, `audit_log`,
`users`, `active_sessions`, `allowed_emails`, `sessions`, `preferences`, `user_grid_layout`

**NOT managed by Drizzle (dynamic per-dimension tables):**
`zugzug.dim_*` and `zugzug.map_*` — created imperatively in `addDimension()` because their names
and key columns are data-driven. These stay as runtime DDL.

***REMOVED******REMOVED*** Drizzle baseline migration

`0000_baseline.sql` matches the current `schema.ts` exactly, but with `CREATE TABLE IF NOT EXISTS`
so it is safe to run against both a fresh DB and an existing DB that was bootstrapped with the old
`ensureSchema()`. The Drizzle migrations table (`drizzle.__drizzle_migrations`) is created on first
`migrate()` call; subsequent `bootstrap` runs are no-ops for already-applied migrations.

***REMOVED******REMOVED*** Cross-store function changes

| Function | Was | Becomes |
|---|---|---|
| `scanValues` | DuckDB JOIN warehouse + Postgres map | DuckDB → distinct values; `pg.ts` → mapped raws; JS Set filter |
| `rowsForUnmappedDrafts` | DuckDB JOIN warehouse + Postgres draft | DuckDB → warehouse occurrences; `pg.ts` → draft raws; JS join |
| `autoStageExactMatches` | DuckDB JOIN warehouse + Postgres dim/map | DuckDB → distinct values; `pg.ts` → canonical labels + map; JS match |

***REMOVED******REMOVED*** New npm scripts

```jsonc
"db:generate": "drizzle-kit generate",   // after editing drizzle/schema.ts
"db:migrate":  "drizzle-kit migrate",    // apply pending migrations (also runs at bootstrap)
"db:studio":   "drizzle-kit studio"      // local schema browser (optional)
```

***REMOVED******REMOVED*** Out of scope (future specs)

- Materialised scan cache: a `scan_result` Postgres table that stores `scanValues` output, so `getDimension` reads from cache instead of hitting MotherDuck live on every page load.
- Drizzle query builder for OLTP (optional ergonomic upgrade; raw `sql` tagged template is fine).
