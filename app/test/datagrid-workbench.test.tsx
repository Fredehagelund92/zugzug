import { test, expect, describe, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid, UndoStackProvider } from "../src/components/datagrid";
import type { ColumnDef, DataGridProps } from "../src/components/datagrid/types";

/**
 * DataGrid workbench-surface capabilities:
 *   - onCellKeyDown: host hook for single-key actions (A/S/R/N…). Fires only
 *     for keydowns the grid did NOT handle, never while editing. ctx.startEdit
 *     opens the editor on the cursor cell (the M-key affordance).
 *   - renderRowDetail: full-width detail row beneath a data row (provenance
 *     drill). The host owns which row is open.
 *
 * Test mechanics mirror datagrid-nav.test.tsx: the cursor is initialized by
 * pointer interaction, so tests click a cell before firing keys.
 */

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid(extra?: Partial<DataGridProps<Row>>) {
  return render(
    <UndoStackProvider>
      <DataGrid
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        onCommit={async () => {}}
        {...extra}
      />
    </UndoStackProvider>,
  );
}

/** Click a gridcell whose text content matches `text`. Returns the cell element. */
function clickCellByText(container: HTMLElement, text: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const cell = cells.find((c) => c.textContent?.includes(text));
  if (!cell) throw new Error(`No gridcell containing "${text}"`);
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  return cell;
}

describe("DataGrid onCellKeyDown", () => {
  test("fires for unhandled keys with the cursor position", async () => {
    const onCellKeyDown = vi.fn();
    const { container } = renderGrid({ onCellKeyDown });
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    clickCellByText(container, "Alpha");
    await act(async () => {
      fireEvent.keyDown(grid, { key: "s", bubbles: true, cancelable: true });
    });

    expect(onCellKeyDown).toHaveBeenCalledTimes(1);
    const [event, ctx] = onCellKeyDown.mock.calls[0]!;
    expect(event.key).toBe("s");
    expect(ctx.cursor).toEqual({ rowKey: "a", field: "name" });
  });

  test("does NOT fire for keys the grid handles (ArrowDown)", async () => {
    const onCellKeyDown = vi.fn();
    const { container } = renderGrid({ onCellKeyDown });
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    clickCellByText(container, "Alpha");
    await act(async () => {
      fireEvent.keyDown(grid, { key: "ArrowDown", bubbles: true, cancelable: true });
    });

    expect(onCellKeyDown).not.toHaveBeenCalled();
  });

  test("ctx.startEdit() opens the editor on the cursor cell", async () => {
    const { container } = renderGrid({
      onCellKeyDown: (e, ctx) => {
        if (e.key === "m") {
          e.preventDefault();
          ctx.startEdit();
        }
      },
    });
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    clickCellByText(container, "Alpha");
    expect(container.querySelector("input")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(grid, { key: "m", bubbles: true, cancelable: true });
    });

    expect(container.querySelector("input")).not.toBeNull();
  });
});

describe("DataGrid cursor survives row removal", () => {
  test("cursor moves to the row now at the same index when its row vanishes", async () => {
    const rows3: Row[] = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
      { id: "c", name: "Gamma" },
    ];
    const onCellKeyDown = vi.fn();
    const { container, rerender } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows3}
          columns={columns}
          rowKey={(r) => r.id}
          onCommit={async () => {}}
          onCellKeyDown={onCellKeyDown}
        />
      </UndoStackProvider>,
    );
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    clickCellByText(container, "Beta");

    await act(async () => {
      rerender(
        <UndoStackProvider>
          <DataGrid
            rows={[rows3[0]!, rows3[2]!]}
            columns={columns}
            rowKey={(r) => r.id}
            onCommit={async () => {}}
            onCellKeyDown={onCellKeyDown}
          />
        </UndoStackProvider>,
      );
    });

    await act(async () => {
      fireEvent.keyDown(grid, { key: "s", bubbles: true, cancelable: true });
    });

    const lastCall = onCellKeyDown.mock.calls.at(-1)!;
    expect(lastCall[1].cursor).toEqual({ rowKey: "c", field: "name" });
  });

  test("cursor clears when rows becomes empty", async () => {
    const rows1: Row[] = [{ id: "a", name: "Alpha" }];
    const onCellKeyDown = vi.fn();
    const { container, rerender } = render(
      <UndoStackProvider>
        <DataGrid
          rows={rows1}
          columns={columns}
          rowKey={(r) => r.id}
          onCommit={async () => {}}
          onCellKeyDown={onCellKeyDown}
        />
      </UndoStackProvider>,
    );
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    clickCellByText(container, "Alpha");

    await act(async () => {
      rerender(
        <UndoStackProvider>
          <DataGrid
            rows={[]}
            columns={columns}
            rowKey={(r) => r.id}
            onCommit={async () => {}}
            onCellKeyDown={onCellKeyDown}
          />
        </UndoStackProvider>,
      );
    });

    await act(async () => {
      fireEvent.keyDown(grid, { key: "s", bubbles: true, cancelable: true });
    });

    const lastCall = onCellKeyDown.mock.calls.at(-1);
    if (lastCall) expect(lastCall[1].cursor).toBeNull();
  });
});

describe("DataGrid renderRowDetail", () => {
  test("renders beneath the matching row only", () => {
    const { container, queryAllByTestId } = renderGrid({
      renderRowDetail: (r) => (r.id === "a" ? <div data-testid="detail">drill-a</div> : null),
    });

    const details = queryAllByTestId("detail");
    expect(details).toHaveLength(1);
    expect(details[0]!.textContent).toBe("drill-a");

    // The detail row sits between row a and row b in DOM order.
    const rowA = container.querySelector('[data-row="a"]');
    const rowB = container.querySelector('[data-row="b"]');
    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    const pos = details[0]!.compareDocumentPosition(rowB!);
    // detail precedes row b
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and row a precedes the detail (detail can't render above its own row)
    expect(
      rowA!.compareDocumentPosition(details[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).toContain("Beta");
  });
});
