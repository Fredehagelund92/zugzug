import React from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { GridRow } from "./DataGridRow";
import type { ColumnDef } from "./types";
import type { PaletteName } from "../../lib/palette";
import type { OptionDef } from "../../data";
import type { RowActivityEntry } from "../../lib/use-row-activity";
import type { RowEvaluation } from "./useConditionalFormatting";

interface CondFmt<Row> {
  evaluateRow: (row: Row) => RowEvaluation;
  hasRules: boolean;
}

interface DataGridBodyProps<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: ColumnDef<Row>[];
  gridStyle: React.CSSProperties;
  cellPadY: string;
  showRowNumbers: boolean;
  selectionCol: boolean;
  estimatedRowHeight: number;
  /** Ref of the scroll container (the outer `<div role="grid">`). */
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  /** Lets DataGrid call `virtualizer.scrollToIndex` from outside (cursor
   *  scroll-into-view). Body assigns this on every render. */
  virtualizerRef: React.MutableRefObject<Virtualizer<HTMLDivElement, Element> | null>;
  /** Empty-state element override; falls back to "No rows.". */
  empty?: React.ReactNode;

  // Cursor + selection state read by GridRow
  cursorRowKey: string | null;
  cursorField: string | null;
  cursorEditing: boolean;
  cursorInitial: string | undefined;
  cellInRange: (rk: string, field: string) => boolean;
  isSelected: (rk: string) => boolean;

  // Add-field placeholder column count for GridRow trailing cell
  onAddFieldClick: (() => void) | undefined;
  hiddenFieldCount: number;

  // Data access
  getValue: (row: Row, field: string) => unknown;

  // Cell handlers
  onCellPointerDown: (e: React.PointerEvent, rk: string, field: string) => void;
  onCellDoubleClick: (rk: string, field: string) => void;
  onToggleSelect: (rk: string) => void;
  onCommitCell: (rk: string, field: string, value: unknown) => Promise<void> | void;
  onStopEdit: () => void;
  onAddColumnOption:
    | ((field: string, label: string, color?: PaletteName | null) => Promise<OptionDef[]>)
    | undefined;
  onRowNumPointerDown: (e: React.PointerEvent, rk: string) => void;
  onColumnHover: (field: string | null) => void;

  // Conditional formatting evaluator
  condFmt: CondFmt<Row>;

  // Host activity + detail row
  activity?: Map<string, RowActivityEntry>;
  renderRowDetail?: (row: Row) => React.ReactNode;
}

export function DataGridBody<Row>(props: DataGridBodyProps<Row>): React.ReactElement {
  const {
    rows,
    rowKey,
    columns,
    gridStyle,
    cellPadY,
    showRowNumbers,
    selectionCol,
    estimatedRowHeight,
    scrollContainerRef,
    virtualizerRef,
    empty,
    cursorRowKey,
    cursorField,
    cursorEditing,
    cursorInitial,
    cellInRange,
    isSelected,
    onAddFieldClick,
    hiddenFieldCount,
    getValue,
    onCellPointerDown,
    onCellDoubleClick,
    onToggleSelect,
    onCommitCell,
    onStopEdit,
    onAddColumnOption,
    onRowNumPointerDown,
    onColumnHover,
    condFmt,
    activity,
    renderRowDetail,
  } = props;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 5,
  });
  // Expose to DataGrid so its cursor scroll-into-view effect can call scrollToIndex.
  virtualizerRef.current = virtualizer;

  if (rows.length === 0) {
    return (
      <>
        {empty ?? (
          <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-2">No rows.</div>
        )}
      </>
    );
  }

  const vItems = virtualizer.getVirtualItems();
  const topPad = vItems[0]?.start ?? 0;
  const bottomPad =
    vItems.length > 0
      ? virtualizer.getTotalSize() - (vItems[vItems.length - 1]?.end ?? 0)
      : virtualizer.getTotalSize();

  return (
    <>
      {topPad > 0 && <div style={{ height: topPad }} />}
      {vItems.map((vRow) => {
        const row = rows[vRow.index]!;
        const rk = rowKey(row);
        const focusedOnThisRow = cursorRowKey === rk;
        const evaluation = condFmt.evaluateRow(row);
        // Host-controlled detail row (provenance drill). Rendered
        // outside the virtualizer's size estimates — acceptable for
        // one open drill at a time on ≤500-row surfaces.
        const detail = renderRowDetail?.(row) ?? null;
        return (
          <React.Fragment key={rk}>
            <GridRow
              row={row}
              rowKey={rk}
              rowIndex={vRow.index}
              columns={columns}
              focusedField={focusedOnThisRow ? cursorField : null}
              editingField={focusedOnThisRow && cursorEditing ? cursorField : null}
              cursorInitial={focusedOnThisRow ? cursorInitial : undefined}
              cellInRange={cellInRange}
              selected={isSelected(rk)}
              selectionCol={selectionCol}
              showRowNumbers={showRowNumbers}
              cellPadY={cellPadY}
              gridStyle={gridStyle}
              onAddFieldClick={onAddFieldClick}
              hiddenFieldCount={hiddenFieldCount}
              getValue={getValue}
              onCellPointerDown={onCellPointerDown}
              onCellDoubleClick={onCellDoubleClick}
              onToggleSelect={onToggleSelect}
              onCommitCell={onCommitCell}
              onStopEdit={onStopEdit}
              onAddColumnOption={onAddColumnOption}
              onRowNumPointerDown={onRowNumPointerDown}
              evaluation={evaluation}
              activityEntry={activity?.get(rk)}
              onColumnHover={onColumnHover}
            />
            {detail !== null && (
              <div role="row" className="border-b border-line bg-surface-2/50">
                {detail}
              </div>
            )}
          </React.Fragment>
        );
      })}
      {bottomPad > 0 && <div style={{ height: bottomPad }} />}
    </>
  );
}
