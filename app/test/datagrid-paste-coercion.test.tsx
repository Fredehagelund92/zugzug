import { test, expect, describe, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

vi.mock("../src/components/Toast", () => ({ toast: vi.fn() }));

interface Row {
  id: string;
  score: number | null;
  signed: string | null;
}
const rows: Row[] = [{ id: "1", score: 42, signed: "2026-01-31" }];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "score", label: "Score", config: { type: "number" } },
  { field: "signed", label: "Signed", config: { type: "date" } },
];

const commit = vi.fn(async () => {});

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={commit} />
    </UndoStackProvider>,
  );
}

/** Focus one cell, put `text` on the clipboard, then ⌘V. */
async function pasteInto(container: HTMLElement, cell: string, text: string) {
  Object.defineProperty(navigator, "clipboard", {
    value: { readText: vi.fn().mockResolvedValue(text), writeText: vi.fn() },
    writable: true,
    configurable: true,
  });
  const target = container.querySelector(`[data-cell="${cell}"]`) as HTMLElement;
  act(() => {
    fireEvent.pointerDown(target, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(target, { button: 0, bubbles: true });
  });
  const grid = container.querySelector('[role="grid"]') as HTMLElement;
  await act(async () => {
    fireEvent.keyDown(grid, { key: "v", metaKey: true, bubbles: true });
  });
}

beforeEach(() => commit.mockClear());

describe("paste coercion", () => {
  test("unreadable text is skipped, not written as an empty number", async () => {
    const { container } = renderGrid();
    await pasteInto(container, "1::score", "hello");
    expect(commit).not.toHaveBeenCalled();
  });

  test("unreadable text is skipped in a date column too", async () => {
    const { container } = renderGrid();
    await pasteInto(container, "1::signed", "hello");
    expect(commit).not.toHaveBeenCalled();
  });

  test("an empty source cell still clears the value", async () => {
    const { container } = renderGrid();
    // Two columns wide: the first cell is blank, the second is a real date.
    await pasteInto(container, "1::score", "\t2026-02-01");
    expect(commit).toHaveBeenCalledWith("1", "score", null);
    expect(commit).toHaveBeenCalledWith("1", "signed", "2026-02-01");
  });

  test("a readable number is written through", async () => {
    const { container } = renderGrid();
    await pasteInto(container, "1::score", "7");
    expect(commit).toHaveBeenCalledWith("1", "score", 7);
  });
});
