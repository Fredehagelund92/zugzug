import { useState, useLayoutEffect, useRef } from "react";

export function FieldDescriptionEditor({
  field, initial, onSave, onClose, anchorRef,
}: {
  field: string;
  initial: string | null;
  onSave: (next: string | null) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const [value, setValue] = useState(initial ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left });
  }, [anchorRef]);

  if (!pos) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Edit description for ${field}`}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 50 }}
      className="w-[320px] rounded-lg border border-line-2 bg-surface-elevated p-3 shadow-pop"
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">Description</div>
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-[12px] text-ink"
        placeholder="What does this field mean? Where does it come from?"
      />
      <div className="mt-2 flex justify-end gap-1">
        <button onClick={onClose} className="rounded px-2 py-1 text-[11px] text-ink-2 hover:bg-hover">Cancel</button>
        <button
          onClick={() => { onSave(value.trim() === "" ? null : value); onClose(); }}
          className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:brightness-110"
        >Save</button>
      </div>
    </div>
  );
}
