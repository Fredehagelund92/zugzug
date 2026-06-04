import { cx } from "../lib/cx";

/* Badge — Tailwind conversion of `.ak-badge`. Tone maps to the functional
   semantic tokens (ok/warn/danger) or the accent; neutral uses surface + line. */
type Tone = "neutral" | "ok" | "warn" | "danger" | "accent" | "committed" | "staged";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line-2",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  accent: "bg-accent text-accent-ink border-transparent",
  committed: "bg-committed-soft text-committed border-transparent",
  staged: "bg-staged-soft text-staged border-transparent",
};

export function Badge({
  tone = "neutral",
  dot,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[11px] font-medium",
        tones[tone],
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-pill bg-current" />}
      {children}
    </span>
  );
}
