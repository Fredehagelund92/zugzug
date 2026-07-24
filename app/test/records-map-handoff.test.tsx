/**
 * Task 7: "Map values to this record" context-menu item.
 * Right-clicking a record's row number should show the item when
 * onMapValuesToRecord is provided, and clicking it should call the callback
 * with that record's key.
 */
import { test, expect, describe, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [
  { id: "rec-alpha", name: "Alpha" },
  { id: "rec-beta", name: "Beta" },
];

const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

describe("Map values to this record — context menu handoff", () => {
  test("row-num menu shows 'Map values to this record' when prop provided", () => {
    const spy = vi.fn();
    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          showRowNumbers
          onMapValuesToRecord={spy}
        />
      </UndoStackProvider>,
    );

    const rownum = container.querySelector('[data-row-num="rec-alpha"]') as HTMLElement;
    expect(rownum).not.toBeNull();
    act(() => {
      fireEvent.contextMenu(rownum, { clientX: 30, clientY: 30, bubbles: true });
    });

    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Map values to this record");
  });

  test("clicking the item calls onMapValuesToRecord with the record key", () => {
    const spy = vi.fn();
    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          showRowNumbers
          onMapValuesToRecord={spy}
        />
      </UndoStackProvider>,
    );

    const rownum = container.querySelector('[data-row-num="rec-alpha"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(rownum, { clientX: 30, clientY: 30, bubbles: true });
    });

    const menuItems = document.querySelectorAll('[role="menuitem"]');
    const handoffItem = Array.from(menuItems).find((el) =>
      el.textContent?.includes("Map values to this record"),
    ) as HTMLElement | undefined;

    expect(handoffItem).toBeDefined();
    act(() => {
      fireEvent.click(handoffItem!);
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith("rec-alpha");
  });

  test("item is absent when onMapValuesToRecord is not provided", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} showRowNumbers />
      </UndoStackProvider>,
    );

    const rownum = container.querySelector('[data-row-num="rec-alpha"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(rownum, { clientX: 30, clientY: 30, bubbles: true });
    });

    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).not.toContain("Map values to this record");
  });
});
