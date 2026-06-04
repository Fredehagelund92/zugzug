import { useLayoutEffect } from "react";
import { IconCheck } from "../../Icons";
import type { CellCtx, EditCtx } from "../types";

function Renderer<Row>({ value }: CellCtx<Row>) {
  if (value == null) {
    return <span className="text-[12px] text-ink-3">—</span>;
  }
  return value ? (
    <span
      aria-label="true"
      className="grid h-4 w-4 place-items-center rounded-sm border border-accent bg-accent text-accent-ink"
    >
      <IconCheck className="h-3 w-3" strokeWidth={3} />
    </span>
  ) : (
    <span aria-label="false" className="grid h-4 w-4 place-items-center rounded-sm border border-line-2" />
  );
}

function Editor<Row>({ value, commit }: EditCtx<Row>) {
  // Enter / double-click toggles. Commit synchronously before paint to avoid
  // a one-frame flicker where the Editor briefly renders nothing.
  useLayoutEffect(() => {
    commit(value === true ? false : true);
  }, []);
  return null;
}

export const BooleanCell = { Renderer, Editor };
