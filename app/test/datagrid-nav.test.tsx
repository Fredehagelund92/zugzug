import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * DataGrid keyboard navigation tests.
 *
 * Architecture note: useGridCursor.onKeyDown() bails early when cursor is null
 * (`if (!cursor) return`). The cursor is initialized by pointer interaction
 * (onCellPointerDown calls setCursor). Keyboard navigation only works once a
 * cell has been pointer-selected — this matches real spreadsheet behavior.
 * Tests therefore click a cell first, then exercise keyboard movement.
 *
 * Required wrappers:
 *   - UndoStackProvider  (DataGrid calls useUndoStack() unconditionally)
 *
 * Required props: rows, columns, rowKey, onCommit (all required by DataGridProps).
 */

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: "a", name: "Acme" },
  { id: "b", name: "Bravo" },
];

// id is non-editable (excluded from navCols); name is editable.
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

/** Click a gridcell whose text content matches `text`. Returns the cell element. */
function clickCellByText(container: HTMLElement, text: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const cell = cells.find((c) => c.textContent?.includes(text));
  if (!cell) throw new Error(`No gridcell containing "${text}"`);
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  return cell;
}

describe("DataGrid keyboard navigation", () => {
  test("clicking a cell focuses it (aria-selected=true)", () => {
    const { container } = renderGrid();
    clickCellByText(container, "Acme");
    const focused = container.querySelector('[aria-selected="true"]');
    expect(focused).not.toBeNull();
    expect(focused?.textContent).toContain("Acme");
  });

  test("ArrowDown moves cursor to the next row", async () => {
    const { container } = renderGrid();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    // Step 1: click "Acme" cell to initialize cursor at row "a", field "name"
    clickCellByText(container, "Acme");
    const afterClick = container.querySelector('[aria-selected="true"]');
    expect(afterClick?.textContent).toContain("Acme");

    // Step 2: fire ArrowDown — cursor should advance to row "b", field "name"
    await act(async () => {
      fireEvent.keyDown(grid, { key: "ArrowDown", bubbles: true, cancelable: true });
    });

    const focused = container.querySelector('[aria-selected="true"]');
    expect(focused).not.toBeNull();
    expect(focused?.textContent ?? "").toContain("Bravo");
  });
});
