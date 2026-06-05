import { useCallback, useEffect, useState } from "react";

/* useSourcesCursor — owns the j/k cursor for the Sources ledger. Pure state
   machine + an onKeyDown factory; no DOM access. Auto-scroll-into-view is
   handled by the consumer (Sources.tsx) via a layout effect that watches
   `cursor` and queries the row element by data attribute. */

export interface SourcesCursorHandle {
  cursor: string | null;
  setCursor: (key: string | null) => void;
  isFocused: (key: string) => boolean;
}

interface Opts {
  visibleKeys: readonly string[];
  rowsWithUnmapped: readonly string[];
  toggleDrillAt: (key: string) => void;
  focusSearch: () => void;
}

export function useSourcesCursor(
  opts: Opts,
): SourcesCursorHandle & { onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void } {
  const { visibleKeys, rowsWithUnmapped, toggleDrillAt, focusSearch } = opts;
  const [cursor, setCursor] = useState<string | null>(null);

  // Staleness: when the visible row set changes and the cursor's key is no
  // longer in it, clear cursor. Same invariant as Task 1.4 of workbench-paradigm.
  useEffect(() => {
    if (cursor && !visibleKeys.includes(cursor)) setCursor(null);
  }, [visibleKeys, cursor]);

  const move = useCallback(
    (delta: 1 | -1) => {
      if (visibleKeys.length === 0) return;
      setCursor((cur) => {
        if (cur === null) return visibleKeys[0];
        const i = visibleKeys.indexOf(cur);
        if (i === -1) return visibleKeys[0];
        const next = Math.max(0, Math.min(visibleKeys.length - 1, i + delta));
        return visibleKeys[next];
      });
    },
    [visibleKeys],
  );

  const jumpToNextNeedsAttention = useCallback(() => {
    if (rowsWithUnmapped.length === 0) return;
    setCursor((cur) => {
      if (cur === null) return rowsWithUnmapped[0];
      const i = rowsWithUnmapped.indexOf(cur);
      if (i === -1) return rowsWithUnmapped[0];
      // wrap-once: advance, modulo length
      return rowsWithUnmapped[(i + 1) % rowsWithUnmapped.length];
    });
  }, [rowsWithUnmapped]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
        return;
      }
      if (e.key === "Enter") {
        if (cursor === null) return;
        e.preventDefault();
        toggleDrillAt(cursor);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        jumpToNextNeedsAttention();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCursor(null);
        return;
      }
    },
    [cursor, move, jumpToNextNeedsAttention, toggleDrillAt, focusSearch],
  );

  const isFocused = useCallback((key: string) => cursor === key, [cursor]);

  return { cursor, setCursor, isFocused, onKeyDown };
}
