import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase =
  "w-full h-full bg-transparent border-0 outline-none p-0 m-0 font-mono text-[12px] leading-normal text-ink";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="truncate font-mono text-[12px] text-ink">{s}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-3">—</span>
  );
}

function Editor<Row>({ value, initial, commit, cancel }: EditCtx<Row>) {
  // When type-to-edit triggered us, the typed character replaces the value;
  // place the cursor at the end so the user can keep typing.
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
  const commitNow = () => commit(v.trim() === "" ? null : v);
  return (
    <input
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      // Enter / Tab commit synchronously: useGridCursor's stopEdit unmounts
      // the editor before the browser blur event reaches React, so onBlur
      // alone would silently drop the typed value.
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

export const TextCell = { Renderer, Editor };
