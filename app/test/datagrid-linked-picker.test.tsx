import { describe, test, expect, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  region: string | null;
}

const candidates = [
  { key: "apac", label: "APAC" },
  { key: "emea", label: "EMEA" },
  { key: "nordics", label: "Nordics" },
];

const columns: ColumnDef<Row>[] = [
  {
    field: "region",
    label: "Region",
    config: { type: "linked", targetRefTableId: "region", displayFields: ["label"], candidates },
    editable: true,
  },
];

function openPicker() {
  const rows: Row[] = [{ id: "r1", region: null }];
  const { container } = render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
  const cell = container.querySelector<HTMLElement>('[role="gridcell"]')!;
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  act(() => {
    fireEvent.doubleClick(cell);
  });
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search records…"]');
  if (!input) throw new Error("picker did not open");
  return input.closest("div.fixed") as HTMLElement;
}

describe("LinkedCell picker layout", () => {
  test("lists every candidate", () => {
    const pop = openPicker();
    for (const c of candidates) expect(pop.textContent).toContain(c.label);
    expect(pop.textContent).not.toContain("No records found");
  });

  /**
   * Rows are absolutely positioned, so they are only visible if the container
   * is given a height and each row is offset. Applying that geometry only on
   * the virtualized path deadlocks in a real browser: the virtualizer reports
   * no items until the scroll element has height, and the scroll element has
   * no height until the geometry is applied — leaving an empty picker (#202).
   *
   * jsdom has no layout engine, so the rendered geometry can't be measured
   * here — but the inline styles that produce it can be.
   */
  test("the list container is given a non-zero height", () => {
    const pop = openPicker();
    const inner = pop.querySelector<HTMLElement>(".overflow-y-auto > div")!;
    expect(inner.style.height).not.toBe("");
    expect(parseFloat(inner.style.height)).toBeGreaterThan(0);
  });

  test("each row carries its own vertical offset", () => {
    const pop = openPicker();
    const buttons = [...pop.querySelectorAll<HTMLElement>(".overflow-y-auto > div > button")];
    expect(buttons).toHaveLength(candidates.length);
    const offsets = buttons.map((b) => b.style.transform);
    // Every row offset must be distinct — all-zero means they stack on top of
    // each other and only one is ever visible.
    expect(new Set(offsets).size).toBe(candidates.length);
    expect(offsets[0]).toContain("translateY(0px)");
  });

  test("picking a candidate commits its key", async () => {
    const onCommit = vi.fn(async () => {});
    const rows: Row[] = [{ id: "r1", region: null }];
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={onCommit} />
      </UndoStackProvider>,
    );
    const cell = container.querySelector<HTMLElement>('[role="gridcell"]')!;
    await act(async () => {
      fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
      fireEvent.pointerUp(cell, { button: 0, bubbles: true });
    });
    await act(async () => {
      fireEvent.doubleClick(cell);
    });
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("EMEA"),
    )!;
    await act(async () => {
      fireEvent.mouseDown(btn);
    });
    await act(async () => {});
    expect(onCommit).toHaveBeenCalledWith("r1", "region", "emea");
  });
});
