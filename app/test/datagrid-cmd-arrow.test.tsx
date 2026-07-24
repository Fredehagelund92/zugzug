import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [
  { id: "1", name: "Acme" },
  { id: "2", name: "Bravo" },
  { id: "3", name: "Charlie" },
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
  test("⌘↓ jumps to last filled of run (edge-jump, not one-step)", () => {
    const { container } = renderGrid();
    clickCellByText(container, "Acme");
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    act(() => {
      fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    });
    // With [Acme, Bravo, Charlie, Delta, Echo] (all filled), ⌘↓ from Acme
    // should jump to Echo (last of run) — not Bravo (one-step).
    const focused = container.querySelector('[aria-selected="true"]');
    expect(focused?.textContent).toContain("Echo");
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
    const echoCell = Array.from(cells).find((c) => c.textContent?.trim() === "Echo");
    // Echo gets the focus ring (edge-jump target); Acme gets the range wash (anchor)
    expect(acmeCell?.className).toContain("bg-accent/10");
    expect(echoCell?.getAttribute("aria-selected")).toBe("true");
  });
});
