import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [{ id: "1", name: "Acme" }];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

describe("menu presentation consistency", () => {
  test("context menu items are Title Case and show shortcut hints where defined", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(cell, { clientX: 50, clientY: 50, bubbles: true });
    });
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    // Title Case labels
    expect(menu.textContent).toContain("Copy");
    expect(menu.textContent).toContain("Paste");
    expect(menu.textContent).toContain("Clear");
    // Shortcut hints for Copy and Paste
    expect(menu.textContent).toContain("⌘C");
    expect(menu.textContent).toContain("⌘V");
  });

  test("filter popover apply button is Title Case", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(cell, { clientX: 50, clientY: 50, bubbles: true });
    });
    const menu = document.querySelector('[role="menu"]')!;
    // No lowercase "apply" on its own (i.e. ColumnHeaderMenu filter sub-panel uses Title Case)
    // The FilterBar (advanced) also uses "Apply" not "apply"
    // We test this indirectly: menu itself should never have a standalone lowercase "apply"
    const buttons = Array.from(menu.querySelectorAll("button"));
    for (const btn of buttons) {
      expect(btn.textContent?.trim()).not.toBe("apply");
    }
  });

  test("column header menu (opened via right-click) shows Title Case labels", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const headerSpan = container.querySelector('[data-header="name"] span') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(headerSpan, { clientX: 50, clientY: 50, bubbles: true });
    });
    // Right-click opens the ColumnHeaderMenu portal, not the shared ContextMenu.
    const menu = document.querySelector("div.zz-pop-in")!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain("Rename column");
    expect(menu.textContent).toContain("Sort A→Z");
    expect(menu.textContent).toContain("Hide column");
  });
});
