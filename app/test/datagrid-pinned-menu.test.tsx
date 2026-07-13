/**
 * Task 6: pinned-left columns must expose the header menu button so users can
 * sort/filter the primary "Record" column from the grid.
 *
 * Required wrappers:
 *   - UndoStackProvider  (DataGrid calls useUndoStack() unconditionally)
 */
import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [{ id: "r1", name: "Alice" }];

const columns: ColumnDef<Row>[] = [
  { field: "id", label: "Record", config: { type: "text" }, pinnedLeft: true },
  { field: "name", label: "Name", config: { type: "text" } },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

test("a pinned-left column shows the header menu button", () => {
  const { container } = renderGrid();
  const pinnedHeader = container.querySelector('[data-header="id"]')!;
  expect(pinnedHeader).not.toBeNull();
  expect(pinnedHeader.querySelector('[aria-label="Column menu"]')).not.toBeNull();
});

test("a non-pinned column also shows the header menu button (unchanged)", () => {
  const { container } = renderGrid();
  const normalHeader = container.querySelector('[data-header="name"]')!;
  expect(normalHeader).not.toBeNull();
  expect(normalHeader.querySelector('[aria-label="Column menu"]')).not.toBeNull();
});
