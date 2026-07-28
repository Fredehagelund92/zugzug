import { describe, test, expect, vi } from "vitest";
import { StrictMode } from "react";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  stars: string | null;
}
const columns: ColumnDef<Row>[] = [
  { field: "stars", label: "Stars", config: { type: "rating", ratingMax: 5 }, editable: true },
];

function setup(onCommit: (rk: string, field: string, value: unknown) => Promise<void>) {
  const rows: Row[] = [{ id: "r1", stars: "2" }];
  return render(
    <StrictMode>
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={onCommit} />
      </UndoStackProvider>
    </StrictMode>,
  );
}

function cell(container: HTMLElement): HTMLElement {
  const c = container.querySelector<HTMLElement>('[role="gridcell"]');
  if (!c) throw new Error("no gridcell");
  return c;
}

describe("RatingCell editor", () => {
  // Type-to-edit seeds `initial`, which the editor used to commit from a mount
  // effect — double-invoked under StrictMode, same shape as the boolean bug (#198).
  test("type-to-edit with a digit commits exactly once under StrictMode", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const c = cell(container);
    await act(async () => {
      fireEvent.pointerDown(c, { button: 0, bubbles: true, cancelable: true });
      fireEvent.pointerUp(c, { button: 0, bubbles: true });
    });
    await act(async () => {
      fireEvent.keyDown(c, { key: "4" });
    });
    await act(async () => {});
    expect(onCommit.mock.calls).toEqual([["r1", "stars", 4]]);
  });

  test("clicking a star commits exactly once", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const c = cell(container);
    await act(async () => {
      fireEvent.pointerDown(c, { button: 0, bubbles: true, cancelable: true });
      fireEvent.pointerUp(c, { button: 0, bubbles: true });
    });
    await act(async () => {
      fireEvent.doubleClick(c);
    });
    await act(async () => {});
    const star = c.querySelector<HTMLElement>('[aria-label="4 stars"]');
    if (!star) throw new Error("rating editor did not open");
    await act(async () => {
      fireEvent.click(star);
    });
    await act(async () => {});
    expect(onCommit.mock.calls).toEqual([["r1", "stars", 4]]);
  });
});
