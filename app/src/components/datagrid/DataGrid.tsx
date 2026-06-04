import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { Checkbox } from "../Checkbox";
import {
  IconFieldBoolean,
  IconFieldDate,
  IconFieldNumber,
  IconFieldSelect,
  IconFieldText,
} from "../Icons";
import { TextCell } from "./cells/TextCell";
import { NumberCell } from "./cells/NumberCell";
import { BooleanCell } from "./cells/BooleanCell";
import { DateCell } from "./cells/DateCell";
import { SelectCell } from "./cells/SelectCell";
import { ColumnHeaderMenu } from "./ColumnHeaderMenu";
import { HiddenFieldsPopover } from "./HiddenFieldsPopover";
import { useGridCursor } from "./useGridCursor";
import { useUndoStack } from "./UndoStack";
import type { DataGridProps, CellType } from "./types";

const FIELD_TYPE_ICONS: Record<CellType, React.ComponentType<{ className?: string }>> = {
  text: IconFieldText,
  number: IconFieldNumber,
  boolean: IconFieldBoolean,
  date: IconFieldDate,
  select: IconFieldSelect,
};

const CELLS: Record<Exclude<CellType, "select">, { Renderer: any; Editor: any }> = {
  text: TextCell, number: NumberCell, boolean: BooleanCell, date: DateCell,
};

// ── Range selection types ───────────────────────────────────────────────────
interface RangeCorner { rowKey: string; field: string }
interface RangeState { anchor: RangeCorner; focus: RangeCorner }

export function DataGrid<Row>(props: DataGridProps<Row>) {
  const { rows, rowKey, columns, selection, onCommit, empty, onAddFieldClick, addFieldRef } = props;
  const visible = columns.filter((c) => !c.hidden);
  const selectionCol = !!selection;
  const undo = useUndoStack();

  // ── Task 19: sort state + sortedRows ────────────────────────────────────────
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const hiddenAnchorRef = useRef<HTMLButtonElement | null>(null);
  const hiddenList = useMemo(() => columns.filter((c) => c.hidden), [columns]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: Row, b: Row) => {
      const av = (a as any)[sort.field]; const bv = (b as any)[sort.field];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
      return String(av).localeCompare(String(bv)) * sign;
    };
    return [...rows].sort(cmp);
  }, [rows, sort]);

  // ── Task 20: per-column widths ──────────────────────────────────────────────
  const [widths, setWidths] = useState<Record<string, number>>(() => Object.fromEntries(
    visible.filter((c) => c.width).map((c) => [c.field, c.width!]),
  ));

  const colWidth = (field: string) => widths[field] ?? visible.find((c) => c.field === field)?.width;

  // ── Task 21: column order + drag state ─────────────────────────────────────
  const [order, setOrder] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<{ field: string; overIndex: number | null } | null>(null);
  // ref mirror of `drag` so onPointerDown's closed-over onMove can read the
  // live value (the hold-timer starts AFTER pointerdown — at pointerdown
  // time, `drag` is null in the closure)
  const dragRef = useRef(drag);
  useEffect(() => { dragRef.current = drag; }, [drag]);

  // resolved visible columns honor `order` if set; otherwise prop order
  const orderedVisible = useMemo(() => {
    if (!order) return visible;
    const byField = new Map(visible.map((c) => [c.field, c]));
    const out: typeof visible = [];
    for (const f of order) { const c = byField.get(f); if (c) out.push(c); }
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
    if (onAddFieldClick) tracks.push("auto");
    return { gridTemplateColumns: tracks.join(" ") };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedVisible, selectionCol, widths, onAddFieldClick]);

  // pending edit value lives inside the editor; commit flows back via the props.onCommit
  const commitValue = async (rk: string, field: string, value: unknown) => {
    await onCommit(rk, field, value);
  };

  // ── Range selection state ───────────────────────────────────────────────────
  // anchor stays fixed while shift-extending; focus tracks the moving corner.
  const [range, setRange] = useState<RangeState | null>(null);
  // ref mirror so pointer-move handlers can read live state without stale closures
  const rangeRef = useRef(range);
  useEffect(() => { rangeRef.current = range; }, [range]);
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
  const computeRangeBounds = useCallback((r: RangeState) => {
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
  }, [rowIndexMap, colIndexMap]);

  // Returns true if (rowKey, field) falls inside the current range
  const inRange = useCallback((rk: string, field: string): boolean => {
    if (!range) return false;
    const ri = rowIndexMap.get(rk);
    const ci = colIndexMap.get(field);
    if (ri == null || ci == null) return false;
    const { minRow, maxRow, minCol, maxCol } = computeRangeBounds(range);
    return ri >= minRow && ri <= maxRow && ci >= minCol && ci <= maxCol;
  }, [range, rowIndexMap, colIndexMap, computeRangeBounds]);

  // ── Cursor ─────────────────────────────────────────────────────────────────
  const cursor = useGridCursor({
    rows: sortedRows, rowKey, columns: orderedVisible,
    onCommit: () => { /* the editor's onBlur handles the actual value commit */ },
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
        cursor.setCursor({ rowKey: anchorCorner.rowKey, field: anchorCorner.field, editing: false });
      }
    },
    onUndo: () => undo.undo(),
    onRedo: () => undo.redo(),
  });

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
      const val = (row as any)[field];
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
        const val = (row as any)[col.field];
        cells.push(val == null ? "" : String(val));
      }
      lines.push(cells.join("\t"));
    }
    await navigator.clipboard.writeText(lines.join("\n"));
  }, [range, cursor.cursor, sortedRows, rowKey, orderedVisible, computeRangeBounds]);

  // ── Paste (Cmd+V) ──────────────────────────────────────────────────────────
  const handlePaste = useCallback(async () => {
    if (!cursor.cursor) return;
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const pasteRows = text.split("\n").map((line) => line.split("\t"));
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
        if (!col) continue;
        if (col.editable === false) continue;

        const rawVal = pasteRow[pc] ?? "";
        let coerced: unknown = rawVal;

        if (col.type === "number") {
          const n = Number(rawVal);
          coerced = isNaN(n) ? null : n;
        } else if (col.type === "boolean") {
          coerced = rawVal.toLowerCase() === "true";
        } else if (col.type === "select") {
          // Only commit if the value matches an existing option label
          const match = col.options?.find((o) => o.label === rawVal);
          if (!match) continue;
          coerced = rawVal;
        }
        // text and date: raw string

        void commitValue(targetRk, col.field, coerced);
      }
    }
  }, [cursor.cursor, range, sortedRows, rowKey, orderedVisible, rowIndexMap, colIndexMap, commitValue]);

  // ── Grid-level keyboard handler (layered on top of cursor.onKeyDown) ────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
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

    // Shift+Arrow: extend range, keep anchor
    const isShiftArrow =
      e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight");

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

    // Escape: collapse range to anchor
    if (e.key === "Escape" && range) {
      e.preventDefault();
      cursor.setCursor({ rowKey: range.anchor.rowKey, field: range.anchor.field, editing: false });
      setRange(null);
      return;
    }

    // Non-shift arrow / all other keys: collapse range and let cursor handle
    if (!e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      setRange(null);
    }

    cursor.onKeyDown(e);
  }, [cursor, range, handleCopy, handlePaste, rowIndexMap, colIndexMap, sortedRows, orderedVisible, rowKey]);

  const isSelected = (rk: string) => selection?.selected.includes(rk) ?? false;
  const toggle = (rk: string) => {
    if (!selection) return;
    const next = isSelected(rk) ? selection.selected.filter((x) => x !== rk) : [...selection.selected, rk];
    selection.onChange(next);
  };

  // ── Pointer handlers for drag-select ───────────────────────────────────────
  const onCellPointerDown = useCallback((e: React.PointerEvent, rk: string, field: string) => {
    // Only primary button; ignore while column-drag is active
    if (e.button !== 0 || drag) return;
    if (cursor.cursor?.editing) return;

    // Focus the workbench so ⌘C / ⌘V / ⌘A / arrow keys reach handleKeyDown.
    // tabIndex={0} makes the div focusable but click-on-child doesn't auto-focus.
    cursor.ref.current?.focus();

    if (e.shiftKey && cursor.cursor) {
      // Shift+click: extend range from existing anchor
      const currentAnchor = range?.anchor ?? { rowKey: cursor.cursor.rowKey, field: cursor.cursor.field };
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
  }, [cursor, range, drag]);

  return (
    <div
      ref={cursor.ref}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="overflow-x-auto rounded-lg border border-line bg-surface outline-none focus:ring-1 focus:ring-accent/40"
    >
      {/* header row */}
      <div className="grid items-stretch border-b border-line text-[12px] font-medium text-ink-2" style={gridStyle}>
        {selectionCol && (
          <div className="flex items-center justify-center border-r border-line py-2">
            <Checkbox
              state={selection!.selected.length === sortedRows.length && sortedRows.length > 0
                ? "on"
                : selection!.selected.length > 0 ? "mixed" : "off"}
              onClick={() => selection!.onChange(
                selection!.selected.length === sortedRows.length ? [] : sortedRows.map(rowKey)
              )}
              aria-label="Select all"
            />
          </div>
        )}
        {orderedVisible.map((c, idx) => {
          const sortGlyph = sort?.field === c.field ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
          const TypeIcon = FIELD_TYPE_ICONS[c.type];
          const isLastCol = idx === orderedVisible.length - 1;
          return (
            <div key={c.field}
              className={cx(
                "group relative flex items-center gap-1.5 px-3 py-2",
                !isLastCol && "border-r border-line",
                c.align === "right" && "justify-end",
              )}
              data-header={c.field}
            >
              {TypeIcon && <TypeIcon className="h-3.5 w-3.5 shrink-0 text-ink-3" />}
              {/* Task 21: dragged-column wash + drop-target line */}
              {drag?.field === c.field && <span className="absolute inset-0 bg-accent-wash" aria-hidden />}
              {drag?.overIndex != null && orderedVisible[drag.overIndex]?.field === c.field && (
                <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" aria-hidden />
              )}

              {/* Task 21: hold-then-drag label */}
              <span className={cx(
                "min-w-0 flex-1 truncate cursor-grab select-none",
                c.pinnedLeft && "cursor-default",
                c.align === "right" && "text-right",
              )}
                onPointerDown={(_e) => {
                  if (c.pinnedLeft) return;
                  let holding = true;
                  const holdTimer = window.setTimeout(() => {
                    if (!holding) return;
                    setDrag({ field: c.field, overIndex: null });
                  }, 200);
                  const onMove = (ev: PointerEvent) => {
                    if (!dragRef.current) return;
                    // determine which header column we're over via element-at-point
                    const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
                    const headerEl = target?.closest<HTMLElement>("[data-header]");
                    const overField = headerEl?.dataset.header ?? null;
                    if (overField == null) return;
                    const next = orderedVisible.findIndex((x) => x.field === overField);
                    setDrag((d) => d ? { ...d, overIndex: next } : d);
                  };
                  const onUp = () => {
                    holding = false;
                    window.clearTimeout(holdTimer);
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
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
              >{c.label}{sortGlyph}</span>

              {/* Task 19: ⋯ menu button — push to far end via ml-auto on left-aligned
                  columns; on right-aligned columns the parent's justify-end already
                  packs everything to the right, so ml-auto would fight that. */}
              {!c.pinnedLeft && (
                <button type="button" aria-label="Column menu"
                  className={cx(
                    "opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100",
                    c.align !== "right" && "ml-auto",
                  )}
                  onClick={(e) => {
                    menuAnchorRef.current = e.currentTarget;
                    setMenuFor((s) => s === c.field ? null : c.field);
                  }}
                >⋯</button>
              )}

              {/* Task 19: ColumnHeaderMenu */}
              {menuFor === c.field && (
                <ColumnHeaderMenu
                  column={c}
                  anchorRef={menuAnchorRef}
                  sortDir={sort?.field === c.field ? sort.dir : null}
                  onClose={() => setMenuFor(null)}
                  onRename={(label) => props.onRenameColumn?.(c.field, label)}
                  onSort={(dir) => setSort(dir ? { field: c.field, dir } : null)}
                  onChangeType={async (newType) => {
                    if (!props.onChangeColumnType) return;
                    const res = await props.onChangeColumnType(c.field, newType);
                    if (!res.ok && res.invalidCount) {
                      if (confirm(`${res.invalidCount} value(s) won't parse as ${newType}. Coerce to empty?`)) {
                        await props.onChangeColumnType(c.field, newType, { coerceInvalidToNull: true });
                      }
                    }
                  }}
                  onHide={() => {
                    // include any already-hidden columns from the full prop list — `visible`
                    // is the post-filter set and never contains them
                    const hidden = [...columns.filter((v) => v.hidden).map((v) => v.field), c.field];
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
                    const headerEl = (e.currentTarget.parentElement as HTMLElement);
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
                className="px-2 py-2 text-[12px] font-medium text-ink-3 transition-colors hover:text-accent"
                aria-label="Show hidden fields"
              >
                👁 {hiddenList.length} hidden
              </button>
            )}
            <button
              ref={addFieldRef as React.RefObject<HTMLButtonElement>}
              type="button"
              onClick={onAddFieldClick}
              className="px-3 py-2 text-[12px] font-medium text-ink-3 transition-colors hover:text-accent"
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
      {sortedRows.length === 0 ? (
        empty ?? <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">No rows.</div>
      ) : sortedRows.map((row) => {
        const rk = rowKey(row);
        const selected = isSelected(rk);
        return (
          <div key={rk}
            className={cx(
              "grid items-stretch border-b border-line transition-colors",
              selected ? "bg-surface-2" : "hover:bg-hover",
            )}
            style={gridStyle}
            data-row={rk}
          >
            {selectionCol && (
              <div className="flex items-center justify-center border-r border-line py-[7px]">
                <Checkbox state={selected ? "on" : "off"} onClick={() => toggle(rk)} aria-label={`Select row ${rk}`} />
              </div>
            )}
            {orderedVisible.map((c, idx) => {
              const focused = cursor.cursor?.rowKey === rk && cursor.cursor?.field === c.field;
              const editing = focused && cursor.cursor?.editing;
              const cellInRange = inRange(rk, c.field);
              const value = (row as any)[c.field];
              const ctx = { row, rowKey: rk, field: c.field, value, focused, column: c };
              const onDoubleClick = () => {
                if (c.editable === false) return;
                cursor.setCursor({ rowKey: rk, field: c.field, editing: true });
                setRange(null);
              };
              const isLastCol = idx === orderedVisible.length - 1;
              const cellCx = cx(
                "relative flex min-w-0 select-none items-center px-3 py-[7px]",
                !isLastCol && "border-r border-line",
                c.align === "right" && "justify-end text-right",
                // Range highlighting: range cells get faint wash; focus cell gets strong ring
                cellInRange && !focused && "bg-accent-wash/25",
                focused && "ring-1 ring-accent bg-accent-wash/40",
              );
              const data = `${rk}::${c.field}`;
              return (
                <div key={c.field}
                  data-cell={data}
                  onPointerDown={(e) => onCellPointerDown(e, rk, c.field)}
                  onDoubleClick={onDoubleClick}
                  className={cellCx}
                >
                  {editing && c.editable !== false
                    ? (c.edit
                        ? c.edit(row, {
                            ...ctx,
                            commit: (v: unknown) => { cursor.stopEdit(); void commitValue(rk, c.field, v); },
                            cancel: () => cursor.stopEdit(),
                          })
                        : c.type === "select"
                          ? <SelectCell.Editor
                              row={row} rowKey={rk} field={c.field} value={value} focused column={c}
                              commit={(v: unknown) => { cursor.stopEdit(); void commitValue(rk, c.field, v); }}
                              cancel={() => cursor.stopEdit()}
                              options={c.options ?? []}
                              onCreate={async (label: string, color) => {
                                if (!props.onAddColumnOption) return c.options ?? [];
                                return await props.onAddColumnOption(c.field, label, color);
                              }}
                            />
                          : <CellEditor type={c.type} ctx={{
                              ...ctx,
                              commit: (v: unknown) => { cursor.stopEdit(); void commitValue(rk, c.field, v); },
                              cancel: () => cursor.stopEdit(),
                            }} />)
                    : (c.render
                        ? c.render(row, ctx)
                        : c.type === "select"
                          ? <SelectCell.Renderer {...ctx} />
                          : <CellRenderer type={c.type} ctx={ctx} />)}
                </div>
              );
            })}
            {onAddFieldClick && (
              <div aria-hidden className="invisible flex items-center">
                {hiddenList.length > 0 && (
                  <span className="px-2 py-2 text-[12px] font-medium">👁 {hiddenList.length} hidden</span>
                )}
                <span className="px-3 py-2 text-[12px] font-medium">+ Field</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CellRenderer({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return <SelectCell.Renderer {...ctx} />;
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Renderer {...ctx} />;
}

function CellEditor({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return null; // select uses inline SelectCell.Editor in the body (needs options + onCreate)
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Editor {...ctx} />;
}
