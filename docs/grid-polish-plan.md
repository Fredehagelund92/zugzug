# Grid Polish Plan

Goal: bring `app/src/components/datagrid/` to Google Sheets / Airtable polish parity.

Each step is a coherent commit. Steps run sequentially (later steps assume earlier
steps shipped).

---

## Step 1 — Bug-fix batch (two reported bugs)

**Bug 1.1: Cell content jumps when entering edit mode.**

- Root cause: every cell editor input (`cells/TextCell.tsx`, `NumberCell.tsx`,
  `DateCell.tsx`, `EmailCell.tsx`, `UrlCell.tsx`) uses
  `border border-accent bg-bg px-1.5 py-0.5` while the cell wrapper at
  `DataGrid.tsx:183` uses `px-3` plus `cellPadY` (`py-[7px]` default,
  `py-[3px]` compact). The 1px border + tighter padding shrinks the content
  area and shifts the caret position when the input replaces the renderer span.
- The wrapper already gets `ring-2 ring-accent ring-inset` on focus (`:188`).
  That should be the only focus chrome.
- Fix: editor inputs become transparent in-place inputs that inherit the
  wrapper's geometry. Each input gets `w-full h-full bg-transparent border-0
  outline-none p-0 m-0 font-mono text-[12px] text-ink` and nothing else
  layout-affecting. The wrapper's `px-3` + `cellPadY` becomes the only
  padding. The wrapper's ring is the only focus indicator.
- For right-aligned columns (`c.align === "right"`), the input must inherit
  `text-right` — check whether it already does via the wrapper, or add it
  explicitly to NumberCell's input.
- Acceptance: enter and exit edit mode on a Text, Number, Date, Email, Url
  cell — caret and text must occupy the same pixel position as the renderer
  span. No 1px shifts. No double outline.

**Bug 1.2: Phantom scrollbars on the grid viewport.**

- Root cause area: `DataGrid.tsx:1383` uses `overflow-x-auto overflow-y-auto`.
  Combined with `minmax(96px, 1fr)` column floors (`:507`-ish in `colWidth`)
  and 1px borders, horizontal scrollbar can appear when content nearly fits;
  vertical scrollbar toggles when virtualizer row estimates round.
- Fix:
  1. Replace `overflow-x-auto overflow-y-auto` with `overflow-auto`.
  2. Add `scrollbar-gutter: stable` to the scroll container's inline style or
     a utility class — prevents content reflow when scrollbar appears.
  3. For non-pinned, non-fixed-width columns, change the column track from
     `minmax(96px, 1fr)` to `minmax(0, 1fr)` so columns compress instead of
     forcing horizontal scroll when the table is narrower than its sum of
     min-widths. Keep an explicit min only on the row-number column and
     pinned columns.
- Acceptance: open a table that fits in the viewport — no scrollbars. Resize
  the window narrower — columns compress until the table actually overflows
  before a horizontal scrollbar appears. Add or remove rows — the body width
  doesn't change when the vertical scrollbar appears (gutter is stable).

**Files in scope for Step 1**:
- `app/src/components/datagrid/DataGrid.tsx` (scroll container, column track)
- `app/src/components/datagrid/cells/TextCell.tsx`
- `app/src/components/datagrid/cells/NumberCell.tsx`
- `app/src/components/datagrid/cells/DateCell.tsx`
- `app/src/components/datagrid/cells/EmailCell.tsx`
- `app/src/components/datagrid/cells/UrlCell.tsx`

**Out of scope for Step 1**: SelectCell, LinkedCell, RatingCell, BooleanCell
editor input shapes (those use portals or non-text editors — addressed in
later steps). Header/body padY alignment (Step 2). Resize grip (Step 2).

**Verification**: `cd app && bun run typecheck`. Manual: launch app, open a
table, click around, enter/exit edit mode in each text-like cell type.

---

## Step 2 — Geometry pass

- Match header padY to body cell padY exactly so column dividers don't kink
  at the header boundary.
- Widen column resize grip hit area to ~12px (centered on column boundary)
  while keeping visible affordance subtle. Add double-click-to-fit-content
  on the grip.
- Apply `tabular-nums` consistently: row-number column, all numeric cell
  renderers, all numeric editor inputs.

## Step 3 — Selection / keyboard pass

- Arrow-key navigation wraps at table edges (right past last column → first
  column of next row).
- Tab / Shift-Tab semantics: commit edit + advance / retreat with wrap.
- Shift+Escape: exit edit mode while keeping the selection range.
- Hover a cell or header → highlight the entire column subtly (matches
  existing row hover affordance).

## Step 4 — Architectural split of DataGrid.tsx

Current: 1893 lines, all concerns mashed together. Target seams:
- `DataGridShell` — layout, scroll container, chrome, focus management
- `DataGridHeader` — column rendering, sort, resize, reorder, header menu
- `DataGridBody` — row rendering, virtualization
- `useSelection` — cursor + range + multi-select hook
- `useEditing` — edit state + commit hook

No behavior change. Files in `datagrid/` only. Re-export from
`datagrid/index.ts`.

## Step 5 — Column virtualization + cell memoization

- Add column virtualization (TanStack `useVirtualizer` for columns).
- `React.memo` per cell component with a tight equality check that only
  re-renders when this cell's value or focus/range membership changes.

## Step 6 — DateCell rebuild + select popover anchoring + IME

- Custom calendar popover for DateCell (not browser-native).
- SelectCell / LinkedCell popovers anchor to the cell with a positioning
  library (or careful manual positioning) instead of fixed-to-viewport.
- Listen for `compositionstart`/`compositionend` in text-like editors so
  IME input doesn't trigger type-to-edit prematurely.
