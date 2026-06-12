/* server.ts — the thin HTTP API over the repo (ARCHITECTURE.md's backend seam).
   Bun.serve; one shared DuckDB connection underneath (serialised). The frontend
   (app/) talks to this; Vite proxies /api → :PORT in dev. */

import { env } from "./env.ts";
import type { NumberFormat, GridLayoutConfig, OptionDef, PaletteName } from "./repo-shared.ts";
import type { ImportRow } from "./repo-canonical.ts";
import {
  getSessionUser,
  handleMe,
  handleLogout,
  handleAuthConfig,
  handleDevLogin,
  canMutate,
  updateUserName,
  listUsers,
  setSuperAdmin,
  type SessionUser,
  type Operation,
} from "./auth.ts";
import * as tables from "./tables.ts";
import { pgAll, pgEnd, pgTxScoped } from "./pg.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { createScheduler } from "./scheduler.ts";
import { scanSourcesJob, autoStageJob, autoCommitJob } from "./scheduler-jobs.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
import { getAdapter } from "./warehouse/registry.ts";
import { presence } from "./realtime/presence-room.ts";
import { resolveTenantContext } from "./tenant-middleware.ts";
import { TenantRepo } from "./tenant-repo.ts";
import {
  provisionTenant,
  listTenants,
  tenantBySlug,
  memberRole,
  teardownTenant,
  listMembershipsForUser,
  listMembersForTenant,
  listInvitesForTenant,
  createInvite,
  revokeInvite,
  setMemberRole,
  countAdmins,
  removeMember,
  updateTenantLabel,
  leaveTenant,
} from "./tenant.ts";
import { pgRun } from "./pg.ts";
import { pg } from "./env.ts";
import type { ServerWebSocket } from "bun";

export { checkHealth, _resetHealthCache, type HealthSnapshot } from "./health.ts";
import { checkHealth } from "./health.ts"; // used by the /api/health/connections route below

const corsHeaders = {
  "access-control-allow-origin": env.origin,
  "access-control-allow-credentials": "true",
  vary: "Origin",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });

const noContent = () => new Response(null, { status: 204, headers: corsHeaders });
const err = (e: unknown, status = 500) =>
  json({ error: e instanceof Error ? e.message : String(e) }, status);

/** Returns a 403 Response if the user's role cannot perform op; null otherwise. */
function gateOrJson(user: SessionUser, op: Operation): Response | null {
  if (!canMutate(user.role, op)) {
    return json({ error: "forbidden", reason: `role '${user.role}' cannot ${op}` }, 403);
  }
  return null;
}

export async function handle(req: Request, setUid: (uid: string) => void): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const seg = pathname.split("/").filter(Boolean); // ["api","dimensions",":id",...]
  const method = req.method;

  if (method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });

  if (pathname === "/health" || pathname === "/api/health") {
    try {
      await pgAll(`SELECT 1`);
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // /api/t/:slug/... strip the /t/:slug prefix so the existing route table matches.
  // We capture the slug to thread into tenant resolution after the session gate.
  let tenantSlugFromPath: string | null = null;
  if (seg[0] === "api" && seg[1] === "t" && seg.length >= 3) {
    tenantSlugFromPath = decodeURIComponent(seg[2]!);
    seg.splice(1, 2); // remove "t" and the slug
  }

  if (seg[0] !== "api") return new Response("Zug Zug API. Try /api/dimensions", { status: 404 });

  // Auth routes — no session required for signup/login/logout/config/oidc/dev
  if (seg[1] === "auth") {
    if (seg[2] === "me" && method === "GET") return handleMe(req);
    if (seg[2] === "logout" && method === "POST") return handleLogout(req);
    if (seg[2] === "config" && method === "GET") return handleAuthConfig();
    // PATCH /api/auth/me — update display name (requires session)
    if (seg[2] === "me" && method === "PATCH") {
      let sessionUser;
      try {
        sessionUser = await getSessionUser(req);
        if (!sessionUser) {
          const { getApiTokenUser } = await import("./auth-api-tokens.ts");
          sessionUser = await getApiTokenUser(req);
        }
      } catch (e) {
        return err(e, 503);
      }
      if (!sessionUser) return json({ error: "Unauthorized" }, 401);
      try {
        const { name } = (await req.json()) as { name: string };
        await updateUserName(sessionUser.id, name);
        return noContent();
      } catch (e) {
        if (e instanceof AppError) {
          return json(
            {
              error: e.message,
              code: e.code,
              ...(e.details ? { details: e.details } : {}),
            },
            e.status,
          );
        }
        throw e;
      }
    }

    // Password mode (only meaningful when env.authMode === "password")
    if (seg[2] === "signup" && method === "POST") {
      const { handleSignup } = await import("./auth-password.ts");
      return handleSignup(req);
    }
    if (seg[2] === "login" && method === "POST") {
      const { handleLogin } = await import("./auth-password.ts");
      return handleLogin(req);
    }

    // OIDC mode (only meaningful when env.authMode === "oidc")
    if (seg[2] === "oidc" && seg[3] === "start" && method === "GET") {
      const { handleOidcStart } = await import("./auth-oidc.ts");
      return handleOidcStart(req);
    }
    if (seg[2] === "oidc" && seg[3] === "callback" && method === "GET") {
      const { handleOidcCallback } = await import("./auth-oidc.ts");
      return handleOidcCallback(req);
    }

    // Dev bypass — local testing only
    if (seg[2] === "dev" && method === "GET") {
      if (!env.devBypassAuth) return json({ error: "not found" }, 404);
      return handleDevLogin();
    }

    return json({ error: "not found" }, 404);
  }

  // Session gate — all other /api/* routes require a valid session
  let sessionUser;
  try {
    sessionUser = await getSessionUser(req);
    if (!sessionUser) {
      const { getApiTokenUser } = await import("./auth-api-tokens.ts");
      sessionUser = await getApiTokenUser(req);
    }
  } catch (e) {
    return err(e, 503);
  }
  if (!sessionUser) return json({ error: "Unauthorized" }, 401);
  const me = sessionUser.id;
  setUid(me);

  // GET /api/me/memberships — list workspaces this user can enter + super-admin flag.
  if (pathname === "/api/me/memberships" && method === "GET") {
    const memberships = await listMembershipsForUser(sessionUser.id);
    return json({
      isSuperAdmin: sessionUser.isSuperAdmin,
      memberships: memberships.map((m) => ({
        slug: m.tenant.slug,
        label: m.tenant.label,
        role: m.role,
      })),
    });
  }

  // Admin block — hoisted OUT of the pgContext.run wrapper because admin routes
  // call pgAll/pgRun directly (via listTenants, teardownTenant, etc.) and would
  // trip the TenantRepo runtime guard.
  if (seg[1] === "admin") {
    if (!sessionUser.isSuperAdmin) {
      return json({ error: "forbidden", reason: "super_admin_required" }, 403);
    }
    try {
      // /api/admin/tenants (GET list, POST provision)
      if (seg[2] === "tenants" && seg.length === 3) {
        if (method === "GET") return json({ tenants: await listTenants() });
        if (method === "POST") {
          const body = (await req.json()) as {
            id: string;
            label: string;
            slug?: string;
            warehouseId?: string;
          };
          const tenant = await provisionTenant({
            id: body.id,
            label: body.label,
            slug: body.slug,
            warehouseId: body.warehouseId,
          });
          return json(tenant, 201);
        }
      }

      // POST /api/admin/tenants/:id/teardown
      if (seg[2] === "tenants" && seg.length === 5 && seg[4] === "teardown" && method === "POST") {
        const targetId = decodeURIComponent(seg[3]!);
        if (targetId === "default") {
          return json({ error: "cannot_teardown_default" }, 400);
        }
        await teardownTenant(targetId);
        return json({ ok: true, teardown: targetId });
      }

      // GET /api/admin/audit[?tenant_id=…&limit=…]
      if (seg[2] === "audit" && seg.length === 3 && method === "GET") {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
        const filterTenant = url.searchParams.get("tenant_id");
        const scope = filterTenant ?? "*";
        const adminRepo = new TenantRepo(scope, "admin", true);
        return json(await adminRepo.listAudit(limit));
      }

      // GET /api/admin/warehouses
      if (seg[2] === "warehouses" && seg.length === 3 && method === "GET") {
        if (!env.attachWarehouse) {
          return json({ databases: [], attached: false });
        }
        try {
          const adapter = await getAdapter();
          // Cast to access the protected `all()` method — this is an admin-only
          // introspection path; the public adapter interface intentionally has no
          // raw SQL escape hatch, so we poke through here rather than widening it.
          const raw = adapter as unknown as {
            all<T>(sql: string): Promise<T[]>;
          };
          const dbRows = await raw.all<{ database_name: string }>("SHOW DATABASES");
          const excluded = new Set(["system", "temp"]);
          const names = dbRows
            .map((r) => r.database_name)
            .filter((n) => !excluded.has(n));

          const countRows = await raw.all<{ table_catalog: string; n: bigint }>(
            "SELECT table_catalog, COUNT(*) AS n FROM information_schema.tables GROUP BY 1",
          );
          const countByDb = new Map<string, number>();
          for (const r of countRows) {
            countByDb.set(r.table_catalog, Number(r.n));
          }

          const databases = names.map((name) => ({
            name,
            tableCount: countByDb.get(name) ?? 0,
            connected: true,
          }));
          return json({ databases, attached: true });
        } catch (err) {
          log({ level: "warn", msg: "admin/warehouses: warehouse unreachable", err: String(err) });
          return json({ databases: [], attached: false, error: "warehouse_unreachable" });
        }
      }

      // GET /api/admin/users[?q=…&limit=…&offset=…]
      if (seg[2] === "users" && seg.length === 3 && method === "GET") {
        const q = url.searchParams.get("q") ?? undefined;
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
        return json({ users: await listUsers(q, limit, offset) });
      }

      // PATCH /api/admin/users/:id — promote/demote super-admin
      if (seg[2] === "users" && seg.length === 4 && method === "PATCH") {
        const targetId = decodeURIComponent(seg[3]!);
        const { isSuperAdmin } = (await req.json()) as { isSuperAdmin: boolean };
        try {
          await setSuperAdmin(targetId, me, isSuperAdmin);
          return noContent();
        } catch (e) {
          if (e instanceof AppError) return json({ error: e.code.toLowerCase() }, e.status);
          throw e;
        }
      }

      // POST /api/admin/impersonate/:tenant_id (set) or /api/admin/impersonate (clear)
      if (seg[2] === "impersonate" && method === "POST") {
        const target = seg[3] ? decodeURIComponent(seg[3]) : null;
        if (target) {
          const t = await tenantBySlug(target);
          if (!t) return json({ error: "tenant_not_found" }, 404);
          await pgRun(
            `INSERT INTO ${pg("active_sessions")} (user_id, last_seen, impersonating_tenant_id)
             VALUES ($1, current_timestamp, $2)
             ON CONFLICT (user_id) DO UPDATE
               SET impersonating_tenant_id = EXCLUDED.impersonating_tenant_id,
                   last_seen = current_timestamp`,
            [sessionUser.id, t.id],
          );
          await new TenantRepo(t.id, "admin", true).appendAudit(
            sessionUser.id,
            "impersonate_start",
            `super-admin → ${t.id}`,
          );
          return json({ ok: true, impersonating: t.id });
        }
        await pgRun(
          `UPDATE ${pg("active_sessions")} SET impersonating_tenant_id = NULL WHERE user_id = $1`,
          [sessionUser.id],
        );
        return json({ ok: true, impersonating: null });
      }

      return json({ error: `no route for ${method} ${pathname}` }, 404);
    } catch (e) {
      if (e instanceof AppError) {
        return json(
          {
            error: e.message,
            code: e.code,
            ...(e.details ? { details: e.details } : {}),
          },
          e.status,
        );
      }
      console.error(`✗ ${method} ${pathname}:`, e);
      return err(e);
    }
  }

  // Resolve the tenant context for non-admin /api/* routes.
  let tenantCtx: { tenantId: string; role: import("./auth.ts").Role; isSuperAdmin: boolean };
  try {
    const pathnameForCtx = tenantSlugFromPath ? `/api/t/${tenantSlugFromPath}/_` : pathname;
    tenantCtx = await resolveTenantContext({
      pathname: pathnameForCtx,
      user: sessionUser,
      isSuperAdmin: sessionUser.isSuperAdmin,
      impersonatingTenantId: sessionUser.impersonatingTenantId,
    });
  } catch (e) {
    if (e instanceof AppError) {
      return json({ error: e.message, code: e.code }, e.status);
    }
    throw e;
  }
  const reqRepo = new TenantRepo(tenantCtx.tenantId, tenantCtx.role, tenantCtx.isSuperAdmin);

  try {
    // POST /api/auth/change-password (authenticated)
    if (seg[1] === "auth" && seg[2] === "change-password" && method === "POST") {
      const { handleChangePassword } = await import("./auth-password.ts");
      return handleChangePassword(req, me);
    }

    // API token management (authenticated; session-required not bearer-required)
    if (seg[1] === "tokens") {
      if (seg.length === 2 && method === "GET") {
        const { handleListTokens } = await import("./auth-api-tokens.ts");
        return handleListTokens(me);
      }
      if (seg.length === 2 && method === "POST") {
        const { handleCreateToken } = await import("./auth-api-tokens.ts");
        return handleCreateToken(req, me);
      }
      if (seg.length === 3 && method === "DELETE") {
        const { handleRevokeToken } = await import("./auth-api-tokens.ts");
        return handleRevokeToken(seg[2], me);
      }
    }

    // PATCH /api/t/:slug — rename workspace label (admin only)
    if (tenantSlugFromPath !== null && seg.length === 1 && method === "PATCH") {
      if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
      const { label } = (await req.json()) as { label: string };
      await updateTenantLabel(tenantCtx.tenantId, label);
      return noContent();
    }

    // DELETE /api/t/:slug — delete workspace (admin only; refuses on "default")
    if (tenantSlugFromPath !== null && seg.length === 1 && method === "DELETE") {
      if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
      if (tenantSlugFromPath === "default") {
        return json({ error: "cannot_delete_default" }, 409);
      }
      await teardownTenant(tenantCtx.tenantId);
      return noContent();
    }

    // POST /api/t/:slug/leave — leave workspace (any member; last-admin guard)
    if (tenantSlugFromPath !== null && seg[1] === "leave" && seg.length === 2 && method === "POST") {
      try {
        await leaveTenant(tenantCtx.tenantId, me);
      } catch (e) {
        if (e instanceof AppError && e.code === "LAST_ADMIN") {
          return json({ error: "last_admin" }, 409);
        }
        throw e;
      }
      return noContent();
    }

    // Per-tenant team routes: /api/t/:slug/team/members|invites
    // These call pgAll/pgRun directly (not via TenantRepo) so must live OUTSIDE
    // the pgContext.run({ insideTenantRepo: true }) block.
    // After splice, seg = ["api","team","members"|"invites", ...userId|email, "role"?]
    if (tenantSlugFromPath !== null && seg[1] === "team") {
      // GET /api/t/:slug/team/members
      if (seg[2] === "members" && seg.length === 3 && method === "GET") {
        return json(await listMembersForTenant(tenantCtx.tenantId));
      }
      // PUT /api/t/:slug/team/members/:userId/role
      if (seg[2] === "members" && seg.length === 5 && seg[4] === "role" && method === "PUT") {
        if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
        const body = (await req.json()) as { role: "admin" | "editor" | "viewer" };
        const targetUserId = decodeURIComponent(seg[3]!);
        const exists = (await listMembersForTenant(tenantCtx.tenantId)).find(
          (m) => m.user_id === targetUserId,
        );
        if (!exists) return json({ error: "not_found" }, 404);
        await setMemberRole(tenantCtx.tenantId, targetUserId, body.role);
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      // DELETE /api/t/:slug/team/members/:userId
      if (seg[2] === "members" && seg.length === 4 && method === "DELETE") {
        if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
        const targetUserId = decodeURIComponent(seg[3]!);
        const targetRole = (await listMembersForTenant(tenantCtx.tenantId)).find(
          (m) => m.user_id === targetUserId,
        )?.role;
        if (targetRole === "admin" && (await countAdmins(tenantCtx.tenantId)) <= 1) {
          return json({ error: "last_admin" }, 409);
        }
        await removeMember(tenantCtx.tenantId, targetUserId);
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      // GET /api/t/:slug/team/invites
      if (seg[2] === "invites" && seg.length === 3 && method === "GET") {
        return json(await listInvitesForTenant(tenantCtx.tenantId));
      }
      // POST /api/t/:slug/team/invites
      if (seg[2] === "invites" && seg.length === 3 && method === "POST") {
        if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
        const body = (await req.json()) as { email: string; role: "admin" | "editor" | "viewer" };
        await createInvite(tenantCtx.tenantId, body.email, body.role, me);
        return json({ ok: true }, 201);
      }
      // DELETE /api/t/:slug/team/invites/:email
      if (seg[2] === "invites" && seg.length === 4 && method === "DELETE") {
        if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
        await revokeInvite(tenantCtx.tenantId, decodeURIComponent(seg[3]!));
        return new Response(null, { status: 204, headers: corsHeaders });
      }
    }

    return await pgTxScoped(tenantCtx.tenantId, async () => {
      // GET /api/preferences ; PUT /api/preferences {publishThreshold, suggestThreshold, scanSchedule}
      if (seg[1] === "preferences" && seg.length === 2) {
        if (method === "GET") return json(await reqRepo.getPreferences());
        if (method === "PUT") {
          const p = (await req.json()) as {
            publishThreshold: number;
            suggestThreshold: number;
            scanSchedule: "15m" | "hourly" | "daily" | null;
          };
          await reqRepo.setPreferences(p);
          return noContent();
        }
      }

      if (seg[1] === "triage" && seg[2] === "ai-hint" && seg.length === 3 && method === "GET") {
        const dimId = url.searchParams.get("dimId") ?? "";
        const raw = url.searchParams.get("raw") ?? "";
        if (!dimId || !raw) return err("dimId and raw required", 400);
        const dim = await reqRepo.getDimension(dimId);
        if (!dim) return json({ error: "not found" }, 404);
        if (!env.anthropicApiKey) return json({ error: "ai_not_configured" }, 503);
        try {
          const canonicalLabels = dim.canonical.map((c) => c.label);
          const hint = await reqRepo.getAiHint(dimId, raw, canonicalLabels, {
            label: dim.dimension,
          });
          return json(hint);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("timeout") || msg.includes("AbortError")) {
            return json({ error: "hint_timeout" }, 503);
          }
          return json({ error: "hint_error" }, 502);
        }
      }

      // GET /api/users → { currentUser, collaborators }
      if (seg[1] === "users" && seg.length === 2 && method === "GET") {
        const users = await reqRepo.listUsers();
        return json({
          currentUser: users.find((u) => u.id === me) ?? users[0],
          collaborators: users,
        });
      }

      // GET /api/workspace/info — adapter capability metadata for the frontend badge
      if (seg[1] === "workspace" && seg[2] === "info" && seg.length === 3 && method === "GET") {
        const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
        const adapterInstance = await getAdapterFn();
        return json({
          adapter: adapterInstance.capabilities.id,
          writable: adapterInstance.capabilities.writable,
          canonicalMode: adapterInstance.capabilities.writable ? "warehouse" : "postgres-export",
          warehouseDb: env.warehouseDb || null,
          defaultEngineerMode: env.defaultEngineerMode,
        });
      }

      // GET /api/health/connections — postgres + warehouse liveness (5s cache)
      if (seg[1] === "health" && seg[2] === "connections" && seg.length === 3 && method === "GET") {
        const force = url.searchParams.get("force") === "1";
        const snapshot = await checkHealth({ force });
        return json(snapshot);
      }

      // /api/sources — registered source columns (cached); /facets; /scan
      if (seg[1] === "sources") {
        if (seg.length === 2 && method === "GET")
          return json(
            await reqRepo.listSources({
              q: url.searchParams.get("q") ?? undefined,
              schema: url.searchParams.get("schema") ?? undefined,
              status: url.searchParams.get("status") ?? undefined,
            }),
          );
        if (seg[2] === "facets" && seg.length === 3 && method === "GET")
          return json(await reqRepo.sourceFacets());
        if (seg[2] === "scan-status" && seg.length === 3 && method === "GET")
          return json(await reqRepo.scanStatus());
        if (seg[2] === "scan" && seg.length === 3 && method === "POST") {
          const denied = gateOrJson(sessionUser, "manage_adapter");
          if (denied) return denied;
          return json({ scanned: await reqRepo.scanSources() });
        }
        // GET /api/sources/unmapped?dimId=&table=&column=&limit=
        if (seg[2] === "unmapped" && seg.length === 3 && method === "GET") {
          const dimId = url.searchParams.get("dimId") ?? "";
          const table = url.searchParams.get("table") ?? "";
          const column = url.searchParams.get("column") ?? "";
          const limit = Number(url.searchParams.get("limit") ?? 5);
          if (!dimId || !table || !column) return err("dimId, table, column required", 400);
          return json(await reqRepo.topUnmapped(dimId, table, column, limit));
        }
      }

      // GET /api/catalog — browse/search the warehouse catalog (the 1000+ tables)
      if (seg[1] === "catalog" && seg.length === 2 && method === "GET")
        return json(
          await reqRepo.searchCatalog({
            q: url.searchParams.get("q") ?? undefined,
            schema: url.searchParams.get("schema") ?? undefined,
            limit: Number(url.searchParams.get("limit") ?? 50),
            offset: Number(url.searchParams.get("offset") ?? 0),
          }),
        );

      // GET /api/audit ; POST /api/audit {action, detail}
      if (seg[1] === "audit" && seg.length === 2) {
        if (method === "GET")
          return json(await reqRepo.listAudit(Number(url.searchParams.get("limit") ?? 30)));
        if (method === "POST") {
          const { action, detail } = (await req.json()) as { action: string; detail: string };
          await reqRepo.appendAudit(me, action, detail);
          return noContent();
        }
      }

      // GET / PATCH /api/grid-layout/:dimId — per-user-per-dim layout (widths/order/hidden)
      if (seg[1] === "grid-layout" && seg.length === 3) {
        const dimId = decodeURIComponent(seg[2]!);
        if (method === "GET") return json(await reqRepo.getGridLayout(me, dimId));
        if (method === "PATCH") {
          const body = (await req.json()) as GridLayoutConfig;
          await reqRepo.setGridLayout(me, dimId, body);
          return noContent();
        }
      }

      if (seg[1] === "tables") {
        if (seg.length === 2 && method === "POST") {
          const denied = gateOrJson(sessionUser, "manage_adapter");
          if (denied) return denied;
          try {
            const input = (await req.json()) as tables.CreateTableInput;
            const result = await tables.createTable(input, me, tenantCtx.tenantId);
            return json(result, 201);
          } catch (e) {
            if (e instanceof AppError) {
              return json(
                {
                  error: e.message,
                  code: e.code,
                  ...(e.details ? { details: e.details } : {}),
                },
                e.status,
              );
            }
            throw e;
          }
        }
        // GET /api/tables/:id/row-activity?since=<iso>
        if (seg.length === 4 && seg[3] === "row-activity" && method === "GET") {
          const tableId = decodeURIComponent(seg[2]!);
          const sinceParam = url.searchParams.get("since");
          const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 86_400_000);
          if (Number.isNaN(since.getTime())) {
            throw new AppError("VALIDATION_FAILED", "invalid `since` query param", 400);
          }
          const entries = await reqRepo.getRowActivitySince(tableId, since);
          return json({ entries, serverTime: new Date().toISOString() });
        }
        return json({ error: "not found" }, 404);
      }

      if (seg[1] === "dimensions") {
        // GET /api/dimensions[?full=true] ; POST /api/dimensions {name}
        // ?full=true returns the full MappingDimension shapes (canonical rows,
        // values, fields, …) in one response — kills the N+1 the client used to
        // make at boot (1 list + N detail fetches).
        if (seg.length === 2) {
          if (method === "GET") {
            if (url.searchParams.get("full") === "true") {
              const metas = await reqRepo.listDimensions();
              const fulls = await Promise.all(metas.map((m) => reqRepo.getDimension(m.id)));
              return json(fulls.filter((d): d is NonNullable<typeof d> => d != null));
            }
            return json(await reqRepo.listDimensions());
          }
          if (method === "POST") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            const { name, keyKind } = (await req.json()) as {
              name: string;
              keyKind?: "slug" | "external_id";
            };
            return json({ id: await reqRepo.addDimension(name, [], { keyKind }, me) }, 201);
          }
        }
        const id = seg[2] ? decodeURIComponent(seg[2]) : "";
        // GET /api/dimensions/:id
        if (seg.length === 3 && id && method === "GET") {
          const dim = await reqRepo.getDimension(id);
          return dim ? json(dim) : json({ error: "not found" }, 404);
        }
        if (seg[3] === "drafts") {
          // GET /api/dimensions/:id/drafts ; PUT (upsert) ; DELETE /.../:raw
          if (seg.length === 4 && method === "GET") return json(await reqRepo.listDrafts(id));
          if (seg.length === 4 && method === "PUT") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            const b = (await req.json()) as {
              raw: string;
              status: "mapped" | "skipped";
              targetLabel: string | null;
              targetKey: string | null;
            };
            await reqRepo.saveDraft(
              id,
              b.raw,
              b.status,
              b.targetLabel ?? null,
              b.targetKey ?? null,
              me,
            );
            return noContent();
          }
          if (seg.length === 5 && method === "DELETE") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            await reqRepo.discardDraft(id, decodeURIComponent(seg[4]!), me);
            return noContent();
          }
        }
        // POST /api/dimensions/:id/sources {table, column} — wire a warehouse column
        if (seg[3] === "sources" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(sessionUser, "manage_adapter");
          if (denied) return denied;
          const { table, column } = (await req.json()) as { table: string; column: string };
          await reqRepo.addSource(id, table, column);
          return noContent();
        }
        // POST /api/dimensions/:id/derive {table, column, nameColumn?} — seed canonical
        if (seg[3] === "derive" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(sessionUser, "curate");
          if (denied) return denied;
          const { table, column, nameColumn } = (await req.json()) as {
            table: string;
            column: string;
            nameColumn?: string;
          };
          return json(await reqRepo.deriveCanonical(id, table, column, nameColumn, {}, me));
        }
        // POST /api/dimensions/:id/import {rows} — bulk CSV import (create new keys, update fields on existing)
        if (seg[3] === "import" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(sessionUser, "curate");
          if (denied) return denied;
          const { rows } = (await req.json()) as { rows: ImportRow[] };
          if (!Array.isArray(rows)) {
            throw new AppError("VALIDATION_FAILED", "rows must be an array", 400);
          }
          if (rows.length > 10_000) {
            throw new AppError("VALIDATION_FAILED", "too many rows (max 10000)", 400);
          }
          return json(await reqRepo.importCanonical(id, rows, me));
        }
        // POST /api/dimensions/:id/fields {label, type?, options?, numberFormat?, ratingMax?, referencedDimId?, displayFields?} — add an attribute column
        if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(sessionUser, "curate");
          if (denied) return denied;
          const { label, type, options, numberFormat, ratingMax, referencedDimId, displayFields } =
            (await req.json()) as {
              label: string;
              type?: string;
              options?: { label: string; color: string | null }[];
              numberFormat?: NumberFormat;
              ratingMax?: number;
              referencedDimId?: string;
              displayFields?: string[];
            };
          return json(
            await reqRepo.addField(
              id,
              label,
              type,
              options as OptionDef[] | undefined,
              { numberFormat, ratingMax, referencedDimId, displayFields },
              me,
            ),
          );
        }
        // POST /api/dimensions/:id/fields/:field/options {label} — append a select option
        if (seg[3] === "fields" && seg[5] === "options" && seg.length === 6 && method === "POST") {
          const denied = gateOrJson(sessionUser, "curate");
          if (denied) return denied;
          const field = decodeURIComponent(seg[4]!);
          const { label, color } = (await req.json()) as { label: string; color?: string | null };
          const res = await reqRepo.addColumnOption(
            id,
            field,
            label,
            (color ?? null) as PaletteName | null,
            {},
            me,
          );
          return res ? json(res) : json({ error: "not a select column" }, 400);
        }
        // PUT/PATCH/DELETE /api/dimensions/:id/fields/:field — rename / change type / update meta / delete
        if (seg[3] === "fields" && seg.length === 5) {
          const field = decodeURIComponent(seg[4]!);
          if (method === "PUT") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            const body = (await req.json()) as {
              label?: string;
              type?: string;
              options?: { label: string; color: string | null }[];
              numberFormat?: NumberFormat;
              ratingMax?: number;
              coerceInvalidToNull?: boolean;
            };
            if (body.label != null) {
              await reqRepo.renameColumn(id, field, body.label, me);
            }
            if (body.type != null) {
              const res = await reqRepo.changeColumnType(id, field, {
                newType: body.type,
                options: body.options as OptionDef[] | undefined,
                numberFormat: body.numberFormat,
                ratingMax: body.ratingMax,
                coerceInvalidToNull: body.coerceInvalidToNull ?? false,
                userId: me,
              });
              return json(res);
            }
            return noContent();
          }
          if (method === "PATCH") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            const body = (await req.json()) as {
              description?: string | null;
              field_config?: string | null;
            };
            await reqRepo.updateField(
              id,
              field,
              { description: body.description, fieldConfig: body.field_config },
              me,
            );
            return noContent();
          }
          if (method === "DELETE") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            return json(await reqRepo.deleteColumn(id, field, me));
          }
        }
        // canonical record management
        if (seg[3] === "canonical") {
          if (seg.length === 4 && method === "POST") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            const { label, key } = (await req.json()) as { label: string; key?: string };
            await reqRepo.addCanonicalOne(id, label, key, me);
            return noContent();
          }
          if (seg[4] === "merge" && seg.length === 5 && method === "POST") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            if (url.searchParams.get("confirm") !== "true") {
              throw new AppError("CONFIRMATION_REQUIRED", "merge requires ?confirm=true", 400);
            }
            const { survivor, losers, expectedVersions } = (await req.json()) as {
              survivor: string;
              losers: string[];
              expectedVersions?: Record<string, number>;
            };
            if (!expectedVersions || typeof expectedVersions !== "object") {
              throw new AppError("VALIDATION_FAILED", "expectedVersions required", 400);
            }
            return json({
              merged: await reqRepo.mergeCanonical(id, survivor, losers, me, expectedVersions),
            });
          }
          const ck = seg[4] ? decodeURIComponent(seg[4]) : "";
          if (seg[5] === "variants" && seg.length === 6 && method === "GET")
            return json(await reqRepo.listVariants(id, ck));
          // PUT /api/dimensions/:id/canonical/:key/field/:field {value}
          if (seg[5] === "field" && seg.length === 7 && method === "PUT") {
            const denied = gateOrJson(sessionUser, "curate");
            if (denied) return denied;
            const { value } = (await req.json()) as { value: string | null };
            await reqRepo.setFieldValue(id, ck, decodeURIComponent(seg[6]!), value ?? null);
            return noContent();
          }
          if (seg.length === 5 && ck) {
            if (method === "PUT") {
              const denied = gateOrJson(sessionUser, "curate");
              if (denied) return denied;
              const { label, expectedVersion } = (await req.json()) as {
                label: string;
                expectedVersion?: number;
              };
              if (typeof expectedVersion !== "number") {
                throw new AppError("VALIDATION_FAILED", "expectedVersion required", 400);
              }
              const result = await reqRepo.renameCanonical(id, ck, label, me, expectedVersion);
              return json(result);
            }
            if (method === "DELETE") {
              const denied = gateOrJson(sessionUser, "curate");
              if (denied) return denied;
              const ev = url.searchParams.get("expectedVersion");
              const expectedVersion = ev !== null ? Number(ev) : NaN;
              if (!Number.isFinite(expectedVersion)) {
                throw new AppError("VALIDATION_FAILED", "expectedVersion required", 400);
              }
              return json(await reqRepo.retireCanonical(id, ck, me, expectedVersion));
            }
          }
        }
        // POST /api/dimensions/:id/commit
        if (seg[3] === "commit" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(sessionUser, "commit");
          if (denied) return denied;
          return json(await reqRepo.commit(id, me));
        }
        // GET /api/dimensions/:id/snapshot.parquet — Parquet export of the dim's map table
        if (seg[3] === "snapshot.parquet" && seg.length === 4 && method === "GET") {
          const dimId = seg[2]!;
          const dim = await reqRepo.getDimension(dimId);
          if (!dim) return json({ error: "not found" }, 404);
          const { exportCanonicalToParquet } = await import("./warehouse/parquet-exporter.ts");
          const buf = await exportCanonicalToParquet({
            dimId: dim.id,
            dimTable: dim.dimTable,
            mapTable: dim.mapTable,
            keyCol: dim.keyCol,
          });
          return new Response(buf, {
            status: 200,
            headers: {
              ...corsHeaders,
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${dimId}-map.parquet"`,
              "cache-control": "no-store",
            },
          });
        }
      }

      return json({ error: `no route for ${method} ${pathname}` }, 404);
    });
  } catch (e) {
    if (e instanceof AppError) {
      return json(
        {
          error: e.message,
          code: e.code,
          ...(e.details ? { details: e.details } : {}),
        },
        e.status,
      );
    }
    console.error(`✗ ${method} ${pathname}:`, e);
    return err(e);
  }
}

if (import.meta.main) {
  registerFactories({
    duckdb: async (creds) => createDuckDbAdapter(creds),
    snowflake: async (creds) => new SnowflakeAdapter(creds),
  });

  const adapter = await getAdapter();
  const ok = await adapter.ping();
  if (!ok) {
    console.error("✗ warehouse adapter ping failed");
    process.exit(1);
  }
  console.log(
    `· connected (${adapter.capabilities.id}${adapter.capabilities.writable ? ", writable" : ", read-only"})`,
  );

  const scheduler = createScheduler({
    tickIntervalMs: 60_000,
    shouldRun: async (tenantId) => {
      // Per-tenant gate: only run jobs for tenants whose scan_run cadence is due.
      const probe = new TenantRepo(tenantId, "admin", true);
      return probe.anyScanDue(new Date());
    },
    jobs: [scanSourcesJob, autoStageJob, autoCommitJob],
  });
  scheduler.start();
  console.log("· scheduler started (1m tick)");

  interface PresenceWsData {
    tableId: string;
    tenantId: string;
    userId: string;
    displayName: string;
  }

  const server = Bun.serve<PresenceWsData>({
    port: env.port,
    idleTimeout: 120,
    maxRequestBodySize: 512 * 1024, // 512 KB — largest legit payload is a grid layout
    async fetch(req, srv) {
      // WebSocket upgrade for presence rooms — must run before HTTP routing.
      // We authenticate via the same session helper used by /api/* routes so that
      // anonymous clients can't observe presence. Auth FIRST, upgrade SECOND.
      const url = new URL(req.url);

      // Tenant-scoped path: /ws/t/:slug/presence/:tableId
      if (url.pathname.startsWith("/ws/t/")) {
        const m = /^\/ws\/t\/([^/]+)\/presence\/(.+)$/.exec(url.pathname);
        if (!m) return new Response("bad ws path", { status: 400 });
        const slug = decodeURIComponent(m[1]!);
        const tableId = decodeURIComponent(m[2]!);
        if (!tableId) return new Response("missing tableId", { status: 400 });

        let session: SessionUser | null;
        try {
          session = await getSessionUser(req);
          if (!session) {
            const { getApiTokenUser } = await import("./auth-api-tokens.ts");
            session = await getApiTokenUser(req);
          }
        } catch {
          return new Response("auth error", { status: 503 });
        }
        if (!session) return new Response("unauthorized", { status: 401 });

        const tenant = await tenantBySlug(slug);
        if (!tenant) return new Response("workspace not found", { status: 404 });
        const role = await memberRole(tenant.id, session.id);
        if (!role && !session.isSuperAdmin) return new Response("forbidden", { status: 403 });

        const ok = srv.upgrade(req, {
          data: {
            tableId,
            tenantId: tenant.id,
            userId: session.id,
            displayName: session.name,
          } satisfies PresenceWsData,
        });
        return ok ? undefined : new Response("upgrade failed", { status: 500 });
      }

      // Legacy /ws/presence/:tableId — default-tenant fallback (one-release deprecation).
      if (url.pathname.startsWith("/ws/presence/")) {
        const tableId = decodeURIComponent(url.pathname.slice("/ws/presence/".length));
        if (!tableId) return new Response("missing tableId", { status: 400 });
        let session: SessionUser | null;
        try {
          session = await getSessionUser(req);
          if (!session) {
            const { getApiTokenUser } = await import("./auth-api-tokens.ts");
            session = await getApiTokenUser(req);
          }
        } catch {
          return new Response("auth error", { status: 503 });
        }
        if (!session) return new Response("unauthorized", { status: 401 });
        const ok = srv.upgrade(req, {
          data: {
            tableId,
            tenantId: "default",
            userId: session.id,
            displayName: session.name,
          } satisfies PresenceWsData,
        });
        return ok ? undefined : new Response("upgrade failed", { status: 500 });
      }

      const reqId = crypto.randomUUID();
      const start = performance.now();
      let userId: string | undefined;
      let status = 500;
      try {
        const res = await handle(req, (uid) => {
          userId = uid;
        });
        status = res.status;
        const headers = new Headers(res.headers);
        headers.set("x-request-id", reqId);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      } catch (e) {
        console.error(`✗ ${req.method} ${new URL(req.url).pathname}:`, e);
        status = 500;
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
          status: 500,
          headers: { "content-type": "application/json", "x-request-id": reqId, ...corsHeaders },
        });
      } finally {
        log({
          level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
          msg: "request",
          reqId,
          method: req.method,
          path: new URL(req.url).pathname,
          status,
          ms: Math.round(performance.now() - start),
          userId,
        });
      }
    },
    websocket: {
      // Stewards may sit on a page for 30+ min between cursor moves; disable Bun's
      // idle timeout (0 = never close due to inactivity). Yjs awareness has its
      // own liveness model on top.
      idleTimeout: 0,
      open(ws) {
        const { tableId, tenantId } = ws.data;
        // Cast: presence.join/leave/broadcast are typed for ServerWebSocket<undefined>
        // (the Bun default). They never read .data — they only fan out frames.
        presence.join(tableId, ws as unknown as ServerWebSocket, tenantId);
      },
      message(ws, msg) {
        const { tableId, tenantId } = ws.data;
        // The yjs awareness envelope is binary. Bun hands us either a Buffer
        // (Uint8Array subclass) or a string. Strings would only come from
        // app-level heartbeats. Normalize to Uint8Array and relay verbatim —
        // the server never decodes the y-protocols frame.
        let payload: Uint8Array;
        if (typeof msg === "string") {
          payload = new TextEncoder().encode(msg);
        } else if (msg instanceof Uint8Array) {
          payload = msg;
        } else {
          payload = new Uint8Array(msg as ArrayBuffer);
        }
        presence.broadcastAwareness(tableId, payload, ws as unknown as ServerWebSocket, tenantId);
      },
      close(ws) {
        const { tableId, tenantId } = ws.data;
        presence.leave(tableId, ws as unknown as ServerWebSocket, tenantId);
      },
    },
  });

  console.log(`\nZug Zug API listening on http://localhost:${server.port}\n`);

  const SHUTDOWN_TIMEOUT_MS = 30_000;
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`· ${signal} received — draining…`);
    // Drain in-flight scheduler job before closing. 30s is the safety-net timeout;
    // v0.2 jobs don't honor the abort signal but future jobs can via ctx.signal.
    await scheduler.stop(SHUTDOWN_TIMEOUT_MS);
    console.log("· scheduler drained; closing server");
    server.stop(false); // stop accepting new connections (Bun has no await-drain API)
    await new Promise<void>((resolve) => setTimeout(resolve, 250)); // best-effort 250ms drain window
    await Promise.race([
      pgEnd(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("pgEnd timeout")), 5000)),
    ]).catch((e) => console.error("pgEnd failed:", e));
    console.log("· shutdown complete");
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
