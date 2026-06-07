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
  onShortcuts?: () => void; // '?' → open shortcuts overlay
  onFocusFilter?: () => void; // '/' → focus toolbar filter
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
  onShortcuts,
  onFocusFilter,
}: Opts<Row>) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // visible navigable columns (skip hidden + non-editable pinned utility columns)
  const navCols = useMemo(
    () => columns.filter((c) => !c.hidden && c.editable !== false),
    [columns],
  );

  const move = useCallback(
    (dx: number, dy: number) => {
      setCursor((cur) => {
        if (!cur) {
          const r0 = rows[0];
          const c0 = navCols[0];
          return r0 && c0 ? { rowKey: rowKey(r0), field: c0.field, editing: false } : null;
        }
        const ri = rows.findIndex((r) => rowKey(r) === cur.rowKey);
        const ci = navCols.findIndex((c) => c.field === cur.field);
        const nr = Math.max(0, Math.min(rows.length - 1, ri + dy));
        const nc = Math.max(0, Math.min(navCols.length - 1, ci + dx));
        const row = rows[nr];
        const col = navCols[nc];
        return row && col ? { rowKey: rowKey(row), field: col.field, editing: false } : cur;
      });
    },
    [rows, navCols, rowKey],
  );

  const startEdit = useCallback(
    (initial?: string) => setCursor((c) => (c ? { ...c, editing: true, initial } : c)),
    [],
  );
  const stopEdit = useCallback(
    () => setCursor((c) => (c ? { ...c, editing: false, initial: undefined } : c)),
    [],
  );

  // auto-scroll the focused cell into view
  useEffect(() => {
    if (!cursor || !ref.current) return;
    const sel = `[data-cell="${cursor.rowKey}::${cursor.field}"]`;
    const el = ref.current.querySelector<HTMLElement>(sel);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor?.rowKey, cursor?.field]);

  // When the host's rows change (filter toggle, async save), drop the cursor if
  // its row vanished — prevents an orphan focus ring on a dead key.
  useEffect(() => {
    if (!cursor) return;
    const present = rows.some((r) => rowKey(r) === cursor.rowKey);
    if (!present) setCursor(null);
  }, [rows, cursor, rowKey]);

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
          move(e.shiftKey ? -1 : 1, 0);
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

      const isCmd = e.metaKey || e.ctrlKey;
      if (
        isCmd &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight")
      ) {
        e.preventDefault();
        const ri = rows.findIndex((r) => rowKey(r) === cursor.rowKey);
        const ci = navCols.findIndex((c) => c.field === cursor.field);
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
        move(-1, 0);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1, 0);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        startEdit();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        move(e.shiftKey ? -1 : 1, 0);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        onShortcuts?.();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        onFocusFilter?.();
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
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        startEdit(e.key);
        return;
      }
    },
    [
      cursor,
      move,
      startEdit,
      stopEdit,
      onCommit,
      onSelectAll,
      onBulkDelete,
      onUndo,
      onRedo,
      onShortcuts,
      onFocusFilter,
      rows,
      navCols,
      rowKey,
      getValue,
    ],
  );

  return { cursor, setCursor, startEdit, stopEdit, move, onKeyDown, ref, findEdge, navCols };
}
