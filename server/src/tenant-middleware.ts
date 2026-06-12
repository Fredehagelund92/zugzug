import { AppError } from "./errors.ts";
import { tenantBySlug, memberRole } from "./tenant.ts";
import { pgGet } from "./pg.ts";
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
  /** When set + isSuperAdmin, legacy /api/* paths resolve to this tenant. */
  impersonatingTenantId?: string | null;
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

  // Super-admin impersonation: legacy /api/* requests resolve to the
  // impersonated tenant. Explicit /api/t/:slug/* wins above and is not affected.
  if (opts.isSuperAdmin && opts.impersonatingTenantId) {
    const row = await pgGet<{ id: string }>(
      `SELECT id FROM "zugzug_app"."tenant" WHERE id = $1 AND deleted_at IS NULL`,
      [opts.impersonatingTenantId],
    );
    if (row) return { tenantId: row.id, role: "admin", isSuperAdmin: true };
  }

  // Legacy /api/* path with no slug → require explicit default tenant membership.
  // PR5 removed the users.role fallback; un-tenanted /api/* requests must come from
  // an actual default-tenant member or a super-admin.
  const role = await memberRole("default", opts.user.id);
  if (role) {
    return { tenantId: "default", role, isSuperAdmin: opts.isSuperAdmin ?? false };
  }
  throw new AppError("FORBIDDEN", "no_membership", 403);
}
