import { cx } from "../lib/cx";

/* Kpi — stat card with the junction "connector tab" on its top edge, a mono
   label, a big tabular value, a trend delta, and a token-coloured sparkline.
   Lifts on hover. All colour token-backed (no hex). */
export function Kpi({
  label,
  value,
  delta,
  dir = "up",
  spark,
}: {
  label: string;
  value: string;
  delta?: string;
  dir?: "up" | "down";
  spark?: number[];
}) {
  return (
    <div className="zz-tab group rounded-lg border border-line bg-surface p-6 shadow-pop transition-[transform,border-color] duration-[var(--ak-dur)] hover:-translate-y-0.5 hover:border-line-2">
      <div className="font-mono text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="font-display text-3xl font-bold tracking-tight text-ink tabular-nums">{value}</div>
        {spark && (
          <div className="flex h-8 items-end gap-[3px]">
            {spark.map((v, i) => (
              <span
                key={i}
                className={cx(
                  "w-1 rounded-sm transition-colors",
                  i === spark.length - 1 ? "bg-accent" : "bg-accent/35 group-hover:bg-accent/55",
                )}
                style={{ height: `${v}%` }}
              />
            ))}
          </div>
        )}
      </div>
      {delta && (
        <div className={cx("mt-1 font-mono text-xs", dir === "up" ? "text-ok" : "text-danger")}>
          {dir === "up" ? "▲" : "▼"} {delta}
        </div>
      )}
    </div>
  );
}
