import { describe, test, expect, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  amount: number | null;
}
const columns: ColumnDef<Row>[] = [
  { field: "amount", label: "Amount", config: { type: "number" }, editable: true },
];

function setup(onCommit: (rk: string, field: string, value: unknown) => Promise<void>) {
  const rows: Row[] = [{ id: "r1", amount: 42 }];
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={onCommit} />
    </UndoStackProvider>,
  );
}

function openEditor(container: HTMLElement): HTMLInputElement {
  const cell = container.querySelector<HTMLElement>('[role="gridcell"]');
  if (!cell) throw new Error("no gridcell");
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  act(() => {
    fireEvent.doubleClick(cell);
  });
  const input = cell.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("editor input did not open");
  return input;
}

// Commit the editor by blurring the input (mirrors how NumberCell.onBlur → commitNow works).
// fireEvent.blur reliably flushes the React stopEdit() re-render in jsdom; keyDown does not.
async function commitEditor(input: HTMLInputElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  });
  await act(async () => {});
}

describe("NumberCell editor validation", () => {
  test("invalid text cancels the edit — no commit, value preserved", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const input = openEditor(container);
    await commitEditor(input, "abc");
    expect(onCommit).not.toHaveBeenCalled();
    // After cancel the editor unmounts and the renderer shows the original value
    expect(container.textContent).toContain("42");
  });

  test("valid number commits", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const input = openEditor(container);
    await commitEditor(input, "7");
    expect(onCommit).toHaveBeenCalledWith("r1", "amount", 7);
  });

  test("clearing to empty commits null (clearing a value is legitimate)", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const input = openEditor(container);
    await commitEditor(input, "");
    expect(onCommit).toHaveBeenCalledWith("r1", "amount", null);
  });
});
