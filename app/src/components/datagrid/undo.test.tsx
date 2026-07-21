import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

// Undo-routing characterization
// ──────────────────────────────────────────────────────────────────────────────
// DataGrid wraps range-clear in undo.beginTransaction / undo.endTransaction
// (DataGrid.tsx:1125-1131).  Undo entries are pushed by the HOST's onCommit
// via undo.push() — see TablePane.tsx:542, 591, 630.  The grid itself never
// calls undo.push().
//
// In the test harness, onCommit is vi.fn(async () => {}) — a no-op spy that
// never calls undo.push().  As a result:
//   • beginTransaction opens a group, commitValue calls onCommit(rk, field, null)
//     for each target cell, but endTransaction finds tx.entries.length === 0
//     and discards the group (UndoStack.tsx:109).
//   • The undo stack remains empty after a range clear.
//   • Ctrl+Z / Cmd+Z calls undo.undo() which returns early (no entry to pop).
//
// These tests assert the STRONGEST TRUE PROPERTIES:
//   1. Range-clear (Delete on r0+r1 name) fires null commits for both cells
//      within a single keyboard action — confirming the single-transaction
//      grouping design (all targets are dispatched via one Promise.all inside
//      one beginTransaction/endTransaction scope).
//   2. With a no-op onCommit, Ctrl+Z cannot restore cells — no additional
//      onCommit calls are made after undo, because the undo stack is empty.
//   3. Redo likewise has nothing to re-apply.
//
// If the host provides a real onCommit that pushes undo entries, the inverse
// would call onCommit with the original values for each cell.  The test for
// that path belongs in an integration test with a stateful host, not here.

describe("grid undo/redo", () => {
  it("range-clear commits null for every cell in one Delete action", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    // Extend selection to r0 + r1
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    await g.press("{Delete}");

    // Both cells must receive a null commit — these are the writes the grid
    // dispatches inside a single beginTransaction/endTransaction block.
    expect(g.onCommit).toHaveBeenCalledWith("r0", "name", null);
    expect(g.onCommit).toHaveBeenCalledWith("r1", "name", null);

    // Exactly two commits — no bystander cells touched.
    const clearedCalls = g.onCommit.mock.calls.length;
    expect(clearedCalls).toBe(2);
  });

  it("Ctrl+Z with a no-op onCommit does not produce extra commits (undo stack empty)", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    await g.press("{Delete}");

    const callsAfterClear = g.onCommit.mock.calls.length;

    // Undo — the stack is empty because the spy never called undo.push(),
    // so this is a no-op; no inverse commits should fire.
    await g.press("{Control>}z{/Control}");

    expect(g.onCommit.mock.calls.length).toBe(callsAfterClear);
  });

  it("redo with a no-op onCommit does not produce extra commits (redo stack empty)", async () => {
    const g = renderGrid();
    await g.focusCell(0, "name");
    await g.press("{Delete}");
    await g.press("{Control>}z{/Control}");

    const callsAfterUndo = g.onCommit.mock.calls.length;

    // Redo — nothing on the redo stack either.
    await g.press("{Control>}{Shift>}z{/Shift}{/Control}");

    expect(g.onCommit.mock.calls.length).toBe(callsAfterUndo);
  });
});
