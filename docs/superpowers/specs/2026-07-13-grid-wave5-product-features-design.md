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
  `GridLayoutConfig` blob — no schema migration.** Confirmed: `user_grid_layout.config` is a
  `varchar` column persisted as `JSON.stringify(config)` (`repo-meta.ts:setGridLayout`); widening
  the interface only widens the stored string.
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
is a manual round-trip.

**Mechanism correction (from spec self-review):** the existing `?value=` param does **not**
preselect a target record — it pins a specific *source-value row* (`MatchModeBody.tsx:252-262`,
"points at a specific row"). Match mode's model is: rows are source values, and `stageMap(value,
label)` maps a source value onto a canonical record by **label** (`keyFor(label)` resolves the
key). So a record→target handoff needs a **new** URL param, not `?value=`. This is a real (small)
Match-mode change, not "near-zero UI".

**Design.**
- **New URL param `?target=<recordKey>`.** Add it to the mode/value URL machinery in
  `MasterTables.tsx` alongside `?value=` (same fold + last-write-wins management; drop `target`
  whenever `mode !== "match"`, exactly as `value` is dropped).
- **Records context-menu item** — label **"Map values to this record"** (no banned vocabulary),
  Wave-4 menu spec (Title Case + icon, no shortcut). It navigates the active table to
  `?mode=match&target=<record.key>` for the right-clicked record.
- **Match mode consumes `?target=`** at mount (active pane only, mirroring the `?value=` ref
  pattern at `MatchModeBody.tsx:257`): resolve `target` (a record key) → its label via
  `dim.canonical.find((c) => c.key === target)?.label` (store the ID, render the name — CLAUDE.md
  master-table convention). Set a **default mapping target** state = that record, and surface a
  dismissible affordance ("Mapping values to <label>"). While a default target is set, the
  primary map action assigns the selected/acted source value(s) to that record via the existing
  `stageMap(value, label)` — no change to the draft/undo machinery. Also switch the status filter
  to **"new"** (unmapped) so the user lands on the values that still need mapping. Clearing the
  affordance drops the default target (and the `?target=` param).
- If `target` resolves to no record (stale key), ignore it (no default target, no crash) — same
  tolerance as a stale `?value=`.

**Testing.** Invoking the item from a record's context menu navigates to
`?mode=match&target=<record.key>`. Match mode, on that deep link, resolves the key to the record's
label, shows the "Mapping values to <label>" affordance, and defaults the status filter to "new".
Mapping a source value while the default target is set stages it to that record (`stageMap` with
the record's label/key). A stale/unknown `target` key is ignored gracefully. Dismissing the
affordance clears the default target and the `?target=` param. The menu item reads "Map values to
this record" and obeys the vocabulary gate.

## Item 2.4 — Persist the filter set per table

**Problem.** Filters are session state (`DataGrid.tsx:217`, `const [filterSet, setFilterSet] =
useState<FilterSet | null>(null)`) while sort, column widths, and hidden columns persist via
`GridLayoutConfig` (client `store.ts:1055`, server `repo-shared.ts:256`). A weekly "records
missing region" check rebuilds its filter every visit.

**Design.**
- Add `filterSet?: FilterSet | null` to the persisted `GridLayoutConfig` (client + server
  interfaces). It rides the SAME layout persistence path as sort/widths/hidden — the
  `user_grid_layout.config` JSON blob keyed `(user_id, dim_id)`, so **no schema migration**.
  Persistence is therefore **per user, per table** (each user keeps their own filter — the same
  scoping widths/sort already use; "per table" in this doc means per-user-per-table).
- Note the server `setGridLayout` expects a **complete** config (partial merge is the client's
  job), so the client must include the current `filterSet` in the full config it saves.
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
