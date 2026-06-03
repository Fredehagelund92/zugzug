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
  IconSearch,
} from "./Icons";
import { useDimensions, collaborators } from "../store";

/* AppShell — the signed-in product chrome: a branded command rail (sidebar) +
   topbar + routed content. Layout in Tailwind; colour/type via token utilities. */

/* a little zigzag rule — the ZZ motif as a divider */
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
  const totalNew = dims.reduce((n, s) => n + s.values.filter((v) => v.status === "new").length, 0);
  const nav = [
    { to: "/app", label: "Dashboard", Icon: IconDashboard, end: true },
    { to: "/app/mapping", label: "Value mapping", Icon: IconMapping, count: totalNew },
    { to: "/app/sources", label: "Sources", Icon: IconSources, count: undefined },
    { to: "/app/tables", label: "Master tables", Icon: IconTables, count: dims.length },
    { to: "/app/settings", label: "Settings", Icon: IconSettings },
  ];
  return (
    <div className="grid min-h-screen grid-cols-[var(--ak-nav)_1fr]">
      {/* command rail */}
      <aside className="flex flex-col border-r border-line bg-surface">
        <div className="flex h-[var(--ak-topbar)] items-center gap-2.5 border-b border-line px-5 font-display text-lg font-extrabold tracking-tight text-ink">
          <Mark className="h-7 w-7" />
          Zug Zug<span className="text-accent">.</span>
        </div>

        <div className="flex items-center gap-2 px-5 pt-4 pb-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Master data layer</span>
        </div>
        <div className="px-5 pb-2"><ZigRule /></div>

        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {nav.map(({ to, label, Icon, count, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-3 rounded-sm px-3 py-2 text-[13px] font-medium transition-colors duration-[var(--ak-dur)]",
                  isActive
                    ? "bg-accent-wash text-accent shadow-[inset_2px_0_0_var(--accent)]"
                    : "text-ink-2 hover:bg-hover hover:text-ink",
                )
              }
            >
              <Icon />
              {label}
              {count != null && (
                <span className="ml-auto rounded-pill bg-surface-3 px-2 py-0.5 font-mono text-[10px] text-ink-3">
                  {count}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* system status footer */}
        <div className="border-t border-line p-4">
          <div className="flex items-center gap-2 font-mono text-[11px] text-ink">
            <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
            analytics.duckdb
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-ink-3">
            <span>warehouse · live</span>
            <span>{dims.length} tables</span>
          </div>
        </div>
      </aside>

      {/* main column */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-40 flex h-[var(--ak-topbar)] items-center gap-4 border-b border-line bg-[var(--ak-glass)] px-6 backdrop-blur-md">
          <label className="flex w-full max-w-md items-center gap-2 rounded-sm border border-line-2 bg-bg px-3 py-1.5 text-ink-3 focus-within:border-accent">
            <IconSearch className="h-4 w-4" />
            <input
              placeholder="Search tables, columns, mappings…"
              className="w-full bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
            <kbd className="rounded-sm border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">⌘K</kbd>
          </label>
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

        <main className="zz-canvas flex-1">
          <div className="mx-auto w-full max-w-[var(--wide)] p-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
