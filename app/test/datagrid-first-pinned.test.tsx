/**
 * Characterization test: only the leftmost pinned-left column carries the
 * first-pinned marker (sticky positioning + z-index). Used to pin behavior
 * before and after the O(cols²) → O(1) first-pinned refactor (Task 4B).
 *
 * Required wrappers:
 *   - UndoStackProvider  (DataGrid calls useUndoStack() unconditionally)
 */
import { test, expect, describe } from "vitest";
import { render } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  key: string;
  name: string;
  rank: string;
}

const rows: Row[] = [{ id: "r1", key: "K1", name: "Alice", rank: "A" }];

// Two pinned-left columns first, then two normal columns.
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "Record", config: { type: "text" }, pinnedLeft: true },
  { field: "key", label: "Key", config: { type: "text" }, pinnedLeft: true },
  { field: "name", label: "Name", config: { type: "text" } },
  { field: "rank", label: "Rank", config: { type: "text" } },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

describe("first-pinned column marker", () => {
  test("only the leftmost pinned column gets sticky positioning", () => {
    const { container } = renderGrid();
    const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
    expect(cells.length).toBeGreaterThan(0);

    // Find cells for each field by their data-field attribute.
    const recordCell = cells.find((c) => c.getAttribute("data-field") === "id");
    const keyCell = cells.find((c) => c.getAttribute("data-field") === "key");
    const nameCell = cells.find((c) => c.getAttribute("data-field") === "name");
    const rankCell = cells.find((c) => c.getAttribute("data-field") === "rank");

    expect(recordCell).toBeTruthy();
    expect(keyCell).toBeTruthy();
    expect(nameCell).toBeTruthy();
    expect(rankCell).toBeTruthy();

    // The first pinned column (Record/id) must be sticky.
    expect(recordCell!.className).toContain("sticky");

    // The second pinned column (Key) must NOT be sticky — only the first is flagged.
    expect(keyCell!.className).not.toContain("sticky");

    // Normal columns are never sticky.
    expect(nameCell!.className).not.toContain("sticky");
    expect(rankCell!.className).not.toContain("sticky");
  });

  test("with only one pinned column it still gets the sticky marker", () => {
    const singlePinColumns: ColumnDef<Row>[] = [
      { field: "id", label: "Record", config: { type: "text" }, pinnedLeft: true },
      { field: "name", label: "Name", config: { type: "text" } },
    ];
    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={singlePinColumns}
          rowKey={(r) => r.id}
          onCommit={async () => {}}
        />
      </UndoStackProvider>,
    );
    const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
    const recordCell = cells.find((c) => c.getAttribute("data-field") === "id");
    const nameCell = cells.find((c) => c.getAttribute("data-field") === "name");

    expect(recordCell!.className).toContain("sticky");
    expect(nameCell!.className).not.toContain("sticky");
  });

  test("with no pinned columns no cell gets the sticky marker", () => {
    const noPinColumns: ColumnDef<Row>[] = [
      { field: "id", label: "Record", config: { type: "text" } },
      { field: "name", label: "Name", config: { type: "text" } },
    ];
    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={noPinColumns}
          rowKey={(r) => r.id}
          onCommit={async () => {}}
        />
      </UndoStackProvider>,
    );
    const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
    cells.forEach((cell) => {
      expect(cell.className).not.toContain("sticky");
    });
  });
});
