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
});
