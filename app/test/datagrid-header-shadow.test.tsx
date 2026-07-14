import { test, expect, vi, describe } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * Header elevation contract: the scroll container carries data-scrolled
 * exactly when scrollTop > 0, so CSS can shadow the sticky header
 * (.zz-grid-scroll[data-scrolled] .zz-grid-header). The toggle is
 * rAF-coalesced like the file's other scroll listeners — rAF is stubbed to
 * run synchronously here.
 */

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({
  id: `r${i}`,
  name: `Row ${i}`,
}));
const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

describe("header scrolled-under shadow", () => {
  test("data-scrolled toggles with scrollTop; header carries zz-grid-header", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const { container } = renderGrid();
      const scroller = container.querySelector<HTMLElement>(".zz-grid-scroll");
      expect(scroller).not.toBeNull();
      expect(container.querySelector(".zz-grid-header")).not.toBeNull();
      expect(scroller!.hasAttribute("data-scrolled")).toBe(false);

      Object.defineProperty(scroller!, "scrollTop", { value: 120, configurable: true });
      act(() => {
        fireEvent.scroll(scroller!);
      });
      expect(scroller!.hasAttribute("data-scrolled")).toBe(true);

      Object.defineProperty(scroller!, "scrollTop", { value: 0, configurable: true });
      act(() => {
        fireEvent.scroll(scroller!);
      });
      expect(scroller!.hasAttribute("data-scrolled")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
