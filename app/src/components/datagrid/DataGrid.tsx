import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cx } from "../../lib/cx";
import { Checkbox } from "../Checkbox";
import {
  IconEye,
  IconFieldBoolean,
  IconFieldDate,
  IconFieldNumber,
  IconFieldSelect,
  IconFieldText,
} from "../Icons";

const IconFieldUrl = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    ↗
  </span>
);
const IconFieldEmail = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    @
  </span>
);
const IconFieldRating = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    ★
  </span>
);
const IconFieldLinked = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    ⇢
  </span>
);
import { TextCell } from "./cells/TextCell";
import { NumberCell } from "./cells/NumberCell";
import { BooleanCell } from "./cells/BooleanCell";
import { DateCell } from "./cells/DateCell";
import { UrlCell } from "./cells/UrlCell";
import { EmailCell } from "./cells/EmailCell";
import { RatingCell } from "./cells/RatingCell";
import { LinkedCell } from "./cells/LinkedCell";
import { SelectCell } from "./cells/SelectCell";
import { ColumnHeaderMenu } from "./ColumnHeaderMenu";
import { HiddenFieldsPopover } from "./HiddenFieldsPopover";
import { useGridCursor } from "./useGridCursor";
import { useUndoStack } from "./UndoStack";
import { useFillHandle } from "./useFillHandle";
import { FilterBar } from "./FilterBar";
import { StatusBar } from "./StatusBar";
import { computeAggregates } from "./useAggregates";
import { useContextMenu, type ContextSurface } from "./useContextMenu";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ConditionalFormatPopover } from "./ConditionalFormatPopover";
import { FieldDescriptionEditor } from "./FieldDescriptionEditor";
import { useConditionalFormatting, type RowEvaluation } from "./useConditionalFormatting";
import type { DataGridProps, CellType, ColumnDef, FilterSet, RuleStyle } from "./types";
import type { PaletteName } from "../../lib/palette";
import type { OptionDef } from "../../data";
import type { RowActivityEntry } from "../../lib/use-row-activity";
import { RowActivityBadge } from "./RowActivityBadge";

// ── GridRow — memoized per-row component ────────────────────────────────────
interface GridRowProps<Row> {
  row: Row;
  rowKey: string;
  rowIndex: number;
  columns: ColumnDef<Row>[];
  /** Which field on this row has the cursor (null = cursor is elsewhere). */
  focusedField: string | null;
  /** Which field on this row is actively being edited (null = none). */
  editingField: string | null;
  /** Passed through to editors for type-to-edit seeding. */
  cursorInitial: string | undefined;
  /** Returns true when (this row, field) is inside the current range selection. */
  cellInRange: (field: string) => boolean;
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
  } = props;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      className={cx(
        "relative group grid items-stretch border-b border-line transition-colors",
        selected ? "bg-surface-2" : "hover:bg-hover",
      )}
      style={gridStyle}
      data-row={rk}
    >
      {activityEntry && <RowActivityBadge entry={activityEntry} />}
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
        const inRangeCell = cellInRange(c.field);
        const value = getValue(row, c.field);
        const ctx = { row, rowKey: rk, field: c.field, value, focused, column: c };
        const isLastCol = idx === columns.length - 1;
        const isFirstPinned = c.pinnedLeft && !columns.slice(0, idx).some((x) => x.pinnedLeft);
        const cellCx = cx(
          "relative flex min-w-0 select-none items-center px-3",
          cellPadY,
          !isLastCol && "border-r border-line",
          c.align === "right" && "justify-end text-right",
          inRangeCell && !focused && "bg-accent/10",
          focused && "ring-2 ring-accent ring-inset",
          isFirstPinned && "sticky left-0 z-[5] bg-[var(--surface)]",
          isFirstPinned && selected && "!bg-[var(--surface-2)]",
        );
        const ruleStyle: RuleStyle | undefined = evaluation.cellStyles.get(c.field);
        const cellInlineStyle: React.CSSProperties = {};
        if (ruleStyle?.cellBg)
          cellInlineStyle.background = `color-mix(in srgb,var(--tint-${ruleStyle.cellBg}) 18%,transparent)`;
        if (ruleStyle?.textColor) cellInlineStyle.color = `var(--tint-${ruleStyle.textColor})`;
        const data = `${rk}::${c.field}`;
        return (
          <div
            key={c.field}
            ref={editing ? editingCellRef : undefined}
            role="gridcell"
            aria-colindex={idx + 1}
            aria-selected={focused ? true : undefined}
            data-cell={data}
            onPointerDown={(e) => onCellPointerDown(e, rk, c.field)}
            onDoubleClick={() => onCellDoubleClick(rk, c.field)}
            className={cellCx}
            style={Object.keys(cellInlineStyle).length > 0 ? cellInlineStyle : undefined}
          >
            {editing && c.editable !== false ? (
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
                    if (!onAddColumnOption)
                      return c.config.type === "select" ? c.config.options : [];
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
const GridRow = React.memo(GridRowInner) as <Row>(props: GridRowProps<Row>) => React.ReactElement;

const FIELD_TYPE_ICONS: Record<CellType, React.ComponentType<{ className?: string }>> = {
  text: IconFieldText,
  number: IconFieldNumber,
  boolean: IconFieldBoolean,
  date: IconFieldDate,
  select: IconFieldSelect,
  url: IconFieldUrl,
  email: IconFieldEmail,
  rating: IconFieldRating,
  linked: IconFieldLinked,
};

const CELLS: Record<Exclude<CellType, "select" | "linked">, { Renderer: any; Editor: any }> = {
  text: TextCell,
  number: NumberCell,
  boolean: BooleanCell,
  date: DateCell,
  url: UrlCell,
  email: EmailCell,
  rating: RatingCell,
};

// ── Range selection types ───────────────────────────────────────────────────
interface RangeCorner {
  rowKey: string;
  field: string;
}
interface RangeState {
  anchor: RangeCorner;
  focus: RangeCorner;
}

// Escape a string for use inside a double-quoted CSS attribute selector.
const attrEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
// Brief accent-wash on a cell after a bulk action (paste-fill / clear-range)
// so the user sees what the keystroke just did. Deferred to the next frame
// so React has rendered the new value first.
function flashCell(rk: string, field: string): void {
  requestAnimationFrame(() => {
    const sel = `[data-cell="${attrEsc(`${rk}::${field}`)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.classList.remove("zz-row-flash");
    void el.offsetWidth;
    el.classList.add("zz-row-flash");
    window.setTimeout(() => el.classList.remove("zz-row-flash"), 1700);
  });
}

// ── FillHandle — absolutely-positioned 8×8 accent square ────────────────────
function FillHandle({
  targetSelector,
  containerRef,
  onPointerDown,
  dragging,
}: {
  targetSelector: string;
  containerRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent) => void;
  dragging: boolean;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const target = container.querySelector<HTMLElement>(targetSelector);
      if (!target) {
        setPos(null);
        return;
      }
      const cRect = container.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      setPos({
        top: tRect.bottom - cRect.top + container.scrollTop - 4,
        left: tRect.right - cRect.left + container.scrollLeft - 4,
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    container.addEventListener("scroll", update);
    return () => {
      ro.disconnect();
      container.removeEventListener("scroll", update);
    };
  }, [targetSelector, containerRef]);
  if (!pos) return null;
  return (
    <div
      data-fill-handle="true"
      onPointerDown={onPointerDown}
      style={{ position: "absolute", top: pos.top, left: pos.left, width: 8, height: 8 }}
      className={cx(
        "z-20 cursor-crosshair rounded-sm bg-accent",
        dragging && "scale-125 shadow-pop",
      )}
    />
  );
}

export function DataGrid<Row>(props: DataGridProps<Row>) {
  const {
    rows,
    rowKey,
    columns,
    selection,
    onCommit,
    empty,
    onAddFieldClick,
    addFieldRef,
    activity,
  } = props;
  const visible = columns.filter((c) => !c.hidden);
  const selectionCol = !!selection;
  const showRowNumbers = !!props.showRowNumbers;
  const compact = props.density === "compact";
  const cellPadY = compact ? "py-[3px]" : "py-[7px]";
  const headerPadY = compact ? "py-[5px]" : "py-2";
  const undo = useUndoStack();

  // Typed cell-value accessor: uses the prop if provided, otherwise falls back
  // to a plain property lookup via Record<string, unknown> — no more `as any`.
  const propGetValue = props.getValue;
  const getValue = useCallback(
    (row: Row, field: string): unknown => {
      if (propGetValue) return propGetValue(row, field);
      return (row as Record<string, unknown>)[field];
    },
    [propGetValue],
  );

  // ── Sort + filter state ─────────────────────────────────────────────────────
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  const [filterSet, setFilterSet] = useState<FilterSet | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [rulesEditor, setRulesEditor] = useState<string | null>(null);
  const [descEditor, setDescEditor] = useState<string | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  // When a popover (ColumnHeaderMenu / ConditionalFormatPopover / FieldDescriptionEditor) is opened
  // from the right-click context menu, anchor at the click point rather than at the column header.
  // Zero-width/height rect ⇒ the popover positioning logic switches to point-anchored mode
  // (open at the cursor, expanding right + down). Cleared on close so the next ⋯ button open
  // falls back to element-anchored positioning.
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const hiddenAnchorRef = useRef<HTMLButtonElement | null>(null);
  const hiddenList = useMemo(() => columns.filter((c) => c.hidden), [columns]);

  const filteredRows = useMemo(() => {
    if (!filterSet || filterSet.conditions.length === 0) return rows;
    const { conjunction, conditions } = filterSet;
    const match = (r: Row) => {
      const check = conditions.map((cond): boolean => {
        const raw = getValue(r, cond.field);
        const str = raw == null ? "" : String(raw).toLowerCase();
        const needle = cond.value.toLowerCase();
        switch (cond.operator) {
          case "contains":
            return str.includes(needle);
          case "not_contains":
            return !str.includes(needle);
          case "equals":
            return str === needle;
          case "not_equals":
            return str !== needle;
          case "starts_with":
            return str.startsWith(needle);
          case "ends_with":
            return str.endsWith(needle);
          case "is_empty":
            return raw == null || String(raw) === "";
          case "is_not_empty":
            return raw != null && String(raw) !== "";
          default:
            return true;
        }
      });
      return conjunction === "and" ? check.every(Boolean) : check.some(Boolean);
    };
    return rows.filter(match);
  }, [rows, filterSet, getValue]);

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const sign = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: Row, b: Row) => {
      const av = getValue(a, sort.field);
      const bv = getValue(b, sort.field);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
      return String(av ?? "").localeCompare(String(bv ?? "")) * sign;
    };
    return [...filteredRows].sort(cmp);
  }, [filteredRows, sort, getValue]);

  // ── Task 20: per-column widths ──────────────────────────────────────────────
  const [widths, setWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(visible.filter((c) => c.width).map((c) => [c.field, c.width!])),
  );

  const colWidth = (field: string) =>
    widths[field] ?? visible.find((c) => c.field === field)?.width;

  // ── Task 21: column order + drag state ─────────────────────────────────────
  const [order, setOrder] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<{ field: string; overIndex: number | null } | null>(null);
  // ref mirror of `drag` so onPointerDown's closed-over onMove can read the
  // live value (the hold-timer starts AFTER pointerdown — at pointerdown
  // time, `drag` is null in the closure)
  const dragRef = useRef(drag);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  // resolved visible columns honor `order` if set; otherwise prop order
  const orderedVisible = useMemo(() => {
    if (!order) return visible;
    const byField = new Map(visible.map((c) => [c.field, c]));
    const out: typeof visible = [];
    for (const f of order) {
      const c = byField.get(f);
      if (c) out.push(c);
    }
    // append columns that aren't in `order` yet (newly added)
    for (const c of visible) if (!order.includes(c.field)) out.push(c);
    return out;
  }, [visible, order]);

  // template: optional checkbox + each visible column's width (uses orderedVisible)
  const gridStyle = useMemo(() => {
    const tracks = orderedVisible.map((c) => {
      const w = colWidth(c.field);
      return w ? `${w}px` : "minmax(96px, 1fr)";
    });
    if (selectionCol) tracks.unshift("28px");
    if (showRowNumbers) tracks.unshift("36px");
    if (onAddFieldClick) tracks.push("auto");
    return { gridTemplateColumns: tracks.join(" ") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedVisible, selectionCol, showRowNumbers, widths, onAddFieldClick]);

  // pending edit value lives inside the editor; commit flows back via the props.onCommit
  const commitValue = useCallback(
    async (rk: string, field: string, value: unknown) => {
      if (onCommit) await onCommit(rk, field, value);
    },
    [onCommit],
  );

  // ── Range selection state ───────────────────────────────────────────────────
  // anchor stays fixed while shift-extending; focus tracks the moving corner.
  const [range, setRange] = useState<RangeState | null>(null);
  // ref mirror so pointer-move handlers can read live state without stale closures
  const rangeRef = useRef(range);
  useEffect(() => {
    rangeRef.current = range;
  }, [range]);

  // whether we are currently drag-selecting
  const draggingRange = useRef(false);

  // Build index maps for O(1) position lookups
  const rowIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    sortedRows.forEach((r, i) => m.set(rowKey(r), i));
    return m;
  }, [sortedRows, rowKey]);

  const colIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    orderedVisible.forEach((c, i) => m.set(c.field, i));
    return m;
  }, [orderedVisible]);

  // Given anchor + focus corners, compute the row/col index bounding box
  const computeRangeBounds = useCallback(
    (r: RangeState) => {
      const ar = rowIndexMap.get(r.anchor.rowKey) ?? 0;
      const fr = rowIndexMap.get(r.focus.rowKey) ?? 0;
      const ac = colIndexMap.get(r.anchor.field) ?? 0;
      const fc = colIndexMap.get(r.focus.field) ?? 0;
      return {
        minRow: Math.min(ar, fr),
        maxRow: Math.max(ar, fr),
        minCol: Math.min(ac, fc),
        maxCol: Math.max(ac, fc),
      };
    },
    [rowIndexMap, colIndexMap],
  );

  // Returns true if (rowKey, field) falls inside the current range
  const inRange = useCallback(
    (rk: string, field: string): boolean => {
      if (!range) return false;
      const ri = rowIndexMap.get(rk);
      const ci = colIndexMap.get(field);
      if (ri == null || ci == null) return false;
      const { minRow, maxRow, minCol, maxCol } = computeRangeBounds(range);
      return ri >= minRow && ri <= maxRow && ci >= minCol && ci <= maxCol;
    },
    [range, rowIndexMap, colIndexMap, computeRangeBounds],
  );

  // ── Fill handle hook ────────────────────────────────────────────────────────
  const fillHandle = useFillHandle({
    range,
    sortedRows,
    rowKey,
    orderedVisible,
    rowIndexMap,
    getValue,
    commitValue,
    setRange,
    beginTransaction: undo.beginTransaction,
    endTransaction: undo.endTransaction,
    flashCell,
  });

  // Selector for the bottom-right cell of the current range (used to anchor
  // the fill handle square). Recalculated whenever the range changes.
  const fillHandlePos = useMemo(() => {
    if (!range) return null;
    const bounds = computeRangeBounds(range);
    const lastRow = sortedRows[bounds.maxRow];
    const lastCol = orderedVisible[bounds.maxCol];
    if (!lastRow || !lastCol) return null;
    return `[data-cell="${attrEsc(`${rowKey(lastRow)}::${lastCol.field}`)}"]`;
  }, [range, sortedRows, orderedVisible, rowKey, computeRangeBounds]);

  // ── Conditional formatting ─────────────────────────────────────────────────
  const condFmt = useConditionalFormatting(orderedVisible, getValue);

  const statusAgg = useMemo(() => {
    if (!range) return null;
    const b = computeRangeBounds(range);
    const cellCount = (b.maxRow - b.minRow + 1) * (b.maxCol - b.minCol + 1);
    if (cellCount <= 1) return null;
    return computeAggregates(sortedRows, orderedVisible, getValue, b);
  }, [range, sortedRows, orderedVisible, getValue, computeRangeBounds]);

  // ── Cursor ─────────────────────────────────────────────────────────────────
  const cursor = useGridCursor({
    rows: sortedRows,
    rowKey,
    columns: orderedVisible,
    getValue,
    onCommit: () => {
      /* the editor's onBlur handles the actual value commit */
    },
    onSelectAll: () => {
      // Cmd+A: select entire grid as range
      const firstRow = sortedRows[0];
      const lastRow = sortedRows[sortedRows.length - 1];
      const firstCol = orderedVisible[0];
      const lastCol = orderedVisible[orderedVisible.length - 1];
      if (firstRow && lastRow && firstCol && lastCol) {
        const anchorCorner = { rowKey: rowKey(firstRow), field: firstCol.field };
        const focusCorner = { rowKey: rowKey(lastRow), field: lastCol.field };
        setRange({ anchor: anchorCorner, focus: focusCorner });
        cursor.setCursor({
          rowKey: anchorCorner.rowKey,
          field: anchorCorner.field,
          editing: false,
        });
      }
    },
    onUndo: () => undo.undo(),
    onRedo: () => undo.redo(),
  });

  // ── Virtualiser ────────────────────────────────────────────────────────────
  const estimatedRowHeight = compact ? 26 : 38;
  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => cursor.ref.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 5,
  });

  // Scroll the cursor row into view when it changes.
  // Step 1: bring the row into the virtualiser's render window (vertical).
  // Step 2 (rAF): once React has rendered the row, scroll the cell for
  // horizontal alignment using scrollIntoView.
  useEffect(() => {
    const rk = cursor.cursor?.rowKey;
    const field = cursor.cursor?.field;
    if (!rk) return;
    const idx = rowIndexMap.get(rk);
    if (idx == null) return;
    virtualizer.scrollToIndex(idx, { align: "auto" });
    requestAnimationFrame(() => {
      const el = cursor.ref.current?.querySelector<HTMLElement>(
        `[data-cell="${attrEsc(`${rk}::${field ?? ""}`)}"]`,
      );
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor.cursor?.rowKey, cursor.cursor?.field]);

  // Keep range anchor in sync when cursor moves without shift (range collapses)
  // We handle this explicitly in the key handler below, not via useEffect, to
  // avoid fighting with the cursor state.

  // ── Copy (Cmd+C) ───────────────────────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    if (!range) {
      // single-cell copy: use cursor
      if (!cursor.cursor) return;
      const { rowKey: rk, field } = cursor.cursor;
      const row = sortedRows.find((r) => rowKey(r) === rk);
      if (!row) return;
      const val = getValue(row, field);
      const text = val == null ? "" : String(val);
      await navigator.clipboard.writeText(text);
      return;
    }
    const { minRow, maxRow, minCol, maxCol } = computeRangeBounds(range);
    const lines: string[] = [];
    for (let ri = minRow; ri <= maxRow; ri++) {
      const row = sortedRows[ri];
      if (!row) continue;
      const cells: string[] = [];
      for (let ci = minCol; ci <= maxCol; ci++) {
        const col = orderedVisible[ci];
        if (!col) continue;
        const val = getValue(row, col.field);
        cells.push(val == null ? "" : String(val));
      }
      lines.push(cells.join("\t"));
    }
    await navigator.clipboard.writeText(lines.join("\n"));
  }, [range, cursor.cursor, sortedRows, rowKey, orderedVisible, computeRangeBounds, getValue]);

  // Coerce a raw clipboard string into the column's expected type. Returns
  // `undefined` to mean "skip this cell" (unparseable / not a valid option).
  const coerceForColumn = useCallback(
    (rawVal: string, col: (typeof orderedVisible)[number]): unknown => {
      switch (col.config.type) {
        case "number": {
          const n = Number(rawVal);
          return isNaN(n) ? null : n;
        }
        case "boolean":
          return rawVal.toLowerCase() === "true";
        case "select": {
          const match = col.config.options.find((o) => o.label === rawVal);
          if (!match) return undefined;
          return rawVal;
        }
        case "rating": {
          const n = parseInt(rawVal, 10);
          return isNaN(n) ? null : n;
        }
        case "text":
        case "url":
        case "email":
        case "date":
        case "linked":
          return rawVal;
        default:
          col.config satisfies never;
          return rawVal;
      }
    },
    [],
  );

  // ── Paste (Cmd+V) ──────────────────────────────────────────────────────────
  // Two modes:
  //   1. Single-value clipboard + multi-cell range selected → fill the range
  //      with that value (spreadsheet fill behavior).
  //   2. Tabular clipboard → paste the source TSV grid starting at the anchor.
  const handlePaste = useCallback(async () => {
    if (!cursor.cursor) return;
    const text = await navigator.clipboard.readText();
    if (!text) return;
    // Trim trailing newline so single-value paste from a copy of one cell
    // doesn't look like two rows.
    const trimmed = text.replace(/\n$/, "");
    const pasteRows = trimmed.split("\n").map((line) => line.split("\t"));
    const isSingleValue = pasteRows.length === 1 && (pasteRows[0]?.length ?? 0) === 1;
    const rangeBig =
      range &&
      (range.anchor.rowKey !== range.focus.rowKey || range.anchor.field !== range.focus.field);

    // Collect target cells; commit them inside a single undo transaction so
    // the whole paste is one Cmd+Z step, not one per cell.
    const writes: Array<{ rk: string; field: string; value: unknown }> = [];

    if (isSingleValue && rangeBig && range) {
      // Mode 1: fill the selected range with the single clipboard value.
      const rawVal = pasteRows[0][0] ?? "";
      const { minRow, maxRow, minCol, maxCol } = computeRangeBounds(range);
      for (let ri = minRow; ri <= maxRow; ri++) {
        const row = sortedRows[ri];
        if (!row) continue;
        const rk = rowKey(row);
        for (let ci = minCol; ci <= maxCol; ci++) {
          const col = orderedVisible[ci];
          if (!col || col.editable === false) continue;
          const coerced = coerceForColumn(rawVal, col);
          if (coerced === undefined) continue;
          writes.push({ rk, field: col.field, value: coerced });
        }
      }
    } else {
      // Mode 2: tabular paste from anchor (default spreadsheet behavior).
      const anchorRk = range?.anchor.rowKey ?? cursor.cursor.rowKey;
      const anchorField = range?.anchor.field ?? cursor.cursor.field;
      const startRowIdx = rowIndexMap.get(anchorRk) ?? 0;
      const startColIdx = colIndexMap.get(anchorField) ?? 0;

      for (let pr = 0; pr < pasteRows.length; pr++) {
        const targetRowIdx = startRowIdx + pr;
        if (targetRowIdx >= sortedRows.length) break;
        const targetRow = sortedRows[targetRowIdx];
        if (!targetRow) continue;
        const targetRk = rowKey(targetRow);
        const pasteRow = pasteRows[pr];
        if (!pasteRow) continue;

        for (let pc = 0; pc < pasteRow.length; pc++) {
          const targetColIdx = startColIdx + pc;
          if (targetColIdx >= orderedVisible.length) break;
          const col = orderedVisible[targetColIdx];
          if (!col || col.editable === false) continue;
          const coerced = coerceForColumn(pasteRow[pc] ?? "", col);
          if (coerced === undefined) continue;
          writes.push({ rk: targetRk, field: col.field, value: coerced });
        }
      }
    }

    if (writes.length === 0) return;
    const label =
      isSingleValue && rangeBig
        ? `fill ${writes.length} cell${writes.length === 1 ? "" : "s"}`
        : `paste ${writes.length} cell${writes.length === 1 ? "" : "s"}`;
    undo.beginTransaction(label);
    void Promise.all(writes.map((w) => commitValue(w.rk, w.field, w.value)))
      .catch((err) => {
        console.error(`DataGrid: ${label} failed`, err);
      })
      .finally(() => {
        undo.endTransaction();
        for (const w of writes) flashCell(w.rk, w.field);
      });
  }, [
    cursor.cursor,
    range,
    sortedRows,
    rowKey,
    orderedVisible,
    rowIndexMap,
    colIndexMap,
    commitValue,
    computeRangeBounds,
    coerceForColumn,
    undo,
  ]);

  // ── Context menu ────────────────────────────────────────────────────────────
  const { menu: contextMenu, onContextMenu, close: closeMenu } = useContextMenu();

  const buildMenuItems = (surface: ContextSurface): MenuItem[] => {
    if (surface.kind === "cell") {
      const { rowKey: rk, field } = surface;
      const row = sortedRows.find((r) => rowKey(r) === rk);
      const value = row ? getValue(row, field) : null;
      const valStr = value == null ? "" : String(value);
      return [
        { label: "Copy", onClick: () => void handleCopy() },
        { label: "Paste", onClick: () => void handlePaste() },
        { label: "Clear", onClick: () => void commitValue(rk, field, null) },
        { separator: true, label: "", onClick: () => {} },
        {
          label: `Filter to "${valStr.slice(0, 24)}"`,
          onClick: () => {
            setFilterSet((cur) => ({
              conjunction: cur?.conjunction ?? "and",
              conditions: [
                ...(cur?.conditions ?? []),
                {
                  id: `${field}-eq-${Date.now()}`,
                  field,
                  operator: "equals" as const,
                  value: valStr,
                },
              ],
            }));
          },
        },
        {
          label: `Filter to NOT "${valStr.slice(0, 24)}"`,
          onClick: () => {
            setFilterSet((cur) => ({
              conjunction: cur?.conjunction ?? "and",
              conditions: [
                ...(cur?.conditions ?? []),
                {
                  id: `${field}-neq-${Date.now()}`,
                  field,
                  operator: "not_equals" as const,
                  value: valStr,
                },
              ],
            }));
          },
        },
        { separator: true, label: "", onClick: () => {} },
        {
          label: "Insert row above",
          onClick: () => props.onInsertRow?.(rk, "above"),
          disabled: !props.onInsertRow,
        },
        {
          label: "Insert row below",
          onClick: () => props.onInsertRow?.(rk, "below"),
          disabled: !props.onInsertRow,
        },
        {
          label: "Delete row",
          onClick: () => props.onDeleteRow?.(rk),
          disabled: !props.onDeleteRow,
        },
      ];
    }
    if (surface.kind === "header") {
      const c = orderedVisible.find((col) => col.field === surface.field);
      return [
        { label: "Sort ascending", onClick: () => setSort({ field: surface.field, dir: "asc" }) },
        { label: "Sort descending", onClick: () => setSort({ field: surface.field, dir: "desc" }) },
        {
          label: "Rename",
          onClick: () => {
            if (contextMenu) setMenuAnchorRect(new DOMRect(contextMenu.x, contextMenu.y, 0, 0));
            setMenuFor(surface.field);
          },
        },
        {
          label: "Change type",
          onClick: () => {
            if (contextMenu) setMenuAnchorRect(new DOMRect(contextMenu.x, contextMenu.y, 0, 0));
            setMenuFor(surface.field);
          },
          disabled: !props.onChangeColumnType,
        },
        { separator: true, label: "", onClick: () => {} },
        {
          label: "Conditional formatting…",
          onClick: () => {
            if (contextMenu) setMenuAnchorRect(new DOMRect(contextMenu.x, contextMenu.y, 0, 0));
            setRulesEditor(surface.field);
          },
          disabled: !props.onSaveColumnRules,
        },
        {
          label: "Edit description",
          onClick: () => {
            if (contextMenu) setMenuAnchorRect(new DOMRect(contextMenu.x, contextMenu.y, 0, 0));
            setDescEditor(surface.field);
          },
          disabled: !props.onSaveColumnDescription,
        },
        { separator: true, label: "", onClick: () => {} },
        {
          label: "Hide column",
          onClick: () => {
            const hidden = [...columns.filter((v) => v.hidden).map((v) => v.field), surface.field];
            props.onLayoutChange?.({ hidden });
          },
        },
        {
          label: "Delete column",
          onClick: () => props.onDeleteColumn?.(surface.field),
          disabled: !props.onDeleteColumn || !!c?.pinnedLeft,
        },
      ];
    }
    if (surface.kind === "row-num") {
      const rk = surface.rowKey;
      return [
        {
          label: "Select row",
          onClick: () => {
            const firstCol = orderedVisible[0],
              lastCol = orderedVisible[orderedVisible.length - 1];
            if (firstCol && lastCol)
              setRange({
                anchor: { rowKey: rk, field: firstCol.field },
                focus: { rowKey: rk, field: lastCol.field },
              });
          },
        },
        {
          label: "Insert above",
          onClick: () => props.onInsertRow?.(rk, "above"),
          disabled: !props.onInsertRow,
        },
        {
          label: "Insert below",
          onClick: () => props.onInsertRow?.(rk, "below"),
          disabled: !props.onInsertRow,
        },
        {
          label: "Duplicate",
          onClick: () => props.onDuplicateRow?.(rk),
          disabled: !props.onDuplicateRow,
        },
        { label: "Delete", onClick: () => props.onDeleteRow?.(rk), disabled: !props.onDeleteRow },
      ];
    }
    return [];
  };

  // ── Grid-level keyboard handler (layered on top of cursor.onKeyDown) ────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const cur = cursor.cursor;

      // While editing, let the cursor handler own everything
      if (cur?.editing) {
        cursor.onKeyDown(e);
        return;
      }

      // Cmd+C
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void handleCopy();
        return;
      }

      // Cmd+V
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void handlePaste();
        return;
      }

      // Cmd+A: select all rows via the row-checkbox selection (when not editing)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && selection) {
        e.preventDefault();
        const allRowKeys = sortedRows.map(rowKey);
        selection.onChange(allRowKeys);
        return;
      }

      // Delete / Backspace (without Cmd): clear focused cell or range to null.
      // Cmd+Backspace falls through to the cursor handler for bulk row delete.
      if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const targets: Array<{ rk: string; field: string }> = [];
        if (range) {
          const { minRow, maxRow, minCol, maxCol } = computeRangeBounds(range);
          for (let ri = minRow; ri <= maxRow; ri++) {
            const row = sortedRows[ri];
            if (!row) continue;
            const rk = rowKey(row);
            for (let ci = minCol; ci <= maxCol; ci++) {
              const col = orderedVisible[ci];
              if (!col || col.editable === false) continue;
              targets.push({ rk, field: col.field });
            }
          }
        } else if (cur) {
          const col = orderedVisible.find((c) => c.field === cur.field);
          if (col && col.editable !== false) {
            targets.push({ rk: cur.rowKey, field: cur.field });
          }
        }
        if (targets.length === 0) return;
        // Coalesce all host undo.push() calls into a single compound entry so
        // one Cmd+Z restores the whole range, not cell-by-cell.
        const label = targets.length === 1 ? "clear cell" : `clear ${targets.length} cells`;
        undo.beginTransaction(label);
        void Promise.all(targets.map((t) => commitValue(t.rk, t.field, null)))
          .catch((err) => {
            console.error(`DataGrid: ${label} failed`, err);
          })
          .finally(() => {
            undo.endTransaction();
            for (const t of targets) flashCell(t.rk, t.field);
          });
        return;
      }

      // Shift+Arrow: extend range, keep anchor (exclude meta so ⌘⇧+Arrow falls through to isShiftMetaArrow)
      const isShiftArrow =
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight");

      if (isShiftArrow && cur) {
        e.preventDefault();
        const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;

        // Current focus position (use range focus if range is active, else cursor)
        const focusRk = range?.focus.rowKey ?? cur.rowKey;
        const focusField = range?.focus.field ?? cur.field;

        const ri = rowIndexMap.get(focusRk) ?? 0;
        const ci = colIndexMap.get(focusField) ?? 0;
        const nr = Math.max(0, Math.min(sortedRows.length - 1, ri + dy));
        const nc = Math.max(0, Math.min(orderedVisible.length - 1, ci + dx));
        const newFocusRow = sortedRows[nr];
        const newFocusCol = orderedVisible[nc];
        if (!newFocusRow || !newFocusCol) return;

        const newFocus = { rowKey: rowKey(newFocusRow), field: newFocusCol.field };
        // Establish anchor if range not yet active
        const currentAnchor = range?.anchor ?? { rowKey: cur.rowKey, field: cur.field };
        setRange({ anchor: currentAnchor, focus: newFocus });
        // Move the cursor focus cell too (visual feedback)
        cursor.setCursor({ rowKey: newFocus.rowKey, field: newFocus.field, editing: false });
        return;
      }

      // Shift+Cmd+Arrow: extend range to data edge
      const isShiftMetaArrow =
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight");

      if (isShiftMetaArrow && cur) {
        e.preventDefault();
        const focusRk = range?.focus.rowKey ?? cur.rowKey;
        const focusField = range?.focus.field ?? cur.field;
        const fr = rowIndexMap.get(focusRk) ?? 0;
        const navFc = cursor.navCols.findIndex((c) => c.field === focusField);
        if (navFc < 0) {
          // Focus column isn't navigable (hidden/non-editable) — delegate to cursor handler
          cursor.onKeyDown(e);
          return;
        }
        const dir =
          e.key === "ArrowUp"
            ? "up"
            : e.key === "ArrowDown"
              ? "down"
              : e.key === "ArrowLeft"
                ? "left"
                : "right";
        const target = cursor.findEdge(sortedRows, cursor.navCols, getValue, fr, navFc, dir);
        const newFocusRow = sortedRows[target.row];
        const newFocusCol = cursor.navCols[target.col];
        if (!newFocusRow || !newFocusCol) return;
        const newFocus = { rowKey: rowKey(newFocusRow), field: newFocusCol.field };
        const currentAnchor = range?.anchor ?? { rowKey: cur.rowKey, field: cur.field };
        setRange({ anchor: currentAnchor, focus: newFocus });
        cursor.setCursor({ rowKey: newFocus.rowKey, field: newFocus.field, editing: false });
        return;
      }

      // Escape: collapse range to anchor
      if (e.key === "Escape" && range) {
        e.preventDefault();
        cursor.setCursor({
          rowKey: range.anchor.rowKey,
          field: range.anchor.field,
          editing: false,
        });
        setRange(null);
        return;
      }

      // Non-shift arrow / all other keys: collapse range and let cursor handle
      if (
        !e.shiftKey &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight")
      ) {
        setRange(null);
      }

      cursor.onKeyDown(e);
    },
    [
      cursor,
      range,
      handleCopy,
      handlePaste,
      rowIndexMap,
      colIndexMap,
      sortedRows,
      orderedVisible,
      rowKey,
      getValue,
      undo,
      commitValue,
      computeRangeBounds,
      selection,
    ],
  );

  const isSelected = (rk: string) => selection?.selected.includes(rk) ?? false;

  const onToggleSelect = useCallback(
    (rk: string) => {
      if (!selection) return;
      const next = selection.selected.includes(rk)
        ? selection.selected.filter((x) => x !== rk)
        : [...selection.selected, rk];
      selection.onChange(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection?.selected, selection?.onChange],
  );

  const onCellDoubleClick = useCallback(
    (rk: string, field: string) => {
      const col = orderedVisible.find((c) => c.field === field);
      if (col?.editable === false) return;
      cursor.setCursor({ rowKey: rk, field, editing: true });
      setRange(null);
    },
    [orderedVisible, cursor],
  );

  const onStopEdit = useCallback(() => cursor.stopEdit(), [cursor]);

  // ── Row-number click → select whole row ────────────────────────────────────
  const onRowNumPointerDown = useCallback(
    (e: React.PointerEvent, rk: string) => {
      if (e.button !== 0) return;
      cursor.ref.current?.focus();
      const firstCol = orderedVisible[0];
      const lastCol = orderedVisible[orderedVisible.length - 1];
      if (!firstCol || !lastCol) return;
      if (e.shiftKey && rangeRef.current) {
        setRange({ anchor: rangeRef.current.anchor, focus: { rowKey: rk, field: lastCol.field } });
      } else {
        setRange({
          anchor: { rowKey: rk, field: firstCol.field },
          focus: { rowKey: rk, field: lastCol.field },
        });
      }
      cursor.setCursor({ rowKey: rk, field: firstCol.field, editing: false });
      e.preventDefault();
    },
    [cursor, orderedVisible],
  );

  // ── Pointer handlers for drag-select ───────────────────────────────────────
  const onCellPointerDown = useCallback(
    (e: React.PointerEvent, rk: string, field: string) => {
      // Only primary button; ignore while column-drag is active
      if (e.button !== 0 || drag) return;
      if (cursor.cursor?.editing) return;

      // Focus the workbench so ⌘C / ⌘V / ⌘A / arrow keys reach handleKeyDown.
      // tabIndex={0} makes the div focusable but click-on-child doesn't auto-focus.
      cursor.ref.current?.focus();

      if (e.shiftKey && cursor.cursor) {
        // Shift+click: extend range from existing anchor
        const currentAnchor = range?.anchor ?? {
          rowKey: cursor.cursor.rowKey,
          field: cursor.cursor.field,
        };
        const newFocus = { rowKey: rk, field };
        setRange({ anchor: currentAnchor, focus: newFocus });
        cursor.setCursor({ rowKey: rk, field, editing: false });
        e.preventDefault();
        return;
      }

      // (text-selection is suppressed via the cell's `select-none` className,
      // not preventDefault — preventDefault on pointerdown also cancels the
      // subsequent click + dblclick, breaking the edit affordance.)

      // Start a new range at the clicked cell
      const corner = { rowKey: rk, field };
      setRange({ anchor: corner, focus: corner });
      cursor.setCursor({ rowKey: rk, field, editing: false });
      draggingRange.current = true;

      const onMove = (ev: PointerEvent) => {
        if (!draggingRange.current) return;
        const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const cellEl = target?.closest<HTMLElement>("[data-cell]");
        if (!cellEl) return;
        const data = cellEl.dataset.cell;
        if (!data) return;
        const sep = data.indexOf("::");
        if (sep < 0) return;
        const focusRk = data.slice(0, sep);
        const focusField = data.slice(sep + 2);
        setRange((prev) => {
          if (!prev) return prev;
          return { anchor: prev.anchor, focus: { rowKey: focusRk, field: focusField } };
        });
        cursor.setCursor({ rowKey: focusRk, field: focusField, editing: false });
      };

      const onUp = () => {
        draggingRange.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [cursor, range, drag],
  );

  return (
    <div className="relative flex flex-1 flex-col min-h-0 overflow-hidden rounded-lg border border-line bg-surface focus-within:ring-1 focus-within:ring-accent/40">
      {filterSet && filterSet.conditions.length > 0 && (
        <FilterBar filterSet={filterSet} columns={orderedVisible} onChange={setFilterSet} />
      )}
      <div
        ref={cursor.ref}
        tabIndex={0}
        role="grid"
        aria-rowcount={sortedRows.length + 1}
        aria-colcount={orderedVisible.length}
        onKeyDown={handleKeyDown}
        onContextMenu={onContextMenu}
        className="relative flex flex-1 flex-col min-h-0 overflow-x-auto overflow-y-auto outline-none"
      >
        {fillHandlePos && (
          <FillHandle
            targetSelector={fillHandlePos}
            containerRef={cursor.ref}
            onPointerDown={fillHandle.onHandlePointerDown}
            dragging={fillHandle.dragging}
          />
        )}
        {/* header row */}
        <div
          role="row"
          aria-rowindex={1}
          className="grid sticky top-0 z-10 items-stretch border-b border-line bg-surface text-[12px] font-medium text-ink-2"
          style={gridStyle}
        >
          {showRowNumbers && (
            <div
              className={cx(
                "flex items-center justify-end border-r border-line pr-2 font-mono text-[10px] text-ink-3",
                headerPadY,
              )}
            >
              #
            </div>
          )}
          {selectionCol && (
            <div
              className={cx("flex items-center justify-center border-r border-line", headerPadY)}
            >
              <Checkbox
                state={
                  selection!.selected.length === sortedRows.length && sortedRows.length > 0
                    ? "on"
                    : selection!.selected.length > 0
                      ? "mixed"
                      : "off"
                }
                onClick={() =>
                  selection!.onChange(
                    selection!.selected.length === sortedRows.length ? [] : sortedRows.map(rowKey),
                  )
                }
                aria-label="Select all"
              />
            </div>
          )}
          {orderedVisible.map((c, idx) => {
            const sortGlyph = sort?.field === c.field ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
            const TypeIcon = FIELD_TYPE_ICONS[c.config.type];
            const isLastCol = idx === orderedVisible.length - 1;
            return (
              <div
                key={c.field}
                role="columnheader"
                aria-colindex={idx + 1}
                aria-sort={
                  sort?.field === c.field
                    ? sort.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className={cx(
                  "group relative flex items-center gap-1.5 px-3",
                  headerPadY,
                  !isLastCol && "border-r border-line",
                  c.pinnedLeft && idx === 0 && "sticky left-0 z-10 bg-surface",
                )}
                data-header={c.field}
              >
                {TypeIcon && <TypeIcon className="h-3.5 w-3.5 shrink-0 text-ink-3" />}
                {/* Task 21: dragged-column wash + drop-target line */}
                {drag?.field === c.field && (
                  <span className="absolute inset-0 bg-accent-wash" aria-hidden />
                )}
                {drag?.overIndex != null && orderedVisible[drag.overIndex]?.field === c.field && (
                  <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" aria-hidden />
                )}

                {/* Task 21: hold-then-drag label — always left-aligned, even on
                  right-aligned (numeric) columns. Spreadsheet convention:
                  headers read uniformly left-to-right while the body cells
                  themselves right-align their numbers for tabular comparison. */}
                <span
                  className={cx(
                    "min-w-0 flex-1 truncate cursor-grab select-none",
                    c.pinnedLeft && "cursor-default",
                  )}
                  onPointerDown={(_e) => {
                    if (c.pinnedLeft) return;
                    let holding = true;
                    let moved = false;
                    const startTime = Date.now();
                    const holdTimer = window.setTimeout(() => {
                      if (!holding) return;
                      setDrag({ field: c.field, overIndex: null });
                    }, 200);
                    const onMove = (ev: PointerEvent) => {
                      moved = true;
                      if (!dragRef.current) return;
                      // determine which header column we're over via element-at-point
                      const target = document.elementFromPoint(
                        ev.clientX,
                        ev.clientY,
                      ) as HTMLElement | null;
                      const headerEl = target?.closest<HTMLElement>("[data-header]");
                      const overField = headerEl?.dataset.header ?? null;
                      if (overField == null) return;
                      const next = orderedVisible.findIndex((x) => x.field === overField);
                      setDrag((d) => (d ? { ...d, overIndex: next } : d));
                    };
                    const onUp = () => {
                      holding = false;
                      window.clearTimeout(holdTimer);
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      const elapsed = Date.now() - startTime;
                      if (!moved && elapsed < 200 && !dragRef.current) {
                        // Plain click — select whole column
                        cursor.ref.current?.focus();
                        const firstRow = sortedRows[0];
                        const lastRow = sortedRows[sortedRows.length - 1];
                        if (firstRow && lastRow) {
                          const anchor = { rowKey: rowKey(firstRow), field: c.field };
                          const focus = { rowKey: rowKey(lastRow), field: c.field };
                          if (_e.shiftKey && rangeRef.current) {
                            setRange({ anchor: rangeRef.current.anchor, focus });
                          } else {
                            setRange({ anchor, focus });
                          }
                          cursor.setCursor({
                            rowKey: anchor.rowKey,
                            field: c.field,
                            editing: false,
                          });
                        }
                        return;
                      }
                      setDrag((d) => {
                        if (!d || d.overIndex == null) return null;
                        const from = orderedVisible.findIndex((x) => x.field === d.field);
                        if (from < 0 || from === d.overIndex) return null;
                        const next = [...orderedVisible.map((x) => x.field)];
                        next.splice(from, 1);
                        next.splice(d.overIndex, 0, d.field);
                        setOrder(next);
                        props.onLayoutChange?.({ order: next });
                        return null;
                      });
                    };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }}
                >
                  {c.label}
                  {sortGlyph}
                </span>
                {filterSet?.conditions.some((fc) => fc.field === c.field) && (
                  <span
                    className="rounded-pill bg-accent-wash px-1 font-mono text-[9px] text-accent"
                    title="column filtered"
                  >
                    ▣
                  </span>
                )}

                {/* description info badge — paired with the ⋯ menu in the
                  right-side metadata cluster so the label stays left-aligned
                  across columns regardless of whether a description exists. */}
                {c.description && (
                  <span
                    data-field-info
                    title={c.description}
                    className="ml-auto inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-line-2 text-[8px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                    aria-label={`Description: ${c.description}`}
                  >
                    i
                  </span>
                )}

                {/* Task 19: ⋯ menu button — pinned to the right cluster. When the
                  info badge is present it owns ml-auto; otherwise the button does. */}
                {!c.pinnedLeft && (
                  <button
                    type="button"
                    aria-label="Column menu"
                    className={cx(
                      "opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 max-md:opacity-40",
                      !c.description && "ml-auto",
                    )}
                    onClick={(e) => {
                      menuAnchorRef.current = e.currentTarget;
                      setMenuAnchorRect(null);
                      setMenuFor((s) => (s === c.field ? null : c.field));
                    }}
                  >
                    ⋯
                  </button>
                )}

                {/* Task 19: ColumnHeaderMenu */}
                {menuFor === c.field && (
                  <ColumnHeaderMenu
                    column={c}
                    anchorRef={menuAnchorRef}
                    anchorRect={menuAnchorRect}
                    sortDir={sort?.field === c.field ? sort.dir : null}
                    filterValue={
                      filterSet?.conditions.find(
                        (fc) => fc.field === c.field && fc.operator === "contains",
                      )?.value ?? null
                    }
                    onClose={() => {
                      setMenuFor(null);
                      setMenuAnchorRect(null);
                    }}
                    onRename={(label) => props.onRenameColumn?.(c.field, label)}
                    onSort={(dir) => setSort(dir ? { field: c.field, dir } : null)}
                    onOpenRules={
                      props.onSaveColumnRules
                        ? () => {
                            setMenuFor(null);
                            setRulesEditor(c.field);
                          }
                        : undefined
                    }
                    onEditDescription={
                      props.onSaveColumnDescription
                        ? () => {
                            setMenuFor(null);
                            setDescEditor(c.field);
                          }
                        : undefined
                    }
                    onFilter={(v) =>
                      setFilterSet((cur) => {
                        const existing = cur?.conditions ?? [];
                        const withoutThis = existing.filter(
                          (fc) => !(fc.field === c.field && fc.operator === "contains"),
                        );
                        if (!v) {
                          return withoutThis.length === 0
                            ? null
                            : { conjunction: cur?.conjunction ?? "and", conditions: withoutThis };
                        }
                        const conditions = [
                          ...withoutThis,
                          {
                            id: `${c.field}-contains`,
                            field: c.field,
                            operator: "contains" as const,
                            value: v,
                          },
                        ];
                        return { conjunction: cur?.conjunction ?? "and", conditions };
                      })
                    }
                    onChangeType={async (newConfig) => {
                      if (!props.onChangeColumnType) return;
                      const res = await props.onChangeColumnType(c.field, newConfig);
                      if (!res.ok && res.invalidCount) {
                        if (
                          confirm(
                            `${res.invalidCount} value(s) won't parse as ${newConfig.type}. Coerce to empty?`,
                          )
                        ) {
                          await props.onChangeColumnType(c.field, newConfig, {
                            coerceInvalidToNull: true,
                          });
                        }
                      }
                    }}
                    onHide={() => {
                      // include any already-hidden columns from the full prop list — `visible`
                      // is the post-filter set and never contains them
                      const hidden = [
                        ...columns.filter((v) => v.hidden).map((v) => v.field),
                        c.field,
                      ];
                      props.onLayoutChange?.({ hidden });
                    }}
                    onDelete={() => props.onDeleteColumn?.(c.field)}
                  />
                )}

                {/* Task 20: right-edge resize grip */}
                {!c.pinnedLeft && (
                  <span
                    aria-hidden
                    className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors group-hover:bg-line-2"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const startX = e.clientX;
                      const headerEl = e.currentTarget.parentElement as HTMLElement;
                      const startW = headerEl.getBoundingClientRect().width;
                      const onMove = (ev: PointerEvent) => {
                        const next = Math.max(60, Math.min(600, startW + (ev.clientX - startX)));
                        setWidths((w) => ({ ...w, [c.field]: next }));
                      };
                      const onUp = () => {
                        window.removeEventListener("pointermove", onMove);
                        window.removeEventListener("pointerup", onUp);
                        // commit the final width via the host
                        setWidths((w) => {
                          props.onLayoutChange?.({ widths: w });
                          return w;
                        });
                      };
                      window.addEventListener("pointermove", onMove);
                      window.addEventListener("pointerup", onUp);
                    }}
                  />
                )}
              </div>
            );
          })}
          {onAddFieldClick && (
            <div className="flex items-center">
              {hiddenList.length > 0 && (
                <button
                  ref={hiddenAnchorRef}
                  type="button"
                  onClick={() => setHiddenOpen((s) => !s)}
                  className="flex items-center gap-1.5 px-2 py-2 text-[12px] font-medium text-ink-3 transition-colors hover:text-accent"
                  aria-label="Show hidden fields"
                >
                  <IconEye className="h-3.5 w-3.5" />
                  <span className="tabular-nums">{hiddenList.length} hidden</span>
                </button>
              )}
              <button
                ref={addFieldRef as React.RefObject<HTMLButtonElement>}
                type="button"
                onClick={onAddFieldClick}
                className="px-3 py-2 text-[12px] font-medium text-accent transition-colors hover:brightness-110"
                aria-label="Add field"
              >
                + Field
              </button>
            </div>
          )}
        </div>
        {hiddenOpen && hiddenList.length > 0 && (
          <HiddenFieldsPopover
            hidden={hiddenList}
            anchorRef={hiddenAnchorRef}
            onUnhide={(field) => {
              const next = columns.filter((v) => v.hidden && v.field !== field).map((v) => v.field);
              props.onLayoutChange?.({ hidden: next });
            }}
            onClose={() => setHiddenOpen(false)}
          />
        )}

        {/* body */}
        {sortedRows.length === 0
          ? (empty ?? (
              <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-2">
                No rows.
              </div>
            ))
          : (() => {
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
                    const row = sortedRows[vRow.index]!;
                    const rk = rowKey(row);
                    const cursorOnThisRow = cursor.cursor?.rowKey === rk ? cursor.cursor : null;
                    const evaluation = condFmt.evaluateRow(row);
                    return (
                      <GridRow
                        key={rk}
                        row={row}
                        rowKey={rk}
                        rowIndex={vRow.index}
                        columns={orderedVisible}
                        focusedField={cursorOnThisRow?.field ?? null}
                        editingField={
                          cursorOnThisRow?.editing ? (cursorOnThisRow.field ?? null) : null
                        }
                        cursorInitial={cursorOnThisRow?.initial}
                        cellInRange={(field) => inRange(rk, field)}
                        selected={isSelected(rk)}
                        selectionCol={selectionCol}
                        showRowNumbers={showRowNumbers}
                        cellPadY={cellPadY}
                        gridStyle={gridStyle}
                        onAddFieldClick={onAddFieldClick}
                        hiddenFieldCount={hiddenList.length}
                        getValue={getValue}
                        onCellPointerDown={onCellPointerDown}
                        onCellDoubleClick={onCellDoubleClick}
                        onToggleSelect={onToggleSelect}
                        onCommitCell={commitValue}
                        onStopEdit={onStopEdit}
                        onAddColumnOption={props.onAddColumnOption}
                        onRowNumPointerDown={onRowNumPointerDown}
                        evaluation={evaluation}
                        activityEntry={activity?.get(rk)}
                      />
                    );
                  })}
                  {bottomPad > 0 && <div style={{ height: bottomPad }} />}
                </>
              );
            })()}
      </div>
      {statusAgg && <StatusBar agg={statusAgg} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeMenu}
          items={buildMenuItems(contextMenu.surface)}
        />
      )}
      {rulesEditor &&
        (() => {
          const col = orderedVisible.find((c) => c.field === rulesEditor);
          if (!col) return null;
          return (
            <ConditionalFormatPopover
              column={col}
              rules={col.rules ?? []}
              anchorRef={menuAnchorRef}
              anchorRect={menuAnchorRect}
              onChange={(rules) => props.onSaveColumnRules?.(col.field, rules)}
              onClose={() => {
                setRulesEditor(null);
                setMenuAnchorRect(null);
              }}
            />
          );
        })()}
      {descEditor &&
        (() => {
          const col = orderedVisible.find((c) => c.field === descEditor);
          if (!col) return null;
          return (
            <FieldDescriptionEditor
              field={col.field}
              initial={col.description ?? null}
              anchorRef={menuAnchorRef}
              anchorRect={menuAnchorRect}
              onSave={(next) => props.onSaveColumnDescription?.(col.field, next)}
              onClose={() => {
                setDescEditor(null);
                setMenuAnchorRect(null);
              }}
            />
          );
        })()}
    </div>
  );
}

function CellRenderer({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return <SelectCell.Renderer {...ctx} />;
  if (type === "linked") return <LinkedCell.Renderer {...ctx} />;
  const C = CELLS[type as Exclude<CellType, "select" | "linked">];
  return <C.Renderer {...ctx} />;
}

function CellEditor({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return null; // select uses inline SelectCell.Editor in the body (needs options + onCreate)
  if (type === "linked") return null; // linked uses inline LinkedCell.Editor in the body (needs candidates + anchorRef)
  const C = CELLS[type as Exclude<CellType, "select" | "linked">];
  return <C.Editor {...ctx} />;
}
