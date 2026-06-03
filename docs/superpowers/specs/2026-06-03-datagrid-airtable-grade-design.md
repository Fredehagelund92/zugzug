***REMOVED*** DataGrid: Airtable-grade inline CRUD for master lists & value matching

**Date:** 2026-06-03
**Status:** Design — pending implementation plan
**Scope:** `app/src/routes/MasterTables.tsx` and `app/src/routes/Mapping.tsx`, plus a new shared `<DataGrid>` primitive

***REMOVED******REMOVED*** Goal

Bring `MasterTables` and `Mapping` to a "database-grade" inline editing experience comparable to Airtable / Notion databases, while keeping the existing aesthetic (light mode, monospace labels, square corners, soft-fill palette). The two routes remain distinct (Mapping is a triage workflow, MasterTables is a CRUD grid), but they share a single underlying grid primitive so the keyboard, undo, and cell-rendering feel are identical across the app.

The headline feature is **single-select chip cells** with Airtable-style behavior: options can be pre-defined when a column is created OR added inline ("Create 'EMEA'") while editing any cell. Beyond that, the v1 brings the baseline polish that makes a grid feel professional: keyboard cell navigation, an undo stack, a column header menu, and column resize + reorder.

***REMOVED******REMOVED*** Non-goals (deferred)

- **Other rich cell types** — multi-select, link-to-dimension, URL, formula. Single-select only in v1.
- **Saved views** — Airtable-style filter + sort + visible-columns presets are not in v1. `app.user_grid_layout` (introduced below) is intentionally narrower; saved views, when added, will be a sibling table.
- **Cell-level row locking / realtime presence cursors** — collaborative editing stays at the draft-batch level. Concurrent edits can still race on the same cell; we surface "row changed elsewhere — refresh" softly rather than locking.
- **Virtualization** — current row counts (≤ a few hundred per dimension) don't need it. The `<DataGrid>` API leaves a clean spot to add it later without breaking consumers.
- **Per-option color overrides** — chip color is deterministic from a hash of the option label. No user-pickable colors in v1.
- **Multi-column sort.**

***REMOVED******REMOVED*** Architecture

A new component lives at `app/src/components/datagrid/`:

```
datagrid/
  DataGrid.tsx              — layout, sticky header, virtualization seam
  useGridCursor.ts          — focused (rowKey, field) + keyboard handler
  UndoStack.tsx             — in-memory undo provider, ⌘Z / ⌘⇧Z
  ShortcutsOverlay.tsx      — '?' modal
  cells/
    TextCell.tsx
    NumberCell.tsx
    BooleanCell.tsx
    DateCell.tsx
    SelectCell.tsx          — single-select chip + picker (new in v1)
  Chip.tsx                  — shared chip rendering (bucket → color)
  bucket.ts                 — deterministic label → palette bucket
```

Both routes become thin column-def configs that mount `<DataGrid>`. They keep their own toolbars, footers, route-specific affordances (Mapping's filter tabs and review/publish footer; MasterTables's import bar). The grid is the body; the route owns the chrome.

***REMOVED******REMOVED******REMOVED*** Contract

```ts
interface DataGridProps<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: ColumnDef<Row>[];
  selection?: { selected: string[]; onChange: (next: string[]) => void };
  onCommit: (rowKey: string, field: string, value: unknown) => Promise<void>;
  // grid-layout config (widths/order/hidden) is wired via a hook that reads
  // and writes app.user_grid_layout for the active dimension
}

interface ColumnDef<Row> {
  field: string;                   // stable id
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  width?: number;                  // px, persisted
  hidden?: boolean;
  sortable?: boolean;
  editable?: boolean;
  pinnedLeft?: boolean;            // checkbox / label / key are pinned, can't be reordered
  // for select:
  options?: string[];              // ordered list of allowed labels
  // route-specific escape hatches (Mapping uses these for its target combobox cell, etc.)
  render?: (row: Row, ctx: CellCtx) => ReactNode;
  edit?: (row: Row, ctx: EditCtx) => ReactNode;
}

interface SelectOption { label: string }
// Note: there's no separate option-id. The label IS the identity.
// Renaming an option is a labeled migration (see "Single-select column type").
```

***REMOVED******REMOVED*** Single-select column type

***REMOVED******REMOVED******REMOVED*** Storage

`FieldDef` in `app/src/data.ts` (and its server counterpart) extends:

```ts
interface FieldDef {
  field: string;
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: string[];   // only set when type === "select"; ordered list of allowed labels
}
```

Cell value remains a plain string (the option label). No separate option-id table — labels ARE the identity, matching how canonical labels work elsewhere (`renameCanonical` is the precedent).

***REMOVED******REMOVED******REMOVED*** Color bucketing

5 buckets drawn from the existing palette tokens (no new colors introduced):

| Bucket | CSS background | Text color | Token |
|---|---|---|---|
| `chip-1` | `var(--ok-soft)` | `var(--ok)` | green |
| `chip-2` | `var(--warn-soft)` | `var(--warn)` | amber |
| `chip-3` | `var(--accent-soft)` | `var(--accent)` | magenta |
| `chip-4` | `color-mix(--accent-2 16%, transparent)` | `***REMOVED***B8780F` | orange |
| `chip-5` | `var(--surface-2)` | `var(--ink-2)` | neutral |

```ts
const BUCKETS = ["chip-1", "chip-2", "chip-3", "chip-4", "chip-5"] as const;
const bucket = (label: string) => BUCKETS[hash32(label.toLowerCase()) % 5];
```

Same label → same bucket, always, across every column in every dimension. No "color drift" when the option list reorders.

***REMOVED******REMOVED******REMOVED*** Picker UI

`SelectCell.Editor` opens on Enter (or click) on a focused select cell:

```
┌─────────────────────────┐
│ [search………………………………]    │  typeahead filter
├─────────────────────────┤
│ ▸ EMEA                  │  arrow keys + Enter to pick
│   AMER                  │
│   APAC                  │
├─────────────────────────┤
│ + Create "Antarctica"   │  shown only when search text matches no option
└─────────────────────────┘
```

Picking commits via `onCommit(rowKey, field, value)`. Creating an option calls `addColumnOption(dimId, field, label)`, which appends to `FieldDef.options` server-side and selects the new option in the cell in one round-trip. The "create" affordance is available to any user in v1 — the app has no role distinction today (everyone in `app.users` can edit), so there's no governance gate to add yet.

***REMOVED******REMOVED******REMOVED*** Type conversion (text → select)

When the header menu's "change type → select" is used on a text column, the server collects distinct existing values, seeds them as `options`, and the existing cell values stay valid (every cell already matches an option). No data loss.

Other conversions:
- `→ number` / `→ date` / `→ boolean`: server validates every existing value parses. If any fails, the API returns `{ ok: false, invalidCount: N }` and the UI prompts: "12 values won't parse — coerce to empty, or cancel?"
- `→ text`: always safe.

***REMOVED******REMOVED*** Keyboard navigation

***REMOVED******REMOVED******REMOVED*** Cursor model

`useGridCursor()` owns a single `(rowKey: string, field: string)` cursor. Tab order goes left-to-right within a row, top-to-bottom across rows, skipping `hidden` columns and pinned utility columns (checkbox, action). The cursor is visualized by an inset accent ring on the focused cell (`box-shadow: inset 0 0 0 1.5px var(--accent)` + a 6%-opacity accent background).

***REMOVED******REMOVED******REMOVED*** Bindings

Attached to the grid container, not `window` (so it never fights the browser address bar):

| Key | When | Action |
|---|---|---|
| `↑ ↓ ← →` | not editing | move cursor |
| `Enter` | not editing | enter edit mode (open picker for select; focus input for text/number/date) |
| `Enter` | editing | commit + move down |
| `Tab` / `Shift+Tab` | editing or not | commit + move right / left |
| `Esc` | editing | cancel + exit edit mode |
| `Space` | not editing, checkbox col focused | toggle row selection |
| `Cmd+A` | not editing | select all visible rows |
| `Cmd+Z` / `Cmd+Shift+Z` | anywhere in grid | undo / redo |
| `Cmd+Backspace` | not editing, row(s) selected | bulk remove (uses selection-bar action) |
| `/` | not editing | focus the search/filter chip in the toolbar |
| `?` (Shift+/) | anywhere | open shortcuts overlay |

***REMOVED******REMOVED******REMOVED*** Mapping-specific shortcuts

These exist only on the Mapping route, layered on top of the grid bindings:

| Key | Action |
|---|---|
| `A` | accept suggestion (focused row) |
| `M` | open target master picker |
| `S` | skip |
| `R` | reset (discard draft) |
| `Cmd+Enter` | publish (commit staged drafts) |

Auto-scroll on cursor move uses `element.scrollIntoView({ block: "nearest" })`.

***REMOVED******REMOVED******REMOVED*** Shortcut surfacing

- **`?` overlay** (`ShortcutsOverlay.tsx`) — modal listing every binding, grouped (Grid · Mapping · Global). The canonical reference.
- **Inline on buttons** — the Publish footer button shows "⌘↵"; the Undo toolbar button shows "⌘Z". Only the two highest-frequency actions get inline shortcut text; everything else lives in the overlay.
- **Focused-row hint (Mapping only)** — a one-line strip fades in below the focused Mapping row: `A accept · M master · S skip · R reset`. Only appears when a row is focused, removes itself on blur.
- **No persistent legend strip in the toolbar.** The keyboard-hint pills shown in earlier mockups are dropped — too noisy.

***REMOVED******REMOVED*** Undo stack

A small in-memory stack of the last 50 entries, lives inside `<DataGrid>` via context. Clears on route change or dimension switch (your stack is tied to the dimension you're working in).

```ts
interface UndoEntry {
  apply: () => Promise<void>;
  inverse: () => Promise<void>;
  label: string;
}
```

Each undoable store mutation pairs with an `inverse`:

| Mutation | Inverse |
|---|---|
| `setFieldValue(dimId, key, field, v)` | restore the previous value (captured at push time) |
| `renameCanonical(dimId, key, newLabel)` | rename back |
| `addColumnOption(dimId, field, label)` | remove option (or no-op if used) |
| `retireCanonical(dimId, key)` | re-INSERT the record into `dim_` from a snapshot of `{ label, key, fields }` captured at the moment of retirement. Variants stay null-pointed because `retireCanonical` already validates that no raw values map to a record before allowing the retire — so no `map_` repointing is needed. |
| `mergeCanonical(dimId, survivor, losers)` | re-INSERT the loser records into `dim_` and re-point the affected `map_` rows back to their original loser keys. Captured at push time as `{ losers: CanonicalValue[], repointed: { raw, fromKey }[] }`. |
| `addColumn` / `deleteColumn` | mirror |
| accept / skip / reset / bulk-accept (Mapping drafts) | restore previous draft state for affected rows |

***REMOVED******REMOVED******REMOVED*** Deliberate exclusions

- **Commit is not undoable.** Once drafts MERGE into `dim_` / `map_` they can't be popped. The toolbar surfaces this: "Undo last edit · commit not undoable".
- **No collaborative undo.** Your stack is your own. If a teammate edits the same cell mid-undo, the inverse may silently no-op; the UI surfaces a soft "this row changed — refresh to see latest" rather than fighting it with locks.
- **Undo does NOT write audit entries.** Only the user-initiated mutation appends to `app.audit_log`; the undo's inverse is a personal walk-back, not a publishable event.

***REMOVED******REMOVED*** Column header menu

Trigger: hover the column header → a faint `⋯` glyph appears on the right; click opens the menu portal anchored to the header.

```
✎ rename column          (inline-edits the label in place)
⇅ change type            (submenu → text | number | boolean | date | select)
─────
↑ sort A→Z
↓ sort Z→A
✕ clear sort             (only when this column is the sort key)
─────
⊘ hide column
🗑 delete column          (confirm dialog; deletes the FieldDef + all cell values)
```

***REMOVED******REMOVED******REMOVED*** Sort

Single-column sort, client-side, in-memory. The sorted column gets a small `↑` / `↓` glyph in its header so it's visible without opening the menu. Sort state is **not persisted** — it's a session-time perspective, by design. (When saved views land, they'll persist sort.)

***REMOVED******REMOVED******REMOVED*** Hide / unhide

Hidden columns get a `+N hidden` chip in the toolbar; clicking opens a list to re-show. Hidden state is per-user-per-dimension and persists via `app.user_grid_layout`.

***REMOVED******REMOVED******REMOVED*** Delete column

Confirm dialog: "Delete 'Region' and clear it on 6 records? This will null the column in `zugzug.dim_country` for every row." Cascades server-side via a single transactional `DELETE` of the field definition + `UPDATE ... SET fields = fields - 'region'` on the dim table.

***REMOVED******REMOVED*** Column resize + reorder

***REMOVED******REMOVED******REMOVED*** Resize

Pointer-down on a column's right-edge grip → drag horizontally → live update via a CSS variable on the grid container (`--col-W-{field}`). Min width 60px, max 600px. Commit on pointer-up: debounced PATCH to `app.user_grid_layout`.

***REMOVED******REMOVED******REMOVED*** Reorder

Pointer-down on the header label → 200ms hold → enters drag mode (visual lift + drop-zone indicators between adjacent columns) → release commits. The hold-wait keeps single clicks free for "open menu" / "sort". Pinned-left columns (checkbox, master record label, key) can't be dragged or be a drop target — they stay where they are.

***REMOVED******REMOVED******REMOVED*** Persistence model

Per-user-per-dimension, stored as a single JSONB blob:

```sql
CREATE TABLE app.user_grid_layout (
  user_id    text not null,
  dim_id     text not null,
  config     jsonb not null,    -- { widths: {field: px}, order: [field, ...], hidden: [field, ...] }
  updated_at timestamptz not null default now(),
  primary key (user_id, dim_id)
);
```

Single API endpoint:
- `GET /api/grid-layout/:dimId` — called once on dimension mount; missing row → defaults
- `PATCH /api/grid-layout/:dimId` — body is a partial config; debounced 400ms client-side so a drag-resize produces exactly one write per gesture

User A widening a column has no effect on user B's grid.

***REMOVED******REMOVED*** Mapping integration

The Mapping row is not a generic CRUD row — its column shape (raw value · target · confidence · status · actions) is workflow-baked. So we don't naively re-render it through `<DataGrid>`. Instead we share the primitives that matter:

**Shared:**
- `useGridCursor()` for row/cell focus
- All keyboard bindings, plus the Mapping-specific `A` / `M` / `S` / `R` / `⌘↵`
- `UndoStack` — accept / skip / reset / bulk-accept all push inverses
- `SelectCell.Editor` (the picker) replaces the current `ComboSelect` in the target-master column
- `Chip` rendering for the status column (semantically assigned: mapped=ok, skipped=neutral, new=warn — NOT hash-bucketed, because status colors are stable)

**Stays Mapping-specific:**
- The fixed column shape (no header menu, no resize, no hide — Mapping is a workflow, not a database table)
- The filter tabs (Needs review / All / Mapped)
- The footer (Review N → Publish N changes) — drafts pattern is untouched
- The expandable provenance row
- The per-row icon buttons go away (selection-bar-only convention from your call); all row mutations now happen via keyboard shortcut or via the bulk bar with rows selected

The two surfaces stay distinct in feel but the cell editing, keyboarding, and undo are identical.

***REMOVED******REMOVED*** Data model changes

***REMOVED******REMOVED******REMOVED*** Postgres

1. **`app.dimension_field`** (or wherever `FieldDef` is server-stored — confirm in `server/src/repo.ts`): add `options jsonb null`. Existing columns get `options = null`. Additive migration.
2. **`app.user_grid_layout`** (new): see schema above.
3. **`app.audit_log`** (existing): add entry types `option.add`, `column.rename`, `column.type-change`, `column.delete`, `record.remove`. No schema change.

***REMOVED******REMOVED******REMOVED*** Store mutations to add (`app/src/store.ts`)

- `addColumnOption(dimId, field, label)` → `POST /api/columns/:dimId/:field/options`
- `renameColumn(dimId, field, newLabel)` → `PATCH /api/columns/:dimId/:field`
- `changeColumnType(dimId, field, newType, options?)` → `PATCH` (server validates; returns `{ ok, invalidCount? }`)
- `hideColumn(dimId, field)` / `unhideColumn(dimId, field)` → routes through `setUserGridLayout`
- `deleteColumn(dimId, field)` → `DELETE /api/columns/:dimId/:field` (transactional: drops `FieldDef` + nulls the field on every dim row)
- `setColumnWidth(dimId, field, px)` / `setColumnOrder(dimId, fields[])` → debounced `PATCH /api/grid-layout/:dimId`

Each pushable mutation pairs with an `inverse` for the `UndoStack`.

***REMOVED******REMOVED*** Testing

| Layer | What |
|---|---|
| Unit | `bucket(label)` is deterministic across runs and re-orderings; `useGridCursor()` returns expected next-cell on each arrow/Tab variant including across hidden and pinned columns; `UndoStack.push/pop/redo` for happy + concurrent-mutation (no-op inverse) paths; type-conversion validators (text→number, text→date, text→select); `hash32` distribution across buckets is roughly even on real-world labels. |
| Component | `SelectCell.Editor` — typeahead filtering, `Enter` picks highlighted, "Create new" appears only when no exact match, picked option commits via `onCommit`, Esc cancels; `ColumnHeaderMenu` — each item triggers expected mutation and is keyboard-accessible. |
| Integration (server) | `addColumnOption` round-trip; `changeColumnType` rejects with `invalidCount` when conversion would lose data; `user_grid_layout` PATCH debouncing produces exactly one write per quiescent burst; `deleteColumn` is transactional (no half-state if the cell-nulling step fails). |
| E2E (Playwright) | Two golden paths: (a) create a select column → add an option inline → pick it on three rows → undo twice → state is correct and no orphaned options remain; (b) Mapping: focus row → `M` → pick master → `Cmd+Z` → row reverts to "New". |

***REMOVED******REMOVED*** Open questions

These are confirmable during implementation, not blockers:

1. The server side of `FieldDef` storage — exact table name and schema. Need to grep `server/src/repo.ts` for the persistence shape before writing the additive `options` migration.
2. Whether `e2e/` already exists in `app/` (mentioned a Playwright harness — confirm before writing E2E tests).
3. Whether the existing `audit_log` schema can take the new entry types as-is or needs a CHECK constraint update.

***REMOVED******REMOVED*** Implementation order (suggested for the plan)

1. Build the shared primitive in isolation: `<DataGrid>`, `useGridCursor`, `UndoStack`, `Chip`, the existing cell types (Text/Number/Boolean/Date) ported from `MasterTables`. Storybook-style smoke test on a fixture page if useful.
2. Add `SelectCell.tsx` (picker + chip rendering) + the server-side `addColumnOption` endpoint. Wire MasterTables to use `<DataGrid>` for its body. Single-select works end-to-end at this point.
3. Header menu (rename/change-type/sort/hide/delete) + column resize/reorder + `app.user_grid_layout` persistence.
4. Wire Mapping to use the shared primitives (cursor, keyboard, undo, picker, chip). The Mapping route keeps its own chrome.
5. `ShortcutsOverlay` + inline shortcut text on Publish/Undo + Mapping focused-row hint strip.

Each step ships a usable improvement; nothing depends on a later step landing first.
