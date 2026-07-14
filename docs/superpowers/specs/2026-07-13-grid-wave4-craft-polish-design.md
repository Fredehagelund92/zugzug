# Grid Wave 4 Design: Craft Polish (feels-cheap 1.10–1.21 + kill list)

Audit items §4 "feels-cheap" (1.10–1.21) and §6 kill list from `docs/grid-next-level-plan.md`.
Closes Phase 1's craft debt. Roadmap context: `docs/grid-remaining-waves-roadmap.md` (Wave 4).
Approved 2026-07-13 as one coherent full-sweep pass. Design decisions locked below.

## Goal

Make the grid feel intentional, not vibe-coded: one menu system everywhere, correct number
handling, real feedback on copy/edit, no layout shift, no React warnings, no vocabulary leaks,
and no dead code. Success = every feels-cheap defect closed (or explicitly deferred with a
reason) and the §7 vocabulary grep clean.

## Global constraints (bind every item)

- **Vocabulary (CLAUDE.md, sign-off gate):** never surface `canonical`, `raw`, `triage`,
  `master`, `golden`, `commit`, `sync`, `tenant`, `matching`. Prefer a concrete example over an
  abstract term. Item 1.10 is the sweep; the final grep over user-facing strings is the wave's
  exit gate (§7 of the audit).
- **Data-access (CLAUDE.md):** OLTP → `postgres.js`; warehouse → DuckDB; cross-store joins in
  app code; never a DuckDB→Postgres ATTACH. **No schema migration this wave** (1.11 is boundary
  coercion, not a data-model change — decision below).
- **Tenant scoping:** any new/changed query stays tenant-scoped exactly like its neighbors.
- **Behavior-preserving unless stated:** these are craft edits. Where an item changes behavior
  (1.12 type-to-edit, 1.15 pinned-column menus, 1.18 optimistic modal) it is called out.
- **Surgical:** each item traces to an audit defect; no unrelated refactoring. The menu
  unification (1.14) is the one deliberate cross-cutting change.

## Locked design decisions (from brainstorming, 2026-07-13)

1. **Menu spec:** all grid menus standardize on **Title Case labels + leading icon + right-aligned
   ⌘ shortcut hints** (Linear/Airtable-like). Applies to column, context, and filter menus.
2. **1.11 numbers:** **boundary coercion, no migration** — right-align + thousands-format at the
   cell; coerce numeric fields with `Number()` at the read/aggregate boundary; normalize on write.
   Storage untouched.
3. **1.10 internal leaks** (e.g. "next position: 6144"): **delete outright** from the UI. No
   engineer-mode gate.
4. **Kill-list #4 "Duplicate":** **remove** the item + dead `onDuplicateRow` prop. Not implemented.

---

## Section A — Menu unification (1.14, 1.15)

**Problem.** Two incoherent menu systems: column menu is mono lowercase w/ icons (one item wraps,
misaligned icon); context menu is sans Title Case, no icons/shortcut hints; filter popover uses
lowercase "apply"; "Create field" button reads disabled when enabled. Pinned "Record"/key columns
have no header menu (`DataGridHeader.tsx:374` `!c.pinnedLeft` gate) — can't sort/filter the primary
columns from the grid.

**Design.**
- One shared menu presentation (a single menu-item component or a shared class set) used by the
  column menu, context menu, and filter popover: Title Case label, optional leading icon slot,
  optional right-aligned ⌘ hint slot. Retire the mono-lowercase styling.
- Normalize existing labels to Title Case ("apply" → "Apply", "Create field" enabled state fixed).
- Remove the `!c.pinnedLeft` gate in `DataGridHeader.tsx:374` so pinned/key columns get the same
  header menu (sort/filter the Record column from the grid).

**Testing.** Render tests: a menu item renders label + icon slot + ⌘ hint slot consistently across
the three menus (no mono-lowercase remnants); the pinned Record column exposes a header menu with
sort/filter actions. Visual check both themes for alignment (no wrapping/misaligned icon).

## Section B — Editing correctness (1.11, 1.12)

**1.12 type-to-edit.** Today typing over a selected cell appends and eats the first keystroke
("First Record" + "Renamed" → "First Recordenamed"); header rename doesn't select-all
("StatusStage"). Fix to the Excel/Airtable convention: starting to type on a focused (non-editing)
cell **replaces** content and **includes the first keystroke**; entering header rename selects-all.
Files: `useGridCursor.ts` / `DataGridHeader.tsx`. Test: typing a char on a focused cell opens the
editor containing exactly that char (replacing prior value); header rename opens with text selected.

**1.11 numbers.** Renderer puts `text-right tabular-nums` on an inline span that shrinks to content
(`NumberCell.tsx:98`); values stored as strings so `useAggregates.ts:50` (`typeof v === "number"`)
never sums ("Sum: – Avg: –" over three cells of 100). Fix (boundary coercion, no migration):
- Align the whole **cell** right (not the inner span) and format with thousands separators
  ("4,543") for display.
- Normalize numeric input on write (strip formatting to a canonical numeric string).
- In `useAggregates.ts`, coerce numeric-typed fields via `Number()` (guard `NaN`) so Sum/Avg work.
Test: three numeric cells of 100 → Sum 300 / Avg 100; a numeric cell renders right-aligned and
comma-formatted; a non-numeric value in a numeric field is excluded from aggregates without throwing.

## Section C — Feedback & motion (1.13, 1.16, 1.19, 1.20)

- **1.13 copy feedback.** ⌘C on a range has no flash/"Copied". Add a brief range flash + a "Copied"
  toast. Test: copying a range dispatches the toast and applies the flash class to the range.
- **1.16 truncated-cell reveal.** Ellipsized cell values lack `title`/tooltip; headers already
  hover-expand (`DataGridHeader.tsx:512-537`). Add a title attr (or the same expand-on-hover) for
  truncated cells. Test: a truncated cell carries the full value in `title` (or reveals on hover).
- **1.19 rename banner.** Confirmation banner inserts in document flow above the grid, shifting
  layout and letting gridlines paint through. Make it an **overlay toast** (no flow element). Test:
  the rename confirmation does not change grid layout height.
- **1.20 first-paint settle.** Cold open fades in and settles ~8px. Reserve heights in the skeleton
  so first paint doesn't jump. Test: skeleton reserves the row/toolbar heights (no post-load shift
  assertion via layout metric or a snapshot of reserved dimensions).

## Section D — Vocabulary sweep (1.10)

**Problem & replacements** (governed by CLAUDE.md; final grep is the exit gate):
- "5,295 **raw**" in every table meta line (`TablePane.tsx:764`) → "5,295 **source values**".
- "**master record**" (`settings/Warehouse.tsx:181`) → "**record**".
- "next position: 6144" dev counter shown to all users → **deleted** from the UI.
- "pick survivor…" merge copy → "**Keep which record?**" (and survivor-picker labels reworded).
- "new a record…" grammar (`TablePane.tsx:1454` interpolates the table name blindly) → "**New
  record**" (fixed interpolation).

**Testing.** A test (or CI grep) asserts no banned term appears in user-facing strings across the
grid + settings surfaces touched. The wave is not signed off until this grep is clean.

## Section E — Bugs (1.17, 1.18)

**1.17 React warnings.** "Cannot update RecordsBody while rendering DataGrid" on every column
resize/reorder (setState-in-render in `DataGridHeader.tsx` resize/drag state); duplicate `Review`
key in the palette (`ShortcutsOverlay.tsx:25,53` / `CommandPalette.tsx`). Fix: defer the resize/
reorder state updates out of render (effect/handler, not render body); de-duplicate the palette key.
Test: rendering + simulating a resize/reorder produces no console error/warning; palette keys are
unique.

**1.18 create-table modal hangs >10s; add-field ~3.4s, no progress.** Synchronous warehouse DDL
holds the modal (`CreateTableModal.tsx`, `AddFieldPopover.tsx`, `server/src/tables.ts`). Fix:
**optimistic close** — the modal closes immediately and the new table appears as a **pending tab**
(spinner/provisioning state) while DDL runs in the background. **On failure:** the pending tab shows
an inline error with a **retry**; dismissing it removes the pending tab (no silent orphan). Add-field
gets the same optimistic treatment (pending field state). Test: submitting create closes the modal
synchronously and shows a pending tab; a simulated provisioning failure surfaces the retry/error and
removes the tab on dismiss.

## Section F — Shortcuts + kill list (1.21, §6)

**1.21.** `useGridCursor.ts:369-378` preventDefaults `/` for a callback no host passes (blocks
typing a leading `/`) and the overlay advertises it (`ShortcutsOverlay.tsx:21`); `DataGrid.tsx:976-980`
"Duplicate" is gated on unimplemented `onDuplicateRow`. Fix: **remove** the dead `/` shortcut
(search wiring is Wave 5's 2.1, not this wave), sync the shortcuts overlay to the real shortcut set,
and remove the Duplicate item.

**Kill list (§6):**
1. `density` prop + both branches (`types.ts:168-169`, `DataGrid.tsx:189-190,483`) — zero call sites.
2. Dead `onFocusFilter`/`onShortcuts` params in `useGridCursor` (`useGridCursor.ts:76-77,369-378,409-410`).
3. Stale ShortcutsOverlay rows (`ShortcutsOverlay.tsx:21,25,53`) — with 1.21.
4. "Duplicate" context item + `onDuplicateRow` prop (`DataGrid.tsx:976-980`, `types.ts:176`) — **remove**.
5. Legacy presence path `/ws/presence/:tableId` (`server/src/server.ts:1602-1604`) — deprecation elapsed.
6. Legacy `?dimId=` URL fold (`MasterTables.tsx:40-45`).

Items #1/#5/#6 stand alone; #2/#3/#4 ride their feature items (1.21). Each removal: delete + confirm
no remaining references (grep) + tests/typecheck green.

## Out of scope

- Wave 5 features (search / `/` + Cmd+F wiring, map-to-record handoff, filter persistence, publish
  markers). Removing the dead `/` shortcut here does **not** implement search.
- The Phase-1 "nice-to-have" tail (prefers-color-scheme, `--ink-3` contrast, fill-handle visibility,
  column-drag ghost, swatch clip, dropdown chips, stale chip, Undo scope label) — fold in
  selectively only if trivial alongside a related item; not required for sign-off.
- Any perf item (Wave 3) or data-model/migration change.

## Verification

- Per section: the named render/behavior tests above, plus `app` typecheck and `server` typecheck.
- Re-walk the affected Track B journeys (edit, copy/paste, structure, filter/sort, keyboard) and
  confirm each closed defect.
- **Exit gate:** the §7 vocabulary grep over user-facing strings is clean; no banned term remains.
- Full app + server suites green.
