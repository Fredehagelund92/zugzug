import type { ReactNode } from "react";
import { PageContainer, type PageContainerProps } from "../PageContainer";

/* Shared by the admin console (wide Users/Workspaces tables → default `wide`)
   and Account (single-column forms → `doc`). See ADR-0004. */
export function SettingsShell({
  sidebar,
  children,
  max,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  max?: PageContainerProps["max"];
}) {
  return (
    <PageContainer max={max}>
      {/* Stack on mobile (sidebar above content); restore the fixed-width side
         rail at md+. A shrink-0 240px sidebar would otherwise crush the content
         into a ~90px strip on a phone. Shared by the admin console + Account. */}
      <div className="flex flex-col md:flex-row">
        <aside className="mb-4 border-b border-line pb-4 md:mb-0 md:w-[240px] md:shrink-0 md:border-b-0 md:border-r md:pb-0 md:pr-6 md:mr-6">
          {sidebar}
        </aside>
        <main className="min-w-0 flex-1 space-y-4 md:space-y-5">{children}</main>
      </div>
    </PageContainer>
  );
}
