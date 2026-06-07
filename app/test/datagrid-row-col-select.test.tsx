import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string; tag: string }
const rows: Row[] = [
  { id: "1", name: "Acme",  tag: "x" },
  { id: "2", name: "Bravo", tag: "y" },
];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
  { field: "tag", label: "Tag", config: { type: "text" } },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id}
                onCommit={async () => {}} showRowNumbers />
    </UndoStackProvider>,
  );
}

describe("row# / column-header click selection", () => {
  test("click row-number cell selects whole row", () => {
    const { container } = renderGrid();
    const rowNumCell = Array.from(container.querySelectorAll<HTMLElement>('[data-row-num]'))
      .find((el) => el.dataset.rowNum === "1")!;
    act(() => {
      fireEvent.pointerDown(rowNumCell, { button: 0, bubbles: true });
      fireEvent.pointerUp(rowNumCell, { button: 0, bubbles: true });
    });
    const acme = container.querySelector('[data-cell="1::name"]');
    const xCell = container.querySelector('[data-cell="1::tag"]');
    expect(acme?.className).toMatch(/bg-accent\/10|ring-accent/);
    expect(xCell?.className).toMatch(/bg-accent\/10|ring-accent/);
  });

  test("click column header label selects whole column", () => {
    const { container } = renderGrid();
    const headers = container.querySelectorAll<HTMLElement>('[data-header]');
    const nameHeader = Array.from(headers).find((h) => h.dataset.header === "name")!;
    const label = nameHeader.querySelector("span") as HTMLElement;
    act(() => {
      fireEvent.pointerDown(label, { button: 0, bubbles: true });
      fireEvent.pointerUp(label, { button: 0, bubbles: true });
    });
    const r1 = container.querySelector('[data-cell="1::name"]');
    const r2 = container.querySelector('[data-cell="2::name"]');
    expect(r1?.className).toMatch(/bg-accent\/10|ring-accent/);
    expect(r2?.className).toMatch(/bg-accent\/10|ring-accent/);
  });
});
