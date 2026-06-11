import { AppError } from "./errors.ts";
import { tenantBySlug, memberRole } from "./tenant.ts";
import type { SessionUser } from "./auth.ts";

export interface TenantContext {
  tenantId: string;
  role: "admin" | "editor" | "viewer";
  isSuperAdmin: boolean;
}

export interface ResolveOpts {
  pathname: string;
  user: SessionUser;
  /** Carried from auth.ts after PR1's users.is_super_admin column. Defaults false. */
  isSuperAdmin?: boolean;
}

const TENANT_PATH_RE = /^\/api\/t\/([^/]+)\//;

/** Resolve the tenant context for an incoming HTTP request.
 *
 *  Path shapes:
 *    /api/t/:slug/...   → resolve slug, require membership (or super-admin bypass)
 *    /api/admin/...     → handled by the route layer; this function is NOT called.
 *    everything else    → legacy /api/* mounted under tenantId='default'.
 *
 *  Throws AppError(NOT_FOUND, 404) for unknown slugs.
 *  Throws AppError(FORBIDDEN, 403) when the user is neither a member nor a super-admin.
 */
export async function resolveTenantContext(opts: ResolveOpts): Promise<TenantContext> {
  const m = TENANT_PATH_RE.exec(opts.pathname);
  if (m) {
    const slug = decodeURIComponent(m[1]!);
    const tenant = await tenantBySlug(slug);
    if (!tenant) {
      throw new AppError("NOT_FOUND", `workspace '${slug}' not found`, 404);
    }
    const role = await memberRole(tenant.id, opts.user.id);
    if (role) {
      return { tenantId: tenant.id, role, isSuperAdmin: false };
    }
    if (opts.isSuperAdmin) {
      return { tenantId: tenant.id, role: "admin", isSuperAdmin: true };
    }
    throw new AppError("FORBIDDEN", `not a member of workspace '${slug}'`, 403);
  }

  // Legacy /api/* path → default tenant. The role comes from the user's
  // membership in 'default'; falls back to the session user's role (which is
  // the global users.role until Deploy 2 drops it). During PR2a both should
  // agree because the PR1 migration backfilled users.role into the default
  // tenant_member row.
  const role = (await memberRole("default", opts.user.id)) ?? opts.user.role;
  return { tenantId: "default", role, isSuperAdmin: opts.isSuperAdmin ?? false };
}
