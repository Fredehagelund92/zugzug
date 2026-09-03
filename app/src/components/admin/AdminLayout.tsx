import { Link, Outlet } from "react-router-dom";
import { Mark } from "../Mark";
import { ThemeToggle } from "../ThemeToggle";
import { SettingsShell } from "../settings/SettingsShell";
import { AdminSidebar } from "./AdminSidebar";
import { authFetch } from "../../api";
import { useMemberships } from "../../store";
import { LAST_SLUG_KEY } from "../../lib/tenant-storage";

const headerLink =
  "text-xs text-ink-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-sm px-1";

export function AdminLayout() {
  // Account lives inside a workspace, so point at the one this admin would
  // land in — same order as AppIndex. A super-admin who belongs to none has
  // no account page to offer, and gets sign-out only.
  const memberships = useMemberships();
  const last = localStorage.getItem(LAST_SLUG_KEY);
  const accountSlug =
    memberships.find((m) => m.slug === last)?.slug ?? memberships[0]?.slug ?? null;

  const signOut = () => {
    void authFetch("/auth/logout", { method: "POST" }).finally(() => {
      window.location.href = "/login";
    });
  };

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
          <div className="ml-auto flex items-center gap-3">
            {accountSlug && (
              <Link to={`/app/${accountSlug}/account/profile`} className={headerLink}>
                Account
              </Link>
            )}
            <button type="button" onClick={signOut} className={headerLink}>
              Sign out
            </button>
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
