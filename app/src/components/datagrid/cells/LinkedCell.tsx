import type { CellCtx, EditCtx } from "../types";
import type { ReactNode } from "react";

function Renderer<Row>({ value }: CellCtx<Row>): ReactNode {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="truncate font-mono text-[12px] text-ink">{s}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-3">—</span>
  );
}

function Editor<Row>({ value, cancel }: EditCtx<Row>): ReactNode {
  const s = value == null || value === "" ? null : String(value);
  return (
    <div
      className="flex items-center px-1.5 py-0.5"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <span className="truncate font-mono text-[12px] text-ink">{s || "—"}</span>
    </div>
  );
}

export const LinkedCell = { Renderer, Editor };
