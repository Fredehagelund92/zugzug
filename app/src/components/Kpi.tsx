import { cx } from "../lib/cx";

/* Kpi — stat card with a mono label, a big tabular value, an optional trend
   delta + sparkline. Set `featured` for the single card that demands attention
   (it gets a 2px accent left border). All colour token-backed (no hex). */
export function Kpi({
  label,
  value,
  delta,
  dir = "up",
  spark,
  featured = false,
}: {
  label: string;
  value: string;
  delta?: string;
  dir?: "up" | "down" | "warn";
  spark?: number[];
  featured?: boolean;
}) {
  return (
    <div
      className={cx(
        "group rounded-lg border border-line bg-surface p-6 shadow-pop transition-[transform,border-color] duration-[var(--ak-dur)] hover:-translate-y-0.5 hover:border-line-2",
        featured && "border-l-2 border-l-accent",
      )}
    >
      <div className="font-mono text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="font-display text-3xl font-bold tracking-tight text-ink tabular-nums">
          {value}
        </div>
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
        <div
          className={cx(
            "mt-1 font-mono text-xs",
            dir === "up" ? "text-ok" : dir === "warn" ? "text-warn" : "text-danger",
          )}
        >
          {dir === "up" ? "▲ " : dir === "down" ? "▼ " : ""}{delta}
        </div>
      )}
    </div>
  );
}
