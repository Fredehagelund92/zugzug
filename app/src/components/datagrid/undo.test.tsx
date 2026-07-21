import { describe, expect, it } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

// Real undo/redo round-trip suite
// ──────────────────────────────────────────────────────────────────────────────
// The stateful Host in render-grid.tsx pushes UndoEntry objects on every commit
// so Cmd+Z / Cmd+Shift+Z round-trips are observable via the DOM cell text.
// The spy (onCommit) is NOT re-called on undo — the inverse runs commitValue
// directly. Assertions read cellAt(i, field).textContent.

const text = (el: HTMLElement) => el.textContent?.trim() ?? "";

describe("grid undo/redo", () => {
  it("single-edit undo restores the original value", async () => {
    const g = renderGrid();

    await g.editCell(0, "name", "Edited");
    expect(text(g.cellAt(0, "name"))).toBe("Edited");

    // Undo via Cmd+Z — inverse runs commitValue(rk, "name", "Name 0")
    await g.press("{Meta>}z{/Meta}");
    expect(text(g.cellAt(0, "name"))).toBe("Name 0");
  });

  it("redo re-applies the edit after undo", async () => {
    const g = renderGrid();

    await g.editCell(0, "name", "Edited");
    await g.press("{Meta>}z{/Meta}");
    expect(text(g.cellAt(0, "name"))).toBe("Name 0");

    // Redo via Cmd+Shift+Z — apply runs commitValue(rk, "name", "Edited")
    await g.press("{Meta>}{Shift>}z{/Shift}{/Meta}");
    expect(text(g.cellAt(0, "name"))).toBe("Edited");
  });

  it("range-clear undoes as ONE transaction (both cells restored by one Cmd+Z)", async () => {
    const g = renderGrid();

    // Select r0 + r1 in the name column and clear
    await g.focusCell(0, "name");
    await g.press("{Shift>}{ArrowDown}{/Shift}");
    await g.press("{Delete}");

    // Both cells should be empty after the clear (grid renders null as "—")
    expect(text(g.cellAt(0, "name"))).toBe("—");
    expect(text(g.cellAt(1, "name"))).toBe("—");

    // ONE Cmd+Z undoes the entire transaction (both cells restored)
    await g.press("{Meta>}z{/Meta}");
    expect(text(g.cellAt(0, "name"))).toBe("Name 0");
    expect(text(g.cellAt(1, "name"))).toBe("Name 1");
  });
});
