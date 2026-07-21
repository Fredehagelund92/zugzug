import React, { useRef } from "react";
import { cx } from "../../lib/cx";
import { Checkbox } from "../Checkbox";
import { TextCell } from "./cells/TextCell";
import { NumberCell } from "./cells/NumberCell";
import { BooleanCell } from "./cells/BooleanCell";
import { DateCell } from "./cells/DateCell";
import { UrlCell } from "./cells/UrlCell";
import { EmailCell } from "./cells/EmailCell";
import { RatingCell } from "./cells/RatingCell";
import { LinkedCell } from "./cells/LinkedCell";
import { SelectCell } from "./cells/SelectCell";
import type { CellCtx, CellType, ColumnDef, EditCtx, RuleStyle } from "./types";
import type { PaletteName } from "../../lib/palette";
import type { OptionDef } from "../../data";
import type { RowActivityEntry } from "../../lib/use-row-activity";
import { RowActivityBadge } from "./RowActivityBadge";
import type { RowEvaluation } from "./useConditionalFormatting";

type InlineEditor = "select" | "linked" | "date";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry stores generic cell components; Row type param is erased at dispatch
const CELLS: Record<
  Exclude<CellType, InlineEditor>,
  { Renderer: (ctx: any) => React.ReactNode; Editor: (ctx: any) => React.ReactNode }
> = {
  text: TextCell,
  number: NumberCell,
  boolean: BooleanCell,
  url: UrlCell,
  email: EmailCell,
  rating: RatingCell,
};

function CellRenderer<Row>({ type, ctx }: { type: CellType; ctx: CellCtx<Row> }) {
  if (type === "select") return <SelectCell.Renderer {...ctx} />;
  if (type === "linked") return <LinkedCell.Renderer {...ctx} />;
  if (type === "date") return <DateCell.Renderer {...ctx} />;
  const C = CELLS[type as Exclude<CellType, InlineEditor>];
  return <C.Renderer {...ctx} />;
}

function CellEditor<Row>({ type, ctx }: { type: CellType; ctx: EditCtx<Row> }) {
  // select / linked / date editors render their own portal popovers and need
  // anchorRef — they're handled inline in the body below.
  if (type === "select" || type === "linked" || type === "date") return null;
  const C = CELLS[type as Exclude<CellType, InlineEditor>];
  return <C.Editor {...ctx} />;
}

// ── GridCell — memoized per-cell component ─────────────────────────────────
// Flat per-cell props so that when the cursor moves from cell A to B, only
// those two cells see prop changes; the other ~N-2 cells skip re-render via
// the custom areEqual check below.
interface GridCellProps<Row> {
  row: Row;
  column: ColumnDef<Row>;
  rowKey: string;
  colIndex: number;
  gridId: string;
  value: unknown;
  focused: boolean;
  editing: boolean;
  cursorInitial: string | undefined;
  inRange: boolean;
  cellPadY: string;
  isLastCol: boolean;
  isFirstPinned: boolean;
  selected: boolean;
  editable: boolean;
  ruleStyle: RuleStyle | undefined;
  editingCellRef: React.RefObject<HTMLDivElement>;
  onCellPointerDown: (e: React.PointerEvent, rk: string, field: string) => void;
  onCellDoubleClick: (rk: string, field: string) => void;
  onColumnHover: (field: string | null) => void;
  onStopEdit: () => void;
  onCommitCell: (rk: string, field: string, value: unknown) => void;
  onAddColumnOption:
    | ((field: string, label: string, color?: PaletteName | null) => Promise<OptionDef[]>)
    | undefined;
}

function GridCellInner<Row>(props: GridCellProps<Row>): React.ReactElement {
  const {
    row,
    column: c,
    rowKey: rk,
    colIndex: idx,
    gridId,
    value,
    focused,
    editing,
    cursorInitial,
    inRange,
    cellPadY,
    isLastCol,
    isFirstPinned,
    selected,
    editable,
    ruleStyle,
    editingCellRef,
    onCellPointerDown,
    onCellDoubleClick,
    onColumnHover,
    onStopEdit,
    onCommitCell,
    onAddColumnOption,
  } = props;
  const ctx = { row, rowKey: rk, field: c.field, value, focused, column: c };
  const cellCx = cx(
    "relative flex min-w-0 select-none items-center px-3",
    cellPadY,
    !isLastCol && "border-r border-line",
    c.align === "right" && "justify-end text-right",
    inRange && !focused && "bg-accent/10",
    focused && "ring-2 ring-accent ring-inset",
    isFirstPinned && "sticky left-0 z-[5] bg-[var(--surface)]",
    isFirstPinned && selected && "!bg-[var(--surface-2)]",
  );
  const cellInlineStyle: React.CSSProperties = {};
  if (ruleStyle?.cellBg)
    cellInlineStyle.background = `color-mix(in srgb,var(--tint-${ruleStyle.cellBg}) 18%,transparent)`;
  if (ruleStyle?.textColor) cellInlineStyle.color = `var(--tint-${ruleStyle.textColor})`;
  const data = `${rk}::${c.field}`;
  return (
    <div
      ref={editing ? editingCellRef : undefined}
      role="gridcell"
      aria-colindex={idx + 1}
      aria-selected={focused ? true : undefined}
      data-in-range={inRange ? "true" : undefined}
      id={`${gridId}${encodeURIComponent(rk)}::${c.field}`}
      data-cell={data}
      data-field={c.field}
      onPointerDown={(e) => onCellPointerDown(e, rk, c.field)}
      onDoubleClick={() => onCellDoubleClick(rk, c.field)}
      onMouseEnter={() => onColumnHover(c.field)}
      onMouseLeave={() => onColumnHover(null)}
      className={cellCx}
      style={Object.keys(cellInlineStyle).length > 0 ? cellInlineStyle : undefined}
    >
      {editing && editable ? (
        c.edit ? (
          c.edit(row, {
            ...ctx,
            initial: cursorInitial,
            commit: (v: unknown) => {
              onStopEdit();
              onCommitCell(rk, c.field, v);
            },
            cancel: () => onStopEdit(),
          })
        ) : c.config.type === "select" ? (
          <SelectCell.Editor
            row={row}
            rowKey={rk}
            field={c.field}
            value={value}
            focused
            column={c}
            anchorRef={editingCellRef}
            commit={(v: unknown) => {
              onStopEdit();
              onCommitCell(rk, c.field, v);
            }}
            cancel={() => onStopEdit()}
            options={c.config.options}
            onCreate={async (label: string, color) => {
              if (!onAddColumnOption) return c.config.type === "select" ? c.config.options : [];
              return await onAddColumnOption(c.field, label, color);
            }}
          />
        ) : c.config.type === "linked" ? (
          <LinkedCell.Editor
            row={row}
            rowKey={rk}
            field={c.field}
            value={value}
            focused
            column={c}
            anchorRef={editingCellRef}
            commit={(v: unknown) => {
              onStopEdit();
              onCommitCell(rk, c.field, v);
            }}
            cancel={() => onStopEdit()}
            candidates={c.config.candidates}
          />
        ) : c.config.type === "date" ? (
          <DateCell.Editor
            row={row}
            rowKey={rk}
            field={c.field}
            value={value}
            focused
            column={c}
            anchorRef={editingCellRef}
            initial={cursorInitial}
            commit={(v: unknown) => {
              onStopEdit();
              onCommitCell(rk, c.field, v);
            }}
            cancel={() => onStopEdit()}
          />
        ) : (
          <CellEditor
            type={c.config.type}
            ctx={{
              ...ctx,
              initial: cursorInitial,
              commit: (v: unknown) => {
                onStopEdit();
                onCommitCell(rk, c.field, v);
              },
              cancel: () => onStopEdit(),
            }}
          />
        )
      ) : c.render ? (
        c.render(row, ctx)
      ) : c.config.type === "select" ? (
        <SelectCell.Renderer {...ctx} />
      ) : c.config.type === "linked" ? (
        <LinkedCell.Renderer {...ctx} />
      ) : (
        <CellRenderer type={c.config.type} ctx={ctx} />
      )}
    </div>
  );
}

function gridCellAreEqual<Row>(prev: GridCellProps<Row>, next: GridCellProps<Row>): boolean {
  return (
    prev.row === next.row &&
    prev.column === next.column &&
    prev.rowKey === next.rowKey &&
    prev.colIndex === next.colIndex &&
    prev.gridId === next.gridId &&
    prev.value === next.value &&
    prev.focused === next.focused &&
    prev.editing === next.editing &&
    prev.cursorInitial === next.cursorInitial &&
    prev.inRange === next.inRange &&
    prev.cellPadY === next.cellPadY &&
    prev.isLastCol === next.isLastCol &&
    prev.isFirstPinned === next.isFirstPinned &&
    prev.selected === next.selected &&
    prev.editable === next.editable &&
    prev.ruleStyle === next.ruleStyle &&
    prev.editingCellRef === next.editingCellRef &&
    prev.onCellPointerDown === next.onCellPointerDown &&
    prev.onCellDoubleClick === next.onCellDoubleClick &&
    prev.onColumnHover === next.onColumnHover &&
    prev.onStopEdit === next.onStopEdit &&
    prev.onCommitCell === next.onCommitCell &&
    prev.onAddColumnOption === next.onAddColumnOption
  );
}

// React.memo erases generics — re-cast to preserve them at the call site.
const GridCell = React.memo(GridCellInner, gridCellAreEqual) as <Row>(
  props: GridCellProps<Row>,
) => React.ReactElement;

// ── GridRow — memoized per-row component ────────────────────────────────────
export interface GridRowProps<Row> {
  row: Row;
  rowKey: string;
  rowIndex: number;
  columns: ColumnDef<Row>[];
  gridId: string;
  /** Which field on this row has the cursor (null = cursor is elsewhere). */
  focusedField: string | null;
  /** Which field on this row is actively being edited (null = none). */
  editingField: string | null;
  /** Passed through to editors for type-to-edit seeding. */
  cursorInitial: string | undefined;
  /** Returns true when (rowKey, field) is inside the current range selection.
   *  Takes the row key so the stable callback can be passed straight through
   *  without a per-row closure (which would defeat React.memo on GridRow). */
  cellInRange: (rk: string, field: string) => boolean;
  selected: boolean;
  selectionCol: boolean;
  showRowNumbers: boolean;
  cellPadY: string;
  gridStyle: React.CSSProperties;
  onAddFieldClick: (() => void) | undefined;
  hiddenFieldCount: number;
  getValue: (row: Row, field: string) => unknown;
  onCellPointerDown: (e: React.PointerEvent, rk: string, field: string) => void;
  onCellDoubleClick: (rk: string, field: string) => void;
  onToggleSelect: (rk: string) => void;
  onCommitCell: (rk: string, field: string, value: unknown) => void;
  onStopEdit: () => void;
  onAddColumnOption:
    | ((field: string, label: string, color?: PaletteName | null) => Promise<OptionDef[]>)
    | undefined;
  onRowNumPointerDown?: (e: React.PointerEvent, rk: string) => void;
  evaluation: RowEvaluation;
  /** Latest audit entry for this row, if any. When present, renders the
   *  activity pip + hover badge inside the row wrapper. */
  activityEntry?: RowActivityEntry;
  /** Column-hover highlight: invoked from each cell's onMouseEnter/Leave to
   *  tint the column. DOM-mutation based on the DataGrid side — see
   *  applyColumnHover. */
  onColumnHover: (field: string | null) => void;
  /** The field of the leftmost pinned-left column, or null if none. Computed
   *  once per render in DataGrid so cells don't recompute O(cols²) per row. */
  firstPinnedField: string | null;
}

function GridRowInner<Row>(props: GridRowProps<Row>): React.ReactElement {
  // Ref for the currently-editing cell — passed to SelectCell.Editor so the
  // portal popover can position itself relative to the cell anchor.
  const editingCellRef = useRef<HTMLDivElement>(null);
  const {
    row,
    rowKey: rk,
    rowIndex,
    columns,
    gridId,
    focusedField,
    editingField,
    cursorInitial,
    cellInRange,
    selected,
    selectionCol,
    showRowNumbers,
    cellPadY,
    gridStyle,
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
    evaluation,
    activityEntry,
    onColumnHover,
    firstPinnedField,
  } = props;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      className={cx(
        "relative group grid items-stretch border-b border-line",
        selected ? "bg-surface-2" : "hover:bg-hover",
      )}
      style={gridStyle}
      data-row={rk}
    >
      {activityEntry && <RowActivityBadge entry={activityEntry} editing={editingField !== null} />}
      {evaluation.rowStripe && (
        <span
          aria-hidden
          data-row-stripe={evaluation.rowStripe}
          className="absolute left-0 top-0 bottom-0 w-1 z-[1] pointer-events-none"
          style={{ background: `var(--tint-${evaluation.rowStripe})` }}
        />
      )}
      {showRowNumbers && (
        <div
          data-row-num={rk}
          onPointerDown={(e) => onRowNumPointerDown?.(e, rk)}
          className={cx(
            "flex items-center justify-end border-r border-line pr-2 font-mono text-[10px] text-ink-3 tabular-nums cursor-cell",
            cellPadY,
          )}
        >
          {rowIndex + 1}
        </div>
      )}
      {selectionCol && (
        <div className={cx("flex items-center justify-center border-r border-line", cellPadY)}>
          <Checkbox
            state={selected ? "on" : "off"}
            onClick={() => onToggleSelect(rk)}
            aria-label={`Select row ${rk}`}
          />
        </div>
      )}
      {columns.map((c, idx) => {
        const focused = focusedField === c.field;
        const editing = editingField === c.field;
        const inRangeCell = cellInRange(rk, c.field);
        const value = getValue(row, c.field);
        const isLastCol = idx === columns.length - 1;
        const isFirstPinned = c.pinnedLeft === true && c.field === firstPinnedField;
        const ruleStyle: RuleStyle | undefined = evaluation.cellStyles.get(c.field);
        return (
          <GridCell
            key={c.field}
            row={row}
            column={c}
            rowKey={rk}
            colIndex={idx}
            gridId={gridId}
            value={value}
            focused={focused}
            editing={editing}
            cursorInitial={editing ? cursorInitial : undefined}
            inRange={inRangeCell}
            cellPadY={cellPadY}
            isLastCol={isLastCol}
            isFirstPinned={isFirstPinned}
            selected={selected}
            editable={c.editable !== false}
            ruleStyle={ruleStyle}
            editingCellRef={editingCellRef}
            onCellPointerDown={onCellPointerDown}
            onCellDoubleClick={onCellDoubleClick}
            onColumnHover={onColumnHover}
            onStopEdit={onStopEdit}
            onCommitCell={onCommitCell}
            onAddColumnOption={onAddColumnOption}
          />
        );
      })}
      {onAddFieldClick && (
        <div aria-hidden className="invisible flex items-center">
          {hiddenFieldCount > 0 && (
            <span className="px-2 py-2 text-[12px] font-medium">👁 {hiddenFieldCount} hidden</span>
          )}
          <span className="px-3 py-2 text-[12px] font-medium">+ Field</span>
        </div>
      )}
    </div>
  );
}

// React.memo erases generics — re-cast to preserve them at the call site.
export const GridRow = React.memo(GridRowInner) as <Row>(
  props: GridRowProps<Row>,
) => React.ReactElement;
