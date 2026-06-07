import { test, expect, describe } from "vitest";
import { render } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef, ConditionalRule } from "../src/components/datagrid/types";

interface Row { id: string; status: string }
const rows: Row[] = [
  { id: "1", status: "ok" },
  { id: "2", status: "conflict" },
];
const rule: ConditionalRule = {
  id: "r1",
  field: "status",
  trigger: { kind: "equals", value: "conflict" },
  style: { rowStripe: "rose" },
};
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "status", label: "Status", config: { type: "text" }, rules: [rule] },
];

describe("conditional formatting", () => {
  test("matching row gets the row stripe element", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const stripes = container.querySelectorAll('[data-row-stripe]');
    expect(stripes.length).toBe(1);
    expect((stripes[0] as HTMLElement).dataset.rowStripe).toBe("rose");
  });
});
