import { useEffect, useRef } from "react";
import type { CellCtx, EditCtx } from "../types";

function Stars({
  value,
  max,
  interactive,
  onPick,
}: {
  value: number | null;
  max: number;
  interactive: boolean;
  onPick?: (n: number) => void;
}) {
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => {
        const filled = value != null && i < value;
        return (
          <span
            key={i}
            aria-label={`${i + 1} star${i === 0 ? "" : "s"}`}
            role={interactive ? "button" : undefined}
            onClick={interactive && onPick ? () => onPick(i + 1) : undefined}
            className={
              interactive
                ? "cursor-pointer text-[13px] leading-none text-amber-400 hover:scale-110 transition-transform"
                : "text-[13px] leading-none text-amber-400"
            }
          >
            {filled ? "★" : "☆"}
          </span>
        );
      })}
    </span>
  );
}

function Renderer<Row>({ value, column }: CellCtx<Row>) {
  const max = column.config.type === "rating" ? column.config.ratingMax : 5;
  const n = value == null || value === "" ? null : Number(value);
  if (n == null || !Number.isFinite(n)) {
    return <span className="font-mono text-[12px] text-ink-3">—</span>;
  }
  return <Stars value={Math.round(n)} max={max} interactive={false} />;
}

function Editor<Row>({ value, initial, commit, cancel, column }: EditCtx<Row>) {
  const max = column.config.type === "rating" ? column.config.ratingMax : 5;
  const n = value == null || value === "" ? null : Number(value);
  const current = n != null && Number.isFinite(n) ? Math.round(n) : null;

  const ref = useRef<HTMLSpanElement>(null);
  // StrictMode double-invokes mount effects, which committed the seeded digit
  // twice — two writes and a duplicate undo entry (#198). The keystroke that
  // opened the editor is the user action here, so guard it to fire once.
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (initial != null) {
      if (!/^[1-9]$/.test(initial) || parseInt(initial, 10) > max) {
        cancel();
        return;
      }
      commit(parseInt(initial, 10));
      return;
    }
    ref.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span
      ref={ref}
      tabIndex={0}
      className="flex items-center gap-0.5 outline-none"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          commit(null);
          return;
        }
        const digit = parseInt(e.key, 10);
        if (!isNaN(digit) && digit >= 1 && digit <= max) {
          commit(digit);
          return;
        }
      }}
    >
      <Stars value={current} max={max} interactive={true} onPick={(n) => commit(n)} />
    </span>
  );
}

export const RatingCell = { Renderer, Editor };
