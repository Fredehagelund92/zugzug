# Zugzug Roadmap

> Living document — directional, not a commitment. This file is about what's
> next and why; shipped work lives in the git history and tagged releases.

**Toward v1.0:** a stable `WarehouseAdapter` interface, broader warehouse coverage,
and the rough edges — surfaced by the one-command demo and production-deploy paths —
sanded down.

---

## Now (in active development)

Hardening toward v1.0: stabilizing the `WarehouseAdapter` interface and closing the
gaps the demo and self-host paths expose. One primary initiative at a time.

---

## Next (queued)

Planned next. Subject to scope refinement.

- **[#53] row-touched invalidation** — a publish-time hint over the presence WebSocket that collapses activity-badge staleness from a 5 s poll to a ~50 ms push.
- **[#17] Review: bulk Skip action** — the floating bulk bar ships Merge; Skip and Map-to are the remaining actions from the original Review bulk spec.
- **Snowflake auth: password and SSO modes** — key-pair auth (`SNOWFLAKE_JWT`) ships today; password/SSO tracked against inbound demand.

---

## Later (roadmapped, not yet committed)

Scoped but not in a specific milestone. Community PRs welcome — open an issue first to discuss the design.

### Curation features

| Item | Status | Trigger |
|---|---|---|
| [#45 — Error recovery: per-record revert](https://github.com/Fredehagelund92/zugzug/issues/45) | Planned | After the first incident where published mutations need rolling back, or sufficient inbound demand. |
| [#33 — Bulk operations in Review + cascade delete](https://github.com/Fredehagelund92/zugzug/issues/33) | Wanted | Merge action shipped; cascade delete (#18) + remaining bulk actions are the open scope. |
| [#35 — Unified search (Cmd-K)](https://github.com/Fredehagelund92/zugzug/issues/35) | Wanted | After v1.0. |
| [#3](https://github.com/Fredehagelund92/zugzug/issues/3), [#4](https://github.com/Fredehagelund92/zugzug/issues/4), [#5](https://github.com/Fredehagelund92/zugzug/issues/5) — AI-assisted suggestions | Exploring | Need design first; not adoption-blocking. |

### Collaboration

| Item | Status | Trigger |
|---|---|---|
| History & rollback | Wanted | Superseded by #45 scope; after #45 ships. |
| Branching / sandbox | Out of scope | See below. |

### Auth + access control

| Item | Status | Trigger |
|---|---|---|
| OIDC web-UI configuration (vs env-only today) | Wanted | If a hosted offering ever materializes; env-only is sufficient for self-hosters. |

### Multi-tenancy / hosted offering

| Item | Status | Trigger |
|---|---|---|
| Per-workspace warehouse tokens | Gated | The schema supports it; wiring per-workspace tokens is triggered by a hosted-offering decision. |
| Super-admin workspace-management UI | Gated | CLI-driven today; triggered by non-engineer ops or many workspaces. |

### More adapters

| Adapter | Status | What would move it forward |
|---|---|---|
| Postgres-as-warehouse | Wanted | Community PR, or self-host request. Cheap follow-on for Redshift via the PG wire protocol. |
| BigQuery | Wanted | Community PR, or sustained inbound demand. |
| Databricks | Wanted | Community PR, or sustained inbound demand. |
| Redshift | Wanted | After Postgres-as-warehouse lands. |

### Ecosystem

| Item | Status | Trigger |
|---|---|---|
| `zugzug_utils` dbt package (macros over `dim_*`/`map_*`) | Considering | Once metrics show dbt-team adoption. |
| S3 / GCS snapshot push, scheduled exports, webhook-on-publish | Wanted | First user request for scheduled exports. |

---

## Out of scope (not planned)

Decisions taking items off the table, listed so they don't re-litigate in issues. Reopenable in principle if circumstances change.

| Item | Why | What would change our mind |
|---|---|---|
| Generic MDM positioning (Tamr / Stibo / Reltio space) | Different market. Entity resolution / golden records explicitly rejected in [ADR-0001](./docs/adr/0001-reference-data-not-entity-resolution.md); reference tables are in scope, probabilistic matching is not. | Never — explicit anti-goal. |
| Airtable-like surface (rich types, attachments, app builder) | Out of focus. Reference tables ([ADR-0001](./docs/adr/0001-reference-data-not-entity-resolution.md)) are governed lists, not an app platform. | Never — explicit anti-goal. |
| ADBC as the warehouse abstraction | No production Node binding with Snowflake + BigQuery + Databricks driver coverage today. | A production-grade Node ADBC binding with the full driver set. |
| OpenRefine Reconciliation API | Different distribution channel; would split focus. | A 10× distribution opportunity tied specifically to OpenRefine. |
| Relicense (Apache-2.0 + CLA, or BSL) | One-way door taken at launch with MIT + DCO. A relicense would require every contributor to re-sign. | Effectively closed. |
| Pre-1.0 rebrand | "Zugzug" is unconventional but distinctive; defer until traction warrants it. | Cease-and-desist, USPTO opposition, or clear evidence the name is friction. |
| Branching / "what-if" sandbox | UX implications outweighed the value for the cases seen so far. | A steward who needs "preview my remap before publishing" with concrete examples. |

---

## Maintenance cadence

- **Now** reflects the one initiative actively being shipped.
- **Next / Later** get re-evaluated periodically against inbound demand and community contributions.
- Shipped work drops off this list — the git history and tagged releases carry it.
