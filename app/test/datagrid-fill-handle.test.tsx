import { test, expect, describe, vi, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; name: string }
const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), name: i === 0 ? "Acme" : "" }));
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false },
  { field: "name", label: "Name", config: { type: "text" } },
];

describe("fill handle", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("drag the corner handle down fills target rows with source value", async () => {
    const commits: Array<{ rk: string; field: string; value: unknown }> = [];
    const onCommit = vi.fn(async (rk: string, field: string, value: unknown) => {
      commits.push({ rk, field, value });
    });
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={onCommit} />
      </UndoStackProvider>,
    );
    const acme = container.querySelector('[data-cell="1::name"]') as HTMLElement;
    act(() => {
      fireEvent.pointerDown(acme, { button: 0, bubbles: true });
      fireEvent.pointerUp(acme, { button: 0, bubbles: true });
    });
    const handle = container.querySelector('[data-fill-handle="true"]') as HTMLElement;
    expect(handle).not.toBeNull();
    const target5 = container.querySelector('[data-cell="5::name"]') as HTMLElement;
    document.elementFromPoint = vi.fn().mockReturnValue(target5);
    act(() => { fireEvent.pointerDown(handle, { button: 0, bubbles: true }); });
    act(() => { fireEvent.pointerMove(window, { clientX: 0, clientY: 200 } as any); });
    act(() => { fireEvent.pointerUp(window, { button: 0 } as any); });
    await new Promise((r) => setTimeout(r, 10));
    const written = commits.filter((c) => c.field === "name").map((c) => c.rk).sort();
    expect(written).toEqual(["2", "3", "4", "5"]);
    commits.filter((c) => c.field === "name").forEach((c) => expect(c.value).toBe("Acme"));
  });
});
