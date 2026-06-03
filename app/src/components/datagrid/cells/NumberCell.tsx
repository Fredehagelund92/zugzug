import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase = "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-right font-mono text-[12px] text-ink outline-none tabular-nums";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const n = value == null || value === "" ? null : Number(value);
  return n != null && Number.isFinite(n) ? (
    <span className="text-right tabular-nums font-mono text-[12px] text-ink">{n}</span>
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
      ref={ref} value={v} inputMode="decimal"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const t = v.trim();
        if (t === "") commit(null);
        else {
          const n = Number(t);
          commit(Number.isFinite(n) ? n : null);
        }
      }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } }}
      className={inputBase}
    />
  );
}

export const NumberCell = { Renderer, Editor };
