import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef, Cursor } from "./types";

/* useGridCursor — owns the (rowKey, field, editing) cursor + the keyboard
   handler. Attached to the grid container, not window (so it doesn't fight
   the browser address bar / app shell shortcuts). */

/** Given a starting (row, col) and direction, return the next data-edge target.
 *  "Empty" = null or empty string. Rules:
 *  - filled + next filled → last filled of run
 *  - filled + next empty  → first filled after empty stretch (or edge)
 *  - empty              → first filled in direction (or edge)
 */
export function findEdge<Row>(
  rows: Row[],
  cols: ColumnDef<Row>[],
  getValue: (row: Row, field: string) => unknown,
  fromRow: number,
  fromCol: number,
  dir: "up" | "down" | "left" | "right",
): { row: number; col: number } {
  const dr = dir === "down" ? 1 : dir === "up" ? -1 : 0;
  const dc = dir === "right" ? 1 : dir === "left" ? -1 : 0;
  const isEmpty = (r: number, c: number): boolean => {
    const row = rows[r];
    const col = cols[c];
    if (!row || !col) return true;
    const v = getValue(row, col.field);
    return v == null || v === "";
  };
  let r = fromRow,
    c = fromCol;
  const lastR = rows.length - 1,
    lastC = cols.length - 1;
  const startEmpty = isEmpty(r, c);
  // Step once to inspect the neighbour
  const nr = r + dr,
    nc = c + dc;
  if (nr < 0 || nr > lastR || nc < 0 || nc > lastC) return { row: r, col: c };
  const neighbourEmpty = isEmpty(nr, nc);
  if (!startEmpty && !neighbourEmpty) {
    // walk forward while next is filled
    while (true) {
      const nextR = r + dr,
        nextC = c + dc;
      if (nextR < 0 || nextR > lastR || nextC < 0 || nextC > lastC) break;
      if (isEmpty(nextR, nextC)) break;
      r = nextR;
      c = nextC;
    }
    return { row: r, col: c };
  }
  // startEmpty OR neighbourEmpty: walk past empties to first filled, or to edge
  r = nr;
  c = nc;
  while (isEmpty(r, c)) {
    const nextR = r + dr,
      nextC = c + dc;
    if (nextR < 0 || nextR > lastR || nextC < 0 || nextC > lastC) return { row: r, col: c };
    r = nextR;
    c = nextC;
  }
  return { row: r, col: c };
}

interface Opts<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: ColumnDef<Row>[];
  getValue?: (row: Row, field: string) => unknown;
  onCommit?: () => void; // grid asks the host to actually persist
  onSelectAll?: () => void;
  onBulkDelete?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Disable type-to-edit (printable char enters edit mode). Off when the host
   *  owns single-key actions via DataGrid's onCellKeyDown. Default true. */
  typeToEdit?: boolean;
}

export function useGridCursor<Row>({
  rows,
  rowKey,
  columns,
  getValue,
  onCommit,
  onSelectAll,
  onBulkDelete,
  onUndo,
  onRedo,
  typeToEdit = true,
}: Opts<Row>) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // visible navigable columns — all non-hidden columns, including read-only ones
  const navCols = useMemo(() => columns.filter((c) => !c.hidden), [columns]);

  // O(1) lookups for cursor moves — findIndex() on every arrow keystroke
  // turned into the dominant cost at 1k+ rows.
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) m.set(rowKey(rows[i] as Row), i);
    return m;
  }, [rows, rowKey]);
  const colIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < navCols.length; i++) m.set(navCols[i]!.field, i);
    return m;
  }, [navCols]);

  const move = useCallback(
    (dx: number, dy: number) => {
      setCursor((cur) => {
        if (!cur) {
          const r0 = rows[0];
          const c0 = navCols[0];
          return r0 && c0 ? { rowKey: rowKey(r0), field: c0.field, editing: false } : null;
        }
        const ri = rowIndex.get(cur.rowKey) ?? -1;
        const ci = colIndex.get(cur.field) ?? -1;
        const nr = Math.max(0, Math.min(rows.length - 1, ri + dy));
        const nc = Math.max(0, Math.min(navCols.length - 1, ci + dx));
        const row = rows[nr];
        const col = navCols[nc];
        return row && col ? { rowKey: rowKey(row), field: col.field, editing: false } : cur;
      });
    },
    [rows, navCols, rowKey, rowIndex, colIndex],
  );

  // Horizontal move that wraps at the row edges (Sheets/Excel convention).
  // ArrowRight on last col → next row, first col. ArrowLeft on first col →
  // previous row, last col. Top-left / bottom-right corners clamp. Used for
  // plain ArrowLeft/Right and Tab/Shift-Tab (both in and out of edit mode).
  const moveH = useCallback(
    (delta: -1 | 1) => {
      setCursor((cur) => {
        if (!cur) return cur;
        const ri = rowIndex.get(cur.rowKey) ?? -1;
        const ci = colIndex.get(cur.field) ?? -1;
        if (ri < 0 || ci < 0) return cur;
        let nr = ri;
        let nc = ci + delta;
        if (nc >= navCols.length) {
          if (ri >= rows.length - 1) return cur; // bottom-right corner clamps
          nr = ri + 1;
          nc = 0;
        } else if (nc < 0) {
          if (ri <= 0) return cur; // top-left corner clamps
          nr = ri - 1;
          nc = navCols.length - 1;
        }
        const row = rows[nr];
        const col = navCols[nc];
        return row && col
          ? { rowKey: rowKey(row), field: col.field, editing: cur.editing, initial: cur.initial }
          : cur;
      });
    },
    [rows, navCols, rowKey, rowIndex, colIndex],
  );

  const startEdit = useCallback(
    (initial?: string) =>
      setCursor((c) => {
        if (!c) return c;
        const col = navCols.find((col) => col.field === c.field);
        if (!col || col.editable === false) return c;
        return { ...c, editing: true, initial };
      }),
    [navCols],
  );
  const stopEdit = useCallback(
    () => setCursor((c) => (c ? { ...c, editing: false, initial: undefined } : c)),
    [],
  );

  // auto-scroll the focused cell into view — but only when it's actually
  // off-screen. block:"nearest" treats cells partially obscured by the sticky
  // header as visible and "optimizes" by scrolling them out from under it,
  // producing a click-jump on cells that are already on-screen. Compare rects
  // against the scroll container (accounting for sticky-header overlap at the
  // top) and bail when the cell is fully visible.
  useEffect(() => {
    if (!cursor || !ref.current) return;
    const cont = ref.current;
    const sel = `[data-cell="${cursor.rowKey}::${cursor.field}"]`;
    const el = cont.querySelector<HTMLElement>(sel);
    if (!el) return;
    const contRect = cont.getBoundingClientRect();
    const cellRect = el.getBoundingClientRect();
    const header = cont.querySelector<HTMLElement>('[role="row"][aria-rowindex="1"]');
    const headerH = header?.getBoundingClientRect().height ?? 0;
    // clientWidth/clientHeight exclude scrollbars — without this, cells under
    // the horizontal scrollbar register as off-screen and trigger a scroll on
    // click.
    const visibleLeft = contRect.left;
    const visibleRight = contRect.left + cont.clientWidth;
    const visibleTop = contRect.top + headerH;
    const visibleBottom = contRect.top + cont.clientHeight;
    // 1px tolerance for sub-pixel rounding at the edges.
    const EPS = 1;
    const fullyVisible =
      cellRect.top >= visibleTop - EPS &&
      cellRect.bottom <= visibleBottom + EPS &&
      cellRect.left >= visibleLeft - EPS &&
      cellRect.right <= visibleRight + EPS;
    if (!fullyVisible) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cursor object ref excluded; only rowKey/field trigger scroll; adding cursor would scroll on every editing-state change too
  }, [cursor?.rowKey, cursor?.field]);

  // When an edit ends but the cursor stays on a cell (Escape / blur-cancel),
  // the editor <input> unmounts and the browser drops focus to <body> — arrows,
  // undo, and type-to-edit all go dead until the user clicks back in. Return
  // focus to the grid so keyboard flow continues. The commit-and-advance path
  // (Enter/Tab) re-enters edit in the same tick, so `editing` never lands on
  // false here; this only fires on a genuine edit-exit. We only reclaim focus
  // when it was orphaned to <body>, so clicking elsewhere still works.
  const wasEditingRef = useRef(false);
  useEffect(() => {
    const editing = cursor?.editing ?? false;
    if (wasEditingRef.current && !editing && cursor && ref.current) {
      const active = document.activeElement;
      if (!active || active === document.body) ref.current.focus();
    }
    wasEditingRef.current = editing;
  }, [cursor]);

  // When the host's rows change (filter toggle, async save), the cursor may
  // point at a row that no longer exists. Instead of dropping focus (which
  // would break the workbench A/A/A triage loop — accept → row leaves → next
  // A is a no-op), move the cursor to whatever row now occupies the same
  // index. Same UX as Linear archiving in a list. Tracked via lastIndexRef so
  // we know where the cursor *was* before the row vanished.
  const lastIndexRef = useRef(-1);
  useEffect(() => {
    if (!cursor) {
      lastIndexRef.current = -1;
      return;
    }
    const present = rowIndex.get(cursor.rowKey) ?? -1;
    if (present >= 0) {
      lastIndexRef.current = present;
      return;
    }
    if (rows.length === 0) {
      setCursor(null);
      lastIndexRef.current = -1;
      return;
    }
    const targetIdx = Math.max(0, Math.min(lastIndexRef.current, rows.length - 1));
    const targetRow = rows[targetIdx];
    if (!targetRow) {
      setCursor(null);
      return;
    }
    setCursor({ rowKey: rowKey(targetRow), field: cursor.field, editing: false });
    lastIndexRef.current = targetIdx;
  }, [rows, cursor, rowKey, rowIndex]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!cursor) return;
      const editing = cursor.editing;

      // Cmd+Z / Cmd+Shift+Z first (work even while editing)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        (e.shiftKey ? onRedo : onUndo)?.();
        return;
      }

      if (editing) {
        // Enter / Tab commit + advance + re-enter edit on the destination so the
        // user can keep typing (Airtable convention; user-requested).
        // Esc cancels; everything else falls through to the editor.
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit?.();
          stopEdit();
          move(0, e.shiftKey ? -1 : 1);
          startEdit();
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          onCommit?.();
          stopEdit();
          moveH(e.shiftKey ? -1 : 1);
          startEdit();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          stopEdit();
          return;
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setCursor(null);
        return;
      }

      const isCmd = e.metaKey || e.ctrlKey;
      if (
        isCmd &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight")
      ) {
        e.preventDefault();
        const ri = rowIndex.get(cursor.rowKey) ?? -1;
        const ci = colIndex.get(cursor.field) ?? -1;
        if (ri < 0 || ci < 0) return;
        const dir =
          e.key === "ArrowUp"
            ? "up"
            : e.key === "ArrowDown"
              ? "down"
              : e.key === "ArrowLeft"
                ? "left"
                : "right";
        if (e.shiftKey) return; // grid handles shift+meta+arrow
        const resolvedGetValue =
          getValue ?? ((r: Row, f: string) => (r as Record<string, unknown>)[f]);
        const target = findEdge(rows, navCols, resolvedGetValue, ri, ci, dir);
        const row = rows[target.row];
        const col = navCols[target.col];
        if (row && col) setCursor({ rowKey: rowKey(row), field: col.field, editing: false });
        return;
      }
      if (isCmd && e.key === "Home") {
        e.preventDefault();
        const row = rows[0],
          col = navCols[0];
        if (row && col) setCursor({ rowKey: rowKey(row), field: col.field, editing: false });
        return;
      }
      if (isCmd && e.key === "End") {
        e.preventDefault();
        const row = rows[rows.length - 1],
          col = navCols[navCols.length - 1];
        if (row && col) setCursor({ rowKey: rowKey(row), field: col.field, editing: false });
        return;
      }
      // Plain Home/End: jump to the first/last column of the current row.
      if (e.key === "Home") {
        e.preventDefault();
        const col = navCols[0];
        if (col) setCursor({ rowKey: cursor.rowKey, field: col.field, editing: false });
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        const col = navCols[navCols.length - 1];
        if (col) setCursor({ rowKey: cursor.rowKey, field: col.field, editing: false });
        return;
      }
      // PageUp/PageDown: move the cursor ~one viewport; the scroll-into-view
      // effect keeps it visible. Page size is measured from the container so it
      // tracks the actual row height.
      if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const cont = ref.current;
        const rowEl = cont?.querySelector<HTMLElement>("[data-row]");
        const rowH = rowEl?.getBoundingClientRect().height || 37;
        const page = cont ? Math.max(1, Math.floor(cont.clientHeight / rowH) - 1) : 10;
        move(0, e.key === "PageDown" ? page : -page);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        move(0, -1);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(0, 1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        moveH(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        moveH(1);
        return;
      }
      // Plain Enter starts editing; ⌘/Ctrl+Enter is left unhandled so it can
      // reach the host's onCellKeyDown (e.g. Match's ⌘↵ publish binding).
      if (e.key === "Enter" && !isCmd) {
        e.preventDefault();
        startEdit();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        moveH(e.shiftKey ? -1 : 1);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        onSelectAll?.();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
        e.preventDefault();
        onBulkDelete?.();
        return;
      }
      // Type-to-edit: any printable single character (no modifier) enters edit
      // mode with that character as the seed value. Standard spreadsheet feel.
      // Skipped when the host owns printable keys (DataGrid onCellKeyDown).
      if (typeToEdit && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        startEdit(e.key);
        return;
      }
    },
    [
      cursor,
      move,
      moveH,
      startEdit,
      stopEdit,
      onCommit,
      onSelectAll,
      onBulkDelete,
      onUndo,
      onRedo,
      rows,
      navCols,
      rowKey,
      rowIndex,
      colIndex,
      getValue,
      typeToEdit,
    ],
  );

  return { cursor, setCursor, startEdit, stopEdit, move, onKeyDown, ref, findEdge, navCols };
}
