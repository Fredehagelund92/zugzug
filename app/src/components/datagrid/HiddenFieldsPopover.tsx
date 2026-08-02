import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { bindOverlayScroll } from "../../lib/overlay-scroll";
import type { ColumnDef } from "./types";

interface Props<Row> {
  hidden: ColumnDef<Row>[];
  anchorRef: React.RefObject<HTMLElement | null>;
  onUnhide: (field: string) => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 220;
const GAP = 4;

export function HiddenFieldsPopover<Row>({ hidden, anchorRef, onUnhide, onClose }: Props<Row>) {
  const ref = useRef<HTMLDivElement>(null);
  // Read through a ref so an inline `onClose` from the parent doesn't re-bind
  // (and re-place) the popover on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const pop = ref.current;
    const anchor = anchorRef.current;
    if (!pop || !anchor) return;
    const place = (): void => {
      const a = anchor.getBoundingClientRect();
      const popH = pop.offsetHeight;

      if (window.innerWidth < 768) {
        const margin = 16;
        const w = Math.min(POPOVER_WIDTH, window.innerWidth - margin * 2);
        pop.style.width = `${w}px`;
        pop.style.left = `${Math.max(margin, (window.innerWidth - w) / 2)}px`;
        let top = a.bottom + GAP;
        if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - GAP - popH);
        pop.style.top = `${top}px`;
        return;
      }

      pop.style.width = `${POPOVER_WIDTH}px`;
      let left = a.right - POPOVER_WIDTH;
      if (left < 8) left = 8;
      if (left + POPOVER_WIDTH > window.innerWidth - 8)
        left = window.innerWidth - POPOVER_WIDTH - 8;
      let top = a.bottom + GAP;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - GAP - popH);
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    };
    place();
    // A page scroll closes the popover rather than dragging it across the
    // screen (#197). Its toggles apply live, so nothing is lost — and onClose
    // is what an outside click already calls.
    return bindOverlayScroll({
      pop,
      anchor,
      place,
      onDismiss: () => closeRef.current(),
    });
  }, [anchorRef, hidden.length]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const pop = ref.current;
      const anchor = anchorRef.current;
      const target = e.target as Node;
      if (pop && pop.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose, anchorRef]);

  const item =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[11.5px] text-ink hover:bg-hover";

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: 0, left: 0 }}
      className="zz-pop-in z-40 rounded-sm border border-line-2 bg-surface-elevated p-1 shadow-pop"
    >
      <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        Hidden fields ({hidden.length})
      </div>
      {hidden.length === 0 ? (
        <div className="px-2 py-1 font-mono text-[11px] text-ink-3">Nothing hidden.</div>
      ) : (
        hidden.map((h) => (
          <button key={h.field} type="button" className={item} onClick={() => onUnhide(h.field)}>
            ↶ <span className="truncate">{h.label}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
