import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { DataGrid } from "../DataGrid";
import { UndoStackProvider } from "../UndoStack";
import type { ColumnDef } from "../types";
import { makeDriver } from "./driver";
import { makeColumns, makeRows, rowKeyFn, type Row } from "./fixtures";
import * as q from "./queries";

let scopeSeq = 0;

export interface RenderGridOverrides {
  rows?: Row[];
  columns?: ColumnDef<Row>[];
  onCommit?: ReturnType<typeof vi.fn>;
  [prop: string]: unknown; // passthrough DataGridProps
}

export function renderGrid(overrides: RenderGridOverrides = {}) {
  const rows = overrides.rows ?? makeRows();
  const columns = overrides.columns ?? makeColumns();
  const onCommit = overrides.onCommit ?? vi.fn(async () => {});
  const { rows: _r, columns: _c, onCommit: _o, ...rest } = overrides;
  const user = userEvent.setup();

  const scopeKey = `test-${scopeSeq++}`;
  const ui = (r: Row[]) => (
    <UndoStackProvider scopeKey={scopeKey}>
      <DataGrid rows={r} rowKey={rowKeyFn} columns={columns} onCommit={onCommit} showRowNumbers {...rest} />
    </UndoStackProvider>
  );

  const { container, rerender } = render(ui(rows));
  const idToKey = (i: number) => rows[i].id;

  return {
    user,
    onCommit,
    container,
    rows,
    rerender: (o: RenderGridOverrides = {}) => rerender(ui(o.rows ?? rows)),
    cellAt: (i: number, field: string) => q.cellAt(container, idToKey(i), field),
    cursorCell: () => q.cursorCell(container),
    selectedCells: () => q.selectedCells(container),
    editingCell: () => q.editingCell(container),
    ...makeDriver(user, (i, field) => q.cellAt(container, idToKey(i), field)),
  };
}
