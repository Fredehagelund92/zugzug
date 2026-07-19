import type { ComponentPropsWithoutRef, ElementType } from "react";
import { cx } from "../lib/cx";

/* Panel — the one framed container for document pages. White surface, hairline
   border, gentle 8px radius (--r-lg, see DESIGN.md §5), clipped. No shadow: shadow
   signals "floating above the page" and belongs to overlays only; an in-page
   Panel separates via the border and the lattice ground. See DESIGN.md §7.

   Surface tint is structural — a Panel is always white (`--surface`). Insets
   inside it go gray (`--surface-2`). Never pick tint by meaning.

   Renders a <div> by default; pass `as` to preserve semantics (e.g. section). */
const PADDING = {
  none: "",
  sm: "p-4",
  md: "p-6",
} as const;

export type PanelProps<T extends ElementType = "div"> = {
  as?: T;
  /** none = tables/grids that fill the frame · sm = compact box · md = content (default). */
  padding?: keyof typeof PADDING;
  className?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "padding">;

export function Panel<T extends ElementType = "div">({
  as,
  padding = "md",
  className,
  ...rest
}: PanelProps<T>) {
  const Comp = (as ?? "div") as ElementType;
  return (
    <Comp
      className={cx(
        "overflow-hidden rounded-lg border border-line bg-surface",
        PADDING[padding],
        className,
      )}
      {...rest}
    />
  );
}
