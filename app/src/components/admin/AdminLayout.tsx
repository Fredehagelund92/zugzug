import { Link, Outlet } from "react-router-dom";
import { Mark } from "../Mark";
import { ThemeToggle } from "../ThemeToggle";
import { SettingsShell } from "../settings/SettingsShell";
import { AdminSidebar } from "./AdminSidebar";

export function AdminLayout() {
  return (
    // Fixed-height shell with the scroll confined to the content region (like
    // AppShell) and scrollbarGutter:"stable" reserving the gutter — otherwise
    // navigating between admin pages of different heights toggles the window
    // scrollbar and re-centers the max-width header, shifting the logo sideways.
    <div className="zz-canvas flex h-[100dvh] flex-col overflow-hidden">
      <header className="shrink-0 border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto max-w-[var(--wide)] px-6 h-14 flex items-center gap-3">
          <Link to="/app" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <Mark className="h-5 w-5 text-accent" />
            <span className="font-display font-bold text-sm tracking-wide text-ink">ZUG ZUG</span>
          </Link>
          <span className="text-ink-3 text-xs mx-0.5">/</span>
          <span
            className="font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 rounded"
            style={{
              color: "var(--accent-2)",
              background: "var(--accent-2-soft)",
            }}
          >
            ADMIN
          </span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
        <SettingsShell sidebar={<AdminSidebar />}>
          <Outlet />
        </SettingsShell>
      </div>
    </div>
  );
}
