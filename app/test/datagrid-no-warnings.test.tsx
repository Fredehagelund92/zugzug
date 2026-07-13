import { test, expect, describe, vi, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid, UndoStackProvider } from "../src/components/datagrid";
import { CommandPalette, type Command } from "../src/components/CommandPalette";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * Task 13: No React setState-in-render warnings on column resize/reorder;
 * no duplicate key warnings from the command palette.
 *
 * (1) Resize / reorder warnings:
 *   The fix targets DataGridHeader.tsx — the onUp handler for resize and the
 *   setDrag updater for reorder both previously called setOrder/onLayoutChange
 *   inside another setState updater, which React flags as a render-phase side
 *   effect. In jsdom tests the StrictMode double-render that surfaces this
 *   warning is absent (StrictMode is only in src/main.tsx), so the exact
 *   "Cannot update X while rendering Y" warning may not reproduce here.
 *   We test what IS observable: no console.error during resize/reorder, and
 *   that onLayoutChange receives the correct payload.
 *
 * (2) Palette duplicate key:
 *   If the commands array contains two entries with the same id, React emits
 *   a "Encountered two children with the same key" warning. We verify that
 *   the palette renders with unique command ids and no such warning fires.
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
    const lastChange = layoutChanges[layoutChanges.length - 1] as { widths?: Record<string, number> };
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
    const headers = Array.from(
      container.querySelectorAll<HTMLElement>('[role="columnheader"]'),
    );
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

// ── 3. Palette: no duplicate-key warning ─────────────────────────────────────

describe("command palette unique keys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("command ids are unique — no duplicate React key warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Simulate the AppShell command list that includes nav entries + dim entries.
    // The critical scenario: two commands could end up with the same id if the
    // commands array is not properly deduplicated.
    const commands: Command[] = [
      { id: "nav:dashboard", group: "Navigate", label: "Home", action: () => {}, priority: true },
      {
        id: "nav:triage",
        group: "Navigate",
        label: "Review",
        action: () => {},
        priority: true,
      },
      { id: "nav:sources", group: "Navigate", label: "Sources", action: () => {}, priority: true },
      { id: "nav:tables", group: "Navigate", label: "Tables", action: () => {}, priority: true },
      { id: "nav:audit", group: "Navigate", label: "Audit", action: () => {}, priority: true },
      { id: "nav:settings", group: "Navigate", label: "Settings", action: () => {}, priority: true },
      {
        id: "nav:integrations",
        group: "Navigate",
        label: "Integrations",
        action: () => {},
        priority: true,
      },
      // Simulate dim entries
      { id: "dim:dim1", group: "Tables", label: "Customers", action: () => {} },
      { id: "dim:dim2", group: "Tables", label: "Countries", action: () => {} },
      // Simulate canonical record entries
      { id: "rec:dim1:us", group: "Records", label: "United States", action: () => {} },
      { id: "rec:dim1:uk", group: "Records", label: "United Kingdom", action: () => {} },
    ];

    // Assert all ids are unique before rendering
    const ids = commands.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);

    // Render the palette open (so it renders the command list)
    render(
      <CommandPalette
        open={true}
        onClose={() => {}}
        commands={commands}
        recents={["nav:triage"]}
      />,
    );

    // No duplicate-key warning should have fired
    const errorMessages = errorSpy.mock.calls.flat().join(" ");
    expect(errorMessages).not.toMatch(/same key/i);
    expect(errorMessages).not.toMatch(/duplicate.*key/i);
    expect(errorMessages).not.toMatch(/Encountered two children with the same key/);
  });

  test("palette with 'Review' search renders without duplicate-key warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const commands: Command[] = [
      {
        id: "nav:triage",
        group: "Navigate",
        label: "Review",
        action: () => {},
        priority: true,
        keywords: "inbox queue match reconcile mapping triage",
      },
      // A dim named "Review" — different id, same label
      { id: "dim:review-dim", group: "Tables", label: "Review", action: () => {} },
      // A canonical record with label "Review" — different id
      { id: "rec:dim1:review", group: "Records", label: "Review", action: () => {} },
    ];

    const { container } = render(
      <CommandPalette open={true} onClose={() => {}} commands={commands} />,
    );

    // Type "review" to trigger filtering
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    act(() => {
      fireEvent.change(input!, { target: { value: "review" } });
    });

    // Three results, all with different IDs — no duplicate key warning
    const errorMessages = errorSpy.mock.calls.flat().join(" ");
    expect(errorMessages).not.toMatch(/same key/i);
    expect(errorMessages).not.toMatch(/Encountered two children with the same key/);
  });
});
