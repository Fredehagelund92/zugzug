import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";

/* ScanScheduleMenu — a small clock-icon button that opens a popover with
   the supported cadences. Used per-row on the Sources page so a user can
   say 'scan this column every 15 minutes' without leaving the list. */

const OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: "Off" },
  { value: "15m", label: "Every 15 min" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
];

export function ScanScheduleMenu({ value, onChange }: { value: string | null; onChange: (next: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = OPTIONS.find((o) => o.value === (value ?? null)) ?? OPTIONS[0];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        aria-label={`Scan schedule: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Scan schedule: ${current.label}`}
        className={cx(
          "grid h-6 w-6 place-items-center rounded-sm border transition-colors",
          value ? "border-accent text-accent" : "border-line-2 text-ink-3 hover:border-accent hover:text-accent",
        )}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.5 V8 L10.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-1 w-40 overflow-hidden rounded-sm border border-line-2 bg-surface shadow-pop">
          <ul className="py-1">
            {OPTIONS.map((o) => (
              <li key={o.value ?? "off"}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(o.value); setOpen(false); }}
                  className={cx(
                    "flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-[12px] transition-colors hover:bg-hover",
                    o.value === (value ?? null) ? "text-accent" : "text-ink-2",
                  )}
                >
                  <span>{o.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
