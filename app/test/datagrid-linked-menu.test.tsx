import { test, expect, describe, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; country: string }
const rows: Row[] = [{ id: "1", country: "DE" }];

function fkColumn(): ColumnDef<Row> {
  return {
    field: "country",
    label: "Country",
    config: { type: "linked", targetDimId: "dim_country", displayFields: ["label", "iso_code"], candidates: [{ key: "DE", label: "Germany" }] },
    columnKind: "fk",
  };
}
function lookupColumn(): ColumnDef<Row> {
  return {
    field: "country__iso_code",
    label: "Country › ISO Code",
    config: { type: "text" },
    editable: false,
    columnKind: "lookup",
    sourceField: "country",
  };
}
function normalColumn(): ColumnDef<Row> {
  return { field: "id", label: "ID", config: { type: "text" } };
}

function openHeaderMenu(field: string, container: HTMLElement) {
  const h = container.querySelector(`[data-header="${field}"] span`) as HTMLElement;
  act(() => { fireEvent.contextMenu(h, { clientX: 50, clientY: 50, bubbles: true }); });
  return document.querySelector('[role="menu"]')!;
}

describe("right-click on FK column", () => {
  test("shows 'Show linked fields…' and 'Open target dimension →'", () => {
    const onShow = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={[normalColumn(), fkColumn()]} rowKey={(r) => r.id} onCommit={async () => {}}
          onShowLinkedFields={onShow} onOpenTargetDimension={onOpen} />
      </UndoStackProvider>,
    );
    const menu = openHeaderMenu("country", container);
    expect(menu.textContent).toContain("Show linked fields");
    expect(menu.textContent).toContain("Open target dimension");
    expect(menu.textContent).not.toContain("Change displayed field");
  });
});

describe("right-click on lookup column", () => {
  test("shows lookup-specific items and hides Rename/Change type", () => {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    const onJump = vi.fn();
    const onManage = vi.fn();
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={[normalColumn(), fkColumn(), lookupColumn()]} rowKey={(r) => r.id} onCommit={async () => {}}
          onChangeDisplayedField={onChange} onRemoveLookup={onRemove} onJumpToSourceColumn={onJump} onManageLinkedFields={onManage} />
      </UndoStackProvider>,
    );
    const menu = openHeaderMenu("country__iso_code", container);
    expect(menu.textContent).toContain("Change displayed field");
    expect(menu.textContent).toContain("Manage linked fields");
    expect(menu.textContent).toContain("Jump to source column");
    expect(menu.textContent).toContain("Remove this lookup");
    expect(menu.textContent).not.toContain("Rename");
    expect(menu.textContent).not.toContain("Change type");
  });
});

describe("right-click on normal column", () => {
  test("does NOT include linked-field items", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={[normalColumn(), fkColumn()]} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const menu = openHeaderMenu("id", container);
    expect(menu.textContent).toContain("Rename");
    expect(menu.textContent).not.toContain("Show linked fields");
    expect(menu.textContent).not.toContain("Change displayed field");
  });
});
