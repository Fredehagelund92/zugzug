import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase =
  "w-full h-full bg-transparent border-0 outline-none p-0 m-0 font-mono text-[12px] leading-normal text-ink";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="font-mono text-[12px] text-ink">{s}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-2">—</span>
  );
}

function Editor<Row>({ value, commit, cancel }: EditCtx<Row>) {
  const [v, setV] = useState(value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const commitNow = () => commit(v.trim() === "" ? null : v);
  return (
    <input
      ref={ref}
      type="date"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") commitNow();
      }}
      className={inputBase}
    />
  );
}

export const DateCell = { Renderer, Editor };
