import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import type { CellType, ColumnDef } from "./types";

interface Props<Row> {
  column: ColumnDef<Row>;
  sortDir: "asc" | "desc" | null;
  onClose: () => void;
  onRename: (newLabel: string) => void;
  onSort: (dir: "asc" | "desc" | null) => void;
  onChangeType: (newType: CellType) => void;
  onHide: () => void;
  onDelete: () => void;
}

const TYPES: CellType[] = ["text", "number", "boolean", "date", "select"];

export function ColumnHeaderMenu<Row>({ column, sortDir, onClose, onRename, onSort, onChangeType, onHide, onDelete }: Props<Row>) {
  const [mode, setMode] = useState<"menu" | "rename" | "type" | "confirm-delete">("menu");
  const [draft, setDraft] = useState(column.label);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[11.5px] text-ink hover:bg-hover";

  return (
    <div ref={ref} className="absolute right-0 top-full z-30 mt-1 w-48 rounded-sm border border-line-2 bg-surface p-1 shadow-lg">
      {mode === "menu" && (
        <>
          <button type="button" className={item} onClick={() => setMode("rename")}>✎ rename column</button>
          <button type="button" className={item} onClick={() => setMode("type")}>⇅ change type</button>
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => { onSort("asc"); onClose(); }}>↑ sort A→Z</button>
          <button type="button" className={item} onClick={() => { onSort("desc"); onClose(); }}>↓ sort Z→A</button>
          {sortDir != null && (
            <button type="button" className={item} onClick={() => { onSort(null); onClose(); }}>✕ clear sort</button>
          )}
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => { onHide(); onClose(); }}>⊘ hide column</button>
          <button type="button" className={cx(item, "text-danger")} onClick={() => setMode("confirm-delete")}>🗑 delete column</button>
        </>
      )}
      {mode === "rename" && (
        <div className="p-1">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onRename(draft.trim()); onClose(); }
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none"
          />
          <div className="mt-1.5 flex gap-1">
            <button type="button" className={cx(item, "justify-center bg-accent text-accent-ink hover:bg-accent")} onClick={() => { onRename(draft.trim()); onClose(); }}>save</button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>cancel</button>
          </div>
        </div>
      )}
      {mode === "type" && (
        <div>
          {TYPES.map((t) => (
            <button key={t} type="button"
              className={cx(item, column.type === t && "bg-accent-wash text-accent")}
              onClick={() => { if (t !== column.type) onChangeType(t); onClose(); }}
            >
              {t}{column.type === t ? " · current" : ""}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => setMode("menu")}>← back</button>
        </div>
      )}
      {mode === "confirm-delete" && (
        <div className="p-2 text-[11.5px] text-ink-2">
          <div className="font-mono">Delete <span className="text-ink">{column.label}</span>? This drops the column on every row.</div>
          <div className="mt-2 flex gap-1">
            <button type="button" className={cx(item, "justify-center bg-danger text-white")} onClick={() => { onDelete(); onClose(); }}>delete</button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
