import type { HTMLAttributes } from "react";
import { cx } from "../lib/cx";

/* Panel — the one framed container for document pages. White surface, hairline
   border, large radius (square under square-mode), clipped. No shadow: shadow
   signals "floating above the page" and belongs to overlays only; an in-page
   Panel separates via the border and the lattice ground. See DESIGN.md §7.

   Surface tint is structural — a Panel is always white (`--surface`). Insets
   inside it go gray (`--surface-2`). Never pick tint by meaning. */
const PADDING = {
  none: "",
  sm: "p-4",
  md: "p-6",
} as const;

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** none = tables/grids that fill the frame · sm = compact box · md = content (default). */
  padding?: keyof typeof PADDING;
}

export function Panel({ padding = "md", className, ...rest }: PanelProps) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-lg border border-line bg-surface",
        PADDING[padding],
        className,
      )}
      {...rest}
    />
  );
}
