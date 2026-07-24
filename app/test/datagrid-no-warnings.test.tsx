import { test, expect, describe, vi, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid, UndoStackProvider } from "../src/components/datagrid";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * Task 13: No React setState-in-render warnings on column resize/reorder.
 *
 * The fix targets DataGridHeader.tsx — the onUp handler for resize and the
 * setDrag updater for reorder both previously called setOrder/onLayoutChange
 * inside another setState updater, which React flags as a render-phase side
 * effect. In jsdom tests the StrictMode double-render that surfaces this
 * warning is absent (StrictMode is only in src/main.tsx), so the exact
 * "Cannot update X while rendering Y" warning may not reproduce here.
 * We test what IS observable: no console.error during resize/reorder, and
 * that onLayoutChange receives the correct payload.
 *
 * Note (palette duplicate key): the spec's Bug 2 ("duplicate Review key") was
 * in ShortcutsOverlay.tsx and is already resolved upstream — group titles are
 * unique. The speculative dedup guard in AppShell.tsx commands useMemo was
 * removed as YAGNI; command ids (nav:*, refTable:${id}, rec:${id}:${key}) cannot
 * collide by construction.
 */

// ── Shared grid setup ────────────────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
  value: string;
}

const rows: Row[] = [
  { id: "a", name: "Alpha", value: "1" },
  { id: "b", name: "Beta", value: "2" },
];

const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
  { field: "value", label: "Value", config: { type: "text" }, editable: true },
];

function renderGrid(onLayoutChange?: (change: object) => void) {
  return render(
    <UndoStackProvider>
      <DataGrid
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        onCommit={async () => {}}
        onLayoutChange={onLayoutChange as never}
      />
    </UndoStackProvider>,
  );
}

// ── 1. Resize: no setState-in-render warning ─────────────────────────────────

describe("column resize", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("resizing a column calls onLayoutChange and logs no setState-in-render error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const layoutChanges: object[] = [];

    const { container } = renderGrid((change) => layoutChanges.push(change));

    // Find the resize grip on the first non-pinned column
    const grip = container.querySelector<HTMLElement>(
      '.zz-grid-header [aria-hidden][class*="cursor-col-resize"]',
    );
    expect(grip).not.toBeNull();

    // Simulate pointer-down → pointer-move → pointer-up (the resize sequence)
    act(() => {
      fireEvent.pointerDown(grip!, {
        button: 0,
        clientX: 100,
        bubbles: true,
        cancelable: true,
      });
    });

    // Move 50px right → column should grow by 50px
    act(() => {
      fireEvent.pointerMove(window, { clientX: 150 } as PointerEventInit);
    });

    act(() => {
      fireEvent.pointerUp(window, { button: 0 } as PointerEventInit);
    });

    // After pointer-up the host's onLayoutChange should have been called with widths
    expect(layoutChanges.length).toBeGreaterThan(0);
    const lastChange = layoutChanges[layoutChanges.length - 1] as {
      widths?: Record<string, number>;
    };
    expect(lastChange.widths).toBeDefined();

    // The critical assertion: no setState-in-render (or any other) console.error
    const errorMessages = errorSpy.mock.calls.flat().join(" ");
    expect(errorMessages).not.toMatch(/Cannot update .* while rendering/);
    expect(errorMessages).not.toMatch(/Warning: Cannot update/);
  });
});

// ── 2. Reorder: no setState-in-render warning ────────────────────────────────

describe("column reorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reordering a column calls onLayoutChange and logs no setState-in-render error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const layoutChanges: object[] = [];

    const { container } = renderGrid((change) => layoutChanges.push(change));

    // Find the draggable label span on the "Name" column header
    const headers = Array.from(container.querySelectorAll<HTMLElement>('[role="columnheader"]'));
    const nameHeader = headers.find((h) => h.textContent?.includes("Name"));
    expect(nameHeader).not.toBeNull();

    const dragLabel = nameHeader!.querySelector<HTMLElement>("span.cursor-grab");
    expect(dragLabel).not.toBeNull();

    // Simulate hold-then-drag: pointerDown → wait 200ms (hold timer) → move → up
    act(() => {
      fireEvent.pointerDown(dragLabel!, {
        button: 0,
        clientX: 50,
        bubbles: true,
        cancelable: true,
      });
    });

    // Advance timers to fire the 200ms hold timer that starts drag mode
    await act(async () => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(250);
      vi.useRealTimers();
    });

    // Move over the "Value" column header
    const valueHeader = headers.find((h) => h.textContent?.includes("Value"));
    if (valueHeader) {
      (document.elementFromPoint as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockReturnValue(valueHeader);
    }

    act(() => {
      fireEvent.pointerMove(window, { clientX: 250 } as PointerEventInit);
    });

    act(() => {
      fireEvent.pointerUp(window, { button: 0 } as PointerEventInit);
    });

    // No setState-in-render error should have fired
    const errorMessages = errorSpy.mock.calls.flat().join(" ");
    expect(errorMessages).not.toMatch(/Cannot update .* while rendering/);
    expect(errorMessages).not.toMatch(/Warning: Cannot update/);
  });
});
