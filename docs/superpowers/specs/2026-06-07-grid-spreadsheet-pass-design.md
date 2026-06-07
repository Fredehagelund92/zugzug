# Grid Spreadsheet Pass — Design Spec

**Date:** 2026-06-07
**Scope:** Seven Excel/Sheets/Airtable-inspired interactions added to `DataGrid` to make it feel spreadsheet-grade for reviewers working through long reconciliation queues.

---

## Overview

The `DataGrid` (`app/src/components/datagrid/DataGrid.tsx`) is already mature — cursor navigation, type-to-edit, range selection, TSV copy/paste with fill-on-paste, undo with transactions, sort, multi-condition filter, column reorder/resize/hide, nine cell types. This spec adds seven gestures and surfaces that are still missing relative to spreadsheets and Airtable:

1. **Fill handle** — drag the bottom-right corner of a selection to fill rows vertically.
2. **⌘+Arrow data-edge jump** — leap (and extend) to the next filled/empty boundary in a column.
3. **Status-bar live aggregates** — Count / Distinct / Sum / Avg of the current selection in a footer strip.
4. **Click row# / column-header to select whole row/column** — turn the gutter into a selection surface.
5. **Right-click context menu** — surface cell, row, and column actions at the click point.
6. **Conditional formatting** — per-column per-table rules that paint cells and row stripes.
7. **Field description tooltips** — hover-revealed `i` icon on headers showing the field's meaning.

Two complementary features the user picked but that another epic already owns are deferred:

- **Presence cursors** — already covered by Epic E1 (#54 and #46–53). Not in this spec.
- **Per-cell revision history** — depends on E1's audit-log foundation (#46) and row-activity API (#47). The right-click menu reserves a slot for it but the UI surface is excluded from v1.

The third bucket the user also flagged — batch actions bar enrichment — is deferred. The existing chassis (`TablePane.tsx:548-603`) is sufficient until conditional formatting and the context menu land.

---

## Architecture

Each feature is decomposed into a hook or component following the existing convention (`useGridCursor`, `useUndoStack`, `<FilterBar>`, `<ColumnHeaderMenu>`, `cells/*`):

| Feature                   | Lives in                                                       |
|---------------------------|----------------------------------------------------------------|
| Fill handle               | `useFillHandle.ts` + small render in `GridRow`                  |
| ⌘+Arrow edge jump          | extension of `useGridCursor.onKeyDown`                          |
| Status-bar aggregates     | `<StatusBar>` component + `useAggregates` hook                   |
| Row#/header click select  | folded into existing `onCellPointerDown` + header pointer-down  |
| Right-click context menu  | `<ContextMenu>` component + `useContextMenu` hook               |
| Conditional formatting    | `useConditionalFormatting` hook + rule-eval utilities + a `<ConditionalFormatPopover>` editor |
| Field description tooltips| inline in the header render + a `<FieldDescriptionEditor>` popover |

`DataGrid.tsx` orchestrates: wires hooks, mounts components, passes the relevant slices of state down. No feature's logic lives inline in `DataGrid.tsx`; the file's size should stay within a few hundred lines of where it is.

Persistence surfaces touched:

- **localStorage** — status-bar aggregate-set preference (per-user).
- **`dimension_field.field_config` JSON** — conditional formatting rules (existing column, no migration).
- **`dimension_field.description`** — new `varchar` column (one Drizzle migration).

No new tables. No backend endpoints beyond extending the existing `dimension_field` update path.

---

## 1. Fill Handle

### 1.1 Purpose
Reconcilers often stamp a freshly-chosen canonical value down a column of similar source rows. Copy/paste works but breaks flow. The fill handle makes it a single drag.

### 1.2 Gesture
- An 8×8 px square renders at the bottom-right of the current range (or single focused cell) when the grid is focused and not editing.
- Mouse-down on the handle starts a vertical drag. Drag pixels translate to row-index deltas via `elementFromPoint` on the cell under the cursor (same pattern as `onCellPointerDown` drag-select at `DataGrid.tsx:905-921`).
- Drag down → range extends to the target row, then on release every cell in the extension is overwritten with the value from the corresponding source column.
- Drag up → same, in reverse.
- Horizontal drag is a no-op (the handle clamps to the X coordinate of mouse-down).

### 1.3 Source semantics
- Source = the active range at drag-start (could be 1×1, 1×N, M×1, or M×N).
- For a 1-row source, every target row gets that row's value-per-column.
- For an M-row source, the source tiles downward (or upward) — target row `t` gets source row `t mod M`.
- The source range spans columns side-by-side. Each column extends within itself; types stay safe because no cross-column movement occurs.

### 1.4 Why vertical-only
The project's columns are strongly typed (`text | number | boolean | date | select | url | email | rating | linked`, per `types.ts:9-23`). Horizontal fill would require cross-column coercion that fails in the common case (text → number, select → date, etc.). Vertical fill stays inside one column, type stays identical, no error states to design.

### 1.5 Commit and undo
- All target writes are batched inside a single `undo.beginTransaction("fill N cells")` ... `endTransaction()` block, matching the existing `handlePaste` pattern (`DataGrid.tsx:670-682`).
- `flashCell` runs on each written cell after commit (existing helper at `DataGrid.tsx:290-300`).
- Read-only columns (`col.editable === false`) are skipped silently — the same rule paste already uses.

### 1.6 Edge cases
- Drag past the last visible row → clamp to last row.
- Drag terminates with the same source as start → no-op commit, no undo entry.
- Source spans a pinned-left column → still fills (pinned ≠ read-only).
- Virtualised rows: pointer drag relies on visible DOM. We extend the virtualiser overscan to 10 while a drag is active so the user can drag past the current render window; ref state on the hook tracks `draggingFill`.

### 1.7 Tests
- Drag-down from a 1-cell source over a select column → all target rows show the source option.
- Drag-down with a 2-row source over 6 target rows → pattern tiles `A B A B A B`.
- Drag past read-only column → that column's cells unchanged.
- Single Cmd+Z undoes the whole fill (transaction).

---

## 2. ⌘+Arrow Data-Edge Jump

### 2.1 Purpose
Navigating to "the next unmapped row" or "the last value in this column" is the spine of reconciliation. Holding arrow keys is too slow at 10k+ rows.

### 2.2 Semantics
"Empty" = `value == null || value === ""`.

Starting from cursor at column `c`, row `r`, with arrow-direction `d`:

- If `(r, c)` is **filled and the next cell in direction `d` is filled**, jump to the last filled cell in that contiguous run.
- If `(r, c)` is **filled and the next cell in `d` is empty**, jump to the first filled cell after the empty stretch (or the grid edge if none).
- If `(r, c)` is **empty**, jump to the first filled cell encountered in direction `d` (or the grid edge if none).

This is the standard Excel rule. Operates on the visible (sorted+filtered) row list — exactly the rows `sortedRows` exposes.

### 2.3 Bindings
| Keystroke      | Action                                       |
|----------------|----------------------------------------------|
| `⌘↑/↓/←/→`     | Jump cursor to the next data edge            |
| `⌘⇧↑/↓/←/→`    | Extend the range to the next data edge       |
| `⌘Home`        | Jump to (visible row 0, visible col 0)       |
| `⌘End`         | Jump to (last visible row, last visible col) |

Range extension semantics mirror existing Shift+Arrow at `DataGrid.tsx:769-801`: anchor stays, focus moves to the computed target.

### 2.4 Implementation
- Extend `useGridCursor.onKeyDown` to detect `(metaKey/ctrlKey) && Arrow` before the unmodified-arrow branch.
- A small helper `findEdge(rows, cols, getValue, fromRow, fromCol, dir): { row, col }` returns the target.
- The shift-extension lives in `DataGrid.tsx`'s `handleKeyDown` since it owns `range`. The grid forwards a `meta + shift + arrow` signal; `useGridCursor` exposes `findEdge` as a return value so the grid can use it.

### 2.5 Conflicts
- `⌘A` (select all) is already on grid-level `handleKeyDown` — unchanged.
- `⌘C/V/Z` already preempt the meta branch — unchanged. Add the meta-arrow branch with explicit `e.key.startsWith("Arrow")` guard.
- `⌘Backspace` (bulk delete selected rows) — unchanged; checks `e.key === "Backspace"` first.

### 2.6 Tests
- Cursor on a filled cell with all-filled column → `⌘↓` → cursor at last filled row.
- Cursor on a filled cell with `[filled, filled, empty, filled, filled]` below → `⌘↓` → cursor at the second filled cell (last of the contiguous run).
- Cursor on an empty cell → `⌘↓` → cursor at next filled cell.
- `⌘⇧↓` from row 1 → range anchor=row1, focus=jumped row.
- `⌘Home` from any cell → cursor at (0, 0).

---

## 3. Status-Bar Live Aggregates

### 3.1 Purpose
"How many rows did I just mark?" "How many distinct partners are in this slice?" The answer should appear without typing a query.

### 3.2 UI
- A 24px-tall footer strip at the bottom of the grid container, above the bottom border, inside the existing `focus-within:ring` shell at `DataGrid.tsx:936`.
- Visible only when the active range covers more than one cell (i.e., `range && rangeIsBig(range)`).
- Right-aligned, monospace numbers, comma-separated chips:
  ```
  Count: 412   Distinct: 87   Sum: 11,930   Avg: 28.95
  ```
- Hover a chip → tooltip with the full label ("Distinct non-empty values").
- Click any chip → small popover (anchored to the strip) with toggles for which aggregates appear. Settings persist in `localStorage` under `zz.grid.statusBar.aggregates`.

### 3.3 Computed values
| Aggregate | Definition                                                                                  | Shown when                  |
|-----------|---------------------------------------------------------------------------------------------|-----------------------------|
| Count     | cells in range with non-null, non-empty value                                                | always (default)            |
| Distinct  | unique `String(value)` of non-null values                                                    | always (default)            |
| Sum       | sum of values whose column type is `number` or `rating`                                      | range spans at least one numeric column |
| Avg       | mean of the same numeric subset                                                              | same                        |
| Min       | minimum (numeric range) or alphabetic min (text-only range)                                  | opt-in via popover          |
| Max       | maximum (numeric) or alphabetic max (text-only)                                              | opt-in via popover          |

Default visible set: `Count, Distinct, Sum, Avg`. `Min, Max` are hidden by default and toggleable.

### 3.4 Implementation
- `useAggregates(range, columns, sortedRows, getValue)` returns `{ count, distinct, sum, avg, min, max }`, memoised on `range` + `sortedRows` identity.
- `<StatusBar>` consumes it + the persisted preference. ~80 lines.
- Computation iterates the bounded range only — bounded by `computeRangeBounds`. Cheap for the typical 1-10k cell selection; for larger selections the chip values render `…` and a tooltip explains "selection too large for live aggregates" (cutoff at 100k cells).

### 3.5 Tests
- Select 5 numeric cells → Sum and Avg compute correctly; Distinct counts unique numbers.
- Select 5 text cells → Sum and Avg hidden; Count and Distinct visible.
- Mixed range (numeric + text columns) → Sum/Avg shown but only over numeric columns.
- Click strip → popover opens → toggle Min on → strip updates → reload page → Min still visible.

---

## 4. Click Row# / Column-Header to Select

### 4.1 Purpose
Clicking a row number to grab the whole row, or a column header to grab the whole column, is universal spreadsheet muscle memory. Today both gestures only sort/reorder.

### 4.2 Semantics
| Click target                          | Result                                                            |
|--------------------------------------|--------------------------------------------------------------------|
| Row number cell                       | `range` = `(thisRow, firstCol) → (thisRow, lastCol)`              |
| Column header label                   | `range` = `(firstRow, thisCol) → (lastRow, thisCol)`              |
| `⇧`+click row number / column header  | extends current range to include the clicked row/column (bbox)    |

`⌘`+click (disjoint multi-range) is **not in v1** — would require an array of ranges and rewrites of `inRange`, `handleCopy`, `handlePaste`, status-bar aggregation. Deferred.

### 4.3 Implementation
- Row number cell at `DataGrid.tsx:115-124` becomes clickable; existing render unchanged structurally. Click handler sets the range as above and focuses the grid container so keyboard immediately works.
- Column header label currently has a 200ms hold-timer that starts the reorder drag (`DataGrid.tsx:1023-1061`). The plain-click branch (timer fires without movement, then mouseup before 200ms) now sets the column range. No behavioural change to reorder.
- Both surfaces hover-change cursor to `cell` so the affordance is discoverable.

### 4.4 Edge cases
- Selecting a column then ⌘C → existing `handleCopy` already iterates the range bounds; works unchanged.
- Selecting a row then `⌫` → existing clear-range path already handles `editable === false` cells (skipped); works unchanged.
- Click the row number column header (top-left corner cell) → selects the entire grid (same as `⌘A` minus the checkbox-list selection). Useful, cheap.

### 4.5 Tests
- Click row number 5 → range covers all cells in row 5; cursor lands on `(row 5, col 0)`.
- Click column header "Label" → range covers all rows in that column.
- ⇧+click another row number → range bbox spans both rows.
- Click column header within 200ms then release without movement → column selected; no reorder triggered.

---

## 5. Right-Click Context Menu

### 5.1 Purpose
The header `⋯` menu handles column actions. Cell-level and row-level actions have no home today. Right-click is the discoverable surface every user expects.

### 5.2 Surfaces and items

**Cell context** (right-click on any body cell):
| Item                       | Action                                                                                       |
|----------------------------|----------------------------------------------------------------------------------------------|
| Copy                       | `handleCopy()` over the range (or single cell)                                               |
| Paste                      | `handlePaste()`                                                                              |
| Clear                      | existing clear-range path                                                                    |
| Filter to this value       | Adds `{ field, operator: "equals", value }` to `filterSet`                                   |
| Filter to NOT this value   | Adds `{ field, operator: "not_equals", value }` to `filterSet`                               |
| ―                          |                                                                                              |
| Insert row above           | Calls new `onInsertRow?(rowKey, "above")` prop                                                |
| Insert row below           | Calls new `onInsertRow?(rowKey, "below")` prop                                                |
| Delete row                 | Calls new `onDeleteRow?(rowKey)` prop                                                         |
| ―                          |                                                                                              |
| _Cell history_             | hidden in v1; placeholder slot for E1                                                        |

**Column-header context** (right-click on a header cell):
- Mirrors the existing `<ColumnHeaderMenu>` items (rename, sort, filter, change type, hide, delete).
- Adds **Edit description** (jumps to the field-description editor, see §7).

**Row-number context** (right-click on a row-number cell):
| Item               | Action                                  |
|--------------------|-----------------------------------------|
| Select row         | range = whole row                       |
| Insert above       | `onInsertRow?(rowKey, "above")`          |
| Insert below       | `onInsertRow?(rowKey, "below")`          |
| Duplicate          | `onDuplicateRow?(rowKey)`                |
| Delete             | `onDeleteRow?(rowKey)`                   |

`onInsertRow`, `onDeleteRow`, `onDuplicateRow` are new optional props on `DataGridProps`. Menu items render `disabled` when the host doesn't provide them.

### 5.3 Component
- `<ContextMenu>` renders absolutely-positioned at the click coordinates, clamped to viewport. Reuses `<ColumnHeaderMenu>`'s popover shell styling (line / surface-elevated / shadow-pop).
- `useContextMenu({ onContext: (kind, target, e) => …})` attaches a single `onContextMenu` listener at the grid container level and dispatches by `closest("[data-cell], [data-header], [data-row-num]")`. Each surface gets a `data-row-num` attribute added.
- `Esc` and outside-click close. Standard portal mount via `lib/open-tabs.tsx` if there's a portal helper, otherwise inline.

### 5.4 Native menu suppression
`e.preventDefault()` on the contextmenu event of the grid container is gated on whether the click hit a known surface; right-click on padding falls through to the OS menu so users aren't trapped.

### 5.5 Tests
- Right-click cell → menu opens at cursor position with cell items.
- Right-click header → menu opens with column items + Edit description.
- Right-click row number → menu opens with row items.
- "Filter to this value" → `filterSet` gains a condition; `<FilterBar>` shows it.
- Esc closes the menu; outside-click closes the menu.
- Menu auto-flips when within 8 px of the right/bottom viewport edge.

---

## 6. Conditional Formatting

### 6.1 Purpose
At-a-glance triage. "Rows with `status = conflict` glow red. Rows with `confidence < 0.5` get an amber stripe. Empty `canonical_label` cells get a red corner." Today the only way to surface state visually is to add a column.

### 6.2 Rule model

```ts
type ConditionalRule =
  | { id: string; field: string; trigger: { kind: "equals" | "not_equals"; value: string }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "contains" | "starts_with" | "ends_with"; value: string }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_empty" | "is_not_empty" }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_in"; values: string[] }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "gt" | "lt"; value: number }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "between"; min: number; max: number }; style: RuleStyle };

type RuleStyle = {
  cellBg?:   PaletteName;  // background tint on the matching cell
  textColor?: PaletteName; // text color on the matching cell
  rowStripe?: PaletteName; // 4px left-edge stripe on the entire row
};
```

`PaletteName` is the existing token type from `app/src/lib/palette.ts`. Reusing it ensures the rules read theme variables, not hardcoded hex.

A rule is **per column per table**. Storage: extend the existing JSON in `dimension_field.field_config`:

```ts
type FieldConfig =
  | SelectConfig             // existing
  | NumberConfig             // existing
  | RatingConfig             // existing
  | { rules?: ConditionalRule[]; /* always allowed alongside other config */ };
```

Rules are an additive optional property on any field's config, so a numeric column can have both `numberFormat` and `rules`. No schema migration needed — `field_config` already stores JSON.

### 6.3 Evaluation
- `useConditionalFormatting(rules, getValue)` returns `evaluateRow(row): { cellStyles: Map<field, RuleStyle>; rowStripe: PaletteName | null }`.
- Within a column, rules are evaluated in array order; first match wins. Row stripes from different columns: the first non-null `rowStripe` encountered (scanning visible columns left-to-right) wins.
- Predicates are compiled to closures when `rules` change (memoised in the hook).
- In `GridRow` render, `cellStyles.get(field)` extends the existing `cellCx` className with inline `style` attrs for bg + text color, and a `<div class="absolute left-0 top-0 bottom-0 w-1">` for the row stripe.

### 6.4 Editor
- `<ConditionalFormatPopover>` opens from the column header `⋯` menu via a new "Conditional formatting…" item.
- Modal layout:
  - List of existing rules with drag-handle to reorder, edit, delete.
  - "+ Add rule" → trigger picker (matched to the column type — number columns expose gt/lt/between, text columns expose contains/equals/etc.) → value input → style picker (three palette swatches: cellBg / textColor / rowStripe).
  - "Done" persists via `onSaveColumnRules?(field, rules: ConditionalRule[])` (new optional prop on `DataGridProps`). The host (`TablePane.tsx`) wires this to the existing field-config update endpoint.

### 6.5 Performance
- Rules evaluate per visible row × per visible column with rules. With ~50 visible rows and ~10 rules total, this is well under a millisecond per render.
- The hook returns a stable `evaluateRow` function reference across renders to avoid breaking `GridRow`'s memoisation.

### 6.6 Tests
- A rule `{ field: "status", trigger: { equals: "conflict" }, style: { rowStripe: "rose" } }` paints the stripe on matching rows.
- Two rules on the same field: first-match-wins ordering verified.
- Saving rules via the editor calls `onSaveColumnRules` with the new array.
- Removing the last rule clears the styling on the affected rows immediately.

---

## 7. Field Description Tooltips

### 7.1 Purpose
"What does `acct_src_code` mean?" needs a one-hover answer that lives with the column, not in a separate docs page.

### 7.2 Schema migration
Add a nullable `description` column to `dimension_field`:

```ts
// server/drizzle/schema.ts
export const dimensionField = app.table(
  "dimension_field",
  {
    dim_id:       varchar("dim_id").notNull(),
    field:        varchar("field").notNull(),
    label:        varchar("label").notNull(),
    type:         varchar("type").notNull(),
    created_at:   timestamp("created_at").notNull(),
    field_config: varchar("field_config"),
    description:  varchar("description"),         // NEW
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.field] })],
);
```

`bun run db:generate` produces the migration; commit it.

### 7.3 ColumnDef extension
Add optional `description?: string` to `ColumnDef<Row>` in `types.ts`. The host (`TablePane.tsx`) populates it when reading dimension fields.

### 7.4 Header render
- When `c.description` is truthy and the user hovers the header, render an `<IconInfo>` (small `i` glyph) immediately to the right of the label, before the `⋯` button (or before the filter pill if present).
- The icon is `opacity-0` by default and `group-hover:opacity-60` (same pattern as the existing `⋯` button at `DataGrid.tsx:1080-1088`).
- Hovering the `i` icon shows a `<Tooltip>` (new tiny component or existing if any) anchored below the header, max-width 320px, plain-text wrapped.
- No description → no icon (don't pollute clean headers).

### 7.5 Editor
- Column header menu (and the new right-click on header) gets an "Edit description" item.
- Clicking opens a small popover with a `<textarea>` (4 rows), Save / Cancel buttons.
- Save calls `onSaveColumnDescription?(field, description: string)` (new optional prop). Host wires to the existing field-update endpoint, which gains a `description` field in its payload.

### 7.6 Tests
- Column with description → hover header → `i` icon appears → hover icon → tooltip shows text.
- Column without description → no icon.
- Edit → save → tooltip text updates immediately.

---

## 8. Out of Scope

Explicitly **not in this spec** (each defers to a different epic or future pass):

- **Presence cursors / selection halos** — Epic E1 (#54).
- **Per-cell revision history popover** — depends on E1 audit foundation (#46–48); right-click leaves a slot.
- **Batch actions bar enrichment** — existing chassis at `TablePane.tsx:548-603` carries through; Apply-value / Comment / Export added in a separate ticket if needed.
- **Fill handle double-click → auto-fill-down** — additive on top of §1, deferred.
- **Smart Fill / Flash Fill (pattern infer from examples)** — large ML-ish surface, separate spec when prioritised.
- **AutoFilter per-column dropdown** with distinct-values checklist — `<FilterBar>` covers the use case for now.
- **Named views** — Airtable-style saved configs, larger spec.
- **Group by field** — collapsible row groups, larger spec.
- **Expand-record card** — separate spec.
- **`⌘`+click disjoint multi-range selection** — would require multi-range state across `inRange`, `handleCopy`, `handlePaste`, aggregates; defer.
- **AND/OR rule groups in conditional formatting** — flat array suffices for v1.
- **Markdown in field descriptions** — plain text for v1.

---

## 9. Testing strategy

Unit tests live in each hook's `__tests__` neighbour (matching the existing layout). Integration tests for cross-feature interplay (e.g., fill handle + undo + status-bar aggregate update) live alongside `DataGrid.test.tsx` if one exists, or get added as a new file.

Manual verification checklist (per `superpowers:verification-before-completion`):

1. Drag fill handle down over 50 rows in a `select` column → all rows show the source option chip; one Cmd+Z undoes them all.
2. `⌘↓` from row 0 with all-filled column → cursor lands on last row.
3. Select 20 rows × 3 columns → status bar shows Count, Distinct, Sum (if numeric).
4. Click row number → row highlighted; ⌫ clears the row.
5. Right-click a cell → context menu opens; "Filter to this value" populates `<FilterBar>`.
6. Add a conditional rule "status equals conflict → rose row stripe" → all matching rows show the stripe immediately; remove the rule → stripes disappear.
7. Set a description on a field → hover header → `i` icon → tooltip text.

---

## 10. Migration

One Drizzle migration: add `description varchar` to `dimension_field`. Generated via `bun run db:generate` after the schema edit. No data backfill — column nullable, defaults to `NULL`.

No other schema or store changes.
