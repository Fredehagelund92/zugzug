import type { CellCtx, EditCtx } from "../types";
import type { ReactNode } from "react";
import { useEffect } from "react";

function Renderer<Row>({ value }: CellCtx<Row>): ReactNode {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="truncate font-mono text-[12px] text-ink">{s}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-3">—</span>
  );
}

function Editor<Row>({ cancel }: EditCtx<Row>): ReactNode {
  useEffect(() => {
    cancel();
  }, [cancel]);
  return null;
}

export const LinkedCell = { Renderer, Editor };
