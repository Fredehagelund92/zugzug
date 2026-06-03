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
  return (
    <input
      ref={ref} value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => commit(v.trim() === "" ? null : v)}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        // Enter / Tab handled by useGridCursor (it calls commit via the host)
      }}
      className={inputBase}
    />
  );
}

export const TextCell = { Renderer, Editor };
