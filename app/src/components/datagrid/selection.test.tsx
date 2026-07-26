import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

describe("grid selection + clear", () => {
  it("Shift+ArrowDown extends the selection to two cells", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    const sel = g
      .selectedCells()
      .map((c) => `${c.rowKey}::${c.field}`)
      .sort();
    expect(sel).toEqual(["r0::name", "r1::name"]);
  });

  it("reflects a multi-cell range in aria-selected, not just the focused cell (#160)", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    const ariaSelected = Array.from(
      g.container.querySelectorAll('[role="gridcell"][aria-selected="true"]'),
    );
    // Both cells of the 2-cell range are announced as selected.
    expect(ariaSelected.length).toBe(2);
  });

  it("associates each cell with its column header via aria-describedby (#160)", async () => {
    const g = renderGrid();
    const cell = g.cellAt(0, "region");
    const headerId = cell.getAttribute("aria-describedby");
    expect(headerId).toBeTruthy();
    const header = g.container.querySelector(`[id="${headerId}"]`);
    expect(header?.getAttribute("role")).toBe("columnheader");
  });

  it("Cmd/Ctrl+A selects all cells as a range (5 rows × 4 cols = 20)", async () => {
    // useGridCursor.ts:410 intercepts Ctrl+A first and calls onSelectAll(), which
    // (DataGrid.tsx:525-541) sets the full grid as a cell range via setRange().
    // The DataGrid.tsx:1046 row-checkbox branch (guarded by `&& selection`) is
    // never reached because the cursor hook returns early. All 20 cells appear
    // in selectedCells() via [data-in-range="true"] / [aria-selected="true"].
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Control>}a{/Control}");
    // 5 rows × 4 columns (name, count, active, region) = 20 cells
    expect(g.selectedCells().length).toBe(20);
  });

  it("Backspace clears the cursor cell via onCommit(null)", async () => {
    // DataGrid.tsx:1126 — commitValue(t.rk, t.field, null) — the empty value is null.
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Backspace}");
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", null);
  });

  it("clearing a multi-cell range commits each cell", async () => {
    // DataGrid.tsx:1103-1126 — iterates range bounds and commits null for each target.
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    await g.press("{Delete}");
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", null);
    expect(g.onCommit).toHaveBeenCalledWith("r1", "name", null);
  });
});
