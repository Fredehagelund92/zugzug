import { useEffect, useRef } from "react";
import { IconCheck } from "../../Icons";
import type { CellCtx, EditCtx } from "../types";

// The server casts field values to VARCHAR on read, so a boolean column
// arrives here as the string "true"/"false" rather than a real boolean.
// Coerce on read so the renderer and the editor agree on the cell state.
function isChecked(value: unknown): boolean {
  return value === true || value === "true";
}

function Renderer<Row>({ value }: CellCtx<Row>) {
  if (value == null) {
    return <span className="text-[12px] text-ink-3">—</span>;
  }
  return isChecked(value) ? (
    <span
      aria-label="true"
      className="grid h-4 w-4 place-items-center rounded-sm border border-accent bg-accent text-accent-ink"
    >
      <IconCheck className="h-3 w-3" strokeWidth={3} />
    </span>
  ) : (
    <span
      aria-label="false"
      className="grid h-4 w-4 place-items-center rounded-sm border border-line-2"
    />
  );
}

function Editor<Row>({ value, commit, cancel }: EditCtx<Row>) {
  // Commit from a real user action rather than on mount. Committing in a mount
  // effect made one toggle write twice under StrictMode — two PUTs and a
  // duplicate undo entry that swallowed a later undo (#198) — and it left no
  // room for Escape to cancel or for type-to-edit to open without writing.
  const ref = useRef<HTMLSpanElement>(null);
  const checked = isChecked(value);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <span
      ref={ref}
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "true" : "false"}
      tabIndex={0}
      className={
        "grid h-4 w-4 place-items-center rounded-sm outline-none ring-2 ring-accent " +
        (checked ? "border border-accent bg-accent text-accent-ink" : "border border-line-2")
      }
      onClick={() => commit(!checked)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          return;
        }
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          commit(!checked);
        }
      }}
    >
      {checked ? <IconCheck className="h-3 w-3" strokeWidth={3} /> : null}
    </span>
  );
}

export const BooleanCell = { Renderer, Editor };
