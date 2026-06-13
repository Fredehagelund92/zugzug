import type { ReactNode } from "react";

export function FormField({
  label,
  hint,
  status,
  children,
}: {
  label: string;
  hint?: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">{label}</span>
        {status}
      </span>
      {children}
      {hint && <span className="text-[12px] text-ink-2">{hint}</span>}
    </label>
  );
}
