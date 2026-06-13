import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
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
import { useConditionalFormatting } from "./useConditionalFormatting";
import type { DataGridProps, CellType, FilterSet } from "./types";
import { CursorOverlay } from "./CursorOverlay";
import { DataGridBody } from "./DataGridBody";
import { attrEsc, flashCell } from "./util";

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

// ── Range selection types ───────────────────────────────────────────────────
interface RangeCorner {
  rowKey: string;
  field: string;
}
interface RangeState {
  anchor: RangeCorner;
  focus: RangeCorner;
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
    presence,
  } = props;
  // Memoized so a stable `columns` identity from the host actually preserves
  // GridRow memoization downstream — a fresh array here cascades into
  // orderedVisible/gridStyle and defeats React.memo on every row.
  const visible = useMemo(() => columns.filter((c) => !c.hidden), [columns]);
  const selectionCol = !!selection;
  const showRowNumbers = !!props.showRowNumbers;
  const compact = props.density === "compact";
  const cellPadY = compact ? "py-[3px]" : "py-[7px]";
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
      return w ? `${w}px` : "minmax(0, 1fr)";
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
    // Hosts that own single-key actions (workbench A/S/R/N…) get printable
    // keys via onCellKeyDown instead of type-to-edit.
    typeToEdit: !props.onCellKeyDown,
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
  // The actual `useVirtualizer` call lives in DataGridBody; it writes its
  // instance into this ref so the cursor scroll-into-view effect below can
  // imperatively call scrollToIndex without re-creating the virtualiser here.
  const estimatedRowHeight = compact ? 26 : 38;
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);

  // Pointer-driven cursor moves must NOT auto-scroll: the clicked cell is
  // already visible, and scrollToIndex (estimated row sizes) can shift the
  // grid under the pointer — the second click of a double-click then lands
  // on a different row. Timestamp instead of a boolean so a set-but-unfired
  // flag can't swallow a later keyboard-driven scroll.
  const pointerCursorAt = useRef(0);

  // Scroll the cursor row into view when it changes.
  // Step 1: bring the row into the virtualiser's render window (vertical).
  // Step 2 (rAF): once React has rendered the row, scroll the cell for
  // horizontal alignment using scrollIntoView.
  useEffect(() => {
    const rk = cursor.cursor?.rowKey;
    const field = cursor.cursor?.field;
    if (!rk) return;
    if (performance.now() - pointerCursorAt.current < 100) return;
    const idx = rowIndexMap.get(rk);
    if (idx == null) return;
    virtualizerRef.current?.scrollToIndex(idx, { align: "auto" });
    requestAnimationFrame(() => {
      const el = cursor.ref.current?.querySelector<HTMLElement>(
        `[data-cell="${attrEsc(`${rk}::${field ?? ""}`)}"]`,
      );
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor.cursor?.rowKey, cursor.cursor?.field]);

  // ── Cursor mirror for hosts that key features off the focused row ─────────
  const onCursorChange = props.onCursorChange;
  useEffect(() => {
    if (!onCursorChange) return;
    onCursorChange(
      cursor.cursor ? { rowKey: cursor.cursor.rowKey, field: cursor.cursor.field } : null,
    );
  }, [cursor.cursor?.rowKey, cursor.cursor?.field, onCursorChange]);

  // ── Publish self cursor position to presence when cursor moves ────────────
  useEffect(() => {
    if (!presence || !cursor.cursor) return;
    const rowIdx = rowIndexMap.get(cursor.cursor.rowKey);
    const colIdx = colIndexMap.get(cursor.cursor.field);
    if (rowIdx != null && colIdx != null) {
      presence.setCell(rowIdx, colIdx);
    }
  }, [presence, cursor.cursor, rowIndexMap, colIndexMap]);

  // Keep range anchor in sync when cursor moves without shift (range collapses)
  // We handle this explicitly in the key handler below, not via useEffect, to
  // avoid fighting with the cursor state.

  // ── Column-hover highlight ─────────────────────────────────────────────────
  // Hovering a cell or header tints every cell in the column. DOM-mutation
  // based (no React state) so the per-hover path doesn't trigger renders —
  // important because GridRow is memoized and a top-level state change would
  // invalidate every row.
  const hoverFieldRef = useRef<string | null>(null);
  const applyColumnHover = useCallback(
    (field: string | null) => {
      const root = cursor.ref.current;
      if (!root) return;
      if (hoverFieldRef.current === field) return;
      if (hoverFieldRef.current) {
        root
          .querySelectorAll(".zz-col-hover")
          .forEach((el) => el.classList.remove("zz-col-hover"));
      }
      hoverFieldRef.current = field;
      if (field) {
        const esc = attrEsc(field);
        root
          .querySelectorAll(`[data-field="${esc}"], [data-header="${esc}"]`)
          .forEach((el) => el.classList.add("zz-col-hover"));
      }
    },
    [cursor.ref],
  );

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

      // Host hook for workbench single-key actions: fires iff (not editing)
      // AND no grid handler above consumed the event AND the cursor bindings
      // didn't preventDefault.
      if (!e.defaultPrevented && props.onCellKeyDown) {
        props.onCellKeyDown(e, {
          cursor: cur ? { rowKey: cur.rowKey, field: cur.field } : null,
          startEdit: (seed?: string) => cursor.startEdit(seed),
        });
      }
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
      props.onCellKeyDown,
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
      pointerCursorAt.current = performance.now();
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
      cursor.ref.current?.focus({ preventScroll: true });
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
      pointerCursorAt.current = performance.now();
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
      cursor.ref.current?.focus({ preventScroll: true });

      if (e.shiftKey && cursor.cursor) {
        // Shift+click: extend range from existing anchor
        const currentAnchor = range?.anchor ?? {
          rowKey: cursor.cursor.rowKey,
          field: cursor.cursor.field,
        };
        const newFocus = { rowKey: rk, field };
        setRange({ anchor: currentAnchor, focus: newFocus });
        pointerCursorAt.current = performance.now();
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
      pointerCursorAt.current = performance.now();
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
        className="relative flex flex-1 flex-col min-h-0 overflow-auto outline-none"
        style={{ scrollbarGutter: "stable" }}
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
                cellPadY,
              )}
            >
              #
            </div>
          )}
          {selectionCol && (
            <div
              className={cx("flex items-center justify-center border-r border-line", cellPadY)}
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
                  cellPadY,
                  !isLastCol && "border-r border-line",
                  c.pinnedLeft && idx === 0 && "sticky left-0 z-10 bg-surface",
                )}
                data-header={c.field}
                onMouseEnter={() => applyColumnHover(c.field)}
                onMouseLeave={() => applyColumnHover(null)}
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
                        cursor.ref.current?.focus({ preventScroll: true });
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

                {/* Task 20: right-edge resize grip — 8px hit area straddling the
                  column boundary (4px each side); the visible 2px bar appears on
                  hover only. Sheets/Airtable pattern. Narrower than 12px so it
                  doesn't overlap the ⋯ menu trigger's right edge. */}
                {!c.pinnedLeft && (
                  <span
                    aria-hidden
                    className="absolute right-[-4px] top-0 bottom-0 w-2 z-[2] cursor-col-resize group/grip"
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
                    onDoubleClick={(e) => {
                      // Fit column to widest visible rendered cell (header + body).
                      // Airtable-style: measure only what's in the DOM. Body cells
                      // are selected by an exact data-field match (no suffix collisions,
                      // attribute value escaped). Header is the grip's parent.
                      //
                      // Renderers truncate their inner span (overflow:hidden +
                      // text-overflow:ellipsis + white-space:nowrap), so the wrapper's
                      // scrollWidth reflects its current rendered width, not the natural
                      // content width. We temporarily relax the truncating styles on
                      // the inner span, read scrollWidth, then restore. We mutate/restore
                      // inline (rather than cloning the subtree) because cloning is more
                      // expensive and this runs only once per double-click; a synchronous
                      // mutate→read→restore stays within one task, so no flash is visible.
                      const root = cursor.ref.current;
                      if (!root) return;
                      const measureNatural = (el: HTMLElement): number => {
                        const inner = el.firstElementChild as HTMLElement | null;
                        const target = inner ?? el;
                        const prev = {
                          maxWidth: target.style.maxWidth,
                          overflow: target.style.overflow,
                          textOverflow: target.style.textOverflow,
                          whiteSpace: target.style.whiteSpace,
                        };
                        target.style.maxWidth = "none";
                        target.style.overflow = "visible";
                        target.style.textOverflow = "clip";
                        target.style.whiteSpace = "nowrap";
                        const w = target.scrollWidth;
                        target.style.maxWidth = prev.maxWidth;
                        target.style.overflow = prev.overflow;
                        target.style.textOverflow = prev.textOverflow;
                        target.style.whiteSpace = prev.whiteSpace;
                        return w;
                      };
                      // Wrappers use px-3 = 12px horizontal padding each side = 24px total.
                      const PAD = 24;
                      const headerEl = e.currentTarget.parentElement as HTMLElement | null;
                      const cells = root.querySelectorAll<HTMLElement>(
                        `[data-field="${attrEsc(c.field)}"]`,
                      );
                      let max = 60;
                      if (headerEl) {
                        const hw = measureNatural(headerEl) + PAD;
                        if (hw > max) max = hw;
                      }
                      for (const cell of cells) {
                        const w = measureNatural(cell) + PAD;
                        if (w > max) max = w;
                      }
                      const next = Math.min(600, Math.max(60, max));
                      setWidths((w) => {
                        const updated = { ...w, [c.field]: next };
                        props.onLayoutChange?.({ widths: updated });
                        return updated;
                      });
                    }}
                  >
                    <span
                      aria-hidden
                      className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-[2px] bg-line-2 opacity-0 transition-opacity group-hover/grip:opacity-100"
                    />
                  </span>
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
        <DataGridBody
          rows={sortedRows}
          rowKey={rowKey}
          columns={orderedVisible}
          gridStyle={gridStyle}
          cellPadY={cellPadY}
          showRowNumbers={showRowNumbers}
          selectionCol={selectionCol}
          estimatedRowHeight={estimatedRowHeight}
          scrollContainerRef={cursor.ref}
          virtualizerRef={virtualizerRef}
          empty={empty}
          cursorRowKey={cursor.cursor?.rowKey ?? null}
          cursorField={cursor.cursor?.field ?? null}
          cursorEditing={!!cursor.cursor?.editing}
          cursorInitial={cursor.cursor?.initial}
          cellInRange={inRange}
          isSelected={isSelected}
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
          onColumnHover={applyColumnHover}
          condFmt={condFmt}
          activity={activity}
          renderRowDetail={props.renderRowDetail}
        />
        {presence && (
          <CursorOverlay
            peers={presence.peers}
            cellRect={(row, col) => {
              const container = cursor.ref.current;
              if (!container) return null;
              const rowEl = container.querySelector<HTMLElement>(
                `[data-row="${sortedRows[row] ? rowKey(sortedRows[row]!) : ""}"]`,
              );
              if (!rowEl) return null;
              const cellEl = rowEl.querySelectorAll<HTMLElement>("[data-cell]")[col] ?? null;
              if (!cellEl) return null;
              const grid = container.getBoundingClientRect();
              const cell = cellEl.getBoundingClientRect();
              return {
                top: cell.top - grid.top + container.scrollTop,
                left: cell.left - grid.left + container.scrollLeft,
                width: cell.width,
                height: cell.height,
              };
            }}
          />
        )}
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
