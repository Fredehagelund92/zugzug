# Zugzug Roadmap

> Living document. Source of truth for sequencing. Re-reviewed at the start of each cycle.
> Each entry links to the GitHub epic; GitHub milestones (`Now`, `Next`, `Later`, `Parked`) mirror the four buckets below.

**Last review:** 2026-06-08 — OSS pivot cycle kickoff (supersedes Q3 2026 BC cycle, paused)
**Stakeholder:** OSS contributors + BC data team (BC's deployment continues, but BC-specific features are paused until post-v1.0)
**North star for this cycle:** Ship v1.0 as an open-source curation UI for the dbt stack, with DuckDB/MotherDuck + Snowflake adapter support.

**Pivot context:** see `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` for the full design and rationale.

---

## Now — Jun 2026 (weeks 1–3, due Jun 28)

The one epic actively being shipped. One thing at a time.

### Phase 1 — Extract `WarehouseAdapter` against DuckDB only
- **Why here:** Load-bearing refactor for the entire pivot. The Snowflake adapter (Phase 2) can't start until the abstraction exists.
- **Children:** WarehouseAdapter interface + types + isWritable guard; Zod credentials union + factory registry; `warehouse/duckdb/` extraction; route every `repo-scan` / `repo-meta` / `repo-canonical` / `repo-shared` callsite through the adapter; kill `whTable()` and direct DuckDB calls in app code.
- **Verification gate:** all existing tests pass; UI smoke equivalent to today; zero raw DuckDB calls outside `warehouse/duckdb/`; zero `whTable()` callsites remaining.
- **Blocker:** none.
- **Spec:** `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (Phase 1).

---

## Next — Jul 2026 (weeks 4–6, due Jul 19)

Queued behind Now. Start when Phase 1 closes.

### Phase 2 — Implement `SnowflakeAdapter` (gating phase)
- **Why here:** This is the load-bearing technical bet of the pivot. If two adapters can't share a meaningful interface, the abstraction failed and the pivot stops.
- **Children:** Snowflake free-trial setup; `snowflake-sdk` key-pair auth; `warehouse/snowflake/` adapter implementation; identifier casing + qualifyRef per-adapter; `CAST AS VARCHAR` cast policy; `INFORMATION_SCHEMA` catalog browsing; end-to-end Sources → Triage → commit-to-warehouse flow against real Snowflake.
- **Verification gate:** full flow works against Snowflake; `commitCanonical` produces correct `dim_*`/`map_*` rows; hand-written dbt `LEFT JOIN` returns expected results.
- **Abort point:** if the interface can't generalize, stop the pivot.
- **Blocker:** Phase 1.

### Phase 3 — Canonical-store modes (week 7–8)
- **Why here:** Cashes in the configurable canonical-store decision. Both writable-warehouse and Postgres-export paths must work before BC-isms can be stripped.
- **Children:** `WritableWarehouseAdapter.commitCanonical` (Snowflake MERGE); `ReadOnlyWarehouseAdapter.exportCanonicalSnapshot` (DuckDB-driven Parquet writer over Postgres canonical); workspace upgrade backfill path; dashboard canonical-destination badge; commit-affordance copy per mode.
- **Verification gate:** both modes round-trip end-to-end; mode-upgrade backfill verified once.
- **Blocker:** Phase 2.

---

## Later — Aug–Sep 2026 (weeks 9–12, due Sep 6)

Planned but not committed. Re-estimate at the mid-cycle review.

### Phase 4 — Strip BC-isms (weeks 9–10)
- **Why here:** Cosmetic and policy refactor; only worth doing once the adapter abstraction has cleared its gate.
- **Children:** Auth refactor (argon2 local password + `openid-client` OIDC plugin + API tokens); engineer-mode default flip; workspace UI gating behind `ZUGZUG_MULTI_TENANT`; seed-data scrub; copy sweep.
- **Verification gate:** clean self-host walkthrough works on a fresh machine.
- **Blocker:** Phase 3.

### Phase 5 — Legal + scrub (week 11)
- **Why here:** Must happen before public push; legal sign-off has indeterminate timing so start parallel conversations early.
- **Children:** BC legal sign-off on IP assignment + MIT release; `git-filter-repo` history scrub; LICENSE (MIT) + NOTICE + CONTRIBUTING.md (DCO) + SECURITY.md; GitHub repo rename; `license-checker` in CI with GPL/AGPL/SSPL deny-list.
- **Verification gate:** secrets grep returns nothing; license audit clean; legal sign-off in writing.
- **Blocker:** Phase 4. (Legal conversation should start in parallel during Phase 1.)

### Phase 6 — Public push + v1.0 tag (week 12)
- **Why here:** The launch itself.
- **Children:** Force-push scrubbed history to fresh public repo; tag `v1.0.0`; launch posts (HN, dbt Slack, r/dataengineering); issue templates for "add adapter for X."
- **Verification gate:** docs render; install works on clean machine in <10 min; contributor can scaffold a new adapter from the example.
- **Blocker:** Phase 5.

---

## Post-v1.0 (v1.1+) — community-PR-welcome bucket

Captured in the spec as out-of-scope for v1.0. Promote to `Later` post-launch based on inbound demand or community PRs.

| Item | Trigger to promote |
|---|---|
| BigQuery adapter | Community PR or 5+ inbound issues asking for it |
| Databricks adapter | Same |
| Postgres-as-warehouse adapter | Community PR or self-host request |
| Redshift adapter | After Postgres-as-warehouse lands (PG wire protocol) |
| dbt package `zugzug_utils` (macros over `dim_*`/`map_*`) | v1.0 launch metrics show dbt-team adoption |
| S3/GCS snapshot push, scheduled exports, webhook-on-commit | First user request for scheduled exports |
| OIDC web-UI configuration | Cloud offering, if it ever exists |
| Workspace switcher UI for self-hosters | Cloud offering trigger |
| `Sql` branded-type project-wide cleanup | Any project-wide refactor touching `qid`/`cq`/`whTable` |

---

## Parked — BC-internal work (paused 2026-06-08 by OSS pivot)

These epics were in the BC Q3 2026 cycle. They are paused, not cancelled. Reopen post-v1.0 if BC's deployment still needs them and they're not already covered by v1.0 features.

| Epic | Why parked | Trigger to reopen |
|---|---|---|
| [#59 — Multi-tenant workspaces (phase 1)](https://github.com/Fredehagelund92/zugzug/issues/59) | Schema/middleware work preserved; UI gated behind `ZUGZUG_MULTI_TENANT`. Surfacing for OSS would close the open-core door. | BC asks for multi-tenant UI on their deployment, or cloud product begins. |
| [#45 — Error recovery: canonical_history + per-record revert](https://github.com/Fredehagelund92/zugzug/issues/45) | Not blocking for v1.0; first OSS users won't accumulate enough state for revert to matter on day one. | After v1.0 ships, or first incident where committed mutations need rolling back. |
| [#33 — Bulk operations in Triage + cascade delete](https://github.com/Fredehagelund92/zugzug/issues/33) | UX gap; not adoption-blocking for OSS launch. | After v1.0 ships, or first community feature request. |
| [#54 — E1 Activity & Presence](https://github.com/Fredehagelund92/zugzug/issues/54) | Realtime is a v1.1+ feature; v1.0 ships with current presence. | After v1.0 ships. |
| [#35 — Unified search (Cmd-K)](https://github.com/Fredehagelund92/zugzug/issues/35) | Nice-to-have; doesn't differentiate the OSS pitch. | After v1.0 ships. |
| [#34 — CSV Import/Export](https://github.com/Fredehagelund92/zugzug/issues/34) | The Parquet export endpoint covers the launch-critical "get my data out" path. CSV import is a v1.1 feature. | After v1.0 ships. |
| AI stubs — [#3](https://github.com/Fredehagelund92/zugzug/issues/3), [#4](https://github.com/Fredehagelund92/zugzug/issues/4), [#5](https://github.com/Fredehagelund92/zugzug/issues/5) | Stubs; need brainstorming + scoping. Not adoption-blocking. | After v1.0 ships. |
| [#55 — E2 Concurrent Editing Safety](https://github.com/Fredehagelund92/zugzug/issues/55) | Was already parked behind #54. | #54 ships + first last-write-wins incident. |
| [#36 — RBAC phase 2](https://github.com/Fredehagelund92/zugzug/issues/36) | Phase 1 absorbed into #59. | A tenant asks for non-admin roles. |
| [#30 — Parse Google `hd` JWT claim](https://github.com/Fredehagelund92/zugzug/issues/30) | Google-OAuth-specific; OIDC refactor in Phase 4 supersedes the pattern. | Probably never; superseded. |
| [#15 — Scan scheduler hardening](https://github.com/Fredehagelund92/zugzug/issues/15) | Current scheduler works. | First production scan failure that loses data. |

---

## Cut / Closed doors (2026-06-08 pivot)

Decisions taking items off the table. See spec for full rationale.

| Item | Disposition | Reopen trigger |
|---|---|---|
| Generic-MDM positioning | Killed by competitive landscape (Tamr/Stibo own that lane) | Never — explicit anti-goal |
| Airtable-shaped features (rich types, attachments, app builder) | Killed by positioning discipline | Never — explicit anti-goal |
| ADBC as the warehouse abstraction | Wrong for Node stack in 2026 (no production binding, no Databricks driver) | Production Node ADBC binding with Databricks + Snowflake + BigQuery coverage |
| OpenRefine Reconciliation API | Dropped for focus, not parked | 10× distribution opportunity tied specifically to OpenRefine community |
| Apache-2.0 + CLA + BSL escape hatch | Closed by MIT+DCO choice — one-way door | Effectively closed; would require every contributor to relicense |
| Pre-launch rebrand | Deferred to "if traction" | Blizzard cease-and-desist, USPTO opposition, or genuine breakout |
| [#57 — E4 Branching / What-if Sandbox](https://github.com/Fredehagelund92/zugzug/issues/57) | Already closed pre-pivot | A steward asks for "preview my remap before committing" |
| [#56 — E3 History & Rollback](https://github.com/Fredehagelund92/zugzug/issues/56) | Folded into #45 pre-pivot | After #45 ships, if cross-table time-travel asked for |

---

## Maintenance cadence

- **Weekly:** glance at `Now` milestone progress in GitHub. No file edit unless something slips.
- **Phase-completion review:** edit this file. Move completed phase to `Shipped` below; promote next phase from `Next` to `Now`.
- **Cycle review (every ~12 weeks):** full file rewrite. After v1.0 launch, the post-v1.0 bucket starts populating `Now`/`Next`/`Later` based on community signal.

### When to break out of `Now == 1 epic`

The rule of one is for cognitive load, not dogma. Two epics in `Now` is fine when:
- One is a small, well-scoped contrast piece (e.g. starting BC-legal conversations during Phase 1 engineering).
- Both have zero shared files / shared mental model.

If both conditions don't hold, ship serially.

---

## Shipped (OSS pivot cycle)

_Add entries here as phases close. Format: `Phase N — Title — shipped YYYY-MM-DD — note`._

- _(none yet this cycle)_

### Pre-pivot context (shipped before 2026-06-08 OSS pivot)

Q3 2026 BC cycle work shipped before the pivot decision:
- Spreadsheet pass: 7 Excel/Sheets/Airtable features (#58)
- Linked record field type with FK picker + virtual lookup columns
- Rating / URL / Email field types + `ColumnConfig` discriminated union
- DataGrid virtualisation, advanced multi-condition filtering, FilterBar
- BootGate, empty-state guards, engineer-mode toggle
- Threshold/preferences API, auto-stage + auto-commit loop, scheduler tick
- Dashboard health table, KPI cards, sort/filter toolbar
- Multi-tenant workspaces phase 1 schema + middleware (UI gated post-pivot)
