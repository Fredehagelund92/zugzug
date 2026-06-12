import { Outlet } from "react-router-dom";
import { Mark } from "../Mark";
import { SettingsShell } from "../settings/SettingsShell";
import { AdminSidebar } from "./AdminSidebar";

export function AdminLayout() {
  return (
    <div className="zz-canvas min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto max-w-[var(--wide)] px-6 h-14 flex items-center gap-3">
          <Mark className="h-5 w-5 text-accent" />
          <span className="font-display font-bold text-sm tracking-wide text-ink">ZUG ZUG</span>
          <span className="text-ink-3 text-xs mx-0.5">/</span>
          <span
            className="font-mono text-[10px] uppercase tracking-widest px-2 py-0.5"
            style={{
              color: "var(--accent-2)",
              background: "var(--accent-2-soft)",
            }}
          >
            ADMIN
          </span>
        </div>
      </header>

      <SettingsShell sidebar={<AdminSidebar />}>
        <Outlet />
      </SettingsShell>
    </div>
  );
}
