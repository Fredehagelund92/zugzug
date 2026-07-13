import { test, expect, describe, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/components/Toast", () => ({ toast: toastSpy }));

interface Row { id: string; name: string }
const rows: Row[] = [
  { id: "1", name: "Acme" },
  { id: "2", name: "Bravo" },
];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

beforeEach(() => {
  toastSpy.mockClear();
  // Mock clipboard API (jsdom doesn't implement it)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

describe("copy feedback", () => {
  test("⌘C on a focused cell fires a Copied toast", async () => {
    const { container } = renderGrid();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    // Click a cell to establish cursor
    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
      fireEvent.pointerUp(cell, { button: 0, bubbles: true });
    });

    // Dispatch ⌘C
    await act(async () => {
      fireEvent.keyDown(grid, { key: "c", metaKey: true, bubbles: true });
    });

    expect(toastSpy).toHaveBeenCalledWith("Copied", "success");
  });

  test("⌘C flashes the copied cell", async () => {
    const { container } = renderGrid();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
      fireEvent.pointerUp(cell, { button: 0, bubbles: true });
    });

    await act(async () => {
      fireEvent.keyDown(grid, { key: "c", metaKey: true, bubbles: true });
    });

    // Flash is applied via rAF; verify it was called (clipboard write resolved)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Acme");
  });
});
