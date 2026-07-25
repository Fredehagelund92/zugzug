import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";
import { makeColumns, type Row } from "./test-kit/fixtures";
import type { ColumnDef } from "./types";

/* Regression: a cell editor's portal popover must anchor to the cell it opens
   from, not the top-left corner of the viewport. The popover positions itself
   in a useLayoutEffect that reads anchorRef.current.getBoundingClientRect();
   the editor mounts as a child of the very cell it anchors to, so the cell's
   ref is attached only *after* the editor's first layout effect runs. Without
   a second pass the effect bails on a null anchor and the popover is stuck at
   its initial top:0/left:0. See useAnchoredPopover. */

const RECT = {
  left: 100,
  top: 200,
  right: 250,
  bottom: 224,
  width: 150,
  height: 24,
  x: 100,
  y: 200,
  toJSON() {},
} as DOMRect;

// Columns exercising each popover-based editor: select, date, linked.
function columns(): ColumnDef<Row>[] {
  return [
    ...makeColumns(),
    { field: "due", label: "Due", config: { type: "date" }, editable: true },
    {
      field: "owner",
      label: "Owner",
      config: {
        type: "linked",
        targetRefTableId: "users",
        displayFields: ["label"],
        candidates: [
          { key: "u1", label: "Ada" },
          { key: "u2", label: "Linus" },
        ],
      },
      editable: true,
    },
  ];
}

describe("cell editor popover positioning", () => {
  it.each([
    ["select", "region"],
    ["date", "due"],
    ["linked", "owner"],
  ])("anchors the %s editor popover to the cell, not the top-left corner", async (_type, field) => {
    const g = renderGrid({ columns: columns() });
    const cell = g.cellAt(0, field);
    // jsdom has no layout — give the anchor cell a known rect so we can tell
    // "positioned against the anchor" apart from "never positioned (0,0)".
    cell.getBoundingClientRect = () => RECT;

    await g.user.dblClick(cell);

    const pop = document.querySelector<HTMLElement>("div.shadow-pop");
    expect(pop).not.toBeNull();
    expect(pop!.style.left).toBe(`${RECT.left}px`);
    expect(pop!.style.top).toBe(`${RECT.bottom + 2}px`);
  });
});
