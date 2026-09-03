import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { cx } from "../../lib/cx";
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
import type { DataGridProps, FilterSet } from "./types";
import { CursorOverlay } from "./CursorOverlay";
import { DataGridBody } from "./DataGridBody";
import { DataGridHeader } from "./DataGridHeader";
import { attrEsc, flashCell, flashCellCopy } from "./util";
import { toast } from "../Toast";
import {
  IconCopy,
  IconPaste,
  IconX,
  IconFilter,
  IconTrash,
  IconPlus,
  IconArrowRight,
} from "../Icons";

// ── Range selection types ───────────────────────────────────────────────────
interface RangeCorner {
  rowKey: string;
  field: string;
}
interface RangeState {
  anchor: RangeCorner;
  focus: RangeCorner;
}

// ── RangeOutline — absolute border around the current range. Re-measures on
// every render (range changes propagate via selector deps), so during a fill
// drag the rectangle grows in lockstep with setRange. Dashed while dragging
// so the extension reads as a preview rather than a committed selection.
function RangeOutline({
  topLeftSelector,
  bottomRightSelector,
  containerRef,
  dragging,
}: {
  topLeftSelector: string;
  bottomRightSelector: string;
  containerRef: React.RefObject<HTMLDivElement>;
  dragging: boolean;
}) {
  const [rect, setRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const tl = container.querySelector<HTMLElement>(topLeftSelector);
      const br = container.querySelector<HTMLElement>(bottomRightSelector);
      if (!tl || !br) {
        setRect(null);
        return;
      }
      const cRect = container.getBoundingClientRect();
      const tlRect = tl.getBoundingClientRect();
      const brRect = br.getBoundingClientRect();
      setRect({
        top: tlRect.top - cRect.top + container.scrollTop,
        left: tlRect.left - cRect.left + container.scrollLeft,
        width: brRect.right - tlRect.left,
        height: brRect.bottom - tlRect.top,
      });
    };
    // rAF-coalesce: scroll fires per-pixel, but we only need one measure per
    // frame. Without this, scrolling a long list ran getBoundingClientRect +
    // setState on every wheel tick and choked the main thread.
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      container.removeEventListener("scroll", onScroll);
    };
  }, [topLeftSelector, bottomRightSelector, containerRef]);
  if (!rect) return null;
  return (
    <div
      data-range-outline=""
      style={{ position: "absolute", ...rect }}
      className={cx(
        "pointer-events-none z-[15] rounded-[2px] border-[2px] border-accent",
        dragging && "border-dashed",
      )}
    />
  );
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
      // Fully inset the handle within the cell so it doesn't extend past the
      // cell's right/bottom edge into the scroll container's overflow area,
      // which would trigger a spurious scrollbar on the rightmost column.
      setPos({
        top: tRect.bottom - cRect.top + container.scrollTop - 8,
        left: tRect.right - cRect.left + container.scrollLeft - 8,
      });
    };
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      container.removeEventListener("scroll", onScroll);
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

/** Clipboard access that never throws: the API is absent in insecure contexts
 *  (and headless browsers), so failures surface a toast instead of an uncaught
 *  rejection. Returns success/false for writes, the text/null for reads. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast("Couldn't access the clipboard", "error");
    return false;
  }
}
async function readClipboard(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) throw new Error("clipboard unavailable");
    return await navigator.clipboard.readText();
  } catch {
    toast("Couldn't read the clipboard", "error");
    return null;
  }
}

export function DataGrid<Row>(props: DataGridProps<Row>) {
  const {
    rows,
    rowKey,
    columns,
    selection,
    onCommit,
    validate,
    onInvalidCommit,
    empty,
    onAddFieldClick,
    addFieldRef,
    activity,
    presence,
  } = props;
  const gridId = useId();
  // Memoized so a stable `columns` identity from the host actually preserves
  // GridRow memoization downstream — a fresh array here cascades into
  // orderedVisible/gridStyle and defeats React.memo on every row.
  const visible = useMemo(() => columns.filter((c) => !c.hidden), [columns]);
  const selectionCol = !!selection;
  const showRowNumbers = !!props.showRowNumbers;
  const cellPadY = "py-[7px]";
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
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(() => {
    const init = props.initialSort;
    return init ? { field: init.column, dir: init.direction } : null;
  });
  const isFirstSortRender = useRef(true);
  useEffect(() => {
    if (isFirstSortRender.current) {
      isFirstSortRender.current = false;
      return;
    }
    props.onSortChange?.(sort ? { column: sort.field, direction: sort.dir } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);
  const [filterSet, setFilterSet] = useState<FilterSet | null>(
    () => props.initialFilterSet ?? null,
  );
  const updateFilterSet = useCallback(
    (next: FilterSet | null | ((cur: FilterSet | null) => FilterSet | null)) => {
      setFilterSet((cur) => {
        const resolved = typeof next === "function" ? next(cur) : next;
        props.onFilterSetChange?.(resolved);
        return resolved;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onFilterSetChange],
  );
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

  const searchedRows = useMemo(() => {
    const q = props.quickFilter?.trim().toLowerCase();
    if (!q) return filteredRows;
    const accessor = props.quickFilterAccessor;
    return filteredRows.filter((r) => {
      const text = accessor ? accessor(r) : String((r as Record<string, unknown>)["label"] ?? "");
      return text.toLowerCase().includes(q);
    });
  }, [filteredRows, props.quickFilter, props.quickFilterAccessor]);

  const sortedRows = useMemo(() => {
    if (!sort) return searchedRows;
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
    return [...searchedRows].sort(cmp);
  }, [searchedRows, sort, getValue]);

  // ── Task 20: per-column widths ──────────────────────────────────────────────
  const [widths, setWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(visible.filter((c) => c.width).map((c) => [c.field, c.width!])),
  );
  // ref mirror of `widths` so DataGridHeader's event handlers can read the
  // committed widths without calling onLayoutChange inside a setState updater
  // (which would be a setState-in-render side effect).
  const widthsRef = useRef(widths);
  useEffect(() => {
    widthsRef.current = widths;
  }, [widths]);

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

  // Computed once per column change — O(cols) instead of O(cols²) per cell.
  const firstPinnedField = useMemo(
    () => orderedVisible.find((c) => c.pinnedLeft)?.field ?? null,
    [orderedVisible],
  );

  // template: optional checkbox + each visible column's width (uses orderedVisible)
  const gridStyle = useMemo(() => {
    const tracks = orderedVisible.map((c) => {
      const w = colWidth(c.field);
      return w ? `${w}px` : "minmax(var(--zz-col-min, 0px), 1fr)";
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
      if (validate) {
        const msg = validate(field, value, rk);
        if (msg) {
          flashCell(rk, field); // existing red-flash affordance
          onInvalidCommit?.(rk, field, msg);
          return; // refuse — value never lands, cursor already advanced by the editor
        }
      }
      if (onCommit) await onCommit(rk, field, value);
    },
    [onCommit, validate, onInvalidCommit],
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

  // Selectors for the top-left and bottom-right cells of the current range.
  // Used to anchor the fill handle (bottom-right) and the range outline (both
  // corners). Recalculated whenever the range changes — during a fill drag
  // this means the outline rect grows as setRange advances the focus row.
  const rangeCornerSelectors = useMemo(() => {
    if (!range) return null;
    const bounds = computeRangeBounds(range);
    const firstRow = sortedRows[bounds.minRow];
    const lastRow = sortedRows[bounds.maxRow];
    const firstCol = orderedVisible[bounds.minCol];
    const lastCol = orderedVisible[bounds.maxCol];
    if (!firstRow || !lastRow || !firstCol || !lastCol) return null;
    const multiCell = bounds.minRow !== bounds.maxRow || bounds.minCol !== bounds.maxCol;
    return {
      topLeft: `[data-cell="${attrEsc(`${rowKey(firstRow)}::${firstCol.field}`)}"]`,
      bottomRight: `[data-cell="${attrEsc(`${rowKey(lastRow)}::${lastCol.field}`)}"]`,
      multiCell,
    };
  }, [range, sortedRows, orderedVisible, rowKey, computeRangeBounds]);
  const fillHandlePos = rangeCornerSelectors?.bottomRight ?? null;

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
    // Spreadsheet default; hosts that own printable keys (e.g. Match's
    // A/S/R/M single-key actions) opt out with typeToEdit={false}.
    typeToEdit: props.typeToEdit ?? true,
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
  const estimatedRowHeight = 38;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields consumed; cursor.cursor object ref excluded to avoid firing on object identity changes when rowKey/field haven't changed
  }, [cursor.cursor?.rowKey, cursor.cursor?.field, onCursorChange]);

  // ── Publish self cursor position to presence when cursor moves ────────────
  useEffect(() => {
    if (!presence || !cursor.cursor) return;
    presence.setCell(cursor.cursor.rowKey, cursor.cursor.field);
  }, [presence, cursor.cursor]);

  // Keep range anchor in sync when cursor moves without shift (range collapses)
  // We handle this explicitly in the key handler below, not via useEffect, to
  // avoid fighting with the cursor state.

  // ── Column-hover highlight ─────────────────────────────────────────────────
  // Hovering a cell or header tints every cell in the column. DOM-mutation
  // based (no React state) so the per-hover path doesn't trigger renders —
  // important because GridRow is memoized and a top-level state change would
  // invalidate every row.
  // isScrollingRef: set true while a scroll is in flight so applyColumnHover
  // is skipped — cells slide under a stationary pointer on scroll and the
  // querySelectorAll sweeps are wasted work.
  const isScrollingRef = useRef(false);
  const hoverFieldRef = useRef<string | null>(null);
  const applyColumnHover = useCallback(
    (field: string | null) => {
      if (isScrollingRef.current) return;
      const root = cursor.ref.current;
      if (!root) return;
      if (hoverFieldRef.current === field) return;
      if (hoverFieldRef.current) {
        root.querySelectorAll(".zz-col-hover").forEach((el) => el.classList.remove("zz-col-hover"));
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

  // Header elevation: flag the scroll container once content has scrolled
  // under the sticky header so CSS can add a shadow
  // (.zz-grid-scroll[data-scrolled] .zz-grid-header). rAF-coalesced like the
  // other scroll listeners in this file.
  // Also sets isScrollingRef while scrolling so applyColumnHover is skipped.
  useEffect(() => {
    const el = cursor.ref.current;
    if (!el) return;
    let raf = 0;
    let scrollEndTimer = 0;
    const update = () => {
      el.toggleAttribute("data-scrolled", el.scrollTop > 0);
    };
    const onScroll = () => {
      isScrollingRef.current = true;
      clearTimeout(scrollEndTimer);
      scrollEndTimer = window.setTimeout(() => {
        isScrollingRef.current = false;
      }, 150);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(scrollEndTimer);
      el.removeEventListener("scroll", onScroll);
    };
  }, [cursor.ref]);

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
      if (!(await writeClipboard(text))) return;
      toast("Copied", "success");
      flashCellCopy(rk, field);
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
    if (!(await writeClipboard(lines.join("\n")))) return;
    toast("Copied", "success");
    for (let ri = minRow; ri <= maxRow; ri++) {
      const row = sortedRows[ri];
      if (!row) continue;
      for (let ci = minCol; ci <= maxCol; ci++) {
        const col = orderedVisible[ci];
        if (!col) continue;
        flashCellCopy(rowKey(row), col.field);
      }
    }
  }, [range, cursor.cursor, sortedRows, rowKey, orderedVisible, computeRangeBounds, getValue]);

  // Coerce a raw clipboard string into the column's expected type. Returns
  // `undefined` to mean "skip this cell" (unparseable / not a valid option).
  const coerceForColumn = useCallback(
    (rawVal: string, col: (typeof orderedVisible)[number]): unknown => {
      // An empty source cell clears the target; text the column can't read is
      // skipped, the same way an unmatchable SELECT option is — pasting garbage
      // must never wipe a value that was already there.
      const blank = rawVal.trim() === "";
      switch (col.config.type) {
        case "number": {
          if (blank) return null;
          const n = Number(rawVal);
          return isNaN(n) ? undefined : n;
        }
        case "boolean":
          return rawVal.toLowerCase() === "true";
        case "select": {
          const match = col.config.options.find((o) => o.label === rawVal);
          if (!match) return undefined;
          return rawVal;
        }
        case "rating": {
          if (blank) return null;
          const n = parseInt(rawVal, 10);
          return isNaN(n) ? undefined : n;
        }
        case "date":
          if (blank) return null;
          return isNaN(new Date(rawVal.trim()).getTime()) ? undefined : rawVal;
        case "text":
        case "url":
        case "email":
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
    const text = await readClipboard();
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
        toast(
          `${label} didn't save — ${err instanceof Error ? err.message : "please try again"}`,
          "error",
        );
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

  // Right-clicking a header opens the same ColumnHeaderMenu the ⋯ button opens
  // (one consistent menu), anchored at the cursor. Cells and row numbers keep
  // the ContextMenu. We intercept the header surface here rather than rendering
  // the ContextMenu for it below.
  useEffect(() => {
    if (contextMenu?.surface.kind !== "header") return;
    const { field } = contextMenu.surface;
    menuAnchorRef.current = null;
    setMenuAnchorRect(new DOMRect(contextMenu.x, contextMenu.y, 0, 0));
    setMenuFor(field);
    closeMenu();
  }, [contextMenu, closeMenu]);

  const buildMenuItems = (surface: ContextSurface): MenuItem[] => {
    if (surface.kind === "cell") {
      const { rowKey: rk, field } = surface;
      const row = sortedRows.find((r) => rowKey(r) === rk);
      const value = row ? getValue(row, field) : null;
      const valStr = value == null ? "" : String(value);
      return [
        { label: "Copy", icon: <IconCopy />, shortcut: "⌘C", onClick: () => void handleCopy() },
        { label: "Paste", icon: <IconPaste />, shortcut: "⌘V", onClick: () => void handlePaste() },
        { label: "Clear", icon: <IconX />, onClick: () => void commitValue(rk, field, null) },
        { separator: true, label: "", onClick: () => {} },
        {
          label: `Filter to "${valStr.slice(0, 24)}"`,
          icon: <IconFilter />,
          onClick: () => {
            updateFilterSet((cur) => ({
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
          icon: <IconFilter />,
          onClick: () => {
            updateFilterSet((cur) => ({
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
          icon: <IconPlus />,
          onClick: () => props.onInsertRow?.(rk, "above"),
          disabled: !props.onInsertRow,
        },
        {
          label: "Insert row below",
          icon: <IconPlus />,
          onClick: () => props.onInsertRow?.(rk, "below"),
          disabled: !props.onInsertRow,
        },
        ...(props.onReorderRow
          ? [
              {
                label: "Move to top",
                onClick: () => {
                  const idx = sortedRows.findIndex((r) => rowKey(r) === rk);
                  const afterKey = idx > 0 ? rowKey(sortedRows[0]!) : null;
                  props.onReorderRow?.(rk, null, afterKey);
                },
              } as MenuItem,
              {
                label: "Move to bottom",
                onClick: () => {
                  const last = sortedRows[sortedRows.length - 1];
                  const beforeKey = last ? rowKey(last) : null;
                  props.onReorderRow?.(rk, beforeKey, null);
                },
              } as MenuItem,
            ]
          : []),
        {
          label: "Delete row",
          icon: <IconTrash />,
          onClick: () => props.onDeleteRow?.(rk),
          disabled: !props.onDeleteRow,
        },
        ...(props.onViewHistory
          ? [
              { separator: true, label: "", onClick: () => {} } as MenuItem,
              {
                label: "View history",
                onClick: () => props.onViewHistory!(rk, field),
              } as MenuItem,
            ]
          : []),
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
          icon: <IconPlus />,
          onClick: () => props.onInsertRow?.(rk, "above"),
          disabled: !props.onInsertRow,
        },
        {
          label: "Insert below",
          icon: <IconPlus />,
          onClick: () => props.onInsertRow?.(rk, "below"),
          disabled: !props.onInsertRow,
        },
        ...(props.onReorderRow
          ? [
              {
                label: "Move to top",
                onClick: () => {
                  const idx = sortedRows.findIndex((r) => rowKey(r) === rk);
                  const afterKey = idx > 0 ? rowKey(sortedRows[0]!) : null;
                  props.onReorderRow?.(rk, null, afterKey);
                },
              } as MenuItem,
              {
                label: "Move to bottom",
                onClick: () => {
                  const last = sortedRows[sortedRows.length - 1];
                  const beforeKey = last ? rowKey(last) : null;
                  props.onReorderRow?.(rk, beforeKey, null);
                },
              } as MenuItem,
            ]
          : []),
        {
          label: "Delete",
          icon: <IconTrash />,
          onClick: () => props.onDeleteRow?.(rk),
          disabled: !props.onDeleteRow,
        },
        ...(props.onMapValuesToRecord
          ? [
              {
                label: "Map values to this record",
                icon: <IconArrowRight />,
                onClick: () => props.onMapValuesToRecord!(rk),
              } as MenuItem,
            ]
          : []),
      ];
    }
    return [];
  };

  // ── Grid-level keyboard handler (layered on top of cursor.onKeyDown) ────────
  const { onCellKeyDown } = props;
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

      // Cmd+D: fill down. With a multi-row range, the top row's value(s) fill
      // the rest of the range; with just a cursor, the focused cell is filled
      // from the cell directly above (Excel convention). One undo step.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const writes: Array<{ rk: string; field: string; value: unknown }> = [];
        // A plain click leaves a single-cell range (anchor === focus), so gate
        // the range branch on it actually spanning more than one row.
        const bounds = range ? computeRangeBounds(range) : null;
        if (bounds && bounds.maxRow > bounds.minRow) {
          const { minRow, maxRow, minCol, maxCol } = bounds;
          const srcRow = sortedRows[minRow];
          if (srcRow) {
            for (let ci = minCol; ci <= maxCol; ci++) {
              const col = orderedVisible[ci];
              if (!col || col.editable === false) continue;
              const value = getValue(srcRow, col.field);
              for (let ri = minRow + 1; ri <= maxRow; ri++) {
                const row = sortedRows[ri];
                if (row) writes.push({ rk: rowKey(row), field: col.field, value });
              }
            }
          }
        } else if (cur) {
          const ri = rowIndexMap.get(cur.rowKey) ?? -1;
          const col = orderedVisible.find((c) => c.field === cur.field);
          const above = ri > 0 ? sortedRows[ri - 1] : undefined;
          if (col && col.editable !== false && above) {
            writes.push({ rk: cur.rowKey, field: cur.field, value: getValue(above, cur.field) });
          }
        }
        if (writes.length === 0) return;
        const label = `fill ${writes.length} cell${writes.length === 1 ? "" : "s"}`;
        undo.beginTransaction(label);
        void Promise.all(writes.map((w) => commitValue(w.rk, w.field, w.value)))
          .catch((err) => {
            console.error(`DataGrid: ${label} failed`, err);
          })
          .finally(() => {
            undo.endTransaction();
            for (const w of writes) flashCell(w.rk, w.field);
          });
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

      // Escape: collapse multi-cell range to anchor; for a single-cell range
      // (anchor === focus, i.e. a plain click), fall through so cursor.onKeyDown
      // can clear the cursor entirely (Escape-then-Tab grid exit).
      if (e.key === "Escape" && range) {
        const isMultiCell =
          range.anchor.rowKey !== range.focus.rowKey || range.anchor.field !== range.focus.field;
        if (isMultiCell) {
          e.preventDefault();
          cursor.setCursor({
            rowKey: range.anchor.rowKey,
            field: range.anchor.field,
            editing: false,
          });
          setRange(null);
          return;
        }
        // Single-cell range: clear it silently and let cursor.onKeyDown clear cursor
        setRange(null);
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
      if (!e.defaultPrevented && onCellKeyDown) {
        onCellKeyDown(e, {
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
      onCellKeyDown,
    ],
  );

  const selectedSet = useMemo(() => new Set(selection?.selected ?? []), [selection?.selected]);
  const isSelected = useCallback((rk: string) => selectedSet.has(rk), [selectedSet]);

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

  // ── Row-number click → select row; sustained drag → reorder row ───────────
  //
  // Sheets/Notion pattern: a tap on the row number selects the whole row.
  // Holding and dragging past a threshold flips into reorder mode (only when
  // the host wired onReorderRow). The threshold prevents accidental reorder
  // from a click-with-jitter and keeps single-click selection snappy.
  const onReorderRowRef = useRef(props.onReorderRow);
  onReorderRowRef.current = props.onReorderRow;
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

      // No reorder wiring → behave as plain row-select.
      if (!onReorderRowRef.current) return;

      const startY = e.clientY;
      const startX = e.clientX;
      const DRAG_THRESHOLD = 5;
      let dragging = false;
      let indicator: HTMLDivElement | null = null;
      let target: { before: string | null; after: string | null } | null = null;
      let ghostClass: string | null = null;

      const startDrag = () => {
        dragging = true;
        document.body.style.cursor = "grabbing";
        indicator = document.createElement("div");
        indicator.style.cssText =
          "position:fixed;height:2px;background:var(--accent,#7c5cff);pointer-events:none;z-index:9999;display:none;border-radius:1px;box-shadow:0 0 6px color-mix(in srgb,var(--accent,#7c5cff) 40%,transparent)";
        document.body.appendChild(indicator);
        // Subtle ghost on the dragged row.
        const dragged = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(rk)}"]`);
        if (dragged) {
          ghostClass = "zz-dragging-row";
          dragged.classList.add(ghostClass);
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
          startDrag();
        }
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const rowEl = el?.closest<HTMLElement>("[data-row]");
        if (!rowEl || rowEl.dataset.row === rk) {
          if (indicator) indicator.style.display = "none";
          target = null;
          return;
        }
        const rect = rowEl.getBoundingClientRect();
        const above = ev.clientY < rect.top + rect.height / 2;
        if (indicator) {
          indicator.style.display = "block";
          indicator.style.left = `${rect.left}px`;
          indicator.style.width = `${rect.width}px`;
          indicator.style.top = `${(above ? rect.top : rect.bottom) - 1}px`;
        }

        const scroller =
          rowEl.closest<HTMLElement>(".zz-grid-scroll") ?? (rowEl.parentElement as HTMLElement);
        const all = Array.from(scroller.querySelectorAll<HTMLElement>("[data-row]"));
        const idx = all.indexOf(rowEl);
        const prevKey = idx > 0 ? (all[idx - 1]?.dataset.row ?? null) : null;
        const nextKey =
          idx >= 0 && idx < all.length - 1 ? (all[idx + 1]?.dataset.row ?? null) : null;
        const hovered = rowEl.dataset.row!;
        target = above
          ? { before: prevKey === rk ? null : prevKey, after: hovered }
          : { before: hovered, after: nextKey === rk ? null : nextKey };
        if (target.before === rk || target.after === rk) target = null;
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (indicator) indicator.remove();
        document.body.style.cursor = "";
        if (ghostClass) {
          const dragged = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(rk)}"]`);
          dragged?.classList.remove(ghostClass);
        }
        if (dragging && target) onReorderRowRef.current?.(rk, target.before, target.after);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
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
        <FilterBar filterSet={filterSet} columns={orderedVisible} onChange={updateFilterSet} />
      )}
      <div
        ref={cursor.ref}
        tabIndex={0}
        role="grid"
        aria-rowcount={sortedRows.length + 1}
        aria-colcount={orderedVisible.length}
        aria-activedescendant={
          cursor.cursor
            ? `${gridId}${encodeURIComponent(cursor.cursor.rowKey)}::${cursor.cursor.field}`
            : undefined
        }
        onKeyDown={handleKeyDown}
        onContextMenu={onContextMenu}
        className={cx(
          "zz-grid-scroll relative flex flex-1 flex-col min-h-0 overflow-auto outline-none",
          props.onReorderRow && "zz-row-reorderable",
        )}
      >
        {rangeCornerSelectors?.multiCell && (
          <RangeOutline
            topLeftSelector={rangeCornerSelectors.topLeft}
            bottomRightSelector={rangeCornerSelectors.bottomRight}
            containerRef={cursor.ref}
            dragging={fillHandle.dragging}
          />
        )}
        {fillHandlePos && (
          <FillHandle
            targetSelector={fillHandlePos}
            containerRef={cursor.ref}
            onPointerDown={fillHandle.onHandlePointerDown}
            dragging={fillHandle.dragging}
          />
        )}
        {/* header row */}
        <DataGridHeader
          gridId={gridId}
          columns={orderedVisible}
          allColumns={columns}
          gridStyle={gridStyle}
          cellPadY={cellPadY}
          showRowNumbers={showRowNumbers}
          selectionCol={selectionCol}
          selection={selection}
          sortedRows={sortedRows}
          rowKey={rowKey}
          sort={sort}
          setSort={setSort}
          filterSet={filterSet}
          setFilterSet={updateFilterSet}
          setWidths={setWidths}
          widthsRef={widthsRef}
          setOrder={setOrder}
          drag={drag}
          setDrag={setDrag}
          dragRef={dragRef}
          menuFor={menuFor}
          setMenuFor={setMenuFor}
          menuAnchorRef={menuAnchorRef}
          menuAnchorRect={menuAnchorRect}
          setMenuAnchorRect={setMenuAnchorRect}
          setRulesEditor={setRulesEditor}
          setDescEditor={setDescEditor}
          onColumnHover={applyColumnHover}
          scrollContainerRef={cursor.ref}
          rangeRef={rangeRef}
          setRange={setRange}
          setCursor={cursor.setCursor}
          onAddFieldClick={onAddFieldClick}
          addFieldRef={addFieldRef as React.RefObject<HTMLButtonElement> | undefined}
          onLayoutChange={props.onLayoutChange}
          onRenameColumn={props.onRenameColumn}
          onSaveColumnRules={props.onSaveColumnRules}
          onSaveColumnValidation={props.onSaveColumnValidation}
          onSaveColumnDescription={props.onSaveColumnDescription}
          onEditColumnFormula={props.onEditColumnFormula}
          onChangeColumnType={props.onChangeColumnType}
          onDeleteColumn={props.onDeleteColumn}
          onShowLinkedFields={props.onShowLinkedFields}
          onOpenTargetRefTable={props.onOpenTargetRefTable}
          onChangeDisplayedField={props.onChangeDisplayedField}
          onManageLinkedFields={props.onManageLinkedFields}
          onJumpToSourceColumn={props.onJumpToSourceColumn}
          onRemoveLookup={props.onRemoveLookup}
        />
        {/* body */}
        <DataGridBody
          rows={sortedRows}
          rowKey={rowKey}
          columns={orderedVisible}
          gridId={gridId}
          gridStyle={gridStyle}
          cellPadY={cellPadY}
          showRowNumbers={showRowNumbers}
          selectionCol={selectionCol}
          estimatedRowHeight={estimatedRowHeight}
          scrollContainerRef={cursor.ref}
          virtualizerRef={virtualizerRef}
          empty={
            rows.length > 0 && filterSet && filterSet.conditions.length > 0 ? (
              <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">
                <div>No records match the current filters.</div>
                <button
                  type="button"
                  onClick={() => updateFilterSet(null)}
                  className="mt-2 text-accent underline-offset-2 hover:underline"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              empty
            )
          }
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
          firstPinnedField={firstPinnedField}
          condFmt={condFmt}
          activity={activity}
          renderRowDetail={props.renderRowDetail}
        />
        {presence && (
          <CursorOverlay
            peers={presence.peers}
            cellRect={(rowKey, field) => {
              const container = cursor.ref.current;
              if (!container) return null;
              const cellEl = container.querySelector<HTMLElement>(
                `[data-cell="${attrEsc(`${rowKey}::${field}`)}"]`,
              );
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
      <StatusBar agg={statusAgg} />
      {/* Header right-clicks are intercepted (see effect above) to open the
          ColumnHeaderMenu instead — never render the shared ContextMenu for them. */}
      {contextMenu && contextMenu.surface.kind !== "header" && (
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
