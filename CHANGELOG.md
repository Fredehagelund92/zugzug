# Changelog

All notable changes to Zugzug. This project is pre-1.0 — expect breaking changes
between minor versions. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [0.3.0] — 2026-07-21

The reference-tables release: dimensions become governed, maintained lists, and
the project gets a one-command self-host path with real test and CI coverage.

### Added
- **Reference tables** — maintain governed lists (the one Country/Currency list your dashboards depend on) edited in place, per [ADR-0001](./docs/adr/0001-reference-data-not-entity-resolution.md) and [ADR-0002](./docs/adr/0002-publish-gates-materialization.md).
- **Versioned publish** — surface the per-table version as "Published vN", a derived unpublished-changes view, and a "changed only" filter. Editing stays instant; publish gates what dbt consumes.
- **Self-referencing hierarchy** — a linked field can target its own table, with cycle rejection and a self-link picker.
- **One-command demo** — `docker compose up` boots Postgres + server + nginx-served SPA with seeded demo tables and password signup; no warehouse or OAuth needed. See the README "Try it in 30 seconds".
- **Grid test-kit** — a reusable RTL/jsdom kit (`app/src/components/datagrid/test-kit/`) plus suites for navigation, editing, selection, undo/redo, and a 20k-row virtualization guard.
- **`compose-smoke` CI job** — builds the images and smoke-tests the full `docker compose up` stack on every push, guarding the self-host path.
- **Docs** — [ARCHITECTURE.md](./ARCHITECTURE.md) (three-store model, request path, subsystems) and [operations](./docs/operations.md) (backup & restore).
- Dimension `owner` metadata; activity/audit timeline with search + actor filters.

### Changed
- **Grid performance** — O(1) cursor lookups and rAF-coalesced overlay scroll.
- README repositioned around the two pillars (value mapping + reference tables) and the one-command demo.

### Fixed
- **First-admin election** shared across password + OIDC signup (`countRealLoginUsers`) so bootstrap-seeded placeholder users can't lock out the first real signup.
- **Server image healthcheck** uses a `bun` probe (`wget`/`curl` aren't in the `oven/bun` base image), so the image reports healthy under a bare `docker run`.
- nginx now reverse-proxies `/api` and `/ws` to the backend, so the containerized SPA can reach the server.

## [0.2.0] — 2026-07-11

Curation-at-scale and multi-tenancy. (Shipped but never tagged at the time;
tagged retroactively.)

### Added
- **Multi-tenant workspaces** — switchable tenants (like Linear teams): TenantRepo, `withTenantTx`, RLS, sign-in invite flow, workspace switcher, `/app/:slug/*` routes, super-admin routes.
- **Role-based permissions** (epic #36) — admin/editor/viewer with `canMutate` gating.
- **Scheduler hardening** (epic #15) — `scan_run` table, failure surfacing in the audit feed, graceful shutdown, drift/overlap logging, per-source duration.
- **Activity & presence** (E1) — row-activity badges, live cursors (yjs awareness), presence strip.
- **Optimistic concurrency** (E2) — version-column conflict detection on record edits.
- **CSV import/export** — per-table import/export.
- **Snowflake auth** — password + OIDC modes.
- Settings IA redesign (Account, Danger zone, Admin console, Team roster).

### Changed
- **Grid-feel sprint** — optimistic mutations, undo persistence, floating bulk-action bar, unified toast stack, vocabulary unification.

## [0.1.0]

Initial public release — the value-mapping workflow, warehouse scan, and
`dim_`/`map_` materialization for dbt.

[0.3.0]: https://github.com/Fredehagelund92/zugzug/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Fredehagelund92/zugzug/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Fredehagelund92/zugzug/releases/tag/v0.1.0
