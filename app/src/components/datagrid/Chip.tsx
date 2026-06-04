import type { PaletteName } from "../../lib/palette";
import { PALETTE } from "../../lib/palette";

interface ChipProps {
  label: string;
  /** Curated palette tint. `null` / undefined renders the neutral chip. */
  color?: PaletteName | null;
}

export function Chip({ label, color }: ChipProps) {
  if (!color) {
    // Neutral chip — today's appearance (surface-3 background, ink-2 text)
    return (
      <span className="inline-flex items-center rounded-pill border border-line bg-surface-3 px-2.5 py-0.5 font-mono text-[10.5px] text-ink-2">
        {label}
      </span>
    );
  }
  const tint = PALETTE[color];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 font-mono text-[10.5px]"
      style={{ background: tint.wash, color: tint.fg, borderColor: tint.border }}
    >
      <span className="h-1.5 w-1.5 rounded-pill" style={{ background: tint.bg }} />
      {label}
    </span>
  );
}
