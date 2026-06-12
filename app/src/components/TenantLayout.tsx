import { useEffect, useMemo, useRef } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../lib/tenant-context";
import { OpenTabsProvider } from "../lib/open-tabs";
import { CreateTableModalProvider } from "../lib/create-table-modal";
import { onTenantSwitch, initStore } from "../store";

export interface Membership {
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
}

export function TenantLayout({
  memberships,
  isSuperAdmin,
}: {
  memberships: Membership[];
  isSuperAdmin: boolean;
}) {
  const { tenantSlug } = useParams<{ tenantSlug: string }>();
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

  if (!tenantSlug) return <Navigate to="/app" replace />;
  if (!m && !isSuperAdmin) return <Navigate to="/app" replace />;

  const ctx: TenantContextValue = useMemo(
    () => ({
      id: m?.slug ?? tenantSlug,
      slug: tenantSlug,
      label: m?.label ?? tenantSlug,
      role: m?.role ?? "admin",
      isSuperAdmin,
    }),
    [tenantSlug, m, isSuperAdmin],
  );

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
