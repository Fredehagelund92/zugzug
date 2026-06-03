import type { HTMLAttributes } from "react";
import { cx } from "../lib/cx";

/* Card — Tailwind conversion of `.ak-card`: surface, hairline, large radius,
   brand shadow. `interactive` lifts on hover. All token-backed, no hex. */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive, className, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        "rounded-lg border border-line bg-surface p-6 shadow-pop",
        interactive &&
          "cursor-pointer transition-[transform,border-color,box-shadow] duration-[var(--ak-dur)] hover:-translate-y-0.5 hover:border-line-2",
        className,
      )}
      {...rest}
    />
  );
}
