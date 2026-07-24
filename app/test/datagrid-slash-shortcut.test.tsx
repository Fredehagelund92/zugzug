import { test, expect } from "vitest";
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
];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

test("pressing '/' on a focused cell starts editing with '/', not a swallowed shortcut", () => {
  const { container } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  act(() => {
    fireEvent.keyDown(cell.closest('[role="grid"]')!, { key: "/" });
  });
  const input = cell.querySelector("input");
  expect(input?.value).toBe("/");
});
