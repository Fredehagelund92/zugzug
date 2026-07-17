import { cx } from "../lib/cx";

/* Kpi — stat card with a mono label, a big tabular value, an optional trend
   delta + sparkline. Set `featured` for the coverage KPI (teal-tinted bg +
   teal value). Set `coveragePct` (0-100) to render an inline coverage bar.
   All colour token-backed (no hex). */
export function Kpi({
  label,
  value,
  delta,
  dir = "up",
  spark,
  featured = false,
  coveragePct,
}: {
  label: string;
  value: string;
  delta?: string;
  dir?: "up" | "down" | "warn";
  spark?: number[];
  featured?: boolean;
  /** 0-100 — when provided renders an inline coverage bar (committed teal) */
  coveragePct?: number;
}) {
  return (
    <div
      className="group h-full rounded-lg border border-line bg-surface p-4 shadow-pop transition-[transform,border-color] duration-[var(--ak-dur)] hover:-translate-y-0.5 hover:border-line-2 md:p-6"
      style={
        featured
          ? {
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--ak-committed) 8%, var(--surface)), var(--surface))",
            }
          : undefined
      }
    >
      <div className="font-mono text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div
          className="font-display text-3xl font-bold tracking-tight tabular-nums"
          style={{ color: featured ? "var(--ak-committed)" : "var(--ink)" }}
        >
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
          {dir === "up" ? "▲ " : dir === "down" ? "▼ " : ""}
          {delta}
        </div>
      )}
      {coveragePct !== undefined && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-pill bg-surface-3"
          aria-label={`${coveragePct.toFixed(1)}% coverage`}
        >
          <div
            className="h-full rounded-pill transition-[width]"
            style={{ width: `${coveragePct}%`, background: "var(--ak-committed)" }}
          />
        </div>
      )}
    </div>
  );
}
