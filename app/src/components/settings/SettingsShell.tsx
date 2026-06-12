import type { ReactNode } from "react";

export function SettingsShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <div className="flex gap-0">
        <aside className="w-[240px] shrink-0 pr-6 mr-6 border-r border-line">
          {sidebar}
        </aside>
        <main className="min-w-0 flex-1 space-y-4 md:space-y-5">{children}</main>
      </div>
    </div>
  );
}
