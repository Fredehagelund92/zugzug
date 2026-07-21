import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";
import { makeRows } from "./test-kit/fixtures";

describe("grid navigation", () => {
  it("ArrowDown moves the cursor to the next row, same column", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    expect(g.cursorCell()).toEqual({ rowKey: "r0", field: "name" });
    await g.press("{ArrowDown}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("ArrowUp moves the cursor to the previous row, same column", async () => {
    const g = renderGrid();
    await g.focusCell(2, "name");
    expect(g.cursorCell()).toEqual({ rowKey: "r2", field: "name" });
    await g.press("{ArrowUp}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("ArrowDown clamps at the last row", async () => {
    const g = renderGrid();
    await g.focusCell(4, "name");
    await g.press("{ArrowDown}");
    expect(g.cursorCell()).toEqual({ rowKey: "r4", field: "name" });
  });

  it("ArrowRight moves across columns", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{ArrowRight}");
    expect(g.cursorCell()).toEqual({ rowKey: "r0", field: "count" });
  });

  it("ArrowLeft moves back across columns", async () => {
    const g = renderGrid();
    await g.focusCell(0, "count");
    await g.press("{ArrowLeft}");
    expect(g.cursorCell()).toEqual({ rowKey: "r0", field: "name" });
  });

  it("Tab advances and wraps at the row edge to the next row's first column", async () => {
    const g = renderGrid();
    await g.focusCell(0, "region"); // last column
    await g.press("{Tab}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("Shift+Tab wraps backward to the previous row's last column", async () => {
    const g = renderGrid();
    await g.focusCell(1, "name"); // first column of row 1
    await g.press("{Shift>}{Tab}{/Shift}");
    expect(g.cursorCell()).toEqual({ rowKey: "r0", field: "region" });
  });

  it("Enter (when not editing) opens the editor on the focused cell", async () => {
    // Plain Enter starts editing per useGridCursor.ts line 401: startEdit()
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Enter}");
    expect(g.editingCell()).toEqual({ rowKey: "r0", field: "name" });
  });

  it("Home jumps to the first column of the current row", async () => {
    const g = renderGrid();
    await g.focusCell(1, "region"); // last column
    await g.press("{Home}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("End jumps to the last column of the current row", async () => {
    const g = renderGrid();
    await g.focusCell(1, "name"); // first column
    await g.press("{End}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "region" });
  });

  it("PageDown moves the cursor down by at least one row", async () => {
    // In jsdom the container has no height, so page size clamps to 1.
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{PageDown}");
    // page = Math.max(1, Math.floor(0 / 37) - 1) = 1
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("PageUp moves the cursor up by at least one row", async () => {
    const g = renderGrid();
    await g.focusCell(2, "name");
    await g.press("{PageUp}");
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });

  it("Ctrl+ArrowDown jumps to the last filled row in the column", async () => {
    // All rows have data, so findEdge walks to the last row (r4).
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Control>}{ArrowDown}{/Control}");
    expect(g.cursorCell()).toEqual({ rowKey: "r4", field: "name" });
  });

  it("Ctrl+ArrowUp jumps to the first filled row in the column", async () => {
    const g = renderGrid();
    await g.focusCell(4, "name");
    await g.press("{Control>}{ArrowUp}{/Control}");
    expect(g.cursorCell()).toEqual({ rowKey: "r0", field: "name" });
  });

  it("cursor recovers to the last valid row when its row is removed", async () => {
    // Start with 5 rows (r0..r4), focus the last one.
    const g = renderGrid();
    await g.focusCell(4, "name");
    expect(g.cursorCell()).toEqual({ rowKey: "r4", field: "name" });

    // Shrink to 2 rows (r0, r1). r4 no longer exists.
    // useGridCursor.ts line 254: targetIdx = Math.max(0, Math.min(lastIndexRef(4), rows.length-1(1))) = 1
    // So the cursor clamps to the new last row: r1.
    g.rerender({ rows: makeRows(2) });
    expect(g.cursorCell()).toEqual({ rowKey: "r1", field: "name" });
  });
});
