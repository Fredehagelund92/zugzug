import { test, expect } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; n: number }
const rows: Row[] = [{ id: "1", n: 10 }, { id: "2", n: 20 }, { id: "3", n: 30 }];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "n", label: "N", config: { type: "number" } },
];

test("status bar shows aggregates when range > 1 cell", () => {
  const { container } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  const cell10 = container.querySelector('[data-cell="1::n"]') as HTMLElement;
  const cell30 = container.querySelector('[data-cell="3::n"]') as HTMLElement;
  act(() => {
    fireEvent.pointerDown(cell10, { button: 0, bubbles: true });
    fireEvent.pointerUp(cell10, { button: 0, bubbles: true });
  });
  act(() => {
    fireEvent.pointerDown(cell30, { button: 0, shiftKey: true, bubbles: true });
    fireEvent.pointerUp(cell30, { button: 0, bubbles: true });
  });
  const bar = container.querySelector('[role="status"]');
  expect(bar).not.toBeNull();
  expect(bar?.textContent).toContain("Count");
  expect(bar?.textContent).toContain("Sum");
  expect(bar?.textContent).toContain("60");
});
