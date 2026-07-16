import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import type { Mode } from "../../lib/available-modes";

interface ModeStripProps {
  modes: readonly Mode[];
  active: Mode;
  onSelect: (m: Mode) => void;
  /** badge counts per mode — accent count for match (new), warn dot for sources (unmapped). */
  badges?: Partial<Record<Mode, { count?: number; warn?: boolean }>>;
}

const LABEL: Record<Mode, string> = {
  records: "Records",
  match: "Map values",
  sources: "Sources",
};

export function ModeStrip({ modes, active, onSelect, badges }: ModeStripProps) {
  const refs = useRef<Record<Mode, HTMLButtonElement | null>>({
    records: null,
    match: null,
    sources: null,
  });
  const [marker, setMarker] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const btn = refs.current[active];
    const parent = btn?.parentElement;
    if (!btn || !parent) return;
    const pBox = parent.getBoundingClientRect();
    const bBox = btn.getBoundingClientRect();
    setMarker({ left: bBox.left - pBox.left, width: bBox.width });
  }, [active, modes]);

  if (modes.length <= 1) return null; // spec § 1: hide when only Records exists

  return (
    <div className="relative inline-flex items-stretch self-start rounded-sm border border-line bg-surface-2 p-1">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 rounded-sm bg-surface-elevated shadow-pop-sm ring-1 ring-line transition-[left,width] duration-[var(--dur-slide)] ease-[var(--ease-spring)]"
        style={{ left: marker.left, width: marker.width }}
      />
      {modes.map((m) => {
        const b = badges?.[m];
        const isActive = m === active;
        return (
          <button
            key={m}
            ref={(el) => {
              refs.current[m] = el;
            }}
            type="button"
            onClick={() => onSelect(m)}
            className={cx(
              "relative z-10 inline-flex items-center gap-2 rounded-sm px-4 py-2 transition-colors",
              isActive ? "text-ink" : "text-ink-3 hover:text-ink-2",
            )}
          >
            <span className="font-display text-[14px] font-semibold leading-none tracking-[-0.01em]">
              {LABEL[m]}
            </span>
            {b?.count != null && b.count > 0 && (
              <span
                className={cx(
                  "inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm px-1.5 font-mono text-[10px] font-semibold leading-none tabular-nums",
                  isActive ? "bg-accent text-accent-ink" : "bg-surface-3 text-ink-2",
                )}
              >
                {b.count}
              </span>
            )}
            {b?.warn && <span aria-hidden className="h-1.5 w-1.5 rounded-sm bg-warn" />}
          </button>
        );
      })}
    </div>
  );
}
