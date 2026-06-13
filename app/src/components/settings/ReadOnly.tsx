import type { ReactNode } from "react";

export function ReadOnly({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return (
    <fieldset
      disabled={enabled}
      aria-disabled={enabled || undefined}
      className={enabled ? "opacity-70 cursor-not-allowed" : undefined}
    >
      {children}
    </fieldset>
  );
}
