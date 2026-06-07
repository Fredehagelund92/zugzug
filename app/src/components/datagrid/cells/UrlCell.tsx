import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase =
  "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const href = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  if (!href) return <span className="font-mono text-[12px] text-ink-3">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="flex min-w-0 items-center gap-1 font-mono text-[12px] text-accent hover:underline"
    >
      <span className="shrink-0 text-[10px] text-ink-3">↗</span>
      <span className="truncate">{href}</span>
    </a>
  );
}

function Editor<Row>({ value, initial, commit, cancel }: EditCtx<Row>) {
  const seeded = initial != null;
  const [v, setV] = useState(seeded ? initial : value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (seeded) {
      const el = ref.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    } else {
      ref.current?.select();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const commitNow = () => commit(v.trim() === "" ? null : v.trim());
  return (
    <input
      ref={ref}
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

export const UrlCell = { Renderer, Editor };
