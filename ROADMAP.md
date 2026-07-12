# Zugzug Roadmap

> Living document. Source of truth for sequencing. Re-reviewed at the start of each release cycle.

**Current release:** v0.2 — shipped. Working toward v1.0.
**Toward v1.0:** stable adapter interface, broader warehouse coverage, the rough edges sanded down.

---

## Now (in active development)

The one initiative actively being worked on. One thing at a time.

- **Reference tables (v0.3)** — dimensions as governed maintained lists, per [ADR-0001](./docs/adr/0001-reference-data-not-entity-resolution.md) and [ADR-0002](./docs/adr/0002-publish-gates-materialization.md). Design reference: `docs/mdm-reference-table.html`. Scope, in shipping order:
  1. Land the activity/audit timeline + grid cursor perf work (in flight).
  2. Dimension `owner` metadata (description and color already exist).
  3. Versioned publish: surface the existing per-dim version counter as "Published vN", derived unpublished-changes panel, "changed only" filter, unify user-facing vocabulary on **publish**. Editing stays instant; publish gates what dbt consumes.

---

## Next (queued)

Planned for the next release. Subject to scope refinement.

- **[#53] row_touched invalidation** — commit-time hint over the presence WebSocket that collapses activity-badge staleness from 5 s poll to ~50 ms push. Deferred from E1; small standalone task.
- **[#17] Review: bulk Skip action** — the floating bulk bar ships Merge; Skip and Map-to are the remaining actions from the original Review bulk spec.
- **Snowflake auth: password and SSO modes** — v0.1 shipped with key-pair auth (SNOWFLAKE_JWT) only. Tracking inbound demand to prioritize.

---

## Later (roadmapped, not yet committed)

Scoped but not in a specific milestone. Community PRs welcome — open an issue first to discuss the design.

### Curation features

| Item | Status | Trigger |
|---|---|---|
| [#45 — Error recovery: canonical_history + per-record revert](https://github.com/Fredehagelund92/zugzug/issues/45) | Planned | After first incident where committed mutations need rolling back, or sufficient inbound demand. |
| [#33 — Bulk operations in Triage + cascade delete](https://github.com/Fredehagelund92/zugzug/issues/33) | Wanted | Merge action shipped; cascade delete (#18) + remaining bulk actions are the open scope. |
| [#35 — Unified search (Cmd-K)](https://github.com/Fredehagelund92/zugzug/issues/35) | Wanted | After v1.0. |
| [#3](https://github.com/Fredehagelund92/zugzug/issues/3), [#4](https://github.com/Fredehagelund92/zugzug/issues/4), [#5](https://github.com/Fredehagelund92/zugzug/issues/5) — AI-assisted suggestions | Exploring | Need design first; not adoption-blocking. |

### Collaboration

| Item | Status | Trigger |
|---|---|---|
| E3 — History & Rollback | Wanted | Superseded by #45 scope; after #45 ships. |
| E4 — Branching / sandbox | Out of scope | See below. |

### Auth + access control

| Item | Status | Trigger |
|---|---|---|
| OIDC web-UI configuration (vs env-only today) | Wanted | If a hosted offering ever materializes; env-only is sufficient for self-hosters. |

### Multi-tenancy / hosted offering

| Item | Status | Trigger |
|---|---|---|
| Per-tenant warehouse tokens (phase 3) | Gated | `tenant.warehouse_id` exists in schema; wiring per-tenant tokens is triggered by a hosted offering decision. |
| Super-admin tenant management UI (phase 3) | Gated | CLI only for now; triggered by non-engineer ops or 50+ tenants. |

### More adapters

| Adapter | Status | What would move it forward |
|---|---|---|
| Postgres-as-warehouse | Wanted | Community PR, or self-host request. Cheap follow-on for Redshift via PG wire protocol. |
| BigQuery | Wanted | Community PR, or 5+ inbound "does it support BigQuery?" issues. |
| Databricks | Wanted | Community PR, or 5+ inbound "does it support Databricks?" issues. |
| Redshift | Wanted | After Postgres-as-warehouse lands. |

### Ecosystem

| Item | Status | Trigger |
|---|---|---|
| `zugzug_utils` dbt package (macros over `dim_*`/`map_*`) | Considering | After v0.2 launch metrics show dbt-team adoption. |
| S3 / GCS snapshot push, scheduled exports, webhook-on-commit | Wanted | First user request for scheduled exports. |

### Internal cleanup

| Item | Status |
|---|---|
| `Sql` branded-type project-wide adoption | Wanted alongside any refactor touching `qid` / `cq` / `whTable` callsites. |

---

## Shipped

### v0.2

- **Scheduler hardening (epic #15)** — scan_run table, failure surfacing, graceful shutdown, drift/overlap logging, per-source duration, scheduler extracted to own module.
- **Role-based permissions (epic #36)** — admin/editor/viewer roles, `canAdminister` gating.
- **CSV import/export** — `POST /dimensions/:id/import`, per-dim Export button, `ImportCSVModal`.
- **E1 — Activity & Presence** — row-activity badges (audit log + API + DataGrid pip), live cursors (yjs WebSocket awareness), presence strip.
- **E2 — Optimistic concurrency** — version-column conflict detection on record edits.
- **Grid-feel sprint** — optimistic mutations, undo persistence, floating bulk-action bar, vocabulary unification, unified toast stack.
- **Multi-tenant workspaces** — Deploy 1 + Deploy 2 migrations, TenantRepo, withTenantTx, auth middleware, sign-in invite flow, provisionTenant/teardownTenant, super-admin routes, scheduler per-tenant scoping, `/app/:slug/*` routes, workspace switcher, apiFetch, RLS.
- **Settings IA redesign** — Account, Danger zone, Admin console, Team roster.
- **v0.1 launch readiness** — public README, issue templates, PR template, license-checker CI, history scrub.
- **Snowflake auth: password + OIDC** — validated against the abstraction and wired through.

---

## Out of scope (not planned)

Decisions taking items off the table. Listed so they don't re-litigate in issues. Reopenable in principle if circumstances change.

| Item | Why | What would change our mind |
|---|---|---|
| Generic MDM positioning (Tamr / Stibo / Reltio space) | Different market; competitive landscape. Entity resolution / golden records explicitly rejected in [ADR-0001](./docs/adr/0001-reference-data-not-entity-resolution.md); reference tables are in scope, probabilistic matching is not. | Never — explicit anti-goal. |
| Airtable-like surface (rich types, attachments, app builder) | Out of focus. Reference tables ([ADR-0001](./docs/adr/0001-reference-data-not-entity-resolution.md)) are governed lists, not an app platform. | Never — explicit anti-goal. |
| ADBC as the warehouse abstraction | No production Node binding with Snowflake + BigQuery + Databricks driver coverage in 2026. | A production-grade Node ADBC binding with the full driver set. |
| OpenRefine Reconciliation API | Different distribution channel; would split focus. | A 10× distribution opportunity tied specifically to OpenRefine. |
| Apache-2.0 + CLA + BSL relicense | One-way door taken at v0.1 with MIT + DCO. Relicense would require every contributor to re-sign. | Effectively closed. |
| Pre-1.0 rebrand | "Zugzug" is unconventional but distinctive; defer until traction warrants it. | Cease-and-desist, USPTO opposition, or a clear breakout where the name is friction. |
| [#57 — Branching / "what-if" sandbox](https://github.com/Fredehagelund92/zugzug/issues/57) | Closed pre-v0.1 — UX implications outweighed value for the cases we'd seen. | A steward who needs "preview my remap before committing" with concrete examples. |

---

## Maintenance cadence

- **Per-release:** Update the `Now` section to reflect what's actively being shipped.
- **Quarterly review:** Re-evaluate `Next` and `Later` based on inbound demand and community contributions.
- **Phase completion:** Move shipped items into the `Shipped` section (not into git tags — releases carry that).

### When `Now` holds more than one item

The rule of one is for cognitive load, not dogma. Two items in `Now` is fine when:
- They have zero shared files or shared mental model.
- One is genuinely small (e.g. a CI gate alongside a bigger refactor).

If both conditions don't hold, ship serially.
