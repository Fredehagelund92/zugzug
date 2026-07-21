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
