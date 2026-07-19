import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { apiFetch, authFetch } from "../api";
import { cx } from "../lib/cx";
import { Mark } from "./Mark";
import { ThemeToggle } from "./ThemeToggle";
import { CommandPalette, type Command } from "./CommandPalette";
import {
  IconDashboard,
  IconMapping,
  IconTables,
  IconLayers,
  IconSettings,
  IconAudit,
  IconUsers,
  IconDatabase,
  IconIntegrations,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconArrowRight,
  IconMenu,
  IconX,
} from "./Icons";
import { useDimensions, currentUser } from "../store";
import { RoleBadge } from "./RoleBadge";
import { SyncPill } from "./SyncPill";
import { useOpenTabs } from "../lib/open-tabs";
import { ShortcutsOverlay } from "./datagrid";
import { ToastStack, toast } from "./Toast";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { useTenant } from "../lib/tenant-context";
import { can } from "../lib/permissions";
import { scopedKey } from "../lib/tenant-storage";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { type Membership } from "./TenantLayout";

/* AppShell — the signed-in product chrome.
   - The sidebar is a fixed column (doesn't scroll with the page); only the
     main content area scrolls.
   - The sidebar collapses to an icon-only rail (~64px) via a chevron toggle.
     Collapsed state is persisted to localStorage so the user's preference
     survives reloads.
   - On <md the sidebar becomes an off-canvas drawer triggered by a hamburger
     button. The desktop collapsed/expanded state is preserved independently. */

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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

function SidebarGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <div className="mb-1 px-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

interface SidebarLinkProps {
  to: string;
  label: string;
  Icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element;
  count?: number;
  end?: boolean;
  onClick?: () => void;
}

function SidebarLink({ to, label, Icon, count, end, onClick }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      title={count != null ? `${label} · ${count}` : label}
      className={({ isActive }) =>
        cx(
          "group flex items-center gap-2.5 rounded-sm px-2 py-[7px] text-[13px] transition-colors",
          isActive
            ? "bg-accent-soft text-accent font-semibold"
            : "text-ink-2 hover:bg-hover hover:text-ink",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cx(
              "h-3.5 w-3.5 shrink-0 transition-opacity",
              isActive ? "opacity-100 text-accent" : "opacity-60 group-hover:opacity-100",
            )}
          />
          <span className="flex-1">{label}</span>
          {count != null && count > 0 && (
            <span className={cx("font-mono text-[10px]", isActive ? "text-accent" : "text-ink-3")}>
              {count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

const USERMENU_W = 160;

function UserMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { slug } = useTenant();

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
    authFetch("/auth/logout", { method: "POST" })
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
              onClick={() => {
                setOpen(false);
                navigate(`/app/${slug}/account`);
              }}
              className="w-full px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Account settings
            </button>
            <div className="border-t border-line" />
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

export function AppShell({ memberships = [] }: { memberships?: Membership[] }) {
  const dims = useDimensions();
  const tenant = useTenant();
  const { slug, role: tenantRole } = tenant;
  const paletteKey = scopedKey(PALETTE_RECENTS_KEY, slug);
  const [collapsed, toggle] = useNavCollapsed();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const navLinks = useNavLinks();

  // Close the drawer whenever the viewport leaves mobile — avoids a stuck open
  // drawer if the user resizes or rotates their device to desktop width.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  // Last 5 invoked palette command ids — surfaced in a "Recent" section on
  // empty search so the user's most-used jumps are one keystroke away.
  const [recents, setRecents] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(paletteKey) ?? "[]");
    } catch {
      return [];
    }
  });
  const onPaletteRun = (id: string) => {
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 5);
      try {
        localStorage.setItem(paletteKey, JSON.stringify(next));
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

  // Background auto-publish visibility: the scheduler commits as u_system with
  // no client signal. Poll scan-status once a minute while the tab is visible
  // and toast when the last-auto-publish timestamp advances past what this
  // session has already seen (seeded on first poll so old runs don't toast).
  const lastAutoSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const r = await apiFetch("/sources/scan-status");
        if (!r.ok) return;
        const s = (await r.json()) as {
          lastAutoPublishAt: string | null;
          lastAutoPublishDetail: string | null;
        };
        if (stop) return;
        if (lastAutoSeen.current === undefined) {
          lastAutoSeen.current = s.lastAutoPublishAt;
          return;
        }
        if (s.lastAutoPublishAt && s.lastAutoPublishAt !== lastAutoSeen.current) {
          lastAutoSeen.current = s.lastAutoPublishAt;
          toast(`Auto-published ${s.lastAutoPublishDetail ?? "changes"}.`);
        }
      } catch {
        /* offline — the BootGate/health surfaces handle connectivity */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 60_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

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
        if (!window.location.pathname.startsWith(navLinks.tables)) return;
        const idx = parseInt(e.key, 10) - 1;
        const target = tabsRef.current[idx];
        if (target) {
          e.preventDefault();
          focusTab(target.id);
        }
      } else if (e.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusTab, drawerOpen, navLinks.tables]);

  const totalNew = dims.reduce((n, s) => n + s.counts.newCount, 0);
  const settingsBase = navLinks.settings;
  interface NavItem {
    to: string;
    label: string;
    Icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element;
    count?: number;
    end?: boolean;
  }
  const homeItem: NavItem = {
    to: navLinks.dashboard,
    label: "Home",
    Icon: IconDashboard,
    end: true,
  };
  const tablesGroup: NavItem[] = [
    { to: navLinks.tables, label: "Tables", Icon: IconTables, count: dims.length },
    { to: navLinks.triage, label: "Review", Icon: IconMapping, count: totalNew },
    { to: navLinks.audit, label: "Activity", Icon: IconAudit },
  ];
  const workspaceGroup: NavItem[] = [
    { to: `${settingsBase}/members`, label: "Members", Icon: IconUsers },
    { to: `${settingsBase}/warehouse`, label: "Warehouse", Icon: IconDatabase },
    { to: navLinks.sources, label: "Sources", Icon: IconLayers },
    { to: `${settingsBase}/general`, label: "Preferences", Icon: IconSettings },
  ];
  const integrationsGroup: NavItem[] = [
    { to: navLinks.integrationsPullApi, label: "Pull API", Icon: IconIntegrations },
    { to: navLinks.integrationsWebhooks, label: "Webhooks", Icon: IconIntegrations },
    ...(can(tenant, "integrations.service_accounts.view")
      ? [
          {
            to: navLinks.integrationsServiceAccounts,
            label: "Service accounts",
            Icon: IconUsers,
          },
        ]
      : []),
  ];
  // Flat nav — used by the command palette and the collapsed icon rail.
  const nav: NavItem[] = [homeItem, ...tablesGroup, ...workspaceGroup, ...integrationsGroup];

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
      action: () => navigate(navLinks.dashboard),
      keywords: "dashboard overview",
      priority: true,
    });
    out.push({
      id: "nav:triage",
      group: "Navigate",
      label: "Review",
      secondary: totalNew > 0 ? `${totalNew} new` : undefined,
      icon: <IconMapping className="h-4 w-4" />,
      action: () => navigate(navLinks.triage),
      keywords: "review unmapped source values mapping",
      priority: true,
    });
    out.push({
      id: "nav:sources",
      group: "Navigate",
      label: "Sources",
      icon: <IconLayers className="h-4 w-4" />,
      action: () => navigate(navLinks.sources),
      keywords: "warehouse catalog",
      priority: true,
    });
    out.push({
      id: "nav:tables",
      group: "Navigate",
      label: "Tables",
      secondary: `${dims.length}`,
      icon: <IconTables className="h-4 w-4" />,
      action: () => navigate(navLinks.tables),
      keywords: "tables records",
      priority: true,
    });
    out.push({
      id: "nav:audit",
      group: "Navigate",
      label: "Activity",
      icon: <IconAudit className="h-4 w-4" />,
      action: () => navigate(navLinks.audit),
      keywords: "audit activity log history changes",
      priority: true,
    });
    out.push({
      id: "nav:settings",
      group: "Navigate",
      label: "Settings",
      icon: <IconSettings className="h-4 w-4" />,
      action: () => navigate(navLinks.settings),
      keywords: "workspace preferences team",
      priority: true,
    });
    out.push({
      id: "nav:integrations",
      group: "Navigate",
      label: "Integrations",
      icon: <IconIntegrations className="h-4 w-4" />,
      action: () => navigate(navLinks.integrations),
      keywords: "webhooks pull api service accounts integrations",
      priority: true,
    });

    // Section 2: jump to a table's Match mode
    for (const d of dims) {
      const newCount = d.counts.newCount;
      out.push({
        id: `dim:${d.id}`,
        group: "Tables",
        label: d.dimension,
        secondary: newCount > 0 ? `${newCount} new` : "clean",
        icon: <IconArrowRight className="h-4 w-4" />,
        keywords: `${d.id} ${d.mapTable} ${d.dimTable} ${d.keyCol}`,
        action: () => {
          openTab(d.id);
          navigate(navLinks.table(d.id, "match"));
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
            navigate(navLinks.tablesFocus(c.key));
          },
        });
      }
    }
    return out;
  }, [dims, totalNew, navigate, openTab, navLinks]);

  // Shared sidebar content — rendered both in the desktop aside and the mobile drawer.
  const sidebarContent = (
    <>
      {collapsed && !isMobile ? (
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
          <div className="px-3 pt-2 pb-1">
            <WorkspaceSwitcher />
          </div>

          <nav aria-label="Navigation" className="flex-1 overflow-y-auto px-3 pt-3">
            <SidebarLink
              {...homeItem}
              onClick={isMobile ? () => setDrawerOpen(false) : undefined}
            />

            <SidebarGroup label="Data">
              {tablesGroup.map((item) => (
                <SidebarLink
                  key={item.to}
                  {...item}
                  onClick={isMobile ? () => setDrawerOpen(false) : undefined}
                />
              ))}
            </SidebarGroup>

            <SidebarGroup label="Workspace">
              {workspaceGroup.map((item) => (
                <SidebarLink
                  key={item.to}
                  {...item}
                  onClick={isMobile ? () => setDrawerOpen(false) : undefined}
                />
              ))}
            </SidebarGroup>

            <SidebarGroup label="Integrations">
              {integrationsGroup.map((item) => (
                <SidebarLink
                  key={item.to}
                  {...item}
                  onClick={isMobile ? () => setDrawerOpen(false) : undefined}
                />
              ))}
            </SidebarGroup>
          </nav>
        </>
      )}
    </>
  );

  return (
    <div
      className="flex h-screen overflow-hidden md:grid"
      style={
        isMobile ? undefined : { gridTemplateColumns: collapsed ? "64px 1fr" : "var(--ak-nav) 1fr" }
      }
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2 focus:text-ink"
      >
        Skip to main content
      </a>
      {/* Desktop sidebar — hidden on mobile (drawer takes over) */}
      <aside className="hidden md:flex flex-col overflow-hidden border-r border-line bg-surface">
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
        {sidebarContent}
      </aside>

      {/* Mobile drawer — portaled so it sits above everything */}
      {isMobile &&
        createPortal(
          <>
            {/* Backdrop */}
            <div
              aria-hidden="true"
              onClick={() => setDrawerOpen(false)}
              className={cx(
                "fixed inset-0 z-40 bg-ink/50 backdrop-blur-sm transition-opacity",
                drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
              )}
              style={{ transitionDuration: "var(--dur-slide)" }}
            />
            {/* Drawer panel */}
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className={cx(
                "fixed inset-y-0 left-0 z-50 flex w-[var(--ak-nav)] max-w-[85vw] flex-col overflow-hidden border-r border-line bg-surface",
                "transition-transform",
                drawerOpen ? "translate-x-0" : "-translate-x-full",
              )}
              style={{
                transitionDuration: "var(--dur-slide)",
                transitionTimingFunction: "var(--ease-spring)",
              }}
            >
              {/* Drawer header */}
              <div className="flex h-[var(--ak-topbar)] shrink-0 items-center justify-between border-b border-line px-5">
                <div className="flex items-center gap-2.5 font-display text-lg font-extrabold tracking-tight text-ink">
                  <Mark className="h-7 w-7" />
                  Zug Zug<span className="text-accent">.</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation"
                  className="grid h-11 w-11 place-items-center rounded-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <IconX className="h-4 w-4" />
                </button>
              </div>
              {sidebarContent}
            </div>
          </>,
          document.body,
        )}

      {/* main column — flex column with the inner main as the only scroll area */}
      <div className="flex h-screen min-w-0 flex-1 flex-col">
        <header className="relative z-10 flex h-[var(--ak-topbar)] shrink-0 items-center gap-3 border-b border-line bg-[var(--ak-glass)] px-3 backdrop-blur-md md:gap-4 md:px-4">
          {/* Mobile: hamburger. Desktop: collapse chevron. */}
          <button
            type="button"
            onClick={isMobile ? () => setDrawerOpen(true) : toggle}
            aria-label={
              isMobile ? "Open navigation" : collapsed ? "Expand sidebar" : "Collapse sidebar"
            }
            title={isMobile ? "Open navigation" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-sm border border-line-2 text-ink-2 transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:h-8 md:w-8"
          >
            {isMobile ? (
              <IconMenu className="h-4 w-4" />
            ) : collapsed ? (
              <IconChevronRight className="h-3.5 w-3.5" />
            ) : (
              <IconChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>

          {/* Search button — full label on desktop, icon-only on mobile */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={cx(
              "flex h-11 items-center gap-2 rounded-sm border border-line-2 bg-surface text-left text-[12.5px] text-ink-3 transition-colors hover:border-accent hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              "max-md:w-11 max-md:justify-center max-md:px-0",
              "md:h-8 md:min-w-[260px] md:max-w-[420px] md:flex-1 md:px-3",
            )}
            aria-label="Open command palette"
          >
            <IconSearch className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate max-md:hidden">Jump to anything…</span>
            <kbd className="rounded border border-line-2 bg-surface-2 px-1 font-mono text-[10px] text-ink-2 max-md:hidden">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <SyncPill />
            <RoleBadge role={tenantRole} />
            <UserMenu />
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="zz-canvas flex-1 overflow-y-auto"
          style={{ scrollbarGutter: "stable" }}
        >
          <Outlet context={{ memberships }} />
        </main>
      </div>
      <ToastStack />
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
