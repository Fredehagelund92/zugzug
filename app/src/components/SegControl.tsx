import { cx } from "../lib/cx";

interface SegControlOption {
  value: string | null;
  label: string;
}

interface SegControlProps {
  value: string | null;
  options: SegControlOption[];
  onChange: (v: string | null) => void;
}

export function SegControl({ value, options, onChange }: SegControlProps) {
  return (
    <div
      role="group"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5"
    >
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
          className={cx(
            "rounded-[4px] px-3 py-1.5 font-mono text-[11.5px] transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            opt.value === value
              ? "border border-line-2 bg-surface-3 text-ink shadow-sm"
              : "text-ink-3 hover:text-ink-2",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
