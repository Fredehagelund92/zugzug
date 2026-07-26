import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Height-chain contract for the Tables grid.
 *
 * The DataGrid's scroll container (`.zz-grid-scroll`, overflow-auto) can only
 * scroll — and therefore the row virtualizer can only virtualize — when every
 * flex-child wrapper between the tab pane and the grid carries `min-h-0`
 * (flex children default to min-height:auto and grow to content height).
 *
 * A bare `<div>` wrapper in RecordsBody broke this chain in commit 36e743f:
 * with it, ALL rows mount (116k DOM nodes / 0.4 FPS at 10k rows, measured in
 * docs/grid-next-level-plan.md §2). jsdom does no layout, so this contract is
 * asserted at the source level: the root element each mode body returns must
 * participate in the flex chain.
 *
 * If this test fails after a refactor, the fix is to keep `flex flex-1
 * flex-col min-h-0` (or an equivalent height constraint) on the mode body's
 * root element — not to delete the test.
 */

function rootDivOfComponent(source: string, componentName: string): string {
  const start = source.indexOf(`function ${componentName}(`);
  expect(start, `function ${componentName} not found`).toBeGreaterThan(-1);
  const body = source.slice(start);
  // Match the JSX return — `return (` followed by a newline — not an effect
  // cleanup `return () => {`, whose `(` is immediately closed by `)`.
  const ret = body.search(/return \(\s*\n/);
  expect(ret, `no return ( in ${componentName}`).toBeGreaterThan(-1);
  const afterReturn = body.slice(ret);
  const divStart = afterReturn.indexOf("<div");
  const divEnd = afterReturn.indexOf(">", divStart);
  return afterReturn.slice(divStart, divEnd + 1);
}

describe("Tables grid height-constraint chain", () => {
  test("RecordsBody's root div is height-constrained (min-h-0 flex chain)", () => {
    const src = readFileSync(join(__dirname, "../src/components/TablePane.tsx"), "utf8");
    const rootDiv = rootDivOfComponent(src, "RecordsBody");
    expect(rootDiv).toContain("min-h-0");
    expect(rootDiv).toContain("flex");
  });

  test("MapValuesBody's root div is height-constrained (guards the sibling mode)", () => {
    const src = readFileSync(join(__dirname, "../src/components/modes/MapValuesBody.tsx"), "utf8");
    const rootDiv = rootDivOfComponent(src, "MapValuesBody");
    expect(rootDiv).toContain("min-h-0");
    expect(rootDiv).toContain("flex");
  });
});
