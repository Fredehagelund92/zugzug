import { cx } from "../../lib/cx";
import { bucket as bucketFor, type Bucket } from "./bucket";

/* Chip — single-select rendering. Pass `bucket` explicitly to override the
   default label-hash (Mapping uses this for semantic status chips: mapped=ok,
   skipped=neutral, new=warn). When omitted, derived from the label. */

const STYLES: Record<Bucket, string> = {
  "chip-1": "bg-ok-soft text-ok",
  "chip-2": "bg-warn-soft text-warn",
  "chip-3": "bg-accent-soft text-accent",
  "chip-4": "border-[color:var(--ak-accent-2)]/30 bg-[color:var(--ak-accent-2)]/16 text-[#B8780F]",
  "chip-5": "border border-line-2 bg-surface-2 text-ink-2",
};

export function Chip({
  label, bucket, className, dot,
}: { label: string; bucket?: Bucket; className?: string; dot?: boolean }) {
  const b = bucket ?? bucketFor(label);
  return (
    <span className={cx(
      "inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[11px] font-medium",
      STYLES[b], className,
    )}>
      {dot && <span className="h-1.5 w-1.5 rounded-pill bg-current" />}
      {label}
    </span>
  );
}
