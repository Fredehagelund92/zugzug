# Grid Test-Kit + Core-Interaction Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable RTL/jsdom test-kit for the data grid (render helper, fixtures, keyboard/interaction driver, DOM queries) plus a core-interaction suite (navigation, editing, selection, undo) and a 20k-row virtualization guard.

**Architecture:** Everything lives under `app/src/components/datagrid/`, co-located with the grid so the existing `cd app && bun run test` CI job runs it. `DataGrid` is store-agnostic (props only) and needs just `<UndoStackProvider>`. The kit centralizes mount + isolation; suites are keyboard-driven and assert on a `vi.fn()` `onCommit` and cursor/selection DOM markers.

**Tech Stack:** vitest 4, jsdom, `@testing-library/react`, `@testing-library/user-event` (all already installed); TanStack Virtual (already polyfilled in `app/test/setup.ts`).

## Global Constraints

- Run all tests from `app/`: `bun run test` (CI-equivalent) or `bun run test <file>`. Never add a CI step — vitest auto-discovers `*.test.tsx`.
- These are **characterization tests of existing, working grid behavior** — not red-green-implement. For each suite test: write it to assert the *expected* behavior, run it; if it fails, first determine whether the test is miscalibrated (fix the assertion to match correct behavior) or a real grid bug (stop and report it — do not paper over it). The kit modules (Task 1–2) ARE new code and follow normal TDD.
- `DataGrid` required props: `rows`, `rowKey`, `columns`. `onCommit?` undefined ⇒ read-only. Only context needed: `UndoStackProvider` from `./UndoStack` (`useUndoStack` throws `"useUndoStack outside <UndoStackProvider>"`).
- **Undo isolation:** `UndoStack` stacks live in a module-level map keyed by `scopeKey`, never cleared. `renderGrid` MUST pass a unique `scopeKey` per call.
- DOM markers (verified): cell = `role="gridcell"` + `data-cell="{rowKey}::{field}"` + `data-field`; cursor cell = `aria-selected="true"`; row = `role="row"` + `data-row="{rowKey}"`; grid = `role="grid"`. Range cells get a new `data-in-range="true"` (added in Task 1).
- Fixture types (verified): `ColumnDef<Row> = { field; label; config: ColumnConfig; editable?; width?; ... }`; `ColumnConfig` union by `type` (`text`, `number`+`numberFormat?`, `boolean`, `select`+`options: OptionDef[]`); `OptionDef = { label: string; color: PaletteName | null }` (select value is the label string). Import `PaletteName` from `app/src/lib/palette`.
- No `Math.random`/`Date.now` in fixtures — deterministic data.
- Commits: `git commit -s` with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Work on a branch, not `main`.

---

### Task 1: Kit foundation — `data-in-range` hook, fixtures, queries, renderGrid, kit smoke

**Files:**
- Modify: `app/src/components/datagrid/DataGridRow.tsx` (add `data-in-range` on the range branch)
- Create: `app/src/components/datagrid/test-kit/fixtures.ts`
- Create: `app/src/components/datagrid/test-kit/queries.ts`
- Create: `app/src/components/datagrid/test-kit/render-grid.tsx`
- Create (test): `app/src/components/datagrid/test-kit/render-grid.test.tsx`

**Interfaces produced (later tasks rely on these exact names/types):**
```ts
// fixtures.ts
export type Row = { id: string; name: string; count: number; active: boolean; region: string };
export const rowKeyFn: (r: Row) => string;              // (r) => r.id
export function makeColumns(): ColumnDef<Row>[];         // text:name, number:count, boolean:active, select:region
export function makeRows(n?: number): Row[];             // default 5; id `r0..r{n-1}`

// queries.ts  (all throw a clear Error if the marker is absent)
export function cellAt(container: HTMLElement, rowKey: string, field: string): HTMLElement;
export function cursorCell(container: HTMLElement): { rowKey: string; field: string } | null;
export function selectedCells(container: HTMLElement): Array<{ rowKey: string; field: string }>;
export function editingCell(container: HTMLElement): { rowKey: string; field: string } | null;

// render-grid.tsx
export interface RenderGridHandle {
  user: UserEvent;
  onCommit: ReturnType<typeof vi.fn>;                    // (rowKey, field, value) => Promise<void>
  container: HTMLElement;
  rows: Row[];
  rerender: (overrides?: Partial<Parameters<typeof renderGrid>[0]>) => void;
  cellAt: (rowIndex: number, field: string) => HTMLElement;      // maps index → rows[index].id
  cursorCell: () => { rowKey: string; field: string } | null;
  selectedCells: () => Array<{ rowKey: string; field: string }>;
  editingCell: () => { rowKey: string; field: string } | null;
}
export function renderGrid(overrides?: {
  rows?: Row[]; columns?: ColumnDef<Row>[]; onCommit?: RenderGridHandle["onCommit"];
  // plus any other DataGridProps<Row> passthrough
} & Partial<Record<string, unknown>>): RenderGridHandle;
```

- [ ] **Step 1: Add the `data-in-range` DOM hook**

In `app/src/components/datagrid/DataGridRow.tsx`, the `GridCell` renders a `<div role="gridcell" … data-cell={data} data-field={c.field} aria-selected={focused ? true : undefined}>` (~line 128-133) and already receives an `inRange: boolean` prop (line 94). Add one attribute to that element:

```tsx
      role="gridcell"
      aria-colindex={idx + 1}
      aria-selected={focused ? true : undefined}
      data-in-range={inRange ? "true" : undefined}
      data-cell={data}
      data-field={c.field}
```

- [ ] **Step 2: Write `fixtures.ts`**

```ts
import type { ColumnDef } from "../types";

export type Row = { id: string; name: string; count: number; active: boolean; region: string };

export const rowKeyFn = (r: Row): string => r.id;

export function makeColumns(): ColumnDef<Row>[] {
  return [
    { field: "name", label: "Name", config: { type: "text" }, editable: true },
    { field: "count", label: "Count", config: { type: "number" }, editable: true },
    { field: "active", label: "Active", config: { type: "boolean" }, editable: true },
    {
      field: "region",
      label: "Region",
      config: { type: "select", options: [{ label: "EMEA", color: null }, { label: "AMER", color: null }] },
      editable: true,
    },
  ];
}

export function makeRows(n = 5): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: `Name ${i}`,
    count: i,
    active: i % 2 === 0,
    region: i % 2 === 0 ? "AMER" : "EMEA",
  }));
}
```

- [ ] **Step 3: Write `queries.ts`**

```ts
function parseCell(el: Element): { rowKey: string; field: string } {
  const data = el.getAttribute("data-cell") ?? "";
  const idx = data.indexOf("::");
  return { rowKey: data.slice(0, idx), field: data.slice(idx + 2) };
}

export function cellAt(container: HTMLElement, rowKey: string, field: string): HTMLElement {
  const sel = `[data-cell="${CSS.escape(`${rowKey}::${field}`)}"]`;
  const el = container.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`cellAt: no cell for ${rowKey}::${field}`);
  return el;
}

export function cursorCell(container: HTMLElement): { rowKey: string; field: string } | null {
  const el = container.querySelector('[role="gridcell"][aria-selected="true"]');
  return el ? parseCell(el) : null;
}

export function selectedCells(container: HTMLElement): Array<{ rowKey: string; field: string }> {
  const els = Array.from(container.querySelectorAll('[role="gridcell"][data-in-range="true"], [role="gridcell"][aria-selected="true"]'));
  // de-dupe (cursor cell may also be in-range)
  const seen = new Set<string>();
  const out: Array<{ rowKey: string; field: string }> = [];
  for (const el of els) {
    const key = el.getAttribute("data-cell") ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parseCell(el));
  }
  return out;
}

export function editingCell(container: HTMLElement): { rowKey: string; field: string } | null {
  // the active editor (input / contenteditable) is rendered inside the editing cell
  const editor = container.querySelector('[role="gridcell"] input, [role="gridcell"] [contenteditable="true"]');
  const cell = editor?.closest('[role="gridcell"]');
  return cell ? parseCell(cell) : null;
}
```

- [ ] **Step 4: Write `render-grid.tsx`**

```tsx
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { DataGrid } from "../DataGrid";
import { UndoStackProvider } from "../UndoStack";
import type { ColumnDef } from "../types";
import { makeColumns, makeRows, rowKeyFn, type Row } from "./fixtures";
import * as q from "./queries";

let scopeSeq = 0;

export interface RenderGridOverrides {
  rows?: Row[];
  columns?: ColumnDef<Row>[];
  onCommit?: ReturnType<typeof vi.fn>;
  [prop: string]: unknown; // passthrough DataGridProps
}

export function renderGrid(overrides: RenderGridOverrides = {}) {
  const rows = overrides.rows ?? makeRows();
  const columns = overrides.columns ?? makeColumns();
  const onCommit = overrides.onCommit ?? vi.fn(async () => {});
  const { rows: _r, columns: _c, onCommit: _o, ...rest } = overrides;
  const user = userEvent.setup();

  const scopeKey = `test-${scopeSeq++}`;
  const ui = (r: Row[]) => (
    <UndoStackProvider scopeKey={scopeKey}>
      <DataGrid rows={r} rowKey={rowKeyFn} columns={columns} onCommit={onCommit} showRowNumbers {...rest} />
    </UndoStackProvider>
  );

  const { container, rerender } = render(ui(rows));
  const idToKey = (i: number) => rows[i].id;

  return {
    user,
    onCommit,
    container,
    rows,
    rerender: (o: RenderGridOverrides = {}) => rerender(ui(o.rows ?? rows)),
    cellAt: (i: number, field: string) => q.cellAt(container, idToKey(i), field),
    cursorCell: () => q.cursorCell(container),
    selectedCells: () => q.selectedCells(container),
    editingCell: () => q.editingCell(container),
  };
}
```

Note: `DataGrid`'s export name is `DataGrid` — confirm the exact import (default vs named) in `DataGrid.tsx` and adjust the import line if needed.

- [ ] **Step 5: Write the kit smoke test `render-grid.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { renderGrid } from "./render-grid";

describe("renderGrid kit", () => {
  it("mounts the grid with default fixtures", () => {
    const g = renderGrid();
    expect(g.container.querySelector('[role="grid"]')).toBeTruthy();
    // 5 default rows × 4 columns → cell (r0, name) exists
    expect(g.cellAt(0, "name").textContent).toContain("Name 0");
    expect(g.cursorCell()).toBeNull(); // nothing focused yet
    expect(g.editingCell()).toBeNull();
  });

  it("isolates undo scope across renders (no shared history)", () => {
    const a = renderGrid();
    const b = renderGrid();
    // distinct containers; distinct scope — this is a structural smoke:
    expect(a.container).not.toBe(b.container);
  });
});
```

- [ ] **Step 6: Run the kit tests**

Run: `cd app && bun run test src/components/datagrid/test-kit/render-grid.test.tsx`
Expected: PASS (2 tests). If `cellAt(0,"name")` can't find the cell, inspect the rendered DOM (the virtualizer polyfills in `app/test/setup.ts` should mount rows) and confirm `data-cell` format is `rowKey::field`.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/datagrid/DataGridRow.tsx app/src/components/datagrid/test-kit
git commit -s -m "test(grid): test-kit foundation — fixtures, queries, renderGrid + data-in-range hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Interaction driver + navigation suite

**Files:**
- Create: `app/src/components/datagrid/test-kit/driver.ts`
- Modify: `app/src/components/datagrid/test-kit/render-grid.tsx` (expose bound driver methods)
- Create (test): `app/src/components/datagrid/navigation.test.tsx`

**Interfaces produced:**
```ts
// driver.ts — pure functions over (user, container/handle)
// exposed on the handle as bound methods:
//   focusCell(rowIndex, field): Promise<void>   // click the cell
//   press(keys): Promise<void>                  // user.keyboard(keys)
//   editCell(rowIndex, field, value): Promise<void>
//   selectRange(from:[rowIndex,field], to:[rowIndex,field]): Promise<void>
```

- [ ] **Step 1: Write `driver.ts`**

```ts
import type { UserEvent } from "@testing-library/user-event";

export function makeDriver(user: UserEvent, cellAt: (i: number, f: string) => HTMLElement) {
  const focusCell = async (i: number, field: string) => {
    await user.click(cellAt(i, field));
  };
  const press = async (keys: string) => {
    await user.keyboard(keys);
  };
  const editCell = async (i: number, field: string, value: string) => {
    await user.dblClick(cellAt(i, field));
    await user.keyboard(value);
    await user.keyboard("{Enter}");
  };
  return { focusCell, press, editCell };
}
```

- [ ] **Step 2: Wire the driver into `render-grid.tsx`**

Add to the returned handle (after `editingCell`):
```tsx
    ...makeDriver(user, (i, field) => q.cellAt(container, idToKey(i), field)),
```
and `import { makeDriver } from "./driver";`.

- [ ] **Step 3: Write `navigation.test.tsx` (characterization — assert real behavior)**

```tsx
import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

describe("grid navigation", () => {
  it("ArrowDown moves the cursor to the next row, same column", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    expect(g.cursorCell()).toEqual({ rowKey: "r0", field: "name" });
    await g.press("{ArrowDown}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("ArrowRight moves across columns", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{ArrowRight}");
    expect(g.cursorCell()).toEqual({ rowKey: "r0", field: "count" });
  });

  it("Tab advances and wraps at the row edge to the next row's first column", async () => {
    const g = renderGrid();
    await g.focusCell(0, "region"); // last column
    await g.press("{Tab}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("Enter moves the cursor down one row (when not editing)", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Enter}"); // opens edit; second Enter commits+advances — characterize actual
    // If Enter opens the editor instead of moving, assert editingCell here and adjust to match real behavior.
    expect(g.editingCell()).toEqual({ rowKey: "r0", field: "name" });
  });
});
```

Also add tests for `{Home}`/`{End}` (row-edge columns), `{PageDown}`/`{PageUp}`, and `{Control>}{ArrowDown}{/Control}` edge-jump, following the same `focusCell → press → assert cursorCell` pattern. Calibrate each assertion to the real `useGridCursor.ts` behavior when you run them.

- [ ] **Step 4: Run**

Run: `cd app && bun run test src/components/datagrid/navigation.test.tsx`
Expected: PASS. For any failing assertion, inspect `useGridCursor.ts` to confirm the true behavior, fix the assertion (or report a real bug), and re-run.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/datagrid/test-kit/driver.ts app/src/components/datagrid/test-kit/render-grid.tsx app/src/components/datagrid/navigation.test.tsx
git commit -s -m "test(grid): interaction driver + navigation suite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Editing + commit suite

**Files:**
- Create (test): `app/src/components/datagrid/editing.test.tsx`

**Interfaces consumed:** `renderGrid` handle (`focusCell`, `press`, `editCell`, `onCommit`, `cellAt`, `editingCell`).

- [ ] **Step 1: Write `editing.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

describe("grid editing + commit", () => {
  it("double-click enters edit mode on the cell", async () => {
    const g = renderGrid();
    await g.user.dblClick(g.cellAt(0, "name"));
    expect(g.editingCell()).toEqual({ rowKey: "r0", field: "name" });
  });

  it("editing a text cell and pressing Enter commits via onCommit", async () => {
    const g = renderGrid();
    await g.editCell(0, "name", "Hello");
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", "Hello");
  });

  it("type-to-edit: a printable key replaces the cell and enters edit", async () => {
    const g = renderGrid();
    await g.focusCell(1, "name");
    await g.press("Z");
    expect(g.editingCell()).toEqual({ rowKey: "r1", field: "name" });
    await g.press("{Enter}");
    expect(g.onCommit).toHaveBeenCalledWith("r1", "name", "Z");
  });

  it("Escape cancels an edit without committing", async () => {
    const g = renderGrid();
    await g.user.dblClick(g.cellAt(0, "name"));
    await g.press("xyz");
    await g.press("{Escape}");
    expect(g.onCommit).not.toHaveBeenCalled();
    expect(g.editingCell()).toBeNull();
  });

  it("committing a number cell passes a numeric value", async () => {
    const g = renderGrid();
    await g.editCell(0, "count", "42");
    // Characterize: number cells may commit a number (42) or string ("42").
    // Assert whichever the code actually does, then lock it in:
    expect(g.onCommit).toHaveBeenCalledWith("r0", "count", 42);
  });
});
```

- [ ] **Step 2: Run + calibrate**

Run: `cd app && bun run test src/components/datagrid/editing.test.tsx`
Expected: PASS. The number-commit test is the most likely to need calibration — if `onCommit` receives `"42"` (string), inspect `NumberCell.tsx`'s commit path and either fix the assertion to the real type or, if the value should be numeric and isn't, report it as a finding. Do not weaken the assertion to `expect.anything()`.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/editing.test.tsx
git commit -s -m "test(grid): editing + commit suite (edit, type-to-edit, escape, number coercion)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Selection + clear suite

**Files:**
- Create (test): `app/src/components/datagrid/selection.test.tsx`

**Interfaces consumed:** `renderGrid` handle (`focusCell`, `press`, `selectedCells`, `onCommit`).

- [ ] **Step 1: Write `selection.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

describe("grid selection + clear", () => {
  it("Shift+ArrowDown extends the selection to two cells", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    const sel = g.selectedCells().map((c) => `${c.rowKey}::${c.field}`).sort();
    expect(sel).toEqual(["r0::name", "r1::name"]);
  });

  it("Cmd/Ctrl+A selects (characterize: all rows or all cells)", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Control>}a{/Control}");
    // Assert the real behavior — DataGrid.tsx:1046 routes Cmd+A to row selection.
    // Calibrate against what selectedCells()/the checkbox selection actually reflects.
    expect(g.selectedCells().length).toBeGreaterThan(1);
  });

  it("Backspace clears the cursor cell via onCommit(empty)", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Backspace}");
    // Characterize the empty value the grid commits (null vs "").
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", null);
  });

  it("clearing a multi-cell range commits each cell", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    await g.press("{Delete}");
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", null);
    expect(g.onCommit).toHaveBeenCalledWith("r1", "name", null);
  });
});
```

- [ ] **Step 2: Run + calibrate**

Run: `cd app && bun run test src/components/datagrid/selection.test.tsx`
Expected: PASS. Likely calibration points: the exact empty value (`null` vs `""` — check `DataGrid.tsx:1099-1135`), and Cmd+A semantics (row-checkbox selection vs cell range — `DataGrid.tsx:1046`). Fix assertions to the real behavior; report anything that looks like a genuine bug.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/selection.test.tsx
git commit -s -m "test(grid): selection + clear suite (shift-range, cmd-A, delete/backspace)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Undo / redo suite

**Files:**
- Create (test): `app/src/components/datagrid/undo.test.tsx`

**Interfaces consumed:** `renderGrid` handle. **Important:** the grid pushes undo entries itself only if `onCommit` performs the mutation; here `onCommit` is a spy that does nothing, so undo/redo must be asserted via the grid's own undo calls. Confirm how undo entries are recorded: `TablePane` pushes `undo.push` in its real `onCommit`, but `DataGrid`'s built-in clear/fill/paste push transactions internally (`DataGrid.tsx:812`). This suite targets the **grid-internal** undoable operations (range clear), which push without relying on the host.

- [ ] **Step 1: Write `undo.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

describe("grid undo/redo", () => {
  it("undoing a range clear restores all cleared cells in one step", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}"); // r0+r1 name
    await g.press("{Delete}");
    const clearedCalls = g.onCommit.mock.calls.length;
    expect(clearedCalls).toBeGreaterThanOrEqual(2);

    await g.press("{Control>}z{/Control}"); // undo the transaction
    // The inverse re-commits the original values for both cells:
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", "Name 0");
    expect(g.onCommit).toHaveBeenCalledWith("r1", "name", "Name 1");
  });

  it("redo re-applies after undo", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Delete}");
    await g.press("{Control>}z{/Control}");
    const beforeRedo = g.onCommit.mock.calls.length;
    await g.press("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(g.onCommit.mock.calls.length).toBeGreaterThan(beforeRedo);
  });
});
```

- [ ] **Step 2: Run + calibrate**

Run: `cd app && bun run test src/components/datagrid/undo.test.tsx`
Expected: PASS. If the grid's undo path for clear does NOT route through `onCommit` (e.g. it mutates via a different callback), inspect `UndoStack.tsx` + `DataGrid.tsx:812`/`1099-1135` and assert against the callback it actually invokes. Keep the single-transaction assertion (one undo restores both cells) — that's the behavior under test.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/undo.test.tsx
git commit -s -m "test(grid): undo/redo suite (range-clear transaction + redo)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Scale / virtualization guard (20k rows)

**Files:**
- Create (test): `app/src/components/datagrid/scale.test.tsx`

**Interfaces consumed:** `renderGrid` handle, `makeRows`.

- [ ] **Step 1: Write `scale.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";
import { makeRows } from "./test-kit/fixtures";

describe("grid virtualization at scale", () => {
  const BOUND = 100; // generous guard: visible + overscan, never all 20k

  it("mounts only a bounded number of rows with 20k rows loaded", () => {
    const g = renderGrid({ rows: makeRows(20_000) });
    // count body rows (role="row"), excluding the header row
    const rows = g.container.querySelectorAll('[role="row"][data-row]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(BOUND);
  });

  it("core interactions still work with 20k rows", async () => {
    const g = renderGrid({ rows: makeRows(20_000) });
    await g.focusCell(0, "name");
    await g.press("{ArrowDown}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
    await g.editCell(0, "name", "Edited");
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", "Edited");
  });
});
```

- [ ] **Step 2: Run**

Run: `cd app && bun run test src/components/datagrid/scale.test.tsx`
Expected: PASS. `[role="row"][data-row]` selects only body rows (the header row has no `data-row`). If the count exceeds `BOUND`, the virtualizer isn't limiting mounts — investigate before raising the threshold (that would be the regression this test exists to catch). The 20k render should still be fast (virtualized); if it times out, confirm the `getBoundingClientRect`/`ResizeObserver` polyfills in `app/test/setup.ts` are active.

- [ ] **Step 3: Full-suite regression check + commit**

Run the whole app suite to confirm no regression from the `data-in-range` change or new files:
Run: `cd app && bun run test`
Expected: all green (prior count + the new grid tests).

```bash
git add app/src/components/datagrid/scale.test.tsx
git commit -s -m "test(grid): 20k-row virtualization guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Kit (renderGrid, fixtures, driver, queries) → Tasks 1–2. ✓
- Undo isolation via unique scopeKey → Task 1 (renderGrid `scopeKey`). ✓
- `data-in-range` grid-source hook → Task 1 Step 1. ✓
- navigation / editing / selection / undo suites → Tasks 2/3/4/5. ✓
- Kit smoke → Task 1 Step 5. ✓
- Scale guard at 20k → Task 6. ✓
- No CI change; runs in existing job → Global Constraints + Task 6 Step 3. ✓
- Deferred items (copy/paste, pointer-drag, sort/filter, column ops, per-type editors, wall-clock perf) → not tasks here, by design (spec Non-goals). ✓

**Placeholder scan:** Kit code (Tasks 1–2) is complete and concrete. Suite tasks give real, runnable test bodies; the "characterize/calibrate" instructions are not placeholders — they are the correct method for tests of pre-existing behavior (write the expected assertion, run, confirm-or-report), and each names the exact file:line to check (`useGridCursor.ts`, `NumberCell.tsx`, `DataGrid.tsx:1046/1099/812`). No "TODO"/"similar to Task N".

**Type/name consistency:** `renderGrid` handle shape (`user`, `onCommit`, `cellAt(i,field)`, `cursorCell`, `selectedCells`, `editingCell`, `focusCell`, `press`, `editCell`) is defined in Task 1–2 and used identically in Tasks 3–6. `Row`/`rowKeyFn`/`makeColumns`/`makeRows` consistent. `data-in-range` marker matches between DataGridRow (Task 1 Step 1) and `queries.selectedCells` (Task 1 Step 3). Fixture rowKeys `r0..r{n-1}` match every suite's `"r0"/"r1"` assertions.
