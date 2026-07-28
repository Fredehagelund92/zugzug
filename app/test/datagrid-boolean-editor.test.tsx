import { describe, test, expect, vi } from "vitest";
import { StrictMode } from "react";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  flag: string | null;
}
const columns: ColumnDef<Row>[] = [
  { field: "flag", label: "Flag", config: { type: "boolean" }, editable: true },
];

// StrictMode is what the real app mounts under (main.tsx), and it double-invokes
// mount effects — the condition that made the old commit-on-mount editor fire
// twice per toggle (#198).
function setup(onCommit: (rk: string, field: string, value: unknown) => Promise<void>) {
  const rows: Row[] = [{ id: "r1", flag: "false" }];
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

async function focusCell(c: HTMLElement) {
  await act(async () => {
    fireEvent.pointerDown(c, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(c, { button: 0, bubbles: true });
  });
}

async function openEditor(c: HTMLElement) {
  await focusCell(c);
  await act(async () => {
    fireEvent.doubleClick(c);
  });
  await act(async () => {});
}

function checkbox(c: HTMLElement): HTMLElement {
  const el = c.querySelector<HTMLElement>('[role="checkbox"]');
  if (!el) throw new Error("boolean editor did not open");
  return el;
}

describe("BooleanCell editor", () => {
  test("opening the editor does not commit — a toggle needs a user action", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    await openEditor(cell(container));
    expect(onCommit).not.toHaveBeenCalled();
  });

  test("Space commits the toggled value exactly once under StrictMode", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const c = cell(container);
    await openEditor(c);
    await act(async () => {
      fireEvent.keyDown(checkbox(c), { key: " " });
    });
    await act(async () => {});
    expect(onCommit.mock.calls).toEqual([["r1", "flag", true]]);
  });

  test("clicking the checkbox commits the toggled value exactly once", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const c = cell(container);
    await openEditor(c);
    await act(async () => {
      fireEvent.click(checkbox(c));
    });
    await act(async () => {});
    expect(onCommit.mock.calls).toEqual([["r1", "flag", true]]);
  });

  test("Escape cancels without committing", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const c = cell(container);
    await openEditor(c);
    await act(async () => {
      fireEvent.keyDown(checkbox(c), { key: "Escape" });
    });
    await act(async () => {});
    expect(onCommit).not.toHaveBeenCalled();
    expect(c.querySelector('[aria-label="false"]')).toBeTruthy();
  });

  test("type-to-edit opens the editor without toggling", async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const c = cell(container);
    await focusCell(c);
    await act(async () => {
      fireEvent.keyDown(c, { key: "x" });
    });
    await act(async () => {});
    expect(onCommit).not.toHaveBeenCalled();
  });
});
