import type { ReactNode } from "react";
import { Panel } from "../Panel";

export function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Panel padding="none">
      <div className="relative border-b border-line px-5 py-4 md:px-6 md:py-5">
        <div className="absolute left-0 inset-y-0 w-[2px] bg-accent" />
        <div className="max-w-2xl">
          <h2 className="font-display text-xl font-bold tracking-tight text-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-ink-2 leading-snug">{hint}</p>}
        </div>
      </div>
      <div className="px-5 py-5 md:px-6 md:py-6">
        <div className="max-w-2xl space-y-6">{children}</div>
      </div>
    </Panel>
  );
}
