import { describe, test, expect } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * Filter-aware empty state: when the FilterBar excludes every row the grid
 * must say records exist but are filtered out (with a one-click clear), not
 * render the host's "table is empty" node. Filter is applied through the
 * real UI: right-click → "Filter to value", then edit the FilterBar's value
 * input to something that matches nothing.
 */

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: "a", name: "Acme" },
  { id: "b", name: "Bravo" },
];
const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        onCommit={async () => {}}
        empty={<div data-testid="host-empty">no records yet</div>}
      />
    </UndoStackProvider>,
  );
}

function cellByText(container: HTMLElement, text: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const cell = cells.find((c) => c.textContent?.includes(text));
  if (!cell) throw new Error(`No gridcell containing "${text}"`);
  return cell;
}

function getMenuItemByText(text: RegExp): HTMLElement {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const item = items.find((el) => text.test(el.textContent ?? ""));
  if (!item) throw new Error(`No menu item matching ${text}`);
  return item;
}

describe("filter-aware empty state", () => {
  test("no matches shows the filtered message + clear; host empty stays for truly empty tables", async () => {
    const { container } = renderGrid();

    // Apply a real filter via the context menu on the "Acme" cell.
    act(() => {
      fireEvent.contextMenu(cellByText(container, "Acme"));
    });
    // The context menu renders into document.body via a portal.
    const filterItem = getMenuItemByText(/^Filter to "/);
    act(() => {
      fireEvent.click(filterItem);
    });

    // FilterBar is up, filtering to "Acme" — Bravo is out, Acme still visible.
    expect(cellByText(container, "Acme")).toBeInTheDocument();

    // Click the filter pill to open the condition editor popover.
    const pill = Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) =>
      /acme/i.test(b.textContent ?? ""),
    );
    expect(pill).toBeDefined();
    act(() => {
      fireEvent.click(pill!);
    });

    // Edit the FilterBar value input to something that matches nothing.
    // The editor popover renders into document.body via a portal.
    const valueInput = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.value === "Acme",
    );
    expect(valueInput).toBeDefined();
    act(() => {
      fireEvent.change(valueInput!, { target: { value: "zzz-no-match" } });
    });
    // Save the edited condition.
    act(() => {
      fireEvent.keyDown(valueInput!, { key: "Enter" });
    });

    // Filtered-empty state, NOT the host empty node.
    expect(await screen.findByText(/no records match/i)).toBeInTheDocument();
    expect(screen.queryByTestId("host-empty")).not.toBeInTheDocument();

    // One-click clear restores the rows.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    });
    expect(cellByText(container, "Bravo")).toBeInTheDocument();
  });

  test("a truly empty table still renders the host empty node", () => {
    render(
      <UndoStackProvider>
        <DataGrid
          rows={[]}
          columns={columns}
          rowKey={(r: Row) => r.id}
          onCommit={async () => {}}
          empty={<div data-testid="host-empty">no records yet</div>}
        />
      </UndoStackProvider>,
    );
    expect(screen.getByTestId("host-empty")).toBeInTheDocument();
  });
});
