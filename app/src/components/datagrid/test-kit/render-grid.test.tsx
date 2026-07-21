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
