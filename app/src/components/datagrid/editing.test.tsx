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
    // NumberCell.Editor calls Number(t) and commits the result (line 153-159 in NumberCell.tsx).
    // The committed value is a JS number, not a string.
    expect(g.onCommit).toHaveBeenCalledWith("r0", "count", 42);
  });
});
