import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string }

const rows: Row[] = [
  { id: "1", name: "Acme" },
  { id: "2", name: "Bravo" },
  { id: "3", name: "" },
  { id: "4", name: "Delta" },
  { id: "5", name: "Echo" },
];
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

function clickCellByText(container: HTMLElement, text: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const cell = cells.find((c) => c.textContent?.trim() === text);
  if (!cell) throw new Error(`No gridcell with text "${text}"`);
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  return cell;
}

describe("DataGrid ⌘+Arrow data-edge jump", () => {
  test("⌘↓ stops at last filled before empty stretch", () => {
    const { container } = renderGrid();
    clickCellByText(container, "Acme");
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    });
    // With [Acme, Bravo, "", Delta, Echo] and current rule "filled→filled = last of run",
    // cursor on Acme (filled) sees Bravo (filled) below → jumps to last filled of run (Bravo).
    const focused = container.querySelector('[aria-selected="true"]');
    expect(focused?.textContent).toContain("Bravo");
  });

  test("⌘⇧↓ extends the range to the data-edge target", () => {
    const { container } = renderGrid();
    clickCellByText(container, "Acme");
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true, shiftKey: true });
    });
    const cells = container.querySelectorAll<HTMLElement>('[role="gridcell"]');
    const acmeCell = Array.from(cells).find((c) => c.textContent?.trim() === "Acme");
    const bravoCell = Array.from(cells).find((c) => c.textContent?.trim() === "Bravo");
    // Bravo gets the focus ring; Acme gets the range wash
    expect(acmeCell?.className).toContain("bg-accent/10");
    expect(bravoCell?.getAttribute("aria-selected")).toBe("true");
  });
});
