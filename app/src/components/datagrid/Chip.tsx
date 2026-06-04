import { cx } from "../../lib/cx";
import { bucket as bucketFor, type Bucket } from "./bucket";
import type { PaletteName } from "../../lib/palette";
import { PALETTE } from "../../lib/palette";

/* Chip — two coexisting modes:
   1. Status chip — `bucket` (or label-hash-derived). Used by Mapping for
      Mapped/Skipped/New status. Semantic palette of 5 buckets.
   2. Option chip — `color` (curated 7-tint palette). Used by SelectCell and
      OptionBuilder for predetermined select-field options.
   `color` wins over `bucket` when both are passed. */

const STYLES: Record<Bucket, string> = {
  "chip-1": "bg-ok-soft text-ok",
  "chip-2": "bg-warn-soft text-warn",
  "chip-3": "bg-accent-soft text-accent",
  "chip-4": "bg-accent-2/16 border-accent-2/30 text-[***REMOVED***B8780F]",
  "chip-5": "border-line-2 bg-surface-2 text-ink-2",
};

interface ChipProps {
  label: string;
  /** Curated palette tint (option chips). Wins over `bucket` when set. */
  color?: PaletteName | null;
  /** Semantic status bucket (status chips). Derived from label if omitted. */
  bucket?: Bucket;
  className?: string;
  /** Renders a small leading dot. Implied when `color` is set. */
  dot?: boolean;
}

export function Chip({ label, color, bucket, className, dot }: ChipProps) {
  if (color) {
    const tint = PALETTE[color];
    return (
      <span
        className={cx(
          "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 font-mono text-[10.5px]",
          className,
        )}
        style={{ background: tint.wash, color: tint.fg, borderColor: tint.border }}
      >
        <span className="h-1.5 w-1.5 rounded-pill" style={{ background: tint.bg }} />
        {label}
      </span>
    );
  }
  const b = bucket ?? bucketFor(label);
  return (
    <span className={cx(
      "inline-flex items-center gap-1.5 rounded-sm border border-transparent px-2 py-0.5 font-mono text-[11px] font-medium",
      STYLES[b], className,
    )}>
      {dot && <span className="h-1.5 w-1.5 rounded-pill bg-current" />}
      {label}
    </span>
  );
}
