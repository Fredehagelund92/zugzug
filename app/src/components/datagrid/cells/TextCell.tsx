import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase = "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="truncate font-mono text-[12px] text-ink">{s}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-3">—</span>
  );
}

function Editor<Row>({ value, commit, cancel }: EditCtx<Row>) {
  const [v, setV] = useState(value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const commitNow = () => commit(v.trim() === "" ? null : v);
  return (
    <input
      ref={ref} value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      // Enter / Tab commit synchronously: useGridCursor's stopEdit unmounts
      // the editor before the browser blur event reaches React, so onBlur
      // alone would silently drop the typed value.
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
        if (e.key === "Enter" || e.key === "Tab") commitNow();
      }}
      className={inputBase}
    />
  );
}

export const TextCell = { Renderer, Editor };
