import { useEffect, useState, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const WIDTH = 320;
const GAP = 6;

export function FieldDescriptionEditor({
  field,
  initial,
  onSave,
  onClose,
  anchorRef,
  anchorRect,
}: {
  field: string;
  initial: string | null;
  onSave: (next: string | null) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  anchorRect?: DOMRect | null;
}) {
  const [value, setValue] = useState(initial ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const popover = ref.current;
    const rect = anchorRect ?? anchorRef.current?.getBoundingClientRect() ?? null;
    if (!rect) return;
    let left = rect.left;
    let top = rect.bottom + GAP;
    if (left + WIDTH > window.innerWidth - 8) left = window.innerWidth - WIDTH - 8;
    if (left < 8) left = 8;
    const h = popover?.offsetHeight ?? 0;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - GAP - h);
    setPos({ top, left });
  }, [anchorRef, anchorRect]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const popover = ref.current;
      const anchor = anchorRef.current;
      const target = e.target as Node;
      if (popover && popover.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose, anchorRef]);

  if (!pos) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Edit description for ${field}`}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 50, width: WIDTH }}
      className="rounded-lg border border-line-2 bg-surface-elevated p-3 shadow-pop"
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        Description
      </div>
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-[12px] text-ink"
        placeholder="What does this field mean? Where does it come from?"
      />
      <div className="mt-2 flex justify-end gap-1">
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-[11px] text-ink-2 hover:bg-hover"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            onSave(value.trim() || null);
            onClose();
          }}
          className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:brightness-110"
        >
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
}
