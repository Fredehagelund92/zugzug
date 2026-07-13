# Grid Wave 5 Design: Product Features (Phase 2)

Audit §5 Phase 2 from `docs/grid-next-level-plan.md`. Deepens the product's job (governed
reference tables for dbt) — **not** Airtable parity (`ROADMAP.md:112` names that an anti-goal).
Roadmap context: `docs/grid-remaining-waves-roadmap.md` (Wave 5). Approved 2026-07-13.

## Goal

Ship the three standalone Phase-2 features that make the grid better at its actual job —
finding, mapping, and maintaining reference records. Success = search matches any visible
field, the Records→Match handoff is one click, and a table's filter survives a reload.

## Scope

**In this wave (all standalone):**
- **2.1** — Search across all visible fields + wire `/` and Cmd+F to the search box.
- **2.3** — "Map values to this record" context-menu handoff to Match mode.
- **2.4** — Persist the filter set per table.

**Deferred (gated, NOT built this wave):**
- **2.2** — "Changes with next publish" row markers. **Gated on the publish-lifecycle branch
  landing** (it supplies `changedKeys` + the staged-workflow token). Verified absent on this
  base — no `changedKeys`/staged-workflow machinery exists. When that branch lands, 2.2 gets
  its own spec. Do not stub it here.

## Global constraints (bind every item)

- **Vocabulary (CLAUDE.md):** never surface `canonical`, `raw`, `triage`, `master`, `golden`,
  `commit`, `sync`, `tenant`, `matching` in user-facing strings. Search copy stays "Search
  records…". The handoff item avoids banned words (see 2.3). The Wave 4 vocabulary gate stays
  green.
- **Data-access (CLAUDE.md):** OLTP → `postgres.js`; warehouse → DuckDB; cross-store joins in
  app code; never a DuckDB→Postgres ATTACH. **2.4 adds a field to the existing JSON
  `GridLayoutConfig` blob — no schema migration** (confirm during planning that layout is
  stored as JSON, like sort/widths/hidden, not a typed column).
- **Tenant scoping:** any changed persistence read/write stays tenant-scoped exactly like its
  neighbors (grid-layout save is already tenant-scoped).
- **Locked decisions (brainstorming 2026-07-13):** 2.1 = filter rows (extend current search to
  all visible fields), not highlight/scroll. 2.4 = auto-persist per table (like sort/widths),
  no explicit save UI.

## Item 2.1 — Search across all visible fields (+ wire `/` and Cmd+F)

**Problem.** The records search matches the label field only (`TablePane.tsx` search state feeds
a row filter that checks the label; `DataGrid.tsx:265-273` region). "find 4543 in rank" fails
silently even though the value is visible. And there's no keyboard entry to search — the `/`
shortcut was dead (removed in Wave 4, so the key is now free).

**Design.**
- Extend the search predicate to match the query (case-insensitive substring) against the
  **string form of every VISIBLE field's value** for a row — not just the label. Hidden columns
  are excluded (matches "visible fields"). Keep the existing filter-style behavior: search
  reduces the grid to matching rows (this composes with the filter bar and sort as today).
- Wire **`/`** and **Cmd/Ctrl+F** to focus the search input (and select its contents) when the
  grid/table pane is focused. `/` is free post-Wave-4; Cmd+F must `preventDefault` the browser
  find only when the grid is the active surface. Escape clears focus / the query per existing
  behavior.
- Copy unchanged: "Search records…".

**Testing.** A row whose label does NOT contain the query but whose `rank` (a visible numeric
field) DOES is included in the results; a match in a HIDDEN field is excluded; clearing the
query restores all rows. Pressing `/` focuses the search box and a typed `/` is not swallowed
elsewhere. Cmd+F focuses search and suppresses the native find within the grid.

## Item 2.3 — "Map values to this record" handoff to Match mode

**Problem.** Going from a record in Records mode to mapping source values onto it in Match mode
is a manual round-trip, even though the URL machinery already carries `?mode=match&value=`
(`MasterTables.tsx` fold logic — `foldUrlMode`, `?value=` handling).

**Design.**
- Add a row/record context-menu item — label **"Map values to this record"** (no banned
  vocabulary) — that navigates the active table into **Match mode** with that record
  preselected as the mapping target, reusing the existing `?mode=match&value=<recordKey>` URL
  contract (last-write-wins fold already handles `?value=`). Near-zero new UI: it's one menu
  item wired through the existing mode/value URL machinery.
- The menu item uses the Wave-4 menu spec (Title Case + icon; no shortcut hint needed).
- Match mode, on load with the preselected record, lands with that record as the target the
  user maps values onto (follow how Match mode already consumes `?value=`).

**Testing.** Invoking the item from a record's context menu navigates to `?mode=match&value=…`
for that record's key; Match mode opens with that record preselected. The item appears in the
record/row context menu and reads "Map values to this record".

## Item 2.4 — Persist the filter set per table

**Problem.** Filters are session state (`DataGrid.tsx:217`, `const [filterSet, setFilterSet] =
useState<FilterSet | null>(null)`) while sort, column widths, and hidden columns persist via
`GridLayoutConfig` (client `store.ts:1055`, server `repo-shared.ts:256`). A weekly "records
missing region" check rebuilds its filter every visit.

**Design.**
- Add `filterSet?: FilterSet | null` to the persisted `GridLayoutConfig` (client + server
  interfaces). It rides the SAME per-table layout persistence path as sort/widths/hidden — a
  JSON blob, so **no schema migration** (confirm during planning).
- **Auto-persist:** when the filter set changes, save it per table via the existing grid-layout
  save (debounced / the same trigger sort and widths use). On opening a table, hydrate
  `filterSet` from its `GridLayoutConfig` so the saved filter is applied immediately.
- Clearing all filter conditions persists the cleared state (so a removed filter stays removed).

**Testing.** Setting a filter, then reloading / reopening the table, restores the applied
filter from the saved layout. Sort/widths/hidden persistence is unaffected. Clearing the filter
persists empty (no stale filter resurrected). The save is tenant-scoped like the existing layout
save. A second table's filter is independent (per-table keying).

## Out of scope

- 2.2 publish-diff row markers (gated — deferred until publish-lifecycle lands).
- Record detail panel, bulk "Set value…", numeric/date filter operators (audit "Later").
- Grouping, saved views, multi-sort, footer summaries, per-row height, frozen right columns,
  export-selection (audit "Out, deliberately" — Airtable-surface anti-goals or already covered).
- Any Wave 3 perf item or Wave 4 craft item.

## Verification

- Per item: the named behavior tests above, plus `app` typecheck (and `server` typecheck for the
  `GridLayoutConfig` field addition).
- Journey checks (audit §7): search hits a non-label visible field; the handoff lands in Match
  mode with the record preselected; a filter survives reload; `/` and Cmd+F focus search.
- The Wave 4 vocabulary gate stays green (search copy + the new menu item obey the banned list).
- Full app + server suites green.
