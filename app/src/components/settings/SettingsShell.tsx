import type { ReactNode } from "react";

export function SettingsShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <div className="flex gap-6 md:gap-8">
        <aside className="w-[220px] shrink-0">{sidebar}</aside>
        <main className="min-w-0 flex-1 space-y-4 md:space-y-6">{children}</main>
      </div>
    </div>
  );
}
