import type { ReactNode } from "react";
import { cx } from "../lib/cx";

/* StatsBar — the rounded horizontal panel that sits below a PageHeader and
   carries a row of mono labels + counts + actions (Mapping coverage panel,
   MasterTables record/field counts, …). Content is per-page; the wrapper is
   shared so density and rhythm don't drift. */
export function StatsBar({
  children,
  className,
  animationDelay,
}: {
  children: ReactNode;
  className?: string;
  animationDelay?: string;
}) {
  return (
    <div
      className={cx(
        "zz-rise flex flex-wrap items-center gap-x-6 gap-y-2.5 rounded-lg border border-line bg-surface px-5 py-4",
        className,
      )}
      style={animationDelay ? { animationDelay } : undefined}
    >
      {children}
    </div>
  );
}
