***REMOVED*** Grid Spreadsheet Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven Excel/Sheets/Airtable-inspired interactions to `DataGrid` — fill handle (vertical only), ⌘+Arrow data-edge jump, status-bar live aggregates, click row***REMOVED***/header to select, right-click context menu, conditional formatting, and field description tooltips.

**Architecture:** Each feature lives in its own hook or sub-component following the existing convention (`useGridCursor`, `useUndoStack`, `<FilterBar>`, `<ColumnHeaderMenu>`, `cells/*`). `DataGrid.tsx` orchestrates; no feature's logic lives inline.

**Tech Stack:** React 18 + TypeScript + Tailwind v4 + `@tanstack/react-virtual` (existing). Tests use Vitest + `@testing-library/react` + jsdom. Backend uses Bun + Drizzle + postgres.js.

**Spec:** `docs/superpowers/specs/2026-06-07-grid-spreadsheet-pass-design.md`

---

***REMOVED******REMOVED*** File Map

| File | Change |
|---|---|
| `server/drizzle/schema.ts` | Add `description: varchar("description")` to `dimensionField` |
| `server/drizzle/0NNN_<auto>.sql` | New — generated migration |
| `server/src/repo-canonical.ts` | Add `description` to FieldDef read/write |
| `server/src/repo-shared.ts` | Extend `FieldDef` with `description?: string` |
| `server/src/server.ts` | Accept `description` on PATCH /fields |
| `app/src/data.ts` | Mirror `FieldDef.description` |
| `app/src/components/datagrid/types.ts` | Add `description?` to `ColumnDef`; add `onInsertRow`/`onDeleteRow`/`onDuplicateRow`/`onSaveColumnRules`/`onSaveColumnDescription` props |
| `app/src/components/datagrid/useGridCursor.ts` | Add `findEdge` helper + meta-arrow handling |
| `app/src/components/datagrid/useFillHandle.ts` | **New** — vertical fill drag |
| `app/src/components/datagrid/useAggregates.ts` | **New** — Count/Distinct/Sum/Avg/Min/Max over range |
| `app/src/components/datagrid/StatusBar.tsx` | **New** — footer strip with aggregates |
| `app/src/components/datagrid/useContextMenu.ts` | **New** — right-click dispatcher |
| `app/src/components/datagrid/ContextMenu.tsx` | **New** — popover menu |
| `app/src/components/datagrid/useConditionalFormatting.ts` | **New** — rule eval |
| `app/src/components/datagrid/ConditionalFormatPopover.tsx` | **New** — rule editor |
| `app/src/components/datagrid/FieldDescriptionEditor.tsx` | **New** — description editor popover |
| `app/src/components/datagrid/DataGrid.tsx` | Wire everything; row***REMOVED***/header click select; render handle/status-bar/menu; apply rule styles |
| `app/src/components/datagrid/ColumnHeaderMenu.tsx` | Add "Conditional formatting…" + "Edit description" items |
| `app/src/components/TablePane.tsx` | Pass new props through; persist rules + description |
| `app/test/datagrid-cmd-arrow.test.tsx` | **New** |
| `app/test/datagrid-row-col-select.test.tsx` | **New** |
| `app/test/datagrid-fill-handle.test.tsx` | **New** |
| `app/test/datagrid-aggregates.test.ts` | **New** |
| `app/test/datagrid-context-menu.test.tsx` | **New** |
| `app/test/datagrid-conditional-format.test.tsx` | **New** |
| `app/test/datagrid-field-description.test.tsx` | **New** |

---

***REMOVED******REMOVED*** Task 1 — Drizzle migration: add `dimension_field.description`

**Files:**
- Modify: `server/drizzle/schema.ts`
- Create: `server/drizzle/0NNN_<auto>.sql` (generated)
- Modify: `server/src/repo-shared.ts`
- Modify: `server/src/repo-canonical.ts`
- Modify: `server/src/server.ts`
- Modify: `app/src/data.ts`
- Test: extend an existing repo test or add `server/test/field-description.test.ts`

- [ ] **Step 1: Add the column to the Drizzle schema**

In `server/drizzle/schema.ts`, locate the `dimensionField` table (~line 42) and add `description` as the last column:

```typescript
export const dimensionField = app.table(
  "dimension_field",
  {
    dim_id:       varchar("dim_id").notNull(),
    field:        varchar("field").notNull(),
    label:        varchar("label").notNull(),
    type:         varchar("type").notNull(),
    created_at:   timestamp("created_at").notNull(),
    field_config: varchar("field_config"),
    description:  varchar("description"),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.field] })],
);
```

- [ ] **Step 2: Generate the migration**

Run:

```bash
cd server && bun run db:generate
```

Expected: a new SQL file appears in `server/drizzle/` named like `0NNN_<auto>.sql` containing `ALTER TABLE "zugzug_app"."dimension_field" ADD COLUMN "description" varchar;`.

- [ ] **Step 3: Extend the server `FieldDef`**

In `server/src/repo-shared.ts`, find `interface FieldDef` (around line 100). Add the optional field:

```typescript
export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string;
  displayFields?: string[];
  description?: string;          // NEW
}
```

- [ ] **Step 4: Read `description` in `getDimension` (repo-canonical.ts)**

In `server/src/repo-canonical.ts`, locate the field-row→FieldDef mapper inside `getDimension` (search for `field_config`). Add `description` alongside it:

```typescript
const fieldDef: FieldDef = {
  field: row.field,
  label: row.label,
  type: row.type,
  ...parseFieldConfig(row.type, row.field_config),
  description: row.description ?? undefined,
};
```

- [ ] **Step 5: Accept `description` on field PATCH**

In `server/src/server.ts`, find the PATCH `/dimensions/:id/fields/:field` route. Add `description` to the destructured body and to the SQL UPDATE:

```typescript
const { label, field_config, description } = (await req.json()) as {
  label?: string; field_config?: string; description?: string | null;
};
await pg`
  UPDATE zugzug_app.dimension_field
  SET label = COALESCE(${label ?? null}, label),
      field_config = COALESCE(${field_config ?? null}, field_config),
      description = ${description === undefined ? sql`description` : description}
  WHERE dim_id = ${dimId} AND field = ${fieldName}
`;
```

(Use the exact SQL builder pattern from the surrounding code — likely `pg.unsafe` or template literals. Match what's there.)

- [ ] **Step 6: Mirror on the client**

In `app/src/data.ts`, find `export interface FieldDef` (or equivalent) and add:

```typescript
description?: string;
```

- [ ] **Step 7: Write a server test for description round-trip**

Create `server/test/field-description.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { addDimension, addField, getDimension, updateField } from "../src/repo-canonical";
import { closePg } from "../src/pg";

test("field description round-trip", async () => {
  const dimId = `test_${Date.now()}`;
  await addDimension({ id: dimId, label: "Test", keyCol: "key" });
  await addField(dimId, { field: "x", label: "X", type: "text" });

  await updateField(dimId, "x", { description: "an explanation" });
  const dim = await getDimension(dimId);
  expect(dim.fields.find((f) => f.field === "x")?.description).toBe("an explanation");

  await updateField(dimId, "x", { description: null });
  const dim2 = await getDimension(dimId);
  expect(dim2.fields.find((f) => f.field === "x")?.description).toBeUndefined();
});
```

If `updateField` doesn't accept `description` yet, add it to that helper to mirror the PATCH route.

- [ ] **Step 8: Run server tests**

```bash
cd server && bun run test:db:up && bun run test
```

Expected: new test passes; no other tests regress.

- [ ] **Step 9: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/0*.sql server/src/repo-shared.ts server/src/repo-canonical.ts server/src/server.ts app/src/data.ts server/test/field-description.test.ts
git commit -m "feat(schema): add dimension_field.description for field tooltips

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Task 2 — ⌘+Arrow data-edge jump

**Files:**
- Modify: `app/src/components/datagrid/useGridCursor.ts`
- Modify: `app/src/components/datagrid/DataGrid.tsx` (shift-extension wiring)
- Test: `app/test/datagrid-cmd-arrow.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-cmd-arrow.test.tsx`:

```tsx
import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string }

const rows: Row[] = [
  { id: "1", name: "Acme" },
  { id: "2", name: "Bravo" },
  { id: "3", name: "" },
  { id: "4", name: "Delta" },
  { id: "5", name: "Echo" },
];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

function clickCellByText(container: HTMLElement, text: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const cell = cells.find((c) => c.textContent?.trim() === text);
  if (!cell) throw new Error(`No gridcell with text "${text}"`);
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  return cell;
}

describe("DataGrid ⌘+Arrow data-edge jump", () => {
  test("⌘↓ from a filled cell with all-filled column jumps to last filled", () => {
    const { container } = renderGrid();
    clickCellByText(container, "Acme");
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    });
    const focused = container.querySelector('[aria-selected="true"]');
    expect(focused?.textContent).toContain("Echo");
  });

  test("⌘↓ stops at last filled before empty stretch", () => {
    const { container } = renderGrid();
    clickCellByText(container, "Acme");
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    });
    // With [Acme, Bravo, "", Delta, Echo] and current rule "filled→filled = last of run",
    // cursor on Acme (filled) sees Bravo (filled) below → jumps to last filled of run (Bravo).
    const focused = container.querySelector('[aria-selected="true"]');
    expect(focused?.textContent).toContain("Bravo");
  });
});
```

(Pick whichever single behavior is unambiguous as the first test. The two tests above are mutually exclusive given the same data; keep one and delete the other. The "stops at Bravo" interpretation matches Excel: when on a filled cell with a filled next cell, you go to the last filled cell *of the contiguous run*. Use that one.)

Keep only the second test for now; delete the first.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun run test datagrid-cmd-arrow
```

Expected: FAIL — cursor is still on "Acme" because no meta-arrow handling exists.

- [ ] **Step 3: Add `findEdge` to useGridCursor**

In `app/src/components/datagrid/useGridCursor.ts`, add a helper function (outside the hook) and expose it:

```typescript
/** Given a starting (row, col) and direction, return the next data-edge target.
 *  "Empty" = null or empty string. Rules:
 *  - filled + next filled → last filled of run
 *  - filled + next empty  → first filled after empty stretch (or edge)
 *  - empty              → first filled in direction (or edge)
 */
export function findEdge<Row>(
  rows: Row[],
  cols: ColumnDef<Row>[],
  getValue: (row: Row, field: string) => unknown,
  fromRow: number,
  fromCol: number,
  dir: "up" | "down" | "left" | "right",
): { row: number; col: number } {
  const dr = dir === "down" ? 1 : dir === "up" ? -1 : 0;
  const dc = dir === "right" ? 1 : dir === "left" ? -1 : 0;
  const isEmpty = (r: number, c: number): boolean => {
    const row = rows[r];
    const col = cols[c];
    if (!row || !col) return true;
    const v = getValue(row, col.field);
    return v == null || v === "";
  };
  let r = fromRow, c = fromCol;
  const lastR = rows.length - 1, lastC = cols.length - 1;
  const startEmpty = isEmpty(r, c);
  // Step once to inspect the neighbour
  let nr = r + dr, nc = c + dc;
  if (nr < 0 || nr > lastR || nc < 0 || nc > lastC) return { row: r, col: c };
  const neighbourEmpty = isEmpty(nr, nc);
  if (!startEmpty && !neighbourEmpty) {
    // walk forward while next is filled
    while (true) {
      const next_r = r + dr, next_c = c + dc;
      if (next_r < 0 || next_r > lastR || next_c < 0 || next_c > lastC) break;
      if (isEmpty(next_r, next_c)) break;
      r = next_r; c = next_c;
    }
    return { row: r, col: c };
  }
  // startEmpty OR neighbourEmpty: walk past empties to first filled, or to edge
  r = nr; c = nc;
  while (isEmpty(r, c)) {
    const next_r = r + dr, next_c = c + dc;
    if (next_r < 0 || next_r > lastR || next_c < 0 || next_c > lastC) return { row: r, col: c };
    r = next_r; c = next_c;
  }
  return { row: r, col: c };
}
```

Then expose it from the hook. Update the hook's return type to include it:

```typescript
return { cursor, setCursor, startEdit, stopEdit, move, onKeyDown, ref, findEdge };
```

(With `findEdge` bound via `useCallback` so consumers get a stable reference; pass the current `rows`, `navCols`, and a captured `getValue` — but `useGridCursor` doesn't currently receive `getValue`. Take it as a new opt: add `getValue?: (row: Row, field: string) => unknown` to `Opts<Row>`, default to `(r, f) => (r as Record<string, unknown>)[f]`.)

- [ ] **Step 4: Handle ⌘+Arrow (no shift) inside `onKeyDown`**

In the same file, just before the unmodified-arrow branch (currently at `if (e.key === "ArrowUp")`), add:

```typescript
const isCmd = e.metaKey || e.ctrlKey;
if (isCmd && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
  e.preventDefault();
  const ri = rows.findIndex((r) => rowKey(r) === cursor.rowKey);
  const ci = navCols.findIndex((c) => c.field === cursor.field);
  if (ri < 0 || ci < 0) return;
  const dir = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : "right";
  if (e.shiftKey) return; // grid handles shift+meta+arrow
  const target = findEdge(rows, navCols, getValue ?? ((r, f) => (r as Record<string, unknown>)[f]), ri, ci, dir);
  const row = rows[target.row];
  const col = navCols[target.col];
  if (row && col) setCursor({ rowKey: rowKey(row), field: col.field, editing: false });
  return;
}
```

Also handle `⌘Home` and `⌘End`:

```typescript
if (isCmd && e.key === "Home") {
  e.preventDefault();
  const row = rows[0], col = navCols[0];
  if (row && col) setCursor({ rowKey: rowKey(row), field: col.field, editing: false });
  return;
}
if (isCmd && e.key === "End") {
  e.preventDefault();
  const row = rows[rows.length - 1], col = navCols[navCols.length - 1];
  if (row && col) setCursor({ rowKey: rowKey(row), field: col.field, editing: false });
  return;
}
```

- [ ] **Step 5: Pass `getValue` from DataGrid to useGridCursor**

In `app/src/components/datagrid/DataGrid.tsx`, update the `useGridCursor({ ... })` call (around line 481) to pass `getValue`:

```typescript
const cursor = useGridCursor({
  rows: sortedRows,
  rowKey,
  columns: orderedVisible,
  getValue,
  onCommit: () => {},
  onSelectAll: () => { /* ...unchanged... */ },
  onUndo: () => undo.undo(),
  onRedo: () => undo.redo(),
});
```

- [ ] **Step 6: Run test to verify pass**

```bash
cd app && bun run test datagrid-cmd-arrow
```

Expected: PASS.

- [ ] **Step 7: Add the shift-extension test**

Append to `app/test/datagrid-cmd-arrow.test.tsx`:

```tsx
test("⌘⇧↓ extends the range to the data-edge target", () => {
  const { container } = renderGrid();
  clickCellByText(container, "Acme");
  const grid = container.querySelector('[role="grid"]') as HTMLElement;
  act(() => {
    fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true, shiftKey: true });
  });
  // Range should now span Acme→Bravo (the run end). Range cells have bg-accent/10.
  const cells = container.querySelectorAll<HTMLElement>('[role="gridcell"]');
  const acmeCell = Array.from(cells).find((c) => c.textContent?.trim() === "Acme");
  const bravoCell = Array.from(cells).find((c) => c.textContent?.trim() === "Bravo");
  // Bravo gets the focus ring; Acme gets the range wash
  expect(acmeCell?.className).toContain("bg-accent/10");
  expect(bravoCell?.getAttribute("aria-selected")).toBe("true");
});
```

- [ ] **Step 8: Verify it fails**

Run the test — expected FAIL (range not extended).

- [ ] **Step 9: Wire shift-extension in DataGrid.handleKeyDown**

In `DataGrid.tsx`, inside `handleKeyDown`, just after the existing `isShiftArrow` block (~line 770-801), add a parallel `isShiftMetaArrow` branch BEFORE the cursor handler call:

```typescript
const isShiftMetaArrow =
  (e.metaKey || e.ctrlKey) && e.shiftKey &&
  (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight");

if (isShiftMetaArrow && cur) {
  e.preventDefault();
  const focusRk = range?.focus.rowKey ?? cur.rowKey;
  const focusField = range?.focus.field ?? cur.field;
  const fr = rowIndexMap.get(focusRk) ?? 0;
  const fc = colIndexMap.get(focusField) ?? 0;
  const dir = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : "right";
  const target = cursor.findEdge(sortedRows, orderedVisible, getValue, fr, fc, dir);
  const newFocusRow = sortedRows[target.row];
  const newFocusCol = orderedVisible[target.col];
  if (!newFocusRow || !newFocusCol) return;
  const newFocus = { rowKey: rowKey(newFocusRow), field: newFocusCol.field };
  const currentAnchor = range?.anchor ?? { rowKey: cur.rowKey, field: cur.field };
  setRange({ anchor: currentAnchor, focus: newFocus });
  cursor.setCursor({ rowKey: newFocus.rowKey, field: newFocus.field, editing: false });
  return;
}
```

- [ ] **Step 10: Run tests, verify pass**

```bash
cd app && bun run test datagrid-cmd-arrow
```

Expected: both tests PASS. Also run full suite to catch regressions:

```bash
cd app && bun run test
```

- [ ] **Step 11: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: zero errors.

- [ ] **Step 12: Commit**

```bash
git add app/src/components/datagrid/useGridCursor.ts app/src/components/datagrid/DataGrid.tsx app/test/datagrid-cmd-arrow.test.tsx
git commit -m "feat(grid): ⌘+arrow data-edge jump and ⌘⇧+arrow range extension

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Task 3 — Click row***REMOVED***/column-header to select

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`
- Test: `app/test/datagrid-row-col-select.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-row-col-select.test.tsx`:

```tsx
import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string; tag: string }
const rows: Row[] = [
  { id: "1", name: "Acme",  tag: "x" },
  { id: "2", name: "Bravo", tag: "y" },
];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
  { field: "tag", label: "Tag", config: { type: "text" } },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id}
                onCommit={async () => {}} showRowNumbers />
    </UndoStackProvider>,
  );
}

describe("row***REMOVED*** / column-header click selection", () => {
  test("click row-number cell selects whole row", () => {
    const { container } = renderGrid();
    const rowNumCell = Array.from(container.querySelectorAll<HTMLElement>('[data-row-num]'))
      .find((el) => el.dataset.rowNum === "1")!;
    act(() => {
      fireEvent.pointerDown(rowNumCell, { button: 0, bubbles: true });
      fireEvent.pointerUp(rowNumCell, { button: 0, bubbles: true });
    });
    // All three body cells in row 1 should be in range
    const acme = container.querySelector('[data-cell="1::name"]');
    const xCell = container.querySelector('[data-cell="1::tag"]');
    expect(acme?.className).toMatch(/bg-accent\/10|ring-accent/);
    expect(xCell?.className).toMatch(/bg-accent\/10|ring-accent/);
  });

  test("click column header label selects whole column", () => {
    const { container } = renderGrid();
    const headers = container.querySelectorAll<HTMLElement>('[data-header]');
    const nameHeader = Array.from(headers).find((h) => h.dataset.header === "name")!;
    const label = nameHeader.querySelector("span") as HTMLElement;
    act(() => {
      fireEvent.pointerDown(label, { button: 0, bubbles: true });
      fireEvent.pointerUp(label, { button: 0, bubbles: true });
    });
    const r1 = container.querySelector('[data-cell="1::name"]');
    const r2 = container.querySelector('[data-cell="2::name"]');
    expect(r1?.className).toMatch(/bg-accent\/10|ring-accent/);
    expect(r2?.className).toMatch(/bg-accent\/10|ring-accent/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd app && bun run test datagrid-row-col-select
```

Expected: FAIL — clicks on row***REMOVED*** and header label don't set range.

- [ ] **Step 3: Add `data-row-num` to row-number cells**

In `DataGrid.tsx`, modify the row-number cell render inside `GridRowInner` (~line 115-124) to add the attribute and a pointer handler. First, thread a new callback `onRowNumPointerDown` into `GridRowProps`:

```typescript
interface GridRowProps<Row> {
  // …existing fields…
  onRowNumPointerDown?: (e: React.PointerEvent, rk: string) => void;
}
```

Then in the cell:

```tsx
{showRowNumbers && (
  <div
    data-row-num={rk}
    onPointerDown={(e) => props.onRowNumPointerDown?.(e, rk)}
    className={cx(
      "flex items-center justify-end border-r border-line pr-2 font-mono text-[10px] text-ink-3 tabular-nums cursor-cell",
      cellPadY,
    )}
  >
    {rowIndex + 1}
  </div>
)}
```

- [ ] **Step 4: Implement row-number click handler in DataGrid**

Inside the `DataGrid` body, add:

```typescript
const onRowNumPointerDown = useCallback(
  (e: React.PointerEvent, rk: string) => {
    if (e.button !== 0) return;
    cursor.ref.current?.focus();
    const firstCol = orderedVisible[0];
    const lastCol = orderedVisible[orderedVisible.length - 1];
    if (!firstCol || !lastCol) return;
    if (e.shiftKey && range) {
      setRange({ anchor: range.anchor, focus: { rowKey: rk, field: lastCol.field } });
    } else {
      setRange({
        anchor: { rowKey: rk, field: firstCol.field },
        focus:  { rowKey: rk, field: lastCol.field },
      });
    }
    cursor.setCursor({ rowKey: rk, field: firstCol.field, editing: false });
    e.preventDefault();
  },
  [cursor, orderedVisible, range],
);
```

Pass it to `<GridRow … onRowNumPointerDown={onRowNumPointerDown} />` at the render site (~line 1264).

- [ ] **Step 5: Implement header-label click → select column**

In the column header render (~line 1017), the label `<span>` currently has `onPointerDown` that starts a hold-timer for reorder. Augment that handler to detect "click without drag" and select the column when no drag occurred.

Modify the inner onPointerDown of the label:

```tsx
onPointerDown={(_e) => {
  if (c.pinnedLeft) return;
  let holding = true;
  let moved = false;
  const startTime = Date.now();
  const holdTimer = window.setTimeout(() => {
    if (!holding) return;
    setDrag({ field: c.field, overIndex: null });
  }, 200);
  const onMove = () => { moved = true; /* …existing… */ };
  const onUp = () => {
    holding = false;
    window.clearTimeout(holdTimer);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const elapsed = Date.now() - startTime;
    if (!moved && elapsed < 200 && !dragRef.current) {
      // Plain click → select column
      cursor.ref.current?.focus();
      const firstRow = sortedRows[0];
      const lastRow = sortedRows[sortedRows.length - 1];
      if (firstRow && lastRow) {
        const anchor = { rowKey: rowKey(firstRow), field: c.field };
        const focus  = { rowKey: rowKey(lastRow),  field: c.field };
        if (_e.shiftKey && range) {
          setRange({ anchor: range.anchor, focus });
        } else {
          setRange({ anchor, focus });
        }
        cursor.setCursor({ rowKey: anchor.rowKey, field: c.field, editing: false });
      }
      return;
    }
    setDrag((d) => { /* …existing drop logic… */ });
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}}
```

(Replace the existing handler in-place; preserve the existing reorder-drop logic inside the final `setDrag` callback.)

- [ ] **Step 6: Run tests, verify pass**

```bash
cd app && bun run test datagrid-row-col-select
```

Expected: both tests PASS.

- [ ] **Step 7: Run full suite**

```bash
cd app && bun run test
```

Expected: no regressions — existing reorder test (if any) still passes because the hold-timer still triggers when the click outlasts 200ms.

- [ ] **Step 8: Typecheck**

```bash
cd app && bun run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/test/datagrid-row-col-select.test.tsx
git commit -m "feat(grid): click row***REMOVED***/column-header to select whole row/col

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Task 4 — Fill handle (vertical only)

**Files:**
- Create: `app/src/components/datagrid/useFillHandle.ts`
- Modify: `app/src/components/datagrid/DataGrid.tsx`
- Test: `app/test/datagrid-fill-handle.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-fill-handle.test.tsx`:

```tsx
import { test, expect, describe, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string }
const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), name: i === 0 ? "Acme" : "" }));
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

describe("fill handle", () => {
  test("drag the corner handle down fills target rows with source value", async () => {
    const commits: Array<{ rk: string; field: string; value: unknown }> = [];
    const onCommit = vi.fn(async (rk: string, field: string, value: unknown) => {
      commits.push({ rk, field, value });
    });
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={onCommit} />
      </UndoStackProvider>,
    );
    // Click "Acme" to select
    const acme = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.pointerDown(acme, { button: 0, bubbles: true });
      fireEvent.pointerUp(acme, { button: 0, bubbles: true });
    });
    // Find the fill handle
    const handle = container.querySelector('[data-fill-handle="true"]') as HTMLElement;
    expect(handle).not.toBeNull();
    // Mock elementFromPoint to return target cells in sequence: row 2 → row 5
    const target5 = container.querySelector('[data-cell="5::name"]') as HTMLElement;
    document.elementFromPoint = vi.fn().mockReturnValue(target5);
    // Drag start, move, end
    act(() => { fireEvent.pointerDown(handle, { button: 0, bubbles: true }); });
    act(() => { fireEvent.pointerMove(window, { clientX: 0, clientY: 200 } as any); });
    act(() => { fireEvent.pointerUp(window, { button: 0 } as any); });
    // After release, rows 2-5 should have been written with "Acme"
    await new Promise((r) => setTimeout(r, 10));
    const written = commits.filter((c) => c.field === "name").map((c) => c.rk).sort();
    expect(written).toEqual(["2", "3", "4", "5"]);
    commits.filter((c) => c.field === "name").forEach((c) => expect(c.value).toBe("Acme"));
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd app && bun run test datagrid-fill-handle
```

Expected: FAIL — handle element doesn't exist.

- [ ] **Step 3: Create the `useFillHandle` hook**

Create `app/src/components/datagrid/useFillHandle.ts`:

```typescript
import { useCallback, useRef, useState } from "react";
import type { ColumnDef } from "./types";

interface RangeCorner { rowKey: string; field: string }
interface RangeState { anchor: RangeCorner; focus: RangeCorner }

interface Opts<Row> {
  range: RangeState | null;
  sortedRows: Row[];
  rowKey: (r: Row) => string;
  orderedVisible: ColumnDef<Row>[];
  rowIndexMap: Map<string, number>;
  getValue: (r: Row, f: string) => unknown;
  commitValue: (rk: string, field: string, value: unknown) => Promise<void>;
  setRange: (r: RangeState | null) => void;
  beginTransaction: (label: string) => void;
  endTransaction: () => void;
  flashCell: (rk: string, field: string) => void;
}

export function useFillHandle<Row>(opts: Opts<Row>) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || !opts.range) return;
    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = true;
    setDragging(true);
    const sourceRange = opts.range;
    const anchorRowIdx = opts.rowIndexMap.get(sourceRange.anchor.rowKey) ?? 0;
    const focusRowIdx = opts.rowIndexMap.get(sourceRange.focus.rowKey) ?? 0;
    const srcMinRow = Math.min(anchorRowIdx, focusRowIdx);
    const srcMaxRow = Math.max(anchorRowIdx, focusRowIdx);

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const cellEl = target?.closest<HTMLElement>("[data-cell]");
      if (!cellEl) return;
      const data = cellEl.dataset.cell;
      if (!data) return;
      const sep = data.indexOf("::");
      if (sep < 0) return;
      const targetRk = data.slice(0, sep);
      const targetRowIdx = opts.rowIndexMap.get(targetRk);
      if (targetRowIdx == null) return;
      // Extend range vertically only — keep source columns, adjust focus row
      const newFocusRow = opts.sortedRows[targetRowIdx];
      if (!newFocusRow) return;
      opts.setRange({
        anchor: sourceRange.anchor,
        focus: { rowKey: opts.rowKey(newFocusRow), field: sourceRange.focus.field },
      });
    };

    const onUp = () => {
      draggingRef.current = false;
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Commit the fill: target rows = rows in extended range but NOT in source
      // Determine final range by reading the last-set range from opts (closure stale; read fresh)
      // To avoid stale closure: caller passes setRange & we read the DOM state via the ref pattern
      // — simpler: derive from the cellEl at pointerUp time via the last seen target.
      // Implementation moved into a separate effect; here we trigger commit by emitting a
      // custom event the host listens for. Simplest path: caller passes onFillCommit and we
      // compute targets inside onMove's last call. See refactor in Step 4.
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [opts]);

  return { onHandlePointerDown, dragging };
}
```

(The commit logic in `onUp` is incomplete in this step — it's resolved in Step 4 by reading the latest range and writing the fill.)

- [ ] **Step 4: Wire the fill-commit on pointer up**

Replace the `onUp` body in `useFillHandle` with a closure-safe variant that reads the freshly-set range via a ref:

```typescript
import { useEffect } from "react";

// inside the hook, add:
const rangeRef = useRef(opts.range);
useEffect(() => { rangeRef.current = opts.range; }, [opts.range]);

// inside onHandlePointerDown, replace onUp:
const onUp = async () => {
  draggingRef.current = false;
  setDragging(false);
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  const finalRange = rangeRef.current;
  if (!finalRange) return;
  const finalFocusRowIdx = opts.rowIndexMap.get(finalRange.focus.rowKey) ?? 0;
  // Source rows are the original [srcMinRow..srcMaxRow]; target rows are everything
  // between srcMaxRow+1 → finalFocusRowIdx (down) OR srcMinRow-1 → finalFocusRowIdx (up).
  const goingDown = finalFocusRowIdx > srcMaxRow;
  const goingUp = finalFocusRowIdx < srcMinRow;
  if (!goingDown && !goingUp) return; // no-op (didn't drag past source)
  const targetRowIdxs: number[] = goingDown
    ? Array.from({ length: finalFocusRowIdx - srcMaxRow }, (_, i) => srcMaxRow + 1 + i)
    : Array.from({ length: srcMinRow - finalFocusRowIdx }, (_, i) => finalFocusRowIdx + i);
  // Source columns from the source range
  const srcMinColIdx = Math.min(
    opts.orderedVisible.findIndex((c) => c.field === sourceRange.anchor.field),
    opts.orderedVisible.findIndex((c) => c.field === sourceRange.focus.field),
  );
  const srcMaxColIdx = Math.max(
    opts.orderedVisible.findIndex((c) => c.field === sourceRange.anchor.field),
    opts.orderedVisible.findIndex((c) => c.field === sourceRange.focus.field),
  );
  const srcCols = opts.orderedVisible.slice(srcMinColIdx, srcMaxColIdx + 1);
  const srcRowCount = srcMaxRow - srcMinRow + 1;
  const writes: Array<{ rk: string; field: string; value: unknown }> = [];
  for (let i = 0; i < targetRowIdxs.length; i++) {
    const targetIdx = targetRowIdxs[i]!;
    const targetRow = opts.sortedRows[targetIdx];
    if (!targetRow) continue;
    const srcIdxInRange = goingDown ? i % srcRowCount : (srcRowCount - 1) - (i % srcRowCount);
    const srcRow = opts.sortedRows[srcMinRow + srcIdxInRange];
    if (!srcRow) continue;
    for (const col of srcCols) {
      if (col.editable === false) continue;
      const value = opts.getValue(srcRow, col.field);
      writes.push({ rk: opts.rowKey(targetRow), field: col.field, value });
    }
  }
  if (writes.length === 0) return;
  const label = `fill ${writes.length} cell${writes.length === 1 ? "" : "s"}`;
  opts.beginTransaction(label);
  try {
    await Promise.all(writes.map((w) => opts.commitValue(w.rk, w.field, w.value)));
  } finally {
    opts.endTransaction();
    for (const w of writes) opts.flashCell(w.rk, w.field);
  }
};
```

- [ ] **Step 5: Render the handle**

In `DataGrid.tsx`, inside the `<div role="grid">` (after the body render), render a fill handle anchored at the bottom-right of the current range. Add a positioning helper:

```typescript
// Compute the bottom-right corner of the current range in client coordinates.
const fillHandlePos = useMemo(() => {
  if (!range || !cursor.ref.current) return null;
  const bounds = computeRangeBounds(range);
  const lastRow = sortedRows[bounds.maxRow];
  const lastCol = orderedVisible[bounds.maxCol];
  if (!lastRow || !lastCol) return null;
  const sel = `[data-cell="${attrEsc(`${rowKey(lastRow)}::${lastCol.field}`)}"]`;
  return sel;
}, [range, sortedRows, orderedVisible, rowKey, computeRangeBounds]);
```

And inject the handle once at the grid level (it positions itself via an effect tracking the bottom-right cell):

```tsx
{fillHandlePos && (
  <FillHandle
    targetSelector={fillHandlePos}
    containerRef={cursor.ref}
    onPointerDown={fillHandle.onHandlePointerDown}
    dragging={fillHandle.dragging}
  />
)}
```

Create the small `FillHandle` component (inline in `DataGrid.tsx` near the top of the file, or its own file if you prefer):

```tsx
function FillHandle({
  targetSelector, containerRef, onPointerDown, dragging,
}: {
  targetSelector: string;
  containerRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent) => void;
  dragging: boolean;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const target = container.querySelector<HTMLElement>(targetSelector);
      if (!target) { setPos(null); return; }
      const cRect = container.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      setPos({
        top: tRect.bottom - cRect.top + container.scrollTop - 4,
        left: tRect.right - cRect.left + container.scrollLeft - 4,
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    container.addEventListener("scroll", update);
    return () => { ro.disconnect(); container.removeEventListener("scroll", update); };
  }, [targetSelector, containerRef]);
  if (!pos) return null;
  return (
    <div
      data-fill-handle="true"
      onPointerDown={onPointerDown}
      style={{ position: "absolute", top: pos.top, left: pos.left, width: 8, height: 8 }}
      className={cx(
        "z-20 cursor-crosshair rounded-sm bg-accent",
        dragging && "scale-125 shadow-pop",
      )}
    />
  );
}
```

(Add `import { useLayoutEffect } from "react"` at the top.)

Also mount `useFillHandle` in `DataGrid`:

```typescript
const fillHandle = useFillHandle({
  range, sortedRows, rowKey, orderedVisible, rowIndexMap, getValue,
  commitValue,
  setRange,
  beginTransaction: undo.beginTransaction,
  endTransaction: undo.endTransaction,
  flashCell,
});
```

- [ ] **Step 6: Wrap grid container with `position: relative`**

The handle is absolutely positioned. The outermost grid container at line 936 already has `flex flex-col`; ensure it has `relative`:

```tsx
<div className="relative flex flex-1 flex-col min-h-0 overflow-hidden rounded-lg border border-line bg-surface focus-within:ring-1 focus-within:ring-accent/40">
```

- [ ] **Step 7: Run tests, verify pass**

```bash
cd app && bun run test datagrid-fill-handle
```

Expected: PASS.

- [ ] **Step 8: Manual verification**

Start the app, click a cell with a value, locate the small accent square at its bottom-right, drag downward over several rows, release. All dragged-over rows take the source value; one Cmd+Z undoes the entire fill.

```bash
cd app && bun run dev
***REMOVED*** also: cd server && bun run start
```

- [ ] **Step 9: Typecheck + lint**

```bash
cd app && bun run typecheck && bun run lint
```

- [ ] **Step 10: Commit**

```bash
git add app/src/components/datagrid/useFillHandle.ts app/src/components/datagrid/DataGrid.tsx app/test/datagrid-fill-handle.test.tsx
git commit -m "feat(grid): vertical fill handle — drag corner to copy values down/up

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Task 5 — Status-bar live aggregates

**Files:**
- Create: `app/src/components/datagrid/useAggregates.ts`
- Create: `app/src/components/datagrid/StatusBar.tsx`
- Modify: `app/src/components/datagrid/DataGrid.tsx`
- Test: `app/test/datagrid-aggregates.test.ts` (pure-unit) + extend `datagrid-fill-handle.test.tsx` (integration)

- [ ] **Step 1: Write the failing unit test for the aggregate calculator**

Create `app/test/datagrid-aggregates.test.ts`:

```typescript
import { test, expect, describe } from "vitest";
import { computeAggregates } from "../src/components/datagrid/useAggregates";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; n: number | null; tag: string }
const rows: Row[] = [
  { id: "1", n: 10, tag: "a" },
  { id: "2", n: 20, tag: "a" },
  { id: "3", n: null, tag: "b" },
  { id: "4", n: 30, tag: "" },
];
const cols: ColumnDef<Row>[] = [
  { field: "n", label: "N", config: { type: "number" } },
  { field: "tag", label: "Tag", config: { type: "text" } },
];

const getValue = (r: Row, f: string) => (r as any)[f];

describe("computeAggregates", () => {
  test("Count counts non-empty cells across range", () => {
    const agg = computeAggregates(rows, cols, getValue, { minRow: 0, maxRow: 3, minCol: 0, maxCol: 1 });
    // n has 3 non-null, tag has 3 non-empty → Count = 6
    expect(agg.count).toBe(6);
  });
  test("Distinct counts unique String(value) of non-null/non-empty", () => {
    const agg = computeAggregates(rows, cols, getValue, { minRow: 0, maxRow: 3, minCol: 0, maxCol: 1 });
    // n: {10,20,30}; tag: {a,b} → 5 distinct (no cross-column merge of "20" vs "a")
    // We treat distinct as per-cell-value across the entire range as one bag.
    // {"10","20","30","a","b"} → 5
    expect(agg.distinct).toBe(5);
  });
  test("Sum + Avg over numeric columns only", () => {
    const agg = computeAggregates(rows, cols, getValue, { minRow: 0, maxRow: 3, minCol: 0, maxCol: 1 });
    expect(agg.sum).toBe(60);
    expect(agg.avg).toBeCloseTo(20);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd app && bun run test datagrid-aggregates
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `computeAggregates` + `useAggregates`**

Create `app/src/components/datagrid/useAggregates.ts`:

```typescript
import { useMemo } from "react";
import type { ColumnDef } from "./types";

interface Bounds { minRow: number; maxRow: number; minCol: number; maxCol: number }

export interface Aggregates {
  count:    number;
  distinct: number;
  sum:      number | null;
  avg:      number | null;
  min:      number | string | null;
  max:      number | string | null;
}

const MAX_CELLS = 100_000;

export function computeAggregates<Row>(
  rows: Row[],
  cols: ColumnDef<Row>[],
  getValue: (r: Row, f: string) => unknown,
  b: Bounds,
): Aggregates {
  const cellCount = (b.maxRow - b.minRow + 1) * (b.maxCol - b.minCol + 1);
  if (cellCount > MAX_CELLS) {
    return { count: cellCount, distinct: NaN, sum: null, avg: null, min: null, max: null };
  }
  let count = 0;
  const seen = new Set<string>();
  let sum = 0, sumCount = 0;
  let min: number | string | null = null;
  let max: number | string | null = null;
  let anyNumeric = false;
  for (let r = b.minRow; r <= b.maxRow; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = b.minCol; c <= b.maxCol; c++) {
      const col = cols[c];
      if (!col) continue;
      const v = getValue(row, col.field);
      if (v == null || v === "") continue;
      count++;
      seen.add(String(v));
      const isNumericCol = col.config.type === "number" || col.config.type === "rating";
      if (isNumericCol && typeof v === "number" && !isNaN(v)) {
        anyNumeric = true;
        sum += v;
        sumCount++;
        if (min == null || (typeof min === "number" && v < min)) min = v;
        if (max == null || (typeof max === "number" && v > max)) max = v;
      } else if (!anyNumeric) {
        const s = String(v);
        if (min == null || (typeof min === "string" && s < min)) min = s;
        if (max == null || (typeof max === "string" && s > max)) max = s;
      }
    }
  }
  return {
    count,
    distinct: seen.size,
    sum: anyNumeric ? sum : null,
    avg: anyNumeric && sumCount > 0 ? sum / sumCount : null,
    min,
    max,
  };
}

export function useAggregates<Row>(
  rows: Row[],
  cols: ColumnDef<Row>[],
  getValue: (r: Row, f: string) => unknown,
  bounds: Bounds | null,
): Aggregates | null {
  return useMemo(() => {
    if (!bounds) return null;
    return computeAggregates(rows, cols, getValue, bounds);
  }, [rows, cols, getValue, bounds]);
}
```

- [ ] **Step 4: Run unit tests, verify pass**

```bash
cd app && bun run test datagrid-aggregates
```

Expected: PASS.

- [ ] **Step 5: Create `<StatusBar>` component**

Create `app/src/components/datagrid/StatusBar.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import type { Aggregates } from "./useAggregates";

const AGG_KEYS = ["count", "distinct", "sum", "avg", "min", "max"] as const;
type AggKey = (typeof AGG_KEYS)[number];

const STORAGE_KEY = "zz.grid.statusBar.aggregates";
const DEFAULT_VISIBLE: AggKey[] = ["count", "distinct", "sum", "avg"];

function loadVisible(): AggKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE;
    const parsed = JSON.parse(raw) as string[];
    return parsed.filter((k): k is AggKey => (AGG_KEYS as readonly string[]).includes(k));
  } catch { return DEFAULT_VISIBLE; }
}

function saveVisible(v: AggKey[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

function fmt(v: number | string | null): string {
  if (v == null) return "—";
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v;
}

const LABEL: Record<AggKey, string> = {
  count: "Count", distinct: "Distinct", sum: "Sum", avg: "Avg", min: "Min", max: "Max",
};

export function StatusBar({ agg }: { agg: Aggregates }) {
  const [visible, setVisible] = useState<AggKey[]>(loadVisible);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { saveVisible(visible); }, [visible]);

  const toggle = (k: AggKey) => {
    setVisible((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  };

  return (
    <div
      ref={ref}
      className="relative flex items-center justify-end gap-4 border-t border-line bg-surface px-3 py-1 font-mono text-[11px] text-ink-2 tabular-nums"
      onClick={() => setOpen((s) => !s)}
      role="status"
      aria-label="Selection aggregates"
    >
      {visible.map((k) => {
        const value = agg[k];
        if (k === "sum" && value == null) return null;
        if (k === "avg" && value == null) return null;
        return (
          <span key={k} title={LABEL[k]}>
            <span className="text-ink-3">{LABEL[k]}:</span>{" "}
            <span className="text-ink">{fmt(value as number | string | null)}</span>
          </span>
        );
      })}
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full right-0 mb-1 rounded-lg border border-line bg-surface-elevated p-2 shadow-pop"
        >
          {AGG_KEYS.map((k) => (
            <label key={k} className="flex items-center gap-2 px-2 py-1 text-[12px] text-ink hover:bg-hover rounded">
              <input type="checkbox" checked={visible.includes(k)} onChange={() => toggle(k)} />
              {LABEL[k]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Mount in DataGrid**

In `DataGrid.tsx`, just before the outermost grid container's closing `</div>` at line 1277 (i.e., inside the `<div className="relative flex flex-1 flex-col …">` but after the scrollable body container), render:

```tsx
{range && (() => {
  const b = computeRangeBounds(range);
  const cellCount = (b.maxRow - b.minRow + 1) * (b.maxCol - b.minCol + 1);
  if (cellCount <= 1) return null;
  return <StatusBar agg={computeAggregates(sortedRows, orderedVisible, getValue, b)} />;
})()}
```

(Or compute via the hook and pass — equivalent. Inline is fine.)

Add the imports at the top:

```typescript
import { StatusBar } from "./StatusBar";
import { computeAggregates } from "./useAggregates";
```

- [ ] **Step 7: Integration test — status bar appears with selection**

Append a test to `app/test/datagrid-aggregates.test.ts` OR add a new `app/test/datagrid-statusbar.test.tsx`. Use the latter:

```tsx
// app/test/datagrid-statusbar.test.tsx
import { test, expect } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; n: number }
const rows: Row[] = [{ id: "1", n: 10 }, { id: "2", n: 20 }, { id: "3", n: 30 }];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "n", label: "N", config: { type: "number" } },
];

test("status bar shows aggregates when range > 1 cell", () => {
  const { container } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  // Click cell "10" then shift+click cell "30" to extend range
  const cell10 = container.querySelector('[data-cell="1::n"]') as HTMLElement;
  const cell30 = container.querySelector('[data-cell="3::n"]') as HTMLElement;
  act(() => {
    fireEvent.pointerDown(cell10, { button: 0, bubbles: true });
    fireEvent.pointerUp(cell10, { button: 0, bubbles: true });
  });
  act(() => {
    fireEvent.pointerDown(cell30, { button: 0, shiftKey: true, bubbles: true });
    fireEvent.pointerUp(cell30, { button: 0, bubbles: true });
  });
  const bar = container.querySelector('[role="status"]');
  expect(bar).not.toBeNull();
  expect(bar?.textContent).toContain("Count");
  expect(bar?.textContent).toContain("Sum");
  expect(bar?.textContent).toContain("60");
});
```

- [ ] **Step 8: Run tests, verify pass**

```bash
cd app && bun run test datagrid-aggregates datagrid-statusbar
```

- [ ] **Step 9: Typecheck**

```bash
cd app && bun run typecheck
```

- [ ] **Step 10: Commit**

```bash
git add app/src/components/datagrid/useAggregates.ts app/src/components/datagrid/StatusBar.tsx app/src/components/datagrid/DataGrid.tsx app/test/datagrid-aggregates.test.ts app/test/datagrid-statusbar.test.tsx
git commit -m "feat(grid): status-bar live aggregates for selection ranges

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Task 6 — Right-click context menu

**Files:**
- Create: `app/src/components/datagrid/useContextMenu.ts`
- Create: `app/src/components/datagrid/ContextMenu.tsx`
- Modify: `app/src/components/datagrid/types.ts` (add `onInsertRow`, `onDeleteRow`, `onDuplicateRow` props)
- Modify: `app/src/components/datagrid/DataGrid.tsx`
- Test: `app/test/datagrid-context-menu.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-context-menu.test.tsx`:

```tsx
import { test, expect, describe, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string }
const rows: Row[] = [{ id: "1", name: "Acme" }, { id: "2", name: "Bravo" }];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

describe("right-click context menu", () => {
  test("right-click on a cell opens menu with cell items", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(cell, { clientX: 50, clientY: 50, bubbles: true });
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Copy");
    expect(menu?.textContent).toContain("Filter to this value");
  });

  test("right-click on a column header opens column items", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const headerLabel = container.querySelector('[data-header="name"] span') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(headerLabel, { clientX: 50, clientY: 50, bubbles: true });
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Rename");
    expect(menu?.textContent).toContain("Sort ascending");
  });

  test("Escape closes the menu", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => { fireEvent.contextMenu(cell, { clientX: 50, clientY: 50, bubbles: true }); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd app && bun run test datagrid-context-menu
```

- [ ] **Step 3: Add new optional props to types.ts**

In `app/src/components/datagrid/types.ts`, append to `DataGridProps<Row>`:

```typescript
onInsertRow?:    (rowKey: string, where: "above" | "below") => void;
onDeleteRow?:    (rowKey: string) => void;
onDuplicateRow?: (rowKey: string) => void;
```

- [ ] **Step 4: Create `useContextMenu`**

Create `app/src/components/datagrid/useContextMenu.ts`:

```typescript
import { useCallback, useEffect, useState } from "react";

export type ContextSurface =
  | { kind: "cell"; rowKey: string; field: string }
  | { kind: "header"; field: string }
  | { kind: "row-num"; rowKey: string };

export interface ContextMenuState {
  surface: ContextSurface;
  x: number;
  y: number;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const cell = target.closest<HTMLElement>("[data-cell]");
    const header = target.closest<HTMLElement>("[data-header]");
    const rowNum = target.closest<HTMLElement>("[data-row-num]");
    let surface: ContextSurface | null = null;
    if (cell?.dataset.cell) {
      const sep = cell.dataset.cell.indexOf("::");
      if (sep > 0) {
        surface = { kind: "cell", rowKey: cell.dataset.cell.slice(0, sep), field: cell.dataset.cell.slice(sep + 2) };
      }
    } else if (header?.dataset.header) {
      surface = { kind: "header", field: header.dataset.header };
    } else if (rowNum?.dataset.rowNum) {
      surface = { kind: "row-num", rowKey: rowNum.dataset.rowNum };
    }
    if (!surface) return;
    e.preventDefault();
    setMenu({ surface, x: e.clientX, y: e.clientY });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[role="menu"]')) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menu, close]);

  return { menu, onContextMenu, close };
}
```

- [ ] **Step 5: Create `<ContextMenu>` component**

Create `app/src/components/datagrid/ContextMenu.tsx`:

```tsx
import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  separator?: boolean;
}

export function ContextMenu({
  items, x, y, onClose,
}: { items: MenuItem[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let top = y, left = x;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    setPos({ top, left });
  }, [x, y]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 100 }}
      className="min-w-[180px] rounded-lg border border-line-2 bg-surface-elevated py-1 text-[12px] shadow-pop"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => { item.onClick(); onClose(); }}
            className={cx(
              "block w-full px-3 py-1.5 text-left text-ink",
              item.disabled ? "cursor-not-allowed opacity-40" : "hover:bg-hover",
            )}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire into DataGrid**

In `DataGrid.tsx`, add:

```typescript
const { menu, onContextMenu, close: closeMenu } = useContextMenu();
```

Pass `onContextMenu` to the grid container's onContextMenu:

```tsx
<div ref={cursor.ref} tabIndex={0} role="grid" … onContextMenu={onContextMenu} onKeyDown={handleKeyDown} …>
```

And render the menu (also inside the outermost relative container, so portal-ish via fixed positioning works at the right z-index):

```tsx
{menu && (
  <ContextMenu
    x={menu.x}
    y={menu.y}
    onClose={closeMenu}
    items={buildMenuItems(menu.surface)}
  />
)}
```

Define `buildMenuItems` inline (large but explicit):

```typescript
const buildMenuItems = (surface: ContextSurface): MenuItem[] => {
  if (surface.kind === "cell") {
    const { rowKey: rk, field } = surface;
    const row = sortedRows.find((r) => rowKey(r) === rk);
    const value = row ? getValue(row, field) : null;
    const valStr = value == null ? "" : String(value);
    return [
      { label: "Copy", onClick: () => void handleCopy() },
      { label: "Paste", onClick: () => void handlePaste() },
      { label: "Clear", onClick: () => void commitValue(rk, field, null) },
      { separator: true, label: "", onClick: () => {} },
      { label: `Filter to "${valStr.slice(0, 24)}"`, onClick: () => {
          setFilterSet((cur) => ({
            conjunction: cur?.conjunction ?? "and",
            conditions: [...(cur?.conditions ?? []), { id: `${field}-eq-${Date.now()}`, field, operator: "equals", value: valStr }],
          }));
        }
      },
      { label: `Filter to NOT "${valStr.slice(0, 24)}"`, onClick: () => {
          setFilterSet((cur) => ({
            conjunction: cur?.conjunction ?? "and",
            conditions: [...(cur?.conditions ?? []), { id: `${field}-neq-${Date.now()}`, field, operator: "not_equals", value: valStr }],
          }));
        }
      },
      { separator: true, label: "", onClick: () => {} },
      { label: "Insert row above", onClick: () => props.onInsertRow?.(rk, "above"), disabled: !props.onInsertRow },
      { label: "Insert row below", onClick: () => props.onInsertRow?.(rk, "below"), disabled: !props.onInsertRow },
      { label: "Delete row", onClick: () => props.onDeleteRow?.(rk), disabled: !props.onDeleteRow },
    ];
  }
  if (surface.kind === "header") {
    const c = orderedVisible.find((col) => col.field === surface.field);
    return [
      { label: "Sort ascending",  onClick: () => setSort({ field: surface.field, dir: "asc" }) },
      { label: "Sort descending", onClick: () => setSort({ field: surface.field, dir: "desc" }) },
      { label: "Rename", onClick: () => { menuAnchorRef.current = null; setMenuFor(surface.field); } },
      { label: "Change type", onClick: () => { menuAnchorRef.current = null; setMenuFor(surface.field); }, disabled: !props.onChangeColumnType },
      { separator: true, label: "", onClick: () => {} },
      // Conditional-formatting and Edit-description items are added in Tasks 7 and 8.
      { separator: true, label: "", onClick: () => {} },
      { label: "Hide column", onClick: () => {
          const hidden = [...columns.filter((v) => v.hidden).map((v) => v.field), surface.field];
          props.onLayoutChange?.({ hidden });
        }
      },
      { label: "Delete column", onClick: () => props.onDeleteColumn?.(surface.field), disabled: !props.onDeleteColumn || !!c?.pinnedLeft },
    ];
  }
  if (surface.kind === "row-num") {
    const rk = surface.rowKey;
    return [
      { label: "Select row", onClick: () => {
          const firstCol = orderedVisible[0], lastCol = orderedVisible[orderedVisible.length - 1];
          if (firstCol && lastCol) setRange({ anchor: { rowKey: rk, field: firstCol.field }, focus: { rowKey: rk, field: lastCol.field } });
        }
      },
      { label: "Insert above", onClick: () => props.onInsertRow?.(rk, "above"), disabled: !props.onInsertRow },
      { label: "Insert below", onClick: () => props.onInsertRow?.(rk, "below"), disabled: !props.onInsertRow },
      { label: "Duplicate", onClick: () => props.onDuplicateRow?.(rk), disabled: !props.onDuplicateRow },
      { label: "Delete", onClick: () => props.onDeleteRow?.(rk), disabled: !props.onDeleteRow },
    ];
  }
  return [];
};
```

(Note: the menu's separator items use `{ label: "", onClick: () => {}, separator: true }` to satisfy `MenuItem` shape with valid types.)

Add imports:

```typescript
import { useContextMenu, type ContextSurface } from "./useContextMenu";
import { ContextMenu, type MenuItem } from "./ContextMenu";
```

- [ ] **Step 7: Run tests, verify pass**

```bash
cd app && bun run test datagrid-context-menu
```

- [ ] **Step 8: Run full suite, typecheck**

```bash
cd app && bun run test && bun run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add app/src/components/datagrid/useContextMenu.ts app/src/components/datagrid/ContextMenu.tsx app/src/components/datagrid/types.ts app/src/components/datagrid/DataGrid.tsx app/test/datagrid-context-menu.test.tsx
git commit -m "feat(grid): right-click context menus for cells, headers, and row numbers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Task 7 — Conditional formatting

**Files:**
- Create: `app/src/components/datagrid/useConditionalFormatting.ts`
- Create: `app/src/components/datagrid/ConditionalFormatPopover.tsx`
- Modify: `app/src/components/datagrid/types.ts` (add `rules?` to ColumnDef, add `onSaveColumnRules` prop)
- Modify: `app/src/components/datagrid/DataGrid.tsx`
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx`
- Modify: `app/src/components/TablePane.tsx`
- Modify: `app/src/data.ts` (FieldDef.rules)
- Modify: `server/src/repo-shared.ts` (FieldDef.rules)
- Test: `app/test/datagrid-conditional-format.test.tsx`

- [ ] **Step 1: Define the rule types in `types.ts`**

In `app/src/components/datagrid/types.ts`, add:

```typescript
import type { PaletteName } from "../../lib/palette";

export interface RuleStyle {
  cellBg?:    PaletteName;
  textColor?: PaletteName;
  rowStripe?: PaletteName;
}

export type ConditionalRule =
  | { id: string; field: string; trigger: { kind: "equals" | "not_equals" | "contains" | "starts_with" | "ends_with"; value: string }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_empty" | "is_not_empty" }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_in"; values: string[] }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "gt" | "lt"; value: number }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "between"; min: number; max: number }; style: RuleStyle };
```

Extend `ColumnDef<Row>`:

```typescript
rules?: ConditionalRule[];
```

Extend `DataGridProps<Row>`:

```typescript
onSaveColumnRules?: (field: string, rules: ConditionalRule[]) => void;
```

- [ ] **Step 2: Write the failing test**

Create `app/test/datagrid-conditional-format.test.tsx`:

```tsx
import { test, expect, describe } from "vitest";
import { render } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef, ConditionalRule } from "../src/components/datagrid/types";

interface Row { id: string; status: string }
const rows: Row[] = [
  { id: "1", status: "ok" },
  { id: "2", status: "conflict" },
];
const rule: ConditionalRule = {
  id: "r1",
  field: "status",
  trigger: { kind: "equals", value: "conflict" },
  style: { rowStripe: "rose" },
};
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "status", label: "Status", config: { type: "text" }, rules: [rule] },
];

describe("conditional formatting", () => {
  test("matching row gets the row stripe element", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const stripes = container.querySelectorAll('[data-row-stripe]');
    expect(stripes.length).toBe(1);
    expect((stripes[0] as HTMLElement).dataset.rowStripe).toBe("rose");
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

```bash
cd app && bun run test datagrid-conditional-format
```

- [ ] **Step 4: Implement `useConditionalFormatting`**

Create `app/src/components/datagrid/useConditionalFormatting.ts`:

```typescript
import { useMemo } from "react";
import type { ColumnDef, ConditionalRule, RuleStyle } from "./types";

function evaluateTrigger(rule: ConditionalRule, raw: unknown): boolean {
  if (rule.trigger.kind === "is_empty")     return raw == null || raw === "";
  if (rule.trigger.kind === "is_not_empty") return raw != null && raw !== "";
  const s = raw == null ? "" : String(raw);
  switch (rule.trigger.kind) {
    case "equals":      return s === rule.trigger.value;
    case "not_equals":  return s !== rule.trigger.value;
    case "contains":    return s.includes(rule.trigger.value);
    case "starts_with": return s.startsWith(rule.trigger.value);
    case "ends_with":   return s.endsWith(rule.trigger.value);
    case "is_in":       return rule.trigger.values.includes(s);
    case "gt":          return typeof raw === "number" && raw > rule.trigger.value;
    case "lt":          return typeof raw === "number" && raw < rule.trigger.value;
    case "between":     return typeof raw === "number" && raw >= rule.trigger.min && raw <= rule.trigger.max;
  }
}

export interface RowEvaluation {
  cellStyles: Map<string, RuleStyle>; // field → style of first matching rule
  rowStripe:  string | null;          // PaletteName of first non-null stripe (L-to-R)
}

export function useConditionalFormatting<Row>(
  columns: ColumnDef<Row>[],
  getValue: (row: Row, field: string) => unknown,
) {
  return useMemo(() => {
    const hasRules = columns.some((c) => c.rules && c.rules.length > 0);
    const evaluateRow = (row: Row): RowEvaluation => {
      const cellStyles = new Map<string, RuleStyle>();
      let rowStripe: string | null = null;
      if (!hasRules) return { cellStyles, rowStripe };
      for (const c of columns) {
        if (!c.rules || c.rules.length === 0) continue;
        const v = getValue(row, c.field);
        for (const r of c.rules) {
          if (evaluateTrigger(r, v)) {
            cellStyles.set(c.field, r.style);
            if (!rowStripe && r.style.rowStripe) rowStripe = r.style.rowStripe;
            break; // first match per column wins
          }
        }
      }
      return { cellStyles, rowStripe };
    };
    return { evaluateRow, hasRules };
  }, [columns, getValue]);
}
```

- [ ] **Step 5: Apply styles in `GridRowInner`**

In `DataGrid.tsx`, thread the `evaluateRow` function through `GridRowProps`:

```typescript
interface GridRowProps<Row> {
  // …existing…
  evaluation: { cellStyles: Map<string, RuleStyle>; rowStripe: string | null };
}
```

Pass at the render site:

```tsx
const evaluation = condFmt.evaluateRow(row);
// …
<GridRow … evaluation={evaluation} />
```

Inside `GridRowInner`:

- Render the row stripe as a 4px-wide accent bar on the left of the row when `evaluation.rowStripe` is not null:

```tsx
{evaluation.rowStripe && (
  <span
    aria-hidden
    data-row-stripe={evaluation.rowStripe}
    className="absolute left-0 top-0 bottom-0 w-1"
    style={{ background: `var(--palette-${evaluation.rowStripe})` }}
  />
)}
```

- Apply per-cell styles by reading `evaluation.cellStyles.get(c.field)` and extending the `style` attr on the cell `<div>`:

```tsx
const ruleStyle = evaluation.cellStyles.get(c.field);
const inlineStyle: React.CSSProperties = {};
if (ruleStyle?.cellBg) inlineStyle.background = `var(--palette-${ruleStyle.cellBg}-wash)`;
if (ruleStyle?.textColor) inlineStyle.color = `var(--palette-${ruleStyle.textColor})`;
// …
<div … style={inlineStyle} className={cellCx}>
```

(Use the existing CSS variables exposed by `app/src/lib/palette.ts` — `--palette-<name>` and `--palette-<name>-wash`. If they don't exist with those exact names, follow whatever the project does — check `palette.ts`.)

Also, ensure the row `<div>` has `relative` so the absolute-positioned stripe attaches. Update the row container className:

```tsx
className={cx(
  "relative grid items-stretch border-b border-line transition-colors",
  …
)}
```

- [ ] **Step 6: Mount `useConditionalFormatting` in DataGrid**

```typescript
const condFmt = useConditionalFormatting(orderedVisible, getValue);
```

- [ ] **Step 7: Run tests, verify pass**

```bash
cd app && bun run test datagrid-conditional-format
```

- [ ] **Step 8: Build the editor popover**

Create `app/src/components/datagrid/ConditionalFormatPopover.tsx`:

```tsx
import { useState } from "react";
import { cx } from "../../lib/cx";
import type { ConditionalRule, ColumnDef, RuleStyle } from "./types";
import type { PaletteName } from "../../lib/palette";

const PALETTES: PaletteName[] = ["rose", "amber", "lime", "sky", "indigo", "violet"];

export function ConditionalFormatPopover<Row>({
  column, rules, onChange, onClose, anchorRef,
}: {
  column: ColumnDef<Row>;
  rules: ConditionalRule[];
  onChange: (rules: ConditionalRule[]) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}) {
  const [local, setLocal] = useState(rules);
  const numeric = column.config.type === "number" || column.config.type === "rating";

  const addRule = () => {
    const r: ConditionalRule = numeric
      ? { id: `r_${Date.now()}`, field: column.field, trigger: { kind: "gt", value: 0 }, style: { rowStripe: "rose" } }
      : { id: `r_${Date.now()}`, field: column.field, trigger: { kind: "equals", value: "" }, style: { rowStripe: "rose" } };
    setLocal((cur) => [...cur, r]);
  };

  const removeRule = (id: string) => setLocal((cur) => cur.filter((r) => r.id !== id));

  const save = () => { onChange(local); onClose(); };

  return (
    <div
      role="dialog"
      aria-label="Conditional formatting"
      className="absolute right-0 top-full mt-1 z-50 w-[400px] rounded-lg border border-line-2 bg-surface-elevated p-3 shadow-pop"
    >
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        Rules for {column.label}
      </div>
      <ul className="space-y-2">
        {local.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-1 rounded border border-line bg-surface p-2 text-[11px]">
            <span>If</span>
            <select
              value={r.trigger.kind}
              onChange={(e) => {
                const k = e.target.value;
                setLocal((cur) => cur.map((x) => x.id === r.id ? ({ ...x, trigger: defaultTrigger(k, numeric) } as ConditionalRule) : x));
              }}
              className="rounded border border-line bg-surface px-1 py-0.5"
            >
              {(numeric
                ? ["gt", "lt", "between", "is_empty", "is_not_empty"] as const
                : ["equals", "not_equals", "contains", "starts_with", "ends_with", "is_empty", "is_not_empty"] as const
              ).map((k) => <option key={k} value={k}>{labelFor(k)}</option>)}
            </select>
            <TriggerInput rule={r} onChange={(t) => setLocal((cur) => cur.map((x) => x.id === r.id ? { ...x, trigger: t } as ConditionalRule : x))} />
            <span>then</span>
            <StyleSwatchPicker
              style={r.style}
              onChange={(s) => setLocal((cur) => cur.map((x) => x.id === r.id ? { ...x, style: s } : x))}
            />
            <button onClick={() => removeRule(r.id)} className="ml-auto text-ink-3 hover:text-rose">×</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between">
        <button onClick={addRule} className="text-[11px] text-accent hover:brightness-110">+ Add rule</button>
        <div className="flex gap-1">
          <button onClick={onClose} className="rounded px-2 py-1 text-[11px] text-ink-2 hover:bg-hover">Cancel</button>
          <button onClick={save} className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:brightness-110">Save</button>
        </div>
      </div>
    </div>
  );
}

function defaultTrigger(kind: string, numeric: boolean): ConditionalRule["trigger"] {
  switch (kind) {
    case "is_empty":     return { kind: "is_empty" };
    case "is_not_empty": return { kind: "is_not_empty" };
    case "gt":           return { kind: "gt", value: 0 };
    case "lt":           return { kind: "lt", value: 0 };
    case "between":      return { kind: "between", min: 0, max: 0 };
    case "is_in":        return { kind: "is_in", values: [] };
    default:             return { kind: kind as "equals", value: "" };
  }
}

function labelFor(k: string): string {
  return ({
    equals: "equals", not_equals: "≠", contains: "contains", starts_with: "starts with",
    ends_with: "ends with", is_empty: "is empty", is_not_empty: "is not empty",
    gt: ">", lt: "<", between: "between", is_in: "is one of",
  } as Record<string, string>)[k] ?? k;
}

function TriggerInput({ rule, onChange }: { rule: ConditionalRule; onChange: (t: ConditionalRule["trigger"]) => void }) {
  const t = rule.trigger;
  if (t.kind === "is_empty" || t.kind === "is_not_empty") return null;
  if (t.kind === "between") {
    return (
      <>
        <input type="number" value={t.min} onChange={(e) => onChange({ ...t, min: Number(e.target.value) })} className="w-16 rounded border border-line bg-surface px-1 py-0.5" />
        <span>and</span>
        <input type="number" value={t.max} onChange={(e) => onChange({ ...t, max: Number(e.target.value) })} className="w-16 rounded border border-line bg-surface px-1 py-0.5" />
      </>
    );
  }
  if (t.kind === "gt" || t.kind === "lt") {
    return <input type="number" value={t.value} onChange={(e) => onChange({ ...t, value: Number(e.target.value) })} className="w-20 rounded border border-line bg-surface px-1 py-0.5" />;
  }
  if (t.kind === "is_in") {
    return <input type="text" placeholder="comma-separated" value={t.values.join(",")} onChange={(e) => onChange({ ...t, values: e.target.value.split(",").map((s) => s.trim()) })} className="w-40 rounded border border-line bg-surface px-1 py-0.5" />;
  }
  return <input type="text" value={t.value} onChange={(e) => onChange({ ...t, value: e.target.value })} className="w-32 rounded border border-line bg-surface px-1 py-0.5" />;
}

function StyleSwatchPicker({ style, onChange }: { style: RuleStyle; onChange: (s: RuleStyle) => void }) {
  return (
    <div className="flex gap-0.5">
      {PALETTES.map((p) => (
        <button
          key={p}
          onClick={() => onChange({ ...style, rowStripe: p })}
          aria-label={`Set stripe ${p}`}
          className={cx("h-4 w-4 rounded-sm border", style.rowStripe === p ? "ring-2 ring-accent" : "border-line")}
          style={{ background: `var(--palette-${p})` }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Launch popover from ColumnHeaderMenu**

In `app/src/components/datagrid/ColumnHeaderMenu.tsx`, add a "Conditional formatting…" item to the menu's items list. When clicked it opens the popover anchored to the menu's anchor. The popover state lives in `DataGrid.tsx`:

```typescript
const [rulesEditor, setRulesEditor] = useState<string | null>(null); // field
// inside ColumnHeaderMenu render call:
<ColumnHeaderMenu
  …
  onOpenRules={() => setRulesEditor(c.field)}
/>
```

And in the menu component, add the item:

```tsx
{onOpenRules && (
  <MenuItem onClick={onOpenRules}>Conditional formatting…</MenuItem>
)}
```

(Match the exact `<MenuItem>` JSX shape used by the existing items in `ColumnHeaderMenu.tsx`.)

In `DataGrid.tsx` body, render the popover when `rulesEditor` is the current field:

```tsx
{rulesEditor && (() => {
  const col = orderedVisible.find((c) => c.field === rulesEditor);
  if (!col) return null;
  return (
    <ConditionalFormatPopover
      column={col}
      rules={col.rules ?? []}
      anchorRef={menuAnchorRef}
      onChange={(rules) => props.onSaveColumnRules?.(col.field, rules)}
      onClose={() => setRulesEditor(null)}
    />
  );
})()}
```

- [ ] **Step 10: Wire persistence through TablePane → server**

In `app/src/store.ts`, add the helper next to existing field-update functions:

```typescript
import type { ConditionalRule } from "./components/datagrid/types";

export async function updateFieldRules(dimId: string, field: string, rules: ConditionalRule[]): Promise<void> {
  // Read current field config so we can merge rules without dropping type-specific keys (options, numberFormat, ratingMax)
  const cur = await fetch(`/api/dimensions/${dimId}`).then((r) => r.json()) as { fields: Array<{ field: string; field_config?: string }> };
  const existing = cur.fields.find((f) => f.field === field);
  let cfg: Record<string, unknown> = {};
  if (existing?.field_config) {
    try { cfg = JSON.parse(existing.field_config) as Record<string, unknown>; } catch { cfg = {}; }
  }
  cfg.rules = rules;
  const res = await fetch(`/api/dimensions/${dimId}/fields/${field}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ field_config: JSON.stringify(cfg) }),
  });
  if (!res.ok) throw new Error(`updateFieldRules failed: ${res.status}`);
}
```

(Use the project's existing refresh-after-update pattern — look at how other field-update helpers in `store.ts` trigger reload. Mirror that exactly.)

In `app/src/components/TablePane.tsx`, find where it passes props to `<DataGrid>`. Add:

```typescript
onSaveColumnRules={(field, rules) => {
  void updateFieldRules(dimId, field, rules).then(() => refreshDimension(dimId));
}}
```

(Replace `refreshDimension` with whatever the existing reload helper is in this file — search for how other PATCHes are followed.)

Also, where `TablePane.tsx` builds `ColumnDef[]` from dimension fields, pass `rules` through:

```typescript
const columns: ColumnDef<Row>[] = dim.fields.map((f) => ({
  field: f.field,
  label: f.label,
  config: columnConfigFromFieldDef(f),
  rules: f.rules,            // NEW
  description: f.description, // NEW (Task 8)
  // …existing props
}));
```

On the server side, in `server/src/repo-shared.ts`, extend `FieldDef`:

```typescript
import type { ConditionalRule } from "./conditional-format-types"; // see below

export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string;
  displayFields?: string[];
  description?: string;
  rules?: ConditionalRule[];   // NEW
}
```

Create `server/src/conditional-format-types.ts` (server-side copy of the rule union — keeps `repo-shared.ts` free of React/Tailwind dependencies):

```typescript
export type ConditionalRule =
  | { id: string; field: string; trigger: { kind: "equals" | "not_equals" | "contains" | "starts_with" | "ends_with"; value: string }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_empty" | "is_not_empty" }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_in"; values: string[] }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "gt" | "lt"; value: number }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "between"; min: number; max: number }; style: RuleStyle };

export interface RuleStyle {
  cellBg?:    string;
  textColor?: string;
  rowStripe?: string;
}
```

In `server/src/repo-canonical.ts`, update `parseFieldConfig` to extract `rules` from the JSON and return it as part of the FieldDef shape:

```typescript
function parseFieldConfig(type: string, raw: string | null): Partial<FieldDef> {
  if (!raw) return {};
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  const out: Partial<FieldDef> = {};
  // Type-specific keys (existing logic — preserve unchanged)
  if (type === "select" && Array.isArray(parsed.options)) out.options = parsed.options as OptionDef[];
  if (type === "number" && parsed.numberFormat) out.numberFormat = parsed.numberFormat as NumberFormat;
  if (type === "rating" && typeof parsed.ratingMax === "number") out.ratingMax = parsed.ratingMax;
  if (type === "linked") {
    if (typeof parsed.referencedDimId === "string") out.referencedDimId = parsed.referencedDimId;
    if (Array.isArray(parsed.displayFields)) out.displayFields = parsed.displayFields as string[];
  }
  // NEW: rules are allowed alongside any other config
  if (Array.isArray(parsed.rules)) out.rules = parsed.rules as ConditionalRule[];
  return out;
}
```

(The exact existing shape of `parseFieldConfig` may differ — preserve whatever's there for type-specific keys and only add the `rules` extraction at the end.)

- [ ] **Step 11: Add "Conditional formatting…" to the right-click header menu**

In `DataGrid.tsx`'s `buildMenuItems` (Task 6 step 6), insert this item in the `surface.kind === "header"` branch — place it right after the "Change type" item and before the separator preceding "Hide column":

```typescript
{ label: "Conditional formatting…", onClick: () => setRulesEditor(surface.field), disabled: !props.onSaveColumnRules },
```

- [ ] **Step 12: Run tests, typecheck, manual verify**

```bash
cd app && bun run test datagrid-conditional-format && bun run typecheck
cd app && bun run dev
***REMOVED*** create rule via header menu → set "status equals conflict" → "rose" stripe → verify row glows
```

- [ ] **Step 13: Commit**

```bash
git add app/src/components/datagrid/useConditionalFormatting.ts app/src/components/datagrid/ConditionalFormatPopover.tsx app/src/components/datagrid/types.ts app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/ColumnHeaderMenu.tsx app/src/components/TablePane.tsx app/src/data.ts server/src/repo-shared.ts server/src/repo-canonical.ts app/test/datagrid-conditional-format.test.tsx
git commit -m "feat(grid): conditional formatting — per-column rules paint cells and row stripes

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Task 8 — Field description tooltips

**Files:**
- Create: `app/src/components/datagrid/FieldDescriptionEditor.tsx`
- Modify: `app/src/components/datagrid/DataGrid.tsx`
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx`
- Modify: `app/src/components/datagrid/types.ts` (add `onSaveColumnDescription` prop)
- Modify: `app/src/components/TablePane.tsx`
- Test: `app/test/datagrid-field-description.test.tsx`

Depends on Task 1 (schema migration).

- [ ] **Step 1: Add the prop type**

In `types.ts`, append to `DataGridProps<Row>`:

```typescript
onSaveColumnDescription?: (field: string, description: string | null) => void;
```

- [ ] **Step 2: Write the failing test**

Create `app/test/datagrid-field-description.test.tsx`:

```tsx
import { test, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string }
const rows: Row[] = [{ id: "1", name: "Acme" }];
const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", description: "The display name of the partner.", config: { type: "text" } },
];

test("header with description shows an i icon on hover, with tooltip text", () => {
  const { container, getByText } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  const header = container.querySelector('[data-header="name"]') as HTMLElement;
  act(() => { fireEvent.mouseEnter(header); });
  const icon = header.querySelector('[data-field-info]') as HTMLElement;
  expect(icon).not.toBeNull();
  act(() => { fireEvent.mouseEnter(icon); });
  expect(getByText("The display name of the partner.")).toBeTruthy();
});

test("header without description shows NO i icon", () => {
  const cols2: ColumnDef<Row>[] = [{ field: "name", label: "Name", config: { type: "text" } }];
  const { container } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={cols2} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  const header = container.querySelector('[data-header="name"]') as HTMLElement;
  act(() => { fireEvent.mouseEnter(header); });
  expect(header.querySelector('[data-field-info]')).toBeNull();
});
```

- [ ] **Step 3: Run, expect FAIL**

```bash
cd app && bun run test datagrid-field-description
```

- [ ] **Step 4: Render the i-icon in the header**

In `DataGrid.tsx`, locate the header label render (~line 1017). Right after the `<span>` that contains the label and sort glyph, conditionally render:

```tsx
{c.description && (
  <span
    data-field-info
    title={c.description}
    className="ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-line-2 text-[8px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
    aria-label={`Description: ${c.description}`}
  >
    i
  </span>
)}
```

(Tooltip via the native `title` attribute is sufficient for v1 — the spec says plain text, no markdown. If a Tooltip component exists in the codebase, use it instead.)

- [ ] **Step 5: Create the editor popover**

Create `app/src/components/datagrid/FieldDescriptionEditor.tsx`:

```tsx
import { useState, useLayoutEffect, useRef } from "react";

export function FieldDescriptionEditor({
  field, initial, onSave, onClose, anchorRef,
}: {
  field: string;
  initial: string | null;
  onSave: (next: string | null) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const [value, setValue] = useState(initial ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left });
  }, [anchorRef]);

  if (!pos) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Edit description for ${field}`}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 50 }}
      className="w-[320px] rounded-lg border border-line-2 bg-surface-elevated p-3 shadow-pop"
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">Description</div>
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-[12px] text-ink"
        placeholder="What does this field mean? Where does it come from?"
      />
      <div className="mt-2 flex justify-end gap-1">
        <button onClick={onClose} className="rounded px-2 py-1 text-[11px] text-ink-2 hover:bg-hover">Cancel</button>
        <button
          onClick={() => { onSave(value.trim() === "" ? null : value); onClose(); }}
          className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:brightness-110"
        >Save</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Add "Edit description" to ColumnHeaderMenu + wire popover**

In `ColumnHeaderMenu.tsx`, add a new `onEditDescription?: () => void` prop and a menu item. In `DataGrid.tsx`, manage state for it:

```typescript
const [descEditor, setDescEditor] = useState<string | null>(null); // field
// in ColumnHeaderMenu render:
<ColumnHeaderMenu
  …
  onEditDescription={() => setDescEditor(c.field)}
/>
// elsewhere, render the editor:
{descEditor && (() => {
  const col = orderedVisible.find((c) => c.field === descEditor);
  if (!col) return null;
  return (
    <FieldDescriptionEditor
      field={col.field}
      initial={col.description ?? null}
      anchorRef={menuAnchorRef}
      onSave={(next) => props.onSaveColumnDescription?.(col.field, next)}
      onClose={() => setDescEditor(null)}
    />
  );
})()}
```

- [ ] **Step 7: Add "Edit description" to the right-click header menu**

In `DataGrid.tsx`'s `buildMenuItems` (Task 6 step 6), insert this item in the `surface.kind === "header"` branch — place it directly under the "Conditional formatting…" item added in Task 7 Step 11:

```typescript
{ label: "Edit description", onClick: () => setDescEditor(surface.field), disabled: !props.onSaveColumnDescription },
```

- [ ] **Step 8: Persist through TablePane**

In `app/src/components/TablePane.tsx`, wire `onSaveColumnDescription`:

```typescript
onSaveColumnDescription={(field, description) => {
  void updateFieldDescription(dimId, field, description);
}}
```

Add `updateFieldDescription` to `app/src/store.ts` (or the relevant store):

```typescript
export async function updateFieldDescription(dimId: string, field: string, description: string | null) {
  const res = await fetch(`/api/dimensions/${dimId}/fields/${field}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error(`updateFieldDescription failed: ${res.status}`);
  await refreshDimension(dimId); // or whatever the existing refresh pattern is
}
```

Also ensure that when `TablePane` reads the dimension fields and maps them to `ColumnDef[]`, it passes through `description`. Search for where `ColumnDef` is built in `TablePane.tsx` and add `description: f.description`.

- [ ] **Step 9: Run tests, typecheck**

```bash
cd app && bun run test datagrid-field-description && bun run typecheck
```

Expected: PASS.

- [ ] **Step 10: Manual verify**

```bash
cd app && bun run dev
***REMOVED*** in a table: column header ⋯ menu → Edit description → type some text → save
***REMOVED*** hover the header → small `i` appears → hover it → tooltip shows the text
***REMOVED*** refresh the page → description persisted
```

- [ ] **Step 11: Commit**

```bash
git add app/src/components/datagrid/FieldDescriptionEditor.tsx app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/ColumnHeaderMenu.tsx app/src/components/datagrid/types.ts app/src/components/TablePane.tsx app/src/store.ts app/test/datagrid-field-description.test.tsx
git commit -m "feat(grid): field description tooltips with hover icon and editor popover

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

***REMOVED******REMOVED*** Final verification

After all eight tasks:

- [ ] **Run the entire test suite, both packages**

```bash
cd app && bun run test
cd ../server && bun run test
```

- [ ] **Typecheck both packages**

```bash
cd app && bun run typecheck
cd ../server && bun run typecheck
```

- [ ] **Lint both packages**

```bash
cd app && bun run lint
cd ../server && bun run lint
```

- [ ] **Run dev + spot-check each feature in the browser**

```bash
cd server && bun run start &
cd app && bun run dev
```

Spec verification checklist (from `2026-06-07-grid-spreadsheet-pass-design.md` §9):
1. Fill handle: drag down over 50 rows in a `select` column → all show source option chip; Cmd+Z undoes all.
2. ⌘↓ from row 0 in all-filled column → cursor lands on last row.
3. Select 20 rows × 3 columns → status bar shows Count, Distinct, Sum.
4. Click row number → row highlighted; ⌫ clears.
5. Right-click a cell → menu opens; "Filter to this value" populates FilterBar.
6. Add rule "status equals conflict → rose stripe" → rows glow; remove → stripes disappear.
7. Set description on a field → hover header → `i` → tooltip with text.

- [ ] **Final commit if any spot-check fixes were needed**

```bash
git status
***REMOVED*** If clean: nothing to commit. If fixes: commit them with descriptive messages.
```
