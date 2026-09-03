import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { authFetch } from "../api";
import { TenantProvider, type TenantContextValue } from "../lib/tenant-context";
import type { Capability } from "../lib/permissions";
import { OpenTabsProvider } from "../lib/open-tabs";
import { CreateTableModalProvider } from "../lib/create-table-modal";
import { LAST_SLUG_KEY } from "../lib/tenant-storage";
import { onTenantSwitch, initStore, useMemberships } from "../store";

export interface Membership {
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  color: string | null;
  capabilities: Capability[];
}

export function TenantLayout({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const { tenantSlug } = useParams<{ tenantSlug: string }>();
  // Read live from the store so a rename/leave/delete elsewhere re-derives the
  // TenantProvider value (label flows through here into SettingsLayout header,
  // WorkspaceSwitcher trigger, etc.).
  const memberships = useMemberships();
  const m = memberships.find((x) => x.slug === tenantSlug);
  const location = useLocation();

  // A slug that is not a membership may be an address this workspace was
  // renamed away from — an old bookmark or a shared link. `undefined` while we
  // ask the server, then the current slug or null. Without this the user is
  // silently dropped into a DIFFERENT workspace.
  const stranded = !m && !isSuperAdmin && Boolean(tenantSlug);
  const [renamedTo, setRenamedTo] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!stranded) return;
    let live = true;
    setRenamedTo(undefined);
    void authFetch(`/me/slug-alias/${encodeURIComponent(tenantSlug!)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ slug?: string }>) : null))
      .then((body) => {
        if (live) setRenamedTo(body?.slug ?? null);
      })
      .catch(() => {
        if (live) setRenamedTo(null);
      });
    return () => {
      live = false;
    };
  }, [stranded, tenantSlug]);

  const lastSlug = useRef<string | null>(null);

  useEffect(() => {
    if (!tenantSlug) return;
    if (lastSlug.current === tenantSlug) return;
    if (lastSlug.current !== null) onTenantSwitch();
    lastSlug.current = tenantSlug;
    localStorage.setItem(LAST_SLUG_KEY, tenantSlug);
    void initStore();
  }, [tenantSlug]);

  useEffect(() => {
    if (tenantSlug) sessionStorage.setItem("zz:lastTenant", tenantSlug);
  }, [tenantSlug]);

  const ctx: TenantContextValue = useMemo(
    () => ({
      id: m?.slug ?? tenantSlug ?? "",
      slug: tenantSlug ?? "",
      label: m?.label ?? tenantSlug ?? "",
      color: m?.color ?? null,
      role: m?.role ?? "admin",
      isSuperAdmin,
      capabilities: m?.capabilities ?? [],
    }),
    [tenantSlug, m, isSuperAdmin],
  );

  if (!tenantSlug) return <Navigate to="/app" replace />;
  if (stranded) {
    if (renamedTo === undefined) return null; // resolving the rename
    if (renamedTo !== null) {
      const rest = location.pathname.slice(`/app/${tenantSlug}`.length);
      return <Navigate to={`/app/${renamedTo}${rest}${location.search}`} replace />;
    }
    return <Navigate to="/app" replace />;
  }

  return (
    <TenantProvider value={ctx}>
      <OpenTabsProvider slug={tenantSlug}>
        <CreateTableModalProvider>
          <Outlet />
        </CreateTableModalProvider>
      </OpenTabsProvider>
    </TenantProvider>
  );
}
