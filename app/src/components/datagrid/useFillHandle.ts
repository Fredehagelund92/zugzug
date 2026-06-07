import { useCallback, useEffect, useRef, useState } from "react";
import type { ColumnDef } from "./types";

interface RangeCorner { rowKey: string; field: string }
interface RangeState { anchor: RangeCorner; focus: RangeCorner }

interface Opts<Row> {
  range: RangeState | null;
  sortedRows: Row[];
  rowKey: (r: Row) => string;
  orderedVisible: ColumnDef<Row>[];
  rowIndexMap: Map<string, number>;
  getValue: (r: Row, f: string) => unknown;
  commitValue: (rk: string, field: string, value: unknown) => Promise<void>;
  setRange: (r: RangeState | null) => void;
  beginTransaction: (label: string) => void;
  endTransaction: () => void;
  flashCell: (rk: string, field: string) => void;
}

export function useFillHandle<Row>(opts: Opts<Row>) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  // Fix 1: track the hovered row synchronously so fast drags don't land one
  // row behind React's render cycle (rangeRef via useEffect is async).
  const fillFocusRowKeyRef = useRef<string | null>(null);

  // Fix 2: gate re-entry while a commit is in flight so concurrent drags
  // don't corrupt undo transactions.
  const committingRef = useRef(false);

  // Fix 3: track currently-attached window listeners so they can be removed
  // on unmount if a drag is still active when the component unmounts.
  const activeListenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
  } | null>(null);

  // Cleanup on unmount — remove any lingering window listeners.
  useEffect(() => {
    return () => {
      const active = activeListenersRef.current;
      if (active) {
        window.removeEventListener("pointermove", active.move);
        window.removeEventListener("pointerup", active.up);
        activeListenersRef.current = null;
      }
    };
  }, []);

  // Keep a stable ref to opts so the closure inside onHandlePointerDown
  // always sees the latest values without recreating event listeners.
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; }, [opts]);

  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || !optsRef.current.range) return;
    // Fix 2: prevent a second drag from starting while the first is committing.
    if (committingRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = true;
    setDragging(true);
    // Fix 1: reset the sync ref at drag start.
    fillFocusRowKeyRef.current = null;

    const o = optsRef.current;
    const sourceRange = o.range!;
    const anchorRowIdx = o.rowIndexMap.get(sourceRange.anchor.rowKey) ?? 0;
    const focusRowIdx = o.rowIndexMap.get(sourceRange.focus.rowKey) ?? 0;
    const srcMinRow = Math.min(anchorRowIdx, focusRowIdx);
    const srcMaxRow = Math.max(anchorRowIdx, focusRowIdx);

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const cellEl = target?.closest<HTMLElement>("[data-cell]");
      if (!cellEl) return;
      const data = cellEl.dataset.cell;
      if (!data) return;
      const sep = data.indexOf("::");
      if (sep < 0) return;
      const targetRk = data.slice(0, sep);
      const cur = optsRef.current;
      const targetRowIdx = cur.rowIndexMap.get(targetRk);
      if (targetRowIdx == null) return;
      const newFocusRow = cur.sortedRows[targetRowIdx];
      if (!newFocusRow) return;
      // Fix 1: write the new row key synchronously BEFORE setRange so onUp
      // always reads the latest value even if React hasn't committed yet.
      const newRowKey = cur.rowKey(newFocusRow);
      fillFocusRowKeyRef.current = newRowKey;
      cur.setRange({
        anchor: sourceRange.anchor,
        focus: { rowKey: newRowKey, field: sourceRange.focus.field },
      });
    };

    const onUp = async () => {
      draggingRef.current = false;
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Fix 3: clear the tracked listeners ref.
      activeListenersRef.current = null;
      // Fix 1: read from the synchronous ref, not rangeRef.
      const finalRk = fillFocusRowKeyRef.current;
      if (!finalRk) return;
      const cur = optsRef.current;
      const finalFocusRowIdx = cur.rowIndexMap.get(finalRk) ?? -1;
      if (finalFocusRowIdx < 0) return;
      const goingDown = finalFocusRowIdx > srcMaxRow;
      const goingUp = finalFocusRowIdx < srcMinRow;
      if (!goingDown && !goingUp) return;
      const targetRowIdxs: number[] = goingDown
        ? Array.from({ length: finalFocusRowIdx - srcMaxRow }, (_, i) => srcMaxRow + 1 + i)
        : Array.from({ length: srcMinRow - finalFocusRowIdx }, (_, i) => finalFocusRowIdx + i);
      const srcAnchorColIdx = cur.orderedVisible.findIndex((c) => c.field === sourceRange.anchor.field);
      const srcFocusColIdx = cur.orderedVisible.findIndex((c) => c.field === sourceRange.focus.field);
      const srcMinColIdx = Math.min(srcAnchorColIdx, srcFocusColIdx);
      const srcMaxColIdx = Math.max(srcAnchorColIdx, srcFocusColIdx);
      const srcCols = cur.orderedVisible.slice(srcMinColIdx, srcMaxColIdx + 1);
      const srcRowCount = srcMaxRow - srcMinRow + 1;
      const writes: Array<{ rk: string; field: string; value: unknown }> = [];
      for (let i = 0; i < targetRowIdxs.length; i++) {
        const targetIdx = targetRowIdxs[i]!;
        const targetRow = cur.sortedRows[targetIdx];
        if (!targetRow) continue;
        const srcIdxInRange = goingDown ? i % srcRowCount : (srcRowCount - 1) - (i % srcRowCount);
        const srcRow = cur.sortedRows[srcMinRow + srcIdxInRange];
        if (!srcRow) continue;
        for (const col of srcCols) {
          if (col.editable === false) continue;
          const value = cur.getValue(srcRow, col.field);
          writes.push({ rk: cur.rowKey(targetRow), field: col.field, value });
        }
      }
      if (writes.length === 0) return;
      const label = `fill ${writes.length} cell${writes.length === 1 ? "" : "s"}`;
      cur.beginTransaction(label);
      // Fix 2: set committingRef before the await, clear in finally.
      committingRef.current = true;
      try {
        await Promise.all(writes.map((w) => cur.commitValue(w.rk, w.field, w.value)));
      } finally {
        cur.endTransaction();
        for (const w of writes) cur.flashCell(w.rk, w.field);
        committingRef.current = false;
      }
    };

    // Fix 3: store the listener refs before attaching.
    activeListenersRef.current = { move: onMove, up: onUp };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []); // stable — reads everything via optsRef

  return { onHandlePointerDown, dragging };
}
