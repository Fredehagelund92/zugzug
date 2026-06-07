# Zugzug Roadmap

> Living document. Source of truth for sequencing. Re-reviewed at the start of each cycle.
> Each entry links to the GitHub epic; GitHub milestones (`Now`, `Next`, `Later`, `Parked`) mirror the four buckets below.

**Last review:** 2026-06-07 — Q3 2026 cycle kickoff
**Stakeholder:** Better Collective data team (Sportsbook, iGaming, Affiliates)
**North star for this cycle:** Make Zugzug safely deployable to multiple internal sub-teams.

---

## Now — Jun 2026 (weeks 1–3, due Jun 28)

The one epic actively being shipped. One thing at a time.

### [#59 — Multi-tenant workspaces (phase 1)](https://github.com/Fredehagelund92/zugzug/issues/59)
- **Why here:** Hard blocker for deployment. Sub-teams cannot share a single Zugzug instance without row isolation.
- **Children:** 20 issues ([#60–#78](https://github.com/Fredehagelund92/zugzug/milestone/2)) — Drizzle Deploy 1+2, auth middleware, TenantRepo, workspace switcher, BootGate slug pre-render, sign-in/invite flow, super-admin CLI, Settings → Team UI, RLS phase 1.5.
- **Blocker:** none.
- **Spec:** `docs/superpowers/specs/2026-06-07-multi-tenant-design.md`
- **Est. ship:** week ending Jun 28.

---

## Next — Jul 2026 (weeks 4–6, due Jul 19)

Queued behind Now. Start when #59 closes.

### [#45 — Error recovery: canonical_history + per-record revert](https://github.com/Fredehagelund92/zugzug/issues/45)
- **Why here:** First safety net for committed mutations. Pairs naturally with multi-tenancy (more editors = more accidental clobbers).
- **Children:** [#37–#44](https://github.com/Fredehagelund92/zugzug/milestone/3) — snapshot table, `withHistory` helper, `mergeCanonical` snapshot, `setFieldValue` audit fix, `revertCanonical`, History tab, revert button (admin-only), activity-feed revert events.
- **Absorbed scope (was #56):** time-travel view, full-table point-in-time restore, `map_*` reverts, schema reverts — all gated by trigger, not v1 work.
- **Blocker:** none.

### [#33 — Bulk operations in Triage + cascade delete](https://github.com/Fredehagelund92/zugzug/issues/33)
- **Why here:** Last remaining P0 UX gap from the 4/10 review. Records-mode bulk shipped; Triage hasn't.
- **Children:** [#16, #17, #18](https://github.com/Fredehagelund92/zugzug/milestone/3) — multi-select state, sticky action bar, bulk Skip/Map-to, cascade-delete opt-in.
- **Blocker:** none. Independent of #45 — can interleave.

---

## Later — Sep 2026 (weeks 7–12, due Sep 6)

Planned but not committed. Re-estimate at the mid-cycle review.

### [#54 — E1 Activity & Presence](https://github.com/Fredehagelund92/zugzug/issues/54)
- **Why here:** Unlocks the realtime-collaboration runway (E2/E3 sit on top). Designed; spec exists.
- **Children:** [#46–#53](https://github.com/Fredehagelund92/zugzug/milestone/4) — audit-log foundation, row activity API, yjs presence room, live cursors, presence strip, row badges, row_touched invalidation.
- **Blocker:** depends on #59 for tenant-scoped rooms.

### [#35 — Unified search (Cmd-K)](https://github.com/Fredehagelund92/zugzug/issues/35)
- **Why here:** Small, clearly scoped (server query layers + palette extension + sources `?focus=`). Easy win between bigger epics.
- **Children:** [#25, #26, #27](https://github.com/Fredehagelund92/zugzug/milestone/4).
- **Blocker:** none.

### [#34 — CSV Import/Export](https://github.com/Fredehagelund92/zugzug/issues/34)
- **Why here:** Power-user feature. Real value, not urgent.
- **Children:** [#19–#24](https://github.com/Fredehagelund92/zugzug/milestone/4).
- **Blocker:** none.

### AI stubs — [#3](https://github.com/Fredehagelund92/zugzug/issues/3) (Dimension Naming Assistant), [#4](https://github.com/Fredehagelund92/zugzug/issues/4) (Source Detector), [#5](https://github.com/Fredehagelund92/zugzug/issues/5) (Health Narrator)
- **Why here:** Stubs only; need brainstorming + scoping. Park-eligible if other Later items grow.
- **Blocker:** plan + spec for each.

---

## Parked

Deferred. Each entry states the **trigger** that would move it back into Now/Next/Later.

| Epic | Why parked | Trigger to reopen |
|---|---|---|
| [#55 — E2 Concurrent Editing Safety](https://github.com/Fredehagelund92/zugzug/issues/55) | Blocks on #54 presence infrastructure. | #54 ships and the first last-write-wins incident hits production. |
| [#36 — RBAC (admin/editor/viewer)](https://github.com/Fredehagelund92/zugzug/issues/36) + children [#28, #29, #31, #32](https://github.com/Fredehagelund92/zugzug/milestone/5) | Phase 1 absorbed into #59 (`tenant_member` table). | A tenant asks for non-admin roles. Reopens as "RBAC phase 2." |
| [#30 — Parse Google `hd` JWT claim](https://github.com/Fredehagelund92/zugzug/issues/30) | Standalone child of #36. Low ROI until phase 2 lands. | Reopen with #36 phase 2. |
| [#15 — Harden the scan scheduler](https://github.com/Fredehagelund92/zugzug/issues/15) + children [#6–#14](https://github.com/Fredehagelund92/zugzug/milestone/5) | Current scheduler works. Hardening is insurance, not value. | First production scan failure that loses data, or scheduler becomes a debugging hotspot. |

### Cut / Folded (Q3 2026)

| Epic | Disposition | Reopen trigger |
|---|---|---|
| [#57 — E4 Branching / What-if Sandbox](https://github.com/Fredehagelund92/zugzug/issues/57) | **Closed.** 4-quarter dependency chain, no user signal, most ambitious epic with weakest demand. | A steward asks for "preview my remap before committing" without a viable workaround. |
| [#56 — E3 History & Rollback](https://github.com/Fredehagelund92/zugzug/issues/56) | **Closed; folded into #45.** ~90% scope overlap; four extension capabilities live in #45 as future-scope. | After #45 ships, if users ask for cross-table time-travel or full point-in-time restore. |

---

## Maintenance cadence

- **Weekly:** glance at `Now` milestone progress in GitHub. No file edit needed unless something slips.
- **Cycle review (every ~12 weeks):** edit this file. Shift `Next → Now`, `Later → Next`, re-trigger parked items, archive shipped epics to the section below. Bump dates on the four milestones (close + recreate, or rename).
- **When an epic ships:** move its entry from `Now` to `Shipped` below with the close date. Close the milestone or leave for history.

### When to break out of `Now == 1 epic`

The rule of one is for cognitive load, not dogma. Two epics in `Now` is fine when:
- The runner-up is a small, well-scoped contrast piece to the main work (e.g. shipping #33 Triage bulk during a multi-tenant lull while waiting on schema review).
- Both have zero shared files / shared mental model.

If both conditions don't hold, ship serially.

---

## Shipped (Q3 2026 cycle)

_Add entries here as epics close. Format: `[#NN — Title](url) — shipped YYYY-MM-DD — note`._

- _(none yet this cycle)_

### Pre-cycle context (shipped before Q3 2026 review)

Recent waves before this roadmap existed:
- Spreadsheet pass: 7 Excel/Sheets/Airtable features (#58)
- Linked record field type with FK picker + virtual lookup columns
- Rating / URL / Email field types + `ColumnConfig` discriminated union
- DataGrid virtualisation, advanced multi-condition filtering, FilterBar
- BootGate, empty-state guards, engineer-mode toggle
- Threshold/preferences API, auto-stage + auto-commit loop, scheduler tick
- Dashboard health table, KPI cards, sort/filter toolbar
