import { useEffect, useMemo, useRef } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../lib/tenant-context";
import type { Capability } from "../lib/permissions";
import { OpenTabsProvider } from "../lib/open-tabs";
import { CreateTableModalProvider } from "../lib/create-table-modal";
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

  const lastSlug = useRef<string | null>(null);

  useEffect(() => {
    if (!tenantSlug) return;
    if (lastSlug.current === tenantSlug) return;
    if (lastSlug.current !== null) onTenantSwitch();
    lastSlug.current = tenantSlug;
    localStorage.setItem("zugzug:last-tenant-slug", tenantSlug);
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
  if (!m && !isSuperAdmin) return <Navigate to="/app" replace />;

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
