import { test, expect, describe, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string }
const rows: Row[] = [{ id: "1", name: "Acme" }, { id: "2", name: "Bravo" }];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

describe("right-click context menu", () => {
  test("right-click on a cell opens menu with cell items", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(cell, { clientX: 50, clientY: 50, bubbles: true });
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Copy");
    expect(menu?.textContent).toContain("Filter to");
  });

  test("right-click on a column header opens the ColumnHeaderMenu (same as the ⋯ button)", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const headerLabel = container.querySelector('[data-header="name"] span') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(headerLabel, { clientX: 50, clientY: 50, bubbles: true });
    });
    // Right-click no longer opens the shared ContextMenu for headers — it opens
    // the same ColumnHeaderMenu the ⋯ button opens.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const menu = document.querySelector("div.zz-pop-in");
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Rename column");
    expect(menu?.textContent).toContain("Sort A→Z");
  });

  test("row-number context menu has no Duplicate item", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} showRowNumbers />
      </UndoStackProvider>,
    );
    const rownum = container.querySelector('[data-row-num="1"]') as HTMLElement;
    act(() => { fireEvent.contextMenu(rownum, { clientX: 30, clientY: 30, bubbles: true }); });
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Duplicate");
  });

  test("Escape closes the menu", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => { fireEvent.contextMenu(cell, { clientX: 50, clientY: 50, bubbles: true }); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
