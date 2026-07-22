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

  it("renders 20k rows within the perf budget (regression guard)", () => {
    const t0 = performance.now();
    const g = renderGrid({ rows: makeRows(20_000) });
    const elapsed = performance.now() - t0;
    const mounted = g.container.querySelectorAll('[role="row"][data-row]').length;
    // PRIMARY (timing-independent): virtualization holds — only a bounded number of rows
    // are ever in the DOM regardless of dataset size. A de-virtualization regression
    // (rendering all 20k) would blow this and tank real-world perf.
    // Non-vacuous: the grid actually rendered rows (an empty render would make the
    // < BOUND guard trivially true).
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(BOUND);
    // SECONDARY (coarse backstop): generous ceiling to catch a catastrophic slowdown.
    // Tune up if it flakes on a loaded machine; the mounted-count guard is the real test.
    expect(elapsed).toBeLessThan(5000);
  });

  it("mounted row count does not grow with dataset size (virtualization is sub-linear)", () => {
    const small = renderGrid({ rows: makeRows(1_000) });
    const large = renderGrid({ rows: makeRows(20_000) });
    const smallMounted = small.container.querySelectorAll('[role="row"][data-row]').length;
    const largeMounted = large.container.querySelectorAll('[role="row"][data-row]').length;
    // Both should be well under BOUND; the large dataset must not mount significantly
    // more rows than the small one, proving the mounted set is data-size-independent.
    expect(smallMounted).toBeGreaterThan(0);
    expect(smallMounted).toBeLessThan(BOUND);
    expect(largeMounted).toBeLessThan(BOUND);
    expect(largeMounted).toBeLessThanOrEqual(smallMounted + 10);
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
