import type { HTMLAttributes } from "react";
import { cx } from "../lib/cx";

/* PageContainer — the one page frame for document pages. Centered, padded,
   capped at --wide (1320) by default. `max="doc"` narrows to --doc (1040) for
   single-column reading/forms pages (tenant settings, Account); `max="full"`
   drops the cap for wide data tables (admin Users/Workspaces, Activity).
   See DESIGN.md §5, §7 and ADR-0004.

   The grid pages (Sources, Review, Master tables) are bespoke full-bleed
   experiences and deliberately do NOT use this — see ADR-0003. */
export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  /** wide = 1320 (default) · doc = 1040 narrow column · full = edge-to-edge. */
  max?: "wide" | "doc" | "full";
}

export function PageContainer({ max = "wide", className, ...rest }: PageContainerProps) {
  return (
    <div
      className={cx(
        "mx-auto w-full p-4 md:p-8",
        max === "wide" && "max-w-[var(--wide)]",
        max === "doc" && "max-w-[var(--doc)]",
        className,
      )}
      {...rest}
    />
  );
}
