import { describe, test, expect } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}

const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function setup() {
  const rows: Row[] = [{ id: "1", name: "First Record" }];
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

function clickCell(container: HTMLElement, text: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const cell = cells.find((c) => c.textContent?.includes(text));
  if (!cell) throw new Error(`No gridcell containing "${text}"`);
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  return cell;
}

describe("type-to-edit", () => {
  test("typing on a focused cell replaces content with the typed char", () => {
    const { container } = setup();
    const cell = clickCell(container, "First Record");
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    act(() => {
      fireEvent.keyDown(grid, { key: "R", bubbles: true });
    });

    const input = cell.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("R");
  });
});

describe("column rename select-all", () => {
  test("rename input opens with text fully selected", () => {
    const { container } = setup();

    // Open the column header menu via the column header button
    const headerMenu = container.querySelector<HTMLElement>('[data-testid="col-menu-btn"]');
    // If no test id, find the ⋯ button in the column header
    const colHeader = container.querySelector<HTMLElement>('[role="columnheader"]');
    if (!colHeader) throw new Error("No column header found");

    // Find the menu trigger button inside the column header
    const menuBtn = colHeader.querySelector<HTMLElement>("button");
    if (!menuBtn) throw new Error("No menu button in column header");

    act(() => {
      fireEvent.click(menuBtn);
    });

    // Find "Rename column" option and click it
    const renameBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rename column"),
    );
    if (!renameBtn) throw new Error("No 'Rename column' button found");

    act(() => {
      fireEvent.click(renameBtn);
    });

    // The rename input should now be present with value "Name" (the column label)
    // Find it by looking in document since ColumnHeaderMenu uses createPortal
    const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    const input = allInputs.find((el) => el.value === "Name");
    if (!input) throw new Error("Rename input not found");

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});
