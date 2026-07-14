import { describe, test, expect } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: "a", name: "Acme" },
  { id: "b", name: "Bravo" },
];
const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

function clickCell(container: HTMLElement, text: string): HTMLElement {
  const cell = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]')).find((c) =>
    c.textContent?.includes(text),
  );
  if (!cell) throw new Error(`no cell ${text}`);
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  return cell;
}

describe("grid a11y", () => {
  test("aria-activedescendant tracks the focused cell and points at a real element id", () => {
    const { container } = renderGrid();
    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
    expect(grid.hasAttribute("aria-activedescendant")).toBe(false);

    const cell = clickCell(container, "Acme");
    const activeId = grid.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(cell.id).toBe(activeId);
    expect(document.getElementById(activeId!)).toBe(cell);

    clickCell(container, "Bravo");
    expect(grid.getAttribute("aria-activedescendant")).not.toBe(activeId);
  });

  test("Escape clears the cursor; the next Tab is not swallowed (keyboard exit)", () => {
    const { container } = renderGrid();
    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
    clickCell(container, "Acme");

    // With a cursor, Tab is intercepted (preventDefault → fireEvent returns false).
    expect(fireEvent.keyDown(grid, { key: "Tab" })).toBe(false);

    act(() => {
      fireEvent.keyDown(grid, { key: "Escape" });
    });
    expect(grid.hasAttribute("aria-activedescendant")).toBe(false);

    // Cursor cleared → the handler bails → Tab falls through to the browser.
    expect(fireEvent.keyDown(grid, { key: "Tab" })).toBe(true);
  });

  test("rowKey with spaces: cell id has no whitespace and getElementById resolves", () => {
    const spaceRows: Row[] = [{ id: "Coca Cola Zero", name: "Coca Cola Zero" }];
    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={spaceRows}
          columns={columns}
          rowKey={(r) => r.id}
          onCommit={async () => {}}
        />
      </UndoStackProvider>,
    );
    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
    const cell = clickCell(container, "Coca Cola Zero");
    const activeId = grid.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    // The id must not contain any whitespace
    expect(/\s/.test(activeId!)).toBe(false);
    // The cell element must be findable by the activeId
    expect(document.getElementById(activeId!)).toBe(cell);
  });

  test("Escape on multi-cell range collapses to anchor, keeps cursor; second Escape clears cursor", () => {
    const { container } = renderGrid();
    const grid = container.querySelector<HTMLElement>('[role="grid"]')!;

    // Click cell A (Acme)
    const cellA = clickCell(container, "Acme");

    // Shift-click cell B (Bravo) to create a 2-row range
    const cellB = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]')).find(
      (c) => c.textContent?.includes("Bravo"),
    )!;
    act(() => {
      fireEvent.pointerDown(cellB, {
        button: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent.pointerUp(cellB, { button: 0, bubbles: true });
    });

    // Range outline should be visible (multi-cell)
    expect(container.querySelector("[data-range-outline]")).not.toBeNull();

    // First Escape: range collapses to anchor, cursor stays
    act(() => {
      fireEvent.keyDown(grid, { key: "Escape" });
    });
    expect(container.querySelector("[data-range-outline]")).toBeNull();
    // aria-activedescendant should still point to something (cursor kept at anchor)
    expect(grid.hasAttribute("aria-activedescendant")).toBe(true);
    const anchorId = grid.getAttribute("aria-activedescendant")!;
    expect(anchorId).toBe(cellA.id);

    // Second Escape: cursor clears
    act(() => {
      fireEvent.keyDown(grid, { key: "Escape" });
    });
    expect(grid.hasAttribute("aria-activedescendant")).toBe(false);
  });
});
