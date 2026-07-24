import { describe, test, expect, vi } from "vitest";
import { render, act, fireEvent, screen, waitFor } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef, FilterSet } from "../src/components/datagrid/types";

/**
 * initialFilterSet + onFilterSetChange wiring.
 * (a) initialFilterSet applies on mount — grid shows fewer rows with NO onFilterSetChange fired.
 * (b) A user filter change (context-menu "Filter to") calls onFilterSetChange with the new set.
 * (c) Clearing calls onFilterSetChange with null.
 */

interface Row {
  id: string;
  region: string;
}

const rows: Row[] = [
  { id: "1", region: "EU" },
  { id: "2", region: "US" },
  { id: "3", region: "EU" },
];

const columns: ColumnDef<Row>[] = [{ field: "region", label: "Region", config: { type: "text" } }];

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

function dataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-row]"));
}

describe("initialFilterSet + onFilterSetChange", () => {
  test("(a) initialFilterSet applies on mount without firing onFilterSetChange", () => {
    const onFilterSetChange = vi.fn();
    const initialFilterSet: FilterSet = {
      conjunction: "and",
      conditions: [{ id: "c1", field: "region", operator: "equals", value: "EU" }],
    };

    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          initialFilterSet={initialFilterSet}
          onFilterSetChange={onFilterSetChange}
        />
      </UndoStackProvider>,
    );

    // Two EU rows visible, US row filtered out
    const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
    const regionCells = cells.filter((c) => ["EU", "US"].includes(c.textContent?.trim() ?? ""));
    const euCells = regionCells.filter((c) => c.textContent?.trim() === "EU");
    const usCells = regionCells.filter((c) => c.textContent?.trim() === "US");
    expect(euCells.length).toBe(2);
    expect(usCells.length).toBe(0);

    // Callback must NOT have been called on mount
    expect(onFilterSetChange).not.toHaveBeenCalled();
  });

  test("(b) user filter change via context menu fires onFilterSetChange", () => {
    const onFilterSetChange = vi.fn();

    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          onFilterSetChange={onFilterSetChange}
        />
      </UndoStackProvider>,
    );

    // Right-click the EU cell and pick "Filter to"
    act(() => {
      fireEvent.contextMenu(cellByText(container, "EU"));
    });
    const filterItem = getMenuItemByText(/^Filter to "/);
    act(() => {
      fireEvent.click(filterItem);
    });

    expect(onFilterSetChange).toHaveBeenCalledOnce();
    const called = onFilterSetChange.mock.calls[0]![0] as FilterSet;
    expect(called.conditions).toHaveLength(1);
    expect(called.conditions[0]!.operator).toBe("equals");
    expect(called.conditions[0]!.value).toBe("EU");
  });

  test("(c) clearing filters fires onFilterSetChange with null", async () => {
    const onFilterSetChange = vi.fn();

    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          onFilterSetChange={onFilterSetChange}
        />
      </UndoStackProvider>,
    );

    // Apply a filter first
    act(() => {
      fireEvent.contextMenu(cellByText(container, "US"));
    });
    act(() => {
      fireEvent.click(getMenuItemByText(/^Filter to "/));
    });
    onFilterSetChange.mockClear();

    // Edit the value to match nothing so the "Clear filters" button appears
    const pill = Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) =>
      /us/i.test(b.textContent ?? ""),
    );
    expect(pill).toBeDefined();
    act(() => {
      fireEvent.click(pill!);
    });

    const valueInput = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.value === "US",
    );
    expect(valueInput).toBeDefined();
    act(() => {
      fireEvent.change(valueInput!, { target: { value: "zzz-no-match" } });
    });
    act(() => {
      fireEvent.keyDown(valueInput!, { key: "Enter" });
    });

    // "Clear filters" button should appear
    const clearBtn = await screen.findByRole("button", { name: /clear filters/i });
    act(() => {
      fireEvent.click(clearBtn);
    });

    // Last call should be with null
    const lastCall = onFilterSetChange.mock.calls.at(-1)![0];
    expect(lastCall).toBeNull();
  });

  test("(d) column-header ⋯ → Filter… path fires onFilterSetChange", async () => {
    // Regression: DataGrid previously passed raw setFilterSet to DataGridHeader
    // so the column-header quick-filter bypassed updateFilterSet and never
    // called onFilterSetChange. This test drives the full UI path to verify the fix.
    const onFilterSetChange = vi.fn();

    render(
      <UndoStackProvider>
        <DataGrid
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          onFilterSetChange={onFilterSetChange}
        />
      </UndoStackProvider>,
    );

    // Open the column-header ⋯ menu for the Region column
    const menuButton = await screen.findByRole("button", { name: /column menu/i });
    act(() => {
      fireEvent.click(menuButton);
    });

    // Click the "Filter…" menu item
    const filterMenuItem = await screen.findByRole("button", { name: /filter…/i });
    act(() => {
      fireEvent.click(filterMenuItem);
    });

    // Type a filter value and press Enter to apply
    const filterInput = await screen.findByPlaceholderText(/contains…/i);
    act(() => {
      fireEvent.change(filterInput, { target: { value: "EU" } });
      fireEvent.keyDown(filterInput, { key: "Enter" });
    });

    // onFilterSetChange must fire — previously it was never called from this path
    await waitFor(() => {
      expect(onFilterSetChange).toHaveBeenCalledOnce();
    });
    const called = onFilterSetChange.mock.calls[0]![0] as FilterSet;
    expect(called.conditions).toHaveLength(1);
    expect(called.conditions[0]!.field).toBe("region");
    expect(called.conditions[0]!.operator).toBe("contains");
    expect(called.conditions[0]!.value).toBe("EU");
  });
});
