import type { TenantContextValue } from "../src/lib/tenant-context";
import type { Capability } from "../src/lib/permissions";

/** Test-only mirror of ROLE_CAPABILITIES in server/src/auth.ts — the payload the
 *  server actually sends on GET /api/me/memberships. Production code never maps
 *  a role to capabilities; it only reads the served list. Keep this in step with
 *  the server matrix (server/test/rbac-http.test.ts is what enforces it). */
export const CAPABILITIES_BY_ROLE: Record<"admin" | "editor" | "viewer", Capability[]> = {
  admin: ["curate", "commit", "manage_tables", "manage_workspace", "manage_integrations"],
  editor: ["curate", "commit", "manage_tables"],
  viewer: [],
};

/** A TenantContextValue as the app would build it after boot, for `role`. */
export function tenantFixture(
  role: "admin" | "editor" | "viewer",
  overrides: Partial<TenantContextValue> = {},
): TenantContextValue {
  return {
    id: "t1",
    slug: "acme",
    label: "Acme",
    color: null,
    role,
    isSuperAdmin: false,
    capabilities: CAPABILITIES_BY_ROLE[role],
    ...overrides,
  };
}
