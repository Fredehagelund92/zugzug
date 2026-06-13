import type { ReactNode } from "react";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";

export function RoleGate({
  action,
  children,
  fallback = null,
}: {
  action: Action;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const tenant = useTenant();
  return <>{can(tenant, action) ? children : fallback}</>;
}
