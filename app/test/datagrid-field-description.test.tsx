import { test, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [{ id: "1", name: "Acme" }];
const columns: ColumnDef<Row>[] = [
  {
    field: "name",
    label: "Name",
    description: "The display name of the partner.",
    config: { type: "text" },
  },
];

test("header with description shows an i icon on hover, with tooltip text", () => {
  const { container } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  const header = container.querySelector('[data-header="name"]') as HTMLElement;
  act(() => {
    fireEvent.mouseEnter(header);
  });
  const icon = header.querySelector("[data-field-info]") as HTMLElement;
  expect(icon).not.toBeNull();
  act(() => {
    fireEvent.mouseEnter(icon);
  });
  expect(icon.getAttribute("title")).toBe("The display name of the partner.");
});

test("header without description shows NO i icon", () => {
  const cols2: ColumnDef<Row>[] = [{ field: "name", label: "Name", config: { type: "text" } }];
  const { container } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={cols2} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  const header = container.querySelector('[data-header="name"]') as HTMLElement;
  act(() => {
    fireEvent.mouseEnter(header);
  });
  expect(header.querySelector("[data-field-info]")).toBeNull();
});
