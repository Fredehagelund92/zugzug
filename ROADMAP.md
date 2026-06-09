# Zugzug Roadmap

> Living document. Source of truth for sequencing. Re-reviewed at the start of each release cycle.

**Current release:** v0.1 — early. Expect breaking changes between minor versions until v1.0.
**Toward v1.0:** stable adapter interface, broader warehouse coverage, the rough edges from v0.1 sanded down.

---

## Now (in active development)

The one initiative actively being worked on. One thing at a time.

### v0.1 launch readiness
- Public-facing README, issue templates, PR template.
- Final audit of repository history + license-checker CI.
- Cutover to public GitHub destination.

---

## Next (queued for v0.2)

Planned for the next release. Subject to scope refinement.

- **Snowflake auth: password and SSO modes.** v0.1 ships with key-pair auth (SNOWFLAKE_JWT) only. Password + SSO modes were validated against the abstraction but not wired through. Tracking inbound demand to prioritize.
- **Quickstart polish.** A real "10-minute walkthrough" from clean machine → working curation UI. v0.1's bootstrap works but has rough edges around env-var validation.
- **CI: bun lockfile drift check.** Currently relies on `--frozen-lockfile`; adding an explicit drift gate.

---

## Later (roadmapped, not yet committed)

Scoped but not in a specific milestone. Community PRs welcome — open an issue first to discuss the design.

### More adapters

| Adapter | Status | What would move it forward |
|---|---|---|
| Postgres-as-warehouse | Wanted | Community PR, or self-host request. Cheap follow-on for Redshift via PG wire protocol. |
| BigQuery | Wanted | Community PR, or 5+ inbound "does it support BigQuery?" issues. |
| Databricks | Wanted | Community PR, or 5+ inbound "does it support Databricks?" issues. |
| Redshift | Wanted | After Postgres-as-warehouse lands. |

### Curation features

| Item | Status | Trigger |
|---|---|---|
| [#45 — Error recovery: canonical_history + per-record revert](https://github.com/Fredehagelund92/zugzug/issues/45) | Planned | After first incident where committed mutations need rolling back, or sufficient inbound demand. |
| [#33 — Bulk operations in Triage + cascade delete](https://github.com/Fredehagelund92/zugzug/issues/33) | Wanted | After v1.0, or first community feature request. |
| [#34 — CSV import/export](https://github.com/Fredehagelund92/zugzug/issues/34) | Wanted | Parquet export covers v0.1; CSV is a v1.x convenience. |
| [#35 — Unified search (Cmd-K)](https://github.com/Fredehagelund92/zugzug/issues/35) | Wanted | After v1.0. |
| [#3](https://github.com/Fredehagelund92/zugzug/issues/3), [#4](https://github.com/Fredehagelund92/zugzug/issues/4), [#5](https://github.com/Fredehagelund92/zugzug/issues/5) — AI-assisted suggestions | Exploring | Need design first; not adoption-blocking. |
| [#15 — Scan scheduler hardening](https://github.com/Fredehagelund92/zugzug/issues/15) | Wanted | First production scan failure that loses data. |

### Collaboration

| Item | Status | Trigger |
|---|---|---|
| [#54 — Activity feed + presence](https://github.com/Fredehagelund92/zugzug/issues/54) | Wanted | After v1.0; realtime infrastructure is its own scope. |
| [#55 — Concurrent editing safety (LWW prevention)](https://github.com/Fredehagelund92/zugzug/issues/55) | Wanted | After #54 ships, or first last-write-wins incident. |

### Auth + access control

| Item | Status | Trigger |
|---|---|---|
| [#36 — RBAC phase 2 (non-admin roles)](https://github.com/Fredehagelund92/zugzug/issues/36) | Wanted | First team that wants per-dimension permissions. |
| OIDC web-UI configuration (vs env-only today) | Wanted | If a hosted offering ever materializes; env-only is sufficient for self-hosters. |

### Multi-tenancy / hosted offering

| Item | Status | Trigger |
|---|---|---|
| [#59 — Multi-tenant workspaces (UI)](https://github.com/Fredehagelund92/zugzug/issues/59) | Gated | Schema + middleware exist behind `ZUGZUG_MULTI_TENANT`; surfacing the UI is on hold to keep open-core options open. Triggered by a hosted offering decision. |
| Workspace switcher UI for self-hosters | Gated | Same as #59. |

### Ecosystem

| Item | Status | Trigger |
|---|---|---|
| `zugzug_utils` dbt package (macros over `dim_*`/`map_*`) | Considering | After v0.1 launch metrics show dbt-team adoption. |
| S3 / GCS snapshot push, scheduled exports, webhook-on-commit | Wanted | First user request for scheduled exports. |

### Internal cleanup

| Item | Status |
|---|---|
| `Sql` branded-type project-wide adoption | Wanted alongside any refactor touching `qid` / `cq` / `whTable` callsites. |
| [#30 — Parse Google `hd` JWT claim](https://github.com/Fredehagelund92/zugzug/issues/30) | Superseded by generic OIDC support; likely closing. |

---

## Out of scope (not planned)

Decisions taking items off the table. Listed so they don't re-litigate in issues. Reopenable in principle if circumstances change.

| Item | Why | What would change our mind |
|---|---|---|
| Generic MDM positioning (Tamr / Stibo / Reltio space) | Different market; competitive landscape | Never — explicit anti-goal. |
| Airtable-like surface (rich types, attachments, app builder) | Out of focus | Never — explicit anti-goal. |
| ADBC as the warehouse abstraction | No production Node binding with Snowflake + BigQuery + Databricks driver coverage in 2026. | A production-grade Node ADBC binding with the full driver set. |
| OpenRefine Reconciliation API | Different distribution channel; would split focus. | A 10× distribution opportunity tied specifically to OpenRefine. |
| Apache-2.0 + CLA + BSL relicense | One-way door taken at v0.1 with MIT + DCO. Relicense would require every contributor to re-sign. | Effectively closed. |
| Pre-1.0 rebrand | "Zugzug" is unconventional but distinctive; defer until traction warrants it. | Cease-and-desist, USPTO opposition, or a clear breakout where the name is friction. |
| [#57 — Branching / "what-if" sandbox](https://github.com/Fredehagelund92/zugzug/issues/57) | Closed pre-v0.1 — UX implications outweighed value for the cases we'd seen. | A steward who needs "preview my remap before committing" with concrete examples. |
| [#56 — History & rollback as a separate epic](https://github.com/Fredehagelund92/zugzug/issues/56) | Folded into #45. | After #45 ships, if cross-table time-travel is asked for. |

---

## Maintenance cadence

- **Per-release:** Update the `Now` section to reflect what's actively being shipped.
- **Quarterly review:** Re-evaluate `Next` and `Later` based on inbound demand and community contributions.
- **Phase completion:** Move shipped items into the release-notes section of the corresponding tag (not into this file — git tags + GitHub releases carry that).

### When `Now` holds more than one item

The rule of one is for cognitive load, not dogma. Two items in `Now` is fine when:
- They have zero shared files or shared mental model.
- One is genuinely small (e.g. a CI gate alongside a bigger refactor).

If both conditions don't hold, ship serially.
