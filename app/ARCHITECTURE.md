# Zug Zug — architecture

Master-data value reconciliation that **sits on MotherDuck**. It reads your
existing warehouse, lets a team reconcile messy source values to canonical
values, and writes the result to its own database — never back into the
warehouse.

## Three stores

| Store | Engine | Access | Holds |
|---|---|---|---|
| **Warehouse** | MotherDuck (`md:analytics`, …) | **read-only** | your existing source tables; scanned for distinct values |
| **Canonical store** | MotherDuck — its own db `md:zugzug` | read/write | every `dim_<x>` (canonical) + `map_<x>` (raw→canonical crosswalk). This is what dbt joins. |
| **App state** | **Postgres** (`postgres://zugzug`) | read/write | the multi-user OLTP layer: dimension registry, **drafts/staged edits**, **audit log**, **users + presence** |

**Why split:** the crosswalks live in MotherDuck so dbt models + the discovery
scan join them to the warehouse *in-engine* (no data movement). The chatty,
concurrent, human-paced editing (drafts, audit, who's-online) is OLTP — that's
Postgres. Canonical = system of record; Postgres = the collaborative workspace.

**The bridge:** DuckDB `ATTACH '…' (TYPE postgres)` + the warehouse, so one query
can join **live drafts (Postgres) ⋈ canonical (MotherDuck) ⋈ warehouse**.

## Data flow

```
warehouse ──scan (read-only)──▶ unmapped values ──reconcile (UI, multi-user)──▶ Postgres drafts
                                                                                     │ commit (batch)
                                                          MotherDuck zugzug.map_*/dim_* ◀┘
                                                                    │ dbt LEFT JOIN map_*
                                                              clean warehouse models
```

1. **Scan** (MotherDuck): `SELECT DISTINCT col FROM warehouse.tbl LEFT JOIN zugzug.map_x m ON lower(m.raw)=lower(col) WHERE m.raw IS NULL` → the "new values" inbox, with provenance + row counts.
2. **Reconcile** (UI → Postgres): accept/suggest/merge/skip land as **drafts** in Postgres (per user, audited). No warehouse round-trip per keystroke.
3. **Commit** (MotherDuck): batch `MERGE INTO zugzug.map_x …` + `INSERT … zugzug.dim_x … ON CONFLICT DO NOTHING`. One statement per commit (cheap; MotherDuck scales to zero when idle).
4. **Consume**: dbt models `LEFT JOIN zugzug.map_x` — unmapped is now resolved.

## Cost (MotherDuck billing)

Fine: the canonical tables are tiny; the `DISTINCT`/`LEFT JOIN` scans are cheapest
in-engine; compute scales to zero when idle. The one rule: **never round-trip
MotherDuck per UI interaction** — load a working set, edit against Postgres
drafts, then **batch-commit one MERGE** (the workbench already models stage→commit).

## What's mocked vs real

This repo is **UI only**. `src/store.ts` is an in-memory stand-in for the backend
and every export is annotated with the SQL it represents:

- `useDimensions` / `addDimension` → Postgres `app.dimension` + `CREATE TABLE zugzug.dim_/map_`
- `useDrafts` / `saveDraft` / `discardDraft` / `listDrafts` → Postgres `app.draft` (per-user staged edits)
- `commit(dimId)` → the batch `INSERT … zugzug.dim_` + `MERGE INTO zugzug.map_` (folds approved drafts into canonical)
- `useAudit` / `appendAudit` → Postgres `app.audit_log` (append-only)
- `currentUser` / `collaborators` → Postgres `app.users` + `app.active_sessions`

To make it real, build a thin backend that ATTACHes the three stores and exposes:
`scanUnmapped(dimId)`, `saveDraft(...)`, `listDrafts(dimId)`, `commit(dimId)` (the
MERGE), `appendAudit(...)`. The UI already calls these shapes through the store
(`saveDraft`/`discardDraft`/`listDrafts`/`commit` are live in `src/store.ts`); only
`scanUnmapped` still reads from the static `data.ts` fixtures.

## Multi-user (in the UI today)

- **Presence**: collaborator avatars in the topbar.
- **Audit**: every commit / canonical add / rename / merge / retire appends to the
  audit log, shown in the dashboard **Activity** feed (who · what · when).
- **Drafts (review/approve before commit)**: accept / merge / skip in the value
  workbench land as per-user **drafts** in the store (the Postgres seam), not a
  per-keystroke MotherDuck write. Drafts persist across navigation and are visible
  to the team — the workbench shows *who* staged each value and a row's "uncommitted
  draft" provenance; the footer's **Review N → Approve & commit** lists the staged
  set (incl. teammates') and folds them into `dim_/map_` in one batch MERGE, after
  which the resolved values flip new→mapped everywhere live. The dashboard surfaces
  **Staged for review** (pending drafts + author) alongside Activity.
- Next: row-level locking on a value while someone edits it; realtime fan-out of
  drafts / presence / audit via Postgres `LISTEN/NOTIFY`.

## Implemented backend (`../server/`) — now real

The thin backend exists and the UI talks to it over `/api` (Vite proxies it). Built
with **Bun + `@duckdb/node-api`**: one DuckDB connection that ATTACHes the stores.

**One pivot from the plan above:** the available MotherDuck token is **read-only**
(`read_scaling`), so the canonical `dim_/map_` were moved into **Postgres** (alongside
app state) rather than MotherDuck. MotherDuck stays the **read-only warehouse** for the
scan. Consequence: `commit()` is now single-catalog (all Postgres) so it's atomic;
the cost is that dbt-on-MotherDuck can't join the Postgres crosswalk in-engine — a
sync step (or a r/w MotherDuck token to move canonical back) is the future fix.

- `server/src/repo.ts` exposes exactly the seam: `scanUnmapped`(`scanValues`, registry-driven
  warehouse⋈map), `saveDraft`/`discardDraft`/`listDrafts`, `commit` (folds mapped drafts
  into `dim_/map_`, idempotent), `appendAudit`, dimensions + users.
- The warehouse scan is gated behind `ATTACH_WAREHOUSE` (off by default; the read-only
  token suffices to scan once enabled). Until then `scanUnmapped` returns nothing and the
  canonical/draft/commit machinery runs Postgres-only.
- Run: `cd server && bun run bootstrap -- --seed` once, then `bun run start` (API :8787)
  + `cd app && bun run dev` (:5173). See `server/.env.example`.

Validated live (bridge spike + draft→commit round-trip) against real Postgres.
