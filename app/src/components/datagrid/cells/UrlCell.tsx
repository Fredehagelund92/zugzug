import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase =
  "w-full h-full bg-transparent border-0 outline-none p-0 m-0 font-mono text-[12px] leading-normal text-ink";

// "example.com" without a scheme would otherwise resolve as a same-origin relative
// path — normalise to https:// so the link goes outside. Existing schemes pass
// through unchanged (http, https, mailto, tel, ftp, …); protocol-relative URLs
// (//cdn.example.com) also pass through.
function toHref(s: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return s;
  return `https://${s}`;
}

function Renderer<Row>({ value }: CellCtx<Row>) {
  const raw = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  if (!raw) return <span className="font-mono text-[12px] text-ink-3">—</span>;
  return (
    <a
      href={toHref(raw)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="flex min-w-0 items-center gap-1 font-mono text-[12px] text-accent hover:underline"
    >
      <span className="shrink-0 text-[10px] text-ink-3">↗</span>
      <span className="truncate">{raw}</span>
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
