import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef, Cursor } from "./types";

/* useGridCursor — owns the (rowKey, field, editing) cursor + the keyboard
   handler. Attached to the grid container, not window (so it doesn't fight
   the browser address bar / app shell shortcuts). */

interface Opts<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: ColumnDef<Row>[];
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
    ],
  );

  return { cursor, setCursor, startEdit, stopEdit, move, onKeyDown, ref };
}
