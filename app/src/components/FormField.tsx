import type { ReactNode } from "react";

/* FormField — the canonical label + control pair. Mono uppercase kicker label
   sits above the control; the whole thing is a <label> so clicks on the kicker
   focus the control. Use everywhere settings/forms surface inputs. */
export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-ink-2">{hint}</span>}
    </label>
  );
}
