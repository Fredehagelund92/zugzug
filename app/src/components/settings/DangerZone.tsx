import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

/* DangerZone — an in-page container for destructive-action sections.
   Mirrors Panel's structural classes but uses a danger-toned border so
   the red hairline is guaranteed (two Tailwind border-color utilities on
   the same element don't reliably cascade by string order). No shadow:
   shadow signals "floating above the page" and belongs to overlays only. */

const PADDING = {
  none: "",
  sm: "p-4",
  md: "p-6",
} as const;

export type DangerZoneProps = {
  padding?: keyof typeof PADDING;
  className?: string;
  children: ReactNode;
};

export function DangerZone({ padding = "sm", className, children }: DangerZoneProps) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-lg border border-danger/40 bg-surface",
        PADDING[padding],
        className,
      )}
    >
      {children}
    </div>
  );
}
