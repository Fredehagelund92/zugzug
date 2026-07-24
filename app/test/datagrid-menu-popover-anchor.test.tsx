import { test, expect, describe } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  status: string;
}
const rows: Row[] = [{ id: "1", status: "ok" }];
const columns: ColumnDef<Row>[] = [
  { field: "id", label: "ID", config: { type: "text" }, editable: false, noValidation: true },
  { field: "status", label: "Status", config: { type: "text" } },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        onCommit={async () => {}}
        onSaveColumnRules={() => {}}
        onSaveColumnValidation={() => {}}
        onSaveColumnDescription={() => {}}
      />
    </UndoStackProvider>,
  );
}

function openHeaderMenu(container: HTMLElement, field: string, x = 50, y = 50) {
  const headerLabel = container.querySelector(`[data-header="${field}"] span`) as HTMLElement;
  act(() => {
    fireEvent.contextMenu(headerLabel, { clientX: x, clientY: y, bubbles: true });
  });
}

function clickMenuItem(text: string) {
  const menu = document.querySelector("div.zz-pop-in") as HTMLElement;
  const btn = Array.from(menu.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  ) as HTMLButtonElement;
  act(() => {
    fireEvent.click(btn);
  });
}

// Regression for the "popup lands in the top-left corner" / "nothing comes up"
// bugs: selecting a follow-on popover from a right-click header menu used to run
// the item handler and then onClose(), which cleared menuAnchorRect out from under
// the just-opened popover — leaving Conditional-formatting stuck at (0,0) and the
// Description editor unrendered (the right-click path also nulls menuAnchorRef).
describe("header-menu popovers keep their anchor (right-click path)", () => {
  test("Conditional formatting anchors to the right-click point, not (0,0)", () => {
    const { container } = renderGrid();
    openHeaderMenu(container, "status", 50, 50);
    clickMenuItem("Conditional formatting");

    const pop = document.querySelector('[role="dialog"][aria-label="Conditional formatting"]');
    expect(pop).not.toBeNull();
    const style = (pop as HTMLElement).style;
    expect(style.left).toBe("50px"); // point-anchored to clientX, not the top-left corner
    expect(style.top).not.toBe("0px");
  });

  test("Edit description renders (does not silently return null)", () => {
    const { container } = renderGrid();
    openHeaderMenu(container, "status", 50, 50);
    clickMenuItem("Edit description");

    const pop = document.querySelector('[role="dialog"][aria-label^="Edit description"]');
    expect(pop).not.toBeNull();
    expect((pop as HTMLElement).style.left).toBe("50px");
  });
});

// Regression for "validation should not be possible on the record/key columns".
describe("Validation… menu item respects noValidation", () => {
  test("normal column shows Validation…", () => {
    const { container } = renderGrid();
    openHeaderMenu(container, "status");
    expect(document.querySelector("div.zz-pop-in")?.textContent).toContain("Validation");
  });

  test("noValidation column hides Validation…", () => {
    const { container } = renderGrid();
    openHeaderMenu(container, "id");
    expect(document.querySelector("div.zz-pop-in")?.textContent).not.toContain("Validation");
  });
});
