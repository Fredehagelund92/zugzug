import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { cx } from "../lib/cx";
import { Mark } from "./Mark";
import { ThemeToggle } from "./ThemeToggle";
import {
  IconDashboard,
  IconMapping,
  IconTables,
  IconSources,
  IconSettings,
  IconChevron,
} from "./Icons";
import { useDimensions, collaborators } from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { ShortcutsOverlay } from "./datagrid";

/* AppShell — the signed-in product chrome.
   - The sidebar is a fixed column (doesn't scroll with the page); only the
     main content area scrolls.
   - The sidebar collapses to an icon-only rail (~64px) via a chevron toggle.
     Collapsed state is persisted to localStorage so the user's preference
     survives reloads.
   - The engineer-mode toggle lives in Settings → Appearance only. */

const NAV_COLLAPSED_KEY = "zugzug:nav-collapsed";

function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
  });
  useEffect(() => {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);
  return [collapsed, () => setCollapsed((c) => !c)];
}

function ZigRule() {
  return (
    <svg viewBox="0 0 96 8" className="h-2 w-24 text-accent" fill="none" aria-hidden="true">
      <path d="M0 4 L8 1 L16 7 L24 1 L32 7 L40 1 L48 7 L56 1 L64 7 L72 1 L80 7 L88 1 L96 4"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AppShell() {
  const dims = useDimensions();
  const { engineer } = useEngineerMode();
  const [collapsed, toggle] = useNavCollapsed();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const totalNew = dims.reduce((n, s) => n + s.values.filter((v) => v.status === "new").length, 0);
  const nav = [
    { to: "/app", label: "Dashboard", Icon: IconDashboard, end: true },
    { to: "/app/mapping", label: "Match values", Icon: IconMapping, count: totalNew },
    { to: "/app/sources", label: "Sources", Icon: IconSources, count: undefined as number | undefined },
    { to: "/app/tables", label: "Master lists", Icon: IconTables, count: dims.length },
    { to: "/app/settings", label: "Settings", Icon: IconSettings },
  ];

  return (
    <div
      className="grid h-screen overflow-hidden"
      style={{ gridTemplateColumns: collapsed ? "64px 1fr" : "var(--ak-nav) 1fr" }}
    >
      {/* command rail — fixed; does not scroll with the page */}
      <aside className="flex flex-col overflow-hidden border-r border-line bg-surface">
        <div className={cx(
          "flex h-[var(--ak-topbar)] shrink-0 items-center gap-2.5 border-b border-line font-display text-lg font-extrabold tracking-tight text-ink",
          collapsed ? "justify-center px-2" : "px-5",
        )}>
          <Mark className="h-7 w-7" />
          {!collapsed && <>Zug Zug<span className="text-accent">.</span></>}
        </div>

        {!collapsed && (
          <>
            <div className="flex items-center gap-2 px-5 pt-4 pb-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Master data layer</span>
            </div>
            <div className="px-5 pb-2"><ZigRule /></div>
          </>
        )}
        {collapsed && <div className="h-3 shrink-0" />}

        <nav className={cx("flex flex-1 flex-col gap-0.5", collapsed ? "p-2" : "p-3")}>
          {nav.map(({ to, label, Icon, count, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={collapsed ? (count != null ? `${label} · ${count}` : label) : undefined}
              className={({ isActive }) =>
                cx(
                  "relative flex items-center text-[13px] font-medium transition-colors duration-[var(--ak-dur)]",
                  collapsed ? "h-10 justify-center" : "gap-3 rounded-sm px-3 py-2",
                  isActive
                    ? collapsed
                      ? "bg-accent-wash text-accent"
                      : "bg-accent-wash text-accent shadow-[inset_2px_0_0_var(--accent)]"
                    : "text-ink-2 hover:bg-hover hover:text-ink",
                )
              }
            >
              <Icon />
              {!collapsed && (
                <>
                  {label}
                  {count != null && (
                    <span className="ml-auto rounded-pill bg-surface-3 px-2 py-0.5 font-mono text-[10px] text-ink-3">
                      {count}
                    </span>
                  )}
                </>
              )}
              {collapsed && count != null && count > 0 && (
                <span className="absolute right-2 top-1 h-1.5 w-1.5 rounded-pill bg-accent" />
              )}
            </NavLink>
          ))}
        </nav>

        {/* footer — just a live dot + 'Connected' (single line). The collapse
            toggle lives in the topbar now. */}
        <div className={cx("shrink-0 border-t border-line", collapsed ? "p-3" : "px-5 py-3")}>
          <div className={cx("flex items-center gap-2 font-mono text-[11px] text-ink", collapsed && "justify-center")}>
            <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
            {!collapsed && <span>{engineer ? "analytics.duckdb" : "Connected"}</span>}
          </div>
        </div>
      </aside>

      {/* main column — flex column with the inner main as the only scroll area */}
      <div className="flex h-screen min-w-0 flex-col">
        <header className="flex h-[var(--ak-topbar)] shrink-0 items-center gap-4 border-b border-line bg-[var(--ak-glass)] px-4 backdrop-blur-md">
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid h-8 w-8 place-items-center rounded-sm border border-line-2 text-ink-2 transition-colors hover:border-accent hover:text-ink"
          >
            <IconChevron className={cx("h-3.5 w-3.5", collapsed ? "-rotate-90" : "rotate-90")} />
          </button>
          <div className="flex-1" />
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <div className="flex items-center -space-x-2">
              {collaborators.map((u, i) => (
                <span key={u.id} title={`${u.name}${i === 0 ? " (you)" : ""}`}
                  className={cx("grid h-8 w-8 place-items-center rounded-pill border-2 border-surface bg-surface-3 font-mono text-[10px] text-ink-2", i === 0 && "ring-1 ring-accent")}>
                  {u.initials}
                </span>
              ))}
            </div>
          </div>
        </header>

        <main className="zz-canvas flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
          <div className="mx-auto w-full max-w-[var(--wide)] p-8">
            <Outlet />
          </div>
        </main>
      </div>
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
