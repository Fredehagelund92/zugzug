import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { cx } from "../lib/cx";
import { Mark } from "./Mark";
import { ThemeToggle } from "./ThemeToggle";
import { CommandPalette, type Command } from "./CommandPalette";
import {
  IconDashboard,
  IconMapping,
  IconTables,
  IconSources,
  IconSettings,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconArrowRight,
} from "./Icons";
import { useDimensions, currentUser } from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { useOpenTabs } from "../lib/open-tabs";
import { SidebarTableTree } from "./SidebarTableTree";
import { ShortcutsOverlay } from "./datagrid";

/* AppShell — the signed-in product chrome.
   - The sidebar is a fixed column (doesn't scroll with the page); only the
     main content area scrolls.
   - The sidebar collapses to an icon-only rail (~64px) via a chevron toggle.
     Collapsed state is persisted to localStorage so the user's preference
     survives reloads.
   - The engineer-mode toggle lives in Settings → Appearance only. */

const NAV_COLLAPSED_KEY = "zugzug:nav-collapsed";
const PALETTE_RECENTS_KEY = "zugzug:palette-recents";

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
      <path
        d="M0 4 L8 1 L16 7 L24 1 L32 7 L40 1 L48 7 L56 1 L64 7 L72 1 L80 7 L88 1 L96 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const USERMENU_W = 160;

function UserMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const dropdown = dropdownRef.current;
      const trigger = triggerRef.current;
      if (!dropdown || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const dropH = dropdown.offsetHeight;

      // right-align with the trigger button
      let left = rect.right - USERMENU_W;
      if (left < 8) left = 8;

      let top = rect.bottom + 4;
      if (top + dropH > window.innerHeight - 8) top = Math.max(8, rect.top - 4 - dropH);

      dropdown.style.left = `${left}px`;
      dropdown.style.top = `${top}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const signOut = () => {
    fetch("/api/auth/logout", { method: "POST" })
      .then(() => {
        window.location.href = "/login";
      })
      .catch(() => {
        window.location.href = "/login";
      });
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={currentUser.name}
        aria-label={`User menu for ${currentUser.name}`}
        className="grid h-8 w-8 place-items-center rounded-pill border border-line-2 bg-surface-3 font-mono text-[10px] text-ink-2 ring-1 ring-accent transition-colors hover:bg-hover"
      >
        {currentUser.initials}
      </button>
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ position: "fixed", top: 0, left: 0, minWidth: USERMENU_W }}
            className="zz-pop-in z-50 rounded-sm border border-line bg-surface-elevated shadow-pop"
          >
            <div className="border-b border-line px-3 py-2">
              <p className="text-[13px] font-medium text-ink">{currentUser.name}</p>
              {currentUser.email && <p className="text-[11px] text-ink-2">{currentUser.email}</p>}
            </div>
            <button
              type="button"
              onClick={signOut}
              className="w-full px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Sign out
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function AppShell() {
  const dims = useDimensions();
  const { engineer } = useEngineerMode();
  const [collapsed, toggle] = useNavCollapsed();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Last 5 invoked palette command ids — surfaced in a "Recent" section on
  // empty search so the user's most-used jumps are one keystroke away.
  const [recents, setRecents] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(PALETTE_RECENTS_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const onPaletteRun = (id: string) => {
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 5);
      try {
        localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const navigate = useNavigate();
  const { tabs, openTab, focusTab } = useOpenTabs();
  // Mirror `tabs` into a ref so the global key handler can read the latest list
  // without re-binding the document listener every time tabs open/close/reorder.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "?" && !inField) {
        e.preventDefault();
        setShortcutsOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // Cmd+K (Ctrl+K on Linux/Windows): open the quick-switcher palette.
        // Fires even inside inputs so the user can always reach it.
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        // Cmd+1..9 → switch to the Nth tab in the tab strip (1-indexed).
        // Only fires on /app/tables, since tabs only exist there; elsewhere we
        // bail so the browser's own Cmd+1..9 shortcut still works.
        if (!window.location.pathname.startsWith("/app/tables")) return;
        const idx = parseInt(e.key, 10) - 1;
        const target = tabsRef.current[idx];
        if (target) {
          e.preventDefault();
          focusTab(target.id);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusTab]);
  const totalNew = dims.reduce((n, s) => n + s.values.filter((v) => v.status === "new").length, 0);
  const nav = [
    { to: "/app", label: "Home", Icon: IconDashboard, end: true },
    { to: "/app/triage", label: "Triage", Icon: IconMapping, count: totalNew },
    {
      to: "/app/sources",
      label: "Sources",
      Icon: IconSources,
      count: undefined as number | undefined,
    },
    { to: "/app/tables", label: "Tables", Icon: IconTables, count: dims.length },
    { to: "/app/settings", label: "Settings", Icon: IconSettings },
  ];

  // Quick-switcher command list — navigation + every dim + every canonical
  // record across dims. Rebuilt only when dims change (canonical churn here
  // is rare; the search is fast enough at thousand-record scale).
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    // Section 1: routes — flagged priority so the empty palette stays compact
    out.push({
      id: "nav:dashboard",
      group: "Navigate",
      label: "Home",
      icon: <IconDashboard className="h-4 w-4" />,
      action: () => navigate("/app"),
      keywords: "dashboard overview",
      priority: true,
    });
    out.push({
      id: "nav:triage",
      group: "Navigate",
      label: "Triage",
      secondary: totalNew > 0 ? `${totalNew} new` : undefined,
      icon: <IconMapping className="h-4 w-4" />,
      action: () => navigate("/app/triage"),
      keywords: "inbox queue match reconcile mapping",
      priority: true,
    });
    out.push({
      id: "nav:sources",
      group: "Navigate",
      label: "Sources",
      icon: <IconSources className="h-4 w-4" />,
      action: () => navigate("/app/sources"),
      keywords: "warehouse catalog",
      priority: true,
    });
    out.push({
      id: "nav:tables",
      group: "Navigate",
      label: "Tables",
      secondary: `${dims.length}`,
      icon: <IconTables className="h-4 w-4" />,
      action: () => navigate("/app/tables"),
      keywords: "master records",
      priority: true,
    });
    out.push({
      id: "nav:settings",
      group: "Navigate",
      label: "Settings",
      icon: <IconSettings className="h-4 w-4" />,
      action: () => navigate("/app/settings"),
      keywords: "workspace preferences team",
      priority: true,
    });

    // Section 2: jump to a table's Match mode
    for (const d of dims) {
      const newCount = d.values.filter((v) => v.status === "new").length;
      out.push({
        id: `dim:${d.id}`,
        group: "Tables",
        label: d.dimension,
        secondary: newCount > 0 ? `${newCount} new` : "clean",
        icon: <IconArrowRight className="h-4 w-4" />,
        keywords: `${d.id} ${d.mapTable} ${d.dimTable} ${d.keyCol}`,
        action: () => {
          openTab(d.id);
          navigate(`/app/tables?open=${d.id}&active=${d.id}&mode=match`);
        },
      });
    }

    // Section 3: every canonical record — opens the dim as a Tables tab + focus
    for (const d of dims) {
      for (const c of d.canonical) {
        out.push({
          id: `rec:${d.id}:${c.key}`,
          group: "Records",
          label: c.label ?? c.key,
          secondary: `${d.dimension} · ${c.key}`,
          keywords: `${d.dimension} ${c.key} ${d.id}`,
          action: () => {
            openTab(d.id);
            navigate(`/app/tables?focus=${encodeURIComponent(c.key)}`);
          },
        });
      }
    }
    return out;
  }, [dims, totalNew, navigate, openTab]);

  return (
    <div
      className="grid h-screen overflow-hidden"
      style={{ gridTemplateColumns: collapsed ? "64px 1fr" : "var(--ak-nav) 1fr" }}
    >
      {/* command rail — fixed; does not scroll with the page */}
      <aside className="flex flex-col overflow-hidden border-r border-line bg-surface">
        <div
          className={cx(
            "flex h-[var(--ak-topbar)] shrink-0 items-center gap-2.5 border-b border-line font-display text-lg font-extrabold tracking-tight text-ink",
            collapsed ? "justify-center px-2" : "px-5",
          )}
        >
          <Mark className="h-7 w-7" />
          {!collapsed && (
            <>
              Zug Zug<span className="text-accent">.</span>
            </>
          )}
        </div>

        {collapsed ? (
          <>
            <nav className="flex flex-1 flex-col gap-0.5 p-2">
              {nav.map(({ to, label, Icon, count, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  title={count != null ? `${label} · ${count}` : label}
                  className={({ isActive }) =>
                    cx(
                      "relative flex h-10 items-center justify-center text-[13px] font-medium transition-colors duration-[var(--ak-dur)]",
                      isActive
                        ? "bg-accent-wash text-accent"
                        : "text-ink-2 hover:bg-hover hover:text-ink",
                    )
                  }
                >
                  <Icon />
                  {count != null && count > 0 && (
                    <span className="absolute right-2 top-1 h-1.5 w-1.5 rounded-pill bg-accent" />
                  )}
                </NavLink>
              ))}
            </nav>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-5 pt-3 pb-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Master data layer
              </span>
            </div>
            <div className="px-5 pb-2">
              <ZigRule />
            </div>

            <SidebarTableTree />

            <nav className="shrink-0 border-t border-line">
              <div className="flex items-center justify-around px-2 py-2">
                {nav
                  .filter((n) => n.to !== "/app/tables")
                  .map(({ to, label, Icon, count, end }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      title={count != null ? `${label} · ${count}` : label}
                      className={({ isActive }) =>
                        cx(
                          "relative grid h-9 w-9 place-items-center rounded-sm transition-colors",
                          isActive
                            ? "bg-accent-wash text-accent"
                            : "text-ink-3 hover:bg-hover hover:text-ink",
                        )
                      }
                    >
                      <Icon />
                      {count != null && count > 0 && (
                        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-pill bg-accent" />
                      )}
                    </NavLink>
                  ))}
              </div>
            </nav>
          </>
        )}

        <div className={cx("shrink-0 border-t border-line", collapsed ? "p-3" : "px-5 py-2")}>
          <div
            className={cx(
              "flex items-center gap-2 font-mono text-[11px] text-ink",
              collapsed && "justify-center",
            )}
          >
            <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
            {!collapsed && <span>{engineer ? "analytics.duckdb" : "Connected"}</span>}
          </div>
        </div>
      </aside>

      {/* main column — flex column with the inner main as the only scroll area */}
      <div className="flex h-screen min-w-0 flex-col">
        <header className="relative z-10 flex h-[var(--ak-topbar)] shrink-0 items-center gap-4 border-b border-line bg-[var(--ak-glass)] px-4 backdrop-blur-md">
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid h-8 w-8 place-items-center rounded-sm border border-line-2 text-ink-2 transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {collapsed ? (
              <IconChevronRight className="h-3.5 w-3.5" />
            ) : (
              <IconChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 min-w-[260px] max-w-[420px] flex-1 items-center gap-2 rounded-sm border border-line-2 bg-surface px-3 text-left text-[12.5px] text-ink-3 transition-colors hover:border-accent hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="Open command palette"
          >
            <IconSearch className="h-3.5 w-3.5" />
            <span className="flex-1 truncate">Jump to anything…</span>
            <kbd className="rounded border border-line-2 bg-surface-2 px-1 font-mono text-[10px] text-ink-2">
              ⌘K
            </kbd>
          </button>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>

        <main className="zz-canvas flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
          <Outlet />
        </main>
      </div>
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        recents={recents}
        onRun={onPaletteRun}
      />
    </div>
  );
}
