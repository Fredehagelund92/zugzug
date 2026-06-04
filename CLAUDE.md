***REMOVED*** CLAUDE.md — Zug Zug (repo: zugzug)

Master-data value reconciliation on MotherDuck. Reads your warehouse, lets a team
reconcile messy source values to canonical values, writes results to its own store
(never back to the warehouse). Full design: `app/ARCHITECTURE.md`.

***REMOVED******REMOVED*** Layout
- `server/` — Bun + `@duckdb/node-api` backend. One DuckDB conn ATTACHes the stores. API :8787.
- `app/` — React 18 + Vite + Tailwind v4 UI. :5173 (Vite proxies `/api`).

***REMOVED******REMOVED*** Run
- `cd server && bun run bootstrap -- --seed`  (once) then `bun run start`
- `cd app && bun run dev`
- Typecheck: `bun run typecheck` in either package.

***REMOVED******REMOVED*** Three stores (see ARCHITECTURE.md)
- Warehouse = MotherDuck, **read-only**, scanned for distinct values.
- Canonical `dim_/map_` + app state (registry, drafts, audit, users) = **Postgres**.
- DuckDB = warehouse-only interface (MotherDuck ATTACH). Does NOT attach Postgres.

***REMOVED******REMOVED*** Data access — hard rules (follow for every feature)
- **OLTP → `postgres.js`** (`server/src/pg.ts`). Every pure-Postgres query (drafts, audit, users, sessions, preferences, dimension registry, canonical tables) uses the native `postgres.js` client. Never use DuckDB to query Postgres.
- **Warehouse → DuckDB** (`server/src/db.ts`). DuckDB only talks to MotherDuck. Use it for `DISTINCT` scans, catalog browsing, and anything that reads warehouse tables.
- **Cross-store joins → application code**. When a query needs warehouse data AND Postgres data (e.g. "which warehouse values are unmapped?"), do two fetches and join in TypeScript. Do not re-introduce a DuckDB Postgres ATTACH.
- **Schema changes → Drizzle migration**. All DDL for the 12 static app-state tables lives in `server/drizzle/schema.ts`. Run `bun run db:generate` after schema edits; commit the generated migration. Dynamic `dim_*/map_*` tables (created per-dimension in `addDimension`) stay as imperative DDL.

***REMOVED******REMOVED*** Gotchas
- MotherDuck token is read-only (`read_scaling`) → canonical `dim_/map_` live in Postgres; `commit()` is single-catalog/atomic.
- Warehouse scan gated by `ATTACH_WAREHOUSE` (off by default). Off → scan functions return nothing; Postgres-only machinery still runs. See `server/.env.example`.
- `app/src/store.ts` annotates each export with the SQL it represents — read it before changing data flow.

***REMOVED******REMOVED*** Master-table convention
- A canonical record = `key` (stable ID) + `label` (renameable name). Never persist the name as a link — names change (`renameCanonical` exists); IDs don't.
- A dimension's `key` MAY be an external warehouse ID (e.g. `partner_id`), not a name-derived slug. When it is, **always display the human name alongside the key** so users can see what they're mapping toward — store the ID, render the name.
