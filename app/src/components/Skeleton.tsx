import type { HTMLAttributes } from "react";
import { cx } from "../lib/cx";

interface SkeletonRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  columns: Array<number | string>;
}

export function SkeletonRow({ columns, className, ...rest }: SkeletonRowProps) {
  const grid = columns
    .map((c) => (typeof c === "number" ? (c === 1 ? "minmax(0,1fr)" : `${c}px`) : c))
    .join(" ");
  return (
    <div
      {...rest}
      aria-busy="true"
      className={cx("grid items-center gap-4 px-5 py-3.5", className)}
      style={{ gridTemplateColumns: grid }}
    >
      {columns.map((_, i) => (
        <span key={i} className="h-3 rounded-sm bg-surface-2 motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

interface SkeletonListProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  rows: number;
  columns: Array<number | string>;
}

export function SkeletonList({ rows, columns, className, ...rest }: SkeletonListProps) {
  return (
    <div {...rest} className={cx("border border-line divide-y divide-line", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
    </div>
  );
}
