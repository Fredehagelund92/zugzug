# Architecture

This document is for contributors and self-hosters. It describes how Zugzug is
put together — the three stores, the request path, and where state lives. For
user-facing vocabulary see [CONTEXT.md](./CONTEXT.md); for the product direction
see the [ADRs](./docs/adr/).

Zugzug is a curation layer between a data warehouse and dbt: teams map messy
source values to approved records and maintain governed reference tables, which
publish as `dim_<x>` / `map_<x>` tables dbt joins directly.

## The three stores

Zugzug reads and writes three separate stores. Keeping them separate is the
central design decision — each has a different owner, durability need, and
access pattern.

| Store | Technology | Owner / durability | Holds |
|---|---|---|---|
| **1. Warehouse** | Your warehouse (MotherDuck/DuckDB today; Snowflake shipped) | Yours — **read-only** to Zugzug | The registered columns Zugzug scans for distinct **source values**. Never modified unless you explicitly configure a writable adapter. |
| **2. Record store** | Postgres (default) or MotherDuck (`MOTHERDUCK_WRITABLE=true`) | Zugzug | The published `dim_<x>` / `map_<x>` tables — the approved **records** and **mappings**, versioned. |
| **3. App state** | Postgres (`zugzug_app` schema) | Zugzug — **the store to back up** | Everything operational: drafts, audit log, users, sessions, presence, preferences, table versions, and the outbound-event queue. |

- The **warehouse** is attached only when `ATTACH_WAREHOUSE=true` (with a warehouse adapter + token). With it off, the record-and-publish workflow still works fully against Postgres — this is the default demo mode.
- The **record store** location depends on `MOTHERDUCK_WRITABLE`, and publishing is **pull-first** ([ADR-0007](./docs/adr/0007-publish-is-pull-first.md)). The recommended path is `false` (the default): published records stay in Postgres, and the warehouse team ingests them through their **own** pipeline — a dbt source, the Pull API (`?since=` cursors), or an on-demand Parquet snapshot — so publishes flow through the existing dev→prod, CI, and review path they already trust. `true` is an **opt-in convenience** that instead `MERGE`s each publish directly into a MotherDuck database your dbt reads; simpler for a solo setup, but it writes into your warehouse out-of-band — no environment promotion, tables mutated in place.
- **App state** in Postgres is the crown jewels — drafts and audit history live nowhere else. See [backup & restore](https://zugzughq.com/docs/guides/backup-restore).

### How the stores connect (server side)

A single local DuckDB engine (`DUCK_PATH`, default `:memory:`) `ATTACH`es the
two remote MotherDuck databases (warehouse + record store), so the server can query
across them. All durable state lives in Postgres + MotherDuck, never in the
local engine — so `:memory:` is fine. The browser never touches DuckDB or
Postgres directly; it only calls the Bun API.

## Request path

```
Browser (React SPA)
   │  fetch /api/*  ,  ws /ws/*        (same origin)
   ▼
nginx (prod)  ── proxies /api + /ws ──►  Bun API server (:8787)
   │  serves the static SPA                 │
   │                                        ├─► Postgres  (app state + record store in default mode)
   │                                        └─► DuckDB engine ─ATTACH─► MotherDuck (warehouse read-only + record store)
```

- **Frontend** (`app/`): React + TypeScript + Vite, Tailwind v4, React Router. Built to static assets, served by nginx in production; `bun run dev` with a Vite proxy in development. All API calls are relative (`/api`, `/ws`) via `apiFetch`, so the app is origin-agnostic.
- **Backend** (`server/`): Bun HTTP server. Path-routed under `/api/*` (`server/src/server.ts`); presence/awareness WebSocket under `/ws/t/<slug>/presence/<table>` (yjs). Health at `/health` and `/api/health`.
- One process, no queue broker: background work (warehouse scans, outbound webhook dispatch, retention sweeps) runs on an in-process scheduler.

## Key subsystems (server/src)

- **Stores & env**: `env.ts` validates the three-store credentials and fails fast with a banner listing every missing var. `pg.ts` is the Postgres layer (`pgTx` transactions, tenant-scoped helpers).
- **Auth** (`auth.ts`, `auth-password.ts`, `auth-oidc.ts`): two modes, one active per deployment. **Password** (default) — local email+password, first real signup becomes admin. **OIDC** — set `OIDC_ISSUER_URL` for any compliant provider. Session cookies are `HttpOnly; SameSite=Lax`, `Secure` only when `ORIGIN` is https. Per-workspace API tokens (`zzsa_*`) via `auth-api-tokens.ts` for dbt CI/scripts. The first-admin election is shared across both paths (`countRealLoginUsers`) so seeded placeholder users don't lock anyone out.
- **Warehouse adapters** (`server/src/warehouse/`): `adapter.ts` is the `WarehouseAdapter` interface; each technology implements read (distinct-value scan) and optional write. DuckDB/MotherDuck and Snowflake ship; the Snowflake adapter is the reference implementation for new ones.
- **Repos** (`repo-*.ts`): the data layer per concern — `repo-record` (records), `repo-drafts` (mappings awaiting publish), `repo-versions` (numbered table versions), `repo-scan`/`repo-source-scan` (source-value discovery), `repo-outbound*` (webhook/pull-API event bus), `repo-rollback` (revert support), `repo-activity` (audit feed).
- **Multi-tenancy**: workspaces are switchable tenants (like Linear teams), row-scoped in Postgres. `withTenantTx` scopes queries; routes live under `/api/t/:slug/*`. Self-hosters typically run one workspace; the model supports many.

## Publish model (ADR-0002)

Editing is **instant** on the working copy. **Publish** is the single gate that
folds mapping drafts and stamps record edits into a new numbered version
(`vN`, a per-table counter) and materializes `dim_<x>` / `map_<x>` for dbt.
Unpublished changes are *derived* (record edits since the last publish), not a
separate staging queue. Nothing reaches dbt until publish. See
[ADR-0001](./docs/adr/0001-reference-data-not-entity-resolution.md) (reference
data, not entity resolution) and
[ADR-0002](./docs/adr/0002-publish-gates-materialization.md).

## Deployment shapes

- **Try it / self-host demo**: `docker compose up` — Postgres + server + nginx-served SPA, `ATTACH_WAREHOUSE=false`, seeded demo tables, password signup. See the README "Try it in 30 seconds". CI's `compose-smoke` job guards this path on every push.
- **Real self-host**: point `DATABASE_URL` at your Postgres, set `ORIGIN`, and (optionally) wire a warehouse (`ATTACH_WAREHOUSE=true` + `WAREHOUSE_ADAPTER` + `MOTHERDUCK_TOKEN`) and OIDC. `SEED_DEMO=false`. Config reference: `server/.env.example`.
- **Production stack**: `compose.prod.yml` fronts the app container with **Caddy** for automatic HTTPS (only Caddy is exposed to the host) over the same nginx-served SPA + Bun API, with a bundled or external Postgres. See the [deploy guide](https://zugzughq.com/docs/guides/deploy).

## Secrets & the `/data` volume

Two keys are generated on first boot into the server's data dir
(`ZUGZUG_DATA_DIR`, default `/data`, a mounted volume in compose):

- `cursor.key` — HMAC key signing Pull-API pagination cursors. Low-stakes; rotating just forces clients to resync from `?since=`.
- the webhook master key (when `WEBHOOKS_ENABLED=1`) — AES-256-GCM key encrypting webhook signing secrets at rest. **Losing it makes every stored webhook secret unrecoverable — back up `/data`.**

Both can be supplied explicitly via env instead of auto-generation. See
[backup & restore](https://zugzughq.com/docs/guides/backup-restore) for what to back up.
