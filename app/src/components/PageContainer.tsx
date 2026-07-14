import type { HTMLAttributes } from "react";
import { cx } from "../lib/cx";

/* PageContainer — the one page frame for document pages. Centered, padded,
   capped at --wide (1320) by default. `max="full"` drops the cap for wide data
   tables (e.g. admin Users/Workspaces). See DESIGN.md §5, §7.

   The grid pages (Sources, Review, Master tables) are bespoke full-bleed
   experiences and deliberately do NOT use this — see ADR-0003. */
export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  /** wide = capped at 1320 (default) · full = edge-to-edge for wide tables. */
  max?: "wide" | "full";
}

export function PageContainer({ max = "wide", className, ...rest }: PageContainerProps) {
  return (
    <div
      className={cx(
        "mx-auto w-full p-4 md:p-8",
        max === "wide" && "max-w-[var(--wide)]",
        className,
      )}
      {...rest}
    />
  );
}
