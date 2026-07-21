import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { vi } from "vitest";
import { DataGrid } from "../DataGrid";
import { UndoStackProvider, useUndoStack } from "../UndoStack";
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

interface HostProps {
  initialRows: Row[];
  /** When provided, overrides internal row state (used by rerender). */
  rowsOverride?: Row[];
  columns: ColumnDef<Row>[];
  onCommitSpy: ReturnType<typeof vi.fn>;
  rest: Record<string, unknown>;
}

function Host({ initialRows, rowsOverride, columns, onCommitSpy, rest }: HostProps) {
  const [internalRows, setInternalRows] = useState(initialRows);
  const rows = rowsOverride ?? internalRows;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const undo = useUndoStack();

  const commitValue = (rk: string, field: string, value: unknown): Promise<void> => {
    setInternalRows((prev) => prev.map((r) => (rowKeyFn(r) === rk ? { ...r, [field]: value } : r)));
    return Promise.resolve();
  };

  const onCommit = async (rk: string, field: string, value: unknown) => {
    onCommitSpy(rk, field, value);
    const oldValue = rowsRef.current.find((r) => rowKeyFn(r) === rk)?.[field as keyof Row];
    await commitValue(rk, field, value);
    undo.push({
      label: `edit ${field}`,
      apply: () => commitValue(rk, field, value),
      inverse: () => commitValue(rk, field, oldValue),
    });
  };

  return (
    <DataGrid
      rows={rows}
      rowKey={rowKeyFn}
      columns={columns}
      onCommit={onCommit}
      showRowNumbers
      {...rest}
    />
  );
}

export function renderGrid(overrides: RenderGridOverrides = {}) {
  const initialRows = overrides.rows ?? makeRows();
  const columns = overrides.columns ?? makeColumns();
  const onCommitSpy = overrides.onCommit ?? vi.fn(async () => {});
  const { rows: _r, columns: _c, onCommit: _o, ...rest } = overrides;
  const user = userEvent.setup();

  const scopeKey = `test-${scopeSeq++}`;

  // rerenderRows holds an override when rerender() is called externally.
  // undefined means "let the Host manage its own state".
  let rerenderRows: Row[] | undefined;

  const buildUi = (rowsOverride?: Row[]) => (
    <UndoStackProvider scopeKey={scopeKey}>
      <Host
        initialRows={initialRows}
        rowsOverride={rowsOverride}
        columns={columns}
        onCommitSpy={onCommitSpy}
        rest={rest}
      />
    </UndoStackProvider>
  );

  const { container, rerender } = render(buildUi());
  const idToKey = (i: number) => initialRows[i].id;

  return {
    user,
    onCommit: onCommitSpy,
    container,
    rows: initialRows,
    rerender: (o: RenderGridOverrides = {}) => {
      rerenderRows = o.rows;
      rerender(buildUi(rerenderRows));
    },
    cellAt: (i: number, field: string) => q.cellAt(container, idToKey(i), field),
    cursorCell: () => q.cursorCell(container),
    selectedCells: () => q.selectedCells(container),
    editingCell: () => q.editingCell(container),
    ...makeDriver(user, (i, field) => q.cellAt(container, idToKey(i), field)),
  };
}
